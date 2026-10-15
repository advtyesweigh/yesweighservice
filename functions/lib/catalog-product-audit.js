import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAccessToken, resolveOrganizationId, fetchProductDetail } from './zoho.js';

const YES_STORE_ITEMS = 'yesStoreItems';
const CATALOG_SITE_INVENTORY = 'catalogSiteInventory';
const PRODUCTS_COLLECTION = 'catalogProducts';
const META_DOC = 'catalogMeta/sync';

/** Invalidate the client catalog list cache after auditSnapshot / stock writes. */
async function bumpCatalogContentChange() {
  await getFirestore().doc(META_DOC).set({
    lastContentChangeAt: new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

function readItemQuantity(item) {
  const qty = Number(item?.quantity ?? 0);
  return Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0;
}

function readLinkMode(item) {
  return item?.catalogLinkMode === 'part' ? 'part' : 'unit';
}

function readUnitsPerProduct(item) {
  const value = Number(item?.unitsPerProduct ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function groupUsesBundleMode(items) {
  return items.some(item => readLinkMode(item) === 'part');
}

function computeHeadOfficeTotals(items) {
  const bundle = groupUsesBundleMode(items);

  if (!bundle) {
    const countedQty = items.reduce((sum, item) => sum + readItemQuantity(item), 0);
    return { mode: 'unit', countedQty, rawCountedQty: countedQty };
  }

  const parts = items.map(item => {
    const countedQty = readItemQuantity(item);
    const unitsPerProduct = readUnitsPerProduct(item);
    return Math.floor(countedQty / unitsPerProduct);
  });
  const countedQty = parts.length ? Math.min(...parts) : 0;
  const rawCountedQty = items.reduce((sum, item) => sum + readItemQuantity(item), 0);
  return { mode: 'bundle', countedQty, rawCountedQty };
}

function readCochinQuantity(data) {
  if (!data) return 0;
  const locations = Array.isArray(data.locations) ? data.locations : [];
  if (locations.length) {
    return locations.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row?.quantity ?? 0))), 0);
  }
  return Math.max(0, Math.floor(Number(data.quantity ?? 0)));
}

async function listYesStoreItemsByCatalogProduct(catalogProductId) {
  const db = getFirestore();
  const snap = await db.collection(YES_STORE_ITEMS)
    .where('catalogProductId', '==', String(catalogProductId).trim())
    .limit(200)
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function readCochinInventory(catalogProductId) {
  const db = getFirestore();
  const docId = `${String(catalogProductId).trim()}_cochin`;
  const snap = await db.collection(CATALOG_SITE_INVENTORY).doc(docId).get();
  return snap.exists ? snap.data() : null;
}

function mapLatestLog(doc) {
  if (!doc?.exists) return null;
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    physicalQty: Number(data.physicalQty ?? 0),
    zohoQtyAtAudit: Number(data.zohoQtyAtAudit ?? 0),
    headOfficeQty: Number(data.headOfficeQty ?? 0),
    cochinQty: Number(data.cochinQty ?? 0),
    trigger: data.trigger ?? null,
    sourceGoodsReceiptId: data.sourceGoodsReceiptId != null
      ? String(data.sourceGoodsReceiptId)
      : null,
    baselineDifference: Number(
      data.baselineDifference ?? (Number(data.physicalQty ?? 0) - Number(data.zohoQtyAtAudit ?? 0)),
    ),
    pendingZohoInbound: Number(data.pendingZohoInbound ?? 0),
    mode: data.mode === 'bundle' ? 'bundle' : 'unit',
  };
}

function readFiniteQty(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clampInboundQty(value) {
  const n = readFiniteQty(value, 0);
  return Math.max(-1_000_000, Math.min(1_000_000, n));
}

const DEFAULT_WAREHOUSE_COUNTED_BY_NAME = 'Diya';

function readItemCountedAt(item) {
  const countedAt = String(item?.countedAt ?? '').trim();
  if (countedAt) return countedAt;
  return String(item?.createdAt ?? item?.updatedAt ?? '').trim();
}

function readItemCountedByName(item) {
  const name = String(item?.countedByName ?? '').trim();
  return name || DEFAULT_WAREHOUSE_COUNTED_BY_NAME;
}

function resolveLegacyAuditor(items, cochinData) {
  let bestAt = '';
  let uid = null;
  let name = null;

  for (const item of items) {
    const at = readItemCountedAt(item);
    if (!at || at <= bestAt) continue;
    bestAt = at;
    uid = item.countedByUid ?? null;
    name = readItemCountedByName(item);
  }

  const cochinAt = String(cochinData?.updatedAt ?? '').trim();
  if (cochinAt && cochinAt > bestAt) {
    bestAt = cochinAt;
    uid = cochinData.updatedByUid ?? null;
    name = String(cochinData.updatedByName ?? '').trim() || null;
  }

  return {
    auditedAt: bestAt || new Date().toISOString(),
    uid,
    name,
  };
}

const PHYSICAL_TRIGGERS = new Set(['warehouse_count', 'cochin_inventory', 'manual', 'legacy_backfill']);
const BACKDATE_FUTURE_SLACK_MS = 60_000;
const BACKDATE_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'invalid-argument';
  return err;
}

function resolveAuditedAt(requested, allowBackdate) {
  const now = new Date();
  if (!allowBackdate || !requested) return now.toISOString();
  const parsed = new Date(requested);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidArgument('Invalid received datetime.');
  }
  if (parsed.getTime() > now.getTime() + BACKDATE_FUTURE_SLACK_MS) {
    throw invalidArgument('Received datetime cannot be in the future.');
  }
  if (parsed.getTime() < now.getTime() - BACKDATE_MAX_AGE_MS) {
    throw invalidArgument('Received datetime is too far in the past.');
  }
  return parsed.toISOString();
}

