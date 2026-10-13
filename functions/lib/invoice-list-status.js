/**
 * List badge / chip status — keep in sync with src/lib/invoiceListStatus.ts
 */

const LOGISTICS_FREIGHT_CATEGORIES = new Set(['product', 'spare']);
const FILTER_STATUS_KEYS = new Set([
  'to_dispatch',
  'in_transit',
  'delivered',
  'returned',
  'void',
]);

function categoriesFromDoc(doc) {
  const raw = Array.isArray(doc?.categories) ? doc.categories : [];
  const keys = raw.map(value => String(value ?? '').toLowerCase()).filter(Boolean);
  if (keys.length) return keys;
  const legacy = String(doc?.invoiceCategory ?? '').toLowerCase();
  return legacy ? [legacy] : [];
}

function hasMarkedAt(nested, scalar) {
  const fromNested = String(nested?.markedAt ?? '').trim();
  if (fromNested && fromNested !== '[object Object]') return true;
  const fromScalar = String(scalar ?? '').trim();
  return Boolean(fromScalar && fromScalar !== '[object Object]');
}

function allowsLogistics(doc) {
  const categories = categoriesFromDoc(doc);
  if (!categories.length) return true;
  if (categories.every(category => category === 'gatc')) return false;
  return categories.some(category => LOGISTICS_FREIGHT_CATEGORIES.has(category));
}

function logisticsListStatus(logistics) {
  if (!logistics || typeof logistics !== 'object') return null;
  const status = String(logistics.status ?? '').trim().toLowerCase();
  if (!status || status === 'cancelled') return null;
  const hasAwb = Boolean(
    String(logistics.consignmentNo ?? '').trim()
    || String(logistics.trackingNo ?? '').trim(),
  );
  const step = String(logistics.wizardStep ?? '').trim();
  const incomplete = !hasAwb && Boolean(step) && step !== 'final_photo';
  if (!hasAwb && incomplete) return null;
  if (status === 'label_generated') return hasAwb ? 'in_transit' : null;
  if (status === 'in_transit' || status === 'delivered' || status === 'returned') return status;
  return status;
}

export function invoiceListStatusFromDoc(doc) {
  const zoho = String(doc?.status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (zoho === 'void') return 'void';
  if (hasMarkedAt(doc?.customerPickup, doc?.customerPickupMarkedAt)) return 'customer_pickup';
  if (hasMarkedAt(doc?.manualDelivery, doc?.manualDeliveredAt)) return 'delivered';
  const logistics = logisticsListStatus(doc?.logistics);
  if (logistics) {
    if (logistics === 'cancelled') return 'to_dispatch';
    return logistics;
  }
  if (allowsLogistics(doc)) return 'to_dispatch';
  return zoho || 'sent';
}

/** Chip key: pickup counts as Delivered; software/service Zoho statuses are omitted. */
export function invoiceListFilterStatusFromDoc(docOrStatus) {
  const key = typeof docOrStatus === 'string'
    ? docOrStatus
    : invoiceListStatusFromDoc(docOrStatus);
  if (key === 'customer_pickup') return 'delivered';
  if (key === 'void') return 'void';
  if (FILTER_STATUS_KEYS.has(key)) return key;
  return null;
}

export function listStatusQueryValues(filterStatus) {
  const key = String(filterStatus ?? '').trim();
  if (!key || key === 'all' || key === 'support') return null;
  if (key === 'delivered') return ['delivered', 'customer_pickup'];
  return [key];
}
