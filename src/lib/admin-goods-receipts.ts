import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  updateDoc,
  where,
  serverTimestamp,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, app } from '../firebase';
import { getOpenAuditCycle } from './auditCycles/data';
import { recordCatalogProductAudit } from './catalogProductAudit/data';
import {
  applyCatalogSiteInventoryDeltas,
} from './catalogSiteInventory/data';
import { applyYesStoreInboundDeltas } from './yesStore/data';
import { isFreightProductId, isFreightSku } from '../constants/freightLines';
import {
  parsePurchaseOrderSerialRanges,
  type PurchaseOrderSerialRangesByLineId,
} from './purchaseOrderSerials';
import { enrichInvoiceDetailImages } from './invoiceLineItemImages';
import {
  getInvoicePeriodBounds,
  invoiceErrorMessage,
  normalizeInvoiceCategories,
  normalizeInvoiceCategoryAmounts,
  parseInvoiceCategory,
  isSoftwareOnlyInvoiceCategories,
  sumInvoiceProductQuantity,
  firstDateTimeValue,
} from './invoices';
import type {
  DealerInvoiceLineItem,
  InvoiceCategory,
  InvoiceDocumentDownload,
  InvoiceSalesEntry,
  KpiPeriod,
} from '../types/invoices';
import type { PurchaseOrderSerialRangeInput } from './purchaseOrderSerials';

const functions = getFunctions(app, 'asia-south1');
const ADMIN_GR_PAGE_SIZE = 100;
const ADMIN_GR_AGGREGATE_MAX_ROWS = 2500;

export type AdminGoodsReceiptSort = 'syncedAt' | 'date';
export type GoodsReceiptLocation = 'head_office' | 'cochin';
export type GoodsReceiptLocationFilter = GoodsReceiptLocation | 'all';
export type GoodsReceiptShipmentStage = 'in_transit' | 'scheduled' | 'received';
export type GoodsReceiptShipmentFilter = 'all' | GoodsReceiptShipmentStage;

export type AdminGoodsReceiptListQuery = {
  sort?: AdminGoodsReceiptSort;
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  /** @deprecated Prefer location */
  category?: InvoiceCategory | 'all';
  location?: GoodsReceiptLocationFilter;
  /** Inclusive YYYY-MM-DD */
  dateStart?: string | null;
  /** Inclusive YYYY-MM-DD */
  dateEnd?: string | null;
};

export interface AdminFirestoreGoodsReceipt {
  id: string;
  billNumber: string;
  vendorId: string;
  vendorName: string | null;
  date: string | null;
  createdTime?: string | null;
  dueDate: string | null;
  status: string;
  total: number;
  balance: number;
  currencyCode: string;
  referenceNumber: string | null;
  syncedAt: string | null;
  itemQuantity: number | null;
  itemVariantCount: number | null;
  locationId: string | null;
  locationName: string | null;
  inventorySite: GoodsReceiptLocation | null;
  goodsReceiptCategory: InvoiceCategory | null;
  categories: InvoiceCategory[];
  categoryAmounts: Partial<Record<InvoiceCategory, number>>;
  sailedDate: string | null;
  receivedDate: string | null;
  /** ISO datetime when ops marked this bill received (opens Zoho draft → open). */
  opsReceivedAt: string | null;
  opsReceivedByName: string | null;
  /** True when ops receive-check has any received qty. */
  receiveChecked: boolean;
}

export interface AdminGoodsReceiptDetail {
  id: string;
  billNumber: string;
  date: string | null;
  dueDate: string | null;
  poDate: string | null;
  sailedDate: string | null;
  receivedDate: string | null;
  opsReceivedAt: string | null;
  opsReceivedByUid: string | null;
  opsReceivedByName: string | null;
  status: string;
  total: number;
  balance: number;
  referenceNumber: string | null;
  purchaseOrderNumber: string | null;
  currencyCode: string;
  vendorId: string;
  vendorName: string | null;
  /** Vendor billing state / province when Zoho provides it. */
  vendorState: string | null;
  /** Vendor billing country when Zoho provides it. */
  vendorCountry: string | null;
  vendorCity: string | null;
  locationId: string | null;
  locationName: string | null;
  inventorySite: GoodsReceiptLocation | null;
  goodsReceiptCategory: InvoiceCategory | null;
  categories: InvoiceCategory[];
  categoryAmounts: Partial<Record<InvoiceCategory, number>>;
  subtotal: number;
  taxTotal: number;
  notes: string | null;
  lineItems: DealerInvoiceLineItem[];
  /** Ops receive check — keyed by Zoho line item id. */
  receiveCheck: GoodsReceiptReceiveCheck | null;
  serialRangesByLineId: PurchaseOrderSerialRangesByLineId;
}

export type GoodsReceiptReceiveLocation = {
  quantity: number;
  /** Cochin warehouse (shop products). */
  zoneId?: string | null;
  zoneRowNumber?: number | null;
  /** Head Office store room (spare parts). */
  rackId?: string | null;
  rowNumber?: number | null;
  binNumber?: number | null;
};

export function isHeadOfficeReceiveLocation(
  loc: Pick<GoodsReceiptReceiveLocation, 'rackId' | 'rowNumber' | 'binNumber'>,
): boolean {
  return Boolean(loc.rackId && loc.rowNumber != null && loc.binNumber != null);
}

export function isCochinReceiveLocation(
  loc: Pick<GoodsReceiptReceiveLocation, 'zoneId' | 'zoneRowNumber'>,
): boolean {
  return Boolean(loc.zoneId && loc.zoneRowNumber != null);
}

function receiveLocationKey(loc: GoodsReceiptReceiveLocation): string {
  if (isHeadOfficeReceiveLocation(loc)) {
    return `ho:${String(loc.rackId).toLowerCase()}:${loc.rowNumber}:${loc.binNumber}`;
  }
  return `cochin:${String(loc.zoneId || '').toLowerCase()}:${loc.zoneRowNumber ?? 0}`;
}

export type GoodsReceiptReceiveLine = {
  /** Total received qty (sum of location quantities, or standalone when no locations). */
  receivedQty: number;
  /**
   * Legacy single Cochin placement — mirrored from locations[0] when present.
   * Prefer `locations`.
   */
  zoneId: string | null;
  zoneRowNumber: number | null;
  rackId: string | null;
  rowNumber: number | null;
  binNumber: number | null;
  /** Warehouse placements for this line. */
  locations: GoodsReceiptReceiveLocation[];
};

export type GoodsReceiptReceiveCheck = {
  /** Per-line receive verification (preferred). */
  lines: Record<string, GoodsReceiptReceiveLine>;
  /** Legacy qty-only map — kept in sync when saving. */
  byLineId: Record<string, number>;
  /**
   * Last placements pushed to stock + product audit (Cochin zone/row and/or Head Office rack/row/bin).
   * Draft saves update `lines` only; Goods received copies `lines` here after posting.
   */
  postedLines: Record<string, GoodsReceiptReceiveLine>;
  /** True when `postedLines` was stored (false = legacy Save, treat `lines` as posted). */
  hasPostedSnapshot: boolean;
  postedAt: string | null;
  postedByUid: string | null;
  postedByName: string | null;
  /** Zoho line ids hidden from receive UI (super-admin only). */
  hiddenLineIds: string[];
  updatedAt: string | null;
  updatedByUid: string | null;
  updatedByName: string | null;
};

