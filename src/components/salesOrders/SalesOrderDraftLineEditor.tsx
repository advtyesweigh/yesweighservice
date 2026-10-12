import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Package, Search, Trash2 } from 'lucide-react';
import { DecimalAmountInput } from '../DecimalAmountInput';
import { QuantityStepper } from '../QuantityStepper';
import { CategoryThumbnail } from '../catalog/CategoryThumbnail';
import {
  type GatcStampingChoice,
} from '../catalog/GatcStampingChoiceDialog';
import { GatcStampingInlineControl } from '../catalog/GatcStampingInlineControl';
import { OrderFreightPanel } from '../orders/OrderFreightPanel';
import { DocumentLineItemSpec } from '../invoices/DocumentLineItemSpec';
import {
  FREIGHT_LINE_OPTIONS,
  freightOptionByProductId,
  freightOptionBySku,
  isFreightProductId,
  isFreightSku,
  type FreightLineSku,
} from '../../constants/freightLines';
import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import { useBlueDartPincode } from '../../hooks/useBlueDartPincode';
import { fetchCatalog, formatCurrency, formatStockQuantity } from '../../lib/catalog';
import { combinedCartRate, newCartLineId, productHasLinkedGatc } from '../../lib/gatcCart';
import { loadGatcStampingPrices } from '../../lib/catalogProductSettings';
import { loadLogisticsCourierRates } from '../../lib/logisticsCourierRates';
import { loadLogisticsSettings } from '../../lib/logisticsSettings';
import {
  freightSkuForPartner,
  isPickupPartner,
  partnerIdForFreightSku,
} from '../../lib/orderFreight';
import type { InventorySite } from '../../lib/salesOrderSegments';
import {
  applyCourierSelectionForSite,
  cartLinesAreSpareOnly,
  cartLinesForFreightEstimate,
  estimateStCourierCartFreight,
  type StCourierCartFreightEstimate,
} from '../../lib/stCourierCartFreight';
import { inferStCourierZone, type StCourierDestination } from '../../lib/stCourierZone';
import type { CatalogProduct } from '../../types/catalog';
import type { LogisticsCourierRates } from '../../types/logistics-courier-rates';
import type { LogisticsDeliveryRulesMatrix } from '../../types/logistics-delivery-rules';
import type { LogisticsPartnerStatuses } from '../../types/logistics-partner-status';

export interface DraftEditLine {
  /** Stable row id — same product can appear with/without stamping. */
  lineId: string;
  productId: string;
  name: string;
  sku: string | null;
  description: string | null;
  imageUrl: string | null;
  /** Combined unit rate = catalogRate + gatcFeePerUnit + qcFeePerUnit. */
  rate: number;
  /** Editable product base rate (staff). Catalog list price when added. */
  catalogRate: number;
  /** Fixed GATC fee from settings (0 if without stamping). */
  gatcFeePerUnit: number;
  gatcStampingPriceId?: string | null;
  gatcStampingRange?: string | null;
  qcEnabled?: boolean;
  qcFeePerUnit?: number;
  unit: string;
  quantity: number;
  stockStatus: string | null;
  categoryName?: string | null;
  categoryId?: string | null;
}

interface SalesOrderDraftLineEditorProps {
  lines: DraftEditLine[];
  onChange: (lines: DraftEditLine[]) => void;
  saving?: boolean;
  onSave: () => void;
  onCancel: () => void;
  /** Flatten into parent surface (no outer panel chrome). */
  embedded?: boolean;
  /** Allow editing base unit rate (staff create / edit). GATC fee stays fixed. */
  allowRateEdit?: boolean;
  saveLabel?: string;
  title?: string;
  hideActions?: boolean;
  /** Limit which catalog products can be added (segment permissions). */
  productFilter?: (product: CatalogProduct) => boolean;
  /** Product/spare SOs — show courier freight radio + amount (staff/admin). */
  allowFreight?: boolean;
  /** Destination for rate-card freight estimate (state/city/zip). */
  shippingDestination?: StCourierDestination | null;
  /** Staff/admin can fill missing package dims into the catalog. */
  canEditPackage?: boolean;
  /** Fired after package dims are saved to the catalog (parent can refresh gates). */
  onPackageInfoSaved?: (productId: string, info: NonNullable<CatalogProduct['packageInfo']>) => void;
}

