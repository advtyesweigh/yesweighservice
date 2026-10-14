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
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, app } from '../firebase';
import { enrichInvoiceDetailImages } from './invoiceLineItemImages';
import {
  getInvoicePeriodBounds,
  invoiceHasCategory,
  invoiceErrorMessage,
  normalizeInvoiceCategories,
  normalizeInvoiceCategoryAmounts,
  parseInvoiceCategory,
  sumInvoiceProductQuantity,
  firstDateTimeValue,
  invoiceDateTimeSortMs,
  freightSkuFromInvoiceLines,
} from './invoices';
import {
  appendSalespersonIdConstraint,
  filterRowsBySalespersonScope,
} from './salespersonScope';
import { buildContactLinks } from './phoneLinks';
import { resolveZohoCustomerDisplayContact } from './zohoCustomerContact';
import { appendMachineQcDescription } from './machineQc';
import type {
  DealerInvoiceLineItem,
  InvoiceCategory,
  InvoiceDocumentDownload,
  InvoiceSalesEntry,
  KpiPeriod,
} from '../types/invoices';

const functions = getFunctions(app, 'asia-south1');

export type AdminSalesOrderSort = 'syncedAt' | 'date' | 'oldest' | 'latest';

export type AdminSalesOrderListQuery = {
  sort?: AdminSalesOrderSort;
  pageSize?: number;
  cursor?: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData> | null;
  category?: InvoiceCategory | 'all';
  /** Inclusive YYYY-MM-DD */
  dateStart?: string | null;
  /** Inclusive YYYY-MM-DD */
  dateEnd?: string | null;
  statusIn?: readonly string[] | null;
  /** YesOne workflow stage (`review`, `payment_submitted`, …). */
  yesOneStage?: string | null;
  /** When set (and yesOneStage is unset), match any of these YesOne stages. */
  yesOneStages?: readonly string[] | null;
  /**
   * When set, restrict to these Zoho salesperson ids.
   * Empty array → no results. Omit / null → org-wide (super admin).
   */
  salespersonIds?: string[] | null;
};

/** Zoho SO statuses treated as finished in the unified pipeline. */
export const ZOHO_DONE_STATUSES = ['fulfilled', 'closed', 'invoiced', 'shipped'] as const;
/** Zoho SO statuses treated as rejected/void. */
export const ZOHO_REJECTED_STATUSES = ['void', 'cancelled', 'canceled'] as const;
/** Active / open Zoho SO statuses (unified "SO" stage). */
export const ZOHO_OPEN_STATUSES = [
  'draft',
  'open',
  'confirmed',
  'approved',
  'partially_invoiced',
  'overdue',
  'pending',
] as const;

export interface AdminFirestoreSalesOrder {
  id: string;
  salesOrderNumber: string;
  customerId: string;
  customerName: string | null;
  /** Zoho Inventory salesperson (KAM) id/name when present on the SO. */
  salespersonId?: string | null;
  salespersonName?: string | null;
  date: string | null;
  createdTime?: string | null;
  shipmentDate: string | null;
  status: string;
  total: number;
  balance: number;
  currencyCode: string;
  referenceNumber: string | null;
  syncedAt: string | null;
  itemQuantity: number | null;
  salesOrderCategory: InvoiceCategory | null;
  categories: InvoiceCategory[];
  categoryAmounts: Partial<Record<InvoiceCategory, number>>;
  /** Courier freight SKU when the SO has a freight line (STFRC, DELFRC, …). */
  freightSku?: string | null;
  /** YesOne workflow stage on the SO mirror (null for legacy sync-only rows). */
  yesOneStage?: string | null;
  /** True when this Draft SO was created from a dealer cart submit. */
  yesOneCreatedFromCart?: boolean;
  /** Portal user who placed the SO (dealer owner after staff approval). */
  yesOneCreatedByUid?: string | null;
  yesOneOrderSegment?: 'product' | 'spare' | 'software' | null;
  /** Dealer staff who submitted the cart for approval. */
  yesOneDealerStaffUid?: string | null;
  /** Linked Zoho invoice when this SO has been invoiced. */
  zohoInvoiceId?: string | null;
  zohoInvoiceNumber?: string | null;
  /** True when one or more line rates differ from catalog for this SO. */
  yesOnePriceCustomized?: boolean;
}

/** Meezan / dealer sales invoice PDF packed with drop-ship parcels. */
export interface DealerCustomerInvoice {
  storagePath: string;
  url: string;
  fileName: string;
  uploadedAt: string | null;
  uploadedByUid: string | null;
  uploadedByName: string | null;
}

