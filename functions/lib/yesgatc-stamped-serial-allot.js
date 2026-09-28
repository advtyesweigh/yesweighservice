/**
 * Warehouse assigns unlinked Interweighing (IWP) OV certificates to
 * GATC-stamped invoice lines. Dismantled / no-GATC lines stay on the
 * automatic non-GATC pool.
 */
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  compactSerialKey,
  expandGatcPickerPool,
  GATC_50KG_SERIES,
  GATC_SL_SERIES,
  isIwpGatcUnusedSerial,
  isXSeriesSerial,
  productHasGatcPickerLots,
  invoiceLineHasGatcTag,
  isVoidInvoiceStatus,
  NON_GATC_MACHINE_HSN,
  SERIAL_NUMBER_ALLOTMENT_DOC,
  seriesHasAllotments,
  pushSerialsToZohoInvoiceSafe,
} from './non-gatc-serial-allot.js';
import {
  assertCanMutateSerialsAfterDelivery,
  isMandatorySerialExemptLine,
  lineIsMandatorySerialCategory,
} from './mandatory-serials.js';
import {
  invoiceDateKey,
  invoiceFieldsFromLink,
  normalizeSerial,
  serialLinkDocId,
  YESGATC_SERIAL_LINKS,
} from './yesgatc-invoice-link.js';
import {
  isYesoneIwpCertificateRow,
  listCertificatesForOps,
  YESONE_RC_CODE,
} from './yesgatc-webhook.js';

const YESGATC_CERTIFICATES = 'yesgatcCertificates';
const MACHINE_HSN = new Set(NON_GATC_MACHINE_HSN);

function str(value) {
  return value == null ? '' : String(value).trim();
}

