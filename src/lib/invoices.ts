import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import {
  INVOICE_CATEGORIES,
  type DealerInvoice,
  type DealerInvoiceDetail,
  type DealerInvoiceLineItem,
  type InvoiceCategory,
  type InvoiceDashboardSummary,
  type InvoiceDocumentDownload,
  type InvoiceDocumentType,
  type InvoiceListParams,
  type InvoiceListResponse,
  type InvoiceSalesEntry,
  type KpiPeriod,
} from '../types/invoices';
import {
  getCachedAllInvoices,
  getCachedInvoiceDashboard,
  getCachedInvoiceDetail,
  getCachedInvoiceList,
  setCachedAllInvoices,
  setCachedInvoiceDashboard,
  setCachedInvoiceDetail,
  setCachedInvoiceList,
} from './invoice-cache';
import { enrichInvoiceDetailImages } from './invoiceLineItemImages';
import { isFreightProductId, isFreightSku, freightOptionFromLine } from '../constants/freightLines';
import { SOFTWARE_KEYS_LEDGER_HSN } from './softwareKeysLedgerStock';
import { isSacHsn } from './sacCatalog';

const functions = getFunctions(app, 'asia-south1');

export function invoiceErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = 'code' in err ? String((err as { code: string }).code) : '';
    const message = 'message' in err ? String((err as { message: string }).message) : '';
    if (code === 'functions/deadline-exceeded' || message.includes('deadline-exceeded')) {
      return 'Invoice sync timed out. Wait a minute and try again.';
    }
    if (code === 'functions/not-found' || message.includes('not-found')) {
      return 'Invoice service is not deployed yet. Push to main or deploy Cloud Functions.';
    }
    if (code === 'functions/permission-denied') {
      return 'You do not have permission to view invoices.';
    }
    if (
      /access denied|not authorized to perform this operation/i.test(message)
      && !/go back to see items/i.test(message)
    ) {
      return 'Zoho refused to print this PDF. Close it and open it again.';
    }
    if (message) return message;
  }
  return 'Could not load invoices.';
}

