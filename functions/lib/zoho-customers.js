import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE } from './zoho.js';
import {
  extractZohoCoreFields,
  extractZohoDetailFields,
  extractZohoListFields,
  formatZohoAddress,
} from './zoho-contact-fields.js';
import { classifyZohoHttpError, recordZohoApiFailure } from './zoho-api-usage.js';
import { extractWebhookEvent } from './invoice-sync.js';
import { ackZohoWebhookFailure, ackIfDailyQuotaBlocked } from './zoho-webhook-guard.js';
import { normalizeStateName } from './location-utils.js';

const CUSTOMERS_COLLECTION = 'zohoCustomers';
const SETTINGS_COLLECTION = 'dealerSettings';

async function parseZohoJsonResponse(res) {
  const text = await res.text().catch(() => '');
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { text, payload };
}

async function fetchCustomersPage(accessToken, orgId, page = 1, perPage = 200) {
  const url = new URL(`${ZOHO_API_BASE}/contacts`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('contact_type', 'customer');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));

  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  const { text, payload } = await parseZohoJsonResponse(res);

  if (!res.ok || payload?.code !== 0) {
    const err = classifyZohoHttpError(res.status, payload ?? { message: text || 'Zoho contacts API error' });
    if (err.code === 'RATE_LIMITED') {
      await recordZohoApiFailure(err, { operation: 'syncZohoCustomers', source: 'dealers' });
    }
    throw err;
  }

  const data = payload;

  const contacts = (data.contacts ?? []).map(c => ({
    id: String(c.contact_id),
    ...extractZohoCoreFields(c),
    ...extractZohoListFields(c),
  }));

  const hasMore = Boolean(data.page_context?.has_more_page);
  if (hasMore) {
    const next = await fetchCustomersPage(accessToken, orgId, page + 1, perPage);
    return [...contacts, ...next];
  }
  return contacts;
}

export function processCustomers(rawCustomers) {
  const processedCustomers = [];
  const afterYesCloud = rawCustomers.map(c => {
    const lowerName = c.contactName.toLowerCase();
    if (lowerName.startsWith('yescloud') || lowerName.startsWith('retail cloud')) {
      return { ...c, isFiltered: true, filterReason: 'YesCloud Exclusion' };
    }
    return { ...c, isFiltered: false, filterReason: null };
  });

  const map = new Map();
  for (const customer of afterYesCloud) {
    if (customer.isFiltered) {
      processedCustomers.push(customer);
      continue;
    }

    const key = customer.contactName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) {
      processedCustomers.push(customer);
      continue;
    }

    if (!map.has(key)) {
      map.set(key, { ...customer });
    } else {
      const existing = map.get(key);
      existing.outstandingReceivable += customer.outstandingReceivable || 0;
      existing.unusedCredits += customer.unusedCredits || 0;
      if (!existing.email && customer.email) existing.email = customer.email;
      if (!existing.phone && customer.phone) existing.phone = customer.phone;
      if (!existing.mobile && customer.mobile) existing.mobile = customer.mobile;
      if (!existing.companyName && customer.companyName) existing.companyName = customer.companyName;
      if (existing.status !== 'active' && customer.status === 'active') existing.status = 'active';
      processedCustomers.push({ ...customer, isFiltered: true, filterReason: 'Duplicate Consolidated' });
    }
  }

  return [...Array.from(map.values()), ...processedCustomers];
}

