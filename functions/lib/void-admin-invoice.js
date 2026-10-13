/**
 * Super-admin void: Faisal / Shalima only.
 * Voids the Zoho invoice, returns non-GATC serials to the pool, and
 * unlinks GATC certificate serial + invoice number.
 */
import { getFirestore } from 'firebase-admin/firestore';
import {
  applyNonGatcSerialAllotmentOnInvoice,
  isVoidInvoiceStatus,
  voidZohoInvoice,
} from './non-gatc-serial-allot.js';

const VOID_ADMIN_NAMES = ['faisal', 'shalima'];

function str(value) {
  return value == null ? '' : String(value).trim();
}

function identityParts(data) {
  return [data?.displayName, data?.loginId, data?.email]
    .flatMap(value => String(value ?? '').toLowerCase().split(/[\s@._-]+/))
    .map(part => part.trim())
    .filter(Boolean);
}

export function canVoidAdminInvoiceIdentity(role, data) {
  if (role !== 'super_admin') return false;
  if (data?.superAdminAccess === 'view_only') return false;
  const parts = new Set(identityParts(data || {}));
  return VOID_ADMIN_NAMES.some(name => parts.has(name));
}

function actorDisplayName(data) {
  return str(data?.displayName || data?.loginId || data?.email) || 'YESWEIGH';
}

export async function voidAdminInvoice({
  uid,
  role,
  customerId,
  invoiceId,
  reason = '',
  secrets,
  configuredOrgId,
} = {}) {
  const cid = str(customerId);
  const iid = str(invoiceId);
  if (!cid || !iid) throw new Error('Invoice is required.');

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const userData = userSnap.exists ? (userSnap.data() || {}) : {};
  if (!canVoidAdminInvoiceIdentity(role, userData)) {
    throw new Error('Only Faisal or Shalima can void invoices.');
  }

  const invoiceRef = db.doc(`zohoCustomers/${cid}/invoices/${iid}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) throw new Error('Invoice not found.');
  const invoice = snap.data() || {};
  if (isVoidInvoiceStatus(invoice.status)) {
    throw new Error('This invoice is already void.');
  }

  const actorName = actorDisplayName(userData);
  const note = str(reason).slice(0, 500);

  await voidZohoInvoice({
    secrets,
    configuredOrgId,
    invoiceId: iid,
    reason: note,
  });

  const now = new Date().toISOString();
  await invoiceRef.set({
    status: 'void',
    voidedAt: now,
    voidedByUid: uid || null,
    voidedByName: actorName,
    voidReason: note || null,
  }, { merge: true });

  try {
    const { notifyRcSoldAfterInvoiceChangeSafe } = await import('./yesgatc-sold-push.js');
    await notifyRcSoldAfterInvoiceChangeSafe({
      customerId: cid,
      invoiceId: iid,
      before: { ...invoice, id: iid, customerId: cid },
      after: { ...invoice, id: iid, customerId: cid, status: 'void' },
      actorName,
    });
  } catch (err) {
    console.warn(`YesGATC RC sold push failed after void ${iid}:`, err?.message ?? err);
  }

  const cleanup = await applyNonGatcSerialAllotmentOnInvoice({
    customerId: cid,
    invoiceId: iid,
    actorName,
    forceRelease: true,
    secrets,
    configuredOrgId,
  });

  return {
    voided: true,
    released: Number(cleanup?.released) || 0,
    zohoPushed: cleanup?.zohoPushed !== false,
    zohoError: cleanup?.zohoError || '',
    invoiceId: iid,
  };
}

/**
 * Portal delete: mark the invoice void in Firestore only.
 * Does not call Zoho and does not cancel the courier booking.
 * voidLocalOnly keeps a later Zoho sync from reopening it.
 */
export async function voidInvoiceInFirestore({
  uid,
  customerId,
  invoiceId,
} = {}) {
  const cid = str(customerId);
  const iid = str(invoiceId);
  if (!cid || !iid) throw new Error('Invoice is required.');

  const db = getFirestore();
  const userSnap = uid ? await db.doc(`users/${uid}`).get() : null;
  const userData = userSnap?.exists ? (userSnap.data() || {}) : {};
  const actorName = actorDisplayName(userData);

  const invoiceRef = db.doc(`zohoCustomers/${cid}/invoices/${iid}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) throw new Error('Invoice not found.');
  const invoice = snap.data() || {};
  if (isVoidInvoiceStatus(invoice.status)) {
    throw new Error('This invoice is already void.');
  }

  const now = new Date().toISOString();
  await invoiceRef.set({
    status: 'void',
    listStatus: 'void',
    voidedAt: now,
    voidedByUid: uid || null,
    voidedByName: actorName,
    voidReason: null,
    voidLocalOnly: true,
  }, { merge: true });

  try {
    const { invoiceSummaryRef, patchInvoiceSummaryListFields } = await import('./invoice-stats.js');
    const summarySnap = await invoiceSummaryRef(cid, iid).get();
    if (summarySnap.exists) {
      await patchInvoiceSummaryListFields(cid, iid, { status: 'void' });
    }
  } catch (err) {
    console.warn(`Invoice summary void update failed for ${iid}:`, err?.message ?? err);
  }

  return { voided: true, invoiceId: iid };
}
