/**
 * Zoho Inventory e-Way Bill API (India edition).
 */
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE, hasZohoJsonBody } from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
} from './zoho-api-usage.js';
import {
  ensureZohoDispatchFromAddress,
  ewayVehicleOriginFromAddress,
} from './eway-shipping-context.js';

function formatZohoApiError(payload, fallback) {
  const parts = [];
  const message = String(payload?.message ?? '').trim();
  if (message) parts.push(message);
  if (Array.isArray(payload?.error_info)) {
    for (const item of payload.error_info) {
      const text = String(item ?? '').trim();
      if (text) parts.push(text);
    }
  }
  return parts.filter(Boolean).join(' ') || fallback;
}

const ZOHO_BOOKS_API_BASE = 'https://www.zohoapis.in/books/v3';

async function zohoJson(accessToken, orgId, path, { method = 'GET', body, query = {}, apiBase = ZOHO_API_BASE } = {}) {
  const url = new URL(`${apiBase}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }
  for (const [key, value] of Object.entries(query)) {
    if (value != null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const sendBody = hasZohoJsonBody(body);
  const init = {
    method,
    headers: {
      ...authHeaders(accessToken, orgId),
      ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (sendBody) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    recordZohoApiFailure(err);
    throw err;
  }

  const payload = await res.json().catch(() => ({}));
  recordZohoApiResponse(res.status, path);

  if (!res.ok) {
    const classified = classifyZohoHttpError(res.status, payload);
    throw new Error(formatZohoApiError(payload, classified?.message || `Zoho request failed (${res.status}).`));
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(formatZohoApiError(payload, 'Zoho API error.'));
  }
  return payload;
}

function normalizeGstin(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[0-9A-Z]{15}$/.test(text) ? text : '';
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function invoiceHasIrn(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  const details = invoice.einvoice_details && typeof invoice.einvoice_details === 'object'
    ? invoice.einvoice_details
    : {};
  const irn = String(details.irn ?? details.IRN ?? invoice.irn ?? '').trim();
  if (irn) return true;
  const status = String(
    details.status ?? invoice.einvoice_status ?? invoice.e_invoice_status ?? '',
  ).trim().toLowerCase();
  return Boolean(status) && /pushed|generated|success|active|irn/.test(status);
}

function existingDispatchFromAddressId(invoice) {
  if (!invoice || typeof invoice !== 'object') return '';
  const details = invoice.einvoice_details && typeof invoice.einvoice_details === 'object'
    ? invoice.einvoice_details
    : {};
  return String(
    invoice.dispatch_from_address_id
    ?? invoice.dispatch_from_address?.address_id
    ?? details.dispatch_from_address_id
    ?? '',
  ).trim();
}

function isIrnDispatchLockedError(message) {
  return /dispatch associated with the irn|irn generated invoice can't be changed|cannot be changed/i.test(
    String(message ?? ''),
  );
}

function isMissingZohoEndpointError(message) {
  return /invalid url|unknown url|not found|no such resource|uri not found|404/i.test(
    String(message ?? ''),
  );
}

function isGstDistanceMismatchError(message) {
  return /distance between the pincodes|too high or low|invalid approximate distance/i.test(
    String(message ?? ''),
  );
}

function isEwayAlreadyGeneratedError(message) {
  return /already generated|already exists|duplicate e-?way|ewaybill is already generated/i.test(
    String(message ?? ''),
  );
}

function isZohoNotAuthorizedError(message) {
  return /not authorized to perform this operation/i.test(String(message ?? ''));
}

export function isEwayPdfNotReadyError(message) {
  return /printed \/ downloaded as PDF|synced e-way bills from e-way bill portal/i.test(
    String(message ?? ''),
  );
}

function isEwayRecoverableGenerateError(message) {
  return isEwayAlreadyGeneratedError(message)
    || isZohoNotAuthorizedError(message)
    || isEwayPdfNotReadyError(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatEwayBillPortalError(message) {
  const text = String(message ?? '').trim();
  if (/api access is not available/i.test(text)) {
    return (
      'Zoho could not reach the GST e-way bill portal (API access is not available). '
      + 'IRN is already generated; e-way bill uses a separate GSTN API. '
      + 'In Zoho Inventory open Settings → Taxes → GST / E-Way Bills and save E-Way Bill Portal '
      + 'username and password, then retry. Or generate the e-way bill on the invoice in Zoho '
      + 'and tap E way bill here again.'
    );
  }
  if (isEwayPdfNotReadyError(text)) {
    return (
      'Zoho cannot print this e-way bill yet (GST portal has not synced the PDF). '
      + 'The e-way number can still be saved on the booking and sent to Delhivery.'
    );
  }
  if (isEwayAlreadyGeneratedError(text)) {
    return (
      'GST already created the e-way bill for this invoice IRN, so Zoho cannot generate it again '
      + '(Save and Generate will keep failing). YesOne will fetch that GST number and attach it in Zoho. '
      + 'If this still fails, look up the e-way bill on the GST portal with the IRN, then in Zoho Books '
      + 'open the invoice → More → Add e-Way Bill Details → Associate e-Way Bill number.'
    );
  }
  return text;
}

function isCancelledEwayStatus(status) {
  return /cancel/.test(String(status ?? '').trim().toLowerCase());
}

function isGeneratedEwayStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value || value === 'yet_to_generate' || value === 'not_generated') return false;
  if (isCancelledEwayStatus(value) || value === 'excluded') return false;
  return value.includes('generated') || value === 'valid' || value === 'active';
}

function recordLooksCancelled(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.is_cancelled === true || record.cancelled === true) return true;
  return isCancelledEwayStatus(
    record.ewaybill_status ?? record.eway_bill_status ?? record.status,
  );
}

function normalizeMappedEwayStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (isCancelledEwayStatus(value)) return 'cancelled';
  if (!value || value === 'yet_to_generate' || value === 'not_generated') return 'missing';
  if (value.includes('generated')) return 'generated';
  return value;
}

async function fetchZohoInvoice(accessToken, orgId, invoiceId) {
  const id = String(invoiceId ?? '').trim();
  if (!id) return null;
  const payload = await zohoJson(accessToken, orgId, `/invoices/${encodeURIComponent(id)}`);
  return payload?.invoice ?? null;
}

async function fetchZohoEwayBillRecord(accessToken, orgId, ewaybillId) {
  const id = String(ewaybillId ?? '').trim();
  if (!id) return null;
  const payload = await zohoJson(accessToken, orgId, `/ewaybills/${encodeURIComponent(id)}`);
  return payload?.ewaybill ?? null;
}

/** Pull GST portal details onto a Zoho e-way bill so the 12-digit number is available. */
export async function syncZohoEwayBillFromGstPortal(accessToken, orgId, ewaybillId) {
  const id = String(ewaybillId ?? '').trim();
  if (!id) return null;
  try {
    const payload = await zohoJson(accessToken, orgId, `/ewaybills/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    });
    const fromSync = ewayRecordFromPayload(payload) || payload?.ewaybill || null;
    if (fromSync && recordEwayBillNumber(fromSync)) {
      return fromSync;
    }
  } catch {
    // GET still works if sync is not allowed or already current
  }
  try {
    const fetched = await zohoJson(accessToken, orgId, `/ewaybills/${encodeURIComponent(id)}/fetch`, {
      method: 'POST',
    });
    const fromFetch = ewayRecordFromPayload(fetched) || fetched?.ewaybill || null;
    if (fromFetch && recordEwayBillNumber(fromFetch)) {
      return fromFetch;
    }
  } catch {
    // Fetch from Portal is not always exposed on this host
  }
  try {
    return await fetchZohoEwayBillRecord(accessToken, orgId, id);
  } catch {
    return null;
  }
}