function buildAuditSnapshot(prior, entry) {
  const {
    logId,
    auditedAt,
    auditedByUid,
    auditedByName,
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    zohoQtyAtAudit,
    baselineDifference,
    pendingZohoInbound,
    trigger,
    auditCycleId,
  } = entry;
  const isPhysical = PHYSICAL_TRIGGERS.has(trigger);
  const prev = prior && typeof prior === 'object' ? prior : {};
  const nextHeadOfficeCycleId = isPhysical
    ? (
      trigger === 'warehouse_count'
        ? (auditCycleId ?? prev.lastHeadOfficeAuditCycleId ?? null)
        : (trigger === 'manual' || trigger === 'legacy_backfill') && Number(headOfficeQty) > 0
          ? (auditCycleId ?? prev.lastHeadOfficeAuditCycleId ?? null)
          : (prev.lastHeadOfficeAuditCycleId ?? null)
    )
    : (prev.lastHeadOfficeAuditCycleId ?? null);
  const nextCochinCycleId = isPhysical
    ? (
      trigger === 'cochin_inventory'
        ? (auditCycleId ?? prev.lastCochinAuditCycleId ?? null)
        : (trigger === 'manual' || trigger === 'legacy_backfill') && Number(cochinQty) > 0
          ? (auditCycleId ?? prev.lastCochinAuditCycleId ?? null)
          : (prev.lastCochinAuditCycleId ?? null)
    )
    : (prev.lastCochinAuditCycleId ?? null);

  return {
    lastAuditLogId: logId,
    lastAuditedAt: isPhysical ? auditedAt : (prev.lastAuditedAt ?? auditedAt),
    lastAuditedByUid: isPhysical ? (auditedByUid ?? null) : (prev.lastAuditedByUid ?? null),
    lastAuditedByName: isPhysical ? (auditedByName ?? null) : (prev.lastAuditedByName ?? null),
    baselineDifference,
    // Physical counts rewrite audited qty. Zoho sync moves audited with Zoho to keep Diff locked.
    physicalQtyAtAudit: (isPhysical || trigger === 'zoho_sync')
      ? physicalQty
      : Number(prev.physicalQtyAtAudit ?? physicalQty),
    zohoQtyAtAudit,
    mode,
    // Site breakdown stays at last physical count (not shifted by Zoho sync).
    headOfficeQtyAtAudit: isPhysical
      ? headOfficeQty
      : Number(prev.headOfficeQtyAtAudit ?? headOfficeQty),
    cochinQtyAtAudit: isPhysical
      ? cochinQty
      : Number(prev.cochinQtyAtAudit ?? cochinQty),
    lastPhysicalAuditedAt: isPhysical
      ? auditedAt
      : (prev.lastPhysicalAuditedAt ?? prev.lastAuditedAt ?? null),
    lastPhysicalAuditedByUid: isPhysical
      ? (auditedByUid ?? null)
      : (prev.lastPhysicalAuditedByUid ?? prev.lastAuditedByUid ?? null),
    lastPhysicalAuditedByName: isPhysical
      ? (auditedByName ?? null)
      : (prev.lastPhysicalAuditedByName ?? prev.lastAuditedByName ?? null),
    lastAuditCycleId: isPhysical
      ? (auditCycleId ?? prev.lastAuditCycleId ?? null)
      : (prev.lastAuditCycleId ?? null),
    lastHeadOfficeAuditCycleId: nextHeadOfficeCycleId,
    lastCochinAuditCycleId: nextCochinCycleId,
    pendingZohoInbound: pendingZohoInbound != null
      ? Number(pendingZohoInbound)
      : Number(prev.pendingZohoInbound ?? 0),
  };
}