function isFreightDraftLine(line: Pick<DraftEditLine, 'productId' | 'sku'>): boolean {
  return isFreightProductId(line.productId) || isFreightSku(line.sku);
}

function freightDraftLine(sku: FreightLineSku, rate: number): DraftEditLine {
  const option = FREIGHT_LINE_OPTIONS.find(row => row.sku === sku)!;
  const nextRate = Math.round(rate * 100) / 100;
  return {
    lineId: 'freight-line',
    productId: option.productId,
    name: option.name,
    sku: option.sku,
    description: null,
    imageUrl: option.image,
    catalogRate: nextRate,
    gatcFeePerUnit: 0,
    gatcStampingPriceId: null,
    gatcStampingRange: null,
    rate: nextRate,
    unit: 'pcs',
    quantity: 1,
    stockStatus: null,
    categoryName: null,
    categoryId: null,
  };
}

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function sameGatcKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a?.trim() || null) === (b?.trim() || null);
}

export function draftEditLineFromProduct(
  product: CatalogProduct,
  quantity = 1,
  choice?: GatcStampingChoice,
): DraftEditLine {
  const catalogRate = Math.round((Number(product.rate) || 0) * 100) / 100;
  const gatcStampingPriceId = choice?.withStamping
    ? (choice.gatcStampingPriceId?.trim() || null)
    : null;
  const gatcFeePerUnit = gatcStampingPriceId
    ? Math.round(Number(choice?.gatcFeePerUnit ?? 0) * 100) / 100
    : 0;
  return {
    lineId: newCartLineId(),
    productId: product.id,
    name: product.name,
    sku: product.sku,
    description: product.description?.trim() || null,
    imageUrl: product.imageUrl,
    catalogRate,
    gatcFeePerUnit,
    gatcStampingPriceId,
    gatcStampingRange: gatcStampingPriceId
      ? (choice?.gatcStampingRange?.trim() || null)
      : null,
    qcEnabled: false,
    qcFeePerUnit: 0,
    rate: combinedCartRate(catalogRate, gatcFeePerUnit, 0),
    unit: product.unit || 'pcs',
    quantity,
    stockStatus: product.stockStatus ?? null,
    categoryName: product.categoryName ?? null,
    categoryId: product.categoryId ?? null,
  };
}