export async function syncDealerInvoicesFromZoho(): Promise<{
  syncedCount: number;
  failedCount: number;
  totalListed: number;
}> {
  const callable = httpsCallable<
    undefined,
    { syncedCount?: number; failedCount?: number; totalListed?: number }
  >(
    functions,
    'syncDealerInvoicesFromZoho',
    { timeout: 600_000 },
  );
  try {
    const result = await callable();
    return {
      syncedCount: result.data.syncedCount ?? 0,
      failedCount: result.data.failedCount ?? 0,
      totalListed: result.data.totalListed ?? 0,
    };
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export async function fetchDealerInvoices(params: InvoiceListParams = {}): Promise<InvoiceListResponse> {
  const callable = httpsCallable<InvoiceListParams, InvoiceListResponse>(
    functions,
    'getDealerInvoices',
    { timeout: 180_000 },
  );
  try {
    const result = await callable(params);
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export async function fetchDealerInvoicesWithCache(
  cacheKey: string | undefined,
  params: InvoiceListParams = {},
): Promise<InvoiceListResponse> {
  const res = await fetchDealerInvoices(params);
  if (cacheKey) setCachedInvoiceList(cacheKey, params, res);
  return res;
}

export function readCachedDealerInvoices(
  userId: string | undefined,
  params: InvoiceListParams = {},
): InvoiceListResponse | null {
  if (!userId) return null;
  return getCachedInvoiceList(userId, params)?.data ?? null;
}

export async function fetchDealerInvoiceDashboard(): Promise<InvoiceDashboardSummary> {
  const callable = httpsCallable<undefined, InvoiceDashboardSummary>(
    functions,
    'getDealerInvoiceDashboard',
    { timeout: 60_000 },
  );
  try {
    const result = await callable();
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export async function fetchDealerInvoiceDashboardWithCache(
  userId: string | undefined,
): Promise<InvoiceDashboardSummary> {
  const res = await fetchDealerInvoiceDashboard();
  if (userId) setCachedInvoiceDashboard(userId, res);
  return res;
}

export function readCachedDealerInvoiceDashboard(
  userId: string | undefined,
): InvoiceDashboardSummary | null {
  if (!userId) return null;
  return getCachedInvoiceDashboard(userId)?.data ?? null;
}

export async function fetchDealerInvoiceDetail(
  invoiceId: string,
  options?: { customerId?: string },
): Promise<DealerInvoiceDetail> {
  const callable = httpsCallable<{ invoiceId: string; customerId?: string }, DealerInvoiceDetail>(
    functions,
    'getDealerInvoiceDetail',
    { timeout: 60_000 },
  );
  try {
    const result = await callable({
      invoiceId,
      customerId: options?.customerId,
    });
    return enrichInvoiceDetailImages(result.data);
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export async function fetchDealerInvoiceDetailWithCache(
  cacheKey: string | undefined,
  invoiceId: string,
  options?: { customerId?: string },
): Promise<DealerInvoiceDetail> {
  const res = await fetchDealerInvoiceDetail(invoiceId, options);
  if (cacheKey) setCachedInvoiceDetail(cacheKey, invoiceId, res);
  return res;
}

export function readCachedDealerInvoiceDetail(
  userId: string | undefined,
  invoiceId: string,
): DealerInvoiceDetail | null {
  if (!userId) return null;
  return getCachedInvoiceDetail(userId, invoiceId)?.data ?? null;
}

export async function downloadDealerInvoiceDocument(
  invoiceId: string,
  documentType: InvoiceDocumentType,
  options?: { refresh?: boolean },
): Promise<InvoiceDocumentDownload> {
  const callable = httpsCallable<
    { invoiceId: string; documentType: InvoiceDocumentType; refresh?: boolean },
    InvoiceDocumentDownload
  >(
    functions,
    'downloadDealerInvoiceDocument',
    { timeout: 120_000 },
  );
  try {
    const result = await callable({
      invoiceId,
      documentType,
      refresh: options?.refresh !== false,
    });
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export async function downloadAdminInvoiceDocument(
  customerId: string,
  invoiceId: string,
  documentType: InvoiceDocumentType,
  options?: { refresh?: boolean },
): Promise<InvoiceDocumentDownload> {
  const callable = httpsCallable<
    {
      customerId: string;
      invoiceId: string;
      documentType: InvoiceDocumentType;
      refresh?: boolean;
    },
    InvoiceDocumentDownload
  >(
    functions,
    'downloadAdminInvoiceDocument',
    { timeout: 120_000 },
  );
  try {
    const result = await callable({
      customerId,
      invoiceId,
      documentType,
      refresh: options?.refresh !== false,
    });
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export function saveInvoiceDocumentFile(doc: InvoiceDocumentDownload): void {
  const blob = invoiceDocumentToBlob(doc);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = doc.filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openInvoiceDocument(doc: InvoiceDocumentDownload): void {
  const blob = invoiceDocumentToBlob(doc);
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export function invoiceDocumentToBlob(doc: InvoiceDocumentDownload): Blob {
  const binary = atob(doc.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: doc.mimeType });
}

export async function loadInvoiceDocumentObjectUrl(invoiceId: string): Promise<string> {
  const doc = await downloadDealerInvoiceDocument(invoiceId, 'invoice');
  const blob = invoiceDocumentToBlob(doc);
  return URL.createObjectURL(blob);
}

/** Pre-tax invoice amount (excludes GST). Prefers Zoho sub_total when present. */
export function invoiceAmountExclGst(inv: {
  total?: number | null;
  subtotal?: number | null;
  taxTotal?: number | null;
}): number {
  if (inv.subtotal != null) {
    const subtotal = Number(inv.subtotal);
    if (Number.isFinite(subtotal)) return subtotal;
  }
  const total = Number(inv.total ?? 0);
  if (inv.taxTotal != null) {
    const taxTotal = Number(inv.taxTotal);
    if (Number.isFinite(taxTotal)) return Math.max(0, total - taxTotal);
  }
  return total;
}

export function invoiceCategoryAmount(inv: {
  total?: number | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  categoryAmounts?: unknown;
  categories?: unknown;
  invoiceCategory?: unknown;
}, category: InvoiceCategory): number {
  if (inv.categoryAmounts && typeof inv.categoryAmounts === 'object' && !Array.isArray(inv.categoryAmounts)) {
    const raw = Number((inv.categoryAmounts as Record<string, unknown>)[category]);
    if (Number.isFinite(raw)) return raw;
  }
  return invoiceHasCategory(inv, category) ? invoiceAmountExclGst(inv) : 0;
}

export function buildSalesEntriesFromInvoices(invoices: DealerInvoice[]): InvoiceSalesEntry[] {
  return invoices
    .filter(inv => inv.date)
    .map(inv => ({
      date: inv.date!,
      total: invoiceAmountExclGst(inv),
    }));
}

export async function fetchAllDealerInvoices(userId?: string): Promise<DealerInvoice[]> {
  const limit = 100;
  let page = 1;
  let totalPages = 1;
  const all: DealerInvoice[] = [];

  while (page <= totalPages) {
    const res = await fetchDealerInvoicesWithCache(userId, {
      page,
      limit,
      sortField: 'date',
      sortDir: 'desc',
    });
    all.push(...res.data);
    totalPages = res.pagination.totalPages;
    page += 1;
  }

  if (userId) setCachedAllInvoices(userId, all);
  return all;
}

export function readCachedAllDealerInvoices(userId: string | undefined): DealerInvoice[] | null {
  if (!userId) return null;
  return getCachedAllInvoices(userId)?.data ?? null;
}

export function formatInvoiceDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

/** True when the string is a calendar date with no real clock time. */
export function isDateOnlyTimestamp(value: string | null | undefined): boolean {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return true;
  if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed)) return true;
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|[+-]00:00)?$/.test(trimmed);
}

function formatClockAmPm(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date).replace(/\u202f/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

export function firstDateTimeValue(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || isDateOnlyTimestamp(trimmed)) continue;
    if (Number.isNaN(Date.parse(trimmed))) continue;
    return trimmed;
  }
  return null;
}

/** Milliseconds for list sort: real clock time when known, else calendar date. */
export function invoiceDateTimeSortMs(
  date: string | null | undefined,
  timestamp?: string | null,
): number {
  const ts = firstDateTimeValue(timestamp, date);
  if (ts) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const raw = String(date ?? '').trim();
  if (!raw) return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }
  const fallback = Date.parse(raw);
  return Number.isNaN(fallback) ? 0 : fallback;
}

/**
 * List/table stamp: `14 Aug 2026, 10:13 am` when a real time exists.
 * Date-only values stay `14 Aug 2026` (never invent midnight).
 */
export function formatInvoiceDateTime(
  date: string | null | undefined,
  timestamp?: string | null,
): string {
  const dateLabel = formatInvoiceDate(date);
  const ts = firstDateTimeValue(timestamp, date);
  if (!ts) return dateLabel;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return dateLabel;
  const timeLabel = formatClockAmPm(new Date(parsed));
  if (dateLabel === '—') {
    const fromTs = formatInvoiceDate(ts);
    return fromTs === '—' ? timeLabel : `${fromTs}, ${timeLabel}`;
  }
  return `${dateLabel}, ${timeLabel}`;
}

export function normalizeInvoiceStatusKey(status: unknown): string {
  return String(status ?? 'draft').trim().toLowerCase().replace(/\s+/g, '_');
}

export function invoiceStatusLabel(status: string): string {
  return normalizeInvoiceStatusKey(status)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

export type InvoiceDeliveryStage = 'shipped' | 'delivered';

/** Invoices 7+ days old are delivered; newer ones are still shipped. */
export function getInvoiceDeliveryStage(date: string | null | undefined): InvoiceDeliveryStage {
  if (!date) return 'shipped';
  const ts = parseInvoiceDate(date);
  if (Number.isNaN(ts)) return 'shipped';
  const diffDays = Math.floor((startOfDay(new Date()).getTime() - startOfDay(new Date(ts)).getTime()) / DAY_MS);
  return diffDays >= 7 ? 'delivered' : 'shipped';
}

export function invoiceDeliveryLabel(stage: InvoiceDeliveryStage): string {
  return stage === 'delivered' ? 'Delivered' : 'Shipped';
}

export function formatInvoiceRelativeTime(value: string | null | undefined): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return '';
  const diffMs = Date.now() - ts;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatInvoiceDate(value);
}

function parseInvoiceDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    ).getTime();
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? NaN : ts;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function financialYearStart(date: Date): Date {
  const month = date.getMonth();
  const year = date.getFullYear();
  const startYear = month >= 3 ? year : year - 1;
  return startOfDay(new Date(startYear, 3, 1));
}

function resolvePeriodBounds(
  period: KpiPeriod,
  now = new Date(),
): {
  periodStart: Date;
  periodEnd: Date;
  prevPeriodStart: Date;
  prevPeriodEnd: Date;
} | null {
  const periodEnd = endOfDay(now);

  if (typeof period === 'number') {
    const periodStart = startOfDay(now);
    periodStart.setDate(periodStart.getDate() - (period - 1));
    const prevPeriodEnd = endOfDay(addDays(periodStart, -1));
    const prevPeriodStart = startOfDay(addDays(prevPeriodEnd, -(period - 1)));
    return { periodStart, periodEnd, prevPeriodStart, prevPeriodEnd };
  }

  if (period === 'lifetime') {
    return null;
  }

  if (period === 'current_month') {
    const periodStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const prevPeriodStart = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const prevPeriodEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()));
    return { periodStart, periodEnd, prevPeriodStart, prevPeriodEnd };
  }

  if (period === 'previous_month') {
    const periodStart = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const periodEndPrev = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
    const prevPeriodStart = startOfDay(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    const prevPeriodEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 0));
    return {
      periodStart,
      periodEnd: periodEndPrev,
      prevPeriodStart,
      prevPeriodEnd,
    };
  }

  if (period === 'previous_financial_year') {
    const currentFyStart = financialYearStart(now);
    const periodStart = startOfDay(new Date(currentFyStart));
    periodStart.setFullYear(periodStart.getFullYear() - 1);
    const periodEndPrev = endOfDay(addDays(currentFyStart, -1));
    const prevPeriodStart = startOfDay(new Date(periodStart));
    prevPeriodStart.setFullYear(prevPeriodStart.getFullYear() - 1);
    const prevPeriodEnd = endOfDay(addDays(periodStart, -1));
    return {
      periodStart,
      periodEnd: periodEndPrev,
      prevPeriodStart,
      prevPeriodEnd,
    };
  }

  const periodStart = financialYearStart(now);
  const prevPeriodStart = startOfDay(new Date(periodStart));
  prevPeriodStart.setFullYear(prevPeriodStart.getFullYear() - 1);
  const dayCount = Math.floor((periodEnd.getTime() - periodStart.getTime()) / DAY_MS) + 1;
  const prevPeriodEnd = endOfDay(addDays(prevPeriodStart, dayCount - 1));
  return { periodStart, periodEnd, prevPeriodStart, prevPeriodEnd };
}

export function getInvoicePeriodBounds(
  period: KpiPeriod,
  now = new Date(),
): { start: Date; end: Date } | null {
  const bounds = resolvePeriodBounds(period, now);
  if (!bounds) return null;
  return { start: bounds.periodStart, end: bounds.periodEnd };
}

function sumSalesInWindow(
  entries: InvoiceSalesEntry[],
  periodStart: Date,
  periodEnd: Date,
): number {
  let total = 0;
  for (const entry of entries) {
    const ts = parseInvoiceDate(entry.date);
    if (Number.isNaN(ts)) continue;
    if (ts >= periodStart.getTime() && ts <= periodEnd.getTime()) {
      total += entry.total;
    }
  }
  return total;
}

export interface PeriodSalesSummary {
  periodStart: string | null;
  periodEnd: string;
  totalSales: number;
  previousSales: number;
  salesTrendPct: number | null;
}

export function computeSalesForPeriod(entries: InvoiceSalesEntry[], period: KpiPeriod): PeriodSalesSummary {
  const now = new Date();
  const periodEnd = endOfDay(now);
  const bounds = resolvePeriodBounds(period, now);

  if (!bounds) {
    let totalSales = 0;
    for (const entry of entries) {
      totalSales += entry.total;
    }
    return {
      periodStart: null,
      periodEnd: periodEnd.toISOString(),
      totalSales,
      previousSales: 0,
      salesTrendPct: null,
    };
  }

  const totalSales = sumSalesInWindow(entries, bounds.periodStart, bounds.periodEnd);
  const previousSales = sumSalesInWindow(entries, bounds.prevPeriodStart, bounds.prevPeriodEnd);

  let salesTrendPct: number | null = null;
  if (previousSales > 0) {
    salesTrendPct = ((totalSales - previousSales) / previousSales) * 100;
  } else if (totalSales > 0) {
    salesTrendPct = 100;
  }

  return {
    periodStart: bounds.periodStart.toISOString(),
    periodEnd: bounds.periodEnd.toISOString(),
    totalSales,
    previousSales,
    salesTrendPct,
  };
}

export function countInvoiceSalesEntriesInPeriod(
  entries: InvoiceSalesEntry[],
  period: KpiPeriod,
): number {
  const bounds = getInvoicePeriodBounds(period);
  if (!bounds) return entries.length;

  let count = 0;
  for (const entry of entries) {
    const ts = parseInvoiceDate(entry.date);
    if (Number.isNaN(ts)) continue;
    if (ts >= bounds.start.getTime() && ts <= bounds.end.getTime()) {
      count += 1;
    }
  }
  return count;
}

export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function defaultCustomRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 29);
  return { start: toDateInputValue(start), end: toDateInputValue(end) };
}

export function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function computeSalesForDateRange(
  entries: InvoiceSalesEntry[],
  periodStart: Date,
  periodEnd: Date,
): PeriodSalesSummary {
  const start = startOfDay(periodStart);
  const end = endOfDay(periodEnd);
  const dayMs = 24 * 60 * 60 * 1000;
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);

  const prevPeriodEnd = new Date(start);
  prevPeriodEnd.setDate(prevPeriodEnd.getDate() - 1);
  prevPeriodEnd.setHours(23, 59, 59, 999);
  const prevPeriodStart = startOfDay(prevPeriodEnd);
  prevPeriodStart.setDate(prevPeriodStart.getDate() - (dayCount - 1));

  let totalSales = 0;
  let previousSales = 0;

  for (const entry of entries) {
    const ts = parseInvoiceDate(entry.date);
    if (Number.isNaN(ts)) continue;
    if (ts >= start.getTime() && ts <= end.getTime()) {
      totalSales += entry.total;
    } else if (ts >= prevPeriodStart.getTime() && ts <= prevPeriodEnd.getTime()) {
      previousSales += entry.total;
    }
  }

  let salesTrendPct: number | null = null;
  if (previousSales > 0) {
    salesTrendPct = ((totalSales - previousSales) / previousSales) * 100;
  } else if (totalSales > 0) {
    salesTrendPct = 100;
  }

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalSales,
    previousSales,
    salesTrendPct,
  };
}

