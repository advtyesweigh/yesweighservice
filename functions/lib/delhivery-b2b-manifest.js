/**
 * Delhivery B2B shipment creation (manifest) per official docs:
 * https://one.delhivery.com/developer-portal/document/b2b/detail/shipment-creation
 *
 * POST multipart/form-data → {ltl}/manifest  (async job_id)
 * GET  {ltl}/manifest?job_id=…              → LR / AWB
 *
 * Hosts:
 *   staging:    https://ltl-clients-api-dev.delhivery.com
 *   production: https://ltl-clients-api.delhivery.com
 *
 * Freight: freight_mode = fod (FOD). BTC omits freight_mode — this client rejects FoP.
 * Goods payment_mode = prepaid.
 */

import { getValidDelhiveryJwt, loadDelhiveryB2bPublicConfig } from './delhivery-b2b.js';
import { delhiveryFreightModeForApi, delhiveryLtlBaseUrl } from './delhivery-freight.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ invoiceId?: string | null, zohoCustomerId?: string | null }} input
 * @returns {Promise<{ invoiceNumber: string | null, invoiceValueInr: number } | null>}
 */
export async function readMirroredInvoiceForDelhivery(db, input) {
  const invoiceId = nonEmpty(input.invoiceId);
  const customerId = nonEmpty(input.zohoCustomerId);
  if (!invoiceId || !customerId) return null;
  const snap = await db.doc(`zohoCustomers/${customerId}/invoices/${invoiceId}`).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    invoiceNumber: nonEmpty(data.invoiceNumber),
    invoiceValueInr: asNumber(data.total, 0),
  };
}

/**
 * Wait for invoice number + total from Firestore, then optional Zoho refresh.
 * Does not invent ₹1 for invoice shipments.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   invoiceNumber?: string | null,
 *   invoiceValueInr?: number | null,
 *   invoiceId?: string | null,
 *   zohoCustomerId?: string | null,
 * }} input
 * @param {{ syncInvoice?: (invoiceId: string) => Promise<unknown> }} [options]
 */
export async function resolveInvoiceFieldsForDelhiveryBook(db, input, options = {}) {
  let invoiceNumber = nonEmpty(input.invoiceNumber);
  let invoiceValueInr = asNumber(input.invoiceValueInr, 0);
  const invoiceId = nonEmpty(input.invoiceId);
  const zohoCustomerId = nonEmpty(input.zohoCustomerId);
  if (!invoiceNumber && !invoiceId) {
    return { invoiceNumber, invoiceValueInr };
  }

  const applyMirror = (mirror) => {
    if (!mirror) return;
    if (invoiceValueInr <= 0 && asNumber(mirror.invoiceValueInr, 0) > 0) {
      invoiceValueInr = asNumber(mirror.invoiceValueInr, 0);
    }
    if (!invoiceNumber && mirror.invoiceNumber) {
      invoiceNumber = mirror.invoiceNumber;
    }
  };

  if (invoiceValueInr <= 0 || !invoiceNumber) {
    applyMirror(await readMirroredInvoiceForDelhivery(db, { invoiceId, zohoCustomerId }));
  }

  if ((invoiceValueInr <= 0 || !invoiceNumber) && invoiceId && typeof options.syncInvoice === 'function') {
    try {
      await options.syncInvoice(invoiceId);
    } catch (err) {
      console.warn('Invoice refresh before Delhivery book failed:', err?.message ?? err);
    }
    applyMirror(await readMirroredInvoiceForDelhivery(db, { invoiceId, zohoCustomerId }));
  }

  return { invoiceNumber, invoiceValueInr };
}

/** Digits-only phone; prefer last 10 digits for Indian mobiles. */
function phoneDigits(value, fallback = '') {
  const primary = String(value ?? '').replace(/\D/g, '');
  if (primary.length >= 8) {
    return primary.length > 10 ? primary.slice(-10) : primary;
  }
  const secondary = String(fallback ?? '').replace(/\D/g, '');
  if (secondary.length >= 8) {
    return secondary.length > 10 ? secondary.slice(-10) : secondary;
  }
  return '';
}

