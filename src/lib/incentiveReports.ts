import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { SHIBIN_SALESPERSON_ID } from '../constants/shibinSalesperson';
import { db } from '../firebase';
import {
  fetchAllAdminInvoicesInRange,
  type AdminFirestoreInvoice,
} from './admin-invoices';
import { canonicalSalespersonName } from './dealerKamDisplay';
import type { User } from '../types';
import { normalizeZohoSalespersonLinks } from './zohoSalespersonStaff';
import {
  bundledGatcFeeFromLines,
  fetchGatcReportForInvoice,
  listGatcReportsInDateRange,
  mapYesOneGatcLines,
  matchGatcReportLine,
  type GatcReportLineItem,
} from './gatcReports';
import {
  invoiceAmountExclGst,
  isFreightInvoiceLineItem,
  isGatcFeeInvoiceLineItem,
} from './invoices';
import {
  gatcFeeFromInvoiceTag,
  invoiceLineHasGatcTag,
} from './invoiceGatcTag';
import { loadGatcStampingPrices } from './catalogProductSettings';
import {
  isDirectorsQtyClubSku,
  isPublishedQtySlabRate,
  loadPriceLevels,
  resolveDealerUnitPrice,
  resolveProductQtySlabRate,
  sumDirectorsClubCartQty,
} from './priceLevels';
import type { PriceLevel } from '../types/priceLevels';

export const INCENTIVE_RATE = 0.035;
export const INCENTIVE_DIRECTOR_RATE = 0.02;
/** Staff share of net upsale / down-sale adjust, added on top of rate-card incentive. */
export const INCENTIVE_UPSALE_SHARE_RATE = 0.3;
export const INCENTIVE_MONTH_START = '2026-04';

export type IncentiveKamId =
  | 'biju'
  | 'visak'
  | 'namratha'
  | 'saritha'
  | 'supriya'
  | 'shibin';

export type IncentiveKamOption = {
  id: IncentiveKamId;
  label: string;
  salespersonIds: string[];
  nameTokens: string[];
  spareOnly: boolean;
};

export const INCENTIVE_KAMS: IncentiveKamOption[] = [
  {
    id: 'biju',
    label: 'Biju',
    salespersonIds: ['99381000031557358'],
    nameTokens: ['biju'],
    spareOnly: false,
  },
  {
    id: 'visak',
    label: 'Visak',
    salespersonIds: ['99381000031557361'],
    nameTokens: ['visak', 'visakh'],
    spareOnly: false,
  },
  {
    id: 'namratha',
    label: 'Namratha',
    salespersonIds: ['99381000031557445'],
    nameTokens: ['namratha', 'namrata'],
    spareOnly: false,
  },
  {
    id: 'saritha',
    label: 'Saritha',
    salespersonIds: ['99381000029368684'],
    nameTokens: ['saritha', 'sarita'],
    spareOnly: false,
  },
  {
    id: 'supriya',
    label: 'Supriya',
    salespersonIds: ['99381000028629702'],
    nameTokens: ['supriya'],
    spareOnly: false,
  },
  {
    id: 'shibin',
    label: 'Shibin',
    salespersonIds: [SHIBIN_SALESPERSON_ID],
    nameTokens: ['shibin'],
    spareOnly: false,
  },
];

export type IncentivePriceAdjust = 'discount' | 'hike' | null;

export type IncentiveInvoiceRow = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string | null;
  date: string | null;
  salespersonName: string | null;
  kamId: IncentiveKamId | null;
  sales: number;
  rateCardSales: number;
  incentive: number;
  rate: number;
  priceAdjust: IncentivePriceAdjust;
  gatcExcess: number;
  discountAmount: number;
  discountedSales: number;
  hikeAmount: number;
};

export type IncentiveLineRateOverrideEdit = {
  at: string;
  byUid: string | null;
  byName: string | null;
  applicableRate: number;
  reason: string;
};

/** Incentive-only applicable rate. Does not change the Zoho invoice. */
export type IncentiveLineRateOverride = {
  id: string;
  invoiceId: string;
  month: string;
  lineKey: string;
  lineName: string;
  billedRate: number;
  applicableRate: number;
  systemListRate: number;
  qty: number;
  oldHikeAmount: number;
  oldDiscountAmount: number;
  hikeAmount: number;
  discountAmount: number;
  reason: string;
  updatedByUid: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  verifiedByUid: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  edits: IncentiveLineRateOverrideEdit[];
};

export const INCENTIVE_RATE_REASON_MAX = 200;

export function trimIncentiveRateReason(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, INCENTIVE_RATE_REASON_MAX);
}

export type IncentiveInvoiceLine = {
  name: string;
  sku: string | null;
  qty: number;
  rate: number;
  total: number;
  itemId: string | null;
  priceAdjust: IncentivePriceAdjust;
  gatcExcess: number;
  unitDiscount: number;
  unitHike: number;
  listRate: number;
  adjustQty: number;
  rateOverride?: IncentiveLineRateOverride | null;
};

export type IncentiveLineExclusion = {
  id: string;
  invoiceId: string;
  month: string;
  lineKey: string;
  sales: number;
  hikeAmount: number;
  discountAmount: number;
};

export type IncentiveRowTone = 'discount' | 'hike' | 'director' | null;

type PriceChangeLike = {
  productId?: unknown;
  itemId?: unknown;
  sku?: unknown;
  name?: unknown;
  catalogRate?: unknown;
  rate?: unknown;
  quantity?: unknown;
  source?: unknown;
  changedByUid?: unknown;
  priceLevelName?: unknown;
};

type SalesOrderExtras = {
  priceAdjust: IncentivePriceAdjust;
  gatcFee: number;
  discountAmount: number;
  discountedSales: number;
  hikeAmount: number;
};

function isManualUserPriceChange(change: PriceChangeLike): boolean {
  if (change.source === 'price_level') return false;
  if (!change.changedByUid && change.priceLevelName) return false;
  return change.source === 'user' || Boolean(change.changedByUid) || change.source == null;
}

function catalogLookupKey(productId?: unknown, itemId?: unknown, sku?: unknown): string[] {
  const keys: string[] = [];
  const product = String(productId ?? '').trim();
  const item = String(itemId ?? '').trim();
  const skuKey = String(sku ?? '').trim().toLowerCase();
  if (product) keys.push(product);
  if (item && item !== product) keys.push(item);
  if (skuKey) keys.push(`sku:${skuKey}`);
  return keys;
}

type CatalogPriceMeta = {
  id: string;
  rate: number;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

function catalogMetaFor(
  catalog: Map<string, CatalogPriceMeta>,
  productId?: unknown,
  itemId?: unknown,
  sku?: unknown,
): CatalogPriceMeta | null {
  for (const key of catalogLookupKey(productId, itemId, sku)) {
    const hit = catalog.get(key);
    if (hit) return hit;
  }
  return null;
}

async function loadCatalogPriceMeta(
  refs: Array<{ productId?: unknown; itemId?: unknown; sku?: unknown }>,
): Promise<Map<string, CatalogPriceMeta>> {
  const catalog = new Map<string, CatalogPriceMeta>();
  const ids = [...new Set(refs.flatMap(ref => (
    [String(ref.productId ?? '').trim(), String(ref.itemId ?? '').trim()].filter(Boolean)
  )))];
  const skus = [...new Set(refs
    .map(ref => String(ref.sku ?? '').trim())
    .filter(Boolean))];

  const index = (id: string, data: Record<string, unknown>) => {
    const meta: CatalogPriceMeta = {
      id: String(data.id ?? id),
      rate: Number(data.rate ?? 0) || 0,
      sku: data.sku != null ? String(data.sku).trim() : null,
      categoryId: data.categoryId != null ? String(data.categoryId).trim() : null,
      categoryName: data.categoryName != null ? String(data.categoryName).trim() : null,
    };
    if (id) catalog.set(id, meta);
    if (meta.id) catalog.set(meta.id, meta);
    if (meta.sku) catalog.set(`sku:${meta.sku.toLowerCase()}`, meta);
  };

  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    try {
      const snap = await getDocs(query(
        collection(db, 'catalogProducts'),
        where(documentId(), 'in', chunk),
      ));
      for (const row of snap.docs) {
        index(row.id, row.data());
      }
    } catch {
      await Promise.all(chunk.map(async id => {
        try {
          const snap = await getDoc(doc(db, 'catalogProducts', id));
          if (snap.exists()) index(id, snap.data());
        } catch {
          // skip missing catalog row
        }
      }));
    }
  }

  const missingSkus = skus.filter(sku => !catalog.has(`sku:${sku.toLowerCase()}`));
  for (const sku of missingSkus) {
    try {
      const snap = await getDocs(query(
        collection(db, 'catalogProducts'),
        where('sku', '==', sku),
        limit(1),
      ));
      if (snap.empty) continue;
      index(snap.docs[0].id, snap.docs[0].data());
    } catch {
      // skip
    }
  }

  return catalog;
}