export function formatKpiPeriodLabel(period: KpiPeriod): string {
  if (period === 'lifetime') return 'Lifetime';
  if (period === 'current_month') return 'Current month';
  if (period === 'previous_month') return 'Previous month';
  if (period === 'financial_year') return 'Current year (FY)';
  if (period === 'previous_financial_year') return 'Previous year (FY)';
  if (period === 365) return '365 days';
  return `${period} days`;
}

export function formatKpiTrendLabel(period: KpiPeriod): string {
  if (period === 'lifetime') return '';
  if (period === 'current_month') return 'vs previous month';
  if (period === 'previous_month') return 'vs month before';
  if (period === 'financial_year') return 'vs previous FY';
  if (period === 'previous_financial_year') return 'vs prior FY';
  return `vs previous ${formatKpiPeriodLabel(period).toLowerCase()}`;
}

export function formatKpiPeriodRange(periodStart: string | null, periodEnd: string): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (!periodStart) return 'All time';
  return `${fmt(new Date(periodStart))} – ${fmt(new Date(periodEnd))}`;
}

/**
 * HSN / SAC codes used to classify docs (same as Zoho sync).
 * Multiple codes per category are OR-matched (existing + newly added).
 */
export const INVOICE_CATEGORY_HSN = {
  service: ['998717', '998719'],
  software_key: ['85238020', '85238010'],
  gatc: ['998346', '79061190'],
  freight: ['996812'],
} as const;

