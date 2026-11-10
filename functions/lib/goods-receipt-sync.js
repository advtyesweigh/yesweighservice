/**
 * Zoho Inventory purchase bills → Firestore mirror (goods receipts).
 * Pattern mirrors purchase-order-sync / invoice-sync; docs live at goodsReceipts/{id}.
 * New bills are pulled as drafts (Scheduled). After ops marks received, the bill is
 * approved to Open in Zoho and kept on the mirror (open/paid). Void/cancelled drop.
 * Software-only bills (HSN / Software keys / Sanoft) are not mirrored.
 */
import { getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE, hasZohoJsonBody } from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
  fetchZohoOrgApiUsage,
  isZohoDailyQuotaBlocked,
} from './zoho-api-usage.js';
import {
  classifyInvoiceCategoryBreakdown,
  classifyInvoiceFromLineItems,
  isSoftwareOnlyInvoiceCategories,
  parseInvoiceCategory,
  sumNonFreightQuantity,
} from './invoice-category.js';
import { extractWebhookEvent } from './invoice-sync.js';
import { ackZohoWebhookFailure, ackIfDailyQuotaBlocked } from './zoho-webhook-guard.js';
import { applyPurchaseOrderSerialsOnGoodsReceipt } from './purchase-order-serials.js';
import { KNOWN_ZOHO_WAREHOUSE_IDS } from './zoho-locations.js';

const COLLECTION = 'goodsReceipts';
const META_DOC = 'goodsReceiptMeta/orgSync';
/** Same pacing knobs as org-invoice-sync. */
const ORG_SYNC_CONCURRENCY = 2;
const ORG_SYNC_MAX_LIST_PAGES = 150;
const STALE_RUN_MS = 75 * 60 * 1000;
const LIST_PAGE_DELAY_MS = 400;
const DETAIL_PULL_DELAY_MS = 250;
const RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BASE_MS = 30_000;
const LIST_SORT = { sortColumn: 'date', sortOrder: 'D' };
/** Nightly scheduled sync stops before consuming this share of the daily Zoho quota. */
export const SCHEDULED_API_QUOTA_RESERVE_RATIO = 0.30;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function scheduledQuotaReserveRemaining(dailyLimit) {
  return Math.ceil(Number(dailyLimit) * SCHEDULED_API_QUOTA_RESERVE_RATIO);
}

function resolveStorageBucketName() {
  const fromEnv = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (fromEnv) return fromEnv;
  const projectId =
    process.env.GCLOUD_PROJECT?.trim()
    ?? process.env.GCP_PROJECT?.trim()
    ?? process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (projectId) return `${projectId}.firebasestorage.app`;
  try {
    const app = getApp();
    if (app.options.storageBucket) return app.options.storageBucket;
    if (app.options.projectId) return `${app.options.projectId}.firebasestorage.app`;
  } catch {
    // ignore
  }
  return null;
}

function storageBucket() {
  const name = resolveStorageBucketName();
  return name ? getStorage().bucket(name) : getStorage().bucket();
}

function poCollection() {
  return getFirestore().collection(COLLECTION);
}

function orgSyncRef() {
  return getFirestore().doc(META_DOC);
}

function pdfPath(poId) {
  return `goodsreceipts/${poId}.pdf`;
}

