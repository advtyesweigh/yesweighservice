/**
 * Settings → Price level: create/rename/delete price levels and assign dealers.
 * Pricing rules stay on Products → Price level.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  ensureDealersCached,
  peekCachedDealers,
  subscribeDealerCache,
} from '../../lib/dealer-cache';
import { dealerMatchesLogisticsQuery } from '../../lib/logisticsDealers';
import {
  categoryRuleHasEffect,
  createEmptyPriceLevel,
  enforceUniqueDealerAssignments,
  isDefaultDealerPriceLevel,
  loadPriceLevels,
  priceLevelsEqual,
  priceLevelsLiveSaveMs,
  savePriceLevels,
} from '../../lib/priceLevels';
import { zohoDealerDisplayName } from '../../lib/logisticsDealers';
import type { ZohoDealer } from '../../types/dealers';
import type { PriceLevel } from '../../types/priceLevels';

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

function dealerLabel(d: Pick<ZohoDealer, 'contactName' | 'companyName' | 'id'>): string {
  return zohoDealerDisplayName(d);
}

function namesFromDealers(
  dealers: ZohoDealer[],
  dealerIds: string[],
): Record<string, string> {
  const byId = new Map(dealers.map(d => [d.id, dealerLabel(d)]));
  const names: Record<string, string> = {};
  for (const id of dealerIds) {
    names[id] = byId.get(id) || id;
  }
  return names;
}

export const DealerLevelDefinitionsPanel: React.FC = () => {
  const { user } = useAuth();
  const userUid = user?.uid ?? null;

  const [levels, setLevels] = useState<PriceLevel[]>([]);
  const [savedLevels, setSavedLevels] = useState<PriceLevel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dealerNames, setDealerNames] = useState<Record<string, string>>({});
  const [allDealers, setAllDealers] = useState<ZohoDealer[]>(() => peekCachedDealers() ?? []);
  const [dealersLoading, setDealersLoading] = useState(() => !(peekCachedDealers()?.length));
  const [dealerSearchError, setDealerSearchError] = useState('');
  const [dealerQuery, setDealerQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const levelsRef = useRef(levels);
  const savedRef = useRef(savedLevels);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveEpochRef = useRef(0);

  levelsRef.current = levels;
  savedRef.current = savedLevels;

  const selected = useMemo(
    () => levels.find(l => l.id === selectedId) ?? null,
    [levels, selectedId],
  );
  const selectedIsDefault = selected ? isDefaultDealerPriceLevel(selected) : false;

  const unassignedDealerCount = useMemo(() => {
    const assigned = new Set(
      levels
        .filter(level => !isDefaultDealerPriceLevel(level))
        .flatMap(level => level.dealerIds),
    );
    return allDealers.filter(d => d.id && !assigned.has(d.id)).length;
  }, [levels, allDealers]);

  useEffect(() => {
    setDealerQuery('');
  }, [selectedId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const docData = await loadPriceLevels();
      setLevels(docData.levels);
      setSavedLevels(docData.levels);
      setSelectedId(prev => (
        prev && docData.levels.some(l => l.id === prev)
          ? prev
          : (docData.levels[0]?.id ?? null)
      ));
      const allDealerIds = [...new Set(docData.levels.flatMap(l => l.dealerIds))];
      if (allDealerIds.length) {
        const cached = peekCachedDealers() ?? [];
        setDealerNames(namesFromDealers(cached, allDealerIds));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dealer levels.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const cached = peekCachedDealers();
    if (cached?.length) {
      setAllDealers(cached);
      setDealersLoading(false);
    } else {
      setDealersLoading(true);
    }

    const unsubscribe = subscribeDealerCache((list, complete) => {
      if (cancelled) return;
      setAllDealers(list);
      if (complete || list.length > 0) setDealersLoading(false);
    });

    void ensureDealersCached()
      .then(list => {
        if (cancelled) return;
        setAllDealers(list);
        setDealersLoading(false);
        setDealerSearchError('');
      })
      .catch(err => {
        if (cancelled || peekCachedDealers()?.length) return;
        setAllDealers([]);
        setDealersLoading(false);
        setDealerSearchError(
          err instanceof Error ? err.message : 'Could not load dealers for search.',
        );
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const ids = [...new Set(levels.flatMap(l => l.dealerIds))];
    if (!ids.length || !allDealers.length) return;
    setDealerNames(prev => ({ ...prev, ...namesFromDealers(allDealers, ids) }));
  }, [levels, allDealers]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const dealerHits = useMemo(() => {
    const q = dealerQuery.trim();
    if (q.length < 2) return [];
    return allDealers
      .filter(dealer => dealerMatchesLogisticsQuery(dealer, q))
      .slice(0, 20);
  }, [allDealers, dealerQuery]);

  const queueSave = useCallback((nextLevels: PriceLevel[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('pending');
    saveTimerRef.current = setTimeout(() => {
      const current = enforceUniqueDealerAssignments(levelsRef.current);
      if (priceLevelsEqual(current, savedRef.current)) {
        setSaveStatus(prev => (prev === 'pending' ? 'idle' : prev));
        return;
      }
      const epoch = ++saveEpochRef.current;
      setSaveStatus('saving');
      setError('');
      void savePriceLevels(current, userUid)
        .then(saved => {
          setSavedLevels(saved.levels);
          setLevels(prev => {
            if (!priceLevelsEqual(prev, nextLevels) && !priceLevelsEqual(prev, current)) {
              return prev;
            }
            return saved.levels;
          });
          if (epoch === saveEpochRef.current) setSaveStatus('saved');
        })
        .catch(err => {
          if (epoch !== saveEpochRef.current) return;
          setSaveStatus('error');
          setError(err instanceof Error ? err.message : 'Could not save dealer levels.');
        });
    }, priceLevelsLiveSaveMs());
  }, [userUid]);

  const patchLevels = useCallback((updater: (prev: PriceLevel[]) => PriceLevel[]) => {
    setLevels(prev => {
      const next = enforceUniqueDealerAssignments(updater(prev));
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  const addLevel = () => {
    const level = createEmptyPriceLevel(`Level ${levels.length + 1}`, levels.length);
    patchLevels(prev => [...prev, level]);
    setSelectedId(level.id);
  };

  const removeLevel = (id: string) => {
    if (isDefaultDealerPriceLevel(id)) return;
    patchLevels(prev => prev.filter(l => l.id !== id));
    setSelectedId(prev => {
      if (prev !== id) return prev;
      const remaining = levels.filter(l => l.id !== id);
      return remaining[0]?.id ?? null;
    });
  };

  const updateSelected = (patch: Partial<PriceLevel>) => {
    if (!selectedId) return;
    patchLevels(prev => prev.map(l => {
      if (l.id !== selectedId) return l;
      if (isDefaultDealerPriceLevel(l)) {
        return { ...l, dealerIds: [] };
      }
      return { ...l, ...patch };
    }));
  };

  const addDealer = (dealer: ZohoDealer) => {
    if (!selected || isDefaultDealerPriceLevel(selected)) return;
    setDealerNames(prev => ({ ...prev, [dealer.id]: dealerLabel(dealer) }));
    patchLevels(prev => prev.map(level => {
      if (level.id === selected.id) {
        if (level.dealerIds.includes(dealer.id)) return level;
        return { ...level, dealerIds: [...level.dealerIds, dealer.id] };
      }
      return {
        ...level,
        dealerIds: level.dealerIds.filter(id => id !== dealer.id),
      };
    }));
    setDealerQuery('');
  };

  const removeDealer = (dealerId: string) => {
    if (!selected || isDefaultDealerPriceLevel(selected)) return;
    updateSelected({
      dealerIds: selected.dealerIds.filter(id => id !== dealerId),
    });
  };

  const saveLabel = saveStatus === 'saving' || saveStatus === 'pending'
    ? 'Saving…'
    : saveStatus === 'saved'
      ? 'Saved'
      : saveStatus === 'error'
        ? 'Save failed'
        : '';

  if (loading) {
    return (
      <div className="price-levels-tab price-levels-tab--loading">
        <Loader2 className="spin-icon" size={22} aria-hidden />
        <p className="text-muted">Loading dealer levels…</p>
      </div>
    );
  }

  return (
    <div className="price-levels-tab dealer-level-definitions">
      <header className="price-levels-tab__header">
        <div>
          <h3>Price level</h3>
          <p className="text-muted text-sm">
            Create levels and assign dealers. Category discounts, item overrides, and Costs &amp; New
            sell live under Products → Price level. Changes save automatically.
          </p>
        </div>
        {saveLabel ? (
          <span
            className={`price-levels-tab__save ${
              saveStatus === 'error' ? 'is-error' : saveStatus === 'saved' ? 'is-saved' : ''
            }`}
          >
            {saveStatus === 'saved' ? <Check size={14} aria-hidden /> : null}
            {(saveStatus === 'saving' || saveStatus === 'pending')
              ? <Loader2 size={14} className="spin-icon" aria-hidden />
              : null}
            {saveLabel}
          </span>
        ) : null}
      </header>

      {error ? <p className="price-levels-tab__error">{error}</p> : null}

      <div className="price-levels-tab__levels-bar">
        <label className="price-levels-tab__level-picker" htmlFor="dealer-level-select">
          <span>Level</span>
          <select
            id="dealer-level-select"
            value={selectedId ?? ''}
            onChange={event => setSelectedId(event.target.value || null)}
            aria-label="Select dealer level"
          >
            {levels.length === 0 ? (
              <option value="">No levels yet</option>
            ) : null}
            {levels.map(level => {
              const isDefault = isDefaultDealerPriceLevel(level);
              const rules = level.categoryRules.filter(categoryRuleHasEffect).length;
              const dealersLabel = isDefault
                ? `All others${allDealers.length ? ` (${unassignedDealerCount})` : ''}`
                : `${level.dealerIds.length} dealer${level.dealerIds.length === 1 ? '' : 's'}`;
              return (
                <option key={level.id} value={level.id}>
                  {level.name}
                  {isDefault ? ' (default)' : ''}
                  {' — '}
                  {dealersLabel}
                  {' · '}
                  {rules}
                  {' '}
                  rule
                  {rules === 1 ? '' : 's'}
                </option>
              );
            })}
          </select>
        </label>
        <div className="price-levels-tab__level-actions">
          {selected && !selectedIsDefault ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary price-levels-tab__level-delete-btn"
              title="Delete level"
              aria-label={`Delete ${selected.name}`}
              onClick={() => removeLevel(selected.id)}
            >
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-primary" onClick={addLevel}>
            <Plus size={14} aria-hidden />
            Add
          </button>
        </div>
      </div>

      <section className="price-levels-tab__detail">
        {!selected ? (
          <p className="text-muted">Select or create a level to edit.</p>
        ) : (
          <div className="price-levels-tab__meta-body price-levels-tab__meta-body--open">
            <label className="price-levels-tab__field price-levels-tab__field--inline">
              <span>Level name</span>
              <input
                type="text"
                value={selected.name}
                onChange={e => updateSelected({ name: e.target.value })}
                placeholder="e.g. Directors"
                disabled={selectedIsDefault}
                readOnly={selectedIsDefault}
              />
            </label>

            {selectedIsDefault ? (
              <div className="price-levels-tab__block">
                <h4>
                  <Users size={16} aria-hidden />
                  Default catch-all
                </h4>
                <p className="text-muted text-sm">
                  Covers every dealer who is not assigned to another level
                  {allDealers.length
                    ? ` (${unassignedDealerCount} of ${allDealers.length} right now)`
                    : ''}
                  . Assign dealers to Directors / Agents / etc. to exclude them from this level.
                </p>
              </div>
            ) : (
              <div className="price-levels-tab__block">
                <h4>
                  <UserPlus size={16} aria-hidden />
                  Dealers in this level
                </h4>
                <div className="price-levels-tab__dealer-search">
                  <Search size={16} aria-hidden />
                  <input
                    type="search"
                    value={dealerQuery}
                    onChange={e => setDealerQuery(e.target.value)}
                    placeholder="Search dealers by name, company, phone…"
                    autoComplete="off"
                  />
                  {dealersLoading ? <Loader2 size={14} className="spin-icon" aria-hidden /> : null}
                </div>
                {dealerSearchError ? (
                  <p className="price-levels-tab__error text-sm">{dealerSearchError}</p>
                ) : null}
                {dealerQuery.trim().length >= 2 && !dealersLoading && dealerHits.length === 0
                  && !dealerSearchError ? (
                  <p className="text-muted text-sm">No matching dealers.</p>
                ) : null}
                {dealerHits.length > 0 ? (
                  <ul className="price-levels-tab__dealer-hits">
                    {dealerHits.map(d => {
                      const already = selected.dealerIds.includes(d.id);
                      return (
                        <li key={d.id}>
                          <button
                            type="button"
                            disabled={already}
                            onClick={() => addDealer(d)}
                          >
                            <strong>{dealerLabel(d)}</strong>
                            <span className="text-muted text-sm">
                              {[d.contactName, d.phone || d.mobile].filter(Boolean).join(' · ')}
                            </span>
                            {already ? <span className="text-muted">Added</span> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {selected.dealerIds.length === 0 ? (
                  <p className="text-muted text-sm">No dealers assigned yet.</p>
                ) : (
                  <ul className="price-levels-tab__dealer-chips">
                    {selected.dealerIds.map(id => (
                      <li key={id}>
                        <span>{dealerNames[id] || id}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${dealerNames[id] || id}`}
                          onClick={() => removeDealer(id)}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