function normalizeCategoryHsn(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function hsnMatchesCategory(
  hsn: string,
  codes: readonly string[],
): boolean {
  return Boolean(hsn) && codes.includes(hsn);
}

/**
 * GATC stamping-fee lines: SAC/HSN 998346 / 79061190, or fee SKU/name
 * (e.g. GRV20 “GATC Fees upto 20kg”).
 */
export function isGatcFeeInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'> & { hsn?: string | null },
): boolean {
  if (hsnMatchesCategory(normalizeCategoryHsn(item.hsn), INVOICE_CATEGORY_HSN.gatc)) return true;
  const name = String(item.name ?? '').trim().toLowerCase();
  if (name.includes('gatc fee')) return true;
  const sku = item.sku?.trim().toLowerCase() ?? '';
  return /^grv\d/.test(sku);
}

export function isFreightInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'> & {
    hsn?: string | null;
    itemId?: string | null;
    id?: string | null;
  },
): boolean {
  if (isFreightProductId(item.itemId) || isFreightProductId(item.id)) return true;
  if (isFreightSku(item.sku)) return true;
  if (hsnMatchesCategory(normalizeCategoryHsn(item.hsn), INVOICE_CATEGORY_HSN.freight)) return true;
  const name = item.name.trim().toLowerCase();
  if (name === 'freight' || name.includes('freight')) return true;
  const sku = item.sku?.trim().toLowerCase() ?? '';
  return sku === 'freight' || sku.includes('freight');
}

