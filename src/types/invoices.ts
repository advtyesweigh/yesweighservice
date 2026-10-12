import type { SpareFreightPackaging } from '../lib/spareFreightQuote';

export type InvoiceStatus =
  | 'sent'
  | 'draft'
  | 'overdue'
  | 'paid'
  | 'void'
  | 'unpaid'
  | 'partially_paid'
  | 'viewed';

/** Paid invoices lock Delhivery BTC/FOD (freight already settled on the invoice). */
export function isInvoicePaidStatus(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'paid';
}

/** Used across invoice, sales order, and purchase order category classification. */
export type InvoiceCategory = 'product' | 'spare' | 'service' | 'software_key' | 'gatc';

export const INVOICE_CATEGORIES: readonly InvoiceCategory[] = [
  'product',
  'spare',
  'service',
  'software_key',
  'gatc',
] as const;

export interface DealerInvoice {
  id: string;
  invoiceNumber: string;
  date: string | null;
  /** Zoho created_time when present (list tiles show clock time). */
  createdTime?: string | null;
  dueDate: string | null;
  status: InvoiceStatus | string;
  /** Grand total including GST. */
  total: number;
  /** Pre-tax amount (excludes GST). Null on older docs that predate sync of this field. */
  subtotal?: number | null;
  /** GST / tax total. Null on older docs that predate sync of this field. */
  taxTotal?: number | null;
  balance: number;
  referenceNumber: string | null;
  lastPaymentDate: string | null;
  currencyCode: string;
  customerName: string | null;
  /** Zoho Inventory salesperson (KAM) when present on the invoice. */
  salespersonId?: string | null;
  salespersonName?: string | null;
  invoiceUrl: string | null;
  /** Legacy single category kept during migration; null for older docs. */
  invoiceCategory?: InvoiceCategory | null;
  /** Multi-category classification derived from non-freight line items. */
  categories?: InvoiceCategory[];
  /** Sum of line totals per category on this document. */
  categoryAmounts?: Partial<Record<InvoiceCategory, number>>;
  /** Courier freight SKU when the invoice includes a delivery-partner line. */
  freightSku?: string | null;
  /** Compact product rows when the list is fetched with `includeLineItems`. */
  lineItems?: DealerInvoiceLineItem[];
  /** Customer collected goods — used for replacement receiving date. */
  customerPickup?: InvoiceCustomerPickup | null;
  customerPickupMarkedAt?: string | null;
  /** Ops marked delivered from the invoice (with or without a logistics booking). */
  manualDelivery?: InvoiceManualDelivery | null;
  manualDeliveredAt?: string | null;
  /**
   * When the dealer received the goods (courier POD, ops delivered, or pickup).
   * Set by getDealerInvoices / getDealerInvoiceDetail when a receiving date is known.
   */
  goodsReceivedAt?: string | null;
}

export interface DealerInvoiceLineItem {
  id: string;
  itemId: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  quantity: number;
  rate: number;
  total: number;
  imageUrl: string | null;
  /** HSN / SAC from Zoho line or catalog (used to exclude freight SAC). */
  hsn?: string | null;
  /** Extra QC per machine (Weighing Scale Import / Bill Printing Scales). */
  qcEnabled?: boolean;
  qcFeePerUnit?: number;
  serialNumbers?: string[];
  /** Catalog Zoho category when resolved (support picker filters software/spares). */
  categoryId?: string | null;
  categoryName?: string | null;
  /** True when the catalog category is flagged as a weighing scale. */
  isWeighingScale?: boolean | null;
  /**
   * Set when catalogProducts was looked up: true = Spare parts tab item
   * (uncategorized or Generic spare parts). Missing means catalog was not resolved.
   */
  isCatalogSpare?: boolean;
}

