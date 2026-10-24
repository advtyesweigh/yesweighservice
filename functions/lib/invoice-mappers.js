import { freightSkuFromInvoiceLines } from './freight-lines.js';
import { lineWithMachineQcFields } from './machine-qc.js';
import { Timestamp } from 'firebase-admin/firestore';

function serializeInvoiceDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (value instanceof Timestamp) return value.toDate().toISOString().slice(0, 10);
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }
  const seconds = Number(value.seconds ?? value._seconds);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString().slice(0, 10);
  return String(value);
}

function formatAddressObject(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const parts = [
    addr.attention,
    addr.address,
    addr.street2,
    addr.city,
    addr.state,
    addr.zip,
    addr.country,
  ].filter(Boolean);
  if (!parts.length) return null;
  return parts.join(', ').replace(/\n/g, ', ');
}

function extractZohoWarehouseFromInvoice(raw) {
  if (!raw || typeof raw !== 'object') {
    return { zohoWarehouseId: null, zohoWarehouseName: null };
  }
  const topId = raw.warehouse_id ?? raw.warehouseId ?? null;
  const topName = raw.warehouse_name ?? raw.warehouseName ?? null;
  if (topId != null && String(topId).trim()) {
    return {
      zohoWarehouseId: String(topId).trim(),
      zohoWarehouseName: topName ? String(topName).trim() : null,
    };
  }
  const lines = raw.line_items ?? raw.lineItems ?? [];
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const lineId = line?.warehouse_id ?? line?.warehouseId ?? null;
      if (lineId != null && String(lineId).trim()) {
        return {
          zohoWarehouseId: String(lineId).trim(),
          zohoWarehouseName: line?.warehouse_name ?? line?.warehouseName
            ? String(line.warehouse_name ?? line.warehouseName).trim()
            : null,
        };
      }
    }
  }
  if (topName) {
    return { zohoWarehouseId: null, zohoWarehouseName: String(topName).trim() };
  }
  return { zohoWarehouseId: null, zohoWarehouseName: null };
}

function mapInvoiceShippingFields(raw) {
  const shippingAddress = formatAddressObject(raw?.shipping_address)
    ?? (raw?.shippingAddress ? String(raw.shippingAddress).trim() || null : null);
  const billingAddress = formatAddressObject(raw?.billing_address)
    ?? (raw?.billingAddress ? String(raw.billingAddress).trim() || null : null);
  const shippingAddressId = raw?.shipping_address_id != null
    ? String(raw.shipping_address_id).trim() || null
    : (raw?.shipping_address?.address_id != null
      ? String(raw.shipping_address.address_id).trim() || null
      : (raw?.shippingAddressId != null
        ? String(raw.shippingAddressId).trim() || null
        : null));
  return { shippingAddress, shippingAddressId, billingAddress };
}

export function mapInvoice(raw) {
  const shipping = mapInvoiceShippingFields(raw);
  const warehouse = extractZohoWarehouseFromInvoice(raw);
  return {
    id: String(raw.invoice_id ?? raw.id ?? ''),
    invoiceNumber: String(raw.invoice_number ?? raw.invoiceNumber ?? ''),
    date: raw.date ?? null,
    createdTime: raw.created_time ?? raw.createdTime ?? null,
    dueDate: raw.due_date ?? raw.dueDate ?? null,
    status: String(raw.status ?? 'draft'),
    total: Number(raw.total ?? 0),
    balance: Number(raw.balance ?? 0),
    referenceNumber: raw.reference_number ?? raw.referenceNumber
      ? String(raw.reference_number ?? raw.referenceNumber)
      : null,
    lastPaymentDate: raw.last_payment_date ?? raw.lastPaymentDate ?? null,
    currencyCode: raw.currency_code ?? raw.currencyCode
      ? String(raw.currency_code ?? raw.currencyCode)
      : 'INR',
    customerName: raw.customer_name ?? raw.customerName
      ? String(raw.customer_name ?? raw.customerName)
      : null,
    salespersonId: raw.salesperson_id != null && String(raw.salesperson_id).trim()
      ? String(raw.salesperson_id).trim()
      : (raw.salespersonId != null && String(raw.salespersonId).trim()
        ? String(raw.salespersonId).trim()
        : null),
    salespersonName: raw.salesperson_name ?? raw.salespersonName
      ? String(raw.salesperson_name ?? raw.salespersonName).trim() || null
      : null,
    invoiceUrl: raw.invoice_url ?? raw.invoiceUrl
      ? String(raw.invoice_url ?? raw.invoiceUrl)
      : null,
    shippingAddress: shipping.shippingAddress,
    shippingAddressId: shipping.shippingAddressId,
    billingAddress: shipping.billingAddress,
    zohoWarehouseId: warehouse.zohoWarehouseId,
    zohoWarehouseName: warehouse.zohoWarehouseName,
  };
}

