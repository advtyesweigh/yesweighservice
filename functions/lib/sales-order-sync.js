/**
 * Zoho Inventory sales orders → Firestore mirror (org-wide, customer-scoped fields).
 * Pattern mirrors invoice-sync / org-invoice-sync, but docs live at salesOrders/{id}.
 */
import { getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE } from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
  fetchZohoOrgApiUsage,
} from './zoho-api-usage.js';
import {
  classifyInvoiceCategoryBreakdown,
  classifyInvoiceFromLineItems,
  parseInvoiceCategory,
  sumNonFreightQuantity,
} from './invoice-category.js';
import { parseOrderSegment, segmentToInvoiceCategory } from './sales-order-segments.js';
import { freightSkuFromInvoiceLines } from './freight-lines.js';
import { reconcileSalesOrderStats } from './sales-order-stats.js';
import { resolveZohoCustomerIdForUser } from './zoho-invoices.js';
import { formatZohoAddress } from './zoho-contact-fields.js';
import { isDealerAdminStaff } from './dealer-staff-team.js';
import { extractWebhookEvent, normalizeWebhookBody } from './invoice-sync.js';
import { ackZohoWebhookFailure, ackIfDailyQuotaBlocked } from './zoho-webhook-guard.js';
import { HttpsError } from 'firebase-functions/v2/https';

const COLLECTION = 'salesOrders';
const META_DOC = 'salesOrderMeta/orgSync';
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

function soCollection() {
  return getFirestore().collection(COLLECTION);
}

function orgSyncRef() {
  return getFirestore().doc(META_DOC);
}

function pdfPath(soId) {
  return `salesorders/${soId}.pdf`;
}

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

function bufferLooksLikeZohoDenied(buffer) {
  const sample = buffer.subarray(0, 4096).toString('utf8');
  return /access denied|not authorized to perform this operation/i.test(sample);
}

function zohoPdfDeniedMessage(rawMessage) {
  const msg = String(rawMessage ?? '').trim();
  if (/access denied|not authorized/i.test(msg)) {
    return (
      'Zoho could not print this sales order PDF (Access Denied). '
      + 'The order is saved — go back for line items. Software orders use Cloud Charges and are not warehouse-stocked; Zoho often blocks the PDF for those.'
    );
  }
  return msg || 'Could not download sales order PDF.';
}

