import crypto from 'node:crypto';
import { getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE } from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
  isZohoDailyQuotaBlocked,
} from './zoho-api-usage.js';
import { ackZohoWebhookFailure, ackIfDailyQuotaBlocked } from './zoho-webhook-guard.js';
import {
  mapInvoice,
  mapInvoiceLineItem,
  buildInvoiceSearchBlob,
  firestoreDocToListInvoice,
  firestoreDocToDetail,
} from './invoice-mappers.js';
import { formatZohoAddress } from './zoho-contact-fields.js';
import {
  classifyInvoiceCategoryBreakdown,
  classifyInvoiceFromLineItems,
  isGenericSpareCategoryName,
  parseInvoiceCategory,
} from './invoice-category.js';
import {
  amountExclGst,
  deleteInvoiceSummary,
  reconcileInvoiceStats,
  sumInvoiceItemQuantity,
  writeInvoiceSummaryAndReconcile,
} from './invoice-stats.js';
import { markInvoiceAsSent } from './zoho-sales-orders.js';
import { freightSkuFromInvoiceLines } from './freight-lines.js';

const CUSTOMERS_COLLECTION = 'zohoCustomers';
const INVOICES_SUBCOLLECTION = 'invoices';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resolveStorageBucketName() {
  const fromEnv = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (fromEnv) return fromEnv;

  const projectId =
    process.env.GCLOUD_PROJECT?.trim()
    ?? process.env.GCP_PROJECT?.trim()
    ?? process.env.GOOGLE_CLOUD_PROJECT?.trim();

  if (projectId) return `${projectId}.firebasestorage.app`;

  try {
    const app = getApp();
    if (app.options.storageBucket) return app.options.storageBucket;
    if (app.options.projectId) return `${app.options.projectId}.firebasestorage.app`;
  } catch {
    // App not initialized yet.
  }

  return null;
}

function storageBucket() {
  const bucketName = resolveStorageBucketName();
  if (bucketName) return getStorage().bucket(bucketName);
  return getStorage().bucket();
}

function invoicesCollection(customerId) {
  return getFirestore()
    .collection(CUSTOMERS_COLLECTION)
    .doc(String(customerId))
    .collection(INVOICES_SUBCOLLECTION);
}

function customerInvoiceMetaRef(customerId) {
  return getFirestore()
    .collection(CUSTOMERS_COLLECTION)
    .doc(String(customerId))
    .collection('invoiceMeta')
    .doc('sync');
}

function invoiceIndexRef(invoiceId) {
  return getFirestore().collection('invoiceIndex').doc(String(invoiceId));
}

function globalInvoiceMetaRef() {
  return getFirestore().collection('invoiceMeta').doc('sync');
}

function invoicePdfPath(customerId, invoiceId) {
  return `invoices/${customerId}/${invoiceId}.pdf`;
}

function salesOrderPdfPath(customerId, salesOrderId) {
  return `invoices/${customerId}/so-${salesOrderId}.pdf`;
}

async function zohoJsonRequest(accessToken, orgId, path) {
  const url = new URL(`${ZOHO_API_BASE}${path}`);
  url.searchParams.set('organization_id', orgId);
  const res = await fetch(url.toString(), {
    headers: authHeaders(accessToken, orgId),
  });
  await recordZohoApiResponse(res, { operation: path, source: 'invoice-sync' });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err = classifyZohoHttpError(res.status, payload);
    await recordZohoApiFailure(err, { operation: path, source: 'invoice-sync' });
    throw err;
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    const err = classifyZohoHttpError(429, payload);
    if (payload.code === 43 || String(payload.message ?? '').toLowerCase().includes('rate')) {
      await recordZohoApiFailure(err, { operation: path, source: 'invoice-sync' });
    }
    const apiErr = new Error(payload.message || 'Zoho API error.');
    apiErr.zohoCode = payload.code;
    throw apiErr;
  }
  return payload;
}

async function fetchInvoiceRaw(accessToken, orgId, invoiceId) {
  const payload = await zohoJsonRequest(accessToken, orgId, `/invoices/${invoiceId}`);
  return payload?.invoice ?? null;
}