export const SalesOrderDraftLineEditor: React.FC<SalesOrderDraftLineEditorProps> = ({
  lines,
  onChange,
  saving = false,
  onSave,
  onCancel,
  embedded = false,
  allowRateEdit = false,
  saveLabel = 'Save to Zoho',
  title = 'Edit items',
  hideActions = false,
  productFilter,
  allowFreight = false,
  shippingDestination = null,
  canEditPackage = false,
  onPackageInfoSaved,
}) => {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [freightSku, setFreightSku] = useState<string | null>(null);
  const [freightAmount, setFreightAmount] = useState('');
  const [freightAmountManual, setFreightAmountManual] = useState(false);
  const [courierRates, setCourierRates] = useState<LogisticsCourierRates | null>(null);
  const [deliveryRules, setDeliveryRules] = useState<LogisticsDeliveryRulesMatrix | null>(null);
  const [partnerStatuses, setPartnerStatuses] = useState<LogisticsPartnerStatuses | null>(null);
  const [courierBySite, setCourierBySite] = useState<Partial<Record<InventorySite, LogisticsPartnerId>>>({});
  const freightHydratedRef = useRef(false);
  const lastAutoFreightKeyRef = useRef('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounce(query, 180);

  const productLines = useMemo(
    () => lines.filter(line => !isFreightDraftLine(line)),
    [lines],
  );
  const productLinesKey = useMemo(
    () => productLines.map(line => `${line.productId}:${line.quantity}:${line.sku || ''}`).join('|'),
    [productLines],
  );
  const destinationKey = useMemo(
    () => [
      shippingDestination?.state ?? '',
      shippingDestination?.city ?? '',
      shippingDestination?.zip ?? '',
    ].join('|'),
    [shippingDestination],
  );
  const freightInputsKey = `${productLinesKey}::${destinationKey}`;
  const prevFreightInputsKeyRef = useRef(freightInputsKey);

  const catalogById = useMemo(() => {
    const map: Record<string, CatalogProduct> = {};
    for (const product of products) map[product.id] = product;
    return map;
  }, [products]);

  useEffect(() => {
    if (!allowFreight) {
      freightHydratedRef.current = false;
      setFreightSku(null);
      setFreightAmount('');
      setFreightAmountManual(false);
      setCourierBySite({});
      return;
    }
    if (freightHydratedRef.current) return;
    freightHydratedRef.current = true;
    const freight = lines.find(isFreightDraftLine);
    if (!freight) return;
    const option = freightOptionByProductId(freight.productId)
      || freightOptionBySku(freight.sku);
    const existingRate = Math.round(Number(freight.rate || freight.catalogRate || 0) * 100) / 100;
    setFreightSku(option?.sku ?? null);
    setFreightAmount(Number.isFinite(existingRate) ? String(existingRate) : '');
    // Keep Zoho/manual freight amounts — auto-estimate must not overwrite them with ₹0.
    if (Number.isFinite(existingRate) && existingRate > 0) {
      setFreightAmountManual(true);
    }
    const partner = partnerIdForFreightSku(option?.sku);
    if (partner) {
      // Site refined once estimate loads.
      setCourierBySite({ cochin: partner, head_office: partner });
    }
  }, [allowFreight, lines]);

  useEffect(() => {
    if (!allowFreight) return;
    if (prevFreightInputsKeyRef.current === freightInputsKey) return;
    prevFreightInputsKeyRef.current = freightInputsKey;
    const freight = lines.find(isFreightDraftLine);
    const existingRate = freight
      ? Math.round(Number(freight.rate || freight.catalogRate || 0) * 100) / 100
      : 0;
    if (existingRate > 0) {
      setFreightAmountManual(true);
    } else {
      setFreightAmountManual(false);
    }
    lastAutoFreightKeyRef.current = '';
  }, [allowFreight, freightInputsKey, lines]);

  useEffect(() => {
    if (!allowFreight) return;
    let cancelled = false;
    void Promise.all([loadLogisticsCourierRates(), loadLogisticsSettings()])
      .then(([rates, settings]) => {
        if (cancelled) return;
        setCourierRates(rates);
        setDeliveryRules(settings.deliveryRules);
        setPartnerStatuses(settings.partnerStatuses);
      })
      .catch(() => { /* estimate optional */ });
    return () => { cancelled = true; };
  }, [allowFreight]);

  const inferredFreightZone = useMemo(
    () => inferStCourierZone(shippingDestination),
    [shippingDestination],
  );
  const blueDartPin = useBlueDartPincode(shippingDestination?.zip);

  const freightEstimate = useMemo((): StCourierCartFreightEstimate | null => {
    if (!allowFreight || !courierRates || !deliveryRules || !partnerStatuses || productLines.length === 0) {
      return null;
    }
    const freightCartLines = cartLinesForFreightEstimate(productLines, catalogById);
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
    });
  }, [
    allowFreight,
    courierRates,
    deliveryRules,
    partnerStatuses,
    productLines,
    catalogById,
    shippingDestination,
    courierBySite,
    inferredFreightZone,
    blueDartPin,
  ]);

  const applyFreight = (sku: string | null, amountRaw: string) => {
    const withoutFreight = lines.filter(line => !isFreightDraftLine(line));
    const option = freightOptionBySku(sku);
    const trimmed = amountRaw.trim();
    const rate = Math.round(Number(trimmed) * 100) / 100;
    if (!option || trimmed === '' || !Number.isFinite(rate) || rate < 0) {
      onChange(withoutFreight);
      return;
    }
    onChange([...withoutFreight, freightDraftLine(option.sku, rate)]);
  };

  useEffect(() => {
    if (!allowFreight || !freightEstimate?.usable || freightAmountManual) return;
    const site = freightEstimate.sites[0];
    if (!site) return;

    const withoutFreight = lines.filter(line => !isFreightDraftLine(line));
    if (isPickupPartner(site.partnerId) || site.isPickup) {
      const key = `${site.site}:pickup`;
      if (lastAutoFreightKeyRef.current === key) return;
      lastAutoFreightKeyRef.current = key;
      setFreightSku(null);
      setFreightAmount('');
      if (lines.some(isFreightDraftLine)) onChange(withoutFreight);
      return;
    }

    const sku = freightSkuForPartner(site.partnerId);
    if (!sku) return;
    const rate = Math.ceil(Number(site.totalInr) || 0) || 0;
    const current = lines.find(isFreightDraftLine);
    const currentAmount = current
      ? Math.round(Number(current.rate || current.catalogRate || 0) * 100) / 100
      : 0;
    // Never clobber an existing freight line with a zero estimate
    // (common for Manual partners like Delhivery with no rate card).
    if (rate === 0 && current) {
      setFreightAmountManual(true);
      setFreightSku(String(current.sku || sku).toUpperCase());
      setFreightAmount(String(currentAmount));
      lastAutoFreightKeyRef.current = `${site.site}:${site.partnerId}:keep:${currentAmount}`;
      return;
    }
    const key = `${site.site}:${site.partnerId}:${rate}`;
    if (lastAutoFreightKeyRef.current === key) return;
    lastAutoFreightKeyRef.current = key;

    setFreightSku(sku);
    setFreightAmount(String(rate));
    if (
      current
      && String(current.sku || '').toUpperCase() === sku
      && currentAmount === rate
    ) {
      return;
    }
    onChange([...withoutFreight, freightDraftLine(sku, rate)]);
    // Sync freight line from estimate when courier/items/package change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowFreight, freightEstimate, freightAmountManual]);

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    void fetchCatalog()
      .then(res => {
        if (!cancelled) {
          setProducts(res.items);
          setCatalogError('');
        }
      })
      .catch(err => {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : 'Could not load products.');
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const productById = useMemo(() => {
    const map = new Map<string, CatalogProduct>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const selectedIds = useMemo(() => new Set(productLines.map(line => line.productId)), [productLines]);

  const matches = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(p => !isFreightProductId(p.id) && !isFreightSku(p.sku))
      .filter(p => (productFilter ? productFilter(p) : true))
      .filter(p => (
        p.name.toLowerCase().includes(q)
        || (p.sku ?? '').toLowerCase().includes(q)
        || p.id.toLowerCase().includes(q)
      ))
      .slice(0, 40);
  }, [products, debouncedQuery, productFilter]);

  const showOptions = open && !catalogLoading && query.trim().length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery, open]);

  const setQuantity = (lineId: string, quantity: number) => {
    const nextQty = Math.max(1, Math.floor(quantity) || 1);
    onChange(lines.map(line => (
      line.lineId === lineId ? { ...line, quantity: nextQty } : line
    )));
  };

  /** Staff edits base rate only; GATC fee stays fixed. */
  const setBaseRate = (lineId: string, baseRate: number) => {
    const nextBase = Number.isFinite(baseRate) && baseRate >= 0
      ? Math.round(baseRate * 100) / 100
      : 0;
    onChange(lines.map(line => (
      line.lineId === lineId
        ? {
            ...line,
            catalogRate: nextBase,
            rate: combinedCartRate(nextBase, line.gatcFeePerUnit, line.qcFeePerUnit ?? 0),
          }
        : line
    )));
  };

  const removeLine = (lineId: string) => {
    onChange(lines.filter(line => line.lineId !== lineId));
  };

  const insertOrMergeProduct = (
    product: CatalogProduct,
    choice?: GatcStampingChoice,
    insertAfterLineId?: string | null,
  ) => {
    const gatcId = choice?.withStamping ? (choice.gatcStampingPriceId?.trim() || null) : null;
    const existing = lines.find(
      line => line.productId === product.id && sameGatcKey(line.gatcStampingPriceId, gatcId),
    );
    if (existing) {
      onChange(lines.map(line => (
        line.lineId === existing.lineId
          ? { ...line, quantity: line.quantity + 1 }
          : line
      )));
    } else {
      const nextLine = draftEditLineFromProduct(product, 1, choice);
      const afterId = String(insertAfterLineId ?? '').trim();
      if (afterId) {
        const afterIndex = lines.findIndex(line => line.lineId === afterId);
        if (afterIndex >= 0) {
          const next = [...lines];
          next.splice(afterIndex + 1, 0, nextLine);
          onChange(next);
        } else {
          onChange([...lines, nextLine]);
        }
      } else {
        onChange([...lines, nextLine]);
      }
    }
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  };

  // Stampable items add without stamping; configure on the line (same UX as dealer cart).
  const addProduct = (product: CatalogProduct) => {
    insertOrMergeProduct(product);
  };

  const applyLineStamping = (lineId: string, choice: GatcStampingChoice) => {
    const stampEditLine = lines.find(line => line.lineId === lineId);
    if (!stampEditLine) return;

    const nextGatcId = choice.withStamping ? choice.gatcStampingPriceId : null;
    const nextFee = choice.withStamping ? choice.gatcFeePerUnit : 0;
    const nextRange = choice.withStamping ? choice.gatcStampingRange : null;

    const mergeInto = lines.find(
      line => line.lineId !== stampEditLine.lineId
        && line.productId === stampEditLine.productId
        && sameGatcKey(line.gatcStampingPriceId, nextGatcId),
    );

    if (mergeInto) {
      onChange(
        lines
          .filter(line => line.lineId !== stampEditLine.lineId)
          .map(line => (
            line.lineId === mergeInto.lineId
              ? {
                  ...line,
                  quantity: line.quantity + stampEditLine.quantity,
                  gatcFeePerUnit: nextFee,
                  gatcStampingPriceId: nextGatcId,
                  gatcStampingRange: nextRange,
                  rate: combinedCartRate(line.catalogRate, nextFee, line.qcFeePerUnit ?? 0),
                }
              : line
          )),
      );
      return;
    }

    onChange(lines.map(line => (
      line.lineId === stampEditLine.lineId
        ? {
            ...line,
            gatcFeePerUnit: nextFee,
            gatcStampingPriceId: nextGatcId,
            gatcStampingRange: nextRange,
            rate: combinedCartRate(line.catalogRate, nextFee, line.qcFeePerUnit ?? 0),
          }
        : line
    )));
  };

  const stampableWithoutStamping = useMemo(() => (
    productLines.filter(line => {
      if (line.gatcStampingPriceId) return false;
      const catalogProduct = productById.get(line.productId);
      return catalogProduct ? productHasLinkedGatc(catalogProduct) : false;
    })
  ), [productLines, productById]);

  const estimatedSubtotal = lines.reduce((sum, line) => sum + line.rate * line.quantity, 0);

  return (
    <section className={`so-draft-editor${embedded ? ' so-draft-editor--embedded' : ' panel glass mb-4'}`}>
      <header className="so-draft-editor__header">
        <div>
          <h3 className="so-draft-editor__title">{title}</h3>
          {!embedded && (
            <p className="so-draft-editor__subtitle text-muted text-sm">
              {allowRateEdit
                ? 'Adjust quantities and base rates (stamping fee is fixed), then save.'
                : 'Adjust quantities inline, then save to Zoho Draft.'}
            </p>
          )}
        </div>
        {!hideActions ? (
          <div className="so-draft-editor__actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving || productLines.length === 0}
              onClick={onSave}
            >
              {saving ? 'Saving…' : saveLabel}
            </button>
          </div>
        ) : null}
      </header>

      {stampableWithoutStamping.length > 0 && (
        <div className="orders-page__stamp-reminder so-draft-editor__stamp-reminder" role="status">
          <p>
            {stampableWithoutStamping.length === 1
              ? '1 item can have stamping added.'
              : `${stampableWithoutStamping.length} items can have stamping added.`}
            {' '}
            Use the stamping control on the line, or <strong>+ Add with stamping</strong> for a separate stamped line.
          </p>
        </div>
      )}

      <ul className="so-draft-editor__lines">
        {productLines.length === 0 ? (
          <li className="so-draft-editor__empty text-muted text-sm">
            No items yet. Search the catalog below to add products.
          </li>
        ) : (
          productLines.map(line => {
            const catalogProduct = productById.get(line.productId);
            const canStamp = catalogProduct
              ? productHasLinkedGatc(catalogProduct)
              : Boolean(line.gatcStampingPriceId);
            const hasStamping = Boolean(line.gatcStampingPriceId);
            const usedGatcIds = productLines
              .filter(other => other.productId === line.productId && other.gatcStampingPriceId)
              .map(other => String(other.gatcStampingPriceId));
            const hasUnstampedSibling = productLines.some(
              other => other.productId === line.productId && !other.gatcStampingPriceId,
            );
            const listBase = line.catalogRate;
            const customized = allowRateEdit
              && catalogProduct != null
              && Math.round((Number(catalogProduct.rate) || 0) * 100) !== Math.round(listBase * 100);

            return (
              <li key={line.lineId} className="so-draft-editor__line">
                <div className="so-draft-editor__line-media">
                  {line.imageUrl ? (
                    <CategoryThumbnail src={line.imageUrl} knockout={false} />
                  ) : (
                    <span className="so-draft-editor__line-placeholder" aria-hidden>
                      <Package size={22} />
                    </span>
                  )}
                </div>
                <DocumentLineItemSpec
                  className="so-draft-editor__line-info invoice-detail-item__body"
                  name={line.name}
                  sku={line.sku}
                  description={line.description}
                >
                  {allowRateEdit ? (
                    <label className="so-draft-editor__rate">
                      <span className="text-muted text-sm">Base rate</span>
                      <DecimalAmountInput
                        className="input-field so-draft-editor__rate-input"
                        value={line.catalogRate}
                        min={0}
                        decimals={2}
                        disabled={saving}
                        onChange={next => {
                          if (next == null) return;
                          setBaseRate(line.lineId, next);
                        }}
                        aria-label={`Base rate for ${line.name}`}
                      />
                      {customized ? (
                        <span className="so-draft-editor__rate-was text-muted text-sm">
                          was {formatCurrency(Number(catalogProduct?.rate) || 0)}
                        </span>
                      ) : null}
                      {line.gatcFeePerUnit > 0 ? (
                        <span className="so-draft-editor__rate-was text-muted text-sm">
                          + {formatCurrency(line.gatcFeePerUnit)} stamping
                          {line.gatcStampingRange ? ` (${line.gatcStampingRange})` : ''}
                          {' = '}
                          {formatCurrency(line.rate)}
                        </span>
                      ) : canStamp ? null : (
                        <span className="so-draft-editor__rate-was text-muted text-sm">
                          Without stamping
                        </span>
                      )}
                    </label>
                  ) : (
                    <span className="text-muted text-sm">
                      {formatCurrency(line.rate)}
                      {line.gatcFeePerUnit > 0
                        ? ` · +${formatCurrency(line.gatcFeePerUnit)} stamp`
                        : ''}
                      {line.stockStatus === 'out_of_stock' ? ' · Out of stock' : ''}
                    </span>
                  )}
                  {canStamp && catalogProduct && (
                    <GatcStampingInlineControl
                      product={catalogProduct}
                      valueId={line.gatcStampingPriceId}
                      hasStamping={hasStamping}
                      usedGatcIds={usedGatcIds}
                      hasUnstampedSibling={hasUnstampedSibling}
                      disabled={saving}
                      onChange={choice => applyLineStamping(line.lineId, choice)}
                      onAddSibling={choice => insertOrMergeProduct(catalogProduct, choice, line.lineId)}
                    />
                  )}
                </DocumentLineItemSpec>
                <QuantityStepper
                  value={line.quantity}
                  onChange={next => setQuantity(line.lineId, next)}
                  disabled={saving}
                  className="so-draft-editor__qty"
                  buttonClassName="so-draft-editor__qty-btn"
                  inputClassName="so-draft-editor__qty-input"
                  aria-label={`Quantity for ${line.name}`}
                />
                <div className="so-draft-editor__line-total">
                  {formatCurrency(line.rate * line.quantity)}
                </div>
                <button
                  type="button"
                  className="so-draft-editor__remove"
                  aria-label={`Remove ${line.name}`}
                  disabled={saving}
                  onClick={() => removeLine(line.lineId)}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div className="so-draft-editor__picker" ref={rootRef}>
        <label className="so-draft-editor__picker-label" htmlFor="so-draft-product-search">
          Add product
        </label>
        <div className={`so-draft-editor__search${showOptions ? ' is-open' : ''}`}>
          <Search size={16} aria-hidden className="so-draft-editor__search-icon" />
          <input
            ref={inputRef}
            id="so-draft-product-search"
            type="search"
            className="so-draft-editor__search-input"
            placeholder="Search by name or SKU…"
            value={query}
            disabled={saving || catalogLoading}
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={showOptions}
            aria-controls="so-draft-product-options"
            onFocus={() => {
              if (query.trim().length > 0) setOpen(true);
            }}
            onChange={e => {
              const next = e.target.value;
              setQuery(next);
              setOpen(next.trim().length > 0);
            }}
            onKeyDown={e => {
              if (!showOptions || matches.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(i => Math.min(i + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(i => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const pick = matches[activeIndex];
                if (pick) addProduct(pick);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          {catalogLoading && (
            <Loader2 size={16} className="spin-icon so-draft-editor__spinner" aria-hidden />
          )}
        </div>

        {showOptions && (
          <ul
            id="so-draft-product-options"
            className="so-draft-editor__options"
            role="listbox"
          >
            {catalogError ? (
              <li className="so-draft-editor__option-empty text-sm">{catalogError}</li>
            ) : matches.length === 0 ? (
              <li className="so-draft-editor__option-empty text-muted text-sm">
                No catalog items match.
              </li>
            ) : (
              matches.map((product, index) => {
                const selected = selectedIds.has(product.id);
                return (
                  <li key={product.id} role="option" aria-selected={index === activeIndex}>
                    <button
                      type="button"
                      className={[
                        'so-draft-editor__option',
                        index === activeIndex ? 'is-active' : '',
                        selected ? 'is-selected' : '',
                      ].filter(Boolean).join(' ')}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => addProduct(product)}
                    >
                      <span className="so-draft-editor__option-media">
                        {product.imageUrl ? (
                          <CategoryThumbnail src={product.imageUrl} knockout={false} />
                        ) : (
                          <span className="so-draft-editor__option-placeholder" aria-hidden>
                            <Package size={18} />
                          </span>
                        )}
                      </span>
                      <span className="so-draft-editor__option-body">
                        <strong>{product.name}</strong>
                        <span className="text-muted text-sm">
                          {[product.sku, product.categoryName].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="so-draft-editor__option-meta">
                        <strong>{formatCurrency(product.rate)}</strong>
                        <span className="text-muted text-sm">
                          {formatStockQuantity(product.stock, product.unit)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {allowFreight ? (
        <div className="so-draft-editor__freight">
          <h4 className="so-draft-editor__freight-title">Freight</h4>
          {freightEstimate?.usable ? (
            <OrderFreightPanel
              estimate={freightEstimate}
              canEditPackage={canEditPackage}
              allowManualFreightEntry={!saving}
              manualFreightAmount={(() => {
                const trimmed = freightAmount.trim();
                if (!trimmed) return null;
                const n = Number(trimmed);
                return Number.isFinite(n) ? n : null;
              })()}
              catalogById={catalogById}
              onManualFreightAmountChange={next => {
                const sku = freightSku
                  || freightSkuForPartner(freightEstimate.sites[0]?.partnerId)
                  || null;
                if (!sku) return;
                setFreightAmountManual(true);
                const value = next == null ? '' : String(next);
                setFreightSku(sku);
                setFreightAmount(value);
                applyFreight(sku, value);
              }}
              onCourierChange={(site, partnerId) => {
                setFreightAmountManual(false);
                lastAutoFreightKeyRef.current = '';
                setCourierBySite(prev => applyCourierSelectionForSite(
                  prev,
                  site,
                  partnerId,
                  freightEstimate?.sites.map(s => s.site),
                ));
              }}
              onPackageInfoChange={(productId, info) => {
                setFreightAmountManual(false);
                lastAutoFreightKeyRef.current = '';
                setProducts(prev => prev.map(product => (
                  product.id === productId
                    ? { ...product, packageInfo: info }
                    : product
                )));
                onPackageInfoSaved?.(productId, info);
              }}
            />
          ) : (
            <p className="text-muted text-sm">
              {shippingDestination
                ? 'Freight estimate unavailable for this destination yet.'
                : 'Shipping address needed to calculate courier freight.'}
            </p>
          )}
          {freightSku && !freightEstimate?.sites.some(site => (
            site.courierOptions.find(o => o.partnerId === site.partnerId)?.manualRate
          )) ? (
            <label className="so-draft-editor__freight-amount">
              <span className="text-muted text-sm">Freight amount (editable)</span>
              <DecimalAmountInput
                className="input-field"
                min={0}
                decimals={2}
                allowEmpty
                placeholder="0.00"
                value={(() => {
                  const trimmed = freightAmount.trim();
                  if (!trimmed) return null;
                  const n = Number(trimmed);
                  return Number.isFinite(n) ? n : null;
                })()}
                disabled={saving}
                aria-label="Freight amount"
                onChange={next => {
                  setFreightAmountManual(true);
                  const value = next == null ? '' : String(next);
                  setFreightAmount(value);
                  applyFreight(freightSku, value);
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <footer className="so-draft-editor__footer">
        <span className="text-muted text-sm">
          Est. catalog subtotal (before tax)
        </span>
        <strong>{formatCurrency(estimatedSubtotal)}</strong>
      </footer>
    </section>
  );
};

/** Hydrate draft lines from an existing SO when opening the editor. */
export async function draftLinesFromSalesOrderItems(
  items: Array<{
    /** Prefer SO line item id so inline expand can match rows. */
    id?: string | null;
    itemId?: string | null;
    productId?: string | null;
    name?: string | null;
    sku?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    rate?: number;
    total?: number;
    quantity?: number;
    unit?: string | null;
    stockStatus?: string | null;
    qcEnabled?: boolean;
    qcFeePerUnit?: number;
  }>,
): Promise<DraftEditLine[]> {
  const catalog = await fetchCatalog().catch(() => null);
  const gatcEntries = await loadGatcStampingPrices().catch(() => []);
  const byId = new Map((catalog?.items ?? []).map(p => [p.id, p]));

  return items.map(item => {
    const productId = String(item.productId || item.itemId || '').trim();
    const product = byId.get(productId);
    const catalogRate = product
      ? Math.round(Number(product.rate) * 100) / 100
      : Math.round(Number(item.rate ?? 0) * 100) / 100;
    // Existing SO lines already have combined rate; we cannot recover fee without meta.
    // Treat full rate as base with no stamping unless product has GATC and rate matches base+fee.
    // Freight catalog list price is often ₹0 — prefer SO line rate/total.
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const fromTotal = Math.round((Number(item.total ?? 0) / qty) * 100) / 100;
    const lineRate = Math.round(Number(item.rate ?? 0) * 100) / 100;
    let gatcFeePerUnit = 0;
    let gatcStampingPriceId: string | null = null;
    let gatcStampingRange: string | null = null;
    let baseRate = Math.round(Number(
      lineRate || fromTotal || catalogRate || 0,
    ) * 100) / 100;

    if (product && productHasLinkedGatc(product)) {
      const linked = new Set(
        (product.gatcStampingPriceIds ?? []).map(id => String(id).trim()).filter(Boolean),
      );
      const combined = Math.round(Number(item.rate ?? 0) * 100) / 100;
      const match = gatcEntries.find(entry => (
        linked.has(entry.id)
        && Math.round((catalogRate + entry.price) * 100) / 100 === combined
      ));
      if (match) {
        gatcStampingPriceId = match.id;
        gatcFeePerUnit = match.price;
        gatcStampingRange = match.stampingRange;
        baseRate = catalogRate;
      } else if (Math.round(combined * 100) === Math.round(catalogRate * 100)) {
        baseRate = catalogRate;
      } else {
        // Custom base (or unknown stamping) — keep rate as base, fee 0 until user picks.
        baseRate = combined;
      }
    }

    const stableId = String(item.id || '').trim();
    return {
      lineId: stableId || newCartLineId(),
      productId,
      name: String(item.name || product?.name || 'Item'),
      sku: item.sku ?? product?.sku ?? null,
      description: item.description?.trim() || product?.description?.trim() || null,
      imageUrl: item.imageUrl ?? product?.imageUrl ?? null,
      catalogRate: baseRate,
      gatcFeePerUnit,
      gatcStampingPriceId,
      gatcStampingRange,
      qcEnabled: item.qcEnabled === true,
      qcFeePerUnit: Number(item.qcFeePerUnit) || 0,
      rate: combinedCartRate(baseRate, gatcFeePerUnit, Number(item.qcFeePerUnit) || 0),
      unit: item.unit || product?.unit || 'pcs',
      quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
      stockStatus: item.stockStatus ?? product?.stockStatus ?? null,
      categoryName: product?.categoryName ?? null,
      categoryId: product?.categoryId ?? null,
    };
  });
}

export function isFreightDraftEditLine(line: Pick<DraftEditLine, 'productId' | 'sku'>): boolean {
  return isFreightProductId(line.productId) || isFreightSku(line.sku);
}

/** Product/spare lines first; freight charge lines last. */
export function withFreightDraftLinesLast(lines: DraftEditLine[]): DraftEditLine[] {
  const goods: DraftEditLine[] = [];
  const freight: DraftEditLine[] = [];
  for (const line of lines) {
    if (isFreightDraftEditLine(line)) freight.push(line);
    else goods.push(line);
  }
  if (freight.length === 0) return lines;
  return [...goods, ...freight];
}

export function draftLinesFingerprint(lines: DraftEditLine[]): string {
  return lines
    .map(line => [
      line.lineId,
      line.productId,
      line.quantity,
      Math.round(line.catalogRate * 100),
      Math.round(line.rate * 100),
      line.gatcStampingPriceId ?? '',
      line.sku ?? '',
    ].join(':'))
    .join('|');
}
