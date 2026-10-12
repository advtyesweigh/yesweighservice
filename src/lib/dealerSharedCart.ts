import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import { combinedCartRate, newCartLineId } from './gatcCart';
import { resolveMachineQc } from './machineQc';
import { dealerPortalStaffTeams, dealerStaffTeam, resolveDealerAccountUid } from './dealerAccess';
import { isCatalogSparePartProduct } from './catalog';
import { normalizePriceLevelSlabs } from './priceLevels';
import { effectiveCatalogStockStatus } from './sacCatalog';
import type { CartItem } from '../types/cart';
import type { CatalogProduct } from '../types/catalog';
import type { User } from '../types';

export const DEALER_CARTS_COLLECTION = 'dealerCarts';

export type CartAddedByTeam = 'sales' | 'service' | 'dealer';

export type CartAttribution = {
  addedByUid: string;
  addedByName: string;
  addedByTeam: CartAddedByTeam;
};

export function isStaffAttributedCartLine(
  item: Pick<CartItem, 'addedByTeam'> | null | undefined,
): boolean {
  return item?.addedByTeam === 'sales' || item?.addedByTeam === 'service';
}

export function cartAttributionForUser(
  user: Pick<User, 'uid' | 'displayName' | 'role' | 'staffDepartment' | 'dealerTeams'> | null | undefined,
  product: Pick<CatalogProduct, 'categoryId' | 'categoryName'> | null | undefined,
): CartAttribution | null {
  if (!user?.uid) return null;
  if (user.role === 'dealer' || dealerStaffTeam(user) === 'admin') {
    return {
      addedByUid: user.uid,
      addedByName: user.displayName?.trim() || (user.role === 'dealer' ? 'Dealer' : 'Admin'),
      addedByTeam: 'dealer',
    };
  }
  const teams = dealerPortalStaffTeams(user);
  if (!teams) return null;
  const spare = product ? isCatalogSparePartProduct(product) : false;
  const team: CartAddedByTeam = spare && teams.includes('service')
    ? 'service'
    : 'sales';
  return {
    addedByUid: user.uid,
    addedByName: user.displayName?.trim() || 'Staff',
    addedByTeam: team,
  };
}

export function applyCartAttribution(item: CartItem, attribution: CartAttribution | null): CartItem {
  if (!attribution) return item;
  return {
    ...item,
    addedByUid: attribution.addedByUid,
    addedByName: attribution.addedByName,
    addedByTeam: attribution.addedByTeam,
  };
}

export function dealerCartMetaRef(dealerUid: string) {
  return doc(db, DEALER_CARTS_COLLECTION, dealerUid);
}

export function dealerCartItemsCollection(dealerUid: string) {
  return collection(db, DEALER_CARTS_COLLECTION, dealerUid, 'items');
}

export function dealerCartApprovalsCollection(dealerUid: string) {
  return collection(db, DEALER_CARTS_COLLECTION, dealerUid, 'approvals');
}

export function parseStoredCartItem(raw: Partial<CartItem> & { productId?: string }): CartItem | null {
  const productId = String(raw.productId ?? '').trim();
  if (!productId) return null;

  const baseRateRaw = raw.baseRate != null ? Number(raw.baseRate) : Number(raw.rate);
  const baseRate = Number.isFinite(baseRateRaw) ? Math.round(baseRateRaw * 100) / 100 : 0;
  const gatcStampingPriceId = String(raw.gatcStampingPriceId ?? '').trim() || null;
  const feeRaw = Number(raw.gatcFeePerUnit ?? 0);
  const gatcFeePerUnit = gatcStampingPriceId && Number.isFinite(feeRaw)
    ? Math.round(feeRaw * 100) / 100
    : 0;
  const qc = resolveMachineQc(
    raw.categoryName != null ? String(raw.categoryName) : null,
    raw.qcEnabled === true,
  );
  const addedByTeam = raw.addedByTeam === 'sales' || raw.addedByTeam === 'service' || raw.addedByTeam === 'dealer'
    ? raw.addedByTeam
    : null;

  return {
    cartLineId: String(raw.cartLineId ?? '').trim() || newCartLineId(),
    productId,
    name: String(raw.name ?? 'Product'),
    sku: raw.sku != null ? String(raw.sku) : null,
    description: raw.description?.trim() || null,
    imageUrl: raw.imageUrl != null ? String(raw.imageUrl) : null,
    baseRate,
    listRate: raw.listRate != null && Number.isFinite(Number(raw.listRate))
      ? Math.round(Number(raw.listRate) * 100) / 100
      : null,
    priceLevelMode: raw.priceLevelMode === 'discount'
      || raw.priceLevelMode === 'increment'
      || raw.priceLevelMode === 'fixed'
      ? raw.priceLevelMode
      : (raw.priceLevelMode === 'none' ? 'none' : null),
    priceLevelSlabs: Array.isArray(raw.priceLevelSlabs)
      ? normalizePriceLevelSlabs(raw.priceLevelSlabs)
      : null,
    gatcFeePerUnit,
    gatcStampingPriceId,
    gatcStampingRange: gatcStampingPriceId
      ? (raw.gatcStampingRange?.trim() || null)
      : null,
    qcEnabled: qc.qcEnabled,
    qcFeePerUnit: qc.qcFeePerUnit,
    rate: combinedCartRate(baseRate, gatcFeePerUnit, qc.qcFeePerUnit),
    unit: String(raw.unit ?? 'pcs'),
    stockStatus: effectiveCatalogStockStatus(raw.stockStatus, raw.hsn),
    categoryName: raw.categoryName != null ? String(raw.categoryName) : null,
    categoryId: raw.categoryId != null ? String(raw.categoryId) : null,
    hsn: raw.hsn ?? null,
    quantity: Math.max(1, Math.floor(Number(raw.quantity) || 1)),
    addedByUid: raw.addedByUid?.trim() || null,
    addedByName: raw.addedByName?.trim() || null,
    addedByTeam,
  };
}

