import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { combinedCartRate } from '../lib/gatcCart';
import { resolveMachineQc } from '../lib/machineQc';
import {
  applyDealerCartPricing,
  resolveDealerUnitPrice,
  subscribePriceLevels,
} from '../lib/priceLevels';
import { effectiveCatalogStockStatus } from '../lib/sacCatalog';
import type { CatalogProduct } from '../types/catalog';
import type { PriceLevel, PriceLevelQtySlab } from '../types/priceLevels';
import {
  cartItemFromProduct,
  type AddCartItemOptions,
  type CartItem,
} from '../types/cart';
import {
  applyCartAttribution,
  cartAttributionForUser,
  deleteDealerCartItem,
  deleteDealerCartItems,
  isStaffAttributedCartLine,
  migrateLocalCartToDealerCart,
  parseStoredCartItem,
  sharedDealerCartUid,
  subscribeDealerCartItems,
  subscribeDealerCartRemarks,
  upsertDealerCartItem,
  writeDealerCartRemarks,
} from '../lib/dealerSharedCart';
import { useAuth } from './AuthContext';
import { CartContext, type UpdateCartQcInput, type UpdateCartStampingInput } from './cart-context';
import { DealerPriceLevelContext } from './dealer-price-level-context';
import { isDealerPortalUser } from '../lib/dealerAccess';
import { isCatalogProductSalesRestricted } from '../lib/catalogSalesRestriction';

const STORAGE_PREFIX = 'yesweigh-cart';
/** Zoho SO notes max is 5000; keep a practical portal limit. */
export const CART_REMARKS_MAX_LENGTH = 2000;

function storageKey(uid: string): string {
  return `${STORAGE_PREFIX}:${uid}`;
}

function sameGatcKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a?.trim() || null) === (b?.trim() || null);
}

function sameAddedBy(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a?.trim() || null) === (b?.trim() || null);
}

function normalizeCartItem(raw: Partial<CartItem> & { productId?: string }): CartItem | null {
  return parseStoredCartItem(raw);
}

function normalizeRemarks(raw: unknown): string {
  return String(raw ?? '').slice(0, CART_REMARKS_MAX_LENGTH);
}

interface StoredCart {
  items: CartItem[];
  remarks: string;
}

function readStoredCart(uid: string): StoredCart {
  try {
    const raw = localStorage.getItem(storageKey(uid));
    if (!raw) return { items: [], remarks: '' };
    const parsed = JSON.parse(raw) as CartItem[] | StoredCart;
    if (Array.isArray(parsed)) {
      return {
        items: parsed
          .map(item => normalizeCartItem(item))
          .filter((item): item is CartItem => Boolean(item)),
        remarks: '',
      };
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      items: items
        .map(item => normalizeCartItem(item))
        .filter((item): item is CartItem => Boolean(item)),
      remarks: normalizeRemarks(parsed?.remarks),
    };
  } catch {
    return { items: [], remarks: '' };
  }
}

function writeStoredCart(uid: string, items: CartItem[], remarks: string): void {
  try {
    if (items.length === 0 && !remarks.trim()) {
      localStorage.removeItem(storageKey(uid));
    } else {
      const payload: StoredCart = { items, remarks: normalizeRemarks(remarks) };
      localStorage.setItem(storageKey(uid), JSON.stringify(payload));
    }
  } catch {
    /* ignore quota errors */
  }
}

function parseAddOptions(options?: number | AddCartItemOptions): Required<
  Pick<AddCartItemOptions, 'quantity'>
> & AddCartItemOptions {
  if (typeof options === 'number') {
    return { quantity: options };
  }
  return {
    quantity: options?.quantity ?? 1,
    gatcStampingPriceId: options?.gatcStampingPriceId,
    gatcFeePerUnit: options?.gatcFeePerUnit,
    gatcStampingRange: options?.gatcStampingRange,
    qcEnabled: options?.qcEnabled === true,
    insertAfterCartLineId: options?.insertAfterCartLineId,
    baseRateOverride: options?.baseRateOverride,
    listRate: options?.listRate,
    priceLevelMode: options?.priceLevelMode,
  };
}

