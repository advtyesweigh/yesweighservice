/**
 * Non-GATC (dismantled) serials: warehouse picks unused serials from the
 * Settings → Serial numbers `non_gatc` pool. Invoice create/sync does not
 * auto-allot. Eligible: HSN 84238190 / 84238290 / 84231000 and not GATC-stamped.
 * Allot / unlink also PUT the Zoho invoice (line description).
 */
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  authHeaders,
  getAccessToken,
  hasZohoJsonBody,
  resolveOrganizationId,
  ZOHO_API_BASE,
} from './zoho.js';
import {
  serialsFromLineDescription,
} from './invoice-mappers.js';
import {
  assertCanMutateSerialsAfterDelivery,
  isMandatorySerialExemptLine,
  lineIsMandatorySerialCategory,
} from './mandatory-serials.js';

export const NON_GATC_SERIES = 'non_gatc';
export const GATC_50KG_SERIES = 'gatc_50kg';
export const GATC_SL_SERIES = 'gatc_sl';

/** Factory GATC stickers held for Interweighing. Used on 50 kg and other stamped lines. */
export const IWP_GATC_UNUSED_RANGES = [
  { from: 'Y10315', to: 'Y11000' },
  { from: 'YZ01420', to: 'YZ01500' },
];
export const NON_GATC_MACHINE_HSN = Object.freeze(['84238190', '84238290', '84231000']);
export const NON_GATC_ALLOCATIONS = 'nonGatcSerialAllocations';
export const SERIAL_NUMBER_ALLOTMENT_DOC = 'appSettings/serialNumberAllotment';

const MACHINE_HSN = new Set(NON_GATC_MACHINE_HSN);

function str(value) {
  return value == null ? '' : String(value).trim();
}

function hsnDigits(value) {
  return str(value).replace(/\D/g, '');
}

