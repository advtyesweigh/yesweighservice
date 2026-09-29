import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Upload,
} from 'lucide-react';
import { formatCurrencyWhole } from '../../../lib/catalog';
import {
  fetchGatcInvoiceLineSerials,
  gatcReportMonthKey,
  listGatcReportsInDateRange,
  serialsForGatcLine,
  sumGatcFeeShares,
  sumGatcQtyByWeightBand,
  type GatcInvoiceLineSerials,
  type GatcReportDoc,
  type GatcReportLineItem,
} from '../../../lib/gatcReports';
import {
  PORTAL_KAM_DISPLAY_NAMES,
  canonicalSalespersonName,
  isPortalVisibleKamName,
  portalKamKey,
} from '../../../lib/dealerKamDisplay';

const PAGE_SIZE = 25;
/** First month available in the GATC month filter. */
const GATC_MONTH_START = '2026-04';

function isGatcReportFreightLine(line: Pick<GatcReportLineItem, 'name' | 'sku'>): boolean {
  const name = line.name.trim().toLowerCase();
  if (name === 'freight' || name.includes('freight')) return true;
  const sku = line.sku?.trim().toLowerCase() ?? '';
  return sku === 'freight' || sku.includes('freight');
}

function gatcReportDisplayLines(report: GatcReportDoc): GatcReportLineItem[] {
  return report.lineItems.filter(line => !isGatcReportFreightLine(line));
}

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

function monthRange(yearMonth: string): { dateStart: string; dateEnd: string } {
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    dateStart: `${yearMonth}-01`,
    dateEnd: `${yearMonth}-${String(lastDay).padStart(2, '0')}`,
  };
}

