/**
 * YesOne sales-order workflow on the Firestore salesOrders mirror.
 * Zoho stays Draft until payment is verified → then Confirm + Invoice.
 *
 * yesOneStage: review → ready_for_payment → payment_submitted → completed | void
 * Software-segment SOs and Directors price-level dealers skip review
 * and open at ready_for_payment.
 */
import { randomUUID } from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { resolveZohoCustomerIdForUser } from './zoho-invoices.js';
import {
  confirmSalesOrder,
  createInvoiceFromSalesOrder,
  deleteSalesOrder,
  getSalesOrderLinkedInvoice,
  markInvoiceAsSent,
  pushInvoiceEinvoiceToIrp,
  setSalesOrderSalesperson,
  updateSalesOrderLines,
  updateSalesOrderShippingAddress,
  voidSalesOrder,
} from './zoho-sales-orders.js';
import { resolveSalespersonForCustomer, resolveSalespersonForStaff } from './sales-order-salesperson.js';
import {
  mapSalesOrderDoc,
  mirrorSalesOrderFromZoho,
  persistSourceMachineQc,
  withCatalogLineImages,
  withResolvedShippingAddress,
} from './sales-order-sync.js';
import { resolveShippingAddressId, withSelectedShippingPhone } from './zoho-contact-addresses.js';
import { isQuantityExcludedLineItem } from './invoice-category.js';
import { effectiveCatalogStockStatus } from './sac-catalog.js';
import { isFreightOrderLine, isFreightProductId, isFreightSku } from './freight-lines.js';
import { applyReservedKotakFeedToInvoice } from './zoho-bank-feeds.js';
import {
  defaultInventorySiteForSegment,
  inventorySiteLabel,
  orderSegmentFromInvoiceCategory,
  parseInventorySite,
  parseOrderSegment,
  productMatchesSalesOrderBucket,
  segmentLabel,
} from './sales-order-segments.js';
import {
  loadGatcStampingPriceMap,
  mergeKeyForLine,
  resolveGatcFeeForProduct,
} from './gatc-stamping.js';
import {
  appendMachineQcDescription,
  parseQcEnabled,
  resolveMachineQc,
} from './machine-qc.js';
import {
  appendWeighingScaleDescription,
  loadWeighingScaleCategoryIdSet,
} from './weighing-scale-description.js';
import { mergePriceChangeAudit } from './price-change-audit.js';
import {
  loadInvoiceDocById,
  writeGatcReportFromSalesOrder,
  yesOneGatcPersistFields,
} from './gatc-report.js';
import { syncSingleInvoiceFromZoho, invoicesCollection } from './invoice-sync.js';
import { patchInvoiceSummaryListFields } from './invoice-stats.js';
import { getAccessToken, resolveOrganizationId } from './zoho.js';
import { staffUserHasPermission } from './staff-permissions.js';
import { fetchRawCustomerDetail } from './zoho-customers.js';
import { extractZohoListFields } from './zoho-contact-fields.js';
import {
  ensureFreightDiffOnInvoicingSalesOrder,
  releaseFreightDiffReservation,
  settleFreightDiffOnInvoice,
} from './freight-diff-settlement.js';

const SO_COLLECTION = 'salesOrders';
const PRODUCTS = 'catalogProducts';

const DEALER_ROLES = new Set(['dealer', 'dealer_staff']);
const OPS_ROLES = new Set(['staff', 'super_admin']);

const STAGES = new Set([
  'review',
  'ready_for_payment',
  'payment_submitted',
  'completed',
  'void',
]);

/**
 * Zoho e-invoice (Push to IRP) is only for GST-registered businesses.
 * In our dealer mirror that is `zohoGstTreatment === 'business_gst'`.
 * (Business without GST / consumer / individual cannot be pushed.)
 */
export function isZohoCustomerEinvoicePushEligible(customer) {
  if (!customer || typeof customer !== 'object') return false;
  const treatment = String(
    customer.zohoGstTreatment ?? customer.gst_treatment ?? '',
  ).trim().toLowerCase();
  if (treatment === 'business_gst') return true;

  // Fallback when GST treatment was not synced but GSTIN + business subtype are present.
  const subType = String(
    customer.zohoCustomerSubType ?? customer.customer_sub_type ?? '',
  ).trim().toLowerCase();
  const gstNo = String(customer.zohoGstNo ?? customer.gst_no ?? '').trim();
  return subType === 'business' && gstNo.length >= 15;
}

async function resolveCustomerForEinvoice(secrets, orgId, customerId) {
  const id = String(customerId ?? '').trim();
  if (!id) return null;

  const ref = getFirestore().collection('zohoCustomers').doc(id);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() || {};
    if (data.zohoGstTreatment || data.zohoCustomerSubType || data.zohoGstNo) {
      return data;
    }
  }

  try {
    const accessToken = await getAccessToken(secrets);
    const organizationId = await resolveOrganizationId(accessToken, orgId);
    const contact = await fetchRawCustomerDetail(accessToken, organizationId, id);
    return extractZohoListFields(contact);
  } catch (err) {
    console.warn('Could not load Zoho customer for e-invoice eligibility:', id, err?.message || err);
    return snap.exists ? (snap.data() || {}) : null;
  }
}

const MISSING_SALESPERSON_MESSAGE = (
  'Assign a sales staff with a linked Zoho salesperson to this dealer, then use “Apply salesperson from dealer” before verifying payment.'
);

/**
 * Verify requires salesperson already on the SO (from create or Apply from dealer).
 */
function requireSalespersonOnSalesOrder(data) {
  const salespersonId = data.salespersonId ? String(data.salespersonId).trim() : '';
  if (!salespersonId) {
    throw new HttpsError('failed-precondition', MISSING_SALESPERSON_MESSAGE);
  }
  const salespersonName = data.salespersonName
    ? String(data.salespersonName).trim() || null
    : null;
  return { salespersonId, salespersonName };
}

/**
 * Write resolved Zoho salesperson onto SO (Zoho + Firestore mirror).
 */
async function applySalespersonResolvedToOrder(
  uid,
  user,
  ref,
  id,
  resolved,
  secrets,
  orgId,
) {
  await setSalesOrderSalesperson(secrets, orgId, id, {
    salespersonId: resolved.id,
    salespersonName: resolved.name,
  });
  await mirrorSalesOrderFromZoho(secrets, orgId, id);
  await ref.set({
    salespersonId: resolved.id,
    salespersonName: resolved.name,
    yesOneUpdatedAt: nowIso(),
    yesOneLastEditedAt: nowIso(),
    yesOneLastEditedByUid: uid,
    yesOneLastEditedByName: displayName(user),
  }, { merge: true });
}

/**
 * Admin action: copy dealer assigned staff → Zoho salesperson onto this SO.
 */
export async function applySalesOrderSalespersonFromDealer(
  uid,
  role,
  salesOrderId,
  secrets,
  orgId,
) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id, data } = await loadSoOrThrow(salesOrderId);
  const stage = yesOneStageOf(data);
  if (stage === 'completed' || stage === 'void') {
    throw new HttpsError(
      'failed-precondition',
      'Salesperson cannot be changed after the order is completed or voided.',
    );
  }

  const resolved = await resolveSalespersonForCustomer(data.customerId);
  if (!resolved?.id) {
    throw new HttpsError('failed-precondition', MISSING_SALESPERSON_MESSAGE);
  }

  try {
    await applySalespersonResolvedToOrder(uid, user, ref, id, resolved, secrets, orgId);
  } catch (err) {
    const message = err?.message || 'Could not set salesperson on the sales order.';
    throw new HttpsError('internal', message);
  }

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/**
 * Admin action: apply a portal staff member's Zoho salesperson onto this SO.
 */
export async function applySalesOrderSalespersonFromStaff(
  uid,
  role,
  salesOrderId,
  staffUid,
  secrets,
  orgId,
) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const targetUid = String(staffUid ?? '').trim();
  if (!targetUid) {
    throw new HttpsError('invalid-argument', 'staffUid is required.');
  }

  const { ref, id, data } = await loadSoOrThrow(salesOrderId);
  const stage = yesOneStageOf(data);
  if (stage === 'completed' || stage === 'void') {
    throw new HttpsError(
      'failed-precondition',
      'Salesperson cannot be changed after the order is completed or voided.',
    );
  }

  const existingId = String(data.salespersonId ?? '').trim();
  if (existingId && !isFullSuperAdmin(user)) {
    throw new HttpsError(
      'permission-denied',
      'Only super admin can change the salesperson on this order.',
    );
  }

  const resolved = await resolveSalespersonForStaff(targetUid);
  if (!resolved?.id) {
    throw new HttpsError(
      'failed-precondition',
      'Selected staff has no linked Zoho salesperson.',
    );
  }

  try {
    await applySalespersonResolvedToOrder(uid, user, ref, id, resolved, secrets, orgId);
  } catch (err) {
    const message = err?.message || 'Could not set salesperson on the sales order.';
    throw new HttpsError('internal', message);
  }

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/**
 * When dealer assigned staff changes, backfill open SOs missing a salesperson.
 */
