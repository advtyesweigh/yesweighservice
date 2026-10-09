import { randomBytes } from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { createDealerRecord } from './dealers-api.js';
import { lookupGstinDetails } from './gstin-lookup.js';

const SHARE_COLLECTION = 'dealerCreateShares';
const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

function trimStr(value) {
  return String(value ?? '').trim();
}

function shareToken(value) {
  const token = trimStr(value);
  if (!TOKEN_RE.test(token)) {
    throw new HttpsError('invalid-argument', 'This dealer link is invalid.');
  }
  return token;
}

export async function createDealerCreateShareRecord({ waId, phone, createdByUid, createdByName }) {
  const token = randomBytes(18).toString('hex');
  const wa = trimStr(waId);
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!wa) throw new HttpsError('invalid-argument', 'Missing WhatsApp number.');
  await getFirestore().doc(`${SHARE_COLLECTION}/${token}`).set({
    waId: wa,
    phone: mobile,
    createdByUid: trimStr(createdByUid),
    createdByName: trimStr(createdByName),
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  });
  return { token };
}

export async function loadDealerCreateShare(token) {
  const id = shareToken(token);
  const snap = await getFirestore().doc(`${SHARE_COLLECTION}/${id}`).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    token: id,
    waId: trimStr(data.waId),
    phone: trimStr(data.phone),
    status: trimStr(data.status) === 'completed' ? 'completed' : 'open',
    companyName: trimStr(data.companyName),
    dealerId: trimStr(data.dealerId),
  };
}

export async function requireOpenDealerCreateShare(token) {
  const id = shareToken(token);
  const ref = getFirestore().doc(`${SHARE_COLLECTION}/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'This dealer link is invalid or has expired.');
  }
  const data = snap.data() || {};
  const status = trimStr(data.status) || 'open';
  if (status === 'completed') {
    throw new HttpsError('already-exists', 'This dealer has already been registered with this link.');
  }
  if (status !== 'open') {
    throw new HttpsError('failed-precondition', 'This dealer link is no longer available.');
  }
  return { ref, data, token: id };
}

export async function publicLookupGstinForShare(token, gstin, { accessToken, organizationId }) {
  await requireOpenDealerCreateShare(token);
  return lookupGstinDetails({ gstin }, { accessToken, organizationId });
}

export async function publicCreateDealerForShare(token, input, { secrets, orgId }) {
  const { ref, data } = await requireOpenDealerCreateShare(token);
  const dealer = await createDealerRecord({
    ...(input && typeof input === 'object' ? input : {}),
    phone: trimStr(input?.phone) || trimStr(data.phone),
    assignedStaffUid: trimStr(data.createdByUid) || undefined,
    dealerStage: trimStr(input?.dealerStage) || 'Active',
  }, { secrets, orgId, requireZohoSalesperson: false });
  await ref.set({
    status: 'completed',
    completedAt: FieldValue.serverTimestamp(),
    dealerId: dealer.id || '',
    companyName: trimStr(dealer.companyName || dealer.contactName),
  }, { merge: true });
  return {
    dealerId: dealer.id,
    companyName: trimStr(dealer.companyName || dealer.contactName) || 'Dealer',
  };
}
