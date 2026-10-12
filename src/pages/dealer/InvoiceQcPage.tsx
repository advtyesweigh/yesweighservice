import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { InvoiceMachineQcPanel } from '../../components/invoices/InvoiceMachineQcPanel';
import { useAuth } from '../../context/AuthContext';
import type { InvoiceDetailOutletContext } from './invoiceDetailContext';

export const InvoiceQcPage: React.FC = () => {
  const { user } = useAuth();
  const { invoice, invoiceId } = useOutletContext<InvoiceDetailOutletContext>();
  if (!invoice) return null;
  const customerId = user?.zohoCustomerId?.trim() || '';
  return (
    <InvoiceMachineQcPanel
      invoiceId={invoiceId}
      customerId={customerId}
      salesOrderId={invoice.salesOrderId}
      invoiceNumber={invoice.invoiceNumber}
      canEdit={false}
    />
  );
};
