/**
 * ECS Lite dealer portal client (ecs.benchpc.online).
 * Shop create must use an employee session so ECS queues PIN approval (pending).
 * Dealer sessions activate shops immediately — never call create as dealer.
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export const ECS_DEALER_BASE = 'https://ecs.benchpc.online';
export const ECS_SETTINGS_DOC = 'whatsappSettings/ecsDealer';
/** YesWeigh-only pending create-shop metadata (payment status is not an ECS API field). */
export const ECS_LITE_PENDING_SHOPS_COLLECTION = 'ecsLitePendingShops';

function asString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function phoneDigits(value) {
  return asString(value).replace(/\D/g, '');
}

export function normalizeEcsMac(value) {
  const hex = asString(value).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return '';
  return hex.match(/.{1,2}/g).join(':');
}

export function macCompact(value) {
  return asString(value).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function parseSetCookie(headerValue) {
  if (!headerValue) return [];
  // Node fetch may join multiple Set-Cookie with ", " — split carefully on cookie boundaries.
  const raw = Array.isArray(headerValue) ? headerValue : [headerValue];
  const out = [];
  for (const entry of raw) {
    const parts = String(entry).split(/,(?=\s*[^;]+=)/);
    for (const part of parts) {
      const pair = part.split(';')[0]?.trim();
      if (pair && pair.includes('=')) out.push(pair);
    }
  }
  return out;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function applySetCookie(jar, response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const list = typeof getSetCookie === 'function'
    ? getSetCookie()
    : parseSetCookie(response.headers.get('set-cookie'));
  for (const pair of list) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
}

async function ecsFetch(path, { method = 'GET', body, jar, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : `${ECS_DEALER_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...(jar && Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}),
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (jar) applySetCookie(jar, res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = asString(json?.error || json?.message) || `ECS request failed (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function loadEcsDealerCredentials() {
  const env = {
    dealerUser: asString(process.env.ECS_DEALER_USER),
    dealerPassword: asString(process.env.ECS_DEALER_PASSWORD),
    employeeAadhaar: asString(process.env.ECS_EMPLOYEE_AADHAAR).replace(/\D/g, ''),
    employeePassword: asString(process.env.ECS_EMPLOYEE_PASSWORD),
  };
  let data = {};
  try {
    const snap = await getFirestore().doc(ECS_SETTINGS_DOC).get();
    data = snap.data() || {};
  } catch {
    data = {};
  }
  return {
    dealerUser: env.dealerUser || asString(data.dealerUser || data.email),
    dealerPassword: env.dealerPassword || asString(data.dealerPassword || data.password),
    employeeAadhaar: env.employeeAadhaar
      || asString(data.employeeAadhaar || data.aadhaar).replace(/\D/g, ''),
    employeePassword: env.employeePassword || asString(data.employeePassword),
  };
}

export async function loginEcsEmployee(credentials) {
  const aadhaar = asString(credentials.employeeAadhaar).replace(/\D/g, '');
  const password = asString(credentials.employeePassword);
  if (!aadhaar || !password) {
    throw new Error(
      'ECS employee credentials are not configured (ECS_EMPLOYEE_AADHAAR / ECS_EMPLOYEE_PASSWORD). '
      + 'Employee login is required so Create Shop stays pending for dealer PIN approval.',
    );
  }
  const jar = {};
  const body = await ecsFetch('/api/dealer/employee/login', {
    method: 'POST',
    jar,
    body: { aadhaar, password },
  });
  if (!body?.ok && body?.actor !== 'employee') {
    // Some responses only set cookie + ok
  }
  if (!jar.scale_dealer && !jar.scale_employee) {
    // Cookie name observed for dealer; employee may reuse scale_dealer with actor claim.
    if (!Object.keys(jar).length) {
      throw new Error('ECS employee sign-in did not return a session cookie.');
    }
  }
  return { jar, login: body };
}

export async function loginEcsDealer(credentials) {
  const email = asString(credentials.dealerUser);
  const password = asString(credentials.dealerPassword);
  if (!email || !password) {
    throw new Error(
      'ECS dealer credentials are not configured (ECS_DEALER_USER / ECS_DEALER_PASSWORD).',
    );
  }
  const jar = {};
  const body = await ecsFetch('/api/dealer/login', {
    method: 'POST',
    jar,
    body: { email, password },
  });
  if (!body?.ok) throw new Error(asString(body?.error) || 'ECS dealer sign-in failed.');
  if (!Object.keys(jar).length) {
    throw new Error('ECS dealer sign-in did not return a session cookie.');
  }
  return { jar, login: body };
}

/** Prefer employee session (pending creates). Fall back to dealer only for read helpers. */
export async function withEcsSession({ preferEmployee = true } = {}) {
  const credentials = await loadEcsDealerCredentials();
  if (preferEmployee && credentials.employeeAadhaar && credentials.employeePassword) {
    return { ...(await loginEcsEmployee(credentials)), credentials, actor: 'employee' };
  }
  if (credentials.dealerUser && credentials.dealerPassword) {
    return { ...(await loginEcsDealer(credentials)), credentials, actor: 'dealer' };
  }
  if (preferEmployee) {
    throw new Error(
      'ECS employee credentials are not configured (ECS_EMPLOYEE_AADHAAR / ECS_EMPLOYEE_PASSWORD).',
    );
  }
  throw new Error(
    'ECS dealer credentials are not configured (ECS_DEALER_USER / ECS_DEALER_PASSWORD).',
  );
}

export async function listEcsUnusedKeysAndCountries() {
  const session = await withEcsSession({ preferEmployee: true });
  const [keysPage, overview] = await Promise.all([
    ecsFetch('/api/dealer/keys', { jar: session.jar }),
    ecsFetch('/api/dealer/overview', { jar: session.jar }),
  ]);
  const rows = Array.isArray(keysPage?.rows) ? keysPage.rows : [];
  // Oldest available first — create-shop takes one automatically; do not enumerate inventory to the client.
  const unused = rows
    .filter((row) => asString(row.status) === 'available')
    .slice()
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .map((row) => ({
      id: asString(row.id),
      preview: asString(row.preview),
      poNumber: asString(row.poNumber),
      status: asString(row.status),
      validDays: Number(row.validDays) || 0,
    }))
    .filter((row) => row.id);
  const key = unused[0] || null;
  const countries = (Array.isArray(overview?.countries) ? overview.countries : [])
    .map((c) => ({
      code: asString(c.code).toUpperCase(),
      label: asString(c.label) || asString(c.code),
    }))
    .filter((c) => c.code);
  return {
    key,
    // Keep a one-element array for older clients; never return the full unused list.
    keys: key ? [key] : [],
    countries: countries.length
      ? countries
      : [{ code: 'IN', label: 'India' }],
    unusedCount: Number(keysPage?.unused) || unused.length,
    actor: session.actor,
  };
}

export async function verifyEcsMac(macInput) {
  const mac = normalizeEcsMac(macInput) || asString(macInput);
  if (macCompact(mac).length !== 12) {
    throw new Error('Enter a valid 12-character MAC ID.');
  }
  const session = await withEcsSession({ preferEmployee: true });
  const body = await ecsFetch(
    `/api/dealer/mac/verify?mac=${encodeURIComponent(mac)}`,
    { jar: session.jar },
  );
  return {
    ok: Boolean(body?.ok),
    status: asString(body?.status),
    message: asString(body?.message),
    shopName: asString(body?.shopName),
    mac: normalizeEcsMac(mac),
  };
}

/** Staff payment flag for YesWeigh only — ECS /api/dealer/shops/create has no payment field. */
export function normalizeEcsLitePaymentStatus(value) {
  const raw = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'not_paid' || raw === 'unpaid' || raw === 'notpaid') return 'not_paid';
  return 'paid';
}

export function validateEcsCreateShopInput(input = {}) {
  const keyId = asString(input.keyId);
  const mac = normalizeEcsMac(input.mac) || asString(input.mac);
  const shopName = asString(input.shopName);
  const deviceName = asString(input.deviceName);
  const username = asString(input.username);
  const password = asString(input.password);
  const phone = phoneDigits(input.phone);
  const country = asString(input.country || 'IN').toUpperCase() || 'IN';
  const paymentStatus = normalizeEcsLitePaymentStatus(input.paymentStatus);

  if (!keyId) throw new Error('Select a license key from inventory.');
  if (macCompact(mac).length !== 12) throw new Error('Enter a valid MAC ID.');
  if (!shopName) throw new Error('Shop name is required.');
  if (!deviceName) throw new Error('Device name is required.');
  if (!username) throw new Error('Username is required.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (phone.length < 8 || phone.length > 15) {
    throw new Error('Phone must be digits only — country code + number (8 to 15 digits).');
  }
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Select a country.');

  return {
    keyId,
    mac,
    shopName,
    deviceName,
    username,
    password,
    phone,
    country,
    paymentStatus,
  };
}

/**
 * Submit create-shop as an ECS employee so the portal queues a pending approval.
 * Refuses to proceed if the response would activate the shop immediately.
 * paymentStatus is stored on YesWeigh (ecsLitePendingShops) — not sent to ECS.
 */
export async function submitEcsPendingShop(input = {}, opts = {}) {
  const validated = validateEcsCreateShopInput(input);
  const { paymentStatus, ...ecsPayload } = validated;
  const credentials = await loadEcsDealerCredentials();
  const session = await loginEcsEmployee(credentials);

  const body = await ecsFetch('/api/dealer/shops/create', {
    method: 'POST',
    jar: session.jar,
    body: ecsPayload,
  });

  if (body?.pending) {
    const approval = body.approval || {};
    const approvalId = asString(approval.id);
    const result = {
      ok: true,
      pending: true,
      status: 'pending',
      message: 'Sent to the dealer for PIN approval. It does not apply until then.',
      approvalId,
      keyId: asString(approval.keyId || ecsPayload.keyId),
      keyPreview: asString(approval.keyPreview),
      shopName: asString(approval.shopName || ecsPayload.shopName),
      username: asString(approval.username || ecsPayload.username),
      summary: asString(approval.summary),
      paymentStatus,
    };

    try {
      const db = getFirestore();
      const docId = approvalId || db.collection(ECS_LITE_PENDING_SHOPS_COLLECTION).doc().id;
      await db.collection(ECS_LITE_PENDING_SHOPS_COLLECTION).doc(docId).set({
        approvalId: approvalId || null,
        keyId: result.keyId || null,
        keyPreview: result.keyPreview || null,
        mac: ecsPayload.mac,
        shopName: result.shopName || null,
        deviceName: ecsPayload.deviceName,
        username: result.username || null,
        phone: ecsPayload.phone,
        country: ecsPayload.country,
        paymentStatus,
        summary: result.summary || null,
        createdByUid: asString(opts.createdByUid) || null,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (persistErr) {
      console.warn(
        'ecsLitePendingShops persist failed (ECS pending still queued):',
        persistErr?.message ?? persistErr,
      );
    }

    return result;
  }

  // Safety: dealer-style immediate activation must never be treated as success here.
  const activatedId = asString(body?.shop?.id || body?.profile?.userId);
  const err = new Error(
    activatedId
      ? `ECS activated shop ${activatedId} instead of queuing pending approval. `
        + 'Use ECS_EMPLOYEE_AADHAAR / ECS_EMPLOYEE_PASSWORD (employee session) so creates stay pending.'
      : 'ECS did not return a pending approval. Shop was not queued for dealer PIN approval.',
  );
  err.activated = true;
  err.body = body;
  throw err;
}
