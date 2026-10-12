import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { InvoiceMachineQcPanel } from '../../components/invoices/InvoiceMachineQcPanel';
import { useAuth } from '../../context/AuthContext';
import { canSuperAdminWrite } from '../../lib/staffAccess';
import type { AdminInvoiceDetailOutletContext } from './adminInvoiceDetailContext';

export const AdminInvoiceQcPage: React.FC = () => {
  const { user } = useAuth();
  const { invoice, customerId, invoiceId } = useOutletContext<AdminInvoiceDetailOutletContext>();
  if (!invoice) return null;
  const canEdit = user?.role === 'warehouse'
    || user?.role === 'staff'
    || canSuperAdminWrite(user);
  return (
    <InvoiceMachineQcPanel
      invoiceId={invoiceId}
      customerId={customerId}
      salesOrderId={invoice.salesOrderId}
      invoiceNumber={invoice.invoiceNumber}
      canEdit={canEdit}
    />
  );
};