function compactProductToken(value) {
  return str(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseCapacityKg(value) {
  const text = str(value);
  if (!text) return null;
  const withUnit = text.match(/(\d+(?:\.\d+)?)\s*kgs?\b/i);
  if (withUnit) {
    const kg = Number(withUnit[1]);
    return Number.isFinite(kg) ? kg : null;
  }
  const bare = text.match(/^(\d+(?:\.\d+)?)\s*$/);
  if (!bare) return null;
  const kg = Number(bare[1]);
  return Number.isFinite(kg) ? kg : null;
}

function isFiftyKg(kg) {
  return kg != null && Number.isFinite(kg) && Math.abs(kg - 50) < 0.01;
}

function lineCapacityKg(line) {
  const fromStamp = str(line?.description).match(/stamping\s*:\s*([^\n]+)/i)?.[1];
  return parseCapacityKg(fromStamp)
    || parseCapacityKg(line?.description)
    || parseCapacityKg(line?.name)
    || parseCapacityKg(line?.productName);
}

function certificateCapacityKg(data) {
  return parseCapacityKg(data?.max);
}

function certificateIsBound(data) {
  return Boolean(compactProductToken(data?.sku) || compactProductToken(data?.productId || data?.itemId));
}

function certificateMatchesLine(data, line) {
  const have = [data?.sku, data?.productId, data?.itemId, data?.productName]
    .map(compactProductToken)
    .filter(Boolean);
  if (!have.length) return true;
  const want = [line?.sku, line?.itemId, line?.productId, line?.name, line?.productName]
    .map(compactProductToken)
    .filter(Boolean);
  if (!want.length) return false;
  return want.some(token => have.includes(token));
}

function certificateAllowedForLine(data, line, dedicated) {
  const lineKg = lineCapacityKg(line);
  const certKg = certificateCapacityKg(data);
  if (isFiftyKg(certKg) && !isFiftyKg(lineKg)) return false;
  if (isFiftyKg(lineKg) && !isFiftyKg(certKg)) return false;
  if (lineKg != null && !isFiftyKg(lineKg) && certKg != null && certKg !== lineKg) return false;
  if (dedicated) {
    return certificateIsBound(data) && certificateMatchesLine(data, line);
  }
  if (certificateIsBound(data) && !certificateMatchesLine(data, line)) return false;
  return true;
}

function hsnDigits(value) {
  return str(value).replace(/\D/g, '');
}

function uniqueSerials(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = str(value);
    const key = compactSerialKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
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

function applySerialsToLine(line, serials) {
  const serialNumbers = uniqueSerials(serials);
  return {
    ...line,
    serialNumbers,
    description: withSerialBlockOnDescription(line?.description, serialNumbers) || null,
  };
}

function verificationKind(data) {
  const raw = data?.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
    ? data.raw
    : null;
  const text = str(
    data?.verificationType
    || raw?.verificationType
    || raw?.verification_type
    || data?.verification_type,
  ).toUpperCase();
  if (!text) return null;
  if (text === 'OV' || text.startsWith('ORIGINAL')) return 'OV';
  if (text === 'RV' || text.startsWith('RE')) return 'RV';
  return null;
}

function isCertificateLinked(data) {
  return Boolean(str(data?.invoiceNumber) || str(data?.invoiceId));
}

function isAllotableIwpCertificate(data, id) {
  if (data?.yesoneVisible === true) return true;
  if (isYesoneIwpCertificateRow({ ...data, id })) return true;
  const raw = data?.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
    ? data.raw
    : null;
  const nested = raw?.rc && typeof raw.rc === 'object' && !Array.isArray(raw.rc)
    ? raw.rc
    : null;
  const bits = [
    data?.rcCode, data?.rcName, data?.code, data?.name,
    raw?.rcCode, raw?.rcName, raw?.companyName,
    nested?.rcCode, nested?.code, nested?.companyName, nested?.username, nested?.name,
  ];
  return bits.some((value) => {
    const text = String(value ?? '').trim().toUpperCase();
    if (!text) return false;
    if (text === YESONE_RC_CODE || text.startsWith(`${YESONE_RC_CODE}/`) || text.startsWith(`${YESONE_RC_CODE}-`)) {
      return true;
    }
    return text.replace(/[\s\-_]/g, '').includes('INTERWEIGHING');
  });
}

function isVoidedCertificate(data) {
  if (data?.voided === true) return true;
  const raw = data?.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
    ? data.raw
    : null;
  return raw?.voided === true;
}

export function isGatcStampedSerialEligibleLine(line) {
  if (!line || typeof line !== 'object') return false;
  if (isMandatorySerialExemptLine(line)) return false;
  if (!invoiceLineHasGatcTag(line)) return false;
  if (MACHINE_HSN.has(hsnDigits(line.hsn))) return true;
  return lineIsMandatorySerialCategory(line);
}

function lineNeed(line) {
  const qty = Math.max(0, Math.round(Number(line?.quantity) || 0));
  return Math.max(0, qty - uniqueSerials(line?.serialNumbers).length);
}

const GATC_POOL_PICK_PREFIX = 'pool:';

function isGatcPoolPickId(id) {
  return str(id).startsWith(GATC_POOL_PICK_PREFIX);
}

function serialFromPoolPickId(id) {
  return str(id).slice(GATC_POOL_PICK_PREFIX.length);
}

function publicCert(id, data) {
  return {
    id,
    certificateNumber: str(data.certificateNumber),
    serialNumber: str(data.serialNumber),
    productName: str(data.productName),
    productId: data.productId != null ? str(data.productId) : null,
    sku: data.sku != null ? str(data.sku) : null,
    rcCode: data.rcCode != null ? str(data.rcCode) : YESONE_RC_CODE,
    rcName: data.rcName != null ? str(data.rcName) : 'INTERWEIGHING PVT LTD',
    issuedAt: data.issuedAt != null ? str(data.issuedAt) : null,
    max: data.max != null ? str(data.max) : '',
    min: data.min != null ? str(data.min) : '',
    e: data.e != null ? str(data.e) : '',
  };
}

function publicPoolSerial(serial, seriesLabel, maxLabel) {
  const key = compactSerialKey(serial);
  return {
    id: `${GATC_POOL_PICK_PREFIX}${key}`,
    certificateNumber: '',
    serialNumber: str(serial),
    productName: seriesLabel,
    productId: null,
    sku: null,
    rcCode: YESONE_RC_CODE,
    rcName: 'INTERWEIGHING PVT LTD',
    issuedAt: null,
    max: maxLabel,
    min: '',
    e: '',
  };
}

function pickerRowBlob(row) {
  return `${row?.serialNumber ?? ''} ${row?.max ?? ''} ${row?.certificateNumber ?? ''} ${row?.sku ?? ''} ${row?.productName ?? ''}`
    .toLowerCase();
}

function isSharedGatcSticker(serial) {
  return isIwpGatcUnusedSerial(serial) || isXSeriesSerial(serial);
}

/**
 * Product serials (YJ and other SKU lots) stay ahead of the shared Y / YZ / X tank.
 * A search runs on the full pool so a serial past the window still resolves.
 */
export function prioritizeUnlinkedGatcRows(sorted, { cap = 2000, query = '' } = {}) {
  const owned = [];
  const shared = [];
  for (const row of sorted) {
    if (isSharedGatcSticker(row?.serialNumber)) shared.push(row);
    else owned.push(row);
  }
  const needle = str(query).toLowerCase();
  const ordered = [...owned, ...shared];
  const pool = needle
    ? ordered.filter(row => pickerRowBlob(row).includes(needle))
    : ordered;
  const limit = Math.min(5000, Math.max(1, Number(cap) || 2000));
  if (!needle && owned.length >= limit) return owned.slice(0, limit);
  return pool.slice(0, limit);
}

function gatcAllotmentSeriesForLine(lineOrKg) {
  const kg = typeof lineOrKg === 'number' || lineOrKg == null
    ? lineOrKg
    : lineCapacityKg(lineOrKg);
  return isFiftyKg(kg) ? GATC_50KG_SERIES : GATC_SL_SERIES;
}

async function loadSerialAllotments(db) {
  const snap = await db.doc(SERIAL_NUMBER_ALLOTMENT_DOC).get();
  return snap.exists ? (snap.data()?.allotments || []) : [];
}

function unusedGatcAllotmentKeys(allotments, filter, series) {
  const hasLots = productHasGatcPickerLots(allotments, filter, series)
    || seriesHasAllotments(allotments, series);
  if (!hasLots) return null;
  return new Set(expandGatcPickerPool(allotments, filter, series).map(compactSerialKey));
}

function certificateLinkedToInvoice(row, invoiceId, invoiceNumber) {
  const iid = str(invoiceId);
  const number = str(invoiceNumber);
  if (iid && str(row?.invoiceId) === iid) return true;
  if (number && str(row?.invoiceNumber) === number) return true;
  return false;
}

export async function listUnlinkedIwpGatcCertificates(maxOrOpts = 2000) {
  const opts = maxOrOpts && typeof maxOrOpts === 'object' ? maxOrOpts : { max: maxOrOpts };
  const cap = Math.min(5000, Math.max(1, Number(opts.max) || 2000));
  const lineKg = opts.capacityKg == null ? null : Number(opts.capacityKg);
  const invoiceId = str(opts.invoiceId);
  const invoiceNumber = str(opts.invoiceNumber);
  const query = str(opts.query);
  const filter = {
    productId: str(opts.productId || opts.itemId),
    sku: str(opts.sku),
    productName: str(opts.productName),
  };
  const rows = await listCertificatesForOps(10000, {
    rcCode: YESONE_RC_CODE,
    ovOnly: true,
  });
  const db = getFirestore();
  const allotments = await loadSerialAllotments(db);
  const series = gatcAllotmentSeriesForLine(Number.isFinite(lineKg) ? lineKg : null);
  const allowedKeys = unusedGatcAllotmentKeys(allotments, filter, series);
  const line = {
    sku: filter.sku,
    itemId: filter.productId,
    productId: filter.productId,
    name: filter.productName,
    productName: filter.productName,
    description: Number.isFinite(lineKg) ? `Stamping: ${lineKg}Kg` : '',
  };
  const dedicatedCert = rows.some(row => (
    (!isCertificateLinked(row) || certificateLinkedToInvoice(row, invoiceId, invoiceNumber))
    && !isVoidedCertificate(row)
    && certificateIsBound(row)
    && certificateMatchesLine(row, line)
  ));
  const certRows = rows
    .filter(row => {
      if (isVoidedCertificate(row) || !str(row.serialNumber)) return false;
      if (certificateLinkedToInvoice(row, invoiceId, invoiceNumber)) return true;
      return !isCertificateLinked(row);
    })
    .filter(row => certificateAllowedForLine(row, line, dedicatedCert))
    .filter(row => {
      if (!allowedKeys) return true;
      if (certificateLinkedToInvoice(row, invoiceId, invoiceNumber)) return true;
      return allowedKeys.has(compactSerialKey(row.serialNumber));
    })
    .map(row => publicCert(row.id, row));
  const seen = new Set(certRows.map(row => compactSerialKey(row.serialNumber)));
  const takenElsewhere = new Set();
  for (const row of rows) {
    if (!str(row.serialNumber) || isVoidedCertificate(row)) continue;
    if (isCertificateLinked(row) && !certificateLinkedToInvoice(row, invoiceId, invoiceNumber)) {
      takenElsewhere.add(compactSerialKey(row.serialNumber));
    }
  }
  const seriesLabel = series === GATC_50KG_SERIES ? '50Kg GATC' : 'SL printed GATC';
  const maxLabel = Number.isFinite(lineKg)
    ? `${lineKg}Kg`
    : (series === GATC_50KG_SERIES ? '50Kg' : '');
  const extras = [];
  for (const serial of expandGatcPickerPool(allotments, filter, series)) {
    const key = compactSerialKey(serial);
    if (!key || seen.has(key) || takenElsewhere.has(key)) continue;
    seen.add(key);
    extras.push(publicPoolSerial(serial, seriesLabel, maxLabel));
  }
  const sorted = [...certRows, ...extras]
    .sort((a, b) => String(a.serialNumber).localeCompare(String(b.serialNumber), 'en', { numeric: true }));
  return prioritizeUnlinkedGatcRows(sorted, { cap, query });
}

async function loadCertificatesById(db, ids) {
  const unique = [...new Set(ids.map(str).filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique.slice(i, i + 100).map(id => db.collection(YESGATC_CERTIFICATES).doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) throw new Error('Certificate not found.');
      out.push({ id: snap.id, data: snap.data() || {} });
    }
  }
  return out;
}

async function findCertificateBySerial(db, serial) {
  const key = compactSerialKey(serial);
  const exact = str(serial);
  if (!key && !exact) return null;
  const queries = [];
  if (key) {
    queries.push(db.collection(YESGATC_CERTIFICATES).where('serialKey', '==', key).limit(5).get());
  }
  if (exact) {
    queries.push(db.collection(YESGATC_CERTIFICATES).where('serialNumber', '==', exact).limit(5).get());
  }
  const snaps = await Promise.all(queries);
  for (const snap of snaps) {
    const doc = snap.docs[0];
    if (doc) return { id: doc.id, data: doc.data() || {} };
  }
  return null;
}

export async function gatcSerialsLinkedToInvoice(db, { invoiceId, invoiceNumber }) {
  const linked = await findCertificatesForInvoice(db, { invoiceId, invoiceNumber });
  return linked
    .map(cert => ({
      serial: str(cert.data?.serialNumber),
      itemId: str(cert.data?.productId || cert.data?.itemId),
      sku: str(cert.data?.sku),
      kind: 'gatc',
    }))
    .filter(row => row.serial);
}

async function findCertificatesForInvoice(db, { invoiceId, invoiceNumber }) {
  const seen = new Map();
  const queries = [];
  if (str(invoiceId)) {
    queries.push(db.collection(YESGATC_CERTIFICATES).where('invoiceId', '==', str(invoiceId)).get());
  }
  if (str(invoiceNumber)) {
    queries.push(
      db.collection(YESGATC_CERTIFICATES).where('invoiceNumber', '==', str(invoiceNumber)).get(),
    );
  }
  const snaps = await Promise.all(queries.map(q => q.catch(() => null)));
  for (const snap of snaps) {
    if (!snap) continue;
    for (const doc of snap.docs) {
      if (!seen.has(doc.id)) seen.set(doc.id, { id: doc.id, data: doc.data() || {} });
    }
  }
  return [...seen.values()];
}

function invoiceLinkPayload(invoice) {
  return {
    invoiceId: str(invoice.id),
    invoiceNumber: str(invoice.invoiceNumber),
    invoiceDate: invoiceDateKey(invoice.date) || null,
    invoiceCustomerId: str(invoice.customerId),
  };
}

function clearInvoiceFields() {
  return {
    invoiceId: null,
    invoiceNumber: null,
    invoiceDate: null,
    invoiceCustomerId: null,
    invoiceLinkedAt: null,
  };
}

async function commitChunks(writes) {
  const db = getFirestore();
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const row of writes.slice(i, i + 400)) {
      if (row.delete) batch.delete(db.doc(row.path));
      else batch.set(db.doc(row.path), row.data, { merge: true });
    }
    await batch.commit();
  }
}

function unlinkWritesForCertificates(certs, invoicePath, remainingLinks) {
  const writes = [];
  for (const cert of certs) {
    const serial = str(cert.data.serialNumber);
    writes.push({
      path: `${YESGATC_CERTIFICATES}/${cert.id}`,
      data: clearInvoiceFields(),
    });
    if (serial) {
      writes.push({
        path: `${YESGATC_SERIAL_LINKS}/${serialLinkDocId(serial)}`,
        delete: true,
      });
    }
  }
  if (str(invoicePath)) {
    writes.push({
      path: invoicePath,
      data: {
        yesgatcLinks: remainingLinks,
        yesgatcLinkedAt: remainingLinks.length ? FieldValue.serverTimestamp() : null,
      },
    });
  }
  return writes;
}

export async function allotGatcStampedSerialsToInvoice({
  customerId,
  invoiceId,
  lineId,
  certificateIds = [],
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
  if (!snap.exists) throw new Error('Invoice not found.');
  const { healInvoiceSerialsOnDocument } = await import('./non-gatc-serial-allot.js');
  const healed = await healInvoiceSerialsOnDocument({ customerId, invoiceId });
  const data = { id: invoiceId, customerId, ...snap.data(), lineItems: healed.lineItems };
  assertCanMutateSerialsAfterDelivery(data, allowWhenDelivered);
  if (isVoidInvoiceStatus(data.status)) {
    throw new Error('Cannot allot GATC serials on a void invoice.');
  }

  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const targetId = str(lineId);
  const line = lines.find(item => str(item.id) === targetId);
  if (!line || !isGatcStampedSerialEligibleLine(line)) {
    throw new Error('Choose a GATC-stamped weighing-scale line.');
  }

  const need = lineNeed(line);
  const wanted = [...new Set((certificateIds || []).map(str).filter(Boolean))];
  if (!need) {
    return {
      allotted: 0,
      released: 0,
      shortage: 0,
      voided: false,
      lineItems: lines,
      zohoPushed: false,
      zohoError: '',
    };
  }
  if (wanted.length !== need) {
    throw new Error(`Select exactly ${need} unlinked GATC serial${need === 1 ? '' : 's'}.`);
  }

  const unused = await listUnlinkedIwpGatcCertificates({
    max: 5000,
    productId: str(line.itemId),
    sku: str(line.sku),
    productName: str(line.name || line.productName),
    capacityKg: lineCapacityKg(line),
    invoiceId,
    invoiceNumber: str(data.invoiceNumber),
  });
  const unusedById = new Map(unused.map(row => [row.id, row]));
  const allotments = await loadSerialAllotments(db);
  const series = gatcAllotmentSeriesForLine(line);
  const allowedKeys = unusedGatcAllotmentKeys(allotments, {
    productId: str(line.itemId),
    sku: str(line.sku),
    productName: str(line.name || line.productName),
  }, series);
  const dedicated = unused.some(row => (
    !isGatcPoolPickId(row.id)
    && certificateIsBound(row)
    && certificateMatchesLine(row, line)
  ));
  const usedOnInvoice = new Set(
    lines.flatMap(item => uniqueSerials(item?.serialNumbers).map(compactSerialKey)),
  );
  const certIds = wanted.filter(id => !isGatcPoolPickId(id));
  const loadedCerts = certIds.length ? await loadCertificatesById(db, certIds) : [];
  const certById = new Map(loadedCerts.map(cert => [cert.id, cert]));
  const serials = [];
  const certs = [];
  for (const wantedId of wanted) {
    const poolPick = isGatcPoolPickId(wantedId);
    let cert = poolPick ? null : certById.get(wantedId);
    let serial = poolPick
      ? (str(unusedById.get(wantedId)?.serialNumber) || serialFromPoolPickId(wantedId))
      : str(cert?.data?.serialNumber);
    if (poolPick) {
      const found = await findCertificateBySerial(db, serial);
      if (found) {
        serial = str(found.data.serialNumber) || serial;
        const canLink = isAllotableIwpCertificate(found.data, found.id)
          && verificationKind(found.data) === 'OV'
          && !isVoidedCertificate(found.data)
          && certificateAllowedForLine(found.data, line, dedicated);
        cert = canLink ? found : null;
        if (isCertificateLinked(found.data)
          && !certificateLinkedToInvoice(found.data, invoiceId, data.invoiceNumber)) {
          throw new Error(`${serial} is already linked.`);
        }
        if (isVoidedCertificate(found.data)) {
          throw new Error(`${serial} is voided.`);
        }
      }
    } else {
      if (!cert) throw new Error('Certificate not found.');
      if (!isAllotableIwpCertificate(cert.data, cert.id)) {
        throw new Error('Only Interweighing (IWP) certificates can be allotted here.');
      }
      if (verificationKind(cert.data) !== 'OV') {
        throw new Error('Only original verification (OV) certificates can be linked.');
      }
      if (isVoidedCertificate(cert.data)) throw new Error('A selected certificate is voided.');
      if (isCertificateLinked(cert.data)
        && !certificateLinkedToInvoice(cert.data, invoiceId, data.invoiceNumber)) {
        throw new Error(`${str(cert.data.serialNumber) || 'A certificate'} is already linked.`);
      }
      if (!certificateAllowedForLine(cert.data, line, dedicated)) {
        const lineKg = lineCapacityKg(line);
        if (isFiftyKg(certificateCapacityKg(cert.data)) && !isFiftyKg(lineKg)) {
          throw new Error(`${serial} is a 50 kg GATC serial. Use it only on a 50 kg scale.`);
        }
        if (isFiftyKg(lineKg) && !isFiftyKg(certificateCapacityKg(cert.data))) {
          throw new Error(`${serial} is not a 50 kg GATC serial.`);
        }
        throw new Error(
          `${serial} belongs to ${str(cert.data.sku || cert.data.productName) || 'another product'}, not this line.`,
        );
      }
    }
    const key = compactSerialKey(serial);
    if (!serial || !key) throw new Error('A selected GATC serial has no serial number.');
    if (usedOnInvoice.has(key) || serials.some(item => compactSerialKey(item) === key)) {
      throw new Error(`${serial} is already on this invoice.`);
    }
    if (
      allowedKeys
      && !allowedKeys.has(key)
      && !(cert && certificateLinkedToInvoice(cert.data, invoiceId, data.invoiceNumber))
    ) {
      throw new Error(
        isFiftyKg(lineCapacityKg(line))
          ? `${serial} is not an unused 50 kg GATC serial.`
          : `${serial} is not an unused SL printed GATC serial.`,
      );
    }
    serials.push(serial);
    if (cert) certs.push(cert);
  }

  const nextLine = applySerialsToLine(line, [...uniqueSerials(line.serialNumbers), ...serials]);
  const nextLines = lines.map(item => (str(item.id) === targetId ? nextLine : item));
  const link = invoiceLinkPayload(data);
  if (!link.invoiceNumber) throw new Error('Invoice number is missing.');

  const existingLinks = Array.isArray(data.yesgatcLinks) ? data.yesgatcLinks : [];
  const linkMap = new Map(
    existingLinks
      .filter(row => row?.certificateId)
      .map(row => [String(row.certificateId), row]),
  );
  const writes = [];
  for (const cert of certs) {
    const serial = str(cert.data.serialNumber);
    writes.push({
      path: `${YESGATC_CERTIFICATES}/${cert.id}`,
      data: {
        serialKey: normalizeSerial(serial),
        ...invoiceFieldsFromLink(link),
      },
    });
    writes.push({
      path: `${YESGATC_SERIAL_LINKS}/${serialLinkDocId(serial)}`,
      data: {
        serialNumber: serial,
        serialKey: normalizeSerial(serial),
        ...link,
        certificateId: cert.id,
        certificateNumber: str(cert.data.certificateNumber),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
    linkMap.set(cert.id, {
      certificateId: cert.id,
      certificateNumber: str(cert.data.certificateNumber),
      serialNumber: serial,
    });
  }

  const allocated = uniqueSerials([
    ...(Array.isArray(data.gatcStampedAllocatedSerials) ? data.gatcStampedAllocatedSerials : []),
    ...serials,
  ]);

  writes.push({
    path: invoiceRef.path,
    data: {
      lineItems: nextLines,
      yesgatcLinks: [...linkMap.values()],
      yesgatcLinkedAt: FieldValue.serverTimestamp(),
      gatcStampedAllocatedSerials: allocated,
      gatcStampedSerialAllottedAt: FieldValue.serverTimestamp(),
      gatcStampedSerialAllottedBy: str(actorName) || 'YESWEIGH',
    },
  });
  await commitChunks(writes);

  const zoho = await pushSerialsToZohoInvoiceSafe({
    accessToken,
    orgId,
    secrets,
    configuredOrgId,
    invoiceId,
    lines: nextLines,
  });

  const yesgatc = await notifyYesGatcInvoiceSerials({
    customerId,
    invoiceId,
    actorName,
    action: 'upsert',
  });

  return {
    allotted: serials.length,
    released: 0,
    shortage: lineNeed(nextLine),
    voided: false,
    lineItems: nextLines,
    ...zoho,
    yesgatcPushed: Boolean(yesgatc.pushed),
    yesgatcSkipped: yesgatc.skipped || null,
    yesgatcError: yesgatc.error || null,
  };
}

async function notifyYesGatcInvoiceSerials({
  customerId,
  invoiceId,
  actorName = 'YESWEIGH',
  action = 'upsert',
} = {}) {
  try {
    const { pushRcInvoiceSerialsToYesGatcSafe } = await import('./yesgatc-rc-invoice-push.js');
    return await pushRcInvoiceSerialsToYesGatcSafe({
      customerId,
      invoiceId,
      actorName,
      force: true,
      action,
    });
  } catch (err) {
    console.warn(
      `YesGATC stamped serial push failed for ${invoiceId}:`,
      err?.message ?? err,
    );
    return {
      pushed: false,
      skipped: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function unlinkGatcStampedSerialsFromInvoice({
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
  if (!snap.exists) throw new Error('Invoice not found.');
  const data = { id: invoiceId, customerId, ...snap.data() };
  assertCanMutateSerialsAfterDelivery(data, allowWhenDelivered);
  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const targetId = str(lineId);
  const result = await releaseGatcStampedSerials({
    data,
    lines,
    lineId: targetId,
    serials,
    invoicePath: invoiceRef.path,
  });
  if (!result.released) {
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

  const remaining = uniqueSerials([
    ...(Array.isArray(data.gatcStampedAllocatedSerials) ? data.gatcStampedAllocatedSerials : []),
  ]).filter(serial => !result.releasedKeys.has(compactSerialKey(serial)));

  await invoiceRef.set({
    lineItems: result.lineItems,
    gatcStampedAllocatedSerials: remaining,
    gatcStampedSerialAllottedAt: remaining.length ? data.gatcStampedSerialAllottedAt ?? null : null,
    gatcStampedSerialAllottedBy: remaining.length
      ? data.gatcStampedSerialAllottedBy ?? (str(actorName) || 'YESWEIGH')
      : null,
  }, { merge: true });

  const zoho = await pushSerialsToZohoInvoiceSafe({
    accessToken,
    orgId,
    secrets,
    configuredOrgId,
    invoiceId,
    lines: result.lineItems,
  });

  const yesgatc = await notifyYesGatcInvoiceSerials({
    customerId,
    invoiceId,
    actorName,
    action: remaining.length ? 'upsert' : 'unlink',
  });

  return {
    allotted: 0,
    released: result.released,
    shortage: 0,
    voided: isVoidInvoiceStatus(data.status),
    lineItems: result.lineItems,
    ...zoho,
    yesgatcPushed: Boolean(yesgatc.pushed),
    yesgatcSkipped: yesgatc.skipped || null,
    yesgatcError: yesgatc.error || null,
  };
}

async function releaseGatcStampedSerials({ data, lines, lineId, invoicePath, serials = [] }) {
  const db = getFirestore();
  const targetId = str(lineId);
  const onlyKeys = new Set(uniqueSerials(serials).map(compactSerialKey));
  const serialKeys = new Set();
  for (const line of lines) {
    if (targetId && str(line.id) !== targetId) continue;
    if (!isGatcStampedSerialEligibleLine(line)) continue;
    for (const serial of uniqueSerials(line?.serialNumbers)) {
      const key = compactSerialKey(serial);
      if (onlyKeys.size && !onlyKeys.has(key)) continue;
      serialKeys.add(key);
    }
  }

  const linked = await findCertificatesForInvoice(db, {
    invoiceId: data.id,
    invoiceNumber: data.invoiceNumber,
  });
  const toClear = linked.filter(cert => serialKeys.has(compactSerialKey(cert.data.serialNumber)));

  const nextLines = lines.map(line => {
    if (targetId && str(line.id) !== targetId) return line;
    if (!(targetId || isGatcStampedSerialEligibleLine(line))) return line;
    const kept = uniqueSerials(line?.serialNumbers).filter(serial => (
      !serialKeys.has(compactSerialKey(serial))
    ));
    return applySerialsToLine(line, kept);
  });

  const clearedIds = new Set(toClear.map(row => row.id));
  const remainingLinks = (Array.isArray(data.yesgatcLinks) ? data.yesgatcLinks : [])
    .filter(row => row?.certificateId && !clearedIds.has(String(row.certificateId)));

  if (toClear.length || serialKeys.size) {
    await commitChunks(unlinkWritesForCertificates(toClear, invoicePath, remainingLinks));
  }

  return {
    lineItems: nextLines,
    released: toClear.length || serialKeys.size,
    releasedKeys: serialKeys,
  };
}

/** Void / cancel: delink IWP certificates and strip GATC serials from the invoice. */
export async function releaseGatcStampedSerialsOnVoid({
  customerId,
  invoiceId,
  data,
  lines,
} = {}) {
  const invoicePath = `zohoCustomers/${customerId}/invoices/${invoiceId}`;
  return releaseGatcStampedSerials({
    data: { id: invoiceId, ...data },
    lines: Array.isArray(lines) ? lines : (Array.isArray(data?.lineItems) ? data.lineItems : []),
    lineId: '',
    invoicePath,
  });
}