export async function backfillOpenSalesOrdersSalespersonForCustomer(
  customerId,
  secrets,
  orgId,
) {
  const id = String(customerId ?? '').trim();
  if (!id) return { updated: 0 };

  const resolved = await resolveSalespersonForCustomer(id);
  if (!resolved?.id) return { updated: 0 };

  const db = getFirestore();
  const snap = await db.collection(SO_COLLECTION)
    .where('customerId', '==', id)
    .get();

  let updated = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (String(data.salespersonId ?? '').trim()) continue;
    const stage = yesOneStageOf(data);
    if (stage === 'completed' || stage === 'void') continue;

    try {
      await setSalesOrderSalesperson(secrets, orgId, docSnap.id, {
        salespersonId: resolved.id,
        salespersonName: resolved.name,
      });
      await mirrorSalesOrderFromZoho(secrets, orgId, docSnap.id);
      await docSnap.ref.set({
        salespersonId: resolved.id,
        salespersonName: resolved.name,
        yesOneUpdatedAt: nowIso(),
      }, { merge: true });
      updated += 1;
    } catch (err) {
      console.warn('backfillOpenSalesOrdersSalespersonForCustomer failed:', {
        salesOrderId: docSnap.id,
        customerId: id,
        message: err?.message ?? String(err),
      });
    }
  }

  return { updated };
}

const MAX_PAYMENT_BYTES = 8 * 1024 * 1024;
const MAX_DEALER_INVOICE_BYTES = 8 * 1024 * 1024;
const DEALER_INVOICE_PREFIX = 'sales-order-dealer-invoices';

function nowIso() {
  return new Date().toISOString();
}

function normalizeRole(role) {
  if (role === 'admin') return 'super_admin';
  if (role === 'director') return 'dealer';
  if (role === 'director_staff') return 'dealer_staff';
  return role;
}

async function loadUser(uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await getFirestore().doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'User profile not found.');
  const data = snap.data() || {};
  if (data.active === false) throw new HttpsError('permission-denied', 'Your account is inactive.');
  return { uid, role: normalizeRole(String(data.role ?? '')), data };
}

function displayName(user) {
  return String(
    user.data?.displayName
    || user.data?.loginId
    || user.data?.email
    || 'User',
  ).trim();
}

function staffHasPermission(user, permission) {
  return staffUserHasPermission(user.role, user.data, permission);
}

function requireOrdersManage(user) {
  if (user.role === 'super_admin') return;
  if (user.role === 'staff' && staffHasPermission(user, 'orders.manage')) return;
  throw new HttpsError('permission-denied', 'You do not have permission to manage orders.');
}

const PAYMENT_VERIFIER_NAMES = ['safna', 'shalima'];

function paymentVerifierIdentityParts(data) {
  return [data?.displayName, data?.loginId, data?.email]
    .flatMap(value => String(value ?? '').toLowerCase().split(/[\s@._-]+/))
    .map(part => part.trim())
    .filter(Boolean);
}

function requirePaymentVerifier(user) {
  if (user.role !== 'staff' && user.role !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Only Safna or Shalima can verify payment.');
  }
  const parts = new Set(paymentVerifierIdentityParts(user.data));
  if (!PAYMENT_VERIFIER_NAMES.some(name => parts.has(name))) {
    throw new HttpsError('permission-denied', 'Only Safna or Shalima can verify payment.');
  }
}

function isFullSuperAdmin(user) {
  return user.role === 'super_admin' && user.data?.superAdminAccess !== 'view_only';
}