const JUNK_SERIAL_KEYS = new Set(['NUMBERS', 'NUMBER', 'SERIAL', 'SERIALS', 'MAC', 'SN', 'S']);

export function isPlausibleInvoiceSerial(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const key = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key || key.length < 3 || JUNK_SERIAL_KEYS.has(key)) return false;
  return true;
}

/** YesOne writes `Serial Numbers: A, B` on Zoho line descriptions. */
export function serialsFromLineDescription(description) {
  const text = String(description ?? '');
  if (!text.trim()) return [];
  const serials = [];
  const block = /\bserial\s*numbers?\s*:\s*([^\n]+)/i.exec(text);
  if (block?.[1]) {
    for (const part of block[1].split(/[,;]+/)) {
      const token = part.trim();
      if (isPlausibleInvoiceSerial(token)) serials.push(token);
    }
  }
  const pattern = /\b(?:s\/n|sn|mac(?:\s*id)?)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9._/-]{2,})/gi;
  let match = pattern.exec(text);
  while (match) {
    if (isPlausibleInvoiceSerial(match[1])) serials.push(match[1].trim());
    match = pattern.exec(text);
  }
  return [...new Set(serials)];
}

export function extractLineItemSerialNumbers(raw) {
  if (!raw || typeof raw !== 'object') return [];

  const serials = [];

  for (const candidate of [
    raw.serialNumbers,
    raw.serial_numbers,
    raw.item_serial_numbers,
    raw.itemSerialNumbers,
  ]) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === 'string' && isPlausibleInvoiceSerial(entry)) {
        serials.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const value = entry.serial_number
        ?? entry.serialnumber
        ?? entry.serial_number_value
        ?? entry.serialNumber;
      if (isPlausibleInvoiceSerial(value)) serials.push(String(value).trim());
    }
  }

  for (const field of raw.item_custom_fields ?? raw.custom_fields ?? []) {
    const label = String(field.label ?? field.api_name ?? field.customfield_id ?? '').toLowerCase();
    if (!label.includes('serial') && !label.includes('mac')) continue;
    const value = field.value ?? field.value_formatted;
    if (isPlausibleInvoiceSerial(value)) serials.push(String(value).trim());
  }

  serials.push(...serialsFromLineDescription(raw.description));

  return [...new Set(serials.filter(Boolean))];
}

export function mapInvoiceLineItem(raw, imageUrl = null) {
  const hsnRaw = raw.hsn_or_sac ?? raw.hsnOrSac ?? raw.hsn ?? null;
  return lineWithMachineQcFields({
    id: String(raw.line_item_id ?? raw.item_id ?? raw.id ?? ''),
    itemId: raw.item_id ?? raw.itemId ? String(raw.item_id ?? raw.itemId) : null,
    name: String(raw.name ?? raw.item_name ?? 'Item'),
    description: raw.description ? String(raw.description) : null,
    sku: raw.sku ? String(raw.sku) : null,
    quantity: Number(raw.quantity ?? 0),
    rate: Number(raw.rate ?? 0),
    total: Number(raw.item_total ?? raw.total ?? 0),
    imageUrl,
    hsn: hsnRaw != null && String(hsnRaw).trim() ? String(hsnRaw) : null,
    serialNumbers: extractLineItemSerialNumbers(raw),
  });
}

export function buildInvoiceSearchBlob(invoiceRaw) {
  const parts = [
    invoiceRaw.invoice_number,
    invoiceRaw.reference_number,
    invoiceRaw.customer_name,
    invoiceRaw.notes,
  ];
  for (const item of invoiceRaw.line_items ?? invoiceRaw.lineItems ?? []) {
    parts.push(item.name, item.item_name, item.description, item.sku);
    parts.push(...extractLineItemSerialNumbers(item));
  }
  return parts
    .filter(Boolean)
    .map(value => String(value))
    .join(' ')
    .toLowerCase();
}

const INVOICE_CATEGORIES = new Set(['product', 'spare', 'service', 'software_key', 'gatc']);

function normalizeCategories(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const key = String(item ?? '').trim().toLowerCase();
    if (INVOICE_CATEGORIES.has(key)) seen.add(key);
  }
  return ['product', 'spare', 'service', 'software_key', 'gatc'].filter(key => seen.has(key));
}