type InvoiceFreightLinesSource = {
  lineItems?: Array<Parameters<typeof isFreightInvoiceLineItem>[0]> | null;
} | null | undefined;

export function invoiceHasCourierFreightLine(invoice: InvoiceFreightLinesSource): boolean {
  return (invoice?.lineItems ?? []).some(line => isFreightInvoiceLineItem(line));
}

/**
 * Line items are loaded and none are courier freight (customer pickup / omitted freight).
 * False when line items are missing so list rows are not treated as pickup.
 */
export function invoiceHasNoCourierFreightLine(invoice: InvoiceFreightLinesSource): boolean {
  const lines = invoice?.lineItems;
  if (!Array.isArray(lines) || lines.length === 0) return false;
  return !lines.some(line => isFreightInvoiceLineItem(line));
}

/** First recognized courier freight SKU on the invoice (STFRC, DELFRC, …). */
export function freightSkuFromInvoiceLines(
  lines: Array<{
    sku?: string | null;
    itemId?: string | null;
    id?: string | null;
    productId?: string | null;
    item_id?: string | null;
    name?: string | null;
    hsn?: string | null;
  }> | null | undefined,
): string | null {
  if (!Array.isArray(lines)) return null;
  let generic: string | null = null;
  for (const line of lines) {
    const option = freightOptionFromLine(line);
    if (option) return option.sku;
    if (!generic && isFreightInvoiceLineItem({
      name: String(line?.name ?? ''),
      sku: line?.sku ?? null,
      hsn: line?.hsn,
      itemId: line?.itemId ?? line?.productId ?? line?.item_id,
      id: line?.id,
    })) {
      generic = 'FRC';
    }
  }
  return generic;
}

/** Keep product/spare lines first; freight charge lines always last. */
export function moveFreightLinesToEnd<T extends Parameters<typeof isFreightInvoiceLineItem>[0]>(
  lines: readonly T[],
): T[] {
  const goods: T[] = [];
  const freight: T[] = [];
  for (const line of lines) {
    if (isFreightInvoiceLineItem(line)) freight.push(line);
    else goods.push(line);
  }
  if (freight.length === 0) return lines.slice() as T[];
  return [...goods, ...freight];
}

/** Lines omitted from qty totals: freight and GATC lines. */
export function isQuantityExcludedInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'> & { hsn?: string | null },
): boolean {
  if (isGatcFeeInvoiceLineItem(item)) return true;
  return isFreightInvoiceLineItem(item);
}

export function isGenericSpareCategoryName(name: string | null | undefined): boolean {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'generic spare parts'
    || normalized === 'generic spares'
    || normalized.includes('generic spare')
  );
}

/** Portal order segments: software keys + sanoft → software_key. */
export function isSoftwareSegmentCategoryName(name: string | null | undefined): boolean {
  const normalized = String(name ?? '').trim().toLowerCase();
  return normalized === 'software keys' || normalized === 'sanoft';
}

/** Uncategorized, missing catalog, or Generic spare parts → spare. */
export function isSpareCatalogItem(catalog: {
  categoryId?: string | null;
  categoryName?: string | null;
} | null | undefined): boolean {
  if (!catalog) return true;
  const categoryId = String(catalog.categoryId ?? '').trim();
  if (!categoryId || categoryId === '-1') return true;
  if (isGenericSpareCategoryName(catalog.categoryName)) return true;
  return false;
}

export type InvoiceCategoryLineInput = {
  total?: number;
  name?: string;
  sku?: string | null;
  itemId?: string | null;
  hsn?: string | null;
  categoryName?: string | null;
};

export type InvoiceCategoryCatalogMeta = {
  hsn?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
};

export type InvoiceCategoryBreakdown = {
  categories: InvoiceCategory[];
  categoryAmounts: Partial<Record<InvoiceCategory, number>>;
  categoryLineCounts: Partial<Record<InvoiceCategory, number>>;
};

function emptyInvoiceCategoryTotals(): Record<InvoiceCategory, number> {
  return {
    product: 0,
    spare: 0,
    service: 0,
    software_key: 0,
    gatc: 0,
  };
}

export function normalizeInvoiceCategories(value: unknown): InvoiceCategory[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<InvoiceCategory>();
  for (const raw of value) {
    const parsed = parseInvoiceCategory(raw);
    if (parsed) seen.add(parsed);
  }
  return INVOICE_CATEGORIES.filter(category => seen.has(category));
}

