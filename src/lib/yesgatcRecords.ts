import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app, db } from '../firebase';
import { getYesGatcRcOffice, getYesGatcRcOfficeBySourceRcId } from './yesgatcRcOffices';
import { firstDateTimeValue, isFreightInvoiceLineItem, isGatcFeeInvoiceLineItem, isSoftwareInvoiceLineItem, isStampingInvoiceLineItem, classifyInvoiceLineItem, isGenericSpareCategoryName } from './invoices';
import { lineIsMandatorySerialCategory } from './mandatorySerials';
import { fetchCatalogMetaForItemIds } from './invoiceLineItemImages';

export const YESGATC_CERTIFICATES = 'yesgatcCertificates';
export const YESGATC_RC_DETAILS = 'yesgatcRcDetails';
export const YESGATC_RC_DEALER_LINKS = 'yesgatcRcDealerLinks';
export const YESGATC_WEBHOOK_SETTINGS_ID = 'yesgatcWebhook';

export const YESGATC_WEBHOOK_URL = 'https://yesweigh-service.web.app/webhooks/yesgatc';
export const YESGATC_WEBHOOK_FUNCTION_URL =
  'https://asia-south1-yesweigh-service.cloudfunctions.net/yesgatcPushWebhook';

export const YESONE_RC_CODE = 'IWP';
export const YESONE_RC_NAME = 'INTERWEIGHING PVT LTD';
export const YESGATC_OV_MACHINE_HSN = ['84238190', '84238290', '84231000'] as const;
const WEIGHING_SCALE_HSN = new Set<string>(YESGATC_OV_MACHINE_HSN);
export const YESGATC_HSN_SOLD_MIN_DATE = '2026-02-01';

const functions = getFunctions(app, 'asia-south1');

export type YesGatcCertificate = {
  id: string;
  certificateNumber: string;
  serialNumber: string;
  dealerName: string;
  dealerId: string | null;
  productName: string;
  sku: string | null;
  rcCode: string | null;
  rcName: string | null;
  status: string | null;
  issuedAt: string | null;
  pdfUrl: string | null;
  receivedAt: string | null;
  yesoneVisible?: boolean;
  max: string;
  min: string;
  e: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  invoiceCustomerId: string | null;
  verificationType?: string | null;
  voided?: boolean;
  raw: unknown;
};

export type YesGatcRcDetail = {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  contactPerson: string | null;
  username: string | null;
  place: string | null;
  address: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  gstNumber: string | null;
  panCard: string | null;
  zohoId: string | null;
  certificationMethod: string | null;
  laboratorySealIdentification: string | null;
  standardWeightsCertNumber: string | null;
  standardWeightsCertDate: string | null;
  standardWeightsCertExpiry: string | null;
  logoUrl: string | null;
  status: string | null;
  active: boolean | null;
  location: { lat: number; lng: number } | null;
  receivedAt: string | null;
  dealerId: string | null;
  dealerName: string | null;
  vctCount: number | null;
  jobsCount: number | null;
  certifiedCount: number | null;
  /** OV done — last value YesGATC posted on the inbound webhook. */
  ovCount: number | null;
  linkedCount: number | null;
  quotaAllotted: number | null;
  quotaUsed: number | null;
  quotaBalance: number | null;
  raw: unknown;
};

export type YesGatcRcDetailInput = Partial<Omit<YesGatcRcDetail, 'raw' | 'receivedAt'>> & {
  id?: string;
  code?: string;
  name?: string;
  companyName?: string;
};

export type YesGatcWebhookSettings = {
  secret: string;
  destinationUrl: string;
  pasteUrl: string;
};

function isoFromUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'object' && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function nullable(value: unknown): string | null {
  const text = str(value);
  return text || null;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function webhookPasteUrl(secret: string): string {
  const key = secret.trim();
  if (!key) return YESGATC_WEBHOOK_URL;
  return `${YESGATC_WEBHOOK_URL}?key=${encodeURIComponent(key)}`;
}

export async function loadYesGatcWebhookSettings(): Promise<YesGatcWebhookSettings | null> {
  const snap = await getDoc(doc(db, 'appSettings', YESGATC_WEBHOOK_SETTINGS_ID));
  const secret = str(snap.data()?.secret);
  if (!secret) return null;
  return {
    secret,
    destinationUrl: YESGATC_WEBHOOK_URL,
    pasteUrl: webhookPasteUrl(secret),
  };
}

export async function saveYesGatcWebhookSecret(
  secret: string,
  actorName: string,
): Promise<YesGatcWebhookSettings> {
  const value = secret.trim();
  if (!value) throw new Error('Webhook secret is empty.');
  await setDoc(doc(db, 'appSettings', YESGATC_WEBHOOK_SETTINGS_ID), {
    secret: value,
    destinationUrl: YESGATC_WEBHOOK_URL,
    updatedAt: serverTimestamp(),
    updatedBy: actorName,
  }, { merge: true });
  return {
    secret: value,
    destinationUrl: YESGATC_WEBHOOK_URL,
    pasteUrl: webhookPasteUrl(value),
  };
}

export async function ensureYesGatcWebhookSettings(
  actorName: string,
): Promise<YesGatcWebhookSettings> {
  try {
    const fn = httpsCallable<{ actorName: string }, YesGatcWebhookSettings>(
      functions,
      'ensureYesGatcWebhookFn',
    );
    return (await fn({ actorName })).data;
  } catch {
    const existing = await loadYesGatcWebhookSettings();
    if (existing) return existing;
    return saveYesGatcWebhookSecret(generateWebhookSecret(), actorName);
  }
}

export async function rotateYesGatcWebhookSecret(
  actorName: string,
): Promise<YesGatcWebhookSettings> {
  try {
    const fn = httpsCallable<{ actorName: string }, YesGatcWebhookSettings>(
      functions,
      'rotateYesGatcWebhookFn',
    );
    return (await fn({ actorName })).data;
  } catch {
    return saveYesGatcWebhookSecret(generateWebhookSecret(), actorName);
  }
}

const MAX_SPEC_KEYS = new Set([
  'max', 'maxcapacity', 'maximum', 'maxload', 'maximumcapacity', 'maxcap', 'capmax',
  'maxkg', 'maxinkg', 'capacitykg', 'wmax',
]);
const MIN_SPEC_KEYS = new Set([
  'min', 'mincapacity', 'minimum', 'minload', 'minimumcapacity', 'mincap', 'capmin',
  'minkg', 'ming', 'mining', 'miningrams', 'minloadg', 'minvalue',
]);
const E_SPEC_KEYS = new Set([
  'e', 'evalue', 'verificationinterval', 'scaleinterval', 'intervale', 'einterval',
  'verificationscale', 'eidivision', 'eg', 'eing', 'eingrams', 'egram', 'egrams',
]);

function normSpecKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function specLeafText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const amount = record.value ?? record.val ?? record.amount ?? record.qty ?? record.reading;
  const unit = record.unit ?? record.uom ?? record.units ?? record.unitName;
  const amountText = amount == null ? '' : String(amount).trim();
  const unitText = unit == null ? '' : String(unit).trim();
  if (amountText && unitText) return `${amountText} ${unitText}`;
  return amountText;
}

