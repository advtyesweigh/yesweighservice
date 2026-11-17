/**
 * Assign dealers to portal staff from each dealer's latest usable invoice salespersonId.
 * Wipe legacy portal KAM collection / fields.
 */

import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { loadHiddenZohoSalespersonIds } from './zoho-salespersons.js';

/** Non-person Zoho salespersons — skip when resolving last-invoice ownership. */
export const IGNORED_INVOICE_SALESPERSON_IDS = new Set([
  '99381000004509002', // yescloud server
  '99381000004019936', // Cloud Charges
  '99381000030360028', // GATC SELF
]);

export const IGNORED_INVOICE_SALESPERSON_LABELS = [
  'yescloud server',
  'Cloud Charges',
  'GATC SELF',
];

let hiddenPortalIdsCache = { at: 0, ids: new Set() };
const HIDDEN_PORTAL_IDS_TTL_MS = 30_000;

async function ignoredInvoiceSalespersonIds() {
  const now = Date.now();
  if (now - hiddenPortalIdsCache.at > HIDDEN_PORTAL_IDS_TTL_MS) {
    hiddenPortalIdsCache = {
      at: now,
      ids: await loadHiddenZohoSalespersonIds(),
    };
  }
  const combined = new Set(IGNORED_INVOICE_SALESPERSON_IDS);
  for (const id of hiddenPortalIdsCache.ids) {
    if (id) combined.add(id);
  }
  return combined;
}

/** Persisted snapshot for Dealers → Dealer linking check (super-admin). */
export const DEALER_STAFF_LINKING_CHECK_DOC = 'appSettings/dealerStaffLinkingCheck';

function linkingCheckRef() {
  return getFirestore().doc(DEALER_STAFF_LINKING_CHECK_DOC);
}

function sortUnlockRows(a, b) {
  return b.unassignedDealers - a.unassignedDealers
    || String(a.zohoSalespersonName || '').localeCompare(String(b.zohoSalespersonName || ''));
}

