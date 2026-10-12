import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { IndianRupee, Package, ShoppingCart, Trash2 } from 'lucide-react';
import { QuantityStepper } from '../../components/QuantityStepper';
import { DelhiveryQuoteStrip } from '../../components/logistics/DelhiveryQuoteStrip';
import { OrderFreightPanel } from '../../components/orders/OrderFreightPanel';
import { ShippingAddressPicker } from '../../components/orders/ShippingAddressPicker';
import { inferStCourierZone } from '../../lib/stCourierZone';
import { CategoryThumbnail } from '../../components/catalog/CategoryThumbnail';
import {
  type GatcStampingChoice,
} from '../../components/catalog/GatcStampingChoiceDialog';
import { GatcStampingInlineControl } from '../../components/catalog/GatcStampingInlineControl';
import { MachineQcInlineControl } from '../../components/catalog/MachineQcInlineControl';
import { DocumentLineItemSpec } from '../../components/invoices/DocumentLineItemSpec';
import { MultiSalesOrderSuccess } from '../../components/salesOrders/MultiSalesOrderSuccess';
import { DealerStaffApprovalQueue } from '../../components/dealers/DealerStaffApprovalQueue';
import { FetchingLoader } from '../../components/FetchingLoader';
import { useAuth } from '../../context/AuthContext';
import { CART_REMARKS_MAX_LENGTH } from '../../context/CartProvider';
import { useCart } from '../../context/useCart';
import { useDealerPriceLevels } from '../../hooks/useDealerUnitPrice';
import { isCatalogProductSalesRestricted } from '../../lib/catalogSalesRestriction';
import { RestrictedItemBadge } from '../../components/catalog/RestrictedItemBadge';
import { useDealerOrderStockGate } from '../../hooks/useDealerOrderStockGate';
import { cartLineIsOutOfStock, fetchCatalog, formatCurrency, isCatalogSparePartProduct } from '../../lib/catalog';
import {
  canPlaceDealerZohoOrder,
  canSeeDealerUnitPrice,
  dealerPortalStaffTeams,
  isLimitedDealerStaff,
  resolveDealerAccountUid,
} from '../../lib/dealerAccess';
import {
  DEALER_ORDER_SCHEDULED_MESSAGE,
  DEALER_ORDER_UNAVAILABLE_MESSAGE,
} from '../../lib/dealerOrderStock';
import {
  formatExtraPriceLevelSlabLabels,
  priceLevelSkipsOpsReview,
} from '../../lib/priceLevels';
import { productHasLinkedGatc } from '../../lib/gatcCart';
import { appendMachineQcDescription, linesHaveMachineQc, productHasMachineQc } from '../../lib/machineQc';
import { attachDealerCustomerInvoiceToSalesOrders } from '../../lib/salesOrderWorkflow';
import {
  dealerOrderErrorMessage,
  submitDealerOrder,
  type SegmentSalesOrderResult,
} from '../../lib/dealerOrders';
import {
  approveDealerStaffOrder,
  rejectDealerStaffOrder,
  submitDealerStaffOrderForApproval,
  subscribeDealerStaffApprovals,
} from '../../lib/dealerStaffOrders';
import { isStaffAttributedCartLine } from '../../lib/dealerSharedCart';
import { selectedPartnerIsDelhivery } from '../../lib/delhiveryCartFreight';
import {
  summarizeSegmentSiteBuckets,
} from '../../lib/salesOrderSegments';
import {
  listDealerShippingAddresses,
  resolveShippingDestination,
  type ShippingAddress,
  type ShippingSelection,
} from '../../lib/shippingAddresses';
import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import { useBlueDartPincode } from '../../hooks/useBlueDartPincode';
import { useDelhiveryLiveFreightQuote } from '../../hooks/useDelhiveryLiveFreightQuote';
import { loadLogisticsCourierRates } from '../../lib/logisticsCourierRates';
import { loadLogisticsSettings } from '../../lib/logisticsSettings';
import type { InventorySite } from '../../lib/salesOrderSegments';
import {
  applyCourierSelectionForSite,
  cartLinesAreSpareOnly,
  cartLinesForFreightEstimate,
  estimateStCourierCartFreight,
  resolveSubmitCourierBySite,
  type StCourierCartFreightEstimate,
} from '../../lib/stCourierCartFreight';
import {
  fetchPendingFreightDiff,
  formatPendingFreightAdjustLabel,
  type PendingFreightDiffPreview,
} from '../../lib/freightDiffSettlement';
import { isInternalOpsUser } from '../../lib/staffAccess';
import { homePathForRole } from '../../types';
import type { CatalogProduct } from '../../types/catalog';
import type { DealerStaffOrderApproval } from '../../types/dealer-staff-orders';
import type { LogisticsCourierRates } from '../../types/logistics-courier-rates';
import type { LogisticsDeliveryRulesMatrix } from '../../types/logistics-delivery-rules';
import type { LogisticsPartnerStatuses } from '../../types/logistics-partner-status';
import type { StaffLogisticsSite } from '../../types/staff-logistics';

export const OrdersPage: React.FC = () => {
  const { user } = useAuth();

  // Staff / super-admin use Zoho sales orders — cart is dealer-only.
  if (isInternalOpsUser(user)) {
    const base = user ? homePathForRole(user.role) : '/staff';
    return <Navigate to={`${base}/sales-orders`} replace />;
  }

  return <DealerCartPage />;
};

const DealerCartPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const {
    items,
    itemCount,
    remarks,
    setRemarks,
    setQuantity,
    removeItem,
    addItem,
    updateStamping,
    updateQc,
    clearCart,
    cartReady,
  } = useCart();
  const isDealerOwner = canPlaceDealerZohoOrder(user);
  const isDealerStaffUser = user?.role === 'dealer_staff';
  const staffTeams = dealerPortalStaffTeams(user) ?? [];
  const teamItems = isDealerOwner ? items.filter(isStaffAttributedCartLine) : [];
  const checkoutItems = isDealerOwner
    ? items.filter(item => !isStaffAttributedCartLine(item))
    : items;
  const checkoutCount = checkoutItems.reduce((sum, item) => sum + item.quantity, 0);
  const checkoutSubtotal = checkoutItems.reduce((sum, item) => sum + item.rate * item.quantity, 0);
  const { level: dealerPriceLevel, billingState } = useDealerPriceLevels();
  const dealerStock = useDealerOrderStockGate();
  const skipsOpsReview = priceLevelSkipsOpsReview(dealerPriceLevel);
  const [submitting, setSubmitting] = useState(false);
  const [dealerInvoicePdf, setDealerInvoicePdf] = useState<File | null>(null);
  const [createdOrders, setCreatedOrders] = useState<SegmentSalesOrderResult[] | null>(null);
  const [submittedForApproval, setSubmittedForApproval] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<DealerStaffOrderApproval[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<ShippingAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(true);
  const [addressesError, setAddressesError] = useState('');
  const [shipping, setShipping] = useState<ShippingSelection | null>(null);
  const [descByProductId, setDescByProductId] = useState<Record<string, string>>({});
  const [catalogById, setCatalogById] = useState<Record<string, CatalogProduct>>({});
  const [courierRates, setCourierRates] = useState<LogisticsCourierRates | null>(null);
  const [deliveryRules, setDeliveryRules] = useState<LogisticsDeliveryRulesMatrix | null>(null);
  const [partnerStatuses, setPartnerStatuses] = useState<LogisticsPartnerStatuses | null>(null);
  const [courierBySite, setCourierBySite] = useState<Partial<Record<InventorySite, LogisticsPartnerId>>>({});
  const [fromAddresses, setFromAddresses] = useState<Partial<Record<StaffLogisticsSite, string>>>({});
  const [freightBillingMode, setFreightBillingMode] = useState<'btc' | 'fod'>('btc');
  const [freightAdjustAgreed, setFreightAdjustAgreed] = useState(true);
  const [pendingFreightDiff, setPendingFreightDiff] = useState<PendingFreightDiffPreview | null>(null);
  const cartHasQc = linesHaveMachineQc(checkoutItems);

  useEffect(() => {
    if (!cartHasQc) setDealerInvoicePdf(null);
  }, [cartHasQc]);

  const base = user ? homePathForRole(user.role) : '/dealer';
  const productsPath = `${base}/products`;
  const dealerAccountUid = resolveDealerAccountUid(user);

  useEffect(() => {
    if (!isDealerOwner || !dealerAccountUid) {
      setPendingApprovals([]);
      return undefined;
    }
    return subscribeDealerStaffApprovals(dealerAccountUid, setPendingApprovals);
  }, [isDealerOwner, dealerAccountUid]);

  const shippingDestination = useMemo(
    () => resolveShippingDestination(shipping, addresses),
    [shipping, addresses],
  );
  const blueDartPin = useBlueDartPincode(shippingDestination?.zip);
  const inferredFreightZone = useMemo(
    () => inferStCourierZone(shippingDestination),
    [shippingDestination],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadLogisticsCourierRates(), loadLogisticsSettings()])
      .then(([rates, settings]) => {
        if (cancelled) return;
        setCourierRates(rates);
        setDeliveryRules(settings.deliveryRules);
        setPartnerStatuses(settings.partnerStatuses);
        setFromAddresses(settings.fromAddresses || {});
      })
      .catch(() => { /* freight preview optional */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchPendingFreightDiff()
      .then(preview => {
        if (!cancelled) setPendingFreightDiff(preview);
      })
      .catch(() => {
        if (!cancelled) setPendingFreightDiff(null);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    void fetchCatalog()
      .then(res => {
        if (cancelled) return;
        const missing = items.filter(item => !item.description?.trim()).map(item => item.productId);
        const nextDesc: Record<string, string> = {};
        const nextCatalog: Record<string, CatalogProduct> = {};
        for (const product of res.items) {
          nextCatalog[product.id] = product;
          const desc = product.description?.trim();
          if (desc && missing.includes(product.id)) nextDesc[product.id] = desc;
        }
        if (Object.keys(nextDesc).length) setDescByProductId(prev => ({ ...prev, ...nextDesc }));
        setCatalogById(nextCatalog);
      })
      .catch(() => { /* keep cart usable without specs */ });
    return () => { cancelled = true; };
  }, [items]);

  const freightEstimateBase = useMemo((): StCourierCartFreightEstimate | null => {
    if (!courierRates || !deliveryRules || !partnerStatuses || checkoutItems.length === 0) return null;
    const freightCartLines = cartLinesForFreightEstimate(checkoutItems, catalogById);
    const spareOnlyCart = cartLinesAreSpareOnly(freightCartLines);
    if (!spareOnlyCart && (!shippingDestination || !inferredFreightZone)) return null;
    return estimateStCourierCartFreight({
      lines: freightCartLines,
      destination: shippingDestination,
      rates: courierRates,
      deliveryRules,
      partnerStatuses,
      courierBySite,
      blueDartPin,
      invoiceValueInr: checkoutSubtotal,
    });
  }, [
    courierRates,
    deliveryRules,
    partnerStatuses,
    checkoutItems,
    shippingDestination,
    catalogById,
    courierBySite,
    inferredFreightZone,
    blueDartPin,
    checkoutSubtotal,
  ]);

  const delhiveryLive = useDelhiveryLiveFreightQuote({
    estimate: freightEstimateBase,
    originAddress: fromAddresses.cochin || fromAddresses.head_office || '',
    destinationPin: shippingDestination?.zip,
    invoiceValueInr: checkoutSubtotal,
    freightBillingMode,
  });

  const freightEstimate = delhiveryLive.estimateWithLive ?? freightEstimateBase;

  const loadAddresses = useCallback(() => {
    setAddressesLoading(true);
    setAddressesError('');
    void listDealerShippingAddresses()
      .then(rows => {
        setAddresses(rows);
      })
      .catch(err => {
        setAddresses([]);
        setAddressesError(dealerOrderErrorMessage(err));
      })
      .finally(() => setAddressesLoading(false));
  }, []);

  useEffect(() => {
    loadAddresses();
  }, [loadAddresses]);

  const stampableWithoutStamping = useMemo(() => {
    return checkoutItems.filter(item => {
      if (item.gatcStampingPriceId) return false;
      const catalogProduct = catalogById[item.productId];
      if (catalogProduct) return productHasLinkedGatc(catalogProduct);
      // Fallback when catalog not loaded yet: treat known stampable cart fields as linked.
      return false;
    });
  }, [checkoutItems, catalogById]);

  const segmentPreview = useMemo(() => {
    const lines = checkoutItems.map(item => {
      const catalog = catalogById[item.productId];
      return {
        categoryId: item.categoryId ?? catalog?.categoryId ?? null,
        categoryName: item.categoryName ?? catalog?.categoryName ?? null,
        productId: item.productId,
        sku: item.sku ?? catalog?.sku ?? null,
        warehouses: catalog?.warehouses ?? null,
      };
    });
    return summarizeSegmentSiteBuckets(lines);
  }, [checkoutItems, catalogById]);

  /** Spare-only cart: partner choice only; freight ₹ set later by staff. */
  const cartIsSpareOnly = useMemo(
    () => segmentPreview.length > 0 && segmentPreview.every(b => b.segment === 'spare'),
    [segmentPreview],
  );
  const hideTeamQty = isLimitedDealerStaff(user);
  const showCartDealerMoney = checkoutItems.every(item => (
    canSeeDealerUnitPrice(user, isCatalogSparePartProduct(catalogById[item.productId] ?? item))
  ));

  /** Checkout total: items + estimated freight (+ pending Diff) + GST (catalog tax %, freight default 18%). */
  const checkoutTotals = useMemo(() => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const defaultGstPct = 18;
    let itemsGst = 0;
    for (const item of checkoutItems) {
      const line = round2(item.rate * item.quantity);
      const pct = catalogById[item.productId]?.taxPercentage;
      const taxPct = Number.isFinite(pct) && (pct as number) > 0 ? (pct as number) : defaultGstPct;
      itemsGst += round2(line * (taxPct / 100));
    }
    const baseFreight = (
      cartIsSpareOnly
        ? 0
        : (
          freightEstimate?.usable
            ? round2(Number(freightEstimate.totalInr) || 0)
            : 0
        )
    );
    const adjust = (
      !cartIsSpareOnly
      && pendingFreightDiff?.willApplyOnNextFreightSo
      && baseFreight > 0
        ? round2(Number(pendingFreightDiff.availableInr) || 0)
        : 0
    );
    const freight = round2(Math.max(0, baseFreight + adjust));
    const freightGst = freight > 0 ? round2(freight * (defaultGstPct / 100)) : 0;
    const gst = round2(itemsGst + freightGst);
    const fodZero = !cartIsSpareOnly
      && freightBillingMode === 'fod'
      && selectedPartnerIsDelhivery(freightEstimate);
    return {
      freight,
      freightAdjust: adjust,
      gst,
      total: round2(checkoutSubtotal + freight + gst),
      hasFreight: Boolean(
        !cartIsSpareOnly
        && freightEstimate?.usable
        && (baseFreight > 0 || Math.abs(adjust) > 0 || fodZero),
      ),
      freightDeferred: cartIsSpareOnly,
    };
  }, [
    checkoutItems,
    catalogById,
    freightEstimate,
    checkoutSubtotal,
    pendingFreightDiff,
    freightBillingMode,
    cartIsSpareOnly,
  ]);

  const { inboundByProductId, raisedPoQty, canOrder } = dealerStock;
  const unorderableItems = useMemo(() => checkoutItems.filter(item => {
    const product = catalogById[item.productId];
    if (product) return !canOrder(product);
    if ((inboundByProductId[item.productId] ?? 0) > 0 || raisedPoQty(item.productId) > 0) return false;
    return cartLineIsOutOfStock(item);
  }), [checkoutItems, catalogById, inboundByProductId, raisedPoQty, canOrder]);

  const restrictedCartItems = useMemo(() => checkoutItems.filter(item => {
    const product = catalogById[item.productId];
    if (!product) return false;
    return isCatalogProductSalesRestricted(product, billingState);
  }), [checkoutItems, catalogById, billingState]);

  const handlePlaceOrder = async () => {
    if (checkoutItems.length === 0 || submitting) return;
    if (unorderableItems.length > 0) {
      window.alert(
        unorderableItems.length === 1
          ? `${unorderableItems[0].name} is out of stock and is not scheduled on a goods receipt.`
          : `${unorderableItems.length} items are out of stock and not scheduled on a goods receipt.`,
      );
      return;
    }
    if (restrictedCartItems.length > 0) {
      window.alert(
        restrictedCartItems.length === 1
          ? `${restrictedCartItems[0].name} is restricted in your state and cannot be ordered.`
          : `${restrictedCartItems.length} items are restricted in your state and cannot be ordered.`,
      );
      return;
    }
    if (!shipping) {
      window.alert(
        isDealerStaffUser
          ? 'Select or enter a complete shipping address before submitting for approval.'
          : 'Select or enter a complete shipping address before placing the order.',
      );
      return;
    }
    if (
      !cartIsSpareOnly
      && selectedPartnerIsDelhivery(freightEstimate)
      && freightBillingMode !== 'fod'
      && !(delhiveryLive.preTaxInr != null && delhiveryLive.preTaxInr > 0)
    ) {
      window.alert(
        delhiveryLive.loading
          ? 'Still estimating Delhivery freight. Try again in a moment.'
          : (delhiveryLive.error || 'Delhivery freight estimate is unavailable for this destination.'),
      );
      return;
    }
    setSubmitting(true);
    try {
      const courierSelection = resolveSubmitCourierBySite(freightEstimate, courierBySite);
      const delhiveryFreight = (
        !cartIsSpareOnly
        && selectedPartnerIsDelhivery(freightEstimate)
      )
        ? (
          freightBillingMode === 'fod'
            ? 0
            : (
              delhiveryLive.preTaxInr != null && delhiveryLive.preTaxInr > 0
                ? Math.ceil(delhiveryLive.preTaxInr)
                : undefined
            )
        )
        : undefined;
      const submitLines = checkoutItems.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        gatcStampingPriceId: item.gatcStampingPriceId ?? null,
        qcEnabled: item.qcEnabled === true,
      }));

      if (isDealerStaffUser) {
        const kind = cartIsSpareOnly && staffTeams.includes('service') ? 'service' : 'sales';
        const submittedByTeam = kind === 'service' || staffTeams[0] === 'service'
          ? 'service'
          : 'sales';
        await submitDealerStaffOrderForApproval({
          lines: submitLines,
          displayLines: checkoutItems,
          cartLineIds: checkoutItems.map(item => item.cartLineId),
          shipping,
          remarks,
          submittedByTeam,
          kind,
          courierBySite: courierSelection,
          freightZone: inferredFreightZone ?? undefined,
          manualFreightAmountInr: delhiveryFreight,
          freightBillingMode: selectedPartnerIsDelhivery(freightEstimate) && !cartIsSpareOnly
            ? freightBillingMode
            : undefined,
        });
        setFreightBillingMode('btc');
        setSubmittedForApproval(true);
        return;
      }

      const order = await submitDealerOrder(
        submitLines,
        shipping,
        remarks,
        courierSelection,
        inferredFreightZone ?? undefined,
        undefined,
        delhiveryFreight,
        selectedPartnerIsDelhivery(freightEstimate) && !cartIsSpareOnly
          ? freightBillingMode
          : undefined,
      );
      if (dealerInvoicePdf) {
        const createdIds = (
          Array.isArray(order.salesOrders) && order.salesOrders.length > 0
            ? order.salesOrders.map(row => row.zohoSalesOrderId)
            : [order.zohoSalesOrderId]
        ).filter((id): id is string => Boolean(id));
        try {
          await attachDealerCustomerInvoiceToSalesOrders(createdIds, dealerInvoicePdf);
        } catch (pdfErr) {
          window.alert(
            pdfErr instanceof Error
              ? `Order placed, but the customer invoice PDF could not be attached: ${pdfErr.message}`
              : 'Order placed, but the customer invoice PDF could not be attached.',
          );
        }
        setDealerInvoicePdf(null);
      }
      clearCart();
      setFreightBillingMode('btc');
      const salesOrders = Array.isArray(order.salesOrders) && order.salesOrders.length > 0
        ? order.salesOrders
        : (order.zohoSalesOrderId
          ? [{
              segment: 'product' as const,
              segmentLabel: 'Product',
              orderNumber: order.orderNumber,
              zohoSalesOrderId: order.zohoSalesOrderId,
              zohoSalesOrderNumber: order.zohoSalesOrderNumber,
              status: order.status,
              subtotal: order.subtotal,
              itemCount: order.itemCount,
              salespersonId: null,
              salespersonName: null,
            }]
          : []);
      if (salesOrders.length > 1) {
        setCreatedOrders(salesOrders);
        return;
      }
      const soId = salesOrders[0]?.zohoSalesOrderId?.trim() || order.zohoSalesOrderId?.trim();
      navigate(
        soId ? `${base}/sales-orders/${soId}` : `${base}/sales-orders`,
        { replace: true },
      );
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveStaffOrder = async (approvalId: string) => {
    if (approvalBusyId) return;
    setApprovalBusyId(approvalId);
    try {
      const order = await approveDealerStaffOrder(approvalId);
      const salesOrders = Array.isArray(order.salesOrders) && order.salesOrders.length > 0
        ? order.salesOrders
        : [];
      if (salesOrders.length > 1) {
        setCreatedOrders(salesOrders);
        return;
      }
      const soId = salesOrders[0]?.zohoSalesOrderId?.trim() || order.zohoSalesOrderId?.trim();
      navigate(
        soId ? `${base}/sales-orders/${soId}` : `${base}/sales-orders`,
        { replace: true },
      );
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setApprovalBusyId(null);
    }
  };

  const handleRejectStaffOrder = async (approvalId: string) => {
    if (approvalBusyId) return;
    if (!window.confirm('Reject this team order? Items will return to the cart.')) return;
    setApprovalBusyId(approvalId);
    try {
      await rejectDealerStaffOrder(approvalId);
    } catch (err) {
      window.alert(dealerOrderErrorMessage(err));
    } finally {
      setApprovalBusyId(null);
    }
  };

  const applyLineStamping = (cartLineId: string, choice: GatcStampingChoice) => {
    updateStamping(cartLineId, {
      withStamping: choice.withStamping,
      gatcStampingPriceId: choice.gatcStampingPriceId,
      gatcFeePerUnit: choice.gatcFeePerUnit,
      gatcStampingRange: choice.gatcStampingRange,
    });
  };

  if (!cartReady) {
    return (
      <div className="page-content fade-in orders-page">
        <FetchingLoader label="Loading cart…" />
      </div>
    );
  }

  if (submittedForApproval) {
    return (
      <div className="page-content fade-in orders-page">
        <div className="dealer-orders-page__header">
          <div>
            <h2 className="orders-page__title">Submitted for approval</h2>
            <p className="text-muted text-sm">
              {staffTeams.includes('service') && !staffTeams.includes('sales')
                ? 'Your spare order was sent to the dealer. It will go to YesOne after they approve it.'
                : 'Your order was sent to the dealer. It will go to YesOne after they approve it.'}
            </p>
          </div>
        </div>
        <div className="orders-page__empty panel glass">
          <ShoppingCart size={48} />
          <h2>Waiting for dealer approval</h2>
          <p className="text-muted">You can keep browsing and add more items to a new cart.</p>
          <Link to={productsPath} className="btn btn-primary">
            Browse products
          </Link>
        </div>
      </div>
    );
  }

  if (createdOrders && createdOrders.length > 0) {
    return (
      <div className="page-content fade-in orders-page">
        <div className="dealer-orders-page__header">
          <div>
            <h2 className="orders-page__title">Order placed</h2>
            <p className="text-muted text-sm">Draft sales orders were created in Zoho Inventory.</p>
          </div>
        </div>
        <MultiSalesOrderSuccess
          salesOrders={createdOrders}
          detailBasePath={`${base}/sales-orders`}
          listPath={`${base}/sales-orders`}
        />
      </div>
    );
  }

  const listedItems = isDealerOwner ? [...teamItems, ...checkoutItems] : checkoutItems;
  const checkoutSubtitle = isDealerStaffUser
    ? (cartIsSpareOnly
      ? 'Submit this spare order to your dealer for approval'
      : 'Submit this order to your dealer for approval')
    : '';

  if (items.length === 0 && pendingApprovals.length === 0) {
    return (
      <div className="page-content fade-in orders-page">
        <div className="dealer-orders-page__header">
          <div>
            <h2 className="orders-page__title">Your cart</h2>
            <p className="text-muted text-sm">
              {isDealerStaffUser
                ? 'Add products, then submit to your dealer for approval.'
                : 'Add products, then place your order.'}
            </p>
          </div>
          <Link to={`${base}/sales-orders`} className="btn btn-secondary btn-sm">
            Sales orders
          </Link>
        </div>
        <div className="orders-page__empty panel glass">
          <ShoppingCart size={48} />
          <h2>Your cart is empty</h2>
          <p className="text-muted">Browse products and add items to build your order.</p>
          <Link to={productsPath} className="btn btn-primary">
            Browse products
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content fade-in orders-page">
      <div className="orders-page__header">
        <div>
          <h2 className="orders-page__title">Your cart</h2>
          <p className="text-muted text-sm">
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
            {checkoutSubtitle ? ` · ${checkoutSubtitle}` : ''}
            {teamItems.length > 0 ? ` · ${teamItems.length} from team` : ''}
            {pendingApprovals.length > 0
              ? ` · ${pendingApprovals.length} waiting for approval`
              : ''}
          </p>
        </div>
        <div className="orders-page__header-actions">
          <Link to={`${base}/sales-orders`} className="btn btn-secondary btn-sm">
            Sales orders
          </Link>
          {listedItems.length > 0 ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearCart}>
            Clear cart
          </button>
          ) : null}
        </div>
      </div>

      {isDealerOwner ? (
        <DealerStaffApprovalQueue
          approvals={pendingApprovals}
          busyId={approvalBusyId}
          onApprove={id => void handleApproveStaffOrder(id)}
          onReject={id => void handleRejectStaffOrder(id)}
        />
      ) : null}

      {stampableWithoutStamping.length > 0 && (
        <div className="orders-page__stamp-reminder panel glass" role="status">
          <p>
            {stampableWithoutStamping.length === 1
              ? '1 item can have stamping added.'
              : `${stampableWithoutStamping.length} items can have stamping added.`}
            {' '}
            Use the stamping control on the line, or <strong>+ Add with stamping</strong> for a separate stamped line.
          </p>
        </div>
      )}

      <div className="orders-page__layout">
        <div className="orders-page__cart-column">
          <ul className="orders-page__items">
            {listedItems.map(item => {
              const lineTotal = item.rate * item.quantity;
              const catalogProduct = catalogById[item.productId];
              const scheduledQty = dealerStock.scheduledQty(item.productId);
              const poQty = dealerStock.raisedPoQty(item.productId);
              const canOrderLine = catalogProduct
                ? dealerStock.canOrder(catalogProduct)
                : scheduledQty > 0 || poQty > 0 || !cartLineIsOutOfStock(item);
              const isSpareLine = isCatalogSparePartProduct(catalogProduct ?? item);
              const showLineDealerPrice = canSeeDealerUnitPrice(user, isSpareLine);
              const inboundOnly = catalogProduct
                ? dealerStock.usesScheduledInbound(catalogProduct)
                : cartLineIsOutOfStock(item) && (scheduledQty > 0 || poQty > 0);
              const lineRestricted = Boolean(
                catalogProduct && isCatalogProductSalesRestricted(catalogProduct, billingState),
              );
              const canEditStamp = catalogProduct
                ? productHasLinkedGatc(catalogProduct)
                : Boolean(item.gatcStampingPriceId);
              const hasStamping = Boolean(item.gatcStampingPriceId);
              const usedGatcIds = listedItems
                .filter(other => other.productId === item.productId
                  && other.gatcStampingPriceId
                  && (other.addedByUid || null) === (item.addedByUid || null))
                .map(other => String(other.gatcStampingPriceId));
              const hasUnstampedSibling = listedItems.some(
                other => other.productId === item.productId
                  && !other.gatcStampingPriceId
                  && (other.addedByUid || null) === (item.addedByUid || null),
              );

              return (
                <li
                  key={item.cartLineId}
                  className={`orders-page__item panel glass ${!canOrderLine ? 'orders-page__item--unavailable' : ''}`}
                >
                  <div className="orders-page__item-aside">
                    <div className="orders-page__item-media">
                      {item.imageUrl ? (
                        <CategoryThumbnail src={item.imageUrl} knockout={false} />
                      ) : (
                        <Package size={28} aria-hidden />
                      )}
                    </div>
                    {catalogProduct && productHasMachineQc(catalogProduct) ? (
                      <MachineQcInlineControl
                        compact
                        product={catalogProduct}
                        qcEnabled={item.qcEnabled === true}
                        disabled={submitting}
                        onChange={next => updateQc(item.cartLineId, { qcEnabled: next })}
                        pdfFile={dealerInvoicePdf}
                        onPdfFileChange={setDealerInvoicePdf}
                      />
                    ) : null}
                  </div>

                  <DocumentLineItemSpec
                    className="orders-page__item-info invoice-detail-item__body"
                    name={item.name}
                    sku={item.sku}
                    description={appendMachineQcDescription(
                      item.description || descByProductId[item.productId] || null,
                      { qcEnabled: item.qcEnabled === true },
                    )}
                  >
                    {isStaffAttributedCartLine(item) && item.addedByName ? (
                      <p className="orders-page__added-by">
                        Added by {item.addedByName}
                        {item.addedByTeam === 'service'
                          ? ' · Service'
                          : item.addedByTeam === 'sales'
                            ? ' · Sales'
                            : ''}
                      </p>
                    ) : null}
                    <div className="orders-page__item-price">
                      {showLineDealerPrice ? (
                        <>
                      {(item.priceLevelMode === 'discount' || item.priceLevelMode === 'fixed')
                        && item.listRate != null
                        && item.listRate > item.baseRate ? (
                        <>
                          <span className="orders-page__item-list-rate">
                            <IndianRupee size={12} strokeWidth={2.5} aria-hidden />
                            {item.listRate.toLocaleString('en-IN')}
                          </span>
                          <IndianRupee size={14} strokeWidth={2.5} aria-hidden />
                          <span>{item.rate.toLocaleString('en-IN')}</span>
                        </>
                      ) : (
                        <>
                          <IndianRupee size={14} strokeWidth={2.5} aria-hidden />
                          <span>{item.rate.toLocaleString('en-IN')}</span>
                        </>
                      )}
                      <span className="text-muted text-sm">/ {item.unit}</span>
                      {(() => {
                        const extraSlabs = item.priceLevelSlabs?.length
                          ? formatExtraPriceLevelSlabLabels(item.priceLevelSlabs, item.rate)
                          : [];
                        if (!extraSlabs.length) return null;
                        return (
                        <ul className="orders-page__item-slabs" aria-label="Quantity rates">
                          {extraSlabs.map(row => (
                            <li key={`${row.minQty}-${row.rate}`}>
                              <span>₹{row.rate.toLocaleString('en-IN')}</span>
                              <span>{row.label}</span>
                            </li>
                          ))}
                        </ul>
                        );
                      })()}
                        </>
                      ) : (
                        <span className="text-muted text-sm">/ {item.unit}</span>
                      )}
                    </div>
                    {showLineDealerPrice && (item.gatcFeePerUnit > 0 || (item.qcFeePerUnit ?? 0) > 0) ? (
                      <span className="orders-page__item-price-breakdown text-muted">
                        {item.baseRate.toLocaleString('en-IN')}
                        {item.gatcFeePerUnit > 0
                          ? ` + ${item.gatcFeePerUnit.toLocaleString('en-IN')} stamping${item.gatcStampingRange ? ` (${item.gatcStampingRange})` : ''}`
                          : ''}
                        {(item.qcFeePerUnit ?? 0) > 0
                          ? ` + ${(item.qcFeePerUnit ?? 0).toLocaleString('en-IN')} QC`
                          : ''}
                      </span>
                    ) : showLineDealerPrice && canEditStamp ? null : showLineDealerPrice ? (
                      <span className="orders-page__item-price-breakdown text-muted">
                        Without stamping
                      </span>
                    ) : null}
                    {canEditStamp && catalogProduct && (
                      <GatcStampingInlineControl
                        product={catalogProduct}
                        valueId={item.gatcStampingPriceId}
                        hasStamping={hasStamping}
                        usedGatcIds={usedGatcIds}
                        hasUnstampedSibling={hasUnstampedSibling}
                        disabled={submitting}
                        onChange={choice => applyLineStamping(item.cartLineId, choice)}
                        onAddSibling={choice => {
                          if (!choice.withStamping) {
                            addItem(catalogProduct, {
                              quantity: 1,
                              insertAfterCartLineId: item.cartLineId,
                              qcEnabled: item.qcEnabled === true,
                            });
                            return;
                          }
                          addItem(catalogProduct, {
                            quantity: 1,
                            insertAfterCartLineId: item.cartLineId,
                            gatcStampingPriceId: choice.gatcStampingPriceId,
                            gatcFeePerUnit: choice.gatcFeePerUnit,
                            gatcStampingRange: choice.gatcStampingRange,
                            qcEnabled: item.qcEnabled === true,
                          });
                        }}
                      />
                    )}
                    {!canOrderLine && !lineRestricted && (
                      <p className="orders-page__item-warning orders-page__item-warning--blocked">
                        {DEALER_ORDER_UNAVAILABLE_MESSAGE}
                      </p>
                    )}
                    {lineRestricted && (
                      <div className="orders-page__item-restricted">
                        <RestrictedItemBadge />
                      </div>
                    )}
                    {inboundOnly && !hideTeamQty && (
                      <p className="orders-page__item-warning">
                        {DEALER_ORDER_SCHEDULED_MESSAGE}
                      </p>
                    )}
                  </DocumentLineItemSpec>

                  <div className="orders-page__item-actions">
                    <QuantityStepper
                      value={item.quantity}
                      onChange={next => setQuantity(item.cartLineId, next)}
                      className="orders-page__qty"
                      buttonClassName="orders-page__qty-btn"
                      inputClassName="orders-page__qty-input"
                      disabled={lineRestricted}
                    />

                    <div className="orders-page__line-total">
                      {showLineDealerPrice ? (
                        <>
                          <IndianRupee size={14} strokeWidth={2.5} aria-hidden />
                          <span>{lineTotal.toLocaleString('en-IN')}</span>
                        </>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      className="orders-page__remove"
                      onClick={() => removeItem(item.cartLineId)}
                      aria-label="Remove from cart"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <Link to={productsPath} className="btn btn-secondary orders-page__continue">
            Add more products
          </Link>
        </div>

        {checkoutItems.length > 0 ? (
        <aside className="orders-page__summary panel glass">
          <h3>Order summary</h3>
          <div className="orders-page__summary-row">
            <span>Subtotal ({checkoutCount} {checkoutCount === 1 ? 'item' : 'items'})</span>
            <strong>{showCartDealerMoney ? formatCurrency(checkoutSubtotal) : '—'}</strong>
          </div>
          <p className="orders-page__summary-note text-muted text-sm">
            {isDealerStaffUser
              ? (cartIsSpareOnly
                ? 'This spare order is sent to your dealer. It is not placed in YesOne until they approve it.'
                : 'This order is sent to your dealer. It is not placed in YesOne until they approve it.')
              : (skipsOpsReview
                ? (segmentPreview.length > 1
                  ? `This cart will create ${segmentPreview.length} sales orders: ${segmentPreview.map(b => b.label).join(', ')}. Directors price level skips review — payment will be due as soon as you submit.`
                  : 'Directors price level skips review. After submit, payment is due (Awaiting payment). Staff can still change items or address until you pay.')
                : (segmentPreview.length > 1
                  ? `This cart will create ${segmentPreview.length} draft sales orders: ${segmentPreview.map(b => b.label).join(', ')}. Each order type and branch uses its own Zoho salesperson.`
                  : segmentPreview[0]
                    ? `Your order is created in Zoho Inventory as Draft (${segmentPreview[0].label}). After submit, only staff can change items or address.`
                    : 'Your order is created in Zoho Inventory as Draft. After submit, only staff can change items or address.'))}
          </p>
          <label className="orders-page__remarks">
            <span className="orders-page__remarks-label">Remarks</span>
            <textarea
              className="orders-page__remarks-input"
              value={remarks}
              onChange={e => setRemarks(e.target.value)}
              disabled={submitting}
              rows={3}
              maxLength={CART_REMARKS_MAX_LENGTH}
              placeholder="Optional notes for this order (shown to staff on the sales order)"
            />
            {remarks.length > 0 && (
              <span className="orders-page__remarks-count text-muted text-sm">
                {remarks.length}/{CART_REMARKS_MAX_LENGTH}
              </span>
            )}
          </label>
          <ShippingAddressPicker
            addresses={addresses}
            loading={addressesLoading}
            error={addressesError}
            disabled={submitting}
            value={shipping}
            onChange={setShipping}
            onRefresh={loadAddresses}
            allowManage
          />
          {freightEstimate?.usable ? (
            <>
              <OrderFreightPanel
                estimate={freightEstimate}
                canEditPackage={false}
                showFreightChargePlan={false}
                clubSites
                hideFreightAmounts={false}
                deferFreightMessage={null}
                catalogById={catalogById}
                destinationLabel={[
                  shippingDestination?.city,
                  shippingDestination?.state,
                ].filter(Boolean).join(', ') || null}
                footerNote={
                  cartIsSpareOnly
                    ? 'ST Courier is always available for spare orders. Freight uses the ST rate card (Other states plan until a shipping address is set).'
                    : 'Estimated freight for this order. Delhivery BTC uses a live API quote; FOD keeps the Delhivery line at ₹0 (consignee pays).'
                }
                freightBillingMode={freightBillingMode}
                onFreightBillingModeChange={setFreightBillingMode}
                onCourierChange={(site, partnerId) => {
                  if (partnerId !== 'delhivery') setFreightBillingMode('btc');
                  setCourierBySite(prev => applyCourierSelectionForSite(
                    prev,
                    site,
                    partnerId,
                    freightEstimate?.sites.map(s => s.site),
                  ));
                }}
              />
              {!cartIsSpareOnly
                && delhiveryLive.showStrip
                && selectedPartnerIsDelhivery(freightEstimate) ? (
                <DelhiveryQuoteStrip
                  originPin={delhiveryLive.originPin || null}
                  destinationPin={delhiveryLive.destinationPin}
                  weightKg={freightEstimate.totalChargeableKg || 5}
                  invAmount={checkoutSubtotal}
                  freightBillingMode={freightBillingMode}
                  includeEstimate={false}
                  compact
                />
              ) : null}
            </>
          ) : !shipping && !addressesLoading && !cartIsSpareOnly ? (
            <p className="orders-page__freight-note text-muted text-sm">
              Select a shipping address to see freight and courier options.
            </p>
          ) : null}
          <div className="orders-page__checkout-total" aria-label="Order total">
            <div className="orders-page__summary-row">
              <span>Subtotal</span>
              <span>{showCartDealerMoney ? formatCurrency(checkoutSubtotal) : '—'}</span>
            </div>
            <div className="orders-page__summary-row">
              <span>Freight</span>
              <span>
                {checkoutTotals.freightDeferred
                  ? 'Updated later'
                  : checkoutTotals.hasFreight
                    ? (showCartDealerMoney ? formatCurrency(checkoutTotals.freight) : '—')
                    : '—'}
              </span>
            </div>
            {!checkoutTotals.freightDeferred && checkoutTotals.freightAdjust !== 0 ? (
              <p className="orders-page__freight-note text-muted text-sm" style={{ margin: 0 }}>
                {formatPendingFreightAdjustLabel(checkoutTotals.freightAdjust)}
                {pendingFreightDiff?.sourceInvoiceNumber
                  ? ` (${pendingFreightDiff.sourceInvoiceNumber})`
                  : ''}
              </p>
            ) : null}
            <div className="orders-page__summary-row">
              <span>GST</span>
              <span>{showCartDealerMoney ? formatCurrency(checkoutTotals.gst) : '—'}</span>
            </div>
            <div className="orders-page__summary-row orders-page__summary-row--total">
              <span>Total</span>
              <strong>{showCartDealerMoney ? formatCurrency(checkoutTotals.total) : '—'}</strong>
            </div>
          </div>
          <label className="orders-page__freight-agree">
            <input
              type="checkbox"
              checked={freightAdjustAgreed}
              disabled={submitting}
              onChange={e => setFreightAdjustAgreed(e.target.checked)}
            />
            <span>
              I agree that any difference in actual freight charges may be adjusted in my next order/bill.
            </span>
          </label>
          <button
            type="button"
            className="btn btn-primary orders-page__submit"
            disabled={
              submitting
              || checkoutItems.length === 0
              || !shipping
              || addressesLoading
              || !freightAdjustAgreed
              || unorderableItems.length > 0
              || restrictedCartItems.length > 0
            }
            onClick={() => void handlePlaceOrder()}
          >
            {submitting
              ? (isDealerStaffUser ? 'Submitting…' : 'Placing…')
              : (isDealerStaffUser ? 'Submit for approval' : 'Place order')}
          </button>
        </aside>
        ) : null}
      </div>
    </div>
  );
};