export async function resolveDealerCustomerInvoice(input: {
  salesOrderId?: string | null;
  invoiceId?: string | null;
}): Promise<DealerCustomerInvoice | null> {
  const salesOrderId = String(input.salesOrderId || '').trim();
  if (salesOrderId) {
    try {
      const snap = await getDoc(doc(db, 'salesOrders', salesOrderId));
      if (snap.exists()) {
        const parsed = parseDealerCustomerInvoice(snap.data()?.dealerCustomerInvoice);
        if (parsed) return parsed;
      }
    } catch {
      /* fall through */
    }
  }
  const invoiceId = String(input.invoiceId || '').trim();
  if (invoiceId) {
    try {
      const snap = await getDocs(
        query(collection(db, 'salesOrders'), where('zohoInvoiceId', '==', invoiceId), limit(1)),
      );
      if (!snap.empty) {
        return parseDealerCustomerInvoice(snap.docs[0].data()?.dealerCustomerInvoice);
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function parseDealerCustomerInvoice(raw: unknown): DealerCustomerInvoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const storagePath = String(data.storagePath ?? '').trim();
  const url = String(data.url ?? '').trim();
  if (!storagePath && !url) return null;
  return {
    storagePath,
    url,
    fileName: String(data.fileName ?? 'dealer-invoice.pdf').trim() || 'dealer-invoice.pdf',
    uploadedAt: data.uploadedAt ? String(data.uploadedAt) : null,
    uploadedByUid: data.uploadedByUid ? String(data.uploadedByUid) : null,
    uploadedByName: data.uploadedByName ? String(data.uploadedByName) : null,
  };
}

export interface AdminSalesOrderDetail {
  id: string;
  salesOrderNumber: string;
  date: string | null;
  shipmentDate: string | null;
  status: string;
  total: number;
  balance: number;
  referenceNumber: string | null;
  currencyCode: string;
  customerId: string;
  customerName: string | null;
  salespersonId?: string | null;
  salespersonName?: string | null;
  /** Formatted shipping (or billing fallback) address from the SO or customer record. */
  shippingAddress?: string | null;
  shippingAddressId?: string | null;
  /** Dealer phone for Call / WhatsApp on the document party block. */
  customerPhone?: string | null;
  /** Phone on the SO shipping address (not Invoice To). */
  shippingPhone?: string | null;
  /** Bill To / invoice-to phone. Kept separate from the ship-to phone. */
  billingPhone?: string | null;
  customerTelHref?: string | null;
  customerWhatsappHref?: string | null;
  salesOrderCategory: InvoiceCategory | null;
  categories: InvoiceCategory[];
  categoryAmounts: Partial<Record<InvoiceCategory, number>>;
  subtotal: number;
  taxTotal: number;
  notes: string | null;
  /** True when this Draft SO was created from a dealer cart submit. */
  yesOneCreatedFromCart?: boolean;
  /** Create/submit segment stamp (product | spare | software). */
  yesOneOrderSegment?: 'product' | 'spare' | 'software' | null;
  /** Create/submit inventory site stamp (cochin | head_office). */
  yesOneInventorySite?: 'cochin' | 'head_office' | null;
  yesOneBranchLabel?: string | null;
  zohoLocationId?: string | null;
  lineItems: DealerInvoiceLineItem[];
  yesOneStage?: string | null;
  yesOnePriceCustomized?: boolean;
  yesOnePriceChanges?: Array<{
    productId: string;
    itemId: string | null;
    name: string;
    sku: string | null;
    catalogRate: number;
    rate: number;
    quantity: number;
    /** price_level = settings rule at create; user = staff/admin edit */
    source?: 'price_level' | 'user' | null;
    priceLevelId?: string | null;
    priceLevelName?: string | null;
    changedAt: string | null;
    changedByUid: string | null;
    changedByName: string | null;
  }>;
  yesOneCreatedByStaff?: boolean;
  yesOneCreatedByName?: string | null;
  paymentAmount?: number | null;
  paymentUtr?: string | null;
  paymentNotes?: string | null;
  paymentScreenshotStoragePath?: string | null;
  paymentScreenshotUrl?: string | null;
  dealerCustomerInvoice?: DealerCustomerInvoice | null;
  paymentSubmittedAt?: string | null;
  paymentVerifiedAt?: string | null;
  readyForPaymentAt?: string | null;
  readyForPaymentByName?: string | null;
  zohoInvoiceId?: string | null;
  zohoInvoiceNumber?: string | null;
  reservedKotakFeed?: {
    transactionId: string;
    date?: string | null;
    postedTime?: string | null;
    amount?: number;
    payee?: string | null;
    description?: string | null;
    referenceNumber?: string | null;
    accountId?: string | null;
    importedTransactionId?: string | null;
    reservedAt?: string | null;
    appliedInvoiceId?: string | null;
    appliedAt?: string | null;
    applyError?: string | null;
  } | null;
  yesOneSyncError?: string | null;
  manuallyMarkedInvoicedAt?: string | null;
}

export interface AdminSalesOrdersPageResult {
  rows: AdminFirestoreSalesOrder[];
  docs: QueryDocumentSnapshot<DocumentData>[];
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
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
    description: appendMachineQcDescription(
      raw.description ? String(raw.description) : null,
      {
        qcEnabled: raw.qcEnabled === true,
        qcFeePerUnit: raw.qcFeePerUnit != null ? Number(raw.qcFeePerUnit) : 0,
      },
    ),
    sku: raw.sku ? String(raw.sku) : null,
    quantity: Number(raw.quantity ?? 0),
    rate: Number(raw.rate ?? 0),
    total: Number(raw.total ?? 0),
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : null,
    hsn: raw.hsn != null && String(raw.hsn).trim() ? String(raw.hsn) : null,
    categoryName: raw.categoryName ? String(raw.categoryName) : null,
    categoryId: raw.categoryId ? String(raw.categoryId) : null,
    qcEnabled: raw.qcEnabled === true,
    qcFeePerUnit: raw.qcFeePerUnit != null ? Number(raw.qcFeePerUnit) : 0,
  };
}

export function mapAdminSalesOrderDoc(
  docSnap: QueryDocumentSnapshot<DocumentData>,
): AdminFirestoreSalesOrder {
  const data = docSnap.data();
  const lineItems = Array.isArray(data.lineItems)
    ? data.lineItems.map(item => mapLineItem(item as Record<string, unknown>))
    : [];
  return {
    id: docSnap.id,
    salesOrderNumber: String(data.salesOrderNumber ?? ''),
    customerId: String(data.customerId ?? ''),
    customerName: data.customerName ? String(data.customerName) : null,
    salespersonId: data.salespersonId ? String(data.salespersonId) : null,
    salespersonName: data.salespersonName ? String(data.salespersonName) : null,
    date: data.date ? String(data.date) : null,
    createdTime: firstDateTimeValue(
      timestampToIso(data.createdTime),
      timestampToIso(data.zohoCreatedTime),
      timestampToIso(data.zohoLastModified),
      timestampToIso(data.createdAt),
    ),
    shipmentDate: data.shipmentDate ? String(data.shipmentDate) : null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    currencyCode: data.currencyCode ? String(data.currencyCode).toUpperCase() : 'INR',
    referenceNumber: data.referenceNumber ? String(data.referenceNumber) : null,
    syncedAt: timestampToIso(data.syncedAt),
    itemQuantity: lineItems.length
      ? sumInvoiceProductQuantity(lineItems)
      : (data.itemQuantity != null ? Number(data.itemQuantity) : null),
    salesOrderCategory: parseInvoiceCategory(data.salesOrderCategory),
    categories: normalizeInvoiceCategories(data.categories),
    categoryAmounts: normalizeInvoiceCategoryAmounts(data.categoryAmounts),
    freightSku: String(data.freightSku ?? '').trim().toUpperCase()
      || freightSkuFromInvoiceLines(lineItems)
      || null,
    yesOneStage: data.yesOneStage ? String(data.yesOneStage) : null,
    yesOneCreatedFromCart: Boolean(data.yesOneCreatedFromCart),
    yesOneCreatedByUid: data.yesOneCreatedByUid ? String(data.yesOneCreatedByUid) : null,
    yesOneOrderSegment: (() => {
      const segment = String(data.yesOneOrderSegment ?? '').trim().toLowerCase();
      return segment === 'product' || segment === 'spare' || segment === 'software'
        ? segment
        : null;
    })(),
    yesOneDealerStaffUid: data.yesOneDealerStaffUid ? String(data.yesOneDealerStaffUid) : null,
    zohoInvoiceId: data.zohoInvoiceId ? String(data.zohoInvoiceId) : null,
    zohoInvoiceNumber: data.zohoInvoiceNumber ? String(data.zohoInvoiceNumber) : null,
    yesOnePriceCustomized: Boolean(data.yesOnePriceCustomized),
  };
}

/** Format a Date as local YYYY-MM-DD for Firestore string date fields. */
export function toSalesOrderDateKey(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildAdminSalesOrdersQuery(options: AdminSalesOrderListQuery) {
  const sort = options.sort ?? 'latest';
  const pageSize = Math.max(1, Math.min(Number(options.pageSize ?? 25) || 25, 100));
  const category = options.category ?? 'all';
  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const statusIn = options.statusIn?.length ? [...options.statusIn] : null;
  const yesOneStage = options.yesOneStage?.trim() || null;
  const yesOneStages = !yesOneStage && options.yesOneStages?.length
    ? [...options.yesOneStages].map(s => String(s).trim()).filter(Boolean).slice(0, 10)
    : null;
  const constraints: QueryConstraint[] = [];

  if (appendSalespersonIdConstraint(constraints, options.salespersonIds) === 'empty') {
    // Impossible match so callers that ignore empty-scope still get zero docs.
    constraints.push(where('salespersonId', '==', '__none__'));
  }

  if (category && category !== 'all') {
    constraints.push(where('categories', 'array-contains', category));
  }
  if (statusIn) {
    constraints.push(where('status', 'in', statusIn.slice(0, 10)));
  }
  if (yesOneStage) {
    constraints.push(where('yesOneStage', '==', yesOneStage));
  } else if (yesOneStages?.length) {
    constraints.push(where('yesOneStage', 'in', yesOneStages));
  }

  // Date range forces orderBy('date'). Indexes are DESC; oldest is client-side.
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

  return query(collection(db, 'salesOrders'), ...constraints);
}

/** @deprecated Prefer buildAdminSalesOrdersQuery(options). */
export function buildAdminSalesOrdersQueryLegacy(
  sort: AdminSalesOrderSort,
  pageSize: number,
  cursor?: QueryDocumentSnapshot<DocumentData> | null,
  category: InvoiceCategory | 'all' = 'all',
) {
  return buildAdminSalesOrdersQuery({ sort, pageSize, cursor, category });
}

export function isSalesOrderInvoiced(
  so: Pick<AdminFirestoreSalesOrder, 'yesOneStage' | 'status' | 'zohoInvoiceId'>,
): boolean {
  const stage = String(so.yesOneStage || '').trim();
  if (stage === 'completed') return true;
  const zoho = String(so.status || '').toLowerCase().replace(/\s+/g, '_');
  if (zoho === 'invoiced') return true;
  return Boolean(so.zohoInvoiceId);
}

/** Spare / software SOs this staff created that are not invoiced yet. */
export async function fetchStaffOpenFollowOnSalesOrders(
  uid: string,
): Promise<AdminFirestoreSalesOrder[]> {
  const id = String(uid ?? '').trim();
  if (!id) return [];
  try {
    const snap = await getDocs(query(
      collection(db, 'salesOrders'),
      where('yesOneCreatedByUid', '==', id),
      limit(80),
    ));
    return snap.docs
      .map(mapAdminSalesOrderDoc)
      .filter(row => {
        const segment = String(row.yesOneOrderSegment ?? '').trim();
        if (segment !== 'spare' && segment !== 'software') return false;
        return !isSalesOrderInvoiced(row);
      });
  } catch {
    return [];
  }
}

export function mergeSalesOrderRows(
  primary: AdminFirestoreSalesOrder[],
  extra: AdminFirestoreSalesOrder[],
): AdminFirestoreSalesOrder[] {
  const seen = new Set(primary.map(row => row.id));
  const next = [...primary];
  for (const row of extra) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    next.push(row);
  }
  return next;
}

export function subscribeAdminSalesOrders(
  sort: AdminSalesOrderSort,
  pageSize: number,
  onData: (rows: AdminFirestoreSalesOrder[]) => void,
  onError: (message: string) => void,
  category: InvoiceCategory | 'all' = 'all',
) {
  const q = buildAdminSalesOrdersQuery({ sort, pageSize, cursor: null, category });
  return onSnapshot(
    q,
    snap => {
      onData(snap.docs.map(mapAdminSalesOrderDoc));
    },
    err => {
      onError(err.message || 'Could not load Sales orders from Firestore.');
    },
  );
}

export async function fetchAdminSalesOrdersPage(
  sortOrOptions: AdminSalesOrderSort | AdminSalesOrderListQuery,
  pageSize?: number,
  cursor?: QueryDocumentSnapshot<DocumentData> | null,
  category: InvoiceCategory | 'all' = 'all',
): Promise<AdminFirestoreSalesOrder[]> {
  const options: AdminSalesOrderListQuery = typeof sortOrOptions === 'string'
    ? { sort: sortOrOptions, pageSize, cursor, category }
    : sortOrOptions;
  const result = await fetchAdminSalesOrdersPageDetailed(options);
  return result.rows;
}

export async function fetchAdminSalesOrdersPageDetailed(
  options: AdminSalesOrderListQuery,
): Promise<AdminSalesOrdersPageResult> {
  if (
    options.salespersonIds != null
    && appendSalespersonIdConstraint([], options.salespersonIds) === 'empty'
  ) {
    return { rows: [], docs: [], lastDoc: null };
  }
  const snap = await getDocs(buildAdminSalesOrdersQuery(options));
  return {
    rows: snap.docs.map(mapAdminSalesOrderDoc),
    docs: snap.docs,
    lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
  };
}

/** Hydrate Firestore page cursors from saved document ids (list return-focus). */
export async function loadAdminSalesOrderCursorDocs(
  ids: Array<string | null>,
): Promise<Array<DocumentSnapshot<DocumentData> | null>> {
  const snaps: Array<DocumentSnapshot<DocumentData> | null> = [];
  for (const id of ids) {
    const trimmed = String(id ?? '').trim();
    if (!trimmed) {
      snaps.push(null);
      continue;
    }
    const snap = await getDoc(doc(db, 'salesOrders', trimmed));
    snaps.push(snap.exists() ? snap : null);
  }
  return snaps;
}

export async function countAdminSalesOrders(
  options: Omit<AdminSalesOrderListQuery, 'pageSize' | 'cursor'>,
): Promise<number> {
  if (
    options.salespersonIds != null
    && appendSalespersonIdConstraint([], options.salespersonIds) === 'empty'
  ) {
    return 0;
  }

  const sort = options.sort ?? 'date';
  const category = options.category ?? 'all';
  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const statusIn = options.statusIn?.length ? [...options.statusIn] : null;
  const yesOneStage = options.yesOneStage?.trim() || null;
  const yesOneStages = !yesOneStage && options.yesOneStages?.length
    ? [...options.yesOneStages].map(s => String(s).trim()).filter(Boolean).slice(0, 10)
    : null;
  const constraints: QueryConstraint[] = [];

  if (appendSalespersonIdConstraint(constraints, options.salespersonIds) === 'empty') {
    return 0;
  }
  if (category && category !== 'all') {
    constraints.push(where('categories', 'array-contains', category));
  }
  if (statusIn) {
    constraints.push(where('status', 'in', statusIn.slice(0, 10)));
  }
  if (yesOneStage) {
    constraints.push(where('yesOneStage', '==', yesOneStage));
  } else if (yesOneStages?.length) {
    constraints.push(where('yesOneStage', 'in', yesOneStages));
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

  const countQuery = query(collection(db, 'salesOrders'), ...constraints);
  const snap = await getCountFromServer(countQuery);
  return snap.data().count;
}

export type AdminSalesOrderYesOneStageCounts = {
  review: number;
  ready_for_payment: number;
  payment_submitted: number;
  completed: number;
};

export async function countAdminSalesOrdersByYesOneStages(options: {
  category?: InvoiceCategory | 'all';
  dateStart?: string | null;
  dateEnd?: string | null;
  salespersonIds?: string[] | null;
}): Promise<AdminSalesOrderYesOneStageCounts> {
  const base = {
    category: options.category ?? 'all',
    dateStart: options.dateStart ?? null,
    dateEnd: options.dateEnd ?? null,
    salespersonIds: options.salespersonIds ?? null,
  } as const;

  const [review, ready_for_payment, payment_submitted, completed] = await Promise.all([
    countAdminSalesOrders({ ...base, yesOneStage: 'review' }),
    countAdminSalesOrders({ ...base, yesOneStage: 'ready_for_payment' }),
    countAdminSalesOrders({ ...base, yesOneStage: 'payment_submitted' }),
    countAdminSalesOrders({ ...base, yesOneStage: 'completed' }),
  ]);

  return { review, ready_for_payment, payment_submitted, completed };
}

export async function countAdminSalesOrdersByUnifiedStages(options: {
  category?: InvoiceCategory | 'all';
  dateStart?: string | null;
  dateEnd?: string | null;
  salespersonIds?: string[] | null;
}): Promise<{ all: number; so: number; done: number; rejected: number }> {
  const base = {
    category: options.category ?? 'all',
    dateStart: options.dateStart ?? null,
    dateEnd: options.dateEnd ?? null,
    salespersonIds: options.salespersonIds ?? null,
  } as const;

  const [all, so, done, rejected] = await Promise.all([
    countAdminSalesOrders(base),
    countAdminSalesOrders({ ...base, statusIn: ZOHO_OPEN_STATUSES }),
    countAdminSalesOrders({ ...base, statusIn: ZOHO_DONE_STATUSES }),
    countAdminSalesOrders({ ...base, statusIn: ZOHO_REJECTED_STATUSES }),
  ]);

  return { all, so, done, rejected };
}

export type AdminSalesOrderCategoryCounts = {
  all: number;
  product: number;
  spare: number;
  software_key: number;
  service: number;
  gatc: number;
};

export async function countAdminSalesOrdersByCategory(options: {
  dateStart?: string | null;
  dateEnd?: string | null;
  salespersonIds?: string[] | null;
  yesOneStage?: string | null;
  yesOneStages?: readonly string[] | null;
}): Promise<AdminSalesOrderCategoryCounts> {
  const base = {
    dateStart: options.dateStart ?? null,
    dateEnd: options.dateEnd ?? null,
    salespersonIds: options.salespersonIds ?? null,
    yesOneStage: options.yesOneStage ?? null,
    yesOneStages: options.yesOneStages ?? null,
  } as const;

  const [all, product, spare, software_key, service, gatc] = await Promise.all([
    countAdminSalesOrders({ ...base, category: 'all' }),
    countAdminSalesOrders({ ...base, category: 'product' }),
    countAdminSalesOrders({ ...base, category: 'spare' }),
    countAdminSalesOrders({ ...base, category: 'software_key' }),
    countAdminSalesOrders({ ...base, category: 'service' }),
    countAdminSalesOrders({ ...base, category: 'gatc' }),
  ]);

  return { all, product, spare, software_key, service, gatc };
}

export function countZohoRowsByCategory(
  rows: AdminFirestoreSalesOrder[],
): AdminSalesOrderCategoryCounts {
  const counts: AdminSalesOrderCategoryCounts = {
    all: rows.length,
    product: 0,
    spare: 0,
    software_key: 0,
    service: 0,
    gatc: 0,
  };
  for (const row of rows) {
    const categories = row.categories.length
      ? row.categories
      : (row.salesOrderCategory ? [row.salesOrderCategory] : []);
    for (const key of categories) {
      counts[key] += 1;
    }
  }
  return counts;
}

const ADMIN_SO_AGGREGATE_MAX_ROWS = 2500;
const ADMIN_SO_PAGE_SIZE = 100;

function isFirestoreIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /requires an index|COLLECTION_GROUP|COLLECTION_DESC|COLLECTION_ASC/i.test(msg);
}

function salesOrderNumberSortValue(value: string | null | undefined): number {
  const match = String(value ?? '').match(/(\d+)\s*$/);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}

function compareSalesOrderNumberDesc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const diff = salesOrderNumberSortValue(b) - salesOrderNumberSortValue(a);
  if (diff) return diff;
  return String(b ?? '').localeCompare(String(a ?? ''), undefined, { numeric: true });
}

function compareSalesOrderSortKey(
  a: AdminFirestoreSalesOrder,
  b: AdminFirestoreSalesOrder,
  sort: AdminSalesOrderSort,
): number {
  if (sort === 'syncedAt') {
    const bySynced = String(b.syncedAt ?? '').localeCompare(String(a.syncedAt ?? ''));
    if (bySynced) return bySynced;
    return compareSalesOrderNumberDesc(a.salesOrderNumber, b.salesOrderNumber);
  }
  const oldest = sort === 'oldest';
  const aTs = invoiceDateTimeSortMs(a.date, a.createdTime);
  const bTs = invoiceDateTimeSortMs(b.date, b.createdTime);
  const byDate = oldest ? aTs - bTs : bTs - aTs;
  if (byDate) return byDate;
  const byNumber = compareSalesOrderNumberDesc(a.salesOrderNumber, b.salesOrderNumber);
  return oldest ? -byNumber : byNumber;
}

/** Club sales orders into one row per dealer (sums amounts / qty; latest date). */
export function aggregateAdminSalesOrdersByDealer(
  rows: AdminFirestoreSalesOrder[],
  sort: AdminSalesOrderSort = 'date',
): AdminFirestoreSalesOrder[] {
  const byCustomer = new Map<string, AdminFirestoreSalesOrder[]>();
  for (const row of rows) {
    const key = row.customerId || '__unknown__';
    const list = byCustomer.get(key);
    if (list) list.push(row);
    else byCustomer.set(key, [row]);
  }

  const aggregates: AdminFirestoreSalesOrder[] = [];
  for (const [customerId, orders] of byCustomer) {
    const newestFirst = [...orders].sort((a, b) => compareSalesOrderSortKey(a, b, 'latest'));
    const latest = newestFirst[0];
    let total = 0;
    let balance = 0;
    let itemQuantity = 0;
    const categories = new Set<InvoiceCategory>();
    const categoryAmounts: Partial<Record<InvoiceCategory, number>> = {};

    for (const order of orders) {
      total += Number(order.total ?? 0);
      balance += Number(order.balance ?? 0);
      if (order.itemQuantity != null) itemQuantity += order.itemQuantity;
      if (order.salesOrderCategory) categories.add(order.salesOrderCategory);
      for (const category of order.categories ?? []) categories.add(category);
      for (const [cat, amount] of Object.entries(order.categoryAmounts ?? {})) {
        const key = cat as InvoiceCategory;
        categoryAmounts[key] = (categoryAmounts[key] ?? 0) + Number(amount ?? 0);
      }
    }

    const count = orders.length;
    aggregates.push({
      ...latest,
      id: count === 1 ? latest.id : `agg-${customerId}`,
      customerId: customerId === '__unknown__' ? '' : customerId,
      salesOrderNumber: count === 1 ? (latest.salesOrderNumber || latest.id) : `${count} orders`,
      status: count === 1 ? latest.status : 'aggregated',
      total,
      balance,
      categories: [...categories],
      categoryAmounts,
      referenceNumber: count === 1 ? latest.referenceNumber : null,
      itemQuantity: orders.some(o => o.itemQuantity != null) ? itemQuantity : null,
      salesOrderCategory: categories.size === 1 ? [...categories][0]! : null,
      freightSku: count === 1 ? (latest.freightSku ?? null) : null,
      yesOneStage: count === 1 ? latest.yesOneStage : null,
      yesOneCreatedFromCart: count === 1 ? latest.yesOneCreatedFromCart : false,
      yesOnePriceCustomized: count === 1 ? Boolean(latest.yesOnePriceCustomized) : false,
    });
  }

  return aggregates.sort((a, b) => {
    const amountDiff = Number(b.total ?? 0) - Number(a.total ?? 0);
    if (amountDiff !== 0) return amountDiff;
    return compareSalesOrderSortKey(a, b, sort);
  });
}

/** Bounded scan of sales orders in a date window (for aggregate / full-period amounts). */
export async function fetchAllAdminSalesOrdersInRange(options: {
  sort?: AdminSalesOrderSort;
  category?: InvoiceCategory | 'all';
  dateStart?: string | null;
  dateEnd?: string | null;
  salespersonIds?: string[] | null;
  statusIn?: readonly string[] | null;
  maxRows?: number;
}): Promise<{ rows: AdminFirestoreSalesOrder[]; truncated: boolean }> {
  if (
    options.salespersonIds != null
    && appendSalespersonIdConstraint([], options.salespersonIds) === 'empty'
  ) {
    return { rows: [], truncated: false };
  }

  const maxRows = options.maxRows ?? ADMIN_SO_AGGREGATE_MAX_ROWS;
  const rows: AdminFirestoreSalesOrder[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let truncated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await fetchAdminSalesOrdersPageDetailed({
      sort: options.sort ?? 'date',
      pageSize: ADMIN_SO_PAGE_SIZE,
      cursor,
      category: options.category ?? 'all',
      dateStart: options.dateStart,
      dateEnd: options.dateEnd,
      statusIn: options.statusIn,
      salespersonIds: options.salespersonIds,
    });
    if (!result.rows.length) break;
    rows.push(...result.rows);
    cursor = result.lastDoc;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (result.rows.length < ADMIN_SO_PAGE_SIZE) break;
  }

  return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}

/**
 * Load Zoho SOs for one or more dealers (newest-first per customer), then merge.
 * Used when the admin filter sheet selects specific dealers — avoids org-wide
 * pagination missing the chosen customers.
 */
export async function fetchAdminSalesOrdersForCustomers(options: {
  customerIds: string[];
  dateStart?: string | null;
  dateEnd?: string | null;
  category?: InvoiceCategory | 'all';
  statusIn?: readonly string[] | null;
  sort?: AdminSalesOrderSort;
  maxPerCustomer?: number;
  salespersonIds?: string[] | null;
}): Promise<AdminFirestoreSalesOrder[]> {
  const ids = [...new Set(
    options.customerIds.map(id => String(id ?? '').trim()).filter(Boolean),
  )];
  if (!ids.length) return [];
  if (
    options.salespersonIds != null
    && appendSalespersonIdConstraint([], options.salespersonIds) === 'empty'
  ) {
    return [];
  }

  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const sort = options.sort ?? 'date';
  const maxPerCustomer = Math.min(Math.max(Number(options.maxPerCustomer ?? 500) || 500, 1), 2000);
  const pageSize = 100;

  const perCustomer = await Promise.all(ids.map(async customerId => {
    const rows: AdminFirestoreSalesOrder[] = [];
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;

    const buildConstraints = (ordered: boolean, pageCursor: QueryDocumentSnapshot<DocumentData> | null) => {
      const constraints: QueryConstraint[] = [where('customerId', '==', customerId)];
      if (appendSalespersonIdConstraint(constraints, options.salespersonIds) === 'empty') {
        return 'empty' as const;
      }
      if (dateStart) constraints.push(where('date', '>=', dateStart));
      if (dateEnd) constraints.push(where('date', '<=', dateEnd));
      if (ordered) {
        if (dateStart || dateEnd || sort !== 'syncedAt') {
          constraints.push(orderBy('date', 'desc'));
        } else {
          constraints.push(orderBy('syncedAt', 'desc'));
        }
        if (pageCursor) constraints.push(startAfter(pageCursor));
        constraints.push(limit(Math.min(pageSize, maxPerCustomer - rows.length)));
      }
      return constraints;
    };

    try {
      while (rows.length < maxPerCustomer) {
        const constraints = buildConstraints(true, cursor);
        if (constraints === 'empty') return [];
        const snap = await getDocs(query(collection(db, 'salesOrders'), ...constraints));
        if (snap.empty) break;
        rows.push(...snap.docs.map(mapAdminSalesOrderDoc));
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
      }
    } catch (err) {
      if (!isFirestoreIndexError(err)) throw err;
      rows.length = 0;
      const constraints = buildConstraints(false, null);
      if (constraints === 'empty') return [];
      const snap = await getDocs(query(collection(db, 'salesOrders'), ...constraints));
      rows.push(...snap.docs.map(mapAdminSalesOrderDoc).slice(0, maxPerCustomer));
      rows.sort((a, b) => compareSalesOrderSortKey(a, b, sort));
    }
    return rows;
  }));

  let merged = filterRowsBySalespersonScope(perCustomer.flat(), options.salespersonIds);

  const selectedCategory = options.category && options.category !== 'all'
    ? options.category
    : null;
  if (selectedCategory) {
    merged = merged.filter(row => invoiceHasCategory({
      categories: row.categories,
      invoiceCategory: row.salesOrderCategory,
    }, selectedCategory));
  }
  if (options.statusIn?.length) {
    const allowed = new Set(options.statusIn.map(s => String(s).toLowerCase()));
    merged = merged.filter(row => allowed.has(String(row.status || '').toLowerCase()));
  }

  merged.sort((a, b) => compareSalesOrderSortKey(a, b, sort));

  return merged;
}

/** Stage counts from an already-loaded dealer-scoped Zoho list. */
export function countZohoRowsByUnifiedStages(
  rows: AdminFirestoreSalesOrder[],
): { all: number; so: number; done: number; rejected: number } {
  const open = new Set(ZOHO_OPEN_STATUSES.map(s => s.toLowerCase()));
  const done = new Set(ZOHO_DONE_STATUSES.map(s => s.toLowerCase()));
  const rejected = new Set(ZOHO_REJECTED_STATUSES.map(s => s.toLowerCase()));
  let so = 0;
  let doneCount = 0;
  let rejectedCount = 0;
  for (const row of rows) {
    const status = String(row.status || '').toLowerCase().replace(/\s+/g, '_');
    if (rejected.has(status) || status === 'cancelled' || status === 'canceled') {
      rejectedCount += 1;
    } else if (done.has(status) || status.includes('invoice')) {
      doneCount += 1;
    } else if (open.has(status) || status === 'draft') {
      so += 1;
    } else {
      so += 1;
    }
  }
  return { all: rows.length, so, done: doneCount, rejected: rejectedCount };
}



export function filterAdminSalesOrders(
  rows: AdminFirestoreSalesOrder[],
  searchText: string,
  category: InvoiceCategory | 'all' = 'all',
): AdminFirestoreSalesOrder[] {
  let next = rows;
  if (category && category !== 'all') {
    next = next.filter(row => invoiceHasCategory({
      categories: row.categories,
      invoiceCategory: row.salesOrderCategory,
    }, category));
  }
  const needle = searchText.trim().toLowerCase();
  if (!needle) return next;
  return next.filter(row => {
    const haystack = [
      row.salesOrderNumber,
      row.customerName,
      row.customerId,
      row.referenceNumber,
      row.id,
      row.status,
      row.salesOrderCategory,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
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

export function filterAdminSalesOrdersByPeriod(
  rows: AdminFirestoreSalesOrder[],
  period: KpiPeriod,
): AdminFirestoreSalesOrder[] {
  const bounds = getInvoicePeriodBounds(period);
  if (!bounds) return rows;
  return rows.filter(row => {
    if (!row.date) return false;
    const ts = parsePoDay(row.date);
    if (Number.isNaN(ts)) return false;
    return ts >= bounds.start.getTime() && ts <= bounds.end.getTime();
  });
}

export function buildAdminSalesOrderSalesEntries(
  rows: AdminFirestoreSalesOrder[],
): InvoiceSalesEntry[] {
  return rows
    .filter(row => row.date)
    .map(row => ({ date: row.date!, total: row.total }));
}

export function mapAdminSalesOrderDetail(
  poId: string,
  data: DocumentData,
): AdminSalesOrderDetail {
  return {
    id: String(data.id ?? poId),
    salesOrderNumber: String(data.salesOrderNumber ?? ''),
    date: data.date ? String(data.date) : null,
    shipmentDate: data.shipmentDate ? String(data.shipmentDate) : null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    referenceNumber: data.referenceNumber ? String(data.referenceNumber) : null,
    currencyCode: data.currencyCode ? String(data.currencyCode) : 'INR',
    customerId: String(data.customerId ?? ''),
    customerName: data.customerName ? String(data.customerName) : null,
    salespersonId: data.salespersonId ? String(data.salespersonId) : null,
    salespersonName: data.salespersonName ? String(data.salespersonName) : null,
    shippingAddress: data.shippingAddress ? String(data.shippingAddress) : null,
    shippingAddressId: data.shippingAddressId ? String(data.shippingAddressId) : null,
    shippingPhone: data.shippingPhone ? String(data.shippingPhone) : null,
    billingPhone: data.billingPhone ? String(data.billingPhone) : null,
    salesOrderCategory: parseInvoiceCategory(data.salesOrderCategory),
    categories: normalizeInvoiceCategories(data.categories),
    categoryAmounts: normalizeInvoiceCategoryAmounts(data.categoryAmounts),
    subtotal: Number(data.subtotal ?? 0),
    taxTotal: Number(data.taxTotal ?? 0),
    notes: data.notes ? String(data.notes) : null,
    yesOneCreatedFromCart: Boolean(data.yesOneCreatedFromCart),
    yesOneOrderSegment: (() => {
      const segment = String(data.yesOneOrderSegment ?? '').trim().toLowerCase();
      return segment === 'product' || segment === 'spare' || segment === 'software'
        ? segment
        : null;
    })(),
    yesOneInventorySite: (() => {
      const site = String(data.yesOneInventorySite ?? '').trim().toLowerCase();
      return site === 'cochin' || site === 'head_office' ? site : null;
    })(),
    yesOneBranchLabel: data.yesOneBranchLabel ? String(data.yesOneBranchLabel) : null,
    zohoLocationId: data.zohoLocationId ? String(data.zohoLocationId) : null,
    lineItems: Array.isArray(data.lineItems)
      ? data.lineItems.map(item => mapLineItem(item as Record<string, unknown>))
      : [],
    yesOneStage: data.yesOneStage ? String(data.yesOneStage) : null,
    paymentAmount: data.paymentAmount != null ? Number(data.paymentAmount) : null,
    paymentUtr: data.paymentUtr ? String(data.paymentUtr) : null,
    paymentNotes: data.paymentNotes ? String(data.paymentNotes) : null,
    paymentScreenshotStoragePath: data.paymentScreenshotStoragePath
      ? String(data.paymentScreenshotStoragePath)
      : null,
    paymentScreenshotUrl: data.paymentScreenshotUrl ? String(data.paymentScreenshotUrl) : null,
    dealerCustomerInvoice: parseDealerCustomerInvoice(data.dealerCustomerInvoice),
    paymentSubmittedAt: data.paymentSubmittedAt ? String(data.paymentSubmittedAt) : null,
    paymentVerifiedAt: data.paymentVerifiedAt ? String(data.paymentVerifiedAt) : null,
    readyForPaymentAt: data.readyForPaymentAt ? String(data.readyForPaymentAt) : null,
    readyForPaymentByName: data.readyForPaymentByName ? String(data.readyForPaymentByName) : null,
    zohoInvoiceId: data.zohoInvoiceId ? String(data.zohoInvoiceId) : null,
    zohoInvoiceNumber: data.zohoInvoiceNumber ? String(data.zohoInvoiceNumber) : null,
    reservedKotakFeed: data.reservedKotakFeed && typeof data.reservedKotakFeed === 'object'
      ? {
        transactionId: String((data.reservedKotakFeed as { transactionId?: string }).transactionId ?? ''),
        date: (data.reservedKotakFeed as { date?: string | null }).date
          ? String((data.reservedKotakFeed as { date?: string | null }).date)
          : null,
        postedTime: (data.reservedKotakFeed as { postedTime?: string | null }).postedTime
          ? String((data.reservedKotakFeed as { postedTime?: string | null }).postedTime)
          : null,
        amount: Number((data.reservedKotakFeed as { amount?: number }).amount ?? 0),
        payee: (data.reservedKotakFeed as { payee?: string | null }).payee
          ? String((data.reservedKotakFeed as { payee?: string | null }).payee)
          : null,
        description: (data.reservedKotakFeed as { description?: string | null }).description
          ? String((data.reservedKotakFeed as { description?: string | null }).description)
          : null,
        referenceNumber: (data.reservedKotakFeed as { referenceNumber?: string | null }).referenceNumber
          ? String((data.reservedKotakFeed as { referenceNumber?: string | null }).referenceNumber)
          : null,
        accountId: (data.reservedKotakFeed as { accountId?: string | null }).accountId
          ? String((data.reservedKotakFeed as { accountId?: string | null }).accountId)
          : null,
        importedTransactionId: (data.reservedKotakFeed as { importedTransactionId?: string | null }).importedTransactionId
          ? String((data.reservedKotakFeed as { importedTransactionId?: string | null }).importedTransactionId)
          : null,
        reservedAt: (data.reservedKotakFeed as { reservedAt?: string | null }).reservedAt
          ? String((data.reservedKotakFeed as { reservedAt?: string | null }).reservedAt)
          : null,
        appliedInvoiceId: (data.reservedKotakFeed as { appliedInvoiceId?: string | null }).appliedInvoiceId
          ? String((data.reservedKotakFeed as { appliedInvoiceId?: string | null }).appliedInvoiceId)
          : null,
        appliedAt: (data.reservedKotakFeed as { appliedAt?: string | null }).appliedAt
          ? String((data.reservedKotakFeed as { appliedAt?: string | null }).appliedAt)
          : null,
        applyError: (data.reservedKotakFeed as { applyError?: string | null }).applyError
          ? String((data.reservedKotakFeed as { applyError?: string | null }).applyError)
          : null,
      }
      : null,
    yesOneSyncError: data.yesOneSyncError ? String(data.yesOneSyncError) : null,
    manuallyMarkedInvoicedAt: data.manuallyMarkedInvoicedAt ? String(data.manuallyMarkedInvoicedAt) : null,
    yesOnePriceCustomized: Boolean(data.yesOnePriceCustomized),
    yesOnePriceChanges: Array.isArray(data.yesOnePriceChanges)
      ? data.yesOnePriceChanges.map((raw: Record<string, unknown>) => ({
        productId: String(raw.productId ?? ''),
        itemId: raw.itemId != null ? String(raw.itemId) : null,
        name: String(raw.name ?? 'Item'),
        sku: raw.sku != null ? String(raw.sku) : null,
        catalogRate: Number(raw.catalogRate ?? 0),
        rate: Number(raw.rate ?? 0),
        quantity: Number(raw.quantity ?? 0),
        source: raw.source === 'price_level' || raw.source === 'user'
          ? raw.source
          : null,
        priceLevelId: raw.priceLevelId ? String(raw.priceLevelId) : null,
        priceLevelName: raw.priceLevelName ? String(raw.priceLevelName) : null,
        changedAt: raw.changedAt ? String(raw.changedAt) : null,
        changedByUid: raw.changedByUid ? String(raw.changedByUid) : null,
        changedByName: raw.changedByName ? String(raw.changedByName) : null,
      }))
      : [],
    yesOneCreatedByStaff: Boolean(data.yesOneCreatedByStaff),
    yesOneCreatedByName: data.yesOneCreatedByName ? String(data.yesOneCreatedByName) : null,
  };
}

/**
 * Portal cart remarks only — hide Zoho template / ERP notes (bank details, etc.).
 */
export function portalSalesOrderRemarks(
  so: Pick<
    AdminSalesOrderDetail,
    'notes' | 'referenceNumber' | 'yesOneCreatedFromCart' | 'yesOneCreatedByStaff'
  >,
): string | null {
  const notes = so.notes?.trim() || '';
  if (!notes) return null;
  const fromPortal = Boolean(so.yesOneCreatedFromCart)
    || Boolean(so.yesOneCreatedByStaff)
    || /^YES-ORD-/i.test(String(so.referenceNumber || ''));
  if (!fromPortal) return null;
  // Default placeholder written when the dealer left remarks blank.
  if (/^YesOne cart\b/i.test(notes)) return null;
  return notes;
}

export async function fetchAdminSalesOrderDetail(
  salesOrderId: string,
): Promise<AdminSalesOrderDetail> {
  const snap = await getDoc(doc(db, 'salesOrders', salesOrderId));
  if (!snap.exists()) {
    throw new Error('Sales order not found.');
  }
  const detail = mapAdminSalesOrderDetail(salesOrderId, snap.data());
  const [withImages, contact] = await Promise.all([
    enrichInvoiceDetailImages({
      ...detail,
      invoiceNumber: detail.salesOrderNumber,
      dueDate: detail.shipmentDate,
      lastPaymentDate: null,
      customerName: detail.customerName,
      invoiceUrl: null,
      salesOrderId: null,
      salesOrderNumber: null,
    }),
    resolveZohoCustomerDisplayContact(detail.customerId, {
      preferredAddress: detail.shippingAddress,
      preferredAddressId: detail.shippingAddressId,
    }),
  ]);
  const shippingPhone = detail.shippingPhone || contact.shippingPhone;
  const shipLinks = shippingPhone ? buildContactLinks(shippingPhone) : null;
  return {
    ...detail,
    // Keep SO-provided address when present; otherwise use customer shipping/billing fallback.
    shippingAddress: contact.address,
    // Invoice-to stays the bill-to phone. Call links on the ship-to card use shippingPhone.
    customerPhone: detail.billingPhone || contact.phone,
    shippingPhone,
    billingPhone: detail.billingPhone || null,
    customerTelHref: shipLinks?.tel ?? contact.telHref,
    customerWhatsappHref: shipLinks?.whatsapp ?? contact.whatsappHref,
    lineItems: withImages.lineItems,
  };
}

export async function downloadSalesOrderDocument(
  salesOrderId: string,
): Promise<InvoiceDocumentDownload> {
  const callable = httpsCallable<
    { salesOrderId: string },
    InvoiceDocumentDownload
  >(
    functions,
    'downloadSalesOrderDocument',
    { timeout: 60_000 },
  );
  try {
    const result = await callable({ salesOrderId });
    return result.data;
  } catch (err) {
    throw new Error(invoiceErrorMessage(err));
  }
}

function emptySoCategoryCounts(): AdminSalesOrderCategoryCounts {
  return {
    all: 0,
    product: 0,
    spare: 0,
    software_key: 0,
    service: 0,
    gatc: 0,
  };
}

function monthKeysForSoRange(dateStart: string | null, dateEnd: string | null): string[] | null {
  if (!dateStart || !dateEnd) return null;
  const start = dateStart.slice(0, 7);
  const end = dateEnd.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) return null;
  const keys: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  for (let i = 0; i < 24; i += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    keys.push(key);
    if (y === ey && m === em) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

function mapAdminSalesOrderDealerStatsDoc(
  docSnap: QueryDocumentSnapshot<DocumentData>,
): AdminFirestoreSalesOrder & { aggregateOrderCount: number } {
  const data = docSnap.data() ?? {};
  const count = Number(data.count ?? 0);
  const byCategory = (data.byCategory ?? {}) as Record<string, number>;
  const amountByCategory = normalizeInvoiceCategoryAmounts(data.amountByCategory);
  const categories = (['product', 'spare', 'software_key', 'service', 'gatc'] as const)
    .filter(key => Number(byCategory[key] ?? 0) > 0);
  const amount = Number(data.amount ?? 0);
  const customerId = String(data.customerId ?? docSnap.id);
  return {
    id: count === 1 ? customerId : `agg-${customerId}`,
    salesOrderNumber: `${count} orders`,
    customerId,
    customerName: data.customerName ? String(data.customerName) : null,
    date: data.latestDate ? String(data.latestDate) : null,
    shipmentDate: null,
    status: count === 1 ? 'open' : 'aggregated',
    total: Number(data.total ?? amount),
    balance: Number(data.balance ?? 0),
    currencyCode: 'INR',
    referenceNumber: null,
    syncedAt: timestampToIso(data.latestSyncedAt) ?? timestampToIso(data.updatedAt),
    itemQuantity: data.itemQuantity != null ? Number(data.itemQuantity) : null,
    salesOrderCategory: categories.length === 1 ? categories[0]! : null,
    categories: [...categories],
    categoryAmounts: amountByCategory,
    freightSku: null,
    yesOneStage: null,
    yesOneCreatedFromCart: false,
    aggregateOrderCount: count,
  };
}

/**
 * Lifetime Aggregate: one slim read per dealer from salesOrderDealerStats.
 * Org-wide only — not salesperson-partitioned.
 */
export async function fetchAdminSalesOrderDealerLifetimeAggregates(): Promise<AdminFirestoreSalesOrder[]> {
  const snap = await getDocs(
    query(collection(db, 'salesOrderDealerStats'), orderBy('amount', 'desc')),
  );
  return snap.docs
    .map(mapAdminSalesOrderDealerStatsDoc)
    .filter(row => (row.aggregateOrderCount ?? 0) > 0)
    .map(({ aggregateOrderCount: _count, ...row }) => row);
}

export type AdminSalesOrderStatsKpi = {
  orderCount: number;
  categoryAmount: number;
  documentAmount: number;
  totalAmount: number;
  categoryCounts: AdminSalesOrderCategoryCounts;
  source: 'rollup' | 'query';
};

/**
 * Prefer precomputed salesOrderStats / salesOrderMonthStats when salesperson is org-wide.
 */
export async function loadAdminSalesOrderKpis(options: {
  dateStart?: string | null;
  dateEnd?: string | null;
  category?: InvoiceCategory | 'all';
  salespersonIds?: string[] | null;
}): Promise<AdminSalesOrderStatsKpi> {
  const category = options.category ?? 'all';
  const dateStart = options.dateStart?.trim() || null;
  const dateEnd = options.dateEnd?.trim() || null;
  const scoped = options.salespersonIds != null;

  if (!scoped) {
    try {
      if (!dateStart && !dateEnd) {
        const org = await getDoc(doc(db, 'salesOrderStats', 'org'));
        if (org.exists()) {
          const data = org.data() ?? {};
          const byCategory = (data.byCategory ?? {}) as Record<string, number>;
          const amountByCategory = (data.amountByCategory ?? {}) as Record<string, number>;
          const documentAmountByCategory = (data.documentAmountByCategory ?? {}) as Record<string, number>;
          const categoryCounts: AdminSalesOrderCategoryCounts = {
            all: Number(data.count ?? 0),
            product: Number(byCategory.product ?? 0),
            spare: Number(byCategory.spare ?? 0),
            software_key: Number(byCategory.software_key ?? 0),
            service: Number(byCategory.service ?? 0),
            gatc: Number(byCategory.gatc ?? 0),
          };
          const categoryAmount = category === 'all'
            ? Number(data.amount ?? 0)
            : Number(amountByCategory[category] ?? 0);
          const documentAmount = category === 'all'
            ? Number(data.amount ?? 0)
            : Number(documentAmountByCategory[category] ?? 0);
          return {
            orderCount: category === 'all' ? categoryCounts.all : categoryCounts[category],
            categoryAmount,
            documentAmount,
            totalAmount: documentAmount,
            categoryCounts,
            source: 'rollup',
          };
        }
      } else {
        const keys = monthKeysForSoRange(dateStart, dateEnd);
        if (keys?.length) {
          const snaps = await Promise.all(
            keys.map(key => getDoc(doc(db, 'salesOrderMonthStats', key))),
          );
          const categoryCounts = emptySoCategoryCounts();
          let totalAmountAll = 0;
          const amountByCategory: Record<string, number> = {
            product: 0, spare: 0, software_key: 0, service: 0, gatc: 0,
          };
          const documentAmountByCategory: Record<string, number> = {
            product: 0, spare: 0, software_key: 0, service: 0, gatc: 0,
          };
          let any = false;
          for (const snap of snaps) {
            if (!snap.exists()) continue;
            any = true;
            const data = snap.data() ?? {};
            categoryCounts.all += Number(data.count ?? 0);
            totalAmountAll += Number(data.amount ?? 0);
            const byCategory = (data.byCategory ?? {}) as Record<string, number>;
            const amounts = (data.amountByCategory ?? {}) as Record<string, number>;
            const documentAmounts = (data.documentAmountByCategory ?? {}) as Record<string, number>;
            for (const key of ['product', 'spare', 'software_key', 'service', 'gatc'] as const) {
              categoryCounts[key] += Number(byCategory[key] ?? 0);
              amountByCategory[key] += Number(amounts[key] ?? 0);
              documentAmountByCategory[key] += Number(documentAmounts[key] ?? 0);
            }
          }
          if (any) {
            const categoryAmount = category === 'all' ? totalAmountAll : amountByCategory[category];
            const documentAmount = category === 'all'
              ? totalAmountAll
              : documentAmountByCategory[category];
            return {
              orderCount: category === 'all' ? categoryCounts.all : categoryCounts[category],
              categoryAmount,
              documentAmount,
              totalAmount: documentAmount,
              categoryCounts,
              source: 'rollup',
            };
          }
        }
      }
    } catch {
      // Fall through to query counts.
    }
  }

  const counts = await countAdminSalesOrdersByCategory({
    dateStart,
    dateEnd,
    salespersonIds: options.salespersonIds,
  });
  return {
    orderCount: category === 'all' ? counts.all : counts[category],
    categoryAmount: 0,
    documentAmount: 0,
    totalAmount: 0,
    categoryCounts: counts,
    source: 'query',
  };
}
