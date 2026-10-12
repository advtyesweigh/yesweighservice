import type { DealerInvoiceDetail } from '../../types/invoices';

export interface InvoiceDetailOutletContext {
  invoice: DealerInvoiceDetail | null;
  loading: boolean;
  error: string;
  invoiceId: string;
  invoicesPath: string;
  qcPhotoCount?: number;
}
