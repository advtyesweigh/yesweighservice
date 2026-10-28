import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ClipboardList,
  UserRound,
} from 'lucide-react';
import { FetchingLoader } from '../../components/FetchingLoader';
import { useAuth } from '../../context/AuthContext';
import { InvoiceCategoryBadge } from '../../components/invoices/InvoiceCategoryVisual';
import { SalesOrderStageSeal } from '../../components/salesOrders/SalesOrderStageSeal';
import { InvoicedStampOverlay } from '../../components/salesOrders/InvoicedStampOverlay';
import { MarkInvoicedNoInvoiceDialog } from '../../components/salesOrders/MarkInvoicedNoInvoiceDialog';
import { useCatalogPageHeader, usePageHeaderTitleBelow, usePageHeaderTitleMeta } from '../../context/PageHeaderContext';
import {
  fetchAdminSalesOrderDetail,
  type AdminSalesOrderDetail,
} from '../../lib/admin-sales-orders';
import { fetchDealerSalesOrderDetail } from '../../lib/dealer-sales-orders';
import { dealerOrderErrorMessage, voidZohoSalesOrder } from '../../lib/dealerOrders';
import { playOnlineOrderAlert, unlockOrderAlertAudio } from '../../lib/orderAlertSound';
import {
  formatInvoiceDate,
  invoiceErrorMessage,
  invoiceStatusLabel,
} from '../../lib/invoices';
import { canNavigateBackInApp } from '../../lib/navigation';
import { isFromSalesOrderList } from '../../lib/salesOrderListReturnFocus';
import {
  applySalesOrderSalespersonFromDealer,
  applySalesOrderSalespersonFromStaff,
  deleteDraftSalesOrder,
  markSalesOrderInvoicedManually,
  markSalesOrderReadyForPayment,
  repairSalesOrderInvoicingMismatch,
  verifySalesOrderPayment,
  effectiveYesOneStageForDisplay,
  isMarkInvoicedNoZohoInvoiceError,
  isSalesOrderInvoicingMismatch,
  yesOneStageLabelForInvoicingDisplay,
  yesOneStageStatusClass,
} from '../../lib/salesOrderWorkflow';
import { listAssignableDealerStaff } from '../../lib/dealers';
import { sealKindForSalesOrder } from '../../lib/unified-sales-orders';
import { canSuperAdminWrite, canVerifySalesOrderPayment, hasStaffPermission } from '../../lib/staffAccess';
import type {
  AdminSalesOrderDetailOutletContext,
  SalesOrderActionBusy,
  SalesOrderWorkflowActions,
} from './adminSalesOrderDetailContext';

