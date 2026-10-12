import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ClipboardCheck, ClipboardList, FileText, Hash, MapPin, UserRound } from 'lucide-react';
import { FetchingLoader } from '../../components/FetchingLoader';
import { SpareOrderListViewDialog } from '../../components/invoices/SpareOrderListViewDialog';
import { BookCourierEntryButton } from '../../components/logistics/BookCourierEntryButton';
import {
  DelhiveryDocumentDialog,
  type DelhiveryDocumentDialogPayload,
} from '../../components/logistics/DelhiveryDocumentDialog';
import { DelhiveryQuoteStrip } from '../../components/logistics/DelhiveryQuoteStrip';
import { EwayBillIcon } from '../../components/logistics/EwayBillIcon';
import { InvoiceAddLrDialog } from '../../components/logistics/InvoiceAddLrDialog';
import { InvoiceCustomerPickupDialog } from '../../components/logistics/InvoiceCustomerPickupDialog';
import { InvoiceMarkDeliveredDialog } from '../../components/logistics/InvoiceMarkDeliveredDialog';
import { LogisticsAwbEntryButton } from '../../components/logistics/LogisticsAwbEntryButton';
import { useAuth } from '../../context/AuthContext';
import { useCatalogPageHeader, usePageHeaderTitleMeta } from '../../context/PageHeaderContext';
import {
  fetchAdminInvoiceDetail,
} from '../../lib/admin-invoices';
import { fetchCatalog } from '../../lib/catalog';
import { pinFromText } from '../../lib/delhiveryQuote';
import { ensureInvoiceEwayBill, type InvoiceEwayBillResult } from '../../lib/invoiceEwayBill';
import {
  formatInvoiceDate,
  invoiceErrorMessage,
  invoiceHasCategory,
  invoiceHasNoCourierFreightLine,
  freightSkuFromInvoiceLines,
} from '../../lib/invoices';
import {
  canCreateLogisticsBooking,
  findLogisticsBookingForInvoice,
} from '../../lib/logisticsBookings';
import {
  buildInvoiceBookingDraftPatch,
  canBookCourierForInvoice,
  canRecordInvoiceLogisticsLr,
  resolveInvoiceCourierPartner,
  type LogisticsEntryState,
} from '../../lib/logisticsPrefill';
import { invoiceNeedsMandatorySerials } from '../../lib/invoiceSerialGate';
import { loadLogisticsSettings } from '../../lib/logisticsSettings';
import { resolveInvoiceShipFromSiteOrDefault, shipFromSiteLabel } from '../../lib/logisticsShipFrom';
import {
  canMarkInvoiceCustomerPickup,
  isInvoiceCustomerPickup,
  rememberInvoiceCustomerPickup,
  updateCustomerPickupEwayPartB,
} from '../../lib/invoiceCustomerPickup';
import {
  canMarkInvoiceDelivered,
  isInvoiceManuallyDelivered,
  rememberInvoiceManualDelivery,
} from '../../lib/invoiceManualDelivery';
import { isInvoiceLocalFreightPickup, setInvoiceLocalFreightPartner, type LocalFreightSelectSku } from '../../lib/invoiceLocalFreight';
import { base64ToUint8Array } from '../../lib/pdfViewer';
import { canSuperAdminWrite, isInternalOpsUser } from '../../lib/staffAccess';
import {
  bookingInvoiceEwayRow,
  clubbedNeedsEwayBill,
  ewayBillIsReady,
  invoiceNeedsEwayBillCard,
} from '../../constants/ewayBill';
import type { CatalogProduct } from '../../types/catalog';
import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import type { DealerInvoiceDetail } from '../../types/invoices';
import type { LogisticsBooking } from '../../types/logistics-dispatch';
import type { StaffLogisticsSite } from '../../types/staff-logistics';
import { canNavigateBackInApp } from '../../lib/navigation';
import { documentLooksLikeMachineQc } from '../../lib/machineQc';
import {
  INVOICE_QC_REQUIRED,
  invoiceNeedsMandatoryQcPhotos,
  listenInvoiceMachineQc,
} from '../../lib/invoiceMachineQc';
import type { AdminInvoiceDetailOutletContext } from './adminInvoiceDetailContext';