function soRef(salesOrderId) {
  const id = String(salesOrderId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Sales order id is required.');
  return getFirestore().doc(`${SO_COLLECTION}/${id}`);
}

async function loadSoOrThrow(salesOrderId) {
  const ref = soRef(salesOrderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Sales order not found.');
  return { ref, id: snap.id, data: snap.data() || {} };
}

function normalizeZohoStatus(status) {
  return String(status || '').toLowerCase().replace(/\s+/g, '_');
}

function yesOneStageOf(data) {
  const stage = String(data.yesOneStage || '').trim();
  return STAGES.has(stage) ? stage : 'review';
}

const BLOCKED_YESONE_EDIT_STAGES = new Set(['payment_submitted', 'completed', 'void']);
const BLOCKED_ZOHO_EDIT_STATUSES = new Set(['void', 'cancelled', 'canceled', 'closed', 'invoiced']);
const OPEN_ZOHO_EDIT_STATUSES = new Set(['draft', 'pending', 'open', 'confirmed', 'approved']);

function canEditSalesOrderContent(user, data) {
  const stage = yesOneStageOf(data);
  if (BLOCKED_YESONE_EDIT_STAGES.has(stage)) return false;

  // Payment due: dealers cannot alter lines/shipping; ops may still edit.
  if (DEALER_ROLES.has(user?.role) && stage === 'ready_for_payment') return false;

  const zohoStatus = normalizeZohoStatus(data.status);
  if (BLOCKED_ZOHO_EDIT_STATUSES.has(zohoStatus)) return false;

  return OPEN_ZOHO_EDIT_STATUSES.has(zohoStatus) || !zohoStatus;
}

function assertCanEditSalesOrder(user, data, action = 'edited') {
  if (!canEditSalesOrderContent(user, data)) {
    const stage = yesOneStageOf(data);
    if (DEALER_ROLES.has(user?.role) && stage === 'ready_for_payment') {
      throw new HttpsError(
        'failed-precondition',
        'This sales order is payment due and can no longer be changed. Submit payment instead.',
      );
    }
    throw new HttpsError('failed-precondition', `This sales order cannot be ${action}.`);
  }
}

async function assertDealerOwnsSo(user, data) {
  if (!DEALER_ROLES.has(user.role)) {
    throw new HttpsError('permission-denied', 'Only dealers can perform this action.');
  }
  const customerId = await resolveZohoCustomerIdForUser(user.uid, user.role);
  if (!customerId || String(data.customerId || '') !== String(customerId)) {
    throw new HttpsError('permission-denied', 'You do not have access to this sales order.');
  }
}

function isCloudOrSpareOrder(data) {
  const segment = String(data?.yesOneOrderSegment || '').trim().toLowerCase();
  if (segment === 'spare' || segment === 'software') return true;
  const category = String(data?.salesOrderCategory || '').trim().toLowerCase();
  if (category === 'spare' || category === 'software_key') return true;
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  return categories.some(value => {
    const key = String(value || '').trim().toLowerCase();
    return key === 'spare' || key === 'software_key';
  });
}

function isSpareOrder(data) {
  const segment = String(data?.yesOneOrderSegment || '').trim().toLowerCase();
  if (segment === 'spare') return true;
  const category = String(data?.salesOrderCategory || '').trim().toLowerCase();
  return category === 'spare';
}

/**
 * Salesperson who created a Cloud or Spare order may attach payment proof
 * after it is awaiting payment (Spare Incharge approval, or Cloud which skips review).
 */
function assertCreatorCanAttachPayment(user, data) {
  if (user.role !== 'staff') return false;
  const createdBy = String(data?.yesOneCreatedByUid || '').trim();
  if (!createdBy || createdBy !== user.uid) return false;
  if (!isCloudOrSpareOrder(data)) return false;
  const stage = yesOneStageOf(data);
  if (stage === 'ready_for_payment' || stage === 'payment_submitted') return true;
  throw new HttpsError(
    'failed-precondition',
    isSpareOrder(data)
      ? 'Attach the payment screenshot after Spare Incharge approves this order.'
      : 'This sales order is not awaiting payment.',
  );
}

/** Dealer owner, staff/super_admin with orders.manage, or the Cloud/Spare order's creator. */
async function assertCanSubmitPayment(user, data) {
  if (OPS_ROLES.has(user.role)) {
    if (user.role === 'super_admin' || staffHasPermission(user, 'orders.manage')) return;
    if (assertCreatorCanAttachPayment(user, data)) return;
    throw new HttpsError('permission-denied', 'You do not have permission to manage orders.');
  }
  await assertDealerOwnsSo(user, data);
}

function lineTotal(rate, qty) {
  return Math.round(Number(rate) * Number(qty) * 100) / 100;
}

async function loadCatalogProduct(productId) {
  const db = getFirestore();
  let snap = await db.doc(`${PRODUCTS}/${productId}`).get();
  if (!snap.exists) {
    const byItem = await db.collection(PRODUCTS)
      .where('itemId', '==', String(productId))
      .limit(1)
      .get();
    if (!byItem.empty) snap = byItem.docs[0];
  }
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    productId: snap.id,
    itemId: data.itemId != null ? String(data.itemId) : snap.id,
    name: String(data.name ?? 'Product'),
    sku: data.sku != null ? String(data.sku) : null,
    description: data.description != null ? String(data.description).trim() || null : null,
    rate: Number(data.rate ?? 0),
    unit: String(data.unit ?? 'pcs'),
    stockStatus: effectiveCatalogStockStatus(
      data.stockStatus != null ? String(data.stockStatus) : null,
      data.hsn,
    ),
    categoryName: data.categoryName != null ? String(data.categoryName) : null,
    categoryId: data.categoryId != null ? String(data.categoryId) : null,
    hsn: data.hsn != null ? String(data.hsn) : null,
    status: String(data.status ?? 'active'),
    hiddenFromCatalog: Boolean(data.hiddenFromCatalog),
    warehouses: Array.isArray(data.warehouses) ? data.warehouses : [],
    gatcStampingPriceIds: Array.isArray(data.gatcStampingPriceIds)
      ? data.gatcStampingPriceIds.map(id => String(id ?? '').trim()).filter(Boolean)
      : [],
  };
}

async function buildLinesFromInput(rawLines, { allowRateOverride = true } = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new HttpsError('invalid-argument', 'Add at least one product.');
  }

  const [gatcMap, weighingScaleCategoryIds] = await Promise.all([
    loadGatcStampingPriceMap(),
    loadWeighingScaleCategoryIdSet(),
  ]);
  const merged = new Map();

  for (const row of rawLines) {
    const productId = String(row?.productId ?? row?.itemId ?? '').trim();
    const quantity = Math.floor(Number(row?.quantity ?? 0));
    if (!productId || quantity < 1) {
      throw new HttpsError('invalid-argument', 'Each line needs a product and quantity ≥ 1.');
    }
    const gatcStampingPriceId = String(row?.gatcStampingPriceId ?? '').trim() || null;
    const qcEnabled = parseQcEnabled(row?.qcEnabled);
    let baseOverride = null;
    if (allowRateOverride && row?.rate != null && row.rate !== '') {
      const parsed = Number(row.rate);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new HttpsError('invalid-argument', 'Each line rate must be a number ≥ 0.');
      }
      baseOverride = Math.round(parsed * 100) / 100;
    }
    const tentativeBase = baseOverride != null ? baseOverride : '__catalog__';
    const key = mergeKeyForLine(productId, gatcStampingPriceId, tentativeBase, qcEnabled);
    const prev = merged.get(key) || {
      productId,
      quantity: 0,
      gatcStampingPriceId,
      qcEnabled,
      baseOverride,
    };
    merged.set(key, {
      ...prev,
      quantity: prev.quantity + quantity,
      baseOverride: baseOverride != null ? baseOverride : prev.baseOverride,
    });
  }

  const lines = [];
  const priceChanges = [];
  for (const entry of merged.values()) {
    const product = await loadCatalogProduct(entry.productId);
    const isFreight = isFreightProductId(product?.id) || isFreightSku(product?.sku)
      || isFreightOrderLine({ productId: entry.productId });
    if (!product || product.status === 'inactive' || (product.hiddenFromCatalog && !isFreight)) {
      throw new HttpsError('failed-precondition', `Product unavailable: ${entry.productId}`);
    }

    const gatc = resolveGatcFeeForProduct(product, entry.gatcStampingPriceId, gatcMap);
    const qc = resolveMachineQc(product, entry.qcEnabled);
    const catalogBase = Math.round((Number(product.rate) || 0) * 100) / 100;
    const baseRate = entry.baseOverride != null ? entry.baseOverride : catalogBase;
    const rate = Math.round((baseRate + gatc.gatcFeePerUnit + qc.qcFeePerUnit) * 100) / 100;

    const isWeighingScale = Boolean(
      product.categoryId && weighingScaleCategoryIds.has(product.categoryId),
    );
    let description = product.description;
    if (gatc.gatcStampingPriceId) {
      const stampNote = `Stamping: ${gatc.gatcStampingRange}`;
      description = description ? `${description}\n${stampNote}` : stampNote;
    }
    description = appendWeighingScaleDescription(description, {
      isWeighingScale,
      hasStamping: Boolean(gatc.gatcStampingPriceId),
    });
    description = appendMachineQcDescription(description, qc);

    lines.push({
      productId: product.productId,
      itemId: product.itemId,
      name: product.name,
      sku: product.sku,
      description,
      rate,
      baseRate,
      unit: product.unit,
      quantity: entry.quantity,
      lineTotal: lineTotal(rate, entry.quantity),
      categoryName: product.categoryName,
      categoryId: product.categoryId,
      hsn: product.hsn,
      stockStatus: product.stockStatus,
      gatcStampingPriceId: gatc.gatcStampingPriceId,
      gatcFeePerUnit: gatc.gatcFeePerUnit,
      gatcStampingRange: gatc.gatcStampingRange,
      qcEnabled: qc.qcEnabled,
      qcFeePerUnit: qc.qcFeePerUnit,
      isWeighingScale,
    });

    if (Math.round(baseRate * 100) !== Math.round(catalogBase * 100)) {
      priceChanges.push({
        productId: product.productId,
        itemId: product.itemId,
        name: product.name,
        sku: product.sku,
        catalogRate: catalogBase,
        rate: baseRate,
        quantity: entry.quantity,
      });
    }
  }
  return { lines, priceChanges };
}

