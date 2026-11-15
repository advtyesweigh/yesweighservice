/**
 * YesGATC → YesOne ingest. Stores certificates, RC details, and OV/quota counts.
 *
 * YesOne → YesGATC sends serial numbers + qty only (added/deducted).
 * YesGATC → YesOne should POST OV done per RC, e.g.
 *   { "event": "rc_ov", "rcs": [{ "rcCode": "ATL", "ov": 589, "linked": 589 }] }
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export const YESGATC_CERTIFICATES = 'yesgatcCertificates';
export const YESGATC_RC_DETAILS = 'yesgatcRcDetails';
export const YESGATC_WEBHOOK_SETTINGS_DOC = 'appSettings/yesgatcWebhook';

const MAX_BATCH = 400;
const MAX_RAW_CHARS = 700_000;

function pickStr(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function pickCertificateStatus(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.signed === true || record.isSigned === true || record.digitallySigned === true) {
    return 'signed';
  }
  const text = pickStr(record, [
    'status', 'state', 'certificateStatus', 'signStatus', 'signedStatus',
    'tag', 'message', 'signed', 'isSigned',
  ]);
  return text || null;
}

function sanitizeId(raw) {
  const text = String(raw ?? '').trim().replace(/[/\\]+/g, '_').slice(0, 700);
  return text || randomUUID();
}

function jsonSafe(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(item => jsonSafe(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      out[key] = jsonSafe(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

function stripSecrets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  delete out.secret;
  delete out.key;
  delete out.token;
  return out;
}

function rawForStore(value) {
  const safe = jsonSafe(stripSecrets(value));
  try {
    const encoded = JSON.stringify(safe);
    if (encoded.length > MAX_RAW_CHARS) {
      return { truncated: true, preview: encoded.slice(0, 8000) };
    }
  } catch {
    return { truncated: true };
  }
  return safe;
}

function looksLikeRc(record) {
  const type = pickStr(record, ['type', 'kind', 'recordType', 'entity', 'entityType', 'event']).toLowerCase();
  if ([
    'rc', 'rc_detail', 'rc_details', 'rcdetails', 'regional_center', 'regionalcenter',
    'rc_office', 'rc_ov', 'ov_update', 'rc_quota',
  ].includes(type) || type.includes('quota')) {
    return true;
  }
  if (['certificate', 'cert', 'stamping_certificate', 'verification_certificate'].includes(type)) {
    return false;
  }
  const keys = Object.keys(record || {}).map(key => key.toLowerCase());
  if (keys.some(key => key.includes('certificate'))) return false;
  return keys.some(key => (
    key === 'rccode'
    || key === 'rc_code'
    || key === 'rcnumber'
    || key === 'rc_number'
    || key === 'rcid'
    || key === 'regionalcenter'
    || key === 'regional_center'
    || key === 'officename'
    || key === 'ov'
    || key === 'ovdone'
    || key === 'ovcount'
    || key === 'allotted'
    || key === 'quota'
  ));
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );
}

function compactRcName(value) {
  return String(value || '').replace(/[\s\-_.,&]+/g, '').toUpperCase();
}

function realRcIdentity(value) {
  const text = String(value || '').trim();
  if (!text || isUuidLike(text)) return '';
  return text;
}

function pickNonNegInt(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (source[key] == null || source[key] === '') continue;
    const n = Number(source[key]);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

function wrapArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function objectRecords(value) {
  return wrapArray(value).filter(item => item && typeof item === 'object' && !Array.isArray(item));
}

function collectRecords(body) {
  const root = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  const nested = (root.data && typeof root.data === 'object' && !Array.isArray(root.data))
    ? root.data
    : {};
  const certificates = [
    ...objectRecords(root.certificates),
    ...objectRecords(root.certificate),
    ...objectRecords(root.certs),
    ...objectRecords(nested.certificates),
    ...objectRecords(nested.certificate),
  ];
  const rcDetails = [
    ...objectRecords(root.rcDetails),
    ...objectRecords(root.rc_details),
    ...objectRecords(root.rcs),
    ...objectRecords(root.rc),
    ...objectRecords(root.rcOvQuota),
    ...objectRecords(root.rcQuota),
    ...objectRecords(root.ovQuota),
    ...objectRecords(root.quota),
    ...objectRecords(root.rcStats),
    ...objectRecords(root.ovUpdates),
    ...objectRecords(nested.rcDetails),
    ...objectRecords(nested.rc_details),
    ...objectRecords(nested.rcs),
    ...objectRecords(nested.rcOvQuota),
    ...objectRecords(nested.rcQuota),
    ...objectRecords(nested.ovQuota),
    ...objectRecords(nested.rcStats),
    ...objectRecords(nested.ovUpdates),
  ];

  if (Array.isArray(body)) {
    for (const item of objectRecords(body)) {
      if (looksLikeRc(item)) rcDetails.push(item);
      else certificates.push(item);
    }
  } else if (Array.isArray(root.data)) {
    for (const item of objectRecords(root.data)) {
      if (looksLikeRc(item)) rcDetails.push(item);
      else certificates.push(item);
    }
  } else if (root && !certificates.length && !rcDetails.length) {
    const skip = new Set(['secret', 'key', 'token', 'type', 'kind', 'event']);
    const keys = Object.keys(root).filter(key => !skip.has(key));
    if (keys.length > 0) {
      const hint = pickStr(root, ['type', 'kind', 'event']).toLowerCase();
      if (looksLikeRc(root) || hint.includes('rc') || hint.includes('ov') || hint.includes('quota')) {
        rcDetails.push(root);
      } else {
        certificates.push(root);
      }
    }
  }

  const typeHint = pickStr(root, ['type', 'kind', 'event']).toLowerCase();
  if (
    (typeHint.includes('rc') || typeHint.includes('quota') || typeHint.includes('ov'))
    && certificates.length
    && !rcDetails.length
  ) {
    rcDetails.push(...certificates.splice(0, certificates.length));
  }

  return { certificates, rcDetails };
}

function normalizeCertificate(record) {
  const certificateNumber = pickStr(record, [
    'certificateNumber', 'certificateNo', 'certificate_no', 'certNo', 'cert_no',
    'number', 'certificateId', 'certificate_id',
  ]);
  const serialNumber = pickStr(record, [
    'serialNumber', 'serial_number', 'serial', 'slNo', 'sl_no', 'machineSerial',
  ]);
  const idHint = pickStr(record, ['id', 'docId', '_id', 'uuid', 'certificateId']);
  const rc = rcFieldsFromRecord(record);
  const yesoneVisible = isYesoneIwpRc({ code: rc.code, name: rc.name, raw: record });
  return {
    certificateNumber,
    serialNumber,
    dealerName: pickStr(record, ['dealerName', 'dealer_name', 'dealer', 'customerName', 'customer']),
    dealerId: pickStr(record, ['dealerId', 'dealer_id', 'zohoCustomerId', 'customerId']) || null,
    productName: pickStr(record, ['productName', 'product_name', 'product', 'model', 'instrument', 'make']),
    sku: pickStr(record, ['sku', 'itemCode', 'item_code']) || null,
    rcCode: yesoneVisible ? YESONE_RC_CODE : (rc.code || null),
    rcName: rc.name || null,
    yesoneVisible,
    status: pickCertificateStatus(record),
    issuedAt: pickStr(record, ['issuedAt', 'issueDate', 'issued_on', 'date', 'createdAt']) || null,
    pdfUrl: pickStr(record, ['pdfUrl', 'pdf_url', 'fileUrl', 'file_url', 'url', 'certificateUrl']) || null,
    max: pickStr(record, ['max', 'Max', 'maxCapacity', 'max_capacity', 'maxKg', 'Max (kg)']),
    min: pickStr(record, ['min', 'Min', 'minCapacity', 'min_capacity', 'minG', 'Min (g)']),
    e: pickStr(record, ['e', 'E', 'eValue', 'e_value', 'eG', 'e (g)']),
    verificationType: pickStr(record, [
      'verificationType', 'verification_type', 'verifType', 'typeOfVerification',
    ]) || null,
    raw: rawForStore(record),
    receivedAt: FieldValue.serverTimestamp(),
    source: 'yesgatc',
    docKey: sanitizeId(idHint || certificateNumber || serialNumber || randomUUID()),
  };
}

function normalizeRc(record) {
  const code = realRcIdentity(pickStr(record, [
    'code', 'rcCode', 'rc_code', 'rcNumber', 'rc_number',
  ]));
  const name = realRcIdentity(pickStr(record, [
    'companyName', 'name', 'rcName', 'officeName', 'office_name', 'title', 'username',
  ]));
  const idHint = pickStr(record, ['id', 'docId', '_id', 'uuid', 'rcId', 'uid']);
  const yesoneVisible = isYesoneIwpRc({ code, name, raw: record });
  const ovCount = pickNonNegInt(record, [
    'ov', 'ovDone', 'ov_done', 'ovCount', 'ov_count', 'ovUsed', 'ovQuotaUsed', 'used',
  ]);
  const linkedCount = pickNonNegInt(record, [
    'linked', 'linkedCount', 'linked_qty', 'linkedQty',
  ]);
  const quotaAllotted = pickNonNegInt(record, ['allotted', 'quotaAllotted', 'quota_allotted', 'ovQuota']);
  const quotaUsed = pickNonNegInt(record, ['used', 'quotaUsed', 'ovUsed', 'ovQuotaUsed']);
  const quotaBalance = pickNonNegInt(record, ['balance', 'bal', 'pending', 'pendingOv', 'ovBalance']);
  const vctCount = pickNonNegInt(record, ['vctCount', 'vcts', 'vct_count']);
  const jobsCount = pickNonNegInt(record, ['jobsCount', 'jobs', 'totalJobs', 'jobCount']);
  const certifiedCount = pickNonNegInt(record, [
    'certifiedCount', 'certified', 'completedJobs', 'certCount',
  ]);
  const location = (record.location && typeof record.location === 'object' && !Array.isArray(record.location))
    ? record.location
    : null;
  const lat = location?.lat != null ? Number(location.lat) : Number(record.lat ?? record.latitude);
  const lng = location?.lng != null ? Number(location.lng) : Number(record.lng ?? record.longitude);
  const activeRaw = record.active;
  const active = typeof activeRaw === 'boolean'
    ? activeRaw
    : (typeof activeRaw === 'string'
      ? !['false', '0', 'inactive', 'deactivated', 'disabled'].includes(activeRaw.trim().toLowerCase())
      : null);
  const resolvedCode = yesoneVisible ? YESONE_RC_CODE : code;
  const resolvedName = yesoneVisible && !name ? YESONE_RC_NAME : name;
  return {
    code: resolvedCode,
    name: resolvedName,
    yesoneVisible,
    companyName: pickStr(record, ['companyName', 'name', 'rcName', 'officeName']) || resolvedName || null,
    contactPerson: pickStr(record, ['contactPerson', 'contact_person', 'contactName', 'person']) || null,
    username: pickStr(record, ['username', 'userName', 'login']) || null,
    place: pickStr(record, ['place', 'locality', 'town', 'taluk']) || null,
    address: pickStr(record, ['address', 'officeAddress']) || null,
    city: pickStr(record, ['city', 'district']) || null,
    district: pickStr(record, ['district', 'city']) || null,
    state: pickStr(record, ['state', 'region']) || null,
    pincode: pickStr(record, ['pincode', 'pin', 'zip']) || null,
    phone: pickStr(record, ['phone', 'mobile']) || null,
    email: pickStr(record, ['email']) || null,
    gstNumber: pickStr(record, ['gstNumber', 'gstin', 'gst']) || null,
    panCard: pickStr(record, ['panCard', 'pan', 'panNumber']) || null,
    zohoId: pickStr(record, ['zohoId', 'zoho_id', 'zohoCustomerId']) || null,
    certificationMethod: pickStr(record, ['certificationMethod', 'certMethod']) || null,
    laboratorySealIdentification: pickStr(record, [
      'laboratorySealIdentification', 'labSeal', 'sealId',
    ]) || null,
    standardWeightsCertNumber: pickStr(record, [
      'standardWeightsCertNumber', 'weightsCertNumber',
    ]) || null,
    standardWeightsCertDate: pickStr(record, [
      'standardWeightsCertDate', 'weightsCertDate',
    ]) || null,
    standardWeightsCertExpiry: pickStr(record, [
      'standardWeightsCertExpiry', 'weightsCertExpiry',
    ]) || null,
    logoUrl: pickStr(record, ['logoUrl', 'logo_url']) || null,
    status: pickStr(record, ['status']) || (active === false ? 'inactive' : null),
    ...(active != null ? { active } : {}),
    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { location: { lat, lng } } : {}),
    ...(vctCount != null ? { vctCount } : {}),
    ...(jobsCount != null ? { jobsCount } : {}),
    ...(certifiedCount != null
      ? { certifiedCount }
      : (ovCount != null ? { certifiedCount: ovCount } : {})),
    ...(ovCount != null ? { ovCount } : {}),
    ...(linkedCount != null && linkedCount > 0 ? { linkedCount } : {}),
    ...(quotaAllotted != null ? { quotaAllotted } : {}),
    ...(quotaUsed != null ? { quotaUsed } : {}),
    ...(quotaBalance != null ? { quotaBalance } : {}),
    ...(ovCount != null || linkedCount != null || quotaUsed != null
      ? { ovSyncedAt: FieldValue.serverTimestamp() }
      : {}),
    raw: rawForStore(record),
    receivedAt: FieldValue.serverTimestamp(),
    source: 'yesgatc',
    docKey: sanitizeId(
      (idHint && !isUuidLike(idHint) ? idHint : '')
      || resolvedCode
      || resolvedName
      || randomUUID(),
    ),
  };
}

async function commitChunks(writes) {
  const db = getFirestore();
  let written = 0;
  for (let i = 0; i < writes.length; i += MAX_BATCH) {
    const chunk = writes.slice(i, i + MAX_BATCH);
    const batch = db.batch();
    for (const row of chunk) {
      batch.set(db.doc(row.path), row.data, { merge: true });
    }
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

export function readProvidedSecret(req) {
  const header = String(
    req.get?.('x-yesgatc-secret')
    || req.get?.('x-webhook-secret')
    || req.get?.('x-yesweigh-secret')
    || '',
  ).trim();
  const auth = String(req.get?.('authorization') ?? '').trim();
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const query = String(req.query?.key ?? req.query?.secret ?? '').trim();
  const bodySecret = (req.body && typeof req.body === 'object')
    ? String(req.body.secret ?? req.body.key ?? '').trim()
    : '';
  return header || bearer || query || bodySecret;
}

export async function loadWebhookSecret() {
  const snap = await getFirestore().doc(YESGATC_WEBHOOK_SETTINGS_DOC).get();
  return String(snap.data()?.secret ?? '').trim();
}

async function remapRcWritePaths(writes) {
  const db = getFirestore();
  let catalog = null;
  const loadCatalog = async () => {
    if (catalog) return catalog;
    const snap = await db.collection(YESGATC_RC_DETAILS).get();
    catalog = snap.docs;
    return catalog;
  };
  const out = [];
  for (const row of writes) {
    if (!String(row.path || '').startsWith(`${YESGATC_RC_DETAILS}/`)) {
      out.push(row);
      continue;
    }
    const existing = await db.doc(row.path).get();
    if (existing.exists) {
      out.push(row);
      continue;
    }
    const code = realRcIdentity(row.data?.code);
    const name = realRcIdentity(row.data?.name);
    const wantedName = compactRcName(name);
    const matches = (await loadCatalog()).filter(docSnap => {
      const data = docSnap.data() || {};
      if (code && realRcIdentity(data.code).toUpperCase() === code.toUpperCase()) return true;
      return Boolean(wantedName && compactRcName(data.name) === wantedName);
    });
    if (matches.length) {
      for (const docSnap of matches) {
        const patch = { ...row.data };
        if (docSnap.data()?.name && !name) delete patch.name;
        if (docSnap.data()?.code && !code) delete patch.code;
        out.push({ path: `${YESGATC_RC_DETAILS}/${docSnap.id}`, data: patch });
      }
      continue;
    }
    if (!code && !name) {
      continue;
    }
    out.push(row);
  }
  return out;
}

export function isYesgatcVerificationDeletedEvent(body) {
  const event = pickStr(body, ['event', 'type', 'kind']).toLowerCase();
  return event === 'verification.deleted' || event === 'certificate.deleted';
}

async function deleteYesgatcVerification(body) {
  const cert = (body?.certificate && typeof body.certificate === 'object' && !Array.isArray(body.certificate))
    ? body.certificate
    : {};
  const idHint = pickStr(cert, ['id', 'docId', '_id']) || pickStr(body, ['id']);
  const serialNumber = pickStr(cert, ['serialNumber', 'serial'])
    || pickStr(body, ['serialNumber', 'serial']);
  const docKey = sanitizeId(idHint || serialNumber);
  const db = getFirestore();
  if (docKey) {
    await db.collection(YESGATC_CERTIFICATES).doc(docKey).delete();
  }
  let unmarked = 0;
  if (serialNumber) {
    try {
      const { unmarkSerialUnitsUsed } = await import('./serial-units.js');
      unmarked = Number((await unmarkSerialUnitsUsed([serialNumber]))?.updated) || 0;
    } catch (err) {
      console.warn('serialUnits used unmark failed:', err?.message ?? err);
    }
  }
  const quota = (body?.quota && typeof body.quota === 'object' && !Array.isArray(body.quota))
    ? body.quota
    : null;
  const rc = (body?.rc && typeof body.rc === 'object' && !Array.isArray(body.rc))
    ? body.rc
    : null;
  let rcWritten = 0;
  if (rc || quota) {
    const merged = {
      ...(rc || {}),
      ...(quota || {}),
      used: quota?.used ?? quota?.ovQuotaUsed ?? rc?.ovUsed ?? rc?.ovQuotaUsed,
      ov: quota?.used ?? quota?.ovDone ?? rc?.ovUsed,
      allotted: quota?.allotted ?? rc?.ovQuota,
      balance: quota?.balance ?? rc?.ovBalance,
    };
    const data = normalizeRc(merged);
    const { docKey: rcKey, ...rest } = data;
    if (rcKey) {
      await db.collection(YESGATC_RC_DETAILS).doc(rcKey).set(rest, { merge: true });
      rcWritten = 1;
    }
  }
  return {
    ok: true,
    deleted: true,
    certificates: 0,
    rcDetails: rcWritten,
    written: rcWritten + (docKey ? 1 : 0),
    certificateId: docKey || null,
    serialNumber: serialNumber || null,
    serialsUnmarked: unmarked,
  };
}

export async function handleYesgatcPush(body) {
  if (isYesgatcVerificationDeletedEvent(body)) {
    return deleteYesgatcVerification(body);
  }
  const { certificates, rcDetails } = collectRecords(body);
  const writes = [
    ...certificates.map(record => {
      const data = normalizeCertificate(record);
      const { docKey, ...rest } = data;
      return { path: `${YESGATC_CERTIFICATES}/${docKey}`, data: rest };
    }),
    ...rcDetails.map(record => {
      const data = normalizeRc(record);
      const { docKey, ...rest } = data;
      return { path: `${YESGATC_RC_DETAILS}/${docKey}`, data: rest };
    }),
  ];
  const remapped = await remapRcWritePaths(writes);
  let outgoing = remapped;
  if (certificates.length) {
    try {
      const { attachInvoiceFieldsToCertificateWrites } = await import('./yesgatc-invoice-link.js');
      outgoing = await attachInvoiceFieldsToCertificateWrites(remapped);
    } catch (err) {
      console.warn('YesGATC invoice link attach failed:', err?.message ?? err);
    }
    try {
      const { attachOvQtyInvoiceToCertificateWrites } = await import('./yesgatc-ov-invoice-qty-link.js');
      outgoing = await attachOvQtyInvoiceToCertificateWrites(outgoing);
    } catch (err) {
      console.warn('YesGATC OV qty invoice attach failed:', err?.message ?? err);
    }
  }
  const written = await commitChunks(outgoing);
  const usedSerials = certificates
    .map(record => String(normalizeCertificate(record).serialNumber ?? '').trim())
    .filter(Boolean);
  if (usedSerials.length) {
    try {
      const { markSerialUnitsUsed } = await import('./serial-units.js');
      await markSerialUnitsUsed(usedSerials);
    } catch (err) {
      console.warn('serialUnits used mark failed:', err?.message ?? err);
    }
  }
  return {
    ok: true,
    certificates: certificates.length,
    rcDetails: rcDetails.length,
    written,
  };
}

export function applyCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-YesGatc-Secret, X-Webhook-Secret');
}

const DEST_URL = 'https://yesweigh-service.web.app/webhooks/yesgatc';
export const YESONE_RC_CODE = 'IWP';
export const YESONE_RC_NAME = 'INTERWEIGHING PVT LTD';

function normCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function rcFieldsFromRecord(record) {
  if (!record || typeof record !== 'object') return { code: '', name: '' };
  const nested = [record.rcOffice, record.regionalCenter, record.rcDetail, record.rc_office]
    .find(item => item && typeof item === 'object' && !Array.isArray(item));
  const rcObject = (record.rc && typeof record.rc === 'object' && !Array.isArray(record.rc))
    ? record.rc
    : null;
  const code = pickStr(record, [
    'rcCode', 'rc_code', 'rcNumber', 'rc_number', 'rcId', 'officeCode', 'rcOfficeCode',
  ]) || (typeof record.rc === 'string' ? String(record.rc).trim() : '')
    || pickStr(rcObject, ['code', 'rcCode', 'id'])
    || pickStr(nested, ['code', 'rcCode', 'id']);
  const name = pickStr(record, [
    'rcName', 'rc_name', 'officeName', 'rcOfficeName', 'regionalCenterName',
  ]) || pickStr(rcObject, ['name', 'rcName', 'title'])
    || pickStr(nested, ['name', 'rcName', 'title']);
  return { code, name };
}

export function isYesoneIwpRc({ code, name, raw } = {}) {
  if (isIwpCode(code) || isIwpName(name)) return true;
  if (raw && typeof raw === 'object') {
    const nested = rcFieldsFromRecord(raw);
    if (isIwpCode(nested.code) || isIwpName(nested.name)) return true;
    if (isIwpName(pickStr(raw, ['issuedBy', 'issued_by', 'office', 'rcOfficeName']))) return true;
  }
  return false;
}

function isIwpCode(value) {
  const code = normCode(value);
  return code === YESONE_RC_CODE || code.startsWith(`${YESONE_RC_CODE}/`) || code.startsWith(`${YESONE_RC_CODE}-`);
}

function isIwpName(value) {
  const compact = normName(value).replace(/[\s\-_]/g, '');
  return compact === 'INTERWEIGHINGPVTLTD' || compact.includes('INTERWEIGHING');
}

function webhookSettingsFromSecret(secret) {
  return {
    secret,
    destinationUrl: DEST_URL,
    pasteUrl: `${DEST_URL}?key=${encodeURIComponent(secret)}`,
  };
}

function isoFromAdmin(value) {
  if (value == null) return null;
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  const text = String(value).trim();
  return text || null;
}

export async function ensureWebhookSettings(actorName, { rotate = false } = {}) {
  const ref = getFirestore().doc(YESGATC_WEBHOOK_SETTINGS_DOC);
  const snap = await ref.get();
  const existing = String(snap.data()?.secret ?? '').trim();
  if (existing && !rotate) return webhookSettingsFromSecret(existing);
  const secret = randomBytes(24).toString('hex');
  await ref.set({
    secret,
    destinationUrl: DEST_URL,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actorName || 'YESWEIGH',
  }, { merge: true });
  return webhookSettingsFromSecret(secret);
}

function mapCertificateDoc(row) {
  const data = row.data() || {};
  return {
    id: row.id,
    certificateNumber: String(data.certificateNumber ?? ''),
    serialNumber: String(data.serialNumber ?? ''),
    dealerName: String(data.dealerName ?? ''),
    dealerId: data.dealerId != null ? String(data.dealerId) : null,
    productName: String(data.productName ?? ''),
    sku: data.sku != null ? String(data.sku) : null,
    rcCode: data.rcCode != null ? String(data.rcCode) : null,
    rcName: data.rcName != null ? String(data.rcName) : null,
    yesoneVisible: data.yesoneVisible === true,
    status: data.status != null
      ? String(data.status)
      : (data.signed === true || data.isSigned === true ? 'signed' : null),
    issuedAt: data.issuedAt != null ? String(data.issuedAt) : null,
    pdfUrl: data.pdfUrl != null ? String(data.pdfUrl) : null,
    max: data.max != null ? String(data.max) : '',
    min: data.min != null ? String(data.min) : '',
    e: data.e != null ? String(data.e) : '',
    receivedAt: isoFromAdmin(data.receivedAt),
    invoiceId: data.invoiceId != null ? String(data.invoiceId) : null,
    invoiceNumber: data.invoiceNumber != null ? String(data.invoiceNumber) : null,
    invoiceDate: data.invoiceDate != null ? String(data.invoiceDate) : null,
    invoiceCustomerId: data.invoiceCustomerId != null ? String(data.invoiceCustomerId) : null,
    verificationType: data.verificationType != null
      ? String(data.verificationType)
      : (data.raw && typeof data.raw === 'object' && data.raw.verificationType != null
        ? String(data.raw.verificationType)
        : null),
    raw: data.raw ?? null,
  };
}

function nullableStr(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function mapRcDoc(row) {
  const data = row.data() || {};
  const raw = (data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw))
    ? data.raw
    : null;
  const code = String(data.code ?? raw?.rcCode ?? raw?.code ?? '');
  const name = String(data.name ?? data.companyName ?? '')
    || String(raw?.companyName ?? raw?.name ?? '')
    || (isIwpCode(code) || isIwpName(data.name) || isIwpName(data.companyName) ? YESONE_RC_NAME : '');
  return {
    id: row.id,
    code,
    name,
    yesoneVisible: data.yesoneVisible === true,
    companyName: nullableStr(data.companyName) || nullableStr(raw?.companyName) || name || null,
    contactPerson: nullableStr(data.contactPerson) || nullableStr(raw?.contactPerson),
    username: nullableStr(data.username) || nullableStr(raw?.username),
    place: nullableStr(data.place) || nullableStr(raw?.place),
    address: nullableStr(data.address) || nullableStr(raw?.address),
    city: nullableStr(data.city) || nullableStr(raw?.city) || nullableStr(raw?.district),
    district: nullableStr(data.district) || nullableStr(raw?.district) || nullableStr(data.city),
    state: nullableStr(data.state) || nullableStr(raw?.state),
    pincode: nullableStr(data.pincode) || nullableStr(raw?.pincode),
    phone: nullableStr(data.phone) || nullableStr(raw?.phone),
    email: nullableStr(data.email) || nullableStr(raw?.email),
    gstNumber: nullableStr(data.gstNumber) || nullableStr(raw?.gstNumber),
    panCard: nullableStr(data.panCard) || nullableStr(raw?.panCard),
    zohoId: nullableStr(data.zohoId) || nullableStr(raw?.zohoId),
    certificationMethod: nullableStr(data.certificationMethod)
      || nullableStr(raw?.certificationMethod),
    laboratorySealIdentification: nullableStr(data.laboratorySealIdentification)
      || nullableStr(raw?.laboratorySealIdentification),
    standardWeightsCertNumber: nullableStr(data.standardWeightsCertNumber)
      || nullableStr(raw?.standardWeightsCertNumber),
    standardWeightsCertDate: nullableStr(data.standardWeightsCertDate)
      || nullableStr(raw?.standardWeightsCertDate),
    standardWeightsCertExpiry: nullableStr(data.standardWeightsCertExpiry)
      || nullableStr(raw?.standardWeightsCertExpiry),
    logoUrl: nullableStr(data.logoUrl) || nullableStr(raw?.logoUrl),
    status: nullableStr(data.status) || nullableStr(raw?.status),
    active: typeof data.active === 'boolean'
      ? data.active
      : (typeof raw?.active === 'boolean' ? raw.active : null),
    location: (data.location && typeof data.location === 'object')
      ? data.location
      : ((raw?.location && typeof raw.location === 'object') ? raw.location : null),
    vctCount: nullableInt(data.vctCount) ?? nullableInt(raw?.vctCount),
    jobsCount: nullableInt(data.jobsCount) ?? nullableInt(raw?.jobsCount),
    certifiedCount: nullableInt(data.certifiedCount)
      ?? nullableInt(raw?.certifiedCount)
      ?? nullableInt(data.ovCount),
    ovCount: nullableInt(data.ovCount),
    linkedCount: nullableInt(data.linkedCount),
    quotaAllotted: nullableInt(data.quotaAllotted),
    quotaUsed: nullableInt(data.quotaUsed),
    quotaBalance: nullableInt(data.quotaBalance),
    dealerId: nullableStr(data.dealerId),
    dealerName: nullableStr(data.dealerName),
    receivedAt: isoFromAdmin(data.receivedAt),
    raw: data.raw ?? null,
  };
}

/** Super Admin create / update of a mirrored RC detail document. */
export async function upsertRcDetailForOps(input = {}, { create = false } = {}) {
  const db = getFirestore();
  const payload = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const existingId = String(payload.id || '').trim();
  if (!create && !existingId) {
    throw new Error('RC id is required.');
  }
  const normalized = normalizeRc({
    ...payload,
    id: existingId || payload.code || payload.rcCode || undefined,
  });
  const { docKey, receivedAt, ...rest } = normalized;
  const id = create
    ? sanitizeId(existingId || docKey || rest.code || rest.name || randomUUID())
    : sanitizeId(existingId);
  if (!rest.code && !rest.name && !rest.companyName) {
    throw new Error('RC code or company name is required.');
  }
  const patch = {
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
    // Ops/admin saves always mark manual — normalizeRc hardcodes source yesgatc.
    source: 'manual',
  };
  if (create) {
    patch.createdAt = FieldValue.serverTimestamp();
    patch.receivedAt = FieldValue.serverTimestamp();
  }
  await db.collection(YESGATC_RC_DETAILS).doc(id).set(patch, { merge: true });
  const snap = await db.collection(YESGATC_RC_DETAILS).doc(id).get();
  return mapRcDoc(snap);
}

