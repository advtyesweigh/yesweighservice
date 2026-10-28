import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { app, auth, db, storage } from '../firebase';
import type { AdminSalesOrderDetail, DealerCustomerInvoice } from './admin-sales-orders';
import { dealerOrderErrorMessage } from './dealerOrders';
import { formatStorageUploadError } from './storageErrors';
import {
  shippingSelectionPayload,
  type ShippingSelection,
} from './shippingAddresses';
import type { SpareFreightPackaging } from './spareFreightQuote';

const DEALER_INVOICE_PREFIX = 'sales-order-dealer-invoices';
const MAX_DEALER_INVOICE_BYTES = 8 * 1024 * 1024;

const functions = getFunctions(app, 'asia-south1');

export type YesOneSalesOrderStage =
  | 'review'
  | 'ready_for_payment'
  | 'payment_submitted'
  | 'completed'
  | 'void';

export type YesOneStageAudience = 'dealer' | 'admin';

/** Filter chips for YesOne workflow stages (list UI). */
export type YesOneStageFilter =
  | 'review'
  | 'ready_for_payment'
  | 'payment_submitted'
  | 'completed';

export const YESONE_STAGE_FILTERS: YesOneStageFilter[] = [
  'payment_submitted',
  'review',
  'ready_for_payment',
  'completed',
];

/** @deprecated Prefer yesOneStageLabelForAudience — kept for shared/fallback copy. */
export const YESONE_STAGE_LABELS: Record<YesOneSalesOrderStage, string> = {
  review: 'Order placed',
  ready_for_payment: 'Awaiting payment',
  payment_submitted: 'Payment submitted',
  completed: 'Completed',
  void: 'Void',
};

export const YESONE_STAGE_LABELS_DEALER: Record<YesOneSalesOrderStage, string> = {
  review: 'submitted',
  ready_for_payment: 'payment due',
  payment_submitted: 'under review',
  completed: 'invoiced',
  void: 'Void',
};

export const YESONE_STAGE_LABELS_ADMIN: Record<YesOneSalesOrderStage, string> = {
  review: 'new order',
  ready_for_payment: 'Awaiting payment',
  payment_submitted: 'pending approval',
  completed: 'invoiced',
  void: 'Void',
};

export function yesOneStageLabel(stage: string | null | undefined): string {
  if (!stage) return '';
  return YESONE_STAGE_LABELS[stage as YesOneSalesOrderStage] ?? stage;
}

export function yesOneStageLabelForAudience(
  stage: string | null | undefined,
  audience: YesOneStageAudience,
): string {
  if (!stage) return '';
  const key = stage as YesOneSalesOrderStage;
  if (audience === 'dealer') {
    return YESONE_STAGE_LABELS_DEALER[key] ?? stage;
  }
  return YESONE_STAGE_LABELS_ADMIN[key] ?? stage;
}

export function yesOneStageStatusClass(stage: string | null | undefined): string {
  const key = String(stage || '').trim();
  if (key === 'review') return 'invoices-status invoices-status--draft so-status--yesone-review';
  if (key === 'ready_for_payment') {
    return 'invoices-status invoices-status--overdue so-status--yesone-pay';
  }
  if (key === 'payment_submitted') {
    return 'invoices-status invoices-status--partially_paid so-status--yesone-verify';
  }
  if (key === 'completed') return 'invoices-status invoices-status--paid so-status--yesone-done';
  if (key === 'invoicing_mismatch') {
    return 'invoices-status invoices-status--partially_paid so-status--yesone-mismatch';
  }
  if (key === 'void') return 'invoices-status invoices-status--void so-status--yesone-void';
  return 'invoices-status invoices-status--draft';
}

/** True when YesOne completed and a Zoho invoice is linked (verify or manual mark). */
export function isSalesOrderInvoicingComplete(input: {
  yesOneStage?: string | null;
  zohoInvoiceId?: string | null;
  paymentVerifiedAt?: string | null;
}): boolean {
  if (String(input.yesOneStage || '').trim() !== 'completed') return false;
  if (String(input.zohoInvoiceId || '').trim()) return true;
  // Legacy verified orders should always have both fields; treat as complete if verified.
  return Boolean(String(input.paymentVerifiedAt || '').trim());
}

