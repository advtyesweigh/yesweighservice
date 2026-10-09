import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const API_BASE = 'https://api1.sanoft.com/dealer';
const PAGE_SIZE = 200;
const SOURCE_ACCOUNT = 'yesweigh';

type ShopRow = Record<string, unknown>;
type MappedShop = Record<string, unknown>;

function asString(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ymd(value: unknown): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(asString(value));
  return match ? match[1] : asString(value);
}

function named(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return asString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return asString((value as { name?: unknown }).name);
}

function renewalWindow(now = new Date()) {
  const start = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const from = start.toISOString().slice(0, 10);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 14);
  return { from, to: end.toISOString().slice(0, 10) };
}

function shopStatus(subscriptionEnd: string, cancelled: boolean): string {
  if (cancelled) return 'CANCELLED';
  if (!subscriptionEnd) return 'EXPIRED';
  const { from, to } = renewalWindow();
  if (subscriptionEnd < from) return 'EXPIRED';
  if (subscriptionEnd <= to) return 'EXPIRING SOON';
  return 'ACTIVE';
}

async function sanoftRequest(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (opts.token) headers.Authorization = opts.token;
  if ((opts.method || 'GET') === 'POST' && !opts.token) headers['User-Interface'] = 'ios';
  const response = await fetch(`${API_BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || Number(payload.status) !== 200) {
    throw new Error(asString(payload.message) || `Sanoft request failed (${response.status}).`);
  }
  return payload;
}

async function fetchYesweighShops(username: string, password: string): Promise<MappedShop[]> {
  const login = await sanoftRequest('/login/', { method: 'POST', body: { username, password } });
  const data = (login.data && typeof login.data === 'object') ? login.data as Record<string, unknown> : {};
  const token = asString(data.auth_token);
  if (!token) throw new Error('Sanoft login did not return an auth token.');

  const shops: ShopRow[] = [];
  let offset = 0;
  let count = Number.POSITIVE_INFINITY;
  while (offset < count) {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE_SIZE),
      search: '',
    });
    const payload = await sanoftRequest(`/shops/?${params}`, { token });
    const rows = Array.isArray(payload.data) ? payload.data as ShopRow[] : [];
    count = Number(payload.count);
    if (!Number.isFinite(count)) count = offset + rows.length;
    shops.push(...rows);
    if (!rows.length) break;
    offset += rows.length;
  }

  const syncedAt = new Date().toISOString();
  return shops.flatMap((row) => {
    const shopId = asNumber(row.id);
    if (!shopId) return [];
    const subscriptionEnd = ymd(row.subscription_end_date);
    const cancelled = ['cancelled', 'canceled', 'inactive'].some(flag => (
      asString(row.status).toLowerCase().includes(flag)
      || asString(row.plan_status).toLowerCase().includes(flag)
    ));
    return [{
      id: `${SOURCE_ACCOUNT}_${shopId}`,
      shopId,
      sourceAccount: SOURCE_ACCOUNT,
      name: asString(row.shop_name),
      phone: asString(row.mobile_no),
      subscription: named(row.subscription),
      status: shopStatus(subscriptionEnd, cancelled),
      rawStatus: asString(row.status) || asString(row.plan_status),
      cancelled,
      subscriptionEnd,
      dealer: named(row.dealer),
      expenseValidity: ymd(row.expense_validity),
      imageSupport: ymd(row.image_support_validity),
      kotValidity: ymd(row.kot_validity),
      kotLite: ymd(row.kot_lite_validity),
      smartScale: ymd(row.smart_scale_validity),
      currency: asString(row.currency),
      salesBalance: asNumber(row.additional_sales_balance),
      country: asString(row.country),
      users: Array.isArray(row.users)
        ? row.users.map((user) => {
          const rowUser = user && typeof user === 'object' ? user as Record<string, unknown> : {};
          return {
            userId: asNumber(rowUser.id) || asString(rowUser.id),
            username: asString(rowUser.username),
            firstName: asString(rowUser.first_name),
            lastName: asString(rowUser.last_name),
            email: asString(rowUser.email),
            blocked: rowUser.d_is_blocked === true,
          };
        })
        : [],
      extras: {},
      syncedAt,
    }];
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function sanoftShopsDevPlugin(env: Record<string, string>): Plugin {
  let cached: { at: number; shops: MappedShop[] } | null = null;
  let inflight: Promise<MappedShop[]> | null = null;

  const load = async (force = false) => {
    const username = env.SANOFT_YESWEIGH_USERNAME?.trim() || '';
    const password = env.SANOFT_YESWEIGH_PASSWORD?.trim() || '';
    if (!username || !password) {
      throw new Error('YesWeigh Sanoft dealer credentials are not configured in .env.local.');
    }
    if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.shops;
    if (!inflight) {
      inflight = fetchYesweighShops(username, password)
        .then((shops) => {
          cached = { at: Date.now(), shops };
          return shops;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  return {
    name: 'sanoft-shops-dev',
    configureServer(server) {
      server.middlewares.use('/__software/shops', (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          next();
          return;
        }
        void load(req.method === 'POST')
          .then((shops) => sendJson(res, 200, {
            ok: true,
            fetched: shops.length,
            upserted: shops.length,
            shops,
          }))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Could not load Sanoft shops.';
            sendJson(res, 502, { ok: false, error: message });
          });
      });
    },
  };
}
