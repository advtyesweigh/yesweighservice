import { FieldValue, getFirestore } from 'firebase-admin/firestore';

async function applyMeezanInrCurrencySymbolWithLogin() {
  return null;
}

async function storeShopPosSecret() {}

export const SOFTWARE_SHOPS_COLLECTION = 'softwareShops';
export const SOFTWARE_SHOP_META_COLLECTION = 'softwareShopMeta';
export const SOFTWARE_SHOP_META_ID = 'sanoft';
export const SOURCE_ACCOUNT_MEEZAN = 'meezan';
export const SOURCE_ACCOUNT_WEIGHVOX = 'weighvox';
export const SOURCE_ACCOUNT_WEIGHVOX_LEGACY = 'weighvox-dubai';
export const SOURCE_ACCOUNT_YESWEIGH = 'yesweigh';
export const KNOWN_SOURCE_ACCOUNTS = [
  SOURCE_ACCOUNT_MEEZAN,
  SOURCE_ACCOUNT_WEIGHVOX_LEGACY,
  SOURCE_ACCOUNT_WEIGHVOX,
  SOURCE_ACCOUNT_YESWEIGH,
];

export function canonicalizeSourceAccount(value) {
  const account = asString(value);
  if (account === SOURCE_ACCOUNT_WEIGHVOX_LEGACY) return SOURCE_ACCOUNT_WEIGHVOX;
  return account || SOURCE_ACCOUNT_YESWEIGH;
}

const API_BASE = 'https://api1.sanoft.com/dealer';
const PAGE_SIZE = 200;
const BATCH_LIMIT = 400;
const TOKEN_KEY = /token|password|secret|auth/i;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Matches dealer portal Renewals: Days Back = 0, Days Forward = 14. */
export const SANOFT_RENEWAL_DAYS_BACK = 0;
export const SANOFT_RENEWAL_DAYS_FORWARD = 14;

function asString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ymd(value) {
  const text = asString(value);
  if (!text) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

const INSTALL_DATE_KEYS = [
  'install_date',
  'installDate',
  'installation_date',
  'installationDate',
  'activation_date',
  'activationDate',
  'activated_at',
  'activatedAt',
  'created_date',
  'createdDate',
  'created_at',
  'createdAt',
  'date_created',
  'dateCreated',
  'shop_created',
  'shopCreated',
  'registered_date',
  'registeredDate',
  'start_date',
  'startDate',
  'subscription_start_date',
  'subscriptionStartDate',
  'subscription_start',
  'subscriptionStart',
  'created',
];

function ymdDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const text = asString(value);
  if (!text) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso) return iso[1];
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
}

export function pickSanoftInstallationDate(row = {}, extras = {}) {
  for (const key of INSTALL_DATE_KEYS) {
    const text = ymdDate(row[key]) || ymdDate(extras[key]);
    if (text) return text;
  }
  return '';
}

function istTodayYmd(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDaysYmd(ymdValue, days) {
  const [y, m, d] = ymdValue.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + days);
  return new Date(utc).toISOString().slice(0, 10);
}

export function sanoftRenewalWindow(now = new Date()) {
  const today = istTodayYmd(now);
  return {
    from: addDaysYmd(today, -SANOFT_RENEWAL_DAYS_BACK),
    to: addDaysYmd(today, SANOFT_RENEWAL_DAYS_FORWARD),
  };
}

