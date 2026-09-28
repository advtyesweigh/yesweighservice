/**
 * PO machine serial ranges (Firestore only). Applied to serial allotment
 * when a goods receipt is marked received — not when the PO is created.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { compactSerialKey, expandSerialRange, previewSerialRange } from './serial-range.js';
import { deleteUnusedSerialList, writeSerialUnitsForRange } from './serial-units.js';
import { pushSerialAllotmentsToYesGatc } from './yesgatc-serial-push.js';

const ALLOTMENT_DOC = 'appSettings/serialNumberAllotment';

function str(value) {
  return value == null ? '' : String(value).trim();
}

function serialRangeKey(row) {
  const series = str(row?.series) || 'non_gatc';
  return `${series}:${compactSerialKey(row?.from)}:${compactSerialKey(row?.to)}`;
}

function stableAllotmentId(poId, lineId) {
  const raw = `po_${str(poId)}_${str(lineId)}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return raw.slice(0, 80) || `po_${Date.now()}`;
}

export function normalizeIncomingSerialRanges(rawRanges, lineItems) {
  const incoming = Array.isArray(rawRanges) ? rawRanges : [];
  const byLineId = new Map();
  const byItemQueue = new Map();

  for (const row of incoming) {
    const start = str(row?.startNumber ?? row?.from);
    const end = str(row?.endNumber ?? row?.to);
    if (!start && !end) continue;
    const preview = previewSerialRange({ from: start, to: end });
    if (preview.error) {
      throw new Error(preview.error);
    }
    const payload = {
      startNumber: preview.from,
      endNumber: preview.to,
      qty: preview.count,
      itemId: str(row?.itemId ?? row?.productId) || null,
      sku: str(row?.sku) || null,
      productName: str(row?.productName ?? row?.name) || null,
      imageUrl: str(row?.imageUrl) || null,
    };
    const lineId = str(row?.lineId);
    if (lineId) byLineId.set(lineId, payload);
    if (payload.itemId) {
      const queue = byItemQueue.get(payload.itemId) || [];
      queue.push(payload);
      byItemQueue.set(payload.itemId, queue);
    }
  }

  const out = {};
  for (const line of Array.isArray(lineItems) ? lineItems : []) {
    const lineId = str(line?.id);
    if (!lineId) continue;
    let match = byLineId.get(lineId);
    if (!match) {
      const queue = byItemQueue.get(str(line?.itemId));
      if (queue?.length) match = queue.shift();
    }
    if (!match) continue;
    out[lineId] = {
      ...match,
      itemId: match.itemId || str(line.itemId) || null,
      sku: match.sku || str(line.sku) || null,
      productName: match.productName || str(line.name) || null,
      imageUrl: match.imageUrl || str(line.imageUrl) || null,
    };
  }
  return out;
}

export async function writePurchaseOrderSerialRanges(purchaseOrderId, rawRanges) {
  const id = str(purchaseOrderId);
  if (!id) throw new Error('purchaseOrderId is required.');
  const ref = getFirestore().collection('purchaseOrders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Purchase order not found.');
  const data = snap.data() || {};
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const serialRangesByLineId = normalizeIncomingSerialRanges(rawRanges, lineItems);
  // update() replaces the map so stale Zoho line ids do not linger after a PUT.
  await ref.update({
    serialRangesByLineId,
    serialRangesUpdatedAt: new Date().toISOString(),
  });
  return { id, serialRangesByLineId };
}

async function lookupPurchaseOrderByNumber(poNumber) {
  const number = str(poNumber);
  if (!number) return null;
  const snap = await getFirestore()
    .collection('purchaseOrders')
    .where('purchaseOrderNumber', '==', number)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() || {} };
}

async function enrichRangeFromCatalog(range) {
  const itemId = str(range.itemId);
  if (!itemId) return range;
  if (range.imageUrl && range.sku && range.productName) return range;
  const snap = await getFirestore().collection('catalogProducts').doc(itemId).get();
  if (!snap.exists) return range;
  const data = snap.data() || {};
  return {
    ...range,
    sku: range.sku || str(data.sku) || null,
    productName: range.productName || str(data.name) || null,
    imageUrl: range.imageUrl || str(data.imageUrl) || null,
  };
}

function previousAllotmentForRow(existing, row) {
  const id = str(row?.id);
  const byId = existing.find(item => str(item?.id) === id);
  if (byId) return byId;
  const receiptId = str(row?.sourceGoodsReceiptId);
  const lineId = str(row?.sourceLineId);
  if (receiptId && lineId) {
    const byLine = existing.find(item => (
      str(item?.sourceGoodsReceiptId) === receiptId
      && str(item?.sourceLineId) === lineId
    ));
    if (byLine) return byLine;
  }
  if (!receiptId) return null;
  const sku = str(row?.sku);
  const productId = str(row?.productId || row?.itemId);
  const byProduct = existing.filter(item => {
    if (str(item?.sourceGoodsReceiptId) !== receiptId) return false;
    if (sku && str(item?.sku) === sku) return true;
    return Boolean(productId && str(item?.productId || item?.itemId) === productId);
  });
  return byProduct.length === 1 ? byProduct[0] : null;
}

/**
 * Append PO serial ranges to appSettings/serialNumberAllotment.
 * A changed range on the same goods receipt releases the previous unused
 * numbers first, so add/update still works after goods received.
 * Never throws for a missing PO / empty ranges.
 */