export function normalizeInvoiceCategoryAmounts(
  value: unknown,
): Partial<Record<InvoiceCategory, number>> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const next: Partial<Record<InvoiceCategory, number>> = {};
  for (const category of INVOICE_CATEGORIES) {
    const amount = Number(raw[category] ?? 0);
    if (Number.isFinite(amount) && amount !== 0) next[category] = amount;
  }
  return next;
}

export function invoiceHasCategory(
  value: { categories?: unknown; invoiceCategory?: unknown } | null | undefined,
  category: InvoiceCategory,
): boolean {
  const categories = normalizeInvoiceCategories(value?.categories);
  if (categories.length) return categories.includes(category);
  return parseInvoiceCategory(value?.invoiceCategory) === category;
}

export function invoiceCategoriesForDisplay(
  value: { categories?: unknown; invoiceCategory?: unknown } | null | undefined,
): InvoiceCategory[] {
  const categories = normalizeInvoiceCategories(value?.categories);
  if (categories.length) return categories;
  const legacy = parseInvoiceCategory(value?.invoiceCategory);
  return legacy ? [legacy] : [];
}

/**
 * Standalone GATC fee invoices (SAC/HSN above) with no product/spare/service/software lines.
 * These are not counted in All / To dispatch — Stamping tab still lists portal Billwise rows.
 */
export function isGatcFeeOnlyInvoice(
  invoice: { categories?: unknown; invoiceCategory?: unknown } | null | undefined,
): boolean {
  const categories = invoiceCategoriesForDisplay(invoice);
  if (!categories.length) return false;
  return categories.every(category => category === 'gatc');
}

export function classifyInvoiceLineItem(
  item: InvoiceCategoryLineInput,
  catalogByItemId: Map<string, InvoiceCategoryCatalogMeta> = new Map(),
): InvoiceCategory | null {
  const name = String(item?.name ?? '');
  const sku = item?.sku ?? null;
  const hsnFromItem = item?.hsn ?? null;
  if (isFreightInvoiceLineItem({ name, sku, hsn: hsnFromItem })) return null;

  const itemId = item.itemId ? String(item.itemId) : '';
  const catalog = itemId ? catalogByItemId.get(itemId) : null;
  const hsn = normalizeCategoryHsn(hsnFromItem || catalog?.hsn);

  if (isGatcFeeInvoiceLineItem({ name, sku, hsn: hsnFromItem || catalog?.hsn })) return 'gatc';
  if (hsnMatchesCategory(hsn, INVOICE_CATEGORY_HSN.service)) return 'service';
  if (hsnMatchesCategory(hsn, INVOICE_CATEGORY_HSN.software_key)) return 'software_key';
  if (
    isSoftwareSegmentCategoryName(catalog?.categoryName)
    || isSoftwareSegmentCategoryName(item?.categoryName)
  ) {
    return 'software_key';
  }
  if (isSpareCatalogItem(catalog)) return 'spare';
  return 'product';
}

export function classifyInvoiceCategoryBreakdown(
  lineItems: InvoiceCategoryLineInput[],
  catalogByItemId: Map<string, InvoiceCategoryCatalogMeta> = new Map(),
): InvoiceCategoryBreakdown {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const totals = emptyInvoiceCategoryTotals();
  const counts = emptyInvoiceCategoryTotals();

  for (const item of items) {
    const category = classifyInvoiceLineItem(item, catalogByItemId);
    if (!category) continue;
    totals[category] += Number(item?.total ?? 0);
    counts[category] += 1;
  }

  const categories = INVOICE_CATEGORIES.filter(category => totals[category] > 0 || counts[category] > 0);
  if (!categories.length) {
    return {
      categories: ['spare'],
      categoryAmounts: { spare: 0 },
      categoryLineCounts: { spare: 0 },
    };
  }

  const categoryAmounts: Partial<Record<InvoiceCategory, number>> = {};
  const categoryLineCounts: Partial<Record<InvoiceCategory, number>> = {};
  for (const category of categories) {
    categoryAmounts[category] = totals[category];
    categoryLineCounts[category] = counts[category];
  }

  return { categories, categoryAmounts, categoryLineCounts };
}

/**
 * Legacy single-category accessor kept during migration.
 * Returns the first normalized category from the multi-category breakdown.
 */
export function classifyInvoiceFromLineItems(
  lineItems: InvoiceCategoryLineInput[],
  catalogByItemId: Map<string, InvoiceCategoryCatalogMeta> = new Map(),
): InvoiceCategory {
  return classifyInvoiceCategoryBreakdown(lineItems, catalogByItemId).categories[0] ?? 'spare';
}

/** Classify a portal dealer order from its lines (mirrors Zoho SO categorisation). */
export function classifyDealerOrderCategory(
  order: {
    lines?: Array<{
      productId: string;
      itemId: string | null;
      name: string;
      sku: string | null;
      lineTotal: number;
      categoryName: string | null;
      hsn?: string | null;
    }>;
  },
): InvoiceCategory {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const catalogByItemId = new Map<string, InvoiceCategoryCatalogMeta>();
  const lineItems: InvoiceCategoryLineInput[] = lines.map(line => {
    const itemId = String(line.itemId || line.productId || '');
    if (itemId) {
      const named = Boolean(line.categoryName?.trim())
        && !isGenericSpareCategoryName(line.categoryName);
      catalogByItemId.set(itemId, {
        hsn: line.hsn ?? null,
        // Portal lines often omit categoryId; a real category name means shop product.
        categoryId: named ? 'portal' : null,
        categoryName: line.categoryName,
      });
    }
    return {
      total: line.lineTotal,
      name: line.name,
      sku: line.sku,
      itemId,
      hsn: line.hsn ?? null,
    };
  });
  return classifyInvoiceFromLineItems(lineItems, catalogByItemId);
}

