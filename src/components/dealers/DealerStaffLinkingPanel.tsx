import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Play, RefreshCw, Undo2, UserPlus } from 'lucide-react';
import { FetchingLoader } from '../FetchingLoader';
import {
  analyzeDealerStaffLinking,
  assignNoUsableInvoiceDealers,
  backfillDealerAssignedStaff,
  dealerErrorMessage,
  listAssignableDealerStaff,
  subscribeDealerStaffLinkingCheck,
  undoNoUsableInvoiceAssign,
  type DealerStaffLinkingAnalysis,
  type DealerStaffLinkingNoInvoice,
} from '../../lib/dealers';
import { dealersSalespersonsPath } from '../../lib/zohoSalespersons';
import type { AssignableStaffOption } from '../../types/dealers';
import { homePathForRole } from '../../types';
import {
  PortalOwnerAutocomplete,
  type PortalOwnerOption,
} from './PortalOwnerAutocomplete';

type UndoEntry = {
  dealers: DealerStaffLinkingNoInvoice[];
  staffUid: string;
  staffName: string;
};

function formatUpdatedAt(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
  }
  if (typeof value === 'object' && value && 'toDate' in value && typeof (value as { toDate: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toLocaleString();
  }
  if (typeof value === 'object' && value && 'seconds' in value) {
    const seconds = Number((value as { seconds: number }).seconds);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toLocaleString();
  }
  return null;
}

export function DealerStaffLinkingPanel() {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [result, setResult] = useState<DealerStaffLinkingAnalysis | null>(null);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [staffOptions, setStaffOptions] = useState<AssignableStaffOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [inlineAssignId, setInlineAssignId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeDealerStaffLinkingCheck(
      data => {
        setResult(data);
        setSnapshotReady(true);
        if (data?.status === 'running') {
          setLoading(true);
        } else if (data?.status === 'ready' || data?.status === 'error') {
          setLoading(false);
        }
        if (data?.status === 'error' && data.errorMessage) {
          setError(data.errorMessage);
        }
      },
      err => {
        setSnapshotReady(true);
        setError(err.message || 'Could not load saved linking check.');
      },
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listAssignableDealerStaff()
      .then(rows => {
        if (!cancelled) setStaffOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setStaffOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fresh scan clears local selection + undo history.
  useEffect(() => {
    setSelectedIds(new Set());
    setUndoStack([]);
    setInlineAssignId(null);
  }, [result?.runCompletedAt]);

  const updatedLabel = useMemo(
    () => formatUpdatedAt(result?.updatedAt) || formatUpdatedAt(result?.runCompletedAt),
    [result?.updatedAt, result?.runCompletedAt],
  );

  const ownerOptions = useMemo<PortalOwnerOption[]>(
    () => staffOptions.map(s => ({ uid: s.uid, displayName: s.displayName })),
    [staffOptions],
  );

  const noInvoiceDealers = result?.noUsableInvoiceDealers ?? [];

  const runCheck = async () => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await analyzeDealerStaffLinking();
      setSuccess('Linking check saved. Results update live as you assign dealers.');
    } catch (err) {
      setError(dealerErrorMessage(err));
      setLoading(false);
    }
  };

  const applyAssignable = async () => {
    setApplying(true);
    setError('');
    setSuccess('');
    try {
      const fill = await backfillDealerAssignedStaff({ onlyFillUnassigned: true });
      setSuccess(
        `Assigned ${fill.filled} dealer${fill.filled === 1 ? '' : 's'} from linked salespersons.`,
      );
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const assignDealers = async (dealerIds: string[], staffUid: string) => {
    const ids = [...new Set(dealerIds.map(id => String(id).trim()).filter(Boolean))];
    const uid = String(staffUid ?? '').trim();
    if (!ids.length || !uid) return;

    setAssigning(true);
    setError('');
    setSuccess('');
    try {
      const res = await assignNoUsableInvoiceDealers({ dealerIds: ids, staffUid: uid });
      if (res.assigned > 0 && res.dealers.length) {
        setUndoStack(prev => [
          ...prev,
          {
            dealers: res.dealers,
            staffUid: res.staffUid,
            staffName: res.staffName,
          },
        ]);
      }
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setSuccess(
        res.assigned === 0
          ? 'No dealers were assigned (they may already have staff).'
          : `Assigned ${res.assigned} dealer${res.assigned === 1 ? '' : 's'} to ${res.staffName}.`,
      );
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setAssigning(false);
      setRowBusyId(null);
    }
  };

  const handleUndo = async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoing(true);
    setError('');
    setSuccess('');
    try {
      const res = await undoNoUsableInvoiceAssign({
        dealers: last.dealers,
        staffUid: last.staffUid,
      });
      setUndoStack(prev => prev.slice(0, -1));
      setSuccess(
        res.restored === 0
          ? 'Nothing to undo (dealers may have been reassigned elsewhere).'
          : `Undid ${res.restored} assignment${res.restored === 1 ? '' : 's'} from ${last.staffName}.`,
      );
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setUndoing(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(noInvoiceDealers.map(d => d.id)) : new Set());
  };

  const toggleRow = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const busy = loading || applying || assigning || undoing;
  const hasReadyResult = Boolean(result?.summary && result.status !== 'error');
  const lastUndo = undoStack[undoStack.length - 1] ?? null;
  const allSelected = noInvoiceDealers.length > 0
    && noInvoiceDealers.every(d => selectedIds.has(d.id));

  return (
    <div className="dealer-linking-panel">
      <section className="panel glass dealer-linking-panel__hero">
        <div className="dealer-linking-panel__hero-copy">
          <h2>Dealer linking check</h2>
          <p className="text-muted text-sm">
            Resolve each unassigned dealer from their latest invoice salesperson
            (skipping {result?.ignoredSalespersons?.join(', ') || 'yescloud server, Cloud Charges, GATC SELF'}
            and portal-hidden salespersons). Link owners in{' '}
            <Link to={dealersSalespersonsPath(homePathForRole('super_admin'))}>
              Dealers → Salespersons
            </Link>
            , then assign ready dealers here. Results update live — re-run only for a fresh scan.
          </p>
          {updatedLabel ? (
            <p className="text-muted text-sm dealer-linking-panel__meta">
              Last saved {updatedLabel}
              {result?.status === 'running' ? ' · scan in progress' : ''}
            </p>
          ) : null}
        </div>
        <div className="dealer-linking-panel__hero-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void runCheck()}
          >
            {loading ? <RefreshCw size={16} className="spin-icon" /> : <Play size={16} />}
            {loading ? 'Running check…' : hasReadyResult ? 'Re-run linking check' : 'Run dealer linking check'}
          </button>
          {result && (result.summary?.alreadyAssignable ?? 0) > 0 ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void applyAssignable()}
            >
              {applying ? <RefreshCw size={16} className="spin-icon" /> : <UserPlus size={16} />}
              {applying
                ? 'Assigning…'
                : `Assign ${result.summary.alreadyAssignable} ready dealers`}
            </button>
          ) : null}
        </div>
      </section>

      {success ? (
        <div
          className="products-inline-error panel glass"
          style={{ borderColor: 'rgba(16,185,129,0.35)', color: '#6ee7b7' }}
        >
          <span>{success}</span>
        </div>
      ) : null}

      {error ? (
        <div className="products-inline-error panel glass">
          <span>{error}</span>
        </div>
      ) : null}

      {!snapshotReady || (loading && !hasReadyResult) ? (
        <FetchingLoader label={loading ? 'Scanning dealers and invoices…' : 'Loading saved check…'} />
      ) : null}

      {hasReadyResult && result?.summary ? (
        <>
          <section className="dealer-linking-kpis" aria-label="Linking summary">
            <div className="panel glass dealer-linking-kpi">
              <span className="dealer-linking-kpi__label">Unassigned</span>
              <strong>{result.summary.unassignedDealers.toLocaleString()}</strong>
            </div>
            <div className="panel glass dealer-linking-kpi">
              <span className="dealer-linking-kpi__label">Ready to assign</span>
              <strong>{result.summary.alreadyAssignable.toLocaleString()}</strong>
            </div>
            <div className="panel glass dealer-linking-kpi">
              <span className="dealer-linking-kpi__label">Need staff link</span>
              <strong>{result.summary.needStaffLink.toLocaleString()}</strong>
            </div>
            <div className="panel glass dealer-linking-kpi">
              <span className="dealer-linking-kpi__label">No usable invoice</span>
              <strong>{result.summary.noUsableInvoice.toLocaleString()}</strong>
            </div>
          </section>

          {(result.alreadyAssignableBySalesperson?.length ?? 0) > 0 ? (
            <section className="panel glass dealer-linking-section">
              <header className="dealer-linking-section__head">
                <Link2 size={18} aria-hidden />
                <div>
                  <h3>Ready to assign</h3>
                  <p className="text-muted text-sm">
                    Last-invoice salesperson is already linked to portal staff.
                  </p>
                </div>
              </header>
              <div className="dealer-linking-table-wrap">
                <table className="dealers-table dealer-linking-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Zoho salesperson</th>
                      <th>Portal staff</th>
                      <th className="dealer-linking-table__num">Dealers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.alreadyAssignableBySalesperson.map((row, index) => (
                      <tr key={row.zohoSalespersonId}>
                        <td>{index + 1}</td>
                        <td>
                          <div className="dealer-linking-table__primary">
                            {row.zohoSalespersonName || row.zohoSalespersonId}
                          </div>
                          <div className="text-muted text-sm">{row.zohoSalespersonId}</div>
                        </td>
                        <td>
                          <div className="dealer-linking-table__primary">{row.linkedStaffName}</div>
                          {row.linkedStaffEmail ? (
                            <div className="text-muted text-sm">{row.linkedStaffEmail}</div>
                          ) : null}
                        </td>
                        <td className="dealer-linking-table__num">{row.unassignedDealers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="panel glass dealer-linking-section">
            <header className="dealer-linking-section__head">
              <div>
                <h3>No usable invoice</h3>
                <p className="text-muted text-sm">
                  Unassigned dealers with no invoice salesperson after ignoring
                  {' '}{(result.ignoredSalespersons || []).join(', ')}.
                  Select rows or assign inline to a portal user with a Zoho salesperson.
                </p>
              </div>
              <span className="dealer-linking-section__count">
                {noInvoiceDealers.length.toLocaleString()}
              </span>
            </header>

            {noInvoiceDealers.length > 0 || lastUndo ? (
              <div className="dealer-linking-assign-bar">
                {selectedIds.size > 0 ? (
                  <div className="dealer-linking-assign-bar__bulk">
                    <span className="text-sm">
                      {selectedIds.size.toLocaleString()} selected
                    </span>
                    <div className="dealer-linking-assign-bar__ac">
                      <PortalOwnerAutocomplete
                        valueUid=""
                        valueLabel=""
                        options={ownerOptions}
                        disabled={busy || ownerOptions.length === 0}
                        busy={assigning && !rowBusyId}
                        ariaLabel="Assign selected dealers to portal user"
                        placeholder="Assign selected to…"
                        showClear={false}
                        onSelect={uid => void assignDealers([...selectedIds], uid)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => setSelectedIds(new Set())}
                    >
                      Clear selection
                    </button>
                  </div>
                ) : (
                  <p className="text-muted text-sm dealer-linking-assign-bar__hint">
                    {ownerOptions.length === 0
                      ? 'No assignable portal users (need a Zoho salesperson link).'
                      : 'Select dealers below, or pick a portal user in the Assign column.'}
                  </p>
                )}
                {lastUndo ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm dealer-linking-assign-bar__undo"
                    disabled={busy}
                    onClick={() => void handleUndo()}
                    title={`Undo last ${lastUndo.dealers.length} assignment${lastUndo.dealers.length === 1 ? '' : 's'} to ${lastUndo.staffName}`}
                  >
                    {undoing ? <RefreshCw size={14} className="spin-icon" /> : <Undo2 size={14} />}
                    Undo last ({lastUndo.dealers.length})
                  </button>
                ) : null}
              </div>
            ) : null}

            {noInvoiceDealers.length === 0 ? (
              <p className="text-muted dealer-linking-empty">None.</p>
            ) : (
              <div className="dealer-linking-table-wrap">
                <table className="dealers-table dealer-linking-table">
                  <thead>
                    <tr>
                      <th className="dealer-linking-table__check">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          disabled={busy}
                          aria-label="Select all dealers"
                          onChange={e => toggleSelectAll(e.target.checked)}
                        />
                      </th>
                      <th>#</th>
                      <th>Dealer</th>
                      <th>Code</th>
                      <th>Location</th>
                      <th>Assign</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noInvoiceDealers.map((row, index) => {
                      const rowBusy = rowBusyId === row.id;
                      return (
                        <tr key={row.id} className={selectedIds.has(row.id) ? 'is-selected' : undefined}>
                          <td className="dealer-linking-table__check">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              disabled={busy}
                              aria-label={`Select ${row.contactName || row.companyName || row.id}`}
                              onChange={() => toggleRow(row.id)}
                            />
                          </td>
                          <td>{index + 1}</td>
                          <td>
                            <div className="dealer-linking-table__primary">
                              {row.contactName || row.companyName || row.id}
                            </div>
                            {row.companyName && row.contactName && row.companyName.trim().toLowerCase() !== row.contactName.trim().toLowerCase() ? (
                              <div className="text-muted text-sm">{row.companyName}</div>
                            ) : null}
                          </td>
                          <td>{row.dealerCode || '—'}</td>
                          <td>
                            {[row.billingCity, row.billingState].filter(Boolean).join(', ') || '—'}
                          </td>
                          <td className="dealer-linking-table__assign" onClick={e => e.stopPropagation()}>
                            {inlineAssignId === row.id ? (
                              <PortalOwnerAutocomplete
                                valueUid=""
                                valueLabel=""
                                options={ownerOptions}
                                disabled={busy || ownerOptions.length === 0}
                                busy={rowBusy}
                                ariaLabel={`Assign ${row.contactName || row.companyName || row.id}`}
                                placeholder="Assign to…"
                                showClear={false}
                                onSelect={uid => {
                                  setRowBusyId(row.id);
                                  setInlineAssignId(null);
                                  void assignDealers([row.id], uid);
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                disabled={busy || ownerOptions.length === 0}
                                onClick={() => setInlineAssignId(row.id)}
                              >
                                Assign…
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : snapshotReady && !loading ? (
        <p className="text-muted dealer-linking-empty panel glass" style={{ padding: '1rem' }}>
          No saved linking check yet. Run a check once to cache results for this tab.
        </p>
      ) : null}
    </div>
  );
}
