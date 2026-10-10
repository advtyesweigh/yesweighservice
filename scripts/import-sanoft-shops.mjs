/**
 * Pull every YesWeigh shop from Sanoft and upsert into Firestore `softwareShops`.
 *
 *   node scripts/import-sanoft-shops.mjs
 *
 * Reads SANOFT_YESWEIGH_USERNAME / SANOFT_YESWEIGH_PASSWORD from `.env.local`.
 * Uses a service account when present; otherwise the logged-in Firebase CLI user.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clientId as firebaseCliClientId, clientSecret as firebaseCliClientSecret } from 'firebase-tools/lib/api.js';
import {
  SOURCE_ACCOUNT_YESWEIGH,
  SOFTWARE_SHOP_META_COLLECTION,
  SOFTWARE_SHOP_META_ID,
  SOFTWARE_SHOPS_COLLECTION,
  fetchAllSanoftShops,
  fetchSanoftRenewalShops,
  loginSanoftDealer,
  mapSanoftShop,
  softwareShopDocId,
  syncSanoftShopsHandler,
} from '../functions/lib/sanoft-shops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'yesweigh-service';
const requireFromFunctions = createRequire(path.join(ROOT, 'functions', 'package.json'));
const { initializeApp, applicationDefault, cert } = requireFromFunctions('firebase-admin/app');
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REST_BATCH = 400;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveCredentialsPath() {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const adc = path.join(ROOT, 'functions', '.firebase-adc.json');
  if (fs.existsSync(adc)) return adc;
  const secretsDir = path.join(ROOT, 'secrets');
  if (fs.existsSync(secretsDir)) {
    const sa = fs.readdirSync(secretsDir)
      .filter((name) => name.endsWith('.json') && name.includes('firebase-adminsdk'))
      .sort()[0];
    if (sa) return path.join(secretsDir, sa);
  }
  return null;
}

function tryInitAdmin() {
  const credentialsPath = resolveCredentialsPath();
  if (credentialsPath) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    const sa = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    initializeApp({ credential: cert(sa), projectId: sa.project_id || PROJECT });
    console.log(`Using credentials: ${path.relative(ROOT, credentialsPath)}`);
    return true;
  }
  try {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT });
    return true;
  } catch {
    return false;
  }
}

function sanoftAccounts() {
  const username = String(process.env.SANOFT_YESWEIGH_USERNAME || '').trim();
  const password = String(process.env.SANOFT_YESWEIGH_PASSWORD || '').trim();
  if (!username || !password) {
    throw new Error('Missing SANOFT_YESWEIGH_USERNAME / SANOFT_YESWEIGH_PASSWORD in .env.local.');
  }
  return [{ sourceAccount: SOURCE_ACCOUNT_YESWEIGH, username, password }];
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (value && typeof value === 'object') {
    if (value._serverTimestamp) return { timestampValue: new Date().toISOString() };
    return { mapValue: { fields: encodeFields(value) } };
  }
  return { stringValue: String(value) };
}

function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)]),
  );
}

function readFirebaseCliTokens() {
  const configPath = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8')).tokens || null;
}

async function firebaseCliAccessToken() {
  const tokens = readFirebaseCliTokens();
  if (tokens?.access_token && Number(tokens.expires_at) > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens?.refresh_token) {
    throw new Error('Firebase CLI is not logged in. Run firebase login, then retry.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: firebaseCliClientId(),
      client_secret: firebaseCliClientSecret(),
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await res.json();
  if (!res.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'Could not refresh Firebase CLI access token.');
  }
  return payload.access_token;
}

async function firestoreRest(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error?.message || `${method} ${url} failed (${res.status})`);
  }
  return payload;
}

async function importWithCliRest() {
  const [{ username, password }] = sanoftAccounts();
  console.log('Logging into Sanoft…');
  const token = await loginSanoftDealer(username, password);
  const started = new Date();
  console.log('Fetching YesWeigh shops from Sanoft…');
  const { shops, apiCalls, count } = await fetchAllSanoftShops(token);
  console.log(`Fetched ${shops.length} shops (reported ${count}). Loading renewals…`);
  const renewals = await fetchSanoftRenewalShops(token, started);
  const syncedAtIso = started.toISOString();
  const byId = new Map();
  for (const row of shops) {
    const shopId = Number(row?.id);
    if (shopId) byId.set(shopId, row);
  }
  const renewalIds = new Set();
  for (const row of renewals.shops) {
    const shopId = Number(row?.id);
    if (!shopId) continue;
    renewalIds.add(shopId);
    byId.set(shopId, row);
  }

  const docs = [];
  for (const row of byId.values()) {
    const mapped = mapSanoftShop(row, syncedAtIso, SOURCE_ACCOUNT_YESWEIGH);
    if (!mapped) continue;
    if (renewalIds.has(mapped.shopId) && mapped.status !== 'CANCELLED' && mapped.status !== 'VOIDED') {
      mapped.status = 'EXPIRING SOON';
    }
    docs.push(mapped);
  }

  const access = await firebaseCliAccessToken();
  console.log(`Writing ${docs.length} shops to Firestore…`);
  for (let i = 0; i < docs.length; i += REST_BATCH) {
    const chunk = docs.slice(i, i + REST_BATCH);
    await firestoreRest(access, 'POST', `${FIRESTORE_BASE}:batchWrite`, {
      writes: chunk.map((doc) => {
        const docId = softwareShopDocId(SOURCE_ACCOUNT_YESWEIGH, doc.shopId);
        return {
          update: {
            name: `projects/${PROJECT}/databases/(default)/documents/${SOFTWARE_SHOPS_COLLECTION}/${docId}`,
            fields: encodeFields({
              ...doc,
              sourceAccount: SOURCE_ACCOUNT_YESWEIGH,
              syncedAt: { _serverTimestamp: true },
            }),
          },
        };
      }),
    });
    console.log(`  wrote ${Math.min(i + chunk.length, docs.length)} / ${docs.length}`);
  }

  const result = {
    sourceAccount: SOURCE_ACCOUNT_YESWEIGH,
    ok: true,
    fetched: shops.length,
    reported: count,
    upserted: docs.length,
    renewals: renewalIds.size,
    apiCalls: apiCalls + renewals.apiCalls + 1,
    syncedAt: syncedAtIso,
    error: null,
    lastSyncAt: { _serverTimestamp: true },
  };
  const metaFields = encodeFields(result);
  const mask = Object.keys(result).map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
  await firestoreRest(
    access,
    'PATCH',
    `${FIRESTORE_BASE}/${SOFTWARE_SHOP_META_COLLECTION}/${SOFTWARE_SHOP_META_ID}?${mask}`,
    { fields: metaFields },
  );
  await firestoreRest(
    access,
    'PATCH',
    `${FIRESTORE_BASE}/${SOFTWARE_SHOP_META_COLLECTION}/${SOFTWARE_SHOP_META_ID}-${SOURCE_ACCOUNT_YESWEIGH}?${mask}`,
    { fields: metaFields },
  );
  return result;
}

async function main() {
  loadEnvFile(path.join(ROOT, '.env.local'));
  if (tryInitAdmin()) {
    try {
      const result = await syncSanoftShopsHandler({ accounts: sanoftAccounts() });
      console.log(
        `Imported ${result.upserted} YesWeigh shops into ${SOFTWARE_SHOPS_COLLECTION} (fetched ${result.fetched}, renewals ${result.renewals}).`,
      );
      return;
    } catch (err) {
      const message = String(err?.message || err);
      if (!/Could not load the default credentials|UNAUTHENTICATED|PERMISSION_DENIED|403/i.test(message)) {
        throw err;
      }
      console.log(`Admin write failed (${message}); falling back to Firebase CLI login.`);
    }
  }
  const result = await importWithCliRest();
  console.log(
    `Imported ${result.upserted} YesWeigh shops into ${SOFTWARE_SHOPS_COLLECTION} (fetched ${result.fetched}, renewals ${result.renewals}).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
