import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Plus, Search, X } from 'lucide-react';
import {
  ensureDealersCached,
  peekCachedDealers,
  subscribeDealerCache,
} from '../../lib/dealer-cache';
import { dealerMatchesLogisticsQuery, zohoDealerDisplayName } from '../../lib/logisticsDealers';
import type { ZohoDealer } from '../../types/dealers';

export type DealerFilterSelection = {
  id: string;
  label: string;
  portalUserId: string | null;
};

function dealerLabel(dealer: ZohoDealer): string {
  return zohoDealerDisplayName(dealer);
}

interface DealerMultiFilterPickerProps {
  value: DealerFilterSelection[];
  onChange: (next: DealerFilterSelection[]) => void;
}

/** Type-to-pick multi-select using the shared dealer cache (same as logistics). */
export const DealerMultiFilterPicker: React.FC<DealerMultiFilterPickerProps> = ({
  value,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dealers, setDealers] = useState<ZohoDealer[]>(() => peekCachedDealers() ?? []);
  const [dealersLoading, setDealersLoading] = useState(() => !(peekCachedDealers()?.length));
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedIds = useMemo(() => new Set(value.map(d => d.id)), [value]);

  const suggestions = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return dealers
      .filter(dealer => !selectedIds.has(dealer.id) && dealerMatchesLogisticsQuery(dealer, q))
      .slice(0, 30);
  }, [dealers, query, selectedIds]);

  const matchedCount = useMemo(() => {
    const q = query.trim();
    if (!q) return 0;
    return dealers.filter(dealer => dealerMatchesLogisticsQuery(dealer, q)).length;
  }, [dealers, query]);

  useEffect(() => {
    const cached = peekCachedDealers();
    if (cached?.length) {
      setDealers(cached);
      setDealersLoading(false);
    } else {
      setDealersLoading(true);
    }

    const unsubscribe = subscribeDealerCache((list, complete) => {
      setDealers(list);
      if (complete || list.length > 0) setDealersLoading(false);
    });

    void ensureDealersCached()
      .then(list => {
        setDealers(list);
        setDealersLoading(false);
      })
      .catch(() => {
        if (!peekCachedDealers()?.length) {
          setDealers([]);
          setDealersLoading(false);
        }
      });

    return unsubscribe;
  }, []);

  const updateMenuPosition = () => {
    const field = fieldRef.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const width = Math.max(rect.width, 240);
    const maxHeight = Math.min(280, window.innerHeight - 24);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const height = Math.min(maxHeight, openUp ? spaceAbove : spaceBelow);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);

    setMenuStyle({
      position: 'fixed',
      top: openUp ? undefined : rect.bottom + 6,
      bottom: openUp ? window.innerHeight - rect.top + 6 : undefined,
      left,
      width,
      maxHeight: Math.max(140, height),
      zIndex: 1300,
    });
  };

  const focusInput = () => {
    inputRef.current?.focus();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, value.length, query, suggestions.length]);

  useEffect(() => {
    if (!open) return;

    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if ((target as Element).closest?.('.dealer-multi-filter__menu')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      inputRef.current?.blur();
    };
    const onReposition = () => updateMenuPosition();

    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, suggestions.length]);

  const addDealer = (dealer: ZohoDealer) => {
    if (selectedIds.has(dealer.id)) return;
    onChange([
      ...value,
      {
        id: dealer.id,
        label: dealerLabel(dealer),
        portalUserId: dealer.portalUserId ?? null,
      },
    ]);
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
    setOpen(true);
  };

  const removeDealer = (id: string) => {
    onChange(value.filter(d => d.id !== id));
    inputRef.current?.focus();
    setOpen(true);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !query && value.length > 0) {
      e.preventDefault();
      removeDealer(value[value.length - 1].id);
      return;
    }

    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setActiveIndex(i => (i + 1) % suggestions.length);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = suggestions[activeIndex];
      if (pick) addDealer(pick);
    }
  };

  const showMenu = open && query.trim().length > 0;
  const showLoading = dealersLoading && dealers.length === 0;

  const menu = showMenu ? (
    <div
      id="dealer-multi-filter-listbox"
      className="dealer-multi-filter__menu panel glass"
      style={menuStyle}
      role="listbox"
      aria-label="Dealer suggestions"
    >
      <div className="dealer-multi-filter__menu-list">
        {showLoading ? (
          <p className="text-muted text-sm dealer-multi-filter__empty">Loading dealers…</p>
        ) : suggestions.length === 0 ? (
          <p className="text-muted text-sm dealer-multi-filter__empty">
            {matchedCount > 0 ? 'Already selected.' : `No dealers match “${query.trim()}”.`}
          </p>
        ) : (
          suggestions.map((dealer, index) => {
            const label = dealerLabel(dealer);
            const active = index === activeIndex;
            return (
              <button
                key={dealer.id}
                type="button"
                role="option"
                aria-selected={active}
                className={[
                  'dealer-multi-filter__option',
                  active ? 'is-active' : '',
                ].filter(Boolean).join(' ')}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => addDealer(dealer)}
              >
                <span className="dealer-multi-filter__option-copy">
                  <span className="dealer-multi-filter__name">{label}</span>
                  {dealer.district || dealer.billingState ? (
                    <span className="dealer-multi-filter__meta text-muted">
                      {[dealer.district, dealer.billingState].filter(Boolean).join(', ')}
                    </span>
                  ) : null}
                </span>
                <Plus size={15} className="dealer-multi-filter__option-add" aria-hidden />
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={[
        'dealer-multi-filter',
        open ? 'dealer-multi-filter--open' : '',
        value.length > 0 ? 'dealer-multi-filter--has-value' : '',
      ].filter(Boolean).join(' ')}
    >
      {value.length > 0 && (
        <div className="dealer-multi-filter__chips" aria-label="Selected dealers">
          {value.map(dealer => (
            <span key={dealer.id} className="dealer-multi-filter__chip">
              <span className="dealer-multi-filter__chip-label">{dealer.label}</span>
              <button
                type="button"
                className="dealer-multi-filter__chip-remove"
                aria-label={`Remove ${dealer.label}`}
                onClick={() => removeDealer(dealer.id)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {value.length > 1 && (
            <button
              type="button"
              className="dealer-multi-filter__clear-all"
              onClick={() => {
                onChange([]);
                focusInput();
              }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      <div
        ref={fieldRef}
        className="dealer-multi-filter__field"
        onClick={focusInput}
      >
        <Search size={15} className="dealer-multi-filter__field-icon" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          className="dealer-multi-filter__input"
          placeholder={value.length === 0 ? 'Search dealers to filter…' : 'Add another dealer…'}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKeyDown}
          aria-label="Search dealers"
          aria-autocomplete="list"
          aria-expanded={showMenu}
          aria-controls="dealer-multi-filter-listbox"
          autoComplete="off"
        />
        {showLoading ? (
          <Loader2 size={14} className="dealer-multi-filter__spinner" aria-hidden />
        ) : (
          <button
            type="button"
            className="dealer-multi-filter__add-btn"
            onClick={e => {
              e.stopPropagation();
              focusInput();
            }}
            aria-label="Add dealer"
            title="Add dealer"
          >
            <Plus size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>

      {value.length === 0 && !open && (
        <p className="dealer-multi-filter__hint text-muted text-sm">
          Leave empty for all dealers
        </p>
      )}

      {menu && createPortal(menu, document.body)}
    </div>
  );
};
