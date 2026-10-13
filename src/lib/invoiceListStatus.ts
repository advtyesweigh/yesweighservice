import { invoiceListLogisticsStatus } from './logisticsBooking';
import { invoiceCategoriesForDisplay } from './invoices';
import type { InvoiceCategory } from '../types/invoices';
import type { LogisticsBooking } from '../types/logistics-dispatch';

export const INVOICE_LIST_STATUS_LABELS: Record<string, string> = {
  to_dispatch: 'To dispatch',
  in_transit: 'In transit',
  delivered: 'Delivered',
  customer_pickup: 'Customer pickup',
  returned: 'Returned',
  void: 'Void',
  support: 'Support',
  cancelled: 'Cancelled',
};

/** SO freight lines attach to product/spare only — never software, GATC, or service-only. */
const LOGISTICS_FREIGHT_CATEGORIES: ReadonlySet<InvoiceCategory> = new Set([
  'product',
  'spare',
]);

const LOGISTICS_FILTER_KEYS = new Set([
  'to_dispatch',
  'in_transit',
  'delivered',
  'returned',
  'void',
]);

export type InvoiceListStatusInvoice = {
  id?: string;
  status?: unknown;
  customerPickup?: { markedAt?: string | null } | null;
  customerPickupMarkedAt?: string | null;
  manualDelivery?: { markedAt?: string | null } | null;
  manualDeliveredAt?: string | null;
  categories?: unknown;
  invoiceCategory?: unknown;
};

function invoiceHasConfirmedCustomerPickup(invoice: InvoiceListStatusInvoice): boolean {
  const nested = String(invoice.customerPickup?.markedAt ?? '').trim();
  if (nested && nested !== '[object Object]') return true;
  const scalar = String(invoice.customerPickupMarkedAt ?? '').trim();
  return Boolean(scalar && scalar !== '[object Object]');
}

function invoiceHasManualDelivery(invoice: InvoiceListStatusInvoice): boolean {
  const nested = String(invoice.manualDelivery?.markedAt ?? '').trim();
  if (nested && nested !== '[object Object]') return true;
  const scalar = String(invoice.manualDeliveredAt ?? '').trim();
  return Boolean(scalar && scalar !== '[object Object]');
}

/**
 * True when this invoice can have a freight line / warehouse dispatch
 * (product or spare). Software keys, stamping, and service-only docs are not.
 */
export function invoiceAllowsLogisticsFulfillment(
  invoice: Pick<InvoiceListStatusInvoice, 'categories' | 'invoiceCategory'> | null | undefined,
): boolean {
  const categories = invoiceCategoriesForDisplay(invoice);
  if (!categories.length) return true;
  if (categories.every(category => category === 'gatc')) return false;
  return categories.some(category => LOGISTICS_FREIGHT_CATEGORIES.has(category));
}

/**
 * List badge key.
 * Void leaves active dispatch chips even when an AWB is still on the invoice.
 * Pickup stays distinct; cancelled AWB returns to to-dispatch;
 * software / GATC / service-only keep Zoho status instead of To dispatch.
 */
export function invoiceListStatusKey(
  invoice: InvoiceListStatusInvoice,
  booking?: Pick<LogisticsBooking, 'status' | 'wizardStep' | 'consignmentNo' | 'trackingNo'> | null,
): string {
  const zoho = String(invoice.status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (zoho === 'void') return 'void';
  if (invoiceHasConfirmedCustomerPickup(invoice)) return 'customer_pickup';
  if (invoiceHasManualDelivery(invoice)) return 'delivered';

  const logistics = invoiceListLogisticsStatus(booking);
  if (logistics) {
    if (logistics.status === 'cancelled') return 'to_dispatch';
    if (logistics.status === 'in_transit') return 'in_transit';
    if (logistics.status === 'delivered') return 'delivered';
    if (logistics.status === 'returned') return 'returned';
    return logistics.status;
  }

  if (invoiceAllowsLogisticsFulfillment(invoice)) return 'to_dispatch';
  return zoho || 'sent';
}

/**
 * Chip key: pickup → Delivered; non-logistics invoices omit dispatch chips
 * (they still appear in All, Support, and Void).
 */
export function invoiceListFilterStatusKey(
  invoice: InvoiceListStatusInvoice,
  booking?: Pick<LogisticsBooking, 'status' | 'wizardStep' | 'consignmentNo' | 'trackingNo'> | null,
): string | null {
  const key = invoiceListStatusKey(invoice, booking);
  if (key === 'customer_pickup') return 'delivered';
  if (key === 'void') return 'void';
  if (LOGISTICS_FILTER_KEYS.has(key)) return key;
  return null;
}

export function invoiceListStatusLabel(key: string): string {
  return INVOICE_LIST_STATUS_LABELS[key]
    ?? key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}
