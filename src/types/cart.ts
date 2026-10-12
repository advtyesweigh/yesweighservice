import type { CatalogProduct, StockStatus } from './catalog';
import { combinedCartRate, newCartLineId } from '../lib/gatcCart';
import { resolveMachineQc } from '../lib/machineQc';
import { effectiveCatalogStockStatus } from '../lib/sacCatalog';
import type { PriceLevelQtySlab } from './priceLevels';

export interface CartItem {
  /** Stable row id — same product can appear twice (with / without stamping). */
  cartLineId: string;
  productId: string;
  name: string;
  sku: string | null;
  /** Zoho item description — same “spec writing” as SO / invoice lines. */
  description: string | null;
  imageUrl: string | null;
  /**
   * Unit rate charged on the SO line = baseRate + gatcFeePerUnit + qcFeePerUnit.
   * (Accounting: stamping and QC are rolled into product price, not separate lines.)
   */
  rate: number;
  /** Catalog / staff-editable product rate before stamping / QC fees. */
  baseRate: number;
  /**
   * Catalog list rate when a price-level discount applies (dealer portal).
   * Null/undefined for list pricing or price-hike levels (hike hides list).
   */
  listRate?: number | null;
  /** Price-level mode applied to baseRate, if any. */
  priceLevelMode?: 'none' | 'discount' | 'increment' | 'fixed' | null;
  /** Qty slab table for dealer display when this line uses fixed slabs. */
  priceLevelSlabs?: PriceLevelQtySlab[] | null;
  /** Fixed GATC fee per unit from Product settings (0 if without stamping). */
  gatcFeePerUnit: number;
  /** Selected GATC entry id; null/undefined = without stamping. */
  gatcStampingPriceId?: string | null;
  /** Snapshot of stamping range label for cart display. */
  gatcStampingRange?: string | null;
  /** Extra QC per machine; rolled into unit rate. */
  qcEnabled?: boolean;
  qcFeePerUnit?: number;
  unit: string;
  stockStatus: StockStatus;
  categoryName: string | null;
  categoryId?: string | null;
  hsn?: string | null;
  quantity: number;
  /** Who added this line on a shared dealer cart. */
  addedByUid?: string | null;
  addedByName?: string | null;
  addedByTeam?: 'sales' | 'service' | 'dealer' | null;
}

export type AddCartItemOptions = {
  quantity?: number;
  /** null = without stamping; set to link a GATC fee into the unit rate. */
  gatcStampingPriceId?: string | null;
  gatcFeePerUnit?: number;
  gatcStampingRange?: string | null;
  /** When set, insert the new line immediately after this cart line (sibling stamping / QC). */
  insertAfterCartLineId?: string | null;
  /** Extra QC per machine for Weighing Scale Import / Bill Printing Scales. */
  qcEnabled?: boolean;
  /** Override catalog rate (e.g. dealer price level charge rate). */
  baseRateOverride?: number | null;
  /** List rate to show alongside a discount charge rate. */
  listRate?: number | null;
  priceLevelMode?: 'none' | 'discount' | 'increment' | 'fixed' | null;
  priceLevelSlabs?: PriceLevelQtySlab[] | null;
};

export function cartItemFromProduct(
  product: CatalogProduct,
  quantity = 1,
  options: Omit<AddCartItemOptions, 'quantity'> = {},
): CartItem {
  const catalogRate = Math.round(Number(product.rate) * 100) / 100;
  const baseRate = options.baseRateOverride != null && Number.isFinite(Number(options.baseRateOverride))
    ? Math.round(Number(options.baseRateOverride) * 100) / 100
    : catalogRate;
  const gatcFeePerUnit = Math.round(Number(options.gatcFeePerUnit ?? 0) * 100) / 100;
  const gatcStampingPriceId = options.gatcStampingPriceId?.trim() || null;
  const qc = resolveMachineQc(product.categoryName, options.qcEnabled === true);
  const priceLevelMode = options.priceLevelMode ?? null;
  const listRate = options.listRate != null && Number.isFinite(Number(options.listRate))
    ? Math.round(Number(options.listRate) * 100) / 100
    : null;
  const priceLevelSlabs = Array.isArray(options.priceLevelSlabs) && options.priceLevelSlabs.length
    ? options.priceLevelSlabs
    : null;
  return {
    cartLineId: newCartLineId(),
    productId: product.id,
    name: product.name,
    sku: product.sku,
    description: product.description?.trim() || null,
    imageUrl: product.imageUrl,
    baseRate,
    listRate,
    priceLevelMode,
    priceLevelSlabs,
    gatcFeePerUnit: gatcStampingPriceId ? gatcFeePerUnit : 0,
    gatcStampingPriceId,
    gatcStampingRange: gatcStampingPriceId
      ? (options.gatcStampingRange?.trim() || null)
      : null,
    qcEnabled: qc.qcEnabled,
    qcFeePerUnit: qc.qcFeePerUnit,
    rate: combinedCartRate(baseRate, gatcStampingPriceId ? gatcFeePerUnit : 0, qc.qcFeePerUnit),
    unit: product.unit,
    stockStatus: effectiveCatalogStockStatus(product.stockStatus, product.hsn),
    categoryName: product.categoryName,
    categoryId: product.categoryId ?? null,
    hsn: product.hsn ?? null,
    quantity,
  };
}