async function writeCatalogProductAuditEntry(productRef, entry) {
  const {
    auditedAt,
    auditedByUid,
    auditedByName,
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    rawPhysicalQty,
    zohoQtyAtAudit,
    baselineDifference,
    pendingZohoInbound,
    trigger,
    logId,
    auditCycleId,
    existingSnapshot,
    skipSnapshot,
    sourceGoodsReceiptId,
  } = entry;

  const logRef = logId
    ? productRef.collection('auditLogs').doc(logId)
    : productRef.collection('auditLogs').doc();

  const log = {
    id: logRef.id,
    catalogProductId: productRef.id,
    auditedAt,
    auditedByUid: auditedByUid ?? null,
    auditedByName: auditedByName ?? null,
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    rawPhysicalQty: rawPhysicalQty ?? null,
    zohoQtyAtAudit,
    baselineDifference,
    trigger,
    auditCycleId: auditCycleId ?? null,
  };
  if (sourceGoodsReceiptId) {
    log.sourceGoodsReceiptId = String(sourceGoodsReceiptId);
  }
  if (pendingZohoInbound != null && Number.isFinite(Number(pendingZohoInbound))) {
    log.pendingZohoInbound = Number(pendingZohoInbound);
  }

  const snapshot = buildAuditSnapshot(existingSnapshot, {
    logId: logRef.id,
    auditedAt,
    auditedByUid,
    auditedByName,
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    zohoQtyAtAudit,
    baselineDifference,
    pendingZohoInbound,
    trigger,
    auditCycleId,
  });

  await logRef.set(log);
  if (!skipSnapshot) {
    await Promise.all([
      productRef.set({ auditSnapshot: snapshot }, { merge: true }),
      bumpCatalogContentChange(),
    ]);
  }

  return { log, snapshot };
}

async function resolveLastLogAtOrBefore(productRef, auditedAtIso, excludeSourceGoodsReceiptId) {
  const snap = await productRef.collection('auditLogs')
    .where('auditedAt', '<=', auditedAtIso)
    .orderBy('auditedAt', 'desc')
    .limit(20)
    .get();
  const exclude = excludeSourceGoodsReceiptId ? String(excludeSourceGoodsReceiptId) : '';
  for (const doc of snap.docs) {
    const mapped = mapLatestLog(doc);
    if (!mapped) continue;
    if (exclude && mapped.sourceGoodsReceiptId === exclude) continue;
    return mapped;
  }
  return null;
}

async function findLogsForGoodsReceipt(productRef, goodsReceiptId) {
  const id = String(goodsReceiptId ?? '').trim();
  if (!id) return [];
  const snap = await productRef.collection('auditLogs')
    .where('sourceGoodsReceiptId', '==', id)
    .get();
  return snap.docs;
}

async function rewriteLaterZohoSyncLogs(productRef, {
  afterIso,
  baselineDifference,
  cochinQty,
  headOfficeQty,
  mode,
  previousZohoQty,
  pendingZohoInbound,
  skipSourceGoodsReceiptId,
}) {
  const snap = await productRef.collection('auditLogs')
    .orderBy('auditedAt', 'asc')
    .get();
  const skipSource = skipSourceGoodsReceiptId ? String(skipSourceGoodsReceiptId) : '';
  const updates = [];
  let runningDiff = Number(baselineDifference);
  let runningPending = Number(pendingZohoInbound ?? 0);
  if (!Number.isFinite(runningPending) || runningPending < 0) runningPending = 0;
  let prevZoho = Number(previousZohoQty);
  if (!Number.isFinite(prevZoho)) prevZoho = 0;
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    const at = String(data.auditedAt ?? '');
    if (!at || at <= afterIso) continue;
    const sourceId = data.sourceGoodsReceiptId != null ? String(data.sourceGoodsReceiptId) : '';
    if (skipSource && sourceId === skipSource) continue;
    if (PHYSICAL_TRIGGERS.has(data.trigger)) {
      const warehouse = Number(data.headOfficeQty ?? 0) + Number(data.cochinQty ?? 0);
      const lockedWarehouse = Number(headOfficeQty) + Number(cochinQty);
      if (warehouse !== lockedWarehouse) break;
      const zoho = Number(data.zohoQtyAtAudit ?? 0);
      const nextZoho = Number.isFinite(zoho) ? zoho : 0;
      const next = nextAuditStateAfterZohoChange(prevZoho, nextZoho, runningDiff, runningPending);
      runningDiff = next.baselineDifference;
      runningPending = next.pendingZohoInbound;
      prevZoho = nextZoho;
      updates.push({
        ref: doc.ref,
        payload: {
          baselineDifference: runningDiff,
          pendingZohoInbound: runningPending,
          cochinQty,
          headOfficeQty,
          mode,
          physicalQty: nextZoho + runningDiff,
        },
      });
      continue;
    }
    if (data.trigger !== 'zoho_sync') continue;
    const zoho = Number(data.zohoQtyAtAudit ?? 0);
    const nextZoho = Number.isFinite(zoho) ? zoho : 0;
    const next = nextAuditStateAfterZohoChange(prevZoho, nextZoho, runningDiff, runningPending);
    runningDiff = next.baselineDifference;
    runningPending = next.pendingZohoInbound;
    prevZoho = nextZoho;
    updates.push({
      ref: doc.ref,
      payload: {
        baselineDifference: runningDiff,
        pendingZohoInbound: runningPending,
        cochinQty,
        headOfficeQty,
        mode,
        physicalQty: nextZoho + runningDiff,
      },
    });
  }

  const db = getFirestore();
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    for (const row of updates.slice(i, i + 400)) {
      batch.update(row.ref, row.payload);
    }
    await batch.commit();
  }
  return updates.length;
}

