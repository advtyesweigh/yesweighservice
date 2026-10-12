import React from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Package } from 'lucide-react';
import { formatCurrency } from '../../lib/catalog';
import { isFreightInvoiceLineItem, moveFreightLinesToEnd } from '../../lib/invoices';
import type { DealerInvoiceDetail, DealerInvoiceLineItem } from '../../types/invoices';
import { DocumentLineItemSpec } from './DocumentLineItemSpec';
import { FastRemoteImage } from '../media/FastRemoteImage';

interface InvoiceDocumentBodyProps {
  invoice: Pick<DealerInvoiceDetail, 'subtotal' | 'taxTotal' | 'total' | 'lineItems'>;
  selectedLineItemId?: string | null;
  onSelectLineItem?: (item: DealerInvoiceLineItem) => void;
  onConfirmLineItem?: () => void;
  itemClassName?: string;
  /** When set, matching line items are omitted (e.g. freight/stamping fees for service requests). */
  hideLineItem?: (item: DealerInvoiceLineItem) => boolean;
  hideTotals?: boolean;
  /** When true, render line items first, then totals (sales-order layout). */
  totalsAfterItems?: boolean;
  /** ISO currency (e.g. USD) — defaults to INR. */
  currencyCode?: string;
  /** Hide rate, line totals, and document totals (qty only). */
  hideAmounts?: boolean;
  /** Shown on freight lines when product package dims are missing. */
  freightAlert?: string | null;
  /** Allow selecting freight lines (SO inline freight expand). */
  selectFreight?: boolean;
  /** Select only freight lines (invoice local courier switch). */
  selectFreightOnly?: boolean;
  /** Content rendered under the selected / expanded line. */
  renderExpanded?: (item: DealerInvoiceLineItem) => React.ReactNode;
  /** Optional meta under each line (e.g. available stock for staff review). */
  itemMeta?: (item: DealerInvoiceLineItem) => React.ReactNode;
  /** Optional control under the product thumbnail (e.g. dealer invoice PDF upload). */
  itemMediaExtra?: (item: DealerInvoiceLineItem) => React.ReactNode;
  /** Rendered after the items list (before totals when totalsAfterItems). */
  afterItems?: React.ReactNode;
}