function expectedCatalogRate(
  change: PriceChangeLike,
  catalog: Map<string, CatalogPriceMeta>,
  levels: PriceLevel[],
  dealerId: string | null,
  directorsClubQty: number,
  lineQty?: number,
): number {
  const meta = catalogMetaFor(catalog, change.productId, change.itemId, change.sku);
  const sku = meta?.sku ?? (change.sku != null ? String(change.sku) : null);
  const productId = meta?.id || String(change.productId ?? change.itemId ?? '');
  const qty = Math.max(1, lineQty || Number(change.quantity) || 0);
  const slabQty = (
    directorsClubQty > 0 && isDirectorsQtyClubSku(sku)
      ? directorsClubQty
      : qty
  );
  const slab = resolveProductQtySlabRate(levels, {
    productId,
    sku,
    quantity: slabQty,
    dealerId,
  });
  if (slab != null && slab > 0) return slab;

  const listRate = meta?.rate || Number(change.catalogRate) || 0;
  if (listRate <= 0) return 0;
  const priced = resolveDealerUnitPrice(
    levels,
    dealerId,
    {
      id: productId,
      rate: listRate,
      sku,
      categoryId: meta?.categoryId ?? null,
      categoryName: meta?.categoryName ?? null,
    },
    qty,
    { directorsClubQty },
  );
  return priced.chargeRate > 0 ? priced.chargeRate : listRate;
}

/** Keep the SO snapshot. Never replace catalogRate with today's list/slab. */
function withFrozenCatalogRates(
  changes: PriceChangeLike[],
  qtyForChange?: (change: PriceChangeLike) => number,
): PriceChangeLike[] {
  return changes.map(change => {
    const storedQty = Math.max(0, Number(change.quantity) || 0);
    const lineQty = qtyForChange?.(change) ?? 0;
    const quantity = Math.max(1, storedQty, lineQty);
    return { ...change, quantity };
  });
}

function lineAdjustNone(
  listRate: number,
  qty: number,
): Pick<IncentiveInvoiceLine, 'priceAdjust' | 'unitDiscount' | 'unitHike' | 'listRate' | 'adjustQty'> {
  return {
    priceAdjust: null,
    unitDiscount: 0,
    unitHike: 0,
    listRate: Math.max(0, listRate),
    adjustQty: qty,
  };
}

function billedRateMatchesPublishedSlab(
  levels: PriceLevel[],
  line: Pick<IncentiveInvoiceLine, 'itemId' | 'sku' | 'rate'>,
  charged = Number(line.rate) || 0,
): boolean {
  return charged > 0 && isPublishedQtySlabRate(levels, {
    productId: line.itemId,
    sku: line.sku,
    rate: charged,
  });
}

function directorsClubQtyFromLines(
  lines: Array<{ sku?: unknown; quantity?: unknown; qty?: unknown }>,
): number {
  return sumDirectorsClubCartQty(lines.map(line => ({
    sku: line.sku != null ? String(line.sku) : null,
    quantity: Number(line.quantity ?? line.qty) || 0,
  })));
}

function priceAdjustFromChange(
  change: PriceChangeLike,
  levels: PriceLevel[] = [],
): IncentivePriceAdjust {
  if (!isManualUserPriceChange(change)) return null;
  const charged = Number(change.rate) || 0;
  if (
    charged > 0
    && isPublishedQtySlabRate(levels, {
      productId: String(change.productId ?? change.itemId ?? ''),
      sku: change.sku != null ? String(change.sku) : null,
      rate: charged,
    })
  ) {
    return null;
  }
  const catalog = Number(change.catalogRate) || 0;
  if (catalog <= 0) return null;
  if (charged < catalog - 0.005) return 'discount';
  if (charged > catalog + 0.005) return 'hike';
  return null;
}

function priceAdjustAmount(change: PriceChangeLike): number {
  const catalog = Number(change.catalogRate) || 0;
  const charged = Number(change.rate) || 0;
  const qty = Math.max(1, Number(change.quantity) || 0);
  return round2(Math.abs(charged - catalog) * qty);
}

function chargedSalesFromChange(change: PriceChangeLike): number {
  const charged = Number(change.rate) || 0;
  const qty = Math.max(1, Number(change.quantity) || 0);
  return round2(Math.max(0, charged) * qty);
}

function summarizePriceAdjusts(
  changes: PriceChangeLike[],
  levels: PriceLevel[] = [],
): Omit<SalesOrderExtras, 'gatcFee'> {
  let hike = false;
  let discountAmount = 0;
  let discountedSales = 0;
  let hikeAmount = 0;
  for (const change of changes) {
    const kind = priceAdjustFromChange(change, levels);
    if (kind === 'discount') {
      discountAmount = round2(discountAmount + priceAdjustAmount(change));
      discountedSales = round2(discountedSales + chargedSalesFromChange(change));
    } else if (kind === 'hike') {
      hike = true;
      hikeAmount = round2(hikeAmount + priceAdjustAmount(change));
    }
  }
  return {
    priceAdjust: discountAmount > 0 ? 'discount' : (hike ? 'hike' : null),
    discountAmount,
    discountedSales,
    hikeAmount,
  };
}

export function incentiveRowTone(
  row: Pick<IncentiveInvoiceRow, 'priceAdjust' | 'rate'>,
): IncentiveRowTone {
  if (row.priceAdjust === 'discount') return 'discount';
  if (row.priceAdjust === 'hike') return 'hike';
  if (row.rate === INCENTIVE_DIRECTOR_RATE) return 'director';
  return null;
}

/** White note under a pink/red list amount: price hike, or discount given. GATC is never shown. */
export function incentiveRowNote(
  row: Pick<IncentiveInvoiceRow, 'priceAdjust' | 'rate' | 'discountAmount' | 'hikeAmount'>,
): { kind: 'excess' | 'discount'; amount: number } | null {
  const tone = incentiveRowTone(row);
  if (tone === 'discount' && row.discountAmount > 0) {
    return { kind: 'discount', amount: row.discountAmount };
  }
  if ((tone === 'hike' || tone === 'director') && row.hikeAmount > 0) {
    return { kind: 'excess', amount: row.hikeAmount };
  }
  return null;
}

export function salesExcludingBundledGatc(sales: number, gatcFee: number): number {
  return Math.max(0, round2(sales - Math.max(0, gatcFee)));
}

export function incentiveLineAmountsExGatc(
  input: {
    rate: number;
    total: number;
    qty: number;
    baseRate?: number | null;
    gatcFeePerUnit?: number | null;
    tagged?: boolean;
  },
  gatc: GatcReportLineItem | null,
): Pick<IncentiveInvoiceLine, 'rate' | 'total' | 'gatcExcess'> {
  const qty = Math.max(0, Number(input.qty) || 0);
  const charged = Number(input.rate) || 0;
  const chargedTotal = Number(input.total) || 0;
  const fee = gatc && gatc.gatcFeePerUnit > 0
    ? gatc.gatcFeePerUnit
    : (Number(input.gatcFeePerUnit) || 0);
  const tagged = Boolean(input.tagged) || fee > 0;
  const storedBase = gatc && gatc.baseRate > 0
    ? gatc.baseRate
    : (input.baseRate != null && Number(input.baseRate) > 0 ? Number(input.baseRate) : 0);
  let base = charged;
  if (fee > 0) {
    const storedPlusFee = storedBase > 0 && Math.abs(storedBase + fee - charged) < 0.51;
    // Invoice tagging means Zoho `rate` is base + GATC. Use that split
    // even when the GATC report stored the combined amount as baseRate.
    if (tagged || storedPlusFee || storedBase <= 0 || Math.abs(storedBase - charged) < 0.51) {
      base = charged - fee;
    } else {
      base = storedBase;
    }
  }
  const safeBase = Math.max(0, round2(base));
  return {
    rate: safeBase,
    total: qty > 0
      ? round2(safeBase * qty)
      : Math.max(0, round2(chargedTotal - fee * qty)),
    gatcExcess: Math.max(0, round2(fee)),
  };
}