export const AdminSalesOrderDetailLayout: React.FC = () => {
  const { salesOrderId = '' } = useParams<{ salesOrderId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  const { user } = useAuth();
  const basePath = pathname.startsWith('/staff')
    ? '/staff'
    : pathname.startsWith('/dealer')
      ? (pathname.startsWith('/dealer-staff') ? '/dealer-staff' : '/dealer')
      : '/super-admin';
  const isDealerView = basePath === '/dealer' || basePath === '/dealer-staff';
  const canManageZoho = !isDealerView && (
    canSuperAdminWrite(user)
    || hasStaffPermission(user, 'orders.manage')
  );
  const canVerifyPayment = canVerifySalesOrderPayment(user);
  const listPath = `${basePath}/sales-orders`;
  const summaryPath = `${listPath}/${salesOrderId}`;
  const isPdfView = pathname.endsWith('/view');

  const [salesOrder, setSalesOrder] = useState<AdminSalesOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState<SalesOrderActionBusy>(null);
  const [assignableStaff, setAssignableStaff] = useState<Array<{ uid: string; displayName: string }>>([]);
  const [markInvoicedGuide, setMarkInvoicedGuide] = useState<{ message: string } | null>(null);
  const [showInvoicedStamp, setShowInvoicedStamp] = useState(false);
  const [kamCardOpen, setKamCardOpen] = useState(false);
  const showKamOnTitle = !isDealerView && canManageZoho && !isPdfView;

  const handleBack = useCallback(() => {
    if (isPdfView) {
      if (canNavigateBackInApp()) {
        navigate(-1);
      } else {
        navigate(summaryPath, { replace: true });
      }
      return;
    }
    if (isFromSalesOrderList(location.state) && canNavigateBackInApp()) {
      navigate(-1);
      return;
    }
    navigate(listPath);
  }, [isPdfView, navigate, summaryPath, listPath, location.state]);

  useCatalogPageHeader({
    title: salesOrder?.salesOrderNumber ?? 'Sales order',
    subtitle: salesOrder?.date ? formatInvoiceDate(salesOrder.date) : null,
    showBack: true,
    onBack: handleBack,
  });

  const stageAudience = isDealerView ? 'dealer' : 'admin';
  const yesOneStage = String(salesOrder?.yesOneStage || '').trim()
    || (salesOrder?.yesOneCreatedFromCart ? 'review' : '');
  const invoicingMismatch = Boolean(
    salesOrder && isSalesOrderInvoicingMismatch(salesOrder),
  );
  const displayStage = salesOrder
    ? effectiveYesOneStageForDisplay(salesOrder)
    : yesOneStage;
  const sealKind = salesOrder
    ? sealKindForSalesOrder({
      yesOneStage: invoicingMismatch ? 'payment_submitted' : (yesOneStage || salesOrder.yesOneStage),
      yesOneCreatedFromCart: salesOrder.yesOneCreatedFromCart,
      status: salesOrder.status,
      referenceNumber: salesOrder.referenceNumber,
    })
    : null;
  const titleStatusLabel = displayStage
    ? yesOneStageLabelForInvoicingDisplay(salesOrder ?? {}, stageAudience)
    : (salesOrder?.status ? invoiceStatusLabel(salesOrder.status) : '');
  const titleStatusClass = displayStage
    ? yesOneStageStatusClass(displayStage)
    : `invoices-status invoices-status--${String(salesOrder?.status || 'draft').toLowerCase().replace(/\s+/g, '_')}`;

  const titleMeta = useMemo(() => {
    if (!salesOrder || isPdfView) return null;
    return (
      <>
        <InvoiceCategoryBadge category={salesOrder.salesOrderCategory} />
        {sealKind ? (
          <SalesOrderStageSeal kind={sealKind} size="inline" />
        ) : null}
        {titleStatusLabel ? (
          <span className={titleStatusClass}>{titleStatusLabel}</span>
        ) : null}
      </>
    );
  }, [salesOrder, isPdfView, sealKind, titleStatusLabel, titleStatusClass]);

  const titleBelow = useMemo(() => {
    if (!salesOrder || !showKamOnTitle) return null;
    const salespersonLabel = String(salesOrder.salespersonName || '').trim()
      || (String(salesOrder.salespersonId || '').trim() ? 'Sales staff' : 'No staff');
    const missingSalesperson = !String(salesOrder.salespersonId || '').trim();
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
  }, [salesOrder, showKamOnTitle, kamCardOpen]);

  usePageHeaderTitleMeta(titleMeta, Boolean(titleMeta));
  usePageHeaderTitleBelow(titleBelow, Boolean(titleBelow));

  const reload = useCallback(() => {
    if (!salesOrderId) return;
    setLoading(true);
    setError('');
    const load = isDealerView
      ? fetchDealerSalesOrderDetail(salesOrderId)
      : fetchAdminSalesOrderDetail(salesOrderId);
    void load
      .then(data => {
        setSalesOrder(data);
        setError('');
      })
      .catch(err => {
        setSalesOrder(null);
        setError(invoiceErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [salesOrderId, isDealerView]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (isDealerView || !canManageZoho) {
      setAssignableStaff([]);
      return;
    }
    let cancelled = false;
    void listAssignableDealerStaff()
      .then(rows => {
        if (!cancelled) setAssignableStaff(rows);
      })
      .catch(() => {
        if (!cancelled) setAssignableStaff([]);
      });
    return () => { cancelled = true; };
  }, [isDealerView, canManageZoho]);

  const statusKey = String(salesOrder?.status || '').toLowerCase().replace(/\s+/g, '_');
  const stage = String(salesOrder?.yesOneStage || 'review');
  const hasSalesperson = Boolean(String(salesOrder?.salespersonId || '').trim());
  const dealerPath = salesOrder?.customerId
    ? `${basePath}/dealers/${salesOrder.customerId}`
    : null;
  const canRepairInvoicing = Boolean(
    canManageZoho && invoicingMismatch,
  );
  const canReady = canManageZoho
    && !invoicingMismatch
    && (statusKey === 'draft' || statusKey === 'pending' || statusKey === 'confirmed' || statusKey === 'open')
    && (stage === 'review' || !salesOrder?.yesOneStage);
  const needsSalesperson = canVerifyPayment && stage === 'payment_submitted' && !hasSalesperson;
  const canVerify = canVerifyPayment && stage === 'payment_submitted' && hasSalesperson;

  useEffect(() => {
    setKamCardOpen(false);
  }, [salesOrderId]);

  useEffect(() => {
    if (needsSalesperson && showKamOnTitle) setKamCardOpen(true);
  }, [needsSalesperson, salesOrderId, showKamOnTitle]);
  const canMarkInvoiced = Boolean(
    canManageZoho
    && !invoicingMismatch
    && stage !== 'completed'
    && stage !== 'void'
    && statusKey !== 'void'
    && statusKey !== 'cancelled'
    && statusKey !== 'canceled',
  );
  const canApplySalesperson = Boolean(
    canManageZoho
    && !hasSalesperson
    && stage !== 'completed'
    && stage !== 'void'
    && salesOrder?.customerId,
  );
  const canAssignSalespersonStaff = Boolean(
    canManageZoho
    && !hasSalesperson
    && stage !== 'completed'
    && stage !== 'void'
    && assignableStaff.length > 0,
  );
  const canChangeSalespersonStaff = Boolean(
    canSuperAdminWrite(user)
    && hasSalesperson
    && stage !== 'completed'
    && stage !== 'void'
    && assignableStaff.length > 0,
  );
  const canDelete = Boolean(
    (canManageZoho || isDealerView)
    && (statusKey === 'draft' || statusKey === 'pending')
    && stage !== 'completed'
    && stage !== 'void'
    && (stage !== 'payment_submitted' || canSuperAdminWrite(user)),
  );
  const canVoid = Boolean(
    canManageZoho
    && !canDelete
    && statusKey
    && statusKey !== 'void'
    && statusKey !== 'closed'
    && statusKey !== 'cancelled'
    && statusKey !== 'canceled'
    && stage !== 'completed'
    && stage !== 'void',
  );

  const dismissInvoicedStamp = useCallback(() => setShowInvoicedStamp(false), []);

  const handleReady = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    if (!window.confirm(
      'Mark this order ready for payment? The dealer will be asked to upload payment proof. You can still edit lines until they submit payment.',
    )) return;
    setActionBusy('ready');
    try {
      const next = await markSalesOrderReadyForPayment(salesOrderId);
      setSalesOrder(next);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const handleVerify = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    if (!window.confirm(
      'Verify payment, confirm this sales order in Zoho, and create the invoice and e-invoice? E-way bill is generated later in logistics.',
    )) return;
    unlockOrderAlertAudio();
    setActionBusy('verify');
    try {
      const next = await verifySalesOrderPayment(salesOrderId);
      playOnlineOrderAlert();
      setShowInvoicedStamp(true);
      setSalesOrder(next);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const handleMarkInvoiced = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    if (!window.confirm(
      'Mark this sales order as invoiced here? Use only when the invoice already exists in Zoho — this will not create a new invoice. If payment is ready, use Verify & invoice instead.',
    )) return;
    setActionBusy('markInvoiced');
    try {
      const next = await markSalesOrderInvoicedManually(salesOrderId);
      setSalesOrder(next);
    } catch (err) {
      if (isMarkInvoicedNoZohoInvoiceError(err)) {
        setMarkInvoicedGuide({
          message: err instanceof Error ? err.message : dealerOrderErrorMessage(err),
        });
      } else {
        window.alert(dealerOrderErrorMessage(err));
      }
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const handleRepairInvoicing = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    if (!window.confirm(
      'Reset this order\'s invoicing status? YesOne will restore the previous workflow stage so you can submit payment or verify & invoice correctly.',
    )) return;
    setActionBusy('repairInvoicing');
    try {
      const next = await repairSalesOrderInvoicingMismatch(salesOrderId);
      setSalesOrder(next);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const handleVoid = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    const reason = window.prompt('Reason for voiding this sales order (optional):');
    if (reason === null) return;
    if (!window.confirm('Void this Zoho sales order? This cannot be undone easily.')) return;
    setActionBusy('void');
    try {
      await voidZohoSalesOrder(salesOrderId, reason.trim() || '');
      reload();
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy, reload]);

  const handleDelete = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    const label = salesOrder?.salesOrderNumber?.trim() || 'this draft sales order';
    if (!window.confirm(
      `Delete ${label}? It will be permanently removed from Zoho and YesOne. This cannot be undone.`,
    )) return;
    setActionBusy('delete');
    try {
      await deleteDraftSalesOrder(salesOrderId);
      navigate(listPath, { replace: true });
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy, salesOrder?.salesOrderNumber, navigate, listPath]);

  const handleApplySalesperson = useCallback(async () => {
    if (!salesOrderId || actionBusy) return;
    setActionBusy('applySalesperson');
    try {
      const next = await applySalesOrderSalespersonFromDealer(salesOrderId);
      setSalesOrder(next);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const handleApplySalespersonFromStaff = useCallback(async (staffUid: string) => {
    if (!salesOrderId || actionBusy || !staffUid.trim()) return;
    setActionBusy('applySalespersonStaff');
    try {
      const next = await applySalesOrderSalespersonFromStaff(salesOrderId, staffUid.trim());
      setSalesOrder(next);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setActionBusy(null);
    }
  }, [salesOrderId, actionBusy]);

  const workflowActions = useMemo<SalesOrderWorkflowActions | null>(() => {
    if (isPdfView) return null;
    if (isDealerView) {
      if (!canDelete) return null;
      return {
        actionBusy,
        canReady: false,
        canVerify: false,
        needsSalesperson: false,
        canApplySalesperson: false,
        canAssignSalespersonStaff: false,
        canChangeSalespersonStaff: false,
        assignableStaff: [],
        canMarkInvoiced: false,
        canRepairInvoicing: false,
        canVoid: false,
        canDelete,
        dealerPath: null,
        onReady: () => {},
        onVerify: () => {},
        onMarkInvoiced: () => {},
        onRepairInvoicing: () => {},
        onApplySalesperson: () => {},
        onApplySalespersonFromStaff: () => {},
        onVoid: () => {},
        onDelete: () => { void handleDelete(); },
      };
    }
    return {
      actionBusy,
      canReady,
      canVerify,
      needsSalesperson,
      canApplySalesperson,
      canAssignSalespersonStaff,
      canChangeSalespersonStaff,
      assignableStaff,
      canMarkInvoiced,
      canRepairInvoicing,
      canVoid,
      canDelete,
      dealerPath,
      onReady: () => { void handleReady(); },
      onVerify: () => { void handleVerify(); },
      onMarkInvoiced: () => { void handleMarkInvoiced(); },
      onRepairInvoicing: () => { void handleRepairInvoicing(); },
      onApplySalesperson: () => { void handleApplySalesperson(); },
      onApplySalespersonFromStaff: (staffUid: string) => {
        void handleApplySalespersonFromStaff(staffUid);
      },
      onVoid: () => { void handleVoid(); },
      onDelete: () => { void handleDelete(); },
    };
  }, [
    isDealerView,
    isPdfView,
    actionBusy,
    canReady,
    canVerify,
    needsSalesperson,
    canApplySalesperson,
    canAssignSalespersonStaff,
    canChangeSalespersonStaff,
    assignableStaff,
    canMarkInvoiced,
    canRepairInvoicing,
    canVoid,
    canDelete,
    dealerPath,
    handleReady,
    handleVerify,
    handleMarkInvoiced,
    handleRepairInvoicing,
    handleApplySalesperson,
    handleApplySalespersonFromStaff,
    handleVoid,
    handleDelete,
  ]);

  if (!salesOrderId) return null;

  const outletContext: AdminSalesOrderDetailOutletContext = {
    salesOrder,
    loading,
    error,
    salesOrderId,
    listPath,
    reload,
    setSalesOrder,
    workflowActions,
    kamCardOpen,
    onToggleKamCard: () => setKamCardOpen(open => !open),
  };

  return (
    <div className={`page-content fade-in invoice-detail-page ${isPdfView ? 'invoice-detail-page--pdf-view' : ''}`}>
      {error && (
        <div className="products-inline-error panel glass invoice-detail-page__error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {loading && !salesOrder ? (
        <FetchingLoader label="Loading Sales order…" />
      ) : !salesOrder ? (
        <div className="invoices-empty panel glass">
          <ClipboardList size={36} aria-hidden />
          <h2>Sales order not found</h2>
          <p className="text-muted text-sm">This Sales order may have been removed or is unavailable.</p>
        </div>
      ) : (
        <Outlet context={outletContext} />
      )}

      {markInvoicedGuide ? (
        <MarkInvoicedNoInvoiceDialog
          errorMessage={markInvoicedGuide.message}
          yesOneStage={salesOrder?.yesOneStage}
          onClose={() => setMarkInvoicedGuide(null)}
        />
      ) : null}

      {showInvoicedStamp ? (
        <InvoicedStampOverlay onDone={dismissInvoicedStamp} />
      ) : null}
    </div>
  );
};
