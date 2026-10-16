import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import { invoiceLineHasGatcTag } from './invoiceGatcTag';
import { serialNumbersFromLineItem } from './invoices';
import {
  isMandatorySerialExemptLine,
  lineIsMandatorySerialCategory,
} from './mandatorySerials';
import { YESGATC_OV_MACHINE_HSN } from './yesgatcRecords';
import type { DealerInvoiceLineItem } from '../types/invoices';

const MACHINE_HSN = new Set<string>(YESGATC_OV_MACHINE_HSN);

function hsnDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

export function isVoidOrCancelledInvoiceStatus(status: unknown): boolean {
  const key = String(status ?? '').trim().toLowerCase();
  return key === 'void' || key === 'cancelled' || key === 'canceled';
}

export function isNonGatcSerialEligibleLine(line: Pick<
  DealerInvoiceLineItem,
  'hsn' | 'description' | 'quantity' | 'sku' | 'itemId' | 'categoryName'
> & { isWeighingScale?: boolean | null }): boolean {
  if (isMandatorySerialExemptLine(line)) return false;
  if (invoiceLineHasGatcTag(line)) return false;
  if (MACHINE_HSN.has(hsnDigits(line.hsn))) return true;
  return lineIsMandatorySerialCategory(line);
}

export function nonGatcSerialShortage(line: DealerInvoiceLineItem): number {
  if (!isNonGatcSerialEligibleLine(line)) return 0;
  const qty = Math.max(0, Math.round(Number(line.quantity) || 0));
  return Math.max(0, qty - serialNumbersFromLineItem(line).length);
}

export function invoiceNeedsNonGatcSerialAllotment(
  lines: ReadonlyArray<DealerInvoiceLineItem> | undefined,
): boolean {
  return (lines ?? []).some(line => nonGatcSerialShortage(line) > 0);
}

export type AllotNonGatcSerialsResult = {
  allotted: number;
  released: number;
  shortage: number;
  voided: boolean;
  zohoPushed?: boolean;
  zohoError?: string;
  yesgatcPushed?: boolean;
  yesgatcSkipped?: string | null;
  yesgatcError?: string | null;
  lineItems?: DealerInvoiceLineItem[];
};

export type AvailableNonGatcSerial = {
  id: string;
  serialNumber: string;
};

type NonGatcSerialCallableInput = {
  customerId: string;
  invoiceId: string;
  actorName: string;
  unlink?: boolean;
  lineId?: string;
  serials?: string[];
};

function nonGatcSerialCallable() {
  return httpsCallable<NonGatcSerialCallableInput, AllotNonGatcSerialsResult>(
    getFunctions(app, 'asia-south1'),
    'allotNonGatcSerialsToInvoiceFn',
    { timeout: 60_000 },
  );
}

export async function listAvailableNonGatcSerials(input: {
  max?: number;
  productId?: string | null;
  sku?: string | null;
  productName?: string | null;
  query?: string | null;
} | number = 2000): Promise<AvailableNonGatcSerial[]> {
  const opts = typeof input === 'number' ? { max: input } : input;
  const fn = httpsCallable<
    { max?: number; productId?: string; sku?: string; productName?: string; query?: string },
    { rows?: AvailableNonGatcSerial[] }
  >(
    getFunctions(app, 'asia-south1'),
    'listAvailableNonGatcSerialsFn',
    { timeout: 60_000 },
  );
  const productId = String(opts.productId ?? '').trim();
  const sku = String(opts.sku ?? '').trim();
  const productName = String(opts.productName ?? '').trim();
  const query = String(opts.query ?? '').trim();
  return (await fn({
    max: opts.max,
    ...(productId ? { productId } : {}),
    ...(sku ? { sku } : {}),
    ...(productName ? { productName } : {}),
    ...(query ? { query } : {}),
  })).data.rows ?? [];
}

export async function allotNonGatcSerialsToInvoice(input: {
  customerId: string;
  invoiceId: string;
  actorName: string;
  lineId?: string;
  serials: string[];
}): Promise<AllotNonGatcSerialsResult> {
  return (await nonGatcSerialCallable()(input)).data;
}

export async function unlinkNonGatcSerialsFromInvoice(input: {
  customerId: string;
  invoiceId: string;
  actorName: string;
  lineId?: string;
  serials?: string[];
}): Promise<AllotNonGatcSerialsResult> {
  return (await nonGatcSerialCallable()({ ...input, unlink: true })).data;
}

export type PushRcInvoiceToYesGatcResult = {
  pushed: boolean;
  skipped: string | null;
  qty?: number;
  serials?: number;
  pushedAt?: string | null;
  rc?: { rcId?: string; rcCode?: string; rcName?: string } | null;
  error?: string;
};

export async function pushRcInvoiceToYesGatc(input: {
  customerId: string;
  invoiceId: string;
  actorName: string;
  force?: boolean;
}): Promise<PushRcInvoiceToYesGatcResult> {
  const fn = httpsCallable<typeof input, PushRcInvoiceToYesGatcResult>(
    getFunctions(app, 'asia-south1'),
    'pushRcInvoiceToYesGatcFn',
    { timeout: 30_000 },
  );
  return (await fn(input)).data;
}