function dealerPortalId(user: { role?: string; zohoCustomerId?: string } | null): string | null {
  if (!user || (user.role !== 'dealer' && user.role !== 'dealer_staff')) return null;
  // Must be Zoho contact id (same ids stored in priceLevels.dealerIds) — not Firebase uid.
  return user.zohoCustomerId?.trim() || null;
}

function persistSharedItem(sharedUid: string | null, item: CartItem): void {
  if (!sharedUid) return;
  void upsertDealerCartItem(sharedUid, item);
}

function persistSharedDelete(sharedUid: string | null, cartLineId: string): void {
  if (!sharedUid) return;
  void deleteDealerCartItem(sharedUid, cartLineId);
}

export const CartProvider: React.FC<{
  children: React.ReactNode;
  /** When false, cart stays in-memory only (nested SO edit sheet). Default true. */
  persist?: boolean;
  /** Seed lines when persist is false (remount to refresh). */
  initialItems?: CartItem[];
}> = ({ children, persist = true, initialItems }) => {
  const { user } = useAuth();
  const dealerPriceLevels = useContext(DealerPriceLevelContext);
  const sharedUid = persist ? sharedDealerCartUid(user) : null;
  const [allItems, setAllItems] = useState<CartItem[]>(() => (
    !persist && initialItems ? initialItems : []
  ));
  const [remarks, setRemarksState] = useState('');
  const [cartReady, setCartReady] = useState(!persist);
  const [priceLevels, setPriceLevels] = useState<PriceLevel[]>([]);
  const priceLevelsRef = useRef<PriceLevel[]>([]);
  priceLevelsRef.current = priceLevels;
  const allItemsRef = useRef<CartItem[]>(allItems);
  allItemsRef.current = allItems;
  const dealerId = dealerPortalId(user);
  const migratedRef = useRef<string | null>(null);

  const items = useMemo(() => {
    if (user?.role === 'dealer_staff') {
      return allItems.filter(item => (item.addedByUid || null) === user.uid);
    }
    return allItems;
  }, [allItems, user?.role, user?.uid]);

  useEffect(() => {
    if (!persist) return;
    if (sharedUid && user?.uid) {
      setCartReady(false);
      let cancelled = false;
      const unsubItems = subscribeDealerCartItems(sharedUid, remoteItems => {
        if (cancelled) return;
        const priced = dealerId
          ? applyDealerCartPricing(remoteItems, priceLevelsRef.current, dealerId)
          : remoteItems;
        setAllItems(priced);
        setCartReady(true);
        if (migratedRef.current === sharedUid) return;
        migratedRef.current = sharedUid;
        const local = readStoredCart(user.uid);
        if (!local.items.length && !local.remarks.trim()) return;
        const attribution = cartAttributionForUser(user, null);
        void migrateLocalCartToDealerCart(sharedUid, local.items, local.remarks, attribution)
          .then(() => writeStoredCart(user.uid, [], ''));
      });
      const unsubRemarks = subscribeDealerCartRemarks(sharedUid, next => {
        if (!cancelled) setRemarksState(normalizeRemarks(next));
      });
      return () => {
        cancelled = true;
        unsubItems();
        unsubRemarks();
      };
    }
    migratedRef.current = null;
    if (user?.uid) {
      const stored = readStoredCart(user.uid);
      setAllItems(stored.items);
      setRemarksState(stored.remarks);
    } else {
      setAllItems([]);
      setRemarksState('');
    }
    setCartReady(true);
    return undefined;
  }, [persist, sharedUid, user?.uid, user?.role, dealerId]);

  useEffect(() => {
    if (!dealerId) {
      setPriceLevels([]);
      return;
    }
    return subscribePriceLevels(docData => {
      setPriceLevels(docData.levels);
    });
  }, [dealerId]);

  useEffect(() => {
    if (!dealerId) return;
    setAllItems(prev => applyDealerCartPricing(prev, priceLevels, dealerId));
  }, [dealerId, priceLevels]);

  useEffect(() => {
    if (!persist || !user?.uid || sharedUid) return;
    writeStoredCart(user.uid, allItems, remarks);
  }, [persist, allItems, remarks, user?.uid, sharedUid]);

  const addItem = useCallback((
    product: CatalogProduct,
    options?: number | AddCartItemOptions,
  ): boolean => {
    const opts = parseAddOptions(options);
    const quantity = Math.floor(Number(opts.quantity) || 0);
    if (quantity < 1) return false;
    if (
      isDealerPortalUser(user)
      && isCatalogProductSalesRestricted(product, dealerPriceLevels?.billingState)
    ) {
      return false;
    }
    const stockStatus = effectiveCatalogStockStatus(product.stockStatus, product.hsn);
    const attribution = cartAttributionForUser(user, product);

    const gatcStampingPriceId = opts.gatcStampingPriceId?.trim() || null;
    const gatcFeePerUnit = gatcStampingPriceId
      ? Math.round(Number(opts.gatcFeePerUnit ?? 0) * 100) / 100
      : 0;
    const qc = resolveMachineQc(product.categoryName, opts.qcEnabled === true);

    let baseRate = opts.baseRateOverride != null && Number.isFinite(Number(opts.baseRateOverride))
      ? Math.round(Number(opts.baseRateOverride) * 100) / 100
      : Math.round(Number(product.rate) * 100) / 100;
    let listRate: number | null = opts.listRate != null && Number.isFinite(Number(opts.listRate))
      ? Math.round(Number(opts.listRate) * 100) / 100
      : null;
    let priceLevelMode = opts.priceLevelMode ?? null;

    let priceLevelSlabs: PriceLevelQtySlab[] | null = null;
    if (opts.baseRateOverride == null && dealerId) {
      const priced = resolveDealerUnitPrice(
        priceLevelsRef.current,
        dealerId,
        product,
        quantity,
      );
      baseRate = priced.chargeRate;
      priceLevelMode = priced.mode;
      listRate = priced.listRate;
      priceLevelSlabs = priced.slabs.length ? priced.slabs : null;
    }

    setAllItems(prev => {
      const existing = prev.find(
        item => item.productId === product.id
          && sameGatcKey(item.gatcStampingPriceId, gatcStampingPriceId)
          && Boolean(item.qcEnabled) === qc.qcEnabled
          && sameAddedBy(item.addedByUid, attribution?.addedByUid),
      );
      let next: CartItem[];
      if (existing) {
        const nextQty = existing.quantity + quantity;
        const nextItem = applyCartAttribution({
          ...existing,
          baseRate,
          listRate,
          priceLevelMode,
          priceLevelSlabs,
          gatcFeePerUnit,
          gatcStampingPriceId,
          gatcStampingRange: gatcStampingPriceId
            ? (opts.gatcStampingRange?.trim() || existing.gatcStampingRange || null)
            : null,
          qcEnabled: qc.qcEnabled,
          qcFeePerUnit: qc.qcFeePerUnit,
          rate: combinedCartRate(baseRate, gatcFeePerUnit, qc.qcFeePerUnit),
          stockStatus,
          hsn: product.hsn ?? existing.hsn ?? null,
          name: product.name,
          description: product.description?.trim() || existing.description || null,
          sku: product.sku ?? existing.sku,
          quantity: nextQty,
        }, attribution);
        persistSharedItem(sharedUid, nextItem);
        next = prev.map(item => (item.cartLineId === existing.cartLineId ? nextItem : item));
      } else {
        const nextItem = applyCartAttribution(cartItemFromProduct(product, quantity, {
          gatcStampingPriceId,
          gatcFeePerUnit,
          gatcStampingRange: opts.gatcStampingRange,
          qcEnabled: qc.qcEnabled,
          baseRateOverride: baseRate,
          listRate,
          priceLevelMode,
          priceLevelSlabs,
        }), attribution);
        persistSharedItem(sharedUid, nextItem);
        const afterId = String(opts.insertAfterCartLineId ?? '').trim();
        if (afterId) {
          const afterIndex = prev.findIndex(item => item.cartLineId === afterId);
          if (afterIndex >= 0) {
            next = [...prev];
            next.splice(afterIndex + 1, 0, nextItem);
          } else {
            next = [...prev, nextItem];
          }
        } else {
          next = [...prev, nextItem];
        }
      }
      if (!dealerId || opts.baseRateOverride != null) return next;
      return applyDealerCartPricing(next, priceLevelsRef.current, dealerId);
    });
    return true;
  }, [dealerId, sharedUid, user, dealerPriceLevels?.billingState]);

  const removeItem = useCallback((cartLineId: string) => {
    persistSharedDelete(sharedUid, cartLineId);
    setAllItems(prev => {
      const next = prev.filter(item => item.cartLineId !== cartLineId);
      if (!dealerId) return next;
      return applyDealerCartPricing(next, priceLevelsRef.current, dealerId);
    });
  }, [dealerId, sharedUid]);

  const setQuantity = useCallback((cartLineId: string, quantity: number) => {
    if (quantity < 1) {
      persistSharedDelete(sharedUid, cartLineId);
      setAllItems(prev => {
        const next = prev.filter(item => item.cartLineId !== cartLineId);
        if (!dealerId) return next;
        return applyDealerCartPricing(next, priceLevelsRef.current, dealerId);
      });
      return;
    }
    const qty = Math.max(1, Math.floor(quantity));
    setAllItems(prev => {
      const next = prev.map(item => (
        item.cartLineId === cartLineId ? { ...item, quantity: qty } : item
      ));
      const priced = dealerId
        ? applyDealerCartPricing(next, priceLevelsRef.current, dealerId)
        : next;
      const updated = priced.find(item => item.cartLineId === cartLineId);
      if (updated) persistSharedItem(sharedUid, updated);
      return priced;
    });
  }, [dealerId, sharedUid]);

  const updateStamping = useCallback((cartLineId: string, input: UpdateCartStampingInput) => {
    setAllItems(prev => {
      const target = prev.find(item => item.cartLineId === cartLineId);
      if (!target) return prev;

      const nextGatcId = input.withStamping
        ? (input.gatcStampingPriceId?.trim() || null)
        : null;
      if (input.withStamping && !nextGatcId) return prev;

      const nextFee = nextGatcId
        ? Math.round(Number(input.gatcFeePerUnit ?? 0) * 100) / 100
        : 0;
      const nextRange = nextGatcId
        ? (input.gatcStampingRange?.trim() || null)
        : null;

      const mergeInto = prev.find(
        item => item.cartLineId !== cartLineId
          && item.productId === target.productId
          && sameGatcKey(item.gatcStampingPriceId, nextGatcId)
          && Boolean(item.qcEnabled) === Boolean(target.qcEnabled)
          && sameAddedBy(item.addedByUid, target.addedByUid),
      );

      if (mergeInto) {
        persistSharedDelete(sharedUid, cartLineId);
        const merged = prev
          .filter(item => item.cartLineId !== cartLineId)
          .map(item => (
            item.cartLineId === mergeInto.cartLineId
              ? {
                  ...item,
                  quantity: item.quantity + target.quantity,
                  baseRate: target.baseRate,
                  gatcFeePerUnit: nextFee,
                  gatcStampingPriceId: nextGatcId,
                  gatcStampingRange: nextRange,
                  rate: combinedCartRate(target.baseRate, nextFee, Number(target.qcFeePerUnit) || 0),
                }
              : item
          ));
        const priced = dealerId
          ? applyDealerCartPricing(merged, priceLevelsRef.current, dealerId)
          : merged;
        const updated = priced.find(item => item.cartLineId === mergeInto.cartLineId);
        if (updated) persistSharedItem(sharedUid, updated);
        return priced;
      }

      const stamped = prev.map(item => (
        item.cartLineId === cartLineId
          ? {
              ...item,
              gatcFeePerUnit: nextFee,
              gatcStampingPriceId: nextGatcId,
              gatcStampingRange: nextRange,
              rate: combinedCartRate(item.baseRate, nextFee, Number(item.qcFeePerUnit) || 0),
            }
          : item
      ));
      const priced = dealerId
        ? applyDealerCartPricing(stamped, priceLevelsRef.current, dealerId)
        : stamped;
      const updated = priced.find(item => item.cartLineId === cartLineId);
      if (updated) persistSharedItem(sharedUid, updated);
      return priced;
    });
  }, [dealerId, sharedUid]);

  const updateQc = useCallback((cartLineId: string, input: UpdateCartQcInput) => {
    setAllItems(prev => {
      const target = prev.find(item => item.cartLineId === cartLineId);
      if (!target) return prev;

      const categoryName = input.categoryName || target.categoryName;
      const qc = resolveMachineQc(categoryName, input.qcEnabled);
      const gatcFee = Number(target.gatcFeePerUnit) || 0;

      const mergeInto = prev.find(
        item => item.cartLineId !== cartLineId
          && item.productId === target.productId
          && sameGatcKey(item.gatcStampingPriceId, target.gatcStampingPriceId)
          && Boolean(item.qcEnabled) === qc.qcEnabled
          && sameAddedBy(item.addedByUid, target.addedByUid),
      );

      if (mergeInto) {
        persistSharedDelete(sharedUid, cartLineId);
        const merged = prev
          .filter(item => item.cartLineId !== cartLineId)
          .map(item => (
            item.cartLineId === mergeInto.cartLineId
              ? {
                  ...item,
                  quantity: item.quantity + target.quantity,
                  baseRate: target.baseRate,
                  categoryName: categoryName ?? item.categoryName,
                  qcEnabled: qc.qcEnabled,
                  qcFeePerUnit: qc.qcFeePerUnit,
                  rate: combinedCartRate(target.baseRate, gatcFee, qc.qcFeePerUnit),
                }
              : item
          ));
        const priced = dealerId
          ? applyDealerCartPricing(merged, priceLevelsRef.current, dealerId)
          : merged;
        const updated = priced.find(item => item.cartLineId === mergeInto.cartLineId);
        if (updated) persistSharedItem(sharedUid, updated);
        return priced;
      }

      const next = prev.map(item => (
        item.cartLineId === cartLineId
          ? {
              ...item,
              categoryName: categoryName ?? item.categoryName,
              qcEnabled: qc.qcEnabled,
              qcFeePerUnit: qc.qcFeePerUnit,
              rate: combinedCartRate(item.baseRate, gatcFee, qc.qcFeePerUnit),
            }
          : item
      ));
      const priced = dealerId
        ? applyDealerCartPricing(next, priceLevelsRef.current, dealerId)
        : next;
      const updated = priced.find(item => item.cartLineId === cartLineId);
      if (updated) persistSharedItem(sharedUid, updated);
      return priced;
    });
  }, [dealerId, sharedUid]);

  const setRemarks = useCallback((next: string) => {
    const value = normalizeRemarks(next);
    setRemarksState(value);
    if (sharedUid) void writeDealerCartRemarks(sharedUid, value);
  }, [sharedUid]);

  const clearCart = useCallback(() => {
    if (sharedUid) {
      const ids = user?.role === 'dealer'
        ? allItemsRef.current
          .filter(item => !isStaffAttributedCartLine(item))
          .map(item => item.cartLineId)
        : items.map(item => item.cartLineId);
      void deleteDealerCartItems(sharedUid, ids);
      setAllItems(prev => prev.filter(item => !ids.includes(item.cartLineId)));
      if (user?.role !== 'dealer_staff') setRemarksState('');
      return;
    }
    setAllItems([]);
    setRemarksState('');
  }, [items, sharedUid, user?.role]);

  const isInCart = useCallback(
    (productId: string) => items.some(item => item.productId === productId),
    [items],
  );

  const getQuantity = useCallback(
    (productId: string) => items
      .filter(item => item.productId === productId)
      .reduce((sum, item) => sum + item.quantity, 0),
    [items],
  );

  const itemCount = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity, 0),
    [items],
  );

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.rate * item.quantity, 0),
    [items],
  );

  const value = useMemo(
    () => ({
      items,
      itemCount,
      subtotal,
      cartReady,
      remarks,
      addItem,
      removeItem,
      setQuantity,
      updateStamping,
      updateQc,
      setRemarks,
      clearCart,
      isInCart,
      getQuantity,
    }),
    [
      items,
      itemCount,
      subtotal,
      cartReady,
      remarks,
      addItem,
      removeItem,
      setQuantity,
      updateStamping,
      updateQc,
      setRemarks,
      clearCart,
      isInCart,
      getQuantity,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};