export interface DealerInvoiceDetail extends DealerInvoice {
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  subtotal: number;
  taxTotal: number;
  notes: string | null;
  lineItems: DealerInvoiceLineItem[];
  /** Resolved shipping/billing address for display (from invoice or zohoCustomers). */
  shippingAddress?: string | null;
  /** Billing address when distinct from shipping (invoice mirror or customer). */
  billingAddress?: string | null;
  /** Customer GSTIN from zohoCustomers (invoice-to / billing). */
  customerGstin?: string | null;
  /** GSTIN on the ship-to address. Null when that address is blank or URP. */
  shippingGstin?: string | null;
  customerPhone?: string | null;
  /** Phone on the invoice Ship To / shipping address (not Invoice To). */
  shippingPhone?: string | null;
  customerTelHref?: string | null;
  customerWhatsappHref?: string | null;
  /** Zoho warehouse on the invoice (for ship-from resolution). */
  zohoWarehouseId?: string | null;
  zohoWarehouseName?: string | null;
  /** Cached e-way bill metadata when invoice value exceeds GST threshold. */
  ewayBill?: InvoiceEwayBillRecord | null;
  /** Customer collected goods — no courier logistics booking. */
  customerPickup?: InvoiceCustomerPickup | null;
  /** Linked YesOne SO was created as customer pickup (no courier freight). */
  sourceSalesOrderIsPickup?: boolean;
  /** Dealer requested QC / back-bill on one or more machines. */
  qcRequested?: boolean;
  /** Meezan / dealer customer sales invoice PDF packed instead of the YESWEIGH invoice. */
  dealerCustomerInvoice?: {
    storagePath: string;
    url: string;
    fileName: string;
    uploadedAt: string | null;
    uploadedByUid: string | null;
    uploadedByName: string | null;
  } | null;
  /** Ops marked delivered from the invoice (with or without a logistics booking). */
  manualDelivery?: InvoiceManualDelivery | null;
  manualDeliveredAt?: string | null;
  /** Courier POD / pickup / ops delivered. */
  goodsReceivedAt?: string | null;
  /**
   * Super-admin local courier switch (e.g. Delhivery → Blue Dart when service
   * is unavailable). Never written to Zoho — e-invoice invoices cannot change.
   */
  yesOneFreightPartner?: InvoiceLocalFreightPartner | null;
  /** For spare invoices: admin-entered spare carton LBH + weight (from the SO). */
  sparePackaging?: SpareFreightPackaging[] | null;
  /** Non-GATC serials allotted from the Settings pool (dismantled machine lines). */
  nonGatcAllocatedSerials?: string[] | null;
  nonGatcSerialAllottedAt?: string | null;
  nonGatcSerialAllottedBy?: string | null;
  /** YesGATC webhook after RC-dealer serial allotment. */
  yesgatcRcPushedAt?: string | null;
  yesgatcRcPushedBy?: string | null;
  yesgatcRcPushError?: string | null;
  yesgatcRcCode?: string | null;
  yesgatcRcName?: string | null;
}

export type InvoiceCustomerPickup = {
  markedAt: string;
  markedByUid?: string | null;
  markedByName?: string | null;
  shipFromSite?: string | null;
  shipFromLabel?: string | null;
  vehicleNumber?: string | null;
};

export type InvoiceManualDelivery = {
  markedAt: string;
  markedByUid?: string | null;
  markedByName?: string | null;
};

export type InvoiceLocalFreightPartner = {
  partnerId: string;
  sku: string;
  previousPartnerId?: string | null;
  previousSku?: string | null;
  /**
   * Freight billed on the invoice when the partner was switched (INR).
   * Invoice line amounts never change; logistics Paid uses this vs Actual.
   */
  paidFreightInr?: number | null;
  updatedAt: string;
  updatedByUid?: string | null;
  updatedByName?: string | null;
};

export type InvoiceEwayBillStatus =
  | 'generated'
  | 'not_required'
  | 'missing'
  | 'pending'
  | 'failed'
  | 'cancelled'
  | string;

export type InvoiceEwayBillRecord = {
  zohoEwaybillId?: string | null;
  ewaybillNumber?: string | null;
  status?: InvoiceEwayBillStatus | null;
  generatedAt?: string | null;
  expiryDate?: string | null;
  pdfStoragePath?: string | null;
  transporterGstin?: string | null;
  partnerId?: string | null;
  lrNumber?: string | null;
  vehicleNumber?: string | null;
  partBUpdatedAt?: string | null;
  error?: string | null;
  required?: boolean;
  /** Clubbed LR: required even when this invoice is under ₹50k. */
  requiredBecause?: 'invoice_total' | 'clubbed_lr' | null;
  updatedAt?: string | null;
};

export type InvoiceEwayBillResult = {
  required: boolean;
  status: InvoiceEwayBillStatus | null;
  ewaybillNumber?: string | null;
  contentBase64?: string;
  filename?: string;
  mimeType?: string;
  cached?: boolean;
  message?: string;
};

