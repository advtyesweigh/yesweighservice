/**
 * Keep Delhivery registered pickup warehouse phone / GSTIN in sync.
 *
 * Shipper copy ("SHIPMENT PICKED FROM") reads these from the warehouse profile
 * (pickup_location_name), not from return_address / billing_address on manifest.
 *
 * PATCH {ltl}/client-warehouses/update
 */

import { getValidDelhiveryJwt, loadDelhiveryB2bPublicConfig, LOGISTICS_SETTINGS_DOC } from './delhivery-b2b.js';
import { delhiveryLtlBaseUrl } from './delhivery-freight.js';

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function phoneDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeGstin(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[0-9A-Z]{15}$/.test(text) ? text : null;
}

function pinFromText(value) {
  const match = /\b(\d{6})\b/.exec(String(value ?? ''));
  return match?.[1] || null;
}

/** Delhivery allows one GSTIN per client-warehouse. Same firm GST on a second site throws this. */
export function isDuplicateDelhiveryWarehouseGstError(message) {
  return /duplicate\s+gst\s+number/i.test(String(message || ''));
}

function warehouseErrorMessage(res, json, text) {
  const message = json?.error?.message
    || json?.message
    || (typeof text === 'string' ? text.slice(0, 300) : '')
    || `Warehouse update failed (${res.status})`;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/** Keep phone visible on LR print (Shipper Copy ignores warehouse phone_number field). */
function addressWithPhone(address, phone) {
  let text = String(address || '').replace(/\s+/g, ' ').trim();
  const digits = phoneDigits(phone);
  if (!text || !digits) return text;
  // Drop trailing bare +91 phones so we can normalize.
  text = text.replace(/(?:,\s*)?\+?91[- ]?\d{10}\s*$/i, '').trim();
  if (!text.replace(/\D/g, '').includes(digits)) {
    text = `${text}, Ph: ${digits}`;
  }
  return text;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} site
 */
export async function loadShipFromContactForSite(db, site) {
  const snap = await db.doc(LOGISTICS_SETTINGS_DOC).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const key = String(site || '').trim() || 'cochin';
  const address = nonEmpty(data.fromAddresses?.[key])
    || nonEmpty(data.fromAddresses?.cochin)
    || nonEmpty(data.fromAddresses?.head_office)
    || '';
  const contact = data.fromSiteContacts?.[key]
    || data.fromSiteContacts?.cochin
    || data.fromSiteContacts?.head_office
    || {};
  const phone = phoneDigits(contact.phone) || phoneDigits('8803333444');
  const gstin = normalizeGstin(contact.gstin) || normalizeGstin('32AAFCI1950F1ZZ');
  return {
    site: key,
    address: address.replace(/\s+/g, ' ').trim(),
    phone,
    gstin,
    pin: pinFromText(address) || '683503',
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   warehouseName: string,
 *   address: string,
 *   phone: string,
 *   gstin: string,
 *   city?: string,
 *   state?: string,
 *   pin?: string,
 * }} input
 */
export async function updateDelhiveryWarehouseContacts(db, input) {
  const warehouseName = nonEmpty(input.warehouseName);
  const address = nonEmpty(input.address);
  const phone = phoneDigits(input.phone);
  const gstin = normalizeGstin(input.gstin);
  if (!warehouseName) throw new Error('Delhivery warehouse name is required.');
  if (!address) throw new Error('Ship-from address is required to update Delhivery warehouse.');
  if (!phone) throw new Error('Ship-from phone is required to update Delhivery warehouse.');
  if (!gstin) throw new Error('Ship-from GSTIN is required to update Delhivery warehouse.');

  const pin = Number(String(input.pin || pinFromText(address) || '683503').replace(/\D/g, '').slice(0, 6));
  const printAddress = addressWithPhone(address, phone);
  const auth = await getValidDelhiveryJwt(db);
  const base = delhiveryLtlBaseUrl(auth.env);
  const pinCode = Number.isFinite(pin) ? pin : 683503;

  const buildBody = (includeGst) => ({
    cl_warehouse_name: warehouseName,
    update_dict: {
      ...(nonEmpty(input.city) ? { city: nonEmpty(input.city) } : {}),
      ...(nonEmpty(input.state) ? { state: nonEmpty(input.state) } : {}),
      country: 'India',
      address_details: {
        address: printAddress,
        contact_person: 'Interweighing',
        phone_number: phone,
        company: 'Interweighing Pvt Ltd',
        email: 'admin@yesweigh.in',
      },
      billing_details: {
        ...(includeGst ? { gst_number: gstin } : {}),
        legal_address: {
          same_as_physical_address: true,
          pin_code: pinCode,
        },
      },
    },
  });

  const patchWarehouse = async (includeGst) => {
    const res = await fetch(`${base}/client-warehouses/update`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.jwt}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(includeGst)),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    if (!res.ok || json?.success === false) {
      const message = warehouseErrorMessage(res, json, text);
      const error = new Error(message);
      error.duplicateGst = isDuplicateDelhiveryWarehouseGstError(message);
      throw error;
    }
    return json;
  };

  let json;
  let gstApplied = true;
  try {
    json = await patchWarehouse(true);
  } catch (err) {
    if (!err?.duplicateGst) throw err;
    // Firm GSTIN is already on another pickup (e.g. INTERWEIGHING B2B).
    // Phone/address still sync. Booking must continue so package photos save.
    console.warn(
      `Delhivery warehouse "${warehouseName}": GST ${gstin} already registered elsewhere. `
      + `Updating phone/address only. ${err.message}`,
    );
    gstApplied = false;
    try {
      json = await patchWarehouse(false);
    } catch (retryErr) {
      console.warn(
        `Delhivery warehouse "${warehouseName}": phone/address sync skipped after duplicate GST. `
        + `${retryErr?.message || retryErr}`,
      );
      return {
        ok: true,
        warehouseName,
        phone,
        gstin,
        gstApplied: false,
        env: auth.env,
        result: null,
      };
    }
  }
  return {
    ok: true,
    warehouseName,
    phone,
    gstin,
    gstApplied,
    env: auth.env,
    result: json?.data?.result || json?.data || null,
  };
}

/**
 * Sync site ship-from phone/GSTIN onto the Delhivery pickup warehouse used for booking.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} site
 * @param {string} [warehouseName]
 */
export async function syncDelhiveryWarehouseForSite(db, site, warehouseName) {
  const config = await loadDelhiveryB2bPublicConfig(db);
  const contact = await loadShipFromContactForSite(db, site);
  const name = nonEmpty(warehouseName)
    || nonEmpty(config.pickupLocationBySite?.[site])
    || nonEmpty(config.pickupLocationBySite?.cochin)
    || nonEmpty(config.pickupLocationBySite?.head_office);
  if (!name) {
    throw new Error('Delhivery pickup location name is not configured for this site.');
  }
  if (!contact.address) {
    throw new Error('Ship-from address is missing in Logistics Settings → Sites.');
  }
  return updateDelhiveryWarehouseContacts(db, {
    warehouseName: name,
    address: contact.address,
    phone: contact.phone,
    gstin: contact.gstin,
    pin: contact.pin,
    city: /cochin|kochi/i.test(contact.address) ? 'Cochin' : undefined,
    state: /kerala/i.test(contact.address) ? 'Kerala' : undefined,
  });
}
