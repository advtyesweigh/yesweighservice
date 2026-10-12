/**
 * Blue Dart APIGEE auth + waybill + tracking.
 *
 * Sandbox:  https://apigateway-sandbox.bluedart.com/in/transportation
 * Production: https://apigateway.bluedart.com/in/transportation
 *
 * Credentials live in appSettings/blueDartSecrets (Admin SDK only).
 * Public connection metadata lives on appSettings/logisticsSettings.blueDart.
 * Cached JWT lives in appSettings/blueDartAuth.
 * Profile.Api_type is S (Shipping) or T (Tracking) — not sandbox vs production.
 */

import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { PDFDocument } from 'pdf-lib';
import { blueDartPickupPinForSite } from './blue-dart-pickup-sites.js';

export const BLUE_DART_SECRETS_DOC = 'appSettings/blueDartSecrets';
export const BLUE_DART_AUTH_DOC = 'appSettings/blueDartAuth';
export const LOGISTICS_SETTINGS_DOC = 'appSettings/logisticsSettings';

export const BLUE_DART_BASE_URLS = Object.freeze({
  sandbox: 'https://apigateway-sandbox.bluedart.com/in/transportation',
  production: 'https://apigateway.bluedart.com/in/transportation',
});

/** GenerateWayBill ProductCode: A Apex (air), E Economy (surface), D Dart Plus (DP). */
export const BLUE_DART_PRODUCT_CODES = Object.freeze({
  bluedart_air: 'A',
  bluedart_surface: 'E',
  bluedart_domestic: 'D',
});

/** GenerateWayBill ProductType enum: 0 Docs (Dox), 1 Dutiables (Non-Dox). */
export const BLUE_DART_PRODUCT_TYPE = Object.freeze({
  docs: 0,
  dutiables: 1,
});

/** RegisterPickup DoxNDox: 1 Dox, 2 Non-Dox. */
export const BLUE_DART_DOX_NDOX = Object.freeze({
  dox: '1',
  ndox: '2',
});

/**
 * PrinterLableSize is a numeric enum (string names 500 the API).
 * 0 A4S single, 1 A4T multi-copy, 2 55×30, 3 89×60.
 */
export const BLUE_DART_PRINTER_LABEL_A4S = 0;

/** Logistics thermal stock — official A4S is shrink-to-fit, no crop. */
export const BLUE_DART_LABEL_WIDTH_MM = 100;
export const BLUE_DART_LABEL_HEIGHT_MM = 150;

const JWT_SKEW_MS = 60_000;
const JWT_FALLBACK_TTL_MS = 25 * 60 * 1000;

/**
 * @param {unknown} raw
 * @returns {'sandbox' | 'production'}
 */
export function normalizeBlueDartEnv(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'production';
}

/**
 * @param {'sandbox' | 'production'} env
 */
export function blueDartBaseUrl(env) {
  return BLUE_DART_BASE_URLS[normalizeBlueDartEnv(env)];
}

/**
 * @param {unknown} partnerId
 */
export function blueDartProductCode(partnerId) {
  const id = String(partnerId ?? '').trim();
  return BLUE_DART_PRODUCT_CODES[id] || BLUE_DART_PRODUCT_CODES.bluedart_surface;
}

/** Envelope → Dox (documents). Everything else, including omitted mode, is Dutiables. */
export function blueDartIsEnvelope(shipmentMode) {
  return String(shipmentMode ?? '').trim().toLowerCase() === 'envelope';
}

export function blueDartProductType(shipmentMode) {
  return blueDartIsEnvelope(shipmentMode)
    ? BLUE_DART_PRODUCT_TYPE.docs
    : BLUE_DART_PRODUCT_TYPE.dutiables;
}

export function blueDartDoxNDox(shipmentMode) {
  return blueDartIsEnvelope(shipmentMode)
    ? BLUE_DART_DOX_NDOX.dox
    : BLUE_DART_DOX_NDOX.ndox;
}

/** GenerateWayBill SubProductCode: A FOD. Empty = prepaid / account. */
export function blueDartSubProductCode(freightBillingMode) {
  return String(freightBillingMode || '').trim().toLowerCase() === 'fod' ? 'A' : '';
}

function blueDartAlnum(raw, maxLen) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, maxLen);
}

function gstin15(raw) {
  const value = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!value || value === 'URP') return '';
  return value.length === 15 ? value : '';
}

export function blueDartCommodity(shipmentMode) {
  return {
    CommodityDetail1: blueDartIsEnvelope(shipmentMode) ? 'Documents' : 'WeighingScale',
  };
}

export function blueDartItemDetails({ shipmentMode, declaredValue, pieceCount, invoiceNumber }) {
  if (blueDartIsEnvelope(shipmentMode)) return [];
  const invoice = blueDartAlnum(invoiceNumber, 20);
  return [{
    ItemID: '1',
    ItemName: 'WeighingScale',
    ItemValue: declaredValue,
    Itemquantity: Math.max(1, Number(pieceCount) || 1),
    ...(invoice ? { InvoiceNumber: invoice } : {}),
  }];
}

/**
 * @param {string} jwt
 * @returns {{ expMs: number | null }}
 */
export function decodeBlueDartJwtExp(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return { expMs: null };
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    const expSec = Number(payload?.exp);
    return { expMs: Number.isFinite(expSec) ? expSec * 1000 : null };
  } catch {
    return { expMs: null };
  }
}