async function zohoJsonRequest(accessToken, orgId, path, { method = 'GET', body } = {}) {
  const url = new URL(`${ZOHO_API_BASE}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }
  const sendBody = hasZohoJsonBody(body);
  const init = {
    method,
    headers: {
      ...authHeaders(accessToken, orgId),
      ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (sendBody) init.body = JSON.stringify(body);
  const res = await fetch(url.toString(), init);
  await recordZohoApiResponse(res, { operation: path, source: 'goods-receipt-sync' });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err = classifyZohoHttpError(res.status, payload);
    await recordZohoApiFailure(err, { operation: path, source: 'goods-receipt-sync' });
    throw err;
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    const apiErr = new Error(payload.message || 'Zoho API error.');
    apiErr.zohoCode = payload.code;
    throw apiErr;
  }
  return payload;
}

async function zohoCallWithRetry(fn, label) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== 'RATE_LIMITED' || attempt >= RATE_LIMIT_RETRIES) {
        await recordZohoApiFailure(err, { operation: label, source: 'goods-receipt-sync' }).catch(() => {});
        throw err;
      }
      const waitMs = RATE_LIMIT_BASE_MS * (attempt + 1);
      console.warn(
        `Zoho rate limit on ${label}, waiting ${waitMs / 1000}s `
        + `(retry ${attempt + 1}/${RATE_LIMIT_RETRIES})`,
      );
      await sleep(waitMs);
    }
  }
  return null;
}

async function mapConcurrent(items, concurrency, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function fetchBillsListPage(accessToken, orgId, page, options = {}) {
  const url = new URL(`${ZOHO_API_BASE}/bills`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '200');
  if (!options.unfiltered) {
    // Nightly/org pull only discovers unopened bills. Open/paid stay if already mirrored.
    // Books UI "Draft" includes API `draft` and `pending` (approval). filter_by matches the UI.
    url.searchParams.set('status', options.status ?? 'draft');
    url.searchParams.set('filter_by', options.filterBy ?? 'Status.Draft');
  }
  url.searchParams.set('sort_column', options.sortColumn ?? 'last_modified_time');
  url.searchParams.set('sort_order', options.sortOrder ?? 'D');
  if (options.billNumber) url.searchParams.set('bill_number', String(options.billNumber).trim());
  if (options.billNumberContains) {
    url.searchParams.set('bill_number_contains', String(options.billNumberContains).trim());
  }
  if (options.referenceNumber) {
    url.searchParams.set('reference_number', String(options.referenceNumber).trim());
  }
  if (options.searchText) url.searchParams.set('search_text', String(options.searchText).trim());
  if (options.locationId) url.searchParams.set('location_id', String(options.locationId).trim());
  if (options.branchId) url.searchParams.set('branch_id', String(options.branchId).trim());
  if (options.warehouseId) url.searchParams.set('warehouse_id', String(options.warehouseId).trim());

  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  await recordZohoApiResponse(res, { operation: `bills/list?page=${page}`, source: 'goods-receipt-sync' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = classifyZohoHttpError(res.status, payload);
    await recordZohoApiFailure(err, { operation: `bills/list?page=${page}`, source: 'goods-receipt-sync' });
    throw err;
  }
  return {
    bills: payload?.bills ?? [],
    hasMore: Boolean(payload?.page_context?.has_more_page),
  };
}

async function fetchBillRaw(accessToken, orgId, billId) {
  const payload = await zohoJsonRequest(accessToken, orgId, `/bills/${billId}`);
  return payload?.bill ?? null;
}

async function collectBillsMatching(accessToken, orgId, listOptions) {
  const found = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 5) {
    const list = await zohoCallWithRetry(
      () => fetchBillsListPage(accessToken, orgId, page, listOptions),
      `bills search page ${page}`,
    );
    found.push(...(list.bills || []));
    hasMore = Boolean(list.hasMore);
    page += 1;
  }
  return found;
}

function knownBillListLocationIds() {
  return [...new Set([
    ...KNOWN_ZOHO_WAREHOUSE_IDS.cochin,
    ...KNOWN_ZOHO_WAREHOUSE_IDS.head_office,
  ].filter(Boolean))];
}

/** Default /bills list is org-head-office scoped. Merge Cochin + HO warehouse/branch lists. */
async function mergeLocationDraftBills(accessToken, orgId, existing = []) {
  const byId = new Map();
  for (const row of existing) {
    const id = String(row?.bill_id ?? '').trim();
    if (id) byId.set(id, row);
  }
  const before = byId.size;
  for (const locationId of knownBillListLocationIds()) {
    for (const extra of [
      { locationId },
      { branchId: locationId },
      { warehouseId: locationId },
    ]) {
      const listed = await collectBillsMatching(accessToken, orgId, { ...LIST_SORT, ...extra });
      for (const row of listed) {
        const id = String(row?.bill_id ?? '').trim();
        if (id) byId.set(id, row);
      }
    }
  }
  if (byId.size !== before) {
    console.log(
      `Goods receipt draft list expanded ${before} → ${byId.size} after Cochin/HO location merge.`,
    );
  }
  return [...byId.values()];
}

/**
 * Pull specific Zoho bills into goodsReceipts (manual recover / webhook miss).
 * Searches without status filter so Draft + Pending + Open all match.
 */
export async function pullGoodsReceiptsByQuery(secrets, orgId, options = {}) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const billNumbers = [...new Set((options.billNumbers || []).map(v => String(v).trim()).filter(Boolean))];
  const referenceNumbers = [...new Set((options.referenceNumbers || []).map(v => String(v).trim()).filter(Boolean))];
  const searchTexts = [...new Set((options.searchTexts || []).map(v => String(v).trim()).filter(Boolean))];

  const queries = [
    ...billNumbers.map(billNumber => ({ unfiltered: true, billNumber })),
    ...billNumbers.map(billNumber => ({ unfiltered: true, billNumberContains: billNumber })),
    ...referenceNumbers.map(referenceNumber => ({ unfiltered: true, referenceNumber })),
    ...searchTexts.map(searchText => ({ unfiltered: true, searchText })),
  ];
  if (!queries.length) {
    throw new Error('billNumbers, referenceNumbers, or searchTexts is required.');
  }

  const byId = new Map();
  for (const query of queries) {
    const listed = await collectBillsMatching(accessToken, organizationId, query);
    for (const row of listed) {
      const id = String(row?.bill_id ?? '').trim();
      if (id) byId.set(id, row);
    }
  }

  const pulled = [];
  const dropped = [];
  const failed = [];
  for (const [id, summary] of byId) {
    try {
      const raw = await zohoCallWithRetry(
        () => fetchBillRaw(accessToken, organizationId, id),
        `bill ${id}`,
      );
      if (!raw) {
        failed.push({ id, billNumber: summary.bill_number || null, error: 'not_found' });
        continue;
      }
      const result = await upsertGoodsReceiptFromRaw(raw);
      const row = {
        id,
        billNumber: String(raw.bill_number || summary.bill_number || ''),
        status: String(raw.status || ''),
        vendorName: raw.vendor_name || null,
        referenceNumber: raw.reference_number || null,
        dropReason: result.dropReason || null,
      };
      if (result.dropped) dropped.push(row);
      else pulled.push(row);
    } catch (err) {
      failed.push({
        id,
        billNumber: summary.bill_number || null,
        error: err?.message || String(err),
      });
    }
  }

  console.log(
    `Manual goods receipt pull: listed=${byId.size} pulled=${pulled.length} `
    + `dropped=${dropped.length} failed=${failed.length}.`,
  );
  return {
    listed: byId.size,
    pulled,
    dropped,
    failed,
  };
}

/**
 * Daytime catch-up for draft bills the Bills webhook missed.
 * One list page, newest first. Already-mirrored bills are left for the nightly sync.
 */
export async function syncRecentDraftGoodsReceipts(secrets, orgId, options = {}) {
  if (await isZohoDailyQuotaBlocked()) {
    console.log('Recent draft goods receipt sync skipped — daily Zoho quota latched.');
    return { skipped: 'quota', listed: 0, missing: 0, newlyPulled: 0, dropped: 0, failed: 0 };
  }

  const maxNew = Math.min(30, Math.max(1, Number(options.maxNew) || 20));
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const list = await zohoCallWithRetry(
    () => fetchBillsListPage(accessToken, organizationId, 1, {
      sortColumn: 'created_time',
      sortOrder: 'D',
    }),
    'recent draft bills',
  );
  const bills = list?.bills || [];
  const ids = bills.map(row => String(row?.bill_id ?? '').trim()).filter(Boolean);
  const have = new Set();
  const db = getFirestore();
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await db.getAll(...ids.slice(i, i + 100).map(id => poCollection().doc(id)));
    for (const snap of snaps) {
      if (snap.exists) have.add(snap.id);
    }
  }

  const missing = [];
  for (const row of bills) {
    const id = String(row?.bill_id ?? '').trim();
    if (!id || have.has(id)) continue;
    missing.push(id);
    if (missing.length >= maxNew) break;
  }

  let newlyPulled = 0;
  let dropped = 0;
  let failed = 0;
  for (const id of missing) {
    try {
      const raw = await zohoCallWithRetry(
        () => fetchBillRaw(accessToken, organizationId, id),
        `bill ${id}`,
      );
      if (!raw) {
        failed += 1;
        continue;
      }
      const result = await upsertGoodsReceiptFromRaw(raw);
      if (result?.dropped) dropped += 1;
      else newlyPulled += 1;
      await sleep(DETAIL_PULL_DELAY_MS);
    } catch (err) {
      failed += 1;
      console.warn(`Recent goods receipt ${id} failed:`, err?.message ?? err);
      if (err?.code === 'RATE_LIMITED') break;
    }
  }

  console.log(
    `Recent draft goods receipts: listed=${bills.length} missing=${missing.length} `
    + `newlyPulled=${newlyPulled} dropped=${dropped} failed=${failed}.`,
  );
  return { listed: bills.length, missing: missing.length, newlyPulled, dropped, failed };
}

function normalizeBillStatus(status) {
  return String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

/** Unopened in Zoho: Draft UI includes `pending` (awaiting approval). */
function isDraftBillStatus(status) {
  const key = normalizeBillStatus(status);
  return key === 'draft' || key === 'pending' || key === 'pending_approval' || key === '';
}

/** Bills ops has already received — keep on the goods-receipt mirror. */
function isKeptBillStatus(status) {
  const key = normalizeBillStatus(status);
  return isDraftBillStatus(key)
    || key === 'open'
    || key === 'paid'
    || key === 'partially_paid'
    || key === 'overdue';
}

function alreadyOpenMessage(message) {
  const text = String(message ?? '').trim().toLowerCase();
  return /already (approved|open)|already in open( status)?|has already been approved|bill is already open/.test(text);
}

function toIstDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isoFromUnknown(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function lineItemsForBillPut(bill) {
  const items = Array.isArray(bill?.line_items) ? bill.line_items : [];
  return items.map((item) => {
    const line = {
      item_id: item.item_id,
      name: item.name,
      rate: item.rate,
      quantity: item.quantity,
    };
    if (item.line_item_id) line.line_item_id = item.line_item_id;
    if (item.account_id) line.account_id = item.account_id;
    if (item.location_id) line.location_id = item.location_id;
    if (item.warehouse_id) line.warehouse_id = item.warehouse_id;
    return line;
  }).filter((line) => line.item_id);
}

/**
 * Zoho bill `date` is yyyy-MM-dd only. Inventory posts as of this date when
 * the draft is marked Open. Time-of-day stays on our opsReceivedAt stamp.
 */
async function setBillDateInZoho(accessToken, orgId, billId, dateKey) {
  const date = String(dateKey ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const raw = await fetchBillRaw(accessToken, orgId, billId);
  if (!raw) throw new Error('Goods receipt not found in Zoho.');
  if (String(raw.date ?? '') === date) return raw;
  const due = String(raw.due_date ?? '').trim();
  const dueDate = due && due >= date ? due : date;
  const payload = await zohoJsonRequest(accessToken, orgId, `/bills/${billId}`, {
    method: 'PUT',
    body: {
      vendor_id: raw.vendor_id,
      bill_number: raw.bill_number,
      date,
      due_date: dueDate,
      line_items: lineItemsForBillPut(raw),
      ...(raw.reference_number ? { reference_number: raw.reference_number } : {}),
      ...(raw.notes ? { notes: raw.notes } : {}),
    },
  });
  return payload?.bill ?? raw;
}

async function commentBillReceivedInZoho(accessToken, orgId, billId, description) {
  const text = String(description ?? '').trim();
  if (!text) return;
  try {
    await zohoJsonRequest(accessToken, orgId, `/bills/${billId}/comments`, {
      method: 'POST',
      body: { description: text },
    });
  } catch (err) {
    console.warn(
      `Zoho bill ${billId} receive comment failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Open a draft bill in Zoho. Approval-workflow orgs use /approve; this org
 * (and PO-converted drafts) must use /status/open. "/approve" returns
 * "You can only approve the Bill submitted to you." and must not be treated
 * as already-open.
 */
async function approveBillInZoho(accessToken, orgId, billId) {
  try {
    await zohoJsonRequest(accessToken, orgId, `/bills/${billId}/status/open`, {
      method: 'POST',
    });
    return;
  } catch (openErr) {
    if (alreadyOpenMessage(openErr?.message)) return;
    console.warn(
      `Zoho bill ${billId} status/open failed: ${openErr?.message ?? openErr}`,
    );
    try {
      await zohoJsonRequest(accessToken, orgId, `/bills/${billId}/approve`, {
        method: 'POST',
      });
      return;
    } catch (approveErr) {
      if (alreadyOpenMessage(approveErr?.message)) return;
      console.warn(
        `Zoho bill ${billId} approve failed: ${approveErr?.message ?? approveErr}`,
      );
      const err = new Error(
        openErr?.message || approveErr?.message || 'Could not open this bill in Zoho.',
      );
      err.zohoCode = openErr?.zohoCode ?? approveErr?.zohoCode;
      throw err;
    }
  }
}

async function removeGoodsReceiptDoc(billId) {
  const id = String(billId ?? '').trim();
  if (!id) return;
  await poCollection().doc(id).delete().catch(() => {});
}

function mapLineItem(raw) {
  return {
    id: String(raw.line_item_id ?? raw.item_id ?? ''),
    itemId: raw.item_id != null ? String(raw.item_id) : null,
    name: String(raw.name ?? raw.item_name ?? 'Item'),
    description: raw.description != null ? String(raw.description) : null,
    sku: raw.sku != null ? String(raw.sku) : null,
    quantity: Number(raw.quantity ?? 0),
    rate: Number(raw.rate ?? 0),
    total: Number(raw.item_total ?? raw.total ?? 0),
    imageUrl: null,
    hsn: raw.hsn_or_sac != null ? String(raw.hsn_or_sac) : (raw.hsn != null ? String(raw.hsn) : null),
  };
}

function buildSearchBlob(doc) {
  return [
    doc.billNumber,
    doc.vendorName,
    doc.vendorId,
    doc.referenceNumber,
    doc.status,
    doc.locationName,
    doc.branchName,
    doc.inventorySite,
    ...(doc.lineItems || []).flatMap(line => [line.name, line.sku]),
  ].filter(Boolean).join(' ').toLowerCase();
}

async function loadCatalogMeta(itemIds) {
  const unique = [...new Set(itemIds.filter(Boolean).map(String))];
  const map = new Map();
  if (!unique.length) return map;
  const db = getFirestore();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const snaps = await db.getAll(...chunk.map(id => db.collection('catalogProducts').doc(id)));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      map.set(snap.id, {
        hsn: data.hsn != null ? String(data.hsn) : null,
        categoryId: data.categoryId != null ? String(data.categoryId) : null,
        categoryName: data.categoryName != null ? String(data.categoryName) : null,
      });
    }
  }
  return map;
}