/** Rematerialize top-level fields from stored YesGATC `raw` payloads. */
export async function rematerializeRcDetailsFromRaw(max = 500) {
  const db = getFirestore();
  const snap = await db.collection(YESGATC_RC_DETAILS).limit(Math.min(500, Math.max(1, Number(max) || 500))).get();
  let updated = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const raw = (data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw))
      ? data.raw
      : null;
    if (!raw) continue;
    const { docKey, receivedAt, raw: _raw, source, ...fields } = normalizeRc({
      ...raw,
      id: docSnap.id,
      code: data.code || raw.rcCode || raw.code,
      ov: data.ovCount ?? raw.ov ?? raw.ovUsed,
      linked: data.linkedCount ?? raw.linked,
      allotted: data.quotaAllotted ?? raw.ovQuota ?? raw.allotted,
      used: data.quotaUsed ?? raw.ovUsed ?? raw.used,
      balance: data.quotaBalance ?? raw.ovBalance ?? raw.balance,
      dealerId: data.dealerId,
      dealerName: data.dealerName,
    });
    await docSnap.ref.set({
      ...fields,
      rematerializedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    updated += 1;
  }
  return { ok: true, scanned: snap.size, updated };
}

async function paginateQuery(queryBase, pageSize = 500) {
  const docs = [];
  let last = null;
  for (;;) {
    let q = queryBase.limit(pageSize);
    if (last) q = queryBase.startAfter(last).limit(pageSize);
    const snap = await q.get();
    if (snap.empty) break;
    docs.push(...snap.docs);
    if (snap.size < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return docs;
}

async function listCollection(name, mapFn, max = 400) {
  const col = getFirestore().collection(name);
  try {
    const snap = await col.orderBy('receivedAt', 'desc').limit(max).get();
    return snap.docs.map(mapFn);
  } catch {
    const snap = await col.limit(max).get();
    return snap.docs.map(mapFn);
  }
}

function publicCertificateRow(row) {
  const { raw, ...rest } = row;
  return rest;
}

export function isYesoneIwpCertificateRow(row) {
  return isYesoneIwpRc({
    code: row?.rcCode ?? row?.code,
    name: row?.rcName ?? row?.name,
    raw: row?.raw,
  });
}

function verificationKindFromCert(row) {
  const raw = row?.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw : null;
  const text = String(
    row?.verificationType
    || raw?.verificationType
    || raw?.verification_type
    || '',
  ).trim().toUpperCase();
  if (!text) return null;
  if (text === 'OV' || text.startsWith('ORIGINAL')) return 'OV';
  if (text === 'RV' || text.startsWith('RE')) return 'RV';
  return null;
}

function certificateRcKeysFromRow(row) {
  const keys = new Set();
  const add = (value) => {
    const text = String(value ?? '').trim().toUpperCase();
    if (text) keys.add(text);
  };
  const raw = row?.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw : null;
  const nested = raw && (raw.rc || raw.rcOffice || raw.regionalCenter);
  const nestedRc = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : null;
  add(row?.rcCode);
  add(row?.rcId);
  add(raw?.rcId);
  add(raw?.rcCode);
  add(nestedRc?.id);
  add(nestedRc?.code);
  add(nestedRc?.rcCode);
  if (row?.yesoneVisible === true || isYesoneIwpCertificateRow(row)) keys.add(YESONE_RC_CODE);
  return [...keys];
}

export async function listCertificatesForOps(max = 10000, filter = {}) {
  const cap = Math.min(20000, Math.max(1, Number(max) || 10000));
  const rcId = String(filter.rcId ?? '').trim();
  const wanted = String(filter.rcCode ?? '').trim().toUpperCase();
  const ovOnly = filter.ovOnly !== false;
  const col = getFirestore().collection(YESGATC_CERTIFICATES);
  let docs = [];
  try {
    docs = await paginateQuery(col.orderBy('receivedAt', 'desc'));
  } catch {
    docs = await paginateQuery(col);
  }
  const rows = [];
  const seen = new Set();
  for (const doc of docs) {
    if (seen.has(doc.id) || rows.length >= cap) break;
    if ((doc.data() || {}).voided === true) continue;
    seen.add(doc.id);
    rows.push(mapCertificateDoc(doc));
  }

  let rcCodeFromDoc = '';
  if (rcId) {
    const snap = await getFirestore().collection(YESGATC_RC_DETAILS).doc(rcId).get();
    rcCodeFromDoc = String(snap.data()?.code ?? '').trim().toUpperCase();
  }
  const wantedKeys = new Set([rcId.toUpperCase(), wanted, rcCodeFromDoc].filter(Boolean));
  const iwp = (!rcId && (!wanted || wanted === YESONE_RC_CODE))
    || wanted === YESONE_RC_CODE
    || rcId.toUpperCase() === YESONE_RC_CODE;

  return rows.filter(row => {
    if (ovOnly && verificationKindFromCert(row) !== 'OV') return false;
    if (!wantedKeys.size) return true;
    if (iwp) return isYesoneIwpCertificateRow(row);
    return certificateRcKeysFromRow(row).some(key => wantedKeys.has(key));
  }).map(publicCertificateRow);
}

export async function listRcDetailsForOps(max = 400) {
  const cap = Math.min(500, Math.max(1, Number(max) || 400));
  const pool = await listCollection(YESGATC_RC_DETAILS, mapRcDoc, cap);
  return pool.sort((a, b) => String(b.receivedAt ?? '').localeCompare(String(a.receivedAt ?? '')));
}
