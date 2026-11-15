import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Loader2, Search, X } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { fetchDealers } from '../../../lib/dealers';
import { canLinkYesGatcRc } from '../../../lib/staffAccess';
import {
  countYesGatcLifetimeOvRv,
  listYesGatcRcDetails,
  saveYesGatcRcDealerLink,
  sumYesGatcRcHsnSoldQty,
  yesGatcOvRvForRc,
  yesGatcRcOfficeName,
  type YesGatcOvRvTotals,
  type YesGatcRcDetail,
} from '../../../lib/yesgatcRecords';
import type { ZohoDealer } from '../../../types/dealers';

function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}

function dealerLabel(dealer: ZohoDealer): string {
  return dealer.companyName?.trim() || dealer.contactName?.trim() || dealer.id;
}

function RcDealerPicker({
  row,
  takenDealerIds,
  onClose,
  onLinked,
}: {
  row: YesGatcRcDetail;
  takenDealerIds: Set<string>;
  onClose: () => void;
  onLinked: (next: YesGatcRcDetail) => void;
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dealers, setDealers] = useState<ZohoDealer[]>([]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, saving]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void fetchDealers({
        page: 1,
        limit: 20,
        q: query.trim() || undefined,
        sortField: 'companyName',
        sortDir: 'asc',
      })
        .then(res => {
          if (!cancelled) setDealers(res.data);
        })
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load dealers.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const pick = async (dealer: ZohoDealer) => {
    if (saving) return;
    setSaving(true);
    setError('');
    const name = dealerLabel(dealer);
    try {
      await saveYesGatcRcDealerLink(row.id, row.code, dealer.id, name);
      onLinked({ ...row, dealerId: dealer.id, dealerName: name });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link this dealer.');
      setSaving(false);
    }
  };

  const available = dealers.filter(dealer => !takenDealerIds.has(dealer.id));

  return createPortal(
    <div
      className="dealers-modal-backdrop yesgatc-rc-picker__backdrop"
      role="presentation"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="yesgatc-rc-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="yesgatc-rc-picker-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="yesgatc-rc-picker__head">
          <div>
            <h3 id="yesgatc-rc-picker-title">Select dealer</h3>
            <p className="text-muted text-sm">
              {yesGatcRcOfficeName(row)}
              {row.code ? ` · ${row.code}` : ''}
            </p>
          </div>
          <button type="button" className="yesgatc-rc-picker__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <label className="yesgatc-rc-picker__search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search dealers"
            autoFocus
          />
        </label>
        {error ? <p className="settings-locations__error">{error}</p> : null}
        <div className="yesgatc-rc-picker__list">
          {loading ? (
            <p className="settings-locations__loading">
              <Loader2 size={16} className="spin-icon" aria-hidden /> Loading dealers…
            </p>
          ) : available.length === 0 ? (
            <p className="settings-locations__empty">No available dealers.</p>
          ) : (
            available.map(dealer => (
              <button
                key={dealer.id}
                type="button"
                className="yesgatc-rc-picker__item"
                disabled={saving}
                onClick={() => void pick(dealer)}
              >
                <strong>{dealerLabel(dealer)}</strong>
                <span>
                  {[dealer.billingState, dealer.district, dealer.phone || dealer.mobile].filter(Boolean).join(' · ')}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const RcDetailsTab: React.FC = () => {
  const { user } = useAuth();
  const canLink = canLinkYesGatcRc(user);
  const [rows, setRows] = useState<YesGatcRcDetail[]>([]);
  const [ovRv, setOvRv] = useState<Map<string, YesGatcOvRvTotals>>(() => new Map());
  const [ovRvReady, setOvRvReady] = useState(false);
  const [soldQty, setSoldQty] = useState<Map<string, number>>(() => new Map());
  const [soldReady, setSoldReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState<YesGatcRcDetail | null>(null);
  const takenDealerIds = new Set(rows.map(row => row.dealerId).filter((id): id is string => Boolean(id)));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await listYesGatcRcDetails());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load RC details.');
    } finally {
      setLoading(false);
    }
  }, []);

  const rcCountKey = rows.map(row => `${row.id}:${row.code}:${row.ovCount ?? ''}:${row.linkedCount ?? ''}`).join('|');

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading || rows.length === 0) return;
    let cancelled = false;
    setOvRvReady(false);
    void countYesGatcLifetimeOvRv(rows)
      .then(totals => {
        if (!cancelled) setOvRv(totals);
      })
      .catch(() => {
        if (!cancelled) setOvRv(new Map());
      })
      .finally(() => {
        if (!cancelled) setOvRvReady(true);
      });
    return () => {
      cancelled = true;
    };
    // Recount when the RC set changes, not when a dealer is linked.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rcCountKey captures id/code/ov
  }, [loading, rcCountKey]);

  const soldKey = rows.map(row => `${row.id}:${row.dealerId || ''}`).join('|');

  useEffect(() => {
    if (loading || rows.length === 0) return;
    let cancelled = false;
    setSoldReady(false);
    void sumYesGatcRcHsnSoldQty(rows)
      .then(qty => {
        if (!cancelled) setSoldQty(qty);
      })
      .catch(() => {
        if (!cancelled) setSoldQty(new Map());
      })
      .finally(() => {
        if (!cancelled) setSoldReady(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- soldKey captures id/dealer
  }, [loading, soldKey]);

  const sortedRows = useMemo(() => (
    [...rows].sort((a, b) => {
      const ovDiff = yesGatcOvRvForRc(ovRv, b).ov - yesGatcOvRvForRc(ovRv, a).ov;
      if (ovDiff !== 0) return ovDiff;
      return yesGatcRcOfficeName(a).localeCompare(yesGatcRcOfficeName(b), 'en', { sensitivity: 'base' });
    })
  ), [ovRv, rows]);

  return (
    <section className="settings-locations panel glass yesgatc-rc-details">
      <header className="settings-locations__header">
        <div>
          <h3>RC details</h3>
          <p className="text-muted text-sm">
            Dealer links for OV sold/quota. Full centre profiles are on{' '}
            <Link to="/super-admin/regional-centres">Regional Centres</Link>.
          </p>
        </div>
      </header>
      {error ? <p className="settings-locations__error">{error}</p> : null}
      {loading ? (
        <p className="settings-locations__loading">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="settings-locations__empty">No RC details yet.</p>
      ) : (
        <div className="yesgatc-rc-list">
          {sortedRows.map(row => {
            const qty = yesGatcOvRvForRc(ovRv, row);
            return (
            <article key={row.id} className="yesgatc-rc-row">
              <p className="yesgatc-rc-row__name">{yesGatcRcOfficeName(row)}</p>
              <div className="yesgatc-rc-row__meta">
                <p className="yesgatc-rc-row__code">{row.code || '—'}</p>
                {row.dealerId ? (
                  <span className="yesgatc-rc-row__linked">Linked</span>
                ) : canLink ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm yesgatc-rc-row__select"
                    onClick={() => setPicking(row)}
                  >
                    Select
                  </button>
                ) : (
                  <span className="yesgatc-rc-row__unlinked">Not linked</span>
                )}
                <p className="yesgatc-rc-row__qty" aria-label="Sold, OV, linked, and balance">
                  <span
                    className="yesgatc-rc-row__sold"
                    title="HSN 84238190, 84238290, 84231000 from 1 Feb 2026"
                  >
                    Sold
                    {' '}
                    <strong>{soldReady ? formatCount(soldQty.get(row.id) || 0) : '…'}</strong>
                  </span>
                  <span className="yesgatc-rc-row__ov">
                    OV
                    {' '}
                    <strong>{ovRvReady ? formatCount(qty.ov) : '…'}</strong>
                  </span>
                  <span className="yesgatc-rc-row__linked-qty">
                    Linked
                    {' '}
                    <strong>{ovRvReady ? formatCount(qty.linked) : '…'}</strong>
                  </span>
                  {ovRvReady && qty.linked > 0 && qty.ov > qty.linked ? (
                    <span className="yesgatc-rc-row__diff" title="OV not yet linked">
                      {formatCount(qty.ov - qty.linked)}
                    </span>
                  ) : null}
                </p>
              </div>
            </article>
            );
          })}
        </div>
      )}
      {!loading && !error && sortedRows.length > 0 ? (
        <p className="text-muted text-sm">
          Sold is YesOne invoice qty (RC dealers, weighing-scale HSN from 1 Feb 2026). Add or delete updates YesGATC. OV and Linked come from YesGATC.
        </p>
      ) : null}
      {picking ? (
        <RcDealerPicker
          row={picking}
          takenDealerIds={takenDealerIds}
          onClose={() => setPicking(null)}
          onLinked={next => {
            setRows(current => current.map(row => (row.id === next.id ? next : row)));
          }}
        />
      ) : null}
    </section>
  );
};