function resolveInventorySite(locationName) {
  const n = String(locationName ?? '').trim().toLowerCase();
  if (!n) return null;
  if (n === 'cochin' || n.includes('cochin') || n.includes('kochi')) return 'cochin';
  if (
    n === 'head office'
    || n === 'headoffice'
    || n === 'head_office'
    || (n.includes('head') && n.includes('office'))
  ) {
    return 'head_office';
  }
  return null;
}

function pickLocationFromBill(raw) {
  // Zoho Books / Inventory multi-branch: UI "Branch" maps to branch_id + branch_name.
  const branchId = raw.branch_id
    ?? raw.branch?.branch_id
    ?? raw.branch?.id
    ?? null;
  const branchName = raw.branch_name
    ?? raw.branch?.branch_name
    ?? raw.branch?.name
    ?? null;

  let locationId = branchId ?? raw.location_id ?? raw.warehouse_id ?? null;
  let locationName = branchName ?? raw.location_name ?? raw.warehouse_name ?? null;

  if (!locationName || locationId == null) {
    const lines = Array.isArray(raw.line_items) ? raw.line_items : [];
    for (const line of lines) {
      const lineName = line?.branch_name
        ?? line?.location_name
        ?? line?.warehouse_name
        ?? null;
      const lineId = line?.branch_id
        ?? line?.location_id
        ?? line?.warehouse_id
        ?? null;
      if (lineName || lineId != null) {
        if (!locationName && lineName) locationName = lineName;
        if (locationId == null && lineId != null) locationId = lineId;
        if (locationName && locationId != null) break;
      }
    }
  }

  const name = locationName != null ? String(locationName).trim() : null;
  const id = locationId != null ? String(locationId) : null;
  return {
    branchId: branchId != null ? String(branchId) : id,
    branchName: branchName != null ? String(branchName).trim() : name,
    locationId: id,
    locationName: name,
    inventorySite: resolveInventorySite(name),
  };
}

function pickVendorAddressFromBill(raw) {
  const billing = raw?.billing_address && typeof raw.billing_address === 'object'
    ? raw.billing_address
    : null;
  const shipping = raw?.shipping_address && typeof raw.shipping_address === 'object'
    ? raw.shipping_address
    : null;
  const addr = billing || shipping || null;

  const clean = (value) => {
    const s = value != null ? String(value).trim() : '';
    return s || null;
  };

  return {
    vendorState: clean(addr?.state ?? addr?.province ?? raw?.source_of_supply),
    vendorCountry: clean(addr?.country),
    vendorCity: clean(addr?.city),
  };
}

function normalizeFieldKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeDateValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeDateValue(value.value ?? value.date ?? value.value_formatted);
  }
  const s = String(value).trim();
  return s || null;
}

function customFieldMatches(fieldKey, needles) {
  return needles.some(needle => fieldKey === needle || fieldKey.endsWith(needle));
}

