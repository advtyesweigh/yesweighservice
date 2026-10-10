import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, ShoppingCart, X } from 'lucide-react';
import { formatCurrency, formatStockQuantity } from '../../lib/catalog';
import { loadCatalogProductStockLedger, isBrokenStockLedger } from '../../lib/catalogProductAudit/loadStockLedger';
import {
  formatPeriodLabel,
  inPeriod,
  resolvePeriodBounds,
  type PeriodPreset,
} from '../../lib/catalogProductAudit/stockLedgerPeriod';
import type { CatalogProduct } from '../../types/catalog';
import type {
  CatalogProductStockMovementsResult,
  CatalogStockMovement,
} from '../../types/catalog-product-audit';
import {
  StockLedgerPagination,
  useLedgerPagination,
} from './StockLedgerPagination';

interface CustomerInvoiceLine {
  key: string;
  documentNumber: string;
  date: string;
  status: string;
  quantity: number;
  itemPrice: number | null;
  itemTotal: number | null;
  currencyCode: string | null;
  currencySymbol: string | null;
}

interface CustomerSalesRow {
  customerKey: string;
  customerName: string;
  invoiceCount: number;
  returnCount: number;
  qtySold: number;
  qtyReturned: number;
  netQty: number;
  lastSaleDate: string;
  invoices: CustomerInvoiceLine[];
}

function isVoidRow(row: CatalogStockMovement): boolean {
  return row.affectsStock === false && String(row.status).toLowerCase().includes('void');
}

function isSalesMovement(row: CatalogStockMovement): boolean {
  return row.type === 'invoice' || row.type === 'creditnote' || row.type === 'salesreturn';
}

function soldQty(row: CatalogStockMovement): number {
  if (isVoidRow(row)) return 0;
  return Math.abs(Number(row.quantity) || Math.abs(Number(row.displayQtyDelta ?? row.qtyDelta) || 0));
}