function firebaseDownloadUrl(bucketName, storagePath, token) {
  const encoded = encodeURIComponent(storagePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

async function durableReadUrl(storagePath) {
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'Payment screenshot not found.');
  const [metadata] = await file.getMetadata();
  let token = metadata?.metadata?.firebaseStorageDownloadTokens;
  if (Array.isArray(token)) token = token[0];
  if (typeof token === 'string' && token.includes(',')) {
    token = token.split(',')[0].trim();
  }
  if (!token) {
    token = randomUUID();
    await file.setMetadata({
      metadata: {
        ...(metadata.metadata || {}),
        firebaseStorageDownloadTokens: token,
      },
    });
  }
  return firebaseDownloadUrl(bucket.name, storagePath, token);
}

function extFromContentType(type, fileName) {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
  const lower = String(fileName ?? '').toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.webp')) return 'webp';
  return 'jpg';
}

function mapDealerCustomerInvoice(raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const storagePath = String(raw.storagePath || '').trim();
  const url = String(extra.url || raw.url || '').trim();
  const fileName = String(raw.fileName || '').trim();
  if (!storagePath && !url) return null;
  return {
    storagePath: storagePath || '',
    url: url || '',
    fileName: fileName || 'dealer-invoice.pdf',
    uploadedAt: raw.uploadedAt ? String(raw.uploadedAt) : null,
    uploadedByUid: raw.uploadedByUid ? String(raw.uploadedByUid) : null,
    uploadedByName: raw.uploadedByName ? String(raw.uploadedByName) : null,
  };
}

async function mirrorDealerCustomerInvoiceToBookings(soData, invoice) {
  const invoiceId = String(soData?.zohoInvoiceId || '').trim();
  if (!invoiceId) return;
  const db = getFirestore();
  const snap = await db.collection('logisticsBookings').where('invoiceId', '==', invoiceId).get();
  if (snap.empty) return;
  const batch = db.batch();
  const at = nowIso();
  for (const row of snap.docs) {
    batch.set(row.ref, {
      dealerCustomerInvoice: invoice || FieldValue.delete(),
      updatedAt: at,
    }, { merge: true });
  }
  await batch.commit();
}

async function detailPayload(id, data, { includePaymentUrl = false } = {}) {
  const mapped = await withCatalogLineImages(
    await withResolvedShippingAddress(mapSalesOrderDoc(id, data)),
  );
  let paymentScreenshotUrl = null;
  if (includePaymentUrl && data.paymentScreenshotStoragePath) {
    try {
      paymentScreenshotUrl = await durableReadUrl(String(data.paymentScreenshotStoragePath));
    } catch {
      paymentScreenshotUrl = null;
    }
  }
  let dealerCustomerInvoiceUrl = String(data.dealerCustomerInvoice?.url || '').trim() || null;
  const dealerInvoicePath = String(data.dealerCustomerInvoice?.storagePath || '').trim();
  if (dealerInvoicePath) {
    try {
      dealerCustomerInvoiceUrl = await durableReadUrl(dealerInvoicePath);
    } catch {
      /* keep stored url */
    }
  }
  return {
    ...mapped,
    yesOneStage: yesOneStageOf(data),
    yesOnePriceCustomized: Boolean(data.yesOnePriceCustomized),
    yesOnePriceChanges: Array.isArray(data.yesOnePriceChanges) ? data.yesOnePriceChanges : [],
    yesOneCreatedByStaff: Boolean(data.yesOneCreatedByStaff),
    yesOneCreatedByName: data.yesOneCreatedByName ? String(data.yesOneCreatedByName) : null,
    paymentAmount: data.paymentAmount != null ? Number(data.paymentAmount) : null,
    paymentUtr: data.paymentUtr ?? null,
    paymentNotes: data.paymentNotes ? String(data.paymentNotes) : null,
    paymentScreenshotStoragePath: data.paymentScreenshotStoragePath ?? null,
    paymentScreenshotUrl,
    dealerCustomerInvoice: mapDealerCustomerInvoice(data.dealerCustomerInvoice, {
      url: dealerCustomerInvoiceUrl,
    }),
    paymentSubmittedAt: data.paymentSubmittedAt ?? null,
    paymentVerifiedAt: data.paymentVerifiedAt ?? null,
    readyForPaymentAt: data.readyForPaymentAt ?? null,
    readyForPaymentByName: data.readyForPaymentByName ?? null,
    zohoInvoiceId: data.zohoInvoiceId ?? null,
    zohoInvoiceNumber: data.zohoInvoiceNumber ?? null,
    reservedKotakFeed: data.reservedKotakFeed && typeof data.reservedKotakFeed === 'object'
      ? data.reservedKotakFeed
      : null,
    yesOneSyncError: data.yesOneSyncError ? String(data.yesOneSyncError) : null,
    manuallyMarkedInvoicedAt: data.manuallyMarkedInvoicedAt ?? null,
  };
}

function inferWorkflowStageAfterRepair(data) {
  if (
    data.paymentSubmittedAt
    || String(data.paymentScreenshotStoragePath || '').trim()
    || String(data.paymentNotes || '').trim()
  ) {
    return 'payment_submitted';
  }
  if (data.readyForPaymentAt) return 'ready_for_payment';
  return 'review';
}

function kotakReservationFromFeed(feed) {
  const raw = feed && typeof feed === 'object' ? feed : {};
  const transactionId = String(raw.transactionId || '').trim();
  if (!transactionId) return null;
  return {
    transactionId,
    date: raw.date ? String(raw.date) : null,
    postedTime: raw.postedTime ? String(raw.postedTime) : null,
    amount: Number(raw.amount) || 0,
    debitOrCredit: raw.debitOrCredit ? String(raw.debitOrCredit) : null,
    payee: raw.payee ? String(raw.payee) : null,
    description: raw.description ? String(raw.description) : null,
    referenceNumber: raw.referenceNumber ? String(raw.referenceNumber) : null,
    accountId: raw.accountId ? String(raw.accountId) : '',
    importedTransactionId: raw.importedTransactionId ? String(raw.importedTransactionId) : null,
  };
}

async function applyReservedKotakPayment(secrets, orgId, {
  ref,
  data,
  invoiceId,
}) {
  const feed = kotakReservationFromFeed(data?.reservedKotakFeed);
  if (!feed || !invoiceId) return null;
  const result = await applyReservedKotakFeedToInvoice(secrets, orgId, {
    feed,
    customerId: data.customerId,
    invoiceId,
    invoiceTotal: Number(data.paymentAmount ?? data.total ?? feed.amount),
  });
  const at = nowIso();
  await ref.set({
    reservedKotakFeed: {
      ...data.reservedKotakFeed,
      ...feed,
      appliedInvoiceId: invoiceId,
      appliedAt: at,
      amountApplied: result.amountApplied,
      applyError: null,
    },
    yesOneUpdatedAt: at,
  }, { merge: true });
  await persistKotakPaidOnInvoice(data.customerId, invoiceId, result, at);
  try {
    await getFirestore().collection('kotakBankFeeds').doc(feed.transactionId).set({
      appliedInvoiceId: invoiceId,
      appliedAt: at,
    }, { merge: true });
  } catch {
    // Reservation apply still succeeded in Zoho.
  }
  return result;
}

async function persistKotakPaidOnInvoice(customerId, invoiceId, result, appliedAt) {
  const cid = String(customerId || '').trim();
  const id = String(invoiceId || '').trim();
  if (!cid || !id) return;
  try {
    const ref = invoicesCollection(cid).doc(id);
    const snap = await ref.get();
    const data = snap.data() || {};
    const total = Number(data.total ?? 0);
    const prevBalance = Number.isFinite(Number(data.balance)) ? Number(data.balance) : total;
    const applied = Number(result?.amountApplied ?? 0);
    const deducted = applied > 0 ? applied : prevBalance;
    const nextBalance = Math.max(0, Number((prevBalance - deducted).toFixed(2)));
    const paidOff = nextBalance <= 0.01;
    const payload = {
      kotakPaidAt: appliedAt,
      kotakAmountApplied: applied || null,
      status: paidOff ? 'paid' : 'partially_paid',
      balance: paidOff ? 0 : nextBalance,
    };
    await ref.set(payload, { merge: true });
    await patchInvoiceSummaryListFields(cid, id, payload);
  } catch (err) {
    console.warn(`Could not persist Kotak paid on invoice ${invoiceId}:`, err?.message || err);
  }
}

/**
 * Reserve an uncategorised Kotak pay-in for this sales order.
 * On Verify & invoice it is categorized against the created invoice (marked paid in Zoho).
 */
export async function reserveKotakFeedForSalesOrder(uid, role, payload = {}) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  const feed = kotakReservationFromFeed(payload.feed);
  if (!feed) {
    throw new HttpsError('invalid-argument', 'Select a Kotak pay-in transaction first.');
  }

  const db = getFirestore();
  const feedRef = db.collection('kotakBankFeeds').doc(feed.transactionId);
  const feedSnap = await feedRef.get();
  const reservedBy = String(feedSnap.data()?.reservedForSalesOrderId || '').trim();
  if (reservedBy && reservedBy !== id) {
    throw new HttpsError(
      'failed-precondition',
      'This bank pay-in is already reserved for another sales order.',
    );
  }

  const previousId = String(data.reservedKotakFeed?.transactionId || '').trim();
  const at = nowIso();
  if (previousId && previousId !== feed.transactionId) {
    await db.collection('kotakBankFeeds').doc(previousId).set({
      reservedForSalesOrderId: FieldValue.delete(),
      reservedAt: FieldValue.delete(),
      reservedByUid: FieldValue.delete(),
    }, { merge: true });
  }

  await feedRef.set({
    ...feed,
    reservedForSalesOrderId: id,
    reservedAt: at,
    reservedByUid: uid,
  }, { merge: true });

  await ref.set({
    reservedKotakFeed: {
      ...feed,
      reservedAt: at,
      reservedByUid: uid,
      reservedByName: displayName(user),
      appliedInvoiceId: null,
      appliedAt: null,
      applyError: null,
    },
    paymentUtr: feed.referenceNumber || feed.transactionId,
    yesOneUpdatedAt: at,
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: false });
}

/**
 * One click: reserve Kotak pay-in → convert SO to invoice → push e-invoice (no e-way)
 * → categorize the bank feed onto that invoice (marked paid in Zoho).
 */