export function isStampingInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'> & { hsn?: string | null },
): boolean {
  if (isGatcFeeInvoiceLineItem(item)) return true;
  const name = item.name.trim().toLowerCase();
  const sku = item.sku?.trim().toLowerCase() ?? '';
  return name.includes('stamping') || sku.includes('stamping');
}

export function isServiceExcludedLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'>,
): boolean {
  return isFreightInvoiceLineItem(item) || isStampingInvoiceLineItem(item);
}

export function isSoftwareInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name' | 'sku'> & {
    hsn?: string | null;
    categoryName?: string | null;
  },
): boolean {
  const hsn = normalizeCategoryHsn(item.hsn);
  if (hsnMatchesCategory(hsn, INVOICE_CATEGORY_HSN.software_key)) return true;
  if (hsn === SOFTWARE_KEYS_LEDGER_HSN) return true;
  if (isSoftwareSegmentCategoryName(item.categoryName)) return true;
  const name = String(item.name ?? '').trim().toLowerCase();
  const sku = item.sku?.trim().toLowerCase() ?? '';
  if (name.includes('subscription') || name.includes('software key')) return true;
  if (/\bsoftware\b/.test(name) || name.includes('additional sales')) return true;
  if (sku.includes('sposelt') || sku.includes('sanoft')) return true;
  return false;
}

export function isSpareInvoiceLineItem(
  item: Pick<DealerInvoiceLineItem, 'name'> & {
    categoryId?: string | null;
    categoryName?: string | null;
  },
): boolean {
  const catalogKnown = item.categoryId !== undefined || item.categoryName !== undefined;
  if (catalogKnown && isSpareCatalogItem({
    categoryId: item.categoryId,
    categoryName: item.categoryName,
  })) {
    return true;
  }
  const categoryName = String(item.categoryName ?? '').trim().toLowerCase();
  if (categoryName.includes('spare')) return true;

  const name = String(item.name ?? '').trim().toLowerCase();
  if (name.includes('generic spare') || name.includes('spare part') || name.includes('spares')) {
    return true;
  }
  if (name.includes('motherboard') || name.includes('mother board')) return true;
  if (/\bpcb\b/.test(name)) return true;
  return false;
}

/**
 * Support picker spare check.
 * Catalog-resolved uncategorized / Generic spare parts items are spares.
 * Do not treat a missing categoryId as a spare unless catalog was looked up
 * (`isCatalogSpare`): compact invoice rows often omit category.
 */
export function isSupportSpareLineItem(
  item: Pick<DealerInvoiceLineItem, 'name'> & {
    categoryName?: string | null;
    isCatalogSpare?: boolean;
  },
): boolean {
  if (item.isCatalogSpare) return true;
  if (isGenericSpareCategoryName(item.categoryName)) return true;
  const categoryName = String(item.categoryName ?? '').trim().toLowerCase();
  if (categoryName.includes('spare')) return true;
  const name = String(item.name ?? '').trim().toLowerCase();
  if (name.includes('generic spare') || name.includes('spare part') || name.includes('spares')) {
    return true;
  }
  if (name.includes('motherboard') || name.includes('mother board')) return true;
  if (/\bpcb\b/.test(name)) return true;
  return false;
}

/** Complaint / service picker: finished shop products only (no software, spares, freight, fees). */
export function isSupportMainProductLineItem(
  item: DealerInvoiceLineItem,
): boolean {
  if (isFreightInvoiceLineItem(item)) return false;
  if (isStampingInvoiceLineItem(item)) return false;
  if (isGatcFeeInvoiceLineItem(item)) return false;
  if (isSoftwareInvoiceLineItem(item)) return false;
  if (isSupportSpareLineItem(item)) return false;
  if (isSacHsn(item.hsn)) return false;
  return true;
}

export function sumInvoiceProductQuantity(lineItems: DealerInvoiceLineItem[]): number {
  return lineItems.reduce((sum, item) => {
    if (isQuantityExcludedInvoiceLineItem(item)) return sum;
    return sum + item.quantity;
  }, 0);
}

/** Distinct product/spare lines on an invoice, excluding freight and GATC fee lines. */
export function countInvoiceItemVariants(
  lineItems: Array<{
    name?: string | null;
    sku?: string | null;
    hsn?: string | null;
    itemId?: string | null;
    id?: string | null;
    productId?: string | null;
  }> | null | undefined,
): number | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const keys = new Set<string>();
  let unnamed = 0;
  for (const item of lineItems) {
    const name = String(item?.name ?? '');
    if (isQuantityExcludedInvoiceLineItem({
      name,
      sku: item?.sku ?? null,
      hsn: item?.hsn,
    })) continue;
    const key = String(item?.sku ?? '').trim().toLowerCase()
      || String(item?.itemId ?? item?.productId ?? item?.id ?? '').trim()
      || name.trim().toLowerCase();
    if (key) keys.add(key);
    else unnamed += 1;
  }
  return keys.size + unnamed;
}