function resolveEwayDistanceKm(options = {}) {
  const explicit = Number(options.explicitDistance);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.round(explicit);
  }
  // GST NIC auto-calculates pin-to-pin when distance is 0. A haversine estimate
  // is often outside NIC's ±10% band ("distance between the pincodes is too high or low").
  return 0;
}

/**
 * @param {string} partnerId Logistics partner id from booking.
 * @returns {string}
 */
export function deliveryPartnerTabForLogisticsPartner(partnerId) {
  const id = String(partnerId ?? '').trim();
  if (id.startsWith('bluedart_')) return 'bluedart';
  if (id.startsWith('trackon_')) return 'trackon';
  return id;
}

async function loadPartnerTransporter(db, partnerId) {
  const tab = deliveryPartnerTabForLogisticsPartner(partnerId);
  const snap = await db.doc('appSettings/logisticsSettings').get();
  const transporterRaw = snap.data()?.partnerTransporters?.[tab];
  if (!transporterRaw || typeof transporterRaw !== 'object') return null;
  const id = String(transporterRaw.id ?? '').trim();
  const name = String(transporterRaw.name ?? '').trim();
  if (!id) return null;
  return { id, name: name || id };
}

/**
 * @param {string} accessToken
 * @param {string} orgId
 */
export async function listZohoTransporters(accessToken, orgId) {
  const payload = await zohoJson(accessToken, orgId, '/ewaybills/transporters');
  const rows = Array.isArray(payload?.transporters) ? payload.transporters : [];
  return rows
    .map(row => ({
      id: String(row?.transporter_id ?? '').trim(),
      name: String(row?.transporter_name ?? '').trim(),
      gstin: normalizeGstin(row?.transporter_registration_id) || null,
    }))
    .filter(row => row.id && row.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the Zoho transporter configured for a delivery partner.
 * @param {import('firebase-admin/firestore').Firestore} db
 */
export async function resolveTransporterForPartner(accessToken, orgId, db, partnerId) {
  const transporter = await loadPartnerTransporter(db, partnerId);
  if (transporter?.id) {
    return {
      transporterId: transporter.id,
      transporterName: transporter.name,
    };
  }

  const transporterName = partnerLabel(partnerId) || partnerId;
  throw new Error(
    'No Zoho transporter is linked to this delivery partner. '
    + 'Open Settings → Logistics → Delivery Partners, pick the Zoho transporter '
    + `(e.g. ${transporterName}), save, then retry.`,
  );
}

function partnerLabel(partnerId) {
  const labels = {
    delhivery: 'Delhivery',
    st_courier: 'ST Courier',
    bluedart: 'Blue Dart',
    trackon: 'Trackon',
    dtdc: 'DTDC',
    ecosafe: 'Ecosafe',
    aps: 'APS',
    personal_collection: 'Customer Pickup',
  };
  const id = String(partnerId ?? '');
  if (labels[id]) return labels[id];
  if (id.startsWith('bluedart_')) return 'Blue Dart';
  if (id.startsWith('trackon_')) return 'Trackon';
  return id || 'Courier';
}

function collectEwayBillIds(invoice) {
  const ids = [];
  const push = (value) => {
    const id = String(value ?? '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(invoice?.ewaybill_id);
  push(invoice?.eway_bill_id);
  const groups = [
    invoice?.ewaybills,
    invoice?.eway_bills,
    invoice?.einvoice_details?.ewaybills,
    invoice?.einvoice_details?.eway_bills,
  ];
  for (const rows of groups) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      push(row.ewaybill_id ?? row.eway_bill_id ?? row.id);
    }
  }
  return ids;
}

function recordEwayBillNumber(record) {
  if (!record || typeof record !== 'object') return '';
  return String(
    record.ewaybill_number
    ?? record.eway_bill_number
    ?? record.ewb_no
    ?? record.EwbNo
    ?? record.ewbNo
    ?? record.ewaybill_no
    ?? '',
  ).trim();
}

function pushKnownEwayNumbers(source, push) {
  if (!source || typeof source !== 'object') return;
  push(source.ewaybill_number);
  push(source.eway_bill_number);
  push(source.ewb_no);
  push(source.EwbNo);
  push(source.ewbNo);
  push(source.ewaybill_no);
}

function decodeSignedEwayNumbers(value, push) {
  const text = String(value ?? '').trim();
  if (!text) return;
  const tryObject = (raw) => {
    if (raw && typeof raw === 'object') pushKnownEwayNumbers(raw, push);
  };
  if (text.startsWith('{')) {
    try {
      tryObject(JSON.parse(text));
    } catch {
      // ignore
    }
    return;
  }
  const parts = text.split('.');
  if (parts.length < 2) return;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    tryObject(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')));
  } catch {
    // ignore
  }
}

function gstEwayBillNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{12}$/.test(digits) ? digits : '';
}

function isoDateFromGst(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!slash) return '';
  return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
}