function changeMatchesLine(
  change: PriceChangeLike,
  line: Pick<IncentiveInvoiceLine, 'itemId' | 'sku' | 'name'>,
): boolean {
  const productId = String(change.productId ?? '').trim();
  const itemId = String(change.itemId ?? '').trim();
  if (line.itemId && (productId === line.itemId || itemId === line.itemId)) return true;
  const sku = String(change.sku ?? '').trim();
  if (sku && line.sku && sku === line.sku.trim()) return true;
  const name = String(change.name ?? '').trim();
  return Boolean(name && line.name && name === line.name);
}

function lineAdjustFromSoChanges(
  line: Pick<IncentiveInvoiceLine, 'itemId' | 'sku' | 'name' | 'rate' | 'qty'>,
  changes: PriceChangeLike[],
  levels: PriceLevel[],
): Pick<IncentiveInvoiceLine, 'priceAdjust' | 'unitDiscount' | 'unitHike' | 'adjustQty' | 'listRate'> | null {
  let matchedSoLine = false;
  let best: Pick<IncentiveInvoiceLine, 'priceAdjust' | 'unitDiscount' | 'unitHike' | 'adjustQty' | 'listRate'> | null = null;
  let bestAbs = 0;
  for (const change of changes) {
    if (!changeMatchesLine(change, line)) continue;
    matchedSoLine = true;
    const charged = Number(change.rate) || Number(line.rate) || 0;
    if (billedRateMatchesPublishedSlab(levels, line, charged)) {
      return lineAdjustNone(charged, line.qty);
    }
    if (!isManualUserPriceChange(change)) {
      return lineAdjustNone(charged || Number(change.catalogRate) || 0, line.qty);
    }
    const catalog = Number(change.catalogRate) || 0;
    if (catalog <= 0 || charged <= 0) continue;
    const delta = round2(charged - catalog);
    const abs = Math.abs(delta);
    if (abs < 0.005 || abs <= bestAbs) continue;
    bestAbs = abs;
    best = delta < 0
      ? {
        priceAdjust: 'discount',
        unitDiscount: round2(-delta),
        unitHike: 0,
        adjustQty: line.qty,
        listRate: catalog,
      }
      : {
        priceAdjust: 'hike',
        unitDiscount: 0,
        unitHike: delta,
        adjustQty: line.qty,
        listRate: catalog,
      };
  }
  if (best) return best;
  if (matchedSoLine) return lineAdjustNone(Number(line.rate) || 0, line.qty);
  return null;
}

function lineAdjustFromRateCard(
  line: Pick<IncentiveInvoiceLine, 'itemId' | 'sku' | 'name' | 'rate' | 'qty'>,
  catalog: Map<string, CatalogPriceMeta>,
  levels: PriceLevel[],
  dealerId: string | null,
  clubQty: number,
  changes: PriceChangeLike[],
  soFound: boolean,
): Pick<IncentiveInvoiceLine, 'priceAdjust' | 'unitDiscount' | 'unitHike' | 'listRate' | 'adjustQty'> {
  const charged = Number(line.rate) || 0;
  if (billedRateMatchesPublishedSlab(levels, line, charged)) {
    return lineAdjustNone(charged, line.qty);
  }

  const fromSo = lineAdjustFromSoChanges(line, changes, levels);
  if (fromSo) return fromSo;
  // YesOne SO with no price-change row → billed at list/level at order time.
  if (soFound) return lineAdjustNone(charged, line.qty);

  const slabQty = Math.max(
    line.qty,
    ...changes
      .filter(change => changeMatchesLine(change, line))
      .map(change => Math.max(0, Number(change.quantity) || 0)),
  );
  const expected = expectedCatalogRate(
    {
      productId: line.itemId,
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity: slabQty,
    },
    catalog,
    levels,
    dealerId,
    clubQty,
    slabQty,
  );
  if (expected > 0 && charged > 0) {
    const delta = round2(charged - expected);
    if (delta < -0.005) {
      return {
        priceAdjust: 'discount',
        unitDiscount: round2(-delta),
        unitHike: 0,
        listRate: expected,
        adjustQty: line.qty,
      };
    }
    if (delta > 0.005) {
      return {
        priceAdjust: 'hike',
        unitDiscount: 0,
        unitHike: delta,
        listRate: expected,
        adjustQty: line.qty,
      };
    }
  }
  return lineAdjustNone(expected || charged, line.qty);
}

export function applyLineAdjustsToRow(
  row: IncentiveInvoiceRow,
  lines: IncentiveInvoiceLine[],
): IncentiveInvoiceRow {
  const fromLines = incentiveAdjustFromLines(lines);
  const hasHike = lines.some(line => line.priceAdjust === 'hike');
  const hasDiscount = lines.some(line => line.priceAdjust === 'discount');
  const hasOverride = lines.some(line => Boolean(line.rateOverride));
  if (hasOverride) {
    return withRateCardIncentive({
      ...row,
      hikeAmount: fromLines.hikeAmount,
      discountAmount: fromLines.discountAmount,
      priceAdjust: fromLines.priceAdjust,
    });
  }
  return withRateCardIncentive({
    ...row,
    hikeAmount: hasHike ? fromLines.hikeAmount : row.hikeAmount,
    discountAmount: hasDiscount ? fromLines.discountAmount : row.discountAmount,
    priceAdjust: hasDiscount
      ? 'discount'
      : (hasHike ? 'hike' : row.priceAdjust),
  });
}