function pickCustomDate(raw, needles) {
  const fields = Array.isArray(raw?.custom_fields) ? raw.custom_fields : [];
  for (const field of fields) {
    const keys = [
      field?.label,
      field?.api_name,
      field?.placeholder,
    ].map(normalizeFieldKey).filter(Boolean);
    if (!keys.some(key => customFieldMatches(key, needles))) continue;
    const date = normalizeDateValue(field?.value_formatted ?? field?.value);
    if (date) return date;
  }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!/^cf_/i.test(key)) continue;
    if (!customFieldMatches(normalizeFieldKey(key), needles)) continue;
    const date = normalizeDateValue(value);
    if (date) return date;
  }
  return null;
}

function pickLinkedPurchaseOrderDate(raw) {
  const orders = Array.isArray(raw?.purchaseorders)
    ? raw.purchaseorders
    : (Array.isArray(raw?.purchase_orders) ? raw.purchase_orders : []);
  for (const po of orders) {
    const date = normalizeDateValue(po?.date ?? po?.purchaseorder_date);
    if (date) return date;
  }
  return null;
}

function pickBillShipmentDates(raw) {
  return {
    poDate: pickLinkedPurchaseOrderDate(raw),
    sailedDate: pickCustomDate(raw, ['saileddate', 'saildate', 'sailingdate', 'etd']),
    receivedDate: pickCustomDate(raw, ['receiveddate', 'receivedon', 'receiptdate', 'arrivaldate']),
  };
}

function linkedPurchaseOrderNumber(raw) {
  const orders = Array.isArray(raw?.purchaseorders)
    ? raw.purchaseorders
    : (Array.isArray(raw?.purchase_orders) ? raw.purchase_orders : []);
  for (const po of orders) {
    const number = String(po?.purchaseorder_number ?? po?.purchase_order_number ?? '').trim();
    if (number) return number;
  }
  return null;
}

async function lookupPurchaseOrderDate(poNumber) {
  const number = String(poNumber ?? '').trim();
  if (!number) return null;
  const snap = await getFirestore()
    .collection('purchaseOrders')
    .where('purchaseOrderNumber', '==', number)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() || {};
  return normalizeDateValue(data.date ?? data.createdTime ?? data.createdAt);
}

async function resolveGoodsReceiptPoDate(mapped, raw) {
  const poNumber = mapped.referenceNumber || linkedPurchaseOrderNumber(raw);
  const fromPo = await lookupPurchaseOrderDate(poNumber);
  return fromPo ?? mapped.poDate ?? null;
}

function mapGoodsReceipt(raw) {
  const lineItems = Array.isArray(raw.line_items)
    ? raw.line_items.map(mapLineItem)
    : [];
  const location = pickLocationFromBill(raw);
  const vendorAddress = pickVendorAddressFromBill(raw);
  const shipmentDates = pickBillShipmentDates(raw);
  return {
    id: String(raw.bill_id ?? ''),
    billNumber: String(raw.bill_number ?? ''),
    date: raw.date ? String(raw.date) : null,
    createdTime: raw.created_time ? String(raw.created_time) : (raw.createdTime ? String(raw.createdTime) : null),
    dueDate: raw.due_date ? String(raw.due_date) : null,
    poDate: shipmentDates.poDate,
    sailedDate: shipmentDates.sailedDate,
    receivedDate: shipmentDates.receivedDate,
    status: String(raw.status ?? 'draft'),
    total: Number(raw.total ?? 0),
    balance: Number(raw.balance ?? raw.total ?? 0),
    referenceNumber: raw.reference_number ? String(raw.reference_number) : null,
    currencyCode: String(raw.currency_code ?? 'INR'),
    vendorId: raw.vendor_id != null ? String(raw.vendor_id) : '',
    vendorName: raw.vendor_name ? String(raw.vendor_name) : null,
    vendorState: vendorAddress.vendorState,
    vendorCountry: vendorAddress.vendorCountry,
    vendorCity: vendorAddress.vendorCity,
    subtotal: Number(raw.sub_total ?? raw.subtotal ?? 0),
    taxTotal: Number(raw.tax_total ?? 0),
    notes: raw.notes ? String(raw.notes) : null,
    locationId: location.locationId,
    locationName: location.locationName,
    branchId: location.branchId,
    branchName: location.branchName,
    inventorySite: location.inventorySite,
    lineItems,
    zohoLastModified: raw.last_modified_time ? String(raw.last_modified_time) : null,
  };
}

async function upsertGoodsReceiptFromRaw(raw) {
  const mapped = mapGoodsReceipt(raw);
  if (!mapped.id) throw new Error('Missing bill_id.');
  mapped.poDate = await resolveGoodsReceiptPoDate(mapped, raw);
  mapped.purchaseOrderNumber = linkedPurchaseOrderNumber(raw) || mapped.referenceNumber || null;

  const existingSnap = await poCollection().doc(mapped.id).get();
  const existing = existingSnap.exists ? (existingSnap.data() || {}) : null;
  if (!mapped.purchaseOrderNumber && existing?.purchaseOrderNumber) {
    mapped.purchaseOrderNumber = existing.purchaseOrderNumber;
  }

  // New bills: unopened only (draft / pending). Already-mirrored stay after ops opens them.
  if (!isDraftBillStatus(mapped.status)) {
    if (!existing || !isKeptBillStatus(mapped.status)) {
      console.warn(
        `Goods receipt drop ${mapped.id} ${mapped.billNumber || ''} `
        + `status=${mapped.status} (not unopened, not already mirrored).`,
      );
      await removeGoodsReceiptDoc(mapped.id);
      return { id: mapped.id, goodsReceiptCategory: null, dropped: true, dropReason: 'status' };
    }
  }

  if (!mapped.receivedDate && existing?.receivedDate) {
    mapped.receivedDate = existing.receivedDate;
  }

  const catalog = await loadCatalogMeta(mapped.lineItems.map(line => line.itemId).filter(Boolean));
  const categoryBreakdown = classifyInvoiceCategoryBreakdown(mapped.lineItems, catalog);
  const goodsReceiptCategory = categoryBreakdown.categories[0]
    ?? classifyInvoiceFromLineItems(mapped.lineItems, catalog);
  if (isSoftwareOnlyInvoiceCategories(categoryBreakdown.categories, goodsReceiptCategory)) {
    console.warn(
      `Goods receipt drop ${mapped.id} ${mapped.billNumber || ''} software-only `
      + `(${(categoryBreakdown.categories || []).join(',')}).`,
    );
    await removeGoodsReceiptDoc(mapped.id);
    return { id: mapped.id, goodsReceiptCategory, dropped: true, dropReason: 'software' };
  }
  const now = Timestamp.now();
  const doc = {
    ...mapped,
    searchBlob: buildSearchBlob(mapped),
    goodsReceiptCategory,
    categories: categoryBreakdown.categories,
    categoryAmounts: categoryBreakdown.categoryAmounts,
    itemQuantity: sumNonFreightQuantity(mapped.lineItems),
    syncedAt: now,
    contentFingerprint: `${mapped.zohoLastModified}|${mapped.lineItems.length}|${mapped.total}`,
  };

  await poCollection().doc(mapped.id).set(doc, { merge: true });
  return { id: mapped.id, goodsReceiptCategory, dropped: false };
}