function flagTrue(value) {
  if (value === true || value === 1) return true;
  const text = asString(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function mentionsCancelled(value) {
  return /\bcancell?ed\b/.test(asString(value).toLowerCase());
}

export function shopLooksCancelled(row = {}) {
  if (
    flagTrue(row.cancelled)
    || flagTrue(row.is_cancelled)
    || flagTrue(row.isCancelled)
    || flagTrue(row.is_canceled)
    || flagTrue(row.isCanceled)
    || flagTrue(row.canceled)
  ) return true;
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  if (
    flagTrue(extras.cancelled)
    || flagTrue(extras.isCancelled)
    || flagTrue(extras.isCanceled)
    || flagTrue(extras.is_cancelled)
  ) return true;
  const subscription = row.subscription && typeof row.subscription === 'object' ? row.subscription : {};
  return [
    row.status,
    row.rawStatus,
    row.plan_status,
    row.planStatus,
    extras.planStatus,
    extras.status,
    extras.rawStatus,
    subscription.status,
    subscription.plan_status,
  ].some(mentionsCancelled);
}

/** Matches Sanoft Renewals: end date from today through +14 days (not already expired). */
export function computeShopStatus(subscriptionEnd, now = new Date(), cancelled = false) {
  if (cancelled) return 'CANCELLED';
  const end = ymd(subscriptionEnd);
  if (!end) return 'EXPIRED';
  const { from, to } = sanoftRenewalWindow(now);
  if (end < from) return 'EXPIRED';
  if (end <= to) return 'EXPIRING SOON';
  return 'ACTIVE';
}

function named(value) {
  if (typeof value === 'string' || typeof value === 'number') return asString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return asString(value.name);
}

function toCamel(key) {
  return String(key).replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

function shopUsers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const user = row && typeof row === 'object' ? row : {};
    return {
      userId: asNumber(user.id) || asString(user.id),
      username: asString(user.username),
      firstName: asString(user.first_name),
      lastName: asString(user.last_name),
      email: asString(user.email),
      blocked: user.d_is_blocked === true,
    };
  });
}

const EXTRA_API_KEYS = [
  ['bluetoothScaleValidity', 'bluetooth_scale_validity'],
  ['customerSupportValidity', 'customer_support_validity'],
  ['kitchenDisplayValidity', 'kitchen_display_validity'],
  ['queueDisplayValidity', 'queue_display_validity'],
  ['onlineCartValidity', 'online_cart_validity'],
  ['warehouseValidity', 'warehouse_validity'],
  ['quickbookSupportValidity', 'quickbook_support_validity'],
  ['zohoSupportValidity', 'zoho_support_validity'],
  ['taxType', 'tax_type'],
  ['taxRegion', 'tax_region'],
  ['taxPreference', 'tax_preference'],
  ['category', 'category'],
  ['subCategory', 'sub_category'],
  ['planStatus', 'plan_status'],
  ['cancelled', 'cancelled'],
  ['isCancelled', 'is_cancelled'],
  ['isCanceled', 'is_canceled'],
  ['isActive', 'is_active'],
  ['currencyName', 'currency_name'],
  ['currencySymbol', 'currency_symbol'],
  ['units', 'units'],
];

const MAPPED_API_KEYS = new Set([
  'id',
  'shop_name',
  'mobile_no',
  'dealer',
  'subscription',
  'users',
  'status',
  'subscription_end_date',
  'install_date',
  'installation_date',
  'activation_date',
  'activated_at',
  'created_date',
  'created_at',
  'date_created',
  'shop_created',
  'registered_date',
  'start_date',
  'subscription_start_date',
  'subscription_start',
  'created',
  'expense_validity',
  'image_support_validity',
  'kot_validity',
  'kot_lite_validity',
  'smart_scale_validity',
  'currency',
  'additional_sales_balance',
  'country',
  'ext_access_token',
  'feedback_token',
  'config',
  'chain',
  'cover_image',
  'shop_logo',
  'external_sales_sync_config',
  'external_sales_sync_platform',
  ...EXTRA_API_KEYS.map(([, apiKey]) => apiKey),
]);

function extrasFromShop(row) {
  const extras = {};
  for (const [key, apiKey] of EXTRA_API_KEYS) {
    const text = ymd(row[apiKey]) || asString(row[apiKey]);
    if (text) extras[key] = text;
  }
  const dealerPhone = asString(row.dealer?.customer_support_number);
  if (dealerPhone) extras.dealerPhone = dealerPhone;
  const subscriptionType = asString(row.subscription?.type);
  if (subscriptionType) extras.subscriptionType = subscriptionType;

  for (const [key, value] of Object.entries(row || {})) {
    if (MAPPED_API_KEYS.has(key) || TOKEN_KEY.test(key)) continue;
    if (value == null || typeof value === 'object') continue;
    const text = ymd(value) || asString(value);
    if (!text) continue;
    const camel = toCamel(key);
    if (!extras[camel]) extras[camel] = text;
  }
  return extras;
}