export async function rebuildProductAuditSnapshot(productRef) {
  const snap = await productRef.collection('auditLogs')
    .orderBy('auditedAt', 'asc')
    .get();
  if (snap.empty) return null;

  let prior = null;
  let snapshot = null;
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    snapshot = buildAuditSnapshot(prior, {
      logId: doc.id,
      auditedAt: data.auditedAt,
      auditedByUid: data.auditedByUid ?? null,
      auditedByName: data.auditedByName ?? null,
      mode: data.mode === 'bundle' ? 'bundle' : 'unit',
      headOfficeQty: Number(data.headOfficeQty ?? 0),
      cochinQty: Number(data.cochinQty ?? 0),
      physicalQty: Number(data.physicalQty ?? 0),
      zohoQtyAtAudit: Number(data.zohoQtyAtAudit ?? 0),
      baselineDifference: Number(data.baselineDifference ?? 0),
      pendingZohoInbound: Number(data.pendingZohoInbound ?? 0),
      trigger: data.trigger,
      auditCycleId: data.auditCycleId ?? null,
    });
    prior = snapshot;
  }
  await Promise.all([
    productRef.set({ auditSnapshot: snapshot }, { merge: true }),
    bumpCatalogContentChange(),
  ]);
  return snapshot;
}

/**
 * Sales keep Diff, including a shortage. Zoho stock falling does not close it.
 * Goods-receipt inbound is pending until it posts in Zoho; that consume leaves
 * the prior locked variance (e.g. +3 NC after a 30 receive).
 * Unsolicited Zoho inbound does not eat the locked Diff — only pending qty does.
 */
export function nextAuditStateAfterZohoChange(
  previousZohoQty,
  nextZohoQty,
  lockedDiff,
  pendingInbound = 0,
) {
  const prev = Number(previousZohoQty);
  const next = Number(nextZohoQty);
  const diff = Number(lockedDiff);
  let pending = Number(pendingInbound);
  if (!Number.isFinite(pending) || pending < 0) pending = 0;
  if (!Number.isFinite(prev) || !Number.isFinite(next) || !Number.isFinite(diff)) {
    return { baselineDifference: diff, pendingZohoInbound: pending };
  }
  const delta = next - prev;
  if (delta > 0 && pending > 0) {
    const consumed = Math.min(delta, pending);
    return {
      baselineDifference: diff - consumed,
      pendingZohoInbound: pending - consumed,
    };
  }
  return { baselineDifference: diff, pendingZohoInbound: pending };
}

export function nextAuditDiffAfterZohoChange(
  previousZohoQty,
  nextZohoQty,
  lockedDiff,
  pendingInbound = 0,
) {
  return nextAuditStateAfterZohoChange(
    previousZohoQty,
    nextZohoQty,
    lockedDiff,
    pendingInbound,
  ).baselineDifference;
}

/**
 * When Zoho stock changes on sync, keep Diff through sales; consume pending
 * receive inbound first so a prior variance (e.g. +3 NC) remains.
 */
export function buildZohoSyncAuditAdjustment(existingSnapshot, previousZohoQty, nextZohoQty, auditedAt) {
  if (!existingSnapshot || existingSnapshot.baselineDifference == null) return null;

  const prevZoho = Number(previousZohoQty);
  const nextZoho = Number(nextZohoQty);
  if (!Number.isFinite(prevZoho) || !Number.isFinite(nextZoho)) return null;
  if (prevZoho === nextZoho) return null;

  const lockedDiff = Number(existingSnapshot.baselineDifference);
  if (!Number.isFinite(lockedDiff)) return null;

  const next = nextAuditStateAfterZohoChange(
    prevZoho,
    nextZoho,
    lockedDiff,
    existingSnapshot.pendingZohoInbound,
  );
  const physicalQty = nextZoho + next.baselineDifference;
  const mode = existingSnapshot.mode === 'bundle' ? 'bundle' : 'unit';
  const headOfficeQty = Number(existingSnapshot.headOfficeQtyAtAudit ?? 0);
  const cochinQty = Number(existingSnapshot.cochinQtyAtAudit ?? 0);
  const at = auditedAt || new Date().toISOString();

  return {
    auditedAt: at,
    auditedByUid: null,
    auditedByName: 'Zoho sync',
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    rawPhysicalQty: null,
    zohoQtyAtAudit: nextZoho,
    baselineDifference: next.baselineDifference,
    pendingZohoInbound: next.pendingZohoInbound,
    trigger: 'zoho_sync',
    existingSnapshot,
  };
}

