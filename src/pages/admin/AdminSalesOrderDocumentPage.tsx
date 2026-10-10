import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  Ban,
  Check,
  ClipboardList,
  FileText,
  ImageIcon,
  IndianRupee,
  Landmark,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { DocumentKamStrip } from '../../components/admin/DocumentKamStrip';
import { DocumentPartyBlock } from '../../components/admin/DocumentPartyBlock';
import { ThemeSelect } from '../../components/ThemeSelect';
import type { GatcStampingChoice } from '../../components/catalog/GatcStampingChoiceDialog';
import { InvoiceDocumentBody } from '../../components/invoices/InvoiceDocumentBody';
import { SpareOrderListViewDialog } from '../../components/invoices/SpareOrderListViewDialog';
import { ShippingAddressPicker } from '../../components/orders/ShippingAddressPicker';
import {
  draftLinesFingerprint,
  draftLinesFromSalesOrderItems,
  isFreightDraftEditLine,
  withFreightDraftLinesLast,
  type DraftEditLine,
} from '../../components/salesOrders/SalesOrderDraftLineEditor';
import { SoDetailCatalogAddSheet } from '../../components/salesOrders/SoDetailCatalogAddSheet';
import { SoFreightExpandPanel } from '../../components/salesOrders/SoFreightExpandPanel';
import { SoLineEditSheet } from '../../components/salesOrders/SoLineEditSheet';
import { SoLineInlineEditor } from '../../components/salesOrders/SoLineInlineEditor';
import { VerifyInvoiceClock } from '../../components/salesOrders/VerifyInvoiceClock';
import { KotakBankFeedsSheet } from '../../components/salesOrders/KotakBankFeedsSheet';
import {
  KotakInvoiceProgressOverlay,
  type KotakInvoicePhase,
} from '../../components/salesOrders/KotakInvoiceProgressOverlay';
import { ZoomableImageDialog } from '../../components/ZoomableImageDialog';
import { useAuth } from '../../context/AuthContext';
import { fetchCatalog, formatCurrency, formatStockQuantity } from '../../lib/catalog';
import { resolveAvailableQtyByProductIds } from '../../lib/catalogAvailableStock';
import { combinedCartRate, newCartLineId } from '../../lib/gatcCart';
import type { CatalogProduct } from '../../types/catalog';
import { dealerOrderErrorMessage } from '../../lib/dealerOrders';
import { fetchKotakBankFeeds, selectKotakFeedAndInvoiceSalesOrder, type KotakBankFeed } from '../../lib/kotakBankFeeds';
import {
  listCustomerShippingAddresses,
  resolveShippingDestination,
  type ShippingAddress,
  type ShippingSelection,
} from '../../lib/shippingAddresses';
import type { StCourierDestination } from '../../lib/stCourierZone';
import {
  cartLinesForFreightEstimate,
  listProductsMissingFreightPackageInfo,
} from '../../lib/stCourierCartFreight';
import { canSuperAdminWrite, hasStaffPermission } from '../../lib/staffAccess';
import { hideDealerStaffCommercials } from '../../lib/dealerAccess';
import {
  submitSalesOrderPayment,
  canEditSalesOrderDraft,
  isSalesOrderInvoicingMismatch,
  updateDraftSalesOrderLines,
  updateDraftSalesOrderSparePackaging,
  updateDraftSalesOrderShipping,
  uploadSalesOrderPaymentScreenshot,
} from '../../lib/salesOrderWorkflow';
import type { SpareFreightPackaging } from '../../lib/spareFreightQuote';
import {
  formatInvoiceDate,
  invoiceHasCategory,
  isFreightInvoiceLineItem,
  moveFreightLinesToEnd,
} from '../../lib/invoices';
import type { DealerInvoiceLineItem } from '../../types/invoices';
import {
  prepareElementScreenshot,
  shareScreenshotBlob,
  type PreparedScreenshot,
} from '../../lib/shareElementScreenshot';
import { playOnlineOrderAlert, unlockOrderAlertAudio } from '../../lib/orderAlertSound';
import type { AdminSalesOrderDetailOutletContext } from './adminSalesOrderDetailContext';
import { portalSalesOrderRemarks } from '../../lib/admin-sales-orders';
import { sendWhatsAppFile } from '../../lib/whatsappInbox';

function WhatsAppIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  ));
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);
  return isMobile;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the sales order image.'));
    reader.readAsDataURL(blob);
  });
}

export const AdminSalesOrderDocumentPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const shareToWa = String(searchParams.get('shareToWa') || '').replace(/\D/g, '');
  const isMobile = useIsMobile();
  const isDealerOwner = user?.role === 'dealer';
  const isDealer = isDealerOwner || user?.role === 'dealer_staff';
  const hideCommercials = hideDealerStaffCommercials(user);
  const isOps = user?.role === 'staff' || user?.role === 'super_admin';
  const canManageOrders = isOps && (
    user?.role === 'super_admin' || hasStaffPermission(user, 'orders.manage')
  );
  const {
    salesOrder,
    salesOrderId,
    listPath,
    setSalesOrder,
    workflowActions,
    kamCardOpen,
  } = useOutletContext<AdminSalesOrderDetailOutletContext>();

  const [editLines, setEditLines] = useState<DraftEditLine[]>([]);
  const [baselineFingerprint, setBaselineFingerprint] = useState('');
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [linesHydrating, setLinesHydrating] = useState(false);
  // Captured from SoFreightExpandPanel spare carton drafts (LBH + weight) for later invoicing/logistics.
  const [sparePackaging, setSparePackaging] = useState<SpareFreightPackaging[] | null>(null);
  const [savingLines, setSavingLines] = useState(false);
  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [paymentNotes, setPaymentNotes] = useState('');
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [editingShip, setEditingShip] = useState(false);
  const [shipAddresses, setShipAddresses] = useState<ShippingAddress[]>([]);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState('');
  const [shipSelection, setShipSelection] = useState<ShippingSelection | null>(null);
  /** Avoid hammering staff-only address API after a failure (e.g. dealer 403). */
  const shipLoadFailedForRef = useRef<string | null>(null);
  const [savingShip, setSavingShip] = useState(false);
  const [catalogDescByItemId, setCatalogDescByItemId] = useState<Record<string, string>>({});
  const [catalogById, setCatalogById] = useState<Record<string, CatalogProduct>>({});
  const [availableQtyByProductId, setAvailableQtyByProductId] = useState<Record<string, number>>({});
  const [showCatalogAdd, setShowCatalogAdd] = useState(false);
  const [catalogAddSession, setCatalogAddSession] = useState(0);
  const [salespersonStaffUid, setSalespersonStaffUid] = useState('');
  const [showPaymentProof, setShowPaymentProof] = useState(false);
  const [orderListOpen, setOrderListOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [fetchingBankFeeds, setFetchingBankFeeds] = useState(false);
  const [bankFeeds, setBankFeeds] = useState<KotakBankFeed[] | null>(null);
  const [bankFeedsFetchedAt, setBankFeedsFetchedAt] = useState<string | null>(null);
  const [selectedKotakFeed, setSelectedKotakFeed] = useState<KotakBankFeed | null>(null);
  const [reservingKotakFeed, setReservingKotakFeed] = useState(false);
  const [kotakInvoicePhase, setKotakInvoicePhase] = useState<KotakInvoicePhase | null>(null);
  const bankFeedFetchGen = useRef(0);
  const shareCaptureRef = useRef<HTMLDivElement>(null);
  const soDetailRef = useRef<HTMLDivElement>(null);
  const warmShotRef = useRef<{ key: string; shot: PreparedScreenshot } | null>(null);
  const warmPromiseRef = useRef<Promise<PreparedScreenshot | null> | null>(null);
  const autoShareDoneRef = useRef(false);

  const stage = String(salesOrder?.yesOneStage || '');
  const showAvailableStock = isOps && (stage === 'review' || stage === 'payment_submitted');
  const workflowEditable = canEditSalesOrderDraft({
    role: user?.role,
    yesOneStage: stage,
    zohoStatus: salesOrder?.status,
  });
  const canEditDraft = workflowEditable && (
    (isOps && (user?.role === 'super_admin' || canManageOrders))
    || isDealerOwner
  );
  const canEditLines = canEditDraft;
  /** Staff/admin only — dealers keep the shipping chosen at order create. */
  const canEditShipping = isOps
    && canEditDraft
    && Boolean(salesOrder?.customerId?.trim());
  const allowRateEdit = isOps && canEditLines;
  const canPay = (
    ((isDealer && !hideCommercials) || canManageOrders)
    && (stage === 'ready_for_payment' || stage === 'payment_submitted')
  );
  const canUploadPayment = canPay && stage === 'ready_for_payment';
  const pdfPath = `${listPath}/${salesOrderId}/view`;

  useEffect(() => {
    const reserved = salesOrder?.reservedKotakFeed;
    if (!reserved?.transactionId) return;
    setSelectedKotakFeed({
      transactionId: reserved.transactionId,
      date: reserved.date ?? null,
      postedTime: reserved.postedTime ?? null,
      amount: Number(reserved.amount) || 0,
      debitOrCredit: 'debit',
      payee: reserved.payee ?? null,
      description: reserved.description ?? null,
      referenceNumber: reserved.referenceNumber ?? null,
      status: 'uncategorized',
      accountId: reserved.accountId ?? '',
      accountName: '',
      bankName: 'Kotak',
      importedTransactionId: reserved.importedTransactionId ?? null,
      reservedForSalesOrderId: salesOrderId,
    });
  }, [salesOrderId, salesOrder?.reservedKotakFeed?.transactionId]);

  useEffect(() => {
    if (!salesOrder?.lineItems?.length) return;
    let cancelled = false;
    void fetchCatalog()
      .then(res => {
        if (cancelled) return;
        const nextDesc: Record<string, string> = {};
        const nextById: Record<string, CatalogProduct> = {};
        for (const product of res.items) {
          nextById[product.id] = product;
          const desc = product.description?.trim();
          if (!desc) continue;
          nextDesc[product.id] = desc;
          if (product.sku) nextDesc[`sku:${product.sku}`] = desc;
        }
        setCatalogById(nextById);
        setCatalogDescByItemId(nextDesc);
      })
      .catch(() => { /* keep SO usable without catalog specs */ });
    return () => { cancelled = true; };
  }, [salesOrder?.lineItems]);

  useEffect(() => {
    if (!showAvailableStock || !salesOrder?.lineItems?.length) {
      setAvailableQtyByProductId({});
      return;
    }
    const productIds = [
      ...new Set(
        salesOrder.lineItems
          .filter(line => !isFreightInvoiceLineItem(line))
          .map(line => line.itemId?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!productIds.length) {
      setAvailableQtyByProductId({});
      return;
    }
    let cancelled = false;
    void resolveAvailableQtyByProductIds(productIds, catalogById).then(map => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const id of productIds) {
        next[id] = map.get(id) ?? 0;
      }
      setAvailableQtyByProductId(next);
    });
    return () => { cancelled = true; };
  }, [showAvailableStock, salesOrder?.lineItems, catalogById]);

  const renderItemStockMeta = useCallback((item: DealerInvoiceLineItem) => {
    if (!showAvailableStock || isFreightInvoiceLineItem(item)) return null;
    const productId = item.itemId?.trim();
    if (!productId) return null;
    const product = catalogById[productId];
    const unit = product?.unit?.trim() || 'pcs';
    const qty = availableQtyByProductId[productId];
    const label = qty != null ? formatStockQuantity(qty, unit) : '—';
    const orderQty = Math.max(1, Math.floor(item.quantity || 1));
    const sufficient = qty != null && qty >= orderQty;
    return (
      <span
        className={[
          'invoice-detail-item__avail-chip',
          sufficient ? 'invoice-detail-item__avail-chip--ok' : 'invoice-detail-item__avail-chip--low',
        ].join(' ')}
        title="Live audited stock"
      >
        Avail: {label}
      </span>
    );
  }, [showAvailableStock, catalogById, availableQtyByProductId]);

  const hasFreightLine = useMemo(
    () => Boolean(salesOrder?.lineItems?.some(line => isFreightInvoiceLineItem(line))),
    [salesOrder?.lineItems],
  );

  const missingFreightPackageLines = useMemo(() => {
    const hasFreight = hasFreightLine
      || editLines.some(isFreightDraftEditLine);
    if (!hasFreight) return [];
    if (Object.keys(catalogById).length === 0) return [];
    const sourceLines = editLines.length > 0
      ? editLines.filter(line => !isFreightDraftEditLine(line)).map(line => ({
        productId: line.productId,
        name: line.name,
        sku: line.sku,
        quantity: line.quantity,
        categoryId: line.categoryId ?? catalogById[line.productId]?.categoryId ?? null,
        categoryName: line.categoryName ?? catalogById[line.productId]?.categoryName ?? null,
      }))
      : (salesOrder?.lineItems ?? [])
        .filter(line => !isFreightInvoiceLineItem(line))
        .map(line => ({
          productId: line.itemId || line.id,
          name: line.name,
          sku: line.sku,
          quantity: line.quantity,
          categoryId: catalogById[line.itemId || line.id]?.categoryId ?? null,
          categoryName: catalogById[line.itemId || line.id]?.categoryName ?? null,
        }));
    if (!sourceLines.length) return [];
    return listProductsMissingFreightPackageInfo(
      cartLinesForFreightEstimate(sourceLines, catalogById),
    );
  }, [salesOrder?.lineItems, catalogById, hasFreightLine, editLines]);

  const freightPackageAlert = useMemo(() => {
    if (!missingFreightPackageLines.length) return null;
    const names = missingFreightPackageLines
      .map(line => line.name || line.sku || 'Item')
      .slice(0, 4);
    const more = missingFreightPackageLines.length > names.length
      ? ` +${missingFreightPackageLines.length - names.length} more`
      : '';
    return `Missing package info (LBH/weight): ${names.join(', ')}${more}. Tap the freight line to fill packaging.`;
  }, [missingFreightPackageLines]);

  const packageBlocksActions = isOps && Boolean(freightPackageAlert);

  const documentInvoice = useMemo(() => {
    if (!salesOrder) return null;
    const withDesc = salesOrder.lineItems.map(line => {
      if (line.description?.trim()) return line;
      const fromCatalog = catalogDescByItemId[line.itemId || '']
        || catalogDescByItemId[line.id]
        || (line.sku ? catalogDescByItemId[`sku:${line.sku}`] : null)
        || null;
      return fromCatalog ? { ...line, description: fromCatalog } : line;
    });

    if (!editLines.length) {
      return { ...salesOrder, lineItems: moveFreightLinesToEnd(withDesc) };
    }

    const dirty = Boolean(
      baselineFingerprint
      && draftLinesFingerprint(editLines) !== baselineFingerprint,
    );
    const draftById = new Map(editLines.map(line => [line.lineId, line]));
    const freightDraft = editLines.find(isFreightDraftEditLine) ?? null;
    const usedDraftIds = new Set<string>();

    const mapped: DealerInvoiceLineItem[] = [];
    for (const line of withDesc) {
      const draft = draftById.get(line.id)
        || (
          isFreightInvoiceLineItem(line) && freightDraft
            ? freightDraft
            : null
        );
      if (!draft) {
        if (dirty && !isFreightInvoiceLineItem(line)) continue;
        if (dirty && isFreightInvoiceLineItem(line) && !freightDraft) continue;
        mapped.push(line);
        continue;
      }
      usedDraftIds.add(draft.lineId);
      const soRate = Number(line.rate) || 0;
      const draftRate = Number(draft.rate) || 0;
      // Don't let a ₹0 freight auto-estimate hide the SO's charged freight amount.
      const rate = (
        isFreightInvoiceLineItem(line)
        && draftRate === 0
        && soRate > 0
      ) ? soRate : draftRate;
      mapped.push({
        ...line,
        id: draft.lineId === 'freight-line' ? line.id : draft.lineId,
        itemId: draft.productId,
        name: draft.name,
        sku: draft.sku,
        description: draft.description ?? line.description,
        imageUrl: draft.imageUrl ?? line.imageUrl,
        rate,
        quantity: draft.quantity,
        total: Math.round(rate * draft.quantity * 100) / 100,
      });
    }

    for (const draft of editLines) {
      if (usedDraftIds.has(draft.lineId)) continue;
      if (isFreightDraftEditLine(draft)) continue;
      mapped.push({
        id: draft.lineId,
        itemId: draft.productId,
        name: draft.name,
        sku: draft.sku,
        description: draft.description,
        imageUrl: draft.imageUrl,
        rate: draft.rate,
        quantity: draft.quantity,
        total: Math.round(draft.rate * draft.quantity * 100) / 100,
      });
    }

    if (freightDraft && !usedDraftIds.has(freightDraft.lineId)) {
      mapped.push({
        id: freightDraft.lineId,
        itemId: freightDraft.productId,
        name: freightDraft.name,
        sku: freightDraft.sku,
        description: freightDraft.description,
        imageUrl: freightDraft.imageUrl,
        rate: freightDraft.rate,
        quantity: freightDraft.quantity,
        total: Math.round(freightDraft.rate * freightDraft.quantity * 100) / 100,
      });
    }

    return { ...salesOrder, lineItems: moveFreightLinesToEnd(mapped) };
  }, [salesOrder, catalogDescByItemId, editLines, baselineFingerprint]);

  const portalRemarks = useMemo(
    () => (salesOrder ? portalSalesOrderRemarks(salesOrder) : null),
    [salesOrder],
  );

  const loadShipAddresses = useCallback((customerId: string, currentAddressId?: string | null) => {
    if (!isOps) return;
    setShipLoading(true);
    setShipError('');
    shipLoadFailedForRef.current = null;
    void listCustomerShippingAddresses(customerId)
      .then(({ addresses: rows, warning }) => {
        setShipAddresses(rows);
        if (warning) setShipError(warning);
        const id = currentAddressId?.trim();
        if (id && rows.some(r => r.addressId === id)) {
          setShipSelection({ mode: 'saved', addressId: id });
        }
      })
      .catch(err => {
        shipLoadFailedForRef.current = customerId;
        setShipAddresses([]);
        setShipError(dealerOrderErrorMessage(err));
      })
      .finally(() => setShipLoading(false));
  }, [isOps]);

  const startEditShipping = () => {
    if (!salesOrder?.customerId) return;
    setEditingShip(true);
    setShipSelection(null);
    loadShipAddresses(salesOrder.customerId, salesOrder.shippingAddressId);
  };

  const freightDestination = useMemo((): StCourierDestination | null => {
    if (!salesOrder) return null;
    if (editingShip && shipSelection) {
      const fromSelection = resolveShippingDestination(shipSelection, shipAddresses);
      if (fromSelection) return fromSelection;
    }
    const id = salesOrder.shippingAddressId?.trim();
    const match = id
      ? shipAddresses.find(addr => addr.addressId === id)
      : null;
    const addr = match
      || shipAddresses.find(a => a.kind === 'shipping')
      || shipAddresses[0]
      || null;
    if (!addr) return null;
    const state = addr.state?.trim() || null;
    const city = addr.city?.trim() || null;
    const zip = addr.zip?.trim() || null;
    if (!state && !city && !zip) return null;
    return { state, city, zip };
  }, [salesOrder, shipAddresses, editingShip, shipSelection]);

  const allowFreightEdit = useMemo(() => {
    if (!salesOrder) return false;
    return salesOrder.salesOrderCategory === 'product'
      || salesOrder.salesOrderCategory === 'spare'
      || (
        !salesOrder.salesOrderCategory
        && !(salesOrder.categories ?? []).includes('software_key')
      );
  }, [salesOrder]);

  const freightEntryAlert = useMemo(() => {
    if (!isOps || !allowFreightEdit) return null;
    const freight = editLines.find(isFreightDraftEditLine);
    const amount = freight ? Math.round(Number(freight.rate || freight.catalogRate || 0) * 100) / 100 : 0;
    if (amount > 0) return null;
    if (freight && amount <= 0) {
      return 'Non–Customer Pickup: enter freight ₹ (use LBH/weight auto-calc or type the amount).';
    }
    if (!freight && salesOrder?.salesOrderCategory === 'spare') {
      return 'Spare order: set logistics partner + freight from box / L×B×H (or Customer Pickup). Dealer freight is updated by staff.';
    }
    return null;
  }, [isOps, allowFreightEdit, editLines, salesOrder?.salesOrderCategory]);

  const onFreightPackageInfoSaved = useCallback((
    productId: string,
    info: NonNullable<CatalogProduct['packageInfo']>,
  ) => {
    setCatalogById(prev => {
      const existing = prev[productId];
      if (!existing) return prev;
      return { ...prev, [productId]: { ...existing, packageInfo: info } };
    });
  }, []);

  const persistSparePackaging = useCallback(async () => {
    if (!salesOrderId) return;
    if (!sparePackaging) return;
    await updateDraftSalesOrderSparePackaging(salesOrderId, sparePackaging);
  }, [salesOrderId, sparePackaging]);

  const hydrateEditLines = useCallback(async (): Promise<DraftEditLine[] | null> => {
    if (!salesOrder) return null;
    if (
      isOps
      && salesOrder.customerId
      && shipAddresses.length === 0
      && !shipLoading
      && shipLoadFailedForRef.current !== salesOrder.customerId
    ) {
      loadShipAddresses(salesOrder.customerId, salesOrder.shippingAddressId);
    }
    setLinesHydrating(true);
    try {
      const next = withFreightDraftLinesLast(
        await draftLinesFromSalesOrderItems(
          salesOrder.lineItems.map(line => {
            const productId = line.itemId || line.id;
            const description = line.description?.trim()
              || catalogDescByItemId[productId]
              || catalogDescByItemId[line.id]
              || (line.sku ? catalogDescByItemId[`sku:${line.sku}`] : null)
              || null;
            return {
              id: line.id,
              productId,
              itemId: line.itemId,
              name: line.name,
              sku: line.sku ?? null,
              description,
              imageUrl: line.imageUrl ?? null,
              rate: Number(line.rate) || 0,
              total: Number(line.total) || 0,
              quantity: Math.max(1, Math.floor(line.quantity || 1)),
              unit: 'pcs',
              stockStatus: null,
            };
          }),
        ),
      );
      setEditLines(next);
      setBaselineFingerprint(draftLinesFingerprint(next));
      return next;
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not load line items for editing.');
      return null;
    } finally {
      setLinesHydrating(false);
    }
  }, [
    salesOrder,
    isOps,
    shipAddresses.length,
    shipLoading,
    loadShipAddresses,
    catalogDescByItemId,
  ]);

  useEffect(() => {
    if (!canEditLines || !salesOrder?.lineItems?.length) {
      setEditLines([]);
      setBaselineFingerprint('');
      setExpandedLineId(null);
      return;
    }
    void hydrateEditLines();
    // Re-hydrate when SO identity / lines change from server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canEditLines,
    salesOrder?.id,
    salesOrder?.total,
    salesOrder?.subtotal,
    salesOrder?.lineItems?.length,
  ]);

  useEffect(() => {
    // Staff/admin only — dealers must not call listCustomerShippingAddresses (403).
    if (!canEditShipping || !salesOrder?.customerId) return;
    if (shipAddresses.length > 0 || shipLoading) return;
    if (shipLoadFailedForRef.current === salesOrder.customerId) return;
    loadShipAddresses(salesOrder.customerId, salesOrder.shippingAddressId);
  }, [
    canEditShipping,
    salesOrder?.customerId,
    salesOrder?.shippingAddressId,
    shipAddresses.length,
    shipLoading,
    loadShipAddresses,
  ]);

  const linesDirty = Boolean(
    baselineFingerprint
    && editLines.length > 0
    && draftLinesFingerprint(editLines) !== baselineFingerprint,
  );

  const cancelLineEdits = () => {
    void hydrateEditLines().then(() => setExpandedLineId(null));
  };

  const saveLines = async () => {
    if (!salesOrderId || savingLines || !salesOrder) return;
    const soFreightRate = Math.round(
      Number(
        salesOrder.lineItems.find(line => isFreightInvoiceLineItem(line))?.rate ?? 0,
      ) * 100,
    ) / 100;
    const lines = withFreightDraftLinesLast(editLines)
      .filter(line => line.productId && line.quantity > 0)
      .map(line => {
        const isFreight = isFreightDraftEditLine(line);
        let rate = Math.round(Number(
          isFreight ? (line.rate || line.catalogRate || 0) : line.catalogRate,
        ) * 100) / 100;
        // Never push a wiped ₹0 freight over a charged SO freight line.
        if (isFreight && rate === 0 && soFreightRate > 0) {
          rate = soFreightRate;
        }
        return {
          productId: line.productId,
          quantity: line.quantity,
          rate,
          gatcStampingPriceId: line.gatcStampingPriceId ?? null,
        };
      });
    if (!lines.length) {
      window.alert('Add at least one line item.');
      return;
    }
    setSavingLines(true);
    try {
      const next = await updateDraftSalesOrderLines(salesOrderId, lines);
      setSalesOrder(next);
      setExpandedLineId(null);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setSavingLines(false);
    }
  };

  const closeExpandedLine = useCallback(() => {
    setExpandedLineId(null);
  }, []);

  const expandedLineItem = useMemo(() => {
    if (!expandedLineId || !salesOrder) return null;
    const items = (documentInvoice ?? salesOrder).lineItems ?? [];
    return items.find(item => item.id === expandedLineId) ?? null;
  }, [expandedLineId, salesOrder, documentInvoice]);

  const handleSelectLineItem = (item: DealerInvoiceLineItem) => {
    if (!canEditLines) return;
    // Freight is edited in the always-visible panel (dealer spare SOs may have no freight line yet).
    if (isFreightInvoiceLineItem(item)) {
      const ensure = editLines.length > 0 ? Promise.resolve(editLines) : hydrateEditLines();
      void ensure.then(rows => {
        if (!rows) return;
        setExpandedLineId(null);
        window.setTimeout(() => {
          document.getElementById('so-draft-freight')?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        }, 50);
      });
      return;
    }
    if (expandedLineId === item.id) {
      setExpandedLineId(null);
      return;
    }
    const ensure = editLines.length > 0 ? Promise.resolve(editLines) : hydrateEditLines();
    void ensure.then(rows => {
      if (!rows) return;
      setExpandedLineId(item.id);
    });
  };

  const updateDraftLine = (next: DraftEditLine) => {
    setEditLines(prev => prev.map(line => (line.lineId === next.lineId ? next : line)));
  };

  const removeDraftLine = (lineId: string) => {
    setEditLines(prev => prev.filter(line => line.lineId !== lineId));
    setExpandedLineId(null);
  };

  const addStampingSibling = (source: DraftEditLine, choice: GatcStampingChoice) => {
    const gatcStampingPriceId = choice.withStamping
      ? (choice.gatcStampingPriceId?.trim() || null)
      : null;
    const gatcFeePerUnit = gatcStampingPriceId
      ? Math.round(Number(choice.gatcFeePerUnit ?? 0) * 100) / 100
      : 0;
    const sibling: DraftEditLine = {
      ...source,
      lineId: newCartLineId(),
      gatcStampingPriceId,
      gatcFeePerUnit,
      gatcStampingRange: gatcStampingPriceId
        ? (choice.gatcStampingRange?.trim() || null)
        : null,
      rate: combinedCartRate(source.catalogRate, gatcFeePerUnit),
      quantity: 1,
    };
    setEditLines(prev => {
      const idx = prev.findIndex(line => line.lineId === source.lineId);
      if (idx < 0) return [...prev, sibling];
      const copy = [...prev];
      copy.splice(idx + 1, 0, sibling);
      return copy;
    });
  };

  const openCatalogAdd = () => {
    if (!canEditLines) return;
    const ensure = editLines.length > 0 ? Promise.resolve(editLines) : hydrateEditLines();
    void ensure.then(rows => {
      if (!rows && editLines.length === 0) return;
      setCatalogAddSession(key => key + 1);
      setShowCatalogAdd(true);
      setExpandedLineId(null);
    });
  };

  const applyCatalogAdd = (productLines: DraftEditLine[]) => {
    setEditLines(prev => {
      const freight = prev.filter(isFreightDraftEditLine);
      return withFreightDraftLinesLast([...productLines, ...freight]);
    });
    setShowCatalogAdd(false);
  };

  const renderLineEditor = (item: DealerInvoiceLineItem): React.ReactNode => {
    if (!salesOrder) return null;
    if (isFreightInvoiceLineItem(item)) {
      // Freight UI lives in the dedicated panel below items (supports deferred spare freight).
      return null;
    }
    const draft = editLines.find(line => line.lineId === item.id);
    if (!draft || isFreightDraftEditLine(draft)) return null;
    return (
      <SoLineInlineEditor
        line={draft}
        catalogProduct={catalogById[draft.productId]}
        siblingLines={editLines.filter(line => !isFreightDraftEditLine(line))}
        allowRateEdit={allowRateEdit}
        disabled={savingLines}
        onChange={updateDraftLine}
        onRemove={() => removeDraftLine(draft.lineId)}
        onAddSibling={choice => addStampingSibling(draft, choice)}
      />
    );
  };

  const saveShipping = async () => {
    if (!salesOrderId || savingShip || !shipSelection) return;
    setSavingShip(true);
    try {
      const next = await updateDraftSalesOrderShipping(salesOrderId, shipSelection);
      setSalesOrder(next);
      setEditingShip(false);
      setShipSelection(null);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setSavingShip(false);
    }
  };

  const handleFetchBankFeeds = async () => {
    if (fetchingBankFeeds) return;
    const gen = ++bankFeedFetchGen.current;
    setBankFeeds([]);
    setBankFeedsFetchedAt(null);
    setFetchingBankFeeds(true);
    try {
      const result = await fetchKotakBankFeeds();
      if (gen !== bankFeedFetchGen.current) return;
      setBankFeeds(result.feeds || []);
      setBankFeedsFetchedAt(result.fetchedAt || null);
    } catch (err) {
      if (gen !== bankFeedFetchGen.current) return;
      setBankFeeds(null);
      window.alert(err instanceof Error ? err.message : 'Could not fetch Kotak bank feeds.');
    } finally {
      if (gen === bankFeedFetchGen.current) setFetchingBankFeeds(false);
    }
  };

  const handleSubmitPayment = async () => {
    if (!salesOrderId || submittingPayment) return;
    const notes = paymentNotes.trim();
    const hasExistingShot = Boolean(salesOrder?.paymentScreenshotStoragePath?.trim());
    if (!paymentFile && !hasExistingShot && !notes) {
      window.alert(
        'Attach a payment screenshot, or add a note (for example: adjust against existing credit).',
      );
      return;
    }
    setSubmittingPayment(true);
    try {
      let storagePath = salesOrder?.paymentScreenshotStoragePath?.trim() || '';
      if (paymentFile) {
        const uploaded = await uploadSalesOrderPaymentScreenshot(salesOrderId, paymentFile);
        storagePath = uploaded.storagePath;
      }
      const next = await submitSalesOrderPayment({
        salesOrderId,
        paymentScreenshotStoragePath: storagePath || null,
        paymentNotes: notes || null,
      });
      setSalesOrder(next);
      setPaymentFile(null);
      setPaymentNotes('');
      window.alert(
        isDealer
          ? 'Payment details submitted. Staff will verify and complete your order.'
          : 'Payment details submitted. Super admin can verify and invoice.',
      );
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setSubmittingPayment(false);
    }
  };

  useEffect(() => {
    if (!workflowActions?.assignableStaff.length) {
      setSalespersonStaffUid('');
      return;
    }
    if (workflowActions.canChangeSalespersonStaff) {
      const name = String(salesOrder?.salespersonName ?? '').trim().toLowerCase();
      const match = name
        ? workflowActions.assignableStaff.find(
          staff => staff.displayName.trim().toLowerCase() === name,
        )
        : null;
      setSalespersonStaffUid(match?.uid ?? '');
      return;
    }
    setSalespersonStaffUid(workflowActions.assignableStaff[0]?.uid ?? '');
  }, [
    salesOrder?.id,
    salesOrder?.salespersonName,
    workflowActions?.assignableStaff,
    workflowActions?.canChangeSalespersonStaff,
  ]);

  useEffect(() => {
    if (!kamCardOpen) return;
    window.requestAnimationFrame(() => {
      document.getElementById('so-detail-kam')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  }, [kamCardOpen]);

  const shareWarmKey = useMemo(() => {
    if (!salesOrder) return '';
    const lines = Array.isArray(salesOrder.lineItems) ? salesOrder.lineItems.length : 0;
    return [
      salesOrderId,
      salesOrder.salesOrderNumber || '',
      salesOrder.date || '',
      salesOrder.total ?? '',
      salesOrder.subtotal ?? '',
      lines,
      salesOrder.yesOneStage || '',
      salesOrder.shippingAddress || '',
      salesOrder.customerName || '',
      salesOrder.paymentScreenshotUrl || '',
      expandedLineId ? 'expanded' : 'view',
      linesDirty ? 'dirty' : 'clean',
    ].join('|');
  }, [salesOrder, salesOrderId, expandedLineId, linesDirty]);

  // Pre-capture in the background so WhatsApp can open immediately on tap.
  useEffect(() => {
    if (!salesOrder || !shareWarmKey) return;
    let cancelled = false;
    const soNumber = salesOrder.salesOrderNumber || salesOrderId || 'sales-order';
    const safeName = soNumber.replace(/[^\w\-]+/g, '-').slice(0, 48);
    const fileName = `${safeName}.png`;

    const warm = async (): Promise<PreparedScreenshot | null> => {
      // Let the document paint (and images settle) before rasterizing.
      await new Promise<void>(resolve => {
        window.setTimeout(resolve, 350);
      });
      if (cancelled) return null;
      const el = shareCaptureRef.current;
      if (!el) return null;
      try {
        const shot = await prepareElementScreenshot(el, {
          fileName,
          backgroundColor: '#13151b',
        });
        if (cancelled) return null;
        warmShotRef.current = { key: shareWarmKey, shot };
        return shot;
      } catch {
        return null;
      }
    };

    warmShotRef.current = null;
    const promise = warm();
    warmPromiseRef.current = promise;
    return () => {
      cancelled = true;
    };
  }, [salesOrder, salesOrderId, shareWarmKey]);

  const handleShareScreenshot = useCallback(async () => {
    const el = shareCaptureRef.current;
    if (!el || !salesOrder || sharing) return;
    setSharing(true);
    try {
      const soNumber = salesOrder.salesOrderNumber || salesOrderId || 'sales-order';
      const safeName = soNumber.replace(/[^\w\-]+/g, '-').slice(0, 48);
      const dateLabel = salesOrder.date ? formatInvoiceDate(salesOrder.date) : '';
      const title = soNumber;
      const text = [soNumber, dateLabel].filter(Boolean).join(' · ');

      let shot: PreparedScreenshot | null =
        warmShotRef.current?.key === shareWarmKey ? warmShotRef.current.shot : null;

      if (!shot && warmPromiseRef.current) {
        shot = await warmPromiseRef.current;
        if (warmShotRef.current?.key !== shareWarmKey) shot = null;
      }

      if (!shot) {
        // Hide sticky action UI only when we must capture on demand.
        soDetailRef.current?.classList.add('is-sharing');
        try {
          shot = await prepareElementScreenshot(el, {
            fileName: `${safeName}.png`,
            backgroundColor: '#13151b',
          });
          warmShotRef.current = { key: shareWarmKey, shot };
        } finally {
          soDetailRef.current?.classList.remove('is-sharing');
        }
      }

      await shareScreenshotBlob(shot.blob, {
        fileName: shot.fileName,
        title,
        text,
        dataBase64: shot.dataBase64,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      window.alert(err instanceof Error ? err.message : 'Could not share screenshot.');
    } finally {
      soDetailRef.current?.classList.remove('is-sharing');
      setSharing(false);
    }
  }, [salesOrder, salesOrderId, sharing, shareWarmKey]);

  useEffect(() => {
    if (!shareToWa || !salesOrder || !shareWarmKey || autoShareDoneRef.current) return;
    const shareKey = `so-wa-share:${salesOrderId}:${shareToWa}`;
    if (sessionStorage.getItem(shareKey)) {
      autoShareDoneRef.current = true;
      navigate(`/super-admin/whatsapp?chat=${encodeURIComponent(shareToWa)}`);
      return;
    }
    let cancelled = false;
    const send = async () => {
      setSharing(true);
      try {
        let shot: PreparedScreenshot | null =
          warmShotRef.current?.key === shareWarmKey ? warmShotRef.current.shot : null;
        if (!shot && warmPromiseRef.current) {
          shot = await warmPromiseRef.current;
          if (warmShotRef.current?.key !== shareWarmKey) shot = null;
        }
        if (!shot) {
          const el = shareCaptureRef.current;
          if (!el) return;
          await new Promise<void>(resolve => { window.setTimeout(resolve, 400); });
          if (cancelled) return;
          shot = await prepareElementScreenshot(el, {
            fileName: `${(salesOrder.salesOrderNumber || salesOrderId || 'sales-order').replace(/[^\w\-]+/g, '-').slice(0, 48)}.png`,
            backgroundColor: '#13151b',
          });
        }
        if (!shot || cancelled) return;
        const fileBase64 = shot.dataBase64 || await blobToBase64(shot.blob);
        if (cancelled) return;
        await sendWhatsAppFile({
          waId: shareToWa,
          fileBase64,
          mimeType: shot.mimeType || 'image/png',
          fileName: shot.fileName,
          caption: salesOrder.salesOrderNumber || 'Sales order',
        });
        autoShareDoneRef.current = true;
        sessionStorage.setItem(shareKey, '1');
        if (!cancelled) {
          navigate(`/super-admin/whatsapp?chat=${encodeURIComponent(shareToWa)}`);
        }
      } catch (err) {
        if (!cancelled) {
          window.alert(err instanceof Error ? err.message : 'Could not send the sales order on WhatsApp.');
        }
      } finally {
        if (!cancelled) setSharing(false);
      }
    };
    void send();
    return () => {
      cancelled = true;
    };
  }, [navigate, salesOrder, salesOrderId, shareToWa, shareWarmKey]);

  if (!salesOrder) return null;

  const showWorkflowActions = Boolean(
    workflowActions
    && (
      workflowActions.canReady
      || workflowActions.canVerify
      || workflowActions.needsSalesperson
      || workflowActions.canApplySalesperson
      || workflowActions.canAssignSalespersonStaff
      || workflowActions.canMarkInvoiced
      || workflowActions.canRepairInvoicing
      || workflowActions.canVoid
      || workflowActions.canDelete
    ),
  );
  const invoicingMismatch = isSalesOrderInvoicingMismatch(salesOrder);
  const syncError = String(salesOrder.yesOneSyncError || '').trim();
  const showPayment = canPay
    || (isOps && (
      stage === 'payment_submitted'
      || stage === 'completed'
      || salesOrder.paymentScreenshotUrl
      || salesOrder.paymentNotes
    ));
  const priceChanges = salesOrder.yesOnePriceChanges ?? [];
  const showPriceChanges = Boolean(
    !hideCommercials && salesOrder.yesOnePriceCustomized && priceChanges.length,
  );

  const paymentScreenshotUrl = salesOrder.paymentScreenshotUrl?.trim() || '';
  // Picking / order list is ops-only (super admin + staff) — never dealers.
  const showOrderList = isOps && (
    invoiceHasCategory(
      {
        categories: salesOrder.categories,
        invoiceCategory: salesOrder.salesOrderCategory,
      },
      'spare',
    ) || salesOrder.yesOneOrderSegment === 'spare'
  );
  const topActionCount = 1
    + (showOrderList ? 1 : 0)
    + (paymentScreenshotUrl ? 1 : 0);
  const topActionClass = topActionCount >= 3
    ? 'invoice-detail-top__actions invoice-detail-top__actions--triple'
    : topActionCount === 2
      ? 'invoice-detail-top__actions invoice-detail-top__actions--pair'
      : 'invoice-detail-top__actions invoice-detail-top__actions--single';

  return (
    <div ref={soDetailRef} className="so-detail so-detail--with-actions">
      <div ref={shareCaptureRef} className="so-detail__share-capture">
        <div className="so-detail__share-title">
          <strong>{salesOrder.salesOrderNumber || 'Sales order'}</strong>
          {salesOrder.date ? (
            <span>{formatInvoiceDate(salesOrder.date)}</span>
          ) : null}
        </div>

      {/* Compact header: PDF (+ order list / payment) + customer + shipping */}
      <header className="so-detail__header">
        {hideCommercials ? null : (
        <div className="invoice-detail-top so-detail__top-actions" data-capture-ignore="1">
          <div className={topActionClass} role="group" aria-label="Sales order actions">
            <Link
              to={pdfPath}
              className="invoice-detail-top__card invoice-detail-top__card--blue is-active"
            >
              <span className="invoice-detail-top__card-icon">
                <FileText size={28} strokeWidth={1.75} aria-hidden />
              </span>
              <span className="invoice-detail-top__card-label">Sales order</span>
            </Link>
            {showOrderList ? (
              <button
                type="button"
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
            {paymentScreenshotUrl ? (
              <button
                type="button"
                className="invoice-detail-top__card invoice-detail-top__card--purple"
                onClick={() => setShowPaymentProof(true)}
              >
                <span className="invoice-detail-top__card-icon">
                  <ImageIcon size={28} strokeWidth={1.75} aria-hidden />
                </span>
                <span className="invoice-detail-top__card-label">Payment</span>
              </button>
            ) : null}
          </div>
        </div>
        )}

        <DocumentPartyBlock
          className="so-detail__party"
          customerName={salesOrder.customerName}
          hideName={isDealer}
          address={salesOrder.shippingAddress}
          pincode={freightDestination?.zip}
          highlightPincode
          telHref={isOps ? salesOrder.customerTelHref : null}
          whatsappHref={isOps ? salesOrder.customerWhatsappHref : null}
          emptyAddressLabel="No address on file"
        >
          {editingShip ? (
            <div className="so-detail__ship-edit">
              <ShippingAddressPicker
                addresses={shipAddresses}
                loading={shipLoading}
                error={shipError}
                disabled={savingShip}
                value={shipSelection}
                onChange={setShipSelection}
                onRefresh={() => {
                  if (salesOrder.customerId) {
                    loadShipAddresses(salesOrder.customerId, salesOrder.shippingAddressId);
                  }
                }}
                allowManage
                customerId={salesOrder.customerId || undefined}
              />
              <div className="so-detail__ship-edit-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={savingShip}
                  onClick={() => {
                    setEditingShip(false);
                    setShipSelection(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={savingShip || !shipSelection || shipLoading}
                  onClick={() => { void saveShipping(); }}
                >
                  {savingShip ? 'Saving…' : 'Save address'}
                </button>
              </div>
            </div>
          ) : (
            canEditShipping ? (
              <button
                type="button"
                className="so-detail__edit-btn so-detail__ship-change"
                onClick={startEditShipping}
              >
                <Pencil size={14} aria-hidden />
                Change address
              </button>
            ) : null
          )}
        </DocumentPartyBlock>

        {isOps && (
          (!canSuperAdminWrite(user) || kamCardOpen)
        ) && (
          <div id="so-detail-kam">
          <DocumentKamStrip
            salespersonId={salesOrder.salespersonId}
            salespersonName={salesOrder.salespersonName}
            showMissing
            assignStaff={
              canSuperAdminWrite(user)
              && (
                workflowActions?.canAssignSalespersonStaff
                || workflowActions?.canChangeSalespersonStaff
              )
                ? {
                    selectedUid: salespersonStaffUid,
                    options: workflowActions.assignableStaff,
                    onSelect: setSalespersonStaffUid,
                    onAssign: () => workflowActions.onApplySalespersonFromStaff(salespersonStaffUid),
                    busy: workflowActions.actionBusy === 'applySalespersonStaff',
                    disabled: Boolean(workflowActions.actionBusy),
                    mode: workflowActions.canChangeSalespersonStaff ? 'change' : 'assign',
                  }
                : null
            }
          />
          </div>
        )}
      </header>

      {isOps && workflowActions?.needsSalesperson ? (
        <div
          className="products-inline-error panel glass so-detail__salesperson-banner"
          data-capture-ignore="1"
        >
          <UserRound size={18} aria-hidden />
          <div className="so-detail__salesperson-banner-copy">
            <span>
              Sales staff is required before Verify &amp; invoice.
              {workflowActions.canAssignSalespersonStaff && canSuperAdminWrite(user) ? (
                <> Tap the salesperson on the title to assign.</>
              ) : workflowActions.canAssignSalespersonStaff ? (
                <> Pick staff below, or assign a KAM on the dealer.</>
              ) : workflowActions.dealerPath ? (
                <>
                  {' '}
                  <Link to={workflowActions.dealerPath}>Open dealer</Link>
                  {' '}
                  to assign a KAM with a linked Zoho salesperson.
                </>
              ) : (
                <> Assign sales staff on the dealer, then apply here.</>
              )}
            </span>
            {workflowActions.canAssignSalespersonStaff && !canSuperAdminWrite(user) ? (
              <div className="so-detail__salesperson-assign">
                <ThemeSelect
                  id="so-salesperson-staff"
                  value={salespersonStaffUid}
                  placeholder="Select staff…"
                  options={workflowActions.assignableStaff.map(staff => ({
                    value: staff.uid,
                    label: staff.displayName,
                  }))}
                  onChange={setSalespersonStaffUid}
                  aria-label="Sales staff"
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={
                    !salespersonStaffUid.trim()
                    || Boolean(workflowActions.actionBusy)
                  }
                  onClick={() => workflowActions.onApplySalespersonFromStaff(salespersonStaffUid)}
                >
                  {workflowActions.actionBusy === 'applySalespersonStaff'
                    ? 'Applying…'
                    : 'Set salesperson'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {isOps && syncError ? (
        <div
          className="products-inline-error panel glass so-detail__sync-error-banner"
          data-capture-ignore="1"
        >
          <AlertCircle size={18} aria-hidden />
          <div className="so-detail__sync-error-copy">
            <strong>Last invoicing attempt failed</strong>
            <span>{syncError}</span>
          </div>
        </div>
      ) : null}

      {isOps && invoicingMismatch ? (
        <div
          className="products-inline-error panel glass so-detail__invoicing-mismatch-banner"
          data-capture-ignore="1"
        >
          <AlertCircle size={18} aria-hidden />
          <div className="so-detail__invoicing-mismatch-copy">
            <strong>Invoicing incomplete</strong>
            <span>
              This order was marked invoiced without a linked Zoho invoice.
              Reset the workflow, then use Verify &amp; invoice (or Mark as invoiced only after the invoice exists in Zoho).
            </span>
            {workflowActions?.canRepairInvoicing ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={Boolean(workflowActions.actionBusy)}
                onClick={() => workflowActions.onRepairInvoicing()}
              >
                {workflowActions.actionBusy === 'repairInvoicing'
                  ? 'Resetting…'
                  : 'Reset invoicing status'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {portalRemarks ? (
        <section className="so-detail__remarks panel glass">
          <h3 className="so-detail__section-title">Remarks</h3>
          <p className="so-detail__remarks-body">{portalRemarks}</p>
        </section>
      ) : null}

      {showPayment && (
        <section className="so-detail__payment panel glass" data-capture-ignore="1">
          <div className="so-detail__payment-head">
            <h3 className="so-detail__section-title">Payment</h3>
            {salesOrder.paymentAmount != null ? (
              <div className="so-detail__payment-due">
                <span className="so-detail__payment-due-label">Amount due</span>
                <strong className="so-detail__payment-due-value">
                  {formatCurrency(salesOrder.paymentAmount, salesOrder.currencyCode)}
                </strong>
              </div>
            ) : null}
          </div>

          {canUploadPayment && (
            <div className="so-detail__payment-form" data-capture-ignore="1">
              <div className="so-detail__payment-field">
                <span>Payment screenshot <span className="text-muted">(optional if noting credit)</span></span>
                <label className="so-detail__payment-file" htmlFor="so-payment-file">
                  <span className="so-detail__payment-file-icon" aria-hidden>
                    <ImageIcon size={18} />
                  </span>
                  <span className="so-detail__payment-file-copy">
                    <strong>{paymentFile ? paymentFile.name : 'Choose image'}</strong>
                    <span className="text-muted text-sm">
                      {paymentFile ? 'Tap to replace' : 'PNG, JPG — bank transfer screenshot'}
                    </span>
                  </span>
                  <input
                    id="so-payment-file"
                    type="file"
                    accept="image/*"
                    onChange={e => setPaymentFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <label className="so-detail__payment-field" htmlFor="so-payment-notes">
                <span>Payment note <span className="text-muted">(optional if screenshot attached)</span></span>
                <textarea
                  id="so-payment-notes"
                  className="input-field so-detail__payment-notes"
                  value={paymentNotes}
                  onChange={e => setPaymentNotes(e.target.value.slice(0, 1000))}
                  disabled={submittingPayment}
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Adjust against existing company credit / advance balance"
                />
              </label>
              <p className="so-detail__payment-hint text-muted text-sm mb-0">
                Provide a screenshot, a note, or both. Notes alone are enough when settling against existing credit.
              </p>

              <button
                type="button"
                className="btn btn-primary so-detail__payment-submit"
                disabled={submittingPayment}
                onClick={() => { void handleSubmitPayment(); }}
              >
                <IndianRupee size={16} aria-hidden />
                {submittingPayment ? 'Submitting…' : 'Submit payment'}
              </button>
            </div>
          )}

          {salesOrder.paymentNotes?.trim() ? (
            <div className="so-detail__payment-note-view">
              <span className="so-detail__payment-note-label">Payment note</span>
              <p className="so-detail__payment-note-text mb-0">{salesOrder.paymentNotes.trim()}</p>
            </div>
          ) : null}
        </section>
      )}

      {/* Products + totals — tap a line to edit; tap freight for splitup */}
      <section className="so-detail__doc">
        {canEditLines ? (
          <div className="so-detail__doc-toolbar" data-capture-ignore="1">
            <p className="so-detail__doc-hint text-muted text-sm">
              {linesHydrating
                ? 'Loading items…'
                : isMobile
                  ? 'Tap a product to edit. Set freight in the Freight section below.'
                  : 'Tap a product to edit it. Set partner / box / LBH in the Freight section below.'}
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm so-detail__add-item-btn"
              disabled={savingLines || linesHydrating}
              onClick={openCatalogAdd}
            >
              <Plus size={16} aria-hidden />
              Add item
            </button>
          </div>
        ) : null}
        <InvoiceDocumentBody
          invoice={documentInvoice ?? salesOrder}
          itemClassName="admin-invoice-detail-item"
          totalsAfterItems
          hideAmounts={hideCommercials}
          freightAlert={freightPackageAlert || freightEntryAlert}
          selectFreight={canEditLines}
          selectedLineItemId={canEditLines ? expandedLineId : null}
          onSelectLineItem={canEditLines ? handleSelectLineItem : undefined}
          renderExpanded={canEditLines && !isMobile ? renderLineEditor : undefined}
          itemMeta={showAvailableStock ? renderItemStockMeta : undefined}
          afterItems={
            canEditLines && allowFreightEdit && editLines.length > 0 ? (
              <section
                className="so-detail__freight panel glass"
                id="so-draft-freight"
                aria-label="Freight"
              >
                <h3 className="so-detail__section-title">Freight</h3>
                {freightEntryAlert && !editLines.some(isFreightDraftEditLine) ? (
                  <p className="so-freight-expand__alert" role="alert">
                    <AlertTriangle size={15} aria-hidden />
                    <span>{freightEntryAlert}</span>
                  </p>
                ) : null}
                <SoFreightExpandPanel
                  key={salesOrder.id}
                  lines={editLines}
                  onChangeLines={setEditLines}
                  catalogById={catalogById}
                  shippingDestination={freightDestination}
                  canEditPackage={isOps}
                  disabled={savingLines}
                  onPackageInfoSaved={onFreightPackageInfoSaved}
                  onSparePackagingChange={setSparePackaging}
                />
              </section>
            ) : null
          }
        />
      </section>

      {canEditLines ? (
        <SoDetailCatalogAddSheet
          open={showCatalogAdd}
          sessionKey={catalogAddSession}
          seedLines={editLines}
          orderCategory={salesOrder.salesOrderCategory}
          orderSegment={salesOrder.yesOneOrderSegment ?? null}
          inventorySite={salesOrder.yesOneInventorySite ?? null}
          onClose={() => setShowCatalogAdd(false)}
          onApply={applyCatalogAdd}
        />
      ) : null}

      {showPriceChanges ? (
        <section className="so-detail__price-changes panel glass">
          <h3 className="so-detail__section-title">Custom prices</h3>
          <ul className="so-detail__price-changes-list">
            {priceChanges.map(change => {
              const isLevel = change.source === 'price_level'
                || (!change.changedByUid && Boolean(change.priceLevelName));
              const attribution = isLevel
                ? (change.priceLevelName || 'Price level')
                : (change.changedByName || null);
              return (
                <li key={`${change.productId}-${change.changedAt ?? change.rate}`}>
                  <div>
                    <strong>{change.name}</strong>
                    {change.sku ? <span className="text-muted text-sm"> · {change.sku}</span> : null}
                  </div>
                  <p className="text-sm mb-0">
                    {formatCurrency(change.catalogRate, salesOrder.currencyCode)}
                    {' → '}
                    <strong>{formatCurrency(change.rate, salesOrder.currencyCode)}</strong>
                    {attribution ? ` · ${attribution}` : ''}
                    {change.changedAt
                      ? ` · ${new Date(change.changedAt).toLocaleString('en-IN')}`
                      : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      </div>

      <footer className={`so-detail__actions${linesDirty ? ' so-detail__actions--edit-dock' : ''}`} data-capture-ignore="1">
        {linesDirty ? (
          <>
            <div className="so-detail__edit-dock-meta">
              <strong>Unsaved line changes</strong>
              <span className="text-muted text-sm">
                Est. {formatCurrency(
                  editLines.reduce((sum, line) => sum + line.rate * line.quantity, 0),
                  salesOrder.currencyCode,
                )} before tax
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={savingLines}
              onClick={cancelLineEdits}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={savingLines || editLines.filter(l => !isFreightDraftEditLine(l)).length === 0}
              onClick={() => { void saveLines(); }}
            >
              {savingLines ? 'Saving…' : 'Save to Zoho'}
            </button>
          </>
        ) : (
          <>
        {packageBlocksActions ? (
          <p className="so-detail__actions-block-note" role="status">
            Fill missing package information before verifying or invoicing. Void and delete stay available.
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary so-detail__share-btn so-detail__share-btn--whatsapp"
          disabled={sharing || Boolean(workflowActions?.actionBusy) || packageBlocksActions}
          title={packageBlocksActions ? freightPackageAlert ?? undefined : undefined}
          onClick={() => { void handleShareScreenshot(); }}
          aria-label="Share on WhatsApp"
        >
          <WhatsAppIcon size={16} />
          {sharing ? 'Sharing…' : 'WhatsApp'}
        </button>
        {isOps ? (
          <button
            type="button"
            className="btn so-detail__fetch-bank-btn"
            disabled={fetchingBankFeeds}
            onClick={() => { void handleFetchBankFeeds(); }}
            aria-label="Fetch uncategorised Kotak bank feeds"
            title="Fetch uncategorised Kotak bank feeds from Zoho"
          >
            <Landmark size={16} aria-hidden />
            {fetchingBankFeeds ? 'Fetching…' : 'Fetch Bank'}
          </button>
        ) : null}
        {selectedKotakFeed ? (
          <p className="so-detail__selected-bank-feed mb-0">
            Selected pay-in reserved for this order:{' '}
            <strong>
              {formatCurrency(selectedKotakFeed.amount, salesOrder?.currencyCode)}
            </strong>
            {' · '}
            {selectedKotakFeed.payee?.trim() || 'Kotak'}
            {' · Ref '}
            {selectedKotakFeed.referenceNumber?.trim() || selectedKotakFeed.transactionId}
          </p>
        ) : null}
        {showWorkflowActions && workflowActions && (
          <>
          {workflowActions.canReady && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(workflowActions.actionBusy) || packageBlocksActions}
              title={packageBlocksActions ? freightPackageAlert ?? undefined : undefined}
              onClick={() => {
                if (packageBlocksActions) return;
                void (async () => {
                  try {
                    await persistSparePackaging();
                    workflowActions.onReady();
                  } catch (err) {
                    window.alert(err instanceof Error ? err.message : 'Could not save spare packaging.');
                  }
                })();
              }}
            >
              <IndianRupee size={16} aria-hidden />
              {workflowActions.actionBusy === 'ready' ? 'Updating…' : 'Ready for payment'}
            </button>
          )}
          {workflowActions.canApplySalesperson && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(workflowActions.actionBusy) || packageBlocksActions}
              title={packageBlocksActions ? freightPackageAlert ?? undefined : undefined}
              onClick={() => {
                if (packageBlocksActions) return;
                workflowActions.onApplySalesperson();
              }}
            >
              <UserRound size={16} aria-hidden />
              {workflowActions.actionBusy === 'applySalesperson'
                ? 'Applying…'
                : 'Apply salesperson from dealer'}
            </button>
          )}
          {workflowActions.canAssignSalespersonStaff && !workflowActions.needsSalesperson ? (
            <div className="so-detail__actions-staff">
              <ThemeSelect
                id="so-salesperson-staff-footer"
                value={salespersonStaffUid}
                placeholder="Select staff…"
                options={workflowActions.assignableStaff.map(staff => ({
                  value: staff.uid,
                  label: staff.displayName,
                }))}
                onChange={setSalespersonStaffUid}
                aria-label="Sales staff"
                disabled={packageBlocksActions}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={
                  !salespersonStaffUid.trim()
                  || Boolean(workflowActions.actionBusy)
                  || packageBlocksActions
                }
                title={packageBlocksActions ? freightPackageAlert ?? undefined : undefined}
                onClick={() => {
                  if (packageBlocksActions) return;
                  workflowActions.onApplySalespersonFromStaff(salespersonStaffUid);
                }}
              >
                <UserRound size={16} aria-hidden />
                {workflowActions.actionBusy === 'applySalespersonStaff'
                  ? 'Applying…'
                  : 'Set salesperson'}
              </button>
            </div>
          ) : null}
          {workflowActions.needsSalesperson && !workflowActions.canVerify && (
            <button
              type="button"
              className="btn btn-primary"
              disabled
              title={
                packageBlocksActions
                  ? freightPackageAlert ?? undefined
                  : canSuperAdminWrite(user) && (
                    workflowActions.canAssignSalespersonStaff
                    || workflowActions.canChangeSalespersonStaff
                  )
                    ? 'Tap the salesperson on the title to assign, then verify'
                    : 'Assign sales staff on the dealer, then apply salesperson here'
              }
            >
              <Check size={16} aria-hidden />
              Verify & invoice
            </button>
          )}
          {workflowActions.canVerify && (
            <button
              type="button"
              className={`btn btn-primary so-detail__verify-btn${
                workflowActions.actionBusy === 'verify' ? ' so-detail__verify-btn--busy' : ''
              }`}
              disabled={Boolean(workflowActions.actionBusy) || packageBlocksActions}
              title={packageBlocksActions ? freightPackageAlert ?? undefined : undefined}
              onClick={() => {
                if (packageBlocksActions) return;
                void (async () => {
                  try {
                    await persistSparePackaging();
                    workflowActions.onVerify();
                  } catch (err) {
                    window.alert(err instanceof Error ? err.message : 'Could not save spare packaging.');
                  }
                })();
              }}
            >
              {workflowActions.actionBusy === 'verify'
                ? <VerifyInvoiceClock size={22} />
                : <Check size={16} aria-hidden />}
              {workflowActions.actionBusy === 'verify' ? 'Invoicing…' : 'Verify & invoice'}
            </button>
          )}
          {workflowActions.canMarkInvoiced && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(workflowActions.actionBusy) || packageBlocksActions}
              title={
                packageBlocksActions
                  ? freightPackageAlert ?? undefined
                  : 'Sync only — invoice must already exist in Zoho'
              }
              onClick={() => {
                if (packageBlocksActions) return;
                workflowActions.onMarkInvoiced();
              }}
            >
              <BadgeCheck size={16} aria-hidden />
              {workflowActions.actionBusy === 'markInvoiced' ? 'Marking…' : 'Mark as invoiced'}
            </button>
          )}
          {workflowActions.canRepairInvoicing && !invoicingMismatch ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(workflowActions.actionBusy) || packageBlocksActions}
              onClick={() => {
                if (packageBlocksActions) return;
                workflowActions.onRepairInvoicing();
              }}
            >
              <AlertCircle size={16} aria-hidden />
              {workflowActions.actionBusy === 'repairInvoicing'
                ? 'Resetting…'
                : 'Reset invoicing status'}
            </button>
          ) : null}
          {workflowActions.canVoid && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(workflowActions.actionBusy)}
              onClick={() => {
                workflowActions.onVoid();
              }}
            >
              <Ban size={16} aria-hidden />
              {workflowActions.actionBusy === 'void' ? 'Voiding…' : 'Void'}
            </button>
          )}
          {workflowActions.canDelete && (
            <button
              type="button"
              className="btn btn-secondary so-detail__delete-btn"
              disabled={Boolean(workflowActions.actionBusy)}
              onClick={() => {
                workflowActions.onDelete();
              }}
            >
              <Trash2 size={16} aria-hidden />
              {workflowActions.actionBusy === 'delete' ? 'Deleting…' : 'Delete draft'}
            </button>
          )}
          </>
        )}
          </>
        )}
      </footer>

      {showPaymentProof && paymentScreenshotUrl ? (
        <ZoomableImageDialog
          src={paymentScreenshotUrl}
          title="Payment proof"
          alt="Payment screenshot"
          onClose={() => setShowPaymentProof(false)}
        />
      ) : null}

      {(fetchingBankFeeds || bankFeeds) ? (
        <KotakBankFeedsSheet
          feeds={bankFeeds || []}
          fetchedAt={bankFeedsFetchedAt}
          loading={fetchingBankFeeds}
          selecting={reservingKotakFeed}
          matchAmount={salesOrder?.paymentAmount ?? salesOrder?.total ?? null}
          matchCustomerName={salesOrder?.customerName ?? null}
          salesOrderId={salesOrderId}
          reservedTransactionId={salesOrder?.reservedKotakFeed?.transactionId ?? selectedKotakFeed?.transactionId ?? null}
          onSelect={async (feed) => {
            if (!salesOrderId) return;
            if (packageBlocksActions) {
              throw new Error(freightPackageAlert || 'Fill missing package information before invoicing.');
            }
            if (!String(salesOrder?.salespersonId || '').trim()) {
              throw new Error('Assign a salesperson before Select & Invoice.');
            }
            setReservingKotakFeed(true);
            setKotakInvoicePhase('invoicing');
            try {
              unlockOrderAlertAudio();
              const next = await selectKotakFeedAndInvoiceSalesOrder(salesOrderId, feed);
              playOnlineOrderAlert();
              setKotakInvoicePhase('categorizing');
              setSalesOrder(next);
              setSelectedKotakFeed(feed);
              bankFeedFetchGen.current += 1;
              setBankFeeds(null);
              setFetchingBankFeeds(false);
              await new Promise(resolve => window.setTimeout(resolve, 2200));
              playOnlineOrderAlert();
              setKotakInvoicePhase('paid');
            } catch (err) {
              setKotakInvoicePhase(null);
              throw err instanceof Error ? err : new Error('Could not invoice from this bank pay-in.');
            } finally {
              setReservingKotakFeed(false);
            }
          }}
          onClose={() => {
            if (reservingKotakFeed) return;
            bankFeedFetchGen.current += 1;
            setBankFeeds(null);
            setFetchingBankFeeds(false);
          }}
        />
      ) : null}

      {kotakInvoicePhase ? (
        <KotakInvoiceProgressOverlay
          phase={kotakInvoicePhase}
          onPaidDone={() => setKotakInvoicePhase(null)}
        />
      ) : null}

      {orderListOpen && salesOrder ? (
        <SpareOrderListViewDialog
          salesOrder={salesOrder}
          onClose={() => setOrderListOpen(false)}
        />
      ) : null}

      {canEditLines && isMobile && expandedLineItem ? (
        <SoLineEditSheet
          eyebrow={isFreightInvoiceLineItem(expandedLineItem) ? 'Freight' : 'Line item'}
          title={
            isFreightInvoiceLineItem(expandedLineItem)
              ? (expandedLineItem.name?.trim() || 'Freight')
              : (expandedLineItem.name?.trim() || 'Edit item')
          }
          onClose={closeExpandedLine}
        >
          {renderLineEditor(expandedLineItem)}
        </SoLineEditSheet>
      ) : null}
    </div>
  );
};
