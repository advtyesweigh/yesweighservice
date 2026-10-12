import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import type { DealerInvoiceDetail } from '../../types/invoices';
import type { LogisticsBooking } from '../../types/logistics-dispatch';
import type { StaffLogisticsSite } from '../../types/staff-logistics';

export interface AdminInvoiceDetailOutletContext {
  invoice: DealerInvoiceDetail | null;
  loading: boolean;
  error: string;
  customerId: string;
  invoiceId: string;
  invoicesPath: string;
  /** Show Manual Logistics under the item list (ops, no booking yet). */
  showManualLogistics: boolean;
  manualLogisticsPartnerId: LogisticsPartnerId;
  /** True when partner came from an invoice freight SKU (picker locked). */
  manualLogisticsPartnerFromFreight: boolean;
  manualLogisticsShipFrom: StaffLogisticsSite | null;
  onOpenManualLogistics: () => void;
  showMarkDelivered: boolean;
  onOpenMarkDelivered: () => void;
  existingBooking: LogisticsBooking | null;
  /** Ops: salesperson chip on the title toggles the full KAM card. */
  kamCardOpen?: boolean;
  /** Super admin: local courier switch on the freight line (not pushed to Zoho). */
  canEditLocalFreight?: boolean;
  localFreightBusy?: boolean;
  localFreightError?: string;
  onChangeLocalFreight?: (sku: import('../../lib/invoiceLocalFreight').LocalFreightSelectSku) => void;
  reloadInvoice?: () => Promise<void>;
  qcPhotoCount?: number;
  needsMandatoryQc?: boolean;
}
