import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { RegionalCentreModal } from '../../components/yesgatc/RegionalCentreModal';
import { useCatalogPageHeader, usePageHeaderSlot, useTopBarAction } from '../../context/PageHeaderContext';
import {
  dedupeYesGatcRcDetails,
  listYesGatcRcDetails,
  rematerializeYesGatcRcDetails,
  yesGatcRcCertifiedCount,
  yesGatcRcContactLabel,
  yesGatcRcJobsCount,
  yesGatcRcOfficeName,
  yesGatcRcPlaceDistrictLine,
  type YesGatcRcDetail,
} from '../../lib/yesgatcRecords';

function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString('en-IN');
}

function matchesQuery(row: YesGatcRcDetail, needle: string): boolean {
  if (!needle) return true;
  const blob = [
    yesGatcRcOfficeName(row),
    row.code,
    row.companyName,
    row.contactPerson,
    row.place,
    row.city,
    row.district,
    row.state,
    row.phone,
    row.email,
    row.gstNumber,
    row.dealerName,
  ].filter(Boolean).join(' ').toLowerCase();
  return blob.includes(needle);
}

export const RegionalCentresPage: React.FC = () => {
  const [rows, setRows] = useState<YesGatcRcDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; row: YesGatcRcDetail | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(dedupeYesGatcRcDetails(await listYesGatcRcDetails()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load regional centres.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = appliedQuery.trim().toLowerCase();
    return [...rows]
      .filter(row => matchesQuery(row, needle))
      .sort((a, b) => {
        const byCert = (yesGatcRcCertifiedCount(b) ?? -1) - (yesGatcRcCertifiedCount(a) ?? -1);
        if (byCert !== 0) return byCert;
        return yesGatcRcOfficeName(a).localeCompare(yesGatcRcOfficeName(b), 'en', { sensitivity: 'base' });
      });
  }, [appliedQuery, rows]);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedQuery(draftQuery);
  };

  const handleReset = () => {
    setDraftQuery('');
    setAppliedQuery('');
  };

  const handleRematerialize = async () => {
    if (syncing) return;
    setSyncing(true);
    setError('');
    try {
      await rematerializeYesGatcRcDetails();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh RC fields from YesGATC payloads.');
    } finally {
      setSyncing(false);
    }
  };

  useCatalogPageHeader({
    title: 'Regional Centres',
    subtitle: 'Manage centres, VCTs and certification progress.',
  }, true);

  const headerSearch = useMemo(
    () => (
      <form className="regional-centres-search" onSubmit={handleSearch}>
        <label className="catalog-search invoices-header-search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={draftQuery}
            onChange={event => setDraftQuery(event.target.value)}
            placeholder="Search…"
            aria-label="Search regional centres"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm">Search</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleReset}>Reset</button>
      </form>
    ),
    [draftQuery],
  );

  const headerActions = useMemo(
    () => (
      <div className="regional-centres-actions">
        <button
          type="button"
          className="catalog-header-filter-btn"
          onClick={() => void handleRematerialize()}
          disabled={syncing || loading}
          title="Pull structured fields from stored YesGATC payloads"
          aria-label="Refresh from YesGATC payloads"
        >
          <RefreshCw size={18} className={syncing ? 'spin-icon' : undefined} />
        </button>
        <button
          type="button"
          className="catalog-header-filter-btn create-po-header-btn dealers-add-btn"
          onClick={() => setModal({ mode: 'create', row: null })}
          aria-label="Add regional centre"
          title="Add regional centre"
        >
          <Plus size={20} strokeWidth={2.5} />
          <span className="dealers-add-btn__label">Add</span>
        </button>
      </div>
    ),
    [loading, syncing],
  );

  usePageHeaderSlot(headerSearch);
  useTopBarAction(headerActions);

  return (
    <div className="page-content fade-in regional-centres-page">
      {error ? <p className="settings-locations__error">{error}</p> : null}

      <section className="panel glass panel--table regional-centres-panel">
        <div className="panel-body p-0">
          {loading ? (
            <div className="regional-centres-loading">
              <Loader2 size={22} className="spin-icon" />
              <span>Loading centres…</span>
            </div>
          ) : (
            <>
              <p className="regional-centres-count text-muted text-sm">
                {filtered.length.toLocaleString('en-IN')} centre{filtered.length === 1 ? '' : 's'}
                {appliedQuery.trim() ? ` matching “${appliedQuery.trim()}”` : ''}
              </p>
              <div className="table-scroll-wrap">
                <table className="data-table data-table--rc">
                  <thead>
                    <tr>
                      <th>Centre</th>
                      <th>Location</th>
                      <th>Contact</th>
                      <th className="text-right">VCT</th>
                      <th className="text-right">Jobs</th>
                      <th className="text-right">Certified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, index) => {
                      const name = yesGatcRcOfficeName(row);
                      const code = row.code?.trim() || '';
                      const location = yesGatcRcPlaceDistrictLine(row) || '—';
                      const contact = yesGatcRcContactLabel(row) || '—';
                      return (
                        <tr key={row.id}>
                          <td>
                            <button
                              type="button"
                              className="regional-centres-name"
                              onClick={() => setModal({ mode: 'edit', row })}
                            >
                              <span className="regional-centres-name__index">#{index + 1}</span>
                              <span className="regional-centres-name__copy">
                                <strong>{name}</strong>
                                {code ? <span className="text-muted text-sm">{code}</span> : null}
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="regional-centres-cell" title={location !== '—' ? location : undefined}>
                              {location}
                            </span>
                          </td>
                          <td>
                            <span className="regional-centres-cell" title={contact !== '—' ? contact : undefined}>
                              {contact}
                            </span>
                          </td>
                          <td className="text-right">{formatCount(row.vctCount)}</td>
                          <td className="text-right">{formatCount(yesGatcRcJobsCount(row))}</td>
                          <td className="text-right">
                            <strong>{formatCount(yesGatcRcCertifiedCount(row))}</strong>
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-10 text-muted">
                          {appliedQuery.trim()
                            ? 'No centres match this search.'
                            : 'No regional centres yet. Click + to add one, or wait for YesGATC webhook sync.'}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </section>

      {modal ? (
        <RegionalCentreModal
          mode={modal.mode}
          row={modal.row}
          onClose={() => setModal(null)}
          onSaved={next => {
            setRows(current => {
              const without = current.filter(row => row.id !== next.id);
              return dedupeYesGatcRcDetails([next, ...without]);
            });
          }}
        />
      ) : null}
    </div>
  );
};