export function compactSerialKey(raw) {
  return str(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function compactProductToken(value) {
  return compactSerialKey(value);
}

export function isVoidInvoiceStatus(status) {
  const key = str(status).toLowerCase();
  return key === 'void' || key === 'cancelled' || key === 'canceled';
}

export function invoiceLineHasGatcTag(input) {
  if (Number(input?.gatcFeePerUnit) > 0) return true;
  if (str(input?.gatcStampingPriceId)) return true;
  const lower = str(input?.description).toLowerCase();
  if (!lower) return false;
  if (
    lower.includes('without stamping')
    || lower.includes('no stamping')
    || lower.includes('unstamped')
    || lower.includes('dismantled condition')
  ) {
    return false;
  }
  if (lower.includes('certified by gatc')) return true;
  if (lower.includes('verified, stamped')) return true;
  if (/\bwith\s+stamping\b/.test(lower)) return true;
  if (/stamping\s*:/.test(lower)) return true;
  return false;
}

export function isNonGatcSerialEligibleLine(line) {
  if (!line || typeof line !== 'object') return false;
  if (isMandatorySerialExemptLine(line)) return false;
  if (invoiceLineHasGatcTag(line)) return false;
  if (MACHINE_HSN.has(hsnDigits(line.hsn))) return true;
  return lineIsMandatorySerialCategory(line);
}

export function invoiceNeedsNonGatcSerials(lines) {
  return (Array.isArray(lines) ? lines : []).some(line => (
    isNonGatcSerialEligibleLine(line)
    && Math.max(0, Math.round(Number(line.quantity) || 0)) > (Array.isArray(line.serialNumbers) ? line.serialNumbers.length : 0)
  ));
}

function parseSerialToken(raw) {
  const token = str(raw);
  if (!token) return null;
  const match = /^(.*?)(\d+)$/.exec(token);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return { prefix: match[1], n, width: match[2].length };
}

function padNumeric(n, width) {
  const raw = String(n);
  return width > raw.length ? raw.padStart(width, '0') : raw;
}

function formatSerial(parsed, n) {
  return `${parsed.prefix}${padNumeric(n, parsed.width)}`;
}

const SERIAL_BLOCK_RE = /\n*Serial Numbers:\s*[^\n]*/gi;

function stripSerialBlockFromDescription(description) {
  return str(description).replace(SERIAL_BLOCK_RE, '').replace(/\s+$/g, '');
}

function withSerialBlockOnDescription(description, serials) {
  const base = stripSerialBlockFromDescription(description);
  const list = uniqueSerials(serials);
  if (!list.length) return base;
  const block = `Serial Numbers: ${list.join(', ')}`;
  return base ? `${base}\n${block}` : block;
}

export function applySerialsToLine(line, serials) {
  const serialNumbers = uniqueSerials(serials);
  return {
    ...line,
    serialNumbers,
    description: withSerialBlockOnDescription(line?.description, serialNumbers) || null,
  };
}

function uniqueSerials(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = str(value);
    const key = compactSerialKey(text);
    if (!text || !key || seen.has(key)) continue;
    if (key.length < 3 || key === 'NUMBERS' || key === 'NUMBER' || key === 'SERIALS') continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function serialsOnLine(line) {
  return uniqueSerials([
    ...(Array.isArray(line?.serialNumbers) ? line.serialNumbers : []),
    ...serialsFromLineDescription(line?.description),
  ]);
}

function lineSerialNeed(line) {
  const qty = Math.max(0, Math.round(Number(line?.quantity) || 0));
  return Math.max(0, qty - serialsOnLine(line).length);
}

export function mergePreservedLineSerials(nextLines, existingLines) {
  const prevList = Array.isArray(existingLines) ? existingLines : [];
  const prevById = new Map(prevList.map(line => [str(line?.id), line]));
  const prevByItem = new Map();
  for (const line of prevList) {
    const itemId = str(line?.itemId);
    if (!itemId) continue;
    const bucket = prevByItem.get(itemId) || [];
    bucket.push(line);
    prevByItem.set(itemId, bucket);
  }
  const usedPrev = new Set();
  return (Array.isArray(nextLines) ? nextLines : []).map(line => {
    let prev = prevById.get(str(line?.id));
    if (prev) {
      usedPrev.add(prev);
    } else {
      const bucket = prevByItem.get(str(line?.itemId)) || [];
      prev = bucket.find(item => !usedPrev.has(item) && serialsOnLine(item).length);
      if (prev) usedPrev.add(prev);
    }
    const merged = uniqueSerials([
      ...serialsOnLine(line),
      ...serialsOnLine(prev),
    ]);
    return merged.length ? applySerialsToLine(line, merged) : line;
  });
}

function attachSerialsToLine(line, serials) {
  return applySerialsToLine(line, uniqueSerials([...serialsOnLine(line), ...serials]));
}

function assignOrphanSerials(lines, orphans) {
  const next = Array.isArray(lines) ? [...lines] : [];
  const used = new Set(next.flatMap(line => serialsOnLine(line).map(compactSerialKey)));
  for (const orphan of orphans || []) {
    const serial = str(orphan?.serial);
    const key = compactSerialKey(serial);
    if (!serial || !key || used.has(key)) continue;
    const kind = orphan.kind === 'gatc' ? 'gatc' : 'nongatc';
    const lineId = str(orphan.lineId);
    const itemId = str(orphan.itemId);
    let idx = -1;
    if (lineId) {
      idx = next.findIndex(line => str(line.id) === lineId && lineSerialNeed(line) > 0);
    }
    if (idx < 0 && itemId) {
      idx = next.findIndex(line => str(line.itemId) === itemId && lineSerialNeed(line) > 0);
    }
    if (idx < 0) {
      idx = next.findIndex(line => (
        lineSerialNeed(line) > 0
        && (kind === 'gatc' ? invoiceLineHasGatcTag(line) : isNonGatcSerialEligibleLine(line))
      ));
    }
    if (idx < 0) {
      idx = next.findIndex(line => lineSerialNeed(line) > 0);
    }
    if (idx < 0) continue;
    next[idx] = attachSerialsToLine(next[idx], [serial]);
    used.add(key);
  }
  return next;
}

/**
 * Zoho sync can rewrite line ids / descriptions and drop serials from lines
 * while allocations still mark them taken. Put them back.
 */
export async function reattachPreservedSerialsToLines({
  lines,
  previousLines,
  invoiceId,
  invoiceNumber,
  nonGatcAllocatedSerials,
  gatcStampedAllocatedSerials,
  yesgatcLinks,
} = {}) {
  let next = mergePreservedLineSerials(lines, previousLines);
  const orphans = [];
  for (const serial of uniqueSerials(nonGatcAllocatedSerials)) {
    orphans.push({ serial, kind: 'nongatc' });
  }
  for (const serial of uniqueSerials(gatcStampedAllocatedSerials)) {
    orphans.push({ serial, kind: 'gatc' });
  }
  for (const link of Array.isArray(yesgatcLinks) ? yesgatcLinks : []) {
    if (str(link?.serialNumber)) {
      orphans.push({ serial: str(link.serialNumber), kind: 'gatc' });
    }
  }
  const iid = str(invoiceId);
  if (iid) {
    const db = getFirestore();
    try {
      const allocSnap = await db.collection(NON_GATC_ALLOCATIONS)
        .where('invoiceId', '==', iid)
        .get();
      allocSnap.forEach(doc => {
        const data = doc.data() || {};
        orphans.push({
          serial: str(data.serial) || doc.id,
          lineId: str(data.lineId),
          kind: 'nongatc',
        });
      });
    } catch (err) {
      console.warn(`reattach allocations ${iid}:`, err?.message ?? err);
    }
    try {
      const { gatcSerialsLinkedToInvoice } = await import('./yesgatc-stamped-serial-allot.js');
      const linked = await gatcSerialsLinkedToInvoice(db, {
        invoiceId: iid,
        invoiceNumber: str(invoiceNumber),
      });
      orphans.push(...linked);
    } catch (err) {
      console.warn(`reattach GATC serials ${iid}:`, err?.message ?? err);
    }
  }
  next = assignOrphanSerials(next, orphans);
  return next;
}

export async function healInvoiceSerialsOnDocument({ customerId, invoiceId } = {}) {
  const cid = str(customerId);
  const iid = str(invoiceId);
  if (!cid || !iid) throw new Error('Invoice is required.');
  const db = getFirestore();
  const invoiceRef = db.doc(`zohoCustomers/${cid}/invoices/${iid}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) throw new Error('Invoice not found.');
  const data = snap.data() || {};
  const previous = Array.isArray(data.lineItems) ? data.lineItems : [];
  const lineItems = await reattachPreservedSerialsToLines({
    lines: previous,
    previousLines: previous,
    invoiceId: iid,
    invoiceNumber: str(data.invoiceNumber),
    nonGatcAllocatedSerials: data.nonGatcAllocatedSerials,
    gatcStampedAllocatedSerials: data.gatcStampedAllocatedSerials,
    yesgatcLinks: data.yesgatcLinks,
  });
  const before = previous.map(line => `${str(line.id)}:${serialsOnLine(line).join(',')}`).join('|');
  const after = lineItems.map(line => `${str(line.id)}:${serialsOnLine(line).join(',')}`).join('|');
  const healed = before !== after;
  if (healed) {
    await invoiceRef.set({ lineItems }, { merge: true });
  }
  return { lineItems, healed };
}

function productTokens(value) {
  return [
    value?.productId,
    value?.itemId,
    value?.sku,
    value?.productName,
  ].map(compactProductToken).filter(Boolean);
}

function allotmentIsBound(row) {
  return productTokens(row).length > 0;
}

function allotmentSkuBound(row) {
  return [row?.productId, row?.itemId, row?.sku].some(token => compactProductToken(token));
}

function serialPrefix(serial) {
  const parsed = parseSerialToken(serial);
  return parsed ? parsed.prefix.toUpperCase() : '';
}

/** X01371-style stickers. Shared settings lots, not a product SKU bank. */
export function isXSeriesSerial(serial) {
  return serialPrefix(serial) === 'X';
}

function isSharedXStampingLot(row) {
  if (serialPrefix(row?.from) !== 'X' && serialPrefix(row?.to) !== 'X') return false;
  return !allotmentSkuBound(row);
}

function nameTokens(value) {
  return [value?.productName, value?.name]
    .map(compactProductToken)
    .filter(token => token.length >= 8);
}

function allotmentMatchesProduct(row, filter = {}) {
  const want = productTokens(filter);
  const have = productTokens(row);
  if (!want.length || !have.length) return false;
  if (want.some(token => have.includes(token))) return true;
  const wantNames = nameTokens(filter);
  const haveNames = nameTokens(row);
  return wantNames.some(left => haveNames.some(right => left.includes(right) || right.includes(left)));
}

export function productHasDedicatedAllotment(allotments, filter = {}, series = NON_GATC_SERIES) {
  const wanted = str(series);
  return (Array.isArray(allotments) ? allotments : []).some(row => (
    str(row?.series) === wanted
    && allotmentIsBound(row)
    && allotmentMatchesProduct(row, filter)
  ));
}

export function productHasDedicatedNonGatcAllotment(allotments, filter = {}) {
  return productHasDedicatedAllotment(allotments, filter, NON_GATC_SERIES);
}

function allotmentInPickerPool(row, filter = {}, dedicated = false, series = NON_GATC_SERIES) {
  if (str(row?.series) !== str(series)) return false;
  const bound = allotmentIsBound(row);
  if (dedicated) return bound && allotmentMatchesProduct(row, filter);
  return !bound;
}

export function seriesHasAllotments(allotments, series) {
  const wanted = str(series);
  return (Array.isArray(allotments) ? allotments : []).some(row => str(row?.series) === wanted);
}

function expandAllotmentRange(row) {
  const from = parseSerialToken(row?.from);
  const to = parseSerialToken(row?.to);
  if (!from || !to || from.prefix !== to.prefix || from.n > to.n) return [];
  const width = Math.max(from.width, to.width);
  const canonical = { ...from, width };
  const missing = new Set((Array.isArray(row.missing) ? row.missing : []).map(compactSerialKey));
  const out = [];
  for (let n = from.n; n <= to.n; n += 1) {
    const serial = formatSerial(canonical, n);
    if (missing.has(compactSerialKey(serial))) continue;
    out.push(serial);
  }
  return out;
}

function uniqueSerialPool(serials) {
  const seen = new Set();
  return serials.filter(serial => {
    const key = compactSerialKey(serial);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function expandSerialAllotmentPool(allotments, filter = {}, series = NON_GATC_SERIES) {
  const rows = Array.isArray(allotments) ? allotments : [];
  const dedicated = productHasDedicatedAllotment(rows, filter, series);
  const out = [];
  const seenRows = new Set();
  for (const row of rows) {
    if (!allotmentInPickerPool(row, filter, dedicated, series)) continue;
    seenRows.add(row);
    out.push(...expandAllotmentRange(row));
  }
  // Shared X lots have no SKU. A product's own preallotted range must not hide them.
  for (const row of rows) {
    if (seenRows.has(row) || !isSharedXStampingLot(row)) continue;
    out.push(...expandAllotmentRange(row));
  }
  return uniqueSerialPool(out);
}

export function productHasGatcPickerLots(allotments, filter = {}, series) {
  void series;
  return (Array.isArray(allotments) ? allotments : []).some(row => (
    allotmentIsBound(row)
    && allotmentMatchesProduct(row, filter)
  ));
}

/**
 * GATC invoice picker.
 * Product with its own lot (often saved as non_gatc from GR) → that range.
 * 50 kg and other stamped lines also get the factory Y / YZ sticker tank.
 */
export function expandGatcPickerPool(allotments, filter = {}, series) {
  const rows = Array.isArray(allotments) ? allotments : [];
  // A product's own lot is that scale's serials, including GR lots saved as non_gatc.
  // Series (50 kg vs SL) only splits the shared unbound sticker tank.
  const productLots = rows.filter(row => (
    allotmentIsBound(row)
    && allotmentMatchesProduct(row, filter)
  ));
  const source = productLots.length
    ? productLots
    : rows.filter(row => str(row?.series) === str(series) && !allotmentIsBound(row));
  const seenRows = new Set(source);
  const out = [];
  for (const row of source) {
    out.push(...expandAllotmentRange(row));
  }
  // X lots are often saved as non_gatc with no SKU. A product's own lot must not hide them.
  for (const row of rows) {
    if (seenRows.has(row) || !isSharedXStampingLot(row)) continue;
    out.push(...expandAllotmentRange(row));
  }
  for (const range of IWP_GATC_UNUSED_RANGES) {
    out.push(...expandAllotmentRange(range));
  }
  return uniqueSerialPool(out);
}

export function isIwpGatcUnusedSerial(serial) {
  const parsed = parseSerialToken(serial);
  if (!parsed) return false;
  return IWP_GATC_UNUSED_RANGES.some(range => {
    const from = parseSerialToken(range.from);
    const to = parseSerialToken(range.to);
    if (!from || !to || parsed.prefix !== from.prefix) return false;
    return parsed.n >= from.n && parsed.n <= to.n;
  });
}

function expandNonGatcPool(allotments, filter = {}) {
  return expandSerialAllotmentPool(allotments, filter, NON_GATC_SERIES);
}

function lineNeed(line) {
  const qty = Math.max(0, Math.round(Number(line?.quantity) || 0));
  const have = uniqueSerials(line?.serialNumbers).length;
  return Math.max(0, qty - have);
}

export async function listAvailableNonGatcSerials(maxOrOpts = 2000) {
  const opts = maxOrOpts && typeof maxOrOpts === 'object' ? maxOrOpts : { max: maxOrOpts };
  const productId = str(opts.productId || opts.itemId);
  const sku = str(opts.sku);
  const productName = str(opts.productName);
  const filter = { productId, sku, productName };
  const limit = Math.min(5000, Math.max(1, Number(opts.max) || 2000));
  const db = getFirestore();
  const allotSnap = await db.doc(SERIAL_NUMBER_ALLOTMENT_DOC).get();
  const allotments = allotSnap.exists ? allotSnap.data()?.allotments : [];
  const dedicated = productHasDedicatedNonGatcAllotment(allotments, filter);
  const { ensureSerialUnitsFromAllotments, listAvailableSerialUnits } = await import('./serial-units.js');
  if (dedicated) {
    await ensureSerialUnitsFromAllotments(allotments, filter);
  }
  const unitRows = await listAvailableSerialUnits({
    productId,
    sku,
    productName,
    max: limit,
    series: NON_GATC_SERIES,
    exclusiveBound: dedicated,
  });
  const taken = await loadTakenSerialKeys(db);
  const seen = new Set(unitRows.map(row => compactSerialKey(row.serialNumber || row.id)));
  const extra = [];
  for (const serial of expandNonGatcPool(allotments, filter)) {
    const key = compactSerialKey(serial);
    if (!key || seen.has(key) || taken.has(key)) continue;
    seen.add(key);
    extra.push({
      id: key,
      serialNumber: serial,
    });
  }
  const pinned = [];
  const rest = [];
  for (const row of [...unitRows, ...extra]) {
    if (isXSeriesSerial(row.serialNumber)) pinned.push(row);
    else rest.push(row);
  }
  return [...pinned, ...rest].slice(0, Math.max(limit, pinned.length));
}

async function loadTakenSerialKeys(db, exceptInvoiceId = '') {
  const taken = new Set();
  const snap = await db.collection(NON_GATC_ALLOCATIONS).get();
  snap.forEach(doc => {
    const data = doc.data() || {};
    if (exceptInvoiceId && str(data.invoiceId) === str(exceptInvoiceId)) return;
    taken.add(doc.id);
  });
  return taken;
}

async function releaseAllocationsForInvoice(db, invoiceId) {
  const snap = await db.collection(NON_GATC_ALLOCATIONS)
    .where('invoiceId', '==', str(invoiceId))
    .get();
  if (snap.empty) return [];
  const serials = [];
  const batch = db.batch();
  snap.forEach(doc => {
    serials.push(str(doc.data()?.serial) || doc.id);
    batch.delete(doc.ref);
  });
  await batch.commit();
  return serials;
}

/**
 * Release non-GATC pool serials and unlink GATC certificates for an invoice
 * that was voided, cancelled, or deleted in Zoho. Skips Zoho PUT so it still
 * works after the invoice is gone.
 */
export async function releaseInvoiceSerialLinks({
  customerId = '',
  invoiceId,
  invoiceNumber = '',
  data = {},
} = {}) {
  const db = getFirestore();
  const iid = str(invoiceId);
  let cid = str(customerId || data?.customerId);
  let invoiceData = data && typeof data === 'object' ? { ...data } : {};

  if (iid && !cid) {
    const indexSnap = await db.doc(`invoiceIndex/${iid}`).get();
    if (indexSnap.exists) cid = str(indexSnap.data()?.customerId);
  }
  if (iid && cid) {
    const snap = await db.doc(`zohoCustomers/${cid}/invoices/${iid}`).get();
    if (snap.exists) invoiceData = { ...snap.data(), ...invoiceData, id: iid, customerId: cid };
  }
  if (!str(invoiceData.invoiceNumber) && invoiceNumber) {
    invoiceData.invoiceNumber = str(invoiceNumber);
  }

  const released = iid ? await releaseAllocationsForInvoice(db, iid) : [];
  if (released.length) {
    try {
      const { markSerialUnitsInStock } = await import('./serial-units.js');
      await markSerialUnitsInStock(released);
    } catch (err) {
      console.warn(`serialUnits restock failed for ${iid}:`, err?.message ?? err);
    }
  }
  let gatcReleased = 0;
  try {
    const { releaseGatcStampedSerialsOnVoid } = await import('./yesgatc-stamped-serial-allot.js');
    const gatc = await releaseGatcStampedSerialsOnVoid({
      customerId: cid,
      invoiceId: iid,
      data: { id: iid, ...invoiceData },
      lines: Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : [],
    });
    gatcReleased = Number(gatc.released) || 0;
  } catch (err) {
    console.warn(`GATC unlink on invoice remove failed for ${iid}:`, err?.message ?? err);
  }

  return {
    released: released.length + gatcReleased,
    serials: released,
    gatcReleased,
  };
}

function isGoneInvoiceStatus(status) {
  return isVoidInvoiceStatus(status);
}

/** One-shot / webhook repair: allocations and GATC links whose invoice is gone or void. */
export async function releaseOrphanedInvoiceSerialLinks() {
  const db = getFirestore();
  const summary = {
    allocationsReleased: 0,
    certificatesUnlinked: 0,
    invoices: [],
  };

  const invoiceIds = new Set();
  const allocSnap = await db.collection(NON_GATC_ALLOCATIONS).get();
  allocSnap.forEach(doc => {
    const iid = str(doc.data()?.invoiceId);
    if (iid) invoiceIds.add(iid);
  });

  const collectInvoiceId = (value) => {
    const iid = str(value);
    if (iid) invoiceIds.add(iid);
  };

  const certSnap = await db.collection('yesgatcCertificates')
    .where('invoiceId', '>', '')
    .get()
    .catch(() => null);
  if (certSnap) {
    certSnap.forEach(doc => collectInvoiceId(doc.data()?.invoiceId));
  }

  const linkSnap = await db.collection('yesgatcSerialLinks')
    .where('invoiceId', '>', '')
    .get()
    .catch(() => null);
  if (linkSnap) {
    linkSnap.forEach(doc => collectInvoiceId(doc.data()?.invoiceId));
  }

  for (const invoiceId of invoiceIds) {
    const indexSnap = await db.doc(`invoiceIndex/${invoiceId}`).get();
    const cid = str(indexSnap.data()?.customerId);
    let gone = !indexSnap.exists || !cid;
    let invoiceData = {};
    if (!gone) {
      const snap = await db.doc(`zohoCustomers/${cid}/invoices/${invoiceId}`).get();
      if (!snap.exists || isGoneInvoiceStatus(snap.data()?.status)) {
        gone = true;
        invoiceData = snap.exists ? (snap.data() || {}) : {};
      }
    }
    if (!gone) continue;
    const result = await releaseInvoiceSerialLinks({
      customerId: cid,
      invoiceId,
      data: invoiceData,
    });
    if (result.released) {
      summary.allocationsReleased += (result.serials || []).length;
      summary.certificatesUnlinked += Number(result.gatcReleased) || 0;
      summary.invoices.push({
        invoiceId,
        customerId: cid || null,
        released: result.released,
        serials: result.serials,
      });
    }
  }

  return summary;
}

function stripReleasedSerials(lines, releasedKeys) {
  const keys = new Set((releasedKeys || []).map(compactSerialKey));
  if (!keys.size) return Array.isArray(lines) ? lines : [];
  return (Array.isArray(lines) ? lines : []).map(line => {
    const serials = uniqueSerials(line?.serialNumbers).filter(serial => !keys.has(compactSerialKey(serial)));
    return applySerialsToLine(line, serials);
  });
}

function isMachineScaleLine(line) {
  return MACHINE_HSN.has(hsnDigits(line?.hsn));
}

function serialsByMachineLineId(lines) {
  const map = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!isMachineScaleLine(line)) continue;
    map.set(str(line.id), uniqueSerials(line.serialNumbers));
  }
  return map;
}

function lineItemsForInvoiceSerialPut(zohoInvoice, serialsByLineId) {
  const items = Array.isArray(zohoInvoice?.line_items) ? zohoInvoice.line_items : [];
  return items.map(item => {
    const line = {
      item_id: item.item_id,
      name: item.name,
      rate: item.rate,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
    };
    if (item.line_item_id) line.line_item_id = item.line_item_id;
    if (item.hsn_or_sac) line.hsn_or_sac = item.hsn_or_sac;
    if (item.tax_id) line.tax_id = item.tax_id;
    if (
      item.warehouse_id != null
      && String(item.warehouse_id).trim()
    ) {
      line.warehouse_id = String(item.warehouse_id).trim();
    }
    const key = str(item.line_item_id);
    if (serialsByLineId.has(key)) {
      line.description = withSerialBlockOnDescription(item.description, serialsByLineId.get(key));
    } else if (item.description) {
      line.description = item.description;
    }
    return line;
  }).filter(line => line.item_id && Number(line.quantity) > 0);
}

async function zohoInventoryJson(accessToken, orgId, path, { method = 'GET', body } = {}) {
  const url = new URL(`${ZOHO_API_BASE}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }
  const sendBody = hasZohoJsonBody(body);
  const res = await fetch(url.toString(), {
    method,
    headers: {
      ...authHeaders(accessToken, orgId),
      ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(sendBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok || (payload?.code != null && payload.code !== 0)) {
    throw new Error(payload?.message || `Zoho invoice ${method} failed.`);
  }
  return payload;
}

async function resolveZohoAuth({ accessToken, orgId, secrets, configuredOrgId } = {}) {
  if (accessToken && orgId) return { accessToken, orgId };
  if (!secrets) return null;
  const token = await getAccessToken(secrets);
  return {
    accessToken: token,
    orgId: await resolveOrganizationId(token, configuredOrgId || orgId),
  };
}

async function pushSerialsToZohoInvoice({
  accessToken,
  orgId,
  secrets,
  configuredOrgId,
  invoiceId,
  lines,
} = {}) {
  const auth = await resolveZohoAuth({ accessToken, orgId, secrets, configuredOrgId });
  if (!auth) return { zohoPushed: false, zohoError: 'Zoho credentials missing.' };
  const payload = await zohoInventoryJson(
    auth.accessToken,
    auth.orgId,
    `/invoices/${encodeURIComponent(invoiceId)}`,
  );
  const zohoInvoice = payload?.invoice;
  if (!zohoInvoice) throw new Error('Zoho invoice not found.');
  await zohoInventoryJson(
    auth.accessToken,
    auth.orgId,
    `/invoices/${encodeURIComponent(invoiceId)}`,
    {
      method: 'PUT',
      body: {
        customer_id: zohoInvoice.customer_id,
        date: zohoInvoice.date,
        line_items: lineItemsForInvoiceSerialPut(zohoInvoice, serialsByMachineLineId(lines)),
      },
    },
  );
  try {
    const { refreshInvoicePdfFromZoho } = await import('./invoice-sync.js');
    await refreshInvoicePdfFromZoho(
      auth.accessToken,
      auth.orgId,
      String(zohoInvoice.customer_id || ''),
      invoiceId,
    );
  } catch (err) {
    console.warn(
      `Invoice PDF refresh after serial update failed for ${invoiceId}:`,
      err?.message ?? err,
    );
  }
  return { zohoPushed: true, zohoError: '' };
}

export async function pushSerialsToZohoInvoiceSafe(input) {
  try {
    return await pushSerialsToZohoInvoice(input);
  } catch (err) {
    const zohoError = err instanceof Error ? err.message : 'Could not update Zoho invoice.';
    console.warn(`Zoho invoice serial update failed for ${input?.invoiceId}:`, zohoError);
    return { zohoPushed: false, zohoError };
  }
}

export async function voidZohoInvoice({
  accessToken,
  orgId,
  secrets,
  configuredOrgId,
  invoiceId,
  reason = '',
} = {}) {
  const id = str(invoiceId);
  if (!id) throw new Error('Invoice is required.');
  const auth = await resolveZohoAuth({ accessToken, orgId, secrets, configuredOrgId });
  if (!auth) throw new Error('Zoho credentials missing.');
  const note = str(reason).slice(0, 500);
  try {
    await zohoInventoryJson(
      auth.accessToken,
      auth.orgId,
      `/invoices/${encodeURIComponent(id)}/status/void`,
      {
        method: 'POST',
        body: note ? { reason: note } : {},
      },
    );
  } catch (err) {
    const message = str(err?.message);
    if (!/already\s+void/i.test(message)) throw err;
  }
  return { invoiceId: id, status: 'void' };
}

export async function applyNonGatcSerialAllotmentOnInvoice({
  customerId,
  invoiceId,
  actorName = 'YESWEIGH',
  force = false,
  forceRelease = false,
  serials = [],
  lineId = '',
  allowWhenDelivered = false,
  accessToken,
  orgId,
  secrets,
  configuredOrgId,
} = {}) {
  const db = getFirestore();
  const invoiceRef = db.doc(`zohoCustomers/${customerId}/invoices/${invoiceId}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new Error('Invoice not found.');
  }
  let data = snap.data() || {};
  if (!forceRelease && !isVoidInvoiceStatus(data.status)) {
    const healed = await healInvoiceSerialsOnDocument({ customerId, invoiceId });
    data = { ...data, lineItems: healed.lineItems };
  }
  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  if (!forceRelease) assertCanMutateSerialsAfterDelivery(data, allowWhenDelivered);

  if (isVoidInvoiceStatus(data.status) || forceRelease) {
    const released = await releaseAllocationsForInvoice(db, invoiceId);
    if (released.length) {
      try {
        const { markSerialUnitsInStock } = await import('./serial-units.js');
        await markSerialUnitsInStock(released);
      } catch (err) {
        console.warn(`serialUnits restock failed for ${invoiceId}:`, err?.message ?? err);
      }
    }
    let workingLines = lines;
    let gatcReleased = 0;
    try {
      const { releaseGatcStampedSerialsOnVoid } = await import('./yesgatc-stamped-serial-allot.js');
      const gatc = await releaseGatcStampedSerialsOnVoid({
        customerId,
        invoiceId,
        data,
        lines: workingLines,
      });
      workingLines = gatc.lineItems || workingLines;
      gatcReleased = Number(gatc.released) || 0;
    } catch (err) {
      console.warn(`GATC stamped unlink on void failed for ${invoiceId}:`, err?.message ?? err);
    }
    if (!released.length && !gatcReleased && !Array.isArray(data.nonGatcAllocatedSerials)) {
      return { allotted: 0, released: 0, shortage: 0, voided: true, lineItems: workingLines };
    }
    const nextLines = stripReleasedSerials(
      workingLines,
      released.concat(data.nonGatcAllocatedSerials || []),
    );
    await invoiceRef.set({
      lineItems: nextLines,
      nonGatcAllocatedSerials: [],
      nonGatcSerialAllottedAt: null,
      gatcStampedAllocatedSerials: [],
      gatcStampedSerialAllottedAt: null,
      gatcStampedSerialAllottedBy: null,
      yesgatcLinks: [],
      yesgatcLinkedAt: null,
    }, { merge: true });
    const zoho = await pushSerialsToZohoInvoiceSafe({
      accessToken,
      orgId,
      secrets,
      configuredOrgId,
      invoiceId,
      lines: nextLines,
    });
    return {
      allotted: 0,
      released: released.length + gatcReleased,
      shortage: 0,
      voided: true,
      lineItems: nextLines,
      ...zoho,
    };
  }

  const eligible = lines.filter(isNonGatcSerialEligibleLine);
  const needed = eligible.reduce((sum, line) => sum + lineNeed(line), 0);
  const selected = uniqueSerials(serials);
  if (!selected.length) {
    return { allotted: 0, released: 0, shortage: needed, voided: false, lineItems: lines };
  }
  if (!needed && !force) {
    return { allotted: 0, released: 0, shortage: 0, voided: false, lineItems: lines };
  }

  const targetLineId = str(lineId);
  const targetLine = targetLineId
    ? lines.find(line => str(line.id) === targetLineId)
    : lines.find(isNonGatcSerialEligibleLine);
  const wantProduct = compactProductToken(targetLine?.itemId);
  const wantSku = compactProductToken(targetLine?.sku);
  const lineFilter = {
    productId: str(targetLine?.itemId),
    sku: str(targetLine?.sku),
    productName: str(targetLine?.name || targetLine?.productName),
  };

  const allotSnap = await db.doc(SERIAL_NUMBER_ALLOTMENT_DOC).get();
  const pool = expandNonGatcPool(allotSnap.exists ? allotSnap.data()?.allotments : [], lineFilter);
  const poolKeys = new Set(pool.map(compactSerialKey));
  const taken = await loadTakenSerialKeys(db, invoiceId);
  for (const line of lines) {
    for (const serial of uniqueSerials(line?.serialNumbers)) {
      taken.add(compactSerialKey(serial));
    }
  }

  const available = [];
  const seenPick = new Set();
  for (const serial of selected) {
    const key = compactSerialKey(serial);
    if (!key || seenPick.has(key)) continue;
    if (!poolKeys.has(key)) {
      throw new Error(`${serial} is not in the non-GATC allotted list.`);
    }
    if (taken.has(key)) {
      throw new Error(`${serial} is already linked to an invoice.`);
    }
    seenPick.add(key);
    available.push(pool.find(item => compactSerialKey(item) === key) || serial);
  }
  if (!available.length) {
    return { allotted: 0, released: 0, shortage: needed, voided: false, lineItems: lines };
  }

  if (wantProduct || wantSku) {
    const { SERIAL_UNITS, SERIAL_UNIT_IN_STOCK } = await import('./serial-units.js');
    for (let i = 0; i < available.length; i += 100) {
      const slice = available.slice(i, i + 100);
      const snaps = await db.getAll(
        ...slice.map(serial => db.collection(SERIAL_UNITS).doc(compactSerialKey(serial))),
      );
      for (let j = 0; j < slice.length; j += 1) {
        const snap = snaps[j];
        if (!snap.exists) continue;
        const data = snap.data() || {};
        const status = str(data.status);
        if (status && status !== SERIAL_UNIT_IN_STOCK) {
          throw new Error(`${slice[j]} is already linked to an invoice.`);
        }
        const unitProduct = compactProductToken(data.productId);
        const unitSku = compactProductToken(data.sku);
        if (!unitProduct && !unitSku) continue;
        if (unitProduct !== wantProduct && unitSku !== wantSku) {
          throw new Error(
            `${slice[j]} belongs to ${str(data.sku || data.productName) || 'another product'}, not this line.`,
          );
        }
      }
    }
  }

  const targetNeed = targetLineId
    ? lineNeed(lines.find(line => str(line.id) === targetLineId) || {})
    : needed;
  if (available.length !== targetNeed) {
    throw new Error(
      `Select exactly ${targetNeed} serial${targetNeed === 1 ? '' : 's'} from the available list.`,
    );
  }

  let cursor = 0;
  let allotted = 0;
  const newAllocations = [];
  const nextLines = lines.map(line => {
    if (!isNonGatcSerialEligibleLine(line)) return line;
    if (targetLineId && str(line.id) !== targetLineId) return line;
    const need = lineNeed(line);
    if (!need) return line;
    const take = available.slice(cursor, cursor + need);
    cursor += take.length;
    if (!take.length) return line;
    allotted += take.length;
    const serialNumbers = uniqueSerials([...(line.serialNumbers || []), ...take]);
    for (const serial of take) {
      newAllocations.push({
        serial,
        lineId: str(line.id),
      });
    }
    return applySerialsToLine(line, serialNumbers);
  });

  let rc = null;
  try {
    const { findLinkedRcForDealer } = await import('./yesgatc-rc-invoice-push.js');
    rc = await findLinkedRcForDealer(customerId);
  } catch {
    rc = null;
  }

  if (newAllocations.length) {
    const now = new Date().toISOString();
    let batch = db.batch();
    let count = 0;
    for (const row of newAllocations) {
      batch.set(db.collection(NON_GATC_ALLOCATIONS).doc(compactSerialKey(row.serial)), {
        serial: row.serial,
        invoiceId: str(invoiceId),
        invoiceNumber: str(data.invoiceNumber || data.zohoInvoiceNumber) || null,
        customerId: str(customerId),
        lineId: row.lineId,
        rcCode: rc?.rcCode || null,
        rcName: rc?.rcName || null,
        allottedAt: now,
        allottedBy: str(actorName) || 'YESWEIGH',
      });
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
    if (count) await batch.commit();
    try {
      const { markSerialUnitsInvoiced } = await import('./serial-units.js');
      await markSerialUnitsInvoiced({
        serials: newAllocations.map(row => row.serial),
        invoiceId,
        invoiceNumber: str(data.invoiceNumber || data.zohoInvoiceNumber),
        customerId,
        lineId: targetLineId,
        rcCode: rc?.rcCode || null,
        rcName: rc?.rcName || null,
        actorName,
      });
    } catch (err) {
      console.warn(`serialUnits invoice mark failed for ${invoiceId}:`, err?.message ?? err);
    }
  }

  const allocatedSerials = uniqueSerials([
    ...(Array.isArray(data.nonGatcAllocatedSerials) ? data.nonGatcAllocatedSerials : []),
    ...newAllocations.map(row => row.serial),
  ]);

  if (allotted) {
    await invoiceRef.set({
      lineItems: nextLines,
      nonGatcAllocatedSerials: allocatedSerials,
      nonGatcSerialAllottedAt: FieldValue.serverTimestamp(),
      nonGatcSerialAllottedBy: str(actorName) || 'YESWEIGH',
      ...(rc ? {
        yesgatcRcCode: rc.rcCode,
        yesgatcRcName: rc.rcName,
      } : {}),
    }, { merge: true });
  }

  const pushLines = allotted ? nextLines : lines;
  const hasSerials = [...serialsByMachineLineId(pushLines).values()].some(list => list.length);
  const zoho = (allotted || (force && hasSerials))
    ? await pushSerialsToZohoInvoiceSafe({
      accessToken,
      orgId,
      secrets,
      configuredOrgId,
      invoiceId,
      lines: pushLines,
    })
    : { zohoPushed: false, zohoError: '' };

  let yesgatc = { pushed: false, skipped: rc ? null : 'not_rc' };
  if (allotted && rc) {
    const { pushRcInvoiceSerialsToYesGatcSafe } = await import('./yesgatc-rc-invoice-push.js');
    yesgatc = await pushRcInvoiceSerialsToYesGatcSafe({
      customerId,
      invoiceId,
      actorName,
      force: true,
    });
  }

  return {
    allotted,
    released: 0,
    shortage: Math.max(0, needed - allotted),
    voided: false,
    lineItems: allotted ? nextLines : lines,
    ...zoho,
    yesgatcPushed: Boolean(yesgatc.pushed),
    yesgatcSkipped: yesgatc.skipped || null,
    yesgatcError: yesgatc.error || null,
  };
}

export async function unlinkNonGatcSerialsFromInvoice({
  customerId,
  invoiceId,
  lineId = '',
  serials = [],
  actorName = 'YESWEIGH',
  allowWhenDelivered = false,
  accessToken,
  orgId,
  secrets,
  configuredOrgId,
} = {}) {
  const db = getFirestore();
  const invoiceRef = db.doc(`zohoCustomers/${customerId}/invoices/${invoiceId}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    throw new Error('Invoice not found.');
  }
  const data = snap.data() || {};
  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  assertCanMutateSerialsAfterDelivery(data, allowWhenDelivered);
  const targetLineId = str(lineId);
  const onlyKeys = new Set(uniqueSerials(serials).map(compactSerialKey));

  const toRelease = [];
  for (const line of lines) {
    if (targetLineId && str(line.id) !== targetLineId) continue;
    if (!isNonGatcSerialEligibleLine(line) && !uniqueSerials(line?.serialNumbers).length) continue;
    for (const serial of uniqueSerials(line?.serialNumbers)) {
      if (onlyKeys.size && !onlyKeys.has(compactSerialKey(serial))) continue;
      toRelease.push(serial);
    }
  }
  if (!toRelease.length && Array.isArray(data.nonGatcAllocatedSerials) && !targetLineId && !onlyKeys.size) {
    toRelease.push(...uniqueSerials(data.nonGatcAllocatedSerials));
  }

  const released = uniqueSerials(toRelease);
  if (!released.length) {
    return {
      allotted: 0,
      released: 0,
      shortage: 0,
      voided: isVoidInvoiceStatus(data.status),
      lineItems: lines,
      zohoPushed: false,
      zohoError: '',
    };
  }

  const releasedKeys = new Set(released.map(compactSerialKey));
  let batch = db.batch();
  let count = 0;
  for (const serial of released) {
    batch.delete(db.collection(NON_GATC_ALLOCATIONS).doc(compactSerialKey(serial)));
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count) await batch.commit();
  try {
    const { markSerialUnitsInStock } = await import('./serial-units.js');
    await markSerialUnitsInStock(released);
  } catch (err) {
    console.warn(`serialUnits restock failed for ${invoiceId}:`, err?.message ?? err);
  }

  const nextLines = stripReleasedSerials(lines, released);
  const remaining = uniqueSerials([
    ...(Array.isArray(data.nonGatcAllocatedSerials) ? data.nonGatcAllocatedSerials : []),
  ]).filter(serial => !releasedKeys.has(compactSerialKey(serial)));

  await invoiceRef.set({
    lineItems: nextLines,
    nonGatcAllocatedSerials: remaining,
    nonGatcSerialAllottedAt: remaining.length ? data.nonGatcSerialAllottedAt ?? null : null,
    nonGatcSerialAllottedBy: remaining.length
      ? data.nonGatcSerialAllottedBy ?? (str(actorName) || 'YESWEIGH')
      : null,
    yesgatcRcPushedAt: null,
    yesgatcRcPushedBy: null,
    yesgatcRcCode: null,
    yesgatcRcName: null,
    yesgatcRcPushError: null,
  }, { merge: true });

  const zoho = await pushSerialsToZohoInvoiceSafe({
    accessToken,
    orgId,
    secrets,
    configuredOrgId,
    invoiceId,
    lines: nextLines,
  });

  let yesgatc = { pushed: false, skipped: null };
  const { pushRcInvoiceSerialsToYesGatcSafe } = await import('./yesgatc-rc-invoice-push.js');
  yesgatc = await pushRcInvoiceSerialsToYesGatcSafe({
    customerId,
    invoiceId,
    actorName,
    force: true,
    action: remaining.length ? 'upsert' : 'unlink',
  });

  return {
    allotted: 0,
    released: released.length,
    shortage: 0,
    voided: isVoidInvoiceStatus(data.status),
    lineItems: nextLines,
    ...zoho,
    yesgatcPushed: Boolean(yesgatc.pushed),
    yesgatcSkipped: yesgatc.skipped || null,
    yesgatcError: yesgatc.error || null,
  };
}