export async function selectKotakFeedAndInvoiceSalesOrder(uid, role, payload = {}, secrets, orgId) {
  requirePaymentVerifier(await loadUser(uid));
  await reserveKotakFeedForSalesOrder(uid, role, payload);

  const user = await loadUser(uid);
  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  const stage = yesOneStageOf(data);
  if (stage === 'completed') {
    throw new HttpsError('failed-precondition', 'This sales order is already invoiced.');
  }
  if (stage === 'void') {
    throw new HttpsError('failed-precondition', 'Cannot invoice a voided sales order.');
  }

  const feed = kotakReservationFromFeed(data.reservedKotakFeed);
  const at = nowIso();
  const note = String(data.paymentNotes || '').trim()
    || `Bank pay-in ${Number(feed?.amount || 0).toFixed(2)} · Ref ${feed?.referenceNumber || feed?.transactionId || ''}`.trim();

  if (stage === 'review') {
    await ref.set({
      yesOneStage: 'ready_for_payment',
      readyForPaymentAt: at,
      readyForPaymentByUid: uid,
      readyForPaymentByName: displayName(user),
      paymentAmount: Number(data.total ?? data.subtotal ?? 0),
      yesOneUpdatedAt: at,
    }, { merge: true });
  }

  if (stage !== 'payment_submitted') {
    await ref.set({
      yesOneStage: 'payment_submitted',
      paymentNotes: note,
      paymentUtr: feed?.referenceNumber || feed?.transactionId || data.paymentUtr || null,
      paymentAmount: Number(data.total ?? data.paymentAmount ?? 0),
      paymentSubmittedAt: data.paymentSubmittedAt || at,
      paymentSubmittedByUid: data.paymentSubmittedByUid || uid,
      paymentSubmittedByName: data.paymentSubmittedByName || displayName(user),
      yesOneUpdatedAt: at,
    }, { merge: true });
  }

  return verifySalesOrderPayment(uid, role, payload.salesOrderId, secrets, orgId);
}

/** Seed YesOne workflow after cart creates a Draft SO. */
export async function initYesOneSalesOrderWorkflow(salesOrderId, extras = {}) {
  const id = String(salesOrderId || '').trim();
  if (!id) return;
  await soRef(id).set({
    yesOneStage: 'review',
    yesOneUpdatedAt: nowIso(),
    ...extras,
  }, { merge: true });
}