export const AdminInvoiceDetailLayout: React.FC = () => {
  const { customerId = '', invoiceId = '' } = useParams<{
    customerId: string;
    invoiceId: string;
  }>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const invoicesPath = pathname.startsWith('/staff') ? '/staff/invoices' : '/super-admin/invoices';
  const invoiceSummaryPath = `${invoicesPath}/${customerId}/${invoiceId}/invoice`;
  const isPdfView = pathname.endsWith('/invoice/view');
  const isQcView = pathname.endsWith('/qc');

  const [invoice, setInvoice] = useState<DealerInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [courierEntry, setCourierEntry] = useState<LogisticsEntryState | null>(null);
  const [existingBooking, setExistingBooking] = useState<LogisticsBooking | null>(null);
  const [addLrAvailable, setAddLrAvailable] = useState(false);
  const [addLrPartnerId, setAddLrPartnerId] = useState<LogisticsPartnerId>('delhivery');
  const [addLrPartnerFromFreight, setAddLrPartnerFromFreight] = useState(false);
  const [addLrShipFrom, setAddLrShipFrom] = useState<StaffLogisticsSite | null>(null);
  const [addLrOpen, setAddLrOpen] = useState(false);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [deliveredOpen, setDeliveredOpen] = useState(false);
  const [pickupShipFrom, setPickupShipFrom] = useState<StaffLogisticsSite>('cochin');
  const [pickupShipFromLabel, setPickupShipFromLabel] = useState('Cochin');
  const [orderListOpen, setOrderListOpen] = useState(false);
  const [delhiveryOriginPin, setDelhiveryOriginPin] = useState('');
  const [ewayDocOpening, setEwayDocOpening] = useState(false);
  const [ewayDocError, setEwayDocError] = useState('');
  const [ewayDocDialog, setEwayDocDialog] = useState<DelhiveryDocumentDialogPayload | null>(null);
  const [kamCardOpen, setKamCardOpen] = useState(false);
  const [qcPhotoCount, setQcPhotoCount] = useState(0);
  const [localFreightBusy, setLocalFreightBusy] = useState(false);
  const [localFreightError, setLocalFreightError] = useState('');
  const showKamOnTitle = Boolean(user && isInternalOpsUser(user) && !isPdfView);

  const handleBack = useCallback(() => {
    if (isPdfView) {
      if (canNavigateBackInApp()) {
        navigate(-1);
      } else {
        navigate(invoiceSummaryPath, { replace: true });
      }
      return;
    }
    navigate(invoicesPath);
  }, [isPdfView, navigate, invoiceSummaryPath, invoicesPath]);

  useCatalogPageHeader({
    title: invoice?.invoiceNumber ?? 'Invoice',
    subtitle: invoice?.date ? formatInvoiceDate(invoice.date) : null,
    showBack: true,
    onBack: handleBack,
  });

  const titleMeta = useMemo(() => {
    if (!invoice || !showKamOnTitle) return null;
    const salespersonLabel = String(invoice.salespersonName || '').trim()
      || (String(invoice.salespersonId || '').trim() ? 'Sales staff' : 'No staff');
    const missingSalesperson = !String(invoice.salespersonId || '').trim();
    return (
      <button
        type="button"
        className={[
          'page-title__salesperson',
          missingSalesperson ? 'is-missing' : '',
          kamCardOpen ? 'is-open' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => setKamCardOpen(open => !open)}
        aria-expanded={kamCardOpen}
        aria-label={kamCardOpen ? 'Hide sales staff card' : 'Show sales staff card'}
      >
        <UserRound size={11} aria-hidden />
        <span>{salespersonLabel}</span>
      </button>
    );
  }, [invoice, showKamOnTitle, kamCardOpen]);

  usePageHeaderTitleMeta(titleMeta, Boolean(titleMeta));

  useEffect(() => {
    let cancelled = false;
    void loadLogisticsSettings()
      .then((settings) => {
        if (cancelled) return;
        const pin = pinFromText(
          settings.fromAddresses?.cochin || settings.fromAddresses?.head_office || '',
        );
        setDelhiveryOriginPin(pin);
      })
      .catch(() => { /* optional */ });
    return () => { cancelled = true; };
  }, []);

  const loadInvoice = useCallback(async () => {
    if (!customerId || !invoiceId) return;
    const data = await fetchAdminInvoiceDetail(customerId, invoiceId);
    setInvoice(data);
    if (isInvoiceCustomerPickup(data)) rememberInvoiceCustomerPickup(data.id || invoiceId);
    if (isInvoiceManuallyDelivered(data)) rememberInvoiceManualDelivery(data.id || invoiceId);
  }, [customerId, invoiceId]);

  useEffect(() => {
    if (!customerId || !invoiceId) return;
    let cancelled = false;

    setLoading(true);
    setError('');

    loadInvoice()
      .then(() => {
        if (!cancelled) setError('');
      })
      .catch(err => {
        if (!cancelled) {
          setInvoice(null);
          setError(invoiceErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [customerId, invoiceId, loadInvoice]);

  /** Existing AWB booking wins; else Book Courier (or Add LR when a freight line exists). */
  useEffect(() => {
    if (!invoice || !customerId || !invoiceId || !user) {
      setCourierEntry(null);
      setExistingBooking(null);
      setAddLrAvailable(false);
      return;
    }
    if (!isInternalOpsUser(user)) {
      setCourierEntry(null);
      setExistingBooking(null);
      setAddLrAvailable(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const linked = await findLogisticsBookingForInvoice(invoiceId).catch(() => null);
      if (cancelled) return;
      if (linked) {
        setExistingBooking(linked);
        setCourierEntry(null);
        setAddLrAvailable(false);
        return;
      }
      setExistingBooking(null);

      const branch = await resolveInvoiceShipFromSiteOrDefault(invoice);
      const shipFromSite = branch.site;
      if (cancelled) return;
      setAddLrShipFrom(shipFromSite);
      setPickupShipFrom(shipFromSite);
      setPickupShipFromLabel(branch.branchLabel);

      const courierPartner = resolveInvoiceCourierPartner(invoice);
      setAddLrPartnerId(courierPartner.partnerId);
      setAddLrPartnerFromFreight(courierPartner.fromFreight);

      const canCreate = canCreateLogisticsBooking(user);
      setAddLrAvailable(canCreate && canRecordInvoiceLogisticsLr(invoice));

      if (
        !canCreate
        || !canBookCourierForInvoice(invoice)
        || invoiceNeedsMandatoryQcPhotos(invoice, qcPhotoCount)
      ) {
        setCourierEntry(null);
        return;
      }
      let productsById: Map<string, CatalogProduct> | undefined;
      try {
        const catalog = await fetchCatalog();
        productsById = new Map(catalog.items.map(item => [item.id, item]));
      } catch {
        // Still allow booking with partner + dealer even if catalog dims fail.
      }
      if (cancelled) return;
      setCourierEntry({
        draftPatch: buildInvoiceBookingDraftPatch(
          invoice,
          invoiceId,
          customerId,
          customerId,
          {
            productsById,
            shipFromSite,
            partnerId: courierPartner.partnerId,
          },
        ),
        dealerQuery: invoice.customerName ?? undefined,
        lockPartner: courierPartner.fromFreight,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [invoice, customerId, invoiceId, user, qcPhotoCount]);

  const handleChangeLocalFreight = useCallback(async (sku: LocalFreightSelectSku) => {
    if (!invoice || !customerId || !invoiceId) return;
    setLocalFreightBusy(true);
    setLocalFreightError('');
    try {
      const result = await setInvoiceLocalFreightPartner({
        customerId,
        invoiceId,
        sku,
      });
      setInvoice(prev => (prev ? {
        ...prev,
        yesOneFreightPartner: result.yesOneFreightPartner,
        freightSku: result.yesOneFreightPartner?.sku
          || freightSkuFromInvoiceLines(prev.lineItems)
          || prev.freightSku,
      } : prev));
    } catch (err) {
      setLocalFreightError(
        err instanceof Error ? err.message : 'Could not update local logistics partner.',
      );
    } finally {
      setLocalFreightBusy(false);
    }
  }, [customerId, invoice, invoiceId]);

  if (!customerId || !invoiceId) return null;

  const needsMandatorySerials = invoiceNeedsMandatorySerials(invoice?.lineItems);
  const needsMandatoryQc = invoiceNeedsMandatoryQcPhotos(invoice, qcPhotoCount);
  const showManualLogistics = Boolean(
    addLrAvailable
    && !existingBooking
    && !isInvoiceCustomerPickup(invoice)
    && !isInvoiceLocalFreightPickup(invoice)
    && !invoice?.sourceSalesOrderIsPickup
    && !invoiceHasNoCourierFreightLine(invoice)
    && !isInvoiceManuallyDelivered(invoice),
  );
  const customerPickupActive = isInvoiceCustomerPickup(invoice);
  const manualDeliveredActive = Boolean(
    invoice && (
      isInvoiceManuallyDelivered(invoice)
      || existingBooking?.status === 'delivered'
    ),
  );
  const showMarkDelivered = Boolean(
    user
    && isInternalOpsUser(user)
    && canCreateLogisticsBooking(user)
    && invoice
    && canMarkInvoiceDelivered(invoice, existingBooking)
    && !needsMandatoryQc,
  );
  const showCustomerPickup = Boolean(
    user
    && isInternalOpsUser(user)
    && canCreateLogisticsBooking(user)
    && invoice
    && canMarkInvoiceCustomerPickup(invoice, Boolean(existingBooking))
    && !needsMandatoryQc,
  );
  const canEditLocalFreight = Boolean(
    canSuperAdminWrite(user)
    && invoice
    && !existingBooking
    && !isInvoiceCustomerPickup(invoice)
    && !invoice.sourceSalesOrderIsPickup
    && !invoiceHasNoCourierFreightLine(invoice)
    && String(invoice.status ?? '').toLowerCase() !== 'void',
  );
  const outletContext: AdminInvoiceDetailOutletContext = {
    invoice,
    loading,
    error,
    customerId,
    invoiceId,
    invoicesPath,
    showManualLogistics,
    manualLogisticsPartnerId: addLrPartnerId,
    manualLogisticsPartnerFromFreight: addLrPartnerFromFreight,
    manualLogisticsShipFrom: addLrShipFrom,
    onOpenManualLogistics: () => setAddLrOpen(true),
    showMarkDelivered,
    onOpenMarkDelivered: () => setDeliveredOpen(true),
    existingBooking,
    kamCardOpen,
    canEditLocalFreight,
    localFreightBusy,
    localFreightError,
    onChangeLocalFreight: handleChangeLocalFreight,
    reloadInvoice: loadInvoice,
    qcPhotoCount,
    needsMandatoryQc,
  };

  // Shared picking list for product/spare invoices — ops (staff / super admin) only.
  const showOrderList = Boolean(
    user
    && isInternalOpsUser(user)
    && invoice
    && (
      invoiceHasCategory(invoice, 'product')
      || invoiceHasCategory(invoice, 'spare')
    ),
  );
  const showCourierCard = Boolean(
    courierEntry
    || existingBooking
    || customerPickupActive
    || manualDeliveredActive,
  );
  const bookingEwayRow = bookingInvoiceEwayRow(existingBooking, invoiceId);
  const showEwayCard = Boolean(
    invoice
    && invoiceNeedsEwayBillCard({
      invoice,
      booking: existingBooking,
      customerPickup: customerPickupActive,
    }),
  );
  const ewayBillNumberOnCard = invoice?.ewayBill?.ewaybillNumber?.trim()
    || bookingEwayRow?.ewayBillNumber?.trim()
    || '';
  const ewayBillReady = Boolean(
    ewayBillIsReady(invoice?.ewayBill?.status, ewayBillNumberOnCard)
    || ewayBillIsReady(bookingEwayRow?.ewayBillStatus, bookingEwayRow?.ewayBillNumber),
  );
  const showQcTile = Boolean(
    invoice
    && (
      documentLooksLikeMachineQc(invoice)
      || qcPhotoCount > 0
    ),
  );
  const qcComplete = qcPhotoCount >= INVOICE_QC_REQUIRED;

  useEffect(() => {
    if (!invoiceId) {
      setQcPhotoCount(0);
      return undefined;
    }
    return listenInvoiceMachineQc(invoiceId, doc => {
      setQcPhotoCount(doc?.images.length ?? 0);
    });
  }, [invoiceId]);

  const topCardCount = 1
    + (showOrderList ? 1 : 0)
    + (showCourierCard ? 1 : 0)
    + (showCustomerPickup ? 1 : 0)
    + (showEwayCard ? 1 : 0)
    + (showQcTile ? 1 : 0);
  const actionsLayout = topCardCount >= 4
    ? 'quad'
    : topCardCount === 3
      ? 'triple'
      : topCardCount === 2
        ? 'pair'
        : 'single';

  const showEwayFromResult = useCallback((result: InvoiceEwayBillResult) => {
    if (!result.required) {
      setEwayDocError(result.message || 'E-way bill is not required for this invoice.');
      return;
    }
    if (!result.contentBase64) {
      setEwayDocError(result.message || 'E-way bill is not ready yet.');
      return;
    }
    const bytes = base64ToUint8Array(result.contentBase64);
    const mimeType = result.mimeType || 'application/pdf';
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType });
    if (mimeType.includes('html')) {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    setEwayDocDialog({
      title: result.ewaybillNumber ? `E way bill ${result.ewaybillNumber}` : 'E way bill',
      contentType: mimeType,
      pdfBytes: bytes,
      fileName: result.filename || 'eway-bill.pdf',
      downloadBlob: blob,
      hideDownload: true,
    });
  }, []);

  const openInvoiceEwayBillDocument = useCallback(async () => {
    if (!invoice || !customerId || !invoiceId) return;
    setEwayDocOpening(true);
    setEwayDocError('');
    try {
      if (customerPickupActive) {
        const pickupVehicle = String(invoice.customerPickup?.vehicleNumber ?? '').trim();
        if (!pickupVehicle) {
          setEwayDocError(
            'Vehicle number is required to generate e-way bill Part B for customer pickup.',
          );
          return;
        }

        const pickupResult = await updateCustomerPickupEwayPartB({
          customerId,
          invoiceId,
          vehicleNumber: pickupVehicle,
        });
        if (pickupResult.customerPickup) {
          setInvoice(prev => prev ? {
            ...prev,
            customerPickup: pickupResult.customerPickup,
            ewayBill: pickupResult.eway?.status
              ? {
                ...(prev.ewayBill ?? {}),
                status: pickupResult.eway.status,
                ewaybillNumber: pickupResult.eway.ewaybillNumber ?? prev.ewayBill?.ewaybillNumber ?? null,
                required: pickupResult.eway.required,
              }
              : prev.ewayBill,
          } : prev);
        }
        if (pickupResult.eway) {
          showEwayFromResult(pickupResult.eway);
        } else {
          setEwayDocError('E-way bill is not ready yet.');
        }
        return;
      }

      const result = await ensureInvoiceEwayBill({
        customerId,
        invoiceId,
        partnerId: existingBooking?.partnerId
          || resolveInvoiceCourierPartner(invoice).partnerId,
        lrNumber: existingBooking?.consignmentNo?.trim() || existingBooking?.trackingNo?.trim() || null,
        bookingId: existingBooking?.id || null,
        invoiceTotalInr: invoice.total ?? null,
        autoGenerate: false,
        forceRequired: Boolean(
          existingBooking
          && clubbedNeedsEwayBill(existingBooking.invoices ?? existingBooking.invoiceValueInr ?? 0),
        ),
      });
      setInvoice(prev => prev ? {
        ...prev,
        ewayBill: {
          ...(prev.ewayBill ?? {}),
          status: result.status,
          ewaybillNumber: result.ewaybillNumber ?? prev.ewayBill?.ewaybillNumber ?? null,
          required: result.required,
          requiredBecause: existingBooking && clubbedNeedsEwayBill(
            existingBooking.invoices ?? existingBooking.invoiceValueInr ?? 0,
          )
            ? 'clubbed_lr'
            : (prev.ewayBill?.requiredBecause ?? 'invoice_total'),
        },
      } : prev);
      showEwayFromResult(result);
    } catch (err) {
      setEwayDocError(err instanceof Error ? err.message : 'Could not open e-way bill.');
    } finally {
      setEwayDocOpening(false);
    }
  }, [
    customerId,
    customerPickupActive,
    existingBooking,
    invoice,
    invoiceId,
    showEwayFromResult,
  ]);

  return (
    <div className={`page-content fade-in invoice-detail-page ${isPdfView ? 'invoice-detail-page--pdf-view' : ''}`}>
      {error && (
        <div className="products-inline-error panel glass invoice-detail-page__error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {loading && !invoice ? (
        <FetchingLoader label="Loading invoice…" />
      ) : !invoice ? (
        <div className="invoices-empty panel glass">
          <FileText size={36} aria-hidden />
          <h2>Invoice not found</h2>
          <p className="text-muted text-sm">This invoice may have been removed or is unavailable.</p>
        </div>
      ) : (
        <>
          {!isPdfView && (
            <div className="invoice-detail-top admin-invoice-detail-top">
              <div
                className={[
                  'invoice-detail-top__actions',
                  `invoice-detail-top__actions--${actionsLayout}`,
                ].join(' ')}
                role="tablist"
                aria-label="Invoice sections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isQcView}
                  className={[
                    'invoice-detail-top__card',
                    'invoice-detail-top__card--blue',
                    !isQcView ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => navigate(
                    `${invoicesPath}/${customerId}/${invoiceId}/invoice/view?fresh=${Date.now()}`,
                  )}
                >
                  <span className="invoice-detail-top__card-icon">
                    <FileText size={28} strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="invoice-detail-top__card-label">Invoice</span>
                  {invoice.dealerCustomerInvoice?.url ? (
                    <span className="invoice-detail-top__card-sub">Customer PDF</span>
                  ) : null}
                </button>
                {showQcTile ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isQcView}
                    className={[
                      'invoice-detail-top__card',
                      needsMandatoryQc
                        ? 'invoice-detail-top__card--amber'
                        : 'invoice-detail-top__card--qc',
                      isQcView || qcComplete ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    title={qcComplete
                      ? `QC photos · ${qcPhotoCount}/${INVOICE_QC_REQUIRED}`
                      : `QC photos are mandatory — upload ${INVOICE_QC_REQUIRED} before dispatch`}
                    onClick={() => navigate(`${invoicesPath}/${customerId}/${invoiceId}/qc`)}
                  >
                    <span className="invoice-detail-top__card-icon">
                      <ClipboardCheck size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">QC</span>
                    <span className="invoice-detail-top__card-sub">
                      {qcPhotoCount}/{INVOICE_QC_REQUIRED}
                    </span>
                  </button>
                ) : null}
                {showOrderList ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={orderListOpen}
                    className={[
                      'invoice-detail-top__card',
                      'invoice-detail-top__card--green',
                      orderListOpen ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setOrderListOpen(true)}
                    title="Open order / picking list PDF"
                  >
                    <span className="invoice-detail-top__card-icon">
                      <ClipboardList size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">Order list</span>
                  </button>
                ) : null}
                {existingBooking ? (
                  <LogisticsAwbEntryButton
                    bookingId={existingBooking.id}
                    awbLabel={
                      existingBooking.consignmentNo?.trim()
                      || existingBooking.trackingNo?.trim()
                      || null
                    }
                    variant="card"
                  />
                ) : needsMandatorySerials && !existingBooking ? (
                  <button
                    type="button"
                    className="invoice-detail-top__card invoice-detail-top__card--amber"
                    title="Add serial numbers on weighing-scale lines before the next step"
                    onClick={() => navigate(invoiceSummaryPath)}
                  >
                    <span className="invoice-detail-top__card-icon">
                      <Hash size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">Add serials</span>
                  </button>
                ) : courierEntry ? (
                  <BookCourierEntryButton entry={courierEntry} variant="card" />
                ) : customerPickupActive ? (
                  <div
                    className="invoice-detail-top__card invoice-detail-top__card--amber is-active"
                    title="Customer pickup"
                  >
                    <span className="invoice-detail-top__card-icon">
                      <MapPin size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">Customer pickup</span>
                    <span className="invoice-detail-top__card-meta text-sm">
                      {invoice.customerPickup?.shipFromLabel
                        || shipFromSiteLabel(invoice.customerPickup?.shipFromSite)}
                      {invoice.customerPickup?.vehicleNumber
                        ? ` · ${invoice.customerPickup.vehicleNumber}`
                        : ''}
                    </span>
                  </div>
                ) : manualDeliveredActive ? (
                  <div
                    className="invoice-detail-top__card invoice-detail-top__card--green is-active"
                    title="Delivered"
                  >
                    <span className="invoice-detail-top__card-icon">
                      <CheckCircle2 size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">Delivered</span>
                  </div>
                ) : null}
                {showCustomerPickup ? (
                  <button
                    type="button"
                    className="invoice-detail-top__card invoice-detail-top__card--amber"
                    title="Mark as customer pickup — no courier booking"
                    onClick={() => setPickupOpen(true)}
                  >
                    <span className="invoice-detail-top__card-icon">
                      <MapPin size={28} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="invoice-detail-top__card-label">Customer pickup</span>
                  </button>
                ) : null}
                {showEwayCard ? (
                  <button
                    type="button"
                    className={[
                      'invoice-detail-top__card',
                      'invoice-detail-top__card--purple',
                      ewayBillReady ? 'is-active' : '',
                      ewayDocOpening ? 'is-disabled' : '',
                    ].filter(Boolean).join(' ')}
                    title="View or download e-way bill"
                    onClick={() => { void openInvoiceEwayBillDocument(); }}
                    disabled={ewayDocOpening}
                  >
                    <span className="invoice-detail-top__card-icon" aria-hidden>
                      <EwayBillIcon size={28} />
                    </span>
                    <span className="invoice-detail-top__card-label">E way bill</span>
                    <span className="invoice-detail-top__card-sub">
                      {ewayDocOpening
                        ? 'Opening…'
                        : (ewayBillNumberOnCard
                          ? `EWB ${ewayBillNumberOnCard}`
                          : 'View or download e-way bill')}
                    </span>
                  </button>
                ) : null}
              </div>
              {ewayDocError ? (
                <p className="logistics-booking__docs-error" role="alert">{ewayDocError}</p>
              ) : null}
              {!existingBooking
                && courierEntry?.draftPatch?.partnerId === 'delhivery'
                && invoice
                && pinFromText(invoice.shippingAddress || invoice.billingAddress || '') ? (
                  <DelhiveryQuoteStrip
                    originPin={delhiveryOriginPin || null}
                    destinationPin={pinFromText(
                      invoice.shippingAddress || invoice.billingAddress || '',
                    )}
                    weightKg={5}
                    freightBillingMode="btc"
                    includeEstimate={Boolean(delhiveryOriginPin)}
                    compact
                  />
                ) : null}
            </div>
          )}
          <Outlet context={outletContext} />
          {orderListOpen && invoice ? (
            <SpareOrderListViewDialog
              invoice={invoice}
              booking={existingBooking}
              onClose={() => setOrderListOpen(false)}
            />
          ) : null}
          {invoice && user && addLrOpen ? (
            <InvoiceAddLrDialog
              open={addLrOpen}
              invoice={invoice}
              invoiceId={invoiceId}
              zohoCustomerId={customerId}
              partnerId={addLrPartnerId}
              allowPartnerPick={!addLrPartnerFromFreight}
              shipFromSite={addLrShipFrom}
              user={user}
              onClose={() => setAddLrOpen(false)}
              onCreated={booking => {
                setExistingBooking(booking);
                setCourierEntry(null);
                setAddLrAvailable(false);
              }}
            />
          ) : null}
          {invoice && pickupOpen ? (
            <InvoiceCustomerPickupDialog
              open={pickupOpen}
              invoice={invoice}
              customerId={customerId}
              invoiceId={invoiceId}
              shipFromSite={pickupShipFrom}
              shipFromLabel={pickupShipFromLabel}
              onClose={() => setPickupOpen(false)}
              onComplete={result => {
                rememberInvoiceCustomerPickup(invoiceId);
                setInvoice(prev => prev ? {
                  ...prev,
                  customerPickup: result.customerPickup,
                  ewayBill: result.eway?.status
                    ? {
                      ...(prev.ewayBill ?? {}),
                      status: result.eway.status,
                      ewaybillNumber: result.eway.ewaybillNumber ?? prev.ewayBill?.ewaybillNumber ?? null,
                      required: result.ewayRequired,
                    }
                    : prev.ewayBill,
                } : prev);
                setCourierEntry(null);
                setAddLrAvailable(false);
              }}
            />
          ) : null}
          {invoice && deliveredOpen ? (
            <InvoiceMarkDeliveredDialog
              open={deliveredOpen}
              invoice={invoice}
              customerId={customerId}
              invoiceId={invoiceId}
              hasLogisticsBooking={Boolean(existingBooking)}
              onClose={() => setDeliveredOpen(false)}
              onComplete={result => {
                rememberInvoiceManualDelivery(invoiceId);
                setInvoice(prev => prev ? {
                  ...prev,
                  manualDelivery: result.manualDelivery,
                  manualDeliveredAt: result.manualDelivery.markedAt,
                } : prev);
                setCourierEntry(null);
                setAddLrAvailable(false);
                setExistingBooking(prev => prev ? {
                  ...prev,
                  status: 'delivered',
                  deliveredAt: result.manualDelivery.markedAt,
                } : prev);
              }}
            />
          ) : null}
          {ewayDocDialog ? (
            <DelhiveryDocumentDialog
              payload={ewayDocDialog}
              onClose={() => {
                setEwayDocDialog(null);
                setEwayDocError('');
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
};
