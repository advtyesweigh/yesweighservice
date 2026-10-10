import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  KeyRound,
  MapPin,
  Package,
  Search,
  Wrench,
  ShoppingCart,
  Trash2,
  UserCircle,
} from 'lucide-react';
import { DocumentKamStrip } from '../../components/admin/DocumentKamStrip';
import { KamCardPicker } from '../../components/admin/KamCardPicker';
import { CatalogBrowse } from '../../components/catalog/CatalogBrowse';
import { CatalogCategoryChips } from '../../components/catalog/CatalogCategoryChips';
import { CategoryThumbnail } from '../../components/catalog/CategoryThumbnail';
import {
  type GatcStampingChoice,
} from '../../components/catalog/GatcStampingChoiceDialog';
import { GatcStampingInlineControl } from '../../components/catalog/GatcStampingInlineControl';
import { DocumentLineItemSpec } from '../../components/invoices/DocumentLineItemSpec';
import { MultiSalesOrderSuccess } from '../../components/salesOrders/MultiSalesOrderSuccess';
import { StaffSoProductPeek } from '../../components/salesOrders/StaffSoProductPeek';
import { DecimalAmountInput } from '../../components/DecimalAmountInput';
import { QuantityStepper } from '../../components/QuantityStepper';
import { DelhiveryQuoteStrip } from '../../components/logistics/DelhiveryQuoteStrip';
import { OrderFreightPanel } from '../../components/orders/OrderFreightPanel';
import { ShippingAddressPicker } from '../../components/orders/ShippingAddressPicker';
import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import { useBlueDartPincode } from '../../hooks/useBlueDartPincode';
import { useDelhiveryLiveFreightQuote } from '../../hooks/useDelhiveryLiveFreightQuote';
import { selectedPartnerIsDelhivery } from '../../lib/delhiveryCartFreight';
import { loadLogisticsCourierRates } from '../../lib/logisticsCourierRates';
import { loadLogisticsSettings } from '../../lib/logisticsSettings';
import {
  applyCourierSelectionForSite,
  cartLinesAreSpareOnly,
  cartLinesForFreightEstimate,
  estimateAllSitesPickup,
  estimateStCourierCartFreight,
  listProductsMissingFreightPackageInfo,
  resolveSubmitCourierBySite,
  type StCourierCartFreightEstimate,
} from '../../lib/stCourierCartFreight';
import type { StaffLogisticsSite } from '../../types/staff-logistics';
import type { SpareBoxDefinition } from '../../types/spare-box-definitions';
import {
  createEmptySpareFreightPackagingDraft,
  SpareFreightPackagingFields,
  spareFreightPackagingsFromDrafts,
  type SpareFreightPackagingDraft,
  type SpareFreightPartnerQuoteNote,
} from '../../components/salesOrders/SpareFreightPackagingFields';
import {
  blueDartServiceForPartner,
  isBlueDartLogisticsPartnerId,
  isTrackonLogisticsPartnerId,
} from '../../constants/logisticsPartners';
import { isPickupPartner } from '../../lib/orderFreight';
import {
  fetchPendingFreightDiff,
  formatPendingFreightAdjustLabel,
  type PendingFreightDiffPreview,
} from '../../lib/freightDiffSettlement';
import { inferStCourierZone } from '../../lib/stCourierZone';
import type { LogisticsCourierRates } from '../../types/logistics-courier-rates';
import type { LogisticsDeliveryRulesMatrix } from '../../types/logistics-delivery-rules';
import type { LogisticsPartnerStatuses } from '../../types/logistics-partner-status';
import { useCatalogPageHeader } from '../../context/PageHeaderContext';
import { useAuth } from '../../context/AuthContext';
import { whatsappInboxChatPath } from '../../lib/whatsappInbox';
import { useCart } from '../../context/useCart';
import { useCartFly } from '../../context/useCartFly';
import {
  excludeHiddenCatalogProducts,
  fetchCatalog,
  fetchSpareLinkIndex,
  formatCurrency,
  getCategoriesForProducts,
  getCatalogSparePartsPool,
  isHiddenCatalogCategory,
} from '../../lib/catalog';
import { canViewCatalogStock } from '../../lib/dealerAccess';
import { combinedCartRate, productHasLinkedGatc } from '../../lib/gatcCart';
import {
  ensureDealersCached,
  peekCachedDealers,
  subscribeDealerCache,
} from '../../lib/dealer-cache';
import {
  dealerOrderErrorMessage,
  type SegmentSalesOrderResult,
} from '../../lib/dealerOrders';
import {
  dealerMatchesLogisticsQuery,
  zohoDealerContactPerson,
  zohoDealerToSnapshot,
} from '../../lib/logisticsDealers';
import {
  classifyOrderLineSegment,
  isFreightOrderLine,
  segmentAllowsFreight,
  segmentLabel,
  staffAllowedOrderSegments,
  summarizeSegments,
  summarizeSegmentSiteBuckets,
  type InventorySite,
  type OrderSegment,
} from '../../lib/salesOrderSegments';
import {
  CLOUD_CHARGES_SALESPERSON_ID,
  CLOUD_CHARGES_SALESPERSON_NAME,
} from '../../constants/cloudChargesSalesperson';
import {
  SHIBIN_SALESPERSON_ID,
  SHIBIN_SALESPERSON_NAME,
} from '../../constants/shibinSalesperson';
import { hasStaffPermission, isFullSuperAdmin } from '../../lib/staffAccess';
import { createStaffSalesOrder } from '../../lib/salesOrderWorkflow';
import {
  addressesFromDealerCache,
  listCustomerShippingAddresses,
  resolveShippingDestination,
  type ShippingAddress,
  type ShippingSelection,
} from '../../lib/shippingAddresses';
import {
  primaryZohoSalespersonForUser,
} from '../../lib/spareIncharge';
import {
  listZohoSalespersons,
  listZohoSalespersonsFromFirestore,
  type ZohoSalespersonOption,
} from '../../lib/zohoSalespersons';
import {
  collapseToPortalKamOptions,
  portalKamIdForSalesperson,
} from '../../lib/dealerKamDisplay';
import { normalizeZohoSalespersonLinks } from '../../lib/zohoSalespersonStaff';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import type { CatalogCategory, CatalogProduct } from '../../types/catalog';
import type { ZohoDealer } from '../../types/dealers';
import type { CartItem } from '../../types/cart';

type WizardStep = 'dealer' | 'catalog' | 'preview';

type SelectedDealer = {
  id: string;
  label: string;
  contactPerson: string | null;
  mobile: string | null;
  assignedStaffUid: string | null;
  assignedStaffName: string | null;
};

type SalespersonPreview = {
  source: 'cloud' | 'spare_incharge' | 'shibin' | 'self' | 'kam' | 'pick';
  title: string;
  salespersonId: string | null;
  salespersonName: string | null;
  staffName: string | null;
  hint: string | null;
  error: string | null;
  loading: boolean;
};

