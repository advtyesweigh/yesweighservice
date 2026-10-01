import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import type { SubmitDealerOrderLineInput } from '../types/dealer-orders';
import {
  shippingSelectionPayload,
  type ShippingSelection,
} from './shippingAddresses';

const functions = getFunctions(app, 'asia-south1');

export function dealerOrderErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const message = 'message' in err ? String((err as { message: string }).message) : '';
    const cleaned = message.replace(/^Firebase:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '');
    if (/not authorized to perform this operation/i.test(cleaned)) {
      if (/Zoho Inventory refused|Zoho rejected/i.test(cleaned)) return cleaned;
      return (
        'Zoho Inventory refused this sales order. '
        + 'YesOne retried with each item’s own Zoho warehouse and without a warehouse on items Zoho does not stock. '
        + 'Confirm the customer is active, the product is active and available for sale, '
        + 'and the connected Zoho user can create sales orders. '
        + (cleaned ? `Zoho: ${cleaned}` : '')
      );
    }
    if (cleaned) return cleaned;
  }
  return 'Something went wrong with this order.';
}

async function call<TReq, TRes>(name: string, data?: TReq, timeout = 60_000): Promise<TRes> {
  const callable = httpsCallable<TReq | undefined, TRes>(functions, name, { timeout });
  const result = await callable(data);
  return result.data;
}

export interface SegmentSalesOrderResult {
  segment: 'product' | 'spare' | 'software';
  segmentLabel: string;
  inventorySite?: 'cochin' | 'head_office' | null;
  branchLabel?: string | null;
  bucketLabel?: string | null;
  orderNumber: string;
  zohoSalesOrderId: string;
  zohoSalesOrderNumber: string | null;
  status: string;
  subtotal: number;
  itemCount: number;
  salespersonId: string | null;
  salespersonName: string | null;
  yesOneStage?: string;
}

export interface SubmitDealerOrderResult {
  zohoSalesOrderId: string | null;
  zohoSalesOrderNumber: string | null;
  orderNumber: string;
  status: string;
  subtotal: number;
  itemCount: number;
  dealerId: string | null;
  zohoCustomerId: string;
  dealerName: string | null;
  createdByUid: string;
  createdByName: string;
  salesOrders?: SegmentSalesOrderResult[];
}

/** Place cart as a Zoho Inventory Draft sales order. */
export async function submitDealerOrder(
  lines: SubmitDealerOrderLineInput[],
  shipping: ShippingSelection,
  remarks = '',
  courierBySite?: Partial<Record<'cochin' | 'head_office', string>>,
  freightZone?: string,
  freightZoneOverrideReason?: string,
  /** Live Delhivery (or other client-quoted) freight when rate card is ₹0. */
  manualFreightAmountInr?: number,
  /** Delhivery freight billing: btc (default) or fod (₹0 on order). */
  freightBillingMode?: 'fod' | 'btc',
): Promise<SubmitDealerOrderResult> {
  try {
    return await call(
      'submitDealerOrder',
      {
        lines,
        shipping: shippingSelectionPayload(shipping),
        remarks: remarks.trim() || undefined,
        courierBySite: courierBySite || undefined,
        ...(freightZone ? { freightZone } : {}),
        ...(freightZoneOverrideReason?.trim()
          ? { freightZoneOverrideReason: freightZoneOverrideReason.trim() }
          : {}),
        ...(manualFreightAmountInr != null
          && Number.isFinite(manualFreightAmountInr)
          && manualFreightAmountInr >= 0
          ? { manualFreightAmountInr: Math.round(manualFreightAmountInr * 100) / 100 }
          : {}),
        ...(freightBillingMode === 'fod' || freightBillingMode === 'btc'
          ? { freightBillingMode }
          : {}),
      },
      180_000,
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function confirmZohoSalesOrder(salesOrderId: string): Promise<{
  salesOrderId: string;
  status: string;
  salesOrderNumber: string | null;
}> {
  try {
    return await call('confirmZohoSalesOrder', { salesOrderId }, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function voidZohoSalesOrder(
  salesOrderId: string,
  reason = '',
): Promise<{
  salesOrderId: string;
  status: string;
  salesOrderNumber: string | null;
}> {
  try {
    return await call('voidZohoSalesOrder', { salesOrderId, reason }, 120_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

/** Super admin: delete all legacy portal dealerOrders documents. */
export async function purgeDealerOrders(): Promise<{ deleted: number; collection: string }> {
  try {
    return await call('purgeDealerOrders', undefined, 540_000);
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}
