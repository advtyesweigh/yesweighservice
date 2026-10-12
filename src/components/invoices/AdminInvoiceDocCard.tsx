import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Calendar,
  ChevronRight,
  ClipboardList,
  CreditCard,
  FileText,
  MapPin,
  Package,
  ScanBarcode,
  Store,
  Truck,
  User,
} from 'lucide-react';
import {
  bookingInvoiceEwayRow,
  invoiceListEwayChip,
  invoiceNeedsEwayBillCard,
  invoiceTotalInclGst,
  isEwayBillRequired,
  type EwayBillListChip,
} from '../../constants/ewayBill';
import { formatCurrency } from '../../lib/catalog';
import { formatAdminCustomerLocation } from '../../lib/admin-invoices';
import type { AdminFirestoreInvoice } from '../../lib/admin-invoices';
import {
  formatInvoiceDateTime,
  formatInvoiceQtyVariants,
  invoiceAmountExclGst,
  invoiceCategoryAmount,
} from '../../lib/invoices';
import { invoiceListStatusKey, invoiceListStatusLabel } from '../../lib/invoiceListStatus';
import { resolveDealerKamName } from '../../lib/dealerKamDisplay';
import type { LogisticsBooking } from '../../types/logistics-dispatch';
import type { InvoiceCategory } from '../../types/invoices';
import { isInvoicePaidStatus } from '../../types/invoices';
import { preventMouseFocusScroll } from '../../lib/preventMouseFocusScroll';
import { ListTileKam } from '../list/ListTileKam';
import { FitSingleLine } from './FitSingleLine';
import { InvoiceTileLeadWithLabel } from './InvoiceCategoryVisual';

type InvoiceDocCardProps = {
  invoice: AdminFirestoreInvoice;
  booking?: LogisticsBooking;
  location?: { district: string | null; state: string | null };
  category: InvoiceCategory | 'all';
  showKam: boolean;
  dealerStaffById: Record<string, string>;
  onOpen: (invoice: AdminFirestoreInvoice) => void;
  kotakPaid?: boolean;
};

function invoiceStatusClass(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, '_');
  return `invoices-status invoices-status--${key}`;
}

function invoiceRowStatusDisplay(
  invoice: Pick<AdminFirestoreInvoice, 'status' | 'customerPickup' | 'categories' | 'invoiceCategory'>,
  booking: LogisticsBooking | undefined,
): { key: string; label: string; className: string } {
  const key = invoiceListStatusKey(invoice, booking);
  const tone = key === 'customer_pickup' || key === 'delivered'
    ? 'delivered'
    : key === 'in_transit' || key === 'to_dispatch'
      ? 'sent'
      : key === 'cancelled' || key === 'void'
        ? 'void'
        : key === 'returned'
          ? 'overdue'
          : key;
  return {
    key,
    label: invoiceListStatusLabel(key),
    className: invoiceStatusClass(tone),
  };
}

type FieldTone =
  | 'invoice'
  | 'so'
  | 'qty'
  | 'date'
  | 'kam'
  | 'eway'
  | 'courier'
  | 'lr';

function CardField({
  icon: Icon,
  label,
  tone,
  children,
}: {
  icon?: LucideIcon;
  label?: string;
  tone?: FieldTone;
  children: ReactNode;
}) {
  return (
    <span className={`invoice-doc-card__field${tone ? ` invoice-doc-card__field--${tone}` : ''}`}>
      {label ? (
        <span className="invoice-doc-card__field-head">
          {Icon ? <Icon size={13} strokeWidth={2.2} className="invoice-doc-card__icon" aria-hidden /> : null}
          <span className="invoice-doc-card__field-label">{label}</span>
        </span>
      ) : null}
      <FitSingleLine className="invoice-doc-card__field-value">{children || '—'}</FitSingleLine>
    </span>
  );
}

