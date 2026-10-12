import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, ShoppingCart, X } from 'lucide-react';
import { CatalogBrowse } from '../catalog/CatalogBrowse';
import { CatalogCategoryChips } from '../catalog/CatalogCategoryChips';
import { CartProvider } from '../../context/CartProvider';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/useCart';
import { useCartFly } from '../../context/useCartFly';
import {
  excludeHiddenCatalogProducts,
  fetchCatalog,
  fetchSpareLinkIndex,
  getCatalogSparePartsPool,
  getCategoriesForProducts,
  isHiddenCatalogCategory,
} from '../../lib/catalog';
import { canViewCatalogStock } from '../../lib/dealerAccess';
import {
  defaultInventorySiteForSegment,
  inventorySiteLabel,
  orderSegmentFromInvoiceCategory,
  productMatchesSalesOrderBucket,
  segmentLabel,
  type InventorySite,
  type OrderSegment,
} from '../../lib/salesOrderSegments';
import type { CartItem } from '../../types/cart';
import type { CatalogCategory, CatalogProduct } from '../../types/catalog';
import type { InvoiceCategory } from '../../types/invoices';
import { StaffSoProductPeek } from './StaffSoProductPeek';
import {
  type DraftEditLine,
  isFreightDraftEditLine,
} from './SalesOrderDraftLineEditor';

function draftLineToCartItem(line: DraftEditLine): CartItem {
  return {
    cartLineId: line.lineId,
    productId: line.productId,
    name: line.name,
    sku: line.sku,
    description: line.description,
    imageUrl: line.imageUrl,
    baseRate: line.catalogRate,
    gatcFeePerUnit: line.gatcFeePerUnit,
    gatcStampingPriceId: line.gatcStampingPriceId ?? null,
    gatcStampingRange: line.gatcStampingRange ?? null,
    qcEnabled: line.qcEnabled === true,
    qcFeePerUnit: line.qcFeePerUnit ?? 0,
    rate: line.rate,
    unit: line.unit || 'pcs',
    stockStatus: (line.stockStatus as CartItem['stockStatus']) ?? 'in_stock',
    categoryName: line.categoryName ?? null,
    categoryId: line.categoryId ?? null,
    quantity: Math.max(1, Math.floor(line.quantity || 1)),
  };
}

function cartItemToDraftLine(item: CartItem): DraftEditLine {
  return {
    lineId: item.cartLineId,
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    description: item.description,
    imageUrl: item.imageUrl,
    catalogRate: item.baseRate,
    gatcFeePerUnit: item.gatcFeePerUnit,
    gatcStampingPriceId: item.gatcStampingPriceId ?? null,
    gatcStampingRange: item.gatcStampingRange ?? null,
    qcEnabled: item.qcEnabled === true,
    qcFeePerUnit: item.qcFeePerUnit ?? 0,
    rate: item.rate,
    unit: item.unit || 'pcs',
    quantity: Math.max(1, Math.floor(item.quantity || 1)),
    stockStatus: item.stockStatus ?? null,
    categoryName: item.categoryName ?? null,
    categoryId: item.categoryId ?? null,
  };
}

