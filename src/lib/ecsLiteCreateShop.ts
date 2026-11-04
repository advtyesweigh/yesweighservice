import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import type { SoftwareShop } from '../types/software-shop';

const functions = getFunctions(app, 'asia-south1');

export type EcsLiteLicenseKey = {
  id: string;
  preview: string;
  poNumber: string;
  status: string;
  validDays: number;
};

export type EcsLiteCountry = {
  code: string;
  label: string;
};

export type EcsLiteCreateShopOptions = {
  /** First unused inventory key (auto-picked). Do not enumerate full inventory. */
  key: EcsLiteLicenseKey | null;
  /** At most one key — same as `key` when present (compat). */
  keys: EcsLiteLicenseKey[];
  countries: EcsLiteCountry[];
  unusedCount: number;
  actor?: string;
};

/** Fixed product defaults for ECS Lite create-shop (staff need not re-enter). */
export const ECS_LITE_DEFAULT_DEVICE_NAME = 'ECS';
export const ECS_LITE_DEFAULT_PASSWORD = 'test12345';

/** Prefill for Create Shop from Software / WhatsApp context. Never invents MAC. */
export type EcsLiteSoftwarePrefill = {
  shopName: string;
  deviceName: string;
  username: string;
  password: string;
  phone: string;
  country: string;
};

function digitsOnlyPhone(value: string): string {
  return String(value || '').replace(/\D/g, '').slice(0, 15);
}

function userDisplayName(shop: SoftwareShop | null | undefined): string {
  const user = shop?.users?.[0];
  if (!user) return '';
  const fromParts = [user.firstName, user.lastName]
    .map((part) => String(part || '').trim())
    .filter((part) => part && part !== '-')
    .join(' ')
    .trim();
  return fromParts;
}

/** Software USERS "User ID" — not the spaced display name. */
function softwareUserId(shop: SoftwareShop | null | undefined): string {
  const user = shop?.users?.[0];
  const fromUsers = String(user?.username || '').trim();
  if (fromUsers) return fromUsers.slice(0, 32);
  const support = String(shop?.supportUsername || '').trim();
  return support.slice(0, 32);
}

function countryFromSoftware(
  shopCountry: string,
  phone: string,
  countries: EcsLiteCountry[],
): string {
  const allowed = new Set(countries.map((c) => c.code));
  const pick = (code: string) => (allowed.size === 0 || allowed.has(code) ? code : '');
  const raw = String(shopCountry || '').trim();
  if (raw) {
    const upper = raw.toUpperCase();
    if (upper.length === 2) {
      const hit = pick(upper);
      if (hit) return hit;
    }
    const labelMatch = countries.find((c) => c.label.toLowerCase() === raw.toLowerCase());
    if (labelMatch) return labelMatch.code;
    if (/india/i.test(raw)) {
      const hit = pick('IN');
      if (hit) return hit;
    }
    if (/uae|united arab|dubai/i.test(raw)) {
      const hit = pick('AE');
      if (hit) return hit;
    }
  }
  const digits = digitsOnlyPhone(phone);
  if (digits.startsWith('91')) {
    const hit = pick('IN');
    if (hit) return hit;
  }
  if (digits.startsWith('971')) {
    const hit = pick('AE');
    if (hit) return hit;
  }
  return pick('IN') || countries[0]?.code || 'IN';
}

/**
 * Map Software shop (+ WhatsApp phone) into ECS Lite create-shop fields.
 * Device name and password use fixed product defaults. MAC is never set.
 */
export function ecsLitePrefillFromSoftwareShop(
  shop: SoftwareShop | null | undefined,
  opts: {
    waPhone?: string;
    fallbackShopName?: string;
    countries?: EcsLiteCountry[];
  } = {},
): EcsLiteSoftwarePrefill {
  const countries = opts.countries?.length ? opts.countries : [{ code: 'IN', label: 'India' }];
  const fallbackName = String(opts.fallbackShopName || '').trim();
  const shopName = String(
    shop?.name || shop?.customerName || userDisplayName(shop) || fallbackName || '',
  ).trim();
  const username = softwareUserId(shop);
  let phone = digitsOnlyPhone(shop?.phone || shop?.ownerPhone || shop?.pocPhone || '');
  if (phone.length === 10 && !phone.startsWith('0')) {
    phone = `91${phone}`;
  }
  if (!phone || phone.length < 8) {
    phone = digitsOnlyPhone(opts.waPhone || '');
  }
  const country = countryFromSoftware(shop?.country || '', phone, countries);
  return {
    shopName,
    deviceName: ECS_LITE_DEFAULT_DEVICE_NAME,
    username,
    password: ECS_LITE_DEFAULT_PASSWORD,
    phone,
    country,
  };
}

export type EcsLiteMacVerifyResult = {
  ok: boolean;
  status: string;
  message: string;
  shopName?: string;
  mac: string;
};

export type EcsLitePaymentStatus = 'paid' | 'not_paid';

export type EcsLitePendingShopInput = {
  keyId: string;
  mac: string;
  shopName: string;
  deviceName: string;
  username: string;
  password: string;
  phone: string;
  country: string;
  /** YesWeigh-only staff flag — not an ECS create-shop API field. */
  paymentStatus?: EcsLitePaymentStatus;
};

export type EcsLitePendingShopResult = {
  ok: boolean;
  pending: boolean;
  status: string;
  message: string;
  approvalId?: string;
  keyId?: string;
  keyPreview?: string;
  shopName?: string;
  username?: string;
  summary?: string;
  paymentStatus?: EcsLitePaymentStatus;
  /** Zoho Books invoice for Retail Cloud service (ECS Lite Key). */
  zohoInvoiceId?: string | null;
  zohoInvoiceNumber?: string | null;
  zohoInvoiceError?: string | null;
  /** Session document send (not template); false when 24h window closed or phone invalid. */
  whatsappInvoiceSent?: boolean;
  whatsappInvoiceError?: string | null;
};

export function normalizeEcsMacInput(value: string): string {
  const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return String(value || '').trim();
  return hex.match(/.{1,2}/g)?.join(':') || hex;
}

export function ecsLiteCallableErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const code = 'code' in err ? String((err as { code?: string }).code || '') : '';
  const message = 'message' in err ? String((err as { message?: string }).message || '') : '';
  const details = 'details' in err ? (err as { details?: unknown }).details : undefined;
  const detailMsg = details && typeof details === 'object' && details !== null && 'message' in details
    ? String((details as { message?: string }).message || '')
    : '';
  const text = detailMsg || message || fallback;
  if (code === 'functions/failed-precondition' || code === 'failed-precondition') return text;
  return text || fallback;
}

export async function listEcsLiteCreateShopOptions(): Promise<EcsLiteCreateShopOptions> {
  const fn = httpsCallable<undefined, EcsLiteCreateShopOptions>(
    functions,
    'listEcsLiteCreateShopOptionsFn',
  );
  const result = await fn();
  return result.data;
}

export async function verifyEcsLiteMac(mac: string): Promise<EcsLiteMacVerifyResult> {
  const fn = httpsCallable<{ mac: string }, EcsLiteMacVerifyResult>(
    functions,
    'verifyEcsLiteMacFn',
  );
  const result = await fn({ mac });
  return result.data;
}

export async function submitEcsLitePendingShop(
  input: EcsLitePendingShopInput,
): Promise<EcsLitePendingShopResult> {
  const fn = httpsCallable<EcsLitePendingShopInput, EcsLitePendingShopResult>(
    functions,
    'submitEcsLitePendingShopFn',
    { timeout: 90_000 },
  );
  const result = await fn(input);
  return result.data;
}