function walkSpecValue(value: unknown, keys: Set<string>, depth = 0): string {
  if (value == null || depth > 6) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walkSpecValue(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const named = str(record.name || record.label || record.key || record.field);
  if (named && keys.has(normSpecKey(named))) {
    const fromName = specLeafText(record.value ?? record.val ?? record.reading) || specLeafText(record);
    if (fromName) return fromName;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (!keys.has(normSpecKey(key))) continue;
    const text = specLeafText(nested);
    if (text) return text;
  }
  for (const nested of Object.values(record)) {
    const found = walkSpecValue(nested, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function specsFromFreeText(text: string): { max: string; min: string; e: string } {
  const blob = text.replace(/\s+/g, ' ');
  const max = blob.match(/\bmax(?:imum)?(?:\s*capacity)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kg|g)?/i);
  const min = blob.match(/\bmin(?:imum)?(?:\s*capacity)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kg|g)?/i);
  const e = blob.match(/\be\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kg|g)?/i);
  return {
    max: max ? `${max[1]}${max[2] ? ` ${max[2].toLowerCase()}` : ''}` : '',
    min: min ? `${min[1]}${min[2] ? ` ${min[2].toLowerCase()}` : ''}` : '',
    e: e ? `${e[1]}${e[2] ? ` ${e[2].toLowerCase()}` : ''}` : '',
  };
}

function withSpecUnit(value: string, unit: 'kg' | 'g'): string {
  const text = value.trim();
  if (!text) return '';
  if (/\b(kgs?|gms?|grams?)\b/i.test(text)) {
    return text
      .replace(/\bkgs\b/i, 'kg')
      .replace(/\b(gms?|grams?)\b/i, 'g');
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  return `${text} ${unit}`;
}

export function yesGatcInstrumentSpecs(row: {
  max?: string | null;
  min?: string | null;
  e?: string | null;
  raw?: unknown;
  productName?: string | null;
} & Record<string, unknown>): { max: string; min: string; e: string } {
  const fromFields = {
    max: str(row.max) || str(row.maxCapacity) || str(row.Max),
    min: str(row.min) || str(row.minCapacity) || str(row.Min),
    e: str(row.e) || str(row.eValue) || str(row.E),
  };
  let max = fromFields.max || walkSpecValue(row, MAX_SPEC_KEYS) || walkSpecValue(row.raw, MAX_SPEC_KEYS);
  let min = fromFields.min || walkSpecValue(row, MIN_SPEC_KEYS) || walkSpecValue(row.raw, MIN_SPEC_KEYS);
  let e = fromFields.e || walkSpecValue(row, E_SPEC_KEYS) || walkSpecValue(row.raw, E_SPEC_KEYS);
  if (!max || !min || !e) {
    const fromText = specsFromFreeText([
      str(row.productName),
      typeof row.raw === 'string' ? row.raw : JSON.stringify(row.raw ?? ''),
    ].join(' '));
    max = max || fromText.max;
    min = min || fromText.min;
    e = e || fromText.e;
  }
  return {
    max: withSpecUnit(max, 'kg'),
    min: withSpecUnit(min, 'g'),
    e: withSpecUnit(e, 'g'),
  };
}

function withCertificateSpecs(row: YesGatcCertificate): YesGatcCertificate {
  const specs = yesGatcInstrumentSpecs(row);
  return { ...row, ...specs };
}

function certificateNumberParts(value: string): number[] {
  return String(value).split(/[^0-9]+/).filter(Boolean).map(part => Number(part));
}

export function compareYesGatcCertificateLatestFirst(a: YesGatcCertificate, b: YesGatcCertificate): number {
  const left = certificateNumberParts(a.certificateNumber);
  const right = certificateNumberParts(b.certificateNumber);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const av = left[index] ?? -1;
    const bv = right[index] ?? -1;
    if (av !== bv) return bv - av;
  }
  return String(b.receivedAt ?? '').localeCompare(String(a.receivedAt ?? ''));
}

function mapCertificate(id: string, data: Record<string, unknown>): YesGatcCertificate {
  const specs = yesGatcInstrumentSpecs(data);
  return {
    id,
    certificateNumber: str(data.certificateNumber),
    serialNumber: str(data.serialNumber),
    dealerName: str(data.dealerName),
    dealerId: nullable(data.dealerId),
    productName: str(data.productName),
    sku: nullable(data.sku),
    rcCode: nullable(data.rcCode),
    rcName: nullable(data.rcName),
    status: nullable(data.status)
      || (data.signed === true || data.isSigned === true ? 'signed' : null),
    issuedAt: nullable(data.issuedAt),
    pdfUrl: nullable(data.pdfUrl),
    receivedAt: isoFromUnknown(data.receivedAt),
    yesoneVisible: data.yesoneVisible === true,
    max: specs.max,
    min: specs.min,
    e: specs.e,
    invoiceId: nullable(data.invoiceId),
    invoiceNumber: nullable(data.invoiceNumber),
    invoiceDate: nullable(data.invoiceDate),
    invoiceCustomerId: nullable(data.invoiceCustomerId),
    verificationType: nullable(data.verificationType)
      || (data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
        ? nullable((data.raw as Record<string, unknown>).verificationType)
        : null),
    voided: data.voided === true
      || (data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
        ? (data.raw as Record<string, unknown>).voided === true
        : false),
    raw: data.raw ?? null,
  };
}

function isCodeLikeName(value: string, code: string): boolean {
  const compact = value.replace(/[\s.\-_]/g, '').toUpperCase();
  const codeCompact = code.replace(/[\s.\-_]/g, '').toUpperCase();
  if (!compact) return true;
  if (codeCompact && compact === codeCompact) return true;
  return compact.length <= 4 && /^[A-Z0-9]+$/.test(compact);
}

const RC_NAME_KEYS = [
  'name', 'rcName', 'rc_name', 'officeName', 'office_name', 'title',
  'company', 'companyName', 'company_name', 'firm', 'firmName', 'firm_name',
  'organisation', 'organization', 'orgName', 'legalName', 'displayName',
  'rcOfficeName', 'regionalCenterName', 'centreName', 'centerName',
];

function nameFromRecord(record: Record<string, unknown> | null | undefined, code: string): string {
  if (!record) return '';
  for (const key of RC_NAME_KEYS) {
    const text = str(record[key]);
    if (text && !isCodeLikeName(text, code)) return text;
  }
  return '';
}

function nameFromAddress(address: string, code: string): string {
  const text = address.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const first = text.split(',')[0]?.trim() ?? '';
  const company = first.split(/\s+(?:Room|No\.?|Nagar|Road|Rd\.?)\b/i)[0]?.trim() ?? '';
  if (
    company
    && company.length >= 4
    && !isCodeLikeName(company, code)
    && !/^\d/.test(company)
    && !/^(TC|PMC|DOOR|PLOT)\b/i.test(company)
  ) {
    return company;
  }
  return '';
}

function resolveRcFullName(
  code: string,
  data: Record<string, unknown>,
  raw: Record<string, unknown> | null,
  address: string | null,
): string {
  if (looksLikeIwpRc(code, str(data.name), raw)) return YESONE_RC_NAME;
  const nested = raw
    ? [raw.rc, raw.rcOffice, raw.regionalCenter, raw.rcDetail, raw.office]
      .find(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown> | undefined
    : undefined;
  return nameFromRecord(data, code)
    || nameFromRecord(raw, code)
    || nameFromRecord(nested, code)
    || nameFromAddress(address || str(raw?.address) || str(data.address), code);
}

function mapLocation(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const lat = Number(row.lat ?? row.latitude);
  const lng = Number(row.lng ?? row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function mapNullableInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function mapRc(id: string, data: Record<string, unknown>): YesGatcRcDetail {
  const raw = data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
    ? data.raw as Record<string, unknown>
    : null;
  const code = str(data.code) || str(raw?.code) || str(raw?.rcCode) || str(raw?.rc_code);
  const address = nullable(data.address) ?? nullable(raw?.address);
  const ovCount = mapNullableInt(data.ovCount);
  const companyName = nullable(data.companyName)
    ?? nullable(raw?.companyName)
    ?? null;
  return {
    id,
    code,
    name: resolveRcFullName(code, { ...data, name: data.name || companyName || data.companyName }, raw, address),
    companyName: companyName
      || resolveRcFullName(code, data, raw, address)
      || null,
    contactPerson: nullable(data.contactPerson) ?? nullable(raw?.contactPerson),
    username: nullable(data.username) ?? nullable(raw?.username),
    place: nullable(data.place) ?? nullable(raw?.place) ?? nullable(raw?.locality),
    address,
    city: nullable(data.city)
      ?? nullable(raw?.city)
      ?? nullable(raw?.district)
      ?? nullable(data.district),
    district: nullable(data.district) ?? nullable(raw?.district) ?? nullable(data.city),
    state: nullable(data.state) ?? nullable(raw?.state),
    pincode: nullable(data.pincode) ?? nullable(raw?.pincode),
    phone: nullable(data.phone) ?? nullable(raw?.phone) ?? nullable(raw?.mobile),
    email: nullable(data.email) ?? nullable(raw?.email),
    gstNumber: nullable(data.gstNumber) ?? nullable(raw?.gstNumber),
    panCard: nullable(data.panCard) ?? nullable(raw?.panCard),
    zohoId: nullable(data.zohoId) ?? nullable(raw?.zohoId),
    certificationMethod: nullable(data.certificationMethod) ?? nullable(raw?.certificationMethod),
    laboratorySealIdentification: nullable(data.laboratorySealIdentification)
      ?? nullable(raw?.laboratorySealIdentification),
    standardWeightsCertNumber: nullable(data.standardWeightsCertNumber)
      ?? nullable(raw?.standardWeightsCertNumber),
    standardWeightsCertDate: nullable(data.standardWeightsCertDate)
      ?? nullable(raw?.standardWeightsCertDate),
    standardWeightsCertExpiry: nullable(data.standardWeightsCertExpiry)
      ?? nullable(raw?.standardWeightsCertExpiry),
    logoUrl: nullable(data.logoUrl) ?? nullable(raw?.logoUrl),
    status: nullable(data.status) ?? nullable(raw?.status),
    active: typeof data.active === 'boolean'
      ? data.active
      : (typeof raw?.active === 'boolean' ? raw.active : null),
    location: mapLocation(data.location) ?? mapLocation(raw?.location),
    receivedAt: isoFromUnknown(data.receivedAt),
    dealerId: nullable(data.dealerId),
    dealerName: nullable(data.dealerName),
    vctCount: mapNullableInt(data.vctCount) ?? mapNullableInt(raw?.vctCount),
    jobsCount: mapNullableInt(data.jobsCount) ?? mapNullableInt(raw?.jobsCount),
    certifiedCount: mapNullableInt(data.certifiedCount)
      ?? mapNullableInt(raw?.certifiedCount)
      ?? ovCount,
    ovCount,
    linkedCount: mapNullableInt(data.linkedCount),
    quotaAllotted: mapNullableInt(data.quotaAllotted),
    quotaUsed: mapNullableInt(data.quotaUsed),
    quotaBalance: mapNullableInt(data.quotaBalance),
    raw: data.raw ?? null,
  };
}

function looksLikeIwpRc(code: string | null | undefined, name: string | null | undefined, raw: unknown): boolean {
  const compactCode = String(code ?? '').trim().toUpperCase();
  if (
    compactCode === YESONE_RC_CODE
    || compactCode.startsWith(`${YESONE_RC_CODE}/`)
    || compactCode.startsWith(`${YESONE_RC_CODE}-`)
  ) return true;
  const compactName = String(name ?? '').replace(/[\s\-_]+/g, '').trim().toUpperCase();
  if (compactName === 'INTERWEIGHINGPVTLTD' || compactName.includes('INTERWEIGHING')) return true;
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as Record<string, unknown>;
  const nested = [record.rc, record.rcOffice, record.regionalCenter, record.rcDetail]
    .find(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown> | undefined;
  const codeBits = [
    nested?.code, nested?.rcCode, record.rcCode, record.rc_code, record.officeCode,
    typeof record.rc === 'string' ? record.rc : null,
  ];
  if (codeBits.some((value) => {
    const next = String(value ?? '').trim().toUpperCase();
    return next === YESONE_RC_CODE || next.startsWith(`${YESONE_RC_CODE}/`) || next.startsWith(`${YESONE_RC_CODE}-`);
  })) return true;
  const nameBits = [
    nested?.name, nested?.rcName, record.rcName, record.rc_name, record.officeName,
    record.issuedBy, record.issued_by, record.office,
  ];
  return nameBits.some((value) => {
    const named = String(value ?? '').replace(/[\s\-_]+/g, '').trim().toUpperCase();
    return named === 'INTERWEIGHINGPVTLTD' || named.includes('INTERWEIGHING');
  });
}

export function isYesoneIwpCertificate(row: YesGatcCertificate): boolean {
  if (row.yesoneVisible === true) return true;
  return looksLikeIwpRc(row.rcCode, row.rcName, row.raw);
}

export function isYesoneIwpRcDetail(row: Pick<YesGatcRcDetail, 'code' | 'name' | 'raw'>): boolean {
  return looksLikeIwpRc(row.code, row.name, row.raw);
}

export function yesGatcRcKey(row: Pick<YesGatcRcDetail, 'id' | 'code'>): string {
  return str(row.code).toUpperCase() || row.id;
}

export function yesGatcRcOfficeName(row: YesGatcRcDetail): string {
  const named = str(row.name);
  if (named && !isCodeLikeName(named, row.code)) return named;
  if (isYesoneIwpRcDetail(row) || str(row.code).toUpperCase() === YESONE_RC_CODE) {
    return YESONE_RC_NAME;
  }
  return named || row.code || row.id;
}

function firstLocationValue(values: unknown[], skip: Set<string>): string {
  for (const value of values) {
    const text = str(value).replace(/\s+/g, ' ');
    if (!text || /^\d{5,6}$/.test(text)) continue;
    const key = text.toLowerCase();
    if (skip.has(key)) continue;
    return text;
  }
  return '';
}

function isStreetishLocation(text: string): boolean {
  return /^\d/.test(text)
    || /^(TC|PMC|DOOR|PLOT|ROOM|NO\.?|HNO|H\.?\s*NO)\b/i.test(text)
    || /\b(road|rd\.?|street|st\.?|lane)\b/i.test(text);
}

function placeFromAddress(address: string | null, skip: Set<string>): string {
  const parts = str(address).split(',').map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const part of parts) {
    if (part.length < 3 || isStreetishLocation(part)) continue;
    const key = part.toLowerCase();
    if (skip.has(key)) continue;
    return part;
  }
  return '';
}

function compactRcName(value: string): string {
  return value.replace(/[\s\-_.,&]+/g, '').toUpperCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_RE.test(String(value || '').trim());
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** Nameless UUID webhook leftovers — not a real RC office. */
export function isYesGatcRcPlaceholder(row: Pick<YesGatcRcDetail, 'id' | 'code' | 'name' | 'dealerId' | 'raw'>): boolean {
  const name = str(row.name);
  const code = str(row.code);
  const named = Boolean(name) && !isUuidLike(name) && !isCodeLikeName(name, code);
  const coded = Boolean(code) && !isUuidLike(code);
  if (named || coded || row.dealerId) return false;
  return isUuidLike(row.id) || isUuidLike(name) || isUuidLike(code);
}

/** Same office name / dealer — YesGATC often sends a name-only row plus a city row. */
export function yesGatcRcDedupeKey(row: YesGatcRcDetail): string {
  const name = compactRcName(yesGatcRcOfficeName(row));
  if (name) return `name:${name}`;
  const dealerId = str(row.dealerId);
  if (dealerId) return `dealer:${dealerId}`;
  const code = str(row.code).toUpperCase();
  if (code) return `code:${code}`;
  return `id:${row.id}`;
}

function rcDetailCompleteness(row: YesGatcRcDetail): number {
  let score = 0;
  if (yesGatcRcPlaceDistrictLine(row)) score += 8;
  if (row.city) score += 4;
  if (row.address) score += 2;
  if (row.dealerId) score += 1;
  if (row.code) score += 1;
  return score;
}

export function dedupeYesGatcRcDetails(rows: readonly YesGatcRcDetail[]): YesGatcRcDetail[] {
  const byKey = new Map<string, YesGatcRcDetail>();
  for (const row of rows) {
    if (isYesGatcRcPlaceholder(row)) continue;
    const key = yesGatcRcDedupeKey(row);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const winner = rcDetailCompleteness(row) > rcDetailCompleteness(prev) ? row : prev;
    const other = winner === row ? prev : row;
    byKey.set(key, {
      ...winner,
      ovCount: maxNullable(winner.ovCount, other.ovCount),
      linkedCount: maxNullable(winner.linkedCount, other.linkedCount),
      quotaAllotted: maxNullable(winner.quotaAllotted, other.quotaAllotted),
      quotaUsed: maxNullable(winner.quotaUsed, other.quotaUsed),
      quotaBalance: maxNullable(winner.quotaBalance, other.quotaBalance),
    });
  }
  return [...byKey.values()];
}

export function yesGatcRcGroupSiblings(
  row: YesGatcRcDetail,
  all: readonly YesGatcRcDetail[],
): YesGatcRcDetail[] {
  const key = yesGatcRcDedupeKey(row);
  return all.filter(item => yesGatcRcDedupeKey(item) === key);
}

export function yesGatcRcPlaceDistrictLine(row: YesGatcRcDetail): string {
  const raw = recordFromUnknown(row.raw);
  const nested = raw
    ? recordFromUnknown(raw.rc)
      || recordFromUnknown(raw.rcOffice)
      || recordFromUnknown(raw.regionalCenter)
      || recordFromUnknown(raw.rcDetail)
      || recordFromUnknown(raw.office)
    : null;
  const skip = new Set(
    [yesGatcRcOfficeName(row), row.state, raw?.state, nested?.state]
      .map(value => str(value).toLowerCase())
      .filter(Boolean),
  );
  const district = firstLocationValue([
    row.district,
    row.city,
    raw?.district,
    nested?.district,
    raw?.District,
    nested?.District,
    raw?.city,
    nested?.city,
  ], skip);
  if (district) skip.add(district.toLowerCase());
  const place = firstLocationValue([
    row.place,
    raw?.place,
    nested?.place,
    raw?.locality,
    nested?.locality,
    raw?.town,
    nested?.town,
    raw?.taluk,
    nested?.taluk,
    placeFromAddress(row.address ?? str(raw?.address), skip),
  ], skip);
  return [place, district].filter(Boolean).join(' · ');
}

export function yesGatcRcContactLabel(row: YesGatcRcDetail): string {
  return str(row.contactPerson) || str(row.username) || str(row.phone) || '';
}

export function yesGatcRcJobsCount(row: YesGatcRcDetail): number | null {
  return row.jobsCount ?? row.ovCount ?? row.certifiedCount ?? null;
}

export function yesGatcRcCertifiedCount(row: YesGatcRcDetail): number | null {
  return row.certifiedCount ?? row.ovCount ?? null;
}

export function yesGatcRcLabel(row: YesGatcRcDetail): string {
  return str(row.dealerName) || yesGatcRcOfficeName(row);
}

export function yesGatcCertificateRcDisplayName(
  row: YesGatcCertificate,
  rcs: ReadonlyArray<YesGatcRcDetail> = [],
): string {
  const match = rcs.find(rc => certificateMatchesRc(row, rc));
  if (match) return yesGatcRcOfficeName(match) || yesGatcRcLabel(match);
  return str(row.rcName);
}

export async function loadYesGatcInvoicePartyNames(
  rows: ReadonlyArray<Pick<YesGatcCertificate, 'id' | 'invoiceCustomerId' | 'invoiceId'>>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const customerCache = new Map<string, string>();
  await Promise.all(rows.map(async row => {
    const customerId = str(row.invoiceCustomerId);
    const invoiceId = str(row.invoiceId);
    if (!customerId) return;
    if (invoiceId) {
      const snap = await getDoc(doc(db, 'zohoCustomers', customerId, 'invoices', invoiceId));
      const fromInvoice = str(snap.data()?.customerName);
      if (fromInvoice) {
        names.set(row.id, fromInvoice);
        return;
      }
    }
    if (!customerCache.has(customerId)) {
      const snap = await getDoc(doc(db, 'zohoCustomers', customerId));
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      customerCache.set(
        customerId,
        str(data.companyName) || str(data.customerName) || str(data.contactName) || str(data.displayName),
      );
    }
    const name = customerCache.get(customerId) || '';
    if (name) names.set(row.id, name);
  }));
  return names;
}

export function withDefaultIwpRc(rows: YesGatcRcDetail[]): YesGatcRcDetail[] {
  const list = rows.map(row => (
    isYesoneIwpRcDetail(row) && !row.name
      ? { ...row, name: YESONE_RC_NAME }
      : row
  ));
  if (!list.some(isYesoneIwpRcDetail)) {
    list.unshift({
      id: YESONE_RC_CODE,
      code: YESONE_RC_CODE,
      name: YESONE_RC_NAME,
      companyName: YESONE_RC_NAME,
      contactPerson: null,
      username: null,
      place: null,
      address: null,
      city: null,
      district: null,
      state: null,
      pincode: null,
      phone: null,
      email: null,
      gstNumber: null,
      panCard: null,
      zohoId: null,
      certificationMethod: null,
      laboratorySealIdentification: null,
      standardWeightsCertNumber: null,
      standardWeightsCertDate: null,
      standardWeightsCertExpiry: null,
      logoUrl: null,
      status: null,
      active: true,
      location: null,
      receivedAt: null,
      dealerId: null,
      dealerName: null,
      vctCount: null,
      jobsCount: null,
      certifiedCount: null,
      ovCount: null,
      linkedCount: null,
      quotaAllotted: null,
      quotaUsed: null,
      quotaBalance: null,
      raw: null,
    });
  }
  return list.sort((a, b) => {
    const aIwp = isYesoneIwpRcDetail(a) ? 0 : 1;
    const bIwp = isYesoneIwpRcDetail(b) ? 0 : 1;
    if (aIwp !== bIwp) return aIwp - bIwp;
    return yesGatcRcLabel(a).localeCompare(yesGatcRcLabel(b), 'en', { sensitivity: 'base' });
  });
}

export function yesGatcCertificateRcKeys(
  row: Pick<YesGatcCertificate, 'rcCode' | 'rcName' | 'yesoneVisible' | 'raw'>,
): string[] {
  return certificateRcIndexKeys({
    rcCode: row.rcCode,
    rcName: row.rcName,
    yesoneVisible: row.yesoneVisible === true,
    raw: row.raw,
  });
}

export function isYesGatcOvCertificate(row: YesGatcCertificate): boolean {
  return yesGatcVerificationKind(row) === 'OV';
}

export function certificateMatchesRc(
  row: YesGatcCertificate,
  rc: string | Pick<YesGatcRcDetail, 'id' | 'code' | 'name' | 'raw'>,
): boolean {
  if (typeof rc === 'string') {
    const wanted = str(rc).toUpperCase() || YESONE_RC_CODE;
    if (wanted === YESONE_RC_CODE) return isYesoneIwpCertificate(row);
    return yesGatcCertificateRcKeys(row).includes(wanted);
  }
  if (isYesoneIwpRcDetail(rc) || str(rc.code).toUpperCase() === YESONE_RC_CODE) {
    return isYesoneIwpCertificate(row);
  }
  const wanted = new Set(
    [str(rc.id).toUpperCase(), str(rc.code).toUpperCase()].filter(Boolean),
  );
  return yesGatcCertificateRcKeys(row).some(key => wanted.has(key));
}

export type YesGatcVerificationKind = 'OV' | 'RV';
export type YesGatcOvRvTotals = { ov: number; rv: number; linked: number };

export function emptyYesGatcOvRvTotals(): YesGatcOvRvTotals {
  return { ov: 0, rv: 0, linked: 0 };
}

export function yesGatcVerificationKind(source: unknown): YesGatcVerificationKind | null {
  if (source == null) return null;
  let text = '';
  if (typeof source === 'string') text = source;
  else if (typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    const raw = record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw)
      ? record.raw as Record<string, unknown>
      : null;
    text = str(record.verificationType)
      || str(raw?.verificationType)
      || str(raw?.verification_type)
      || str(record.verification_type);
  }
  const upper = text.trim().toUpperCase();
  if (!upper) return null;
  if (upper === 'OV' || upper.startsWith('ORIGINAL')) return 'OV';
  if (upper === 'RV' || upper.startsWith('RE')) return 'RV';
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function certificateRcIndexKeys(data: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const text = str(value).toUpperCase();
    if (text) keys.add(text);
  };
  const raw = recordFromUnknown(data.raw);
  const nestedRc = recordFromUnknown(raw?.rc)
    || recordFromUnknown(raw?.rcOffice)
    || recordFromUnknown(raw?.regionalCenter);
  add(data.rcCode);
  add(data.rcId);
  add(raw?.rcId);
  add(raw?.rcCode);
  add(nestedRc?.id);
  add(nestedRc?.code);
  add(nestedRc?.rcCode);
  if (data.yesoneVisible === true || looksLikeIwpRc(str(data.rcCode), str(data.rcName), raw)) {
    keys.add(YESONE_RC_CODE);
  }
  return [...keys];
}

function isInvoiceLinkedCertificate(data: Record<string, unknown>): boolean {
  return Boolean(str(data.invoiceNumber) || str(data.invoiceId));
}

function isVoidedCertificate(data: Record<string, unknown>): boolean {
  if (data.voided === true) return true;
  const raw = recordFromUnknown(data.raw);
  return raw?.voided === true;
}

export function yesGatcOvRvForRc(
  totals: Map<string, YesGatcOvRvTotals>,
  rc: Pick<YesGatcRcDetail, 'id' | 'code' | 'name' | 'raw'>,
): YesGatcOvRvTotals {
  return totals.get(rc.id) ?? emptyYesGatcOvRvTotals();
}

export async function countYesGatcLifetimeOvRv(
  rcs: ReadonlyArray<YesGatcRcDetail>,
): Promise<Map<string, YesGatcOvRvTotals>> {
  const totals = new Map<string, YesGatcOvRvTotals>();
  for (const rc of rcs) {
    if (rc.ovCount != null) {
      totals.set(rc.id, {
        ov: rc.ovCount,
        rv: 0,
        linked: rc.linkedCount && rc.linkedCount > 0 ? rc.linkedCount : rc.ovCount,
      });
    } else {
      totals.set(rc.id, emptyYesGatcOvRvTotals());
    }
  }
  if (rcs.length === 0) return totals;
  const needCertificateCount = rcs.filter(rc => rc.ovCount == null);
  if (needCertificateCount.length === 0) return totals;

  const keyToRcIds = new Map<string, string[]>();
  for (const rc of needCertificateCount) {
    const keys = [rc.id, str(rc.code).toUpperCase()].filter(Boolean);
    if (isYesoneIwpRcDetail(rc)) keys.push(YESONE_RC_CODE);
    for (const key of keys) {
      const list = keyToRcIds.get(key) ?? [];
      if (!list.includes(rc.id)) list.push(rc.id);
      keyToRcIds.set(key, list);
    }
  }

  const col = collection(db, YESGATC_CERTIFICATES);
  const pageSize = 400;
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  for (;;) {
    const snap: QuerySnapshot<DocumentData> = await getDocs(
      cursor
        ? query(col, startAfter(cursor), limit(pageSize))
        : query(col, limit(pageSize)),
    );
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      if (isVoidedCertificate(data)) continue;
      const kind = yesGatcVerificationKind(data);
      if (kind !== 'OV') continue;
      const hit = new Set<string>();
      for (const key of certificateRcIndexKeys(data)) {
        for (const rcId of keyToRcIds.get(key) ?? []) hit.add(rcId);
      }
      for (const rcId of hit) {
        const slot = totals.get(rcId) ?? emptyYesGatcOvRvTotals();
        slot.ov += 1;
        if (isInvoiceLinkedCertificate(data)) slot.linked += 1;
        totals.set(rcId, slot);
      }
    }
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1] ?? null;
    if (!cursor) break;
  }
  return totals;
}

function hsnDigits(value: unknown): string {
  return str(value).replace(/\D/g, '');
}

function invoiceDateKey(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }
  const text = str(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return '';
}

function isVoidInvoice(data: Record<string, unknown>): boolean {
  const status = str(data.status).toLowerCase();
  return status === 'void' || status === 'cancelled' || status === 'canceled';
}

async function catalogHsnByItemIds(itemIds: Iterable<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set([...itemIds].map(id => str(id)).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const snaps = await Promise.all(chunk.map(id => getDoc(doc(db, 'catalogProducts', id))));
    snaps.forEach((snap, index) => {
      const hsn = hsnDigits(snap.data()?.hsn);
      if (hsn) map.set(chunk[index], hsn);
    });
  }
  return map;
}

async function sumDealerMachineQty(
  dealerId: string,
  minDate: string,
  wanted: Set<string>,
  pendingByItemId: Map<string, number>,
): Promise<number> {
  const pageSize = 400;
  const col = collection(db, 'zohoCustomers', dealerId, 'invoices');
  const loadPage = async (
    filterByDate: boolean,
    cursor: QueryDocumentSnapshot<DocumentData> | null,
  ) => getDocs(
    filterByDate
      ? (cursor
        ? query(col, where('date', '>=', minDate), orderBy('date', 'desc'), startAfter(cursor), limit(pageSize))
        : query(col, where('date', '>=', minDate), orderBy('date', 'desc'), limit(pageSize)))
      : (cursor
        ? query(col, startAfter(cursor), limit(pageSize))
        : query(col, limit(pageSize))),
  );

  let qty = 0;
  const addLines = (data: Record<string, unknown>) => {
    if (isVoidInvoice(data)) return;
    const date = invoiceDateKey(data.date);
    if (!date || date < minDate) return;
    const lines = Array.isArray(data.lineItems)
      ? data.lineItems
      : (Array.isArray(data.line_items) ? data.line_items : []);
    for (const raw of lines) {
      if (!raw || typeof raw !== 'object') continue;
      const line = raw as Record<string, unknown>;
      const lineQty = Number(line.quantity ?? 0);
      if (!Number.isFinite(lineQty) || lineQty <= 0) continue;
      const hsn = hsnDigits(line.hsn ?? line.hsnOrSac ?? line.hsn_or_sac);
      if (wanted.has(hsn)) {
        qty += Math.round(lineQty);
        continue;
      }
      if (hsn) continue;
      const itemId = str(line.itemId ?? line.item_id);
      if (!itemId) continue;
      pendingByItemId.set(itemId, (pendingByItemId.get(itemId) || 0) + Math.round(lineQty));
    }
  };

  const scan = async (filterByDate: boolean) => {
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
    for (;;) {
      const snap: QuerySnapshot<DocumentData> = await loadPage(filterByDate, cursor);
      for (const docSnap of snap.docs) addLines(docSnap.data() as Record<string, unknown>);
      if (snap.size < pageSize) break;
      cursor = snap.docs[snap.docs.length - 1] ?? null;
      if (!cursor) break;
    }
  };

  try {
    await scan(true);
  } catch {
    qty = 0;
    pendingByItemId.clear();
    await scan(false);
  }
  return qty;
}

/**
 * Machine qty sold on each RC's linked dealer invoices from 1 Feb 2026
 * for HSN 84238190, 84238290, 84231000.
 */
export async function sumYesGatcRcHsnSoldQty(
  rcs: ReadonlyArray<Pick<YesGatcRcDetail, 'id' | 'dealerId'>>,
  minDate = YESGATC_HSN_SOLD_MIN_DATE,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const wanted = new Set<string>(YESGATC_OV_MACHINE_HSN);
  const pendingByRc = new Map<string, Map<string, number>>();
  for (const rc of rcs) {
    totals.set(rc.id, 0);
    pendingByRc.set(rc.id, new Map());
  }
  await Promise.all(rcs.map(async rc => {
    const dealerId = str(rc.dealerId);
    if (!dealerId) return;
    const pending = pendingByRc.get(rc.id) ?? new Map<string, number>();
    try {
      totals.set(rc.id, await sumDealerMachineQty(dealerId, minDate, wanted, pending));
      pendingByRc.set(rc.id, pending);
    } catch {
      totals.set(rc.id, 0);
    }
  }));
  const itemIds = new Set<string>();
  for (const pending of pendingByRc.values()) {
    for (const itemId of pending.keys()) itemIds.add(itemId);
  }
  if (itemIds.size) {
    const catalog = await catalogHsnByItemIds(itemIds);
    for (const [rcId, pending] of pendingByRc) {
      let extra = 0;
      for (const [itemId, qty] of pending) {
        if (wanted.has(catalog.get(itemId) || '')) extra += qty;
      }
      if (extra) totals.set(rcId, (totals.get(rcId) || 0) + extra);
    }
  }
  return totals;
}

async function loadCertificatesWhere(
  field: 'yesoneVisible' | 'rcCode' | null,
  value: string | boolean | null,
): Promise<YesGatcCertificate[]> {
  const col = collection(db, YESGATC_CERTIFICATES);
  const pageSize = 400;
  const rows: YesGatcCertificate[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  for (;;) {
    const snap: QuerySnapshot<DocumentData> = await getDocs(
      cursor
        ? (field
          ? query(col, where(field, '==', value), startAfter(cursor), limit(pageSize))
          : query(col, startAfter(cursor), limit(pageSize)))
        : (field
          ? query(col, where(field, '==', value), limit(pageSize))
          : query(col, limit(pageSize))),
    );
    rows.push(...snap.docs.map(docSnap => (
      mapCertificate(docSnap.id, docSnap.data() as Record<string, unknown>)
    )));
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1] ?? null;
    if (!cursor) break;
  }
  return rows;
}

export async function countYesGatcIwpCertificates(rcCode = YESONE_RC_CODE): Promise<number> {
  const col = collection(db, YESGATC_CERTIFICATES);
  const wanted = str(rcCode).toUpperCase() || YESONE_RC_CODE;
  const queries = wanted === YESONE_RC_CODE
    ? [
      getCountFromServer(query(col, where('yesoneVisible', '==', true))),
      getCountFromServer(query(col, where('rcCode', '==', YESONE_RC_CODE))),
    ]
    : [getCountFromServer(query(col, where('rcCode', '==', wanted)))];
  const counts = await Promise.allSettled(queries);
  let best = 0;
  for (const result of counts) {
    if (result.status === 'fulfilled') {
      best = Math.max(best, result.value.data().count);
    }
  }
  return best;
}

export async function listYesGatcCertificates(
  max = 10000,
  filter: { rcCode?: string; rcId?: string; ovOnly?: boolean } = {},
): Promise<YesGatcCertificate[]> {
  const rcId = str(filter.rcId);
  const rcCode = str(filter.rcCode).toUpperCase();
  const ovOnly = filter.ovOnly !== false;
  const iwp = (!rcId && !rcCode)
    || rcCode === YESONE_RC_CODE
    || rcId.toUpperCase() === YESONE_RC_CODE;
  const merge = new Map<string, YesGatcCertificate>();
  const take = (rows: YesGatcCertificate[]) => {
    for (const row of rows) {
      const next = withCertificateSpecs({
        ...row,
        invoiceId: row.invoiceId ?? null,
        invoiceNumber: row.invoiceNumber ?? null,
        invoiceDate: row.invoiceDate ?? null,
        invoiceCustomerId: row.invoiceCustomerId ?? null,
      });
      const prev = merge.get(row.id);
      if (!prev) {
        if (merge.size >= max) continue;
        merge.set(row.id, next);
        continue;
      }
      if (!prev.invoiceNumber && next.invoiceNumber) {
        merge.set(row.id, {
          ...prev,
          invoiceId: next.invoiceId,
          invoiceNumber: next.invoiceNumber,
          invoiceDate: next.invoiceDate,
          invoiceCustomerId: next.invoiceCustomerId,
        });
      }
    }
  };

  const matchesFilter = (row: YesGatcCertificate) => {
    if (row.voided) return false;
    if (ovOnly && !isYesGatcOvCertificate(row)) return false;
    if (iwp) return isYesoneIwpCertificate(row);
    return certificateMatchesRc(row, { id: rcId, code: rcCode, name: '', raw: null });
  };

  if (iwp) {
    try {
      take(await loadCertificatesWhere('yesoneVisible', true));
    } catch {
      // ignore
    }
    try {
      take(await loadCertificatesWhere('rcCode', YESONE_RC_CODE));
    } catch {
      // ignore
    }
  } else {
    if (rcId) {
      try {
        take(await loadCertificatesWhere('rcCode', rcId));
      } catch {
        // ignore
      }
    }
    if (rcCode && rcCode !== rcId.toUpperCase()) {
      try {
        take(await loadCertificatesWhere('rcCode', rcCode));
      } catch {
        // ignore
      }
    }
  }

  let matched = [...merge.values()].filter(matchesFilter);

  if (matched.length === 0) {
    try {
      take(await loadCertificatesWhere(null, null));
    } catch {
      // Rules missing — callable fallback below.
    }
    matched = [...merge.values()].filter(matchesFilter);
  }

  if (matched.length === 0) {
    try {
      const fn = httpsCallable<
        { max?: number; rcCode?: string; rcId?: string; ovOnly?: boolean },
        { rows: YesGatcCertificate[] }
      >(
        functions,
        'listYesGatcCertificatesFn',
      );
      take((await fn({ max, rcCode, rcId, ovOnly })).data.rows ?? []);
      matched = [...merge.values()].filter(matchesFilter);
    } catch {
      // Callable unavailable.
    }
  }

  return matched.sort(compareYesGatcCertificateLatestFirst);
}

export async function listYesGatcRcDetails(max = 400): Promise<YesGatcRcDetail[]> {
  const merge = new Map<string, YesGatcRcDetail>();
  const take = (rows: YesGatcRcDetail[]) => {
    for (const row of rows) {
      if (merge.size >= max || merge.has(row.id)) continue;
      merge.set(row.id, mapRc(row.id, row as unknown as Record<string, unknown>));
    }
  };

  try {
    const fn = httpsCallable<{ max?: number }, { rows: YesGatcRcDetail[] }>(
      functions,
      'listYesGatcRcDetailsFn',
    );
    take((await fn({ max })).data.rows ?? []);
  } catch {
    // Callable unavailable — Firestore reads still run.
  }

  const col = collection(db, YESGATC_RC_DETAILS);
  for (const next of [
    () => getDocs(query(col, limit(max))),
    () => getDocs(query(col, where('yesoneVisible', '==', true), limit(max))),
    () => getDocs(query(col, where('code', '==', YESONE_RC_CODE), limit(max))),
  ]) {
    try {
      const snap = await next();
      take(snap.docs.map(row => mapRc(row.id, row.data() as Record<string, unknown>)));
      if (merge.size > 1) break;
    } catch {
      // Rules or index missing — try the next query.
    }
  }

  const links = await listYesGatcRcDealerLinks().catch(
    () => new Map<string, { dealerId: string; dealerName: string }>(),
  );

  return dedupeYesGatcRcDetails(
    [...merge.values()].map(row => applyRcDealerLink(row, links)),
  ).sort((a, b) => yesGatcRcLabel(a).localeCompare(yesGatcRcLabel(b), 'en', { sensitivity: 'base' }));
}

function applyRcDealerLink(
  row: YesGatcRcDetail,
  links: Map<string, { dealerId: string; dealerName: string }>,
): YesGatcRcDetail {
  const link = links.get(row.id) ?? links.get(yesGatcRcKey(row));
  if (!link) return row;
  return {
    ...row,
    dealerId: link.dealerId,
    dealerName: link.dealerName,
  };
}

export async function listYesGatcRcDealerLinks(): Promise<Map<string, { dealerId: string; dealerName: string }>> {
  const snap = await getDocs(collection(db, YESGATC_RC_DEALER_LINKS));
  const links = new Map<string, { dealerId: string; dealerName: string }>();
  for (const row of snap.docs) {
    const data = row.data() as Record<string, unknown>;
    const dealerId = str(data.dealerId);
    const dealerName = str(data.dealerName);
    if (!dealerId || !dealerName) continue;
    links.set(row.id, { dealerId, dealerName });
    const code = str(data.rcCode).toUpperCase();
    if (code) links.set(code, { dealerId, dealerName });
  }
  return links;
}

export type YesGatcDealerRcLink = {
  rcId: string;
  rcCode: string;
  rcName: string;
};

/** Linked regional-center office for a Zoho customer. IWP (company) is not a dealer RC. */
export async function findYesGatcRcForDealer(
  dealerId: string,
): Promise<YesGatcDealerRcLink | null> {
  const cid = str(dealerId);
  if (!cid) return null;
  const snap = await getDocs(
    query(collection(db, YESGATC_RC_DEALER_LINKS), where('dealerId', '==', cid), limit(1)),
  );
  if (snap.empty) return null;
  const row = snap.docs[0];
  const data = row.data() as Record<string, unknown>;
  const rcSnap = await getDoc(doc(db, YESGATC_RC_DETAILS, row.id));
  const rc = rcSnap.exists()
    ? mapRc(row.id, rcSnap.data() as Record<string, unknown>)
    : null;
  if (rc && isYesoneIwpRcDetail(rc)) return null;
  const code = str(data.rcCode || rc?.code).toUpperCase();
  if (code === YESONE_RC_CODE) return null;
  const office = await getYesGatcRcOffice(code).catch(() => null)
    ?? await getYesGatcRcOfficeBySourceRcId(row.id).catch(() => null);
  if (!office) return null;
  return {
    rcId: office.sourceRcId || row.id,
    rcCode: office.code,
    rcName: office.name,
  };
}

export async function saveYesGatcRcDealerLink(
  rcId: string,
  rcCode: string,
  dealerId: string,
  dealerName: string,
): Promise<void> {
  const snap = await getDocs(collection(db, YESGATC_RC_DEALER_LINKS));
  for (const row of snap.docs) {
    if (row.id === rcId) continue;
    const data = row.data() as Record<string, unknown>;
    if (str(data.dealerId) === dealerId) {
      throw new Error('This dealer is already linked to another RC. One dealer can be used only once.');
    }
  }
  await setDoc(doc(db, YESGATC_RC_DEALER_LINKS, rcId), {
    rcCode,
    dealerId,
    dealerName,
    linkedAt: serverTimestamp(),
  });
}

export async function clearYesGatcRcDealerLink(rcId: string): Promise<void> {
  await deleteDoc(doc(db, YESGATC_RC_DEALER_LINKS, rcId));
}

function sanitizeRcDocId(raw: string): string {
  return String(raw || '').trim().replace(/[/\\]+/g, '_').slice(0, 700);
}

async function saveYesGatcRcDetailLocal(
  input: YesGatcRcDetailInput,
  options: { create?: boolean } = {},
): Promise<YesGatcRcDetail> {
  const create = options.create === true;
  const companyName = str(input.companyName) || str(input.name);
  const code = str(input.code).toUpperCase();
  if (!companyName && !code) throw new Error('RC code or company name is required.');
  const id = sanitizeRcDocId(
    create
      ? (str(input.id) || code || companyName || `rc-${Date.now()}`)
      : str(input.id),
  );
  if (!id) throw new Error('RC id is required.');
  const patch: Record<string, unknown> = {
    code,
    name: companyName || code,
    companyName: companyName || code || null,
    contactPerson: nullable(input.contactPerson),
    place: nullable(input.place),
    address: nullable(input.address),
    city: nullable(input.city),
    district: nullable(input.district) ?? nullable(input.city),
    state: nullable(input.state),
    pincode: nullable(input.pincode),
    phone: nullable(input.phone),
    email: nullable(input.email),
    gstNumber: nullable(input.gstNumber),
    panCard: nullable(input.panCard),
    zohoId: nullable(input.zohoId),
    certificationMethod: nullable(input.certificationMethod),
    laboratorySealIdentification: nullable(input.laboratorySealIdentification),
    status: nullable(input.status),
    active: input.active !== false,
    vctCount: input.vctCount ?? null,
    jobsCount: input.jobsCount ?? null,
    certifiedCount: input.certifiedCount ?? null,
    source: 'manual',
    updatedAt: serverTimestamp(),
  };
  if (create) {
    patch.receivedAt = serverTimestamp();
    patch.createdAt = serverTimestamp();
  }
  await setDoc(doc(db, YESGATC_RC_DETAILS, id), patch, { merge: true });
  const snap = await getDoc(doc(db, YESGATC_RC_DETAILS, id));
  return mapRc(id, (snap.data() || {}) as Record<string, unknown>);
}

export async function saveYesGatcRcDetail(
  input: YesGatcRcDetailInput,
  options: { create?: boolean } = {},
): Promise<YesGatcRcDetail> {
  try {
    const fn = httpsCallable<
      { rc: YesGatcRcDetailInput; create?: boolean },
      { ok: boolean; row: YesGatcRcDetail }
    >(functions, 'saveYesGatcRcDetailFn');
    const res = await fn({ rc: input, create: options.create === true });
    const row = res.data.row;
    if (!row?.id) throw new Error('RC save did not return a record.');
    return mapRc(row.id, row as unknown as Record<string, unknown>);
  } catch {
    return saveYesGatcRcDetailLocal(input, options);
  }
}

export async function rematerializeYesGatcRcDetails(max = 500): Promise<{ scanned: number; updated: number }> {
  try {
    const fn = httpsCallable<{ max?: number }, { scanned: number; updated: number }>(
      functions,
      'rematerializeYesGatcRcDetailsFn',
    );
    const res = await fn({ max });
    return {
      scanned: Number(res.data.scanned) || 0,
      updated: Number(res.data.updated) || 0,
    };
  } catch {
    // Callable not deployed yet — rematerialize client-side from raw blobs.
    const snap = await getDocs(query(
      collection(db, YESGATC_RC_DETAILS),
      limit(Math.min(500, Math.max(1, Number(max) || 500))),
    ));
    let updated = 0;
    for (const row of snap.docs) {
      const data = row.data() as Record<string, unknown>;
      const raw = data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
        ? data.raw as Record<string, unknown>
        : null;
      if (!raw) continue;
      const mapped = mapRc(row.id, { ...data, ...raw, raw });
      await setDoc(doc(db, YESGATC_RC_DETAILS, row.id), {
        companyName: mapped.companyName,
        contactPerson: mapped.contactPerson,
        place: mapped.place,
        address: mapped.address,
        city: mapped.city,
        district: mapped.district,
        state: mapped.state,
        pincode: mapped.pincode,
        phone: mapped.phone,
        email: mapped.email,
        gstNumber: mapped.gstNumber,
        panCard: mapped.panCard,
        zohoId: mapped.zohoId,
        certificationMethod: mapped.certificationMethod,
        laboratorySealIdentification: mapped.laboratorySealIdentification,
        standardWeightsCertNumber: mapped.standardWeightsCertNumber,
        standardWeightsCertDate: mapped.standardWeightsCertDate,
        standardWeightsCertExpiry: mapped.standardWeightsCertExpiry,
        logoUrl: mapped.logoUrl,
        status: mapped.status,
        active: mapped.active,
        location: mapped.location,
        vctCount: mapped.vctCount,
        jobsCount: mapped.jobsCount,
        certifiedCount: mapped.certifiedCount,
        rematerializedAt: serverTimestamp(),
      }, { merge: true });
      updated += 1;
    }
    return { scanned: snap.size, updated };
  }
}

export function formatYesGatcWhen(iso: string | null | undefined, compact = false): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', compact
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function firstDateText(value: unknown): string {
  const iso = isoFromUnknown(value);
  if (iso) return iso;
  const text = str(value);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function yesGatcCertifiedIso(row: YesGatcCertificate): string | null {
  const fromFields = firstDateText(row.issuedAt);
  if (fromFields) return fromFields;
  if (row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)) {
    const record = row.raw as Record<string, unknown>;
    const nested = firstDateText(
      record.issuedAt
      ?? record.issueDate
      ?? record.issued_on
      ?? record.certifiedAt
      ?? record.certificationDate
      ?? record.certifiedOn
      ?? record.dateOfCertification,
    );
    if (nested) return nested;
  }
  return firstDateText(row.receivedAt) || null;
}

export function yesGatcCertifiedTimeMs(row: YesGatcCertificate): number | null {
  const iso = yesGatcCertifiedIso(row);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function yesGatcCertifiedAt(row: YesGatcCertificate, compact = false): string {
  return formatYesGatcWhen(yesGatcCertifiedIso(row), compact);
}

function signedFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  if (/\b(un|not[-_ ]?)signed\b/.test(text)) return false;
  return text === 'true' || text === 'yes' || text === '1' || /\bsigned\b/.test(text);
}

export function isYesGatcCertificateSigned(row: YesGatcCertificate): boolean {
  if (signedFlag(row.status)) return true;
  if (row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)) {
    const record = row.raw as Record<string, unknown>;
    if (
      signedFlag(record.signed)
      || signedFlag(record.isSigned)
      || signedFlag(record.digitallySigned)
      || signedFlag(record.status)
      || signedFlag(record.state)
      || signedFlag(record.certificateStatus)
      || signedFlag(record.signStatus)
      || signedFlag(record.tag)
    ) return true;
    const message = String(record.message ?? record.tag ?? '').toLowerCase();
    if (/\bsigned\b/.test(message)) return true;
  }
  return false;
}

export async function runYesGatcInvoiceLink(minDate?: string): Promise<{
  matched?: number;
  written?: number;
}> {
  const fn = httpsCallable<
    { minDate?: string },
    { matched?: number; written?: number }
  >(functions, 'linkYesGatcInvoicesFn', { timeout: 540_000 });
  return (await fn(minDate ? { minDate } : {})).data ?? {};
}

export async function runYesGatcOvInvoiceQtyLink(minDate?: string): Promise<{
  assigned?: number;
  written?: number;
  unlinkedOv?: number;
}> {
  const fn = httpsCallable<
    { minDate?: string },
    { assigned?: number; written?: number; unlinkedOv?: number }
  >(functions, 'linkYesGatcOvByInvoiceQtyFn', { timeout: 540_000 });
  return (await fn(minDate ? { minDate } : {})).data ?? {};
}

export async function pushRcSoldToYesGatc(actorName: string): Promise<{
  ok: boolean;
  rcCount: number;
  sold: number;
}> {
  const fn = httpsCallable<{ actorName?: string }, { ok?: boolean; rcCount?: number; sold?: number }>(
    functions,
    'pushRcSoldToYesGatcFn',
    { timeout: 180_000 },
  );
  const data = (await fn({ actorName })).data ?? {};
  return {
    ok: data.ok !== false,
    rcCount: Number(data.rcCount) || 0,
    sold: Number(data.sold) || 0,
  };
}

export async function saveYesGatcCertificateInvoice(input: {
  certificateId: string;
  serialNumber?: string | null;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate?: string | null;
  invoiceCustomerId?: string | null;
}): Promise<{
  invoiceId: string | null;
  invoiceNumber: string;
  invoiceDate: string | null;
  invoiceCustomerId: string | null;
}> {
  const fn = httpsCallable<typeof input, {
    invoiceId?: string | null;
    invoiceNumber?: string;
    invoiceDate?: string | null;
    invoiceCustomerId?: string | null;
  }>(functions, 'linkYesGatcCertificateInvoiceFn');
  const data = (await fn(input)).data ?? {};
  return {
    invoiceId: data.invoiceId ?? input.invoiceId,
    invoiceNumber: data.invoiceNumber ?? input.invoiceNumber,
    invoiceDate: data.invoiceDate ?? input.invoiceDate ?? null,
    invoiceCustomerId: data.invoiceCustomerId ?? input.invoiceCustomerId ?? null,
  };
}

export async function voidYesGatcCertificate(input: {
  certificateId: string;
  actorName: string;
}): Promise<{
  ok: boolean;
  certificateId: string;
  serialNumber: string | null;
  yesgatcPushed?: boolean;
  yesgatcError?: string | null;
}> {
  const fn = httpsCallable<typeof input, {
    ok?: boolean;
    certificateId?: string;
    serialNumber?: string | null;
    yesgatcPushed?: boolean;
    yesgatcError?: string | null;
  }>(functions, 'voidYesGatcCertificateFn');
  const data = (await fn(input)).data ?? {};
  return {
    ok: data.ok !== false,
    certificateId: data.certificateId ?? input.certificateId,
    serialNumber: data.serialNumber ?? null,
    yesgatcPushed: Boolean(data.yesgatcPushed),
    yesgatcError: data.yesgatcError ?? null,
  };
}

export type YesGatcRcInvoiceReportLine = {
  id: string;
  itemId: string | null;
  name: string;
  sku: string | null;
  description?: string;
  imageUrl: string | null;
  quantity?: number;
  serialNumbers: string[];
  max: string;
  e: string;
  hsn?: string | null;
  categoryName?: string | null;
  isWeighingScale?: boolean;
  isCatalogSpare?: boolean;
  spareGroupId?: string | null;
  certificateNumbers: string[];
};

export type YesGatcRcInvoiceReportRow = {
  id: string;
  customerId: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  createdTime?: string | null;
  customerName: string | null;
  rcCode: string | null;
  rcName: string | null;
  serialNumbers: string[];
  serialCount: number;
  pushedAt: string | null;
  pushedBy?: string | null;
  lines?: YesGatcRcInvoiceReportLine[];
};

export function gatcRcInvoiceReportErrorMessage(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code: string }).code)
    : '';
  const message = err instanceof Error ? err.message : '';
  const text = `${code} ${message}`.toLowerCase();
  if (code === 'functions/not-found' || text.includes('not-found')) {
    return 'GATC RC list is not deployed yet. Deploy yesGatcRcInvoiceReportFn.';
  }
  if (
    code === 'functions/internal'
    || /^internal$/i.test(message.trim())
    || text.includes('functions/internal')
    || /requires an index|collection_group/i.test(text)
  ) {
    return 'Could not load the GATC RC list. Try Apply again in a moment.';
  }
  if (code === 'functions/permission-denied') {
    return 'You do not have permission to view the GATC RC list.';
  }
  if (message && !/^internal$/i.test(message.trim())) return message;
  return 'Could not load the GATC RC list.';
}