export async function writeZohoSyncAuditEntry(productRef, existingSnapshot, previousZohoQty, nextZohoQty, auditedAt) {
  const entry = buildZohoSyncAuditAdjustment(
    existingSnapshot,
    previousZohoQty,
    nextZohoQty,
    auditedAt,
  );
  if (!entry) return null;
  return writeCatalogProductAuditEntry(productRef, {
    ...entry,
    existingSnapshot,
  });
}

async function collectAuditCandidateProductIds() {
  const db = getFirestore();
  const ids = new Set();

  const itemsSnap = await db.collection(YES_STORE_ITEMS).get();
  for (const doc of itemsSnap.docs) {
    const id = String(doc.data()?.catalogProductId ?? '').trim();
    if (id) ids.add(id);
  }

  const siteSnap = await db.collection(CATALOG_SITE_INVENTORY).get();
  for (const doc of siteSnap.docs) {
    if (doc.id.endsWith('_cochin')) {
      ids.add(doc.id.slice(0, -'_cochin'.length));
      continue;
    }
    if (doc.id.endsWith('_head_office')) {
      ids.add(doc.id.slice(0, -'_head_office'.length));
    }
  }

  return [...ids];
}

/**
 * One-time migration: turn existing warehouse bin counts + Cochin site stock into
 * auditLogs + auditSnapshot so the drift-adjusted display works after deploy.
 * Uses cached catalogProducts.stock as zohoQtyAtAudit (what the app showed).
 */
export async function backfillLegacyCatalogProductAudits(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const onlyMissing = options.onlyMissing !== false;

  const db = getFirestore();
  const productIds = await collectAuditCandidateProductIds();

  const itemsByProduct = new Map();
  const itemsSnap = await db.collection(YES_STORE_ITEMS).get();
  for (const doc of itemsSnap.docs) {
    const data = doc.data() ?? {};
    const id = String(data.catalogProductId ?? '').trim();
    if (!id) continue;
    const list = itemsByProduct.get(id) ?? [];
    list.push({ id: doc.id, ...data });
    itemsByProduct.set(id, list);
  }

  const cochinByProduct = new Map();
  const headOfficeSiteByProduct = new Map();
  const siteSnap = await db.collection(CATALOG_SITE_INVENTORY).get();
  for (const doc of siteSnap.docs) {
    if (doc.id.endsWith('_cochin')) {
      cochinByProduct.set(doc.id.slice(0, -'_cochin'.length), doc.data() ?? {});
      continue;
    }
    if (doc.id.endsWith('_head_office')) {
      headOfficeSiteByProduct.set(doc.id.slice(0, -'_head_office'.length), doc.data() ?? {});
    }
  }

  const summary = {
    dryRun,
    candidates: productIds.length,
    created: 0,
    skippedHasSnapshot: 0,
    skippedNoProduct: 0,
    skippedNoData: 0,
    errors: [],
    samples: [],
  };

  for (const productId of productIds) {
    try {
      const productRef = db.collection(PRODUCTS_COLLECTION).doc(productId);
      const productSnap = await productRef.get();
      if (!productSnap.exists) {
        summary.skippedNoProduct += 1;
        continue;
      }

      const productData = productSnap.data() ?? {};
      if (onlyMissing && productData.auditSnapshot) {
        summary.skippedHasSnapshot += 1;
        continue;
      }

      const items = itemsByProduct.get(productId) ?? [];
      const cochinData = cochinByProduct.get(productId) ?? null;
      const headOfficeSite = headOfficeSiteByProduct.get(productId) ?? null;
      if (!items.length && !cochinData && !headOfficeSite) {
        summary.skippedNoData += 1;
        continue;
      }

      const headOffice = items.length
        ? computeHeadOfficeTotals(items)
        : {
          mode: 'unit',
          countedQty: readCochinQuantity(headOfficeSite),
          rawCountedQty: readCochinQuantity(headOfficeSite),
        };
      const cochinQty = readCochinQuantity(cochinData);
      const physicalQty = headOffice.countedQty + cochinQty;
      const zohoQtyAtAudit = Number(productData.stock ?? 0);
      const baselineDifference = physicalQty - zohoQtyAtAudit;
      const auditor = resolveLegacyAuditor(items, cochinData || headOfficeSite);

      const entry = {
        auditedAt: auditor.auditedAt,
        auditedByUid: auditor.uid,
        auditedByName: auditor.name,
        mode: headOffice.mode,
        headOfficeQty: headOffice.countedQty,
        cochinQty,
        physicalQty,
        rawPhysicalQty: headOffice.mode === 'bundle' ? headOffice.rawCountedQty : null,
        zohoQtyAtAudit,
        baselineDifference,
        trigger: 'legacy_backfill',
      };

      if (dryRun) {
        summary.created += 1;
        if (summary.samples.length < 5) {
          summary.samples.push({
            productId,
            physicalQty,
            zohoQtyAtAudit,
            baselineDifference,
            auditedAt: entry.auditedAt,
          });
        }
        continue;
      }

      await writeCatalogProductAuditEntry(productRef, entry);
      summary.created += 1;
      if (summary.samples.length < 5) {
        summary.samples.push({
          productId,
          physicalQty,
          zohoQtyAtAudit,
          baselineDifference,
          auditedAt: entry.auditedAt,
        });
      }
    } catch (err) {
      summary.errors.push({
        productId,
        message: err?.message ?? String(err),
      });
    }
  }

  return summary;
}