function detailStillValid(existing, summary) {
  if (!existing) return false;
  if (isSoftwareOnlyInvoiceCategories(existing.categories, existing.goodsReceiptCategory)) return false;
  if (!Array.isArray(existing.lineItems) || existing.lineItems.length === 0) return false;
  // Force re-pull once after branch/location mapping was added.
  if (!Object.prototype.hasOwnProperty.call(existing, 'branchName')) return false;
  // Force re-pull once after vendor state/country mapping was added.
  if (!Object.prototype.hasOwnProperty.call(existing, 'vendorCountry')) return false;
  // Force re-pull once after PO / sailed / received dates were added.
  if (!Object.prototype.hasOwnProperty.call(existing, 'poDate')) return false;
  const existingMod = String(existing.zohoLastModified ?? '');
  const summaryMod = String(summary.last_modified_time ?? '');
  return Boolean(existingMod && summaryMod && existingMod === summaryMod);
}

async function readOrgSyncMeta() {
  const snap = await orgSyncRef().get();
  return snap.exists ? (snap.data() || {}) : {};
}

function normalizeStatus(meta) {
  const status = String(meta.status ?? 'idle');
  if (status === 'running') return 'running';
  if (status === 'complete') return 'complete';
  return 'idle';
}

export async function getOrgGoodsReceiptSyncStatus() {
  const meta = await readOrgSyncMeta();
  const totalInRange = meta.totalInRange ?? null;
  const pulledCount = meta.pulledCount ?? 0;
  const remaining = totalInRange == null ? null : Math.max(0, totalInRange - pulledCount);
  let status = normalizeStatus(meta);
  const startedAt = meta.runStartedAt?.toDate?.();
  if (status === 'running' && startedAt && Date.now() - startedAt.getTime() > STALE_RUN_MS) {
    status = pulledCount >= totalInRange && totalInRange > 0 ? 'complete' : 'idle';
    await orgSyncRef().set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return {
    status,
    totalInRange,
    pulledCount,
    remaining,
    checkpointPage: meta.checkpointPage ?? 1,
    checkpointIndex: meta.checkpointIndex ?? 0,
    lastRunAt: meta.lastRunAt?.toDate?.()?.toISOString?.() ?? null,
    lastRunSummary: meta.status === 'running' || !meta.lastRunSummary?.inProgress
      ? (meta.lastRunSummary ?? null)
      : null,
    lastRunSource: meta.lastRunSource ?? null,
    completedAt: meta.completedAt?.toDate?.()?.toISOString?.() ?? null,
    totalCountedAt: meta.totalCountedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

async function beginOrgSyncRun() {
  const ref = orgSyncRef();
  return getFirestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? {};
    const startedAt = data.runStartedAt?.toDate?.();
    const staleRun = data.status === 'running'
      && startedAt
      && Date.now() - startedAt.getTime() > STALE_RUN_MS;
    if (data.status === 'running' && !staleRun) {
      const err = new Error('Goods receipt sync is already running.');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    tx.set(ref, {
      status: 'running',
      runStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return data;
  });
}

async function writeOrgSyncMeta(patch) {
  await orgSyncRef().set({
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function batchHasStoredDetail(summaries) {
  const db = getFirestore();
  let pulled = 0;
  const refs = summaries.map(s => poCollection().doc(String(s.bill_id)));
  for (let i = 0; i < refs.length; i += 100) {
    const snaps = await db.getAll(...refs.slice(i, i + 100));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() ?? {};
      if (Array.isArray(data.lineItems) && data.lineItems.length > 0) pulled += 1;
    }
  }
  return pulled;
}

export async function countOrgGoodsReceiptsInRange(secrets, orgId) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  let page = 1;
  let totalInRange = 0;
  let pulledCount = 0;
  let hasMore = true;

  while (hasMore && page <= ORG_SYNC_MAX_LIST_PAGES) {
    const list = await zohoCallWithRetry(
      () => fetchBillsListPage(accessToken, organizationId, page, LIST_SORT),
      `bills count list page ${page}`,
    );
    const bills = page === 1
      ? await mergeLocationDraftBills(accessToken, organizationId, list.bills)
      : list.bills;
    totalInRange += bills.length;
    pulledCount += await batchHasStoredDetail(bills);
    hasMore = list.hasMore;
    page += 1;
    if (hasMore) await sleep(LIST_PAGE_DELAY_MS);
  }

  const now = FieldValue.serverTimestamp();
  const priorMeta = await readOrgSyncMeta();
  const scopeChanged = priorMeta.totalInRange != null && priorMeta.totalInRange !== totalInRange;
  await writeOrgSyncMeta({
    totalInRange,
    pulledCount,
    totalCountedAt: now,
    status: priorMeta.status === 'running'
      ? 'running'
      : (pulledCount >= totalInRange && totalInRange > 0 ? 'complete' : 'idle'),
    completedAt: pulledCount >= totalInRange && totalInRange > 0 ? now : priorMeta.completedAt ?? null,
    checkpointPage: scopeChanged ? 1 : (priorMeta.checkpointPage ?? 1),
    checkpointIndex: scopeChanged ? 0 : (priorMeta.checkpointIndex ?? 0),
  });

  return {
    totalInRange,
    pulledCount,
    remaining: Math.max(0, totalInRange - pulledCount),
  };
}

export async function syncOrgGoodsReceiptsToFirestore(secrets, orgId, options = {}) {
  const source = options.source ?? 'org-goods-receipt-sync';
  let priorMeta;
  try {
    priorMeta = await beginOrgSyncRun();
  } catch (err) {
    if (err?.code === 'ALREADY_RUNNING') throw err;
    throw err;
  }

  console.log(
    `Org goods receipt sync started (${source}): checkpoint page ${priorMeta.checkpointPage ?? 1} `
    + `index ${priorMeta.checkpointIndex ?? 0}, `
    + `pulled ${priorMeta.pulledCount ?? 0}/${priorMeta.totalInRange ?? '?'}.`,
  );

  let page = Number(priorMeta.checkpointPage ?? 1);
  let index = Number(priorMeta.checkpointIndex ?? 0);
  const baselinePulled = Number(priorMeta.pulledCount ?? 0);
  let pulledCount = baselinePulled;
  const totalInRange = priorMeta.totalInRange ?? null;

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let unchanged = 0;
  let newlyPulled = 0;
  let completed = false;
  let rateLimited = false;
  let quotaReserved = false;

  const quotaReserveRatio = Number(options.quotaReserveRatio ?? 0);
  let apiCallsThisRun = 0;
  let apiBudget = null;

  const shouldStopForQuota = () => apiBudget != null && apiCallsThisRun >= apiBudget;

  const trackZohoCall = () => {
    apiCallsThisRun += 1;
    if (shouldStopForQuota()) quotaReserved = true;
  };

  const computePulledCount = () => Math.max(
    Number(priorMeta.pulledCount ?? 0),
    baselinePulled + newlyPulled + unchanged,
  );

  const publishProgress = async (force = false) => {
    if (!force && newlyPulled > 0 && newlyPulled % 25 !== 0) return;
    await writeOrgSyncMeta({
      pulledCount: computePulledCount(),
      checkpointPage: page,
      checkpointIndex: index,
      lastRunSummary: {
        synced,
        failed,
        skipped,
        unchanged,
        newlyPulled,
        rateLimited: false,
        quotaReserved: false,
        inProgress: true,
      },
    });
  };

  try {
    const accessToken = await getAccessToken(secrets);
    const organizationId = await resolveOrganizationId(accessToken, orgId);

    if (quotaReserveRatio > 0) {
      const usage = await fetchZohoOrgApiUsage(accessToken, organizationId);
      apiCallsThisRun = 1;
      const reserveRemaining = scheduledQuotaReserveRemaining(usage.dailyLimit);
      apiBudget = Math.max(0, usage.remaining - reserveRemaining);
      console.log(
        `Scheduled goods receipt sync API budget: ${apiBudget.toLocaleString()} calls `
        + `(keeping ${Math.round(quotaReserveRatio * 100)}% / `
        + `${reserveRemaining.toLocaleString()} of ${usage.dailyLimit.toLocaleString()} daily quota).`,
      );
      if (apiBudget <= 0) {
        quotaReserved = true;
        console.log('Scheduled goods receipt sync skipped — daily quota already at or below the 30% reserve.');
      }
    }

    const processSummary = async summary => {
      if (shouldStopForQuota()) {
        quotaReserved = true;
        return { synced: 0, unchanged: 0, failed: 0, skipped: 0, newlyPulled: 0, rateLimited: false, stopQuota: true };
      }

      const poId = String(summary.bill_id ?? '');
      if (!poId) {
        return { synced: 0, unchanged: 0, failed: 0, skipped: 1, newlyPulled: 0, rateLimited: false };
      }

      const existingSnap = await poCollection().doc(poId).get();
      const existing = existingSnap.exists ? existingSnap.data() : null;
      if (detailStillValid(existing, summary)) {
        return { synced: 1, unchanged: 1, failed: 0, skipped: 0, newlyPulled: 0, rateLimited: false };
      }

      let fullRaw;
      try {
        fullRaw = await zohoCallWithRetry(
          () => fetchBillRaw(accessToken, organizationId, poId),
          `bill ${poId}`,
        );
        trackZohoCall();
      } catch (err) {
        if (err?.code === 'RATE_LIMITED') {
          return { synced: 0, unchanged: 0, failed: 0, skipped: 0, newlyPulled: 0, rateLimited: true };
        }
        return { synced: 0, unchanged: 0, failed: 1, skipped: 0, newlyPulled: 0, rateLimited: false };
      }

      if (!fullRaw) {
        return { synced: 0, unchanged: 0, failed: 0, skipped: 1, newlyPulled: 0, rateLimited: false };
      }

      try {
        const upserted = await upsertGoodsReceiptFromRaw(fullRaw);
        await sleep(DETAIL_PULL_DELAY_MS);
        if (upserted?.dropped) {
          return { synced: 0, unchanged: 0, failed: 0, skipped: 1, newlyPulled: 0, rateLimited: false };
        }
        return { synced: 1, unchanged: 0, failed: 0, skipped: 0, newlyPulled: 1, rateLimited: false };
      } catch (err) {
        console.warn('Org goods receipt sync item failed:', err?.message ?? err);
        return { synced: 0, unchanged: 0, failed: 1, skipped: 0, newlyPulled: 0, rateLimited: false };
      }
    };

    while (!completed && !rateLimited && !quotaReserved) {
      if (shouldStopForQuota()) {
        quotaReserved = true;
        break;
      }

      let list;
      try {
        list = await zohoCallWithRetry(
          () => fetchBillsListPage(accessToken, organizationId, page, LIST_SORT),
          `bills list page ${page}`,
        );
        trackZohoCall();
        if (page === 1) {
          list = {
            ...list,
            bills: await mergeLocationDraftBills(accessToken, organizationId, list.bills),
          };
        }
      } catch (err) {
        if (err?.code === 'RATE_LIMITED') {
          rateLimited = true;
          break;
        }
        throw err;
      }

      const slice = list.bills.slice(index);
      const results = await mapConcurrent(slice, ORG_SYNC_CONCURRENCY, processSummary);
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        if (result.stopQuota) {
          quotaReserved = true;
          index += i;
          break;
        }
        if (result.rateLimited) {
          rateLimited = true;
          index += i;
          break;
        }
        synced += result.synced;
        unchanged += result.unchanged;
        failed += result.failed;
        skipped += result.skipped;
        newlyPulled += result.newlyPulled;
      }

      await publishProgress(true);

      if (newlyPulled > 0 && newlyPulled % 100 === 0) {
        console.log(`Org goods receipt sync progress: ${newlyPulled} newly pulled this run.`);
      }

      if (rateLimited || quotaReserved) {
        await writeOrgSyncMeta({ checkpointPage: page, checkpointIndex: index });
        break;
      }

      index = 0;
      if (!list.hasMore) {
        completed = true;
        page = 1;
        break;
      }
      page += 1;
      await writeOrgSyncMeta({ checkpointPage: page, checkpointIndex: 0 });
      await sleep(LIST_PAGE_DELAY_MS);
    }
  } catch (err) {
    await writeOrgSyncMeta({
      status: 'idle',
      checkpointPage: page,
      checkpointIndex: index,
    }).catch(() => {});
    console.error('Org goods receipt sync failed:', err?.message ?? err);
    throw err;
  } finally {
    const priorPulled = Number(priorMeta.pulledCount ?? 0);
    const runEstimate = baselinePulled + newlyPulled + unchanged;
    pulledCount = Math.max(priorPulled, runEstimate);
    if (completed && totalInRange != null) {
      pulledCount = Math.min(totalInRange, Math.max(pulledCount, runEstimate));
    }
    const allDone = completed && (totalInRange == null || pulledCount >= totalInRange);
    const status = allDone ? 'complete' : 'idle';

    await writeOrgSyncMeta({
      status,
      totalInRange: totalInRange ?? priorMeta.totalInRange ?? null,
      pulledCount,
      checkpointPage: completed ? 1 : page,
      checkpointIndex: completed ? 0 : (rateLimited || quotaReserved ? index : 0),
      lastRunAt: FieldValue.serverTimestamp(),
      lastRunSource: source,
      lastRunSummary: {
        synced,
        failed,
        skipped,
        unchanged,
        newlyPulled,
        rateLimited,
        quotaReserved,
        inProgress: false,
      },
      ...(allDone ? { completedAt: FieldValue.serverTimestamp() } : {}),
    });
  }

  const remaining = totalInRange == null ? null : Math.max(0, totalInRange - pulledCount);
  const message = rateLimited
    ? 'Zoho API rate limit reached. Progress is saved at the current checkpoint — wait for quota to recover, then click Pull now again.'
    : quotaReserved
      ? `Scheduled sync stopped to preserve ${Math.round((quotaReserveRatio || SCHEDULED_API_QUOTA_RESERVE_RATIO) * 100)}% of today's Zoho API quota for daytime use. Resume with Pull now or wait for the next 3 AM run.`
      : completed
        ? 'All draft purchase bills are synced. Received bills already on the list are kept.'
        : 'Goods receipt sync paused.';

  console.log(
    `Org goods receipt sync finished (${source}): status=${completed ? 'complete' : 'idle'}, `
    + `newlyPulled=${newlyPulled}, unchanged=${unchanged}, failed=${failed}, rateLimited=${rateLimited}, `
    + `quotaReserved=${quotaReserved}, pulled=${pulledCount}/${totalInRange ?? '?'}.`,
  );

  return {
    status: completed && (totalInRange == null || pulledCount >= totalInRange) ? 'complete' : 'idle',
    syncedCount: synced,
    failedCount: failed,
    skippedCount: skipped,
    unchangedCount: unchanged,
    newlyPulled,
    totalInRange,
    pulledCount,
    remaining,
    completed,
    rateLimited,
    quotaReserved,
    message,
  };
}

export async function reclassifyGoodsReceiptCategoriesFromCatalog(options = {}) {
  const limit = Math.min(Math.max(Number(options.batchSize ?? 500) || 500, 50), 2000);
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  const counts = { product: 0, spare: 0, service: 0, software_key: 0, gatc: 0 };

  let lastDoc = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = poCollection().orderBy('__name__').limit(limit);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const itemIds = [];
    for (const docSnap of snap.docs) {
      const lines = Array.isArray(docSnap.data()?.lineItems) ? docSnap.data().lineItems : [];
      for (const line of lines) {
        if (line?.itemId) itemIds.push(String(line.itemId));
      }
    }
    const catalog = await loadCatalogMeta(itemIds);
    const batch = getFirestore().batch();
    let batchWrites = 0;

    for (const docSnap of snap.docs) {
      scanned += 1;
      const data = docSnap.data() || {};
      const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
      const breakdown = classifyInvoiceCategoryBreakdown(lines, catalog);
      const next = breakdown.categories[0] ?? classifyInvoiceFromLineItems(lines, catalog);
      counts[next] = (counts[next] || 0) + 1;
      const current = parseInvoiceCategory(data.goodsReceiptCategory);
      const sameCategories = JSON.stringify(data.categories ?? []) === JSON.stringify(breakdown.categories);
      const sameAmounts = JSON.stringify(data.categoryAmounts ?? {}) === JSON.stringify(breakdown.categoryAmounts);
      if (current === next && sameCategories && sameAmounts) {
        unchanged += 1;
        continue;
      }
      batch.update(docSnap.ref, {
        goodsReceiptCategory: next,
        categories: breakdown.categories,
        categoryAmounts: breakdown.categoryAmounts,
      });
      batchWrites += 1;
      updated += 1;
    }
    if (batchWrites) await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < limit) break;
  }

  return { scanned, updated, unchanged, counts };
}

export async function ensureGoodsReceiptPdf(secrets, orgId, billId) {
  const id = String(billId || '').trim();
  if (!id) throw new Error('Goods receipt id is required.');
  const ref = poCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Goods receipt not found.');
  const data = snap.data() || {};
  const path = data.pdfStoragePath || pdfPath(id);
  const file = storageBucket().file(path);
  const [exists] = await file.exists();
  if (exists) {
    const [buf] = await file.download();
    return {
      contentBase64: buf.toString('base64'),
      filename: `${data.billNumber || id}.pdf`,
      mimeType: 'application/pdf',
    };
  }

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const url = new URL(`${ZOHO_API_BASE}/bills/${id}`);
  url.searchParams.set('organization_id', organizationId);
  const res = await fetch(url.toString(), {
    headers: {
      ...authHeaders(accessToken, organizationId),
      Accept: 'application/pdf',
    },
  });
  await recordZohoApiResponse(res, { operation: `bills/${id}/pdf`, source: 'goods-receipt-sync' });
  if (!res.ok) {
    throw new Error(`Could not download goods receipt PDF (${res.status}).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('PDF file is empty.');
  await file.save(buffer, { resumable: false, contentType: 'application/pdf' });
  await ref.set({ pdfStoragePath: path }, { merge: true });
  return {
    contentBase64: buffer.toString('base64'),
    filename: `${data.billNumber || id}.pdf`,
    mimeType: 'application/pdf',
  };
}

export function mapGoodsReceiptDoc(id, data) {
  return {
    id,
    billNumber: String(data.billNumber ?? ''),
    date: data.date ?? null,
    dueDate: data.dueDate ?? null,
    poDate: data.poDate ?? null,
    sailedDate: data.sailedDate ?? null,
    receivedDate: data.receivedDate ?? null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    referenceNumber: data.referenceNumber ?? null,
    currencyCode: String(data.currencyCode ?? 'INR'),
    vendorId: String(data.vendorId ?? ''),
    vendorName: data.vendorName ?? null,
    vendorState: data.vendorState != null ? String(data.vendorState) : null,
    vendorCountry: data.vendorCountry != null ? String(data.vendorCountry) : null,
    vendorCity: data.vendorCity != null ? String(data.vendorCity) : null,
    locationId: data.locationId != null ? String(data.locationId) : null,
    locationName: data.locationName != null ? String(data.locationName) : null,
    branchId: data.branchId != null ? String(data.branchId) : null,
    branchName: data.branchName != null ? String(data.branchName) : null,
    inventorySite: data.inventorySite === 'head_office' || data.inventorySite === 'cochin'
      ? data.inventorySite
      : null,
    subtotal: Number(data.subtotal ?? 0),
    taxTotal: Number(data.taxTotal ?? 0),
    notes: data.notes ?? null,
    lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
    goodsReceiptCategory: parseInvoiceCategory(data.goodsReceiptCategory),
    categories: Array.isArray(data.categories) ? data.categories.map(String) : [],
    categoryAmounts: data.categoryAmounts && typeof data.categoryAmounts === 'object'
      ? { ...data.categoryAmounts }
      : {},
    itemQuantity: data.itemQuantity != null
      ? Number(data.itemQuantity)
      : (Array.isArray(data.lineItems)
        ? data.lineItems.reduce((sum, line) => sum + Number(line.quantity || 0), 0)
        : null),
    syncedAt: data.syncedAt?.toDate?.()?.toISOString?.()
      ?? (typeof data.syncedAt === 'string' ? data.syncedAt : null),
    searchBlob: data.searchBlob ?? '',
    pdfStoragePath: data.pdfStoragePath ?? null,
  };
}

function normalizeWebhookBody(body) {
  if (!body || typeof body !== 'object') return {};
  let next = { ...body };
  if (typeof body.JSONString === 'string' && body.JSONString.trim()) {
    try {
      const parsed = JSON.parse(body.JSONString);
      if (parsed && typeof parsed === 'object') next = { ...next, ...parsed };
    } catch {
      // ignore malformed Zoho JSONString
    }
  }
  return next;
}

function firstZohoId(value) {
  const id = String(value ?? '').trim();
  if (!id) return null;
  // Zoho bill_id is numeric. Ignore bill numbers like YM2608009.
  if (!/^\d{6,}$/.test(id)) return null;
  return id;
}

function billIdFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  return firstZohoId(value.bill_id)
    || firstZohoId(value.billId)
    || firstZohoId(value.entity_id)
    || firstZohoId(value.entityId);
}

export function extractBillIdFromWebhook(body, query = {}) {
  const normalized = normalizeWebhookBody(body);
  const nestedBill = normalized.bill
    || normalized.data?.bill
    || normalized.payload?.bill
    || (Array.isArray(normalized.bills) ? normalized.bills[0] : null)
    || (Array.isArray(normalized.data?.bills) ? normalized.data.bills[0] : null);
  const candidates = [
    query.bill_id,
    query.billId,
    query.entity_id,
    (String(query.id ?? '') !== String(query.organization_id ?? '') ? query.id : null),
    normalized.bill_id,
    normalized.billId,
    normalized.entity_id,
    nestedBill,
    normalized.data?.bill_id,
    normalized.payload?.bill_id,
  ];
  for (const value of candidates) {
    const id = typeof value === 'object' ? billIdFromObject(value) : firstZohoId(value);
    if (id) return id;
  }
  return billIdFromObject(normalized);
}

export async function deleteGoodsReceiptFromFirestore(billId) {
  await removeGoodsReceiptDoc(billId);
}

/** Pull one purchase bill from Zoho into Firestore (webhook / single refresh). */
export async function mirrorGoodsReceiptFromZoho(secrets, orgId, billId) {
  const id = String(billId ?? '').trim();
  if (!id) throw new Error('billId is required.');
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const raw = await fetchBillRaw(accessToken, organizationId, id);
  if (!raw) throw new Error('Goods receipt not found in Zoho.');
  return upsertGoodsReceiptFromRaw(raw);
}

/**
 * Ops: record received datetime and approve the Zoho draft bill (Draft → Open).
 */
export async function markGoodsReceiptReceived(secrets, orgId, {
  goodsReceiptId,
  markedByUid,
  markedByName,
  receivedAt: receivedAtInput,
  allowBackdate,
  serialRanges,
}) {
  const id = String(goodsReceiptId ?? '').trim();
  if (!id) throw new Error('goodsReceiptId is required.');

  const ref = poCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Goods receipt not found.');
  const data = snap.data() || {};

  const existingReceivedAt = isoFromUnknown(data.opsReceivedAt);
  const currentStatus = normalizeBillStatus(data.status);
  const stillDraft = isDraftBillStatus(currentStatus);

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);

  if (existingReceivedAt && !stillDraft) {
    const raw = await fetchBillRaw(accessToken, organizationId, id).catch(() => null);
    const serialAllotment = await applyPurchaseOrderSerialsOnGoodsReceipt({
      goodsReceiptId: id,
      purchaseOrderNumber: linkedPurchaseOrderNumber(raw)
        || data.purchaseOrderNumber
        || data.referenceNumber,
      markedByName,
      serialRanges,
    });
    return {
      alreadyReceived: true,
      status: String(data.status ?? 'open'),
      receivedDate: data.receivedDate ? String(data.receivedDate) : null,
      opsReceivedAt: existingReceivedAt,
      opsReceivedByUid: data.opsReceivedByUid != null ? String(data.opsReceivedByUid) : null,
      opsReceivedByName: data.opsReceivedByName != null ? String(data.opsReceivedByName) : null,
      serialAllotment,
    };
  }

  let receivedAt = existingReceivedAt ? new Date(existingReceivedAt) : new Date();
  if (!existingReceivedAt && allowBackdate && receivedAtInput) {
    const parsed = new Date(receivedAtInput);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid received datetime.');
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      throw new Error('Received datetime cannot be in the future.');
    }
    receivedAt = parsed;
  }
  const opsReceivedAt = receivedAt.toISOString();
  const receivedDate = data.receivedDate
    ? String(data.receivedDate)
    : toIstDateKey(receivedAt);

  if (stillDraft) {
    await setBillDateInZoho(accessToken, organizationId, id, receivedDate);
    await approveBillInZoho(accessToken, organizationId, id);
    const receivedLabel = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(receivedAt);
    await commentBillReceivedInZoho(
      accessToken,
      organizationId,
      id,
      `Goods received ${receivedLabel} IST. Draft marked Open with bill date ${receivedDate}.`,
    );
  }

  const raw = await fetchBillRaw(accessToken, organizationId, id);
  if (!raw) throw new Error('Goods receipt not found in Zoho.');
  if (!isKeptBillStatus(raw.status) || isDraftBillStatus(raw.status)) {
    console.error(
      `Zoho bill ${id} still ${raw.status} after open attempt.`,
    );
    throw new Error(
      `Zoho did not open this bill (still ${String(raw.status || 'draft')}).`,
    );
  }
  const upserted = await upsertGoodsReceiptFromRaw(raw);
  if (upserted?.dropped) {
    throw new Error('Could not keep this bill after opening it in Zoho.');
  }

  const status = String(raw.status ?? 'open');
  const purchaseOrderNumber = linkedPurchaseOrderNumber(raw)
    || data.purchaseOrderNumber
    || data.referenceNumber
    || null;
  await ref.set({
    status,
    receivedDate,
    opsReceivedAt,
    purchaseOrderNumber,
    opsReceivedByUid: data.opsReceivedByUid ?? markedByUid ?? null,
    opsReceivedByName: data.opsReceivedByName ?? markedByName ?? null,
  }, { merge: true });

  const serialAllotment = await applyPurchaseOrderSerialsOnGoodsReceipt({
    goodsReceiptId: id,
    purchaseOrderNumber,
    markedByName,
    serialRanges,
  });

  return {
    alreadyReceived: Boolean(existingReceivedAt),
    status,
    receivedDate,
    opsReceivedAt,
    opsReceivedByUid: data.opsReceivedByUid != null
      ? String(data.opsReceivedByUid)
      : (markedByUid ?? null),
    opsReceivedByName: data.opsReceivedByName != null
      ? String(data.opsReceivedByName)
      : (markedByName ?? null),
    serialAllotment,
  };
}

/**
 * Zoho Purchase Bill webhook — create/edit/delete mirror in Firestore.
 */
function webhookDebugKeys(body, query) {
  const bodyKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 24) : [];
  const queryKeys = query && typeof query === 'object' ? Object.keys(query).slice(0, 16) : [];
  return `bodyKeys=${bodyKeys.join(',') || '-'} queryKeys=${queryKeys.join(',') || '-'}`;
}

export async function handleZohoGoodsReceiptWebhook(secrets, orgId, req) {
  const body = normalizeWebhookBody(req.body ?? {});
  const query = req.query ?? {};
  const billId = extractBillIdFromWebhook(body, query);
  if (!billId) {
    // 400 makes Zoho retry 5× then disable the Bills webhook. ACK and log instead.
    console.warn(
      `Zoho goodsreceipt webhook missing bill_id. ${webhookDebugKeys(body, query)}`,
    );
    return {
      ok: true,
      status: 200,
      action: 'ignored',
      reason: 'missing_bill_id',
    };
  }

  const queryAction = String(query.action ?? '').trim().toLowerCase();
  const event = queryAction || extractWebhookEvent(body);
  if (event.includes('delete')) {
    await deleteGoodsReceiptFromFirestore(billId);
    console.log(`Zoho goodsreceipt webhook deleted ${billId}`);
    return { ok: true, status: 200, action: 'deleted', billId };
  }

  try {
    const blocked = await ackIfDailyQuotaBlocked('goodsreceipt', billId);
    if (blocked) return blocked;
    const result = await mirrorGoodsReceiptFromZoho(secrets, orgId, billId);
    console.log(
      `Zoho goodsreceipt webhook ${result?.dropped ? 'dropped' : 'synced'} ${billId}`
      + (result?.dropReason ? ` reason=${result.dropReason}` : '')
      + (result?.goodsReceiptCategory ? ` category=${result.goodsReceiptCategory}` : ''),
    );
    return {
      ok: true,
      status: 200,
      action: result?.dropped ? 'dropped' : 'synced',
      billId,
      result,
    };
  } catch (err) {
    const ack = await ackZohoWebhookFailure('goodsreceipt', billId, err);
    if (ack) return ack;
    throw err;
  }
}