async function readLinkingCheckCache() {
  const snap = await linkingCheckRef().get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function writeLinkingCheckCache(payload) {
  await linkingCheckRef().set({
    ...payload,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: false });
}

/**
 * After claiming one unlock row, drop it from cache and bump summary counters.
 */
async function patchCacheAfterClaim({
  zohoSalespersonId,
  assignedCount,
  staffUid,
  staffName,
  staffEmail = null,
  zohoSalespersonName = null,
}) {
  const cache = await readLinkingCheckCache();
  if (!cache?.summary) return null;

  const unlocks = Array.isArray(cache.unlocks) ? [...cache.unlocks] : [];
  const idx = unlocks.findIndex(row => row.zohoSalespersonId === zohoSalespersonId);
  const removed = idx >= 0 ? unlocks.splice(idx, 1)[0] : null;
  const claimed = Math.max(0, Number(assignedCount) || 0);
  const fromRow = removed ? Number(removed.unassignedDealers) || claimed : claimed;

  const alreadyAssignableBySalesperson = Array.isArray(cache.alreadyAssignableBySalesperson)
    ? [...cache.alreadyAssignableBySalesperson]
    : [];

  const summary = {
    ...cache.summary,
    unassignedDealers: Math.max(0, (Number(cache.summary.unassignedDealers) || 0) - claimed),
    needStaffLink: Math.max(0, (Number(cache.summary.needStaffLink) || 0) - fromRow),
  };

  // Claimed dealers are now assigned — they leave the "ready" pool too if they were listed there.
  const readyIdx = alreadyAssignableBySalesperson.findIndex(
    row => row.zohoSalespersonId === zohoSalespersonId,
  );
  if (readyIdx >= 0) {
    const readyRow = alreadyAssignableBySalesperson[readyIdx];
    const readyCount = Number(readyRow.unassignedDealers) || 0;
    alreadyAssignableBySalesperson.splice(readyIdx, 1);
    summary.alreadyAssignable = Math.max(0, (Number(summary.alreadyAssignable) || 0) - readyCount);
  }

  const next = {
    ...cache,
    status: 'ready',
    ignoredSalespersons: cache.ignoredSalespersons || IGNORED_INVOICE_SALESPERSON_LABELS,
    summary,
    unlocks: unlocks.sort(sortUnlockRows),
    alreadyAssignableBySalesperson: alreadyAssignableBySalesperson.sort(sortUnlockRows),
    noUsableInvoiceDealers: Array.isArray(cache.noUsableInvoiceDealers)
      ? cache.noUsableInvoiceDealers
      : [],
    lastMutation: {
      type: 'claim',
      zohoSalespersonId,
      zohoSalespersonName: zohoSalespersonName || removed?.zohoSalespersonName || null,
      staffUid,
      staffName,
      staffEmail,
      assigned: claimed,
      at: new Date().toISOString(),
    },
  };
  delete next.id;
  await writeLinkingCheckCache(next);
  return next;
}

/**
 * After filling ready-to-assign rows, clear that section from cache.
 */
async function patchCacheAfterFillAssignable({ filled }) {
  const cache = await readLinkingCheckCache();
  if (!cache?.summary) return null;

  const ready = Array.isArray(cache.alreadyAssignableBySalesperson)
    ? cache.alreadyAssignableBySalesperson
    : [];
  const readyCount = ready.reduce((sum, row) => sum + (Number(row.unassignedDealers) || 0), 0);
  const claimed = Math.max(0, Number(filled) || readyCount);

  const next = {
    ...cache,
    status: 'ready',
    ignoredSalespersons: cache.ignoredSalespersons || IGNORED_INVOICE_SALESPERSON_LABELS,
    summary: {
      ...cache.summary,
      unassignedDealers: Math.max(0, (Number(cache.summary.unassignedDealers) || 0) - claimed),
      alreadyAssignable: 0,
    },
    unlocks: Array.isArray(cache.unlocks) ? cache.unlocks : [],
    alreadyAssignableBySalesperson: [],
    noUsableInvoiceDealers: Array.isArray(cache.noUsableInvoiceDealers)
      ? cache.noUsableInvoiceDealers
      : [],
    lastMutation: {
      type: 'fillAssignable',
      assigned: claimed,
      at: new Date().toISOString(),
    },
  };
  delete next.id;
  await writeLinkingCheckCache(next);
  return next;
}

function normalizeZohoLinks(data = {}) {
  const ids = new Set();
  if (Array.isArray(data.zohoSalespersonIds)) {
    for (const id of data.zohoSalespersonIds) {
      const trimmed = String(id ?? '').trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  if (data.zohoSalespersonId) {
    const trimmed = String(data.zohoSalespersonId).trim();
    if (trimmed) ids.add(trimmed);
  }
  if (Array.isArray(data.zohoSalespersonLinks)) {
    for (const link of data.zohoSalespersonLinks) {
      const trimmed = String(link?.id ?? '').trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return [...ids];
}

async function buildSalespersonToStaffMap() {
  const snap = await getFirestore().collection('users').get();
  const map = new Map();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const role = String(data.role ?? '');
    if (role !== 'staff' && role !== 'super_admin') continue;
    if (data.active === false) continue;
    const displayName = String(data.displayName ?? 'Staff').trim() || 'Staff';
    const email = data.email ? String(data.email) : null;
    for (const zohoId of normalizeZohoLinks(data)) {
      if (!map.has(zohoId)) {
        map.set(zohoId, { uid: docSnap.id, displayName, email });
      }
    }
  }
  return map;
}

async function loadSalespersonNames() {
  const snap = await getFirestore().collection('zohoSalespersons').get();
  const map = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    map.set(doc.id, data.name || data.salespersonName || null);
  }
  return map;
}

/**
 * Latest invoice salesperson, skipping ignored placeholders (look back through recent invoices).
 * @returns {Promise<{ id: string, name: string | null } | null>}
 */
export async function latestUsableInvoiceSalesperson(customerId, { lookback = 40 } = {}) {
  const db = getFirestore();
  const customerRef = db.collection('zohoCustomers').doc(customerId);

  const tryQuery = async (subcollection) => {
    const snap = await customerRef
      .collection(subcollection)
      .orderBy('date', 'desc')
      .limit(lookback)
      .get();
    if (snap.empty) return { foundSubcollection: false, match: null };
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const id = data.salespersonId != null ? String(data.salespersonId).trim() : '';
      if (!id) continue;
      if (ignoredIds.has(id)) continue;
      return {
        foundSubcollection: true,
        match: {
          id,
          name: data.salespersonName ? String(data.salespersonName) : null,
        },
      };
    }
    return { foundSubcollection: true, match: null };
  };

  const ignoredIds = await ignoredInvoiceSalespersonIds();

  try {
    const fromSummary = await tryQuery('invoiceSummaries');
    if (fromSummary.match) return fromSummary.match;
    if (fromSummary.foundSubcollection && !fromSummary.match) {
      // Had summaries but all ignored / empty — still try fat invoices.
    }
  } catch {
    // Index / empty — fall through.
  }

  try {
    const fromInvoices = await tryQuery('invoices');
    return fromInvoices.match;
  } catch {
    return null;
  }
}

/** @deprecated Prefer latestUsableInvoiceSalesperson — kept for scripts that imported the old name conceptually. */
export { latestUsableInvoiceSalesperson as latestInvoiceSalespersonResolver };

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

/**
 * @param {{ dryRun?: boolean, onlyFillUnassigned?: boolean, onProgress?: Function }} options
 */
export async function backfillDealerAssignedStaff({
  dryRun = false,
  onlyFillUnassigned = false,
  onProgress,
} = {}) {
  const db = getFirestore();
  const result = {
    dryRun: Boolean(dryRun),
    onlyFillUnassigned: Boolean(onlyFillUnassigned),
    scanned: 0,
    assigned: 0,
    filled: 0,
    unassigned: 0,
    noInvoice: 0,
    unknownSalesperson: 0,
    unchanged: 0,
    skippedAlreadyAssigned: 0,
    usedCache: false,
  };

  let batch = db.batch();
  let batchOps = 0;
  const flush = async () => {
    if (!batchOps || dryRun) {
      batch = db.batch();
      batchOps = 0;
      return;
    }
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  // Fast path: fill from persisted linking-check dealerIds (no invoice re-scan).
  if (onlyFillUnassigned) {
    const cache = await readLinkingCheckCache();
    const readyRows = Array.isArray(cache?.alreadyAssignableBySalesperson)
      ? cache.alreadyAssignableBySalesperson
      : [];
    const plan = [];
    for (const row of readyRows) {
      const staffUid = String(row.linkedStaffUid || '').trim();
      const staffName = String(row.linkedStaffName || 'Staff').trim() || 'Staff';
      const ids = Array.isArray(row.dealerIds) ? row.dealerIds.map(String).filter(Boolean) : [];
      if (!staffUid || !ids.length) continue;
      for (const id of ids) plan.push({ id, staffUid, staffName });
    }

    if (plan.length) {
      result.usedCache = true;
      for (let i = 0; i < plan.length; i += 100) {
        const chunk = plan.slice(i, i + 100);
        const refs = chunk.map(item => db.collection('zohoCustomers').doc(item.id));
        const snaps = await db.getAll(...refs);
        for (let j = 0; j < snaps.length; j += 1) {
          const snap = snaps[j];
          const item = chunk[j];
          result.scanned += 1;
          if (!snap.exists) {
            result.unchanged += 1;
            continue;
          }
          const prevUid = snap.data()?.assignedStaffUid
            ? String(snap.data().assignedStaffUid).trim()
            : '';
          if (prevUid) {
            result.skippedAlreadyAssigned += 1;
            result.unchanged += 1;
            continue;
          }
          if (!dryRun) {
            batch.set(snap.ref, {
              assignedStaffUid: item.staffUid,
              assignedStaffName: item.staffName,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            batchOps += 1;
            if (batchOps >= 400) await flush();
          }
          result.assigned += 1;
          result.filled += 1;
          onProgress?.({
            scanned: result.scanned,
            assigned: result.assigned,
            filled: result.filled,
            unassigned: result.unassigned,
          });
        }
      }
      await flush();
      if (!dryRun) {
        await patchCacheAfterFillAssignable({ filled: result.filled });
      }
      return result;
    }
  }

  const salespersonMap = await buildSalespersonToStaffMap();
  const dealersSnap = await db.collection('zohoCustomers').select(
    'assignedStaffUid',
    'assignedStaffName',
    'companyName',
    'contactName',
  ).get();

  const docs = dealersSnap.docs;
  const resolved = await mapPool(docs, 40, async (dealerDoc) => {
    const prev = dealerDoc.data() || {};
    const prevUid = prev.assignedStaffUid ? String(prev.assignedStaffUid).trim() : '';
    const prevName = prev.assignedStaffName ? String(prev.assignedStaffName) : null;
    if (onlyFillUnassigned && prevUid) {
      return { dealerDoc, skip: 'alreadyAssigned', prevUid, prevName };
    }
    const match = await latestUsableInvoiceSalesperson(dealerDoc.id);
    return { dealerDoc, prevUid, prevName, match, companyName: prev.companyName, contactName: prev.contactName };
  });

  for (const row of resolved) {
    result.scanned += 1;
    if (row.skip === 'alreadyAssigned') {
      result.skippedAlreadyAssigned += 1;
      result.unchanged += 1;
      continue;
    }

    let nextUid = null;
    let nextName = null;

    if (!row.match) {
      result.noInvoice += 1;
    } else {
      const staff = salespersonMap.get(row.match.id);
      if (!staff) {
        result.unknownSalesperson += 1;
      } else {
        nextUid = staff.uid;
        nextName = staff.displayName;
        result.assigned += 1;
      }
    }

    if (!nextUid) result.unassigned += 1;

    if (onlyFillUnassigned && !nextUid) {
      result.unchanged += 1;
      continue;
    }

    const prevUid = row.prevUid || null;
    const prevName = row.prevName || null;
    if (prevUid === nextUid && prevName === nextName) {
      result.unchanged += 1;
      continue;
    }

    if (onlyFillUnassigned && nextUid) {
      result.filled += 1;
    }

    if (!dryRun) {
      batch.set(row.dealerDoc.ref, {
        assignedStaffUid: nextUid,
        assignedStaffName: nextName,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      batchOps += 1;
      if (batchOps >= 400) await flush();
    }

    onProgress?.({
      scanned: result.scanned,
      assigned: result.assigned,
      filled: result.filled,
      unassigned: result.unassigned,
    });
  }

  await flush();
  if (!dryRun && onlyFillUnassigned && result.filled > 0) {
    await patchCacheAfterFillAssignable({ filled: result.filled });
  }
  return result;
}

/**
 * Dry analysis for the super-admin Dealers → Staff linking tab.
 * Persists the snapshot to appSettings/dealerStaffLinkingCheck for realtime UI.
 */
export async function analyzeDealerStaffLinking({ onProgress, runByUid = null } = {}) {
  const db = getFirestore();
  const hiddenIds = await loadHiddenZohoSalespersonIds();
  const ignoredLabels = [
    ...IGNORED_INVOICE_SALESPERSON_LABELS,
    ...(hiddenIds.size ? [`${hiddenIds.size} portal-hidden`] : []),
  ];

  await linkingCheckRef().set({
    status: 'running',
    ignoredSalespersons: ignoredLabels,
    runStartedAt: FieldValue.serverTimestamp(),
    runByUid: runByUid || null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const salespersonMap = await buildSalespersonToStaffMap();
  const spNames = await loadSalespersonNames();
  const dealersSnap = await db.collection('zohoCustomers').select(
    'assignedStaffUid',
    'assignedStaffName',
    'companyName',
    'contactName',
    'cfDealerCode',
    'billingState',
    'billingCity',
  ).get();

  const unlocksBySp = new Map();
  const assignableBySp = new Map();
  const noUsableInvoiceDealers = [];

  let unassignedTotal = 0;
  let alreadyAssignable = 0;
  let needStaffLink = 0;
  let noUsableInvoice = 0;

  const docs = dealersSnap.docs;
  let scanned = 0;

  await mapPool(docs, 40, async (dealerDoc) => {
    const data = dealerDoc.data() || {};
    const prevUid = data.assignedStaffUid ? String(data.assignedStaffUid).trim() : '';
    if (prevUid) {
      scanned += 1;
      onProgress?.({ scanned, total: docs.length });
      return;
    }

    unassignedTotal += 1;
    const match = await latestUsableInvoiceSalesperson(dealerDoc.id);
    scanned += 1;
    onProgress?.({ scanned, total: docs.length });

    if (!match) {
      noUsableInvoice += 1;
      noUsableInvoiceDealers.push({
        id: dealerDoc.id,
        companyName: data.companyName ? String(data.companyName) : null,
        contactName: data.contactName ? String(data.contactName) : null,
        dealerCode: data.cfDealerCode ? String(data.cfDealerCode) : null,
        billingState: data.billingState ? String(data.billingState) : null,
        billingCity: data.billingCity ? String(data.billingCity) : null,
      });
      return;
    }

    const staff = salespersonMap.get(match.id) || null;
    const spName = spNames.get(match.id) || match.name || match.id;

    if (staff) {
      alreadyAssignable += 1;
      const entry = assignableBySp.get(match.id) || {
        zohoSalespersonId: match.id,
        zohoSalespersonName: spName,
        linkedStaffUid: staff.uid,
        linkedStaffName: staff.displayName,
        linkedStaffEmail: staff.email,
        unassignedDealers: 0,
        dealerIds: [],
      };
      entry.unassignedDealers += 1;
      entry.dealerIds.push(dealerDoc.id);
      assignableBySp.set(match.id, entry);
      return;
    }

    needStaffLink += 1;
    const entry = unlocksBySp.get(match.id) || {
      zohoSalespersonId: match.id,
      zohoSalespersonName: spName,
      unassignedDealers: 0,
      dealerIds: [],
    };
    entry.unassignedDealers += 1;
    entry.dealerIds.push(dealerDoc.id);
    unlocksBySp.set(match.id, entry);
  });

  noUsableInvoiceDealers.sort((a, b) =>
    String(a.contactName || a.companyName || a.id)
      .localeCompare(String(b.contactName || b.companyName || b.id)),
  );

  const payload = {
    status: 'ready',
    ignoredSalespersons: ignoredLabels,
    summary: {
      totalDealers: docs.length,
      unassignedDealers: unassignedTotal,
      alreadyAssignable,
      needStaffLink,
      noUsableInvoice,
    },
    unlocks: [...unlocksBySp.values()].sort(sortUnlockRows),
    alreadyAssignableBySalesperson: [...assignableBySp.values()].sort(sortUnlockRows),
    noUsableInvoiceDealers,
    runByUid: runByUid || null,
    runCompletedAt: new Date().toISOString(),
    lastMutation: {
      type: 'fullCheck',
      at: new Date().toISOString(),
    },
  };

  await writeLinkingCheckCache(payload);
  return payload;
}

/**
 * Claim unassigned dealers for a Zoho salesperson onto a portal staff user.
 * Prefer cached dealerIds from the linking check snapshot to avoid invoice re-scans.
 * Also links the Zoho salesperson to that staff for future invoice-based matching.
 */
export async function claimUnassignedDealersForSalesperson({
  zohoSalespersonId,
  zohoSalespersonName = null,
  staffUid,
  onProgress,
} = {}) {
  const spId = String(zohoSalespersonId ?? '').trim();
  const uid = String(staffUid ?? '').trim();
  if (!spId) throw new Error('zohoSalespersonId is required.');
  if (!uid) throw new Error('staffUid is required.');

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new Error('Staff user not found.');
  const userData = userSnap.data() || {};
  const role = String(userData.role ?? '');
  if (role !== 'staff' && role !== 'super_admin') {
    throw new Error('Assigned user must be staff or super admin.');
  }
  if (userData.active === false) throw new Error('Assigned staff is inactive.');

  const displayName = String(userData.displayName ?? 'Staff').trim() || 'Staff';
  const staffEmail = userData.email ? String(userData.email) : null;
  const spName = zohoSalespersonName
    ? String(zohoSalespersonName).trim()
    : ((await loadSalespersonNames()).get(spId) || null);

  const existingIds = normalizeZohoLinks(userData);
  const alreadyLinked = existingIds.includes(spId);
  if (!alreadyLinked) {
    const links = Array.isArray(userData.zohoSalespersonLinks)
      ? userData.zohoSalespersonLinks
        .map(link => ({
          id: String(link?.id ?? '').trim(),
          name: link?.name != null ? String(link.name) : null,
        }))
        .filter(link => link.id)
      : existingIds.map(id => ({ id, name: null }));
    links.push({ id: spId, name: spName });
    const ids = [...new Set(links.map(link => link.id))];
    const first = links[0] || null;
    await userRef.set({
      zohoSalespersonIds: ids,
      zohoSalespersonLinks: links,
      zohoSalespersonId: first?.id ?? spId,
      zohoSalespersonName: first?.name ?? spName,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const cache = await readLinkingCheckCache();
  const cachedUnlock = Array.isArray(cache?.unlocks)
    ? cache.unlocks.find(row => row.zohoSalespersonId === spId)
    : null;
  let dealerIds = Array.isArray(cachedUnlock?.dealerIds)
    ? cachedUnlock.dealerIds.map(id => String(id)).filter(Boolean)
    : [];

  // Fallback: invoice scan when cache missing / stale row without ids.
  if (!dealerIds.length) {
    const dealersSnap = await db.collection('zohoCustomers').select('assignedStaffUid').get();
    const unassigned = dealersSnap.docs.filter((doc) => {
      const prevUid = doc.data()?.assignedStaffUid ? String(doc.data().assignedStaffUid).trim() : '';
      return !prevUid;
    });
    const matchFlags = await mapPool(unassigned, 40, async (dealerDoc) => {
      const match = await latestUsableInvoiceSalesperson(dealerDoc.id);
      return match?.id === spId ? dealerDoc.id : null;
    });
    dealerIds = matchFlags.filter(Boolean);
  }

  let batch = db.batch();
  let ops = 0;
  let assigned = 0;
  const flush = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  // Chunk gets to verify still unassigned (cheap vs invoice lookback).
  for (let i = 0; i < dealerIds.length; i += 100) {
    const chunk = dealerIds.slice(i, i + 100);
    const refs = chunk.map(id => db.collection('zohoCustomers').doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const prevUid = snap.data()?.assignedStaffUid
        ? String(snap.data().assignedStaffUid).trim()
        : '';
      if (prevUid) continue;
      batch.set(snap.ref, {
        assignedStaffUid: uid,
        assignedStaffName: displayName,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      ops += 1;
      assigned += 1;
      if (ops >= 400) await flush();
      onProgress?.({ assigned, total: dealerIds.length });
    }
  }
  await flush();

  await patchCacheAfterClaim({
    zohoSalespersonId: spId,
    assignedCount: assigned,
    staffUid: uid,
    staffName: displayName,
    staffEmail,
    zohoSalespersonName: spName,
  });

  return {
    zohoSalespersonId: spId,
    zohoSalespersonName: spName,
    staffUid: uid,
    staffName: displayName,
    linkedSalesperson: !alreadyLinked,
    matchedDealers: dealerIds.length,
    assigned,
    usedCache: Boolean(cachedUnlock?.dealerIds?.length),
  };
}

function sortNoUsableInvoiceDealers(a, b) {
  return String(a.contactName || a.companyName || a.id || '')
    .localeCompare(String(b.contactName || b.companyName || b.id || ''));
}

function normalizeNoInvoiceRow(row = {}) {
  const id = String(row.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    companyName: row.companyName ? String(row.companyName) : null,
    contactName: row.contactName ? String(row.contactName) : null,
    dealerCode: row.dealerCode ? String(row.dealerCode) : null,
    billingState: row.billingState ? String(row.billingState) : null,
    billingCity: row.billingCity ? String(row.billingCity) : null,
  };
}

async function patchCacheAfterNoInvoiceAssign({ dealers, staffUid, staffName }) {
  const cache = await readLinkingCheckCache();
  if (!cache?.summary) return null;

  const removeIds = new Set(
    (dealers || []).map(row => String(row?.id ?? '').trim()).filter(Boolean),
  );
  if (!removeIds.size) return cache;

  const remaining = (Array.isArray(cache.noUsableInvoiceDealers)
    ? cache.noUsableInvoiceDealers
    : []
  ).filter(row => !removeIds.has(String(row?.id ?? '').trim()));

  const claimed = Math.max(0, (Array.isArray(cache.noUsableInvoiceDealers)
    ? cache.noUsableInvoiceDealers.length
    : 0) - remaining.length);

  const next = {
    ...cache,
    status: 'ready',
    ignoredSalespersons: cache.ignoredSalespersons || IGNORED_INVOICE_SALESPERSON_LABELS,
    summary: {
      ...cache.summary,
      unassignedDealers: Math.max(0, (Number(cache.summary.unassignedDealers) || 0) - claimed),
      noUsableInvoice: remaining.length,
    },
    unlocks: Array.isArray(cache.unlocks) ? cache.unlocks : [],
    alreadyAssignableBySalesperson: Array.isArray(cache.alreadyAssignableBySalesperson)
      ? cache.alreadyAssignableBySalesperson
      : [],
    noUsableInvoiceDealers: remaining,
    lastMutation: {
      type: 'noInvoiceAssign',
      assigned: claimed,
      staffUid: staffUid || null,
      staffName: staffName || null,
      at: new Date().toISOString(),
    },
  };
  delete next.id;
  await writeLinkingCheckCache(next);
  return next;
}

async function patchCacheAfterNoInvoiceUndo({ dealers }) {
  const cache = await readLinkingCheckCache();
  if (!cache?.summary) return null;

  const existing = Array.isArray(cache.noUsableInvoiceDealers)
    ? [...cache.noUsableInvoiceDealers]
    : [];
  const existingIds = new Set(existing.map(row => String(row?.id ?? '').trim()).filter(Boolean));
  const restored = [];
  for (const raw of dealers || []) {
    const row = normalizeNoInvoiceRow(raw);
    if (!row || existingIds.has(row.id)) continue;
    existing.push(row);
    existingIds.add(row.id);
    restored.push(row);
  }
  if (!restored.length) return cache;

  existing.sort(sortNoUsableInvoiceDealers);

  const next = {
    ...cache,
    status: 'ready',
    ignoredSalespersons: cache.ignoredSalespersons || IGNORED_INVOICE_SALESPERSON_LABELS,
    summary: {
      ...cache.summary,
      unassignedDealers: (Number(cache.summary.unassignedDealers) || 0) + restored.length,
      noUsableInvoice: existing.length,
    },
    unlocks: Array.isArray(cache.unlocks) ? cache.unlocks : [],
    alreadyAssignableBySalesperson: Array.isArray(cache.alreadyAssignableBySalesperson)
      ? cache.alreadyAssignableBySalesperson
      : [],
    noUsableInvoiceDealers: existing,
    lastMutation: {
      type: 'noInvoiceUndo',
      assigned: restored.length,
      at: new Date().toISOString(),
    },
  };
  delete next.id;
  await writeLinkingCheckCache(next);
  return next;
}

/**
 * Manually assign unassigned "no usable invoice" dealers to a portal user,
 * then remove them from the linking-check cache list.
 */
export async function assignNoUsableInvoiceDealers({
  dealerIds,
  staffUid,
  onProgress,
} = {}) {
  const uid = String(staffUid ?? '').trim();
  const ids = [...new Set(
    (Array.isArray(dealerIds) ? dealerIds : [])
      .map(id => String(id ?? '').trim())
      .filter(Boolean),
  )];
  if (!uid) throw new Error('staffUid is required.');
  if (!ids.length) throw new Error('Select at least one dealer.');
  if (ids.length > 200) throw new Error('Assign at most 200 dealers at a time.');

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new Error('Portal user not found.');
  const userData = userSnap.data() || {};
  const role = String(userData.role ?? '');
  if (role !== 'staff' && role !== 'super_admin') {
    throw new Error('Assigned user must be staff or super admin.');
  }
  if (userData.active === false) throw new Error('Assigned staff is inactive.');
  const zohoIds = normalizeZohoLinks(userData);
  if (!zohoIds.length) {
    throw new Error('Portal user must have at least one Zoho salesperson linked.');
  }
  const displayName = String(userData.displayName ?? 'Staff').trim() || 'Staff';

  const assignedDealers = [];
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const refs = chunk.map(id => db.collection('zohoCustomers').doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      const prevUid = data.assignedStaffUid ? String(data.assignedStaffUid).trim() : '';
      if (prevUid) continue;
      batch.set(snap.ref, {
        assignedStaffUid: uid,
        assignedStaffName: displayName,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      ops += 1;
      assignedDealers.push({
        id: snap.id,
        companyName: data.companyName ? String(data.companyName) : null,
        contactName: data.contactName ? String(data.contactName) : null,
        dealerCode: data.dealerCode ? String(data.dealerCode) : null,
        billingState: data.billingState ? String(data.billingState) : null,
        billingCity: data.billingCity ? String(data.billingCity) : null,
      });
      if (ops >= 400) await flush();
      onProgress?.({ assigned: assignedDealers.length, total: ids.length });
    }
  }
  await flush();

  if (assignedDealers.length) {
    await patchCacheAfterNoInvoiceAssign({
      dealers: assignedDealers,
      staffUid: uid,
      staffName: displayName,
    });
  }

  return {
    staffUid: uid,
    staffName: displayName,
    requested: ids.length,
    assigned: assignedDealers.length,
    dealers: assignedDealers,
  };
}

/**
 * Undo a prior no-usable-invoice assign batch: clear staff if still that user,
 * and put dealers back on the linking-check list.
 */
export async function undoNoUsableInvoiceAssign({
  dealers,
  staffUid,
} = {}) {
  const uid = String(staffUid ?? '').trim();
  const rows = (Array.isArray(dealers) ? dealers : [])
    .map(normalizeNoInvoiceRow)
    .filter(Boolean);
  if (!uid) throw new Error('staffUid is required.');
  if (!rows.length) throw new Error('Nothing to undo.');

  const db = getFirestore();
  const restored = [];
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const refs = chunk.map(row => db.collection('zohoCustomers').doc(row.id));
    const snaps = await db.getAll(...refs);
    const byId = new Map(chunk.map(row => [row.id, row]));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      const prevUid = data.assignedStaffUid ? String(data.assignedStaffUid).trim() : '';
      if (prevUid !== uid) continue;
      batch.set(snap.ref, {
        assignedStaffUid: null,
        assignedStaffName: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      ops += 1;
      restored.push(byId.get(snap.id) || {
        id: snap.id,
        companyName: data.companyName ? String(data.companyName) : null,
        contactName: data.contactName ? String(data.contactName) : null,
        dealerCode: data.dealerCode ? String(data.dealerCode) : null,
        billingState: data.billingState ? String(data.billingState) : null,
        billingCity: data.billingCity ? String(data.billingCity) : null,
      });
      if (ops >= 400) await flush();
    }
  }
  await flush();

  if (restored.length) {
    await patchCacheAfterNoInvoiceUndo({ dealers: restored });
  }

  return {
    staffUid: uid,
    restored: restored.length,
    dealers: restored,
  };
}

/**
 * Delete legacy kams collection and strip kamId / staffKamId fields.
 */
export async function wipeLegacyKamData({ onProgress } = {}) {
  const db = getFirestore();
  let kamsDeleted = 0;
  let dealersCleared = 0;
  let usersCleared = 0;

  const kamsSnap = await db.collection('kams').get();
  for (let i = 0; i < kamsSnap.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of kamsSnap.docs.slice(i, i + 400)) {
      batch.delete(doc.ref);
      kamsDeleted += 1;
    }
    await batch.commit();
  }

  const dealersSnap = await db.collection('zohoCustomers').select('kamId').get();
  let batch = db.batch();
  let ops = 0;
  for (const docSnap of dealersSnap.docs) {
    const data = docSnap.data() || {};
    if (!Object.prototype.hasOwnProperty.call(data, 'kamId')) continue;
    batch.update(docSnap.ref, {
      kamId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    dealersCleared += 1;
    ops += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops) await batch.commit();

  const usersSnap = await db.collection('users').select('staffKamId').get();
  batch = db.batch();
  ops = 0;
  for (const docSnap of usersSnap.docs) {
    const data = docSnap.data() || {};
    if (!Object.prototype.hasOwnProperty.call(data, 'staffKamId')) continue;
    batch.update(docSnap.ref, { staffKamId: FieldValue.delete() });
    usersCleared += 1;
    ops += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops) await batch.commit();

  onProgress?.({ kamsDeleted, dealersCleared, usersCleared });
  return { kamsDeleted, dealersCleared, usersCleared };
}
