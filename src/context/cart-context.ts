import { createContext } from 'react';
import type { CatalogProduct } from '../types/catalog';
import type { AddCartItemOptions, CartItem } from '../types/cart';

export type UpdateCartStampingInput = {
  withStamping: boolean;
  gatcStampingPriceId?: string | null;
  gatcFeePerUnit?: number;
  gatcStampingRange?: string | null;
};

export type UpdateCartQcInput = {
  qcEnabled: boolean;
};

export interface CartContextType {
  items: CartItem[];
  itemCount: number;
  subtotal: number;
  /** False until localStorage or the shared dealer cart has loaded. */
  cartReady: boolean;
  /** Order-level remarks → Zoho sales order notes. */
  remarks: string;
  addItem: (product: CatalogProduct, options?: number | AddCartItemOptions) => boolean;
  removeItem: (cartLineId: string) => void;
  setQuantity: (cartLineId: string, quantity: number) => void;
  updateStamping: (cartLineId: string, input: UpdateCartStampingInput) => void;
  updateQc: (cartLineId: string, input: UpdateCartQcInput) => void;
  setRemarks: (remarks: string) => void;
  clearCart: () => void;
  isInCart: (productId: string) => boolean;
  getQuantity: (productId: string) => number;
}

export const CartContext = createContext<CartContextType | undefined>(undefined);