function collectEwayBillNumbers(invoice) {
  const numbers = [];
  const push = (value) => {
    const number = String(value ?? '').trim();
    if (number && !numbers.includes(number)) numbers.push(number);
  };
  const details = invoice?.einvoice_details && typeof invoice.einvoice_details === 'object'
    ? invoice.einvoice_details
    : {};
  pushKnownEwayNumbers(invoice, push);
  pushKnownEwayNumbers(details, push);
  const groups = [
    invoice?.ewaybills,
    invoice?.eway_bills,
    details.ewaybills,
    details.eway_bills,
  ];
  for (const rows of groups) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      pushKnownEwayNumbers(row, push);
    }
  }
  decodeSignedEwayNumbers(details.signed_invoice ?? details.SignedInvoice, push);
  decodeSignedEwayNumbers(invoice?.signed_invoice, push);
  return numbers;
}

function ewayRecordFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.ewaybill && typeof payload.ewaybill === 'object') {
    return ewayRecordFromPayload(payload.ewaybill);
  }
  if (payload.eway_bill && typeof payload.eway_bill === 'object') {
    return ewayRecordFromPayload(payload.eway_bill);
  }
  const number = recordEwayBillNumber(payload);
  if (payload.ewaybill_id || payload.eway_bill_id || number) {
    if (number && !payload.ewaybill_number && !payload.eway_bill_number) {
      return { ...payload, ewaybill_number: number, ewaybill_status: payload.ewaybill_status || 'generated' };
    }
    return payload;
  }
  if (payload.einvoice_details && typeof payload.einvoice_details === 'object') {
    return ewayRecordFromPayload(payload.einvoice_details);
  }
  if (payload.einvoice && typeof payload.einvoice === 'object') {
    return ewayRecordFromPayload(payload.einvoice);
  }
  return null;
}

function isDraftEwayRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (recordEwayBillNumber(record)) return false;
  const status = String(
    record.ewaybill_status ?? record.eway_bill_status ?? record.status ?? '',
  ).trim().toLowerCase();
  return status === 'yet_to_generate' || status === 'not_generated' || status === 'draft';
}

function isActiveGeneratedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (recordLooksCancelled(record)) return false;
  if (isDraftEwayRecord(record)) return false;
  if (recordEwayBillNumber(record)) return true;
  const status = String(record.ewaybill_status ?? record.eway_bill_status ?? record.status ?? '').toLowerCase();
  return isGeneratedEwayStatus(status);
}

async function listEwayBillsForInvoice(accessToken, orgId, invoice) {
  const invoiceId = String(invoice?.invoice_id ?? '').trim();
  const invoiceNumber = String(invoice?.invoice_number ?? '').trim();
  const queries = [];
  if (invoiceId) {
    queries.push({ entity_type: 'invoice', entity_ids: invoiceId });
    queries.push({ entity_type: 'invoice', entity_id: invoiceId });
    queries.push({ entity_type: 'invoice', entity_ids: invoiceId, status: 'yet_to_generate' });
    queries.push({ invoice_id: invoiceId });
    queries.push({ entity_id: invoiceId });
  }
  if (invoiceNumber) {
    queries.push({ entity_type: 'invoice', reference_number: invoiceNumber });
    queries.push({ reference_number: invoiceNumber });
    queries.push({ invoice_number: invoiceNumber });
  }
  for (const number of collectEwayBillNumbers(invoice)) {
    queries.push({ ewaybill_number: number });
    queries.push({ eway_bill_number: number });
  }

  const belongs = (row) => {
    if (!row || typeof row !== 'object') return false;
    const rowInvoiceId = String(row.invoice_id ?? row.entity_id ?? '').trim();
    const rowNumber = String(
      row.invoice_number ?? row.reference_number ?? row.entity_number ?? '',
    ).trim();
    if (rowInvoiceId) return Boolean(invoiceId) && rowInvoiceId === invoiceId;
    if (rowNumber) return Boolean(invoiceNumber) && rowNumber === invoiceNumber;
    return true;
  };

  const seen = new Set();
  const rows = [];
  for (const query of queries) {
    try {
      const payload = await zohoJson(accessToken, orgId, '/ewaybills', { query });
      const batch = Array.isArray(payload?.ewaybills) ? payload.ewaybills : [];
      for (const row of batch) {
        if (!belongs(row)) continue;
        const key = String(row?.ewaybill_id ?? row?.ewaybill_number ?? JSON.stringify(row));
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    } catch {
      // try the next query shape
    }
  }
  return rows;
}

async function fetchZohoEinvoice(accessToken, orgId, invoice) {
  const invoiceId = String(invoice?.invoice_id ?? '').trim();
  const einvoiceId = String(
    invoice?.einvoice_id
    ?? invoice?.einvoice_details?.einvoice_id
    ?? '',
  ).trim();
  const paths = [];
  if (invoiceId) {
    paths.push(`/invoices/${encodeURIComponent(invoiceId)}/einvoice`);
    paths.push(`/invoices/${encodeURIComponent(invoiceId)}/einvoice/ewaybill`);
  }
  if (einvoiceId) paths.push(`/einvoices/${encodeURIComponent(einvoiceId)}`);

  for (const path of paths) {
    try {
      const payload = await zohoJson(accessToken, orgId, path);
      return payload?.einvoice ?? payload?.einvoice_details ?? payload;
    } catch {
      // try the next path
    }
  }
  return null;
}

async function postZohoQuiet(accessToken, orgId, path, apiBase = ZOHO_API_BASE) {
  try {
    return await zohoJson(accessToken, orgId, path, { method: 'POST', body: {}, apiBase });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingZohoEndpointError(message)) return null;
    if (/already|success|fetched|no details|not generated/i.test(message)) return { message };
    console.warn(`Zoho ${path} failed:`, message);
    return null;
  }
}

