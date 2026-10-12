/**
 * GATC stamping fee helpers for dealer/staff sales-order line building.
 * Fee is rolled into the product unit rate (no separate Zoho line).
 */
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

const PRODUCT_SETTINGS_DOC = 'appSettings/productSettings';

export function normalizeGatcIdList(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))];
}

export function normalizeGatcStampingPrices(values) {
  if (!Array.isArray(values)) return [];
  const entries = [];
  const usedIds = new Set();
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') continue;
    const stampingRange = String(raw.stampingRange ?? raw.range ?? '').trim();
    if (!stampingRange) continue;
    const priceRaw = raw.price;
    const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw);
    if (!Number.isFinite(price) || price < 0) continue;
    let id = String(raw.id ?? '').trim();
    if (!id || usedIds.has(id)) {
      id = `gatc-${entries.length}-${Date.now()}`;
    }
    usedIds.add(id);
    entries.push({
      id,
      stampingRange,
      price: Math.round(price * 100) / 100,
    });
  }
  return entries;
}

export async function loadGatcStampingPriceMap() {
  const snap = await getFirestore().doc(PRODUCT_SETTINGS_DOC).get();
  const entries = normalizeGatcStampingPrices(snap.exists ? snap.data()?.gatcStampingPrices : []);
  return new Map(entries.map(entry => [entry.id, entry]));
}

/**
 * Resolve GATC fee for a product line.
 * @returns {{ gatcStampingPriceId: string|null, gatcFeePerUnit: number, gatcStampingRange: string|null }}
 */
export function resolveGatcFeeForProduct(product, gatcStampingPriceId, gatcMap) {
  const requested = String(gatcStampingPriceId ?? '').trim() || null;
  if (!requested) {
    return { gatcStampingPriceId: null, gatcFeePerUnit: 0, gatcStampingRange: null };
  }
  const linked = new Set(normalizeGatcIdList(product?.gatcStampingPriceIds));
  if (!linked.has(requested)) {
    throw new HttpsError(
      'invalid-argument',
      `Stamping option is not linked to ${product?.name || 'this product'}.`,
    );
  }
  const entry = gatcMap.get(requested);
  if (!entry) {
    throw new HttpsError('invalid-argument', 'Selected stamping option is no longer available.');
  }
  return {
    gatcStampingPriceId: entry.id,
    gatcFeePerUnit: entry.price,
    gatcStampingRange: entry.stampingRange,
  };
}

export function mergeKeyForLine(productId, gatcStampingPriceId, baseRate, qcEnabled = false) {
  const gatc = String(gatcStampingPriceId ?? '').trim() || '-';
  const base = Math.round(Number(baseRate) * 100);
  const qc = qcEnabled ? 'qc' : '-';
  return `${productId}::${gatc}::${qc}::${base}`;
}
