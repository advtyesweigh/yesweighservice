/**
 * Put back shortages that a Zoho stock sync ate after the last clean count.
 *
 * A clean count is a bin audit whose +/- equals Audit − Zoho and whose bin
 * total equals the audit qty. Sync rows after that count are restored only
 * when they match the old "sale closes a shortage" formula. Anything else
 * (goods receipt, mismatched count, unexplained sync) is left untouched.
 *
 *   node scripts/repair-zoho-sync-shortage-wipes.mjs
 *   node scripts/repair-zoho-sync-shortage-wipes.mjs --apply
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { rebuildProductAuditSnapshot } from '../lib/catalog-product-audit.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = 'yesweigh-service';
const APPLY = process.argv.includes('--apply');
const PHYSICAL = new Set(['warehouse_count', 'cochin_inventory', 'manual', 'legacy_backfill']);

function resolveCredPath() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim(),
    join(SCRIPT_DIR, '..', '..', 'secrets', 'yesweigh-service-firebase-adminsdk-fbsvc-65d526cda5.json'),
    join(process.cwd(), 'secrets', 'yesweigh-service-firebase-adminsdk-fbsvc-65d526cda5.json'),
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) || '';
}

if (!getApps().length) {
  const credPath = resolveCredPath();
  if (!credPath) throw new Error('Firebase credentials not found.');
  const parsed = JSON.parse(readFileSync(credPath, 'utf8'));
  initializeApp({
    credential: parsed.type === 'service_account' ? cert(parsed) : applicationDefault(),
    projectId: parsed.project_id || PROJECT_ID,
  });
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function binsOf(log) {
  return num(log.headOfficeQty) + num(log.cochinQty);
}

function isTrustedCount(log) {
  if (!PHYSICAL.has(log.trigger) || log.sourceGoodsReceiptId) return false;
  const diff = num(log.baselineDifference);
  const physical = num(log.physicalQty);
  const zoho = num(log.zohoQtyAtAudit);
  if (diff !== physical - zoho) return false;
  if (log.trigger === 'legacy_backfill') return true;
  return binsOf(log) === physical;
}

function keptNext(prevZoho, nextZoho, diff, pending) {
  const delta = nextZoho - prevZoho;
  if (delta > 0 && pending > 0) {
    const consumed = Math.min(delta, pending);
    return { baselineDifference: diff - consumed, pendingZohoInbound: pending - consumed };
  }
  return { baselineDifference: diff, pendingZohoInbound: pending };
}

async function readAll(base) {
  const out = [];
  let query = base.limit(1000);
  for (;;) {
    const snap = await query.get();
    out.push(...snap.docs);
    if (snap.size < 1000) break;
    query = base.startAfter(snap.docs[snap.docs.length - 1]).limit(1000);
  }
  return out;
}

const db = getFirestore();
const products = await readAll(
  db.collection('catalogProducts').select('name', 'sku', 'stock', 'auditSnapshot'),
);
const productById = new Map(products.map(doc => {
  const data = doc.data() || {};
  return [doc.id, {
    id: doc.id,
    name: String(data.name || '').trim(),
    sku: String(data.sku || '').trim(),
    stock: num(data.stock),
    shownDiff: data.auditSnapshot ? num(data.auditSnapshot.baselineDifference) : null,
  }];
}));

const logDocs = await readAll(db.collectionGroup('auditLogs').select(
  'catalogProductId',
  'auditedAt',
  'auditedByName',
  'trigger',
  'zohoQtyAtAudit',
  'physicalQty',
  'baselineDifference',
  'headOfficeQty',
  'cochinQty',
  'pendingZohoInbound',
  'sourceGoodsReceiptId',
));

const logsByProduct = new Map();
for (const doc of logDocs) {
  const data = doc.data() || {};
  const productId = String(data.catalogProductId || doc.ref.parent.parent?.id || '').trim();
  if (!productId) continue;
  const list = logsByProduct.get(productId) || [];
  list.push({
    ref: doc.ref,
    id: doc.id,
    auditedAt: String(data.auditedAt || ''),
    auditedByName: data.auditedByName || '',
    trigger: data.trigger || '',
    zohoQtyAtAudit: data.zohoQtyAtAudit,
    physicalQty: data.physicalQty,
    baselineDifference: data.baselineDifference,
    headOfficeQty: data.headOfficeQty,
    cochinQty: data.cochinQty,
    pendingZohoInbound: data.pendingZohoInbound,
    sourceGoodsReceiptId: data.sourceGoodsReceiptId ? String(data.sourceGoodsReceiptId) : '',
  });
  logsByProduct.set(productId, list);
}

const fixes = [];
const skipped = [];

for (const [productId, logs] of logsByProduct) {
  logs.sort((a, b) => a.auditedAt.localeCompare(b.auditedAt) || a.id.localeCompare(b.id));
  const product = productById.get(productId) || { id: productId, sku: '', name: '', stock: 0, shownDiff: null };

  let anchorIndex = -1;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (isTrustedCount(logs[i])) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) continue;

  const later = logs.slice(anchorIndex + 1);
  if (!later.length) continue;
  const blocker = later.find(log => log.trigger !== 'zoho_sync');
  if (blocker) {
    skipped.push({
      sku: product.sku,
      name: product.name,
      reason: blocker.sourceGoodsReceiptId
        ? 'Goods receipt after the last clean count'
        : `Later ${blocker.trigger || 'row'} is not a stock sync`,
      at: blocker.auditedAt,
      by: blocker.auditedByName,
      diff: num(blocker.baselineDifference),
    });
    continue;
  }

  const anchor = logs[anchorIndex];
  let keep = {
    zoho: num(anchor.zohoQtyAtAudit),
    diff: num(anchor.baselineDifference),
    pending: num(anchor.pendingZohoInbound),
  };
  const updates = [];
  let confusing = null;
  let repairedEarlier = false;
  for (const log of later) {
    const zoho = num(log.zohoQtyAtAudit);
    const delta = zoho - keep.zoho;
    const keepNext = keptNext(keep.zoho, zoho, keep.diff, keep.pending);
    const storedDiff = num(log.baselineDifference);
    const storedPending = num(log.pendingZohoInbound);
    const alreadyKept = storedDiff === keepNext.baselineDifference
      && storedPending === keepNext.pendingZohoInbound;
    // Shortage moved toward zero with pending unchanged. A sale does this
    // directly. A later sync keeps that wrong zero when Zoho goes back up.
    const ateShortage = keep.diff < 0
      && storedPending === keep.pending
      && storedDiff > keep.diff
      && storedDiff <= 0
      && (delta < 0 || repairedEarlier);
    if (!alreadyKept && !ateShortage) {
      confusing = {
        at: log.auditedAt,
        storedDiff,
        keepDiff: keepNext.baselineDifference,
        delta,
      };
      break;
    }
    if (ateShortage) {
      updates.push({
        ref: log.ref,
        at: log.auditedAt,
        zoho,
        fromDiff: storedDiff,
        toDiff: keep.diff,
        physicalQty: zoho + keep.diff,
        pendingZohoInbound: keep.pending,
      });
      repairedEarlier = true;
      keep = { zoho, diff: keep.diff, pending: keep.pending };
      continue;
    }
    keep = { zoho, diff: keepNext.baselineDifference, pending: keepNext.pendingZohoInbound };
  }
  if (confusing) {
    skipped.push({
      sku: product.sku,
      name: product.name,
      reason: 'Stock sync does not match a sale eating the shortage',
      at: confusing.at,
      storedDiff: confusing.storedDiff,
      expectedKept: confusing.keepDiff,
      delta: confusing.delta,
    });
    continue;
  }
  if (!updates.length) continue;
  fixes.push({
    productId,
    sku: product.sku,
    name: product.name,
    anchorAt: anchor.auditedAt,
    anchorBy: anchor.auditedByName,
    anchorDiff: num(anchor.baselineDifference),
    shownDiff: product.shownDiff,
    restoredDiff: keep.diff,
    hiddenUnits: num(anchor.baselineDifference) - (product.shownDiff ?? keep.diff),
    updates,
  });
}

fixes.sort((a, b) => Math.abs(b.hiddenUnits) - Math.abs(a.hiddenUnits) || a.sku.localeCompare(b.sku));
skipped.sort((a, b) => a.sku.localeCompare(b.sku));

if (APPLY) {
  let applied = 0;
  for (const row of fixes) {
    for (let i = 0; i < row.updates.length; i += 400) {
      const batch = db.batch();
      for (const update of row.updates.slice(i, i + 400)) {
        batch.update(update.ref, {
          baselineDifference: update.toDiff,
          physicalQty: update.physicalQty,
          pendingZohoInbound: update.pendingZohoInbound,
        });
      }
      await batch.commit();
    }
    await rebuildProductAuditSnapshot(db.collection('catalogProducts').doc(row.productId));
    applied += 1;
  }
  console.error(`applied ${applied}`);
}

const report = {
  mode: APPLY ? 'apply' : 'dry-run',
  fixProducts: fixes.length,
  fixRows: fixes.reduce((sum, row) => sum + row.updates.length, 0),
  restoredUnits: fixes.reduce((sum, row) => sum + (row.anchorDiff - row.restoredDiff === 0
    ? (row.shownDiff == null ? 0 : row.anchorDiff - row.shownDiff)
    : 0), 0),
  skipped: skipped.length,
  fixes: fixes.map(row => ({
    sku: row.sku,
    name: row.name,
    anchorBy: row.anchorBy,
    anchorDiff: row.anchorDiff,
    shownDiff: row.shownDiff,
    restoredDiff: row.restoredDiff,
    rows: row.updates.length,
  })),
  skipped,
};
const out = join(process.env.TEMP || SCRIPT_DIR, 'shortage-repair-report.json');
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  mode: report.mode,
  fixProducts: report.fixProducts,
  fixRows: report.fixRows,
  skipped: report.skipped,
  out,
}, null, 2));