/** Pull IRN / e-way details from the GST IRP onto the Zoho invoice. */
async function fetchZohoEinvoiceFromIrp(accessToken, orgId, invoice) {
  const invoiceId = String(invoice?.invoice_id ?? '').trim();
  if (!invoiceId) return null;
  const paths = [
    `/invoices/${encodeURIComponent(invoiceId)}/einvoice/fetch`,
    `/invoices/${encodeURIComponent(invoiceId)}/einvoices/fetch`,
  ];
  for (const path of paths) {
    const payload = await postZohoQuiet(accessToken, orgId, path);
    if (payload) return payload;
  }
  return postZohoQuiet(
    accessToken,
    orgId,
    `/invoices/${encodeURIComponent(invoiceId)}/einvoice/fetch`,
    ZOHO_BOOKS_API_BASE,
  );
}

/**
 * Look up an active generated e-way bill for an invoice.
 * Ignores cancelled bills so a replacement (after cancel) can be found.
 *
 * @param {string} accessToken
 * @param {string} orgId
 * @param {string} invoiceId
 */
export async function findZohoEwayBillForInvoice(accessToken, orgId, invoiceId) {
  const id = String(invoiceId ?? '').trim();
  if (!id) return null;

  const invoice = await fetchZohoInvoice(accessToken, orgId, id);
  if (!invoice) return null;

  return pickActiveEwayBillForInvoice(accessToken, orgId, invoice);
}

async function pickActiveEwayBillForInvoice(accessToken, orgId, invoice, extra = null) {
  const extraDetails = extra && typeof extra === 'object'
    ? {
      ...extra,
      ...(extra.einvoice && typeof extra.einvoice === 'object' ? extra.einvoice : {}),
      ...(extra.einvoice_details && typeof extra.einvoice_details === 'object' ? extra.einvoice_details : {}),
    }
    : null;
  const merged = extraDetails
    ? {
      ...invoice,
      einvoice_details: {
        ...(invoice.einvoice_details && typeof invoice.einvoice_details === 'object'
          ? invoice.einvoice_details
          : {}),
        ...extraDetails,
      },
    }
    : invoice;

  const fromExtra = ewayRecordFromPayload(extraDetails) || ewayRecordFromPayload(extra);
  const ids = collectEwayBillIds(merged);
  if (fromExtra?.ewaybill_id) {
    const nestedId = String(fromExtra.ewaybill_id).trim();
    if (nestedId && !ids.includes(nestedId)) ids.push(nestedId);
  }
  const listed = await listEwayBillsForInvoice(accessToken, orgId, merged);
  for (const row of listed) {
    const listedId = String(row?.ewaybill_id ?? row?.eway_bill_id ?? '').trim();
    if (listedId && !ids.includes(listedId)) ids.push(listedId);
  }

  let best = null;
  const consider = (record) => {
    if (!isActiveGeneratedRecord(record)) return;
    if (!best) {
      best = record;
      return;
    }
    const bestDate = String(best.ewaybill_date ?? best.created_time ?? '');
    const nextDate = String(record.ewaybill_date ?? record.created_time ?? '');
    if (nextDate > bestDate) best = record;
  };

  consider(fromExtra);
  for (const ewayId of ids) {
    try {
      consider(await fetchZohoEwayBillRecord(accessToken, orgId, ewayId));
    } catch {
      // skip missing / inaccessible ids
    }
  }
  if (best) return best;

  const listedActive = listed.find(row => isActiveGeneratedRecord(row));
  if (listedActive) return listedActive;

  const number = collectEwayBillNumbers(merged).map(gstEwayBillNumber).find(Boolean) || '';
  if (!number) return null;
  return {
    ewaybill_id: ids[0] || undefined,
    ewaybill_number: number,
    ewaybill_status: 'generated',
  };
}

async function findDraftEwayBillId(accessToken, orgId, invoice) {
  const ids = collectEwayBillIds(invoice);
  const listed = await listEwayBillsForInvoice(accessToken, orgId, invoice);
  for (const row of listed) {
    const listedId = String(row?.ewaybill_id ?? row?.eway_bill_id ?? '').trim();
    if (listedId && !ids.includes(listedId)) ids.push(listedId);
  }
  for (const ewayId of ids) {
    try {
      const record = await fetchZohoEwayBillRecord(accessToken, orgId, ewayId);
      if (record && isDraftEwayRecord(record)) return String(record.ewaybill_id ?? ewayId);
    } catch {
      // skip
    }
  }
  const listedDraft = listed.find(row => isDraftEwayRecord(row));
  return listedDraft?.ewaybill_id ? String(listedDraft.ewaybill_id) : '';
}