async function zohoJsonRequest(accessToken, orgId, path) {
  const url = new URL(`${ZOHO_API_BASE}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }
  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  await recordZohoApiResponse(res, { operation: path, source: 'sales-order-sync' });
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
    await recordZohoApiFailure(err, { operation: path, source: 'sales-order-sync' });
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
        await recordZohoApiFailure(err, { operation: label, source: 'sales-order-sync' }).catch(() => {});
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

async function fetchSalesOrdersListPage(accessToken, orgId, page, options = {}) {
  const url = new URL(`${ZOHO_API_BASE}/salesorders`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '200');
  url.searchParams.set('sort_column', options.sortColumn ?? 'last_modified_time');
  url.searchParams.set('sort_order', options.sortOrder ?? 'D');
  if (options.customerId) url.searchParams.set('customer_id', String(options.customerId));

  const res = await fetch(url.toString(), { headers: authHeaders(accessToken, orgId) });
  await recordZohoApiResponse(res, { operation: `salesorders/list?page=${page}`, source: 'sales-order-sync' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = classifyZohoHttpError(res.status, payload);
    await recordZohoApiFailure(err, { operation: `salesorders/list?page=${page}`, source: 'sales-order-sync' });
    throw err;
  }
  return {
    salesOrders: payload?.salesorders ?? [],
    hasMore: Boolean(payload?.page_context?.has_more_page),
  };
}

async function fetchSalesOrderRaw(accessToken, orgId, soId) {
  const payload = await zohoJsonRequest(accessToken, orgId, `/salesorders/${soId}`);
  return payload?.salesorder ?? null;
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
    doc.salesOrderNumber,
    doc.customerName,
    doc.customerId,
    doc.referenceNumber,
    doc.status,
    ...(doc.lineItems || []).flatMap(line => [line.name, line.sku]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function catalogImageUrlFromData(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.imageUrl) return String(data.imageUrl);
  if (Array.isArray(data.imageUrls) && data.imageUrls[0]) return String(data.imageUrls[0]);
  return null;
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
        imageUrl: catalogImageUrlFromData(data),
        hsn: data.hsn != null ? String(data.hsn) : null,
        categoryId: data.categoryId != null ? String(data.categoryId) : null,
        categoryName: data.categoryName != null ? String(data.categoryName) : null,
      });
    }
  }
  return map;
}

function attachCatalogImages(lineItems, catalog) {
  if (!Array.isArray(lineItems) || !lineItems.length) return lineItems || [];
  return lineItems.map(line => {
    if (line?.imageUrl || !line?.itemId) return line;
    const imageUrl = catalog.get(String(line.itemId))?.imageUrl ?? null;
    return imageUrl ? { ...line, imageUrl } : line;
  });
}

function mapSalesOrder(raw) {
  const lineItems = Array.isArray(raw.line_items)
    ? raw.line_items.map(mapLineItem)
    : [];
  return {
    id: String(raw.salesorder_id ?? ''),
    salesOrderNumber: String(raw.salesorder_number ?? ''),
    date: raw.date ? String(raw.date) : null,
    createdTime: raw.created_time ? String(raw.created_time) : (raw.createdTime ? String(raw.createdTime) : null),
    shipmentDate: raw.shipment_date ? String(raw.shipment_date) : null,
    status: String(raw.status ?? 'draft'),
    total: Number(raw.total ?? 0),
    balance: Number(raw.balance ?? raw.total ?? 0),
    referenceNumber: raw.reference_number ? String(raw.reference_number) : null,
    currencyCode: String(raw.currency_code ?? 'INR'),
    customerId: raw.customer_id != null ? String(raw.customer_id) : '',
    customerName: raw.customer_name ? String(raw.customer_name) : null,
    salespersonId: raw.salesperson_id != null && String(raw.salesperson_id).trim()
      ? String(raw.salesperson_id).trim()
      : null,
    salespersonName: raw.salesperson_name ? String(raw.salesperson_name).trim() || null : null,
    shippingAddress: formatZohoAddress(raw.shipping_address) ?? null,
    shippingPhone: String(raw.shipping_address?.phone || '').trim() || null,
    billingPhone: String(raw.billing_address?.phone || '').trim() || null,
    shippingAddressId: raw.shipping_address_id != null
      ? String(raw.shipping_address_id)
      : (raw.shipping_address?.address_id != null
        ? String(raw.shipping_address.address_id)
        : null),
    subtotal: Number(raw.sub_total ?? raw.subtotal ?? 0),
    taxTotal: Number(raw.tax_total ?? 0),
    notes: raw.notes ? String(raw.notes) : null,
    lineItems,
    zohoLastModified: raw.last_modified_time ? String(raw.last_modified_time) : null,
  };
}

async function upsertSalesOrderFromRaw(raw, options = {}) {
  const mapped = mapSalesOrder(raw);
  if (!mapped.id) throw new Error('Missing salesorder_id.');
  if (!mapped.shippingPhone) delete mapped.shippingPhone;
  if (!mapped.billingPhone) delete mapped.billingPhone;

  const catalog = await loadCatalogMeta(mapped.lineItems.map(line => line.itemId).filter(Boolean));
  mapped.lineItems = attachCatalogImages(mapped.lineItems, catalog);
  const categoryBreakdown = classifyInvoiceCategoryBreakdown(mapped.lineItems, catalog);
  let salesOrderCategory = categoryBreakdown.categories[0]
    ?? classifyInvoiceFromLineItems(mapped.lineItems, catalog);
  let categories = categoryBreakdown.categories;
  let categoryAmounts = categoryBreakdown.categoryAmounts;

  const ref = soCollection().doc(mapped.id);
  const beforeSnap = await ref.get();
  const before = beforeSnap.exists ? { id: beforeSnap.id, ...(beforeSnap.data() || {}) } : null;
  const forcedSegment = parseOrderSegment(before?.yesOneOrderSegment)
    || parseOrderSegment(options.orderSegment);
  if (forcedSegment) {
    const forced = segmentToInvoiceCategory(forcedSegment);
    salesOrderCategory = forced;
    categories = [forced];
    categoryAmounts = { [forced]: Number(mapped.total ?? 0) };
  }

  const now = Timestamp.now();
  const doc = {
    ...mapped,
    searchBlob: buildSearchBlob(mapped),
    salesOrderCategory,
    categories,
    categoryAmounts,
    freightSku: freightSkuFromInvoiceLines(mapped.lineItems),
    itemQuantity: sumNonFreightQuantity(mapped.lineItems),
    syncedAt: now,
    contentFingerprint: `${mapped.zohoLastModified}|${mapped.lineItems.length}|${mapped.total}`,
  };

  await ref.set(doc, { merge: true });
  await reconcileSalesOrderStats(before, { id: mapped.id, ...doc });
  return { id: mapped.id, salesOrderCategory };
}

function detailStillValid(existing, summary) {
  if (!existing) return false;
  if (!Array.isArray(existing.lineItems) || existing.lineItems.length === 0) return false;
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

export async function getOrgSalesOrderSyncStatus() {
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
      const err = new Error('Sales order sync is already running.');
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
  const refs = summaries.map(s => soCollection().doc(String(s.salesorder_id)));
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

export async function countOrgSalesOrdersInRange(secrets, orgId) {
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  let page = 1;
  let totalInRange = 0;
  let pulledCount = 0;
  let hasMore = true;

  while (hasMore && page <= ORG_SYNC_MAX_LIST_PAGES) {
    const list = await zohoCallWithRetry(
      () => fetchSalesOrdersListPage(accessToken, organizationId, page, LIST_SORT),
      `SO count list page ${page}`,
    );
    totalInRange += list.salesOrders.length;
    pulledCount += await batchHasStoredDetail(list.salesOrders);
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

export async function syncOrgSalesOrdersToFirestore(secrets, orgId, options = {}) {
  const source = options.source ?? 'org-so-sync';
  let priorMeta;
  try {
    priorMeta = await beginOrgSyncRun();
  } catch (err) {
    if (err?.code === 'ALREADY_RUNNING') throw err;
    throw err;
  }

  console.log(
    `Org SO sync started (${source}): checkpoint page ${priorMeta.checkpointPage ?? 1} `
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
        `Scheduled SO sync API budget: ${apiBudget.toLocaleString()} calls `
        + `(keeping ${Math.round(quotaReserveRatio * 100)}% / `
        + `${reserveRemaining.toLocaleString()} of ${usage.dailyLimit.toLocaleString()} daily quota).`,
      );
      if (apiBudget <= 0) {
        quotaReserved = true;
        console.log('Scheduled SO sync skipped — daily quota already at or below the 30% reserve.');
      }
    }

    const processSummary = async summary => {
      if (shouldStopForQuota()) {
        quotaReserved = true;
        return { synced: 0, unchanged: 0, failed: 0, skipped: 0, newlyPulled: 0, rateLimited: false, stopQuota: true };
      }

      const soId = String(summary.salesorder_id ?? '');
      if (!soId) {
        return { synced: 0, unchanged: 0, failed: 0, skipped: 1, newlyPulled: 0, rateLimited: false };
      }

      const existingSnap = await soCollection().doc(soId).get();
      const existing = existingSnap.exists ? existingSnap.data() : null;
      if (detailStillValid(existing, summary)) {
        return { synced: 1, unchanged: 1, failed: 0, skipped: 0, newlyPulled: 0, rateLimited: false };
      }

      let fullRaw;
      try {
        fullRaw = await zohoCallWithRetry(
          () => fetchSalesOrderRaw(accessToken, organizationId, soId),
          `SO ${soId}`,
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
        await upsertSalesOrderFromRaw(fullRaw);
        await sleep(DETAIL_PULL_DELAY_MS);
        return { synced: 1, unchanged: 0, failed: 0, skipped: 0, newlyPulled: 1, rateLimited: false };
      } catch (err) {
        console.warn('Org SO sync item failed:', err?.message ?? err);
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
          () => fetchSalesOrdersListPage(accessToken, organizationId, page, LIST_SORT),
          `SO list page ${page}`,
        );
        trackZohoCall();
      } catch (err) {
        if (err?.code === 'RATE_LIMITED') {
          rateLimited = true;
          break;
        }
        throw err;
      }

      const slice = list.salesOrders.slice(index);
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
        console.log(`Org SO sync progress: ${newlyPulled} newly pulled this run.`);
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
    console.error('Org SO sync failed:', err?.message ?? err);
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
      ? `Scheduled sync stopped to preserve ${Math.round((quotaReserveRatio || SCHEDULED_API_QUOTA_RESERVE_RATIO) * 100)}% of today's Zoho API quota for daytime use. Resume with Pull now or wait for the next 4 AM run.`
      : completed
        ? 'All sales orders are synced.'
        : 'Sales order sync paused.';

  console.log(
    `Org SO sync finished (${source}): status=${completed ? 'complete' : 'idle'}, `
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

export async function reclassifySalesOrderCategoriesFromCatalog(options = {}) {
  const limit = Math.min(Math.max(Number(options.batchSize ?? 500) || 500, 50), 2000);
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  const counts = { product: 0, spare: 0, service: 0, software_key: 0, gatc: 0 };

  let lastDoc = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = soCollection().orderBy('__name__').limit(limit);
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
    const pendingStats = [];

    for (const docSnap of snap.docs) {
      scanned += 1;
      const data = docSnap.data() || {};
      const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
      const breakdown = classifyInvoiceCategoryBreakdown(lines, catalog);
      const next = breakdown.categories[0] ?? classifyInvoiceFromLineItems(lines, catalog);
      counts[next] = (counts[next] || 0) + 1;
      const current = parseInvoiceCategory(data.salesOrderCategory);
      const sameCategories = JSON.stringify(data.categories ?? []) === JSON.stringify(breakdown.categories);
      const sameAmounts = JSON.stringify(data.categoryAmounts ?? {}) === JSON.stringify(breakdown.categoryAmounts);
      if (current === next && sameCategories && sameAmounts) {
        unchanged += 1;
        continue;
      }
      const after = {
        ...data,
        salesOrderCategory: next,
        categories: breakdown.categories,
        categoryAmounts: breakdown.categoryAmounts,
      };
      batch.update(docSnap.ref, {
        salesOrderCategory: next,
        categories: breakdown.categories,
        categoryAmounts: breakdown.categoryAmounts,
      });
      batchWrites += 1;
      updated += 1;
      pendingStats.push({
        before: { id: docSnap.id, ...data },
        after: { id: docSnap.id, ...after },
      });
    }
    if (batchWrites) await batch.commit();
    for (const entry of pendingStats) {
      await reconcileSalesOrderStats(entry.before, entry.after);
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < limit) break;
  }

  return { scanned, updated, unchanged, counts };
}

export async function ensureSalesOrderPdf(secrets, orgId, soId) {
  const id = String(soId || '').trim();
  if (!id) throw new Error('Sales order id is required.');
  const ref = soCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Sales order not found.');
  const data = snap.data() || {};
  const path = data.pdfStoragePath || pdfPath(id);
  const file = storageBucket().file(path);
  const [exists] = await file.exists();
  if (exists) {
    const [buf] = await file.download();
    if (isPdfBuffer(buf) && !bufferLooksLikeZohoDenied(buf)) {
      return {
        contentBase64: buf.toString('base64'),
        filename: `${data.salesOrderNumber || id}.pdf`,
        mimeType: 'application/pdf',
      };
    }
    await file.delete().catch(() => {});
    await ref.set({ pdfStoragePath: FieldValue.delete() }, { merge: true }).catch(() => {});
  }

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const url = new URL(`${ZOHO_API_BASE}/salesorders/${id}`);
  url.searchParams.set('organization_id', organizationId);
  url.searchParams.set('accept', 'pdf');
  const res = await fetch(url.toString(), {
    headers: {
      ...authHeaders(accessToken, organizationId),
      Accept: 'application/pdf',
    },
  });
  await recordZohoApiResponse(res, { operation: `salesorders/${id}/pdf`, source: 'sales-order-sync' });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !isPdfBuffer(buffer) || bufferLooksLikeZohoDenied(buffer)) {
    let message = `Could not download sales order PDF (${res.status}).`;
    try {
      const payload = JSON.parse(buffer.toString('utf8'));
      if (payload?.message) message = String(payload.message);
    } catch {
      if (bufferLooksLikeZohoDenied(buffer)) message = 'Access Denied';
    }
    throw new Error(zohoPdfDeniedMessage(message));
  }
  await file.save(buffer, { resumable: false, contentType: 'application/pdf' });
  await ref.set({ pdfStoragePath: path }, { merge: true });
  return {
    contentBase64: buffer.toString('base64'),
    filename: `${data.salesOrderNumber || id}.pdf`,
    mimeType: 'application/pdf',
  };
}

export function mapSalesOrderDoc(id, data) {
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const dateRaw = data.date;
  const date = dateRaw == null
    ? null
    : (typeof dateRaw === 'string'
      ? dateRaw
      : (dateRaw?.toDate?.()?.toISOString?.()?.slice(0, 10) ?? String(dateRaw)));
  const yesOneStage = data.yesOneStage ? String(data.yesOneStage) : null;
  return {
    id,
    salesOrderNumber: String(data.salesOrderNumber ?? ''),
    date,
    createdTime: data.createdTime
      ? String(data.createdTime)
      : (data.zohoLastModified ? String(data.zohoLastModified) : null),
    shipmentDate: data.shipmentDate ?? null,
    status: String(data.status ?? 'draft'),
    total: Number(data.total ?? 0),
    balance: Number(data.balance ?? 0),
    referenceNumber: data.referenceNumber ?? null,
    currencyCode: String(data.currencyCode ?? 'INR'),
    customerId: String(data.customerId ?? ''),
    customerName: data.customerName ?? null,
    salespersonId: data.salespersonId ? String(data.salespersonId) : null,
    salespersonName: data.salespersonName ? String(data.salespersonName) : null,
    shippingAddress: data.shippingAddress ? String(data.shippingAddress) : null,
    shippingAddressId: data.shippingAddressId ? String(data.shippingAddressId) : null,
    shippingPhone: data.shippingPhone ? String(data.shippingPhone) : null,
    billingPhone: data.billingPhone ? String(data.billingPhone) : null,
    subtotal: Number(data.subtotal ?? 0),
    taxTotal: Number(data.taxTotal ?? 0),
    notes: data.notes ?? null,
    lineItems,
    salesOrderCategory: parseInvoiceCategory(data.salesOrderCategory),
    freightSku: data.freightSku
      ? String(data.freightSku).trim().toUpperCase() || null
      : freightSkuFromInvoiceLines(lineItems),
    categories: Array.isArray(data.categories) ? data.categories.map(String) : [],
    categoryAmounts: data.categoryAmounts && typeof data.categoryAmounts === 'object'
      ? { ...data.categoryAmounts }
      : {},
    itemQuantity: lineItems.length
      ? sumNonFreightQuantity(lineItems)
      : (data.itemQuantity != null ? Number(data.itemQuantity) : null),
    syncedAt: data.syncedAt?.toDate?.()?.toISOString?.()
      ?? (typeof data.syncedAt === 'string' ? data.syncedAt : null),
    searchBlob: data.searchBlob ?? '',
    pdfStoragePath: data.pdfStoragePath ?? null,
    yesOneStage,
    yesOneOrderSegment: (() => {
      const segment = String(data.yesOneOrderSegment ?? '').trim().toLowerCase();
      return segment === 'product' || segment === 'spare' || segment === 'software'
        ? segment
        : null;
    })(),
    yesOneInventorySite: (() => {
      const site = String(data.yesOneInventorySite ?? '').trim().toLowerCase();
      return site === 'cochin' || site === 'head_office' ? site : null;
    })(),
    yesOneBranchLabel: data.yesOneBranchLabel ? String(data.yesOneBranchLabel) : null,
    zohoLocationId: data.zohoLocationId ? String(data.zohoLocationId) : null,
    yesOnePriceCustomized: Boolean(data.yesOnePriceCustomized),
    paymentAmount: data.paymentAmount != null ? Number(data.paymentAmount) : null,
    paymentUtr: data.paymentUtr ?? null,
    paymentNotes: data.paymentNotes ? String(data.paymentNotes) : null,
    paymentScreenshotStoragePath: data.paymentScreenshotStoragePath
      ? String(data.paymentScreenshotStoragePath)
      : null,
    paymentScreenshotUrl: data.paymentScreenshotUrl
      ? String(data.paymentScreenshotUrl)
      : null,
    dealerCustomerInvoice: data.dealerCustomerInvoice && typeof data.dealerCustomerInvoice === 'object'
      ? {
        storagePath: String(data.dealerCustomerInvoice.storagePath || ''),
        url: String(data.dealerCustomerInvoice.url || ''),
        fileName: String(data.dealerCustomerInvoice.fileName || 'dealer-invoice.pdf'),
        uploadedAt: data.dealerCustomerInvoice.uploadedAt
          ? String(data.dealerCustomerInvoice.uploadedAt)
          : null,
        uploadedByUid: data.dealerCustomerInvoice.uploadedByUid
          ? String(data.dealerCustomerInvoice.uploadedByUid)
          : null,
        uploadedByName: data.dealerCustomerInvoice.uploadedByName
          ? String(data.dealerCustomerInvoice.uploadedByName)
          : null,
      }
      : null,
    paymentSubmittedAt: data.paymentSubmittedAt ?? null,
    paymentVerifiedAt: data.paymentVerifiedAt ?? null,
    readyForPaymentAt: data.readyForPaymentAt ?? null,
    zohoInvoiceId: data.zohoInvoiceId ?? null,
    zohoInvoiceNumber: data.zohoInvoiceNumber ?? null,
    yesOneCreatedFromCart: Boolean(data.yesOneCreatedFromCart),
    yesOneCreatedByUid: data.yesOneCreatedByUid ? String(data.yesOneCreatedByUid) : null,
    yesOneDealerStaffUid: data.yesOneDealerStaffUid ? String(data.yesOneDealerStaffUid) : null,
  };
}

/** List payload without heavy line items. */
function mapSalesOrderListRow(id, data) {
  const full = mapSalesOrderDoc(id, data);
  return {
    id: full.id,
    salesOrderNumber: full.salesOrderNumber,
    date: full.date,
    createdTime: full.createdTime,
    shipmentDate: full.shipmentDate,
    status: full.status,
    total: full.total,
    balance: full.balance,
    referenceNumber: full.referenceNumber,
    currencyCode: full.currencyCode,
    customerId: full.customerId,
    customerName: full.customerName,
    salesOrderCategory: full.salesOrderCategory,
    categories: full.categories,
    categoryAmounts: full.categoryAmounts,
    itemQuantity: full.itemQuantity,
    syncedAt: full.syncedAt,
    yesOneStage: full.yesOneStage,
    yesOnePriceCustomized: full.yesOnePriceCustomized,
    yesOneCreatedFromCart: full.yesOneCreatedFromCart,
    yesOneCreatedByUid: full.yesOneCreatedByUid,
    yesOneDealerStaffUid: full.yesOneDealerStaffUid,
    zohoInvoiceId: full.zohoInvoiceId,
    zohoInvoiceNumber: full.zohoInvoiceNumber,
  };
}

/** Pull one SO from Zoho into Firestore (used after portal approve). */
export async function mirrorSalesOrderFromZoho(secrets, orgId, salesOrderId, options = {}) {
  const id = String(salesOrderId ?? '').trim();
  if (!id) throw new Error('salesOrderId is required.');
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const raw = await fetchSalesOrderRaw(accessToken, organizationId, id);
  if (!raw) throw new Error('Sales order not found in Zoho.');
  return upsertSalesOrderFromRaw(raw, options);
}

/**
 * Customer-scoped SO pull (dealer invoices equivalent). Bounded for callable timeouts.
 */
export async function syncDealerSalesOrdersToFirestore(secrets, orgId, customerId, options = {}) {
  const cid = String(customerId ?? '').trim();
  if (!cid) throw new Error('customerId is required.');

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const maxPages = Math.min(Math.max(Number(options.maxPages ?? 3) || 3, 1), 10);
  const maxDetails = Math.min(Math.max(Number(options.maxDetails ?? 60) || 60, 1), 200);

  const summaries = [];
  let page = 1;
  while (page <= maxPages) {
    const batch = await fetchSalesOrdersListPage(accessToken, organizationId, page, {
      customerId: cid,
      sortColumn: 'date',
      sortOrder: 'D',
    });
    summaries.push(...(batch.salesOrders || []));
    if (!batch.hasMore) break;
    page += 1;
    await sleep(LIST_PAGE_DELAY_MS);
  }

  const toPull = summaries.slice(0, maxDetails);
  let synced = 0;
  let failed = 0;
  let unchanged = 0;

  await mapConcurrent(toPull, ORG_SYNC_CONCURRENCY, async summary => {
    const soId = String(summary?.salesorder_id ?? '').trim();
    if (!soId) return;
    try {
      const existingSnap = await soCollection().doc(soId).get();
      if (detailStillValid(existingSnap.data(), summary)) {
        unchanged += 1;
        return;
      }
      const raw = await zohoCallWithRetry(
        () => fetchSalesOrderRaw(accessToken, organizationId, soId),
        `salesorders/${soId}`,
      );
      if (!raw) {
        failed += 1;
        return;
      }
      await upsertSalesOrderFromRaw(raw);
      synced += 1;
      await sleep(DETAIL_PULL_DELAY_MS);
    } catch (err) {
      failed += 1;
      console.warn(`Dealer SO sync failed for ${soId}:`, err?.message ?? err);
    }
  });

  await getFirestore().doc(`salesOrderMeta/dealerSync_${cid}`).set({
    customerId: cid,
    lastSyncedAt: Timestamp.now(),
    listed: summaries.length,
    synced,
    failed,
    unchanged,
  }, { merge: true });

  return {
    customerId: cid,
    listed: summaries.length,
    synced,
    failed,
    unchanged,
  };
}

/**
 * Admin-style fetch: page through this customer's salesOrders newest-first.
 * Avoids the old single-shot limit(400) that returned an arbitrary/old slice.
 */
async function queryDealerSalesOrdersFromFirestore(customerId, options = {}) {
  const dateStart = options.dateStart ? String(options.dateStart).slice(0, 10) : '';
  const dateEnd = options.dateEnd ? String(options.dateEnd).slice(0, 10) : '';
  const pageSize = Math.min(Math.max(Number(options.pageSize ?? 200) || 200, 50), 300);
  const maxRows = Math.min(Math.max(Number(options.maxRows ?? 2500) || 2500, 1), 5000);

  const mapDocs = snap => snap.docs.map(
    docSnap => mapSalesOrderListRow(docSnap.id, docSnap.data() || {}),
  );

  const pageOrdered = async () => {
    const rows = [];
    let lastDoc = null;
    while (rows.length < maxRows) {
      let q = soCollection().where('customerId', '==', String(customerId));
      if (dateStart) q = q.where('date', '>=', dateStart);
      if (dateEnd) q = q.where('date', '<=', dateEnd);
      q = q.orderBy('date', 'desc').limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      rows.push(...mapDocs(snap));
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
    return rows.slice(0, maxRows);
  };

  /** Equality-only pages (no date index) → sort/filter in memory. */
  const pageUnordered = async () => {
    const rows = [];
    let lastDoc = null;
    while (rows.length < maxRows) {
      let q = soCollection()
        .where('customerId', '==', String(customerId))
        .limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      rows.push(...mapDocs(snap));
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
    let sorted = sortSalesOrderRows(rows);
    if (dateStart || dateEnd) {
      sorted = sorted.filter(row => {
        const d = String(row.date ?? '');
        if (!d) return false;
        if (dateStart && d < dateStart) return false;
        if (dateEnd && d > dateEnd) return false;
        return true;
      });
    }
    return sorted.slice(0, maxRows);
  };

  try {
    return await pageOrdered();
  } catch (err) {
    const msg = String(err?.message ?? err ?? '');
    if (!/index|FAILED_PRECONDITION/i.test(msg) && err?.code !== 9) throw err;
    console.warn(
      `Dealer SO ordered query unavailable for ${customerId}, paging unordered fallback:`,
      msg.slice(0, 180),
    );
    return pageUnordered();
  }
}

function sortSalesOrderRows(rows) {
  return [...rows].sort((a, b) => {
    const aTs = salesOrderDateTimeMs(a);
    const bTs = salesOrderDateTimeMs(b);
    if (aTs !== bTs) return bTs - aTs;
    return String(b.syncedAt ?? '').localeCompare(String(a.syncedAt ?? ''));
  });
}

function salesOrderDateTimeMs(row) {
  const created = row.createdTime != null ? String(row.createdTime).trim() : '';
  if (created && !/^\d{4}-\d{2}-\d{2}$/.test(created)) {
    const parsed = Date.parse(created);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const date = String(row.date ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function salesOrderVisibleToDealerStaff(row, uid) {
  const staffUid = String(row?.yesOneDealerStaffUid ?? '').trim();
  const createdBy = String(row?.yesOneCreatedByUid ?? '').trim();
  return staffUid === uid || createdBy === uid;
}

async function dealerStaffSeesAllSalesOrders(uid, role) {
  if (role !== 'dealer_staff') return true;
  const snap = await getFirestore().doc(`users/${uid}`).get();
  return isDealerAdminStaff({ role, data: snap.data() || {} });
}

/**
 * Dealer / dealer_staff: list Zoho sales orders for their linked customer.
 * Mirrors admin visibility: date-ordered pagination for the customer (no 400-cap slice).
 */
export async function listDealerSalesOrders(uid, role, query = {}, context = {}) {
  const customerId = await resolveZohoCustomerIdForUser(uid, role);
  if (!customerId) {
    throw new HttpsError('failed-precondition', 'No Zoho customer is linked to this account.');
  }
  const secrets = context.secrets;
  const orgId = context.orgId;
  const dateStart = query.dateStart ? String(query.dateStart).slice(0, 10) : '';
  const dateEnd = query.dateEnd ? String(query.dateEnd).slice(0, 10) : '';
  const maxRows = Math.min(Math.max(Number(query.limit ?? query.maxRows ?? 2500) || 2500, 1), 5000);
  const rangeOpts = {
    dateStart: dateStart || undefined,
    dateEnd: dateEnd || undefined,
    maxRows,
  };

  let rows = await queryDealerSalesOrdersFromFirestore(customerId, rangeOpts);

  // Firestore empty for this customer → pull from Zoho (throttled).
  if (rows.length === 0 && secrets && orgId) {
    const metaSnap = await getFirestore().doc(`salesOrderMeta/dealerSync_${customerId}`).get();
    const lastMs = metaSnap.data()?.lastSyncedAt?.toMillis?.() ?? 0;
    const stale = Date.now() - lastMs > 10 * 60 * 1000;
    if (stale) {
      try {
        console.log(`Dealer SO lazy sync for customer ${customerId}`);
        await syncDealerSalesOrdersToFirestore(secrets, orgId, customerId, {
          maxPages: 5,
          maxDetails: 120,
        });
        rows = await queryDealerSalesOrdersFromFirestore(customerId, rangeOpts);
      } catch (err) {
        console.warn('Dealer SO lazy sync failed:', err?.message ?? err);
      }
    }
  }

  if (role === 'dealer_staff' && !(await dealerStaffSeesAllSalesOrders(uid, role))) {
    rows = rows.filter(row => salesOrderVisibleToDealerStaff(row, uid));
  }

  const payload = sortSalesOrderRows(rows).slice(0, maxRows);
  console.log(
    `listDealerSalesOrders uid=${uid} customer=${customerId} `
    + `rows=${payload.length} newestDate=${payload[0]?.date ?? 'none'} `
    + `oldestDate=${payload[payload.length - 1]?.date ?? 'none'} `
    + `range=${dateStart || '…'}..${dateEnd || '…'}`,
  );

  return {
    salesOrders: payload,
    data: payload,
    customerId: String(customerId),
    truncated: rows.length > maxRows,
  };
}

async function shippingAddressFromCustomer(customerId) {
  const id = String(customerId ?? '').trim();
  if (!id) return null;
  const snap = await getFirestore().collection('zohoCustomers').doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  // Shipping first, then billing — never invent from district/ZIP alone.
  const formatted = data.zohoShippingAddress
    || data.shippingAddress
    || formatZohoAddress(data.zohoShippingAddressRaw)
    || data.zohoBillingAddress
    || data.billingAddress
    || formatZohoAddress(data.zohoBillingAddressRaw);
  return formatted ? String(formatted) : null;
}

/** Prefer SO shipping address; fall back to customer record. */
export async function withResolvedShippingAddress(mapped) {
  if (!mapped || mapped.shippingAddress) return mapped;
  const fallback = await shippingAddressFromCustomer(mapped.customerId);
  if (!fallback) return mapped;
  return { ...mapped, shippingAddress: fallback };
}

/** Fill missing line-item imageUrl from catalogProducts (for live detail responses). */
export async function withCatalogLineImages(mapped) {
  if (!mapped || !Array.isArray(mapped.lineItems) || !mapped.lineItems.length) return mapped;
  const missing = mapped.lineItems.filter(line => !line?.imageUrl && line?.itemId);
  if (!missing.length) return mapped;
  const catalog = await loadCatalogMeta(missing.map(line => line.itemId));
  const lineItems = attachCatalogImages(mapped.lineItems, catalog);
  if (lineItems === mapped.lineItems) return mapped;
  return { ...mapped, lineItems };
}

/** Dealer / dealer_staff: load one sales order if it belongs to their customer. */
export async function getDealerSalesOrderDetail(uid, role, salesOrderId) {
  const id = String(salesOrderId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'salesOrderId is required.');

  const customerId = await resolveZohoCustomerIdForUser(uid, role);
  if (!customerId) {
    throw new HttpsError('failed-precondition', 'No Zoho customer is linked to this account.');
  }

  const snap = await soCollection().doc(id).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Sales order not found.');
  }
  const data = snap.data() || {};
  if (String(data.customerId ?? '') !== String(customerId)) {
    throw new HttpsError('permission-denied', 'You do not have access to this sales order.');
  }
  if (role === 'dealer_staff' && !(await dealerStaffSeesAllSalesOrders(uid, role))
    && !salesOrderVisibleToDealerStaff(data, uid)) {
    throw new HttpsError('permission-denied', 'You do not have access to this sales order.');
  }
  const mapped = await withResolvedShippingAddress(mapSalesOrderDoc(snap.id, data));
  return withCatalogLineImages(mapped);
}

/** Ensure dealer owns the SO before serving PDF. */
export async function ensureDealerSalesOrderPdf(secrets, orgId, uid, role, salesOrderId) {
  await getDealerSalesOrderDetail(uid, role, salesOrderId);
  return ensureSalesOrderPdf(secrets, orgId, salesOrderId);
}

export function extractSalesOrderIdFromWebhook(body, query = {}) {
  const normalized = normalizeWebhookBody(body);
  const candidates = [
    query.salesorder_id,
    query.salesOrderId,
    query.id,
    normalized.salesorder_id,
    normalized.salesorderId,
    normalized.sales_order_id,
    normalized.salesorder?.salesorder_id,
    normalized.salesorder?.salesorderId,
    normalized.data?.salesorder_id,
    normalized.payload?.salesorder_id,
    normalized.sales_order?.salesorder_id,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

export async function deleteSalesOrderFromFirestore(salesOrderId) {
  const id = String(salesOrderId ?? '').trim();
  if (!id) return;
  const ref = soCollection().doc(id);
  const beforeSnap = await ref.get();
  if (beforeSnap.exists) {
    await reconcileSalesOrderStats({ id, ...(beforeSnap.data() || {}) }, null);
  }
  await ref.delete().catch(() => {});
}

/**
 * Zoho Sales Order webhook — create/edit/delete mirror in Firestore.
 * Prefer a complete webhook payload (line_items present) to skip a Zoho GET.
 * Quota / 401 ACK 200 and queue retry so Zoho does not disable the webhook.
 */
function extractSalesOrderRawFromWebhook(body) {
  const normalized = normalizeWebhookBody(body);
  const raw = normalized.salesorder
    || normalized.sales_order
    || (normalized.salesorder_id && Array.isArray(normalized.line_items) ? normalized : null);
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.salesorder_id || !Array.isArray(raw.line_items)) return null;
  return raw;
}

export async function handleZohoSalesOrderWebhook(secrets, orgId, req) {
  const body = normalizeWebhookBody(req.body ?? {});
  const salesOrderId = extractSalesOrderIdFromWebhook(body, req.query ?? {});
  if (!salesOrderId) {
    return { ok: false, status: 400, message: 'Missing salesorder_id' };
  }

  const queryAction = String(req.query?.action ?? '').trim().toLowerCase();
  const event = queryAction || extractWebhookEvent(body);
  if (event.includes('delete')) {
    await deleteSalesOrderFromFirestore(salesOrderId);
    return { ok: true, status: 200, action: 'deleted', salesOrderId };
  }

  try {
    const payloadRaw = extractSalesOrderRawFromWebhook(body);
    if (payloadRaw) {
      const result = await upsertSalesOrderFromRaw(payloadRaw);
      return {
        ok: true,
        status: 200,
        action: 'synced',
        salesOrderId,
        source: 'payload',
        result,
      };
    }
    const blocked = await ackIfDailyQuotaBlocked('salesorder', salesOrderId);
    if (blocked) return blocked;
    const result = await mirrorSalesOrderFromZoho(secrets, orgId, salesOrderId);
    return {
      ok: true,
      status: 200,
      action: 'synced',
      salesOrderId,
      result,
    };
  } catch (err) {
    const message = String(err?.message ?? '').toLowerCase();
    const code = String(err?.code ?? err?.zohoCode ?? '').toLowerCase();
    const missingInZoho = (
      code === 'not_found'
      || code === '404'
      || message.includes('not found')
      || message.includes('does not exist')
      || message.includes('invalid salesorder')
      || /(?:^|\D)404(?:\D|$)/.test(message)
      || Number(err?.status) === 404
      || Number(err?.zohoCode) === 5 // Zoho common "resource does not exist"
    );
    if (missingInZoho) {
      await deleteSalesOrderFromFirestore(salesOrderId);
      return {
        ok: true,
        status: 200,
        action: 'deleted',
        salesOrderId,
        reason: 'missing_in_zoho',
      };
    }
    const ack = await ackZohoWebhookFailure('salesorder', salesOrderId, err);
    if (ack) return ack;
    throw err;
  }
}