function normalizeCategoryAmounts(value) {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  for (const key of ['product', 'spare', 'service', 'software_key', 'gatc']) {
    const amount = Number(value[key] ?? 0);
    if (Number.isFinite(amount) && amount !== 0) next[key] = amount;
  }
  return next;
}

export function filterInvoices(invoices, { status, category } = {}) {
  let next = invoices;
  if (status && status !== 'all') {
    const normalized = String(status).toLowerCase();
    next = next.filter(inv => String(inv.status).toLowerCase() === normalized);
  }
  if (category && category !== 'all') {
    const normalized = String(category).toLowerCase();
    if (INVOICE_CATEGORIES.has(normalized)) {
      next = next.filter(inv => {
        const categories = normalizeCategories(inv.categories);
        if (categories.length) return categories.includes(normalized);
        return String(inv.invoiceCategory ?? '').toLowerCase() === normalized;
      });
    }
  }
  return next;
}

/** Counts after status/search filters, before the category tab filter. */
export function countInvoicesByCategory(invoices) {
  const counts = {
    all: invoices.length,
    product: 0,
    spare: 0,
    software_key: 0,
    service: 0,
    gatc: 0,
  };
  for (const inv of invoices) {
    const categories = normalizeCategories(inv.categories);
    if (categories.length) {
      for (const key of categories) counts[key] += 1;
      continue;
    }
    const legacy = String(inv.invoiceCategory ?? '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, legacy) && legacy !== 'all') {
      counts[legacy] += 1;
    }
  }
  return counts;
}

function invoiceNumberSortKey(value) {
  const text = String(value ?? '').trim();
  const match = /\/(\d+)\s*$/.exec(text) || /^(\d+)\s*$/.exec(text);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}

function compareInvoiceNumber(a, b, dir) {
  const aKey = invoiceNumberSortKey(a.invoiceNumber || a.id);
  const bKey = invoiceNumberSortKey(b.invoiceNumber || b.id);
  if (aKey !== bKey) return (aKey - bKey) * dir;
  return String(a.invoiceNumber ?? a.id ?? '').localeCompare(
    String(b.invoiceNumber ?? b.id ?? ''),
  ) * dir;
}

export function sortInvoices(invoices, sortField = 'date', sortDir = 'desc') {
  const dir = sortDir === 'asc' ? 1 : -1;
  const key = sortField || 'date';

  return [...invoices].sort((a, b) => {
    if (key === 'total' || key === 'balance') {
      return (Number(a[key] ?? 0) - Number(b[key] ?? 0)) * dir;
    }
    if (key === 'date' || key === 'dueDate') {
      const av = key === 'date' ? invoiceDateTimeMs(a) : (a[key] ? Date.parse(a[key]) : 0);
      const bv = key === 'date' ? invoiceDateTimeMs(b) : (b[key] ? Date.parse(b[key]) : 0);
      const diff = (av - bv) * dir;
      if (diff !== 0) return diff;
      return compareInvoiceNumber(a, b, dir);
    }
    if (key === 'syncedAt') {
      const av = a.syncedAt ? Date.parse(a.syncedAt) : 0;
      const bv = b.syncedAt ? Date.parse(b.syncedAt) : 0;
      const diff = (av - bv) * dir;
      if (diff !== 0) return diff;
      return compareInvoiceNumber(a, b, dir);
    }
    const av = a[key === 'invoiceNumber' ? 'invoiceNumber' : key] ?? '';
    const bv = b[key === 'invoiceNumber' ? 'invoiceNumber' : key] ?? '';
    return String(av).localeCompare(String(bv)) * dir;
  });
}

export function paginateInvoices(invoices, page = 1, limit = 25) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const skip = (safePage - 1) * safeLimit;
  return {
    data: invoices.slice(skip, skip + safeLimit),
    pagination: {
      total: invoices.length,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(invoices.length / safeLimit) || 1,
    },
  };
}

function invoiceTimestamp(inv) {
  const raw = inv.date ? String(inv.date).trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }
  const d = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(d) ? 0 : d;
}