function normalizeGstin(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[0-9A-Z]{15}$/.test(text) ? text : null;
}

/** Drop a GSTIN that was previously concatenated into a street line. */
function stripEmbeddedGstin(address) {
  return String(address || '')
    .replace(/,?\s*GSTIN:\s*[0-9A-Z]{15}\b/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Delhivery Shipper Copy leaves the labeled phone blank even when the API
 * field is set. Phone is embedded in the street. GSTIN stays in gst_number
 * only, and only when the ship-to itself has one.
 */
function addressWithContactPrintFields(address, phone) {
  let text = stripEmbeddedGstin(address);
  if (!text) return text;
  const phoneValue = phoneDigits(phone);
  if (phoneValue && !text.replace(/\D/g, '').includes(phoneValue)) {
    text = `${text}, Ph: ${phoneValue}`;
  }
  return text;
}

/**
 * App billing → optional Delhivery freight_mode.
 * FoP is not allowed for INTERWEIGHING B2B — omit for BTC.
 * @param {unknown} raw
 * @returns {'fod' | null}
 */
export function delhiveryFreightModeFromBilling(raw) {
  return delhiveryFreightModeForApi(raw);
}

/**
 * Build multipart fields for POST /manifest (LTL clients API).
 *
 * @param {{
 *   pickupLocationName: string,
 *   orderId: string,
 *   consignee: {
 *     name: string,
 *     phone: string,
 *     address: string,
 *     city?: string,
 *     state?: string,
 *     pincode: string,
 *     country?: string,
 *     email?: string,
 *     gstin?: string,
 *   },
 *   returnAddress?: {
 *     name?: string,
 *     phone?: string,
 *     address?: string,
 *     city?: string,
 *     state?: string,
 *     pincode?: string,
 *     country?: string,
 *   } | null,
 *   boxes: Array<{
 *     lengthCm?: number,
 *     widthCm?: number,
 *     heightCm?: number,
 *     weightKg?: number,
 *     quantity?: number,
 *   }>,
 *   invoiceId?: string | null,
 *   zohoCustomerId?: string | null,
 *   invoiceNumber?: string | null,
 *   invoiceValueInr?: number | null,
 *   invoiceDate?: string | null,
 *   productsDesc?: string | null,
 *   hsnCode?: string | null,
 *   sellerGstin?: string | null,
 *   paymentMode?: string | null,
 *   shippingMode?: string | null,
 *   freightBillingMode?: 'fod' | 'btc' | string | null,
 *   billingAddress?: {
 *     name?: string,
 *     company?: string,
 *     consignor?: string,
 *     address?: string,
 *     city?: string,
 *     state?: string,
 *     pin?: string,
 *     phone?: string,
 *     pan_number?: string,
 *     gst_number?: string,
 *   } | null,
 * }} input
 */
export function buildDelhiveryB2bManifestPayload(input) {
  const pickup = nonEmpty(input.pickupLocationName);
  if (!pickup) {
    throw new Error('Delhivery pickup location name is required (set it in Logistics Settings → Delhivery).');
  }
  const consignee = input.consignee || {};
  const name = nonEmpty(consignee.name);
  const phone = phoneDigits(consignee.phone);
  const address = nonEmpty(consignee.address);
  const pin = String(consignee.pincode || '').replace(/\D/g, '');
  if (!name || !phone || !address || pin.length !== 6) {
    throw new Error('Consignee name, phone, address, and 6-digit pincode are required.');
  }
  const boxes = Array.isArray(input.boxes) ? input.boxes : [];
  if (!boxes.length) {
    throw new Error('At least one box is required to book Delhivery.');
  }

  let totalWeightKg = 0;
  let boxCount = 0;
  /** @type {Array<Record<string, number>>} */
  const dimensions = [];
  for (const box of boxes) {
    const count = Math.max(1, Math.round(asNumber(box.quantity, 1)));
    // LTL /manifest dimensions schema: length, width, height, box_count (cm).
    const length = Math.max(1, Math.round(asNumber(box.lengthCm, 10)));
    const width = Math.max(1, Math.round(asNumber(box.widthCm, 10)));
    const height = Math.max(1, Math.round(asNumber(box.heightCm, 10)));
    const weightKg = Math.max(0.1, asNumber(box.weightKg, 1));
    totalWeightKg += weightKg * count;
    boxCount += count;
    dimensions.push({
      length,
      width,
      height,
      box_count: count,
    });
  }

  const weightG = Math.max(1, Math.round(totalWeightKg * 1000));
  const rawInvoiceValue = asNumber(input.invoiceValueInr, 0);
  const invoiceNumberRaw = nonEmpty(input.invoiceNumber);
  const hasInvoice = Boolean(invoiceNumberRaw || nonEmpty(input.invoiceId));
  const clubbedRows = Array.isArray(input.invoices)
    ? input.invoices.filter(row => row && (nonEmpty(row.invoiceNumber) || nonEmpty(row.invoiceId)))
    : [];
  if (!clubbedRows.length && hasInvoice && rawInvoiceValue <= 0) {
    throw new Error(
      'Invoice total (incl. GST) is not ready yet. Wait for the invoice to finish syncing, then create the Delhivery LR.',
    );
  }
  const invoiceValue = hasInvoice || clubbedRows.length
    ? rawInvoiceValue
    : Math.max(1, rawInvoiceValue || 1);
  const invoiceNumber = invoiceNumberRaw || String(input.orderId || 'INV');
  const productsDesc = nonEmpty(input.productsDesc) || 'Goods';
  const invoices = clubbedRows.length
    ? clubbedRows.map((row) => {
      const invNum = nonEmpty(row.invoiceNumber) || invoiceNumber;
      const invAmt = asNumber(row.invoiceValueInr, 0);
      if (invAmt <= 0) {
        throw new Error(
          `Invoice total (incl. GST) is not ready for ${invNum}. Wait for the invoice to finish syncing, then create the Delhivery LR.`,
        );
      }
      return {
        // Filled later via PUT /lrn/update/{lrn} once Zoho issues e-way bills.
        ewaybill: '',
        inv_num: invNum,
        inv_amt: invAmt,
        inv_qr_code: '',
      };
    })
    : [
      {
        // Filled later via PUT /lrn/update/{lrn} once Zoho issues e-way bills.
        ewaybill: '',
        inv_num: invoiceNumber,
        inv_amt: invoiceValue,
        inv_qr_code: '',
      },
    ];
  const freightMode = delhiveryFreightModeFromBilling(input.freightBillingMode);
  const freightBillingMode = String(input.freightBillingMode || '').trim().toLowerCase() === 'fod'
    ? 'fod'
    : 'btc';
  const orderId = String(input.orderId || `YW-${Date.now()}`);
  // Interweighing firm GSTIN — LTL requires PAN or GSTIN on billing_address for FoD/FoP.
  const DEFAULT_GSTIN = '32AAFCI1950F1ZZ';
  const sellerGstin = normalizeGstin(input.sellerGstin) || DEFAULT_GSTIN;
  const consigneeGstin = normalizeGstin(consignee.gstin);

  const dropoff_location = {
    consignee_name: name,
    address: addressWithContactPrintFields(address, phone),
    city: nonEmpty(consignee.city) || 'NA',
    state: nonEmpty(consignee.state) || 'NA',
    zip: pin,
    // Docs type this as INTEGER; portal stores it, but Shipper Copy phone field stays blank.
    phone: Number(phone) || phone,
    email: nonEmpty(consignee.email) || '',
    // Ship-to GST only. Blank / URP omits the field — never the customer billing GSTIN.
    ...(consigneeGstin ? { gst_number: consigneeGstin, consignee_gst: consigneeGstin } : {}),
  };

  // Keep shipment_details minimal — extra keys (waybills/master) break list parsing
  // when paired with wrong dimension field names.
  const shipment_details = [
    {
      order_id: orderId,
      box_count: boxCount,
      description: productsDesc,
      weight: weightG,
    },
  ];

  const ret = input.returnAddress || null;
  // Shipper/return phone must never fall back to consignee phone.
  const returnPhone = phoneDigits(ret?.phone);
  const return_address = ret && nonEmpty(ret.address)
    ? {
      name: nonEmpty(ret.name) || pickup,
      // Docs type return phone as INTEGER.
      phone: Number(returnPhone) || returnPhone,
      address: addressWithContactPrintFields(
        nonEmpty(ret.address),
        returnPhone,
      ),
      city: nonEmpty(ret.city) || 'NA',
      state: nonEmpty(ret.state) || 'NA',
      zip: String(ret.pincode || '').replace(/\D/g, '') || pin,
    }
    : undefined;
  if (return_address && !return_address.phone) {
    throw new Error('Ship-from phone is required for Delhivery return address (set it in Logistics Settings → Sites).');
  }

  // FoD/FoP both require billing_address with PAN or GSTIN.
  const billing = input.billingAddress || null;
  const billingPhone = phoneDigits(billing?.phone, return_address?.phone || '');
  const billingBase = billing && nonEmpty(billing.address)
    ? {
      name: nonEmpty(billing.name) || pickup,
      company: nonEmpty(billing.company) || nonEmpty(billing.name) || pickup,
      consignor: nonEmpty(billing.consignor) || nonEmpty(billing.company) || pickup,
      address: nonEmpty(billing.address),
      city: nonEmpty(billing.city) || 'NA',
      state: nonEmpty(billing.state) || 'NA',
      pin: String(billing.pin || '').replace(/\D/g, '') || (return_address?.zip || pin),
      phone: String(billingPhone || returnPhone || ''),
    }
    : (return_address
      ? {
        name: return_address.name,
        company: return_address.name,
        consignor: return_address.name,
        address: return_address.address,
        city: return_address.city,
        state: return_address.state,
        pin: return_address.zip,
        phone: String(returnPhone || ''),
      }
      : {
        name: pickup,
        company: pickup,
        consignor: pickup,
        address: 'Pickup warehouse',
        city: 'NA',
        state: 'NA',
        pin,
        phone: String(billingPhone || ''),
      });
  if (!billingBase.phone) {
    throw new Error('Shipper phone is required for Delhivery billing address (set it in Logistics Settings → Sites).');
  }
  // billing_address.phone is documented as String.
  billingBase.phone = String(billingBase.phone);

  const billing_address = {
    ...billingBase,
    gst_number: normalizeGstin(billing?.gst_number) || sellerGstin,
    ...(nonEmpty(billing?.pan_number) ? { pan_number: nonEmpty(billing.pan_number) } : {}),
  };

  return {
    pickup_location_name: pickup,
    payment_mode: 'prepaid',
    weight: weightG,
    dropoff_location,
    shipment_details,
    invoices,
    dimensions,
    // Only send for FOD. Explicit fop → DataError "FoP orders not allowed for this client".
    ...(freightMode ? { freight_mode: freightMode } : {}),
    fm_pickup: true,
    rov_insurance: false,
    billing_address,
    ...(return_address ? { return_address } : {}),
    // Kept for debugging / logs (not all sent as form keys).
    _meta: {
      orderId,
      boxCount,
      totalWeightKg,
      freightBillingMode,
    },
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Record<string, unknown>} payload from buildDelhiveryB2bManifestPayload
 */
function buildManifestFormData(payload) {
  const form = new FormData();
  form.append('pickup_location_name', String(payload.pickup_location_name));
  form.append('payment_mode', String(payload.payment_mode || 'prepaid'));
  form.append('weight', String(payload.weight));
  form.append('dropoff_location', JSON.stringify(payload.dropoff_location));
  form.append('shipment_details', JSON.stringify(payload.shipment_details));
  form.append('invoices', JSON.stringify(payload.invoices));
  if (payload.freight_mode) {
    form.append('freight_mode', String(payload.freight_mode));
  }
  form.append('fm_pickup', payload.fm_pickup === false ? 'False' : 'True');
  form.append('rov_insurance', payload.rov_insurance === true ? 'True' : 'False');
  if (Array.isArray(payload.dimensions) && payload.dimensions.length) {
    form.append('dimensions', JSON.stringify(payload.dimensions));
  }
  if (payload.return_address) {
    form.append('return_address', JSON.stringify(payload.return_address));
  }
  if (payload.billing_address) {
    form.append('billing_address', JSON.stringify(payload.billing_address));
  }
  return form;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Record<string, unknown>} payload from buildDelhiveryB2bManifestPayload
 */
async function postLtlManifest(db, payload) {
  const auth = await getValidDelhiveryJwt(db);
  const base = delhiveryLtlBaseUrl(auth.env);
  const url = `${base}/manifest`;

  async function send(jwt) {
    return fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
      // Rebuild each attempt — FormData body is single-use.
      body: buildManifestFormData(payload),
    });
  }

  let res = await send(auth.jwt);
  if (res.status === 401 || res.status === 403) {
    const fresh = await getValidDelhiveryJwt(db, { force: true });
    res = await send(fresh.jwt);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text, env: auth.env, url };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} jobId
 */
async function getLtlManifestJob(db, jobId) {
  const auth = await getValidDelhiveryJwt(db);
  const base = delhiveryLtlBaseUrl(auth.env);
  const url = new URL(`${base}/manifest`);
  url.searchParams.set('job_id', jobId);

  async function send(jwt) {
    return fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
    });
  }

  let res = await send(auth.jwt);
  if (res.status === 401 || res.status === 403) {
    const fresh = await getValidDelhiveryJwt(db, { force: true });
    res = await send(fresh.jwt);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function extractJobId(json) {
  if (!json || typeof json !== 'object') return '';
  const candidates = [
    json.job_id,
    json.jobId,
    json.request_id,
    json.data?.job_id,
    json.data?.jobId,
    json.data?.request_id,
    json.result?.job_id,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function extractLrn(json) {
  if (!json || typeof json !== 'object') return '';
  const candidates = [
    json.lrn,
    json.lrnum,
    json.lr_number,
    json.lrNumber,
    json.master_waybill,
    json.waybill,
    json.data?.lrn,
    json.data?.lrnum,
    json.data?.lr_number,
    json.data?.lrNumber,
    json.data?.lrn_number,
    json.result?.lrn,
    json.result?.lrnum,
    json.shipments?.[0]?.lrn,
    json.data?.shipments?.[0]?.lrn,
    json.data?.success?.[0]?.lrn,
    json.data?.success?.[0]?.lr_number,
    json.data?.result?.lrn,
  ];
  for (const value of candidates) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  const blob = JSON.stringify(json);
  const match = /\b(\d{9})\b/.exec(blob);
  return match?.[1] || '';
}

function extractErrorMessage(json, text, status) {
  const err = json?.error;
  const nested = err && typeof err === 'object'
    ? (err.message || err.msg || err.detail)
    : err;
  return String(
    nested
    || json?.message
    || json?.data?.message
    || text
    || `Delhivery manifest failed (${status})`,
  );
}

/**
 * Cancel a Delhivery B2B LR.
 * Docs: DELETE {ltl}/lrn/cancel/{lrn}
 * https://one.delhivery.com/developer-portal/document/b2b/detail/shipment-cancellation
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} lrn
 */
export async function cancelDelhiveryB2bShipment(db, lrn) {
  const id = String(lrn || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(id)) {
    throw new Error('A 9-digit Delhivery LRN is required to cancel.');
  }
  const config = await loadDelhiveryB2bPublicConfig(db);
  if (!config.passwordSet) {
    throw new Error('Delhivery B2B credentials are not configured.');
  }

  const auth = await getValidDelhiveryJwt(db);
  const base = delhiveryLtlBaseUrl(auth.env);
  const url = `${base}/lrn/cancel/${encodeURIComponent(id)}`;

  async function send(jwt) {
    return fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
    });
  }

  let res = await send(auth.jwt);
  if (res.status === 401 || res.status === 403) {
    const fresh = await getValidDelhiveryJwt(db, { force: true });
    res = await send(fresh.jwt);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || json?.success === false) {
    throw new Error(extractErrorMessage(json, text, res.status));
  }

  return {
    ok: true,
    lrn: id,
    env: auth.env,
    message: String(json?.data || json?.message || `Shipment ${id} cancelled.`),
    raw: json,
  };
}

function extractUpdateJobStatus(json) {
  const blob = json && typeof json === 'object' ? json : {};
  const data = blob.data && typeof blob.data === 'object' ? blob.data : {};
  const raw = String(
    blob.status
    || data.status
    || blob.state
    || data.state
    || blob.result
    || '',
  ).toLowerCase();
  if (blob.success === false || data.success === false) return 'fail';
  if (/fail|error|reject/.test(raw)) return 'fail';
  if (/pending|process|queue|running|in.?progress/.test(raw)) return 'pending';
  if (/success|done|complete|updated|ok/.test(raw)) return 'success';
  if (blob.success === true || data.success === true) return 'success';
  return 'pending';
}

/**
 * Patch invoice / e-way bill numbers on an existing Delhivery LR.
 * Docs: PUT {ltl}/lrn/update/{lrn} (async job_id)
 *       GET {ltl}/lrn/update/status?job_id=…
 * https://one.delhivery.com/developer-portal/document/b2b/detail/shipment-update
 *
 * Create-time /manifest always sends ewaybill: ''. This is how we fill it after
 * Zoho generates e-way bills (including clubbed LRs with several invoices).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} lrn
 * @param {Array<{ invoiceNumber: string, invoiceValueInr?: number, ewaybill?: string | null }>} invoices
 * @param {{ pollMs?: number, maxAttempts?: number }} [options]
 */
export async function updateDelhiveryB2bLrInvoices(db, lrn, invoices, options = {}) {
  const id = String(lrn || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(id)) {
    throw new Error('A 9-digit Delhivery LRN is required to update e-way bills.');
  }
  const rows = (Array.isArray(invoices) ? invoices : [])
    .map((row) => {
      const invNumber = nonEmpty(row?.invoiceNumber) || nonEmpty(row?.inv_number) || nonEmpty(row?.inv_num);
      if (!invNumber) return null;
      const amount = asNumber(row?.invoiceValueInr ?? row?.inv_amount ?? row?.inv_amt, 0);
      const ewaybill = nonEmpty(row?.ewaybill ?? row?.ewayBillNumber) || '';
      return {
        inv_number: invNumber,
        inv_num: invNumber,
        inv_amount: amount,
        inv_amt: amount,
        ewaybill,
        qr_code: '',
      };
    })
    .filter(Boolean);
  if (!rows.length) {
    throw new Error('At least one invoice is required to update the Delhivery LR.');
  }
  if (!rows.some(row => row.ewaybill)) {
    throw new Error('No e-way bill number to send to Delhivery.');
  }

  const config = await loadDelhiveryB2bPublicConfig(db);
  if (!config.passwordSet) {
    throw new Error('Delhivery B2B credentials are not configured.');
  }

  const auth = await getValidDelhiveryJwt(db);
  const base = delhiveryLtlBaseUrl(auth.env);
  const url = `${base}/lrn/update/${encodeURIComponent(id)}`;

  async function send(jwt) {
    const form = new FormData();
    form.append('invoices', JSON.stringify(rows));
    return fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
      body: form,
    });
  }

  let res = await send(auth.jwt);
  if (res.status === 401 || res.status === 403) {
    const fresh = await getValidDelhiveryJwt(db, { force: true });
    res = await send(fresh.jwt);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || json?.success === false) {
    throw new Error(extractErrorMessage(json, text, res.status));
  }

  const jobId = extractJobId(json);
  const immediate = extractUpdateJobStatus(json);
  if (!jobId || immediate === 'success') {
    return {
      ok: true,
      lrn: id,
      jobId: jobId || null,
      env: auth.env,
      invoices: rows.map(row => ({ inv_number: row.inv_number, ewaybill: row.ewaybill })),
      raw: json,
    };
  }

  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 2000;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 15;
  let lastJson = json;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollMs);
    const statusUrl = new URL(`${base}/lrn/update/status`);
    statusUrl.searchParams.set('job_id', jobId);
    const token = (await getValidDelhiveryJwt(db)).jwt;
    const polled = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    const polledText = await polled.text();
    try {
      lastJson = polledText ? JSON.parse(polledText) : null;
    } catch {
      lastJson = null;
    }
    const state = extractUpdateJobStatus(lastJson);
    if (state === 'success') {
      return {
        ok: true,
        lrn: id,
        jobId,
        env: auth.env,
        invoices: rows.map(row => ({ inv_number: row.inv_number, ewaybill: row.ewaybill })),
        raw: lastJson,
      };
    }
    if (state === 'fail' || (polled.ok === false && polled.status !== 404 && attempt >= 2)) {
      throw new Error(extractErrorMessage(lastJson, polledText, polled.status));
    }
  }

  throw new Error(
    `Delhivery LR update job ${jobId} did not finish in time. `
    + `Last response: ${JSON.stringify(lastJson)?.slice(0, 240) || '(empty)'}`,
  );
}