export function formatInvoiceItemQuantity(quantity: number | null): string {
  if (quantity === null) return '—';
  return quantity.toLocaleString('en-IN');
}

export function formatInvoiceQtyVariants(
  quantity: number | null,
  variantCount: number | null,
): string {
  return `${formatInvoiceItemQuantity(quantity)} / ${formatInvoiceItemQuantity(variantCount)}`;
}

export function parseInvoiceCategory(value: unknown): InvoiceCategory | null {
  const key = String(value ?? '').trim();
  return (INVOICE_CATEGORIES as readonly string[]).includes(key)
    ? (key as InvoiceCategory)
    : null;
}

/**
 * Software-only docs (HSN 85238020/85238010, Software keys / Sanoft category).
 * Mixed product/spare + software bills are kept.
 */
export function isSoftwareOnlyInvoiceCategories(
  categories?: InvoiceCategory[] | null,
  primaryCategory?: InvoiceCategory | string | null,
): boolean {
  const parsed = normalizeInvoiceCategories(categories);
  const one = parseInvoiceCategory(primaryCategory);
  const cats = parsed.length ? parsed : (one ? [one] : []);
  if (!cats.length) return false;
  if (cats.some(category => category === 'product' || category === 'spare')) return false;
  return cats.includes('software_key');
}

export function invoiceCategoryLabel(category: InvoiceCategory | null | undefined): string {
  switch (category) {
    case 'product':
      return 'Product';
    case 'spare':
      return 'Spares';
    case 'service':
      return 'Service charges';
    case 'software_key':
      return 'Software';
    case 'gatc':
      return 'Stamping';
    default:
      return '';
  }
}

export function invoiceCategoryClassName(category: InvoiceCategory | null | undefined): string {
  if (!category) return 'invoices-category';
  return `invoices-category invoices-category--${category}`;
}

export function normalizeInvoiceSearchNeedle(text: string): string {
  return text.trim().toLowerCase();
}

const JUNK_SERIAL_KEYS = new Set(['NUMBERS', 'NUMBER', 'SERIAL', 'SERIALS', 'MAC', 'SN', 'S']);

function isPlausibleInvoiceSerial(value: string | null | undefined): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const key = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return Boolean(key && key.length >= 3 && !JUNK_SERIAL_KEYS.has(key));
}

function serialsFromLineDescription(description: string | null | undefined): string[] {
  const text = String(description ?? '');
  if (!text.trim()) return [];
  const serials: string[] = [];
  const block = /\bserial\s*numbers?\s*:\s*([^\n]+)/i.exec(text);
  if (block?.[1]) {
    for (const part of block[1].split(/[,;]+/)) {
      const token = part.trim();
      if (isPlausibleInvoiceSerial(token)) serials.push(token);
    }
  }
  const pattern = /\b(?:s\/n|sn|mac(?:\s*id)?)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,})/gi;
  let match = pattern.exec(text);
  while (match) {
    if (isPlausibleInvoiceSerial(match[1])) serials.push(match[1].trim());
    match = pattern.exec(text);
  }
  return [...new Set(serials)];
}

/** Serial / MAC values from stored line serials or description text. */
export function serialNumbersFromLineItem(
  item: Pick<DealerInvoiceLineItem, 'description' | 'serialNumbers'>,
): string[] {
  const listed = (item.serialNumbers ?? [])
    .map(value => value.trim())
    .filter(isPlausibleInvoiceSerial);
  return [...new Set([...listed, ...serialsFromLineDescription(item.description)])];
}

export function lineItemMatchesSerialQuery(
  item: Pick<DealerInvoiceLineItem, 'description' | 'serialNumbers'>,
  query: string,
): boolean {
  const needle = normalizeInvoiceSearchNeedle(query);
  if (!needle) return false;

  return serialNumbersFromLineItem(item).some(serial => {
    const normalized = normalizeInvoiceSearchNeedle(serial);
    return normalized === needle || normalized.includes(needle) || needle.includes(normalized);
  });
}

export function findLineItemBySerialQuery(
  lineItems: DealerInvoiceLineItem[],
  query: string,
  excludeItem?: (item: DealerInvoiceLineItem) => boolean,
): { item: DealerInvoiceLineItem; serial: string } | null {
  const needle = normalizeInvoiceSearchNeedle(query);
  if (!needle) return null;

  const candidates = lineItems.filter(item => !excludeItem?.(item));

  for (const item of candidates) {
    for (const serial of serialNumbersFromLineItem(item)) {
      const normalized = normalizeInvoiceSearchNeedle(serial);
      if (normalized === needle) {
        return { item, serial };
      }
    }
  }

  for (const item of candidates) {
    for (const serial of serialNumbersFromLineItem(item)) {
      const normalized = normalizeInvoiceSearchNeedle(serial);
      if (normalized.includes(needle) || needle.includes(normalized)) {
        return { item, serial };
      }
    }
  }

  const descriptionMatch = candidates.find(item => item.description?.toLowerCase().includes(needle));
  if (descriptionMatch) {
    const serial = serialNumbersFromLineItem(descriptionMatch).find(value =>
      normalizeInvoiceSearchNeedle(value).includes(needle),
    );
    return { item: descriptionMatch, serial: serial ?? query.trim() };
  }

  return null;
}
