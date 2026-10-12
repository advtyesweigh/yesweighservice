/**
 * Structured billing address and ship-to GST fields for Zoho Books e-invoice / IRP.
 *
 * Zoho Books stores the street on billing_address.address (IRP "street name").
 * City, state, zip, and country are separate. A formatted line in `address`
 * with those fields empty still prints on the invoice, and IRP rejects it.
 * An address id alone does the same.
 *
 * Unregistered ship-to (no GSTIN) is GSTIN URP and needs shipping_legal_name.
 * A real ship-to GSTIN is shipping_gst_no — never replaced with URP.
 */
import { fitZohoAddressLines } from './zoho-contact-fields.js';
import { lookupPincodeLocation, normalizeStateName } from './location-utils.js';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Lakshadweep', 'Puducherry', 'Ladakh',
].sort((a, b) => b.length - a.length);

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Turn multiline Zoho address text into a comma-separated line before splitting. */
function flatten(value) {
  return String(value ?? '')
    .replace(/\s*\n\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return text(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeShipGstin(value) {
  const gstin = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!gstin || gstin === 'URP') return '';
  return GSTIN_RE.test(gstin) ? gstin : '';
}

function pinCode(value) {
  const match = String(value ?? '').match(/\b(\d{6})\b/);
  return match ? match[1] : '';
}

function countryName(value) {
  const country = text(value);
  if (!country) return '';
  if (/^in(dia)?$/i.test(country)) return 'India';
  return country;
}

function findState(value) {
  const haystack = compact(value);
  if (!haystack) return '';
  for (const state of INDIAN_STATES) {
    if (haystack.includes(compact(state))) return state;
  }
  return '';
}

function splitParts(value) {
  return String(value ?? '')
    .split(/[,\n]+/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stripTokens(part, tokens) {
  let next = ` ${text(part)} `;
  const ordered = tokens.filter(Boolean).sort((a, b) => b.length - a.length);
  for (const token of ordered) {
    next = next.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'ig'), ' ');
  }
  return next
    .replace(/\b\d{6}\b/g, ' ')
    .replace(/\bphone\b\s*:?/ig, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[, ]+|[, ]+$/g, '')
    .trim();
}

function streetFromParts(parts, { attention, city, state, country, phone }) {
  const kept = [];
  for (const part of parts) {
    if (/^phone\b/i.test(part)) continue;
    const stripped = stripTokens(part, [state, city, country, 'India', attention, phone]);
    if (!stripped) continue;
    if (city && compact(stripped) === compact(city)) continue;
    if (state && compact(stripped) === compact(state)) continue;
    if (attention && compact(stripped) === compact(attention)) continue;
    if (compact(stripped) === 'india') continue;
    kept.push(stripped);
  }
  return kept.join(', ');
}

/**
 * True when IRP's billing street, city, state, zip, and country are all present.
 * A formatted blob sitting only in `address` is not ready.
 */
export function billingAddressIsIrpReady(addr) {
  if (!addr || typeof addr !== 'object') return false;
  const street = text(addr.address || addr.street);
  const city = text(addr.city);
  const state = text(addr.state);
  const zip = pinCode(addr.zip);
  const country = countryName(addr.country);
  return Boolean(street && city && state && zip && country);
}

function addressScore(addr) {
  if (!addr || typeof addr !== 'object') return 0;
  let score = 0;
  if (text(addr.address || addr.street)) score += 1;
  if (text(addr.city)) score += 2;
  if (text(addr.state)) score += 2;
  if (pinCode(addr.zip)) score += 2;
  if (countryName(addr.country)) score += 1;
  return score;
}

/** Prefer the bill-to that already has structured fields. Keep the transaction phone. */
export function preferBillingRaw(transaction, contact) {
  const tx = transaction && typeof transaction === 'object' ? transaction : null;
  const ct = contact && typeof contact === 'object' ? contact : null;
  if (!tx && !ct) return null;
  if (!tx) return { ...ct };
  if (!ct) return { ...tx };
  const best = addressScore(ct) > addressScore(tx) ? { ...ct } : { ...tx };
  const phone = text(tx.phone) || text(ct.phone);
  const attention = text(best.attention) || text(tx.attention) || text(ct.attention);
  return {
    ...best,
    ...(phone ? { phone } : {}),
    ...(attention ? { attention } : {}),
  };
}

function pinCity(loc) {
  return text(loc?.city) || text(loc?.district);
}

/**
 * Split a bill-to into Zoho billing_address fields.
 * Does not replace a complete structured address.
 * Fills city/state from the formatted line, then from `pinLocation` when still missing.
 * Does not invent a street.
 * @param {object|null|undefined} raw
 * @param {{ city?: string, district?: string, state?: string }|null} [pinLocation]
 */
export function structureBillingAddress(raw, pinLocation = null) {
  if (!raw || typeof raw !== 'object') return null;
  const phone = text(raw.phone);
  const attention = text(raw.attention);
  const street2 = flatten(raw.street2);
  let street = flatten(raw.address || raw.street);
  let city = text(raw.city);
  let state = normalizeStateName(raw.state) || text(raw.state);
  let zip = pinCode(raw.zip) || pinCode(street) || pinCode(street2);
  let country = countryName(raw.country);

  if (billingAddressIsIrpReady({
    address: street,
    city,
    state,
    zip,
    country,
  })) {
    return fitZohoAddressLines({
      attention,
      address: street,
      street2,
      city,
      state,
      zip,
      country,
      phone,
    });
  }

  const blob = [street, street2, city, state, zip, country].filter(Boolean).join(', ');
  if (!zip) zip = pinCode(blob);
  if (!state) state = findState(blob);
  if (state) state = normalizeStateName(state) || state;
  if (!country && (/\bindia\b/i.test(blob) || street || zip || city || state)) country = 'India';

  const streetHoldsRest = Boolean(
    street
    && (
      (zip && street.includes(zip))
      || (state && compact(street).includes(compact(state)))
      || /\bindia\b/i.test(street)
    ),
  );

  if (!city && state) {
    const parts = splitParts(blob);
    const stateIdx = parts.findIndex(part => compact(part).includes(compact(state)));
    if (stateIdx > 0) {
      const candidate = stripTokens(parts[stateIdx - 1], [state, 'India', attention, phone, country]);
      if (candidate && compact(candidate) !== compact(attention)) city = candidate;
    }
  }
  if (!city) city = pinCity(pinLocation);
  if (!state && pinLocation?.state) state = normalizeStateName(pinLocation.state) || text(pinLocation.state);
  if (!country && (street || city || state || zip)) country = 'India';

  if (streetHoldsRest) {
    const parts = splitParts([street, street2].filter(Boolean).join(', '));
    const parsed = streetFromParts(parts, { attention, city, state, country, phone });
    street = parsed;
  }

  if (!street) return null;

  return fitZohoAddressLines({
    attention,
    address: street,
    street2: streetHoldsRest ? '' : street2,
    city,
    state,
    zip,
    country: country || 'India',
    phone,
  });
}

function locationsMatch(shipping, billing) {
  if (!shipping || !billing) return false;
  const shipZip = pinCode(shipping.zip) || pinCode(shipping.address);
  const billZip = pinCode(billing.zip) || pinCode(billing.address);
  const shipStreet = compact(shipping.address || shipping.street);
  const billStreet = compact(billing.address || billing.street);
  if (!shipZip || !billZip || shipZip !== billZip) return false;
  if (shipStreet && billStreet && shipStreet === billStreet) return true;
  const shipAtt = compact(shipping.attention);
  const billAtt = compact(billing.attention);
  return Boolean(shipAtt && billAtt && shipAtt === billAtt);
}

/**
 * Invoice-level ship-to GST. Real GSTIN wins. Blank / URP gets the
 * recipient legal name from attention so Business Legal Name is not empty.
 * Same-address ship-to is left alone unless Zoho already marked it URP.
 */
export function shippingRecipientGstFields(address, existing = {}, { billing = null } = {}) {
  const fromAddress = normalizeShipGstin(
    address?.gstin ?? address?.gst_no ?? address?.shipping_gst_no,
  );
  const fromExisting = normalizeShipGstin(existing?.shipping_gst_no);
  const gstin = fromAddress || fromExisting;
  if (gstin) return { shipping_gst_no: gstin };

  const existingUrp = text(existing?.shipping_gst_no).toUpperCase() === 'URP';
  const differs = !locationsMatch(address, billing);
  if (!differs && !existingUrp) return {};

  const legal = text(
    address?.attention
    || address?.recipient_name
    || address?.recipientName
    || existing?.shipping_legal_name,
  ).slice(0, 100);
  if (!legal) return {};
  return {
    shipping_gst_no: 'URP',
    shipping_legal_name: legal,
  };
}

export async function resolveStructuredBillingAddress(raw, pinLookup = lookupPincodeLocation) {
  const draft = structureBillingAddress(raw, null);
  if (!draft?.address) return null;
  if (draft.city && draft.state && draft.zip && draft.country) return draft;
  if (!draft.zip || (draft.city && draft.state)) return draft;
  let loc = null;
  try {
    loc = await pinLookup(draft.zip);
  } catch {
    loc = null;
  }
  if (!loc) return draft;
  return structureBillingAddress(raw, loc) || draft;
}