function formatShippingSummary(
  shipping: ShippingSelection | null,
  addresses: ShippingAddress[],
): string {
  if (!shipping) return 'No address selected';
  if (shipping.mode === 'saved') {
    const match = addresses.find(addr => addr.addressId === shipping.addressId);
    return match?.formatted?.trim()
      || match?.label?.trim()
      || 'Saved address';
  }
  if (shipping.mode === 'kind') {
    return shipping.kind === 'billing' ? 'Billing address' : 'Shipping address';
  }
  const parts = [
    shipping.newAddress.attention,
    shipping.newAddress.address,
    shipping.newAddress.city,
    shipping.newAddress.state,
    shipping.newAddress.zip,
  ].map(part => String(part ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : 'New address';
}

async function loadStaffSalesperson(uid: string): Promise<{
  salespersonId: string;
  salespersonName: string | null;
  staffName: string;
} | null> {
  const id = uid.trim();
  if (!id) return null;
  const snap = await getDoc(doc(db, 'users', id));
  if (!snap.exists()) return null;
  const data = snap.data() as Record<string, unknown>;
  if (data.active === false) return null;
  const link = primaryZohoSalespersonForUser({
    zohoSalespersonLinks: data.zohoSalespersonLinks as { id: string; name: string | null }[] | null,
    zohoSalespersonIds: data.zohoSalespersonIds as string[] | null,
    zohoSalespersonId: data.zohoSalespersonId as string | null,
    zohoSalespersonName: data.zohoSalespersonName as string | null,
  });
  if (!link?.id) return null;
  return {
    salespersonId: link.id,
    salespersonName: link.name,
    staffName: String(data.displayName ?? 'Staff').trim() || 'Staff',
  };
}

function toSelectedDealer(dealer: ZohoDealer): SelectedDealer {
  const snapshot = zohoDealerToSnapshot(dealer);
  const label = snapshot.name;
  const contactPerson = zohoDealerContactPerson(dealer);
  return {
    id: dealer.id,
    label,
    contactPerson: contactPerson !== '—' && contactPerson !== label ? contactPerson : null,
    mobile: snapshot.mobile !== '—' ? snapshot.mobile : null,
    assignedStaffUid: dealer.assignedStaffUid?.trim() || null,
    assignedStaffName: dealer.assignedStaffName?.trim() || null,
  };
}

function progressClass(currentIndex: number, index: number): string {
  if (index < currentIndex) return 'is-done';
  if (index === currentIndex) return 'is-active';
  return '';
}

function dealerLocationLabel(dealer: ZohoDealer): string | null {
  const city = (
    dealer.zohoShippingAddressRaw?.city
    || dealer.zohoBillingAddressRaw?.city
    || dealer.district
    || ''
  ).trim();
  const state = (
    dealer.zohoShippingAddressRaw?.state
    || dealer.zohoBillingAddressRaw?.state
    || dealer.billingState
    || ''
  ).trim();
  const parts = [city, state].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export const StaffCreateSalesOrderPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const shareToWa = String(searchParams.get('wa') || '').replace(/\D/g, '');
  const shareToWaNeedle = shareToWa.length >= 10 ? shareToWa.slice(-10) : shareToWa;
  const inboxPath = shareToWa ? whatsappInboxChatPath(shareToWa) : '';
  const {
    items: cartItems,
    itemCount,
    setQuantity,
    removeItem,
    addItem,
    updateStamping,
    clearCart,
    remarks: cartRemarks,
    setRemarks: setCartRemarks,
  } = useCart();
  const { registerCartTarget, cartBump } = useCartFly();
  const cartBtnRef = useRef<HTMLButtonElement>(null);

  const canManage = hasStaffPermission(user, 'orders.manage');
  const listPath = pathname.startsWith('/super-admin')
    ? '/super-admin/sales-orders'
    : '/staff/sales-orders';
  const leavePath = inboxPath || listPath;

  const allowedSegments = useMemo(() => staffAllowedOrderSegments(user), [user]);
  const [selectedSegment, setSelectedSegment] = useState<OrderSegment | ''>('');
  /** Mixed cart like dealer — submit splits by segment×site. */
  const [step, setStep] = useState<WizardStep>('dealer');

  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  const [catalogCategories, setCatalogCategories] = useState<CatalogCategory[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [browseCategoryId, setBrowseCategoryId] = useState('');
  const [spareCountByProductId, setSpareCountByProductId] = useState<Map<string, number> | null>(null);
  const [peekProduct, setPeekProduct] = useState<CatalogProduct | null>(null);
  const showStockQuantity = canViewCatalogStock(user);

  const [dealerQuery, setDealerQuery] = useState('');
  const [dealers, setDealers] = useState<ZohoDealer[]>([]);
  const [, setDealersLoading] = useState(false);
  const [selectedDealer, setSelectedDealer] = useState<SelectedDealer | null>(null);

  const [addresses, setAddresses] = useState<ShippingAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [addressWarning, setAddressWarning] = useState('');
  const [shipping, setShipping] = useState<ShippingSelection | null>(null);
  const [salespersonId, setSalespersonId] = useState('');
  const [salespersons, setSalespersons] = useState<ZohoSalespersonOption[]>([]);
  const [salespersonsLoading, setSalespersonsLoading] = useState(false);
  const [segmentSpMap, setSegmentSpMap] = useState<Partial<Record<OrderSegment, SalespersonPreview>>>({});
  const [spLoading, setSpLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createdOrders, setCreatedOrders] = useState<SegmentSalesOrderResult[] | null>(null);
  const [rateOverrides, setRateOverrides] = useState<Record<string, number>>({});
  const [courierRates, setCourierRates] = useState<LogisticsCourierRates | null>(null);
  const [deliveryRules, setDeliveryRules] = useState<LogisticsDeliveryRulesMatrix | null>(null);
  const [partnerStatuses, setPartnerStatuses] = useState<LogisticsPartnerStatuses | null>(null);
  const [spareBoxDefinitions, setSpareBoxDefinitions] = useState<SpareBoxDefinition[]>([]);
  const [sparePackagingDrafts, setSparePackagingDrafts] = useState<SpareFreightPackagingDraft[]>(
    () => [createEmptySpareFreightPackagingDraft()],
  );
  const [courierBySite, setCourierBySite] = useState<Partial<Record<InventorySite, LogisticsPartnerId>>>({});
  const [manualFreightAmount, setManualFreightAmount] = useState<number | null>(null);
  const [manualFreightAmountLocked, setManualFreightAmountLocked] = useState(false);
  const [freightBillingMode, setFreightBillingMode] = useState<'btc' | 'fod'>('btc');
  const [fromAddresses, setFromAddresses] = useState<Partial<Record<StaffLogisticsSite, string>>>({});
  const [pendingFreightDiff, setPendingFreightDiff] = useState<PendingFreightDiffPreview | null>(null);

  useEffect(() => {
    setSelectedSegment(prev => {
      if (prev && allowedSegments.includes(prev)) return prev;
      if (allowedSegments.includes('product')) return 'product';
      return allowedSegments[0] ?? '';
    });
  }, [allowedSegments]);

  const activeSegments = useMemo(
    () => (selectedSegment && allowedSegments.includes(selectedSegment)
      ? [selectedSegment]
      : []),
    [selectedSegment, allowedSegments],
  );

  const freightAllowed = activeSegments.some(segment => segmentAllowsFreight(segment));

  const steps = useMemo((): WizardStep[] => (
    ['dealer', 'catalog', 'preview']
  ), []);

  const stepIndex = Math.max(0, steps.indexOf(step));

  const dealerReady = Boolean(selectedDealer && shipping);

  const fullSA = isFullSuperAdmin(user);
  const needsSalespersonPicker = activeSegments.includes('product');
  const typeReady = activeSegments.length > 0;

  const stepTitle = `Step ${stepIndex + 1} of ${steps.length}`;

  const goBackRef = useRef<() => void>(() => {
    navigate(leavePath);
  });

  useCatalogPageHeader({
    title: createdOrders?.length ? 'Orders created' : 'New sales order',
    subtitle: createdOrders?.length ? null : stepTitle,
    showBack: true,
    onBack: () => {
      goBackRef.current();
    },
    accentTitle: !createdOrders?.length,
    mobileCompactHeader: false,
  }, true);

  useEffect(() => {
    if (!canManage) {
      navigate(listPath, { replace: true });
    }
  }, [canManage, navigate, listPath]);

  useEffect(() => {
    if (!freightAllowed) return;
    let cancelled = false;
    void Promise.all([loadLogisticsCourierRates(), loadLogisticsSettings()])
      .then(([rates, settings]) => {
        if (cancelled) return;
        setCourierRates(rates);
        setDeliveryRules(settings.deliveryRules);
        setPartnerStatuses(settings.partnerStatuses);
        setSpareBoxDefinitions(settings.spareBoxDefinitions || []);
        setFromAddresses(settings.fromAddresses || {});
      })
      .catch(() => { /* freight preview optional */ });
    return () => { cancelled = true; };
  }, [freightAllowed]);

  useEffect(() => {
    const customerId = selectedDealer?.id?.trim() || '';
    if (!customerId || !freightAllowed) {
      setPendingFreightDiff(null);
      return;
    }
    let cancelled = false;
    void fetchPendingFreightDiff(customerId)
      .then(preview => {
        if (!cancelled) setPendingFreightDiff(preview);
      })
      .catch(() => {
        if (!cancelled) setPendingFreightDiff(null);
      });
    return () => { cancelled = true; };
  }, [selectedDealer?.id, freightAllowed]);

  const productMatchesActiveSegments = useCallback(
    (product: { categoryId?: string | null; categoryName?: string | null; productId?: string | null; id?: string | null; sku?: string | null }) => {
      if (!activeSegments.length) return false;
      if (isFreightOrderLine({ productId: product.productId ?? product.id, sku: product.sku })) {
        return false;
      }
      const segment = classifyOrderLineSegment(product);
      return Boolean(segment && activeSegments.includes(segment));
    },
    [activeSegments],
  );

  const allowedItems = useMemo(
    () => cartItems.filter(item => productMatchesActiveSegments(item)),
    [cartItems, productMatchesActiveSegments],
  );

  const lines = useMemo(() => (
    allowedItems.map(item => {
      const override = rateOverrides[item.cartLineId];
      const catalogRate = override != null ? override : item.baseRate;
      return {
        ...item,
        catalogRate,
        rate: combinedCartRate(catalogRate, item.gatcFeePerUnit),
      };
    })
  ), [allowedItems, rateOverrides]);

  const segmentsRequiringSp = useMemo((): OrderSegment[] => {
    const inCart = summarizeSegments(lines.map(line => ({
      categoryId: line.categoryId,
      categoryName: line.categoryName,
      productId: line.productId,
      sku: line.sku,
    })));
    if (inCart.length > 0) {
      return inCart.filter(segment => activeSegments.includes(segment));
    }
    // Before cart: don't block product shopping when Spare Incharge isn't configured yet.
    if (activeSegments.includes('product')) return ['product'];
    return [...activeSegments];
  }, [lines, activeSegments]);

  const segmentSpReady = (segment: OrderSegment): boolean => {
    if (segment === 'product' && needsSalespersonPicker) {
      return Boolean(salespersonId.trim());
    }
    const preview = segmentSpMap[segment];
    return Boolean(preview?.salespersonId) && !preview?.error;
  };

  const salespersonReady = !spLoading
    && segmentsRequiringSp.every(segmentSpReady);

  const catalogById = useMemo(() => {
    const map: Record<string, CatalogProduct> = {};
    for (const product of catalogProducts) map[product.id] = product;
    return map;
  }, [catalogProducts]);

  const stampableWithoutStamping = useMemo(() => (
    lines.filter(item => {
      if (item.gatcStampingPriceId) return false;
      const catalogProduct = catalogById[item.productId];
      return catalogProduct ? productHasLinkedGatc(catalogProduct) : false;
    })
  ), [lines, catalogById]);

  const applyLineStamping = useCallback((cartLineId: string, choice: GatcStampingChoice) => {
    updateStamping(cartLineId, {
      withStamping: choice.withStamping,
      gatcStampingPriceId: choice.gatcStampingPriceId,
      gatcFeePerUnit: choice.gatcFeePerUnit,
      gatcStampingRange: choice.gatcStampingRange,
    });
  }, [updateStamping]);

  useEffect(() => {
    setRateOverrides(prev => {
      const ids = new Set(cartItems.map(item => item.cartLineId));
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!ids.has(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cartItems]);

  const submitLines = useMemo(() => (
    lines.map(line => {
      const catalog = catalogById[line.productId];
      return {
        productId: line.productId,
        quantity: line.quantity,
        rate: line.catalogRate,
        gatcStampingPriceId: line.gatcStampingPriceId ?? null,
        name: line.name,
        sku: line.sku,
        categoryId: line.categoryId,
        categoryName: line.categoryName,
        warehouses: catalog?.warehouses ?? null,
      };
    })
  ), [lines, catalogById]);

  const shippingDestination = useMemo(
    () => resolveShippingDestination(shipping, addresses),
    [shipping, addresses],
  );
  const blueDartPin = useBlueDartPincode(shippingDestination?.zip);
  const inferredFreightZone = useMemo(
    () => inferStCourierZone(shippingDestination),
    [shippingDestination],
  );

  const freightEstimateBase = useMemo((): StCourierCartFreightEstimate | null => {
    if (!freightAllowed || !courierRates || !deliveryRules || !partnerStatuses || lines.length === 0) {
      return null;
    }
    const freightCartLines = cartLinesForFreightEstimate(lines, catalogById);
    const spareOnlyCart = cartLinesAreSpareOnly(freightCartLines);
    if (!spareOnlyCart && (!shippingDestination || !inferredFreightZone)) return null;
    const cartHasSpare = freightCartLines.some(line => classifyOrderLineSegment(line) === 'spare');
    const sparePackaging = cartHasSpare
      ? spareFreightPackagingsFromDrafts(sparePackagingDrafts)
      : null;
    return estimateStCourierCartFreight({
      lines: freightCartLines,
      destination: shippingDestination,
      rates: courierRates,
      deliveryRules,
      partnerStatuses,
      courierBySite,
      blueDartPin,
      invoiceValueInr: lines.reduce((sum, line) => sum + line.rate * line.quantity, 0),
      sparePackaging,
      requireSparePackaging: cartHasSpare,
    });
  }, [
    freightAllowed,
    courierRates,
    deliveryRules,
    partnerStatuses,
    lines,
    shippingDestination,
    catalogById,
    courierBySite,
    inferredFreightZone,
    blueDartPin,
    sparePackagingDrafts,
  ]);

  const goodsSubtotalForDelhivery = useMemo(
    () => lines.reduce((sum, line) => sum + line.rate * line.quantity, 0),
    [lines],
  );

  const delhiveryLive = useDelhiveryLiveFreightQuote({
    estimate: freightEstimateBase,
    originAddress: fromAddresses.cochin || fromAddresses.head_office || '',
    destinationPin: shippingDestination?.zip,
    invoiceValueInr: goodsSubtotalForDelhivery,
    freightBillingMode,
    enabled: freightAllowed,
  });

  const freightEstimate = delhiveryLive.estimateWithLive ?? freightEstimateBase;

  const spareVolumetricDivisor = useMemo(() => {
    if (!courierRates) return 5000;
    const site = freightEstimateBase?.sites[0];
    const partnerId = site?.partnerId;
    if (!partnerId || isPickupPartner(partnerId)) return 5000;
    if (isBlueDartLogisticsPartnerId(partnerId)) {
      const service = blueDartServiceForPartner(partnerId) ?? 'domestic_priority';
      if (service === 'domestic_priority') {
        return Number(courierRates.bluedart.domestic_priority.volumetricDivisor) || 5000;
      }
      return Number(courierRates.bluedart[service].volumetricDivisor) || 5000;
    }
    if (isTrackonLogisticsPartnerId(partnerId)) {
      return Number(courierRates.trackon.shared.volumetricDivisor) || 5000;
    }
    const origin = partnerId === 'delhivery'
      ? courierRates.delhivery
      : courierRates.st_courier[site?.site ?? 'head_office'];
    return Number(origin?.volumetricDivisor) || 4500;
  }, [courierRates, freightEstimateBase]);

  const sparePartnerQuotes = useMemo((): SpareFreightPartnerQuoteNote[] => {
    const site = freightEstimateBase?.sites[0];
    if (!site?.hasSpare) return [];
    return site.courierOptions
      .filter(opt => !isPickupPartner(opt.partnerId))
      .map(opt => ({
        partnerId: opt.partnerId,
        label: opt.label,
        amountInr: Number(opt.estimatedTotalInr) || 0,
        volumetricKg: opt.estimatedVolumetricKg ?? null,
        chargeableKg: opt.estimatedChargeableKg ?? null,
        enabled: opt.enabled,
      }));
  }, [freightEstimateBase]);

  useEffect(() => {
    if (!selectedPartnerIsDelhivery(freightEstimate)) return;
    if (freightBillingMode === 'fod') {
      setManualFreightAmount(prev => (prev === 0 ? prev : 0));
      return;
    }
    if (manualFreightAmountLocked) return;
    if (delhiveryLive.preTaxInr == null) return;
    const next = Math.ceil(delhiveryLive.preTaxInr);
    setManualFreightAmount(prev => (prev === next ? prev : next));
  }, [
    delhiveryLive.preTaxInr,
    freightEstimate,
    manualFreightAmountLocked,
    freightBillingMode,
  ]);

  useEffect(() => {
    // Destination / cart change → allow live estimate to refresh the amount.
    setManualFreightAmountLocked(false);
  }, [shippingDestination?.zip, lines.length, goodsSubtotalForDelhivery]);

  const segmentPreview = useMemo(() => summarizeSegmentSiteBuckets(submitLines), [submitLines]);

  const selectedFreightUsesManualRate = useMemo(() => {
    if (!freightEstimate?.usable) return false;
    return freightEstimate.sites.some(site => {
      const opt = site.courierOptions.find(o => o.partnerId === site.partnerId);
      return Boolean(opt?.manualRate || opt?.liveApiRate || site.partnerId === 'delhivery');
    });
  }, [freightEstimate]);

  const freightSubtotal = useMemo(() => {
    if (!freightAllowed || !freightEstimate?.usable) return 0;
    let base = 0;
    if (
      selectedFreightUsesManualRate
      && manualFreightAmount != null
      && Number.isFinite(manualFreightAmount)
    ) {
      base = Math.round(manualFreightAmount * 100) / 100;
    } else {
      base = freightEstimate.totalInr;
    }
    const adjust = (
      pendingFreightDiff?.willApplyOnNextFreightSo && base > 0
        ? Number(pendingFreightDiff.availableInr) || 0
        : 0
    );
    return Math.round(Math.max(0, base + adjust) * 100) / 100;
  }, [
    freightAllowed,
    freightEstimate,
    selectedFreightUsesManualRate,
    manualFreightAmount,
    pendingFreightDiff,
  ]);

  const freightAdjustPreview = useMemo(() => {
    if (!freightAllowed || !freightEstimate?.usable) return 0;
    if (!pendingFreightDiff?.willApplyOnNextFreightSo) return 0;
    return Number(pendingFreightDiff.availableInr) || 0;
  }, [freightAllowed, freightEstimate, pendingFreightDiff]);

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + line.rate * line.quantity, 0) + freightSubtotal,
    [lines, freightSubtotal],
  );

  const spareOnlyCatalog = activeSegments.length === 1 && activeSegments[0] === 'spare';

  const cartHasSpare = useMemo(
    () => lines.some((line) => {
      const catalog = catalogById[line.productId];
      return classifyOrderLineSegment({
        productId: line.productId,
        sku: line.sku,
        categoryId: catalog?.categoryId ?? null,
        categoryName: catalog?.categoryName ?? null,
      }) === 'spare';
    }),
    [lines, catalogById],
  );

  const spareOnlyCart = useMemo(
    () => cartLinesAreSpareOnly(cartLinesForFreightEstimate(lines, catalogById)),
    [lines, catalogById],
  );

  useEffect(() => {
    if (!spareOnlyCart) return;
    setCourierBySite((prev) => {
      if (!Object.values(prev).some(id => isPickupPartner(id))) return prev;
      return {};
    });
  }, [spareOnlyCart]);

  const shopProducts = useMemo(() => {
    const visible = excludeHiddenCatalogProducts(catalogProducts, catalogCategories);
    if (spareOnlyCatalog) {
      return getCatalogSparePartsPool(visible, catalogCategories);
    }
    return visible.filter(productMatchesActiveSegments);
  }, [
    catalogProducts,
    catalogCategories,
    spareOnlyCatalog,
    productMatchesActiveSegments,
  ]);

  const shopCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of shopProducts) {
      if (!product.categoryId) continue;
      counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1);
    }
    return getCategoriesForProducts(catalogCategories, shopProducts)
      .filter(c => c.id && !isHiddenCatalogCategory(c) && (counts.get(c.id) ?? 0) > 0)
      .map(c => ({
        ...c,
        productCount: counts.get(c.id) ?? c.productCount,
      }))
      .sort((a, b) => {
        const orderDiff = a.displayOrder - b.displayOrder;
        if (orderDiff !== 0) return orderDiff;
        return a.name.localeCompare(b.name);
      });
  }, [catalogCategories, shopProducts]);

  const showBrowseCategoryChips = shopCategories.length > 0;

  useEffect(() => {
    setBrowseCategoryId('');
  }, [activeSegments]);

  useEffect(() => {
    if (step !== 'catalog') {
      registerCartTarget(null);
      return;
    }
    registerCartTarget(cartBtnRef.current);
    return () => registerCartTarget(null);
  }, [registerCartTarget, step, itemCount]);

  useEffect(() => {
    if (step !== 'catalog' || activeSegments.length === 0) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError('');
    void fetchCatalog()
      .then(data => {
        if (cancelled) return;
        setCatalogProducts(data.items);
        setCatalogCategories(data.categories);
      })
      .catch(err => {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : 'Could not load products.');
          setCatalogProducts([]);
          setCatalogCategories([]);
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    void fetchSpareLinkIndex()
      .then(index => {
        if (!cancelled) setSpareCountByProductId(index.spareCountByProductId);
      })
      .catch(() => {
        if (!cancelled) setSpareCountByProductId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [step, activeSegments]);

  useEffect(() => {
    if (step !== 'catalog') setPeekProduct(null);
  }, [step]);

  useEffect(() => {
    if (!needsSalespersonPicker) return;
    let cancelled = false;
    setSalespersonsLoading(true);
    void listZohoSalespersons({ includeHidden: true })
      .then(rows => {
        if (!cancelled) {
          const kamRows = collapseToPortalKamOptions(rows);
          setSalespersons(kamRows.map(row => ({
            id: row.id,
            name: row.name,
            email: null,
            active: true,
          })));
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load salespersons.');
          setSalespersons([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSalespersonsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSalespersonPicker]);

  useEffect(() => {
    let cancelled = false;
    if (!activeSegments.length) {
      setSegmentSpMap({});
      setSpLoading(false);
      return;
    }

    setSpLoading(true);

    void (async () => {
      const next: Partial<Record<OrderSegment, SalespersonPreview>> = {};
      try {
        if (activeSegments.includes('software')) {
          let match: ZohoSalespersonOption | null = null;
          try {
            const rows = await listZohoSalespersonsFromFirestore();
            match = rows.find(row => (
              row.active
              && row.name.trim().toLowerCase() === CLOUD_CHARGES_SALESPERSON_NAME.toLowerCase()
            )) ?? null;
          } catch {
            // Staff without HR view may be denied Firestore salesperson cache — use known id.
          }
          next.software = {
            source: 'cloud',
            title: 'Cloud Charges',
            salespersonId: match?.id || CLOUD_CHARGES_SALESPERSON_ID,
            salespersonName: match?.name || CLOUD_CHARGES_SALESPERSON_NAME,
            staffName: CLOUD_CHARGES_SALESPERSON_NAME,
            hint: 'Software draft SOs use Cloud Charges.',
            error: null,
            loading: false,
          };
        }

        if (activeSegments.includes('spare')) {
          let match: ZohoSalespersonOption | null = null;
          try {
            const rows = await listZohoSalespersonsFromFirestore();
            match = rows.find(row => (
              row.name.trim().toLowerCase() === SHIBIN_SALESPERSON_NAME.toLowerCase()
            )) ?? null;
          } catch {
            // Staff without HR view may be denied Firestore salesperson cache — use known id.
          }
          next.spare = {
            source: 'shibin',
            title: SHIBIN_SALESPERSON_NAME,
            salespersonId: match?.id || SHIBIN_SALESPERSON_ID,
            salespersonName: match?.name || SHIBIN_SALESPERSON_NAME,
            staffName: SHIBIN_SALESPERSON_NAME,
            hint: null,
            error: null,
            loading: false,
          };
        }

        if (activeSegments.includes('product')) {
          let visibleRows: ZohoSalespersonOption[] = [];
          try {
            visibleRows = await listZohoSalespersons({ includeHidden: true });
          } catch {
            visibleRows = [];
          }
          const kamRows = collapseToPortalKamOptions(visibleRows);
          const ownLinks = normalizeZohoSalespersonLinks({
            zohoSalespersonLinks: user?.zohoSalespersonLinks,
            zohoSalespersonIds: user?.zohoSalespersonIds,
            zohoSalespersonId: user?.zohoSalespersonId,
            zohoSalespersonName: user?.zohoSalespersonName,
          });
          const own = ownLinks[0]
            ? { salespersonId: ownLinks[0].id, salespersonName: ownLinks[0].name }
            : null;

          let defaultId = portalKamIdForSalesperson(
            own?.salespersonId,
            own?.salespersonName,
            kamRows,
          );
          let defaultName = kamRows.find(row => row.id === defaultId)?.name ?? null;

          if (!defaultId && selectedDealer?.assignedStaffUid) {
            const kam = await loadStaffSalesperson(selectedDealer.assignedStaffUid);
            if (kam) {
              defaultId = portalKamIdForSalesperson(
                kam.salespersonId,
                kam.salespersonName,
                kamRows,
              );
              defaultName = kamRows.find(row => row.id === defaultId)?.name ?? null;
            }
          }

          next.product = {
            source: 'pick',
            title: 'KAM',
            salespersonId: defaultId || null,
            salespersonName: defaultName,
            staffName: user?.displayName ?? null,
            hint: null,
            error: null,
            loading: false,
          };
          if (defaultId) {
            setSalespersonId(prev => prev || defaultId);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not resolve salesperson.';
        for (const segment of activeSegments) {
          if (next[segment]) continue;
          next[segment] = {
            source: segment === 'software' ? 'cloud' : segment === 'spare' ? 'shibin' : 'pick',
            title: 'Salesperson',
            salespersonId: null,
            salespersonName: null,
            staffName: null,
            hint: null,
            error: message,
            loading: false,
          };
        }
      }

      if (cancelled) return;
      setSegmentSpMap(next);
      setSpLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSegments, selectedDealer, fullSA, user]);

  useEffect(() => {
    let cancelled = false;
    const cached = peekCachedDealers();
    if (cached?.length) {
      setDealers(cached);
      setDealersLoading(false);
    } else {
      setDealersLoading(true);
    }

    const unsubscribe = subscribeDealerCache((list, complete) => {
      if (cancelled) return;
      setDealers(list);
      if (complete || list.length > 0) setDealersLoading(false);
    });

    void ensureDealersCached()
      .then(list => {
        if (!cancelled) {
          setDealers(list);
          setDealersLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled && !peekCachedDealers()?.length) {
          setDealers([]);
          setDealersLoading(false);
          setError(err instanceof Error ? err.message : 'Could not load dealers.');
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const filteredDealers = useMemo(() => {
    const q = dealerQuery.trim();
    if (q.length < 2) return [];
    return dealers
      .filter(dealer => dealerMatchesLogisticsQuery(dealer, q))
      .slice(0, 40);
  }, [dealers, dealerQuery]);

  useEffect(() => {
    if (!shareToWaNeedle) return;
    setDealerQuery(current => current || shareToWaNeedle);
    if (allowedSegments.includes('product')) setSelectedSegment(current => current || 'product');
  }, [allowedSegments, shareToWaNeedle]);

  const loadAddresses = useCallback(async (customerId: string, dealerHint?: ZohoDealer | null) => {
    setAddressesLoading(true);
    setAddressError('');
    setAddressWarning('');
    setShipping(null);
    const cachedDealer = dealerHint
      ?? dealers.find(dealer => dealer.id === customerId)
      ?? null;
    try {
      const { addresses: next, warning } = await listCustomerShippingAddresses(customerId);
      setAddresses(next);
      setAddressWarning(warning || '');
    } catch (err) {
      const fallback = addressesFromDealerCache(cachedDealer);
      if (fallback.length) {
        setAddresses(fallback);
        setAddressError('');
        setAddressWarning('');
      } else {
        setAddresses([]);
        setAddressError(err instanceof Error ? err.message : 'Could not load addresses.');
      }
    } finally {
      setAddressesLoading(false);
    }
  }, [dealers]);

  const selectDealer = (dealer: ZohoDealer) => {
    setSelectedDealer(toSelectedDealer(dealer));
    setDealerQuery('');
    setError('');
    void loadAddresses(dealer.id, dealer);
  };

  const autoPickedWaDealer = useRef(false);
  useEffect(() => {
    if (autoPickedWaDealer.current || !shareToWaNeedle || selectedDealer) return;
    if (filteredDealers.length !== 1) return;
    autoPickedWaDealer.current = true;
    selectDealer(filteredDealers[0]);
  }, [filteredDealers, selectedDealer, shareToWaNeedle]);

  const canSubmit = Boolean(
    lines.length
    && selectedDealer
    && shipping
    && salespersonReady,
  );

  /** Product LBH/weight required before Ready for payment (draft still allowed). */
  const missingPackageLines = useMemo(
    () => listProductsMissingFreightPackageInfo(
      cartLinesForFreightEstimate(lines, catalogById),
    ),
    [lines, catalogById],
  );
  const packageDataReady = missingPackageLines.length === 0;
  const canReadyForPayment = canSubmit && packageDataReady;

  const setLineBaseRate = (cartLineId: string, baseRate: number) => {
    const nextBase = Number.isFinite(baseRate) && baseRate >= 0
      ? Math.round(baseRate * 100) / 100
      : 0;
    setRateOverrides(prev => ({ ...prev, [cartLineId]: nextBase }));
  };

  const goBack = useCallback(() => {
    setError('');
    if (step === 'preview') {
      setStep('catalog');
      return;
    }
    if (step === 'catalog') {
      setStep('dealer');
      return;
    }
    navigate(leavePath);
  }, [step, navigate, leavePath]);

  goBackRef.current = createdOrders?.length
    ? () => navigate(leavePath)
    : goBack;

  const selectSegment = (segment: OrderSegment) => {
    if (selectedSegment === segment) return;
    setSelectedSegment(segment);
    if (segment !== 'product') setSalespersonId('');
    setError('');
  };

  const goToCatalog = () => {
    if (!typeReady) {
      setError('Select Product, Spare or Software.');
      return;
    }
    if (!selectedDealer) {
      setError('Select a dealer.');
      return;
    }
    if (!shipping) {
      setError('Select a shipping address.');
      return;
    }
    if (!salespersonReady) {
      const firstError = segmentsRequiringSp
        .map(segment => segmentSpMap[segment]?.error)
        .find(Boolean);
      setError(firstError || 'Resolve salesperson before continuing.');
      return;
    }
    setError('');
    setStep('catalog');
  };

  const goToPreview = () => {
    if (!dealerReady) {
      setError('Select dealer and shipping address first.');
      setStep('dealer');
      return;
    }
    if (!lines.length) {
      setError('Add at least one item from products.');
      return;
    }
    const cartSegments = summarizeSegments(lines);
    const missingSp = cartSegments.find(segment => !segmentSpReady(segment));
    if (missingSp) {
      setError(
        segmentSpMap[missingSp]?.error
        || `Salesperson is not resolved for ${segmentLabel(missingSp)}.`,
      );
      setStep('dealer');
      return;
    }
    setError('');
    setStep('preview');
  };

  const onProgressStepClick = (target: WizardStep) => {
    if (target === step) return;
    if (target === 'dealer') {
      setError('');
      setStep('dealer');
      return;
    }
    if (target === 'catalog') {
      if (!typeReady || !dealerReady || !salespersonReady) return;
      setError('');
      setStep('catalog');
      return;
    }
    if (target === 'preview') {
      goToPreview();
    }
  };

  const save = async (stage: 'review' | 'ready_for_payment') => {
    if (!selectedDealer) {
      setError('Select a dealer.');
      return;
    }
    if (!lines.length) {
      setError('Add items from products.');
      return;
    }
    if (!shipping) {
      setError('Select a shipping address.');
      return;
    }
    if (needsSalespersonPicker && !salespersonId.trim()) {
      setError('Select a salesperson for the product sales order.');
      return;
    }
    if (
      selectedFreightUsesManualRate
      && selectedPartnerIsDelhivery(freightEstimate)
      && freightBillingMode !== 'fod'
      && !(manualFreightAmount != null && Number.isFinite(manualFreightAmount) && manualFreightAmount > 0)
    ) {
      setError('Wait for the Delhivery freight estimate, or enter freight ₹ before creating the order.');
      return;
    }
    if (
      freightAllowed
      && freightEstimate?.usable
      && !estimateAllSitesPickup(freightEstimate)
      && !(
        freightBillingMode === 'fod'
        && selectedPartnerIsDelhivery(freightEstimate)
      )
      && !(freightSubtotal > 0)
    ) {
      setError(
        'Enter freight ₹ for the selected logistics partner (or choose Customer Pickup). Use LBH/weight for auto calculation when available.',
      );
      return;
    }
    if (stage === 'ready_for_payment' && !packageDataReady) {
      const sample = missingPackageLines
        .slice(0, 3)
        .map(row => row.name || row.sku || 'Item')
        .join(', ');
      setError(
        `Fill package LBH/weight before Ready for payment${sample ? ` (${sample}${missingPackageLines.length > 3 ? '…' : ''})` : ''}. You can still Save as draft.`,
      );
      return;
    }
    {
      const cartSegments = summarizeSegments(submitLines);
      const missingSp = cartSegments.find(segment => !segmentSpReady(segment));
      if (missingSp) {
        setError(
          segmentSpMap[missingSp]?.error
          || `Salesperson is not resolved for ${segmentLabel(missingSp)}.`,
        );
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const result = await createStaffSalesOrder({
        zohoCustomerId: selectedDealer.id,
        lines: submitLines.map(line => ({
          productId: line.productId,
          quantity: line.quantity,
          rate: line.rate,
          gatcStampingPriceId: line.gatcStampingPriceId ?? null,
        })),
        shipping,
        stage,
        remarks: cartRemarks.trim(),
        courierBySite: resolveSubmitCourierBySite(freightEstimate, courierBySite),
        ...(inferredFreightZone
          ? { freightZone: inferredFreightZone }
          : (spareOnlyCart ? { freightZone: 'other_states' as const } : {})),
        ...((
          (selectedFreightUsesManualRate
            && manualFreightAmount != null
            && Number.isFinite(manualFreightAmount)
            && manualFreightAmount >= 0)
          || (cartHasSpare && freightSubtotal > 0)
        )
          ? {
              manualFreightAmountInr: Math.round(
                (
                  selectedFreightUsesManualRate
                  && manualFreightAmount != null
                  && Number.isFinite(manualFreightAmount)
                    ? manualFreightAmount
                    : freightSubtotal
                ) * 100,
              ) / 100,
            }
          : {}),
        ...(selectedPartnerIsDelhivery(freightEstimate)
          ? { freightBillingMode }
          : {}),
        ...(needsSalespersonPicker
          ? { salespersonId: salespersonId.trim() }
          : {}),
      });
      clearCart();
      setRateOverrides({});
      setCourierBySite({});
      setManualFreightAmount(null);
      setManualFreightAmountLocked(false);
      setFreightBillingMode('btc');
      const salesOrders = Array.isArray(result.salesOrders) && result.salesOrders.length > 0
        ? result.salesOrders
        : (result.zohoSalesOrderId
          ? [{
              segment: 'product' as const,
              segmentLabel: 'Product',
              orderNumber: result.orderNumber,
              zohoSalesOrderId: result.zohoSalesOrderId,
              zohoSalesOrderNumber: result.zohoSalesOrderNumber,
              status: 'draft',
              subtotal: result.subtotal,
              itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
              salespersonId: null,
              salespersonName: null,
            }]
          : []);
      const shareQs = shareToWa ? `?shareToWa=${encodeURIComponent(shareToWa)}` : '';
      if (salesOrders.length > 1) {
        setCreatedOrders(salesOrders);
        return;
      }
      const soId = salesOrders[0]?.zohoSalesOrderId || result.zohoSalesOrderId;
      if (soId) navigate(`${listPath}/${soId}${shareQs}`);
      else navigate(leavePath);
    } catch (err) {
      setError(dealerOrderErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (createdOrders && createdOrders.length > 0) {
    return (
      <div className="page-content fade-in staff-create-so-page">
        <MultiSalesOrderSuccess
          salesOrders={createdOrders}
          detailBasePath={listPath}
          listPath={leavePath}
          shareToWa={shareToWa || undefined}
        />
      </div>
    );
  }

  const cartSegmentLabels = useMemo(
    () => summarizeSegments(submitLines).map(segmentLabel),
    [submitLines],
  );

  return (
    <div className={`page-content fade-in staff-create-so-page staff-create-so-page--${step}`}>
      <nav className="staff-create-so-page__stepper" aria-label="Create sales order progress">
        {steps.map((id, index) => {
          const label = id === 'dealer'
            ? 'Dealer Details'
            : id === 'catalog'
              ? 'Items'
              : 'Review & Confirm';
          const clickable = id === 'dealer'
            ? step !== 'dealer'
            : id === 'catalog'
              ? dealerReady && salespersonReady && (step === 'preview' || step === 'dealer')
              : id === 'preview' && dealerReady && salespersonReady
                && step === 'catalog' && lines.length > 0;
          const stateClass = progressClass(stepIndex, index);
          return (
            <React.Fragment key={id}>
              {index > 0 ? (
                <span
                  className={`staff-create-so-page__stepper-line${
                    index <= stepIndex + 1 ? ' is-done' : ''
                  }`}
                  aria-hidden
                />
              ) : null}
              <button
                type="button"
                className={`staff-create-so-page__stepper-item ${stateClass}${
                  clickable ? ' is-clickable' : ''
                }`}
                disabled={!clickable}
                aria-current={step === id ? 'step' : undefined}
                onClick={() => onProgressStepClick(id)}
              >
                <span className="staff-create-so-page__stepper-num">
                  {stateClass === 'is-done' ? (
                    <Check size={14} strokeWidth={3} aria-hidden />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="staff-create-so-page__stepper-label">{label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {error ? (
        <div className="products-inline-error panel glass" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      ) : null}

      {shareToWa ? (
        <p className="text-muted text-sm staff-create-so-page__wa-note">
          Sales order for this WhatsApp chat. After you create it, it will be sent to that number.
        </p>
      ) : null}

      {step === 'dealer' ? (
        <>
          <section className="staff-create-so-page__dealer-stage">
            <div className="staff-create-so-page__order-types" role="group" aria-label="Order type">
              {allowedSegments.map(segment => {
                const selected = selectedSegment === segment;
                const icon = segment === 'spare'
                  ? <Wrench size={20} />
                  : segment === 'software'
                    ? <KeyRound size={20} />
                    : <Package size={20} />;
                return (
                  <button
                    key={segment}
                    type="button"
                    className={`staff-create-so-page__order-type${selected ? ' is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => selectSegment(segment)}
                  >
                    <span className="staff-create-so-page__order-type-icon" aria-hidden>
                      {icon}
                    </span>
                    <span className="staff-create-so-page__order-type-name">
                      {segmentLabel(segment)}
                    </span>
                  </button>
                );
              })}
            </div>

            {typeReady ? (
            <>
              <div className="staff-create-so-page__dealer-search">
                <div className="catalog-search staff-create-so-page__dealer-search-input">
                  <Search size={15} aria-hidden />
                  <input
                    type="search"
                    placeholder="Search dealer by name, code or mobile…"
                    value={dealerQuery}
                    onChange={e => {
                      setDealerQuery(e.target.value);
                      if (selectedDealer) {
                        setSelectedDealer(null);
                        setAddresses([]);
                        setShipping(null);
                      }
                    }}
                    aria-label="Search dealers"
                    autoFocus
                  />
                </div>
                {selectedDealer && !dealerQuery.trim() ? (
                  <div className="staff-create-so-page__dealer-picked">
                    <strong>{selectedDealer.label}</strong>
                  </div>
                ) : filteredDealers.length > 0 ? (
                  <ul className="staff-create-so-page__dealer-list" role="listbox">
                    {filteredDealers.map(dealer => {
                      const snapshot = zohoDealerToSnapshot(dealer);
                      const location = dealerLocationLabel(dealer);
                      const phone = snapshot.mobile !== '—' ? snapshot.mobile : null;
                      const meta = [snapshot.code, phone].filter(Boolean).join(' • ');
                      return (
                        <li key={dealer.id}>
                          <button
                            type="button"
                            className="staff-create-so-page__dealer-option"
                            onClick={() => selectDealer(dealer)}
                          >
                            <span className="staff-create-so-page__dealer-option-main">
                              <strong>{snapshot.name}</strong>
                              {meta ? (
                                <span className="staff-create-so-page__dealer-option-meta">{meta}</span>
                              ) : null}
                            </span>
                            <span className="staff-create-so-page__dealer-option-side">
                              {location ? (
                                <span className="staff-create-so-page__dealer-option-location">
                                  <MapPin size={13} aria-hidden />
                                  {location}
                                </span>
                              ) : null}
                              <ChevronRight size={18} className="staff-create-so-page__dealer-option-chevron" aria-hidden />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>

          {selectedDealer ? (
            <div className="staff-create-so-page__dealer-panel panel glass">
              <ShippingAddressPicker
                addresses={addresses}
                loading={addressesLoading}
                error={addressError}
                warning={addressWarning}
                value={shipping}
                onChange={setShipping}
                onRefresh={() => void loadAddresses(selectedDealer.id)}
                allowManage
                customerId={selectedDealer.id}
              />
            </div>
          ) : null}

          {needsSalespersonPicker ? (
          <div className="staff-create-so-page__dealer-panel panel glass staff-create-so-page__salesperson-panel">
            <header className="staff-create-so-page__salesperson-head">
              <span className="staff-create-so-page__salesperson-icon" aria-hidden>
                <UserCircle size={22} />
              </span>
              <h2>KAM</h2>
            </header>
            <KamCardPicker
              options={salespersons}
              value={salespersonId}
              onChange={setSalespersonId}
              disabled={salespersonsLoading}
              loading={salespersonsLoading}
              aria-label="KAM"
            />
          </div>
          ) : null}
            </>
            ) : null}
          </section>

          <div className="staff-create-so-page__dealer-continue staff-create-so-page__dealer-continue--sticky">
            <button
              type="button"
              className="btn btn-primary staff-create-so-page__dealer-continue-btn"
              disabled={!typeReady || !dealerReady || !salespersonReady}
              onClick={goToCatalog}
            >
              Continue to Catalog
              <ArrowRight size={16} aria-hidden />
            </button>
          </div>
        </>
      ) : null}

      {step === 'catalog' ? (
        <section className="staff-create-so-page__catalog">
          <div className="staff-create-so-page__catalog-bar panel glass">
            <p className="text-muted text-sm staff-create-so-page__catalog-hint">
              Tap an item for details, or the cart icon to add it
              {spareOnlyCatalog ? ' — all spare parts can be ordered' : ''}
            </p>
            <button
              ref={cartBtnRef}
              type="button"
              id="cart-fly-target"
              className={`btn btn-primary btn-sm staff-create-so-page__cart-btn${
                cartBump ? ' cart-header-btn--bump' : ''
              }`}
              disabled={!lines.length}
              onClick={goToPreview}
              aria-label={`Cart, ${itemCount} items`}
            >
              <ShoppingCart size={16} aria-hidden />
              <span>Cart</span>
              {lines.length > 0 ? (
                <span className="staff-create-so-page__cart-badge">{lines.length}</span>
              ) : null}
            </button>
          </div>

          {catalogError ? (
            <div className="products-inline-error panel glass" role="alert">
              <AlertCircle size={18} />
              <span>{catalogError}</span>
            </div>
          ) : (
            <>
              {showBrowseCategoryChips ? (
                <div className="staff-create-so-page__category-chips panel glass">
                  <CatalogCategoryChips
                    categories={shopCategories}
                    activeCategoryId={browseCategoryId}
                    onSelect={setBrowseCategoryId}
                  />
                </div>
              ) : null}
              <CatalogBrowse
                products={shopProducts}
                categories={shopCategories}
                isLoading={catalogLoading}
                title=""
                showToolbar={false}
                filterMode="minimal"
                dealerView
                enableCart
                isCartable={productMatchesActiveSegments}
                flatBrowse={spareOnlyCatalog}
                showCategoryGrid={!spareOnlyCatalog && !browseCategoryId}
                searchPlaceholder={spareOnlyCatalog ? 'Search spare parts…' : 'Search products…'}
                showStockQuantity={showStockQuantity}
                spareLinkCountByProductId={spareOnlyCatalog ? undefined : (spareCountByProductId ?? undefined)}
                onProductSelect={setPeekProduct}
                managePageHeader={false}
                activeCategoryId={browseCategoryId}
                onActiveCategoryChange={setBrowseCategoryId}
                emptyTitle={spareOnlyCatalog ? 'No spare parts available' : 'No catalog items available'}
                emptyHint={spareOnlyCatalog ? 'Sync the catalog or search a different spare name.' : 'Sync the catalog or adjust category filters.'}
              />
            </>
          )}

          <StaffSoProductPeek
            product={peekProduct}
            categories={catalogCategories}
            showStockQuantity={showStockQuantity}
            isCartable={productMatchesActiveSegments}
            onClose={() => setPeekProduct(null)}
          />

          <div className="staff-create-so-page__catalog-footer panel glass">
            <span className="text-muted text-sm">
              {lines.length
                ? `${lines.length} line${lines.length === 1 ? '' : 's'} in cart`
                : 'Cart is empty'}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!lines.length}
              onClick={goToPreview}
            >
              Review & confirm
              <ArrowRight size={16} aria-hidden />
            </button>
          </div>
        </section>
      ) : null}

      {step === 'preview' ? (
        <>
          <section className="panel glass staff-create-so-page__section">
            <div className="staff-create-so-page__section-head">
              <h2>Items</h2>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving}
                onClick={() => setStep('catalog')}
              >
                Edit cart
              </button>
            </div>

            {stampableWithoutStamping.length > 0 && (
              <div className="orders-page__stamp-reminder staff-create-so-page__stamp-reminder" role="status">
                <p>
                  {stampableWithoutStamping.length === 1
                    ? '1 item can have stamping added.'
                    : `${stampableWithoutStamping.length} items can have stamping added.`}
                  {' '}
                  Use the stamping control on the line, or <strong>+ Add with stamping</strong> for a separate stamped line.
                </p>
              </div>
            )}

            {lines.length === 0 ? (
              <div className="staff-create-so-page__cart-empty">
                <Package size={36} aria-hidden />
                <p>Cart is empty</p>
              </div>
            ) : (
              <ul className="staff-create-so-page__cart-list">
                {lines.map(item => {
                  const catalogProduct = catalogById[item.productId];
                  const canEditStamp = catalogProduct
                    ? productHasLinkedGatc(catalogProduct)
                    : Boolean(item.gatcStampingPriceId);
                  const hasStamping = Boolean(item.gatcStampingPriceId);
                  const usedGatcIds = lines
                    .filter(other => other.productId === item.productId && other.gatcStampingPriceId)
                    .map(other => String(other.gatcStampingPriceId));
                  const hasUnstampedSibling = lines.some(
                    other => other.productId === item.productId && !other.gatcStampingPriceId,
                  );

                  return (
                    <StaffCartLine
                      key={item.cartLineId}
                      item={item}
                      catalogProduct={catalogProduct}
                      canEditStamp={canEditStamp}
                      hasStamping={hasStamping}
                      usedGatcIds={usedGatcIds}
                      hasUnstampedSibling={hasUnstampedSibling}
                      disabled={saving}
                      onQuantity={qty => setQuantity(item.cartLineId, qty)}
                      onRate={rate => setLineBaseRate(item.cartLineId, rate)}
                      onStamping={choice => applyLineStamping(item.cartLineId, choice)}
                      onAddSibling={choice => {
                        if (!catalogProduct) return;
                        if (!choice.withStamping) {
                          addItem(catalogProduct, {
                            quantity: 1,
                            insertAfterCartLineId: item.cartLineId,
                          });
                          return;
                        }
                        addItem(catalogProduct, {
                          quantity: 1,
                          insertAfterCartLineId: item.cartLineId,
                          gatcStampingPriceId: choice.gatcStampingPriceId,
                          gatcFeePerUnit: choice.gatcFeePerUnit,
                          gatcStampingRange: choice.gatcStampingRange,
                        });
                      }}
                      onRemove={() => {
                        removeItem(item.cartLineId);
                        setRateOverrides(prev => {
                          const next = { ...prev };
                          delete next[item.cartLineId];
                          return next;
                        });
                      }}
                    />
                  );
                })}
              </ul>
            )}

            {segmentPreview.length > 1 ? (
              <p className="text-muted text-sm staff-create-so-page__order-type-hint">
                This will create {segmentPreview.length} draft sales orders:
                {' '}
                {segmentPreview.map(bucket => bucket.label).join(', ')}.
              </p>
            ) : segmentPreview[0] ? (
              <p className="text-muted text-sm staff-create-so-page__order-type-hint">
                Branch: {segmentPreview[0].label}.
              </p>
            ) : null}
          </section>

          <section className="panel glass staff-create-so-page__section">
            <div className="staff-create-so-page__section-head">
              <h2>Dealer & shipping</h2>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving}
                onClick={() => {
                  setError('');
                  setStep('dealer');
                }}
              >
                Change
              </button>
            </div>
            {selectedDealer ? (
              <div className="staff-create-so-page__dealer-summary">
                <div>
                  <strong>{selectedDealer.label}</strong>
                  {selectedDealer.contactPerson ? (
                    <p className="text-muted text-sm">{selectedDealer.contactPerson}</p>
                  ) : null}
                  {selectedDealer.mobile ? (
                    <p className="text-muted text-sm">{selectedDealer.mobile}</p>
                  ) : null}
                </div>
                <p className="text-muted text-sm staff-create-so-page__ship-summary">
                  {formatShippingSummary(shipping, addresses)}
                </p>
              </div>
            ) : (
              <p className="text-muted text-sm">No dealer selected.</p>
            )}
            <div className="staff-create-so-page__sp-summary">
              {(cartSegmentLabels.length
                ? summarizeSegments(submitLines)
                : activeSegments
              ).map(segment => {
                const preview = segmentSpMap[segment];
                if (!preview) return null;
                const isProductPick = segment === 'product' && needsSalespersonPicker;
                return (
                  <div key={segment} className="staff-create-so-page__sp-block">
                    <span className="text-muted text-sm">
                      {preview.title}
                      {' · '}
                      {segmentLabel(segment)}
                    </span>
                    <DocumentKamStrip
                      salespersonId={
                        isProductPick
                          ? salespersonId
                          : preview.salespersonId
                      }
                      salespersonName={
                        isProductPick
                          ? (salespersons.find(row => row.id === salespersonId)?.name ?? null)
                          : (preview.salespersonName || preview.staffName)
                      }
                      showMissing
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {freightAllowed ? (
            <section className="panel glass staff-create-so-page__section">
              {freightEstimate?.usable
                && !estimateAllSitesPickup(freightEstimate)
                && !(freightBillingMode === 'fod' && selectedPartnerIsDelhivery(freightEstimate))
                && !(freightSubtotal > 0) ? (
                <p className="so-freight-expand__alert" role="alert">
                  Non–Customer Pickup: enter freight ₹ (LBH/weight auto-calc or manual) before creating the order.
                </p>
              ) : null}
              {cartHasSpare ? (
                <SpareFreightPackagingFields
                  drafts={sparePackagingDrafts}
                  definitions={spareBoxDefinitions}
                  volumetricDivisor={spareVolumetricDivisor}
                  partnerQuotes={sparePartnerQuotes}
                  onChange={next => {
                    setSparePackagingDrafts(next);
                    setManualFreightAmountLocked(false);
                  }}
                />
              ) : null}
              {freightEstimate?.usable ? (
                <>
                  <OrderFreightPanel
                    estimate={freightEstimate}
                    canEditPackage
                    allowManualFreightEntry={freightBillingMode !== 'fod'}
                    manualFreightAmount={manualFreightAmount}
                    freightBillingMode={freightBillingMode}
                    onFreightBillingModeChange={mode => {
                      setFreightBillingMode(mode);
                      setManualFreightAmountLocked(false);
                      if (mode === 'fod') setManualFreightAmount(0);
                    }}
                    catalogById={catalogById}
                    destinationLabel={[
                      shippingDestination?.city,
                      shippingDestination?.state,
                    ].filter(Boolean).join(', ') || null}
                    footerNote="One freight line per draft SO. ST / Blue Dart / Trackon use rate cards; Delhivery BTC uses the live B2B estimate; FOD keeps the Delhivery line at ₹0."
                    onManualFreightAmountChange={next => {
                      setManualFreightAmountLocked(true);
                      setManualFreightAmount(next);
                    }}
                    onCourierChange={(site, partnerId) => {
                      setManualFreightAmountLocked(false);
                      if (partnerId !== 'delhivery') setFreightBillingMode('btc');
                      setCourierBySite(prev => applyCourierSelectionForSite(
                        prev,
                        site,
                        partnerId,
                        freightEstimate?.sites.map(s => s.site),
                      ));
                    }}
                    onPackageInfoChange={(productId, info) => {
                      setManualFreightAmountLocked(false);
                      setCatalogProducts(prev => prev.map(product => (
                        product.id === productId
                          ? { ...product, packageInfo: info }
                          : product
                      )));
                    }}
                  />
                  {delhiveryLive.showStrip && selectedPartnerIsDelhivery(freightEstimate) ? (
                    <DelhiveryQuoteStrip
                      originPin={delhiveryLive.originPin || null}
                      destinationPin={delhiveryLive.destinationPin}
                      weightKg={freightEstimate.totalChargeableKg || 5}
                      invAmount={goodsSubtotalForDelhivery}
                      freightBillingMode={freightBillingMode}
                      includeEstimate={freightBillingMode === 'btc' && Boolean(delhiveryLive.originPin)}
                      compact
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <h2>Freight</h2>
                  <p className="text-muted text-sm">
                    {shipping
                      ? 'Freight will calculate once items and destination rates are available.'
                      : (spareOnlyCart
                        ? 'ST Courier freight is available for spare orders without a shipping address (Other states plan until address is set).'
                        : 'Select a shipping address to see freight and courier options.')}
                  </p>
                </>
              )}
            </section>
          ) : null}

          <section className="panel glass staff-create-so-page__section">
            <label htmlFor="staff-so-remarks">
              Remarks
              <textarea
                id="staff-so-remarks"
                className="input-field"
                rows={3}
                value={cartRemarks}
                disabled={saving}
                onChange={e => setCartRemarks(e.target.value)}
                placeholder="Optional notes for this sales order"
              />
            </label>

            <div className="staff-create-so-page__totals">
              <span className="text-muted">Estimated subtotal</span>
              <strong>{formatCurrency(subtotal)}</strong>
            </div>
            {freightAdjustPreview !== 0 ? (
              <p className="text-muted text-sm" style={{ marginTop: 0 }}>
                {formatPendingFreightAdjustLabel(freightAdjustPreview)}
                {pendingFreightDiff?.sourceInvoiceNumber
                  ? ` (${pendingFreightDiff.sourceInvoiceNumber})`
                  : ''}
              </p>
            ) : null}
            {!packageDataReady ? (
              <p className="staff-create-so-page__package-gate text-muted text-sm" role="status">
                Package LBH/weight missing on
                {' '}
                {missingPackageLines.length}
                {' '}
                product
                {missingPackageLines.length === 1 ? '' : 's'}
                . Save as draft is available; Ready for payment unlocks after package data is filled.
              </p>
            ) : null}
            <div className="staff-create-so-page__actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={saving || !canSubmit}
                onClick={() => void save('review')}
              >
                {saving ? 'Saving…' : 'Save as draft'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !canReadyForPayment}
                title={
                  !packageDataReady
                    ? 'Fill package LBH/weight on all products first'
                    : undefined
                }
                onClick={() => void save('ready_for_payment')}
              >
                {saving ? 'Saving…' : 'Ready for payment'}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
};

function StaffCartLine({
  item,
  catalogProduct,
  canEditStamp,
  hasStamping,
  usedGatcIds,
  hasUnstampedSibling,
  disabled,
  onQuantity,
  onRate,
  onStamping,
  onAddSibling,
  onRemove,
}: {
  item: CartItem & { catalogRate: number; rate: number };
  catalogProduct?: CatalogProduct;
  canEditStamp: boolean;
  hasStamping: boolean;
  usedGatcIds: string[];
  hasUnstampedSibling: boolean;
  disabled?: boolean;
  onQuantity: (qty: number) => void;
  onRate: (rate: number) => void;
  onStamping: (choice: GatcStampingChoice) => void;
  onAddSibling: (choice: GatcStampingChoice) => void;
  onRemove: () => void;
}) {
  return (
    <li className="staff-create-so-page__cart-item">
      <div className="staff-create-so-page__cart-media">
        {item.imageUrl ? (
          <CategoryThumbnail src={item.imageUrl} knockout={false} />
        ) : (
          <Package size={24} aria-hidden />
        )}
      </div>
      <DocumentLineItemSpec
        className="staff-create-so-page__cart-info"
        name={item.name}
        sku={item.sku}
        description={item.description}
      >
        <label className="staff-create-so-page__rate">
          <span className="text-muted text-sm">Base rate</span>
          <DecimalAmountInput
            className="input-field"
            value={item.catalogRate}
            min={0}
            decimals={2}
            disabled={disabled}
            onChange={next => {
              if (next == null) return;
              onRate(next);
            }}
            aria-label={`Base rate for ${item.name}`}
          />
        </label>
        {item.gatcFeePerUnit > 0 ? (
          <span className="staff-create-so-page__stamp-breakdown text-muted text-sm">
            + {item.gatcFeePerUnit.toLocaleString('en-IN')} stamping
            {item.gatcStampingRange ? ` (${item.gatcStampingRange})` : ''}
          </span>
        ) : canEditStamp ? null : (
          <span className="staff-create-so-page__stamp-breakdown text-muted text-sm">
            Without stamping
          </span>
        )}
        {canEditStamp && catalogProduct ? (
          <GatcStampingInlineControl
            product={catalogProduct}
            valueId={item.gatcStampingPriceId}
            hasStamping={hasStamping}
            usedGatcIds={usedGatcIds}
            hasUnstampedSibling={hasUnstampedSibling}
            disabled={disabled}
            onChange={onStamping}
            onAddSibling={onAddSibling}
          />
        ) : null}
        <strong>{formatCurrency(item.rate * item.quantity)}</strong>
      </DocumentLineItemSpec>
      <div className="staff-create-so-page__cart-actions">
        <QuantityStepper
          value={item.quantity}
          onChange={onQuantity}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={disabled}
          onClick={onRemove}
          aria-label="Remove from cart"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}