function parseReportDate(value: string | null | undefined): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  // YYYY-MM-DD (date-only) — treat as local calendar day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatInvoiceDate(report: GatcReportDoc): string {
  const invoiceAt = parseReportDate(report.invoiceDate);
  if (!invoiceAt) return formatStampedOn(report).date;
  return invoiceAt.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatStampedOn(report: GatcReportDoc): { date: string; time: string } {
  const stampedAt = parseReportDate(report.createdAt) ?? parseReportDate(report.invoiceDate);
  if (!stampedAt) return { date: '—', time: '' };
  return {
    date: stampedAt.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    time: stampedAt.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }),
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportGatcReportsCsv(reports: GatcReportDoc[], monthLabel: string): void {
  const headers = [
    'Invoice No',
    'Customer',
    'Invoice Date',
    'Salesperson',
    'Sales Order',
    'Stamped Qty',
    'GATC Fees',
    'Stamped On',
  ];
  const lines = [
    headers.join(','),
    ...reports.map(report => {
      const stamped = formatStampedOn(report);
      return [
        report.invoiceNumber || report.invoiceId,
        report.customerName || '',
        report.invoiceDate || '',
        report.salespersonName || '',
        report.salesOrderNumber || '',
        String(report.totals.stampedQty),
        String(report.totals.gatcFeeTotal),
        [stamped.date, stamped.time].filter(Boolean).join(' '),
      ].map(value => csvEscape(String(value))).join(',');
    }),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gatc-report-${monthLabel.replace(/\s+/g, '-').toLowerCase()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const GatcReportTab: React.FC = () => {
  const monthOptions = useMemo(
    () => buildMonthOptions(GATC_MONTH_START, currentYearMonth()),
    [],
  );
  const defaultMonth = monthOptions[0]?.value || GATC_MONTH_START;

  const [rows, setRows] = useState<GatcReportDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [month, setMonth] = useState(defaultMonth);
  const [kam, setKam] = useState('');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [serialsByInvoice, setSerialsByInvoice] = useState<
    Record<string, GatcInvoiceLineSerials[]>
  >({});
  const [serialsLoadingId, setSerialsLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { dateStart, dateEnd } = monthRange(month);
    setLoading(true);
    setError('');
    setRows([]);
    void listGatcReportsInDateRange({ dateStart, dateEnd, maxRows: 2000 })
      .then(reports => {
        if (cancelled) return;
        setRows(reports.filter(report => gatcReportMonthKey(report.invoiceDate) === month));
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load GATC report.');
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  useEffect(() => {
    setPage(1);
    setExpandedId(null);
  }, [month, kam]);

  useEffect(() => {
    if (!expandedId) return;
    const report = rows.find(row => row.id === expandedId);
    if (!report) return;
    const invoiceId = report.invoiceId.trim();
    if (!invoiceId || serialsByInvoice[invoiceId] !== undefined) return;

    let cancelled = false;
    setSerialsLoadingId(invoiceId);
    void fetchGatcInvoiceLineSerials(report.customerId, invoiceId)
      .then(lines => {
        if (!cancelled) {
          setSerialsByInvoice(prev => ({ ...prev, [invoiceId]: lines }));
        }
      })
      .finally(() => {
        if (!cancelled) setSerialsLoadingId(current => (current === invoiceId ? null : current));
      });

    return () => {
      cancelled = true;
    };
  }, [expandedId, rows, serialsByInvoice]);

  const monthRows = useMemo(() => {
    return rows.filter(report => gatcReportMonthKey(report.invoiceDate) === month);
  }, [rows, month]);

  const kamOptions = useMemo(() => {
    const names = new Set<string>(PORTAL_KAM_DISPLAY_NAMES);
    for (const report of monthRows) {
      const name = canonicalSalespersonName(report.salespersonName);
      if (name && isPortalVisibleKamName(name)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'en'));
  }, [monthRows]);

  useEffect(() => {
    if (kam && !kamOptions.includes(kam)) setKam('');
  }, [kam, kamOptions]);

  const filtered = useMemo(() => {
    if (!kam) return monthRows;
    return monthRows.filter(report => portalKamKey(report.salespersonName) === portalKamKey(kam));
  }, [monthRows, kam]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const kpis = useMemo(() => {
    const gatcFeeTotal = filtered.reduce((sum, row) => sum + row.totals.gatcFeeTotal, 0);
    const stampedQty = filtered.reduce((sum, row) => sum + row.totals.stampedQty, 0);
    const invoiceCount = filtered.length;
    const stampedLines = filtered.flatMap(report => gatcReportDisplayLines(report));
    const share = sumGatcFeeShares(stampedLines);
    const qtyBand = sumGatcQtyByWeightBand(stampedLines);
    return {
      invoiceCount,
      gatcFeeTotal,
      stampedQty,
      qtyUpto20kg: qtyBand.upto20kg,
      qtyAbove20kg: qtyBand.above20kg,
      yesweigh: share.yesweigh,
      contractor: share.contractor,
    };
  }, [filtered]);

  const monthLabel = monthOptions.find(opt => opt.value === month)?.label || month;

  const handleExport = useCallback(() => {
    exportGatcReportsCsv(filtered, monthLabel);
  }, [filtered, monthLabel]);

  return (
    <section className="gatc-report">
      {error ? <p className="gatc-report__error text-sm">{error}</p> : null}

      {loading ? (
        <div className="gatc-report__loading">
          <div className="loader-ring" />
        </div>
      ) : (
        <>
          <div className="gatc-report__kpis" aria-label="GATC summary">
            <article className="gatc-report__kpi gatc-report__kpi--inv">
              <span className="gatc-report__kpi-label">INV</span>
              <strong className="gatc-report__kpi-value">
                {kpis.invoiceCount.toLocaleString('en-IN')}
              </strong>
            </article>

            <article className="gatc-report__kpi gatc-report__kpi--qty" aria-label="Stamped quantity split">
              <div className="gatc-report__kpi-head">
                <span className="gatc-report__kpi-label">Total Qty</span>
                <strong className="gatc-report__kpi-value">
                  {kpis.stampedQty.toLocaleString('en-IN')}
                </strong>
              </div>
              <dl className="gatc-report__stat-list">
                <div className="gatc-report__stat gatc-report__stat--light">
                  <dt>Below 20 kg</dt>
                  <dd>{kpis.qtyUpto20kg.toLocaleString('en-IN')}</dd>
                </div>
                <div className="gatc-report__stat gatc-report__stat--heavy">
                  <dt>Above 20 kg</dt>
                  <dd>{kpis.qtyAbove20kg.toLocaleString('en-IN')}</dd>
                </div>
              </dl>
            </article>

            <article className="gatc-report__kpi gatc-report__kpi--fees" aria-label="GATC fees split">
              <dl className="gatc-report__stat-list gatc-report__stat-list--fees">
                <div className="gatc-report__stat gatc-report__stat--t">
                  <dt>Total</dt>
                  <dd>{formatCurrencyWhole(kpis.gatcFeeTotal)}</dd>
                </div>
                <div className="gatc-report__stat gatc-report__stat--y">
                  <dt>Yesweigh</dt>
                  <dd>{formatCurrencyWhole(kpis.yesweigh)}</dd>
                </div>
                <div className="gatc-report__stat gatc-report__stat--c">
                  <dt>Contractor</dt>
                  <dd>{formatCurrencyWhole(kpis.contractor)}</dd>
                </div>
              </dl>
            </article>
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
              <label className="gatc-report__kam">
                <select
                  value={kam}
                  onChange={e => setKam(e.target.value)}
                  aria-label="KAM"
                >
                  <option value="">All KAM</option>
                  {kamOptions.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="gatc-report__export-btn"
              disabled={loading || filtered.length === 0}
              onClick={handleExport}
            >
              <Upload size={15} aria-hidden />
              Export
            </button>
          </div>

          {filtered.length === 0 ? (
            <div className="gatc-report__empty">
              <FileText size={28} aria-hidden />
              <strong>{rows.length === 0 ? 'No stamped invoices yet' : 'No matching invoices'}</strong>
              <p>
                {rows.length === 0
                  ? 'Entries appear when a stamped portal invoice is created or synced.'
                  : 'Try another month or KAM.'}
              </p>
            </div>
          ) : (
            <>
              <div className="gatc-report__list" aria-label="GATC report">
                {pageRows.map(report => {
                  const open = expandedId === report.id;
                  const feeLines = gatcReportDisplayLines(report).filter(
                    line => line.hasStamping && line.lineGatcTotal > 0,
                  );
                  const invoiceSerialLines = serialsByInvoice[report.invoiceId] ?? [];
                  const usedSerialLines = new Set<number>();
                  return (
                    <article
                      key={report.id}
                      className={`gatc-report__row${open ? ' is-open' : ''}`}
                    >
                      <button
                        type="button"
                        className="gatc-report__row-main"
                        aria-expanded={open}
                        onClick={() => setExpandedId(open ? null : report.id)}
                      >
                        <strong className="gatc-report__row-customer">
                          {report.customerName || '—'}
                        </strong>
                        <div className="gatc-report__row-line">
                          <span className="gatc-report__row-inv">
                            {report.invoiceNumber || report.invoiceId}
                            <em>{formatInvoiceDate(report)}</em>
                          </span>
                          <span className="gatc-report__row-qty">
                            {report.totals.stampedQty.toLocaleString('en-IN')}
                          </span>
                          <span className="gatc-report__row-amt">
                            {formatCurrencyWhole(report.totals.gatcFeeTotal)}
                          </span>
                        </div>
                      </button>
                      {open ? (
                        <div className="gatc-report__detail">
                          <table className="gatc-report__detail-table">
                            <thead>
                              <tr>
                                <th>Item name</th>
                                <th className="is-num">Fees</th>
                                <th className="is-num">Qty</th>
                                <th className="is-num">Total fees</th>
                              </tr>
                            </thead>
                            <tbody>
                              {feeLines.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="gatc-report__detail-empty">
                                    No fee lines on this invoice.
                                  </td>
                                </tr>
                              ) : (
                                feeLines.map((line, index) => {
                                  const serials = serialsForGatcLine(
                                    line,
                                    invoiceSerialLines,
                                    usedSerialLines,
                                  );
                                  return (
                                    <tr
                                      key={`${line.productId || line.itemId || 'line'}-${index}`}
                                    >
                                      <td>
                                        <div className="gatc-report__detail-item">{line.name}</div>
                                        {serials.length > 0 ? (
                                          <div className="gatc-report__detail-serials">
                                            {serials.join(' · ')}
                                          </div>
                                        ) : serialsLoadingId === report.invoiceId && index === 0 ? (
                                          <div className="gatc-report__detail-serials is-loading">
                                            Loading serials…
                                          </div>
                                        ) : null}
                                      </td>
                                      <td className="is-num">
                                        {formatCurrencyWhole(
                                          line.gatcFeePerUnit > 0
                                            ? line.gatcFeePerUnit
                                            : (line.qty > 0 ? line.lineGatcTotal / line.qty : 0),
                                        )}
                                      </td>
                                      <td className="is-num">
                                        {line.qty.toLocaleString('en-IN')}
                                      </td>
                                      <td className="is-num">
                                        {formatCurrencyWhole(line.lineGatcTotal)}
                                      </td>
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                            {feeLines.length > 0 ? (
                              <tfoot>
                                <tr className="gatc-report__detail-total">
                                  <th colSpan={3} scope="row">Total fees</th>
                                  <td className="is-num">
                                    {formatCurrencyWhole(report.totals.gatcFeeTotal)}
                                  </td>
                                </tr>
                              </tfoot>
                            ) : null}
                          </table>
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
                    {filtered.length.toLocaleString('en-IN')}
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
