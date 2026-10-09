import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  readAllDealersFromFirestore,
  readDealerSetting,
  writeDealerSetting,
  refreshDealerFromZoho,
  pushDealerChangesToZoho,
  createZohoCustomer,
  deleteOrVoidZohoCustomer,
  findZohoContactIdByGstin,
  zohoCustomerStillExists,
} from './zoho-customers.js';
import {
  filterDealers,
  sortDealers,
  paginateDealers,
  dealerStats,
  dealerLocations,
  dealersToCsv,
  mapDealerForClient,
  mapDealerDetailForClient,
} from './dealer-query.js';
import { normalizeStaffZohoSalespersonIds } from './sales-order-salesperson.js';

const STAFF_ASSIGN_NO_ZOHO_MESSAGE = (
  'Assigned staff must have at least one linked Zoho salesperson.'
);

async function loadUserMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const db = getFirestore();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) {
    chunks.push(ids.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const snaps = await Promise.all(chunk.map(id => db.doc(`users/${id}`).get()));
    for (const snap of snaps) {
      if (snap.exists) {
        map.set(snap.id, snap.data());
      }
    }
  }
  return map;
}

/**
 * Staff users eligible for dealer assignment:
 * active staff/super_admin with ≥1 linked Zoho salesperson.
 */
export async function listAssignableStaffOptions() {
  const snap = await getFirestore().collection('users').get();
  const rows = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const role = String(data.role ?? '');
    if (role !== 'staff' && role !== 'super_admin') continue;
    if (data.active === false) continue;
    if (/\bshibin\b/i.test(String(data.displayName ?? ''))) continue;
    if (!normalizeStaffZohoSalespersonIds(data).length) continue;
    rows.push({
      uid: docSnap.id,
      displayName: String(data.displayName ?? 'Staff').trim() || 'Staff',
    });
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

function assertAssignableDealerStaff(userSnap, { requireZohoSalesperson = true } = {}) {
  if (!userSnap?.exists) {
    throw new HttpsError('not-found', 'Assigned staff not found.');
  }
  const userData = userSnap.data() || {};
  const role = String(userData.role ?? '');
  if (role !== 'staff' && role !== 'super_admin') {
    throw new HttpsError('failed-precondition', 'Assigned user must be staff or super admin.');
  }
  if (userData.active === false) {
    throw new HttpsError('failed-precondition', 'Assigned staff is inactive.');
  }
  if (requireZohoSalesperson && !normalizeStaffZohoSalespersonIds(userData).length) {
    throw new HttpsError('failed-precondition', STAFF_ASSIGN_NO_ZOHO_MESSAGE);
  }
  return userData;
}

function applyStaffScope(query, _scope = {}) {
  // All staff and super admins see the full dealer roster.
  // Optional `assignedStaffUid` query filter still works when the client sends it.
  return { ...(query || {}) };
}

export async function listDealers(query = {}, scope = {}) {
  const scopedQuery = applyStaffScope(query, scope);
  const rawDealers = await readAllDealersFromFirestore();

  const filtered = filterDealers(rawDealers, scopedQuery);
  const sorted = sortDealers(filtered, scopedQuery.sortField, scopedQuery.sortDir);
  const page = Number(scopedQuery.page) || 1;
  const limit = scopedQuery.limit === 99999 ? sorted.length : (Number(scopedQuery.limit) || 50);
  const { data, pagination } = paginateDealers(sorted, page, limit);

  const userIds = data.flatMap(d => [d.portalUserId, d.assignedStaffUid]);
  const usersById = await loadUserMap(userIds);
  return {
    data: data.map(d => mapDealerForClient(d, null, usersById)),
    pagination,
  };
}

export async function exportDealersCsv(query = {}, scope = {}) {
  const scopedQuery = applyStaffScope(query, scope);
  const rawDealers = await readAllDealersFromFirestore();
  const filtered = filterDealers(rawDealers, scopedQuery);
  const sorted = sortDealers(filtered, scopedQuery.sortField, scopedQuery.sortDir);
  return dealersToCsv(sorted);
}

export async function getDealerStatsSummary(scope = {}) {
  const rawDealers = await readAllDealersFromFirestore();
  const scoped = applyStaffScope({}, scope);
  const filtered = filterDealers(rawDealers, scoped);
  return dealerStats(filtered);
}

export async function getDealerLocationsSummary(scope = {}) {
  const rawDealers = await readAllDealersFromFirestore();
  const scoped = applyStaffScope({}, scope);
  const filtered = filterDealers(rawDealers, scoped);
  return dealerLocations(filtered);
}

export async function getDealerRecord(id, { refreshFromZoho, secrets, orgId } = {}) {
  if (refreshFromZoho && secrets) {
    await refreshDealerFromZoho(id, secrets, orgId, {
      force: Boolean(refreshFromZoho.force),
    });
  }

  const db = getFirestore();
  const snap = await db.collection('zohoCustomers').doc(id).get();
  if (!snap.exists) throw new Error('Dealer not found.');

  const raw = { id: snap.id, ...snap.data() };
  const usersById = await loadUserMap([raw.portalUserId, raw.assignedStaffUid]);
  return mapDealerDetailForClient(raw, null, usersById);
}

function textValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeDealerAddress(value) {
  if (!value || typeof value !== 'object') return null;
  const addr = {
    attention: textValue(value.attention),
    phone: textValue(value.phone),
    address: textValue(value.address),
    street2: textValue(value.street2),
    city: textValue(value.city),
    zip: String(value.zip ?? '').replace(/\D/g, '').slice(0, 6),
    state: textValue(value.state),
    country: textValue(value.country) || 'India',
    district: textValue(value.district),
  };
  if (!addr.address && !addr.city && !addr.zip && !addr.state && !addr.attention && !addr.district) {
    return null;
  }
  return addr;
}

function formatDealerAddress(addr) {
  if (!addr) return '';
  return [addr.attention, addr.address, addr.street2, addr.city, addr.state, addr.zip, addr.country]
    .map(textValue)
    .filter(Boolean)
    .join(', ');
}

function zohoAddressRaw(addr) {
  if (!addr) return null;
  return {
    attention: addr.attention,
    phone: addr.phone,
    address: addr.address,
    street2: addr.street2,
    city: addr.city,
    zip: addr.zip,
    state: addr.state,
    country: addr.country,
  };
}

export async function createDealerRecord(input, { secrets, orgId, requireZohoSalesperson = false } = {}) {
  const companyName = String(input?.companyName ?? '').trim();
  if (!companyName) {
    throw new HttpsError('invalid-argument', 'Company name is required.');
  }
  if (!secrets) {
    throw new HttpsError('failed-precondition', 'Zoho credentials are required to create a dealer.');
  }
  const contactName = String(input?.contactName ?? '').trim();
  const phone = String(input?.phone ?? '').replace(/\D/g, '').slice(0, 10);
  const mobile = String(input?.mobile ?? input?.alternateMobile ?? '').replace(/\D/g, '').slice(0, 10);
  const email = String(input?.email ?? '').trim().toLowerCase();
  const gstin = String(input?.gstin ?? input?.zohoGstNo ?? '').replace(/[\s-]/g, '').toUpperCase();
  const pan = String(input?.pan ?? input?.zohoPanNo ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const gstTreatment = String(input?.gstTreatment ?? input?.zohoGstTreatment ?? '').trim();
  const legalName = String(input?.legalName ?? input?.zohoLegalName ?? '').trim();
  if (!phone && !mobile) {
    throw new HttpsError('invalid-argument', 'Enter shop mobile or mobile.');
  }
  if (phone && phone.length !== 10) {
    throw new HttpsError('invalid-argument', 'Enter a valid 10-digit mobile number.');
  }
  if (mobile && mobile.length !== 10) {
    throw new HttpsError('invalid-argument', 'Enter a valid 10-digit mobile number.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 15-character GSTIN.');
  }
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 10-character PAN.');
  }

  const billing = normalizeDealerAddress(input?.billing) || normalizeDealerAddress({
    address: input?.billingAddress,
    state: input?.billingState,
    district: input?.district,
    zip: input?.zipCode,
  });
  const shipping = input?.sameShipping === false
    ? (normalizeDealerAddress(input?.shipping) || billing)
    : billing;

  const db = getFirestore();
  if (gstin) {
    const zohoId = await findZohoContactIdByGstin(secrets, orgId, gstin).catch(() => null);
    if (zohoId) {
      throw new HttpsError('already-exists', 'A dealer with this GSTIN already exists in Zoho.');
    }
    const existingGstin = await db.collection('zohoCustomers').where('zohoGstNo', '==', gstin).limit(1).get();
    if (!existingGstin.empty) {
      const orphan = existingGstin.docs[0];
      const stillInZoho = await zohoCustomerStillExists(secrets, orgId, orphan.id);
      if (stillInZoho) {
        throw new HttpsError('already-exists', 'A dealer with this GSTIN already exists.');
      }
      await orphan.ref.delete();
    }
  }

  let assignedStaffUid = null;
  let assignedStaffName = null;
  const staffUid = String(input?.assignedStaffUid ?? '').trim();
  if (staffUid) {
    const userSnap = await db.doc(`users/${staffUid}`).get();
    const userData = assertAssignableDealerStaff(userSnap, { requireZohoSalesperson });
    assignedStaffUid = staffUid;
    assignedStaffName = String(userData.displayName ?? userData.name ?? 'Staff').trim() || 'Staff';
  }

  let contactId;
  try {
    contactId = await createZohoCustomer({
      companyName,
      contactName,
      email,
      phone,
      mobile: mobile || phone,
      gstin,
      gstTreatment,
      legalName,
      pan,
      billing,
      shipping,
    }, secrets, orgId);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      'failed-precondition',
      err?.message || 'Could not create this dealer in Zoho.',
    );
  }

  const ref = db.collection('zohoCustomers').doc(contactId);
  await ref.set({
    firstName: contactName || null,
    phone: phone || null,
    mobile: mobile || phone || null,
    alternateMobile: mobile && mobile !== phone ? mobile : null,
    email: email || null,
    zohoGstNo: gstin || null,
    zohoGstTreatment: gstTreatment || null,
    zohoLegalName: legalName || null,
    zohoTaxpayerType: String(input?.taxpayerType ?? input?.zohoTaxpayerType ?? '').trim() || null,
    zohoConstitutionOfBusiness: String(input?.constitutionOfBusiness ?? input?.zohoConstitutionOfBusiness ?? '').trim() || null,
    zohoPanNo: pan || null,
    firmType: String(input?.constitutionOfBusiness ?? input?.firmType ?? '').trim() || null,
    billingState: billing?.state || String(input?.billingState ?? '').trim() || null,
    district: billing?.district || String(input?.district ?? '').trim() || null,
    zipCode: billing?.zip || String(input?.zipCode ?? '').replace(/\D/g, '').slice(0, 6) || null,
    billingAddress: formatDealerAddress(billing) || String(input?.billingAddress ?? '').trim() || null,
    shippingAddress: formatDealerAddress(shipping) || String(input?.shippingAddress ?? '').trim() || null,
    zohoBillingAddressRaw: zohoAddressRaw(billing),
    zohoShippingAddressRaw: zohoAddressRaw(shipping),
    googleMapsUrl: String(input?.googleMapsUrl ?? '').trim() || null,
    canBuySpares: input?.canBuySpares !== false,
    orderPayOffline: input?.orderPayOffline !== false,
    orderPayOnline: Boolean(input?.orderPayOnline),
    assignedStaffUid,
    assignedStaffName,
    dealerStage: String(input?.dealerStage ?? '').trim() || null,
    source: 'app',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return getDealerRecord(contactId);
}

export async function patchDealerRecord(id, body = {}) {
  const db = getFirestore();
  const ref = db.collection('zohoCustomers').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Dealer not found.');

  const data = {};
  if ('assignedStaffUid' in body) {
    const uid = body.assignedStaffUid ? String(body.assignedStaffUid).trim() : null;
    data.assignedStaffUid = uid || null;
    if (uid) {
      const userSnap = await db.doc(`users/${uid}`).get();
      const userData = assertAssignableDealerStaff(userSnap);
      data.assignedStaffName = String(userData.displayName ?? 'Staff').trim() || 'Staff';
    } else {
      data.assignedStaffName = null;
    }
  }
  if ('dealerStage' in body) data.dealerStage = body.dealerStage || null;
  if ('billingState' in body) data.billingState = body.billingState || null;
  if ('district' in body) data.district = body.district || null;
  if ('zipCode' in body) data.zipCode = body.zipCode || null;
  if ('categories' in body && Array.isArray(body.categories)) data.categories = body.categories;
  if ('isFiltered' in body) data.isFiltered = Boolean(body.isFiltered);
  if ('filterReason' in body) data.filterReason = body.filterReason ?? null;
  if ('firstName' in body) data.firstName = body.firstName || null;
  if ('email' in body) data.email = body.email || null;
  if ('phone' in body) data.phone = body.phone || null;
  if ('portalUserId' in body) data.portalUserId = body.portalUserId || null;
  if ('designation' in body) data.designation = body.designation || null;
  if ('alternateMobile' in body) data.alternateMobile = body.alternateMobile || null;
  if ('whatsappNumber' in body) data.whatsappNumber = body.whatsappNumber || null;
  if ('dealerType' in body) data.dealerType = body.dealerType || null;
  if ('firmType' in body) data.firmType = body.firmType || null;
  if ('creditLimit' in body) {
    data.creditLimit = body.creditLimit === '' || body.creditLimit == null
      ? null
      : Number(body.creditLimit);
  }
  if ('priceLevel' in body) data.priceLevel = body.priceLevel || null;
  if ('billingAddress' in body) data.billingAddress = body.billingAddress || null;
  if ('shippingAddress' in body) data.shippingAddress = body.shippingAddress || null;
  if ('zohoBillingAddressRaw' in body) data.zohoBillingAddressRaw = body.zohoBillingAddressRaw || null;
  if ('zohoShippingAddressRaw' in body) data.zohoShippingAddressRaw = body.zohoShippingAddressRaw || null;
  if ('zohoPanNo' in body) data.zohoPanNo = body.zohoPanNo || null;
  if ('googleMapsUrl' in body) data.googleMapsUrl = body.googleMapsUrl || null;
  if ('canBuySpares' in body) data.canBuySpares = Boolean(body.canBuySpares);
  if ('orderPayOffline' in body) data.orderPayOffline = Boolean(body.orderPayOffline);
  if ('orderPayOnline' in body) data.orderPayOnline = Boolean(body.orderPayOnline);
  if ('adminApprovalRequired' in body) data.adminApprovalRequired = Boolean(body.adminApprovalRequired);
  if ('maxOrderLimit' in body) {
    data.maxOrderLimit = body.maxOrderLimit === '' || body.maxOrderLimit == null
      ? null
      : Number(body.maxOrderLimit);
  }

  data.updatedAt = FieldValue.serverTimestamp();
  await ref.set(data, { merge: true });
  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

export async function linkDealerPortalUser(zohoCustomerId, portalUserId) {
  const db = getFirestore();
  const customerRef = db.collection('zohoCustomers').doc(zohoCustomerId);
  const customerSnap = await customerRef.get();
  if (!customerSnap.exists) throw new Error('Zoho customer not found.');

  if (portalUserId) {
    const userRef = db.doc(`users/${portalUserId}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error('Portal user not found.');
    await userRef.set({ zohoCustomerId }, { merge: true });
  }

  await customerRef.set({
    portalUserId: portalUserId || null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function refreshDealerZohoRecord(id, secrets, orgId, { force = true } = {}) {
  await refreshDealerFromZoho(id, secrets, orgId, { force });
  return getDealerRecord(id);
}

export async function pushDealerToZohoRecord(id, changes, secrets, orgId) {
  await pushDealerChangesToZoho(id, changes, secrets, orgId);
  return getDealerRecord(id);
}

export async function deleteDealerRecord(id, { secrets, orgId } = {}) {
  const contactId = String(id ?? '').trim();
  if (!contactId) throw new HttpsError('invalid-argument', 'Dealer id is required.');
  if (!secrets) {
    throw new HttpsError('failed-precondition', 'Zoho credentials are required to delete a dealer.');
  }
  try {
    return await deleteOrVoidZohoCustomer(contactId, secrets, orgId);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('failed-precondition', err?.message || 'Could not delete dealer.');
  }
}

export { readDealerSetting, writeDealerSetting };
