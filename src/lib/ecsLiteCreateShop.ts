import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';

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
  keys: EcsLiteLicenseKey[];
  countries: EcsLiteCountry[];
  unusedCount: number;
  actor?: string;
};

export type EcsLiteMacVerifyResult = {
  ok: boolean;
  status: string;
  message: string;
  shopName?: string;
  mac: string;
};

export type EcsLitePendingShopInput = {
  keyId: string;
  mac: string;
  shopName: string;
  deviceName: string;
  username: string;
  password: string;
  phone: string;
  country: string;
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