function parseReceiveLocation(raw: Record<string, unknown>): GoodsReceiptReceiveLocation | null {
  const quantity = Math.max(0, Number(raw.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const rackId = raw.rackId != null && String(raw.rackId).trim()
    ? String(raw.rackId).trim().toLowerCase()
    : '';
  const rowNumber = Number(raw.rowNumber);
  const binNumber = Number(raw.binNumber);
  if (rackId && Number.isFinite(rowNumber) && rowNumber >= 1 && Number.isFinite(binNumber) && binNumber >= 1) {
    return {
      quantity,
      rackId,
      rowNumber: Math.floor(rowNumber),
      binNumber: Math.floor(binNumber),
    };
  }
  const zoneId = raw.zoneId != null && String(raw.zoneId).trim()
    ? String(raw.zoneId).trim().toLowerCase()
    : '';
  const zoneRowNumber = Number(raw.zoneRowNumber);
  if (zoneId && Number.isFinite(zoneRowNumber) && zoneRowNumber >= 1) {
    return {
      quantity,
      zoneId,
      zoneRowNumber: Math.floor(zoneRowNumber),
    };
  }
  return null;
}

function emptyReceiveLine(receivedQty: number): GoodsReceiptReceiveLine {
  return {
    receivedQty,
    zoneId: null,
    zoneRowNumber: null,
    rackId: null,
    rowNumber: null,
    binNumber: null,
    locations: [],
  };
}

function receiveLineFromLocations(
  locations: GoodsReceiptReceiveLocation[],
  fallbackQty = 0,
): GoodsReceiptReceiveLine {
  const receivedQty = locations.length > 0
    ? locations.reduce((sum, loc) => sum + loc.quantity, 0)
    : fallbackQty;
  const firstHo = locations.find(isHeadOfficeReceiveLocation) ?? null;
  const firstCochin = locations.find(isCochinReceiveLocation) ?? null;
  return {
    receivedQty,
    zoneId: firstCochin?.zoneId ?? null,
    zoneRowNumber: firstCochin?.zoneRowNumber ?? null,
    rackId: firstHo?.rackId ?? null,
    rowNumber: firstHo?.rowNumber ?? null,
    binNumber: firstHo?.binNumber ?? null,
    locations,
  };
}

/** Normalize placements from a saved receive line (supports legacy single zone/row). */
export function receiveLineLocations(
  line: GoodsReceiptReceiveLine | null | undefined,
): GoodsReceiptReceiveLocation[] {
  if (!line) return [];
  if (Array.isArray(line.locations) && line.locations.length > 0) {
    return line.locations
      .map(loc => parseReceiveLocation(loc as unknown as Record<string, unknown>))
      .filter((loc): loc is GoodsReceiptReceiveLocation => Boolean(loc));
  }
  const legacy = parseReceiveLocation({
    quantity: Number(line.receivedQty),
    zoneId: line.zoneId,
    zoneRowNumber: line.zoneRowNumber,
    rackId: line.rackId,
    rowNumber: line.rowNumber,
    binNumber: line.binNumber,
  } as Record<string, unknown>);
  return legacy ? [legacy] : [];
}

export interface AdminGoodsReceiptsPageResult {
  rows: AdminFirestoreGoodsReceipt[];
  docs: QueryDocumentSnapshot<DocumentData>[];
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
}

export type AdminGoodsReceiptLocationCounts = {
  all: number;
  head_office: number;
  cochin: number;
};

export type AdminGoodsReceiptShipmentCounts = {
  all: number;
  in_transit: number;
  scheduled: number;
  received: number;
};

export const EMPTY_GOODS_RECEIPT_SHIPMENT_COUNTS: AdminGoodsReceiptShipmentCounts = {
  all: 0,
  in_transit: 0,
  scheduled: 0,
  received: 0,
};

function hasGoodsReceiptDate(value: unknown): boolean {
  return Boolean(String(value ?? '').trim());
}

function receiveCheckHasQty(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const data = raw as Record<string, unknown>;
  const byLineId = data.byLineId;
  if (byLineId && typeof byLineId === 'object') {
    if (Object.values(byLineId as Record<string, unknown>).some(qty => Number(qty) > 0)) {
      return true;
    }
  }
  const lines = data.lines;
  if (lines && typeof lines === 'object') {
    for (const value of Object.values(lines as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      if (Number((value as Record<string, unknown>).receivedQty) > 0) return true;
    }
  }
  return false;
}

export function isReceivedBillStatus(status: string | null | undefined): boolean {
  const key = String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return key === 'open' || key === 'paid' || key === 'partially_paid' || key === 'overdue';
}

export function goodsReceiptShipmentStage(
  row: Pick<
    AdminFirestoreGoodsReceipt,
    'sailedDate' | 'receivedDate' | 'opsReceivedAt' | 'status'
  >,
): GoodsReceiptShipmentStage {
  if (
    hasGoodsReceiptDate(row.opsReceivedAt)
    || hasGoodsReceiptDate(row.receivedDate)
    || isReceivedBillStatus(row.status)
  ) {
    return 'received';
  }
  if (hasGoodsReceiptDate(row.sailedDate)) return 'in_transit';
  return 'scheduled';
}

/** Software-only bills (Sanoft / software keys / software HSN) are not listed. */
export function isSoftwareExcludedGoodsReceipt(
  row: Pick<AdminFirestoreGoodsReceipt, 'goodsReceiptCategory' | 'categories'>,
): boolean {
  return isSoftwareOnlyInvoiceCategories(row.categories, row.goodsReceiptCategory);
}

function excludeSoftwareGoodsReceipts(
  rows: AdminFirestoreGoodsReceipt[],
): AdminFirestoreGoodsReceipt[] {
  return rows.filter(row => !isSoftwareExcludedGoodsReceipt(row));
}

export function countAdminGoodsReceiptsByShipment(
  rows: AdminFirestoreGoodsReceipt[],
): AdminGoodsReceiptShipmentCounts {
  const counts: AdminGoodsReceiptShipmentCounts = {
    all: rows.length,
    in_transit: 0,
    scheduled: 0,
    received: 0,
  };
  for (const row of rows) {
    counts[goodsReceiptShipmentStage(row)] += 1;
  }
  return counts;
}

export function parseGoodsReceiptLocation(value: unknown): GoodsReceiptLocation | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const s = raw.replace(/\s+/g, '_');
  if (s === 'head_office' || s === 'headoffice' || (raw.includes('head') && raw.includes('office'))) {
    return 'head_office';
  }
  if (s === 'cochin' || raw.includes('cochin') || raw.includes('kochi')) return 'cochin';
  return null;
}

export function goodsReceiptLocationLabel(
  site: GoodsReceiptLocation | null | undefined,
): string {
  if (site === 'head_office') return 'Head office';
  if (site === 'cochin') return 'Cochin';
  return '—';
}

/** Zoho draft → Scheduled; open/paid after receive → Received. */
export function goodsReceiptStatusLabel(status: string): string {
  const key = String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (key === 'draft' || key === 'pending' || key === 'pending_approval') return 'Scheduled';
  if (isReceivedBillStatus(key)) return 'Received';
  if (!key) return '—';
  return key.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

export function goodsReceiptStatusClass(status: string): string {
  const label = goodsReceiptStatusLabel(status);
  const key = label === 'Scheduled'
    ? 'scheduled'
    : label === 'Received'
      ? 'received'
      : String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return `invoices-status invoices-status--${key || 'draft'}`;
}

function timestampToIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function mapLineItem(raw: Record<string, unknown>): DealerInvoiceLineItem {
  return {
    id: String(raw.id ?? ''),
    itemId: raw.itemId ? String(raw.itemId) : null,
    name: String(raw.name ?? 'Item'),
    description: raw.description ? String(raw.description) : null,
    sku: raw.sku ? String(raw.sku) : null,
    quantity: Number(raw.quantity ?? 0),
    rate: Number(raw.rate ?? 0),
    total: Number(raw.total ?? 0),
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : null,
    hsn: raw.hsn != null && String(raw.hsn).trim() ? String(raw.hsn) : null,
  };
}

export function mapAdminGoodsReceiptDoc(
  docSnap: QueryDocumentSnapshot<DocumentData>,
): AdminFirestoreGoodsReceipt {
  const data = docSnap.data();
  const lineItems = Array.isArray(data.lineItems)
    ? data.lineItems.map(item => mapLineItem(item as Record<string, unknown>))
    : [];
  return {
    id: docSnap.id,
    billNumber: String(data.billNumber ?? ''),
    vendorId: String(data.vendorId ?? ''),
    vendorName: data.vendorName ? String(data.vendorName) : null,
    date: data.date ? String(data.date) : null,
    createdTime: firstDateTimeValue(
      timestampToIso(data.createdTime),
      timestampToIso(data.zohoCreatedTime),
      timestampToIso(data.zohoLastModified),
    ),
    dueDate: data.dueDate ? String(data.dueDate) : null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    currencyCode: data.currencyCode ? String(data.currencyCode).toUpperCase() : 'INR',
    referenceNumber: data.referenceNumber ? String(data.referenceNumber) : null,
    syncedAt: timestampToIso(data.syncedAt),
    itemQuantity: lineItems.length
      ? sumInvoiceProductQuantity(lineItems)
      : (data.itemQuantity != null ? Number(data.itemQuantity) : null),
    itemVariantCount: lineItems.length
      ? lineItems.filter(line => !isFreightProductId(line.itemId) && !isFreightSku(line.sku)).length
      : (data.itemVariantCount != null && Number.isFinite(Number(data.itemVariantCount))
        ? Number(data.itemVariantCount)
        : null),
    locationId: data.locationId != null ? String(data.locationId) : null,
    locationName: data.locationName ? String(data.locationName) : null,
    inventorySite: parseGoodsReceiptLocation(data.inventorySite)
      ?? parseGoodsReceiptLocation(data.branchName)
      ?? parseGoodsReceiptLocation(data.locationName),
    goodsReceiptCategory: parseInvoiceCategory(data.goodsReceiptCategory),
    categories: normalizeInvoiceCategories(data.categories),
    categoryAmounts: normalizeInvoiceCategoryAmounts(data.categoryAmounts),
    sailedDate: data.sailedDate ? String(data.sailedDate) : null,
    receivedDate: data.receivedDate ? String(data.receivedDate) : null,
    opsReceivedAt: timestampToIso(data.opsReceivedAt),
    opsReceivedByName: data.opsReceivedByName ? String(data.opsReceivedByName) : null,
    receiveChecked: receiveCheckHasQty(data.receiveCheck),
  };
}

/** Format a Date as local YYYY-MM-DD for Firestore string date fields. */
export function toGoodsReceiptDateKey(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildAdminGoodsReceiptsQuery(options: AdminGoodsReceiptListQuery) {
  const sort = options.sort ?? 'date';
  const pageSize = Math.max(1, Math.min(Number(options.pageSize ?? 25) || 25, 100));
  const location = options.location ?? 'all';
  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const constraints: QueryConstraint[] = [];

  if (location && location !== 'all') {
    constraints.push(where('inventorySite', '==', location));
  }

  if (dateStart || dateEnd) {
    if (dateStart) constraints.push(where('date', '>=', dateStart));
    if (dateEnd) constraints.push(where('date', '<=', dateEnd));
    constraints.push(orderBy('date', 'desc'));
  } else {
    const field = sort === 'syncedAt' ? 'syncedAt' : 'date';
    constraints.push(orderBy(field, 'desc'));
  }

  if (options.cursor) constraints.push(startAfter(options.cursor));
  constraints.push(limit(pageSize));

  return query(collection(db, 'goodsReceipts'), ...constraints);
}

/** @deprecated Prefer buildAdminGoodsReceiptsQuery(options). */
export function buildAdminGoodsReceiptsQueryLegacy(
  sort: AdminGoodsReceiptSort,
  pageSize: number,
  cursor?: QueryDocumentSnapshot<DocumentData> | null,
  location: GoodsReceiptLocationFilter = 'all',
) {
  return buildAdminGoodsReceiptsQuery({ sort, pageSize, cursor, location });
}

export function subscribeAdminGoodsReceipts(
  sort: AdminGoodsReceiptSort,
  pageSize: number,
  onData: (rows: AdminFirestoreGoodsReceipt[]) => void,
  onError: (message: string) => void,
  location: GoodsReceiptLocationFilter = 'all',
) {
  const q = buildAdminGoodsReceiptsQuery({ sort, pageSize, cursor: null, location });
  return onSnapshot(
    q,
    snap => {
      onData(excludeSoftwareGoodsReceipts(snap.docs.map(mapAdminGoodsReceiptDoc)));
    },
    err => {
      onError(err.message || 'Could not load goods receipts from Firestore.');
    },
  );
}

export async function fetchAdminGoodsReceiptsPageDetailed(
  options: AdminGoodsReceiptListQuery,
): Promise<AdminGoodsReceiptsPageResult> {
  const snap = await getDocs(buildAdminGoodsReceiptsQuery(options));
  return {
    rows: excludeSoftwareGoodsReceipts(snap.docs.map(mapAdminGoodsReceiptDoc)),
    docs: snap.docs,
    lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
  };
}

export async function fetchAdminGoodsReceiptsPage(
  sortOrOptions: AdminGoodsReceiptSort | AdminGoodsReceiptListQuery,
  pageSize?: number,
  cursor?: QueryDocumentSnapshot<DocumentData> | null,
  location: GoodsReceiptLocationFilter = 'all',
): Promise<AdminFirestoreGoodsReceipt[]> {
  const options: AdminGoodsReceiptListQuery = typeof sortOrOptions === 'string'
    ? { sort: sortOrOptions, pageSize, cursor, location }
    : sortOrOptions;
  const result = await fetchAdminGoodsReceiptsPageDetailed(options);
  return result.rows;
}

export async function countAdminGoodsReceipts(
  options: Omit<AdminGoodsReceiptListQuery, 'pageSize' | 'cursor'>,
): Promise<number> {
  const sort = options.sort ?? 'date';
  const location = options.location ?? 'all';
  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const constraints: QueryConstraint[] = [];

  if (location && location !== 'all') {
    constraints.push(where('inventorySite', '==', location));
  }
  if (dateStart || dateEnd) {
    if (dateStart) constraints.push(where('date', '>=', dateStart));
    if (dateEnd) constraints.push(where('date', '<=', dateEnd));
    constraints.push(orderBy('date', 'desc'));
  } else if (sort === 'syncedAt') {
    constraints.push(orderBy('syncedAt', 'desc'));
  } else {
    constraints.push(orderBy('date', 'desc'));
  }

  const snap = await getCountFromServer(query(collection(db, 'goodsReceipts'), ...constraints));
  return snap.data().count;
}

export async function countAdminGoodsReceiptsByLocation(options: {
  dateStart?: string | null;
  dateEnd?: string | null;
}): Promise<AdminGoodsReceiptLocationCounts> {
  const { rows } = await fetchAllAdminGoodsReceiptsInRange({
    location: 'all',
    dateStart: options.dateStart ?? null,
    dateEnd: options.dateEnd ?? null,
  });
  return {
    all: rows.length,
    head_office: rows.filter(row => row.inventorySite === 'head_office').length,
    cochin: rows.filter(row => row.inventorySite === 'cochin').length,
  };
}

export async function fetchAllAdminGoodsReceiptsInRange(options: {
  sort?: AdminGoodsReceiptSort;
  location?: GoodsReceiptLocationFilter;
  dateStart?: string | null;
  dateEnd?: string | null;
  maxRows?: number;
}): Promise<{ rows: AdminFirestoreGoodsReceipt[]; truncated: boolean }> {
  const maxRows = options.maxRows ?? ADMIN_GR_AGGREGATE_MAX_ROWS;
  const rows: AdminFirestoreGoodsReceipt[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let truncated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await fetchAdminGoodsReceiptsPageDetailed({
      sort: options.sort ?? 'date',
      pageSize: ADMIN_GR_PAGE_SIZE,
      cursor,
      location: options.location ?? 'all',
      dateStart: options.dateStart,
      dateEnd: options.dateEnd,
    });
    if (!result.docs.length) break;
    rows.push(...result.rows);
    cursor = result.lastDoc;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (result.docs.length < ADMIN_GR_PAGE_SIZE) break;
  }

  return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}

export function filterAdminGoodsReceipts(
  rows: AdminFirestoreGoodsReceipt[],
  searchText: string,
  location: GoodsReceiptLocationFilter = 'all',
  shipment: GoodsReceiptShipmentFilter = 'all',
): AdminFirestoreGoodsReceipt[] {
  let next = excludeSoftwareGoodsReceipts(rows);
  if (location && location !== 'all') {
    next = next.filter(row => row.inventorySite === location);
  }
  if (shipment && shipment !== 'all') {
    next = next.filter(row => goodsReceiptShipmentStage(row) === shipment);
  }
  const needle = searchText.trim().toLowerCase();
  if (!needle) return next;
  return next.filter(row => {
    const haystack = [
      row.billNumber,
      row.vendorName,
      row.vendorId,
      row.referenceNumber,
      row.id,
      row.status,
      row.locationName,
      row.inventorySite,
      goodsReceiptLocationLabel(row.inventorySite),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function goodsReceiptReceivedMs(row: AdminFirestoreGoodsReceipt): number {
  const raw = row.opsReceivedAt || row.receivedDate;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Latest received first; bills with no receive time stay below. */
export function sortAdminGoodsReceiptsByReceived(
  rows: AdminFirestoreGoodsReceipt[],
): AdminFirestoreGoodsReceipt[] {
  return [...rows].sort((a, b) => {
    const receivedDelta = goodsReceiptReceivedMs(b) - goodsReceiptReceivedMs(a);
    if (receivedDelta !== 0) return receivedDelta;
    return String(b.date ?? '').localeCompare(String(a.date ?? ''));
  });
}

function parsePoDay(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? NaN : ts;
}

export function filterAdminGoodsReceiptsByPeriod(
  rows: AdminFirestoreGoodsReceipt[],
  period: KpiPeriod,
): AdminFirestoreGoodsReceipt[] {
  const bounds = getInvoicePeriodBounds(period);
  if (!bounds) return rows;
  return rows.filter(row => {
    if (!row.date) return false;
    const ts = parsePoDay(row.date);
    if (Number.isNaN(ts)) return false;
    return ts >= bounds.start.getTime() && ts <= bounds.end.getTime();
  });
}

export function buildAdminGoodsReceiptSalesEntries(
  rows: AdminFirestoreGoodsReceipt[],
): InvoiceSalesEntry[] {
  return rows
    .filter(row => row.date)
    .map(row => ({ date: row.date!, total: row.total }));
}

function mapReceiveLineMap(raw: unknown): {
  lines: Record<string, GoodsReceiptReceiveLine>;
  byLineId: Record<string, number>;
} {
  const lines: Record<string, GoodsReceiptReceiveLine> = {};
  const byLineId: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return { lines, byLineId };

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const qty = Number(row.receivedQty);
    if (!Number.isFinite(qty)) continue;
    const locationsRaw = Array.isArray(row.locations) ? row.locations : [];
    const locations: GoodsReceiptReceiveLocation[] = locationsRaw
      .filter((loc): loc is Record<string, unknown> => Boolean(loc) && typeof loc === 'object')
      .map(loc => parseReceiveLocation(loc))
      .filter((loc): loc is GoodsReceiptReceiveLocation => Boolean(loc));
    const legacy = locations.length > 0
      ? null
      : parseReceiveLocation({
        quantity: qty,
        zoneId: row.zoneId,
        zoneRowNumber: row.zoneRowNumber,
        rackId: row.rackId,
        rowNumber: row.rowNumber,
        binNumber: row.binNumber,
      });
    const normalizedLocations = locations.length > 0
      ? locations
      : (legacy ? [legacy] : []);
    lines[key] = receiveLineFromLocations(normalizedLocations, qty);
    byLineId[key] = lines[key].receivedQty;
  }
  return { lines, byLineId };
}

function resolvePostedLines(previous: GoodsReceiptReceiveCheck | null): Record<string, GoodsReceiptReceiveLine> {
  if (!previous) return {};
  if (previous.hasPostedSnapshot) return previous.postedLines;
  return previous.lines;
}

function mapReceiveCheck(raw: unknown): GoodsReceiptReceiveCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const mapped = mapReceiveLineMap(data.lines);
  const lines = mapped.lines;
  const byLineId = { ...mapped.byLineId };

  const byLineRaw = data.byLineId;
  if (byLineRaw && typeof byLineRaw === 'object') {
    for (const [key, value] of Object.entries(byLineRaw as Record<string, unknown>)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      byLineId[key] = n;
      if (!lines[key]) {
        lines[key] = emptyReceiveLine(n);
      }
    }
  }

  const hasPostedSnapshot = Object.prototype.hasOwnProperty.call(data, 'postedLines');
  const postedLines = hasPostedSnapshot
    ? mapReceiveLineMap(data.postedLines).lines
    : { ...lines };

  return {
    lines,
    byLineId,
    postedLines,
    hasPostedSnapshot,
    postedAt: timestampToIso(data.postedAt),
    postedByUid: data.postedByUid != null ? String(data.postedByUid) : null,
    postedByName: data.postedByName != null ? String(data.postedByName) : null,
    hiddenLineIds: Array.isArray(data.hiddenLineIds)
      ? data.hiddenLineIds.map(id => String(id || '').trim()).filter(Boolean)
      : [],
    updatedAt: timestampToIso(data.updatedAt),
    updatedByUid: data.updatedByUid != null ? String(data.updatedByUid) : null,
    updatedByName: data.updatedByName != null ? String(data.updatedByName) : null,
  };
}

export function mapAdminGoodsReceiptDetail(
  poId: string,
  data: DocumentData,
): AdminGoodsReceiptDetail {
  return {
    id: String(data.id ?? poId),
    billNumber: String(data.billNumber ?? ''),
    date: data.date ? String(data.date) : null,
    dueDate: data.dueDate ? String(data.dueDate) : null,
    poDate: data.poDate ? String(data.poDate) : null,
    sailedDate: data.sailedDate ? String(data.sailedDate) : null,
    receivedDate: data.receivedDate ? String(data.receivedDate) : null,
    opsReceivedAt: timestampToIso(data.opsReceivedAt),
    opsReceivedByUid: data.opsReceivedByUid != null ? String(data.opsReceivedByUid) : null,
    opsReceivedByName: data.opsReceivedByName ? String(data.opsReceivedByName) : null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    referenceNumber: data.referenceNumber ? String(data.referenceNumber) : null,
    purchaseOrderNumber: data.purchaseOrderNumber
      ? String(data.purchaseOrderNumber)
      : (data.referenceNumber ? String(data.referenceNumber) : null),
    currencyCode: data.currencyCode ? String(data.currencyCode).toUpperCase() : 'INR',
    vendorId: String(data.vendorId ?? ''),
    vendorName: data.vendorName ? String(data.vendorName) : null,
    vendorState: data.vendorState ? String(data.vendorState) : null,
    vendorCountry: data.vendorCountry ? String(data.vendorCountry) : null,
    vendorCity: data.vendorCity ? String(data.vendorCity) : null,
    locationId: data.locationId != null ? String(data.locationId) : null,
    locationName: data.locationName ? String(data.locationName) : null,
    inventorySite: parseGoodsReceiptLocation(data.inventorySite)
      ?? parseGoodsReceiptLocation(data.branchName)
      ?? parseGoodsReceiptLocation(data.locationName),
    goodsReceiptCategory: parseInvoiceCategory(data.goodsReceiptCategory),
    categories: normalizeInvoiceCategories(data.categories),
    categoryAmounts: normalizeInvoiceCategoryAmounts(data.categoryAmounts),
    subtotal: Number(data.subtotal ?? 0),
    taxTotal: Number(data.taxTotal ?? 0),
    notes: data.notes ? String(data.notes) : null,
    lineItems: Array.isArray(data.lineItems)
      ? data.lineItems.map(item => mapLineItem(item as Record<string, unknown>))
      : [],
    receiveCheck: mapReceiveCheck(data.receiveCheck),
    serialRangesByLineId: parsePurchaseOrderSerialRanges(data.serialRangesByLineId),
  };
}

async function lookupPurchaseOrderDate(poNumber: string): Promise<string | null> {
  const number = poNumber.trim();
  if (!number) return null;
  const snap = await getDocs(query(
    collection(db, 'purchaseOrders'),
    where('purchaseOrderNumber', '==', number),
    limit(1),
  ));
  if (snap.empty) return null;
  const date = snap.docs[0].data()?.date;
  return date ? String(date) : null;
}

export async function fetchAdminGoodsReceiptDetail(
  goodsReceiptId: string,
): Promise<AdminGoodsReceiptDetail> {
  const snap = await getDoc(doc(db, 'goodsReceipts', goodsReceiptId));
  if (!snap.exists()) {
    throw new Error('Goods receipt not found.');
  }
  const detail = mapAdminGoodsReceiptDetail(goodsReceiptId, snap.data());
  if (isSoftwareExcludedGoodsReceipt(detail)) {
    throw new Error('Goods receipt not found.');
  }
  const [withImages, poDate] = await Promise.all([
    enrichInvoiceDetailImages({
      ...detail,
      invoiceNumber: detail.billNumber,
      dueDate: detail.dueDate,
      lastPaymentDate: null,
      customerName: detail.vendorName,
      invoiceUrl: null,
      salesOrderId: null,
      salesOrderNumber: null,
    }),
    detail.referenceNumber
      ? lookupPurchaseOrderDate(detail.referenceNumber).catch(() => detail.poDate)
      : Promise.resolve(detail.poDate),
  ]);
  return {
    ...detail,
    poDate,
    lineItems: withImages.lineItems,
  };
}

type GoodsReceiptReceiveLineInput = {
  locations: GoodsReceiptReceiveLocation[];
};

function normalizeReceiveLines(
  inputLines: Record<string, GoodsReceiptReceiveLineInput>,
): { lines: Record<string, GoodsReceiptReceiveLine>; byLineId: Record<string, number> } {
  const lines: Record<string, GoodsReceiptReceiveLine> = {};
  const byLineId: Record<string, number> = {};
  for (const [lineId, value] of Object.entries(inputLines)) {
    const key = String(lineId || '').trim();
    if (!key) continue;
    const locations: GoodsReceiptReceiveLocation[] = [];
    for (const loc of value.locations ?? []) {
      const quantity = Number(loc.quantity);
      const rackId = String(loc.rackId ?? '').trim().toLowerCase();
      const rowNumber = Number(loc.rowNumber);
      const binNumber = Number(loc.binNumber);
      const zoneId = String(loc.zoneId ?? '').trim().toLowerCase();
      const zoneRowNumber = Number(loc.zoneRowNumber);
      const hasHo = Boolean(rackId || Number.isFinite(rowNumber) || Number.isFinite(binNumber));
      const hasCochin = Boolean(zoneId || Number.isFinite(zoneRowNumber));
      if (!hasHo && !hasCochin && !(Number.isFinite(quantity) && quantity > 0)) {
        continue;
      }
      if (hasHo) {
        if (!rackId || !Number.isFinite(rowNumber) || rowNumber < 1 || !Number.isFinite(binNumber) || binNumber < 1) {
          throw new Error('Each Head Office location needs a rack, row, and bin.');
        }
      } else if (!zoneId || !Number.isFinite(zoneRowNumber) || zoneRowNumber < 1) {
        throw new Error('Each warehouse location needs a zone and row.');
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new Error('Location qty must be a non-negative number.');
      }
      if (quantity <= 0) continue;
      if (hasHo) {
        locations.push({
          rackId,
          rowNumber: Math.floor(rowNumber),
          binNumber: Math.floor(binNumber),
          quantity: Math.floor(quantity),
        });
      } else {
        locations.push({
          zoneId,
          zoneRowNumber: Math.max(1, Math.floor(zoneRowNumber)),
          quantity: Math.floor(quantity),
        });
      }
    }
    const merged = new Map<string, GoodsReceiptReceiveLocation>();
    for (const loc of locations) {
      const mergeKey = receiveLocationKey(loc);
      const existing = merged.get(mergeKey);
      if (existing) existing.quantity += loc.quantity;
      else merged.set(mergeKey, { ...loc });
    }
    const normalizedLocations = [...merged.values()];
    const next = receiveLineFromLocations(normalizedLocations);
    lines[key] = next;
    byLineId[key] = next.receivedQty;
  }
  return { lines, byLineId };
}

function receiveLineHasPlacement(line: GoodsReceiptReceiveLine | null | undefined): boolean {
  return receiveLineLocations(line).some(loc => loc.quantity > 0);
}

function receivePlacementsEqual(
  a: GoodsReceiptReceiveLocation[],
  b: GoodsReceiptReceiveLocation[],
): boolean {
  const tally = new Map<string, number>();
  for (const loc of a) {
    const key = receiveLocationKey(loc);
    tally.set(key, (tally.get(key) ?? 0) + loc.quantity);
  }
  for (const loc of b) {
    const key = receiveLocationKey(loc);
    const next = (tally.get(key) ?? 0) - loc.quantity;
    if (next === 0) tally.delete(key);
    else tally.set(key, next);
  }
  return tally.size === 0;
}

function lineQty(line: DealerInvoiceLineItem): number {
  const n = Number(line.quantity);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isFreightGoodsReceiptLine(line: DealerInvoiceLineItem): boolean {
  return isFreightProductId(line.itemId) || isFreightSku(line.sku);
}

function zohoInboundQtyForProduct(
  lineItems: DealerInvoiceLineItem[],
  catalogProductId: string,
): number {
  return lineItems.reduce((sum, line) => {
    if (isFreightGoodsReceiptLine(line)) return sum;
    if ((line.itemId?.trim() || null) !== catalogProductId) return sum;
    return sum + lineQty(line);
  }, 0);
}

function placedQtyForProduct(
  lines: Record<string, GoodsReceiptReceiveLine>,
  itemIdByLineId: Map<string, string | null>,
  catalogProductId: string,
): number {
  let total = 0;
  for (const [lineId, line] of Object.entries(lines)) {
    if (itemIdByLineId.get(lineId) !== catalogProductId) continue;
    total += receiveLineLocations(line).reduce((sum, loc) => sum + loc.quantity, 0);
  }
  return total;
}

function toClientReceiveCheck(
  fields: {
    lines: Record<string, GoodsReceiptReceiveLine>;
    byLineId: Record<string, number>;
    postedLines: Record<string, GoodsReceiptReceiveLine>;
    postedAt: string | null;
    postedByUid: string | null;
    postedByName: string | null;
    hiddenLineIds: string[];
  },
  actor: { uid: string; displayName?: string | null },
): GoodsReceiptReceiveCheck {
  return {
    ...fields,
    hasPostedSnapshot: true,
    updatedAt: new Date().toISOString(),
    updatedByUid: actor.uid,
    updatedByName: actor.displayName?.trim() || null,
  };
}

/**
 * Persist receive placements on the goods receipt.
 * `draft` stores entries on the bill only.
 * `post` applies Cochin and/or Head Office stock + product audit (delta vs last posted snapshot).
 * Historical zone/row placements are left as-is; they are not rewritten to rack/bin.
 */
export async function saveGoodsReceiptReceiveCheck(
  goodsReceiptId: string,
  input: {
    lines: Record<string, GoodsReceiptReceiveLineInput>;
    lineItems: DealerInvoiceLineItem[];
    previous: GoodsReceiptReceiveCheck | null;
    mode: 'draft' | 'post';
    auditedAt?: string | null;
    zohoAlreadyIncludesInbound?: boolean;
  },
  actor: { uid: string; displayName?: string | null },
): Promise<GoodsReceiptReceiveCheck> {
  const id = String(goodsReceiptId || '').trim();
  if (!id) throw new Error('Goods receipt id is required.');

  const { lines, byLineId } = normalizeReceiveLines(input.lines);
  const postedLines = resolvePostedLines(input.previous);
  const previousHidden = input.previous?.hiddenLineIds ?? [];
  const hiddenLineIds = [...new Set(
    previousHidden.map(hiddenId => String(hiddenId || '').trim()).filter(Boolean),
  )];

  for (const lineId of hiddenLineIds) {
    delete lines[lineId];
    delete byLineId[lineId];
  }

  const nextPostedLines = input.mode === 'post' ? { ...lines } : postedLines;
  const postedAtIso = input.mode === 'post'
    ? (input.auditedAt?.trim() || new Date().toISOString())
    : (input.previous?.postedAt ?? null);
  const postedByUid = input.mode === 'post'
    ? actor.uid
    : (input.previous?.postedByUid ?? null);
  const postedByName = input.mode === 'post'
    ? (actor.displayName?.trim() || null)
    : (input.previous?.postedByName ?? null);

  const itemIdByLineId = new Map(
    input.lineItems
      .filter(line => line.id)
      .map(line => [line.id, line.itemId?.trim() || null] as const),
  );

  const placementLineIds = new Set<string>([
    ...Object.keys(lines).filter(lineId => receiveLineHasPlacement(lines[lineId])),
    ...Object.keys(postedLines).filter(lineId => receiveLineHasPlacement(postedLines[lineId])),
  ]);

  const changedLineIds = [...placementLineIds].filter(lineId => (
    !receivePlacementsEqual(
      receiveLineLocations(postedLines[lineId]),
      receiveLineLocations(lines[lineId]),
    )
  ));

  const cochinDeltasByProduct = new Map<string, Array<{
    zoneId: string;
    zoneRowNumber: number;
    quantityDelta: number;
  }>>();
  const headOfficeDeltasByProduct = new Map<string, Array<{
    rackId: string;
    rowNumber: number;
    binNumber: number;
    quantityDelta: number;
  }>>();
  let cochinCycleId: string | null = null;
  let headOfficeCycleId: string | null = null;

  if (input.mode === 'post' && changedLineIds.length > 0) {
    const changedLocs = changedLineIds.flatMap(lineId => [
      ...receiveLineLocations(postedLines[lineId]),
      ...receiveLineLocations(lines[lineId]),
    ]);
    const needsCochin = changedLocs.some(isCochinReceiveLocation);
    const needsHeadOffice = changedLocs.some(isHeadOfficeReceiveLocation);

    if (needsCochin) {
      const openCycle = await getOpenAuditCycle('cochin');
      if (!openCycle?.id) {
        throw new Error('No open audit cycle for Cochin. Counting is locked — open a cycle to place stock.');
      }
      cochinCycleId = openCycle.id;
    }
    if (needsHeadOffice) {
      const openCycle = await getOpenAuditCycle('head_office');
      if (!openCycle?.id) {
        throw new Error('No open audit cycle for Head Office. Counting is locked — open a cycle to place stock.');
      }
      headOfficeCycleId = openCycle.id;
    }

    for (const lineId of changedLineIds) {
      const itemId = itemIdByLineId.get(lineId);
      const lineName = input.lineItems.find(l => l.id === lineId)?.name ?? lineId;
      const needsForward = receiveLineHasPlacement(lines[lineId]);
      if (!itemId) {
        if (needsForward) {
          throw new Error(`No catalog product linked for ${lineName} — cannot place stock.`);
        }
        continue;
      }
      const productSnap = await getDoc(doc(db, 'catalogProducts', itemId));
      if (!productSnap.exists() && needsForward) {
        throw new Error(`Catalog product not found for ${lineName}.`);
      }
    }

    const ensureCochinDeltas = (catalogProductId: string) => {
      let deltas = cochinDeltasByProduct.get(catalogProductId);
      if (deltas) return deltas;
      deltas = [];
      cochinDeltasByProduct.set(catalogProductId, deltas);
      return deltas;
    };
    const ensureHeadOfficeDeltas = (catalogProductId: string) => {
      let deltas = headOfficeDeltasByProduct.get(catalogProductId);
      if (deltas) return deltas;
      deltas = [];
      headOfficeDeltasByProduct.set(catalogProductId, deltas);
      return deltas;
    };

    for (const lineId of changedLineIds) {
      const catalogProductId = itemIdByLineId.get(lineId);
      if (!catalogProductId) continue;
      const prevLocs = receiveLineLocations(postedLines[lineId]);
      const nextLocs = receiveLineLocations(lines[lineId]);
      const pushLoc = (loc: GoodsReceiptReceiveLocation, sign: 1 | -1) => {
        if (isHeadOfficeReceiveLocation(loc) && loc.rackId && loc.rowNumber != null && loc.binNumber != null) {
          ensureHeadOfficeDeltas(catalogProductId).push({
            rackId: loc.rackId,
            rowNumber: loc.rowNumber,
            binNumber: loc.binNumber,
            quantityDelta: sign * loc.quantity,
          });
          return;
        }
        if (isCochinReceiveLocation(loc) && loc.zoneId && loc.zoneRowNumber != null) {
          ensureCochinDeltas(catalogProductId).push({
            zoneId: loc.zoneId,
            zoneRowNumber: loc.zoneRowNumber,
            quantityDelta: sign * loc.quantity,
          });
        }
      };
      for (const loc of prevLocs) pushLoc(loc, -1);
      for (const loc of nextLocs) pushLoc(loc, 1);
    }
  }

  const receiveCheck = {
    lines,
    byLineId,
    postedLines: nextPostedLines,
    postedAt: input.mode === 'post'
      ? (input.auditedAt?.trim() ? new Date(input.auditedAt) : serverTimestamp())
      : (input.previous?.postedAt ?? null),
    postedByUid,
    postedByName,
    hiddenLineIds,
    updatedAt: serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByName: actor.displayName?.trim() || null,
  };

  try {
    await updateDoc(doc(db, 'goodsReceipts', id), { receiveCheck });
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }

  const productsToAuditCochin = new Set<string>(cochinDeltasByProduct.keys());
  const productsToAuditHeadOffice = new Set<string>(headOfficeDeltasByProduct.keys());
  if (input.mode === 'post' && input.auditedAt) {
    for (const [lineId, line] of Object.entries(lines)) {
      if (!receiveLineHasPlacement(line)) continue;
      const catalogProductId = itemIdByLineId.get(lineId);
      if (!catalogProductId) continue;
      const locs = receiveLineLocations(line);
      if (locs.some(isCochinReceiveLocation)) productsToAuditCochin.add(catalogProductId);
      if (locs.some(isHeadOfficeReceiveLocation)) productsToAuditHeadOffice.add(catalogProductId);
    }
  }

  if (input.mode === 'post' && productsToAuditCochin.size > 0 && !cochinCycleId) {
    const openCycle = await getOpenAuditCycle('cochin');
    if (!openCycle?.id) {
      throw new Error('No open audit cycle for Cochin. Counting is locked — open a cycle to place stock.');
    }
    cochinCycleId = openCycle.id;
  }
  if (input.mode === 'post' && productsToAuditHeadOffice.size > 0 && !headOfficeCycleId) {
    const openCycle = await getOpenAuditCycle('head_office');
    if (!openCycle?.id) {
      throw new Error('No open audit cycle for Head Office. Counting is locked — open a cycle to place stock.');
    }
    headOfficeCycleId = openCycle.id;
  }

  const inboundAlreadyInZoho = Boolean(input.zohoAlreadyIncludesInbound);
  const auditedProducts = new Set<string>();
  const productMeta = (catalogProductId: string) => {
    const line = input.lineItems.find(item => (item.itemId?.trim() || null) === catalogProductId);
    return {
      name: line?.name?.trim() || catalogProductId,
      sku: line?.sku?.trim() || null,
    };
  };
  try {
    for (const [catalogProductId, deltas] of cochinDeltasByProduct) {
      await applyCatalogSiteInventoryDeltas({
        catalogProductId,
        site: 'cochin',
        deltas,
        updatedByUid: actor.uid,
        updatedByName: actor.displayName,
      });
    }
    for (const [catalogProductId, deltas] of headOfficeDeltasByProduct) {
      const meta = productMeta(catalogProductId);
      await applyYesStoreInboundDeltas({
        catalogProductId,
        productName: meta.name,
        productSku: meta.sku,
        deltas,
        actor,
      });
    }
    for (const catalogProductId of productsToAuditCochin) {
      if (!cochinCycleId) continue;
      await recordCatalogProductAudit(
        catalogProductId,
        'cochin_inventory',
        cochinCycleId,
        {
          auditedAt: input.auditedAt ?? null,
          incomingZohoQty: zohoInboundQtyForProduct(input.lineItems, catalogProductId),
          cochinInboundQty: placedQtyForProduct(lines, itemIdByLineId, catalogProductId),
          inboundQty: placedQtyForProduct(lines, itemIdByLineId, catalogProductId),
          sourceGoodsReceiptId: id,
          inboundAlreadyInZoho,
        },
      );
      auditedProducts.add(catalogProductId);
    }
    for (const catalogProductId of productsToAuditHeadOffice) {
      if (!headOfficeCycleId) continue;
      await recordCatalogProductAudit(
        catalogProductId,
        'warehouse_count',
        headOfficeCycleId,
        {
          auditedAt: input.auditedAt ?? null,
          incomingZohoQty: zohoInboundQtyForProduct(input.lineItems, catalogProductId),
          inboundQty: placedQtyForProduct(lines, itemIdByLineId, catalogProductId),
          sourceGoodsReceiptId: id,
          inboundAlreadyInZoho,
        },
      );
      auditedProducts.add(catalogProductId);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(
      `Placements saved, but warehouse / audit update failed (${auditedProducts.size} product(s) audited): ${detail}`,
    );
  }

  return toClientReceiveCheck({
    lines,
    byLineId,
    postedLines: nextPostedLines,
    postedAt: postedAtIso,
    postedByUid,
    postedByName,
    hiddenLineIds,
  }, actor);
}

/**
 * Super-admin: hide/unhide a bill line from the receive UI.
 * Hiding clears draft placements; posted stock is reversed only if that line was posted.
 */
export async function setGoodsReceiptLineHidden(
  goodsReceiptId: string,
  lineId: string,
  hidden: boolean,
  options: {
    lineItems: DealerInvoiceLineItem[];
    previous: GoodsReceiptReceiveCheck | null;
  },
  actor: { uid: string; displayName?: string | null },
): Promise<GoodsReceiptReceiveCheck> {
  const id = String(goodsReceiptId || '').trim();
  const targetLineId = String(lineId || '').trim();
  if (!id) throw new Error('Goods receipt id is required.');
  if (!targetLineId) throw new Error('Line id is required.');

  const previous = options.previous;
  const previousLines = previous?.lines ?? {};
  const previousByLineId = { ...(previous?.byLineId ?? {}) };
  const nextLines: Record<string, GoodsReceiptReceiveLine> = { ...previousLines };
  const nextByLineId: Record<string, number> = { ...previousByLineId };
  const nextPostedLines: Record<string, GoodsReceiptReceiveLine> = {
    ...resolvePostedLines(previous),
  };
  const hiddenSet = new Set(
    (previous?.hiddenLineIds ?? []).map(v => String(v || '').trim()).filter(Boolean),
  );

  if (hidden) hiddenSet.add(targetLineId);
  else hiddenSet.delete(targetLineId);

  const postedLocs = hidden ? receiveLineLocations(nextPostedLines[targetLineId]) : [];
  if (hidden) {
    delete nextLines[targetLineId];
    delete nextByLineId[targetLineId];
    delete nextPostedLines[targetLineId];
  }

  let cochinCycleId: string | null = null;
  let headOfficeCycleId: string | null = null;
  let reverseProductId: string | null = null;
  const cochinReverseDeltas: Array<{ zoneId: string; zoneRowNumber: number; quantityDelta: number }> = [];
  const headOfficeReverseDeltas: Array<{
    rackId: string;
    rowNumber: number;
    binNumber: number;
    quantityDelta: number;
  }> = [];
  if (postedLocs.length > 0) {
    const line = options.lineItems.find(l => l.id === targetLineId);
    reverseProductId = line?.itemId?.trim() || null;
    if (reverseProductId) {
      for (const loc of postedLocs) {
        if (isHeadOfficeReceiveLocation(loc) && loc.rackId && loc.rowNumber != null && loc.binNumber != null) {
          headOfficeReverseDeltas.push({
            rackId: loc.rackId,
            rowNumber: loc.rowNumber,
            binNumber: loc.binNumber,
            quantityDelta: -loc.quantity,
          });
        } else if (isCochinReceiveLocation(loc) && loc.zoneId && loc.zoneRowNumber != null) {
          cochinReverseDeltas.push({
            zoneId: loc.zoneId,
            zoneRowNumber: loc.zoneRowNumber,
            quantityDelta: -loc.quantity,
          });
        }
      }
      if (cochinReverseDeltas.length > 0) {
        const openCycle = await getOpenAuditCycle('cochin');
        if (!openCycle?.id) {
          throw new Error('No open audit cycle for Cochin. Counting is locked — open a cycle to update stock.');
        }
        cochinCycleId = openCycle.id;
      }
      if (headOfficeReverseDeltas.length > 0) {
        const openCycle = await getOpenAuditCycle('head_office');
        if (!openCycle?.id) {
          throw new Error('No open audit cycle for Head Office. Counting is locked — open a cycle to update stock.');
        }
        headOfficeCycleId = openCycle.id;
      }
    }
  }

  const hiddenLineIds = [...hiddenSet];
  const postedAt = previous?.postedAt ?? null;
  const postedByUid = previous?.postedByUid ?? null;
  const postedByName = previous?.postedByName ?? null;
  const receiveCheck = {
    lines: nextLines,
    byLineId: nextByLineId,
    postedLines: nextPostedLines,
    postedAt: previous?.postedAt ?? null,
    postedByUid,
    postedByName,
    hiddenLineIds,
    updatedAt: serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByName: actor.displayName?.trim() || null,
  };

  try {
    await updateDoc(doc(db, 'goodsReceipts', id), { receiveCheck });
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }

  try {
    if (reverseProductId && cochinReverseDeltas.length > 0) {
      await applyCatalogSiteInventoryDeltas({
        catalogProductId: reverseProductId,
        site: 'cochin',
        deltas: cochinReverseDeltas,
        updatedByUid: actor.uid,
        updatedByName: actor.displayName,
      });
      if (cochinCycleId) {
        await recordCatalogProductAudit(reverseProductId, 'cochin_inventory', cochinCycleId);
      }
    }
    if (reverseProductId && headOfficeReverseDeltas.length > 0) {
      const line = options.lineItems.find(l => l.id === targetLineId);
      await applyYesStoreInboundDeltas({
        catalogProductId: reverseProductId,
        productName: line?.name?.trim() || reverseProductId,
        productSku: line?.sku?.trim() || null,
        deltas: headOfficeReverseDeltas,
        actor,
      });
      if (headOfficeCycleId) {
        await recordCatalogProductAudit(reverseProductId, 'warehouse_count', headOfficeCycleId);
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Item hidden, but warehouse / audit update failed: ${detail}`);
  }

  return toClientReceiveCheck({
    lines: nextLines,
    byLineId: nextByLineId,
    postedLines: nextPostedLines,
    postedAt,
    postedByUid,
    postedByName,
    hiddenLineIds,
  }, actor);
}

export async function downloadGoodsReceiptDocument(
  goodsReceiptId: string,
): Promise<InvoiceDocumentDownload> {
  const callable = httpsCallable<
    { goodsReceiptId: string },
    InvoiceDocumentDownload
  >(
    functions,
    'downloadGoodsReceiptDocument',
    { timeout: 60_000 },
  );
  try {
    const result = await callable({ goodsReceiptId });
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

export type MarkGoodsReceiptReceivedResult = {
  alreadyReceived: boolean;
  status: string;
  receivedDate: string | null;
  opsReceivedAt: string | null;
  opsReceivedByUid: string | null;
  opsReceivedByName: string | null;
  serialAllotment?: {
    applied?: number;
    updated?: number;
    pushed?: number;
    skipped?: string | null;
  } | null;
};

export async function markGoodsReceiptReceived(
  goodsReceiptId: string,
  receivedAt?: string | null,
  serialRanges?: PurchaseOrderSerialRangeInput[],
): Promise<MarkGoodsReceiptReceivedResult> {
  const callable = httpsCallable<
    {
      goodsReceiptId: string;
      receivedAt?: string | null;
      serialRanges?: PurchaseOrderSerialRangeInput[];
    },
    MarkGoodsReceiptReceivedResult
  >(
    functions,
    'markGoodsReceiptReceivedFn',
    { timeout: 180_000 },
  );
  try {
    const result = await callable({
      goodsReceiptId,
      receivedAt: receivedAt ?? null,
      serialRanges: serialRanges?.length ? serialRanges : undefined,
    });
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}