/** Completed in YesOne but no invoice was ever linked — false "invoiced" state. */
export function isSalesOrderInvoicingMismatch(input: {
  yesOneStage?: string | null;
  zohoInvoiceId?: string | null;
  paymentVerifiedAt?: string | null;
}): boolean {
  return String(input.yesOneStage || '').trim() === 'completed'
    && !isSalesOrderInvoicingComplete(input);
}

/** Stage key for badges / filters — surfaces mismatch instead of false "invoiced". */
export function effectiveYesOneStageForDisplay(input: {
  yesOneStage?: string | null;
  zohoInvoiceId?: string | null;
  paymentVerifiedAt?: string | null;
}): string {
  if (isSalesOrderInvoicingMismatch(input)) return 'invoicing_mismatch';
  return String(input.yesOneStage || '').trim();
}

export function yesOneStageLabelForInvoicingDisplay(
  input: {
    yesOneStage?: string | null;
    zohoInvoiceId?: string | null;
    paymentVerifiedAt?: string | null;
  },
  audience: YesOneStageAudience,
): string {
  const stage = effectiveYesOneStageForDisplay(input);
  if (stage === 'invoicing_mismatch') {
    return audience === 'dealer' ? 'processing issue' : 'invoicing incomplete';
  }
  return yesOneStageLabelForAudience(stage, audience);
}

const BLOCKED_YESONE_EDIT_STAGES = new Set<YesOneSalesOrderStage | string>([
  'payment_submitted',
  'completed',
  'void',
]);

const BLOCKED_ZOHO_EDIT_STATUSES = new Set([
  'void',
  'cancelled',
  'canceled',
  'closed',
  'invoiced',
]);

const OPEN_ZOHO_EDIT_STATUSES = new Set([
  'draft',
  'pending',
  'open',
  'confirmed',
  'approved',
]);

export function normalizeSalesOrderZohoStatus(status: string | null | undefined): string {
  return String(status || '').toLowerCase().replace(/\s+/g, '_');
}

/** Whether lines/shipping on a portal SO can still be edited. */
/**
 * Creating salesperson may attach a payment screenshot on their Cloud / Spare order
 * once it is awaiting payment (after Spare Incharge approval, or immediately for Cloud).
 */
export function staffCanAttachCreatorPaymentProof(input: {
  uid?: string | null;
  role?: string | null;
  createdByUid?: string | null;
  segment?: string | null;
  category?: string | null;
  stage?: string | null;
}): boolean {
  if (input.role !== 'staff') return false;
  const uid = String(input.uid ?? '').trim();
  const createdBy = String(input.createdByUid ?? '').trim();
  if (!uid || uid !== createdBy) return false;
  const segment = String(input.segment ?? '').trim();
  const category = String(input.category ?? '').trim();
  const cloudOrSpare = segment === 'spare'
    || segment === 'software'
    || category === 'spare'
    || category === 'software_key';
  if (!cloudOrSpare) return false;
  const stage = String(input.stage ?? '').trim();
  return stage === 'ready_for_payment' || stage === 'payment_submitted';
}

export function canEditSalesOrderDraft(input: {
  role?: string | null;
  yesOneStage?: string | null;
  zohoStatus?: string | null;
}): boolean {
  const stage = String(input.yesOneStage || '').trim();
  if (BLOCKED_YESONE_EDIT_STAGES.has(stage)) return false;

  const role = String(input.role || '').trim();
  const isDealer = role === 'dealer' || role === 'dealer_staff';
  // Payment due: dealers are locked; staff/admin may still adjust the draft.
  if (isDealer && stage === 'ready_for_payment') return false;

  const zoho = normalizeSalesOrderZohoStatus(input.zohoStatus);
  if (BLOCKED_ZOHO_EDIT_STATUSES.has(zoho)) return false;

  return OPEN_ZOHO_EDIT_STATUSES.has(zoho) || !zoho;
}