export function softwareShopDocId(sourceAccount, shopId) {
  return `${canonicalizeSourceAccount(sourceAccount)}_${shopId}`;
}

export function parseSoftwareShopDocId(docId) {
  const text = asString(docId);
  if (/^\d+$/.test(text)) {
    return { sourceAccount: SOURCE_ACCOUNT_MEEZAN, shopId: Number(text), legacy: true };
  }
  for (const account of KNOWN_SOURCE_ACCOUNTS) {
    const prefix = `${account}_`;
    if (text.startsWith(prefix)) {
      const shopId = asNumber(text.slice(prefix.length));
      if (shopId) return { sourceAccount: account, shopId, legacy: false };
    }
  }
  return null;
}

export function mapSanoftShop(row, syncedAtIso, sourceAccount = SOURCE_ACCOUNT_MEEZAN) {
  const shopId = asNumber(row?.id);
  if (!shopId) return null;
  const account = canonicalizeSourceAccount(sourceAccount);
  const subscriptionEnd = ymd(row.subscription_end_date);
  const cancelled = shopLooksCancelled(row);
  const extras = extrasFromShop(row);
  return {
    shopId,
    sourceAccount: account,
    name: asString(row.shop_name),
    phone: asString(row.mobile_no),
    subscription: named(row.subscription),
    status: computeShopStatus(subscriptionEnd, new Date(), cancelled),
    rawStatus: asString(row.status) || asString(row.plan_status),
    cancelled,
    subscriptionEnd,
    sanoftInstallationDate: pickSanoftInstallationDate(row, extras),
    dealer: named(row.dealer),
    expenseValidity: ymd(row.expense_validity),
    imageSupport: ymd(row.image_support_validity),
    kotValidity: ymd(row.kot_validity),
    kotLite: ymd(row.kot_lite_validity),
    smartScale: ymd(row.smart_scale_validity),
    currency: asString(row.currency),
    salesBalance: asNumber(row.additional_sales_balance),
    country: asString(row.country),
    users: shopUsers(row.users),
    extras,
    syncedAt: syncedAtIso,
  };
}

function assertNoSecrets(record) {
  const walk = (obj) => {
    for (const [key, value] of Object.entries(obj || {})) {
      if (TOKEN_KEY.test(key)) {
        throw new Error('Refusing to store a credential-like field.');
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value);
    }
  };
  walk(record);
}

async function sanoftRequest(path, { method = 'GET', token = '', body } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = token;
  if (method === 'POST' && !token) headers['User-Interface'] = 'ios';

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.status) !== 200) {
    const message = asString(payload.message) || `Sanoft request failed (${response.status}).`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return payload;
}

export async function loginSanoftDealer(username, password) {
  const payload = await sanoftRequest('/login/', {
    method: 'POST',
    body: { username, password },
  });
  const token = asString(payload?.data?.auth_token);
  if (!token) throw new Error('Sanoft login did not return an auth token.');
  return token;
}

export async function fetchAllSanoftShops(token, extraParams = {}) {
  const shops = [];
  let offset = 0;
  let count = Infinity;
  let apiCalls = 0;

  while (offset < count) {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE_SIZE),
      search: '',
      ...extraParams,
    });
    const payload = await sanoftRequest(`/shops/?${params}`, { token });
    apiCalls += 1;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    count = Number(payload.count);
    if (!Number.isFinite(count)) count = offset + rows.length;
    shops.push(...rows);
    if (!rows.length) break;
    offset += rows.length;
  }

  return { shops, apiCalls, count: Number.isFinite(count) ? count : shops.length };
}

