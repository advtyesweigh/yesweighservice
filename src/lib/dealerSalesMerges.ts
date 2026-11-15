import { fetchDealerSetting } from './dealers';

export type DealerSalesMerge = {
  fromCustomerId: string;
  toCustomerId: string;
  fromName?: string;
  toName?: string;
  reason?: string;
  mergedAt?: string;
};

type DealerSalesMergesSetting = {
  merges?: DealerSalesMerge[];
};

const CACHE_TTL_MS = 60_000;
let cachedAt = 0;
let cachedMerges: DealerSalesMerge[] = [];

function normalizeMerges(value: unknown): DealerSalesMerge[] {
  const merges = (value as DealerSalesMergesSetting | null)?.merges;
  if (!Array.isArray(merges)) return [];
  return merges
    .map(row => ({
      fromCustomerId: String(row?.fromCustomerId ?? '').trim(),
      toCustomerId: String(row?.toCustomerId ?? '').trim(),
      fromName: row?.fromName ? String(row.fromName) : undefined,
      toName: row?.toName ? String(row.toName) : undefined,
      reason: row?.reason ? String(row.reason) : undefined,
      mergedAt: row?.mergedAt ? String(row.mergedAt) : undefined,
    }))
    .filter(row => row.fromCustomerId && row.toCustomerId && row.fromCustomerId !== row.toCustomerId);
}

/** Load dealer sales merge aliases from dealerSettings (via callable). */
export async function loadDealerSalesMerges(force = false): Promise<DealerSalesMerge[]> {
  if (!force && cachedMerges.length && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedMerges;
  }
  try {
    const value = await fetchDealerSetting<DealerSalesMergesSetting>('dealer_sales_merges', { merges: [] });
    cachedMerges = normalizeMerges(value);
  } catch {
    cachedMerges = [];
  }
  cachedAt = Date.now();
  return cachedMerges;
}

export function dealerSalesMergeTargetMap(merges: DealerSalesMerge[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of merges) {
    map.set(row.fromCustomerId, row.toCustomerId);
  }
  return map;
}

/** Remap a customer id through the merge chain (from → to). */
export function resolveMergedCustomerId(
  customerId: string | null | undefined,
  targetByFrom: Map<string, string>,
): string {
  let id = String(customerId ?? '').trim();
  if (!id) return id;
  // Cap chain length to avoid cycles.
  for (let i = 0; i < 5; i += 1) {
    const next = targetByFrom.get(id);
    if (!next || next === id) break;
    id = next;
  }
  return id;
}

type MergeableDealerRow = {
  customerId: string | null;
  customerName?: string | null;
  total?: number | null;
  subtotal?: number | null;
  balance?: number | null;
  itemQuantity?: number | null;
  itemVariantCount?: number | null;
  aggregateInvoiceCount?: number;
  aggregateOrderCount?: number;
  categoryAmounts?: Record<string, number> | null;
  categories?: string[] | null;
  date?: string | null;
  id?: string;
};

function addCategoryAmounts(
  into: Record<string, number>,
  from: Record<string, number> | null | undefined,
): Record<string, number> {
  const next = { ...into };
  if (!from) return next;
  for (const [key, value] of Object.entries(from)) {
    const amount = Number(value ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    next[key] = Number(next[key] ?? 0) + amount;
  }
  return next;
}

/**
 * Fold "from" dealer lifetime rows into their "to" targets and drop the sources.
 * Used for invoiceDealerStats / salesOrderDealerStats Aggregate lifetime lists.
 */
export function applyDealerSalesMergesToAggregateRows<T extends MergeableDealerRow>(
  rows: T[],
  merges: DealerSalesMerge[],
  options?: { countField?: 'aggregateInvoiceCount' | 'aggregateOrderCount' },
): T[] {
  if (!merges.length) return rows;
  const targetByFrom = dealerSalesMergeTargetMap(merges);
  const keepNameByTo = new Map(
    merges
      .filter(row => row.toName)
      .map(row => [row.toCustomerId, row.toName!] as const),
  );
  const countField = options?.countField ?? 'aggregateInvoiceCount';

  const byId = new Map<string, T>();
  for (const row of rows) {
    const originalId = String(row.customerId ?? '').trim();
    if (!originalId) continue;
    const targetId = resolveMergedCustomerId(originalId, targetByFrom);
    const existing = byId.get(targetId);
    if (!existing) {
      const rowCount = Number((row as Record<string, unknown>)[countField] ?? 0);
      const renamed = targetId !== originalId
        ? {
            ...row,
            customerId: targetId,
            id: rowCount === 1 ? targetId : `agg-${targetId}`,
            customerName: keepNameByTo.get(targetId) || row.customerName,
          }
        : row;
      byId.set(targetId, renamed as T);
      continue;
    }

    const existingCount = Number((existing as Record<string, unknown>)[countField] ?? 0);
    const rowCount = Number((row as Record<string, unknown>)[countField] ?? 0);
    const mergedCount = existingCount + rowCount;
    const existingDate = String(existing.date ?? '');
    const rowDate = String(row.date ?? '');
    const latestDate = !existingDate
      ? (row.date ?? null)
      : !rowDate
        ? existing.date ?? null
        : rowDate > existingDate
          ? row.date
          : existing.date;

    const categories = [...new Set([
      ...(existing.categories ?? []),
      ...(row.categories ?? []),
    ].filter(Boolean))] as string[];

    byId.set(targetId, {
      ...existing,
      customerId: targetId,
      customerName: keepNameByTo.get(targetId) || existing.customerName || row.customerName,
      id: mergedCount === 1 ? targetId : `agg-${targetId}`,
      total: Number(existing.total ?? 0) + Number(row.total ?? 0),
      subtotal: (existing.subtotal != null || row.subtotal != null)
        ? Number(existing.subtotal ?? 0) + Number(row.subtotal ?? 0)
        : null,
      balance: Number(existing.balance ?? 0) + Number(row.balance ?? 0),
      itemQuantity: (existing.itemQuantity != null || row.itemQuantity != null)
        ? Number(existing.itemQuantity ?? 0) + Number(row.itemQuantity ?? 0)
        : null,
      itemVariantCount: (existing.itemVariantCount != null || row.itemVariantCount != null)
        ? Number(existing.itemVariantCount ?? 0) + Number(row.itemVariantCount ?? 0)
        : null,
      categoryAmounts: addCategoryAmounts(
        { ...(existing.categoryAmounts ?? {}) },
        row.categoryAmounts,
      ),
      categories,
      date: latestDate,
      [countField]: mergedCount,
    } as T);
  }

  return [...byId.values()];
}
