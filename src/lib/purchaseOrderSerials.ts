import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { YESGATC_OV_MACHINE_HSN } from './yesgatcRecords';
import { isSacHsn } from './sacCatalog';
import { previewSerialRange } from './serialNumberAllotment';

const MACHINE_HSN = new Set<string>(YESGATC_OV_MACHINE_HSN);

export type PurchaseOrderLineSerialRange = {
  startNumber: string;
  endNumber: string;
  qty: number;
  itemId: string | null;
  sku: string | null;
  productName: string | null;
  imageUrl: string | null;
};

export type PurchaseOrderSerialRangeInput = {
  lineId?: string | null;
  productId?: string | null;
  itemId?: string | null;
  sku?: string | null;
  productName?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  startNumber?: string | null;
  endNumber?: string | null;
};

export type PurchaseOrderSerialRangesByLineId = Record<string, PurchaseOrderLineSerialRange>;

export function parsePurchaseOrderSerialRanges(raw: unknown): PurchaseOrderSerialRangesByLineId {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PurchaseOrderSerialRangesByLineId = {};
  for (const [lineId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(lineId ?? '').trim();
    if (!id || !value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const startNumber = String(row.startNumber ?? row.from ?? '').trim();
    const endNumber = String(row.endNumber ?? row.to ?? '').trim();
    if (!startNumber && !endNumber) continue;
    const preview = startNumber && endNumber
      ? previewSerialRange({ from: startNumber, to: endNumber, missingText: '' })
      : null;
    out[id] = {
      startNumber: preview && !preview.error ? preview.from : startNumber,
      endNumber: preview && !preview.error ? preview.to : endNumber,
      qty: preview && !preview.error ? preview.count : Math.max(0, Number(row.qty) || 0),
      itemId: row.itemId != null && String(row.itemId).trim() ? String(row.itemId) : null,
      sku: row.sku != null && String(row.sku).trim() ? String(row.sku) : null,
      productName: row.productName != null && String(row.productName).trim()
        ? String(row.productName)
        : (row.name != null && String(row.name).trim() ? String(row.name) : null),
      imageUrl: row.imageUrl != null && String(row.imageUrl).trim() ? String(row.imageUrl) : null,
    };
  }
  return out;
}

function isLabelIndicatorLine(line: { name?: string | null; sku?: string | null }): boolean {
  const sku = String(line.sku ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (sku === 'LBLIND' || sku.startsWith('LBLIND')) return true;
  return String(line.name ?? '').toLowerCase().includes('label indicator');
}

export function poLineShowsSerialRange(line: {
  hsn?: string | null;
  name?: string | null;
  sku?: string | null;
}): boolean {
  if (isLabelIndicatorLine(line)) return true;
  const hsn = String(line.hsn ?? '').replace(/\D/g, '');
  if (isSacHsn(line.hsn)) return false;
  if (!hsn) return true;
  return MACHINE_HSN.has(hsn);
}

export function serialRangesFingerprint(ranges: PurchaseOrderSerialRangesByLineId): string {
  const keys = Object.keys(ranges).sort();
  return JSON.stringify(keys.map(key => ({
    lineId: key,
    start: ranges[key]?.startNumber ?? '',
    end: ranges[key]?.endNumber ?? '',
  })));
}

export function serialRangeInputsFromLines(
  lines: Array<{
    lineId: string;
    productId: string;
    name: string;
    sku: string | null;
    imageUrl: string | null;
    startNumber?: string;
    endNumber?: string;
  }>,
): PurchaseOrderSerialRangeInput[] {
  return lines
    .map(line => ({
      lineId: line.lineId,
      productId: line.productId,
      itemId: line.productId,
      sku: line.sku,
      productName: line.name,
      imageUrl: line.imageUrl,
      startNumber: String(line.startNumber ?? '').trim(),
      endNumber: String(line.endNumber ?? '').trim(),
    }))
    .filter(line => line.startNumber || line.endNumber);
}

/** Map entered ranges onto current PO lines (Zoho line ids change after a PUT). */
export function bindSerialRangesToLines(
  lineItems: Array<{ id: string; itemId?: string | null; name?: string; sku?: string | null; imageUrl?: string | null }>,
  inputs: PurchaseOrderSerialRangeInput[],
): PurchaseOrderSerialRangesByLineId {
  const unused = [...inputs];
  const out: PurchaseOrderSerialRangesByLineId = {};

  for (const line of lineItems) {
    const lineId = String(line.id ?? '').trim();
    if (!lineId) continue;
    const itemId = String(line.itemId ?? '').trim();
    const index = unused.findIndex(row => {
      const rowLineId = String(row.lineId ?? '').trim();
      const rowItemId = String(row.itemId ?? row.productId ?? '').trim();
      if (rowLineId && rowLineId === lineId) return true;
      return Boolean(itemId && rowItemId === itemId);
    });
    if (index < 0) continue;
    const [row] = unused.splice(index, 1);
    const startNumber = String(row.startNumber ?? '').trim();
    const endNumber = String(row.endNumber ?? '').trim();
    if (!startNumber && !endNumber) continue;
    const preview = previewSerialRange({ from: startNumber, to: endNumber, missingText: '' });
    if (preview.error) {
      throw new Error(preview.error);
    }
    out[lineId] = {
      startNumber: preview.from,
      endNumber: preview.to,
      qty: preview.count,
      itemId: itemId || null,
      sku: row.sku || line.sku || null,
      productName: row.productName || row.name || line.name || null,
      imageUrl: row.imageUrl || line.imageUrl || null,
    };
  }
  return out;
}

export async function fetchPurchaseOrderSerialRangesByNumber(
  poNumber: string,
): Promise<{ poId: string; ranges: PurchaseOrderSerialRangesByLineId }> {
  const number = String(poNumber ?? '').trim();
  if (!number) return { poId: '', ranges: {} };
  const snap = await getDocs(
    query(collection(db, 'purchaseOrders'), where('purchaseOrderNumber', '==', number), limit(1)),
  );
  if (snap.empty) return { poId: '', ranges: {} };
  const docSnap = snap.docs[0];
  return {
    poId: docSnap.id,
    ranges: parsePurchaseOrderSerialRanges(docSnap.data()?.serialRangesByLineId),
  };
}
