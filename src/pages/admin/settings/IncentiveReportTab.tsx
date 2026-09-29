import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgePercent, ChartNoAxesColumnIncreasing, FileText, Upload } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { formatCurrencyWhole } from '../../../lib/catalog';
import {
  INCENTIVE_KAMS,
  INCENTIVE_MONTH_START,
  INCENTIVE_RATE,
  INCENTIVE_RATE_REASON_MAX,
  INCENTIVE_UPSALE_SHARE_RATE,
  applyIncentiveExclusions,
  applyIncentiveLineRateOverridesToLines,
  applyIncentiveRateOverrideDeltas,
  canBrowseAllIncentiveKams,
  incentiveKamsForUser,
  incentiveReportSalespersonIds,
  applyLineAdjustsToRow,
  clearIncentiveLineExcluded,
  clearIncentiveLineRateOverride,
  fetchIncentiveInvoiceLines,
  incentiveExcludedAdjustTotals,
  incentiveDateInMonth,
  incentiveForRow,
  incentiveLineAdjustAmounts,
  incentiveLineHasAdjust,
  incentiveLineKey,
  incentiveLineRateOverridePending,
  incentiveOnSurplus,
  invoiceIncentiveRateOverrideKind,
  incentiveRowNote,
  incentiveRowTone,
  incentiveSurplus,
  listIncentiveInvoices,
  listIncentiveLineExclusions,
  listIncentiveLineRateOverrides,
  listIncentiveStaffTargets,
  parseIncentiveTargetInput,
  persistIncentiveSnapshots,
  rateCardSalesForRow,
  setIncentiveLineExcluded,
  setIncentiveLineRateOverride,
  setIncentiveStaffTarget,
  trimIncentiveRateReason,
  verifyIncentiveLineRateOverride,
  withRateCardIncentive,
  type IncentiveInvoiceLine,
  type IncentiveInvoiceRow,
  type IncentiveKamId,
  type IncentiveLineExclusion,
  type IncentiveLineRateOverride,
} from '../../../lib/incentiveReports';
import { canSuperAdminWrite } from '../../../lib/staffAccess';
import { hydrateTableCache, peekTableCache, setTableCache } from '../../../lib/tableDisplayCache';

const PAGE_SIZE = 25;

type AdjustFilter = '' | 'upsales' | 'down' | 'updates';

function currentYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function buildMonthOptions(fromYm: string, toYm: string): Array<{ value: string; label: string }> {
  const [fromY, fromM] = fromYm.split('-').map(Number);
  const [toY, toM] = toYm.split('-').map(Number);
  if (!fromY || !fromM || !toY || !toM) return [];

  const options: Array<{ value: string; label: string }> = [];
  let y = fromY;
  let m = fromM;
  while (y < toY || (y === toY && m <= toM)) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    const label = new Date(y, m - 1, 1).toLocaleString('en-IN', {
      month: 'long',
      year: 'numeric',
    });
    options.push({ value, label });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return options.reverse();
}

function parseInvoiceDate(value: string | null | undefined): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatLineAdjustNote(line: IncentiveInvoiceLine): string | null {
  const qty = Math.max(0, Number(line.adjustQty || line.qty) || 0);
  if (qty <= 0) return null;
  const qtyLabel = qty.toLocaleString('en-IN');
  if (line.priceAdjust === 'discount' && line.unitDiscount > 0) {
    return `-${formatCurrencyWhole(line.unitDiscount)} × ${qtyLabel} = -${formatCurrencyWhole(line.unitDiscount * qty)}`;
  }
  if (line.priceAdjust === 'hike' && line.unitHike > 0) {
    return `+${formatCurrencyWhole(line.unitHike)} × ${qtyLabel} = +${formatCurrencyWhole(line.unitHike * qty)}`;
  }
  return null;
}