export async function applyPurchaseOrderSerialsOnGoodsReceipt({
  goodsReceiptId,
  purchaseOrderNumber,
  markedByName,
  serialRanges,
} = {}) {
  const grId = str(goodsReceiptId);
  if (!grId) return { applied: 0, alreadyApplied: false, pushed: 0 };

  const db = getFirestore();
  const grRef = db.collection('goodsReceipts').doc(grId);
  const grSnap = await grRef.get();
  const gr = grSnap.exists ? (grSnap.data() || {}) : {};
  const alreadyApplied = Boolean(gr.serialAllotmentAppliedAt);
  const incoming = Array.isArray(serialRanges) ? serialRanges : [];
  const poNumber = str(purchaseOrderNumber) || str(gr.purchaseOrderNumber) || str(gr.referenceNumber);
  let po = poNumber ? await lookupPurchaseOrderByNumber(poNumber) : null;
  if (!incoming.length && !po) {
    return {
      applied: 0,
      updated: 0,
      alreadyApplied,
      pushed: 0,
      skipped: poNumber ? 'po_not_found' : 'no_po',
    };
  }

  if (po && incoming.length) {
    const incomingMap = normalizeIncomingSerialRanges(
      incoming,
      Array.isArray(po.data.lineItems) ? po.data.lineItems : [],
    );
    const existingRanges = po.data.serialRangesByLineId
      && typeof po.data.serialRangesByLineId === 'object'
      ? po.data.serialRangesByLineId
      : {};
    await getFirestore().collection('purchaseOrders').doc(po.id).update({
      serialRangesByLineId: { ...existingRanges, ...incomingMap },
      serialRangesUpdatedAt: new Date().toISOString(),
    });
    po = await lookupPurchaseOrderByNumber(poNumber) || po;
  }

  const ownerId = po?.id || grId;
  const lineItems = po
    ? (Array.isArray(po.data.lineItems) ? po.data.lineItems : [])
    : (Array.isArray(gr.lineItems) ? gr.lineItems : []);
  const storedRanges = po?.data?.serialRangesByLineId;
  const ranges = storedRanges && typeof storedRanges === 'object' && Object.keys(storedRanges).length
    ? storedRanges
    : normalizeIncomingSerialRanges(incoming, lineItems.length ? lineItems : (gr.lineItems || []));
  const newRows = [];
  for (const [lineId, raw] of Object.entries(ranges)) {
    const start = str(raw?.startNumber ?? raw?.from);
    const end = str(raw?.endNumber ?? raw?.to);
    if (!start || !end) continue;
    const preview = previewSerialRange({ from: start, to: end });
    if (preview.error) continue;
    const enriched = await enrichRangeFromCatalog({
      itemId: str(raw?.itemId) || null,
      sku: str(raw?.sku) || null,
      productName: str(raw?.productName ?? raw?.name) || null,
      imageUrl: str(raw?.imageUrl) || null,
    });
    newRows.push({
      id: stableAllotmentId(ownerId, lineId),
      series: 'non_gatc',
      from: preview.from,
      to: preview.to,
      missing: [],
      count: preview.count,
      createdAt: new Date().toISOString(),
      createdBy: str(markedByName) || 'Goods receipt',
      pushedAt: null,
      pushError: null,
      productId: str(enriched.itemId) || null,
      itemId: str(enriched.itemId) || null,
      sku: enriched.sku,
      imageUrl: enriched.imageUrl,
      productName: enriched.productName,
      sourcePoNumber: poNumber,
      sourceLineId: str(lineId),
      sourceGoodsReceiptId: grId,
    });
  }

  if (incoming.length && !newRows.length) {
    throw new Error('Enter a start and end serial before saving.');
  }

  const allotRef = db.doc(ALLOTMENT_DOC);
  const beforeSnap = await allotRef.get();
  const beforeRows = beforeSnap.exists && Array.isArray(beforeSnap.data()?.allotments)
    ? beforeSnap.data().allotments
    : [];
  for (const row of newRows) {
    const previous = previousAllotmentForRow(beforeRows, row);
    if (!previous || serialRangeKey(previous) === serialRangeKey(row)) continue;
    const nextSerials = new Set(expandSerialRange(row));
    const removed = expandSerialRange(previous).filter(serial => !nextSerials.has(serial));
    if (removed.length) await deleteUnusedSerialList(removed);
    if (str(previous.id)) row.id = str(previous.id);
  }

  let added = [];
  let updated = [];
  if (newRows.length) {
    await db.runTransaction(async tx => {
      const snap = await tx.get(allotRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      const existing = Array.isArray(data.allotments) ? data.allotments : [];
      const seenKeys = new Set(existing.map(serialRangeKey));
      const seenIds = new Set(existing.map(row => str(row?.id)));
      const merged = [...existing];
      const fresh = [];
      const changed = [];
      for (const row of newRows) {
        const idIdx = merged.findIndex(existingRow => str(existingRow?.id) === row.id);
        const keyIdx = merged.findIndex(existingRow => serialRangeKey(existingRow) === serialRangeKey(row));
        const idx = idIdx >= 0 ? idIdx : keyIdx;
        if (idx >= 0 && idIdx < 0) continue;
        if (idx >= 0) {
          const prev = merged[idx];
          const sameRange = serialRangeKey(prev) === serialRangeKey(row);
          merged[idx] = {
            ...prev,
            productId: row.productId || prev.productId || null,
            itemId: row.itemId || prev.itemId || null,
            sku: row.sku || prev.sku || null,
            productName: row.productName || prev.productName || null,
            imageUrl: row.imageUrl || prev.imageUrl || null,
            sourceGoodsReceiptId: row.sourceGoodsReceiptId || prev.sourceGoodsReceiptId || null,
            sourceLineId: row.sourceLineId || prev.sourceLineId || null,
            ...(sameRange ? {} : {
              from: row.from,
              to: row.to,
              missing: [],
              count: row.count,
              pushedAt: null,
              pushError: null,
            }),
          };
          if (!sameRange) changed.push(merged[idx]);
          continue;
        }
        seenKeys.add(serialRangeKey(row));
        seenIds.add(row.id);
        merged.push(row);
        fresh.push(row);
      }
      added = fresh;
      updated = changed;
      tx.set(allotRef, {
        allotments: merged,
        updatedAt: new Date().toISOString(),
        updatedBy: str(markedByName) || 'Goods receipt',
      }, { merge: true });
    });
  }

  if (newRows.length || !alreadyApplied) {
    await grRef.set({
      purchaseOrderNumber: poNumber || gr.purchaseOrderNumber || null,
      serialRangesByLineId: ranges,
      serialAllotmentAppliedAt: new Date().toISOString(),
      serialAllotmentCount: newRows.length,
    }, { merge: true });
  }

  for (const row of [...added, ...updated]) {
    try {
      await writeSerialUnitsForRange(row);
    } catch (err) {
      console.warn(`serialUnits write failed for ${row.id}:`, err?.message ?? err);
    }
  }

  const toPush = [...added, ...updated];
  let pushed = 0;
  if (toPush.length) {
    try {
      const result = await pushSerialAllotmentsToYesGatc({
        mode: 'ids',
        ids: toPush.map(row => row.id),
        actorName: str(markedByName) || 'Goods receipt',
      });
      pushed = Number(result?.sent) || 0;
    } catch {
      // Leave pending — Serial numbers → Test retries YesGATC.
    }
  }

  return { applied: added.length, updated: updated.length, alreadyApplied, pushed };
}
