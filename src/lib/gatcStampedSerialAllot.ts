import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import { parseGatcStampingCapacityKg } from './gatcReports';
import { gatcStampingRangeFromDescription, invoiceLineHasGatcTag } from './invoiceGatcTag';
import { serialNumbersFromLineItem } from './invoices';
import {
  isMandatorySerialExemptLine,
  lineIsMandatorySerialCategory,
} from './mandatorySerials';
import {
  YESGATC_OV_MACHINE_HSN,
} from './yesgatcRecords';
import type { DealerInvoiceLineItem } from '../types/invoices';
import type { AllotNonGatcSerialsResult } from './nonGatcSerialAllot';

const MACHINE_HSN = new Set<string>(YESGATC_OV_MACHINE_HSN);

function hsnDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

export type UnlinkedIwpGatcCertificate = {
  id: string;
  certificateNumber: string;
  serialNumber: string;
  productName: string;
  productId?: string | null;
  sku: string | null;
  rcCode: string | null;
  rcName: string | null;
  issuedAt: string | null;
  max: string;
  min: string;
  e: string;
};

export function isGatcStampedSerialEligibleLine(line: Pick<
  DealerInvoiceLineItem,
  'hsn' | 'description' | 'quantity' | 'sku' | 'itemId' | 'categoryName'
> & { isWeighingScale?: boolean | null }): boolean {
  if (isMandatorySerialExemptLine(line)) return false;
  if (!invoiceLineHasGatcTag(line)) return false;
  if (MACHINE_HSN.has(hsnDigits(line.hsn))) return true;
  return lineIsMandatorySerialCategory(line);
}

export function gatcStampedSerialShortage(line: DealerInvoiceLineItem): number {
  if (!isGatcStampedSerialEligibleLine(line)) return 0;
  const qty = Math.max(0, Math.round(Number(line.quantity) || 0));
  return Math.max(0, qty - serialNumbersFromLineItem(line).length);
}

/** Prefer "Stamping: 50Kg 5g", then Max 50Kg on the invoice line. */
export function invoiceLineStampingCapacityKg(line: {
  description?: string | null;
  name?: string | null;
}): number | null {
  return parseGatcStampingCapacityKg(gatcStampingRangeFromDescription(line.description))
    || parseGatcStampingCapacityKg(line.description)
    || parseGatcStampingCapacityKg(line.name);
}

export function certificateCapacityKg(row: { max?: string | null }): number | null {
  return parseGatcStampingCapacityKg(row.max);
}

export function invoiceNeedsGatcStampedSerialAllotment(
  lines: ReadonlyArray<DealerInvoiceLineItem> | undefined,
): boolean {
  return (lines ?? []).some(line => gatcStampedSerialShortage(line) > 0);
}

export async function listUnlinkedIwpGatcCertificates(
  maxOrOpts: number | {
    max?: number;
    productId?: string | null;
    sku?: string | null;
    productName?: string | null;
    capacityKg?: number | null;
    invoiceId?: string | null;
    invoiceNumber?: string | null;
    query?: string | null;
  } = 2000,
): Promise<UnlinkedIwpGatcCertificate[]> {
  const opts = typeof maxOrOpts === 'number' ? { max: maxOrOpts } : maxOrOpts;
  const fn = httpsCallable<
    {
      max?: number;
      productId?: string;
      sku?: string;
      productName?: string;
      capacityKg?: number;
      invoiceId?: string;
      invoiceNumber?: string;
      query?: string;
    },
    { rows?: UnlinkedIwpGatcCertificate[] }
  >(
    getFunctions(app, 'asia-south1'),
    'listUnlinkedIwpGatcCertificatesFn',
    { timeout: 60_000 },
  );
  const productId = String(opts.productId ?? '').trim();
  const sku = String(opts.sku ?? '').trim();
  const productName = String(opts.productName ?? '').trim();
  const capacityKg = Number(opts.capacityKg);
  const invoiceId = String(opts.invoiceId ?? '').trim();
  const invoiceNumber = String(opts.invoiceNumber ?? '').trim();
  const query = String(opts.query ?? '').trim();
  return (await fn({
    max: opts.max,
    ...(productId ? { productId } : {}),
    ...(sku ? { sku } : {}),
    ...(productName ? { productName } : {}),
    ...(Number.isFinite(capacityKg) ? { capacityKg } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(query ? { query } : {}),
  })).data.rows ?? [];
}

export async function allotGatcStampedSerialsToInvoice(input: {
  customerId: string;
  invoiceId: string;
  lineId: string;
  certificateIds: string[];
  actorName: string;
}): Promise<AllotNonGatcSerialsResult> {
  const fn = httpsCallable<typeof input, AllotNonGatcSerialsResult>(
    getFunctions(app, 'asia-south1'),
    'allotGatcStampedSerialsToInvoiceFn',
    { timeout: 90_000 },
  );
  return (await fn(input)).data;
}

export async function unlinkGatcStampedSerialsFromInvoice(input: {
  customerId: string;
  invoiceId: string;
  actorName: string;
  lineId?: string;
  serials?: string[];
}): Promise<AllotNonGatcSerialsResult> {
  const fn = httpsCallable<typeof input & { unlink: true }, AllotNonGatcSerialsResult>(
    getFunctions(app, 'asia-south1'),
    'allotGatcStampedSerialsToInvoiceFn',
    { timeout: 90_000 },
  );
  return (await fn({ ...input, unlink: true })).data;
}