/** Same query as dealer.sanoft.com/console/renew-shops (Days Back 0, Days Forward 14). */
export async function fetchSanoftRenewalShops(token, now = new Date()) {
  const { from, to } = sanoftRenewalWindow(now);
  return fetchAllSanoftShops(token, {
    subscription_end_from_date: from,
    subscription_end_to_date: to,
  });
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newerTimestamp(left, right) {
  return timestampMillis(right) > timestampMillis(left) ? right : left;
}

async function commitBatches(ops) {
  const db = getFirestore();
  let batch = db.batch();
  let writes = 0;
  let committed = 0;

  const flush = async () => {
    if (!writes) return;
    await batch.commit();
    committed += writes;
    batch = db.batch();
    writes = 0;
  };

  for (const apply of ops) {
    apply(batch);
    writes += 1;
    if (writes >= BATCH_LIMIT) await flush();
  }
  await flush();
  return committed;
}

async function loadVoidedShopIds() {
  try {
    const snap = await getFirestore()
      .collection(SOFTWARE_SHOPS_COLLECTION)
      .where('voided', '==', true)
      .get();
    return new Set(snap.docs.map((docSnap) => docSnap.id));
  } catch {
    return new Set();
  }
}

function applyLocalVoid(payload) {
  return {
    ...payload,
    voided: true,
    status: 'VOIDED',
  };
}

async function upsertShops(docs) {
  const db = getFirestore();
  const col = db.collection(SOFTWARE_SHOPS_COLLECTION);
  const voidedIds = await loadVoidedShopIds();
  return commitBatches(docs.map((doc) => {
    assertNoSecrets(doc);
    const account = canonicalizeSourceAccount(doc.sourceAccount);
    const docId = softwareShopDocId(account, doc.shopId);
    const payload = {
      ...doc,
      sourceAccount: account,
      syncedAt: FieldValue.serverTimestamp(),
    };
    const next = voidedIds.has(docId) || flagTrue(doc.voided)
      ? applyLocalVoid(payload)
      : payload;
    return (batch) => {
      batch.set(col.doc(docId), next, { merge: true }); // keep follow-up flags + local void
    };
  }));
}

function contactMerge(keeper, extra) {
  const remarks = asString(keeper.lastFollowUpRemarks) || asString(extra.lastFollowUpRemarks);
  const lastChannel = asString(keeper.lastFollowUpChannel) || asString(extra.lastFollowUpChannel);
  return {
    ...(keeper.whatsappRenewalSentAt || extra.whatsappRenewalSentAt
      ? { whatsappRenewalSentAt: newerTimestamp(extra.whatsappRenewalSentAt, keeper.whatsappRenewalSentAt) || keeper.whatsappRenewalSentAt || extra.whatsappRenewalSentAt }
      : {}),
    ...(keeper.hasFollowUp || extra.hasFollowUp || remarks ? { hasFollowUp: true } : {}),
    ...(keeper.contactedAt || extra.contactedAt
      ? { contactedAt: newerTimestamp(extra.contactedAt, keeper.contactedAt) || keeper.contactedAt || extra.contactedAt }
      : {}),
    ...(remarks ? { lastFollowUpRemarks: remarks } : {}),
    ...(lastChannel === 'call' || lastChannel === 'whatsapp' ? { lastFollowUpChannel: lastChannel } : {}),
    ...(keeper.contactedViaCall || extra.contactedViaCall ? { contactedViaCall: true } : {}),
    ...(keeper.contactedViaWhatsApp || extra.contactedViaWhatsApp ? { contactedViaWhatsApp: true } : {}),
  };
}

function shopIdentity(docSnap) {
  const data = docSnap.data() || {};
  const parsed = parseSoftwareShopDocId(docSnap.id);
  const shopId = asNumber(data.shopId ?? data.id) || parsed?.shopId || 0;
  if (!shopId) return null;
  const tagged = asString(data.sourceAccount);
  const sourceAccount = canonicalizeSourceAccount(parsed?.legacy
    ? SOURCE_ACCOUNT_MEEZAN
    : (tagged || parsed?.sourceAccount || SOURCE_ACCOUNT_MEEZAN));
  return {
    shopId,
    sourceAccount,
    destId: softwareShopDocId(sourceAccount, shopId),
    legacy: Boolean(parsed?.legacy) || /^\d+$/.test(docSnap.id),
    tagged,
  };
}

export async function migrateLegacySoftwareShopDocs() {
  const db = getFirestore();
  const col = db.collection(SOFTWARE_SHOPS_COLLECTION);
  const snap = await col.get();
  const byId = new Map(snap.docs.map((docSnap) => [docSnap.id, docSnap]));
  const groups = new Map();
  const tags = [];

  for (const docSnap of snap.docs) {
    const identity = shopIdentity(docSnap);
    if (!identity) continue;
    const key = `${identity.sourceAccount}:${identity.shopId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ docSnap, ...identity });
    if (docSnap.id === identity.destId && identity.tagged !== identity.sourceAccount) {
      tags.push({ ref: docSnap.ref, sourceAccount: identity.sourceAccount, shopId: identity.shopId });
    }
  }

  const ops = [];
  let moved = 0;
  let deleted = 0;

  for (const rows of groups.values()) {
    const keeper = rows.find((row) => row.docSnap.id === row.destId)
      || rows.find((row) => !row.legacy)
      || rows[0];
    const destRef = col.doc(keeper.destId);
    const destSnap = byId.get(keeper.destId) || keeper.docSnap;
    let destData = destSnap.data() || {};

    if (destSnap.id !== keeper.destId) {
      destData = { ...destData, shopId: keeper.shopId, sourceAccount: keeper.sourceAccount };
      assertNoSecrets(destData);
      ops.push((batch) => {
        batch.set(destRef, destData, { merge: true });
      });
      moved += 1;
    }

    for (const row of rows) {
      if (row.docSnap.id === keeper.destId) continue;
      const extra = row.docSnap.data() || {};
      const followUps = await row.docSnap.ref.collection('followUps').get();
      const payload = {
        shopId: keeper.shopId,
        sourceAccount: keeper.sourceAccount,
        ...contactMerge(destData, extra),
      };
      assertNoSecrets(payload);
      ops.push((batch) => {
        batch.set(destRef, payload, { merge: true });
      });
      destData = { ...destData, ...payload };
      for (const followSnap of followUps.docs) {
        const data = followSnap.data() || {};
        assertNoSecrets(data);
        ops.push((batch) => {
          batch.set(destRef.collection('followUps').doc(followSnap.id), data, { merge: true });
        });
        ops.push((batch) => {
          batch.delete(followSnap.ref);
        });
      }
      ops.push((batch) => {
        batch.delete(row.docSnap.ref);
      });
      deleted += 1;
      moved += 1;
    }
  }

  for (const tag of tags) {
    ops.push((batch) => {
      batch.set(tag.ref, { sourceAccount: tag.sourceAccount, shopId: tag.shopId }, { merge: true });
    });
  }

  const written = await commitBatches(ops);
  return {
    scanned: snap.size,
    moved,
    deleted,
    tagged: tags.length,
    written,
  };
}

function normalizeAccounts(input = {}) {
  if (Array.isArray(input.accounts) && input.accounts.length) {
    return input.accounts
      .map((row) => ({
        sourceAccount: canonicalizeSourceAccount(row?.sourceAccount),
        username: asString(row?.username),
        password: asString(row?.password),
      }))
      .filter((row) => row.username && row.password);
  }
  const username = asString(input.username);
  const password = asString(input.password);
  if (!username || !password) return [];
  return [{
    sourceAccount: canonicalizeSourceAccount(input.sourceAccount),
    username,
    password,
  }];
}

async function syncOneSanoftAccount({ sourceAccount, username, password }) {
  const started = new Date();
  const token = await loginSanoftDealer(username, password);
  const { shops, apiCalls, count } = await fetchAllSanoftShops(token);
  const renewals = await fetchSanoftRenewalShops(token, started);
  const syncedAtIso = started.toISOString();
  const byId = new Map();
  for (const row of shops) {
    const shopId = asNumber(row?.id);
    if (shopId) byId.set(shopId, row);
  }
  const renewalIds = new Set();
  for (const row of renewals.shops) {
    const shopId = asNumber(row?.id);
    if (!shopId) continue;
    renewalIds.add(shopId);
    byId.set(shopId, row);
  }
  const docs = [];
  for (const row of byId.values()) {
    const mapped = mapSanoftShop(row, syncedAtIso, sourceAccount);
    if (!mapped) continue;
    if (renewalIds.has(mapped.shopId) && mapped.status !== 'CANCELLED' && mapped.status !== 'VOIDED') {
      mapped.status = 'EXPIRING SOON';
    }
    docs.push(mapped);
  }
  const upserted = await upsertShops(docs);
  const result = {
    sourceAccount,
    ok: true,
    fetched: shops.length,
    reported: count,
    upserted,
    renewals: renewalIds.size,
    apiCalls: apiCalls + renewals.apiCalls + 1,
    syncedAt: syncedAtIso,
  };

  await getFirestore().collection(SOFTWARE_SHOP_META_COLLECTION).doc(`${SOFTWARE_SHOP_META_ID}-${sourceAccount}`).set({
    ...result,
    error: null,
    lastSyncAt: FieldValue.serverTimestamp(),
  });

  return result;
}

export async function syncSanoftShopsHandler(input = {}) {
  const accounts = normalizeAccounts(input);
  if (!accounts.length) {
    throw new Error('Sanoft dealer credentials are not configured.');
  }

  const started = new Date();
  const migrated = await migrateLegacySoftwareShopDocs();
  const accountResults = [];
  for (const account of accounts) {
    try {
      accountResults.push(await syncOneSanoftAccount(account));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sanoft sync failed.';
      accountResults.push({
        sourceAccount: account.sourceAccount,
        ok: false,
        fetched: 0,
        reported: 0,
        upserted: 0,
        renewals: 0,
        apiCalls: 1,
        syncedAt: new Date().toISOString(),
        error: message,
      });
      await getFirestore().collection(SOFTWARE_SHOP_META_COLLECTION).doc(`${SOFTWARE_SHOP_META_ID}-${account.sourceAccount}`).set({
        sourceAccount: account.sourceAccount,
        ok: false,
        error: message,
        lastSyncAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  const ok = accountResults.some((row) => row.ok);
  const failed = accountResults.filter((row) => !row.ok).map((row) => `${row.sourceAccount}: ${row.error}`).join(' ');
  const result = {
    ok,
    collection: SOFTWARE_SHOPS_COLLECTION,
    fetched: accountResults.reduce((sum, row) => sum + row.fetched, 0),
    reported: accountResults.reduce((sum, row) => sum + row.reported, 0),
    upserted: accountResults.reduce((sum, row) => sum + row.upserted, 0),
    renewals: accountResults.reduce((sum, row) => sum + (row.renewals || 0), 0),
    apiCalls: accountResults.reduce((sum, row) => sum + (row.apiCalls || 0), 0),
    syncedAt: started.toISOString(),
    migrated: migrated.moved + migrated.deleted + migrated.tagged,
    accounts: accountResults,
    error: failed || null,
  };

  await getFirestore().collection(SOFTWARE_SHOP_META_COLLECTION).doc(SOFTWARE_SHOP_META_ID).set({
    ...result,
    lastSyncAt: FieldValue.serverTimestamp(),
  });

  if (!ok) throw new Error(failed || 'Sanoft dealer credentials are not configured.');

  return result;
}

export const MEEZAN_SANOFT_DEALER_ID = 14;
export const DEFAULT_SANOFT_SHOP_PASSWORD = 'test@12345';
const SHOP_API_BASE = 'https://api1.sanoft.com/api';
const SANOFT_CREATE_PLANS = {
  'sanoft-lite': { id: 32, key: 'sanoft-lite', name: 'Sanoft Lite' },
  'sanoft-pro': { id: 33, key: 'sanoft-pro', name: 'Sanoft Pro' },
  'sanoft-elite': { id: 34, key: 'sanoft-elite', name: 'Sanoft Elite' },
};

function failCreate(message, code = 'invalid-argument') {
  const err = new Error(message);
  err.code = code;
  throw err;
}

const USERNAME_MAX = 16;
const USERNAME_PART = 8;
const USERNAME_SKIP = /^(and|the|of|for|a|an|shop)$/;

function usernamePart(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, USERNAME_PART);
}

export function suggestSanoftUsername(shopName, fullName) {
  const source = asString(shopName) || asString(fullName);
  const words = source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !USERNAME_SKIP.test(word));
  const first = usernamePart(words[0] || '');
  const last = usernamePart(words.length > 1 ? words[words.length - 1] : '');
  const slug = (first && last && first !== last ? `${first}.${last}` : first || last)
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, USERNAME_MAX);
  return slug || 'shop';
}

function uniqueUsername(base, attempt) {
  if (attempt <= 1) return base;
  const suffix = String(attempt);
  return `${base.slice(0, Math.max(1, USERNAME_MAX - suffix.length))}${suffix}`;
}

async function refreshMeezanShop(shopId, dealerAuth = {}) {
  const username = asString(dealerAuth.username);
  const password = asString(dealerAuth.password);
  if (!shopId || !username || !password) return null;
  try {
    const token = await loginSanoftDealer(username, password);
    try {
      const payload = await sanoftRequest(`/shops/${shopId}/`, { token });
      const row = payload?.data;
      if (row && typeof row === 'object' && !Array.isArray(row) && asNumber(row.id) === shopId) {
        return row;
      }
    } catch {
      // Some dealer builds only expose the list endpoint.
    }
    const params = new URLSearchParams({
      offset: '0',
      limit: '5',
      search: String(shopId),
    });
    const payload = await sanoftRequest(`/shops/?${params}`, { token });
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return rows.find((row) => asNumber(row?.id) === shopId) || null;
  } catch {
    return null;
  }
}

async function registerSanoftShop(payload) {
  const params = new URLSearchParams({
    registration_channel: 'online',
    registration_type: 'trial-shop',
  });
  const response = await fetch(`${SHOP_API_BASE}/register/?${params}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.json().catch(() => ({}));
  return { httpStatus: response.status, raw };
}

export async function createSanoftShopHandler(input = {}, actor = {}, dealerAuth = {}) {
  const planKey = asString(input.planKey).toLowerCase();
  const plan = SANOFT_CREATE_PLANS[planKey];
  if (!plan) failCreate('Select Sanoft Lite, Pro, or Elite.');

  const shopName = asString(input.shopName);
  const fullName = asString(input.fullName);
  const email = asString(input.email);
  const mobile = asString(input.mobile).replace(/\s+/g, '');
  if (!shopName || !fullName || !email || !mobile) {
    failCreate('Shop name, full name, email, and mobile are required.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) failCreate('Enter a valid email address.');
  if (!/^\+?\d{8,15}$/.test(mobile)) failCreate('Enter a valid mobile number.');

  let password = asString(input.password) || DEFAULT_SANOFT_SHOP_PASSWORD;
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    failCreate('Password must be at least 8 characters and include letters and numbers.');
  }

  const requestedUsername = asString(input.username);
  const baseUsername = requestedUsername || suggestSanoftUsername(shopName, fullName);
  if (!/^[a-zA-Z0-9._-]+$/.test(baseUsername)) {
    failCreate('User ID can only contain letters, numbers, dots, underscores, or hyphens.');
  }

  let lastMessage = 'Could not create this shop.';
  let created = null;
  let username = baseUsername;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    username = uniqueUsername(baseUsername, attempt);
    if (password.toLowerCase() === username.toLowerCase()) {
      failCreate('Password cannot be the same as the user ID.');
    }
    const { raw } = await registerSanoftShop({
      name: shopName,
      email,
      first_name: fullName,
      last_name: '-',
      username,
      password,
      mobile,
      mac_id: null,
      registration_key: null,
      dealer_id: MEEZAN_SANOFT_DEALER_ID,
      subscription_id: plan.id,
      plan_key: plan.key,
    });
    const message = asString(raw?.message);
    lastMessage = message || lastMessage;
    if (Number(raw?.status) === 200 && raw?.data?.shop) {
      created = raw.data;
      break;
    }
    if (/username already taken/i.test(message) && !requestedUsername) continue;
    if (/username already taken/i.test(message)) failCreate('That user ID is already taken.', 'already-exists');
    failCreate(message || 'Could not create this Sanoft shop.');
  }

  if (!created?.shop) failCreate(lastMessage);

  const createdShop = created.shop;
  const shopId = asNumber(createdShop.id);
  let currencySettings = null;
  try {
    currencySettings = await applyMeezanInrCurrencySymbolWithLogin(shopId, username, password);
  } catch {
    currencySettings = null;
  }
  const refreshed = await refreshMeezanShop(shopId, dealerAuth);
  const shopRow = {
    ...(refreshed || createdShop),
    id: shopId || asNumber((refreshed || createdShop).id),
    shop_name: asString((refreshed || createdShop).shop_name)
      || asString((refreshed || createdShop).name)
      || shopName,
    mobile_no: asString((refreshed || createdShop).mobile_no)
      || asString((refreshed || createdShop).mobile)
      || mobile,
    subscription: (refreshed || createdShop).subscription || {
      id: plan.id,
      name: plan.name,
      key: plan.key,
    },
    dealer: (refreshed || createdShop).dealer || {
      id: MEEZAN_SANOFT_DEALER_ID,
      name: 'Meezan',
    },
    users: Array.isArray((refreshed || createdShop).users) && (refreshed || createdShop).users.length
      ? (refreshed || createdShop).users
      : [{ username, first_name: fullName, email, mobile }],
    subscription_end_date: (refreshed || createdShop).subscription_end_date
      || addDaysYmd(istTodayYmd(), 7),
  };

  const syncedAtIso = new Date().toISOString();
  const mapped = mapSanoftShop(shopRow, syncedAtIso, SOURCE_ACCOUNT_MEEZAN);
  if (!mapped) failCreate('Shop was created but could not be saved to the list.');
  mapped.extras = {
    ...mapped.extras,
    createdByUid: asString(actor.uid),
    createdByName: asString(actor.displayName),
    createdPlanKey: plan.key,
    ...(currencySettings ? {
      currencySymbol: currencySettings.currencySymbol,
      currencyName: currencySettings.currencyName,
      taxRegion: currencySettings.taxRegion,
    } : {}),
  };
  if (currencySettings?.currency) mapped.currency = currencySettings.currency;
  await upsertShops([mapped]);
  const shopDocId = softwareShopDocId(SOURCE_ACCOUNT_MEEZAN, mapped.shopId);
  await getFirestore().collection(SOFTWARE_SHOPS_COLLECTION).doc(shopDocId).set({
    supportUsername: username,
  }, { merge: true });
  await storeShopPosSecret(shopDocId, {
    shopId: mapped.shopId,
    sourceAccount: SOURCE_ACCOUNT_MEEZAN,
    username,
    password,
  });

  return {
    ok: true,
    shopId: mapped.shopId,
    shopDocId,
    name: mapped.name,
    username,
    password,
    plan: plan.name,
    sourceAccount: SOURCE_ACCOUNT_MEEZAN,
    dealerId: MEEZAN_SANOFT_DEALER_ID,
    currency: currencySettings?.currency || mapped.currency || 'INR',
    currencySymbol: currencySettings?.currencySymbol || null,
    currencyApplied: Boolean(currencySettings),
  };
}