function invoiceDateTimeMs(inv) {
  const created = inv.createdTime != null ? String(inv.createdTime).trim() : '';
  if (created && !/^\d{4}-\d{2}-\d{2}$/.test(created)) {
    const parsed = Date.parse(created);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return invoiceTimestamp(inv);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Pre-tax invoice amount (excludes GST). Prefers Zoho sub_total when present. */
export function invoiceAmountExclGst(inv) {
  if (inv?.subtotal != null && inv.subtotal !== '') {
    const subtotal = Number(inv.subtotal);
    if (Number.isFinite(subtotal)) return subtotal;
  }
  const total = Number(inv?.total ?? 0);
  if (inv?.taxTotal != null && inv.taxTotal !== '') {
    const taxTotal = Number(inv.taxTotal);
    if (Number.isFinite(taxTotal)) return Math.max(0, total - taxTotal);
  }
  return total;
}

export function buildSalesEntries(invoices) {
  return invoices
    .filter(inv => inv.date)
    .map(inv => ({
      date: inv.date,
      total: invoiceAmountExclGst(inv),
    }));
}

export function computeDailySales(invoices, dayCount = 30) {
  const now = new Date();
  const dailySales = [];

  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - i);
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);

    let dayTotal = 0;
    for (const inv of invoices) {
      const ts = invoiceTimestamp(inv);
      if (ts >= dayStart.getTime() && ts <= dayEnd.getTime()) {
        dayTotal += invoiceAmountExclGst(inv);
      }
    }

    dailySales.push({
      label: day.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      total: dayTotal,
    });
  }

  return dailySales;
}

export function computeSalesForPeriod(invoices, periodDays = 30) {
  const now = new Date();
  const periodEnd = endOfDay(now);

  if (periodDays === null || periodDays === 'lifetime') {
    let totalSales = 0;
    for (const inv of invoices) {
      totalSales += invoiceAmountExclGst(inv);
    }
    return {
      periodStart: null,
      periodEnd: periodEnd.toISOString(),
      totalSales,
      previousSales: 0,
      salesTrendPct: null,
    };
  }

  const days = Number(periodDays) || 30;
  const periodStart = startOfDay(now);
  periodStart.setDate(periodStart.getDate() - (days - 1));

  const prevPeriodEnd = new Date(periodStart);
  prevPeriodEnd.setDate(prevPeriodEnd.getDate() - 1);
  prevPeriodEnd.setHours(23, 59, 59, 999);
  const prevPeriodStart = startOfDay(prevPeriodEnd);
  prevPeriodStart.setDate(prevPeriodStart.getDate() - (days - 1));

  let totalSales = 0;
  let previousSales = 0;

  for (const inv of invoices) {
    const ts = invoiceTimestamp(inv);
    const amount = invoiceAmountExclGst(inv);
    if (ts >= periodStart.getTime() && ts <= periodEnd.getTime()) {
      totalSales += amount;
    } else if (ts >= prevPeriodStart.getTime() && ts <= prevPeriodEnd.getTime()) {
      previousSales += amount;
    }
  }

  let salesTrendPct = null;
  if (previousSales > 0) {
    salesTrendPct = ((totalSales - previousSales) / previousSales) * 100;
  } else if (totalSales > 0) {
    salesTrendPct = 100;
  }

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalSales,
    previousSales,
    salesTrendPct,
  };
}

export function computeInvoiceDashboardSummary(invoices) {
  const salesPeriod = computeSalesForPeriod(invoices, 30);
  const dailySales = computeDailySales(invoices, 30);

  let outstandingBalance = 0;
  let unpaidCount = 0;
  let overdueCount = 0;
  let paidCount = 0;

  for (const inv of invoices) {
    const status = String(inv.status ?? '').toLowerCase();

    outstandingBalance += Number(inv.balance ?? 0);
    if (status === 'paid') paidCount += 1;
    if (status === 'unpaid' || status === 'partially_paid') unpaidCount += 1;
    if (status === 'overdue') overdueCount += 1;
  }

  const recentInvoices = sortInvoices(invoices, 'date', 'desc').slice(0, 5);

  return {
    periodStart: salesPeriod.periodStart,
    periodEnd: salesPeriod.periodEnd,
    totalSales: salesPeriod.totalSales,
    previousSales: salesPeriod.previousSales,
    salesTrendPct: salesPeriod.salesTrendPct,
    outstandingBalance,
    unpaidCount,
    overdueCount,
    paidCount,
    totalInvoiceCount: invoices.length,
    dailySales,
    salesEntries: buildSalesEntries(invoices),
    recentInvoices,
  };
}

function normalizeSearchNeedle(value) {
  return String(value ?? '').trim().toLowerCase();
}

function invoiceHeaderMatches(invoice, needle) {
  if (!needle) return true;
  const fields = [
    invoice.invoiceNumber,
    invoice.referenceNumber,
    invoice.customerName,
    invoice.id,
  ];
  return fields.some(field => field && String(field).toLowerCase().includes(needle));
}

