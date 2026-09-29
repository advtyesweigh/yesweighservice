import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app, db } from '../firebase';
import { serialNumbersFromLineItem } from './invoices';

export const GATC_REPORTS_COLLECTION = 'gatcReports';

const functions = getFunctions(app, 'asia-south1');

export type GatcReportLineItem = {
  productId: string | null;
  itemId: string | null;
  sku: string | null;
  name: string;
  qty: number;
  baseRate: number;
  gatcFeePerUnit: number;
  gatcStampingPriceId: string | null;
  gatcStampingRange: string | null;
  unitRate: number;
  lineBaseTotal: number;
  lineGatcTotal: number;
  lineTotal: number;
  hasStamping: boolean;
  isWeighingScale: boolean;
};

export type GatcInvoiceLineSerials = {
  productId: string | null;
  itemId: string | null;
  sku: string | null;
  name: string;
  serialNumbers: string[];
};

export type GatcReportTotals = {
  lineCount: number;
  stampedLineCount: number;
  stampedQty: number;
  baseTotal: number;
  gatcFeeTotal: number;
  lineTotal: number;
};

export type GatcReportDoc = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  soId: string;
  salesOrderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  salespersonId: string | null;
  salespersonName: string | null;
  invoiceDate: string | null;
  soDate: string | null;
  referenceNumber: string | null;
  createdAt: string;
  source: string;
  hasStamping: boolean;
  hasWeighingScale: boolean;
  searchBlob: string;
  lineItems: GatcReportLineItem[];
  totals: GatcReportTotals;
};

function mapLine(raw: Record<string, unknown>): GatcReportLineItem {
  const gatcFeePerUnit = Number(raw.gatcFeePerUnit) || 0;
  const gatcStampingPriceId = String(raw.gatcStampingPriceId ?? '').trim() || null;
  const qty = Math.max(0, Math.floor(Number(raw.qty ?? raw.quantity) || 0));
  const baseRate = Number(raw.baseRate) || 0;
  const unitRate = Number(raw.unitRate) || 0;
  return {
    productId: raw.productId != null ? String(raw.productId) : null,
    itemId: raw.itemId != null ? String(raw.itemId) : null,
    sku: raw.sku != null ? String(raw.sku) : null,
    name: String(raw.name ?? 'Item'),
    qty,
    baseRate,
    gatcFeePerUnit,
    gatcStampingPriceId,
    gatcStampingRange: raw.gatcStampingRange != null ? String(raw.gatcStampingRange) : null,
    unitRate,
    lineBaseTotal: Number(raw.lineBaseTotal) || (baseRate * qty),
    lineGatcTotal: Number(raw.lineGatcTotal) || (gatcFeePerUnit * qty),
    lineTotal: Number(raw.lineTotal) || (unitRate * qty),
    hasStamping: Boolean(raw.hasStamping ?? (gatcStampingPriceId && gatcFeePerUnit > 0)),
    isWeighingScale: Boolean(raw.isWeighingScale),
  };
}

/** Sales-order `yesOneGatcLines` use `quantity`; report docs use `qty`. */
export function mapYesOneGatcLines(raw: unknown): GatcReportLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map(mapLine);
}

export function bundledGatcFeeFromLines(
  lines: ReadonlyArray<Pick<GatcReportLineItem, 'lineGatcTotal' | 'gatcFeePerUnit' | 'qty'>>,
): number {
  return Math.round(lines.reduce((sum, line) => {
    const fromLine = Number(line.lineGatcTotal) || 0;
    if (fromLine > 0) return sum + fromLine;
    return sum + (Number(line.gatcFeePerUnit) || 0) * (Number(line.qty) || 0);
  }, 0) * 100) / 100;
}

function normGatcKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export function matchGatcReportLine(
  line: {
    itemId?: string | null;
    productId?: string | null;
    sku?: string | null;
    name?: string | null;
    qty?: number;
  },
  gatcLines: readonly GatcReportLineItem[],
  used: Set<number>,
): GatcReportLineItem | null {
  const itemId = normGatcKey(line.itemId ?? line.productId);
  const sku = normGatcKey(line.sku);
  const name = normGatcKey(line.name);
  const qty = Math.max(0, Math.floor(Number(line.qty) || 0));

  const tryMatch = (predicate: (gatc: GatcReportLineItem) => boolean) => {
    for (let i = 0; i < gatcLines.length; i += 1) {
      if (used.has(i)) continue;
      const gatc = gatcLines[i];
      if (!gatc || !predicate(gatc)) continue;
      used.add(i);
      return gatc;
    }
    return null;
  };

  return (
    (itemId
      ? tryMatch(gatc => normGatcKey(gatc.itemId) === itemId || normGatcKey(gatc.productId) === itemId)
      : null)
    || (sku ? tryMatch(gatc => normGatcKey(gatc.sku) === sku && (!qty || gatc.qty === qty)) : null)
    || (sku ? tryMatch(gatc => normGatcKey(gatc.sku) === sku) : null)
    || (name ? tryMatch(gatc => normGatcKey(gatc.name) === name && (!qty || gatc.qty === qty)) : null)
    || (name ? tryMatch(gatc => normGatcKey(gatc.name) === name) : null)
  );
}

function mapReport(id: string, data: Record<string, unknown>): GatcReportDoc {
  const lineItems = Array.isArray(data.lineItems)
    ? data.lineItems
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map(mapLine)
    : [];
  const totalsRaw = (data.totals && typeof data.totals === 'object'
    ? data.totals as Record<string, unknown>
    : {}) as Record<string, unknown>;
  return {
    id,
    invoiceId: String(data.invoiceId ?? id),
    invoiceNumber: data.invoiceNumber != null ? String(data.invoiceNumber) : null,
    soId: String(data.soId ?? ''),
    salesOrderNumber: data.salesOrderNumber != null ? String(data.salesOrderNumber) : null,
    customerId: data.customerId != null ? String(data.customerId) : null,
    customerName: data.customerName != null ? String(data.customerName) : null,
    salespersonId: data.salespersonId != null ? String(data.salespersonId) : null,
    salespersonName: data.salespersonName != null ? String(data.salespersonName) : null,
    invoiceDate: data.invoiceDate != null ? String(data.invoiceDate) : null,
    soDate: data.soDate != null ? String(data.soDate) : null,
    referenceNumber: data.referenceNumber != null ? String(data.referenceNumber) : null,
    createdAt: String(data.createdAt ?? ''),
    source: String(data.source ?? 'portal_verify'),
    hasStamping: Boolean(data.hasStamping),
    hasWeighingScale: Boolean(
      data.hasWeighingScale
      ?? lineItems.some(line => line.isWeighingScale),
    ),
    searchBlob: String(data.searchBlob ?? ''),
    lineItems,
    totals: {
      lineCount: Number(totalsRaw.lineCount) || lineItems.length,
      stampedLineCount: Number(totalsRaw.stampedLineCount)
        || lineItems.filter(line => line.hasStamping).length,
      stampedQty: Number(totalsRaw.stampedQty)
        || lineItems.filter(line => line.hasStamping).reduce((s, line) => s + line.qty, 0),
      baseTotal: Number(totalsRaw.baseTotal)
        || lineItems.reduce((s, line) => s + line.lineBaseTotal, 0),
      gatcFeeTotal: Number(totalsRaw.gatcFeeTotal)
        || lineItems.reduce((s, line) => s + line.lineGatcTotal, 0),
      lineTotal: Number(totalsRaw.lineTotal)
        || lineItems.reduce((s, line) => s + line.lineTotal, 0),
    },
  };
}

/** Portal GATC ledger for one invoice (`gatcReports/{invoiceId}`). */
export async function fetchGatcReportForInvoice(
  invoiceId: string,
): Promise<GatcReportDoc | null> {
  const id = invoiceId.trim();
  if (!id) return null;
  try {
    const snap = await getDoc(doc(db, GATC_REPORTS_COLLECTION, id));
    if (!snap.exists()) return null;
    return mapReport(snap.id, snap.data() as Record<string, unknown>);
  } catch {
    return null;
  }
}