function normalizeGstin(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** True when this contact id still exists in Zoho Inventory. */
export async function zohoCustomerStillExists(secrets, orgId, contactId) {
  const id = String(contactId ?? '').trim();
  if (!id) return false;
  try {
    const accessToken = await getAccessToken(secrets);
    const organizationId = await resolveOrganizationId(accessToken, orgId);
    await fetchRawCustomerDetail(accessToken, organizationId, id);
    return true;
  } catch {
    return false;
  }
}

/** Zoho contact id for this GSTIN, or null when Zoho has no match. */
export async function findZohoContactIdByGstin(secrets, orgId, gstin) {
  const key = normalizeGstin(gstin);
  if (!key) return null;
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const url = new URL(`${ZOHO_API_BASE}/contacts`);
  url.searchParams.set('organization_id', organizationId);
  url.searchParams.set('contact_type', 'customer');
  url.searchParams.set('search_text', key);
  url.searchParams.set('per_page', '25');
  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, organizationId) });
  const { payload } = await parseZohoJsonResponse(res);
  if (!res.ok || payload?.code !== 0) return null;
  const match = (payload.contacts ?? []).find(
    row => normalizeGstin(row?.gst_no) === key,
  );
  return match?.contact_id ? String(match.contact_id) : null;
}

export async function fetchRawCustomerDetail(accessToken, orgId, contactId) {
  const url = `${ZOHO_API_BASE}/contacts/${contactId}?organization_id=${orgId}`;
  const res = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  const { text, payload } = await parseZohoJsonResponse(res);
  if (!res.ok || payload?.code !== 0) {
    const err = classifyZohoHttpError(
      res.status,
      payload ?? { message: text || 'Zoho contact detail error' },
    );
    if (err.code === 'RATE_LIMITED') {
      await recordZohoApiFailure(err, { operation: 'fetchZohoCustomerDetail', source: 'dealers' });
    }
    throw err;
  }
  return payload.contact;
}