export async function recordCatalogProductAudit(
  secrets,
  configuredOrgId,
  catalogProductId,
  options = {},
) {
  const id = String(catalogProductId ?? '').trim();
  if (!id) throw new Error('catalogProductId is required.');

  const trigger = options.trigger ?? 'manual';
  const editor = options.editor ?? {};

  const db = getFirestore();
  const productRef = db.collection(PRODUCTS_COLLECTION).doc(id);
  const productSnap = await productRef.get();
  const existingSnapshot = productSnap.exists
    ? (productSnap.data()?.auditSnapshot ?? null)
    : null;
  const cachedZohoQty = Number(productSnap.exists ? (productSnap.data()?.stock ?? 0) : 0);

  // Physical counts must not depend on a live Zoho item GET. Zoho often
  // answers "You are not authorized to perform this operation" even when
  // locations already saved in Firestore.
  let liveZohoQty = cachedZohoQty;
  try {
    const accessToken = await getAccessToken(secrets);
    const organizationId = await resolveOrganizationId(accessToken, configuredOrgId);
    const zohoDetail = await fetchProductDetail(accessToken, organizationId, id);
    liveZohoQty = Number(zohoDetail.stock ?? 0);
  } catch (err) {
    console.warn(
      'recordCatalogProductAudit: Zoho stock fetch failed, using cached catalog stock:',
      err?.message ?? err,
    );
  }

  const [items, cochinData] = await Promise.all([
    listYesStoreItemsByCatalogProduct(id),
    readCochinInventory(id),
  ]);

  const headOffice = computeHeadOfficeTotals(items);
  const liveCochinQty = readCochinQuantity(cochinData);
  const incomingZohoQty = clampInboundQty(options.incomingZohoQty);
  const cochinInboundQty = options.cochinInboundQty == null
    ? null
    : clampInboundQty(options.cochinInboundQty);
  const sourceGoodsReceiptId = String(options.sourceGoodsReceiptId ?? '').trim() || null;
  const inboundQty = options.inboundQty != null
    ? clampInboundQty(options.inboundQty)
    : (cochinInboundQty != null
      ? cochinInboundQty
      : (sourceGoodsReceiptId && incomingZohoQty > 0 ? incomingZohoQty : null));
  const inboundAlreadyInZoho = options.inboundAlreadyInZoho === true;
  const auditedAt = resolveAuditedAt(options.auditedAt, options.allowBackdate === true);

  let resolvedCycleId = options.auditCycleId
    ? String(options.auditCycleId).trim() || null
    : null;

  // Physical site counts require an open cycle for that site (manual may omit).
  if (trigger === 'warehouse_count' || trigger === 'cochin_inventory') {
    const site = trigger === 'warehouse_count' ? 'head_office' : 'cochin';
    const openSnap = await db.collection('auditCycles')
      .where('status', '==', 'open')
      .limit(10)
      .get();
    const openDoc = openSnap.docs.find(d => d.data()?.site === site);
    if (!openDoc) {
      const err = new Error(
        `No open audit cycle for ${site === 'head_office' ? 'Head Office' : 'Cochin'}. Counting is locked.`,
      );
      err.code = 'failed-precondition';
      throw err;
    }
    const openCycleId = openDoc.id;
    if (resolvedCycleId && resolvedCycleId !== openCycleId) {
      const err = new Error('auditCycleId does not match the open cycle for this site.');
      err.code = 'failed-precondition';
      throw err;
    }
    resolvedCycleId = openCycleId;
  }

  const existingSourceDocs = sourceGoodsReceiptId
    ? await findLogsForGoodsReceipt(productRef, sourceGoodsReceiptId)
    : [];
  existingSourceDocs.sort((a, b) => (
    String(b.data()?.auditedAt ?? '').localeCompare(String(a.data()?.auditedAt ?? ''))
  ));
  const reuseLogId = existingSourceDocs[0]?.id ?? null;
  const extraSourceDocs = existingSourceDocs.slice(1);

  const laterSnap = await productRef.collection('auditLogs')
    .where('auditedAt', '>', auditedAt)
    .orderBy('auditedAt', 'asc')
    .limit(25)
    .get();
  const hasLaterLogs = laterSnap.docs.some((doc) => {
    const sourceId = doc.data()?.sourceGoodsReceiptId != null
      ? String(doc.data().sourceGoodsReceiptId)
      : '';
    return !sourceGoodsReceiptId || sourceId !== sourceGoodsReceiptId;
  });

  const priorAtT = hasLaterLogs || inboundQty != null
    ? await resolveLastLogAtOrBefore(productRef, auditedAt, sourceGoodsReceiptId)
    : null;

  const useHistoricalSites = Boolean(hasLaterLogs && priorAtT && cochinInboundQty != null);
  const headOfficeQty = useHistoricalSites
    ? priorAtT.headOfficeQty
    : headOffice.countedQty;
  const cochinQty = useHistoricalSites
    ? Math.max(0, priorAtT.cochinQty + cochinInboundQty)
    : liveCochinQty;
  let physicalQty = headOfficeQty + cochinQty;
  const zohoQtyAtAudit = (hasLaterLogs && priorAtT)
    ? priorAtT.zohoQtyAtAudit
    : (hasLaterLogs ? 0 : liveZohoQty);
  let baselineDifference = physicalQty - zohoQtyAtAudit;
  let pendingZohoInbound = 0;
  const lastWarehouse = Number(existingSnapshot?.headOfficeQtyAtAudit ?? 0)
    + Number(existingSnapshot?.cochinQtyAtAudit ?? 0);
  if (sourceGoodsReceiptId && inboundQty != null) {
    const snapshotDiff = existingSnapshot && Number.isFinite(Number(existingSnapshot.baselineDifference))
      ? Number(existingSnapshot.baselineDifference)
      : 0;
    const priorDiff = priorAtT && Number.isFinite(Number(priorAtT.baselineDifference))
      ? Number(priorAtT.baselineDifference)
      : snapshotDiff;
    if (inboundAlreadyInZoho) {
      pendingZohoInbound = 0;
      baselineDifference = priorDiff;
    } else {
      pendingZohoInbound = Math.max(0, Number(inboundQty) || 0);
      baselineDifference = priorDiff + pendingZohoInbound;
    }
    physicalQty = zohoQtyAtAudit + baselineDifference;
  } else if (
    trigger === 'manual'
    && existingSnapshot
    && existingSnapshot.baselineDifference != null
    && lastWarehouse === physicalQty
  ) {
    const locked = Number(existingSnapshot.baselineDifference);
    if (Number.isFinite(locked)) {
      const prevZoho = Number(existingSnapshot.zohoQtyAtAudit ?? zohoQtyAtAudit);
      const next = nextAuditStateAfterZohoChange(
        prevZoho,
        zohoQtyAtAudit,
        locked,
        existingSnapshot.pendingZohoInbound,
      );
      baselineDifference = next.baselineDifference;
      pendingZohoInbound = next.pendingZohoInbound;
      physicalQty = zohoQtyAtAudit + baselineDifference;
    }
  }
  const mode = useHistoricalSites ? priorAtT.mode : headOffice.mode;
  const rawPhysicalQty = useHistoricalSites
    ? null
    : (headOffice.mode === 'bundle' ? headOffice.rawCountedQty : null);

  const latestSnap = await productRef.collection('auditLogs')
    .orderBy('auditedAt', 'desc')
    .limit(1)
    .get();
  const latest = mapLatestLog(latestSnap.docs[0]);
  const latestCycleId = latestSnap.docs[0]
    ? (latestSnap.docs[0].data()?.auditCycleId ?? null)
    : null;
  const latestIsThisReceipt = Boolean(
    sourceGoodsReceiptId
    && latest?.sourceGoodsReceiptId === sourceGoodsReceiptId,
  );
  if (
    !hasLaterLogs
    && !latestIsThisReceipt
    && latest
    && latest.physicalQty === physicalQty
    && latest.zohoQtyAtAudit === zohoQtyAtAudit
    && latest.headOfficeQty === headOfficeQty
    && latest.cochinQty === cochinQty
    && (latestCycleId ?? null) === (resolvedCycleId ?? null)
  ) {
    const existing = latestSnap.docs[0].data() ?? {};
    return {
      skipped: true,
      log: { id: latestSnap.docs[0].id, catalogProductId: id, ...existing },
      snapshot: existingSnapshot,
    };
  }

  const logRef = reuseLogId
    ? productRef.collection('auditLogs').doc(reuseLogId)
    : productRef.collection('auditLogs').doc();
  const result = await writeCatalogProductAuditEntry(productRef, {
    auditedAt,
    auditedByUid: editor.uid ?? null,
    auditedByName: editor.displayName ?? null,
    mode,
    headOfficeQty,
    cochinQty,
    physicalQty,
    rawPhysicalQty,
    zohoQtyAtAudit,
    baselineDifference,
    pendingZohoInbound,
    trigger,
    logId: logRef.id,
    auditCycleId: resolvedCycleId,
    existingSnapshot,
    skipSnapshot: hasLaterLogs,
    sourceGoodsReceiptId,
  });

  for (const extra of extraSourceDocs) {
    await extra.ref.delete().catch(() => {});
  }

  if (hasLaterLogs) {
    await rewriteLaterZohoSyncLogs(productRef, {
      afterIso: auditedAt,
      baselineDifference,
      cochinQty,
      headOfficeQty,
      mode,
      previousZohoQty: zohoQtyAtAudit,
      pendingZohoInbound,
      skipSourceGoodsReceiptId: sourceGoodsReceiptId,
    });
    const snapshot = await rebuildProductAuditSnapshot(productRef);
    return { skipped: false, log: result.log, snapshot: snapshot ?? result.snapshot };
  }

  return { skipped: false, log: result.log, snapshot: result.snapshot };
}