export interface SalesOrderWorkflowDetail extends AdminSalesOrderDetail {
  yesOneStage: YesOneSalesOrderStage | string | null;
  paymentAmount: number | null;
  paymentUtr: string | null;
  paymentNotes: string | null;
  paymentScreenshotStoragePath: string | null;
  paymentScreenshotUrl: string | null;
  dealerCustomerInvoice?: DealerCustomerInvoice | null;
  paymentSubmittedAt: string | null;
  paymentVerifiedAt: string | null;
  readyForPaymentAt: string | null;
  readyForPaymentByName: string | null;
  zohoInvoiceId: string | null;
  zohoInvoiceNumber: string | null;
  yesOneSyncError: string | null;
  manuallyMarkedInvoicedAt: string | null;
}

async function call<TReq, TRes>(name: string, data?: TReq, timeout = 60_000): Promise<TRes> {
  const callable = httpsCallable<TReq | undefined, TRes>(functions, name, { timeout });
  const result = await callable(data);
  return result.data;
}

export async function updateDraftSalesOrderLines(
  salesOrderId: string,
  lines: Array<{
    productId: string;
    quantity: number;
    /** Staff: base product rate (server adds GATC / QC fees). */
    rate?: number;
    gatcStampingPriceId?: string | null;
    qcEnabled?: boolean;
  }>,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('updateDraftSalesOrderLines', { salesOrderId, lines }, 180_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function createStaffSalesOrder(input: {
  zohoCustomerId: string;
  lines: Array<{
    productId: string;
    quantity: number;
    /** Staff: base product rate (server adds GATC / QC fees). */
    rate?: number;
    gatcStampingPriceId?: string | null;
    qcEnabled?: boolean;
  }>;
  shipping: ShippingSelection;
  stage: 'review' | 'ready_for_payment';
  remarks?: string;
  /** Full super admin product SO: preferred Zoho salesperson (defaults to theirs in UI; changeable). */
  salespersonId?: string | null;
  /** Courier choice per ship-from site (server builds freight lines). */
  courierBySite?: Partial<Record<'cochin' | 'head_office', string>>;
  /** Freight charge plan zone (kerala / tamil_nadu_pondy / other_states). */
  freightZone?: string;
  freightZoneOverrideReason?: string;
  /**
   * Manual freight ₹ for partners without a rate card (e.g. Delhivery TBD).
   * Applied only when a manual-rate partner is selected.
   */
  manualFreightAmountInr?: number;
  /** Delhivery freight billing: btc (default) or fod (₹0 on order). */
  freightBillingMode?: 'fod' | 'btc';
}): Promise<{
  zohoSalesOrderId: string | null;
  zohoSalesOrderNumber: string | null;
  orderNumber: string;
  yesOneStage: string;
  subtotal: number;
  priceCustomized: boolean;
  salesOrders?: Array<{
    segment: 'product' | 'spare' | 'software';
    segmentLabel: string;
    inventorySite?: 'cochin' | 'head_office' | null;
    branchLabel?: string | null;
    bucketLabel?: string | null;
    orderNumber: string;
    zohoSalesOrderId: string;
    zohoSalesOrderNumber: string | null;
    status: string;
    subtotal: number;
    itemCount: number;
    salespersonId: string | null;
    salespersonName: string | null;
    yesOneStage?: string;
  }>;
}> {
  try {
    return await call(
      'createStaffSalesOrder',
      {
        zohoCustomerId: input.zohoCustomerId,
        lines: input.lines,
        shipping: shippingSelectionPayload(input.shipping),
        stage: input.stage,
        remarks: input.remarks ?? '',
        ...(input.salespersonId?.trim()
          ? { salespersonId: input.salespersonId.trim() }
          : {}),
        ...(input.courierBySite ? { courierBySite: input.courierBySite } : {}),
        ...(input.freightZone ? { freightZone: input.freightZone } : {}),
        ...(input.freightZoneOverrideReason?.trim()
          ? { freightZoneOverrideReason: input.freightZoneOverrideReason.trim() }
          : {}),
        ...(input.manualFreightAmountInr != null
          && Number.isFinite(input.manualFreightAmountInr)
          && input.manualFreightAmountInr >= 0
          ? { manualFreightAmountInr: Math.round(input.manualFreightAmountInr * 100) / 100 }
          : {}),
        ...(input.freightBillingMode === 'fod' || input.freightBillingMode === 'btc'
          ? { freightBillingMode: input.freightBillingMode }
          : {}),
      },
      180_000,
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function updateDraftSalesOrderShipping(
  salesOrderId: string,
  shipping: ShippingSelection,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call(
      'updateDraftSalesOrderShipping',
      { salesOrderId, shipping: shippingSelectionPayload(shipping) },
      120_000,
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function updateDraftSalesOrderSparePackaging(
  salesOrderId: string,
  sparePackaging: SpareFreightPackaging[],
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call(
      'updateDraftSalesOrderSparePackaging',
      { salesOrderId, sparePackaging },
      120_000,
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function markSalesOrderReadyForPayment(
  salesOrderId: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('markSalesOrderReadyForPayment', { salesOrderId });
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function uploadSalesOrderPaymentScreenshot(
  salesOrderId: string,
  file: File,
): Promise<{ storagePath: string; url: string }> {
  const dataBase64 = await fileToBase64(file);
  try {
    return await call(
      'uploadSalesOrderPaymentScreenshotFn',
      {
        salesOrderId,
        contentType: file.type || 'image/jpeg',
        dataBase64,
        fileName: file.name,
      },
      120_000,
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

function sanitizeDealerInvoiceFileName(name: string): string {
  const raw = String(name || 'dealer-invoice.pdf').trim() || 'dealer-invoice.pdf';
  const fileName = raw.replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
  return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
}

async function assertDealerInvoicePdf(file: File): Promise<void> {
  const isPdf = file.type === 'application/pdf'
    || file.type === 'application/octet-stream'
    || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error('Upload a PDF sales invoice.');
  if (file.size > MAX_DEALER_INVOICE_BYTES) throw new Error('PDF must be 8 MB or smaller.');
  const header = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
  if (!header.startsWith('%PDF')) throw new Error('File is not a PDF.');
}

export async function uploadSalesOrderDealerCustomerInvoice(
  salesOrderId: string,
  file: File,
): Promise<DealerCustomerInvoice> {
  const id = String(salesOrderId || '').trim();
  if (!id) throw new Error('Sales order is required.');
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to upload the invoice PDF.');
  await assertDealerInvoicePdf(file);

  const token = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    : Date.now().toString(36);
  const storagePath = `${DEALER_INVOICE_PREFIX}/${id}/${Date.now()}_${token}.pdf`;
  try {
    await uploadBytes(ref(storage, storagePath), file, { contentType: 'application/pdf' });
  } catch (err) {
    throw new Error(formatStorageUploadError(err, 'Could not upload the invoice PDF.'));
  }

  let url = '';
  try {
    url = await getDownloadURL(ref(storage, storagePath));
  } catch (err) {
    throw new Error(formatStorageUploadError(err, 'Could not read the uploaded invoice PDF.'));
  }

  const uploadedAt = new Date().toISOString();
  const invoice: DealerCustomerInvoice = {
    storagePath,
    url,
    fileName: sanitizeDealerInvoiceFileName(file.name),
    uploadedAt,
    uploadedByUid: user.uid,
    uploadedByName: user.displayName?.trim() || user.email?.trim() || 'Portal user',
  };

  try {
    await updateDoc(doc(db, 'salesOrders', id), {
      dealerCustomerInvoice: invoice,
      yesOneUpdatedAt: uploadedAt,
    });
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
  return invoice;
}

export async function removeSalesOrderDealerCustomerInvoice(
  salesOrderId: string,
): Promise<void> {
  const id = String(salesOrderId || '').trim();
  if (!id) throw new Error('Sales order is required.');
  try {
    await updateDoc(doc(db, 'salesOrders', id), {
      dealerCustomerInvoice: deleteField(),
      yesOneUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function attachDealerCustomerInvoiceToSalesOrders(
  salesOrderIds: string[],
  file: File,
): Promise<void> {
  const ids = [...new Set(salesOrderIds.map(id => String(id || '').trim()).filter(Boolean))];
  let uploaded = 0;
  let lastError: Error | null = null;
  for (const id of ids) {
    try {
      await uploadSalesOrderDealerCustomerInvoice(id, file);
      uploaded += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (uploaded === 0 && lastError) throw lastError;
}

export async function submitSalesOrderPayment(input: {
  salesOrderId: string;
  paymentScreenshotStoragePath?: string | null;
  paymentNotes?: string | null;
  paymentUtr?: string;
}): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('submitSalesOrderPayment', input, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function verifySalesOrderPayment(
  salesOrderId: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('verifySalesOrderPayment', { salesOrderId }, 180_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

/** Callable detail when Mark as invoiced finds no Zoho invoice. */
export const MARK_INVOICED_NO_ZOHO_INVOICE = 'mark_invoiced_no_zoho_invoice';

export class SalesOrderWorkflowError extends Error {
  readonly workflowCode?: string;

  constructor(message: string, workflowCode?: string) {
    super(message);
    this.name = 'SalesOrderWorkflowError';
    this.workflowCode = workflowCode;
  }
}

function callableWorkflowErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const details = (err as { details?: unknown }).details;
  if (details && typeof details === 'object' && 'code' in details) {
    const code = String((details as { code?: string }).code || '').trim();
    return code || undefined;
  }
  return undefined;
}

export function isMarkInvoicedNoZohoInvoiceError(err: unknown): boolean {
  if (err instanceof SalesOrderWorkflowError) {
    return err.workflowCode === MARK_INVOICED_NO_ZOHO_INVOICE;
  }
  const directCode = callableWorkflowErrorCode(err);
  if (directCode === MARK_INVOICED_NO_ZOHO_INVOICE) return true;
  const message = err instanceof Error ? err.message : dealerOrderErrorMessage(err);
  const lower = message.toLowerCase();
  return lower.includes('no invoice is linked to this sales order in zoho')
    || lower.includes('could not confirm a zoho invoice for this sales order');
}

/** Portal steps to show when Mark as invoiced fails (no Zoho invoice yet). */
export function markInvoicedPortalRouteSteps(
  yesOneStage: string | null | undefined,
): string[] {
  const stage = String(yesOneStage || '').trim() || 'review';
  const steps: string[] = [];
  if (stage === 'review') {
    steps.push('Staff: mark the order Ready for payment.');
  }
  if (stage !== 'payment_submitted') {
    steps.push('Submit payment proof on this page (dealer upload or staff payment screenshot / note).');
  }
  steps.push('Safna or Shalima: use Verify & invoice to confirm payment and create the Zoho invoice and e-invoice.');
  return steps;
}

/** Mark SO completed/invoiced here after it was already processed in Zoho. */
export async function markSalesOrderInvoicedManually(
  salesOrderId: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('markSalesOrderInvoicedManually', { salesOrderId }, 120_000);
  } catch (err) {
    throw new SalesOrderWorkflowError(
      dealerOrderErrorMessage(err),
      callableWorkflowErrorCode(err),
    );
  }
}

/** Reset false completed state (completed without linked Zoho invoice). */
export async function repairSalesOrderInvoicingMismatch(
  salesOrderId: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('repairSalesOrderInvoicingMismatch', { salesOrderId }, 60_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

/** Copy dealer assigned staff → Zoho salesperson onto this SO (Zoho + Firestore). */
export async function applySalesOrderSalespersonFromDealer(
  salesOrderId: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('applySalesOrderSalespersonFromDealer', { salesOrderId }, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

/** Apply a portal staff member's Zoho salesperson onto this SO. */
export async function applySalesOrderSalespersonFromStaff(
  salesOrderId: string,
  staffUid: string,
): Promise<SalesOrderWorkflowDetail> {
  try {
    return await call('applySalesOrderSalespersonFromStaff', { salesOrderId, staffUid }, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

/** Delete a Draft SO in Zoho and remove the portal mirror. */
export async function deleteDraftSalesOrder(
  salesOrderId: string,
): Promise<{ salesOrderId: string; deleted: boolean }> {
  try {
    return await call('deleteDraftSalesOrder', { salesOrderId }, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}