/** Attach a GST e-way number onto Zoho's draft (same as Associate e-Way Bill number). */
export async function associateGstEwayBillOnZoho(accessToken, orgId, invoice, number, extra = null) {
  const digits = gstEwayBillNumber(number) || gstEwayBillNumber(recordEwayBillNumber(extra));
  if (!digits) return null;
  const invoiceId = String(invoice?.invoice_id ?? '').trim();
  if (!invoiceId) return null;
  const date = isoDateFromGst(
    extra?.ewaybill_date
    ?? extra?.EwbDt
    ?? extra?.ewb_dt
    ?? extra?.eway_bill_date
    ?? '',
  );
  const body = {
    entity_id: invoiceId,
    entity_type: 'invoice',
    ewaybill_number: digits,
    action: 'manually_generated',
    ...(date ? { ewaybill_date: date } : {}),
    ...(invoice.branch_id ? { branch_id: String(invoice.branch_id) } : {}),
    ...(invoice.location_id ? { location_id: String(invoice.location_id) } : {}),
  };
  const draftId = await findDraftEwayBillId(accessToken, orgId, invoice);
  try {
    const payload = draftId
      ? await zohoJson(accessToken, orgId, `/ewaybills/${encodeURIComponent(draftId)}`, {
        method: 'PUT',
        query: { action: 'manually_generated' },
        body,
      })
      : await zohoJson(accessToken, orgId, '/ewaybills', {
        method: 'POST',
        body,
      });
    let record = ewayRecordFromPayload(payload) || payload?.ewaybill || null;
    const id = String(record?.ewaybill_id ?? draftId ?? '').trim();
    if (id) {
      const synced = await syncZohoEwayBillFromGstPortal(accessToken, orgId, id);
      if (synced && isActiveGeneratedRecord(synced)) return synced;
    }
    const attached = gstEwayBillNumber(recordEwayBillNumber(record)) || digits;
    if (record && (isActiveGeneratedRecord(record) || attached)) {
      return {
        ...record,
        ewaybill_number: attached,
        ewaybill_status: record.ewaybill_status || 'generated',
      };
    }
    return {
      ewaybill_id: id || undefined,
      ewaybill_number: digits,
      ewaybill_status: 'generated',
    };
  } catch (err) {
    console.warn(
      'Could not associate GST e-way bill on Zoho:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function firstGstEwayNumber(...sources) {
  for (const source of sources) {
    const fromRecord = gstEwayBillNumber(recordEwayBillNumber(source));
    if (fromRecord) return fromRecord;
    if (source && typeof source === 'object') {
      const fromList = collectEwayBillNumbers(source).map(gstEwayBillNumber).find(Boolean);
      if (fromList) return fromList;
    } else {
      const direct = gstEwayBillNumber(source);
      if (direct) return direct;
    }
  }
  return '';
}

export async function recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId) {
  try {
    const id = String(invoiceId ?? '').trim();
    if (!id) return null;

    let invoice = await fetchZohoInvoice(accessToken, orgId, id);
    if (!invoice) return null;

    const pick = (current, extra = null) => (
      pickActiveEwayBillForInvoice(accessToken, orgId, current, extra)
    );

    let found = await pick(invoice);
    if (found && gstEwayBillNumber(recordEwayBillNumber(found)) && found.ewaybill_id && !isDraftEwayRecord(found)) {
      return found;
    }

    if (invoiceHasIrn(invoice)) {
      const fetched = await fetchZohoEinvoiceFromIrp(accessToken, orgId, invoice);
      invoice = await fetchZohoInvoice(accessToken, orgId, id) || invoice;
      const einvoice = await fetchZohoEinvoice(accessToken, orgId, invoice);
      found = await pick(invoice, einvoice || fetched);
      const number = firstGstEwayNumber(found, einvoice, fetched, invoice);
      if (number) {
        const associated = await associateGstEwayBillOnZoho(
          accessToken,
          orgId,
          invoice,
          number,
          einvoice || fetched || found,
        );
        if (associated) return associated;
        return found || {
          ewaybill_number: number,
          ewaybill_status: 'generated',
        };
      }
      if (found) return found;
    }

    const draftId = await findDraftEwayBillId(accessToken, orgId, invoice);
    if (draftId) {
      const synced = await syncZohoEwayBillFromGstPortal(accessToken, orgId, draftId);
      if (synced && isActiveGeneratedRecord(synced)) return synced;
    }

    await sleep(800);
    const refreshed = await fetchZohoInvoice(accessToken, orgId, id);
    if (!refreshed) return null;
    found = await pick(refreshed);
    if (found) return found;
    const refreshedEinvoice = invoiceHasIrn(refreshed)
      ? await fetchZohoEinvoice(accessToken, orgId, refreshed)
      : null;
    return pick(refreshed, refreshedEinvoice);
  } catch {
    return null;
  }
}

async function recoverExistingOrThrow(accessToken, orgId, invoiceId, message) {
  if (isEwayRecoverableGenerateError(message)) {
    const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
    if (recovered) return recovered;
  }
  throw new Error(formatEwayBillPortalError(message));
}

/**
 * @param {string} accessToken
 * @param {string} orgId
 * @param {{
 *   invoiceId: string;
 *   transporterId: string;
 *   lrNumber?: string | null;
 *   distance?: number | null;
 *   shipFromAddress?: string | null;
 *   deliveryAddress?: string | null;
 *   dispatchFromAddressId?: string | null;
 *   shipFromSite?: string | null;
 *   vehicleNumber?: string | null;
 *   db?: import('firebase-admin/firestore').Firestore | null;
 * }} input
 */
export async function createZohoEwayBillForInvoice(accessToken, orgId, input) {
  const invoiceId = String(input.invoiceId ?? '').trim();
  if (!invoiceId) throw new Error('Invoice id is required.');

  const invoice = await fetchZohoInvoice(accessToken, orgId, invoiceId);
  if (!invoice) throw new Error('Invoice not found in Zoho.');

  const lr = String(input.lrNumber ?? '').trim();
  const shipFromAddress = String(input.shipFromAddress ?? '').trim();
  const deliveryAddress = String(input.deliveryAddress ?? '').trim();
  const vehicleNumber = String(input.vehicleNumber ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const hasIrn = invoiceHasIrn(invoice);
  const irnDispatchFromId = existingDispatchFromAddressId(invoice);

  let vehicleOrigin = null;
  if (vehicleNumber && shipFromAddress) {
    try {
      vehicleOrigin = ewayVehicleOriginFromAddress(shipFromAddress);
    } catch {
      vehicleOrigin = null;
    }
  }

  const vehicleFields = vehicleNumber
    ? {
      vehicle_number: vehicleNumber.slice(0, 20),
      vehicle_type: 'regular',
      ...(vehicleOrigin
        ? { from_place: vehicleOrigin.fromPlace, from_state: vehicleOrigin.fromState }
        : {}),
    }
    : {};

  let dispatchFromAddressId = String(input.dispatchFromAddressId ?? '').trim();
  if (hasIrn) {
    // IRN freezes dispatch-from. A new portal site address must not replace it.
    dispatchFromAddressId = irnDispatchFromId;
  } else if (!dispatchFromAddressId && shipFromAddress) {
    dispatchFromAddressId = await ensureZohoDispatchFromAddress(
      accessToken,
      orgId,
      zohoJson,
      shipFromAddress,
      {
        db: input.db ?? null,
        shipFromSite: input.shipFromSite ?? null,
      },
    );
  }

  const distance = resolveEwayDistanceKm({
    explicitDistance: input.distance,
  });
  const shipToAddressId = invoice.shipping_address?.address_id
    ?? invoice.shipping_address_id
    ?? null;

  const body = {
    entity_id: invoiceId,
    entity_type: 'invoice',
    action: 'save_generate',
    transportation_mode: 'road',
    transporter_id: String(input.transporterId),
    sub_supply_type: 'supply',
    transaction_type: 'regular',
    distance,
    transporter_document_date: todayIsoDate(),
    ...(invoice.branch_id ? { branch_id: String(invoice.branch_id) } : {}),
    ...(invoice.location_id ? { location_id: String(invoice.location_id) } : {}),
    ...(shipToAddressId ? { ship_to_address_id: String(shipToAddressId) } : {}),
    ...(dispatchFromAddressId ? { dispatch_from_address_id: dispatchFromAddressId } : {}),
    ...(lr ? { transporter_document_number: lr.slice(0, 30) } : {}),
    ...vehicleFields,
  };

  const einvoiceEwayBody = (distanceValue) => ({
    transporter_id: String(input.transporterId),
    transportation_mode: 'road',
    sub_supply_type: 'supply',
    transaction_type: 'regular',
    distance: distanceValue,
    transporter_document_date: todayIsoDate(),
    ...(lr ? { transporter_document_number: lr.slice(0, 30) } : {}),
    ...vehicleFields,
  });

  const draftGenerateBody = (distanceValue) => ({
    transportation_mode: 'road',
    transporter_id: String(input.transporterId),
    sub_supply_type: 'supply',
    transaction_type: 'regular',
    distance: distanceValue,
    transporter_document_date: todayIsoDate(),
    action: 'save_generate',
    ...(lr ? { transporter_document_number: lr.slice(0, 30) } : {}),
    ...vehicleFields,
  });

  const usableEwayRecord = (record) => {
    if (!record || typeof record !== 'object') return null;
    if (isDraftEwayRecord(record)) return null;
    return isActiveGeneratedRecord(record) ? record : null;
  };

  const putSaveGenerate = async (draftId, distanceValue) => {
    const updated = await zohoJson(
      accessToken,
      orgId,
      `/ewaybills/${encodeURIComponent(draftId)}`,
      {
        method: 'PUT',
        query: { action: 'save_generate' },
        body: draftGenerateBody(distanceValue),
      },
    );
    return usableEwayRecord(updated?.ewaybill ?? updated);
  };

  const trySaveGenerateDraft = async (draftId, distanceValue) => {
    const id = String(draftId ?? '').trim();
    if (!id) return null;
    try {
      const generated = await putSaveGenerate(id, distanceValue);
      if (generated) return generated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isEwayAlreadyGeneratedError(message)) {
        const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
        if (recovered) return recovered;
        throw err;
      }
      if (isEwayRecoverableGenerateError(message)) {
        const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
        if (recovered) return recovered;
      } else {
        throw err;
      }
    }
    return null;
  };

  const postEway = async (distanceValue) => {
    const payloadBody = { ...body, distance: distanceValue };
    let draftId = await findDraftEwayBillId(accessToken, orgId, invoice);

    if (hasIrn) {
      let fromEinvoice = null;
      try {
        fromEinvoice = await createEwayBillFromEinvoice(
          accessToken,
          orgId,
          invoice,
          einvoiceEwayBody(distanceValue),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isEwayAlreadyGeneratedError(message)) {
          const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
          if (recovered && isActiveGeneratedRecord(recovered)) return recovered;
          throw err;
        }
        throw err;
      }
      const usable = usableEwayRecord(fromEinvoice) || usableEwayRecord(ewayRecordFromPayload(fromEinvoice));
      if (usable) return usable;
      if (fromEinvoice && isDraftEwayRecord(fromEinvoice)) {
        const draftFromEinvoice = String(
          fromEinvoice.ewaybill_id ?? fromEinvoice.eway_bill_id ?? '',
        ).trim();
        if (draftFromEinvoice) {
          draftId = draftId || draftFromEinvoice;
          const generated = await trySaveGenerateDraft(draftFromEinvoice, distanceValue);
          if (generated) return generated;
        }
      }
      const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
      if (recovered && isActiveGeneratedRecord(recovered)) return recovered;
      // Fall through to draft save_generate / POST /ewaybills (same path Zoho UI uses).
    }

    if (draftId) {
      const synced = await syncZohoEwayBillFromGstPortal(accessToken, orgId, draftId);
      const usableSynced = usableEwayRecord(synced);
      if (usableSynced) return usableSynced;
      const generated = await trySaveGenerateDraft(draftId, distanceValue);
      if (generated) return generated;
    }

    try {
      const payload = await zohoJson(accessToken, orgId, '/ewaybills', {
        method: 'POST',
        body: payloadBody,
      });
      const created = usableEwayRecord(payload?.ewaybill ?? payload);
      if (created) return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (draftId && /already exists|already created|already generated/i.test(message)) {
        try {
          const generated = await putSaveGenerate(draftId, distanceValue);
          if (generated) return generated;
        } catch {
          // fall through
        }
        const synced = await syncZohoEwayBillFromGstPortal(accessToken, orgId, draftId);
        const usableSynced = usableEwayRecord(synced);
        if (usableSynced) return usableSynced;
      }
      throw err;
    }
    return null;
  };

  try {
    return await postEway(distance);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isGstDistanceMismatchError(message) && distance !== 0) {
      try {
        return await postEway(0);
      } catch (retryErr) {
        return recoverExistingOrThrow(
          accessToken,
          orgId,
          invoiceId,
          retryErr instanceof Error ? retryErr.message : String(retryErr),
        );
      }
    }
    if (isIrnDispatchLockedError(message) && body.dispatch_from_address_id) {
      const { dispatch_from_address_id: _ignored, ...withoutDispatch } = body;
      try {
        const retried = await zohoJson(accessToken, orgId, '/ewaybills', {
          method: 'POST',
          body: withoutDispatch,
        });
        return retried?.ewaybill ?? null;
      } catch (retryErr) {
        return recoverExistingOrThrow(
          accessToken,
          orgId,
          invoiceId,
          retryErr instanceof Error ? retryErr.message : String(retryErr),
        );
      }
    }
    if (
      isZohoNotAuthorizedError(message)
      && (body.location_id || body.branch_id || body.dispatch_from_address_id)
    ) {
      const {
        location_id: _locationId,
        branch_id: _branchId,
        dispatch_from_address_id: _dispatchId,
        ...stripped
      } = body;
      try {
        const retried = await zohoJson(accessToken, orgId, '/ewaybills', {
          method: 'POST',
          body: stripped,
        });
        return retried?.ewaybill ?? null;
      } catch (retryErr) {
        return recoverExistingOrThrow(
          accessToken,
          orgId,
          invoiceId,
          retryErr instanceof Error ? retryErr.message : String(retryErr),
        );
      }
    }
    return recoverExistingOrThrow(accessToken, orgId, invoiceId, message);
  }
}