function round2(value: number): number {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeName(value: string | null | undefined): string {
  return canonicalSalespersonName(value)
    .toLowerCase()
    .replace(/[()[\]]+/g, ' ')
    .replace(/[-_/.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function invoiceStatusExcluded(status: string | null | undefined): boolean {
  const key = String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return key === 'void' || key === 'draft' || key === 'cancelled' || key === 'canceled';
}

export function incentiveMonthBounds(yearMonth: string): { dateStart: string; dateEnd: string } {
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const day = String(lastDay).padStart(2, '0');
  return {
    dateStart: `${yearMonth}-01`,
    // \uf8ff keeps the last calendar day inclusive when `date` is a timestamp.
    dateEnd: `${yearMonth}-${day}\uf8ff`,
  };
}

/** True when an invoice date belongs to `YYYY-MM`. Undated rows are out. */
export function incentiveDateInMonth(
  date: string | null | undefined,
  yearMonth: string,
): boolean {
  const ym = String(yearMonth ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return false;
  const prefix = /^(\d{4}-\d{2})/.exec(String(date ?? '').trim());
  return Boolean(prefix && prefix[1] === ym);
}

export function matchIncentiveKam(
  invoice: Pick<AdminFirestoreInvoice, 'salespersonId' | 'salespersonName'>,
): IncentiveKamOption | null {
  const salespersonId = String(invoice.salespersonId ?? '').trim();
  const name = normalizeName(invoice.salespersonName);
  return INCENTIVE_KAMS.find(kam => {
    if (salespersonId && kam.salespersonIds.includes(salespersonId)) return true;
    return kam.nameTokens.some(token => name.includes(token));
  }) ?? null;
}

/** Super admins may switch KAMs. Sales staff only see their own. */
export function canBrowseAllIncentiveKams(
  user: Pick<User, 'role'> | null | undefined,
): boolean {
  return user?.role === 'super_admin';
}

type IncentiveStaffIdentity = {
  displayName?: string | null;
  zohoSalespersonId?: string | null;
  zohoSalespersonName?: string | null;
  zohoSalespersonIds?: string[] | null;
  zohoSalespersonLinks?: Array<{ id: string; name: string | null }> | null;
};

/** Incentive KAMs linked to this staff via Zoho salesperson id or name. */
export function incentiveKamsForUser(
  user: IncentiveStaffIdentity | null | undefined,
): IncentiveKamOption[] {
  if (!user) return [];
  const matched = new Set<IncentiveKamId>();
  const consider = (
    salespersonId: string | null | undefined,
    salespersonName: string | null | undefined,
  ) => {
    const kam = matchIncentiveKam({ salespersonId, salespersonName });
    if (kam) matched.add(kam.id);
  };

  consider(user.zohoSalespersonId, user.zohoSalespersonName);
  consider(null, user.displayName);
  for (const link of normalizeZohoSalespersonLinks(user)) {
    consider(link.id, link.name);
  }

  return INCENTIVE_KAMS.filter(kam => matched.has(kam.id));
}

/**
 * Firestore salesperson filter for the incentive report.
 * `null` = org-wide (super admin). `[]` = no linked KAM (show nothing).
 */
export function incentiveReportSalespersonIds(
  user: IncentiveStaffIdentity & Pick<User, 'role'> | null | undefined,
): string[] | null {
  if (canBrowseAllIncentiveKams(user)) return null;
  const ids = new Set<string>();
  for (const kam of incentiveKamsForUser(user)) {
    for (const id of kam.salespersonIds) ids.add(id);
  }
  for (const link of normalizeZohoSalespersonLinks(user ?? {})) {
    if (link.id) ids.add(link.id);
  }
  return [...ids];
}

function categoryAmount(
  invoice: AdminFirestoreInvoice,
  category: 'product' | 'spare' | 'service' | 'software_key' | 'gatc',
): number {
  const raw = Number(invoice.categoryAmounts?.[category] ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Invoice sales for incentive: exclude GST, courier/freight, and GATC fees.
 * Freight is already omitted from categoryAmounts; GATC is dropped here.
 */
export function incentiveEligibleSales(
  invoice: AdminFirestoreInvoice,
  spareOnly = false,
): number {
  if (spareOnly) return Math.max(0, round2(categoryAmount(invoice, 'spare')));

  const product = categoryAmount(invoice, 'product');
  const spare = categoryAmount(invoice, 'spare');
  const software = categoryAmount(invoice, 'software_key');
  const service = categoryAmount(invoice, 'service');
  const gatc = categoryAmount(invoice, 'gatc');
  const fromCategories = product + spare + software + service;

  if (fromCategories > 0 || gatc > 0 || Object.keys(invoice.categoryAmounts ?? {}).length > 0) {
    return Math.max(0, round2(fromCategories));
  }

  return Math.max(0, round2(invoiceAmountExclGst(invoice)));
}

export function isDirectorPriceLevelName(name: string | null | undefined): boolean {
  const key = String(name ?? '').trim().toLowerCase();
  return key === 'director' || key === 'directors';
}

export function directorDealerIdSet(levels: Array<Pick<PriceLevel, 'name' | 'dealerIds'>>): Set<string> {
  const ids = new Set<string>();
  for (const level of levels) {
    if (!isDirectorPriceLevelName(level.name)) continue;
    for (const raw of level.dealerIds ?? []) {
      const id = String(raw ?? '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function incentiveRateForInvoice(
  _kamId: IncentiveKamId | null,
  _dealerIsDirector: boolean,
): number {
  // All KAMs including spare incharge (Shibin): flat 3.5%. No director 2% slab.
  return INCENTIVE_RATE;
}

export function incentiveForSales(sales: number, rate = INCENTIVE_RATE): number {
  return round2(sales * rate);
}

/** Rate-card sales ignore invoice hikes and discounts. */
export function rateCardSalesFromInvoice(
  invoiceSales: number,
  hikeAmount: number,
  discountAmount: number,
): number {
  return Math.max(0, round2(invoiceSales - hikeAmount + discountAmount));
}

export function withRateCardIncentive(row: IncentiveInvoiceRow): IncentiveInvoiceRow {
  const rateCardSales = rateCardSalesFromInvoice(
    row.sales,
    row.hikeAmount ?? 0,
    row.discountAmount ?? 0,
  );
  return {
    ...row,
    rateCardSales,
    incentive: incentiveForSales(rateCardSales, row.rate),
  };
}

export function incentiveForRow(
  row: Pick<IncentiveInvoiceRow, 'incentive'>,
): number {
  return row.incentive;
}

export type IncentiveStaffTarget = {
  id: string;
  month: string;
  kamId: IncentiveKamId;
  target: number;
};

export function isIncentiveKamId(value: string): value is IncentiveKamId {
  return INCENTIVE_KAMS.some(kam => kam.id === value);
}

export function incentiveTargetDocId(month: string, kamId: IncentiveKamId): string {
  return `${month.trim()}_${kamId}`;
}

export function rateCardSalesForRow(
  row: Pick<IncentiveInvoiceRow, 'rateCardSales' | 'sales'>,
): number {
  const value = Number(row.rateCardSales);
  if (Number.isFinite(value)) return Math.max(0, value);
  return Math.max(0, Number(row.sales) || 0);
}

export function parseIncentiveTargetInput(raw: string): number {
  const cleaned = String(raw ?? '').replace(/[₹\s,]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(n);
}

/** Rate-card sales minus monthly target. Negative when the book misses target. */
export function incentiveSurplus(rateCardSales: number, target = 0): number {
  return round2((Number(rateCardSales) || 0) - Math.max(0, round2(target)));
}

/** Payable incentive: max(0, rate-card sales − target) × rate. */
export function incentiveOnSurplus(
  rateCardSales: number,
  target = 0,
  rate = INCENTIVE_RATE,
): number {
  return incentiveForSales(Math.max(0, incentiveSurplus(rateCardSales, target)), rate);
}

export function incentiveLineKey(
  line: Pick<IncentiveInvoiceLine, 'itemId' | 'sku' | 'name' | 'qty' | 'rate' | 'total'>,
  index: number,
): string {
  return [
    line.itemId || '',
    line.sku || '',
    line.name,
    line.qty,
    line.rate,
    line.total,
    index,
  ].join('|');
}

export function incentiveLineHasAdjust(line: Pick<IncentiveInvoiceLine, 'priceAdjust'>): boolean {
  return line.priceAdjust === 'discount' || line.priceAdjust === 'hike';
}

export function incentiveAdjustFromLines(
  lines: IncentiveInvoiceLine[],
): Pick<IncentiveInvoiceRow, 'hikeAmount' | 'discountAmount' | 'priceAdjust'> {
  const totals = lines.reduce((sum, line) => {
    const amounts = incentiveLineAdjustAmounts(line);
    return {
      hikeAmount: round2(sum.hikeAmount + amounts.hikeAmount),
      discountAmount: round2(sum.discountAmount + amounts.discountAmount),
    };
  }, { hikeAmount: 0, discountAmount: 0 });
  return {
    ...totals,
    priceAdjust: priceAdjustFromAmounts(totals.discountAmount, totals.hikeAmount),
  };
}

export function incentiveLineAdjustAmounts(
  line: Pick<IncentiveInvoiceLine, 'qty' | 'adjustQty' | 'priceAdjust' | 'unitDiscount' | 'unitHike'>,
  invoice?: Pick<IncentiveInvoiceRow, 'discountAmount' | 'hikeAmount'>,
): Pick<IncentiveLineExclusion, 'sales' | 'hikeAmount' | 'discountAmount'> {
  const qty = Math.max(0, Number(line.adjustQty || line.qty) || 0);
  let hikeAmount = line.priceAdjust === 'hike'
    ? round2(Math.max(0, line.unitHike) * qty)
    : 0;
  let discountAmount = line.priceAdjust === 'discount'
    ? round2(Math.max(0, line.unitDiscount) * qty)
    : 0;
  if (line.priceAdjust === 'hike' && hikeAmount <= 0 && invoice && invoice.hikeAmount > 0) {
    hikeAmount = invoice.hikeAmount;
  }
  if (line.priceAdjust === 'discount' && discountAmount <= 0 && invoice && invoice.discountAmount > 0) {
    discountAmount = invoice.discountAmount;
  }
  return {
    sales: 0,
    hikeAmount,
    discountAmount,
  };
}

function incentiveLineExclusionDocId(invoiceId: string, lineKey: string): string {
  return `${invoiceId}__${lineKey.replace(/[/#[\]]/g, '_')}`;
}

function priceAdjustFromAmounts(
  discountAmount: number,
  hikeAmount: number,
): IncentivePriceAdjust {
  if (discountAmount > 0.005) return 'discount';
  if (hikeAmount > 0.005) return 'hike';
  return null;
}

export function applyIncentiveExclusions(
  rows: IncentiveInvoiceRow[],
  exclusions: IncentiveLineExclusion[],
): IncentiveInvoiceRow[] {
  if (exclusions.length === 0) return rows;
  const cuts = new Map<string, IncentiveLineExclusion[]>();
  for (const exclusion of exclusions) {
    const list = cuts.get(exclusion.invoiceId) ?? [];
    list.push(exclusion);
    cuts.set(exclusion.invoiceId, list);
  }
  return rows.map(row => {
    const list = cuts.get(row.id);
    if (!list?.length) return row;
    const hikeCut = list.reduce((sum, item) => sum + item.hikeAmount, 0);
    const discountCut = list.reduce((sum, item) => sum + item.discountAmount, 0);
    const hikeAmount = Math.max(0, round2(row.hikeAmount - hikeCut));
    const discountAmount = Math.max(0, round2(row.discountAmount - discountCut));
    return {
      ...row,
      hikeAmount,
      discountAmount,
      priceAdjust: priceAdjustFromAmounts(discountAmount, hikeAmount),
    };
  });
}

export function incentiveExcludedAdjustTotals(
  rows: IncentiveInvoiceRow[],
  exclusions: IncentiveLineExclusion[],
): { hikeAmount: number; discountAmount: number } {
  const invoiceIds = new Set(rows.map(row => row.id));
  return exclusions.reduce((sum, item) => {
    if (!invoiceIds.has(item.invoiceId)) return sum;
    return {
      hikeAmount: round2(sum.hikeAmount + item.hikeAmount),
      discountAmount: round2(sum.discountAmount + item.discountAmount),
    };
  }, { hikeAmount: 0, discountAmount: 0 });
}

export async function listIncentiveLineExclusions(
  yearMonth: string,
): Promise<IncentiveLineExclusion[]> {
  const month = yearMonth.trim();
  if (!month) return [];
  const snap = await getDocs(query(
    collection(db, 'incentiveLineExclusions'),
    where('month', '==', month),
  ));
  return snap.docs.map(row => {
    const data = row.data();
    return {
      id: row.id,
      invoiceId: String(data.invoiceId ?? '').trim(),
      month: String(data.month ?? month).trim(),
      lineKey: String(data.lineKey ?? '').trim(),
      sales: Number(data.sales ?? 0) || 0,
      hikeAmount: Number(data.hikeAmount ?? 0) || 0,
      discountAmount: Number(data.discountAmount ?? 0) || 0,
    };
  }).filter(row => row.invoiceId && row.lineKey);
}

export async function setIncentiveLineExcluded(input: {
  invoiceId: string;
  month: string;
  lineKey: string;
  sales: number;
  hikeAmount: number;
  discountAmount: number;
  uid?: string | null;
}): Promise<IncentiveLineExclusion> {
  const invoiceId = input.invoiceId.trim();
  const month = input.month.trim();
  const lineKey = input.lineKey.trim();
  const id = incentiveLineExclusionDocId(invoiceId, lineKey);
  const exclusion: IncentiveLineExclusion = {
    id,
    invoiceId,
    month,
    lineKey,
    sales: round2(Math.max(0, input.sales)),
    hikeAmount: round2(Math.max(0, input.hikeAmount)),
    discountAmount: round2(Math.max(0, input.discountAmount)),
  };
  await setDoc(doc(db, 'incentiveLineExclusions', id), {
    ...exclusion,
    excludedAt: serverTimestamp(),
    excludedBy: input.uid || null,
  });
  return exclusion;
}

export async function clearIncentiveLineExcluded(
  invoiceId: string,
  lineKey: string,
): Promise<void> {
  const id = incentiveLineExclusionDocId(invoiceId.trim(), lineKey.trim());
  await deleteDoc(doc(db, 'incentiveLineExclusions', id));
}

function incentiveLineRateOverrideDocId(invoiceId: string, lineKey: string): string {
  return `${invoiceId}__${lineKey.replace(/[/#[\]]/g, '_')}`;
}

function firestoreDateIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date.toISOString()
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mapIncentiveLineRateOverrideEdits(raw: unknown): IncentiveLineRateOverrideEdit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const applicableRate = round2(Number(row.applicableRate) || 0);
    if (applicableRate <= 0) return [];
    return [{
      at: firestoreDateIso(row.at) || new Date().toISOString(),
      byUid: row.byUid == null ? null : String(row.byUid),
      byName: row.byName == null ? null : String(row.byName),
      applicableRate,
      reason: trimIncentiveRateReason(row.reason == null ? '' : String(row.reason)),
    }];
  }).slice(-20);
}

function mapIncentiveLineRateOverride(
  id: string,
  data: Record<string, unknown>,
  month: string,
): IncentiveLineRateOverride | null {
  const invoiceId = String(data.invoiceId ?? '').trim();
  const lineKey = String(data.lineKey ?? '').trim();
  const applicableRate = round2(Number(data.applicableRate) || 0);
  if (!invoiceId || !lineKey || applicableRate <= 0) return null;
  return {
    id,
    invoiceId,
    month: String(data.month ?? month).trim() || month,
    lineKey,
    lineName: String(data.lineName ?? '').trim(),
    billedRate: round2(Number(data.billedRate) || 0),
    applicableRate,
    systemListRate: round2(Number(data.systemListRate) || 0),
    qty: Math.max(0, round2(Number(data.qty) || 0)),
    oldHikeAmount: round2(Math.max(0, Number(data.oldHikeAmount) || 0)),
    oldDiscountAmount: round2(Math.max(0, Number(data.oldDiscountAmount) || 0)),
    hikeAmount: round2(Math.max(0, Number(data.hikeAmount) || 0)),
    discountAmount: round2(Math.max(0, Number(data.discountAmount) || 0)),
    reason: trimIncentiveRateReason(data.reason == null ? '' : String(data.reason)),
    updatedByUid: data.updatedByUid == null ? null : String(data.updatedByUid),
    updatedByName: data.updatedByName == null ? null : String(data.updatedByName),
    updatedAt: firestoreDateIso(data.updatedAt),
    verifiedByUid: data.verifiedByUid == null ? null : String(data.verifiedByUid),
    verifiedByName: data.verifiedByName == null ? null : String(data.verifiedByName),
    verifiedAt: firestoreDateIso(data.verifiedAt),
    edits: mapIncentiveLineRateOverrideEdits(data.edits),
  };
}

export function incentiveAmountsFromApplicableRate(
  billedRate: number,
  applicableRate: number,
  qty: number,
): { hikeAmount: number; discountAmount: number } {
  const units = Math.max(0, round2(qty));
  const billed = round2(billedRate);
  const applicable = round2(applicableRate);
  const delta = round2(billed - applicable);
  if (units <= 0 || applicable <= 0) return { hikeAmount: 0, discountAmount: 0 };
  if (delta > 0.005) return { hikeAmount: round2(delta * units), discountAmount: 0 };
  if (delta < -0.005) return { hikeAmount: 0, discountAmount: round2(-delta * units) };
  return { hikeAmount: 0, discountAmount: 0 };
}

export function lineAdjustFromApplicableRate(
  billedRate: number,
  applicableRate: number,
  qty: number,
): Pick<IncentiveInvoiceLine, 'priceAdjust' | 'unitDiscount' | 'unitHike' | 'listRate' | 'adjustQty'> {
  const charged = round2(billedRate);
  const expected = round2(applicableRate);
  const units = Math.max(0, round2(qty));
  if (expected > 0 && charged > 0) {
    const delta = round2(charged - expected);
    if (delta < -0.005) {
      return {
        priceAdjust: 'discount',
        unitDiscount: round2(-delta),
        unitHike: 0,
        listRate: expected,
        adjustQty: units,
      };
    }
    if (delta > 0.005) {
      return {
        priceAdjust: 'hike',
        unitDiscount: 0,
        unitHike: delta,
        listRate: expected,
        adjustQty: units,
      };
    }
  }
  return {
    priceAdjust: null,
    unitDiscount: 0,
    unitHike: 0,
    listRate: expected || charged,
    adjustQty: units,
  };
}

export function applyIncentiveLineRateOverride(
  line: IncentiveInvoiceLine,
  override: IncentiveLineRateOverride | undefined,
): IncentiveInvoiceLine {
  if (!override) return { ...line, rateOverride: null };
  return {
    ...line,
    ...lineAdjustFromApplicableRate(line.rate, override.applicableRate, line.qty),
    rateOverride: override,
  };
}

export function applyIncentiveLineRateOverridesToLines(
  lines: IncentiveInvoiceLine[],
  invoiceId: string,
  overrides: IncentiveLineRateOverride[],
): IncentiveInvoiceLine[] {
  if (!overrides.length) {
    return lines.map(line => (line.rateOverride ? { ...line, rateOverride: null } : line));
  }
  const byKey = new Map<string, IncentiveLineRateOverride>();
  for (const item of overrides) {
    if (item.invoiceId === invoiceId) byKey.set(item.lineKey, item);
  }
  if (!byKey.size) {
    return lines.map(line => (line.rateOverride ? { ...line, rateOverride: null } : line));
  }
  return lines.map((line, index) => (
    applyIncentiveLineRateOverride(line, byKey.get(incentiveLineKey(line, index)))
  ));
}

export function applyIncentiveRateOverrideDeltas(
  row: IncentiveInvoiceRow,
  overrides: IncentiveLineRateOverride[],
): IncentiveInvoiceRow {
  const list = overrides.filter(item => item.invoiceId === row.id);
  if (!list.length) return row;
  let hikeAmount = row.hikeAmount;
  let discountAmount = row.discountAmount;
  for (const item of list) {
    hikeAmount = round2(hikeAmount - item.oldHikeAmount + item.hikeAmount);
    discountAmount = round2(discountAmount - item.oldDiscountAmount + item.discountAmount);
  }
  hikeAmount = Math.max(0, hikeAmount);
  discountAmount = Math.max(0, discountAmount);
  return withRateCardIncentive({
    ...row,
    hikeAmount,
    discountAmount,
    priceAdjust: priceAdjustFromAmounts(discountAmount, hikeAmount),
  });
}

export function incentiveLineRateOverridePending(
  override: Pick<IncentiveLineRateOverride, 'verifiedAt'>,
): boolean {
  return !override.verifiedAt;
}

export function invoiceIncentiveRateOverrideKind(
  invoiceId: string,
  overrides: IncentiveLineRateOverride[],
): 'pending' | 'verified' | null {
  const list = overrides.filter(item => item.invoiceId === invoiceId);
  if (!list.length) return null;
  return list.some(incentiveLineRateOverridePending) ? 'pending' : 'verified';
}

export async function listIncentiveLineRateOverrides(
  yearMonth: string,
): Promise<IncentiveLineRateOverride[]> {
  const month = yearMonth.trim();
  if (!month) return [];
  const snap = await getDocs(query(
    collection(db, 'incentiveLineRateOverrides'),
    where('month', '==', month),
  ));
  return snap.docs.flatMap(row => {
    const mapped = mapIncentiveLineRateOverride(row.id, row.data() as Record<string, unknown>, month);
    return mapped ? [mapped] : [];
  });
}

export async function setIncentiveLineRateOverride(input: {
  invoiceId: string;
  month: string;
  lineKey: string;
  lineName: string;
  billedRate: number;
  applicableRate: number;
  systemListRate: number;
  qty: number;
  oldHikeAmount: number;
  oldDiscountAmount: number;
  uid?: string | null;
  name?: string | null;
  reason?: string | null;
  markVerified?: boolean;
  previous?: IncentiveLineRateOverride | null;
}): Promise<IncentiveLineRateOverride> {
  const invoiceId = input.invoiceId.trim();
  const month = input.month.trim();
  const lineKey = input.lineKey.trim();
  const applicableRate = round2(input.applicableRate);
  const reason = trimIncentiveRateReason(input.reason);
  if (!invoiceId || !month || !lineKey || applicableRate <= 0) {
    throw new Error('Applicable rate is required.');
  }
  if (!reason) {
    throw new Error('Add a reason for this rate update.');
  }
  const id = incentiveLineRateOverrideDocId(invoiceId, lineKey);
  const now = new Date().toISOString();
  const amounts = incentiveAmountsFromApplicableRate(input.billedRate, applicableRate, input.qty);
  const actorUid = input.uid || null;
  const actorName = (input.name || '').trim() || null;
  const previousEdits = input.previous?.edits ?? [];
  const edits = [
    ...previousEdits,
    { at: now, byUid: actorUid, byName: actorName, applicableRate, reason },
  ].slice(-20);
  const verified = Boolean(input.markVerified);
  const override: IncentiveLineRateOverride = {
    id,
    invoiceId,
    month,
    lineKey,
    lineName: input.lineName.trim(),
    billedRate: round2(input.billedRate),
    applicableRate,
    systemListRate: round2(Math.max(0, input.systemListRate)),
    qty: Math.max(0, round2(input.qty)),
    oldHikeAmount: round2(Math.max(0, input.oldHikeAmount)),
    oldDiscountAmount: round2(Math.max(0, input.oldDiscountAmount)),
    hikeAmount: amounts.hikeAmount,
    discountAmount: amounts.discountAmount,
    reason,
    updatedByUid: actorUid,
    updatedByName: actorName,
    updatedAt: now,
    verifiedByUid: verified ? actorUid : null,
    verifiedByName: verified ? actorName : null,
    verifiedAt: verified ? now : null,
    edits,
  };
  await setDoc(doc(db, 'incentiveLineRateOverrides', id), {
    ...override,
    savedAt: serverTimestamp(),
  });
  return override;
}

export async function verifyIncentiveLineRateOverride(input: {
  override: IncentiveLineRateOverride;
  uid?: string | null;
  name?: string | null;
}): Promise<IncentiveLineRateOverride> {
  const now = new Date().toISOString();
  const actorUid = input.uid || null;
  const actorName = (input.name || '').trim() || null;
  const override: IncentiveLineRateOverride = {
    ...input.override,
    verifiedByUid: actorUid,
    verifiedByName: actorName,
    verifiedAt: now,
  };
  await setDoc(doc(db, 'incentiveLineRateOverrides', override.id), {
    ...override,
    savedAt: serverTimestamp(),
  });
  return override;
}

export async function clearIncentiveLineRateOverride(
  invoiceId: string,
  lineKey: string,
): Promise<void> {
  const id = incentiveLineRateOverrideDocId(invoiceId.trim(), lineKey.trim());
  await deleteDoc(doc(db, 'incentiveLineRateOverrides', id));
}

export async function listIncentiveStaffTargets(
  yearMonth: string,
): Promise<IncentiveStaffTarget[]> {
  const month = yearMonth.trim();
  if (!month) return [];
  const snap = await getDocs(query(
    collection(db, 'incentiveTargets'),
    where('month', '==', month),
  ));
  return snap.docs.map(row => {
    const data = row.data();
    const kamId = String(data.kamId ?? '').trim();
    if (!isIncentiveKamId(kamId)) return null;
    return {
      id: row.id,
      month: String(data.month ?? month).trim() || month,
      kamId,
      target: Math.max(0, round2(Number(data.target) || 0)),
    };
  }).filter((row): row is IncentiveStaffTarget => Boolean(row));
}

export async function setIncentiveStaffTarget(input: {
  month: string;
  kamId: IncentiveKamId;
  target: number;
  uid?: string | null;
}): Promise<IncentiveStaffTarget> {
  const month = input.month.trim();
  const kamId = input.kamId;
  if (!month || !isIncentiveKamId(kamId)) {
    throw new Error('Invalid incentive target.');
  }
  const id = incentiveTargetDocId(month, kamId);
  const target: IncentiveStaffTarget = {
    id,
    month,
    kamId,
    target: Math.max(0, round2(input.target)),
  };
  await setDoc(doc(db, 'incentiveTargets', id), {
    ...target,
    updatedAt: serverTimestamp(),
    updatedBy: input.uid || null,
  });
  return target;
}

export async function persistIncentiveSnapshots(
  yearMonth: string,
  rows: IncentiveInvoiceRow[],
): Promise<void> {
  const month = yearMonth.trim();
  if (!month || rows.length === 0) return;
  const chunkSize = 400;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const row of rows.slice(i, i + chunkSize)) {
      batch.set(doc(db, 'incentiveSnapshots', row.id), {
        invoiceId: row.id,
        invoiceNumber: row.invoiceNumber,
        customerId: row.customerId,
        month,
        date: row.date,
        kamId: row.kamId,
        invoiceSales: row.sales,
        rateCardSales: row.rateCardSales,
        incentive: row.incentive,
        rate: row.rate,
        hikeAmount: row.hikeAmount,
        discountAmount: row.discountAmount,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
  }
}

function toIncentiveRow(
  invoice: AdminFirestoreInvoice,
  directorDealerIds: Set<string>,
  gatcFee = 0,
): IncentiveInvoiceRow | null {
  if (invoiceStatusExcluded(invoice.status)) return null;
  const kam = matchIncentiveKam(invoice);
  const sales = salesExcludingBundledGatc(
    incentiveEligibleSales(invoice, kam?.spareOnly === true),
    gatcFee,
  );
  if (sales <= 0) return null;
  const dealerIsDirector = directorDealerIds.has(String(invoice.customerId ?? '').trim());
  const rate = incentiveRateForInvoice(kam?.id ?? null, dealerIsDirector);
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber || invoice.id,
    customerId: String(invoice.customerId ?? '').trim(),
    customerName: invoice.customerName,
    date: invoice.date,
    salespersonName: invoice.salespersonName ?? kam?.label ?? null,
    kamId: kam?.id ?? null,
    sales,
    rateCardSales: sales,
    incentive: incentiveForSales(sales, rate),
    rate,
    priceAdjust: null,
    gatcExcess: Math.max(0, round2(gatcFee)),
    discountAmount: 0,
    discountedSales: 0,
    hikeAmount: 0,
  };
}

export async function fetchIncentiveInvoiceLines(
  customerId: string | null | undefined,
  invoiceId: string,
): Promise<IncentiveInvoiceLine[]> {
  const cid = String(customerId ?? '').trim();
  const invId = invoiceId.trim();
  if (!cid || !invId) return [];
  try {
    const [snap, gatcReport, gatcPrices, priceLevels] = await Promise.all([
      getDoc(doc(db, 'zohoCustomers', cid, 'invoices', invId)),
      fetchGatcReportForInvoice(invId),
      loadGatcStampingPrices().catch(() => []),
      loadPriceLevels().catch(() => ({ levels: [] as PriceLevel[] })),
    ]);
    if (!snap.exists()) return [];
    const invoice = snap.data() ?? {};
    const salesOrderId = invoice.salesOrderId != null ? String(invoice.salesOrderId).trim() : '';
    const soExtras = await loadSalesOrderLineContext(invId, salesOrderId);
    const invoiceLines = (Array.isArray(invoice.lineItems) ? invoice.lineItems : [])
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
    const catalog = await loadCatalogPriceMeta([
      ...soExtras.changes,
      ...invoiceLines.map(raw => ({
        productId: raw.productId,
        itemId: raw.itemId ?? raw.item_id,
        sku: raw.sku,
      })),
    ]);
    const clubQty = directorsClubQtyFromLines([
      ...soExtras.changes,
      ...soExtras.lines,
      ...invoiceLines,
    ]);
    const priceChanges = withFrozenCatalogRates(soExtras.changes);
    const gatcLines = gatcReport?.lineItems?.length
      ? gatcReport.lineItems
      : soExtras.gatcLines;
    const usedGatc = new Set<number>();
    const lines = invoiceLines;
    return lines
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map(raw => {
        const name = String(raw.name ?? 'Item');
        const sku = raw.sku != null ? String(raw.sku) : null;
        const itemId = raw.itemId != null ? String(raw.itemId) : (
          raw.item_id != null ? String(raw.item_id) : null
        );
        const productId = raw.productId != null ? String(raw.productId) : itemId;
        const hsn = raw.hsn != null ? String(raw.hsn) : null;
        const qty = Number(raw.quantity ?? raw.qty ?? 0) || 0;
        const description = raw.description != null ? String(raw.description) : null;
        const tagged = invoiceLineHasGatcTag({
          description,
          gatcStampingPriceId: raw.gatcStampingPriceId != null
            ? String(raw.gatcStampingPriceId)
            : null,
          gatcFeePerUnit: raw.gatcFeePerUnit != null ? Number(raw.gatcFeePerUnit) : null,
        });
        const gatc = matchGatcReportLine(
          { itemId, productId, sku, name, qty },
          gatcLines,
          usedGatc,
        );
        const tagFee = gatcFeeFromInvoiceTag({
          description,
          gatcFeePerUnit: raw.gatcFeePerUnit != null ? Number(raw.gatcFeePerUnit) : null,
          gatcStampingRange: raw.gatcStampingRange != null
            ? String(raw.gatcStampingRange)
            : (gatc?.gatcStampingRange ?? null),
        }, gatcPrices);
        const amounts = incentiveLineAmountsExGatc({
          rate: Number(raw.rate ?? 0) || 0,
          total: Number(raw.total ?? 0) || 0,
          qty,
          baseRate: raw.baseRate != null ? Number(raw.baseRate) : null,
          gatcFeePerUnit: (gatc && gatc.gatcFeePerUnit > 0)
            ? gatc.gatcFeePerUnit
            : tagFee,
          tagged: tagged || Boolean(gatc?.hasStamping),
        }, gatc);
        return {
          name,
          sku,
          qty,
          ...amounts,
          itemId,
          hsn,
        };
      })
      .filter(line => (
        !isFreightInvoiceLineItem(line)
        && !isGatcFeeInvoiceLineItem(line)
        && line.qty > 0
      ))
      .map(({ name, sku, qty, rate, total, itemId, gatcExcess }) => {
        const adjust = lineAdjustFromRateCard(
          { itemId, sku, name, rate, qty },
          catalog,
          priceLevels.levels,
          cid,
          clubQty,
          priceChanges,
          soExtras.found,
        );
        return {
          name,
          sku,
          qty,
          rate,
          total,
          itemId,
          gatcExcess,
          ...adjust,
        };
      });
  } catch {
    return [];
  }
}

async function loadSalesOrderLineContext(
  invoiceId: string,
  salesOrderId?: string,
): Promise<{
  found: boolean;
  changes: PriceChangeLike[];
  lines: Array<Record<string, unknown>>;
  gatcLines: GatcReportLineItem[];
}> {
  const empty = {
    found: false,
    changes: [] as PriceChangeLike[],
    lines: [] as Array<Record<string, unknown>>,
    gatcLines: [] as GatcReportLineItem[],
  };
  const fromSnap = (data: Record<string, unknown> | undefined) => ({
    found: true,
    changes: Array.isArray(data?.yesOnePriceChanges) ? data.yesOnePriceChanges : [],
    lines: (Array.isArray(data?.lineItems) ? data.lineItems : [])
      .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object'),
    gatcLines: mapYesOneGatcLines(data?.yesOneGatcLines),
  });
  if (salesOrderId) {
    const soSnap = await getDoc(doc(db, 'salesOrders', salesOrderId));
    if (soSnap.exists()) return fromSnap(soSnap.data());
  }
  const found = await getDocs(query(
    collection(db, 'salesOrders'),
    where('zohoInvoiceId', '==', invoiceId),
    limit(1),
  ));
  if (found.empty) return empty;
  return fromSnap(found.docs[0].data());
}

type IncentiveSoLookup = {
  invoiceId: string;
  customerId: string;
  salesOrderId?: string | null;
  salesOrderNumber?: string | null;
  itemQuantity?: number | null;
};

type SalesOrderBundle = {
  id: string;
  zohoInvoiceId: string;
  salesOrderNumber: string;
  customerId: string;
  changes: PriceChangeLike[];
  lines: Array<Record<string, unknown>>;
  gatcFee: number;
  soQty: number;
};

function soPricedQty(lines: Array<Record<string, unknown>>): number {
  let qty = 0;
  for (const line of lines) {
    const sku = line.sku != null ? String(line.sku) : null;
    const name = String(line.name ?? '');
    if (isFreightInvoiceLineItem({ sku, name }) || isGatcFeeInvoiceLineItem({ sku, name })) continue;
    qty += Math.max(0, Number(line.quantity ?? line.qty) || 0);
  }
  return qty;
}

function bundleFromSalesOrderDoc(
  soId: string,
  data: Record<string, unknown>,
  fallbackCustomerId = '',
): SalesOrderBundle {
  const lines = (Array.isArray(data.lineItems) ? data.lineItems : [])
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object');
  return {
    id: soId,
    zohoInvoiceId: String(data.zohoInvoiceId ?? '').trim(),
    salesOrderNumber: String(data.salesOrderNumber ?? '').trim(),
    customerId: String(data.customerId ?? fallbackCustomerId).trim(),
    changes: Array.isArray(data.yesOnePriceChanges) ? data.yesOnePriceChanges : [],
    lines,
    gatcFee: bundledGatcFeeFromLines(mapYesOneGatcLines(data.yesOneGatcLines)),
    soQty: soPricedQty(lines),
  };
}

function salesOrderMatchesInvoice(so: SalesOrderBundle, invoice: IncentiveSoLookup): boolean {
  if (so.zohoInvoiceId && so.zohoInvoiceId === invoice.invoiceId) return true;
  if (invoice.salesOrderId && invoice.salesOrderId === so.id) return true;
  const soNumber = so.salesOrderNumber;
  const invNumber = String(invoice.salesOrderNumber ?? '').trim();
  return Boolean(soNumber && invNumber && soNumber === invNumber);
}

function scaleSalesOrderExtras(
  extras: Omit<SalesOrderExtras, 'gatcFee'>,
  invoiceQty: number | null | undefined,
  soQty: number,
): Omit<SalesOrderExtras, 'gatcFee'> {
  if (soQty <= 0 || invoiceQty == null || invoiceQty <= 0 || invoiceQty >= soQty) return extras;
  const factor = invoiceQty / soQty;
  return {
    ...extras,
    hikeAmount: round2(extras.hikeAmount * factor),
    discountAmount: round2(extras.discountAmount * factor),
    discountedSales: round2(extras.discountedSales * factor),
  };
}

async function loadSalesOrderDocsByIds(ids: string[]): Promise<SalesOrderBundle[]> {
  const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
  const bundles: SalesOrderBundle[] = [];
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const snap = await getDocs(query(
      collection(db, 'salesOrders'),
      where(documentId(), 'in', chunk),
    ));
    for (const row of snap.docs) {
      bundles.push(bundleFromSalesOrderDoc(row.id, row.data() as Record<string, unknown>));
    }
  }
  return bundles;
}

async function loadSalesOrderDocsByNumbers(numbers: string[]): Promise<SalesOrderBundle[]> {
  const unique = [...new Set(numbers.map(value => value.trim()).filter(Boolean))];
  const bundles: SalesOrderBundle[] = [];
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const snap = await getDocs(query(
      collection(db, 'salesOrders'),
      where('salesOrderNumber', 'in', chunk),
    ));
    for (const row of snap.docs) {
      bundles.push(bundleFromSalesOrderDoc(row.id, row.data() as Record<string, unknown>));
    }
  }
  return bundles;
}

async function loadSalesOrderExtras(
  invoices: IncentiveSoLookup[],
  levels: PriceLevel[],
): Promise<Map<string, SalesOrderExtras>> {
  const bundlesById = new Map<string, SalesOrderBundle>();
  const remember = (bundle: SalesOrderBundle) => {
    if (!bundlesById.has(bundle.id)) bundlesById.set(bundle.id, bundle);
  };

  const invoiceIds = [...new Set(invoices.map(row => row.invoiceId.trim()).filter(Boolean))];
  for (let i = 0; i < invoiceIds.length; i += 10) {
    const chunk = invoiceIds.slice(i, i + 10);
    const snap = await getDocs(query(
      collection(db, 'salesOrders'),
      where('zohoInvoiceId', 'in', chunk),
    ));
    for (const row of snap.docs) {
      remember(bundleFromSalesOrderDoc(row.id, row.data() as Record<string, unknown>));
    }
  }

  const missing = invoices.filter(invoice => (
    ![...bundlesById.values()].some(so => salesOrderMatchesInvoice(so, invoice))
  ));
  const missingSoIds = missing
    .map(row => String(row.salesOrderId ?? '').trim())
    .filter(Boolean);
  if (missingSoIds.length) {
    for (const bundle of await loadSalesOrderDocsByIds(missingSoIds)) remember(bundle);
  }

  const stillMissing = invoices.filter(invoice => (
    ![...bundlesById.values()].some(so => salesOrderMatchesInvoice(so, invoice))
  ));
  const missingNumbers = stillMissing
    .map(row => String(row.salesOrderNumber ?? '').trim())
    .filter(Boolean);
  if (missingNumbers.length) {
    try {
      for (const bundle of await loadSalesOrderDocsByNumbers(missingNumbers)) remember(bundle);
    } catch {
      // salesOrderNumber lookup is best-effort (index / field may be missing).
    }
  }

  const extrasBySoId = new Map<string, Omit<SalesOrderExtras, 'gatcFee'> & { gatcFee: number; soQty: number }>();
  for (const so of bundlesById.values()) {
    extrasBySoId.set(so.id, {
      ...summarizePriceAdjusts(withFrozenCatalogRates(so.changes), levels),
      gatcFee: so.gatcFee,
      soQty: so.soQty,
    });
  }

  const map = new Map<string, SalesOrderExtras>();
  for (const invoice of invoices) {
    const so = [...bundlesById.values()].find(bundle => salesOrderMatchesInvoice(bundle, invoice));
    if (!so) continue;
    const extras = extrasBySoId.get(so.id);
    if (!extras) continue;
    const scaled = scaleSalesOrderExtras(extras, invoice.itemQuantity, extras.soQty);
    map.set(invoice.invoiceId, {
      ...scaled,
      gatcFee: extras.gatcFee,
    });
  }
  return map;
}

export async function listIncentiveInvoices(
  yearMonth: string,
  salespersonIds?: string[] | null,
): Promise<{
  rows: IncentiveInvoiceRow[];
  truncated: boolean;
}> {
  if (salespersonIds != null && salespersonIds.length === 0) {
    return { rows: [], truncated: false };
  }
  const { dateStart, dateEnd } = incentiveMonthBounds(yearMonth);
  const [{ rows, truncated }, priceLevels, gatcReports] = await Promise.all([
    fetchAllAdminInvoicesInRange({
      category: 'all',
      dateStart,
      dateEnd,
      sort: 'latest',
      skipDerivedOverlays: true,
      maxRows: 4000,
      salespersonIds,
    }),
    loadPriceLevels().catch(() => ({ levels: [] as PriceLevel[] })),
    listGatcReportsInDateRange({ dateStart, dateEnd, maxRows: 2000 }).catch(() => []),
  ]);
  const gatcFeeByInvoice = new Map<string, number>();
  for (const report of gatcReports) {
    const invoiceId = (report.invoiceId || report.id).trim();
    if (!invoiceId || gatcFeeByInvoice.has(invoiceId)) continue;
    gatcFeeByInvoice.set(invoiceId, report.totals.gatcFeeTotal);
  }
  const directorDealerIds = directorDealerIdSet(priceLevels.levels);
  const mapped = rows
    .map(row => toIncentiveRow(row, directorDealerIds, gatcFeeByInvoice.get(row.id) ?? 0))
    .filter((row): row is IncentiveInvoiceRow => Boolean(row));
  const extras = await loadSalesOrderExtras(
    rows.map(row => ({
      invoiceId: row.id,
      customerId: row.customerId,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrderNumber,
      itemQuantity: row.itemQuantity,
    })),
    priceLevels.levels,
  );
  return {
    rows: mapped.map(row => {
      const extra = extras.get(row.id);
      const gatcExcess = row.gatcExcess > 0 ? row.gatcExcess : (extra?.gatcFee ?? 0);
      const sales = row.gatcExcess > 0
        ? row.sales
        : salesExcludingBundledGatc(row.sales, extra?.gatcFee ?? 0);
      return withRateCardIncentive({
        ...row,
        sales,
        gatcExcess,
        priceAdjust: extra?.priceAdjust ?? null,
        discountAmount: extra?.discountAmount ?? 0,
        discountedSales: extra?.discountedSales ?? 0,
        hikeAmount: extra?.hikeAmount ?? 0,
      });
    }).filter(row => row.sales > 0 && incentiveDateInMonth(row.date, yearMonth)),
    truncated,
  };
}