export function serializeCartItem(item: CartItem): Record<string, unknown> {
  return {
    cartLineId: item.cartLineId,
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    description: item.description,
    imageUrl: item.imageUrl,
    baseRate: item.baseRate,
    listRate: item.listRate ?? null,
    priceLevelMode: item.priceLevelMode ?? null,
    priceLevelSlabs: item.priceLevelSlabs ?? null,
    gatcFeePerUnit: item.gatcFeePerUnit,
    gatcStampingPriceId: item.gatcStampingPriceId ?? null,
    gatcStampingRange: item.gatcStampingRange ?? null,
    qcEnabled: item.qcEnabled === true,
    qcFeePerUnit: Number(item.qcFeePerUnit) || 0,
    rate: item.rate,
    unit: item.unit,
    stockStatus: item.stockStatus,
    categoryName: item.categoryName,
    categoryId: item.categoryId ?? null,
    hsn: item.hsn ?? null,
    quantity: item.quantity,
    addedByUid: item.addedByUid ?? null,
    addedByName: item.addedByName ?? null,
    addedByTeam: item.addedByTeam ?? null,
  };
}

export function subscribeDealerCartItems(
  dealerUid: string,
  onItems: (items: CartItem[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    dealerCartItemsCollection(dealerUid),
    snap => {
      const items = snap.docs
        .map(row => parseStoredCartItem({
          ...(row.data() as Partial<CartItem>),
          cartLineId: row.id,
        }))
        .filter((item): item is CartItem => Boolean(item));
      onItems(items);
    },
    err => onError?.(err instanceof Error ? err : new Error('Could not load dealer cart.')),
  );
}

export function subscribeDealerCartRemarks(
  dealerUid: string,
  onRemarks: (remarks: string) => void,
): Unsubscribe {
  return onSnapshot(dealerCartMetaRef(dealerUid), snap => {
    const remarks = String(snap.data()?.remarks ?? '').slice(0, 2000);
    onRemarks(remarks);
  });
}

export async function upsertDealerCartItem(dealerUid: string, item: CartItem): Promise<void> {
  const id = item.cartLineId?.trim() || newCartLineId();
  await setDoc(
    doc(dealerCartItemsCollection(dealerUid), id),
    serializeCartItem({ ...item, cartLineId: id }),
    { merge: true },
  );
}

export async function deleteDealerCartItem(dealerUid: string, cartLineId: string): Promise<void> {
  const id = cartLineId.trim();
  if (!id) return;
  await deleteDoc(doc(dealerCartItemsCollection(dealerUid), id));
}

export async function deleteDealerCartItems(dealerUid: string, cartLineIds: string[]): Promise<void> {
  const ids = [...new Set(cartLineIds.map(id => id.trim()).filter(Boolean))];
  if (!ids.length) return;
  const col = dealerCartItemsCollection(dealerUid);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) {
      batch.delete(doc(col, id));
    }
    await batch.commit();
  }
}

export async function writeDealerCartRemarks(dealerUid: string, remarks: string): Promise<void> {
  await setDoc(
    dealerCartMetaRef(dealerUid),
    { remarks: String(remarks ?? '').slice(0, 2000), updatedAtMs: Date.now() },
    { merge: true },
  );
}

export async function migrateLocalCartToDealerCart(
  dealerUid: string,
  items: CartItem[],
  remarks: string,
  attribution: CartAttribution | null,
): Promise<void> {
  if (!items.length && !remarks.trim()) return;
  const col = dealerCartItemsCollection(dealerUid);
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + 400)) {
      const next = applyCartAttribution(item, item.addedByUid ? null : attribution);
      const id = next.cartLineId?.trim() || newCartLineId();
      batch.set(doc(col, id), serializeCartItem({ ...next, cartLineId: id }));
    }
    await batch.commit();
  }
  if (remarks.trim()) {
    await writeDealerCartRemarks(dealerUid, remarks);
  }
}

export function sharedDealerCartUid(
  user: Pick<User, 'uid' | 'role' | 'dealerId'> | null | undefined,
): string | null {
  return resolveDealerAccountUid(user);
}