export async function listCatalogProductAuditLogs(catalogProductId, max = 20) {
  const id = String(catalogProductId ?? '').trim();
  if (!id) throw new Error('catalogProductId is required.');

  const snap = await getFirestore()
    .collection(PRODUCTS_COLLECTION)
    .doc(id)
    .collection('auditLogs')
    .orderBy('auditedAt', 'desc')
    .limit(Math.min(Math.max(max, 1), 50))
    .get();

  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * Products that still have auditSnapshot after log cleanup, but an empty
 * auditLogs subcollection — recreate a matching log (and refresh snapshot).
 */
export async function repairSnapshotsMissingAuditLogs(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const db = getFirestore();
  const summary = {
    dryRun,
    scanned: 0,
    repaired: 0,
    skippedHasLogs: 0,
    skippedNoSnapshot: 0,
    errors: [],
    samples: [],
  };

  const productsSnap = await db.collection(PRODUCTS_COLLECTION).get();
  for (const doc of productsSnap.docs) {
    const data = doc.data() ?? {};
    const snapshot = data.auditSnapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      summary.skippedNoSnapshot += 1;
      continue;
    }
    summary.scanned += 1;

    try {
      const logsSnap = await doc.ref.collection('auditLogs').limit(1).get();
      if (!logsSnap.empty) {
        summary.skippedHasLogs += 1;
        continue;
      }

      const physicalQty = Number(snapshot.physicalQtyAtAudit ?? 0);
      const zohoQtyAtAudit = Number(snapshot.zohoQtyAtAudit ?? data.stock ?? 0);
      const headOfficeQty = Number(snapshot.headOfficeQtyAtAudit ?? 0);
      const cochinQty = Number(snapshot.cochinQtyAtAudit ?? 0);
      const baselineDifference = Number.isFinite(Number(snapshot.baselineDifference))
        ? Number(snapshot.baselineDifference)
        : physicalQty - zohoQtyAtAudit;
      const auditedAt = String(
        snapshot.lastPhysicalAuditedAt
        || snapshot.lastAuditedAt
        || new Date().toISOString(),
      );
      let auditedByName = String(
        snapshot.lastPhysicalAuditedByName
        || snapshot.lastAuditedByName
        || '',
      ).trim();
      if (!auditedByName || /reset after clearing/i.test(auditedByName)) {
        auditedByName = 'Legacy backfill';
      }
      const auditedByUid = snapshot.lastPhysicalAuditedByUid
        ?? snapshot.lastAuditedByUid
        ?? null;
      const preferredLogId = String(snapshot.lastAuditLogId ?? '').trim() || null;

      const entry = {
        auditedAt,
        auditedByUid,
        auditedByName,
        mode: snapshot.mode === 'bundle' ? 'bundle' : 'unit',
        headOfficeQty,
        cochinQty,
        physicalQty,
        rawPhysicalQty: null,
        zohoQtyAtAudit,
        baselineDifference,
        trigger: 'legacy_backfill',
        logId: preferredLogId,
        auditCycleId: snapshot.lastAuditCycleId
          ?? snapshot.lastHeadOfficeAuditCycleId
          ?? snapshot.lastCochinAuditCycleId
          ?? null,
        existingSnapshot: snapshot,
      };

      if (dryRun) {
        summary.repaired += 1;
        if (summary.samples.length < 8) {
          summary.samples.push({
            productId: doc.id,
            sku: data.sku ?? null,
            physicalQty,
            zohoQtyAtAudit,
            baselineDifference,
            logId: preferredLogId,
          });
        }
        continue;
      }

      await writeCatalogProductAuditEntry(doc.ref, entry);
      summary.repaired += 1;
      if (summary.samples.length < 8) {
        summary.samples.push({
          productId: doc.id,
          sku: data.sku ?? null,
          physicalQty,
          zohoQtyAtAudit,
          baselineDifference,
          logId: preferredLogId,
        });
      }
    } catch (err) {
      summary.errors.push({
        productId: doc.id,
        message: err?.message ?? String(err),
      });
    }
  }

  return summary;
}