function emptyPublic() {
  return {
    env: 'production',
    loginId: '',
    customerCode: '',
    originArea: '',
    customerPincode: '',
    customerName: '',
    clientSecretSet: false,
    shippingLicenseSet: false,
    trackingLicenseSet: false,
    sandboxLicenseSet: false,
    lastTestAt: '',
    lastTestOk: false,
    lastTestMessage: '',
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 */
export async function loadBlueDartPublicConfig(db) {
  const snap = await db.doc(LOGISTICS_SETTINGS_DOC).get();
  const raw = snap.exists && snap.data()?.blueDart && typeof snap.data().blueDart === 'object'
    ? snap.data().blueDart
    : {};
  const secretsSnap = await db.doc(BLUE_DART_SECRETS_DOC).get();
  const secrets = secretsSnap.exists ? (secretsSnap.data() || {}) : {};
  const loginId = String(raw.loginId || secrets.loginId || '').trim();
  return {
    env: normalizeBlueDartEnv(raw.env),
    loginId,
    customerCode: String(raw.customerCode || secrets.customerCode || '').trim(),
    originArea: String(raw.originArea || secrets.originArea || '').trim(),
    customerPincode: String(raw.customerPincode || secrets.customerPincode || '').trim(),
    customerName: String(raw.customerName || secrets.customerName || '').trim(),
    clientSecretSet: Boolean(String(secrets.clientSecret || '').trim()),
    shippingLicenseSet: Boolean(String(secrets.shippingLicenseKey || '').trim()),
    trackingLicenseSet: Boolean(String(secrets.trackingLicenseKey || '').trim()),
    sandboxLicenseSet: Boolean(String(secrets.sandboxLicenseKey || '').trim()),
    lastTestAt: typeof raw.lastTestAt === 'string' ? raw.lastTestAt : '',
    lastTestOk: Boolean(raw.lastTestOk),
    lastTestMessage: typeof raw.lastTestMessage === 'string' ? raw.lastTestMessage : '',
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Record<string, unknown>} input
 */
export async function saveBlueDartConfig(db, input = {}) {
  const now = new Date().toISOString();
  const publicConfig = await loadBlueDartPublicConfig(db);
  const next = {
    env: input.env != null ? normalizeBlueDartEnv(input.env) : publicConfig.env,
    loginId: input.loginId != null ? String(input.loginId).trim() : publicConfig.loginId,
    customerCode: input.customerCode != null
      ? String(input.customerCode).trim()
      : publicConfig.customerCode,
    originArea: input.originArea != null
      ? String(input.originArea).trim().toUpperCase()
      : publicConfig.originArea,
    customerPincode: input.customerPincode != null
      ? String(input.customerPincode).replace(/\D/g, '').slice(0, 6)
      : publicConfig.customerPincode,
    customerName: input.customerName != null
      ? String(input.customerName).trim()
      : publicConfig.customerName,
  };

  const publicPatch = {
    blueDart: {
      ...next,
      clientSecretSet: publicConfig.clientSecretSet,
      shippingLicenseSet: publicConfig.shippingLicenseSet,
      trackingLicenseSet: publicConfig.trackingLicenseSet,
      sandboxLicenseSet: publicConfig.sandboxLicenseSet,
      lastTestAt: publicConfig.lastTestAt || '',
      lastTestOk: publicConfig.lastTestOk,
      lastTestMessage: publicConfig.lastTestMessage || '',
      updatedAt: now,
      ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
    },
    updatedAt: now,
    ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
  };

  const secretsPatch = {
    loginId: next.loginId,
    customerCode: next.customerCode,
    originArea: next.originArea,
    customerPincode: next.customerPincode,
    customerName: next.customerName,
    updatedAt: now,
    ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
  };

  const assignSecret = (field, publicFlag) => {
    if (input[field] == null || String(input[field]).length === 0) return;
    secretsPatch[field] = String(input[field]).trim();
    publicPatch.blueDart[publicFlag] = true;
  };
  if (input.clientId != null && String(input.clientId).trim()) {
    secretsPatch.clientId = String(input.clientId).trim();
  }
  assignSecret('clientSecret', 'clientSecretSet');
  assignSecret('shippingLicenseKey', 'shippingLicenseSet');
  assignSecret('trackingLicenseKey', 'trackingLicenseSet');
  assignSecret('sandboxLicenseKey', 'sandboxLicenseSet');

  await db.doc(LOGISTICS_SETTINGS_DOC).set(publicPatch, { merge: true });
  await db.doc(BLUE_DART_SECRETS_DOC).set(secretsPatch, { merge: true });
  await db.doc(BLUE_DART_AUTH_DOC).set({
    jwt: FieldValue.delete(),
    expMs: FieldValue.delete(),
    env: next.env,
    clearedAt: now,
  }, { merge: true });

  return loadBlueDartPublicConfig(db);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 */
async function loadSecrets(db) {
  const snap = await db.doc(BLUE_DART_SECRETS_DOC).get();
  if (!snap.exists) {
    throw new Error('Blue Dart credentials are not configured.');
  }
  const data = snap.data() || {};
  const clientId = String(data.clientId || '').trim();
  const clientSecret = String(data.clientSecret || '').trim();
  const loginId = String(data.loginId || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Blue Dart ClientID / ClientSecret missing. Save them in Logistics Settings.');
  }
  if (!loginId) {
    throw new Error('Blue Dart LoginID missing. Save it in Logistics Settings.');
  }
  return {
    clientId,
    clientSecret,
    loginId,
    customerCode: String(data.customerCode || '').trim(),
    originArea: String(data.originArea || '').trim(),
    customerPincode: String(data.customerPincode || '').replace(/\D/g, '').slice(0, 6),
    customerName: String(data.customerName || 'INTERWEIGHING PRIVATE LIMITED').trim(),
    shippingLicenseKey: String(data.shippingLicenseKey || '').trim(),
    trackingLicenseKey: String(data.trackingLicenseKey || '').trim(),
    sandboxLicenseKey: String(data.sandboxLicenseKey || '').trim(),
  };
}

/**
 * @param {'sandbox' | 'production'} env
 * @param {'shipping' | 'tracking'} kind
 * @param {Awaited<ReturnType<typeof loadSecrets>>} secrets
 */
function licenseFor(env, kind, secrets) {
  if (env === 'sandbox') {
    const key = secrets.sandboxLicenseKey || secrets.shippingLicenseKey;
    if (!key) throw new Error('Blue Dart sandbox license key is not configured.');
    return key;
  }
  if (kind === 'tracking') {
    const key = secrets.trackingLicenseKey || secrets.shippingLicenseKey;
    if (!key) throw new Error('Blue Dart tracking license key is not configured.');
    return key;
  }
  if (!secrets.shippingLicenseKey) {
    throw new Error('Blue Dart shipping license key is not configured.');
  }
  return secrets.shippingLicenseKey;
}

/** Profile.Api_type is Shipping (S) vs Tracking (T), not sandbox vs production. */
function apiTypeFor(kind = 'shipping') {
  return kind === 'tracking' ? 'T' : 'S';
}

function profilePayload(env, secrets, kind = 'shipping') {
  return {
    Api_type: apiTypeFor(kind),
    LicenceKey: licenseFor(env, kind, secrets),
    LoginID: secrets.loginId,
    Version: '1.3',
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ skipPublicPatch?: boolean, force?: boolean }} [options]
 */
export async function loginBlueDart(db, options = {}) {
  const config = await loadBlueDartPublicConfig(db);
  const secrets = await loadSecrets(db);
  const baseUrl = blueDartBaseUrl(config.env);
  const res = await fetch(`${baseUrl}/token/v1/login`, {
    method: 'GET',
    headers: {
      ClientID: secrets.clientId,
      clientSecret: secrets.clientSecret,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const errList = json?.['error-response'];
    const message = json?.title
      || (Array.isArray(errList) ? errList[0]?.msg : null)
      || json?.message
      || text
      || `Blue Dart token failed (${res.status})`;
    throw new Error(String(message));
  }
  const jwt = String(json?.JWTToken || json?.jwtToken || json?.token || '').trim();
  if (!jwt) {
    throw new Error('Blue Dart login succeeded but no JWTToken was returned.');
  }
  const claims = decodeBlueDartJwtExp(jwt);
  const expMs = claims.expMs || (Date.now() + JWT_FALLBACK_TTL_MS);
  const now = new Date().toISOString();
  await db.doc(BLUE_DART_AUTH_DOC).set({
    jwt,
    expMs,
    env: config.env,
    loginId: secrets.loginId,
    loggedInAt: now,
  }, { merge: true });

  if (!options.skipPublicPatch) {
    await db.doc(LOGISTICS_SETTINGS_DOC).set({
      blueDart: {
        env: config.env,
        loginId: secrets.loginId,
        customerCode: secrets.customerCode,
        originArea: secrets.originArea,
        customerPincode: secrets.customerPincode,
        customerName: secrets.customerName,
        clientSecretSet: true,
        lastTestAt: now,
        lastTestOk: true,
        lastTestMessage: `JWT OK (${config.env}) as ${secrets.loginId}`,
        updatedAt: now,
      },
      updatedAt: now,
    }, { merge: true });
  }

  return {
    jwt,
    env: config.env,
    baseUrl,
    loginId: secrets.loginId,
    expMs,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ force?: boolean }} [options]
 */
export async function getValidBlueDartJwt(db, options = {}) {
  if (!options.force) {
    const authSnap = await db.doc(BLUE_DART_AUTH_DOC).get();
    if (authSnap.exists) {
      const data = authSnap.data() || {};
      const jwt = String(data.jwt || '').trim();
      const expMs = Number(data.expMs);
      const config = await loadBlueDartPublicConfig(db);
      const envMatch = normalizeBlueDartEnv(data.env) === config.env;
      if (
        jwt
        && envMatch
        && Number.isFinite(expMs)
        && expMs > Date.now() + JWT_SKEW_MS
      ) {
        return {
          jwt,
          env: config.env,
          baseUrl: blueDartBaseUrl(config.env),
          loginId: String(data.loginId || config.loginId || ''),
          expMs,
        };
      }
    }
  }
  return loginBlueDart(db, { skipPublicPatch: true });
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} path
 * @param {{ method?: string, body?: unknown, forceLogin?: boolean }} [options]
 */
export async function blueDartFetch(db, path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const auth = await getValidBlueDartJwt(db, { force: Boolean(options.forceLogin) });
  const url = path.startsWith('http')
    ? path
    : `${auth.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    JWTToken: auth.jwt,
    Accept: 'application/json',
  };
  let body;
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  let res = await fetch(url, { method, headers, body });
  if (res.status === 401 || res.status === 403) {
    const fresh = await getValidBlueDartJwt(db, { force: true });
    headers.JWTToken = fresh.jwt;
    res = await fetch(url, { method, headers, body });
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text, auth };
}

function firstStatusInfo(statusRows) {
  if (typeof statusRows === 'string' && statusRows.trim()) return statusRows.trim();
  if (!Array.isArray(statusRows) || !statusRows[0]) return '';
  const row = statusRows[0];
  return String(row.StatusInformation || row.ErrorMessage || row.StatusCode || '').trim();
}

function compactBlueDartError(json, text, status, fallback) {
  const pickup = json?.RegisterPickupResult
    || json?.PickupRegistrationResponse
    || json?.PickupRegistrationResponseEntity
    || json?.CancelPickupResult;
  const fromPickup = firstStatusInfo(pickup?.Status)
    || String(pickup?.StatusInformation || pickup?.ErrorMessage || pickup?.Message || '').trim();
  if (fromPickup && fromPickup.toLowerCase() !== 'bad request') {
    return fromPickup.slice(0, 400);
  }
  const full = blueDartErrorMessage(json, text, status, fallback)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (full && full.toLowerCase() !== 'bad request') return full.slice(0, 400);
  return `${fallback} (${status})`;
}

function pickupTimeHhMm(raw) {
  const digits = String(raw || '1600').replace(/\D/g, '').slice(0, 4).padStart(4, '0');
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function sanitizeBlueDartRef(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

function parseAlreadyGeneratedWaybill(message, result) {
  const fromResult = String(result?.AWBNo || '').replace(/\D/g, '').trim();
  const msg = String(message || '').replace(/\u00a0/g, ' ');
  const fromMsg = /waybill\s*no\s*[:.\-–—]?\s*'?(\d{8,})/i.exec(msg)?.[1]
    || (/\balready\s+generated\b/i.test(msg) && /\bwaybill\b/i.test(msg)
      ? /\b(\d{11,12})\b/.exec(msg)?.[1]
      : null);
  const awb = (fromResult.length >= 8 ? fromResult : String(fromMsg || '').replace(/\D/g, '')).trim();
  if (!awb) return null;
  const destArea = String(result?.DestinationArea || '').trim().toUpperCase()
    || (/dest\s*area\s*[:.\-–—]?\s*([A-Z]{3,6})/i.exec(msg)?.[1] || '').toUpperCase()
    || null;
  const destLoc = String(result?.DestinationLocation || '').trim().toUpperCase()
    || (/dest\s*scrcd\s*[:.\-–—]?\s*([A-Z0-9]{3,8})/i.exec(msg)?.[1] || '').toUpperCase()
    || null;
  return {
    awb,
    destinationArea: destArea || null,
    destinationLocation: destLoc || null,
  };
}

function blueDartErrorMessage(json, text, status, fallback) {
  const errList = json?.['error-response'];
  if (Array.isArray(errList) && errList[0]) {
    const first = errList[0];
    const msg = first.ErrorMessage
      || first.msg
      || first.StatusInformation
      || first.message
      || firstStatusInfo(first.Status);
    if (msg && String(msg).toLowerCase() !== 'bad request') return String(msg);
  }
  const result = json?.GenerateWayBillResult || json?.WayBillGenerationStatus;
  const fromResult = firstStatusInfo(result?.Status);
  if (fromResult) return fromResult;
  const title = String(json?.title || json?.message || '').trim();
  if (title && title.toLowerCase() !== 'bad request') return title;
  return String(text || `${fallback} (${status})`);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 */
export async function testBlueDartConnection(db) {
  try {
    const session = await loginBlueDart(db);
    const secrets = await loadSecrets(db);
    const pin = secrets.customerPincode || blueDartPickupPinForSite('cochin') || '683104';
    const finder = await blueDartFetch(db, '/finder/v1/GetServicesforPincode', {
      method: 'POST',
      body: {
        pinCode: pin,
        profile: profilePayload(session.env, secrets, 'shipping'),
      },
    });
    const now = new Date().toISOString();
    if (!finder.ok) {
      const message = blueDartErrorMessage(
        finder.json,
        finder.text,
        finder.status,
        'Blue Dart finder failed',
      );
      await db.doc(LOGISTICS_SETTINGS_DOC).set({
        blueDart: {
          lastTestAt: now,
          lastTestOk: false,
          lastTestMessage: message,
          updatedAt: now,
        },
        updatedAt: now,
      }, { merge: true });
      return { ok: false, env: session.env, loginId: session.loginId, message };
    }
    const message = `Connected (${session.env}) as ${session.loginId} · finder ${pin} OK`;
    await db.doc(LOGISTICS_SETTINGS_DOC).set({
      blueDart: {
        lastTestAt: now,
        lastTestOk: true,
        lastTestMessage: message,
        loginId: session.loginId,
        clientSecretSet: true,
        updatedAt: now,
      },
      updatedAt: now,
    }, { merge: true });
    return {
      ok: true,
      env: session.env,
      loginId: session.loginId,
      message,
    };
  } catch (err) {
    const now = new Date().toISOString();
    const message = err?.message || String(err);
    await db.doc(LOGISTICS_SETTINGS_DOC).set({
      blueDart: {
        lastTestAt: now,
        lastTestOk: false,
        lastTestMessage: message,
        updatedAt: now,
      },
      updatedAt: now,
    }, { merge: true });
    return { ok: false, message };
  }
}

function ynFlag(value) {
  return String(value || '').trim().toUpperCase() === 'Y';
}

function firstFinderRow(json) {
  const root = json?.GetServicesforPincodeResult
    || json?.ServiceCenterDetails
    || json?.ServiceCenterDetailsReference
    || json?.finder
    || json;
  if (Array.isArray(root)) return root[0] || null;
  if (root && typeof root === 'object') return root;
  return null;
}

/**
 * Location Finder for one or more pins (network area/hub — not account warehouses).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} pins
 */
export async function lookupBlueDartPincodes(db, pins = []) {
  const unique = [...new Set(
    (Array.isArray(pins) ? pins : [])
      .map(pin => String(pin || '').replace(/\D/g, '').slice(0, 6))
      .filter(pin => pin.length === 6),
  )].slice(0, 8);
  if (!unique.length) {
    throw new Error('Provide at least one 6-digit pincode.');
  }
  const secrets = await loadSecrets(db);
  const config = await loadBlueDartPublicConfig(db);
  const results = [];
  for (const pin of unique) {
    const finder = await blueDartFetch(db, '/finder/v1/GetServicesforPincode', {
      method: 'POST',
      body: {
        pinCode: pin,
        profile: profilePayload(config.env, secrets, 'shipping'),
      },
    });
    const row = firstFinderRow(finder.json);
    const error = finder.ok
      ? String(row?.ErrorMessage || '').trim()
      : blueDartErrorMessage(finder.json, finder.text, finder.status, 'Finder failed');
    const isError = Boolean(row?.IsError) || !finder.ok;
    results.push({
      pin,
      ok: !isError,
      error: isError ? (error || 'Finder failed') : null,
      description: String(row?.PincodeDescription || row?.PinDescription || '').trim(),
      areaCode: String(row?.AreaCode || '').trim().toUpperCase(),
      serviceCenterCode: String(row?.ServiceCenterCode || '').trim().toUpperCase(),
      airOutbound: ynFlag(row?.ApexOutbound),
      surfaceOutbound: ynFlag(row?.GroundOutbound),
      dpOutbound: ynFlag(row?.DomesticPriorityOutbound),
    });
  }
  return {
    ok: true,
    account: {
      originArea: String(secrets.originArea || config.originArea || '').trim().toUpperCase(),
      customerPincode: String(secrets.customerPincode || config.customerPincode || '').replace(/\D/g, '').slice(0, 6),
      customerCode: String(secrets.customerCode || config.customerCode || '').trim(),
    },
    results,
  };
}

function splitAddressLines(address, maxLen = 30) {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  const lines = ['', '', ''];
  if (!text) {
    lines[0] = 'Address';
    return lines;
  }
  const words = text.split(' ');
  let idx = 0;
  for (const word of words) {
    const next = lines[idx] ? `${lines[idx]} ${word}` : word;
    if (next.length <= maxLen) {
      lines[idx] = next;
    } else if (idx < 2) {
      idx += 1;
      lines[idx] = word.slice(0, maxLen);
    } else {
      lines[2] = `${lines[2]} ${word}`.trim().slice(0, maxLen);
    }
  }
  if (!lines[0]) lines[0] = text.slice(0, maxLen);
  return lines;
}

function mobile10(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function pin6(raw) {
  return String(raw || '').replace(/\D/g, '').slice(0, 6);
}

function nextPickupIst() {
  const ist = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const d = new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    10,
    30,
    0,
    0,
  ));
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function pdfFromPrintContent(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.from(raw);
  if (typeof raw === 'string') {
    const compact = raw.replace(/\s/g, '');
    if (!compact) return null;
    return Buffer.from(compact, 'base64');
  }
  return null;
}

/**
 * Shrink official A4S onto 100×150 mm (uniform scale, centered). No crop or redraw.
 * @param {Buffer} pdfBuffer
 */
export async function fitBlueDartWaybillToLabel(pdfBuffer) {
  const src = await PDFDocument.load(pdfBuffer);
  const srcPage = src.getPage(0);
  const { width, height } = srcPage.getSize();
  const labelW = BLUE_DART_LABEL_WIDTH_MM / 25.4 * 72;
  const labelH = BLUE_DART_LABEL_HEIGHT_MM / 25.4 * 72;
  if (Math.abs(width - labelW) < 2 && Math.abs(height - labelH) < 2) {
    return Buffer.from(pdfBuffer);
  }
  const scale = Math.min(labelW / width, labelH / height);
  const dw = width * scale;
  const dh = height * scale;
  const out = await PDFDocument.create();
  const embedded = await out.embedPage(srcPage);
  const page = out.addPage([labelW, labelH]);
  page.drawPage(embedded, {
    x: (labelW - dw) / 2,
    y: (labelH - dh) / 2,
    width: dw,
    height: dh,
  });
  return Buffer.from(await out.save());
}

async function saveWaybillPdf(awb, buffer, kind = '100x150') {
  const suffix = kind === 'a4s' ? 'a4' : '100x150';
  const fileName = `${awb}-${suffix}.pdf`;
  const storagePath = `logistics/bluedart-awb/${awb}/${fileName}`;
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  const token = randomUUID();
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: 'application/pdf',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return { storagePath, fileName, contentType: 'application/pdf' };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} storagePath
 */
export async function readBlueDartWaybillPdf(db, storagePath) {
  void db;
  const path = String(storagePath || '').trim();
  if (!path) throw new Error('Waybill storage path is missing.');
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new Error('Blue Dart waybill PDF is not in storage.');
  const [buffer] = await file.download();
  return {
    contentBase64: buffer.toString('base64'),
    contentType: 'application/pdf',
    fileName: path.split('/').pop() || 'waybill.pdf',
  };
}

function pinFromText(raw) {
  const match = /\b(\d{6})\b/.exec(String(raw || ''));
  return match?.[1] || '';
}

function phoneFromText(raw) {
  const match = /(?:\+91[-\s]?)?([6-9]\d{9})\b/.exec(String(raw || ''));
  return match?.[1] || '';
}

async function loadSiteShipFrom(db, site) {
  const snap = await db.doc(LOGISTICS_SETTINGS_DOC).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const key = String(site || '').trim() || 'cochin';
  const address = String(data.fromAddresses?.[key] || '').trim();
  const contact = data.fromSiteContacts?.[key] && typeof data.fromSiteContacts[key] === 'object'
    ? data.fromSiteContacts[key]
    : {};
  return {
    address,
    phone: String(contact.phone || contact.mobile || contact.mobileNumber || '').trim(),
    gstin: String(contact.gstin || '').trim(),
  };
}

async function resolveBlueDartShipFromOrigin(db, secrets, input = {}) {
  const sitePin = pin6(blueDartPickupPinForSite(input.shipFromSite) || input.pincode);
  const accountPin = pin6(secrets.customerPincode);
  const pin = sitePin || accountPin;
  const accountArea = String(secrets.originArea || '').trim().toUpperCase();
  let area = accountArea;
  if (sitePin) {
    try {
      const looked = await lookupBlueDartPincodes(db, [sitePin]);
      const row = looked.results?.[0];
      const found = String(row?.areaCode || '').trim().toUpperCase();
      // This customer can only register pickup in the contracted origin (COK).
      if (row?.ok && found && found === accountArea) area = found;
    } catch {
      // Keep account area if Finder is down.
    }
  }
  return { pin, area, usedSitePin: Boolean(sitePin) };
}

function isMissingBlueDartPickupRoute(res) {
  if (!res) return false;
  if (res.status === 404) return true;
  const blob = `${res.text || ''} ${res.json?.title || ''} ${res.json?.message || ''}`;
  return /index was outside|not found|no such resource/i.test(blob);
}

const BLUE_DART_STANDALONE_PICKUP_UNAVAILABLE =
  'Blue Dart cannot register pickup after the AWB exists on this account. '
  + 'Pickup is requested with Generate AWB (next working day around 4:00 pm IST from this ship-from). '
  + 'Refresh tracking, or call Blue Dart with this AWB.';

export async function registerBlueDartPickupAtAddress(db, input = {}) {
  const secrets = await loadSecrets(db);
  const config = await loadBlueDartPublicConfig(db);
  const pin = pin6(input.pincode);
  const area = String(input.area || secrets.originArea || '').trim().toUpperCase();
  const addr = splitAddressLines(input.address);
  const phone = mobile10(input.phone);
  const pickupDt = input.pickupMs ? new Date(input.pickupMs) : nextPickupIst();
  const awb = String(input.awb || '').replace(/\D/g, '');
  const productCode = String(input.productCode || 'E').trim().slice(0, 1).toUpperCase() || 'E';
  const pickupTime = pickupTimeHhMm(input.pickupTime || '1600');
  const requestBase = {
    AreaCode: area,
    ContactPersonName: String(input.contactName || secrets.customerName || 'YESWEIGH').slice(0, 30),
    CustomerAddress1: addr[0],
    CustomerAddress2: addr[1],
    CustomerAddress3: addr[2],
    CustomerCode: secrets.customerCode,
    CustomerName: String(secrets.customerName || 'YESWEIGH').slice(0, 30),
    CustomerPincode: pin,
    CustomerTelephoneNumber: phone,
    DoxNDox: blueDartDoxNDox(input.shipmentMode),
    IsForcePickup: true,
    IsReversePickup: false,
    MobileTelNo: phone,
    NumberofPieces: Math.max(1, Number(input.pieceCount) || 1),
    OfficeCloseTime: '18:00',
    ProductCode: productCode,
    ReferenceNo: sanitizeBlueDartRef(input.referenceNo || awb),
    Remarks: String(input.remarks || 'Warehouse pickup').replace(/[^a-zA-Z0-9 .]/g, ' ').slice(0, 30),
    RouteCode: '99',
    ShipmentPickupDate: `/Date(${pickupDt.getTime()})/`,
    ShipmentPickupTime: pickupTime,
    VolumeWeight: Number(input.weightKg) || 0.5,
    WeightofShipment: Number(input.weightKg) || 0.5,
    isToPayShipper: String(input.freightBillingMode || '').toLowerCase() === 'fod',
  };
  const profile = profilePayload(config.env, secrets, 'shipping');
  const paths = ['/pickup/v1RegisterPickup', '/pickup/v1/RegisterPickup'];

  async function postPickup(includeAwb, code) {
    const body = {
      Request: {
        ...requestBase,
        ProductCode: code,
        ...(includeAwb && awb ? { AWBNo: [awb] } : {}),
      },
      Profile: profile,
    };
    let res = await blueDartFetch(db, paths[0], { method: 'POST', body });
    if (isMissingBlueDartPickupRoute(res)) {
      res = await blueDartFetch(db, paths[1], { method: 'POST', body });
    }
    const row = res.json?.RegisterPickupResult
      || res.json?.PickupRegistrationResponse
      || res.json;
    const token = String(row?.TokenNumber || row?.tokenNumber || '').trim();
    const message = isMissingBlueDartPickupRoute(res)
      ? BLUE_DART_STANDALONE_PICKUP_UNAVAILABLE
      : compactBlueDartError(
        res.json,
        res.text,
        res.status,
        'Blue Dart pickup registration failed',
      );
    const failed = Boolean(row?.IsError) || !res.ok;
    return { res, row, token, message, failed, missingRoute: isMissingBlueDartPickupRoute(res) };
  }

  const attempt = await postPickup(Boolean(awb), productCode);
  if (attempt.missingRoute) {
    throw new Error(BLUE_DART_STANDALONE_PICKUP_UNAVAILABLE);
  }
  let next = attempt;
  if (next.failed && !next.token && awb && /awb|waybill|invalid/i.test(next.message)) {
    next = await postPickup(false, productCode);
    if (next.missingRoute) throw new Error(BLUE_DART_STANDALONE_PICKUP_UNAVAILABLE);
  }
  if (next.failed && !next.token && productCode === 'D') {
    next = await postPickup(Boolean(awb), 'E');
    if (next.missingRoute) throw new Error(BLUE_DART_STANDALONE_PICKUP_UNAVAILABLE);
  }

  const { row, token, message, failed } = next;
  const alreadyRegistered = /already\s+(register|exist|generat)/i.test(message)
    || /pickup\s+already/i.test(message);
  if (failed && !token && !alreadyRegistered) {
    console.error('registerBlueDartPickupAtAddress', message, {
      status: next.res.status,
      pin,
      area,
      productCode,
      awb: awb || null,
    });
    throw new Error(message);
  }
  return {
    ok: !failed || Boolean(token) || alreadyRegistered,
    alreadyRegistered,
    tokenNumber: token || null,
    pickupDate: `${pickupDt.getUTCFullYear()}-${String(pickupDt.getUTCMonth() + 1).padStart(2, '0')}-${String(pickupDt.getUTCDate()).padStart(2, '0')}`,
    pickupTime: pickupTime.replace(':', ''),
    pickupPin: pin,
    originArea: area,
    raw: row,
  };
}

const BLUE_DART_PARTNER_IDS = new Set([
  'bluedart_air',
  'bluedart_surface',
  'bluedart_domestic',
]);

/**
 * Register first-mile pickup for an existing Blue Dart AWB and persist the token.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} bookingId
 */
export async function registerBlueDartPickupForBooking(db, bookingId) {
  const id = String(bookingId || '').trim();
  if (!id) throw new Error('Booking is required.');
  const ref = db.collection('logisticsBookings').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Logistics booking not found.');
  const data = snap.data() || {};
  const partnerId = String(data.partnerId || '').trim();
  if (!BLUE_DART_PARTNER_IDS.has(partnerId)) {
    throw new Error('This booking is not a Blue Dart shipment.');
  }
  const status = String(data.status || '').trim();
  if (status === 'cancelled' || status === 'returned') {
    throw new Error('Cancelled or returned shipments cannot request pickup.');
  }
  const awb = String(data.consignmentNo || data.trackingNo || '').replace(/\D/g, '');
  if (awb.length < 8) throw new Error('This booking has no Blue Dart AWB.');

  const existing = data.blueDartPickup && typeof data.blueDartPickup === 'object'
    ? data.blueDartPickup
    : {};
  const existingToken = String(existing.tokenNumber || '').trim();
  if (existing.registered === true && existingToken) {
    return { ok: true, alreadyRegistered: true, pickup: existing };
  }

  const shipFromSite = String(data.shipFromSite || 'cochin').trim() || 'cochin';
  const site = await loadSiteShipFrom(db, shipFromSite);
  const address = String(data.shipFromAddress || site.address || '').trim();
  if (!address) {
    throw new Error('Ship-from address is missing. Set it in Logistics Settings.');
  }
  const secrets = await loadSecrets(db);
  const origin = await resolveBlueDartShipFromOrigin(db, secrets, {
    shipFromSite,
    pincode: pinFromText(address),
  });
  if (!origin.pin) {
    throw new Error('Ship-from pincode is missing. Set the Blue Dart pickup pin for this site.');
  }
  const phone = mobile10(site.phone) || mobile10(phoneFromText(address)) || '8803333444';

  const boxes = Array.isArray(data.boxes) ? data.boxes : [];
  const pieceCount = Math.max(1, Number(data.numberOfBoxes) || boxes.length || 1);
  const weightKg = boxes.reduce((sum, box) => {
    const kg = Number(box?.weightKg);
    return sum + (Number.isFinite(kg) && kg > 0 ? kg : 0);
  }, 0);
  const pickupDt = nextPickupIst();
  const created = await registerBlueDartPickupAtAddress(db, {
    awb,
    address,
    pincode: origin.pin,
    area: origin.area,
    phone,
    contactName: secrets.customerName || 'YESWEIGH',
    productCode: blueDartProductCode(partnerId),
    shipmentMode: data.shipmentMode,
    freightBillingMode: data.freightBillingMode,
    pieceCount,
    weightKg: weightKg || 0.5,
    pickupMs: pickupDt.getTime(),
    referenceNo: String(data.invoiceNumber || awb).slice(0, 20),
    remarks: 'YesWeigh AWB pickup',
  });

  const pickup = {
    ok: created.ok === true,
    registered: created.ok === true,
    pickupDate: created.pickupDate || null,
    pickupTime: created.pickupTime || '1600',
    pickupAddress: address,
    pickupPin: created.pickupPin || origin.pin || null,
    originArea: created.originArea || origin.area || null,
    destinationArea: existing.destinationArea || null,
    destinationLocation: existing.destinationLocation || null,
    tokenNumber: created.tokenNumber || existingToken || null,
    message: created.tokenNumber
      ? `Pickup token ${created.tokenNumber}`
      : (created.alreadyRegistered
        ? 'Pickup already registered with Blue Dart'
        : `Pickup requested at ${origin.pin}`),
    requestedAt: new Date().toISOString(),
  };
  const updatedAt = new Date().toISOString();
  await ref.set({ blueDartPickup: pickup, updatedAt }, { merge: true });
  return { ok: pickup.registered, alreadyRegistered: Boolean(created.alreadyRegistered), pickup };
}

export async function cancelBlueDartPickup(db, input = {}) {
  const secrets = await loadSecrets(db);
  const config = await loadBlueDartPublicConfig(db);
  const token = String(input.tokenNumber || '').trim();
  if (!token) throw new Error('Pickup token is required to cancel.');
  const pickupMs = Number(input.pickupMs) || Date.now();
  const body = {
    Request: {
      TokenNo: /^\d+$/.test(token) ? Number(token) : token,
      PickupRegistrationDate: `/Date(${pickupMs})/`,
      Remarks: String(input.remarks || 'YesWeigh cancel').slice(0, 60),
    },
    Profile: profilePayload(config.env, secrets, 'shipping'),
  };
  let res = await blueDartFetch(db, '/pickup/v1/CancelPickup', {
    method: 'POST',
    body,
  });
  if (!res.ok || /not found|404/i.test(String(res.text || ''))) {
    res = await blueDartFetch(db, '/pickup/v1CancelPickup', {
      method: 'POST',
      body,
    });
  }
  const row = res.json?.CancelPickupResult || res.json?.CancelPickupResponseEntity || res.json;
  const failed = Boolean(row?.IsError) || !res.ok;
  if (failed) {
    throw new Error(blueDartErrorMessage(
      res.json,
      res.text,
      res.status,
      'Blue Dart pickup cancel failed',
    ));
  }
  return { ok: true, raw: row };
}

export async function cancelBlueDartWaybill(db, awb) {
  const number = String(awb || '').replace(/\D/g, '');
  if (!number) throw new Error('AWB is required to cancel.');
  const secrets = await loadSecrets(db);
  const config = await loadBlueDartPublicConfig(db);
  const body = {
    Request: { AWBNo: number },
    Profile: profilePayload(config.env, secrets, 'shipping'),
  };
  const res = await blueDartFetch(db, '/waybill/v1/CancelWaybill', {
    method: 'POST',
    body,
  });
  const row = res.json?.CancelWaybillResult || res.json;
  const failed = Boolean(row?.IsError) || !res.ok;
  if (failed) {
    const message = blueDartErrorMessage(
      res.json,
      res.text,
      res.status,
      'Blue Dart cancel waybill failed',
    );
    if (/already\s+cancel/i.test(message) || /cancelled/i.test(message) && /waybill/i.test(message)) {
      return { ok: true, awb: number, alreadyCancelled: true };
    }
    throw new Error(message);
  }
  return { ok: true, awb: number, alreadyCancelled: false };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{
 *   partnerId?: string,
 *   shipFromSite?: string,
 *   orderId?: string,
 *   consignee?: Record<string, unknown>,
 *   returnAddress?: Record<string, unknown> | null,
 *   boxes?: Array<Record<string, unknown>>,
 *   invoiceNumber?: string | null,
 *   invoiceValueInr?: number | null,
 *   sellerGstin?: string | null,
 *   shipmentMode?: string | null,
 *   freightBillingMode?: string | null,
 *   registerPickup?: boolean,
 * }} input
 */
export async function bookBlueDartShipment(db, input = {}) {
  const config = await loadBlueDartPublicConfig(db);
  const secrets = await loadSecrets(db);
  const partnerId = String(input.partnerId || 'bluedart_surface').trim();
  const productCode = blueDartProductCode(partnerId);
  const productType = blueDartProductType(input.shipmentMode);
  const consignee = input.consignee && typeof input.consignee === 'object' ? input.consignee : {};
  const boxes = Array.isArray(input.boxes) ? input.boxes : [];
  const destPin = pin6(consignee.pincode);
  if (!destPin || destPin.length !== 6) {
    throw new Error('Consignee pincode (6 digits) is required for Blue Dart booking.');
  }
  const consigneeMobile = mobile10(consignee.phone);
  if (!consigneeMobile) {
    throw new Error('Consignee phone is required for Blue Dart booking.');
  }
  if (!secrets.customerCode || !secrets.originArea) {
    throw new Error('Blue Dart CustomerCode / OriginArea missing. Save them in Logistics Settings.');
  }

  const addr = splitAddressLines(consignee.address);
  const returnSrc = input.returnAddress && typeof input.returnAddress === 'object'
    ? input.returnAddress
    : {};
  const siteShipFrom = await loadSiteShipFrom(db, input.shipFromSite);
  const pickupAddress = String(returnSrc.address || siteShipFrom.address || '').trim();
  const retAddr = splitAddressLines(pickupAddress || consignee.address);
  const shipperPhone = mobile10(returnSrc.phone)
    || mobile10(siteShipFrom.phone)
    || consigneeMobile;
  const origin = await resolveBlueDartShipFromOrigin(db, secrets, {
    shipFromSite: input.shipFromSite,
    pincode: returnSrc.pincode || pinFromText(pickupAddress),
  });
  if (input.originArea) {
    origin.area = String(input.originArea).trim().toUpperCase();
  }
  const shipperPin = origin.pin;
  if (!shipperPin) {
    throw new Error('Ship-from pincode is missing. Set it on the site address or Blue Dart API settings.');
  }
  const dims = boxes
    .map(box => ({
      Length: Number(box.lengthCm) || 0,
      Breadth: Number(box.widthCm) || 0,
      Height: Number(box.heightCm) || 0,
      Count: Math.max(1, Number(box.quantity) || 1),
    }))
    .filter(row => row.Length > 0 && row.Breadth > 0 && row.Height > 0);
  const weightKg = boxes.reduce((sum, box) => {
    const kg = Number(box.weightKg);
    return sum + (Number.isFinite(kg) && kg > 0 ? kg : 0);
  }, 0);
  const dimPieces = dims.reduce((sum, row) => sum + row.Count, 0);
  const pieceCount = Math.max(1, dimPieces || boxes.length || 1);
  const declared = Number(input.invoiceValueInr);
  const declaredValue = Number.isFinite(declared) && declared > 0 ? declared : 1000;
  const pickupDt = nextPickupIst();
  const pickupMs = pickupDt.getTime();
  const cref = sanitizeBlueDartRef(input.orderId || input.invoiceNumber) || `YW${Date.now()}`;
  const invoiceNo = blueDartAlnum(input.invoiceNumber, 10);
  const fod = String(input.freightBillingMode || '').toLowerCase() === 'fod';
  const subProductCode = blueDartSubProductCode(input.freightBillingMode);
  const registerPickup = input.registerPickup !== false;
  const gstin = gstin15(consignee.gstin);
  const sellerGstin = gstin15(input.sellerGstin);

  const payload = {
    Request: {
      Consignee: {
        ConsigneeAddress1: addr[0],
        ConsigneeAddress2: addr[1],
        ConsigneeAddress3: addr[2],
        ConsigneeAddressType: 'R',
        ConsigneeAttention: '',
        ConsigneeEmailID: String(consignee.email || ''),
        ConsigneeGSTNumber: gstin,
        ConsigneeLatitude: '',
        ConsigneeLongitude: '',
        ConsigneeMaskedContactNumber: '',
        ConsigneeMobile: consigneeMobile,
        ConsigneeName: String(consignee.name || 'Consignee').slice(0, 30),
        ConsigneePincode: destPin,
        ConsigneeTelephone: '',
      },
      Returnadds: {
        ManifestNumber: '',
        ReturnAddress1: retAddr[0],
        ReturnAddress2: retAddr[1],
        ReturnAddress3: retAddr[2],
        ReturnContact: String(returnSrc.name || secrets.customerName).slice(0, 30),
        ReturnEmailID: '',
        ReturnLatitude: '',
        ReturnLongitude: '',
        ReturnMaskedContactNumber: '',
        ReturnMobile: shipperPhone,
        ReturnPincode: shipperPin,
        ReturnTelephone: '',
      },
      Services: {
        AWBNo: '',
        ActualWeight: weightKg > 0 ? weightKg.toFixed(2) : '0.50',
        Commodity: blueDartCommodity(input.shipmentMode),
        CreditReferenceNo: cref,
        DeclaredValue: declaredValue,
        Dimensions: dims,
        ECCN: '',
        InvoiceNo: invoiceNo,
        PDFOutputNotRequired: input.pdfOutputNotRequired === true,
        PackType: '',
        PickupDate: `/Date(${pickupMs})/`,
        PickupTime: '1600',
        PieceCount: String(pieceCount),
        ProductCode: productCode,
        ProductType: productType,
        RegisterPickup: registerPickup,
        SpecialInstruction: '',
        SubProductCode: subProductCode,
        PrinterLableSize: BLUE_DART_PRINTER_LABEL_A4S,
        itemdtl: blueDartItemDetails({
          shipmentMode: input.shipmentMode,
          declaredValue,
          pieceCount,
          invoiceNumber: input.invoiceNumber,
        }),
        noOfDCGiven: 0,
      },
      Shipper: {
        CustomerAddress1: retAddr[0],
        CustomerAddress2: retAddr[1],
        CustomerAddress3: retAddr[2],
        CustomerCode: secrets.customerCode,
        CustomerEmailID: '',
        CustomerGSTNumber: sellerGstin,
        CustomerLatitude: '',
        CustomerLongitude: '',
        CustomerMaskedContactNumber: '',
        CustomerMobile: shipperPhone,
        CustomerName: secrets.customerName.slice(0, 50),
        CustomerPincode: shipperPin,
        CustomerTelephone: '',
        IsToPayCustomer: fod,
        OriginArea: origin.area,
        Sender: 'YESWEIGH',
        VendorCode: '',
      },
    },
    Profile: profilePayload(config.env, secrets, 'shipping'),
  };

  let res = await blueDartFetch(db, '/waybill/v1/GenerateWayBill', {
    method: 'POST',
    body: payload,
  });

  let result = res.json?.GenerateWayBillResult || res.json;
  let isError = Boolean(result?.IsError) || !res.ok;
  const firstError = blueDartErrorMessage(res.json, res.text, res.status, '');
  const originRejected = /invalid\s*area|sc\s*not\s*in\s*region|pincode|outbound service is not available|not authorized to register pickup/i.test(firstError);
  const accountPin = pin6(secrets.customerPincode);
  if (isError && originRejected && accountPin && accountPin !== shipperPin) {
    payload.Request.Shipper.OriginArea = secrets.originArea;
    payload.Request.Shipper.CustomerPincode = accountPin;
    payload.Request.Returnadds.ReturnPincode = accountPin;
    res = await blueDartFetch(db, '/waybill/v1/GenerateWayBill', {
      method: 'POST',
      body: payload,
    });
    result = res.json?.GenerateWayBillResult || res.json;
    isError = Boolean(result?.IsError) || !res.ok;
  }
  if (isError && registerPickup) {
    payload.Request.Services.RegisterPickup = false;
    res = await blueDartFetch(db, '/waybill/v1/GenerateWayBill', {
      method: 'POST',
      body: payload,
    });
    result = res.json?.GenerateWayBillResult || res.json;
  }

  const awb = String(result?.AWBNo || '').replace(/\D/g, '').trim();
  const failed = Boolean(result?.IsError) || !res.ok || !awb;
  if (failed) {
    const errMsg = blueDartErrorMessage(
      res.json,
      res.text,
      res.status,
      'Blue Dart waybill failed',
    );
    const recovered = parseAlreadyGeneratedWaybill(errMsg, result);
    if (!recovered) {
      throw new Error(errMsg);
    }
    return {
      ok: true,
      awb: recovered.awb,
      env: config.env,
      productCode,
      productType,
      destinationArea: recovered.destinationArea,
      destinationLocation: recovered.destinationLocation,
      creditReferenceNo: result?.CCRCRDREF || cref,
      pickupRegistered: false,
      pickupDate: null,
      pickupTime: null,
      pickupAddress: pickupAddress || null,
      pickupPin: pin6(payload.Request.Shipper.CustomerPincode) || shipperPin,
      originArea: payload.Request.Shipper.OriginArea || origin.area,
      pickupToken: null,
      pickupMessage: 'Waybill already generated — continuing.',
      documents: null,
    };
  }

  const officialPdf = pdfFromPrintContent(result.AWBPrintContent);
  let documents = null;
  if (officialPdf && officialPdf.length > 100) {
    const cachedAt = new Date().toISOString();
    const savedA4 = await saveWaybillPdf(awb, officialPdf, 'a4s');
    let labelPdf = officialPdf;
    try {
      labelPdf = await fitBlueDartWaybillToLabel(officialPdf);
    } catch {
      labelPdf = officialPdf;
    }
    const savedLabel = await saveWaybillPdf(awb, labelPdf, '100x150');
    documents = {
      awb,
      waybill: {
        ...savedLabel,
        cachedAt,
        labelSize: '100x150',
      },
      awbA4: {
        ...savedA4,
        cachedAt,
        labelSize: 'a4s',
      },
    };
  }

  const acceptedPin = pin6(payload.Request.Shipper.CustomerPincode) || shipperPin;
  const pickupMessage = payload.Request.Services.RegisterPickup
    ? `Pickup requested at ${acceptedPin}`
    : 'Not registered';

  return {
    ok: true,
    awb,
    env: config.env,
    productCode,
    productType,
    destinationArea: result.DestinationArea || null,
    destinationLocation: result.DestinationLocation || null,
    creditReferenceNo: result.CCRCRDREF || cref,
    pickupRegistered: Boolean(payload.Request.Services.RegisterPickup),
    pickupDate: `${pickupDt.getUTCFullYear()}-${String(pickupDt.getUTCMonth() + 1).padStart(2, '0')}-${String(pickupDt.getUTCDate()).padStart(2, '0')}`,
    pickupTime: '1600',
    pickupAddress: pickupAddress || null,
    pickupPin: acceptedPin,
    originArea: payload.Request.Shipper.OriginArea || origin.area,
    pickupToken: null,
    pickupMessage,
    documents,
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function scanToHistory(scan) {
  const date = String(scan?.ScanDate || scan?.Date || '').trim();
  const time = String(scan?.ScanTime || scan?.Time || '').trim();
  const at = [date, time].filter(Boolean).join(' ');
  return {
    at: at || '',
    location: String(scan?.ScannedLocation || scan?.ScanLocation || scan?.Location || '').trim(),
    activity: String(scan?.Scan || scan?.ScanCode || scan?.Status || scan?.Remarks || '').trim(),
  };
}

function shipmentFromTrackJson(json) {
  const data = json?.ShipmentData || json?.ScanDetail || json;
  const shipment = data?.Shipment || data?.shipment || data;
  const list = asArray(shipment);
  return list[0] || shipment || data || {};
}

function xmlTag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? String(match[1] || '').trim() : '';
}

function parseBlueDartTrackXml(xml) {
  const error = /<Error>([^<]+)<\/Error>/i.exec(xml);
  if (error) return { error: error[1].trim() };
  const ship = /<Shipment\b([^>]*)>([\s\S]*?)<\/Shipment>/i.exec(xml);
  if (!ship) return { error: 'No shipment data.' };
  const attrs = ship[1] || '';
  const body = ship[2] || '';
  const awb = /WaybillNo="([^"]*)"/i.exec(attrs)?.[1]
    || xmlTag(body, 'WaybillNo');
  const scans = [];
  const scanRe = /<ScanDetail>([\s\S]*?)<\/ScanDetail>/gi;
  let row;
  while ((row = scanRe.exec(body))) {
    scans.push({
      Scan: xmlTag(row[1], 'Scan'),
      ScanDate: xmlTag(row[1], 'ScanDate'),
      ScanTime: xmlTag(row[1], 'ScanTime'),
      ScannedLocation: xmlTag(row[1], 'ScannedLocation'),
    });
  }
  return {
    awb: String(awb || '').replace(/\D/g, ''),
    status: xmlTag(body, 'Status'),
    statusType: xmlTag(body, 'StatusType'),
    origin: xmlTag(body, 'Origin'),
    destination: xmlTag(body, 'Destination'),
    productType: xmlTag(body, 'ProductType') || xmlTag(body, 'Service'),
    scans,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} awb
 */
export async function fetchBlueDartTrack(db, awb) {
  const id = String(awb || '').replace(/\D/g, '').trim();
  if (!id) {
    return {
      awb: '',
      ok: false,
      error: 'AWB is required.',
      status: null,
      origin: null,
      destination: null,
      consignmentType: null,
      bookedAt: null,
      deliveredAt: null,
      history: [],
      sourceUrl: 'https://www.bluedart.com/web/guest/trackdartplus',
      fetchedAt: new Date().toISOString(),
    };
  }
  const config = await loadBlueDartPublicConfig(db);
  const secrets = await loadSecrets(db);
  const license = licenseFor(config.env, 'tracking', secrets);
  const query = new URLSearchParams({
    handler: 'tnt',
    action: 'custawbquery',
    loginid: secrets.loginId,
    awb: 'awb',
    numbers: id,
    format: 'xml',
    lickey: license,
    verno: '1.3',
    scan: '1',
  });
  const res = await blueDartFetch(db, `/tracking/v1?${query.toString()}`, {
    method: 'GET',
  });
  const fetchedAt = new Date().toISOString();
  const sourceUrl = `https://www.bluedart.com/web/guest/trackdartplus?trackFor=0&trackNo=${id}`;
  const looksXml = /<ShipmentData|<Shipment\b|<Error>/i.test(res.text || '');
  const parsedXml = looksXml
    ? parseBlueDartTrackXml(res.text || '')
    : { error: '', awb: '', status: '', statusType: '', origin: '', destination: '', productType: '', scans: [] };
  if (looksXml && parsedXml.error && !parsedXml.awb) {
    return {
      awb: id,
      ok: false,
      error: parsedXml.error,
      status: null,
      origin: null,
      destination: null,
      consignmentType: null,
      bookedAt: null,
      deliveredAt: null,
      history: [],
      sourceUrl,
      fetchedAt,
    };
  }
  if (!res.ok && !parsedXml.awb && !parsedXml.status) {
    return {
      awb: id,
      ok: false,
      error: blueDartErrorMessage(res.json, res.text, res.status, 'Blue Dart tracking failed'),
      status: null,
      origin: null,
      destination: null,
      consignmentType: null,
      bookedAt: null,
      deliveredAt: null,
      history: [],
      sourceUrl,
      fetchedAt,
    };
  }

  let shipment = parsedXml.awb || parsedXml.status
    ? {
      AWBNo: parsedXml.awb,
      Status: parsedXml.status,
      StatusType: parsedXml.statusType,
      Origin: parsedXml.origin,
      Destination: parsedXml.destination,
      ProductType: parsedXml.productType,
      Scans: { ScanDetail: parsedXml.scans },
    }
    : shipmentFromTrackJson(res.json);
  const scansRaw = shipment?.Scans?.ScanDetail
    || shipment?.ScanDetail
    || shipment?.Scans
    || parsedXml.scans
    || [];
  const history = asArray(scansRaw).map(scanToHistory).filter(row => row.activity || row.location);
  const status = String(
    shipment?.Status
    || shipment?.StatusType
    || history[0]?.activity
    || '',
  ).trim() || null;
  const notFound = /no information|incorrect waybill/i.test(status || '')
    || String(shipment?.StatusType || parsedXml.statusType || '') === 'NF';
  const deliveredAt = String(shipment?.DeliveryDate || shipment?.DeliveredDate || '').trim() || (
    /\bdelivered\b/i.test(status || '') ? fetchedAt : null
  );
  return {
    awb: String(shipment?.AWBNo || parsedXml.awb || id).replace(/\D/g, '') || id,
    ok: !notFound,
    error: notFound ? (status || 'No tracking information yet.') : null,
    status: notFound ? (status || 'No tracking information yet.') : status,
    statusType: shipment?.StatusType != null
      ? String(shipment.StatusType)
      : (parsedXml.statusType || null),
    origin: shipment?.Origin != null ? String(shipment.Origin) : (parsedXml.origin || null),
    destination: shipment?.Destination != null
      ? String(shipment.Destination)
      : (parsedXml.destination || null),
    consignmentType: shipment?.ProductType != null
      ? String(shipment.ProductType)
      : (parsedXml.productType || null),
    bookedAt: shipment?.NewWaybillDate || shipment?.BookingDate || null,
    deliveredAt,
    history,
    sourceUrl,
    fetchedAt,
  };
}

export { emptyPublic as emptyBlueDartPublicConfig };
