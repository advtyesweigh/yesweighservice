/**
 * Dealer staff submit cart for dealer approval; dealer approve creates Zoho SO.
 */
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { submitDealerOrder } from './dealer-orders.js';
import { assertLinesNotRestrictedForBillingState } from './catalog-sales-restriction.js';
import { isDealerAdminStaff } from './dealer-staff-team.js';

const DEALER_CARTS = 'dealerCarts';

async function loadUser(uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await getFirestore().doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'User profile not found.');
  const data = snap.data() || {};
  if (data.active === false) throw new HttpsError('permission-denied', 'Your account is inactive.');
  const role = String(data.role ?? '').trim() === 'director' ? 'dealer'
    : String(data.role ?? '').trim() === 'director_staff' ? 'dealer_staff'
      : String(data.role ?? '').trim();
  return { uid, role, data };
}

function displayName(user) {
  return String(
    user.data?.displayName
    || user.data?.loginId
    || user.data?.email
    || 'User',
  ).trim();
}

function resolveDealerUid(user) {
  if (user.role === 'dealer') return user.uid;
  if (user.role === 'dealer_staff') {
    return String(user.data?.dealerId ?? user.data?.directorId ?? '').trim() || null;
  }
  return null;
}

function parseLines(raw) {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new HttpsError('invalid-argument', 'Add at least one item before submitting.');
  }
  const lines = raw.slice(0, 80).map(line => ({
    productId: String(line?.productId ?? '').trim(),
    quantity: Math.max(1, Math.floor(Number(line?.quantity) || 0)),
    gatcStampingPriceId: String(line?.gatcStampingPriceId ?? '').trim() || null,
    qcEnabled: line?.qcEnabled === true,
  })).filter(line => line.productId);
  if (!lines.length) {
    throw new HttpsError('invalid-argument', 'Add at least one item before submitting.');
  }
  return lines;
}

function parseDisplayLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 80).map(line => ({
    cartLineId: String(line?.cartLineId ?? '').trim(),
    productId: String(line?.productId ?? '').trim(),
    name: String(line?.name ?? 'Product'),
    sku: line?.sku != null ? String(line.sku) : null,
    description: line?.description != null ? String(line.description) : null,
    imageUrl: line?.imageUrl != null ? String(line.imageUrl) : null,
    baseRate: Number(line?.baseRate ?? line?.rate) || 0,
    listRate: line?.listRate != null ? Number(line.listRate) : null,
    gatcFeePerUnit: Number(line?.gatcFeePerUnit) || 0,
    gatcStampingPriceId: line?.gatcStampingPriceId != null ? String(line.gatcStampingPriceId) : null,
    gatcStampingRange: line?.gatcStampingRange != null ? String(line.gatcStampingRange) : null,
    qcEnabled: line?.qcEnabled === true,
    qcFeePerUnit: Number(line?.qcFeePerUnit) || 0,
    rate: Number(line?.rate) || 0,
    unit: String(line?.unit ?? 'pcs'),
    stockStatus: line?.stockStatus != null ? String(line.stockStatus) : 'in_stock',
    categoryName: line?.categoryName != null ? String(line.categoryName) : null,
    categoryId: line?.categoryId != null ? String(line.categoryId) : null,
    hsn: line?.hsn != null ? String(line.hsn) : null,
    quantity: Math.max(1, Math.floor(Number(line?.quantity) || 1)),
    addedByUid: line?.addedByUid != null ? String(line.addedByUid) : null,
    addedByName: line?.addedByName != null ? String(line.addedByName) : null,
    addedByTeam: line?.addedByTeam === 'service' || line?.addedByTeam === 'sales' || line?.addedByTeam === 'dealer'
      ? line.addedByTeam
      : null,
  })).filter(line => line.productId);
}

