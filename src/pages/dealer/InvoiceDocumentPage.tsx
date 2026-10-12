import React from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Headphones, Package } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { BookCourierEntryButton } from '../../components/logistics/BookCourierEntryButton';
import { DocumentLineItemSpec } from '../../components/invoices/DocumentLineItemSpec';
import { FastRemoteImage } from '../../components/media/FastRemoteImage';
import { formatCurrency } from '../../lib/catalog';
import { supportBasePath } from '../../lib/dealerSupport';
import {
  buildInvoiceBookingDraftPatch,
  canBookCourierForInvoice,
} from '../../lib/logisticsPrefill';
import {
  isFreightInvoiceLineItem,
  serialNumbersFromLineItem,
} from '../../lib/invoices';
import type { DealerInvoiceLineItem } from '../../types/invoices';
import type { SupportProductDraft } from '../../types/dealer-support';
import type { InvoiceDetailOutletContext } from './invoiceDetailContext';
import { RelatedSupportRequests } from '../../components/support/RelatedSupportRequests';
import {
  appendMachineQcDescription,
  documentLooksLikeMachineQc,
  lineLooksLikeMachineQc,
  stripBackBillNote,
} from '../../lib/machineQc';

export const InvoiceDocumentPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { invoice, invoiceId } = useOutletContext<InvoiceDetailOutletContext>();

  const handleServiceRequest = (item: DealerInvoiceLineItem) => {
    if (!invoice || !invoiceId || !user) return;
    const draft: SupportProductDraft = {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      salesOrderNumber: invoice.salesOrderNumber,
      lineItemId: item.id,
      itemId: item.itemId,
      itemName: item.name,
      itemSku: item.sku,
      quantity: item.quantity,
      imageUrl: item.imageUrl,
      invoiceDate: invoice.date,
      serialNumbers: serialNumbersFromLineItem(item),
    };
    navigate(supportBasePath(user.role), { state: { draft, intent: 'service' as const } });
  };

  if (!invoice) return null;

  const dealerId = user?.role === 'dealer' ? user.uid : (user?.dealerId ?? user?.uid ?? '');
  const zohoCustomerId = user?.zohoCustomerId?.trim() || '';
  const showBookCourier = canBookCourierForInvoice(invoice);
  const courierEntry = showBookCourier
    ? {
      draftPatch: buildInvoiceBookingDraftPatch(
        invoice,
        invoiceId,
        zohoCustomerId,
        dealerId || zohoCustomerId,
      ),
      dealerQuery: invoice.customerName ?? undefined,
    }
    : null;

  return (
    <>
      {courierEntry ? (
        <section className="invoice-detail-actions panel glass">
          <BookCourierEntryButton entry={courierEntry} size="sm" />
        </section>
      ) : null}
      {dealerId && (
        <RelatedSupportRequests
          dealerId={dealerId}
          invoiceId={invoiceId}
          invoiceNumber={invoice.invoiceNumber}
        />
      )}
      <section className="invoice-detail-items panel glass">
        <h3 className="invoice-detail-items__title">
          Items{invoice.lineItems.length ? ` (${invoice.lineItems.length})` : ''}
        </h3>
        {invoice.lineItems.length ? (
          <ul className="invoice-detail-item-list">
            {invoice.lineItems.map(item => {
              const qcRequested = !isFreightInvoiceLineItem(item) && (
                Boolean(invoice.qcRequested)
                || documentLooksLikeMachineQc(invoice)
                || lineLooksLikeMachineQc(item)
              );
              return (
              <li key={item.id} className="invoice-detail-item">
                <div className="invoice-detail-item__image-wrap">
                  {item.imageUrl ? (
                    <FastRemoteImage src={item.imageUrl} alt="" className="invoice-detail-item__image" />
                  ) : (
                    <span className="invoice-detail-item__placeholder" aria-hidden>
                      <Package size={22} />
                    </span>
                  )}
                </div>
                <DocumentLineItemSpec
                  name={item.name}
                  sku={item.sku}
                  description={qcRequested
                    ? appendMachineQcDescription(item.description, {
                      qcEnabled: true,
                      qcFeePerUnit: item.qcFeePerUnit ?? 0,
                    })
                    : stripBackBillNote(item.description)}
                >
                  <div className="invoice-detail-item__pricing">
                    <span>{formatCurrency(item.rate)} × {item.quantity}</span>
                    <strong>{formatCurrency(item.total)}</strong>
                  </div>
                  {qcRequested ? (
                    <p className="invoice-detail-item__qc-requested">QC requested</p>
                  ) : null}
                </DocumentLineItemSpec>
                <button
                  type="button"
                  className="invoice-detail-item__service"
                  aria-label={`Request service for ${item.name}`}
                  onClick={() => handleServiceRequest(item)}
                >
                  <Headphones size={18} aria-hidden />
                  <span>Service</span>
                </button>
              </li>
              );
            })}
          </ul>
        ) : (
          <p className="invoice-detail-items__empty text-muted text-sm">No line items on this invoice.</p>
        )}
      </section>
      <section className="invoice-detail-footer panel glass">
        <div className="invoice-detail-footer__row">
          <span>Sub Total</span>
          <span>{formatCurrency(invoice.subtotal)}</span>
        </div>
        <div className="invoice-detail-footer__row">
          <span>GST</span>
          <span>{formatCurrency(invoice.taxTotal)}</span>
        </div>
        <div className="invoice-detail-footer__row invoice-detail-footer__row--total">
          <span>Grand Total</span>
          <strong>{formatCurrency(invoice.total)}</strong>
        </div>
      </section>
    </>
  );
};