function ewayFieldDisplay(
  invoice: AdminFirestoreInvoice,
  booking: LogisticsBooking | undefined,
  chip: EwayBillListChip | null,
): { text: string; tone: 'number' | 'mandatory' | 'optional' } {
  const row = booking ? bookingInvoiceEwayRow(booking, invoice.id) : null;
  const number = invoice.ewayBill?.ewaybillNumber?.trim()
    || row?.ewayBillNumber?.trim()
    || booking?.ewayBillNumber?.trim()
    || '';
  if (number) return { text: number, tone: 'number' };

  const mandatory = chip?.tone === 'missing'
    || chip?.tone === 'cancelled'
    || invoice.ewayBill?.required === true
    || invoice.ewayBill?.requiredBecause === 'clubbed_lr'
    || isEwayBillRequired(invoiceTotalInclGst(invoice))
    || invoiceNeedsEwayBillCard({
      invoice,
      booking,
      customerPickup: Boolean(invoice.customerPickup?.markedAt || invoice.customerPickupMarkedAt),
    });
  if (mandatory) return { text: 'Mandatory', tone: 'mandatory' };
  return { text: 'Not mandatory', tone: 'optional' };
}

function invoiceShowsPaidStamp(invoice: AdminFirestoreInvoice): boolean {
  const status = String(invoice.status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (status === 'void' || status === 'cancelled') return false;
  if (invoice.kotakPaidAt) return true;
  if (isInvoicePaidStatus(invoice.status)) return true;
  const total = Number(invoice.total);
  const balance = Number(invoice.balance);
  return Number.isFinite(total) && total > 0 && Number.isFinite(balance) && balance <= 0.01;
}

function lrFieldValue(
  invoice: AdminFirestoreInvoice,
  booking: LogisticsBooking | undefined,
): string {
  const lr = booking?.consignmentNo?.trim() || booking?.trackingNo?.trim();
  if (lr) return lr;
  if (invoice.customerPickup?.markedAt || invoice.customerPickupMarkedAt) return 'Customer pickup';
  return '—';
}

export function AdminInvoiceDocCard({
  invoice,
  booking,
  location,
  category,
  showKam,
  dealerStaffById,
  onOpen,
  kotakPaid = false,
}: InvoiceDocCardProps) {
  const isAggregateRow = (invoice.aggregateInvoiceCount ?? 0) > 1;
  const locationLabel = formatAdminCustomerLocation(location);
  const rowStatus = isAggregateRow ? null : invoiceRowStatusDisplay(invoice, booking);
  const ewayChip = isAggregateRow ? null : invoiceListEwayChip(invoice, booking);
  const eway = isAggregateRow
    ? { text: '—', tone: 'plain' as const }
    : ewayFieldDisplay(invoice, booking, ewayChip);
  const kamName = showKam
    ? resolveDealerKamName({
      zohoCustomerId: invoice.customerId,
      documentSalespersonName: invoice.salespersonName,
      dealerStaffById,
    })
    : null;
  const amount = category === 'all'
    ? invoiceAmountExclGst(invoice)
    : invoiceCategoryAmount(invoice, category);
  const accent = rowStatus?.key === 'delivered' || rowStatus?.key === 'customer_pickup'
    ? 'delivered'
    : rowStatus?.key === 'in_transit'
      ? 'transit'
      : rowStatus?.key === 'to_dispatch'
        ? 'dispatch'
        : rowStatus?.key === 'void' || rowStatus?.key === 'cancelled'
          ? 'void'
          : rowStatus?.key === 'returned'
            ? 'returned'
            : 'default';
  const paid = !isAggregateRow && (kotakPaid || invoiceShowsPaidStamp(invoice));
  const qcRequested = !isAggregateRow && Boolean(invoice.qcRequested);

  return (
    <button
      type="button"
      className={`invoice-doc-card invoice-doc-card--invoices invoice-doc-card--${accent}${paid ? ' invoice-doc-card--paid' : ''}${qcRequested ? ' invoice-doc-card--qc' : ''}`}
      onMouseDown={preventMouseFocusScroll}
      onClick={() => onOpen(invoice)}
      aria-label={
        isAggregateRow
          ? `View invoices for ${invoice.customerName ?? 'dealer'}`
          : `View invoice ${invoice.invoiceNumber || invoice.id}${paid ? ', paid' : ''}${qcRequested ? ', QC requested' : ''}`
      }
    >
      {paid ? (
        <span className="invoice-doc-card__paid-stamp" aria-hidden>
          <span>PAID</span>
        </span>
      ) : null}
      {qcRequested ? (
        <span className="invoice-doc-card__qc-stamp" aria-hidden>
          <span>QC requested</span>
        </span>
      ) : null}
      <span className="invoice-doc-card__main">
        <span className="invoice-doc-card__head">
          <span className="invoice-doc-card__dealer">
            <Store size={18} strokeWidth={2.1} className="invoice-doc-card__icon" aria-hidden />
            <span className="invoice-doc-card__dealer-copy">
              <FitSingleLine className="invoice-doc-card__title">
                {invoice.customerName ?? (isAggregateRow ? 'Dealer' : '—')}
              </FitSingleLine>
              {locationLabel ? (
                <span className="invoice-doc-card__meta-item">
                  <MapPin size={11} strokeWidth={2.2} aria-hidden />
                  <FitSingleLine className="invoice-doc-card__meta-text">{locationLabel}</FitSingleLine>
                </span>
              ) : null}
            </span>
          </span>
          <span className="invoice-doc-card__head-end">
            <FitSingleLine className="invoice-doc-card__amount">{formatCurrency(amount)}</FitSingleLine>
            <ChevronRight size={18} className="invoice-doc-card__chevron" aria-hidden />
          </span>
        </span>

        <span className="invoice-doc-card__grid">
          <span className="invoice-doc-card__row">
            <CardField icon={FileText} label="Invoice No." tone="invoice">
              {isAggregateRow ? `${invoice.aggregateInvoiceCount} invoices` : (invoice.invoiceNumber || invoice.id)}
            </CardField>
            <CardField icon={ClipboardList} label="SO No." tone="so">
              {isAggregateRow ? '—' : (invoice.referenceNumber || '—')}
            </CardField>
            <CardField icon={Package} label="Qty / Variants" tone="qty">
              {formatInvoiceQtyVariants(invoice.itemQuantity, invoice.itemVariantCount ?? null)}
            </CardField>
          </span>
          <span className="invoice-doc-card__row">
            <CardField icon={Calendar} label="Date & Time" tone="date">
              {formatInvoiceDateTime(invoice.date, invoice.createdTime) || '—'}
            </CardField>
            <CardField icon={User} label="KAM" tone="kam">
              {showKam && kamName ? <ListTileKam name={kamName} /> : '—'}
            </CardField>
            <CardField icon={CreditCard} label="E-way" tone="eway">
              <span className={`invoice-doc-card__eway invoice-doc-card__eway--${eway.tone}`}>
                {eway.text}
              </span>
            </CardField>
          </span>
          <span className="invoice-doc-card__row">
            <CardField tone="courier">
              <InvoiceTileLeadWithLabel invoice={invoice} booking={booking} layout="row" />
            </CardField>
            <CardField icon={ScanBarcode} label="LR / AWB" tone="lr">
              {lrFieldValue(invoice, booking)}
            </CardField>
            <span className="invoice-doc-card__field invoice-doc-card__field--status">
              {isAggregateRow || !rowStatus ? (
                <span className="text-muted text-sm">{invoice.aggregateInvoiceCount} invoices</span>
              ) : (
                <span className={rowStatus.className}>
                  <Truck size={12} strokeWidth={2.2} aria-hidden />
                  {rowStatus.label}
                </span>
              )}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