export type CancelInvoiceEwayBillResult = {
  ok: boolean;
  status: InvoiceEwayBillStatus | null;
  ewaybillNumber?: string | null;
  localOnly?: boolean;
  message?: string;
};

export type InvoiceDocumentType = 'invoice' | 'salesorder';

export interface InvoiceDocumentDownload {
  contentBase64: string;
  filename: string;
  mimeType: string;
}

export interface InvoiceListParams {
  page?: number;
  limit?: number;
  q?: string;
  status?: InvoiceStatus | 'all' | '';
  category?: InvoiceCategory | 'all' | '';
  sortField?: 'invoiceNumber' | 'date' | 'dueDate' | 'total' | 'balance' | 'status';
  sortDir?: 'asc' | 'desc';
  /** Ops only — load invoices for a specific Zoho customer. */
  customerId?: string;
  /** Attach compact product rows for the current page (support invoice picker). */
  includeLineItems?: boolean;
  /** Only invoices dated in the last 10 days (full product replacement / DOA). */
  replacementWindow?: boolean;
  /** Last 365 days of invoices in one response (warranty / complaint picker). */
  warrantyWindow?: boolean;
}

export const INVOICE_CATEGORY_FILTER_OPTIONS: Array<{
  value: InvoiceCategory | 'all';
  label: string;
}> = [
  { value: 'all', label: 'All categories' },
  { value: 'product', label: 'Product' },
  { value: 'spare', label: 'Spares' },
  { value: 'software_key', label: 'Software' },
  { value: 'service', label: 'Service charges' },
  { value: 'gatc', label: 'Stamping' },
];

export interface InvoiceListResponse {
  data: DealerInvoice[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  /** Present after status/search filters; used for category tab badges. */
  categoryCounts?: {
    all: number;
    product: number;
    spare: number;
    software_key: number;
    service: number;
    gatc: number;
  };
  customerId?: string;
  lastSyncedAt?: string | null;
  /** Portal GATC Billwise fee total for this dealer (all dates). */
  portalStampingFeeTotal?: number;
  /** Invoice ids present in gatcReports with hasStamping. */
  portalStampingInvoiceIds?: string[];
}

export const INVOICE_STATUS_OPTIONS: Array<{ value: InvoiceStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'sent', label: 'Sent' },
  { value: 'viewed', label: 'Viewed' },
  { value: 'draft', label: 'Draft' },
  { value: 'void', label: 'Void' },
];

/** Chip keys for the invoice list status row (portal fulfillment). */
export type InvoiceListStatusFilter =
  | 'to_dispatch'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'void'
  | 'support';

export const INVOICE_STATUS_FILTERS: readonly InvoiceListStatusFilter[] = [
  'to_dispatch',
  'in_transit',
  'delivered',
  'returned',
  'void',
  'support',
] as const;

export interface InvoiceChartPoint {
  label: string;
  total: number;
}

export interface InvoiceSalesEntry {
  date: string;
  total: number;
}

export type KpiPeriod =
  | 7
  | 30
  | 90
  | 365
  | 'lifetime'
  | 'current_month'
  | 'previous_month'
  | 'financial_year'
  | 'previous_financial_year';

export type SalesRangePreset = KpiPeriod;

export const KPI_PERIOD_OPTIONS: Array<{ value: KpiPeriod; label: string }> = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last 365 days' },
  { value: 'lifetime', label: 'Lifetime' },
  { value: 'current_month', label: 'Current month' },
  { value: 'previous_month', label: 'Previous month' },
  { value: 'financial_year', label: 'Current year (FY)' },
  { value: 'previous_financial_year', label: 'Previous year (FY)' },
];

export const SALES_RANGE_OPTIONS = KPI_PERIOD_OPTIONS;

export interface InvoiceDashboardSummary {
  periodStart: string | null;
  periodEnd: string;
  totalSales: number;
  previousSales: number;
  salesTrendPct: number | null;
  outstandingBalance: number;
  unpaidCount: number;
  overdueCount: number;
  paidCount: number;
  totalInvoiceCount: number;
  dailySales: InvoiceChartPoint[];
  salesEntries: InvoiceSalesEntry[];
  recentInvoices: DealerInvoice[];
  customerId?: string;
}