async function createEwayBillFromEinvoice(accessToken, orgId, invoice, body) {
  const invoiceId = String(invoice.invoice_id ?? '').trim();
  const einvoiceId = String(
    invoice.einvoice_id
    ?? invoice.einvoice_details?.einvoice_id
    ?? '',
  ).trim();
  const paths = [];
  if (invoiceId) {
    paths.push(`/invoices/${encodeURIComponent(invoiceId)}/einvoice/ewaybill`);
  }
  if (einvoiceId) {
    paths.push(`/einvoices/${encodeURIComponent(einvoiceId)}/ewaybill`);
  }

  let lastError = null;
  let draftRecord = null;
  for (const path of paths) {
    try {
      const payload = await zohoJson(accessToken, orgId, path, { method: 'POST', body });
      const record = payload?.ewaybill ?? ewayRecordFromPayload(payload);
      if (record && isDraftEwayRecord(record)) {
        draftRecord = record;
        continue;
      }
      if (record && isActiveGeneratedRecord(record)) return record;
      if (recordEwayBillNumber(record)) return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err;
      if (isMissingZohoEndpointError(message)) continue;
      if (isEwayAlreadyGeneratedError(message)) {
        try {
          const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
          if (recovered && isActiveGeneratedRecord(recovered)) return recovered;
        } catch {
          // keep looking
        }
        const einvoice = await fetchZohoEinvoice(accessToken, orgId, invoice);
        const record = ewayRecordFromPayload(einvoice);
        if (record && isActiveGeneratedRecord(record)) return record;
        throw err;
      }
      if (isEwayRecoverableGenerateError(message)) {
        try {
          const recovered = await recoverExistingEwayBillForInvoice(accessToken, orgId, invoiceId);
          if (recovered && isActiveGeneratedRecord(recovered)) return recovered;
        } catch {
          // keep looking
        }
        const einvoice = await fetchZohoEinvoice(accessToken, orgId, invoice);
        const record = ewayRecordFromPayload(einvoice);
        if (record && isActiveGeneratedRecord(record)) return record;
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (draftRecord) return draftRecord;
  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (isEwayAlreadyGeneratedError(message)) throw lastError;
    if (!isMissingZohoEndpointError(message) && !isEwayRecoverableGenerateError(message)) {
      throw lastError;
    }
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string} orgId
 * @param {string} ewaybillId
 */
export async function fetchZohoEwayBillPdf(accessToken, orgId, ewaybillId) {
  const id = String(ewaybillId ?? '').trim();
  if (!id) throw new Error('E-way bill id is required.');

  const url = new URL(`${ZOHO_API_BASE}/ewaybills/${encodeURIComponent(id)}`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('print', 'true');

  const res = await fetch(url.toString(), {
    headers: {
      ...authHeaders(accessToken, orgId),
      Accept: 'application/pdf,application/json,text/html,*/*',
    },
  });
  await recordZohoApiResponse(res.status, `/ewaybills/${id}?print=true`);

  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const classified = classifyZohoHttpError(res.status, payload);
    throw new Error(formatZohoApiError(payload, classified?.message || `Could not download e-way bill (${res.status}).`));
  }

  const contentType = String(res.headers.get('content-type') ?? '').toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('E-way bill file is empty.');

  if (contentType.includes('json') || buffer.slice(0, 1).toString() === '{') {
    try {
      const json = JSON.parse(buffer.toString('utf8'));
      if (json && typeof json === 'object' && (json.code !== undefined && json.code !== 0 || json.message)) {
        if (json.code !== undefined && json.code !== 0) {
          throw new Error(formatZohoApiError(json, 'Could not download e-way bill.'));
        }
        const html = json?.print_html || json?.html || json?.data;
        if (typeof html === 'string' && html.trim()) {
          return { buffer: Buffer.from(html, 'utf8'), mimeType: 'text/html', extension: 'html' };
        }
      }
    } catch (err) {
      if (err instanceof Error && /printed \/ downloaded|synced e-way|could not download/i.test(err.message)) {
        throw err;
      }
    }
  }

  if (contentType.includes('pdf') || buffer.slice(0, 4).toString() === '%PDF') {
    return { buffer, mimeType: 'application/pdf', extension: 'pdf' };
  }

  const text = buffer.toString('utf8');
  try {
    const json = JSON.parse(text);
    const html = json?.print_html || json?.html || json?.data;
    if (typeof html === 'string' && html.trim()) {
      return { buffer: Buffer.from(html, 'utf8'), mimeType: 'text/html', extension: 'html' };
    }
  } catch {
    // fall through
  }

  if (text.includes('<html')) {
    return { buffer, mimeType: 'text/html', extension: 'html' };
  }

  throw new Error('Unexpected e-way bill print response from Zoho.');
}

export function mapZohoEwayBillRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = recordEwayBillNumber(raw);
  let status = normalizeMappedEwayStatus(raw.ewaybill_status ?? raw.eway_bill_status ?? raw.status);
  if (number && (status === 'missing' || !status)) status = 'generated';
  return {
    zohoEwaybillId: raw.ewaybill_id ? String(raw.ewaybill_id) : (raw.eway_bill_id ? String(raw.eway_bill_id) : null),
    ewaybillNumber: number || null,
    status,
    generatedAt: raw.ewaybill_date ? String(raw.ewaybill_date) : null,
    expiryDate: raw.ewaybill_expiry_date ? String(raw.ewaybill_expiry_date) : null,
    transporterGstin: normalizeGstin(raw.transporter_registration_id) || null,
    pdfPrintAllowed: raw.can_allow_print_ewaybill === true,
  };
}

export { normalizeGstin };

/**
 * Add or update Part B vehicle details on a generated e-way bill.
 * @param {string} accessToken
 * @param {string} orgId
 * @param {string} ewaybillId
 * @param {{
 *   vehicleNumber: string;
 *   fromPlace: string;
 *   fromState: string;
 *   reason?: string;
 *   remarks?: string;
 *   vehicleId?: string | null;
 * }} input
 */
export async function addZohoEwayBillVehicle(accessToken, orgId, ewaybillId, input) {
  const id = String(ewaybillId ?? '').trim();
  if (!id) throw new Error('E-way bill id is required.');

  const vehicleNumber = String(input.vehicleNumber ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!vehicleNumber) throw new Error('Vehicle number is required for e-way bill Part B.');

  const fromPlace = String(input.fromPlace ?? '').trim().slice(0, 50);
  const fromState = String(input.fromState ?? '').trim();
  if (!fromPlace || !fromState) {
    throw new Error('Dispatch place and state are required to update e-way bill Part B.');
  }

  const reason = String(input.reason ?? 'first_time').trim() || 'first_time';
  const allowedReasons = new Set(['due_to_break_down', 'due_to_transhipment', 'first_time', 'others']);
  if (!allowedReasons.has(reason)) {
    throw new Error('Invalid reason for vehicle update.');
  }

  const body = {
    vehicle_number: vehicleNumber.slice(0, 20),
    vehicle_type: 'regular',
    transportation_mode: 'road',
    from_place: fromPlace,
    from_state: fromState,
    reason,
    remarks: String(input.remarks ?? 'Customer pickup').trim().slice(0, 50) || 'Customer pickup',
  };

  const vehicleId = String(input.vehicleId ?? '').trim();
  try {
    if (vehicleId) {
      body.vehicle_id = vehicleId;
      const payload = await zohoJson(
        accessToken,
        orgId,
        `/ewaybills/${encodeURIComponent(id)}/vehicles/${encodeURIComponent(vehicleId)}`,
        { method: 'PUT', body },
      );
      return payload?.vehicle_details ?? payload?.ewaybill ?? payload;
    }

    const payload = await zohoJson(
      accessToken,
      orgId,
      `/ewaybills/${encodeURIComponent(id)}/vehicles`,
      { method: 'POST', body },
    );
    return payload?.vehicle_details ?? payload?.ewaybill ?? payload;
  } catch (err) {
    throw new Error(formatEwayBillPortalError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Cancel a generated e-way bill on the GST portal via Zoho.
 * @param {{ reason: string; remarks?: string | null }} input
 */
export async function cancelZohoEwayBill(accessToken, orgId, ewaybillId, input) {
  const id = String(ewaybillId ?? '').trim();
  if (!id) throw new Error('E-way bill id is required.');

  const reason = String(input?.reason ?? '').trim();
  const allowed = new Set(['duplicate', 'order_cancelled', 'data_entry_mistake', 'others']);
  if (!allowed.has(reason)) {
    throw new Error('Select a valid cancellation reason.');
  }

  const remarks = String(input?.remarks ?? '').trim().slice(0, 50);
  const body = {
    reason,
    ...(remarks ? { remarks } : {}),
  };

  const payload = await zohoJson(
    accessToken,
    orgId,
    `/ewaybills/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body },
  );
  return payload?.ewaybill ?? payload;
}