function formatInvoiceDate(value: string | null | undefined): string {
  const date = parseInvoiceDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function mergeIncentiveExclusions(
  local: IncentiveLineExclusion[],
  remote: IncentiveLineExclusion[],
): IncentiveLineExclusion[] {
  const byKey = new Map<string, IncentiveLineExclusion>();
  for (const item of [...remote, ...local]) {
    byKey.set(`${item.invoiceId}|${item.lineKey}`, item);
  }
  return [...byKey.values()];
}

function mergeIncentiveRateOverrides(
  local: IncentiveLineRateOverride[],
  remote: IncentiveLineRateOverride[],
): IncentiveLineRateOverride[] {
  const byKey = new Map<string, IncentiveLineRateOverride>();
  for (const item of [...remote, ...local]) {
    byKey.set(`${item.invoiceId}|${item.lineKey}`, item);
  }
  return [...byKey.values()];
}

function formatOverrideWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function lineDraftKey(invoiceId: string, lineKey: string): string {
  return `${invoiceId}|${lineKey}`;
}

function lineRateCardTotal(line: IncentiveInvoiceLine): number {
  const qty = Math.max(0, Number(line.adjustQty || line.qty) || 0);
  if (qty <= 0) return Math.max(0, line.total);
  if (line.priceAdjust === 'discount' && line.unitDiscount > 0) {
    return Math.round((line.total + line.unitDiscount * qty) * 100) / 100;
  }
  if (line.priceAdjust === 'hike' && line.unitHike > 0) {
    return Math.max(0, Math.round((line.total - line.unitHike * qty) * 100) / 100);
  }
  return line.total;
}

function defaultApplicableDraft(line: IncentiveInvoiceLine): string {
  const override = line.rateOverride;
  const rate = override?.applicableRate
    || (line.listRate > 0 ? line.listRate : line.rate);
  return rate > 0 ? String(rate) : '';
}

function defaultReasonDraft(line: IncentiveInvoiceLine): string {
  return line.rateOverride?.reason ?? '';
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportIncentiveCsv(
  rows: IncentiveInvoiceRow[],
  monthLabel: string,
  kamLabel: string,
  extras: {
    rateCardSales: number;
    target: number;
    surplus: number;
    rateCardIncentive: number;
    upsaleShare: number;
    incentive: number;
  },
): void {
  const headers = [
    'Invoice No',
    'Customer',
    'Invoice Date',
    'Salesperson',
    'Invoice sales (ex GST, courier, GATC)',
    'Rate card sales',
    'Invoice incentive (3.5% of rate card)',
  ];
  const lines = [
    ['Month', monthLabel].map(csvEscape).join(','),
    ['Staff', kamLabel].map(csvEscape).join(','),
    ['Rate-card sales', String(extras.rateCardSales)].map(csvEscape).join(','),
    ['Target', String(extras.target)].map(csvEscape).join(','),
    ['Surplus (rate-card sales − target)', String(extras.surplus)].map(csvEscape).join(','),
    ['Rate-card incentive ((rate-card sales − target) × 3.5%)', String(extras.rateCardIncentive)].map(csvEscape).join(','),
    ['30% of net upsale', String(extras.upsaleShare)].map(csvEscape).join(','),
    ['Total incentive (rate-card + 30% net upsale)', String(extras.incentive)].map(csvEscape).join(','),
    '',
    headers.join(','),
    ...rows.map(row => [
      row.invoiceNumber,
      row.customerName || '',
      row.date || '',
      row.salespersonName || '',
      String(row.sales),
      String(row.rateCardSales ?? row.sales),
      String(incentiveForRow(row)),
    ].map(value => csvEscape(String(value))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const suffix = kamLabel.replace(/\s+/g, '-').toLowerCase();
  anchor.download = `incentive-report-${monthLabel.replace(/\s+/g, '-').toLowerCase()}-${suffix}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const IncentiveReportTab: React.FC = () => {
  const { user } = useAuth();
  const canExcludeLines = canSuperAdminWrite(user);
  const canEditRates = canSuperAdminWrite(user) || user?.role === 'staff';
  const canVerifyRates = canSuperAdminWrite(user);
  const browseAllKams = canBrowseAllIncentiveKams(user);
  const allowedKams = useMemo(
    () => (browseAllKams ? INCENTIVE_KAMS : incentiveKamsForUser(user)),
    [browseAllKams, user],
  );
  const allowedKamIds = useMemo(
    () => new Set(allowedKams.map(opt => opt.id)),
    [allowedKams],
  );
  const salespersonIds = useMemo(
    () => incentiveReportSalespersonIds(user),
    [user],
  );
  const scopeKey = browseAllKams
    ? 'all'
    : (allowedKams.map(opt => opt.id).join(',') || 'none');
  const monthOptions = useMemo(
    () => buildMonthOptions(INCENTIVE_MONTH_START, currentYearMonth()),
    [],
  );
  const defaultMonth = monthOptions[0]?.value || INCENTIVE_MONTH_START;

  const [rows, setRows] = useState<IncentiveInvoiceRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [month, setMonth] = useState(defaultMonth);
  const [kam, setKam] = useState<IncentiveKamId>(allowedKams[0]?.id ?? 'biju');
  const [adjustFilter, setAdjustFilter] = useState<AdjustFilter>('');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [linesByInvoice, setLinesByInvoice] = useState<Record<string, IncentiveInvoiceLine[]>>({});
  const [linesLoadingId, setLinesLoadingId] = useState<string | null>(null);
  const [exclusions, setExclusions] = useState<IncentiveLineExclusion[]>([]);
  const [exclusionBusyKey, setExclusionBusyKey] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<IncentiveLineRateOverride[]>([]);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [rateBusyKey, setRateBusyKey] = useState<string | null>(null);
  const [targetsByKam, setTargetsByKam] = useState<Partial<Record<IncentiveKamId, number>>>({});
  const [targetDraft, setTargetDraft] = useState('');
  const [targetFocused, setTargetFocused] = useState(false);
  const [targetSaving, setTargetSaving] = useState(false);
  const canEditTarget = canExcludeLines;
  const loadGen = useRef(0);

  const loadMonth = useCallback(async (yearMonth: string) => {
    const gen = ++loadGen.current;
    const alive = () => gen === loadGen.current;
    const cacheKey = `incentive-v2:${yearMonth}:${scopeKey}`;
    const inMonth = (source: IncentiveInvoiceRow[]) => {
      const own = browseAllKams
        ? source
        : source.filter(row => row.kamId != null && allowedKamIds.has(row.kamId));
      return own.filter(row => incentiveDateInMonth(row.date, yearMonth));
    };
    const cached = peekTableCache<{ rows: IncentiveInvoiceRow[]; truncated: boolean }>(cacheKey)
      ?? await hydrateTableCache<{ rows: IncentiveInvoiceRow[]; truncated: boolean }>(cacheKey);
    if (!alive()) return;
    if (cached) {
      setRows(inMonth(cached.rows.map(row => withRateCardIncentive(row))));
      setTruncated(cached.truncated);
      setLoading(false);
    } else {
      setRows([]);
      setTargetsByKam({});
      setLoading(true);
    }
    setError('');
    const exclusionKey = `incentive-excl:${yearMonth}:${scopeKey}`;
    const overrideKey = `incentive-rate:${yearMonth}:${scopeKey}`;
    const targetKey = `incentive-target:${yearMonth}:${scopeKey}`;
    const localExclusions = peekTableCache<IncentiveLineExclusion[]>(exclusionKey)
      ?? await hydrateTableCache<IncentiveLineExclusion[]>(exclusionKey)
      ?? [];
    if (!alive()) return;
    if (localExclusions.length) setExclusions(localExclusions);
    else setExclusions([]);
    const localOverrides = peekTableCache<IncentiveLineRateOverride[]>(overrideKey)
      ?? await hydrateTableCache<IncentiveLineRateOverride[]>(overrideKey)
      ?? [];
    if (!alive()) return;
    if (localOverrides.length) setOverrides(localOverrides);
    else setOverrides([]);
    const cachedTargets = peekTableCache<Partial<Record<IncentiveKamId, number>>>(targetKey)
      ?? await hydrateTableCache<Partial<Record<IncentiveKamId, number>>>(targetKey)
      ?? {};
    if (!alive()) return;
    if (Object.keys(cachedTargets).length) {
      const scopedTargets = browseAllKams
        ? cachedTargets
        : Object.fromEntries(
          Object.entries(cachedTargets).filter(([id]) => allowedKamIds.has(id as IncentiveKamId)),
        ) as Partial<Record<IncentiveKamId, number>>;
      setTargetsByKam(scopedTargets);
    } else if (!cached) {
      setTargetsByKam({});
    }
    try {
      const [result, monthExclusions, monthOverrides, monthTargets] = await Promise.all([
        listIncentiveInvoices(yearMonth, salespersonIds),
        listIncentiveLineExclusions(yearMonth).catch(() => null),
        listIncentiveLineRateOverrides(yearMonth).catch(() => null),
        listIncentiveStaffTargets(yearMonth).catch(() => null),
      ]);
      if (!alive()) return;
      const merged = monthExclusions
        ? mergeIncentiveExclusions(localExclusions, monthExclusions)
        : localExclusions;
      const mergedOverrides = monthOverrides
        ? mergeIncentiveRateOverrides(localOverrides, monthOverrides)
        : localOverrides;
      const scopedRows = inMonth(result.rows);
      setRows(scopedRows);
      setTruncated(result.truncated);
      if (monthExclusions) setExclusions(merged);
      if (monthOverrides) setOverrides(mergedOverrides);
      setTableCache(cacheKey, { rows: scopedRows, truncated: result.truncated });
      if (monthExclusions) setTableCache(exclusionKey, merged);
      if (monthOverrides) setTableCache(overrideKey, mergedOverrides);
      if (monthTargets) {
        const nextTargets: Partial<Record<IncentiveKamId, number>> = {};
        for (const item of monthTargets) {
          if (browseAllKams || allowedKamIds.has(item.kamId)) nextTargets[item.kamId] = item.target;
        }
        setTargetsByKam(nextTargets);
        setTableCache(targetKey, nextTargets);
      }
      void persistIncentiveSnapshots(yearMonth, scopedRows);
    } catch (err) {
      if (!alive()) return;
      if (!cached) {
        setError(err instanceof Error ? err.message : 'Could not load incentive report.');
        setRows([]);
        setTruncated(false);
        setExclusions([]);
        setOverrides([]);
        setTargetsByKam({});
      }
    } finally {
      if (alive()) setLoading(false);
    }
  }, [allowedKamIds, browseAllKams, salespersonIds, scopeKey]);

  useEffect(() => {
    if (allowedKams.length === 0) return;
    if (!allowedKams.some(opt => opt.id === kam)) setKam(allowedKams[0].id);
  }, [allowedKams, kam]);

  useEffect(() => {
    void loadMonth(month);
  }, [loadMonth, month]);

  useEffect(() => {
    setPage(1);
    setExpandedId(null);
    setAdjustFilter('');
    setLinesByInvoice({});
  }, [month, kam]);

  useEffect(() => {
    setPage(1);
    setExpandedId(null);
  }, [adjustFilter]);

  useEffect(() => {
    if (!expandedId) return;
    const report = rows.find(row => row.id === expandedId);
    if (!report || linesByInvoice[report.id] !== undefined) return;

    let cancelled = false;
    setLinesLoadingId(report.id);
    void fetchIncentiveInvoiceLines(report.customerId, report.id)
      .then(lines => {
        if (cancelled) return;
        setLinesByInvoice(prev => ({ ...prev, [report.id]: lines }));
        setRows(current => {
          const next = current.map(row => (
            row.id === report.id
              ? applyLineAdjustsToRow(row, lines)
              : row
          ));
          setTableCache(`incentive-v2:${month}:${scopeKey}`, { rows: next, truncated });
          const updated = next.find(row => row.id === report.id);
          if (updated) void persistIncentiveSnapshots(month, [updated]);
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setLinesLoadingId(current => (current === report.id ? null : current));
      });

    return () => {
      cancelled = true;
    };
  }, [expandedId, rows, linesByInvoice, month, truncated, scopeKey]);

  const adjustedLinesByInvoice = useMemo(() => {
    const next: Record<string, IncentiveInvoiceLine[]> = {};
    for (const [invoiceId, lines] of Object.entries(linesByInvoice)) {
      next[invoiceId] = applyIncentiveLineRateOverridesToLines(lines, invoiceId, overrides);
    }
    return next;
  }, [linesByInvoice, overrides]);

  const rowsWithLineAdjust = useMemo(() => (
    rows.map(row => {
      const lines = adjustedLinesByInvoice[row.id];
      if (lines?.length) return applyLineAdjustsToRow(row, lines);
      return applyIncentiveRateOverrideDeltas(row, overrides);
    })
  ), [adjustedLinesByInvoice, overrides, rows]);

  const displayRows = useMemo(
    () => applyIncentiveExclusions(rowsWithLineAdjust, exclusions),
    [rowsWithLineAdjust, exclusions],
  );

  const excludedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const exclusion of exclusions) {
      keys.add(`${exclusion.invoiceId}|${exclusion.lineKey}`);
    }
    return keys;
  }, [exclusions]);

  const kamRows = useMemo(
    () => displayRows.filter(row => row.kamId === kam),
    [displayRows, kam],
  );

  const kamOverrideInvoiceIds = useMemo(() => {
    const ids = new Set(kamRows.map(row => row.id));
    return new Set(overrides.filter(item => ids.has(item.invoiceId)).map(item => item.invoiceId));
  }, [kamRows, overrides]);

  const pendingOverrideCount = useMemo(() => {
    const ids = kamOverrideInvoiceIds;
    return overrides.filter(item => (
      ids.has(item.invoiceId) && incentiveLineRateOverridePending(item)
    )).length;
  }, [kamOverrideInvoiceIds, overrides]);

  const listed = useMemo(() => {
    if (adjustFilter === 'upsales') return kamRows.filter(row => row.hikeAmount > 0);
    if (adjustFilter === 'down') return kamRows.filter(row => row.discountAmount > 0);
    if (adjustFilter === 'updates') {
      return kamRows.filter(row => kamOverrideInvoiceIds.has(row.id));
    }
    return kamRows;
  }, [adjustFilter, kamOverrideInvoiceIds, kamRows]);

  const totalPages = Math.max(1, Math.ceil(listed.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return listed.slice(start, start + PAGE_SIZE);
  }, [listed, page]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const kamSource = useMemo(
    () => rowsWithLineAdjust.filter(row => row.kamId === kam),
    [rowsWithLineAdjust, kam],
  );

  const savedTarget = Math.max(0, targetsByKam[kam] ?? 0);

  useEffect(() => {
    if (targetFocused) return;
    setTargetDraft(savedTarget > 0 ? String(savedTarget) : '');
  }, [savedTarget, kam, month, targetFocused]);

  const kpis = useMemo(() => {
    const invoiceCount = kamRows.length;
    const totalSales = kamRows.reduce((sum, row) => sum + row.sales, 0);
    const rateCardSales = kamRows.reduce((sum, row) => sum + rateCardSalesForRow(row), 0);
    const target = savedTarget;
    const surplus = incentiveSurplus(rateCardSales, target);
    // Spare incharge (Shibin): 3.5% of rate-card sales only — no 2% / no 30% upsale share.
    const includeUpsaleShare = kam !== 'shibin';
    const rateCardIncentive = incentiveOnSurplus(rateCardSales, target, INCENTIVE_RATE);
    const excludedAdjust = incentiveExcludedAdjustTotals(kamSource, exclusions);
    const rawUpsales = kamSource.reduce((sum, row) => sum + row.hikeAmount, 0);
    const rawDownSale = kamSource.reduce((sum, row) => sum + row.discountAmount, 0);
    const upsales = Math.max(0, rawUpsales - excludedAdjust.hikeAmount);
    const downSale = Math.max(0, rawDownSale - excludedAdjust.discountAmount);
    const netAdjust = upsales - downSale;
    const kamShare = includeUpsaleShare
      ? Math.round(netAdjust * INCENTIVE_UPSALE_SHARE_RATE * 100) / 100
      : 0;
    const totalIncentive = Math.round((rateCardIncentive + kamShare) * 100) / 100;
    return {
      invoiceCount,
      totalSales,
      rateCardSales,
      target,
      surplus,
      rateCardIncentive,
      totalIncentive,
      upsales,
      downSale,
      netAdjust,
      kamShare,
      includeUpsaleShare,
    };
  }, [kamRows, kamSource, exclusions, savedTarget, kam]);

  const monthLabel = monthOptions.find(opt => opt.value === month)?.label || month;
  const kamLabel = allowedKams.find(opt => opt.id === kam)?.label
    || INCENTIVE_KAMS.find(opt => opt.id === kam)?.label
    || 'Sales staff';
  const canPickKam = browseAllKams || allowedKams.length > 1;

  const handleExport = useCallback(() => {
    exportIncentiveCsv(listed, monthLabel, kamLabel, {
      rateCardSales: kpis.rateCardSales,
      target: kpis.target,
      surplus: kpis.surplus,
      rateCardIncentive: kpis.rateCardIncentive,
      upsaleShare: kpis.kamShare,
      incentive: kpis.totalIncentive,
    });
  }, [
    listed,
    monthLabel,
    kamLabel,
    kpis.rateCardSales,
    kpis.target,
    kpis.surplus,
    kpis.rateCardIncentive,
    kpis.kamShare,
    kpis.totalIncentive,
  ]);

  const persistTarget = useCallback(async (raw: string) => {
    const next = parseIncentiveTargetInput(raw);
    setTargetDraft(next > 0 ? String(next) : '');
    if (next === savedTarget) return;
    setTargetSaving(true);
    const previous = targetsByKam;
    setTargetsByKam(current => ({ ...current, [kam]: next }));
    try {
      await setIncentiveStaffTarget({
        month,
        kamId: kam,
        target: next,
        uid: user?.uid,
      });
      setTableCache(`incentive-target:${month}:${scopeKey}`, { ...previous, [kam]: next });
    } catch {
      setTargetsByKam(previous);
      setTargetDraft(savedTarget > 0 ? String(savedTarget) : '');
      setError('Could not save staff target.');
    } finally {
      setTargetSaving(false);
    }
  }, [kam, month, savedTarget, targetsByKam, user?.uid, scopeKey]);

  const toggleLineExclusion = useCallback(async (
    row: IncentiveInvoiceRow,
    line: IncentiveInvoiceLine,
    index: number,
  ) => {
    if (!canExcludeLines || !incentiveLineHasAdjust(line)) return;
    const lineKey = incentiveLineKey(line, index);
    const busyKey = `${row.id}|${lineKey}`;
    if (exclusionBusyKey) return;
    const already = excludedKeys.has(busyKey);
    const amounts = incentiveLineAdjustAmounts(line, row);
    setExclusionBusyKey(busyKey);
    const next = already
      ? exclusions.filter(item => !(item.invoiceId === row.id && item.lineKey === lineKey))
      : [...exclusions.filter(item => !(item.invoiceId === row.id && item.lineKey === lineKey)), {
        id: `${row.id}__${lineKey}`,
        invoiceId: row.id,
        month,
        lineKey,
        ...amounts,
      }];
    setExclusions(next);
    setTableCache(`incentive-excl:${month}:${scopeKey}`, next);
    try {
      if (already) {
        await clearIncentiveLineExcluded(row.id, lineKey);
      } else {
        await setIncentiveLineExcluded({
          invoiceId: row.id,
          month,
          lineKey,
          ...amounts,
          uid: user?.uid,
        });
      }
    } catch {
      // Keep the local exclusion so Upsales / Down sale still move.
    } finally {
      setExclusionBusyKey(current => (current === busyKey ? null : current));
    }
  }, [canExcludeLines, excludedKeys, exclusionBusyKey, exclusions, month, user?.uid, scopeKey]);

  const saveLineApplicableRate = useCallback(async (
    row: IncentiveInvoiceRow,
    index: number,
  ) => {
    if (!canEditRates) return;
    const rawLine = linesByInvoice[row.id]?.[index];
    if (!rawLine) return;
    const lineKey = incentiveLineKey(rawLine, index);
    const busyKey = lineDraftKey(row.id, lineKey);
    if (rateBusyKey) return;
    const previous = overrides.find(item => item.invoiceId === row.id && item.lineKey === lineKey) ?? null;
    const applicableRate = parseIncentiveTargetInput(
      rateDrafts[busyKey] ?? defaultApplicableDraft({ ...rawLine, rateOverride: previous }),
    );
    const reason = trimIncentiveRateReason(
      reasonDrafts[busyKey] ?? previous?.reason ?? '',
    );
    if (applicableRate <= 0) {
      setError('Enter an applicable rate greater than zero.');
      return;
    }
    if (!reason) {
      setError('Add a reason for this rate update.');
      return;
    }
    const oldAmounts = previous
      ? { hikeAmount: previous.oldHikeAmount, discountAmount: previous.oldDiscountAmount }
      : incentiveLineAdjustAmounts(rawLine, row);
    const systemListRate = previous?.systemListRate
      || (rawLine.listRate > 0 ? rawLine.listRate : rawLine.rate);
    setRateBusyKey(busyKey);
    setError('');
    try {
      const saved = await setIncentiveLineRateOverride({
        invoiceId: row.id,
        month,
        lineKey,
        lineName: rawLine.name,
        billedRate: rawLine.rate,
        applicableRate,
        systemListRate,
        qty: rawLine.qty,
        oldHikeAmount: oldAmounts.hikeAmount,
        oldDiscountAmount: oldAmounts.discountAmount,
        uid: user?.uid,
        name: user?.displayName,
        reason,
        markVerified: canVerifyRates,
        previous,
      });
      const next = [
        ...overrides.filter(item => !(item.invoiceId === row.id && item.lineKey === lineKey)),
        saved,
      ];
      setOverrides(next);
      setTableCache(`incentive-rate:${month}:${scopeKey}`, next);
      setRateDrafts(current => ({ ...current, [busyKey]: String(saved.applicableRate) }));
      setReasonDrafts(current => ({ ...current, [busyKey]: saved.reason }));
    } catch (err) {
      setError(err instanceof Error && err.message === 'Add a reason for this rate update.'
        ? err.message
        : 'Could not save applicable rate. Used only for incentive — the invoice is unchanged.');
    } finally {
      setRateBusyKey(current => (current === busyKey ? null : current));
    }
  }, [
    canEditRates,
    canVerifyRates,
    linesByInvoice,
    month,
    overrides,
    rateBusyKey,
    rateDrafts,
    reasonDrafts,
    scopeKey,
    user?.displayName,
    user?.uid,
  ]);

  const verifyLineApplicableRate = useCallback(async (
    row: IncentiveInvoiceRow,
    lineKey: string,
  ) => {
    if (!canVerifyRates) return;
    const previous = overrides.find(item => item.invoiceId === row.id && item.lineKey === lineKey);
    if (!previous || !incentiveLineRateOverridePending(previous)) return;
    const busyKey = lineDraftKey(row.id, lineKey);
    if (rateBusyKey) return;
    setRateBusyKey(busyKey);
    setError('');
    try {
      const saved = await verifyIncentiveLineRateOverride({
        override: previous,
        uid: user?.uid,
        name: user?.displayName,
      });
      const next = overrides.map(item => (item.id === saved.id ? saved : item));
      setOverrides(next);
      setTableCache(`incentive-rate:${month}:${scopeKey}`, next);
    } catch {
      setError('Could not verify this rate update.');
    } finally {
      setRateBusyKey(current => (current === busyKey ? null : current));
    }
  }, [canVerifyRates, month, overrides, rateBusyKey, scopeKey, user?.displayName, user?.uid]);

  const clearLineApplicableRate = useCallback(async (
    row: IncentiveInvoiceRow,
    lineKey: string,
  ) => {
    if (!canEditRates) return;
    const busyKey = lineDraftKey(row.id, lineKey);
    if (rateBusyKey) return;
    const previous = overrides.find(item => item.invoiceId === row.id && item.lineKey === lineKey);
    if (!previous) return;
    setRateBusyKey(busyKey);
    setError('');
    const next = overrides.filter(item => item.id !== previous.id);
    setOverrides(next);
    setTableCache(`incentive-rate:${month}:${scopeKey}`, next);
    try {
      await clearIncentiveLineRateOverride(row.id, lineKey);
      setRateDrafts(current => {
        const copy = { ...current };
        delete copy[busyKey];
        return copy;
      });
      setReasonDrafts(current => {
        const copy = { ...current };
        delete copy[busyKey];
        return copy;
      });
    } catch {
      setOverrides(overrides);
      setTableCache(`incentive-rate:${month}:${scopeKey}`, overrides);
      setError('Could not clear this rate update.');
    } finally {
      setRateBusyKey(current => (current === busyKey ? null : current));
    }
  }, [canEditRates, month, overrides, rateBusyKey, scopeKey]);

  return (
    <section className="gatc-report incentive-report">
      {error ? <p className="gatc-report__error text-sm">{error}</p> : null}
      {truncated ? (
        <p className="gatc-report__error text-sm">
          Showing the first 4,000 invoices for this month. Narrow the KAM filter after load if totals look short.
        </p>
      ) : null}

      {loading ? (
        <div className="gatc-report__loading">
          <div className="loader-ring" />
        </div>
      ) : (
        <>
          <div className="incentive-report__kpis" aria-label="Incentive summary">
            <article className="incentive-report__kpi incentive-report__kpi--inv">
              <FileText className="incentive-report__kpi-icon" size={18} strokeWidth={2} aria-hidden />
              <div className="incentive-report__kpi-copy">
                <span className="incentive-report__kpi-label">INV</span>
                <strong className="incentive-report__kpi-value">
                  {kpis.invoiceCount.toLocaleString('en-IN')}
                </strong>
              </div>
            </article>
            <article className="incentive-report__kpi incentive-report__kpi--sales">
              <ChartNoAxesColumnIncreasing className="incentive-report__kpi-icon" size={18} strokeWidth={2} aria-hidden />
              <div className="incentive-report__kpi-copy">
                <span className="incentive-report__kpi-label">Total sales</span>
                <strong className="incentive-report__kpi-value">
                  {formatCurrencyWhole(kpis.totalSales)}
                </strong>
              </div>
            </article>
            <article className={`incentive-report__kpi incentive-report__kpi--fee${kpis.includeUpsaleShare && Math.abs(kpis.kamShare) > 0.005 ? ' is-split' : ''}`}>
              <BadgePercent className="incentive-report__kpi-icon" size={18} strokeWidth={2} aria-hidden />
              <div className="incentive-report__kpi-copy">
                <span className="incentive-report__kpi-label">
                  {kpis.includeUpsaleShare
                    ? 'Total incentive'
                    : `Incentives (${(INCENTIVE_RATE * 100).toFixed(1)}% rate card)`}
                </span>
                {kpis.includeUpsaleShare && Math.abs(kpis.kamShare) > 0.005 ? (
                  <dl className="incentive-report__kpi-split">
                    <div>
                      <dt>Total</dt>
                      <dd>{formatCurrencyWhole(kpis.totalIncentive)}</dd>
                    </div>
                    <div>
                      <dt>Rate card</dt>
                      <dd className="is-standard">{formatCurrencyWhole(kpis.rateCardIncentive)}</dd>
                    </div>
                    <div>
                      <dt>{(INCENTIVE_UPSALE_SHARE_RATE * 100).toFixed(0)}% net</dt>
                      <dd className={kpis.kamShare < 0 ? 'is-director' : 'is-upsale'}>
                        {kpis.kamShare < 0 ? '−' : '+'}
                        {formatCurrencyWhole(Math.abs(kpis.kamShare))}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <strong className="incentive-report__kpi-value">
                    {formatCurrencyWhole(kpis.totalIncentive)}
                  </strong>
                )}
              </div>
            </article>
          </div>

          <div className="incentive-report__formula" aria-label="Incentive formula">
            <div className="incentive-report__formula-term">
              <span className="incentive-report__formula-label">Rate card</span>
              <strong>{formatCurrencyWhole(kpis.rateCardSales)}</strong>
            </div>
            <span className="incentive-report__formula-op" aria-hidden>−</span>
            <label className="incentive-report__formula-term is-target">
              <span className="incentive-report__formula-label">Target</span>
              {canEditTarget ? (
                <input
                  type="text"
                  inputMode="decimal"
                  className="incentive-report__target-input"
                  aria-label={`${kamLabel} sales target for ${monthLabel}`}
                  placeholder="₹0"
                  disabled={targetSaving}
                  value={targetFocused
                    ? targetDraft
                    : (savedTarget > 0 ? formatCurrencyWhole(savedTarget) : '')}
                  onFocus={() => {
                    setTargetFocused(true);
                    setTargetDraft(savedTarget > 0 ? String(Math.round(savedTarget)) : '');
                  }}
                  onChange={e => setTargetDraft(e.target.value)}
                  onBlur={() => {
                    setTargetFocused(false);
                    void persistTarget(targetDraft);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  }}
                />
              ) : (
                <strong>{formatCurrencyWhole(kpis.target)}</strong>
              )}
            </label>
            <span className="incentive-report__formula-op" aria-hidden>×</span>
            <span className="incentive-report__formula-rate">
              {(INCENTIVE_RATE * 100).toFixed(1)}%
            </span>
            <span className="incentive-report__formula-op" aria-hidden>=</span>
            {kpis.includeUpsaleShare ? (
              <>
                <div className={`incentive-report__formula-term is-base${kpis.surplus < 0 ? ' is-short' : ''}`}>
                  <span className="incentive-report__formula-label">
                    {kpis.surplus < 0 ? 'Below target' : 'Rate card'}
                  </span>
                  <strong>{formatCurrencyWhole(kpis.rateCardIncentive)}</strong>
                </div>
                <span className="incentive-report__formula-op" aria-hidden>+</span>
                <div className={`incentive-report__formula-term is-upsale${kpis.kamShare < 0 ? ' is-short' : ''}`}>
                  <span className="incentive-report__formula-label">
                    {(INCENTIVE_UPSALE_SHARE_RATE * 100).toFixed(0)}% net upsale
                  </span>
                  <strong>{formatCurrencyWhole(kpis.kamShare)}</strong>
                </div>
                <span className="incentive-report__formula-op" aria-hidden>=</span>
                <div className={`incentive-report__formula-term is-result${kpis.totalIncentive < 0 ? ' is-short' : ''}`}>
                  <span className="incentive-report__formula-label">Total incentive</span>
                  <strong>{formatCurrencyWhole(kpis.totalIncentive)}</strong>
                </div>
              </>
            ) : (
              <div className={`incentive-report__formula-term is-result${kpis.surplus < 0 ? ' is-short' : ''}`}>
                <span className="incentive-report__formula-label">
                  {kpis.surplus < 0 ? 'Below target' : 'Incentive'}
                </span>
                <strong>{formatCurrencyWhole(kpis.totalIncentive)}</strong>
              </div>
            )}
          </div>

          <div className="incentive-report__adjust" aria-label="Upsales and down sale">
            <button
              type="button"
              className={`incentive-report__adjust-col is-up${adjustFilter === 'upsales' ? ' is-active' : ''}`}
              aria-pressed={adjustFilter === 'upsales'}
              onClick={() => setAdjustFilter(current => (current === 'upsales' ? '' : 'upsales'))}
            >
              <span className="incentive-report__adjust-label">Upsales</span>
              <strong className="incentive-report__adjust-value">
                {formatCurrencyWhole(kpis.upsales)}
              </strong>
            </button>
            <button
              type="button"
              className={`incentive-report__adjust-col is-down${adjustFilter === 'down' ? ' is-active' : ''}`}
              aria-pressed={adjustFilter === 'down'}
              onClick={() => setAdjustFilter(current => (current === 'down' ? '' : 'down'))}
            >
              <span className="incentive-report__adjust-label">Down sale</span>
              <strong className="incentive-report__adjust-value">
                {formatCurrencyWhole(kpis.downSale)}
              </strong>
            </button>
            {kpis.includeUpsaleShare ? (
              <div className="incentive-report__adjust-col is-net">
                <strong className="incentive-report__adjust-value">
                  {formatCurrencyWhole(kpis.kamShare)}
                </strong>
                <span className="incentive-report__adjust-kam">
                  {(INCENTIVE_UPSALE_SHARE_RATE * 100).toFixed(0)}% of{' '}
                  {formatCurrencyWhole(kpis.netAdjust)} · in total
                </span>
              </div>
            ) : (
              <div className="incentive-report__adjust-col is-net">
                <strong className="incentive-report__adjust-value">
                  {formatCurrencyWhole(kpis.netAdjust)}
                </strong>
                <span className="incentive-report__adjust-kam">
                  Info only · not in incentive
                </span>
              </div>
            )}
          </div>

          <div className="gatc-report__filters">
            <div className="gatc-report__filters-start">
              <label className="gatc-report__month">
                <select
                  value={month}
                  onChange={e => setMonth(e.target.value)}
                  aria-label="Report month"
                >
                  {monthOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              {canPickKam ? (
                <label className="gatc-report__kam">
                  <select
                    value={kam}
                    onChange={e => setKam(e.target.value as IncentiveKamId)}
                    aria-label="Salesperson"
                  >
                    {allowedKams.map(opt => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                </label>
              ) : allowedKams.length === 1 ? (
                <span className="gatc-report__kam gatc-report__kam--locked">{kamLabel}</span>
              ) : null}
              {kamOverrideInvoiceIds.size > 0 ? (
                <button
                  type="button"
                  className={`incentive-report__updates-filter${adjustFilter === 'updates' ? ' is-active' : ''}${pendingOverrideCount > 0 ? ' is-pending' : ''}`}
                  aria-pressed={adjustFilter === 'updates'}
                  onClick={() => setAdjustFilter(current => (current === 'updates' ? '' : 'updates'))}
                >
                  Updates
                  <strong>{pendingOverrideCount > 0 ? pendingOverrideCount : kamOverrideInvoiceIds.size}</strong>
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="gatc-report__export-btn"
              disabled={loading || listed.length === 0}
              onClick={handleExport}
            >
              <Upload size={15} aria-hidden />
              Export
            </button>
          </div>

          {listed.length === 0 ? (
            <div className="gatc-report__empty">
              <FileText size={28} aria-hidden />
              <strong>
                {!browseAllKams && allowedKams.length === 0
                  ? 'No sales incentive linked to your account'
                  : kamRows.length === 0
                  ? 'No invoices this month'
                  : adjustFilter === 'upsales'
                    ? 'No upsales this month'
                    : adjustFilter === 'updates'
                      ? 'No staff rate updates this month'
                    : 'No down sales this month'}
              </strong>
              <p>
                {!browseAllKams && allowedKams.length === 0
                  ? 'Your Zoho salesperson is not linked to this login.'
                  : kamRows.length === 0
                    ? (canPickKam ? 'Try another month or salesperson.' : 'Try another month.')
                    : 'Tap the box again to show all invoices.'}
              </p>
            </div>
          ) : (
            <>
              <div className="gatc-report__list" aria-label="Incentive invoices">
                {pageRows.map(row => {
                  const open = expandedId === row.id;
                  const rawLines = linesByInvoice[row.id];
                  const lines = adjustedLinesByInvoice[row.id];
                  const billedSubtotal = (lines ?? []).reduce((sum, line) => sum + line.total, 0);
                  const rateCardSubtotal = (lines ?? []).reduce(
                    (sum, line) => sum + lineRateCardTotal(line),
                    0,
                  );
                  const lineHikeTotal = (lines ?? []).reduce((sum, line) => (
                    line.priceAdjust === 'hike'
                      ? sum + line.unitHike * (line.adjustQty || line.qty)
                      : sum
                  ), 0);
                  const lineDiscountTotal = (lines ?? []).reduce((sum, line) => (
                    line.priceAdjust === 'discount'
                      ? sum + line.unitDiscount * (line.adjustQty || line.qty)
                      : sum
                  ), 0);
                  const tone = incentiveRowTone(row);
                  const note = incentiveRowNote(row);
                  const overrideKind = invoiceIncentiveRateOverrideKind(row.id, overrides);
                  return (
                    <article
                      key={row.id}
                      className={[
                        'gatc-report__row',
                        open ? 'is-open' : '',
                        overrideKind === 'pending' ? 'is-rate-pending' : '',
                        overrideKind === 'verified' ? 'is-rate-verified' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <button
                        type="button"
                        className="gatc-report__row-main"
                        aria-expanded={open}
                        onClick={() => setExpandedId(open ? null : row.id)}
                      >
                        <strong className="gatc-report__row-customer">
                          {row.customerName || '—'}
                        </strong>
                        <div className="gatc-report__row-line">
                          <span className="gatc-report__row-inv">
                            {row.invoiceNumber}
                            <em>{formatInvoiceDate(row.date)}</em>
                            {overrideKind ? (
                              <span className={`incentive-report__row-flag is-${overrideKind}`}>
                                {overrideKind === 'pending' ? 'Staff update' : 'Verified rate'}
                              </span>
                            ) : null}
                          </span>
                          <span className={[
                            'gatc-report__row-amt',
                            tone === 'discount' ? 'is-discounted' : '',
                            tone === 'hike' || tone === 'director' ? 'is-director' : '',
                          ].filter(Boolean).join(' ')}>
                            <span className="gatc-report__row-amt-main">
                              {formatCurrencyWhole(rateCardSalesForRow(row))}
                            </span>
                            {note ? (
                              <span className="gatc-report__row-amt-note">
                                {note.kind === 'discount'
                                  ? `-${formatCurrencyWhole(note.amount)}`
                                  : formatCurrencyWhole(note.amount)}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </button>
                      {open ? (
                        <div className="incentive-report__detail">
                          {linesLoadingId === row.id && !rawLines ? (
                            <p className="incentive-report__detail-empty">Loading items…</p>
                          ) : !lines?.length ? (
                            <p className="incentive-report__detail-empty">No item lines on this invoice.</p>
                          ) : (
                            <>
                              {lines.map((line, index) => {
                                const lineKey = incentiveLineKey(line, index);
                                const excluded = excludedKeys.has(`${row.id}|${lineKey}`);
                                const canToggle = canExcludeLines && incentiveLineHasAdjust(line);
                                const busy = exclusionBusyKey === `${row.id}|${lineKey}`;
                                const adjustNote = formatLineAdjustNote(line);
                                const override = line.rateOverride ?? null;
                                const pending = Boolean(override && incentiveLineRateOverridePending(override));
                                const draftKey = lineDraftKey(row.id, lineKey);
                                const draft = rateDrafts[draftKey] ?? defaultApplicableDraft(line);
                                const reasonDraft = reasonDrafts[draftKey] ?? defaultReasonDraft(line);
                                const rateBusy = rateBusyKey === draftKey;
                                const draftRate = parseIncentiveTargetInput(draft);
                                const rateDirty = override
                                  ? Math.abs(draftRate - override.applicableRate) > 0.005
                                  : Math.abs(draftRate - (line.listRate > 0 ? line.listRate : line.rate)) > 0.005;
                                const reasonDirty = trimIncentiveRateReason(reasonDraft)
                                  !== trimIncentiveRateReason(override?.reason ?? '');
                                const dirty = rateDirty || reasonDirty;
                                const earlier = Math.max(0, (override?.edits.length ?? 0) - 1);
                                return (
                                <div
                                  key={lineKey}
                                  className={[
                                    'incentive-report__item',
                                    line.priceAdjust === 'discount' ? 'is-discounted' : '',
                                    line.priceAdjust === 'hike' ? 'is-hiked' : '',
                                    excluded ? 'is-excluded' : '',
                                    override ? 'is-rate-override' : '',
                                    pending ? 'is-rate-override-pending' : '',
                                  ].filter(Boolean).join(' ')}
                                >
                                  <div className="incentive-report__item-main">
                                    <span className="incentive-report__item-name">{line.name}</span>
                                    <span className="incentive-report__item-qty">
                                      {line.qty.toLocaleString('en-IN')}
                                    </span>
                                    <span className="incentive-report__item-total">
                                      {formatCurrencyWhole(lineRateCardTotal(line))}
                                    </span>
                                  </div>
                                  <div className="incentive-report__item-meta">
                                    <span>{line.sku || '—'}</span>
                                    <span>({formatCurrencyWhole(line.rate)})</span>
                                    {override ? (
                                      <span>applicable {formatCurrencyWhole(override.applicableRate)}</span>
                                    ) : line.listRate > 0 && Math.abs(line.listRate - line.rate) > 0.005 ? (
                                      <span>list {formatCurrencyWhole(line.listRate)}</span>
                                    ) : null}
                                    {override && override.systemListRate > 0
                                      && Math.abs(override.systemListRate - override.applicableRate) > 0.005 ? (
                                      <span className="incentive-report__was-list">
                                        was {formatCurrencyWhole(override.systemListRate)}
                                      </span>
                                    ) : null}
                                    {adjustNote ? (
                                      <span className="incentive-report__item-note">
                                        {adjustNote}
                                      </span>
                                    ) : null}
                                    {canToggle ? (
                                      <button
                                        type="button"
                                        className={`incentive-report__exclude-btn${excluded ? ' is-active' : ''}`}
                                        aria-pressed={excluded}
                                        disabled={busy}
                                        onClick={() => { void toggleLineExclusion(row, line, index); }}
                                      >
                                        {excluded ? 'Include' : 'Exclude'}
                                      </button>
                                    ) : excluded ? (
                                      <span className="incentive-report__exclude-flag">Excluded</span>
                                    ) : null}
                                  </div>
                                  {canEditRates || override ? (
                                    <div className="incentive-report__item-rate">
                                      {canEditRates ? (
                                        <label className="incentive-report__rate-field">
                                          <span>Applicable</span>
                                          <input
                                            className="incentive-report__rate-input"
                                            inputMode="decimal"
                                            value={draft}
                                            disabled={rateBusy}
                                            aria-label={`Applicable rate for ${line.name}`}
                                            onChange={e => {
                                              const value = e.target.value;
                                              setRateDrafts(current => ({ ...current, [draftKey]: value }));
                                            }}
                                            onKeyDown={e => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                void saveLineApplicableRate(row, index);
                                              }
                                            }}
                                          />
                                        </label>
                                      ) : null}
                                      {canEditRates ? (
                                        <label className="incentive-report__reason-field">
                                          <span>Reason</span>
                                          <input
                                            className="incentive-report__reason-input"
                                            value={reasonDraft}
                                            disabled={rateBusy}
                                            maxLength={INCENTIVE_RATE_REASON_MAX}
                                            placeholder="Slab at invoicing, catalog change…"
                                            aria-label={`Reason for applicable rate on ${line.name}`}
                                            onChange={e => {
                                              const value = e.target.value;
                                              setReasonDrafts(current => ({ ...current, [draftKey]: value }));
                                            }}
                                            onKeyDown={e => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                void saveLineApplicableRate(row, index);
                                              }
                                            }}
                                          />
                                        </label>
                                      ) : null}
                                      {canEditRates && dirty ? (
                                        <button
                                          type="button"
                                          className="incentive-report__rate-save"
                                          disabled={rateBusy || draftRate <= 0}
                                          onClick={() => { void saveLineApplicableRate(row, index); }}
                                        >
                                          {override ? 'Update' : 'Save'}
                                        </button>
                                      ) : null}
                                      {override ? (
                                        <span className={`incentive-report__override-flag${pending ? ' is-pending' : ' is-verified'}`}>
                                          {pending ? 'Staff update' : 'Verified'}
                                          {override.updatedByName ? ` · ${override.updatedByName}` : ''}
                                          {formatOverrideWhen(override.updatedAt)
                                            ? ` · ${formatOverrideWhen(override.updatedAt)}`
                                            : ''}
                                          {earlier > 0 ? ` · +${earlier} earlier` : ''}
                                        </span>
                                      ) : (
                                        <span className="incentive-report__rate-hint">
                                          Incentive only
                                        </span>
                                      )}
                                      {canVerifyRates && pending ? (
                                        <button
                                          type="button"
                                          className="incentive-report__rate-verify"
                                          disabled={rateBusy}
                                          onClick={() => { void verifyLineApplicableRate(row, lineKey); }}
                                        >
                                          Verify
                                        </button>
                                      ) : null}
                                      {canEditRates && override ? (
                                        <button
                                          type="button"
                                          className="incentive-report__rate-clear"
                                          disabled={rateBusy}
                                          onClick={() => { void clearLineApplicableRate(row, lineKey); }}
                                        >
                                          Clear
                                        </button>
                                      ) : null}
                                      {override?.reason ? (
                                        <p className="incentive-report__override-reason">
                                          {override.reason}
                                        </p>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                                );
                              })}
                              <div className="incentive-report__subtotal">
                                <span>
                                  {Math.abs(rateCardSubtotal - billedSubtotal) > 0.5 ? 'Rate card' : 'Sub total'}
                                </span>
                                <strong>{formatCurrencyWhole(rateCardSubtotal)}</strong>
                              </div>
                              {Math.abs(rateCardSubtotal - billedSubtotal) > 0.5 ? (
                                <div className="incentive-report__subtotal is-invoice">
                                  <span>Invoice</span>
                                  <strong>{formatCurrencyWhole(billedSubtotal)}</strong>
                                </div>
                              ) : null}
                              {lineHikeTotal > 0.005 ? (
                                <div className="incentive-report__adjust-sum">
                                  Extra {formatCurrencyWhole(lineHikeTotal)}
                                </div>
                              ) : row.hikeAmount > 0.005 ? (
                                <div className="incentive-report__adjust-sum">
                                  Extra {formatCurrencyWhole(row.hikeAmount)}
                                </div>
                              ) : null}
                              {lineDiscountTotal > 0.005 ? (
                                <div className="incentive-report__adjust-sum is-discount">
                                  Discount {formatCurrencyWhole(lineDiscountTotal)}
                                </div>
                              ) : row.discountAmount > 0.005 ? (
                                <div className="incentive-report__adjust-sum is-discount">
                                  Discount {formatCurrencyWhole(row.discountAmount)}
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>

              {totalPages > 1 ? (
                <footer className="invoices-pagination gatc-report__pagination">
                  <span className="invoices-pagination__info text-muted text-sm">
                    {pageRows.length
                      ? `${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + pageRows.length}`
                      : '0'}
                    {' of '}
                    {listed.length.toLocaleString('en-IN')}
                  </span>
                  <div className="invoices-pagination__btns">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={page <= 1}
                      onClick={() => setPage(p => p - 1)}
                    >
                      Prev
                    </button>
                    <span className="invoices-pagination__page text-sm">
                      {page} / {totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage(p => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                </footer>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
};