const SoDetailCatalogAddBody: React.FC<{
  orderCategory: InvoiceCategory | null | undefined;
  orderSegment: OrderSegment | null;
  inventorySite: InventorySite | null;
  allowAllProducts?: boolean;
  /** Product ids already on the SO — kept even if warehouse stock later flips site. */
  seedProductIds: Set<string>;
  onClose: () => void;
  onApply: (productLines: DraftEditLine[]) => void;
}> = ({
  orderCategory,
  orderSegment,
  inventorySite,
  allowAllProducts = false,
  seedProductIds,
  onClose,
  onApply,
}) => {
  const { user } = useAuth();
  const { items, itemCount } = useCart();
  const { registerCartTarget, cartBump } = useCartFly();
  const cartBtnRef = useRef<HTMLButtonElement>(null);
  const showStockQuantity = canViewCatalogStock(user);

  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  const [catalogCategories, setCatalogCategories] = useState<CatalogCategory[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [browseCategoryId, setBrowseCategoryId] = useState('');
  const [peekProduct, setPeekProduct] = useState<CatalogProduct | null>(null);
  const [spareCountByProductId, setSpareCountByProductId] = useState<Map<string, number> | null>(null);

  const resolvedSegment = orderSegment
    || orderSegmentFromInvoiceCategory(orderCategory);
  const resolvedSite = inventorySite
    || (resolvedSegment ? defaultInventorySiteForSegment(resolvedSegment) : null);
  const isSpareOrder = resolvedSegment === 'spare';
  const bucketLabel = resolvedSegment && resolvedSite
    ? `${segmentLabel(resolvedSegment)} · ${inventorySiteLabel(resolvedSite)}`
    : null;

  /** Strict create/submit bucket: segment × inventory site (use full catalog row for warehouses). */
  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogProduct>();
    for (const product of catalogProducts) map.set(product.id, product);
    return map;
  }, [catalogProducts]);

  const isCartable = useMemo(
    () => (product: CatalogProduct) => {
      if (allowAllProducts) return true;
      const full = catalogById.get(product.id) ?? product;
      return productMatchesSalesOrderBucket(full, {
        segment: resolvedSegment,
        site: resolvedSite,
      });
    },
    [allowAllProducts, catalogById, resolvedSegment, resolvedSite],
  );

  /**
   * Spare SO: browse the spare-parts catalog so any spare can be added.
   * Other SO types: browse only cartable bucket items.
   */
  const shopProducts = useMemo(() => {
    const visible = excludeHiddenCatalogProducts(catalogProducts, catalogCategories);
    if (isSpareOrder) {
      return getCatalogSparePartsPool(visible, catalogCategories);
    }
    return visible.filter(isCartable);
  }, [catalogProducts, catalogCategories, isSpareOrder, isCartable]);

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
  }, []);

  useEffect(() => {
    registerCartTarget(cartBtnRef.current);
    return () => registerCartTarget(null);
  }, [registerCartTarget, itemCount]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = () => {
    const allowed = items.filter(item => {
      if (allowAllProducts || seedProductIds.has(item.productId)) return true;
      const catalog = catalogById.get(item.productId);
      return productMatchesSalesOrderBucket(
        catalog ?? {
          id: item.productId,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          sku: item.sku,
        },
        { segment: resolvedSegment, site: resolvedSite },
      );
    });
    onApply(allowed.map(cartItemToDraftLine));
  };

  return (
    <div
      className="so-detail-catalog-add"
      role="dialog"
      aria-modal="true"
      aria-label="Add items from catalog"
    >
      <header className="so-detail-catalog-add__bar panel glass">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
          Cancel
        </button>
        <p className="text-muted text-sm so-detail-catalog-add__hint">
          {isSpareOrder
            ? 'Search spare parts and add them to this order'
            : bucketLabel
              ? `Only ${bucketLabel} items can be added to this order`
              : 'Tap an item for details & linked spares, or the cart icon to add it'}
        </p>
        <button
          ref={cartBtnRef}
          type="button"
          id="so-detail-cart-fly-target"
          className={`btn btn-primary btn-sm so-detail-catalog-add__cart-btn${
            cartBump ? ' cart-header-btn--bump' : ''
          }`}
          disabled={items.length === 0}
          onClick={apply}
          aria-label={`Done, ${itemCount} items`}
        >
          <ShoppingCart size={16} aria-hidden />
          <span>Done</span>
          {items.length > 0 ? (
            <span className="so-detail-catalog-add__cart-badge">{items.length}</span>
          ) : null}
        </button>
      </header>

      <div className="so-detail-catalog-add__body">
        {catalogError ? (
          <div className="products-inline-error panel glass" role="alert">
            <AlertCircle size={18} />
            <span>{catalogError}</span>
          </div>
        ) : (
          <>
            {showBrowseCategoryChips ? (
              <div className="so-detail-catalog-add__chips panel glass">
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
              isCartable={isCartable}
              flatBrowse={isSpareOrder}
              showCategoryGrid={!isSpareOrder && !browseCategoryId}
              searchPlaceholder={isSpareOrder ? 'Search spare parts…' : 'Search products…'}
              showStockQuantity={showStockQuantity}
              spareLinkCountByProductId={isSpareOrder ? undefined : (spareCountByProductId ?? undefined)}
              onProductSelect={setPeekProduct}
              managePageHeader={false}
              activeCategoryId={browseCategoryId}
              onActiveCategoryChange={setBrowseCategoryId}
              emptyTitle={isSpareOrder ? 'No spare parts available' : 'No catalog items available'}
              emptyHint={isSpareOrder ? 'Sync the catalog or search a different spare name.' : 'Sync the catalog or adjust category filters.'}
            />
          </>
        )}
      </div>

      <StaffSoProductPeek
        product={peekProduct}
        categories={catalogCategories}
        showStockQuantity={showStockQuantity}
        isCartable={isCartable}
        onClose={() => setPeekProduct(null)}
      />

      <footer className="so-detail-catalog-add__footer panel glass">
        <span className="text-muted text-sm">
          {items.length
            ? `${items.length} line${items.length === 1 ? '' : 's'} selected`
            : isSpareOrder
              ? 'Add spare parts from the catalog'
              : 'Add items from products'}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={items.length === 0}
          onClick={apply}
        >
          <Check size={16} aria-hidden />
          Apply to order
        </button>
      </footer>
    </div>
  );
};

export const SoDetailCatalogAddSheet: React.FC<{
  open: boolean;
  /** Remount key so each open gets a fresh ephemeral cart seeded from the SO. */
  sessionKey: number;
  seedLines: DraftEditLine[];
  orderCategory?: InvoiceCategory | null;
  orderSegment?: OrderSegment | null;
  inventorySite?: InventorySite | null;
  allowAllProducts?: boolean;
  onClose: () => void;
  onApply: (productLines: DraftEditLine[]) => void;
}> = ({
  open,
  sessionKey,
  seedLines,
  orderCategory,
  orderSegment = null,
  inventorySite = null,
  allowAllProducts = false,
  onClose,
  onApply,
}) => {
  const seedItems = useMemo(
    () => seedLines.filter(line => !isFreightDraftEditLine(line)).map(draftLineToCartItem),
    [seedLines],
  );
  const seedProductIds = useMemo(
    () => new Set(seedItems.map(item => item.productId)),
    [seedItems],
  );

  if (!open) return null;

  return createPortal(
    <CartProvider key={sessionKey} persist={false} initialItems={seedItems}>
      <SoDetailCatalogAddBody
        orderCategory={orderCategory}
        orderSegment={orderSegment}
        inventorySite={inventorySite}
        allowAllProducts={allowAllProducts}
        seedProductIds={seedProductIds}
        onClose={onClose}
        onApply={onApply}
      />
    </CartProvider>,
    document.body,
  );
};