function finiteAmount(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function invoiceLineFromMovement(row: CatalogStockMovement, index: number): CustomerInvoiceLine {
  return {
    key: `${row.documentId || row.documentNumber}:${row.date}:${index}`,
    documentNumber: String(row.documentNumber || '').trim() || 'Invoice',
    date: String(row.date || '').slice(0, 10),
    status: String(row.status || '').trim(),
    quantity: soldQty(row),
    itemPrice: finiteAmount(row.itemPrice),
    itemTotal: finiteAmount(row.itemTotal),
    currencyCode: row.currencyCode ?? null,
    currencySymbol: row.currencySymbol ?? null,
  };
}

function formatInvoiceMoney(
  amount: number | null,
  currencyCode: string | null,
  currencySymbol: string | null,
): string {
  if (amount == null) return '—';
  if (currencyCode) return formatCurrency(amount, currencyCode);
  if (currencySymbol) {
    const formatted = amount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${currencySymbol}${formatted}`;
  }
  return formatCurrency(amount, 'INR');
}

function invoiceLineAmount(line: CustomerInvoiceLine): number | null {
  if (line.itemTotal != null) return line.itemTotal;
  if (line.itemPrice != null) return line.itemPrice * line.quantity;
  return null;
}

function formatInvoiceStatus(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function aggregateSalesByCustomer(rows: CatalogStockMovement[]): CustomerSalesRow[] {
  const byCustomer = new Map<string, CustomerSalesRow>();

  for (const row of rows) {
    if (!isSalesMovement(row)) continue;

    const customerName = String(row.customerOrVendor ?? '').trim() || 'Unknown dealer';
    const customerKey = customerName.toLowerCase();
    const existing = byCustomer.get(customerKey) ?? {
      customerKey,
      customerName,
      invoiceCount: 0,
      returnCount: 0,
      qtySold: 0,
      qtyReturned: 0,
      netQty: 0,
      lastSaleDate: '',
      invoices: [],
    };

    const qty = soldQty(row);
    const date = String(row.date || '').slice(0, 10);

    if (row.type === 'invoice') {
      if (!isVoidRow(row)) {
        existing.invoiceCount += 1;
        existing.qtySold += qty;
        existing.invoices.push(invoiceLineFromMovement(row, existing.invoices.length));
        if (date && date > existing.lastSaleDate) existing.lastSaleDate = date;
      }
    } else if (qty > 0) {
      existing.returnCount += 1;
      existing.qtyReturned += qty;
    }

    byCustomer.set(customerKey, existing);
  }

  return [...byCustomer.values()]
    .map(row => ({
      ...row,
      netQty: row.qtySold - row.qtyReturned,
      invoices: [...row.invoices].sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.documentNumber.localeCompare(a.documentNumber);
      }),
    }))
    .filter(row => row.invoiceCount > 0 || row.returnCount > 0)
    .sort((a, b) => {
      if (b.netQty !== a.netQty) return b.netQty - a.netQty;
      if (b.qtySold !== a.qtySold) return b.qtySold - a.qtySold;
      return a.customerName.localeCompare(b.customerName);
    });
}

function formatSaleDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCustomerDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Unknown dealer';
  // Soften ALL-CAPS dealer names for the compact list.
  if (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) && trimmed.length > 3) {
    const small = new Set(['AND', 'OF', 'THE', 'FOR', 'A', 'AN']);
    return trimmed
      .toLowerCase()
      .split(/(\s+|[-/&])/)
      .map((part, index) => {
        if (!part || /^[\s\-/&]+$/.test(part)) return part;
        const upper = part.toUpperCase();
        if (index > 0 && small.has(upper)) return part.toLowerCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('');
  }
  return trimmed;
}

function InvoiceCountButton({
  count,
  onClick,
  labelled = false,
}: {
  count: number;
  onClick: () => void;
  labelled?: boolean;
}) {
  const label = `${count.toLocaleString('en-IN')} invoice${count === 1 ? '' : 's'}`;
  if (count <= 0) {
    return (
      <span className="stock-ledger__invoice-count is-empty">
        0
        {labelled ? <span className="stock-ledger__invoice-count-label">inv</span> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="stock-ledger__invoice-count"
      onClick={onClick}
      aria-label={label}
    >
      {count.toLocaleString('en-IN')}
      {labelled ? <span className="stock-ledger__invoice-count-label">inv</span> : null}
    </button>
  );
}

function SalesCustomerTile({
  row,
  unit,
  onOpenInvoices,
}: {
  row: CustomerSalesRow;
  unit: string;
  onOpenInvoices: () => void;
}) {
  return (
    <article className="stock-ledger__sales-tile">
      <strong className="stock-ledger__sales-tile-name">
        {formatCustomerDisplayName(row.customerName)}
      </strong>
      <span className="stock-ledger__sales-tile-end">
        <InvoiceCountButton count={row.invoiceCount} onClick={onOpenInvoices} labelled />
        <span className="stock-ledger__sales-tile-sold">
          <strong>{row.qtySold.toLocaleString('en-IN')}</strong>
          <span>{unit}</span>
        </span>
      </span>
    </article>
  );
}

function DealerInvoicesDialog({
  dealer,
  productName,
  unit,
  onClose,
}: {
  dealer: CustomerSalesRow;
  productName: string;
  unit: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const titleId = 'dealer-invoices-title';

  return createPortal(
    <div
      className="spare-link-editor-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="stock-ledger__invoices-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={event => event.stopPropagation()}
      >
        <header className="stock-ledger__invoices-dialog-header">
          <div>
            <h2 id={titleId}>{dealer.customerName}</h2>
            <p className="text-muted text-sm">
              {productName}
              {' · '}
              {dealer.invoiceCount.toLocaleString('en-IN')} invoice{dealer.invoiceCount === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            className="stock-ledger__invoices-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        {dealer.invoices.length === 0 ? (
          <p className="stock-ledger__invoices-empty">No invoices for this dealer.</p>
        ) : (
          <div className="stock-ledger__invoices-table-wrap">
            <table className="stock-ledger__invoices-table">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Date</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Price</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dealer.invoices.map(line => (
                  <tr key={line.key}>
                    <td>
                      <strong>{line.documentNumber}</strong>
                      {line.status ? (
                        <span className="stock-ledger__invoices-status">
                          {formatInvoiceStatus(line.status)}
                        </span>
                      ) : null}
                    </td>
                    <td>{formatSaleDate(line.date)}</td>
                    <td className="stock-ledger__invoices-num">
                      {line.quantity.toLocaleString('en-IN')}
                      <span>{unit}</span>
                    </td>
                    <td className="stock-ledger__invoices-num stock-ledger__invoices-price">
                      {formatInvoiceMoney(line.itemPrice, line.currencyCode, line.currencySymbol)}
                      {line.itemPrice != null ? <span>/ {unit}</span> : null}
                    </td>
                    <td className="stock-ledger__invoices-num">
                      {formatInvoiceMoney(invoiceLineAmount(line), line.currencyCode, line.currencySymbol)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export const ProductSalesPanel: React.FC<{
  product: CatalogProduct;
  active?: boolean;
}> = ({ product, active = true }) => {
  const [data, setData] = useState<CatalogProductStockMovementsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('lifetime');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [invoiceCustomerKey, setInvoiceCustomerKey] = useState<string | null>(null);

  const unit = product.unit || 'nos';

  const load = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await loadCatalogProductStockLedger(product.id);
      if (isBrokenStockLedger(result)) {
        setError('Could not load sales from Zoho. Try Refresh again.');
      }
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sales.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [product.id]);

  useEffect(() => {
    if (!active) return;
    setData(null);
    setError(null);
    setPeriodPreset('lifetime');
    setCustomFrom('');
    setCustomTo('');
    setInvoiceCustomerKey(null);
    void load();
  }, [product.id, active, load]);

  const period = useMemo(
    () => resolvePeriodBounds(periodPreset, customFrom, customTo),
    [periodPreset, customFrom, customTo],
  );

  const periodSalesRows = useMemo(() => {
    if (!data) return [];
    const salesOnly = data.movements.filter(row => isSalesMovement(row));
    return salesOnly.filter(row => inPeriod(row.date, period.from, period.to));
  }, [data, period.from, period.to]);

  const customerRows = useMemo(
    () => aggregateSalesByCustomer(periodSalesRows),
    [periodSalesRows],
  );

  const invoiceDealer = useMemo(
    () => customerRows.find(row => row.customerKey === invoiceCustomerKey) ?? null,
    [customerRows, invoiceCustomerKey],
  );

  const closeInvoices = useCallback(() => setInvoiceCustomerKey(null), []);

  useEffect(() => {
    if (!invoiceCustomerKey) return;
    if (!customerRows.some(row => row.customerKey === invoiceCustomerKey)) {
      setInvoiceCustomerKey(null);
    }
  }, [invoiceCustomerKey, customerRows]);

  const paginationResetKey = `${product.id}:${periodPreset}:${period.from ?? ''}:${period.to ?? ''}`;
  const {
    page,
    setPage,
    totalPages,
    paginatedRows,
    totalCount,
    rangeStart,
    rangeEnd,
  } = useLedgerPagination(customerRows, paginationResetKey);

  const summary = useMemo(() => {
    const customers = customerRows.length;
    let totalSold = 0;
    let totalReturned = 0;
    for (const row of customerRows) {
      totalSold += row.qtySold;
      totalReturned += row.qtyReturned;
    }
    return {
      customers,
      totalSold,
      totalReturned,
      netSold: totalSold - totalReturned,
    };
  }, [customerRows]);

  const dateRangeLabel = useMemo(
    () => formatPeriodLabel(periodPreset, period.from, period.to),
    [periodPreset, period.from, period.to],
  );

  const lastUpdated = data?.fetchedAt
    ? new Date(data.fetchedAt).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    : null;

  const imageUrl = product.imageUrl || product.imageUrls?.[0] || null;
  const hasData = data != null;

  return (
    <div className="stock-ledger stock-ledger--sales">
      <header className="stock-ledger__header">
        <h3 className="stock-ledger__title">Sales Ledger</h3>
        <button
          type="button"
          className="stock-ledger__refresh"
          disabled={loading || refreshing}
          onClick={() => void load(true)}
          aria-label="Refresh from Zoho"
          title="Refresh from Zoho"
        >
          <RefreshCw size={16} className={refreshing || (loading && !hasData) ? 'spin-icon' : undefined} aria-hidden />
        </button>
      </header>

      <section className="stock-ledger__product" aria-label="Product">
        <div className="stock-ledger__product-media">
          {imageUrl ? (
            <img src={imageUrl} alt="" />
          ) : (
            <span className="stock-ledger__product-placeholder" aria-hidden />
          )}
        </div>
        <div className="stock-ledger__product-meta">
          <p className="stock-ledger__product-name">{product.name}</p>
          <p className="stock-ledger__product-line">
            {[product.sku?.trim() || null, unit].filter(Boolean).join(' · ')}
          </p>
        </div>
      </section>

      {error && <p className="stock-ledger__error">{error}</p>}

      {loading && !hasData && (
        <p className="stock-ledger__status">Loading sales ledger…</p>
      )}

      {hasData && (
        <>
          <section className="stock-ledger__summary" aria-label="Sales summary">
            <div className="stock-ledger__stat">
              <span className="stock-ledger__stat-label">Dealers</span>
              <strong className="stock-ledger__stat-value is-neutral">
                {summary.customers.toLocaleString('en-IN')}
              </strong>
            </div>
            <div className="stock-ledger__stat">
              <span className="stock-ledger__stat-label">Total Sold</span>
              <strong className="stock-ledger__stat-value is-out">
                {formatStockQuantity(summary.totalSold, unit)}
              </strong>
            </div>
            <div className="stock-ledger__stat">
              <span className="stock-ledger__stat-label">Returns</span>
              <strong className="stock-ledger__stat-value is-in">
                {formatStockQuantity(summary.totalReturned, unit)}
              </strong>
            </div>
            <div className="stock-ledger__stat">
              <span className="stock-ledger__stat-label">Net Sold</span>
              <strong className="stock-ledger__stat-value is-neutral">
                {formatStockQuantity(summary.netSold, unit)}
              </strong>
            </div>
          </section>

          <div className="stock-ledger__filters">
            <label className="stock-ledger__filter stock-ledger__filter--period">
              <span className="visually-hidden">Period</span>
              <select
                value={periodPreset}
                onChange={e => setPeriodPreset(e.target.value as PeriodPreset)}
                aria-label="Period"
              >
                <option value="month">This month</option>
                <option value="financial_year">This year (FY)</option>
                <option value="lifetime">Lifetime</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {periodPreset === 'custom' ? (
              <div className="stock-ledger__custom-dates">
                <label className="stock-ledger__filter">
                  <span className="visually-hidden">Start date</span>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    aria-label="Start date"
                  />
                </label>
                <span className="stock-ledger__custom-sep" aria-hidden>–</span>
                <label className="stock-ledger__filter">
                  <span className="visually-hidden">End date</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    aria-label="End date"
                  />
                </label>
              </div>
            ) : null}
            <p className="stock-ledger__filter-hint text-muted text-sm">{dateRangeLabel}</p>
          </div>

          <StockLedgerPagination
            page={page}
            totalPages={totalPages}
            totalCount={totalCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPageChange={setPage}
            label="Sales pagination"
          />

          {customerRows.length === 0 ? (
            <p className="stock-ledger__empty">No sales in this period.</p>
          ) : (
            <>
              <div className="stock-ledger__sales-tiles" aria-label="Sales by dealer">
                {paginatedRows.map(row => (
                  <SalesCustomerTile
                    key={row.customerKey}
                    row={row}
                    unit={unit}
                    onOpenInvoices={() => setInvoiceCustomerKey(row.customerKey)}
                  />
                ))}
              </div>

              <div className="stock-ledger__table-wrap stock-ledger__table-wrap--sales-desktop">
                <table className="stock-ledger__table stock-ledger__table--sales">
                  <thead>
                    <tr>
                      <th scope="col">Dealer</th>
                      <th scope="col">Invoices</th>
                      <th scope="col">Last sale</th>
                      <th scope="col">Sold</th>
                      <th scope="col">Returns</th>
                      <th scope="col">Net qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedRows.map(row => (
                      <tr key={row.customerKey}>
                        <td>
                          <div className="stock-ledger__customer">
                            <span className="stock-ledger__type-icon stock-ledger__type-icon--inline" aria-hidden>
                              <ShoppingCart size={14} />
                            </span>
                            <strong>{row.customerName}</strong>
                          </div>
                        </td>
                        <td>
                          <InvoiceCountButton
                            count={row.invoiceCount}
                            onClick={() => setInvoiceCustomerKey(row.customerKey)}
                          />
                        </td>
                        <td>{formatSaleDate(row.lastSaleDate)}</td>
                        <td className="stock-ledger__qty is-out">
                          <strong>{row.qtySold.toLocaleString('en-IN')}</strong>
                          <span>{unit}</span>
                        </td>
                        <td className="stock-ledger__qty is-in">
                          <strong>{row.qtyReturned.toLocaleString('en-IN')}</strong>
                          <span>{unit}</span>
                        </td>
                        <td className="stock-ledger__closing">
                          <strong>{row.netQty.toLocaleString('en-IN')}</strong>
                          <span>{unit}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <StockLedgerPagination
            page={page}
            totalPages={totalPages}
            totalCount={totalCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPageChange={setPage}
            label="Sales pagination"
          />

          {invoiceDealer ? (
            <DealerInvoicesDialog
              dealer={invoiceDealer}
              productName={product.name}
              unit={unit}
              onClose={closeInvoices}
            />
          ) : null}

          <footer className="stock-ledger__footer">
            <p>Sorted by net quantity bought — highest first. Void invoices excluded.</p>
            {lastUpdated ? (
              <p>Last updated: {lastUpdated}</p>
            ) : null}
          </footer>
        </>
      )}
    </div>
  );
};