export const InvoiceDocumentBody: React.FC<InvoiceDocumentBodyProps> = ({
  invoice,
  selectedLineItemId,
  onSelectLineItem,
  onConfirmLineItem,
  itemClassName = '',
  hideLineItem,
  hideTotals = false,
  totalsAfterItems = false,
  currencyCode = 'INR',
  hideAmounts = false,
  freightAlert = null,
  selectFreight = false,
  selectFreightOnly = false,
  renderExpanded,
  itemMeta,
  itemMediaExtra,
  afterItems = null,
}) => {
  const selectable = Boolean(onSelectLineItem);
  const visibleItems = moveFreightLinesToEnd(
    hideLineItem
      ? invoice.lineItems.filter(item => !hideLineItem(item))
      : invoice.lineItems,
  );
  const money = (value: number) => formatCurrency(value, currencyCode);
  const showAmounts = !hideAmounts;

  const totals = showAmounts && !hideTotals ? (
    <section className="invoice-detail-footer panel glass">
      <div className="invoice-detail-footer__row">
        <span>Sub Total</span>
        <span>{money(invoice.subtotal)}</span>
      </div>
      <div className="invoice-detail-footer__row">
        <span>GST</span>
        <span>{money(invoice.taxTotal)}</span>
      </div>
      <div className="invoice-detail-footer__row invoice-detail-footer__row--total">
        <span>Grand Total</span>
        <strong>{money(invoice.total)}</strong>
      </div>
    </section>
  ) : null;

  const items = (
    <section className="invoice-detail-items panel glass">
      <h3 className="invoice-detail-items__title">
        Items{visibleItems.length ? ` (${visibleItems.length})` : ''}
      </h3>
      {visibleItems.length ? (
        <ul className="invoice-detail-item-list">
          {visibleItems.map(item => {
            const isFreight = isFreightInvoiceLineItem(item);
            const isSelected = selectedLineItemId === item.id;
            const canSelect = selectable && (
              selectFreightOnly
                ? isFreight
                : (selectFreight || !isFreight || Boolean(hideLineItem))
            );
            const showFreightAlert = Boolean(isFreight && freightAlert);
            const expanded = isSelected ? renderExpanded?.(item) : null;

            return (
              <li
                key={item.id}
                className={[
                  'invoice-detail-item',
                  itemClassName,
                  isSelected ? 'is-selected' : '',
                  canSelect ? 'is-selectable' : '',
                  showFreightAlert ? 'has-freight-alert' : '',
                  expanded ? 'is-expanded' : '',
                ].filter(Boolean).join(' ')}
              >
                {canSelect ? (
                  <div
                    role="button"
                    tabIndex={0}
                    className="invoice-detail-item__select"
                    onClick={event => {
                      if ((event.target as HTMLElement).closest('[data-capture-ignore="1"]')) return;
                      onSelectLineItem?.(item);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectLineItem?.(item);
                      }
                    }}
                    aria-pressed={isSelected}
                    aria-expanded={Boolean(expanded)}
                  >
                    <ItemContent
                      item={item}
                      currencyCode={currencyCode}
                      hideAmounts={hideAmounts}
                      showNext={isSelected && Boolean(onConfirmLineItem) && !renderExpanded}
                      onNext={onConfirmLineItem}
                      alert={showFreightAlert ? freightAlert : null}
                      meta={itemMeta?.(item)}
                      mediaExtra={itemMediaExtra?.(item)}
                    />
                    {isSelected ? (
                      <ChevronDown size={20} className="invoice-detail-item__chevron" aria-hidden />
                    ) : (
                      <ChevronRight size={20} className="invoice-detail-item__chevron" aria-hidden />
                    )}
                  </div>
                ) : (
                  <ItemContent
                    item={item}
                    currencyCode={currencyCode}
                    hideAmounts={hideAmounts}
                    alert={showFreightAlert ? freightAlert : null}
                    meta={itemMeta?.(item)}
                    mediaExtra={itemMediaExtra?.(item)}
                  />
                )}
                {expanded ? (
                  <div className="invoice-detail-item__expanded" data-capture-ignore="1">
                    {expanded}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="invoice-detail-items__empty text-muted text-sm">No line items on this invoice.</p>
      )}
    </section>
  );

  return (
    <>
      {totalsAfterItems ? (
        <>
          {items}
          {afterItems}
          {totals}
        </>
      ) : (
        <>
          {totals}
          {items}
          {afterItems}
        </>
      )}
    </>
  );
};

function ItemContent({
  item,
  currencyCode = 'INR',
  hideAmounts = false,
  showNext = false,
  onNext,
  alert = null,
  meta = null,
  mediaExtra = null,
}: {
  item: DealerInvoiceLineItem;
  currencyCode?: string;
  hideAmounts?: boolean;
  showNext?: boolean;
  onNext?: () => void;
  alert?: string | null;
  meta?: React.ReactNode;
  mediaExtra?: React.ReactNode;
}) {
  return (
    <>
      <div className="invoice-detail-item__media">
        <div className="invoice-detail-item__image-wrap">
          {item.imageUrl ? (
            <FastRemoteImage src={item.imageUrl} alt="" className="invoice-detail-item__image" />
          ) : (
            <span className="invoice-detail-item__placeholder" aria-hidden>
              <Package size={22} />
            </span>
          )}
        </div>
        {mediaExtra}
      </div>
      <DocumentLineItemSpec
        name={item.name}
        sku={item.sku}
        description={item.description}
      >
        <div className="invoice-detail-item__pricing">
          {hideAmounts ? (
            <span>Qty {item.quantity}</span>
          ) : (
            <>
              <span>{formatCurrency(item.rate, currencyCode)} × {item.quantity}</span>
              <strong>{formatCurrency(item.total, currencyCode)}</strong>
            </>
          )}
        </div>
        {meta}
        {alert ? (
          <p className="invoice-detail-item__freight-alert" role="alert">
            <AlertTriangle size={14} aria-hidden />
            <span>{alert}</span>
          </p>
        ) : null}
        {showNext && onNext && (
          <button
            type="button"
            className="btn btn-primary btn-sm invoice-detail-item__next"
            onClick={e => {
              e.stopPropagation();
              onNext();
            }}
          >
            Next
            <ArrowRight size={16} />
          </button>
        )}
      </DocumentLineItemSpec>
    </>
  );
}