export function filterInvoicesBySearch(invoices, searchText, searchBlobById = new Map()) {
  const needle = normalizeSearchNeedle(searchText);
  if (!needle) return invoices;

  return invoices.filter(invoice => {
    if (invoiceHeaderMatches(invoice, needle)) return true;
    const blob = searchBlobById.get(invoice.id) ?? invoice.searchBlob ?? '';
    return String(blob).includes(needle);
  });
}

export function firestoreDocToListInvoice(data) {
  const invoiceCategory = data.invoiceCategory
    && ['product', 'spare', 'service', 'software_key', 'gatc'].includes(String(data.invoiceCategory))
    ? String(data.invoiceCategory)
    : null;
  return {
    id: String(data.id ?? ''),
    invoiceNumber: String(data.invoiceNumber ?? ''),
    date: serializeInvoiceDate(data.date),
    createdTime: data.createdTime ?? data.zohoLastModified ?? null,
    dueDate: data.dueDate ?? null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    subtotal: data.subtotal != null && data.subtotal !== '' ? Number(data.subtotal) : null,
    taxTotal: data.taxTotal != null && data.taxTotal !== '' ? Number(data.taxTotal) : null,
    balance: Number(data.balance ?? 0),
    referenceNumber: data.referenceNumber ?? null,
    lastPaymentDate: data.lastPaymentDate ?? null,
    currencyCode: data.currencyCode ? String(data.currencyCode) : 'INR',
    customerName: data.customerName ?? null,
    salespersonId: data.salespersonId ? String(data.salespersonId) : null,
    salespersonName: data.salespersonName ? String(data.salespersonName) : null,
    invoiceUrl: data.invoiceUrl ?? null,
    invoiceCategory,
    categories: normalizeCategories(data.categories),
    categoryAmounts: normalizeCategoryAmounts(data.categoryAmounts),
    freightSku: data.yesOneFreightPartner?.sku
      ? String(data.yesOneFreightPartner.sku).trim().toUpperCase() || null
      : data.freightSku
        ? String(data.freightSku).trim().toUpperCase() || null
        : freightSkuFromInvoiceLines(data.lineItems),
    customerPickup: data.customerPickup && typeof data.customerPickup === 'object'
      ? data.customerPickup
      : null,
    customerPickupMarkedAt: data.customerPickupMarkedAt
      ? String(data.customerPickupMarkedAt)
      : null,
    manualDelivery: data.manualDelivery && typeof data.manualDelivery === 'object'
      ? data.manualDelivery
      : null,
    manualDeliveredAt: data.manualDeliveredAt
      ? String(data.manualDeliveredAt)
      : null,
    goodsReceivedAt: data.goodsReceivedAt
      ? serializeInvoiceDate(data.goodsReceivedAt) || String(data.goodsReceivedAt)
      : null,
  };
}

function normalizeSparePackaging(sparePackaging) {
  if (!Array.isArray(sparePackaging)) return null;
  const rows = sparePackaging.map(row => {
    const lengthCm = Number(row?.lengthCm);
    const widthCm = Number(row?.widthCm);
    const heightCm = Number(row?.heightCm);
    const weightKg = Number(row?.weightKg);
    return {
      lengthCm: Number.isFinite(lengthCm) ? lengthCm : 0,
      widthCm: Number.isFinite(widthCm) ? widthCm : 0,
      heightCm: Number.isFinite(heightCm) ? heightCm : 0,
      weightKg: Number.isFinite(weightKg) ? Math.max(0, weightKg) : 0,
      boxDefinitionId: row?.boxDefinitionId != null ? String(row.boxDefinitionId).trim() || null : null,
    };
  });
  // Treat as complete only when LBH are present. Weight may be blank/0.
  return rows.filter(r => r.lengthCm > 0 && r.widthCm > 0 && r.heightCm > 0);
}

export function firestoreDocToDetail(data) {
  const list = firestoreDocToListInvoice(data);
  return {
    ...list,
    salesOrderId: data.salesOrderId ?? null,
    salesOrderNumber: data.salesOrderNumber ?? null,
    subtotal: Number(data.subtotal ?? list.subtotal ?? 0),
    taxTotal: Number(data.taxTotal ?? list.taxTotal ?? 0),
    notes: data.notes ?? null,
    shippingAddress: data.shippingAddress ? String(data.shippingAddress) : null,
    shippingAddressId: data.shippingAddressId ? String(data.shippingAddressId) : null,
    billingAddress: data.billingAddress ? String(data.billingAddress) : null,
    lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
    sparePackaging: normalizeSparePackaging(data.sparePackaging),
    yesOneFreightPartner: data.yesOneFreightPartner && typeof data.yesOneFreightPartner === 'object'
      ? data.yesOneFreightPartner
      : null,
  };
}