function parseInvoiceLineSerials(raw: Record<string, unknown>): string[] {
  const serials: string[] = [];

  const pushAll = (values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const entry of values) {
      if (typeof entry === 'string' && entry.trim()) {
        serials.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const value = row.serial_number
        ?? row.serialnumber
        ?? row.serial_number_value
        ?? row.serialNumber;
      if (value) serials.push(String(value).trim());
    }
  };

  pushAll(raw.serialNumbers);
  pushAll(raw.serial_numbers);
  pushAll(raw.item_serial_numbers);
  pushAll(raw.itemSerialNumbers);

  for (const field of [
    ...(Array.isArray(raw.item_custom_fields) ? raw.item_custom_fields : []),
    ...(Array.isArray(raw.custom_fields) ? raw.custom_fields : []),
  ]) {
    if (!field || typeof field !== 'object') continue;
    const row = field as Record<string, unknown>;
    const label = String(row.label ?? row.api_name ?? row.customfield_id ?? '').toLowerCase();
    if (!label.includes('serial') && !label.includes('mac')) continue;
    const value = row.value ?? row.value_formatted;
    if (value) serials.push(String(value).trim());
  }

  const description = raw.description != null ? String(raw.description) : null;
  serials.push(...serialNumbersFromLineItem({
    description,
    serialNumbers: undefined,
  }));

  if (description) {
    const listPattern = /\b(?:serial(?:\s*numbers?)?|s\/n|sn)\s*[:#-]\s*([^\n]+)/gi;
    let match = listPattern.exec(description);
    while (match) {
      const chunk = match[1] ?? '';
      for (const part of chunk.split(/[,;|]+/)) {
        const value = part.trim();
        if (value.length >= 3) serials.push(value);
      }
      match = listPattern.exec(description);
    }
  }

  return [...new Set(serials.filter(Boolean))];
}

/** Machine serials from the mirrored invoice (not stored on gatcReports). */
export async function fetchGatcInvoiceLineSerials(
  customerId: string | null | undefined,
  invoiceId: string,
): Promise<GatcInvoiceLineSerials[]> {
  const invId = invoiceId.trim();
  const cid = String(customerId ?? '').trim();
  if (!invId || !cid) return [];
  try {
    const snap = await getDoc(doc(db, 'zohoCustomers', cid, 'invoices', invId));
    if (!snap.exists()) return [];
    const lines = (Array.isArray(snap.data()?.lineItems) ? snap.data()?.lineItems : []) as unknown[];
    return lines
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map((raw): GatcInvoiceLineSerials => ({
        productId: raw.productId != null ? String(raw.productId) : (
          raw.itemId != null ? String(raw.itemId) : null
        ),
        itemId: raw.itemId != null ? String(raw.itemId) : (
          raw.item_id != null ? String(raw.item_id) : null
        ),
        sku: raw.sku != null ? String(raw.sku) : null,
        name: String(raw.name ?? ''),
        serialNumbers: parseInvoiceLineSerials(raw),
      }))
      .filter(row => row.serialNumbers.length > 0);
  } catch {
    return [];
  }
}

export function serialsForGatcLine(
  line: GatcReportLineItem,
  invoiceLines: GatcInvoiceLineSerials[],
  used: Set<number>,
): string[] {
  const name = line.name.trim().toLowerCase();
  const sku = line.sku?.trim().toLowerCase() ?? '';
  const unused = invoiceLines
    .map((inv, i) => ({ inv, i }))
    .filter(row => !used.has(row.i));

  const pick = (predicate: (inv: GatcInvoiceLineSerials) => boolean) =>
    unused.find(row => predicate(row.inv));

  const match = pick(inv => Boolean(line.productId && inv.productId && line.productId === inv.productId))
    ?? pick(inv => Boolean(line.itemId && inv.itemId && line.itemId === inv.itemId))
    ?? pick(inv => Boolean(sku && inv.sku && sku === inv.sku.trim().toLowerCase()))
    ?? pick(inv => Boolean(name && inv.name.trim().toLowerCase() === name))
    ?? pick(inv => {
      const invName = inv.name.trim().toLowerCase();
      return Boolean(name && invName && (invName.includes(name) || name.includes(invName)));
    })
    ?? (unused.length === 1 ? unused[0] : undefined);

  if (!match) return [];
  used.add(match.i);
  return match.inv.serialNumbers;
}

export async function listGatcReports(pageSize = 100): Promise<GatcReportDoc[]> {
  const cap = Math.max(1, Math.min(500, pageSize));
  try {
    const snap = await getDocs(
      query(
        collection(db, GATC_REPORTS_COLLECTION),
        orderBy('invoiceDate', 'desc'),
        limit(cap),
      ),
    );
    return snap.docs.map(docSnap => mapReport(docSnap.id, docSnap.data() as Record<string, unknown>));
  } catch {
    // Fallback if invoiceDate index is not ready yet.
    const snap = await getDocs(
      query(
        collection(db, GATC_REPORTS_COLLECTION),
        orderBy('createdAt', 'desc'),
        limit(cap),
      ),
    );
    return snap.docs.map(docSnap => mapReport(docSnap.id, docSnap.data() as Record<string, unknown>));
  }
}

/** Calendar day `YYYY-MM-DD`, or '' when the stored date cannot be placed. */
export function gatcReportDayKey(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  const prefix = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (prefix) return prefix[1];
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function gatcReportMonthKey(value: string | null | undefined): string {
  return gatcReportDayKey(value).slice(0, 7);
}

/**
 * Portal-stamped invoices in a date window (same membership as GATC Billwise).
 * Only reports with hasStamping are returned.
 */
export async function listGatcReportsInDateRange(options?: {
  dateStart?: string | null;
  dateEnd?: string | null;
  /** Soft cap — month windows are small; keep bounded for safety. */
  maxRows?: number;
}): Promise<GatcReportDoc[]> {
  const dateStart = options?.dateStart?.trim() || null;
  const dateEnd = options?.dateEnd?.trim() || null;
  const maxRows = Math.max(1, Math.min(2000, options?.maxRows ?? 1000));

  const mapSnap = (snap: Awaited<ReturnType<typeof getDocs>>) => (
    snap.docs
      .map(docSnap => mapReport(docSnap.id, docSnap.data() as Record<string, unknown>))
      .filter(report => report.hasStamping)
  );

  const runQuery = async (dateField: 'invoiceDate' | 'createdAt') => {
    const constraints: QueryConstraint[] = [];
    if (dateStart) constraints.push(where(dateField, '>=', dateStart));
    if (dateEnd) {
      // Date-only end must still include timestamp values on that calendar day.
      const endBound = /^\d{4}-\d{2}-\d{2}$/.test(dateEnd) ? `${dateEnd}\uf8ff` : dateEnd;
      constraints.push(where(dateField, '<=', endBound));
    }
    constraints.push(orderBy(dateField, 'desc'));
    constraints.push(limit(maxRows));
    return getDocs(query(collection(db, GATC_REPORTS_COLLECTION), ...constraints));
  };

  try {
    return mapSnap(await runQuery('invoiceDate'));
  } catch {
    try {
      return mapSnap(await runQuery('createdAt'));
    } catch {
      // Last resort: scan newest reports and filter client-side.
      const fallback = (await listGatcReports(Math.min(500, maxRows)))
        .filter(report => report.hasStamping);
      return fallback.filter(report => {
        const day = gatcReportDayKey(report.invoiceDate);
        if (dateStart && day && day < dateStart) return false;
        if (dateEnd && day && day > dateEnd.slice(0, 10)) return false;
        if ((dateStart || dateEnd) && !day) return false;
        return true;
      });
    }
  }
}

export function summarizeGatcReports(reports: readonly GatcReportDoc[]): {
  invoiceCount: number;
  gatcFeeTotal: number;
  stampedQty: number;
  invoiceIds: Set<string>;
} {
  const invoiceIds = new Set<string>();
  let gatcFeeTotal = 0;
  let stampedQty = 0;
  for (const report of reports) {
    const id = report.invoiceId || report.id;
    if (!id || invoiceIds.has(id)) continue;
    invoiceIds.add(id);
    gatcFeeTotal += report.totals.gatcFeeTotal;
    stampedQty += report.totals.stampedQty;
  }
  return {
    invoiceCount: invoiceIds.size,
    gatcFeeTotal,
    stampedQty,
    invoiceIds,
  };
}

export async function backfillGatcReportsFromInvoices(options?: {
  dryRun?: boolean;
}): Promise<{
  dryRun: boolean;
  scannedSalesOrders: number;
  scannedInvoices: number;
  wrote: number;
  soIndexed: number;
  soNumberIndexed: number;
  invoiceJoinIndexed: number;
  soFallbackWrote: number;
  skippedNoInvoice: number;
  skippedNoSo: number;
  skippedNoStamping: number;
  skippedMissingSo: number;
  deletedZero: number;
  errors: number;
}> {
  const callable = httpsCallable<
    { dryRun?: boolean },
    {
      dryRun: boolean;
      scannedSalesOrders: number;
      scannedInvoices: number;
      wrote: number;
      soIndexed: number;
      soNumberIndexed: number;
      invoiceJoinIndexed: number;
      soFallbackWrote: number;
      skippedNoInvoice: number;
      skippedNoSo: number;
      skippedNoStamping: number;
      skippedMissingSo: number;
      deletedZero: number;
      errors: number;
    }
  >(functions, 'backfillGatcReportsFromInvoicesFn', { timeout: 540_000 });
  const res = await callable({ dryRun: Boolean(options?.dryRun) });
  return res.data;
}

const LIGHT_SHARE = { yesweigh: 100, contractor: 100 } as const;
const HEAVY_SHARE = { yesweigh: 150, contractor: 200 } as const;

/** First kg token from a range like "20Kg 2g" or "5Kg 500mg". Bare "50" counts as 50 kg. */
export function parseGatcStampingCapacityKg(range: string | null | undefined): number | null {
  const text = String(range ?? '').trim();
  if (!text) return null;
  const withUnit = text.match(/(\d+(?:\.\d+)?)\s*kgs?\b/i);
  if (withUnit) {
    const kg = Number(withUnit[1]);
    return Number.isFinite(kg) ? kg : null;
  }
  const bare = text.match(/^(\d+(?:\.\d+)?)\s*$/);
  if (!bare) return null;
  const kg = Number(bare[1]);
  return Number.isFinite(kg) ? kg : null;
}

/** Up to 20 kg → light share; above 20 kg → heavy. Fee 200/350 is the fallback. */
export function isLightGatcStampingLine(line: Pick<
  GatcReportLineItem,
  'gatcStampingRange' | 'gatcFeePerUnit' | 'lineGatcTotal' | 'qty'
>): boolean {
  const kg = parseGatcStampingCapacityKg(line.gatcStampingRange);
  if (kg != null) return kg <= 20;
  const fee = line.gatcFeePerUnit > 0
    ? line.gatcFeePerUnit
    : (line.qty > 0 ? line.lineGatcTotal / line.qty : 0);
  return fee > 0 && fee <= 200;
}

export function gatcFeeShareForLine(line: GatcReportLineItem): {
  yesweigh: number;
  contractor: number;
} {
  if (!line.hasStamping || line.qty <= 0) return { yesweigh: 0, contractor: 0 };
  const share = isLightGatcStampingLine(line) ? LIGHT_SHARE : HEAVY_SHARE;
  return {
    yesweigh: share.yesweigh * line.qty,
    contractor: share.contractor * line.qty,
  };
}

export function sumGatcQtyByWeightBand(
  lines: ReadonlyArray<GatcReportLineItem>,
): { upto20kg: number; above20kg: number } {
  return lines.reduce(
    (sum, line) => {
      if (!line.hasStamping || line.qty <= 0) return sum;
      if (isLightGatcStampingLine(line)) {
        return { ...sum, upto20kg: sum.upto20kg + line.qty };
      }
      return { ...sum, above20kg: sum.above20kg + line.qty };
    },
    { upto20kg: 0, above20kg: 0 },
  );
}

export function sumGatcFeeShares(
  lines: ReadonlyArray<GatcReportLineItem>,
): { yesweigh: number; contractor: number } {
  return lines.reduce(
    (sum, line) => {
      const share = gatcFeeShareForLine(line);
      return {
        yesweigh: sum.yesweigh + share.yesweigh,
        contractor: sum.contractor + share.contractor,
      };
    },
    { yesweigh: 0, contractor: 0 },
  );
}

export function gatcReportMatchesQuery(report: GatcReportDoc, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (report.searchBlob.includes(q)) return true;
  const hay = [
    report.invoiceNumber,
    report.salesOrderNumber,
    report.customerName,
    report.customerId,
    report.referenceNumber,
    report.salespersonName,
    ...report.lineItems.flatMap(line => [
      line.sku,
      line.name,
      line.gatcStampingRange,
    ]),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}