export async function fetchYesGatcRcInvoiceReport(input: {
  rcCode?: string;
  dateStart?: string | null;
  dateEnd?: string | null;
}): Promise<{
  rows: YesGatcRcInvoiceReportRow[];
  truncated: boolean;
}> {
  return fetchYesGatcRcInvoiceReportFromFirestore(input);
}

function uniqueReportSerials(values: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = str(value);
    if (!text) continue;
    const key = text.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function isReportSerial(value: string): boolean {
  const text = str(value);
  if (text.length < 3) return false;
  if (/^(serials?|numbers?|n\/?a|none|nil|null|mac|id)$/i.test(text)) return false;
  return true;
}

function serialPrefix(value: string): string {
  const match = str(value).match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : '';
}

function sortReportSerials(serials: readonly string[]): string[] {
  return [...serials].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

function inReportDateWindow(date: string, dateStart: string, dateEnd: string): boolean {
  if (!date) return !dateStart && !dateEnd;
  if (dateStart && date < dateStart) return false;
  if (dateEnd && date > dateEnd) return false;
  return true;
}

function isReportKeepLine(line: {
  name?: string;
  sku?: string | null;
  hsn?: string | null;
  itemId?: string | null;
  categoryName?: string | null;
}): boolean {
  const name = str(line.name);
  const sku = line.sku ?? null;
  const hsn = line.hsn ?? null;
  if (isFreightInvoiceLineItem({ name, sku, hsn, itemId: line.itemId ?? null })) return false;
  if (isGatcFeeInvoiceLineItem({ name, sku, hsn })) return false;
  if (isStampingInvoiceLineItem({ name, sku, hsn })) return false;
  if (isSoftwareInvoiceLineItem({ name, sku, hsn, categoryName: line.categoryName ?? null })) return false;
  const kind = classifyInvoiceLineItem({
    name,
    sku,
    hsn,
    itemId: line.itemId ?? null,
    categoryName: line.categoryName ?? null,
  });
  if (kind === 'service' || kind === 'gatc' || kind === 'software_key') return false;
  return true;
}

/** Complete weighing instrument — not a spare component. */
const WEIGHING_MACHINE_NAME_RE = /\b(?:weighing\s+)?(?:scale|scales|balance)s?\b/;

/** Parts that leak in under scale categories (print heads, SMPS, stickers, …). */
const SPARE_COMPONENT_NAME_RE = new RegExp(
  String.raw`\b(?:`
  + [
    'print\\s*heads?',
    'smps',
    'psu',
    'sticker(?:\\s+set)?s?',
    'overlays?',
    'spare\\s*parts?',
    'load\\s*cells?',
    'mother\\s*boards?',
    'main\\s*boards?',
    'pcbs?',
    'power\\s+supply',
    'power\\s+supplies',
    'adapt(?:er|or)s?',
    'chargers?',
    'batter(?:y|ies)',
    'keypads?',
    'cables?',
    'motors?',
    'cutters?',
    'rollers?',
    'ribbons?',
    'hoppers?',
    'sensors?',
    'transformers?',
    'fuses?',
    'fans?',
    'solenoids?',
    'belts?',
    'gears?',
    'bearings?',
    'springs?',
    'knobs?',
    'covers?',
    'housings?',
    'connectors?',
    'display\\s+boards?',
    'power\\s+boards?',
    'io\\s+boards?',
    'weighing\\s+pans?',
    'scale\\s+pans?',
    'keypad\\s+overlays?',
  ].join('|')
  + String.raw`)\b`,
  'i',
);

/** Currency / note counters (CCM) — not weighing scales. */
export function isYesGatcRcNonWeighingMachineLine(line: {
  name?: string | null;
  sku?: string | null;
  description?: string | null;
}): boolean {
  const blob = `${str(line.name)} ${str(line.sku)} ${str(line.description)}`.toLowerCase();
  if (!blob.trim()) return false;
  if (/\b(value|currency|cash|note|bill|money|banknote)\s+count(?:ing)?(?:\s+machine)?\b/.test(blob)) {
    return true;
  }
  if (/\bccm\b/.test(blob) && /\bcount/.test(blob)) return true;
  if (/^ccm\s*[-–—]/.test(str(line.name).toLowerCase())) return true;
  return false;
}

/** Stickers, print heads, SMPS, generic spare parts — not serialled weighing scales. */
export function isYesGatcRcSparePartLine(line: {
  name?: string | null;
  sku?: string | null;
  description?: string | null;
  categoryName?: string | null;
  isCatalogSpare?: boolean;
  spareGroupId?: string | null;
}): boolean {
  if (line.isCatalogSpare || str(line.spareGroupId)) return true;
  if (isGenericSpareCategoryName(line.categoryName)) return true;
  const category = str(line.categoryName).toLowerCase();
  if (/\b(?:spare|spares|accessor(?:y|ies))\b/.test(category)) return true;
  const blob = `${str(line.name)} ${str(line.sku)}`.toLowerCase();
  if (!blob.trim() || !SPARE_COMPONENT_NAME_RE.test(blob)) return false;
  if (WEIGHING_MACHINE_NAME_RE.test(blob) && !/\b(?:print\s*head|smps|sticker|overlay|load\s*cell|pcb|power\s+supply)\b/.test(blob)) {
    return false;
  }
  return true;
}

export function isYesGatcRcWeighingScaleLine(line: {
  name?: string | null;
  sku?: string | null;
  description?: string | null;
  hsn?: string | null;
  categoryName?: string | null;
  isWeighingScale?: boolean;
  isCatalogSpare?: boolean;
  spareGroupId?: string | null;
  max?: string;
  e?: string;
}): boolean {
  if (isYesGatcRcSparePartLine(line)) return false;
  if (isYesGatcRcNonWeighingMachineLine(line)) return false;
  if (line.isWeighingScale) return true;
  if (lineIsMandatorySerialCategory({
    categoryName: line.categoryName,
    isWeighingScale: line.isWeighingScale,
  })) return true;
  const hsn = str(line.hsn).replace(/\D/g, '');
  if (hsn && (WEIGHING_SCALE_HSN.has(hsn) || hsn.startsWith('8423'))) {
    return true;
  }
  return Boolean(str(line.max) || str(line.e));
}

function keepWeighingScaleReportRows(rows: YesGatcRcInvoiceReportRow[]): YesGatcRcInvoiceReportRow[] {
  const next: YesGatcRcInvoiceReportRow[] = [];
  for (const row of rows) {
    const lines = (row.lines || []).filter(line => isYesGatcRcWeighingScaleLine(line));
    if (!lines.length) continue;
    const serialNumbers = uniqueReportSerials(lines.flatMap(line => line.serialNumbers));
    next.push({
      ...row,
      lines,
      serialNumbers,
      serialCount: serialNumbers.length,
    });
  }
  return next;
}

function reportTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function mapInvoiceSnapToGatcReportRow(
  docSnap: QueryDocumentSnapshot<DocumentData>,
  fallback?: { rcCode?: string | null; rcName?: string | null },
): YesGatcRcInvoiceReportRow | null {
  const data = docSnap.data() as Record<string, unknown>;
  const status = str(data.status).toLowerCase();
  if (status === 'void' || status === 'voided' || data.voided === true) return null;
  const rcCode = str(data.yesgatcRcCode).toUpperCase() || str(fallback?.rcCode).toUpperCase() || null;
  const rcName = str(data.yesgatcRcName) || str(fallback?.rcName) || null;
  const rawLines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const lines: YesGatcRcInvoiceReportLine[] = [];
  for (const raw of rawLines) {
    const line = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (!isReportKeepLine({
      name: str(line.name),
      sku: str(line.sku) || null,
      hsn: str(line.hsn) || null,
      itemId: str(line.itemId) || null,
      categoryName: str(line.categoryName) || null,
    })) continue;
    const serialNumbers = uniqueReportSerials(
      Array.isArray(line.serialNumbers)
        ? line.serialNumbers.map(value => str(value)).filter(Boolean)
        : [],
    ).filter(isReportSerial);
    lines.push({
      id: str(line.id) || `${lines.length}`,
      itemId: str(line.itemId) || null,
      name: str(line.name) || 'Item',
      sku: str(line.sku) || null,
      description: str(line.description) || '',
      imageUrl: str(line.imageUrl) || null,
      quantity: Math.max(0, Math.round(Number(line.quantity) || 0)),
      serialNumbers,
      max: str(line.max) || '',
      e: str(line.e) || '',
      hsn: str(line.hsn) || null,
      categoryName: str(line.categoryName) || null,
      isWeighingScale: line.isWeighingScale === true,
      certificateNumbers: [],
    });
  }
  let leftover = uniqueReportSerials([
    ...(Array.isArray(data.gatcStampedAllocatedSerials) ? data.gatcStampedAllocatedSerials : []),
    ...(Array.isArray(data.nonGatcAllocatedSerials) ? data.nonGatcAllocatedSerials : []),
  ]).filter(serial => isReportSerial(serial) && !lines.some(line => line.serialNumbers.includes(serial)));
  leftover = sortReportSerials(leftover);
  for (const line of lines) {
    if (!isYesGatcRcWeighingScaleLine(line)) continue;
    const need = Math.max(0, (line.quantity ?? 0) - line.serialNumbers.length);
    if (!need || !leftover.length) continue;
    const prefix = serialPrefix(line.serialNumbers[0] || leftover[0] || '');
    const matched = leftover.filter(serial => !prefix || serialPrefix(serial) === prefix);
    const take = matched.slice(0, need);
    leftover = leftover.filter(serial => !take.includes(serial));
    line.serialNumbers = uniqueReportSerials([...line.serialNumbers, ...take]);
  }
  const serialNumbers = uniqueReportSerials(lines.flatMap(line => line.serialNumbers));
  return {
    id: docSnap.id,
    customerId: str(data.customerId) || str(docSnap.ref.parent.parent?.id),
    invoiceNumber: str(data.invoiceNumber) || docSnap.id,
    invoiceDate: invoiceDateKey(data.date ?? data.invoiceDate) || null,
    createdTime: firstDateTimeValue(
      reportTimestamp(data.createdTime),
      reportTimestamp(data.zohoCreatedTime),
      reportTimestamp(data.zohoLastModified),
      str(data.yesgatcRcPushedAt) || null,
    ),
    customerName: str(data.customerName) || null,
    rcCode,
    rcName,
    serialNumbers,
    serialCount: serialNumbers.length,
    pushedAt: str(data.yesgatcRcPushedAt) || null,
    pushedBy: str(data.yesgatcRcPushedBy) || null,
    lines: lines.length ? lines : [{
      id: 'invoice',
      itemId: null,
      name: str(data.customerName) || 'Invoice',
      sku: null,
      description: '',
      imageUrl: null,
      quantity: Math.round(Number(data.itemQuantity) || 0),
      serialNumbers,
      max: '',
      e: '',
      certificateNumbers: [],
    }],
  };
}

async function attachReportCatalogImages(rows: YesGatcRcInvoiceReportRow[]): Promise<void> {
  const itemIds = [...new Set(
    rows.flatMap(row => row.lines || []).map(line => line.itemId).filter((id): id is string => Boolean(id)),
  )];
  if (!itemIds.length) return;
  const meta = await fetchCatalogMetaForItemIds(itemIds);
  for (const row of rows) {
    for (const line of row.lines || []) {
      if (!line.itemId) continue;
      const catalog = meta.get(line.itemId);
      if (!catalog) continue;
      if (!line.imageUrl) line.imageUrl = catalog.imageUrl || null;
      if (!line.hsn && catalog.hsn) line.hsn = catalog.hsn;
      if (!line.categoryName && catalog.categoryName) line.categoryName = catalog.categoryName;
      if (catalog.isCatalogSpare || catalog.spareGroupId) {
        line.isCatalogSpare = true;
        line.spareGroupId = catalog.spareGroupId;
        line.isWeighingScale = false;
      } else if (catalog.isWeighingScale) {
        line.isWeighingScale = true;
      }
    }
  }
}

function sortGatcReportRows(rows: YesGatcRcInvoiceReportRow[]): void {
  rows.sort((a, b) => {
    const dateCmp = String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || ''));
    if (dateCmp !== 0) return dateCmp;
    return String(a.invoiceNumber).localeCompare(String(b.invoiceNumber), 'en');
  });
}