function parseShipping(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new HttpsError('invalid-argument', 'Select a shipping address before submitting.');
  }
  const addressId = String(raw.addressId ?? '').trim();
  const kind = String(raw.kind ?? '').trim();
  const newAddress = raw.newAddress && typeof raw.newAddress === 'object' ? raw.newAddress : null;
  if (!addressId && !kind && !newAddress) {
    throw new HttpsError('invalid-argument', 'Select a shipping address before submitting.');
  }
  return {
    ...(addressId ? { addressId } : {}),
    ...(kind ? { kind } : {}),
    ...(newAddress ? { newAddress } : {}),
  };
}

function staffTeam(user, fallback) {
  const stored = Array.isArray(user.data?.dealerTeams)
    ? user.data.dealerTeams.filter(team => team === 'sales' || team === 'service')
    : [];
  if (fallback === 'service' || fallback === 'sales') return fallback;
  if (stored.includes('service') && !stored.includes('sales')) return 'service';
  if (user.data?.staffDepartment === 'service') return 'service';
  return 'sales';
}

export async function submitDealerStaffOrderForApproval(uid, payload = {}) {
  const user = await loadUser(uid);
  if (user.role !== 'dealer_staff' || isDealerAdminStaff(user)) {
    throw new HttpsError('permission-denied', 'Only sales and service staff can submit for dealer approval.');
  }
  const dealerUid = resolveDealerUid(user);
  if (!dealerUid) {
    throw new HttpsError('failed-precondition', 'This staff account is not linked to a dealer.');
  }

  const lines = parseLines(payload.lines);
  const displayLines = parseDisplayLines(payload.displayLines);
  const shipping = parseShipping(payload.shipping);
  const cartLineIds = Array.isArray(payload.cartLineIds)
    ? [...new Set(payload.cartLineIds.map(id => String(id || '').trim()).filter(Boolean))].slice(0, 80)
    : displayLines.map(line => line.cartLineId).filter(Boolean);
  const submittedByTeam = staffTeam(user, payload.submittedByTeam);
  const kind = payload.kind === 'service' ? 'service' : 'sales';
  const remarks = String(payload.remarks ?? '').trim().slice(0, 2000);
  const courierBySite = payload.courierBySite && typeof payload.courierBySite === 'object'
    ? payload.courierBySite
    : null;
  const freightZone = String(payload.freightZone ?? '').trim() || null;
  const freightZoneOverrideReason = String(payload.freightZoneOverrideReason ?? '').trim().slice(0, 500) || null;
  const freightBillingMode = String(payload.freightBillingMode || '').trim().toLowerCase() === 'fod'
    ? 'fod'
    : (String(payload.freightBillingMode || '').trim().toLowerCase() === 'btc' ? 'btc' : null);
  const manualRaw = Number(payload.manualFreightAmountInr);
  const manualFreightAmountInr = Number.isFinite(manualRaw) && manualRaw >= 0
    ? Math.round(manualRaw * 100) / 100
    : null;

  const db = getFirestore();
  const approvalRef = db.collection(DEALER_CARTS).doc(dealerUid).collection('approvals').doc();
  const createdAtMs = Date.now();

  const zohoCustomerId = String(user.data?.zohoCustomerId ?? '').trim();
  let billingState = null;
  if (zohoCustomerId) {
    const customerSnap = await db.doc(`zohoCustomers/${zohoCustomerId}`).get();
    billingState = customerSnap.exists ? (customerSnap.data()?.billingState ?? null) : null;
  }
  await assertLinesNotRestrictedForBillingState(lines, billingState);

  await approvalRef.set({
    dealerUid,
    status: 'pending_approval',
    submittedByUid: uid,
    submittedByName: displayName(user),
    submittedByTeam,
    kind,
    lines,
    displayLines,
    shipping,
    remarks,
    courierBySite,
    freightZone,
    freightZoneOverrideReason,
    manualFreightAmountInr,
    freightBillingMode,
    cartLineIds,
    createdAtMs,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const itemsCol = db.collection(DEALER_CARTS).doc(dealerUid).collection('items');
  for (let i = 0; i < cartLineIds.length; i += 400) {
    const batch = db.batch();
    for (const id of cartLineIds.slice(i, i + 400)) {
      batch.delete(itemsCol.doc(id));
    }
    await batch.commit();
  }

  return { approvalId: approvalRef.id };
}

export async function approveDealerStaffOrder(uid, approvalId, secrets, orgId) {
  const user = await loadUser(uid);
  if (user.role !== 'dealer' && !isDealerAdminStaff(user)) {
    throw new HttpsError('permission-denied', 'Only the dealer can approve team orders.');
  }
  const dealerUid = user.role === 'dealer' ? uid : resolveDealerUid(user);
  if (!dealerUid) {
    throw new HttpsError('failed-precondition', 'This account is not linked to a dealer.');
  }
  const id = String(approvalId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Approval is required.');

  const db = getFirestore();
  const ref = db.collection(DEALER_CARTS).doc(dealerUid).collection('approvals').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'This approval is no longer available.');
  const data = snap.data() || {};
  if (data.status !== 'pending_approval') {
    throw new HttpsError('failed-precondition', 'This order is no longer waiting for approval.');
  }
  if (String(data.dealerUid ?? '') !== dealerUid) {
    throw new HttpsError('permission-denied', 'This approval belongs to another dealer.');
  }

  const result = await submitDealerOrder(dealerUid, 'dealer', {
    lines: data.lines,
    shipping: data.shipping,
    remarks: data.remarks,
    courierBySite: data.courierBySite || undefined,
    freightZone: data.freightZone || undefined,
    freightZoneOverrideReason: data.freightZoneOverrideReason || undefined,
    manualFreightAmountInr: data.manualFreightAmountInr,
    freightBillingMode: data.freightBillingMode || undefined,
    staffSubmitter: {
      uid: data.submittedByUid || null,
      name: data.submittedByName || null,
      team: data.submittedByTeam || null,
    },
  }, secrets, orgId);

  await ref.update({
    status: 'placed',
    approvedAtMs: Date.now(),
    approvedByUid: uid,
    zohoSalesOrderId: result.zohoSalesOrderId || null,
    zohoSalesOrderNumber: result.zohoSalesOrderNumber || null,
    placedSalesOrders: result.salesOrders || [],
    updatedAt: FieldValue.serverTimestamp(),
  });

  return result;
}

export async function rejectDealerStaffOrder(uid, approvalId) {
  const user = await loadUser(uid);
  if (user.role !== 'dealer' && !isDealerAdminStaff(user)) {
    throw new HttpsError('permission-denied', 'Only the dealer can reject team orders.');
  }
  const dealerUid = user.role === 'dealer' ? uid : resolveDealerUid(user);
  if (!dealerUid) {
    throw new HttpsError('failed-precondition', 'This account is not linked to a dealer.');
  }
  const id = String(approvalId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Approval is required.');

  const db = getFirestore();
  const ref = db.collection(DEALER_CARTS).doc(dealerUid).collection('approvals').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'This approval is no longer available.');
  const data = snap.data() || {};
  if (data.status !== 'pending_approval') {
    throw new HttpsError('failed-precondition', 'This order is no longer waiting for approval.');
  }
  if (String(data.dealerUid ?? '') !== dealerUid) {
    throw new HttpsError('permission-denied', 'This approval belongs to another dealer.');
  }

  const displayLines = parseDisplayLines(data.displayLines);
  const itemsCol = db.collection(DEALER_CARTS).doc(dealerUid).collection('items');
  for (let i = 0; i < displayLines.length; i += 400) {
    const batch = db.batch();
    for (const line of displayLines.slice(i, i + 400)) {
      const lineId = String(line.cartLineId || '').trim() || itemsCol.doc().id;
      batch.set(itemsCol.doc(lineId), { ...line, cartLineId: lineId }, { merge: true });
    }
    await batch.commit();
  }

  await ref.update({
    status: 'rejected',
    rejectedAtMs: Date.now(),
    rejectedByUid: uid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
}