export async function syncCustomersToFirestore(secrets, orgId) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const raw = await fetchCustomersPage(accessToken, organizationId);
  const customers = processCustomers(raw);
  console.info(`Zoho customer sync: fetched ${raw.length} contacts, ${customers.length} after processing`);

  const db = getFirestore();
  const existingSnap = await db.collection(CUSTOMERS_COLLECTION).get();
  const existingMap = new Map(
    existingSnap.docs.map(d => [d.id, d.data()]),
  );

  let count = 0;
  const batchSize = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const customer of customers) {
    const existing = existingMap.get(customer.id);
    const isManuallyDeactivated = existing?.filterReason === 'Manual';
    const filteredValue = isManuallyDeactivated ? true : (customer.isFiltered ?? false);
    const filterReasonVal = isManuallyDeactivated ? 'Manual' : (customer.filterReason ?? null);

    let billingState = existing?.billingState ?? null;
    let district = existing?.district ?? null;
    let zipCode = existing?.zipCode ?? null;

    // Skip per-contact Zoho detail fetch during bulk sync — it adds minutes on first
    // import (one API call + delay per new customer). Location can be edited later.

    const ref = db.collection(CUSTOMERS_COLLECTION).doc(customer.id);
    const zohoListFields = extractZohoListFields(customer);
    const base = {
      contactName: customer.contactName,
      companyName: customer.companyName,
      email: existing?.email ?? customer.email,
      zohoEmail: customer.email,
      phone: existing?.phone ?? customer.phone,
      mobile: existing?.mobile ?? customer.mobile,
      firstName: existing?.firstName ?? customer.firstName,
      status: customer.status,
      outstandingReceivable: customer.outstandingReceivable,
      unusedCredits: customer.unusedCredits,
      isFiltered: filteredValue,
      filterReason: filterReasonVal,
      syncedAt: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      ...zohoListFields,
    };

    if (existing) {
      batch.set(ref, base, { merge: true });
    } else {
      batch.set(ref, {
        ...base,
        assignedStaffUid: null,
        assignedStaffName: null,
        dealerStage: null,
        billingState,
        district,
        zipCode,
        categories: [],
        portalUserId: null,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    batchCount += 1;
    count += 1;
    if (batchCount >= batchSize) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) await batch.commit();

  await db.collection(SETTINGS_COLLECTION).doc('meta').set({
    lastCustomerSyncAt: new Date().toISOString(),
    customerCount: count,
  }, { merge: true });

  const visible = customers.filter(c => !c.isFiltered || c.filterReason !== 'Manual').length;
  console.info(`Zoho customer sync complete: upserted ${count}, visible roster ~${visible}`);
  return count;
}

export async function readAllDealersFromFirestore() {
  const snap = await getFirestore().collection(CUSTOMERS_COLLECTION).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function readDealerSetting(key, fallback) {
  const doc = await getFirestore().collection(SETTINGS_COLLECTION).doc(key).get();
  if (!doc.exists) return fallback;
  return doc.data()?.value ?? fallback;
}

export async function writeDealerSetting(key, value) {
  await getFirestore().collection(SETTINGS_COLLECTION).doc(key).set({
    value,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return value;
}

const DETAIL_REFRESH_MAX_AGE_MS = 60 * 60 * 1000;

export async function refreshDealerFromZoho(id, secrets, orgId, { force = false } = {}) {
  const db = getFirestore();
  const ref = db.collection(CUSTOMERS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Dealer not found.');

  const existing = snap.data();
  if (existing.source === 'app' || !/^\d+$/.test(String(id))) {
    return { id: snap.id, ...existing };
  }

  const syncedAt = existing.zohoDetailSyncedAt;
  if (!force && syncedAt) {
    const age = Date.now() - new Date(syncedAt).getTime();
    if (age < DETAIL_REFRESH_MAX_AGE_MS) {
      return { id: snap.id, ...existing };
    }
  }

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const contact = await fetchRawCustomerDetail(accessToken, organizationId, id);
  const zohoDetailFields = extractZohoDetailFields(contact);
  const coreFields = extractZohoCoreFields(contact);
  const zohoEmail = coreFields.email ?? null;

  // Prefer Zoho contact-person mobile (login number) over a stale/empty local value.
  // Keep existing.phone as-is when set — it may be a shipping/company number.
  const resolvedMobile = coreFields.mobile
    ?? zohoDetailFields.zohoPrimaryContact?.mobile
    ?? existing.mobile
    ?? null;

  const patch = {
    ...coreFields,
    ...zohoDetailFields,
    zohoEmail,
    email: existing.email ?? zohoEmail,
    phone: existing.phone ?? coreFields.phone,
    mobile: resolvedMobile,
    firstName: existing.firstName ?? coreFields.firstName,
    syncedAt: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const billing = contact.billing_address;
  const shipping = contact.shipping_address;
  const address = (shipping?.state || shipping?.city) ? shipping : billing;
  if (address) {
    if (!existing.billingState && (address.state || address.state_code)) {
      patch.billingState = normalizeStateName(address.state || address.state_code)
        || address.state
        || address.state_code;
    }
    if (!existing.district && address.city) {
      patch.district = address.city;
    }
    if (!existing.zipCode && address.zip) {
      patch.zipCode = address.zip;
    }
  }

  await ref.set(patch, { merge: true });
  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

function cleanStr(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function omitEmpty(obj) {
  const next = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === '') continue;
    next[key] = value;
  }
  return next;
}

function isZohoPrimaryPerson(person, primaryId) {
  const flag = person?.is_primary_contact;
  if (flag === true || flag === 1 || flag === 'true' || flag === '1') return true;
  if (flag === false || flag === 0 || flag === 'false' || flag === '0') return false;
  return Boolean(primaryId && String(person?.contact_person_id) === String(primaryId));
}

function writableZohoAddress(raw, addressLine) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return omitEmpty({
    attention: cleanStr(src.attention),
    address: cleanStr(addressLine) ?? cleanStr(src.address),
    street2: cleanStr(src.street2),
    city: cleanStr(src.city),
    state: cleanStr(src.state),
    zip: cleanStr(src.zip),
    country: cleanStr(src.country),
    phone: cleanStr(src.phone),
    fax: cleanStr(src.fax),
  });
}

function addressChangeProvided(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return true;
  return Boolean(cleanStr(value));
}

function writableZohoAddressFromChange(raw, change) {
  if (change && typeof change === 'object' && !Array.isArray(change)) {
    return omitEmpty({
      attention: cleanStr(change.attention),
      address: cleanStr(change.address),
      street2: cleanStr(change.street2),
      city: cleanStr(change.city),
      state: cleanStr(change.state),
      zip: cleanStr(change.zip),
      country: cleanStr(change.country) || 'India',
      phone: cleanStr(change.phone),
      fax: cleanStr(change.fax),
    });
  }
  return writableZohoAddress(raw, change);
}

const CONTACT_PERSON_CHANGE_KEYS = [
  'firstName',
  'email',
  'zoho_email',
  'phone',
  'zoho_phone',
  'alternateMobile',
  'designation',
  'mobile',
];

function shouldUpdateContactPersons(changes) {
  return CONTACT_PERSON_CHANGE_KEYS.some(key => cleanStr(changes?.[key]));
}

function mapContactPersonForUpdate(person, primaryId, changes) {
  const isPrimary = isZohoPrimaryPerson(person, primaryId);
  const base = omitEmpty({
    contact_person_id: person.contact_person_id,
    salutation: cleanStr(person.salutation),
    last_name: cleanStr(person.last_name),
    department: cleanStr(person.department),
  });

  if (!isPrimary) {
    return omitEmpty({
      ...base,
      first_name: cleanStr(person.first_name),
      email: cleanStr(person.email),
      phone: cleanStr(person.phone),
      mobile: cleanStr(person.mobile),
      designation: cleanStr(person.designation),
    });
  }

  return omitEmpty({
    ...base,
    first_name: cleanStr(changes.firstName) ?? cleanStr(person.first_name),
    email: cleanStr(changes.email) ?? cleanStr(person.email),
    phone: cleanStr(changes.phone) ?? cleanStr(person.phone),
    mobile: cleanStr(changes.alternateMobile) ?? cleanStr(person.mobile),
    designation: cleanStr(changes.designation) ?? cleanStr(person.designation),
  });
}

function addressForCreate(addr) {
  if (!addr || typeof addr !== 'object') return undefined;
  const next = writableZohoAddressFromChange(null, addr);
  if (!next.address && !next.city && !next.zip && !next.state) return undefined;
  return next;
}

export async function createZohoCustomer(input, secrets, orgId) {
  const companyName = cleanStr(input?.companyName);
  if (!companyName) throw new Error('Company name is required.');

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const personName = cleanStr(input?.contactName) ?? companyName;
  const email = cleanStr(input?.email);
  const phone = cleanStr(input?.phone);
  const mobile = cleanStr(input?.mobile) ?? phone;
  const gstin = cleanStr(input?.gstin) ?? cleanStr(input?.gst_no);
  const gstTreatment = cleanStr(input?.gstTreatment) ?? cleanStr(input?.gst_treatment);
  const pan = cleanStr(input?.pan) ?? cleanStr(input?.pan_no);
  const legalName = cleanStr(input?.legalName) ?? cleanStr(input?.legal_name);
  const billingAddress = addressForCreate(input?.billing ?? input?.billing_address);
  const shippingAddress = addressForCreate(input?.shipping ?? input?.shipping_address) ?? billingAddress;

  const contactPerson = omitEmpty({
    first_name: personName,
    email,
    phone,
    mobile,
    is_primary_contact: true,
  });

  const body = omitEmpty({
    contact_name: companyName,
    company_name: companyName,
    contact_type: 'customer',
    customer_sub_type: 'business',
    email,
    phone,
    mobile,
    first_name: personName,
    gst_no: gstin,
    gst_treatment: gstTreatment,
    pan_no: pan,
    legal_name: legalName,
    contact_persons: [contactPerson],
    billing_address: billingAddress,
    shipping_address: shippingAddress,
  });

  const url = `${ZOHO_API_BASE}/contacts?organization_id=${organizationId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(accessToken, organizationId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(data.message || `Zoho contact create failed (${res.status}).`);
  }

  const contactId = String(data.contact?.contact_id ?? '').trim();
  if (!contactId) throw new Error('Zoho did not return a contact id.');
  await upsertCustomerFromZoho(secrets, orgId, contactId);
  return contactId;
}

export async function pushDealerChangesToZoho(id, changes, secrets, orgId) {
  const db = getFirestore();
  const ref = db.collection(CUSTOMERS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Dealer not found.');

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const contact = await fetchRawCustomerDetail(accessToken, organizationId, id);

  const contactName = contact.contact_name;
  if (!contactName) throw new Error('Zoho contact is missing contact_name.');

  const primaryId = contact.primary_contact_id;
  const updatePersons = shouldUpdateContactPersons(changes);
  let contactPersons = updatePersons
    ? (contact.contact_persons ?? []).map(p => mapContactPersonForUpdate(p, primaryId, changes))
    : [];

  if (updatePersons && !contactPersons.length) {
    contactPersons = [omitEmpty({
      first_name: cleanStr(changes.firstName),
      last_name: cleanStr(contact.last_name) ?? cleanStr(contactName),
      email: cleanStr(changes.email ?? changes.zoho_email),
      phone: cleanStr(changes.phone ?? changes.zoho_phone),
      mobile: cleanStr(changes.alternateMobile),
      designation: cleanStr(changes.designation),
      is_primary_contact: true,
    })];
  } else if (updatePersons && cleanStr(changes.zoho_phone)) {
    contactPersons = contactPersons.map(p => {
      const isPrimary = isZohoPrimaryPerson(p, primaryId)
        || (primaryId && String(p.contact_person_id) === String(primaryId));
      if (!isPrimary) return p;
      return omitEmpty({ ...p, phone: cleanStr(changes.zoho_phone) });
    });
  }

  const contactEmail = cleanStr(changes.email) ?? cleanStr(changes.zoho_email);
  const contactPhone = cleanStr(changes.phone) ?? cleanStr(changes.zoho_phone);

  const body = {
    contact_name: contactName,
    contact_type: contact.contact_type || 'customer',
  };

  if (updatePersons) {
    body.email = contactEmail ?? cleanStr(contact.email);
    body.phone = contactPhone ?? cleanStr(contact.phone);
    body.first_name = cleanStr(changes.firstName) ?? cleanStr(contact.first_name);
    body.mobile = cleanStr(changes.mobile)
      ?? cleanStr(changes.alternateMobile)
      ?? cleanStr(contact.mobile);
    if (contactPersons.length) body.contact_persons = contactPersons;
  } else {
    if (contactEmail) body.email = contactEmail;
    if (contactPhone) body.phone = contactPhone;
    if (cleanStr(changes.firstName)) body.first_name = cleanStr(changes.firstName);
    if (cleanStr(changes.mobile) || cleanStr(changes.alternateMobile)) {
      body.mobile = cleanStr(changes.mobile) ?? cleanStr(changes.alternateMobile);
    }
  }

  if (cleanStr(changes.legal_name)) body.legal_name = cleanStr(changes.legal_name);
  if (cleanStr(changes.customer_sub_type)) body.customer_sub_type = cleanStr(changes.customer_sub_type);
  if (cleanStr(changes.website)) body.website = cleanStr(changes.website);
  if (cleanStr(changes.gst_no)) body.gst_no = cleanStr(changes.gst_no);
  if (cleanStr(changes.gst_treatment)) body.gst_treatment = cleanStr(changes.gst_treatment);
  if (cleanStr(changes.pan_no)) body.pan_no = cleanStr(changes.pan_no);
  if (cleanStr(changes.notes)) body.notes = cleanStr(changes.notes);

  if (addressChangeProvided(changes.billing_address)) {
    body.billing_address = writableZohoAddressFromChange(contact.billing_address, changes.billing_address);
  }
  if (addressChangeProvided(changes.shipping_address)) {
    body.shipping_address = writableZohoAddressFromChange(contact.shipping_address, changes.shipping_address);
  }

  Object.keys(body).forEach(key => {
    if (body[key] === undefined) delete body[key];
  });

  const url = `${ZOHO_API_BASE}/contacts/${id}?organization_id=${organizationId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...authHeaders(accessToken, organizationId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(data.message || `Zoho contact update failed (${res.status}).`);
  }

  const localPatch = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if ('firstName' in changes) localPatch.firstName = cleanStr(changes.firstName) ?? null;
  if ('email' in changes) localPatch.email = cleanStr(changes.email) ?? null;
  if ('phone' in changes) localPatch.phone = cleanStr(changes.phone) ?? null;
  if ('designation' in changes) localPatch.designation = cleanStr(changes.designation) ?? null;
  if ('alternateMobile' in changes) localPatch.alternateMobile = cleanStr(changes.alternateMobile) ?? null;
  if (addressChangeProvided(changes.billing_address)) {
    const formatted = typeof changes.billing_address === 'object'
      ? formatZohoAddress(changes.billing_address)
      : cleanStr(changes.billing_address);
    localPatch.zohoBillingAddress = formatted ?? null;
    localPatch.billingAddress = formatted ?? null;
    if (typeof changes.billing_address === 'object') {
      localPatch.zohoBillingAddressRaw = changes.billing_address;
      localPatch.zipCode = cleanStr(changes.billing_address.zip) ?? null;
      localPatch.billingState = cleanStr(changes.billing_address.state) ?? null;
    }
  }
  if (addressChangeProvided(changes.shipping_address)) {
    const formatted = typeof changes.shipping_address === 'object'
      ? formatZohoAddress(changes.shipping_address)
      : cleanStr(changes.shipping_address);
    localPatch.zohoShippingAddress = formatted ?? null;
    localPatch.shippingAddress = formatted ?? null;
    if (typeof changes.shipping_address === 'object') {
      localPatch.zohoShippingAddressRaw = changes.shipping_address;
    }
  }
  await ref.set(localPatch, { merge: true });

  return refreshDealerFromZoho(id, secrets, orgId, { force: true });
}

function normalizeWebhookBody(body) {
  if (!body || typeof body !== 'object') return {};
  let next = { ...body };
  if (typeof body.JSONString === 'string' && body.JSONString.trim()) {
    try {
      const parsed = JSON.parse(body.JSONString);
      if (parsed && typeof parsed === 'object') next = { ...next, ...parsed };
    } catch {
      // ignore
    }
  }
  return next;
}

export function extractContactIdFromWebhook(body, query = {}) {
  const normalized = normalizeWebhookBody(body);
  const candidates = [
    query.contact_id,
    query.contactId,
    query.customer_id,
    query.customerId,
    query.id,
    normalized.contact_id,
    normalized.contactId,
    normalized.customer_id,
    normalized.contact?.contact_id,
    normalized.customer?.contact_id,
    normalized.data?.contact_id,
    normalized.payload?.contact_id,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

/**
 * Create or refresh one Zoho customer in zohoCustomers/{id} (webhook / force path).
 */
export async function upsertCustomerFromZoho(secrets, orgId, contactId) {
  const id = String(contactId ?? '').trim();
  if (!id) throw new Error('contactId is required.');

  const db = getFirestore();
  const ref = db.collection(CUSTOMERS_COLLECTION).doc(id);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const contact = await fetchRawCustomerDetail(accessToken, organizationId, id);

  const zohoDetailFields = extractZohoDetailFields(contact);
  const coreFields = extractZohoCoreFields(contact);
  const zohoListFields = extractZohoListFields(contact);
  const zohoEmail = coreFields.email ?? null;

  const isManuallyDeactivated = existing?.filterReason === 'Manual';
  const contactStatus = String(contact.status ?? coreFields.status ?? 'active').toLowerCase();
  const zohoFiltered = contactStatus === 'inactive' || contactStatus === 'deleted';

  const resolvedMobile = coreFields.mobile
    ?? zohoDetailFields.zohoPrimaryContact?.mobile
    ?? existing?.mobile
    ?? null;

  const patch = {
    ...coreFields,
    ...zohoListFields,
    ...zohoDetailFields,
    zohoEmail,
    email: existing?.email ?? zohoEmail,
    phone: existing?.phone ?? coreFields.phone,
    mobile: resolvedMobile,
    firstName: existing?.firstName ?? coreFields.firstName,
    isFiltered: isManuallyDeactivated ? true : zohoFiltered,
    filterReason: isManuallyDeactivated ? 'Manual' : (zohoFiltered ? 'Inactive' : (existing?.filterReason ?? null)),
    syncedAt: new Date().toISOString(),
    zohoDetailSyncedAt: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!isManuallyDeactivated && !zohoFiltered && existing?.filterReason === 'DeletedFromZoho') {
    patch.isFiltered = false;
    patch.filterReason = null;
  }

  const billing = contact.billing_address;
  const shipping = contact.shipping_address;
  const address = (shipping?.state || shipping?.city) ? shipping : billing;
  if (address) {
    if (!existing?.billingState && (address.state || address.state_code)) {
      patch.billingState = normalizeStateName(address.state || address.state_code)
        || address.state
        || address.state_code;
    }
    if (!existing?.district && address.city) {
      patch.district = address.city;
    }
    if (!existing?.zipCode && address.zip) {
      patch.zipCode = address.zip;
    }
  }

  if (!existing) {
    await ref.set({
      ...patch,
      assignedStaffUid: null,
      assignedStaffName: null,
      dealerStage: null,
      billingState: patch.billingState ?? null,
      district: patch.district ?? null,
      zipCode: patch.zipCode ?? null,
      categories: [],
      portalUserId: null,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { id, created: true };
  }

  await ref.set(patch, { merge: true });
  return { id, created: false };
}

function zohoContactMissing(res, payload) {
  const code = Number(payload?.code);
  const message = String(payload?.message ?? '');
  return res?.status === 404
    || code === 1002
    || code === 5
    || /invalid contact|not found|does not exist|invalid url passed|resource does not exist|has been deleted/i.test(message);
}

function zohoErrorLooksMissing(err) {
  return zohoContactMissing(
    { status: err?.status ?? 0 },
    { message: String(err?.message ?? err ?? ''), code: err?.zohoCode ?? err?.code },
  );
}

function zohoIsUnavailable(err) {
  const status = Number(err?.status ?? 0);
  const message = String(err?.message ?? '');
  return err?.code === 'RATE_LIMITED'
    || status === 401
    || status === 403
    || status === 429
    || status >= 500
    || /rate.?limit|unauthorized|not authorized|invalid token|access token|timed out/i.test(message);
}

function zohoAlreadyInactive(payload) {
  const message = String(payload?.message ?? '');
  return /already/i.test(message) && /inactive/i.test(message);
}

async function zohoContactAlreadyGone(accessToken, organizationId, contactId, priorErr) {
  if (priorErr && zohoErrorLooksMissing(priorErr)) return true;
  try {
    await fetchRawCustomerDetail(accessToken, organizationId, contactId);
    return false;
  } catch (err) {
    if (zohoIsUnavailable(err)) throw err;
    return true;
  }
}

function cannotDeleteBecauseTransactions(payload) {
  if (zohoContactMissing({ status: 0 }, payload)) return false;
  const message = String(payload?.message ?? '').toLowerCase();
  return /transaction|cannot be deleted|associated with|sales order|invoice|has been used|outstanding/i.test(message);
}

async function markZohoContactInactive(accessToken, organizationId, contactId) {
  const inactiveUrl = `${ZOHO_API_BASE}/contacts/${contactId}/inactive?organization_id=${organizationId}`;
  const res = await fetch(inactiveUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(accessToken, organizationId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const { payload } = await parseZohoJsonResponse(res);
  if (res.ok && (payload?.code === 0 || payload?.code == null)) return;
  if (zohoAlreadyInactive(payload) || zohoContactMissing(res, payload)) return;

  let contactName = '';
  const contact = await fetchRawCustomerDetail(accessToken, organizationId, contactId);
  contactName = String(contact?.contact_name ?? '').trim();
  const putUrl = `${ZOHO_API_BASE}/contacts/${contactId}?organization_id=${organizationId}`;
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      ...authHeaders(accessToken, organizationId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contact_name: contactName || 'Customer',
      contact_type: 'customer',
      status: 'inactive',
    }),
  });
  const { payload: putPayload } = await parseZohoJsonResponse(putRes);
  if (putRes.ok && (putPayload?.code === 0 || putPayload?.code == null)) return;
  if (zohoAlreadyInactive(putPayload) || zohoContactMissing(putRes, putPayload)) return;
  throw new Error(putPayload?.message || 'Zoho could not void this dealer.');
}

/** Delete in Zoho when there are no transactions; otherwise mark inactive (void). */
export async function deleteOrVoidZohoCustomer(id, secrets, orgId) {
  const contactId = String(id ?? '').trim();
  if (!contactId) throw new Error('Dealer id is required.');

  const db = getFirestore();
  const ref = db.collection(CUSTOMERS_COLLECTION).doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Dealer not found.');

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const delUrl = `${ZOHO_API_BASE}/contacts/${contactId}?organization_id=${organizationId}`;
  const delRes = await fetch(delUrl, {
    method: 'DELETE',
    headers: authHeaders(accessToken, organizationId),
  });
  const { payload: delPayload } = await parseZohoJsonResponse(delRes);
  console.info('deleteDealer zoho DELETE', {
    id: contactId,
    status: delRes.status,
    code: delPayload?.code ?? null,
    message: delPayload?.message ?? null,
  });
  const deletedOk = delRes.ok && (delPayload?.code === 0 || delRes.status === 204);
  const missing = zohoContactMissing(delRes, delPayload);

  if (deletedOk || missing) {
    await ref.delete();
    return { action: 'deleted', id: contactId };
  }

  if (cannotDeleteBecauseTransactions(delPayload)) {
    try {
      await markZohoContactInactive(accessToken, organizationId, contactId);
    } catch (err) {
      if (await zohoContactAlreadyGone(accessToken, organizationId, contactId, err)) {
        await ref.delete();
        return { action: 'deleted', id: contactId };
      }
      throw err;
    }
    await ref.set({
      status: 'inactive',
      isFiltered: true,
      filterReason: 'Void',
      dealerStage: 'Non Active',
      syncedAt: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { action: 'voided', id: contactId };
  }

  if (await zohoContactAlreadyGone(accessToken, organizationId, contactId)) {
    await ref.delete();
    return { action: 'deleted', id: contactId };
  }

  throw new Error(delPayload?.message || `Zoho could not delete this dealer (${delRes.status}).`);
}

export async function markCustomerDeletedFromZoho(contactId) {
  const id = String(contactId ?? '').trim();
  if (!id) return;
  const ref = getFirestore().collection(CUSTOMERS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  // Keep portal-linked dealers; soft-hide everyone on Zoho delete.
  await ref.set({
    isFiltered: true,
    filterReason: data.filterReason === 'Manual' ? 'Manual' : 'DeletedFromZoho',
    status: 'inactive',
    syncedAt: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function handleZohoCustomerWebhook(secrets, orgId, req) {
  const body = normalizeWebhookBody(req.body ?? {});
  const contactId = extractContactIdFromWebhook(body, req.query ?? {});
  if (!contactId) {
    return { ok: false, status: 400, message: 'Missing contact_id' };
  }

  const queryAction = String(req.query?.action ?? '').trim().toLowerCase();
  const event = queryAction || extractWebhookEvent(body);
  if (event.includes('delete')) {
    await markCustomerDeletedFromZoho(contactId);
    return { ok: true, status: 200, action: 'deleted', contactId };
  }

  try {
    const blocked = await ackIfDailyQuotaBlocked('customer', contactId);
    if (blocked) return blocked;
    const result = await upsertCustomerFromZoho(secrets, orgId, contactId);
    return { ok: true, status: 200, action: 'synced', contactId, result };
  } catch (err) {
    const ack = await ackZohoWebhookFailure('customer', contactId, err);
    if (ack) return ack;
    throw err;
  }
}