async function resolveRcDealer(wantedRc: string): Promise<{
  dealerId: string;
  rcCode: string;
  rcName: string;
} | null> {
  const code = str(wantedRc).toUpperCase();
  if (!code) return null;
  const [links, rcs] = await Promise.all([
    listYesGatcRcDealerLinks(),
    listYesGatcRcDetails(),
  ]);
  const rc = rcs.find(row => yesGatcRcKey(row) === code || str(row.code).toUpperCase() === code);
  const dealerId = str(links.get(code)?.dealerId) || str(rc?.dealerId) || str(links.get(rc?.id || '')?.dealerId);
  if (!dealerId) return null;
  return {
    dealerId,
    rcCode: str(rc?.code).toUpperCase() || code,
    rcName: rc ? yesGatcRcOfficeName(rc) : (links.get(code)?.dealerName || code),
  };
}

async function fetchDealerInvoicesForGatcReport(input: {
  dealerId: string;
  rcCode: string;
  rcName: string;
  dateStart: string;
  dateEnd: string;
  cap: number;
}): Promise<{ rows: YesGatcRcInvoiceReportRow[]; truncated: boolean }> {
  const col = collection(db, 'zohoCustomers', input.dealerId, 'invoices');
  const constraints = [
    ...(input.dateStart ? [where('date', '>=', input.dateStart)] : []),
    ...(input.dateEnd ? [where('date', '<=', input.dateEnd)] : []),
    orderBy('date', 'desc'),
  ];
  const rows: YesGatcRcInvoiceReportRow[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let truncated = false;
  const pageSize = 400;
  for (;;) {
    let page: QuerySnapshot<DocumentData>;
    try {
      page = await getDocs(
        cursor
          ? query(col, ...constraints, startAfter(cursor), limit(pageSize))
          : query(col, ...constraints, limit(pageSize)),
      );
    } catch {
      page = await getDocs(query(col, limit(input.cap)));
      for (const docSnap of page.docs) {
        const row = mapInvoiceSnapToGatcReportRow(docSnap, {
          rcCode: input.rcCode,
          rcName: input.rcName,
        });
        if (!row) continue;
        if (!inReportDateWindow(row.invoiceDate || '', input.dateStart, input.dateEnd)) continue;
        rows.push(row);
      }
      sortGatcReportRows(rows);
      await attachReportCatalogImages(rows);
      return {
        rows: keepWeighingScaleReportRows(rows).slice(0, input.cap),
        truncated: page.size >= input.cap,
      };
    }
    if (page.empty) break;
    for (const docSnap of page.docs) {
      const row = mapInvoiceSnapToGatcReportRow(docSnap, {
        rcCode: input.rcCode,
        rcName: input.rcName,
      });
      if (row) rows.push(row);
    }
    cursor = page.docs[page.docs.length - 1] ?? null;
    if (page.size < pageSize) break;
    if (rows.length >= input.cap) {
      truncated = true;
      break;
    }
  }
  sortGatcReportRows(rows);
  const sliced = rows.slice(0, input.cap);
  await attachReportCatalogImages(sliced);
  return { rows: keepWeighingScaleReportRows(sliced), truncated: truncated || rows.length > input.cap };
}

async function fetchYesGatcRcInvoiceReportFromFirestore(input: {
  rcCode?: string;
  dateStart?: string | null;
  dateEnd?: string | null;
}): Promise<{
  rows: YesGatcRcInvoiceReportRow[];
  truncated: boolean;
}> {
  const wantedRc = str(input.rcCode).toUpperCase();
  const dateStart = str(input.dateStart).slice(0, 10);
  const dateEnd = str(input.dateEnd).slice(0, 10);
  const cap = 5000;
  if (wantedRc) {
    const linked = await resolveRcDealer(wantedRc);
    if (linked) {
      return fetchDealerInvoicesForGatcReport({
        dealerId: linked.dealerId,
        rcCode: linked.rcCode,
        rcName: linked.rcName,
        dateStart,
        dateEnd,
        cap,
      });
    }
  }

  const invoices = collectionGroup(db, 'invoices');
  const constraints = [
    ...(dateStart ? [where('date', '>=', dateStart)] : []),
    ...(dateEnd ? [where('date', '<=', dateEnd)] : []),
    orderBy('date', 'desc'),
  ];
  const mapped: YesGatcRcInvoiceReportRow[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let scanned = 0;
  let truncated = false;
  const pageSize = 400;

  for (;;) {
    const page: QuerySnapshot<DocumentData> = await getDocs(
      cursor
        ? query(invoices, ...constraints, startAfter(cursor), limit(pageSize))
        : query(invoices, ...constraints, limit(pageSize)),
    );
    if (page.empty) break;
    scanned += page.size;
    for (const docSnap of page.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const rcCode = str(data.yesgatcRcCode).toUpperCase() || null;
      if (!str(data.yesgatcRcPushedAt) && !rcCode) continue;
      if (wantedRc && rcCode !== wantedRc) continue;
      const row = mapInvoiceSnapToGatcReportRow(docSnap);
      if (!row) continue;
      if (!inReportDateWindow(row.invoiceDate || '', dateStart, dateEnd)) continue;
      mapped.push(row);
    }
    cursor = page.docs[page.docs.length - 1] ?? null;
    if (page.size < pageSize) break;
    if (mapped.length >= cap || scanned >= cap) {
      truncated = true;
      break;
    }
  }

  sortGatcReportRows(mapped);
  const rows = mapped.slice(0, cap);
  await attachReportCatalogImages(rows);
  return { rows: keepWeighingScaleReportRows(rows), truncated: truncated || mapped.length > cap };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadYesGatcRcInvoiceReportCsv(
  rows: readonly YesGatcRcInvoiceReportRow[],
  fileStem: string,
): void {
  const headers = [
    'Invoice No',
    'Invoice Date',
    'Dealer',
    'RC Code',
    'RC Name',
    'Serial Count',
    'Serial Numbers',
    'Pushed At',
  ];
  const lines = [
    headers.join(','),
    ...rows.map(row => [
      row.invoiceNumber || '',
      row.invoiceDate || '',
      row.customerName || '',
      row.rcCode || '',
      row.rcName || '',
      String(row.serialCount ?? row.serialNumbers?.length ?? 0),
      (row.serialNumbers || []).join(' '),
      row.pushedAt || '',
    ].map(value => csvEscape(String(value))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const safe = fileStem.replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    || 'gatc-rc-invoices';
  anchor.download = `${safe}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