/**
 * Create a Delhivery B2B LR via LTL /manifest and poll for LR.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Parameters<typeof buildDelhiveryB2bManifestPayload>[0]} input
 * @param {{ pollMs?: number, maxAttempts?: number }} [options]
 */
export async function bookDelhiveryB2bShipment(db, input, options = {}) {
  const config = await loadDelhiveryB2bPublicConfig(db);
  if (!config.passwordSet) {
    throw new Error('Delhivery B2B credentials are not configured.');
  }

  const payload = buildDelhiveryB2bManifestPayload(input);
  const created = await postLtlManifest(db, payload);

  if (!created.ok) {
    throw new Error(extractErrorMessage(created.json, created.text, created.status));
  }

  let lrn = extractLrn(created.json);
  let jobId = extractJobId(created.json);
  if (lrn) {
    return {
      ok: true,
      lrn,
      jobId: jobId || null,
      env: created.env,
      raw: created.json,
      payload,
    };
  }

  if (!jobId) {
    throw new Error(
      'Delhivery accepted the request but returned no LR number or job id. '
      + `Response: ${created.text?.slice(0, 240) || '(empty)'}`,
    );
  }

  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 2000;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 20;
  let lastJson = created.json;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollMs);
    const polled = await getLtlManifestJob(db, jobId);
    lastJson = polled.json;
    if (!polled.ok) {
      const message = extractErrorMessage(polled.json, polled.text, polled.status);
      if (/invalid job|not ready|processing|pending/i.test(message) && attempt < 5) continue;
      throw new Error(message);
    }
    lrn = extractLrn(polled.json);
    if (lrn) {
      return {
        ok: true,
        lrn,
        jobId,
        env: created.env,
        raw: polled.json,
        payload,
      };
    }
    const statusText = String(
      polled.json?.status
      || polled.json?.data?.status
      || polled.json?.state
      || polled.json?.data?.state
      || '',
    ).toLowerCase();
    if (statusText.includes('fail') || statusText.includes('error')) {
      throw new Error(extractErrorMessage(polled.json, polled.text, polled.status));
    }
  }

  throw new Error(
    `Delhivery job ${jobId} did not return an LR in time. `
    + `Last response: ${JSON.stringify(lastJson)?.slice(0, 240) || '(empty)'}`,
  );
}

/**
 * Resolve configured pickup location name for a logistics site.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} site
 */
export async function resolveDelhiveryPickupLocationName(db, site) {
  const config = await loadDelhiveryB2bPublicConfig(db);
  const key = site === 'cochin' ? 'cochin' : 'head_office';
  return config.pickupLocationBySite[key] || '';
}