async function fetchZohoPdf(accessToken, orgId, resource, id) {
  const url = new URL(`${ZOHO_API_BASE}/${resource}/${id}`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('accept', 'pdf');
  url.searchParams.set('t', String(Date.now()));
  const res = await fetch(url.toString(), {
    headers: {
      ...authHeaders(accessToken, orgId),
      Accept: 'application/pdf',
    },
  });
  await recordZohoApiResponse(res, { operation: `${resource}/${id}/pdf`, source: 'invoice-sync' });
  if (!res.ok) {
    if (res.status === 429) {
      const err = new Error('Zoho rate limit exceeded.');
      err.code = 'RATE_LIMITED';
      await recordZohoApiFailure(err, { operation: `${resource}/${id}/pdf`, source: 'invoice-sync' });
      throw err;
    }
    const text = await res.text();
    let message = `Could not download ${resource} PDF (${res.status}).`;
    try {
      const payload = JSON.parse(text);
      if (payload?.message) message = payload.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('PDF file is empty.');
  return buffer;
}

async function fetchInvoicesListPage(accessToken, orgId, page, options = {}) {
  const url = new URL(`${ZOHO_API_BASE}/invoices`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '200');
  url.searchParams.set('sort_column', options.sortColumn ?? 'last_modified_time');
  url.searchParams.set('sort_order', options.sortOrder ?? 'D');
  if (options.customerId) url.searchParams.set('customer_id', options.customerId);

  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  await recordZohoApiResponse(res, { operation: `invoices/list?page=${page}`, source: 'invoice-sync' });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const err = classifyZohoHttpError(res.status, payload);
    err.message = payload?.message || err.message;
    await recordZohoApiFailure(err, { operation: `invoices/list?page=${page}`, source: 'invoice-sync' });
    throw err;
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    const err = classifyZohoHttpError(429, payload);
    if (String(payload.message ?? '').toLowerCase().includes('rate')) {
      await recordZohoApiFailure(err, { operation: `invoices/list?page=${page}`, source: 'invoice-sync' });
      throw err;
    }
    const apiErr = new Error(payload.message || 'Zoho invoices API error.');
    apiErr.zohoCode = payload.code;
    throw apiErr;
  }

  return {
    invoices: payload?.invoices ?? [],
    hasMore: Boolean(payload?.page_context?.has_more_page),
  };
}

async function fetchAllInvoiceSummaries(accessToken, orgId, options = {}) {
  const invoices = [];
  let page = 1;
  const maxPages = options.maxPages ?? 100;

  while (page <= maxPages) {
    const batch = await fetchInvoicesListPage(accessToken, orgId, page, options);
    invoices.push(...batch.invoices);
    if (!batch.hasMore) break;
    page += 1;
    if (options.delayMs) await sleep(options.delayMs);
  }

  return invoices;
}

function shippingFromSalesOrderRaw(so) {
  if (!so || typeof so !== 'object') {
    return { shippingAddress: null, shippingAddressId: null };
  }
  return {
    shippingAddress: formatZohoAddress(so.shipping_address) ?? null,
    shippingAddressId: so.shipping_address_id != null
      ? String(so.shipping_address_id).trim() || null
      : (so.shipping_address?.address_id != null
        ? String(so.shipping_address.address_id).trim() || null
        : null),
  };
}

/** Prefer mirrored Firestore SO shipping when Zoho invoice omitted ship-to. */
async function shippingFromMirroredSalesOrder(salesOrderId) {
  const id = String(salesOrderId || '').trim();
  if (!id) return { shippingAddress: null, shippingAddressId: null };
  try {
    const snap = await getFirestore().collection('salesOrders').doc(id).get();
    if (!snap.exists) return { shippingAddress: null, shippingAddressId: null };
    const data = snap.data() || {};
    return {
      shippingAddress: data.shippingAddress ? String(data.shippingAddress).trim() || null : null,
      shippingAddressId: data.shippingAddressId
        ? String(data.shippingAddressId).trim() || null
        : null,
    };
  } catch {
    return { shippingAddress: null, shippingAddressId: null };
  }
}

async function sparePackagingFromSalesOrderId(salesOrderId) {
  const id = String(salesOrderId || '').trim();
  if (!id) return null;
  try {
    const snap = await getFirestore().collection('salesOrders').doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    return Array.isArray(data.sparePackaging) ? data.sparePackaging : null;
  } catch {
    return null;
  }
}

async function resolveSalesOrder(accessToken, orgId, customerId, invoiceRaw) {
  const salesOrderId = invoiceRaw.salesorder_id ? String(invoiceRaw.salesorder_id) : null;
  const referenceNumber = invoiceRaw.reference_number ? String(invoiceRaw.reference_number) : null;

  if (salesOrderId) {
    try {
      const payload = await zohoJsonRequest(accessToken, orgId, `/salesorders/${salesOrderId}`);
      const so = payload?.salesorder;
      if (so && String(so.customer_id) === customerId) {
        const shipping = shippingFromSalesOrderRaw(so);
        return {
          id: String(so.salesorder_id),
          number: so.salesorder_number ? String(so.salesorder_number) : referenceNumber,
          ...shipping,
        };
      }
    } catch {
      // Fall back to search by reference number.
    }
  }

  if (!referenceNumber) return null;

  const url = new URL(`${ZOHO_API_BASE}/salesorders`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('customer_id', customerId);
  url.searchParams.set('search_text', referenceNumber);
  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok || payload?.code !== 0) return null;

  const orders = payload?.salesorders ?? [];
  const match =
    orders.find(so => String(so.salesorder_number) === referenceNumber)
    ?? orders.find(so => String(so.reference_number) === referenceNumber)
    ?? orders[0];

  if (!match) return null;
  return {
    id: String(match.salesorder_id),
    number: match.salesorder_number ? String(match.salesorder_number) : referenceNumber,
  };
}

/** @returns {Map<string, { imageUrl: string|null, hsn: string|null, categoryId: string|null, categoryName: string|null }>} */
async function getCatalogMetaForItems(itemIds) {
  const unique = [...new Set(itemIds.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const db = getFirestore();
  const refs = unique.map(id => db.collection('catalogProducts').doc(id));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const data = snap.data() || {};
    map.set(snap.id, {
      imageUrl: data.imageUrl ?? null,
      hsn: data.hsn != null ? String(data.hsn) : null,
      categoryId: data.categoryId != null ? String(data.categoryId) : null,
      categoryName: data.categoryName != null ? String(data.categoryName) : null,
      modelNumber: data.modelNumber != null ? String(data.modelNumber).trim() || null : null,
      isWeighingScale: false,
    });
  }
  const categoryIds = [...new Set(
    [...map.values()].map(meta => meta.categoryId).filter(Boolean),
  )];
  if (categoryIds.length) {
    const catSnaps = await db.getAll(
      ...categoryIds.map(id => db.collection('catalogCategories').doc(id)),
    );
    const weighing = new Set(
      catSnaps.filter(snap => snap.exists && snap.data()?.isWeighingScale).map(snap => snap.id),
    );
    for (const meta of map.values()) {
      meta.isWeighingScale = Boolean(meta.categoryId && weighing.has(meta.categoryId));
    }
  }
  return map;
}

async function uploadPdfToStorage(storagePath, buffer) {
  const bucket = storageBucket();
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType: 'application/pdf',
    metadata: { cacheControl: 'private, max-age=0, must-revalidate' },
    resumable: false,
  });
  return storagePath;
}

async function readPdfFromStorage(storagePath) {
  const bucket = storageBucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  return buffer.length ? buffer : null;
}

function millisFromUnknown(value) {
  if (value == null || value === '') return null;
  if (typeof value.toMillis === 'function') {
    try { return value.toMillis(); } catch { return null; }
  }
  if (typeof value.toDate === 'function') {
    try { return value.toDate().getTime(); } catch { return null; }
  }
  const seconds = Number(value.seconds ?? value._seconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function cachedInvoicePdfIsStale(storagePath, data) {
  const zohoMs = millisFromUnknown(data?.zohoLastModified) ?? millisFromUnknown(data?.syncedAt);
  if (zohoMs == null) return false;
  const cachedMs = millisFromUnknown(data?.pdfCachedAt);
  if (cachedMs != null) return zohoMs > cachedMs + 1000;
  const file = storageBucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return true;
  const [metadata] = await file.getMetadata();
  const updated = Date.parse(String(metadata.updated || metadata.timeCreated || ''));
  if (!Number.isFinite(updated)) return false;
  return zohoMs > updated + 1000;
}

function zohoContentFingerprint(invoiceRaw) {
  return [
    invoiceRaw.last_modified_time,
    invoiceRaw.status,
    invoiceRaw.total,
    invoiceRaw.balance,
    invoiceRaw.invoice_number,
    (invoiceRaw.line_items ?? []).length,
    invoiceRaw.shipping_address_id,
    invoiceRaw.shipping_address?.address,
    invoiceRaw.shipping_address?.zip,
  ].join('|');
}

async function buildFirestoreInvoiceDoc(accessToken, orgId, invoiceRaw, options = {}) {
  const customerId = String(invoiceRaw.customer_id);
  const invoiceId = String(invoiceRaw.invoice_id);
  const lineItemsRaw = invoiceRaw.line_items ?? [];
  const itemIds = lineItemsRaw.map(item => (item.item_id ? String(item.item_id) : null));
  // Always load catalog meta for HSN/category classification (and optional images).
  const catalogMap = await getCatalogMetaForItems(itemIds);
  const lineItems = lineItemsRaw.map(item => {
    const itemId = item.item_id ? String(item.item_id) : null;
    const meta = itemId ? catalogMap.get(itemId) : null;
    const mapped = mapInvoiceLineItem(
      item,
      options.skipImages ? null : (meta?.imageUrl ?? null),
    );
    return {
      ...mapped,
      hsn: mapped.hsn || meta?.hsn || null,
      ...(meta?.categoryId ? { categoryId: meta.categoryId } : {}),
      ...(meta?.categoryName ? { categoryName: meta.categoryName } : {}),
      ...(meta?.isWeighingScale ? { isWeighingScale: true } : {}),
    };
  });
  const classifyInput = lineItemsRaw.map(item => {
    const itemId = item.item_id ? String(item.item_id) : null;
    return {
      total: Number(item.item_total ?? item.total ?? 0),
      name: String(item.name ?? item.item_name ?? ''),
      sku: item.sku ? String(item.sku) : null,
      itemId,
      hsn: item.hsn_or_sac ?? item.hsnOrSac ?? item.hsn ?? null,
    };
  });
  const categoryBreakdown = classifyInvoiceCategoryBreakdown(classifyInput, catalogMap);
  const invoiceCategory = categoryBreakdown.categories[0]
    ?? classifyInvoiceFromLineItems(classifyInput, catalogMap);
  const salesOrder = options.skipSalesOrder
    ? null
    : await resolveSalesOrder(accessToken, orgId, customerId, invoiceRaw);

  const summary = mapInvoice(invoiceRaw);
  const searchBlob = buildInvoiceSearchBlob(invoiceRaw);
  const fingerprint = zohoContentFingerprint(invoiceRaw);

  const salesOrderId = options.skipSalesOrder
    ? (invoiceRaw.salesorder_id ? String(invoiceRaw.salesorder_id) : null)
    : (salesOrder?.id ?? (invoiceRaw.salesorder_id ? String(invoiceRaw.salesorder_id) : null));

  const sparePackaging = invoiceCategory === 'spare' && salesOrderId
    ? await sparePackagingFromSalesOrderId(salesOrderId)
    : null;

  let shippingAddress = summary.shippingAddress || null;
  let shippingAddressId = summary.shippingAddressId || null;
  if (!shippingAddress && salesOrder?.shippingAddress) {
    shippingAddress = salesOrder.shippingAddress;
    shippingAddressId = salesOrder.shippingAddressId || shippingAddressId;
  }
  if (!shippingAddress && salesOrderId) {
    const mirrored = await shippingFromMirroredSalesOrder(salesOrderId);
    if (mirrored.shippingAddress) {
      shippingAddress = mirrored.shippingAddress;
      shippingAddressId = mirrored.shippingAddressId || shippingAddressId;
    }
  }

  return {
    ...summary,
    customerId,
    searchBlob,
    salesOrderId: options.skipSalesOrder ? (salesOrderId || null) : (salesOrder?.id ?? salesOrderId),
    salesOrderNumber: options.skipSalesOrder
      ? (invoiceRaw.reference_number ? String(invoiceRaw.reference_number) : null)
      : (salesOrder?.number
        ?? (invoiceRaw.reference_number ? String(invoiceRaw.reference_number) : null)),
    subtotal: Number(invoiceRaw.sub_total ?? 0),
    taxTotal: Number(invoiceRaw.tax_total ?? 0),
    notes: invoiceRaw.notes ? String(invoiceRaw.notes) : null,
    shippingAddress,
    shippingAddressId,
    billingAddress: summary.billingAddress || null,
    lineItems,
    itemQuantity: sumInvoiceItemQuantity(lineItems),
    amountExclGst: amountExclGst({
      total: summary.total,
      subtotal: Number(invoiceRaw.sub_total ?? 0),
      taxTotal: Number(invoiceRaw.tax_total ?? 0),
    }),
    invoiceCategory,
    sparePackaging,
    categories: categoryBreakdown.categories,
    categoryAmounts: categoryBreakdown.categoryAmounts,
    freightSku: freightSkuFromInvoiceLines(lineItems),
    zohoLastModified: invoiceRaw.last_modified_time
      ? String(invoiceRaw.last_modified_time)
      : null,
    contentFingerprint: fingerprint,
    syncedAt: FieldValue.serverTimestamp(),
  };
}

function invoiceDetailStillValid(existing, summary) {
  if (!existing || !Array.isArray(existing.lineItems) || !existing.lineItems.length) {
    return false;
  }
  const modified = summary?.last_modified_time ? String(summary.last_modified_time) : '';
  return Boolean(modified && modified === String(existing.zohoLastModified ?? ''));
}

function defaultInvoiceSyncOptions(options = {}) {
  return {
    skipPdfs: options.skipPdfs ?? false,
    skipSalesOrder: options.skipSalesOrder !== false,
    skipImages: options.skipImages !== false,
    concurrency: options.concurrency ?? 3,
    delayMs: options.delayMs ?? 350,
  };
}

export async function refreshInvoicePdfFromZoho(accessToken, orgId, customerId, invoiceId) {
  const id = String(invoiceId || '').trim();
  const cid = String(customerId || '').trim();
  if (!id || !cid) throw new Error('Invoice is required.');
  const pdfBuffer = await fetchZohoPdf(accessToken, orgId, 'invoices', id);
  const pdfStoragePath = await uploadPdfToStorage(invoicePdfPath(cid, id), pdfBuffer);
  await invoicesCollection(cid).doc(id).set({
    pdfStoragePath,
    pdfCachedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return pdfStoragePath;
}

async function cacheInvoicePdfs(accessToken, orgId, customerId, invoiceId, invoiceRaw, salesOrder, options = {}) {
  const paths = {
    pdfStoragePath: null,
    salesOrderPdfStoragePath: null,
  };

  if (options.skipPdfs) return paths;

  try {
    const pdfBuffer = await fetchZohoPdf(accessToken, orgId, 'invoices', invoiceId);
    paths.pdfStoragePath = await uploadPdfToStorage(invoicePdfPath(customerId, invoiceId), pdfBuffer);
  } catch (err) {
    console.warn(`Invoice PDF cache failed for ${invoiceId}:`, err?.message ?? err);
  }

  if (salesOrder?.id && !options.skipSalesOrder) {
    try {
      const soBuffer = await fetchZohoPdf(accessToken, orgId, 'salesorders', salesOrder.id);
      paths.salesOrderPdfStoragePath = await uploadPdfToStorage(
        salesOrderPdfPath(customerId, salesOrder.id),
        soBuffer,
      );
    } catch (err) {
      console.warn(`Sales order PDF cache failed for invoice ${invoiceId}:`, err?.message ?? err);
    }
  }

  return paths;
}

export async function upsertInvoiceFromRaw(accessToken, orgId, invoiceRaw, options = {}) {
  if (!invoiceRaw?.invoice_id || !invoiceRaw?.customer_id) {
    return { skipped: true, reason: 'missing ids' };
  }

  const customerId = String(invoiceRaw.customer_id);
  const invoiceId = String(invoiceRaw.invoice_id);
  const existing = options.existingDoc
    ?? (await invoicesCollection(customerId).doc(invoiceId).get()).data()
    ?? null;
  const fingerprint = zohoContentFingerprint(invoiceRaw);

  const needsDetail = !options.summaryRefreshOnly && (
    !existing
    || existing.contentFingerprint !== fingerprint
    || !Array.isArray(existing.lineItems)
    || !existing.lineItems.length
  );

  let doc;
  let salesOrder = null;

  if (options.summaryRefreshOnly) {
    if (!existing) {
      return { skipped: true, reason: 'no cached detail' };
    }
    const mapped = mapInvoice(invoiceRaw);
    let shippingAddress = mapped.shippingAddress || existing.shippingAddress || null;
    let shippingAddressId = mapped.shippingAddressId || existing.shippingAddressId || null;
    if (!shippingAddress) {
      const mirrored = await shippingFromMirroredSalesOrder(
        existing.salesOrderId || invoiceRaw.salesorder_id || null,
      );
      if (mirrored.shippingAddress) {
        shippingAddress = mirrored.shippingAddress;
        shippingAddressId = mirrored.shippingAddressId || shippingAddressId;
      }
    }
    doc = {
      ...firestoreDocToDetail(existing),
      ...mapped,
      // List payloads often omit addresses — keep cached / SO ship-to.
      shippingAddress,
      shippingAddressId,
      billingAddress: mapped.billingAddress || existing.billingAddress || null,
      customerId,
      invoiceCategory: parseInvoiceCategory(existing.invoiceCategory) || 'product',
      categories: Array.isArray(existing.categories) ? existing.categories : [],
      categoryAmounts: existing.categoryAmounts ?? {},
      syncedAt: FieldValue.serverTimestamp(),
    };

    if (doc.invoiceCategory === 'spare' && doc.salesOrderId) {
      const spare = await sparePackagingFromSalesOrderId(doc.salesOrderId);
      if (spare) doc.sparePackaging = spare;
    }
  } else if (needsDetail || options.forceDetail) {
    const fullRaw = options.useProvidedRaw
      ? invoiceRaw
      : await fetchInvoiceRaw(accessToken, orgId, invoiceId);
    if (!fullRaw) {
      return { skipped: true, reason: 'not found in zoho' };
    }
    doc = await buildFirestoreInvoiceDoc(accessToken, orgId, fullRaw, options);
    if (!doc.shippingAddress && existing?.shippingAddress) {
      doc.shippingAddress = existing.shippingAddress;
      doc.shippingAddressId = doc.shippingAddressId || existing.shippingAddressId || null;
    }
    if (!options.skipSalesOrder && doc.salesOrderId) {
      salesOrder = { id: doc.salesOrderId, number: doc.salesOrderNumber };
    }
  } else {
    const mapped = mapInvoice(invoiceRaw);
    let shippingAddress = mapped.shippingAddress || existing.shippingAddress || null;
    let shippingAddressId = mapped.shippingAddressId || existing.shippingAddressId || null;
    if (!shippingAddress) {
      const soId = existing.salesOrderId || invoiceRaw.salesorder_id || null;
      const mirrored = await shippingFromMirroredSalesOrder(soId);
      if (mirrored.shippingAddress) {
        shippingAddress = mirrored.shippingAddress;
        shippingAddressId = mirrored.shippingAddressId || shippingAddressId;
      }
    }
    doc = {
      ...firestoreDocToDetail(existing),
      ...mapped,
      shippingAddress,
      shippingAddressId,
      billingAddress: mapped.billingAddress || existing.billingAddress || null,
      customerId,
      searchBlob: buildInvoiceSearchBlob(invoiceRaw),
      contentFingerprint: fingerprint,
      invoiceCategory: parseInvoiceCategory(existing.invoiceCategory) || 'product',
      categories: Array.isArray(existing.categories) ? existing.categories : [],
      categoryAmounts: existing.categoryAmounts ?? {},
      syncedAt: FieldValue.serverTimestamp(),
    };

    if (doc.invoiceCategory === 'spare' && doc.salesOrderId) {
      const spare = await sparePackagingFromSalesOrderId(doc.salesOrderId);
      if (spare) doc.sparePackaging = spare;
    }
    if (!options.skipSalesOrder && existing.salesOrderId) {
      salesOrder = { id: existing.salesOrderId, number: existing.salesOrderNumber };
    }
  }

  const contentChanged = Boolean(existing?.contentFingerprint)
    && existing.contentFingerprint !== fingerprint;
  const needsPdf = !options.skipPdfs && (
    options.forcePdfs
    || contentChanged
    || !existing?.pdfStoragePath
    || (!options.skipSalesOrder && salesOrder?.id && !existing?.salesOrderPdfStoragePath)
  );

  if (needsPdf && !options.skipPdfs) {
    const fullRaw = needsDetail || options.forceDetail
      ? (options.useProvidedRaw ? invoiceRaw : await fetchInvoiceRaw(accessToken, orgId, invoiceId))
      : invoiceRaw;
    if (fullRaw) {
      const pdfPaths = await cacheInvoicePdfs(
        accessToken,
        orgId,
        customerId,
        invoiceId,
        fullRaw,
        salesOrder,
        options,
      );
      if (pdfPaths.pdfStoragePath) {
        doc.pdfStoragePath = pdfPaths.pdfStoragePath;
        doc.pdfCachedAt = FieldValue.serverTimestamp();
      }
      if (pdfPaths.salesOrderPdfStoragePath) doc.salesOrderPdfStoragePath = pdfPaths.salesOrderPdfStoragePath;
    }
  } else if (existing) {
    if (existing.pdfStoragePath) doc.pdfStoragePath = existing.pdfStoragePath;
    if (existing.salesOrderPdfStoragePath) doc.salesOrderPdfStoragePath = existing.salesOrderPdfStoragePath;
  }

  // Zoho payloads never carry YesWeigh fulfillment — keep booking/pickup/e-way.
  if (existing) {
    if (doc.logistics == null && existing.logistics) doc.logistics = existing.logistics;
    if (doc.customerPickup == null && existing.customerPickup) {
      doc.customerPickup = existing.customerPickup;
    }
    if (doc.customerPickupMarkedAt == null && existing.customerPickupMarkedAt) {
      doc.customerPickupMarkedAt = existing.customerPickupMarkedAt;
    }
    if (doc.manualDelivery == null && existing.manualDelivery) {
      doc.manualDelivery = existing.manualDelivery;
    }
    if (doc.manualDeliveredAt == null && existing.manualDeliveredAt) {
      doc.manualDeliveredAt = existing.manualDeliveredAt;
    }
    if (doc.ewayBill == null && existing.ewayBill) doc.ewayBill = existing.ewayBill;
    if (doc.district == null && existing.district) doc.district = existing.district;
    if (doc.billingState == null && existing.billingState) doc.billingState = existing.billingState;
    if (doc.yesOneFreightPartner == null && existing.yesOneFreightPartner) {
      doc.yesOneFreightPartner = existing.yesOneFreightPartner;
    }
    if (existing.kotakPaidAt) {
      doc.kotakPaidAt = existing.kotakPaidAt;
      if (existing.kotakAmountApplied != null) doc.kotakAmountApplied = existing.kotakAmountApplied;
      const zohoPaid = String(doc.status || '').trim().toLowerCase() === 'paid'
        || Number(doc.balance) <= 0.01;
      if (!zohoPaid) {
        doc.status = 'paid';
        doc.balance = 0;
      }
    }
    if (existing.voidLocalOnly) {
      doc.status = 'void';
      doc.voidLocalOnly = true;
      doc.listStatus = 'void';
      if (existing.voidedAt) doc.voidedAt = existing.voidedAt;
      if (existing.voidedByUid) doc.voidedByUid = existing.voidedByUid;
      if (existing.voidedByName) doc.voidedByName = existing.voidedByName;
      if (existing.voidReason) doc.voidReason = existing.voidReason;
    }
    if (Array.isArray(doc.lineItems)) {
      const { reattachPreservedSerialsToLines } = await import('./non-gatc-serial-allot.js');
      doc.lineItems = await reattachPreservedSerialsToLines({
        lines: doc.lineItems,
        previousLines: existing.lineItems,
        invoiceId,
        invoiceNumber: doc.invoiceNumber || existing.invoiceNumber,
        nonGatcAllocatedSerials: existing.nonGatcAllocatedSerials,
        gatcStampedAllocatedSerials: existing.gatcStampedAllocatedSerials,
        yesgatcLinks: existing.yesgatcLinks,
      });
    }
    if (Array.isArray(existing.nonGatcAllocatedSerials) && existing.nonGatcAllocatedSerials.length) {
      doc.nonGatcAllocatedSerials = existing.nonGatcAllocatedSerials;
      if (existing.nonGatcSerialAllottedAt) doc.nonGatcSerialAllottedAt = existing.nonGatcSerialAllottedAt;
      if (existing.nonGatcSerialAllottedBy) doc.nonGatcSerialAllottedBy = existing.nonGatcSerialAllottedBy;
    }
    if (Array.isArray(existing.gatcStampedAllocatedSerials) && existing.gatcStampedAllocatedSerials.length) {
      doc.gatcStampedAllocatedSerials = existing.gatcStampedAllocatedSerials;
      if (existing.gatcStampedSerialAllottedAt) {
        doc.gatcStampedSerialAllottedAt = existing.gatcStampedSerialAllottedAt;
      }
      if (existing.gatcStampedSerialAllottedBy) {
        doc.gatcStampedSerialAllottedBy = existing.gatcStampedSerialAllottedBy;
      }
    }
    if (Array.isArray(existing.yesgatcLinks) && existing.yesgatcLinks.length) {
      doc.yesgatcLinks = existing.yesgatcLinks;
      if (existing.yesgatcLinkedAt) doc.yesgatcLinkedAt = existing.yesgatcLinkedAt;
    }
  }

  await invoicesCollection(customerId).doc(invoiceId).set(doc, { merge: true });
  await invoiceIndexRef(invoiceId).set({ customerId, updatedAt: FieldValue.serverTimestamp() });

  const statusKey = String(doc.status || '').trim().toLowerCase();
  if (
    !doc.voidLocalOnly
    && (statusKey === 'void' || statusKey === 'cancelled' || statusKey === 'canceled')
  ) {
    try {
      const { applyNonGatcSerialAllotmentOnInvoice } = await import('./non-gatc-serial-allot.js');
      await applyNonGatcSerialAllotmentOnInvoice({
        customerId,
        invoiceId,
        actorName: 'invoice-sync',
        accessToken,
        orgId,
      });
    } catch (err) {
      console.warn(`Serial release on void invoice ${invoiceId} failed:`, err?.message ?? err);
    }
  }

  if (Number(doc.total ?? 0) > 50_000) {
    try {
      const { syncEwayBillMetadataFromZoho } = await import('./invoice-ewaybill.js');
      await syncEwayBillMetadataFromZoho(accessToken, orgId, customerId, invoiceId, doc.total);
    } catch (err) {
      console.warn(`E-way bill metadata sync failed for ${invoiceId}:`, err?.message ?? err);
    }
  }

  await customerInvoiceMetaRef(customerId).set({
    ...(options.source === 'webhook' ? { lastWebhookAt: FieldValue.serverTimestamp() } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  try {
    const afterSnap = {
      ...doc,
      customerId,
      invoiceCategory: parseInvoiceCategory(doc.invoiceCategory) || doc.invoiceCategory,
      date: doc.date ?? null,
      total: doc.total,
      subtotal: doc.subtotal,
      taxTotal: doc.taxTotal,
      logistics: doc.logistics ?? existing?.logistics ?? null,
      customerPickup: doc.customerPickup ?? existing?.customerPickup ?? null,
      customerPickupMarkedAt: doc.customerPickupMarkedAt
        ?? existing?.customerPickupMarkedAt
        ?? existing?.customerPickup?.markedAt
        ?? null,
      manualDelivery: doc.manualDelivery ?? existing?.manualDelivery ?? null,
      manualDeliveredAt: doc.manualDeliveredAt
        ?? existing?.manualDeliveredAt
        ?? existing?.manualDelivery?.markedAt
        ?? null,
      ewayBill: doc.ewayBill ?? existing?.ewayBill ?? null,
    };
    const beforeSnap = existing
      ? { ...existing, customerId: existing.customerId ?? customerId }
      : null;
    const fields = await writeInvoiceSummaryAndReconcile(
      customerId,
      invoiceId,
      afterSnap,
      beforeSnap,
    );
    if (fields?.listStatus) {
      await invoicesCollection(customerId).doc(invoiceId).set({
        listStatus: fields.listStatus,
        ...(fields.logistics ? { logistics: fields.logistics } : {}),
      }, { merge: true });
    }
  } catch (err) {
    console.warn(`Invoice stats/summary update failed for ${invoiceId}:`, err?.message ?? err);
  }

  // Index stamped GATC fees against this invoice (joins linked SO portal meta).
  try {
    const { maybeWriteGatcReportAfterInvoiceUpsert } = await import('./gatc-report.js');
    await maybeWriteGatcReportAfterInvoiceUpsert({
      ...doc,
      id: invoiceId,
      customerId,
    });
  } catch (err) {
    console.warn(`GATC report index failed for invoice ${invoiceId}:`, err?.message ?? err);
  }

  try {
    const { syncYesGatcLinksAfterInvoiceUpsert } = await import('./yesgatc-invoice-link.js');
    await syncYesGatcLinksAfterInvoiceUpsert({
      ...doc,
      id: invoiceId,
      invoiceId,
      customerId,
    });
  } catch (err) {
    console.warn(`YesGATC certificate link failed for invoice ${invoiceId}:`, err?.message ?? err);
  }

  try {
    const {
      invoiceMachineSoldQty,
      notifyRcSoldAfterInvoiceChangeSafe,
    } = await import('./yesgatc-sold-push.js');
    const afterDoc = { ...doc, id: invoiceId, customerId };
    if (invoiceMachineSoldQty(existing) !== invoiceMachineSoldQty(afterDoc)) {
      await notifyRcSoldAfterInvoiceChangeSafe({
        customerId,
        invoiceId,
        before: existing || null,
        after: afterDoc,
        actorName: 'invoice-sync',
      });
    }
  } catch (err) {
    console.warn(`YesGATC RC sold push failed for invoice ${invoiceId}:`, err?.message ?? err);
  }

  return { customerId, invoiceId, updated: true };
}

function isZohoInvoiceMissing(err) {
  const message = String(err?.message ?? '').toLowerCase();
  const code = String(err?.code ?? err?.zohoCode ?? '').toLowerCase();
  return (
    code === 'not_found'
    || code === '404'
    || Number(err?.status) === 404
    || Number(err?.zohoCode) === 5
    || message.includes('not found')
    || message.includes('does not exist')
    || message.includes('invalid invoice')
    || /(?:^|\D)404(?:\D|$)/.test(message)
  );
}

async function releaseSerialsBeforeInvoiceRemove(customerId, invoiceId, data = {}) {
  try {
    const { releaseInvoiceSerialLinks } = await import('./non-gatc-serial-allot.js');
    return await releaseInvoiceSerialLinks({
      customerId,
      invoiceId,
      invoiceNumber: data.invoiceNumber || data.invoice_number || '',
      data,
    });
  } catch (err) {
    console.warn(
      `Serial / GATC release failed for invoice ${invoiceId}:`,
      err?.message ?? err,
    );
    return { released: 0 };
  }
}

export async function deleteInvoiceFromFirestore(customerId, invoiceId) {
  const ref = invoicesCollection(customerId).doc(invoiceId);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() ?? {}) : {};
  await releaseSerialsBeforeInvoiceRemove(customerId, invoiceId, data);
  if (!snap.exists) return false;
  const bucket = storageBucket();
  const paths = [data.pdfStoragePath, data.salesOrderPdfStoragePath].filter(Boolean);
  await ref.delete();
  await invoiceIndexRef(invoiceId).delete().catch(() => {});
  let summaryListStatus = data.listStatus ?? null;
  try {
    const { invoiceSummaryRef } = await import('./invoice-stats.js');
    const summarySnap = await invoiceSummaryRef(customerId, invoiceId).get();
    if (summarySnap.exists) {
      summaryListStatus = summarySnap.data()?.listStatus ?? summaryListStatus;
    }
  } catch {
    // keep hot-invoice status
  }
  await deleteInvoiceSummary(customerId, invoiceId);
  try {
    await reconcileInvoiceStats({
      ...data,
      customerId: data.customerId ?? customerId,
      listStatus: summaryListStatus,
    }, null);
  } catch (err) {
    console.warn(`Invoice stats remove failed for ${invoiceId}:`, err?.message ?? err);
  }
  await Promise.all(paths.map(async path => {
    try {
      await bucket.file(path).delete({ ignoreNotFound: true });
    } catch {
      // ignore storage delete failures
    }
  }));
  try {
    const { notifyRcSoldAfterInvoiceChangeSafe } = await import('./yesgatc-sold-push.js');
    await notifyRcSoldAfterInvoiceChangeSafe({
      customerId,
      invoiceId,
      before: { ...data, id: invoiceId, customerId },
      after: null,
      actorName: 'invoice-delete',
    });
  } catch (err) {
    console.warn(`YesGATC RC sold push failed after delete ${invoiceId}:`, err?.message ?? err);
  }
  return true;
}

async function mapConcurrent(items, concurrency, fn) {
  if (!items.length) return [];
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        results[current] = { error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function syncInvoicesToFirestore(secrets, orgId, options = {}) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const syncOpts = defaultInvoiceSyncOptions(options);
  const { concurrency, delayMs, skipPdfs, skipSalesOrder, skipImages } = syncOpts;
  const customerIdFilter = options.customerId ? String(options.customerId) : null;

  const summaries = await fetchAllInvoiceSummaries(accessToken, organizationId, {
    customerId: customerIdFilter ?? undefined,
    delayMs,
  });

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let unchanged = 0;
  const customerCounts = new Map();

  const upsertOptions = {
    skipPdfs,
    skipSalesOrder,
    skipImages,
    forcePdfs: !skipPdfs,
    source: options.source ?? 'sync',
  };

  await mapConcurrent(summaries, concurrency, async summary => {
    if (delayMs) await sleep(delayMs);
    try {
      const invoiceId = String(summary.invoice_id);
      const customerId = String(summary.customer_id);
      const existingSnap = await invoicesCollection(customerId).doc(invoiceId).get();
      const existing = existingSnap.exists ? existingSnap.data() : null;
      const summaryStatus = String(summary.status || existing?.status || '').trim().toLowerCase();

      if (summaryStatus !== 'draft' && invoiceDetailStillValid(existing, summary)) {
        const result = await upsertInvoiceFromRaw(accessToken, organizationId, summary, {
          ...upsertOptions,
          useProvidedRaw: true,
          summaryRefreshOnly: true,
          existingDoc: existing,
        });
        if (result.skipped) {
          skipped += 1;
          return;
        }
        unchanged += 1;
        synced += 1;
        customerCounts.set(customerId, (customerCounts.get(customerId) ?? 0) + 1);
        return;
      }

      let fullRaw;
      try {
        fullRaw = await fetchInvoiceRaw(accessToken, organizationId, invoiceId);
      } catch (err) {
        err.syncPhase = 'zoho-fetch';
        throw err;
      }
      if (!fullRaw) {
        skipped += 1;
        return;
      }
      fullRaw = await promoteDraftInvoiceIfPaymentConfirmed(
        secrets,
        orgId,
        accessToken,
        organizationId,
        invoiceId,
        fullRaw,
        existing,
      );
      try {
        await upsertInvoiceFromRaw(accessToken, organizationId, fullRaw, {
          ...upsertOptions,
          useProvidedRaw: true,
          existingDoc: existing,
        });
      } catch (err) {
        err.syncPhase = 'firestore-upsert';
        throw err;
      }
      synced += 1;
      customerCounts.set(customerId, (customerCounts.get(customerId) ?? 0) + 1);
    } catch (err) {
      failed += 1;
      if (err?.code === 'RATE_LIMITED') {
        await sleep(5000);
      }
      const phase = err?.syncPhase ? ` [${err.syncPhase}]` : '';
      const zohoHint = err?.zohoCode === 57
        ? ' (Zoho code 57 — wrong data center or missing ZohoInventory.invoices.READ scope)'
        : '';
      console.warn('Invoice sync item failed:', `${err?.message ?? err}${phase}${zohoHint}`);
    }
  });

  const now = FieldValue.serverTimestamp();
  const touchedCustomers = customerIdFilter
    ? [customerIdFilter]
    : [...customerCounts.keys()];

  for (const customerId of touchedCustomers) {
    const snap = await invoicesCollection(customerId).count().get();
    await customerInvoiceMetaRef(customerId).set({
      totalCount: snap.data().count,
      lastFullSyncAt: now,
      lastSyncStatus: failed ? 'partial' : 'ok',
      updatedAt: now,
    }, { merge: true });
  }

  await globalInvoiceMetaRef().set({
    lastFullSyncAt: now,
    syncedCount: synced,
    failedCount: failed,
    skippedCount: skipped,
    totalListed: summaries.length,
    updatedAt: now,
  }, { merge: true });

  return {
    syncedCount: synced,
    failedCount: failed,
    skippedCount: skipped,
    unchangedCount: unchanged,
    totalListed: summaries.length,
    customerCount: touchedCustomers.length,
  };
}

async function salesOrderPaymentConfirmed(salesOrderId) {
  const soId = String(salesOrderId ?? '').trim();
  if (!soId) return false;
  try {
    const snap = await getFirestore().collection('salesOrders').doc(soId).get();
    if (!snap.exists) return false;
    const data = snap.data() ?? {};
    const stage = String(data.yesOneStage ?? '').trim().toLowerCase();
    if (stage === 'completed') return true;
    return Boolean(String(data.paymentVerifiedAt ?? '').trim());
  } catch {
    return false;
  }
}

async function promoteDraftInvoiceIfPaymentConfirmed(
  secrets,
  orgId,
  accessToken,
  organizationId,
  invoiceId,
  invoiceRaw,
  existingDoc = null,
) {
  const zohoStatus = String(invoiceRaw?.status || '').trim().toLowerCase();
  if (zohoStatus !== 'draft') return invoiceRaw;
  const soId = String(invoiceRaw?.salesorder_id || existingDoc?.salesOrderId || '').trim();
  if (!soId || !(await salesOrderPaymentConfirmed(soId))) return invoiceRaw;
  try {
    await markInvoiceAsSent(secrets, orgId, invoiceId);
    const refreshed = await fetchInvoiceRaw(accessToken, organizationId, invoiceId);
    return refreshed || invoiceRaw;
  } catch (sentErr) {
    console.warn(
      `Could not mark invoice ${invoiceId} as sent during sync (SO ${soId}):`,
      sentErr?.message || sentErr,
    );
    return invoiceRaw;
  }
}

export async function syncSingleInvoiceFromZoho(secrets, orgId, invoiceId, options = {}) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const syncOpts = defaultInvoiceSyncOptions(options);
  let fullRaw;
  try {
    fullRaw = await fetchInvoiceRaw(accessToken, organizationId, invoiceId);
  } catch (err) {
    if (!isZohoInvoiceMissing(err)) throw err;
    fullRaw = null;
  }
  if (!fullRaw) {
    const indexSnap = await invoiceIndexRef(invoiceId).get();
    if (indexSnap.exists) {
      await deleteInvoiceFromFirestore(String(indexSnap.data()?.customerId), invoiceId);
      return { deleted: true, updated: false, reason: 'missing_in_zoho' };
    }
    await releaseSerialsBeforeInvoiceRemove('', invoiceId);
    return { deleted: true, updated: false, reason: 'missing_in_zoho' };
  }

  fullRaw = await promoteDraftInvoiceIfPaymentConfirmed(
    secrets,
    orgId,
    accessToken,
    organizationId,
    invoiceId,
    fullRaw,
  );
  const soId = String(fullRaw.salesorder_id || '').trim();

  const result = await upsertInvoiceFromRaw(accessToken, organizationId, fullRaw, {
    useProvidedRaw: true,
    forceDetail: true,
    forcePdfs: !syncOpts.skipPdfs,
    skipPdfs: syncOpts.skipPdfs,
    skipSalesOrder: syncOpts.skipSalesOrder,
    skipImages: syncOpts.skipImages,
    source: options.source ?? 'webhook',
  });

  // Outside-portal invoices: move/settle pending freight Diff onto first invoiced SO with freight.
  const customerId = String(result?.customerId || fullRaw?.customer_id || '').trim();
  if (soId && customerId && !options.skipFreightDiffSettle) {
    try {
      const { settleFreightDiffForInvoicedSalesOrder } = await import('./freight-diff-settlement.js');
      await settleFreightDiffForInvoicedSalesOrder(getFirestore(), {
        secrets,
        orgId,
        salesOrderId: soId,
        invoiceId: String(invoiceId),
        invoiceNumber: fullRaw?.invoice_number ? String(fullRaw.invoice_number) : null,
        zohoCustomerId: customerId,
      });
    } catch (freightErr) {
      console.warn(
        `Freight diff settle on invoice sync failed for SO ${soId}:`,
        freightErr?.message || freightErr,
      );
    }
  }

  return result;
}

export async function reconcileCustomerInvoices(secrets, orgId, customerId, options = {}) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);

  const zohoSummaries = await fetchAllInvoiceSummaries(accessToken, organizationId, {
    customerId: String(customerId),
    delayMs: options.delayMs ?? 300,
  });
  const zohoIds = new Set(zohoSummaries.map(row => String(row.invoice_id)));

  const localSnap = await invoicesCollection(customerId).get();
  const localIds = new Set(localSnap.docs.map(doc => doc.id));

  let removed = 0;
  for (const id of localIds) {
    if (!zohoIds.has(id)) {
      await deleteInvoiceFromFirestore(customerId, id);
      removed += 1;
    }
  }

  return { zohoCount: zohoIds.size, localRemoved: removed };
}

function isCatalogSpareMeta(catalog) {
  if (!catalog) return false;
  if (isGenericSpareCategoryName(catalog.categoryName)) return true;
  if (String(catalog.modelNumber ?? '').trim()) return false;
  const categoryId = String(catalog.categoryId ?? '').trim();
  if (!categoryId || categoryId === '-1') return true;
  return false;
}

function compactInvoiceLineItemPreview(item, catalogMap) {
  const itemId = item?.itemId != null && String(item.itemId).trim()
    ? String(item.itemId)
    : null;
  const catalog = itemId ? catalogMap.get(itemId) : null;
  return {
    id: String(item?.id ?? ''),
    itemId,
    name: String(item?.name ?? 'Item'),
    description: null,
    sku: item?.sku != null && String(item.sku).trim() ? String(item.sku) : null,
    quantity: Number(item?.quantity ?? 0),
    rate: 0,
    total: 0,
    imageUrl: item?.imageUrl
      ? String(item.imageUrl)
      : (catalog?.imageUrl ? String(catalog.imageUrl) : null),
    hsn: item?.hsn != null && String(item.hsn).trim()
      ? String(item.hsn)
      : (catalog?.hsn ?? null),
    serialNumbers: Array.isArray(item?.serialNumbers)
      ? item.serialNumbers.map(value => String(value).trim()).filter(Boolean)
      : [],
    ...(catalog?.categoryId != null ? { categoryId: String(catalog.categoryId) } : {}),
    ...(catalog?.categoryName != null ? { categoryName: String(catalog.categoryName) } : {}),
    ...(catalog?.isWeighingScale ? { isWeighingScale: true } : {}),
    ...(catalog ? { isCatalogSpare: isCatalogSpareMeta(catalog) } : {}),
  };
}

/**
 * Attach compact product rows to a small page of invoices (support picker).
 * Reuses lineItems already loaded by an indexed list query.
 */
export async function attachInvoiceLineItemPreviews(customerId, invoices) {
  if (!Array.isArray(invoices) || !invoices.length) return invoices;
  const col = invoicesCollection(String(customerId));
  const extraByIndex = invoices.map(() => null);
  const linesByInvoice = invoices.map(inv => (
    Array.isArray(inv.lineItems) && inv.lineItems.length ? inv.lineItems : null
  ));
  const missingIndexes = invoices
    .map((inv, index) => (linesByInvoice[index] ? -1 : index))
    .filter(index => index >= 0);

  if (missingIndexes.length) {
    const db = getFirestore();
    const refs = missingIndexes.map(index => col.doc(String(invoices[index].id)));
    const snaps = [];
    for (let i = 0; i < refs.length; i += 100) {
      snaps.push(...await db.getAll(...refs.slice(i, i + 100)));
    }
    snaps.forEach((snap, i) => {
      const index = missingIndexes[i];
      const data = snap.exists ? snap.data() ?? {} : {};
      extraByIndex[index] = data;
      const lines = data.lineItems ?? data.line_items;
      linesByInvoice[index] = Array.isArray(lines) && lines.length ? lines : null;
    });
  }

  const catalogItemIds = [];
  for (const lines of linesByInvoice) {
    if (!Array.isArray(lines)) continue;
    for (const item of lines) {
      if (item?.itemId) catalogItemIds.push(String(item.itemId));
    }
  }
  const catalogMap = await getCatalogMetaForItems(catalogItemIds);
  return invoices.map((inv, index) => {
    const extra = extraByIndex[index] ?? {};
    return {
      ...inv,
      lineItems: Array.isArray(linesByInvoice[index])
        ? linesByInvoice[index].map(item => compactInvoiceLineItemPreview(item, catalogMap))
        : undefined,
      customerPickup: extra.customerPickup ?? inv.customerPickup ?? null,
      customerPickupMarkedAt: extra.customerPickupMarkedAt ?? inv.customerPickupMarkedAt ?? null,
      manualDelivery: extra.manualDelivery ?? inv.manualDelivery ?? null,
      manualDeliveredAt: extra.manualDeliveredAt ?? inv.manualDeliveredAt ?? null,
      goodsReceivedAt: inv.goodsReceivedAt ?? extra.goodsReceivedAt ?? null,
    };
  });
}

/** List fields only — omit lineItems / PDF paths so large dealers stay under memory caps. */
const INVOICE_LIST_SELECT_FIELDS = [
  'invoiceNumber',
  'date',
  'dueDate',
  'status',
  'total',
  'subtotal',
  'taxTotal',
  'balance',
  'referenceNumber',
  'lastPaymentDate',
  'currencyCode',
  'customerName',
  'salespersonId',
  'salespersonName',
  'invoiceUrl',
  'invoiceCategory',
  'freightSku',
  'goodsReceivedAt',
  'customerPickup',
  'customerPickupMarkedAt',
  'manualDelivery',
  'manualDeliveredAt',
];

/** IST calendar date `days` ago as YYYY-MM-DD — matches Zoho invoice `date` strings. */
export function istCalendarDateDaysAgo(days) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);
  const utc = new Date(Date.UTC(year, month - 1, day - Number(days || 0)));
  return utc.toISOString().slice(0, 10);
}

function indexedInvoiceRowFromDoc(docSnap, includeLineItems) {
  const data = docSnap.data() ?? {};
  const row = firestoreDocToListInvoice({ ...data, id: docSnap.id });
  if (includeLineItems) {
    const lines = data.lineItems ?? data.line_items;
    if (Array.isArray(lines) && lines.length) row.lineItems = lines;
  }
  return row;
}

async function lastSyncedAtFromCustomerMeta(customerId) {
  const metaSnap = await customerInvoiceMetaRef(String(customerId)).get();
  const meta = metaSnap.exists ? metaSnap.data() : null;
  let lastSyncedAt = null;
  const timestamps = [meta?.lastFullSyncAt, meta?.lastWebhookAt, meta?.updatedAt];
  for (const ts of timestamps) {
    if (ts instanceof Timestamp) {
      const iso = ts.toDate().toISOString();
      if (!lastSyncedAt || iso > lastSyncedAt) lastSyncedAt = iso;
    }
  }
  return lastSyncedAt;
}

/**
 * Indexed invoice page: date DESC (+ optional date >= from).
 * Uses the invoices.date collection index instead of reading every dealer invoice.
 */
export async function readCustomerInvoicesFromFirestoreIndexed(
  customerId,
  {
    dateFrom = '',
    page = 1,
    limit = 40,
    includeLineItems = false,
    fetchAll = false,
  } = {},
) {
  const col = invoicesCollection(String(customerId));
  const fields = includeLineItems
    ? [...INVOICE_LIST_SELECT_FIELDS, 'lineItems', 'line_items']
    : INVOICE_LIST_SELECT_FIELDS;
  const from = String(dateFrom || '').trim();

  if (fetchAll) {
    const pageSize = 100;
    const maxRows = Math.max(100, Math.min(Number(limit) || 800, 800));
    const invoices = [];
    let lastDoc = null;
    while (invoices.length < maxRows) {
      let listQuery = col.select(...fields);
      if (from) listQuery = listQuery.where('date', '>=', from);
      listQuery = listQuery.orderBy('date', 'desc');
      if (lastDoc) listQuery = listQuery.startAfter(lastDoc);
      listQuery = listQuery.limit(Math.min(pageSize, maxRows - invoices.length));
      const snap = await listQuery.get();
      if (snap.empty) break;
      snap.forEach(docSnap => {
        invoices.push(indexedInvoiceRowFromDoc(docSnap, includeLineItems));
      });
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
    return {
      invoices,
      searchBlobById: new Map(),
      lastSyncedAt: await lastSyncedAtFromCustomerMeta(customerId),
      total: invoices.length,
    };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || 40);
  const offset = (safePage - 1) * safeLimit;

  let listQuery = col.select(...fields);
  let countQuery = col;
  if (from) {
    listQuery = listQuery.where('date', '>=', from);
    countQuery = countQuery.where('date', '>=', from);
  }
  listQuery = listQuery.orderBy('date', 'desc');
  countQuery = countQuery.orderBy('date', 'desc');
  if (offset) listQuery = listQuery.offset(offset);
  listQuery = listQuery.limit(safeLimit);

  const [snap, countSnap, lastSyncedAt] = await Promise.all([
    listQuery.get(),
    countQuery.count().get(),
    lastSyncedAtFromCustomerMeta(customerId),
  ]);

  const invoices = [];
  snap.forEach(docSnap => {
    invoices.push(indexedInvoiceRowFromDoc(docSnap, includeLineItems));
  });

  return {
    invoices,
    searchBlobById: new Map(),
    lastSyncedAt,
    total: countSnap.data().count,
  };
}

export async function readCustomerInvoicesFromFirestore(
  customerId,
  { includeSearchBlob = false } = {},
) {
  const fields = includeSearchBlob
    ? [...INVOICE_LIST_SELECT_FIELDS, 'searchBlob']
    : INVOICE_LIST_SELECT_FIELDS;
  const snap = await invoicesCollection(String(customerId)).select(...fields).get();
  const invoices = [];
  const searchBlobById = new Map();

  snap.forEach(doc => {
    const data = doc.data() ?? {};
    invoices.push(firestoreDocToListInvoice({ ...data, id: doc.id }));
    if (includeSearchBlob && data.searchBlob) {
      searchBlobById.set(doc.id, String(data.searchBlob));
    }
  });

  const metaSnap = await customerInvoiceMetaRef(String(customerId)).get();
  const meta = metaSnap.exists ? metaSnap.data() : null;
  let lastSyncedAt = null;
  const timestamps = [meta?.lastFullSyncAt, meta?.lastWebhookAt, meta?.updatedAt];
  for (const ts of timestamps) {
    if (ts instanceof Timestamp) {
      const iso = ts.toDate().toISOString();
      if (!lastSyncedAt || iso > lastSyncedAt) lastSyncedAt = iso;
    }
  }

  return { invoices, searchBlobById, lastSyncedAt };
}

async function resolveInvoiceDisplayAddress(customerId, data) {
  const preferred = String(data.shippingAddress || data.billingAddress || '').trim() || null;
  const preferredId = String(data.shippingAddressId || '').trim() || null;
  if (preferred) return preferred;

  try {
    const snap = await getFirestore().collection(CUSTOMERS_COLLECTION).doc(String(customerId)).get();
    if (!snap.exists) return null;
    const customer = snap.data() || {};
    if (preferredId && Array.isArray(customer.zohoAddresses)) {
      const match = customer.zohoAddresses.find(
        row => String(row?.addressId || '').trim() === preferredId && row?.formatted,
      );
      if (match?.formatted) return String(match.formatted).trim() || null;
    }
    return (
      (customer.zohoShippingAddress && String(customer.zohoShippingAddress).trim())
      || (customer.shippingAddress && String(customer.shippingAddress).trim())
      || formatZohoAddress(customer.zohoShippingAddressRaw)
      || (customer.zohoBillingAddress && String(customer.zohoBillingAddress).trim())
      || (customer.billingAddress && String(customer.billingAddress).trim())
      || formatZohoAddress(customer.zohoBillingAddressRaw)
      || null
    );
  } catch {
    return null;
  }
}

export async function readInvoiceDetailFromFirestore(customerId, invoiceId) {
  const snap = await invoicesCollection(String(customerId)).doc(String(invoiceId)).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (String(data.customerId ?? customerId) !== String(customerId)) return null;
  const detail = firestoreDocToDetail({ ...data, id: snap.id });
  let shippingAddress = detail.shippingAddress;
  if (!shippingAddress && detail.salesOrderId) {
    const mirrored = await shippingFromMirroredSalesOrder(detail.salesOrderId);
    shippingAddress = mirrored.shippingAddress;
  }
  if (!shippingAddress) {
    shippingAddress = await resolveInvoiceDisplayAddress(customerId, data);
  }

  const needsImages = detail.lineItems.some(item => !item.imageUrl && item.itemId);
  const withAddress = { ...detail, shippingAddress: shippingAddress || null };
  if (!needsImages) return withAddress;

  const itemIds = detail.lineItems.map(item => item.itemId).filter(Boolean);
  const catalogMap = await getCatalogMetaForItems(itemIds);
  return {
    ...withAddress,
    lineItems: detail.lineItems.map(item => ({
      ...item,
      imageUrl: item.imageUrl
        || (item.itemId ? catalogMap.get(String(item.itemId))?.imageUrl ?? null : null),
    })),
  };
}

function invoiceDocumentMeta(customerId, invoiceId, data, documentType) {
  if (documentType === 'invoice') {
    return {
      storagePath: data.pdfStoragePath ?? invoicePdfPath(customerId, invoiceId),
      filename: `${String(data.invoiceNumber || invoiceId).replace(/[^\w.-]+/g, '_')}.pdf`,
      zohoResource: 'invoices',
      zohoId: String(invoiceId),
      firestorePathField: 'pdfStoragePath',
    };
  }
  if (documentType === 'salesorder') {
    if (!data.salesOrderId) throw new Error('Sales order not found for this invoice.');
    const salesOrderId = String(data.salesOrderId);
    return {
      storagePath: data.salesOrderPdfStoragePath ?? salesOrderPdfPath(customerId, salesOrderId),
      filename: `${String(data.salesOrderNumber || salesOrderId).replace(/[^\w.-]+/g, '_')}.pdf`,
      zohoResource: 'salesorders',
      zohoId: salesOrderId,
      firestorePathField: 'salesOrderPdfStoragePath',
    };
  }
  throw new Error('Unsupported document type.');
}

/** Invoice PDF is always pulled from Zoho so serial updates are not served from cache. */
export async function ensureInvoiceDocumentPdf(secrets, orgId, customerId, invoiceId, documentType) {
  const snap = await invoicesCollection(String(customerId)).doc(String(invoiceId)).get();
  if (!snap.exists) throw new Error('Invoice not found.');
  const data = snap.data() ?? {};
  if (String(data.customerId ?? customerId) !== String(customerId)) {
    throw new Error('Invoice not found.');
  }

  const meta = invoiceDocumentMeta(customerId, invoiceId, data, documentType);
  const forceFresh = documentType === 'invoice';
  let buffer = forceFresh ? null : await readPdfFromStorage(meta.storagePath);
  if (!forceFresh && buffer && await cachedInvoicePdfIsStale(meta.storagePath, data)) {
    buffer = null;
  }

  if (!buffer) {
    const accessToken = await getAccessToken(secrets);
    const organizationId = await resolveOrganizationId(accessToken, orgId);
    buffer = await fetchZohoPdf(accessToken, organizationId, meta.zohoResource, meta.zohoId);
    const savedPath = await uploadPdfToStorage(meta.storagePath, buffer);
    await invoicesCollection(String(customerId)).doc(String(invoiceId)).set(
      {
        [meta.firestorePathField]: savedPath,
        ...(documentType === 'invoice' ? { pdfCachedAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    );
  }

  return {
    contentBase64: buffer.toString('base64'),
    filename: meta.filename,
    mimeType: 'application/pdf',
  };
}

export async function readInvoiceDocumentFromStorage(customerId, invoiceId, documentType) {
  const snap = await invoicesCollection(String(customerId)).doc(String(invoiceId)).get();
  if (!snap.exists) throw new Error('Invoice not found.');
  const data = snap.data() ?? {};
  if (String(data.customerId ?? customerId) !== String(customerId)) {
    throw new Error('Invoice not found.');
  }

  const meta = invoiceDocumentMeta(customerId, invoiceId, data, documentType);
  const buffer = await readPdfFromStorage(meta.storagePath);
  if (!buffer) {
    throw new Error('PDF not cached yet. Open the invoice to download it from Zoho.');
  }
  return {
    contentBase64: buffer.toString('base64'),
    filename: meta.filename,
    mimeType: 'application/pdf',
  };
}

function normalizeSignature(value) {
  return String(value ?? '').trim();
}

function signaturesMatch(received, calculated) {
  const a = normalizeSignature(received);
  const b = normalizeSignature(calculated);
  if (!a || !b) return false;
  if (a.length !== b.length) {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

export function verifyZohoWebhookSignature(req, secret) {
  if (!secret) return false;

  const received =
    req.get('X-ZB-Signature')
    ?? req.get('X-ZB-WebhookSignature')
    ?? req.get('X-Zoho-Webhook-Signature')
    ?? req.get('x-zb-signature');

  const rawBody = req.rawBody;
  if (!received || !rawBody) return false;

  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (signaturesMatch(received, hex)) return true;

  const base64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  if (signaturesMatch(received, base64)) return true;

  return false;
}

export function normalizeWebhookBody(body) {
  if (!body || typeof body !== 'object') return {};
  let next = { ...body };
  if (typeof body.JSONString === 'string' && body.JSONString.trim()) {
    try {
      const parsed = JSON.parse(body.JSONString);
      if (parsed && typeof parsed === 'object') next = { ...next, ...parsed };
    } catch {
      // ignore malformed Zoho JSONString
    }
  }
  return next;
}

export function extractInvoiceIdFromWebhook(body, query = {}) {
  const normalized = normalizeWebhookBody(body);
  const candidates = [
    query.invoice_id,
    query.invoiceId,
    query.id,
    normalized.invoice_id,
    normalized.invoiceId,
    normalized.invoice?.invoice_id,
    normalized.invoice?.invoiceId,
    normalized.data?.invoice_id,
    normalized.payload?.invoice_id,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

export function extractWebhookEvent(body, query = {}) {
  const normalized = normalizeWebhookBody(body);
  const event = query.action
    ?? query.event
    ?? normalized.event_type
    ?? normalized.event
    ?? normalized.action
    ?? normalized.type;
  return String(event ?? 'update').toLowerCase();
}

function webhookInvoiceNumber(body) {
  const normalized = normalizeWebhookBody(body);
  const value = normalized.invoice_number
    ?? normalized.invoice?.invoice_number
    ?? normalized.data?.invoice_number;
  return value != null ? String(value).trim() : '';
}

function webhookCustomerId(body) {
  const normalized = normalizeWebhookBody(body);
  const value = normalized.customer_id
    ?? normalized.invoice?.customer_id
    ?? normalized.data?.customer_id;
  return value != null ? String(value).trim() : '';
}

async function removeInvoiceFromWebhook(invoiceId, body) {
  const customerId = webhookCustomerId(body);
  if (customerId) {
    await deleteInvoiceFromFirestore(customerId, invoiceId);
    return { ok: true, status: 200, action: 'deleted', invoiceId };
  }
  const indexSnap = await invoiceIndexRef(invoiceId).get();
  if (indexSnap.exists) {
    await deleteInvoiceFromFirestore(String(indexSnap.data()?.customerId), invoiceId);
    return { ok: true, status: 200, action: 'deleted', invoiceId };
  }
  await releaseSerialsBeforeInvoiceRemove('', invoiceId, {
    invoiceNumber: webhookInvoiceNumber(body),
  });
  return { ok: true, status: 200, action: 'deleted', invoiceId, reason: 'released_without_local_doc' };
}

function extractInvoiceRawFromWebhook(body) {
  const normalized = normalizeWebhookBody(body);
  const raw = normalized.invoice
    || (normalized.invoice_id && Array.isArray(normalized.line_items) ? normalized : null);
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.invoice_id || !Array.isArray(raw.line_items)) return null;
  return raw;
}

export async function handleZohoInvoiceWebhook(secrets, orgId, req) {
  const body = normalizeWebhookBody(req.body ?? {});
  const invoiceId = extractInvoiceIdFromWebhook(body, req.query ?? {});
  if (!invoiceId) {
    return { ok: false, status: 400, message: 'Missing invoice_id' };
  }

  const event = extractWebhookEvent(body, req.query ?? {});
  if (event.includes('delete')) {
    return removeInvoiceFromWebhook(invoiceId, body);
  }

  try {
    const payloadRaw = extractInvoiceRawFromWebhook(body);
    if (payloadRaw) {
      const blocked = await isZohoDailyQuotaBlocked();
      const accessToken = blocked ? '' : await getAccessToken(secrets);
      const organizationId = blocked ? '' : await resolveOrganizationId(accessToken, orgId);
      const result = await upsertInvoiceFromRaw(accessToken, organizationId, payloadRaw, {
        useProvidedRaw: true,
        forceDetail: true,
        skipPdfs: true,
        skipSalesOrder: true,
        skipImages: true,
        source: 'webhook',
      });
      return { ok: true, status: 200, action: 'synced', invoiceId, source: 'payload', result };
    }

    const blocked = await ackIfDailyQuotaBlocked('invoice', invoiceId);
    if (blocked) return blocked;
    const result = await syncSingleInvoiceFromZoho(secrets, orgId, invoiceId, {
      source: 'webhook',
      skipPdfs: true,
    });
    if (result?.deleted || result?.reason === 'missing_in_zoho') {
      return { ok: true, status: 200, action: 'deleted', invoiceId, result };
    }
    return { ok: true, status: 200, action: 'synced', invoiceId, result };
  } catch (err) {
    if (isZohoInvoiceMissing(err)) {
      return removeInvoiceFromWebhook(invoiceId, body);
    }
    const ack = await ackZohoWebhookFailure('invoice', invoiceId, err);
    if (ack) return ack;
    throw err;
  }
}

export {
  fetchInvoicesListPage,
  fetchInvoiceRaw,
  invoiceDetailStillValid,
  invoicesCollection,
  customerInvoiceMetaRef,
  defaultInvoiceSyncOptions,
};