export async function updateDraftSalesOrderLines(uid, role, payload = {}, secrets, orgId) {
  const user = await loadUser(uid);
  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  assertCanEditSalesOrder(user, data, 'edited');

  if (OPS_ROLES.has(user.role)) {
    requireOrdersManage(user);
  } else if (DEALER_ROLES.has(user.role)) {
    await assertDealerOwnsSo(user, data);
  } else {
    throw new HttpsError('permission-denied', 'You do not have permission to edit this sales order.');
  }

  // Dealers may add/edit lines until payment (UI hides rate edit; rates come from
  // hydrated SO lines + catalog for new products).
  const { lines, priceChanges } = await buildLinesFromInput(payload.lines, {
    allowRateOverride: true,
  });

  const requiredSegment = parseOrderSegment(data.yesOneOrderSegment)
    || orderSegmentFromInvoiceCategory(data.salesOrderCategory);
  if (requiredSegment) {
    const requiredSite = parseInventorySite(data.yesOneInventorySite)
      || defaultInventorySiteForSegment(requiredSegment);
    const existingIds = new Set(
      (Array.isArray(data.lineItems) ? data.lineItems : [])
        .map(line => String(line.itemId || line.productId || '').trim())
        .filter(Boolean),
    );
    for (const line of lines) {
      if (isFreightOrderLine(line)) continue;
      const productId = String(line.productId || '').trim();
      if (!productId || existingIds.has(productId)) continue;
      const product = await loadCatalogProduct(productId);
      if (!productMatchesSalesOrderBucket(product, {
        segment: requiredSegment,
        site: requiredSite,
      })) {
        throw new HttpsError(
          'failed-precondition',
          `${line.name || 'Item'} cannot be added to this ${segmentLabel(requiredSegment)} · ${inventorySiteLabel(requiredSite)} sales order.`,
        );
      }
    }
  }

  await updateSalesOrderLines(secrets, orgId, id, lines);
  await mirrorSalesOrderFromZoho(secrets, orgId, id);
  await persistSourceMachineQc(id, lines);

  const at = nowIso();
  const actorName = displayName(user);
  const nextChanges = mergePriceChangeAudit(
    data.yesOnePriceChanges,
    priceChanges,
    { uid, name: actorName, at },
  );

  // Keep YesOne stage (review or ready_for_payment).
  const stage = yesOneStageOf(data);
  await ref.set({
    yesOneUpdatedAt: at,
    yesOneLastEditedAt: at,
    yesOneLastEditedByUid: uid,
    yesOneLastEditedByName: actorName,
    yesOnePriceCustomized: nextChanges.length > 0,
    yesOnePriceChanges: nextChanges,
    ...yesOneGatcPersistFields(lines),
    ...(stage === 'ready_for_payment'
      ? {
        paymentAmount: Math.round(
          lines.reduce((s, l) => s + Number(l.lineTotal || 0), 0) * 100,
        ) / 100,
      }
      : {}),
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

export async function updateDraftSalesOrderSparePackaging(uid, role, payload = {}, secrets, orgId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  assertCanEditSalesOrder(user, data, 'updated spare packaging');

  const input = payload.sparePackaging;
  const rows = Array.isArray(input) ? input : [];

  const normalized = rows
    .map(row => {
      const lengthCm = Number(row.lengthCm);
      const widthCm = Number(row.widthCm);
      const heightCm = Number(row.heightCm);
      const weightKg = Number(row.weightKg);
      return {
        lengthCm: Number.isFinite(lengthCm) ? lengthCm : 0,
        widthCm: Number.isFinite(widthCm) ? widthCm : 0,
        heightCm: Number.isFinite(heightCm) ? heightCm : 0,
        weightKg: Number.isFinite(weightKg) ? Math.max(0, weightKg) : 0,
        boxDefinitionId: row.boxDefinitionId ? String(row.boxDefinitionId).trim() : null,
      };
    })
    // Spare freight cartons are only considered "complete" when LBH are present.
    .filter(r => r.lengthCm > 0 && r.widthCm > 0 && r.heightCm > 0);

  await ref.set({
    sparePackaging: normalized,
    yesOneUpdatedAt: nowIso(),
    yesOneLastEditedAt: nowIso(),
    yesOneLastEditedByUid: uid,
    yesOneLastEditedByName: displayName(user),
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/** Staff/super admin: change shipping address on a Draft SO (Zoho + mirror). */
export async function updateDraftSalesOrderShipping(uid, role, payload = {}, secrets, orgId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  assertCanEditSalesOrder(user, data, 'updated for shipping');

  const customerId = String(data.customerId || '').trim();
  if (!customerId) {
    throw new HttpsError('failed-precondition', 'Sales order has no customer.');
  }

  const shippingSel = payload.shipping || {};
  const resolved = withSelectedShippingPhone(
    await resolveShippingAddressId(secrets, orgId, customerId, {
      addressId: shippingSel.addressId || null,
      kind: shippingSel.kind || null,
      newAddress: shippingSel.newAddress || null,
    }),
    shippingSel.phone,
  );

  const selectedAddress = resolved.address || null;
  const shippingPhone = String(selectedAddress?.phone || '').trim() || null;
  await updateSalesOrderShippingAddress(secrets, orgId, id, {
    shippingAddressId: resolved.shippingAddressId,
    shippingAddressInline: selectedAddress,
  });
  await mirrorSalesOrderFromZoho(secrets, orgId, id);

  await ref.set({
    shippingAddressId: resolved.shippingAddressId || null,
    shippingAddress: selectedAddress?.formatted || null,
    ...(shippingPhone ? { shippingPhone } : {}),
    yesOneUpdatedAt: nowIso(),
    yesOneLastEditedAt: nowIso(),
    yesOneLastEditedByUid: uid,
    yesOneLastEditedByName: displayName(user),
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

export async function markSalesOrderReadyForPayment(uid, role, salesOrderId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, data } = await loadSoOrThrow(salesOrderId);
  const zohoStatus = normalizeZohoStatus(data.status);
  if (zohoStatus === 'void' || zohoStatus === 'cancelled' || zohoStatus === 'canceled') {
    throw new HttpsError('failed-precondition', 'Cannot mark a voided sales order ready for payment.');
  }
  const stage = yesOneStageOf(data);
  if (stage === 'completed' || stage === 'void') {
    throw new HttpsError('failed-precondition', 'This sales order is already closed.');
  }
  if (stage === 'payment_submitted') {
    throw new HttpsError('failed-precondition', 'Payment is already submitted for this order.');
  }

  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  if (!lines.length) {
    throw new HttpsError('failed-precondition', 'Add at least one line item before requesting payment.');
  }

  const at = nowIso();
  await ref.set({
    yesOneStage: 'ready_for_payment',
    readyForPaymentAt: at,
    readyForPaymentByUid: uid,
    readyForPaymentByName: displayName(user),
    paymentAmount: Number(data.total ?? data.subtotal ?? 0),
    yesOneUpdatedAt: at,
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

export async function uploadSalesOrderPaymentScreenshot(uid, input = {}) {
  const user = await loadUser(uid);
  const { id, data } = await loadSoOrThrow(input.salesOrderId);
  await assertCanSubmitPayment(user, data);

  const stage = yesOneStageOf(data);
  if (stage !== 'ready_for_payment' && stage !== 'payment_submitted') {
    throw new HttpsError(
      'failed-precondition',
      'Payment can only be uploaded after the order is ready for payment.',
    );
  }

  const contentType = String(input.contentType || 'image/jpeg').trim();
  if (!contentType.startsWith('image/')) {
    throw new HttpsError('invalid-argument', 'Payment screenshot must be an image.');
  }
  const dataBase64 = String(input.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!dataBase64) throw new HttpsError('invalid-argument', 'Image data is required.');
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw new HttpsError('invalid-argument', 'Image data is empty.');
  if (buffer.length > MAX_PAYMENT_BYTES) {
    throw new HttpsError('invalid-argument', 'Image must be 8 MB or smaller.');
  }

  const ext = extFromContentType(contentType, input.fileName);
  const token = randomUUID();
  const storagePath = `sales-order-payments/${id}/${Date.now()}_${token.slice(0, 8)}.${ext}`;
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    resumable: false,
    contentType,
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
        uploadedByUid: uid,
        salesOrderId: id,
      },
    },
  });

  const url = firebaseDownloadUrl(bucket.name, storagePath, token);
  return { storagePath, url };
}

async function assertCanManageDealerCustomerInvoice(user, data) {
  if (OPS_ROLES.has(user.role)) return;
  await assertDealerOwnsSo(user, data);
}

export async function uploadSalesOrderDealerCustomerInvoice(uid, input = {}) {
  const user = await loadUser(uid);
  const { ref, id, data } = await loadSoOrThrow(input.salesOrderId);
  await assertCanManageDealerCustomerInvoice(user, data);
  if (yesOneStageOf(data) === 'void') {
    throw new HttpsError('failed-precondition', 'This sales order is void.');
  }

  if (input.remove === true) {
    const prevPath = String(data.dealerCustomerInvoice?.storagePath || '').trim();
    if (prevPath && prevPath.startsWith(`${DEALER_INVOICE_PREFIX}/${id}/`)) {
      try {
        await getStorage().bucket().file(prevPath).delete({ ignoreNotFound: true });
      } catch {
        /* ignore */
      }
    }
    await ref.set({
      dealerCustomerInvoice: FieldValue.delete(),
      yesOneUpdatedAt: nowIso(),
    }, { merge: true });
    await mirrorDealerCustomerInvoiceToBookings(data, null);
    const snap = await ref.get();
    return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
  }

  const contentType = String(input.contentType || 'application/pdf').trim().toLowerCase();
  if (contentType !== 'application/pdf' && contentType !== 'application/octet-stream') {
    throw new HttpsError('invalid-argument', 'Upload a PDF sales invoice.');
  }
  const dataBase64 = String(input.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!dataBase64) throw new HttpsError('invalid-argument', 'PDF data is required.');
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw new HttpsError('invalid-argument', 'PDF data is empty.');
  if (buffer.length > MAX_DEALER_INVOICE_BYTES) {
    throw new HttpsError('invalid-argument', 'PDF must be 8 MB or smaller.');
  }
  if (buffer.slice(0, 4).toString('utf8') !== '%PDF') {
    throw new HttpsError('invalid-argument', 'File is not a PDF.');
  }

  const token = randomUUID();
  const storagePath = `${DEALER_INVOICE_PREFIX}/${id}/${Date.now()}_${token.slice(0, 8)}.pdf`;
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    resumable: false,
    contentType: 'application/pdf',
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
        uploadedByUid: uid,
        salesOrderId: id,
        kind: 'dealer_customer_invoice',
      },
    },
  });
  const url = firebaseDownloadUrl(bucket.name, storagePath, token);
  const rawName = String(input.fileName || 'dealer-invoice.pdf').trim() || 'dealer-invoice.pdf';
  const fileName = rawName.replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
  const invoice = {
    storagePath,
    url,
    fileName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`,
    uploadedAt: nowIso(),
    uploadedByUid: uid,
    uploadedByName: displayName(user),
  };

  const prevPath = String(data.dealerCustomerInvoice?.storagePath || '').trim();
  if (prevPath && prevPath.startsWith(`${DEALER_INVOICE_PREFIX}/${id}/`) && prevPath !== storagePath) {
    try {
      await bucket.file(prevPath).delete({ ignoreNotFound: true });
    } catch {
      /* ignore */
    }
  }

  await ref.set({
    dealerCustomerInvoice: invoice,
    yesOneUpdatedAt: invoice.uploadedAt,
  }, { merge: true });
  await mirrorDealerCustomerInvoiceToBookings(data, invoice);
  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

export async function submitSalesOrderPayment(uid, role, payload = {}) {
  const user = await loadUser(uid);
  const { ref, id, data } = await loadSoOrThrow(payload.salesOrderId);
  await assertCanSubmitPayment(user, data);

  const stage = yesOneStageOf(data);
  if (stage !== 'ready_for_payment' && stage !== 'payment_submitted') {
    throw new HttpsError(
      'failed-precondition',
      'This sales order is not awaiting payment.',
    );
  }

  const storagePath = String(payload.paymentScreenshotStoragePath || '').trim();
  const notes = String(payload.paymentNotes || '').trim().slice(0, 1000);
  const utr = String(payload.paymentUtr || '').trim().slice(0, 80);

  if (storagePath && !storagePath.startsWith(`sales-order-payments/${id}/`)) {
    throw new HttpsError('invalid-argument', 'Invalid payment screenshot path.');
  }
  if (!storagePath && !notes) {
    throw new HttpsError(
      'invalid-argument',
      'Attach a payment screenshot or add a payment note (e.g. existing credit).',
    );
  }

  const at = nowIso();
  let paymentScreenshotUrl = null;
  if (storagePath) {
    try {
      paymentScreenshotUrl = await durableReadUrl(storagePath);
    } catch {
      paymentScreenshotUrl = null;
    }
  }

  await ref.set({
    yesOneStage: 'payment_submitted',
    paymentScreenshotStoragePath: storagePath || null,
    paymentScreenshotUrl,
    paymentUtr: utr || null,
    paymentNotes: notes || null,
    paymentAmount: Number(data.total ?? data.paymentAmount ?? 0),
    paymentSubmittedAt: at,
    paymentSubmittedByUid: uid,
    paymentSubmittedByName: displayName(user),
    yesOneUpdatedAt: at,
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: false });
}

/**
 * Safna or Shalima: verify payment → Confirm Zoho SO
 * → create Invoice → (B2B only) push e-invoice to IRP (no e-way bill)
 * → mark invoice Sent → completed.
 * E-way bills are generated later by logistics (Generate e-way bill).
 */
export async function verifySalesOrderPayment(uid, role, salesOrderId, secrets, orgId) {
  const user = await loadUser(uid);
  requirePaymentVerifier(user);

  const { ref, id, data } = await loadSoOrThrow(salesOrderId);
  if (yesOneStageOf(data) !== 'payment_submitted') {
    throw new HttpsError(
      'failed-precondition',
      'Payment must be submitted before verification.',
    );
  }
  const hasScreenshot = Boolean(String(data.paymentScreenshotStoragePath || '').trim());
  const hasNotes = Boolean(String(data.paymentNotes || '').trim());
  if (!hasScreenshot && !hasNotes) {
    throw new HttpsError(
      'failed-precondition',
      'Payment screenshot or payment note is missing.',
    );
  }

  const zohoStatus = normalizeZohoStatus(data.status);
  if (zohoStatus === 'void' || zohoStatus === 'cancelled' || zohoStatus === 'canceled') {
    throw new HttpsError('failed-precondition', 'Cannot verify payment on a voided sales order.');
  }

  try {
    if (zohoStatus !== 'invoiced' && zohoStatus !== 'closed') {
      await confirmSalesOrder(secrets, orgId, id);
    }

    const { salespersonId } = requireSalespersonOnSalesOrder(data);

    let invoiceId = data.zohoInvoiceId || null;
    let invoiceNumber = data.zohoInvoiceNumber || null;
    if (!invoiceId) {
      try {
        const linked = await getSalesOrderLinkedInvoice(secrets, orgId, id);
        if (linked.invoiceId) {
          invoiceId = linked.invoiceId;
          invoiceNumber = linked.invoiceNumber || invoiceNumber;
        }
      } catch (linkErr) {
        console.warn(
          `Could not load linked Zoho invoice before verify for SO ${id}:`,
          linkErr?.message || linkErr,
        );
      }
    }
    if (!invoiceId) {
      try {
        await ensureFreightDiffOnInvoicingSalesOrder(getFirestore(), {
          secrets,
          orgId,
          salesOrderId: id,
          zohoCustomerId: data.customerId,
        });
      } catch (freightErr) {
        console.warn(
          `Freight diff ensure before invoice failed for SO ${id}:`,
          freightErr?.message || freightErr,
        );
      }
      const inv = await createInvoiceFromSalesOrder(secrets, orgId, {
        salesOrderId: id,
        customerId: data.customerId,
        referenceNumber: data.referenceNumber,
        salespersonId,
        courierPartner: data.yesOneCourierPartner || null,
        shippingPhone: data.shippingPhone || null,
      });
      invoiceId = inv.invoiceId;
      invoiceNumber = inv.invoiceNumber;
      try {
        await settleFreightDiffOnInvoice(getFirestore(), {
          salesOrderId: id,
          invoiceId,
          invoiceNumber,
          zohoCustomerId: data.customerId,
        });
      } catch (freightErr) {
        console.warn(
          `Freight diff settle after invoice failed for SO ${id}:`,
          freightErr?.message || freightErr,
        );
      }
    }

    try {
      await syncSingleInvoiceFromZoho(secrets, orgId, invoiceId, {
        skipPdfs: true,
        skipImages: true,
        skipFreightDiffSettle: true,
        source: 'payment_verify_pre_einvoice',
      });
    } catch (syncErr) {
      console.warn(
        `Invoice mirror before e-invoice failed for ${invoiceId} (SO ${id}):`,
        syncErr?.message ?? syncErr,
      );
    }

    let einvoicePushStatus = 'skipped_not_b2b';
    let einvoicePushError = null;
    const customer = await resolveCustomerForEinvoice(secrets, orgId, data.customerId);
    if (isZohoCustomerEinvoicePushEligible(customer)) {
      try {
        await pushInvoiceEinvoiceToIrp(secrets, orgId, invoiceId);
        einvoicePushStatus = 'pushed';
      } catch (pushErr) {
        einvoicePushStatus = 'failed';
        einvoicePushError = String(pushErr?.message || 'E-invoice push failed.');
        console.warn(
          `E-invoice push failed for invoice ${invoiceId} (SO ${id}):`,
          einvoicePushError,
        );
      }
    }

    const latest = (await ref.get()).data() || data;
    if (kotakReservationFromFeed(latest.reservedKotakFeed)) {
      try {
        await applyReservedKotakPayment(secrets, orgId, {
          ref,
          data: latest,
          invoiceId,
        });
      } catch (payErr) {
        const message = String(payErr?.message || 'Could not mark the invoice paid from the reserved Kotak pay-in.');
        await ref.set({
          reservedKotakFeed: {
            ...(latest.reservedKotakFeed || {}),
            applyError: message,
          },
          yesOneUpdatedAt: nowIso(),
        }, { merge: true });
        throw new Error(message);
      }
    }

    try {
      await markInvoiceAsSent(secrets, orgId, invoiceId);
    } catch (sentErr) {
      console.warn(
        `Could not mark invoice ${invoiceId} as sent after payment verify (SO ${id}):`,
        sentErr?.message || sentErr,
      );
    }

    await mirrorSalesOrderFromZoho(secrets, orgId, id);

    const at = nowIso();
    await ref.set({
      yesOneStage: 'completed',
      paymentVerifiedAt: at,
      paymentVerifiedByUid: uid,
      paymentVerifiedByName: displayName(user),
      zohoInvoiceId: invoiceId,
      zohoInvoiceNumber: invoiceNumber,
      einvoicePushStatus,
      einvoicePushError,
      einvoicePushedAt: einvoicePushStatus === 'pushed' ? at : null,
      yesOneUpdatedAt: at,
      yesOneSyncError: null,
    }, { merge: true });

    const soSnap = await ref.get();
    const soData = soSnap.data() || data;
    try {
      try {
        await syncSingleInvoiceFromZoho(secrets, orgId, invoiceId, {
          skipPdfs: true,
          skipImages: true,
          skipFreightDiffSettle: true,
          source: 'payment_verify',
        });
      } catch (syncErr) {
        console.warn(
          `Invoice mirror after verify failed for ${invoiceId} (SO ${id}):`,
          syncErr?.message ?? syncErr,
        );
      }
      const kotakFeed = kotakReservationFromFeed(soData.reservedKotakFeed);
      if (kotakFeed && soData.reservedKotakFeed?.appliedAt) {
        await persistKotakPaidOnInvoice(soData.customerId, invoiceId, {
          amountApplied: Number(soData.reservedKotakFeed.amountApplied ?? kotakFeed.amount ?? 0),
        }, soData.reservedKotakFeed.appliedAt);
      }
      const invoice = await loadInvoiceDocById(invoiceId);
      await writeGatcReportFromSalesOrder({
        soId: id,
        soData,
        invoiceId,
        invoiceNumber,
        invoice,
        source: 'portal_verify',
      });
    } catch (gatcErr) {
      console.warn(
        `GATC report write failed for invoice ${invoiceId} (SO ${id}):`,
        gatcErr?.message ?? gatcErr,
      );
    }
  } catch (err) {
    const message = err?.message || 'Could not complete sales order in Zoho.';
    await ref.set({
      yesOneSyncError: message,
      yesOneUpdatedAt: nowIso(),
    }, { merge: true });
    throw new HttpsError('internal', message);
  }

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/**
 * Manually mark a YesOne SO as invoiced after it was processed in Zoho outside the portal.
 * Does not create a Zoho invoice — refreshes the SO mirror and sets stage to completed.
 */
export async function markSalesOrderInvoicedManually(uid, role, salesOrderId, secrets, orgId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id, data } = await loadSoOrThrow(salesOrderId);
  const stage = yesOneStageOf(data);
  if (stage === 'completed') {
    throw new HttpsError('failed-precondition', 'This sales order is already marked invoiced.');
  }
  if (stage === 'void') {
    throw new HttpsError('failed-precondition', 'Cannot mark a voided sales order as invoiced.');
  }

  const zohoStatus = normalizeZohoStatus(data.status);
  if (zohoStatus === 'void' || zohoStatus === 'cancelled' || zohoStatus === 'canceled') {
    throw new HttpsError('failed-precondition', 'Cannot mark a voided Zoho sales order as invoiced.');
  }

  let invoiceId = data.zohoInvoiceId ? String(data.zohoInvoiceId).trim() : null;
  let invoiceNumber = data.zohoInvoiceNumber ? String(data.zohoInvoiceNumber).trim() : null;

  try {
    await mirrorSalesOrderFromZoho(secrets, orgId, id);
  } catch (err) {
    console.warn(`Mirror before manual invoice mark failed for SO ${id}:`, err?.message || err);
  }

  let linkedLookupError = null;
  try {
    const linked = await getSalesOrderLinkedInvoice(secrets, orgId, id);
    if (linked.invoiceId) {
      invoiceId = linked.invoiceId;
      invoiceNumber = linked.invoiceNumber || invoiceNumber;
    }
  } catch (err) {
    linkedLookupError = err;
    console.warn(`Could not load linked Zoho invoices for SO ${id}:`, err?.message || err);
  }

  if (!invoiceId) {
    const message = linkedLookupError
      ? `Could not confirm a Zoho invoice for this sales order: ${linkedLookupError.message || linkedLookupError}`
      : 'No invoice is linked to this sales order in Zoho.';
    throw new HttpsError('failed-precondition', message, { code: 'mark_invoiced_no_zoho_invoice' });
  }

  if (kotakReservationFromFeed(data.reservedKotakFeed)) {
    try {
      await applyReservedKotakPayment(secrets, orgId, {
        ref,
        data,
        invoiceId,
      });
    } catch (payErr) {
      const message = String(payErr?.message || 'Could not mark the invoice paid from the reserved Kotak pay-in.');
      await ref.set({
        reservedKotakFeed: {
          ...(data.reservedKotakFeed || {}),
          applyError: message,
        },
        yesOneUpdatedAt: nowIso(),
      }, { merge: true });
      throw new HttpsError('internal', message);
    }
  }

  try {
    await markInvoiceAsSent(secrets, orgId, invoiceId);
  } catch (sentErr) {
    console.warn(
      `Could not mark invoice ${invoiceId} as sent on manual invoice mark (SO ${id}):`,
      sentErr?.message || sentErr,
    );
  }

  const at = nowIso();
  try {
    if (secrets && orgId) {
      await ensureFreightDiffOnInvoicingSalesOrder(getFirestore(), {
        secrets,
        orgId,
        salesOrderId: id,
        zohoCustomerId: data.customerId,
      });
    }
    await settleFreightDiffOnInvoice(getFirestore(), {
      salesOrderId: id,
      invoiceId,
      invoiceNumber,
      zohoCustomerId: data.customerId,
    });
  } catch (freightErr) {
    console.warn(
      `Freight diff settle on manual invoice mark failed for SO ${id}:`,
      freightErr?.message || freightErr,
    );
  }

  await ref.set({
    yesOneStage: 'completed',
    zohoInvoiceId: invoiceId || null,
    zohoInvoiceNumber: invoiceNumber || null,
    manuallyMarkedInvoicedAt: at,
    manuallyMarkedInvoicedByUid: uid,
    manuallyMarkedInvoicedByName: displayName(user),
    yesOneUpdatedAt: at,
    yesOneSyncError: null,
  }, { merge: true });

  if (invoiceId) {
    const soSnap = await ref.get();
    const soData = soSnap.data() || data;
    try {
      try {
        await syncSingleInvoiceFromZoho(secrets, orgId, invoiceId, {
          skipPdfs: true,
          skipImages: true,
          skipFreightDiffSettle: true,
          source: 'manual_invoice_mark',
        });
      } catch (syncErr) {
        console.warn(
          `Invoice mirror after manual mark failed for ${invoiceId} (SO ${id}):`,
          syncErr?.message ?? syncErr,
        );
      }
      const invoice = await loadInvoiceDocById(invoiceId);
      await writeGatcReportFromSalesOrder({
        soId: id,
        soData,
        invoiceId,
        invoiceNumber,
        invoice,
        source: 'manual_invoice_mark',
      });
    } catch (gatcErr) {
      console.warn(
        `GATC report write failed for manual invoice mark ${invoiceId} (SO ${id}):`,
        gatcErr?.message ?? gatcErr,
      );
    }
  }

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/**
 * Reset a false "completed" mark (yesOneStage completed but no linked Zoho invoice).
 * Restores the workflow stage from payment / ready-for-payment history.
 */
export async function repairSalesOrderInvoicingMismatch(uid, role, salesOrderId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, data } = await loadSoOrThrow(salesOrderId);
  if (yesOneStageOf(data) !== 'completed') {
    throw new HttpsError(
      'failed-precondition',
      'This sales order is not marked completed in YesOne.',
    );
  }
  if (String(data.zohoInvoiceId || '').trim()) {
    throw new HttpsError(
      'failed-precondition',
      'This sales order already has a linked invoice.',
    );
  }
  if (data.paymentVerifiedAt) {
    throw new HttpsError(
      'failed-precondition',
      'Payment was verified on this order. Contact support instead of resetting the workflow.',
    );
  }

  const restoredStage = inferWorkflowStageAfterRepair(data);
  const at = nowIso();
  await ref.set({
    yesOneStage: restoredStage,
    zohoInvoiceId: null,
    zohoInvoiceNumber: null,
    manuallyMarkedInvoicedAt: FieldValue.delete(),
    manuallyMarkedInvoicedByUid: FieldValue.delete(),
    manuallyMarkedInvoicedByName: FieldValue.delete(),
    yesOneSyncError: null,
    yesOneUpdatedAt: at,
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/** Void Zoho SO and mark YesOne workflow void. */
export async function voidSalesOrderWithWorkflow(uid, role, salesOrderId, reason, secrets, orgId) {
  const user = await loadUser(uid);
  requireOrdersManage(user);

  const { ref, id } = await loadSoOrThrow(salesOrderId);
  try {
    await releaseFreightDiffReservation(getFirestore(), {
      salesOrderId: id,
      secrets,
      orgId,
      stripZoho: true,
    });
  } catch (freightErr) {
    console.warn(`Freight diff release on void failed for SO ${id}:`, freightErr?.message || freightErr);
  }
  await voidSalesOrder(secrets, orgId, id, reason);
  await mirrorSalesOrderFromZoho(secrets, orgId, id);
  await ref.set({
    yesOneStage: 'void',
    yesOneUpdatedAt: nowIso(),
    voidedAt: nowIso(),
    voidedByUid: uid,
    voidedByName: displayName(user),
    voidReason: String(reason || '').trim().slice(0, 500) || null,
  }, { merge: true });

  const snap = await ref.get();
  return detailPayload(snap.id, snap.data() || {}, { includePaymentUrl: true });
}

/**
 * Delete a Draft Zoho SO (Zoho DELETE) and remove the Firestore mirror.
 * Staff/super_admin with orders.manage, or the owning dealer.
 */
export async function deleteDraftSalesOrder(uid, role, salesOrderId, secrets, orgId) {
  const user = await loadUser(uid);
  const { ref, id, data } = await loadSoOrThrow(salesOrderId);

  if (OPS_ROLES.has(user.role)) {
    requireOrdersManage(user);
  } else if (DEALER_ROLES.has(user.role)) {
    await assertDealerOwnsSo(user, data);
  } else {
    throw new HttpsError('permission-denied', 'You cannot delete this sales order.');
  }

  const zohoStatus = normalizeZohoStatus(data.status);
  if (zohoStatus !== 'draft' && zohoStatus !== 'pending') {
    throw new HttpsError(
      'failed-precondition',
      'Only Draft sales orders can be deleted. Use Void for confirmed orders.',
    );
  }
  const stage = yesOneStageOf(data);
  const superAdminDelete = isFullSuperAdmin(user);
  if (stage === 'completed' || stage === 'void') {
    throw new HttpsError(
      'failed-precondition',
      'This sales order can no longer be deleted.',
    );
  }
  if (stage === 'payment_submitted' && !superAdminDelete) {
    throw new HttpsError(
      'failed-precondition',
      'This sales order can no longer be deleted.',
    );
  }

  try {
    await releaseFreightDiffReservation(getFirestore(), {
      salesOrderId: id,
      secrets,
      orgId,
      stripZoho: true,
    });
  } catch (freightErr) {
    console.warn(`Freight diff release on delete failed for SO ${id}:`, freightErr?.message || freightErr);
  }

  try {
    await deleteSalesOrder(secrets, orgId, id);
  } catch (err) {
    const message = String(err?.message || err || '');
    console.error(`deleteDraftSalesOrder Zoho delete failed for ${id}:`, message);
    // Already gone in Zoho — still clear the portal mirror.
    if (/not found|does not exist|invalid|404/i.test(message)) {
      // continue
    } else if (/cannot be deleted|not (?:allowed|permitted)|only draft|status/i.test(message)) {
      throw new HttpsError(
        'failed-precondition',
        message || 'This sales order cannot be deleted in Zoho. Use Void for confirmed orders.',
      );
    } else {
      throw new HttpsError('internal', message || 'Could not delete sales order in Zoho.');
    }
  }

  try {
    await ref.delete();
  } catch (err) {
    console.error(`deleteDraftSalesOrder Firestore delete failed for ${id}:`, err?.message || err);
    throw new HttpsError(
      'internal',
      err?.message || 'Deleted in Zoho but could not remove the portal copy.',
    );
  }
  return { salesOrderId: id, deleted: true };
}

export async function getSalesOrderWorkflowDetail(uid, role, salesOrderId) {
  const user = await loadUser(uid);
  const { id, data } = await loadSoOrThrow(salesOrderId);

  if (OPS_ROLES.has(user.role)) {
    if (user.role === 'staff' && !staffHasPermission(user, 'orders.view')) {
      throw new HttpsError('permission-denied', 'You do not have access to orders.');
    }
    return detailPayload(id, data, { includePaymentUrl: true });
  }

  await assertDealerOwnsSo(user, data);
  return detailPayload(id, data, { includePaymentUrl: false });
}

export function sumWorkflowItemCount(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((sum, line) => {
    if (isQuantityExcludedLineItem(line?.name, line?.sku, line?.hsn)) return sum;
    return sum + Number(line?.quantity || 0);
  }, 0);
}
