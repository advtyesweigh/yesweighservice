import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, CheckCircle2, Loader2, Search, UserX } from 'lucide-react';
import { fetchDealerById, fetchDealers } from '../../lib/dealers';
import type { ZohoDealer } from '../../types/dealers';
import type { SupportOnBehalfDealer } from '../../types/dealer-support';

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function dealerLabel(dealer: ZohoDealer): string {
  return dealer.companyName?.trim() || dealer.contactName?.trim() || 'Dealer';
}

function dealerToOnBehalf(dealer: ZohoDealer): SupportOnBehalfDealer {
  return {
    zohoCustomerId: dealer.id,
    dealerName: dealerLabel(dealer),
    portalUserId: dealer.portalUserId,
  };
}

function formatPortalPhone(dealer: Pick<ZohoDealer, 'portalLoginId' | 'mobile' | 'phone'>): string | null {
  const raw = dealer.portalLoginId?.trim() || dealer.mobile?.trim() || dealer.phone?.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return raw;
}

function portalRegistrationStatus(dealer: Pick<ZohoDealer, 'signedIn' | 'portalUserId' | 'portalLoginId' | 'portalUserName' | 'mobile' | 'phone'>) {
  const registered = Boolean(dealer.signedIn || dealer.portalUserId);
  const phone = formatPortalPhone(dealer);
  if (registered) {
    return {
      registered: true,
      title: 'Portal registered',
      detail: 'This dealer completed mobile OTP account creation and can sign in to the app.',
      phoneLabel: phone ? `Login mobile · ${phone}` : dealer.portalUserName ? `Account · ${dealer.portalUserName}` : null,
    };
  }
  return {
    registered: false,
    title: 'Not registered on portal',
    detail: 'This dealer has not completed mobile OTP account creation yet. You can still create a service request for them.',
    phoneLabel: phone ? `Zoho mobile · ${phone}` : null,
  };
}

interface SupportDealerPickerProps {
  value: SupportOnBehalfDealer | null;
  onChange: (dealer: SupportOnBehalfDealer | null) => void;
  disabled?: boolean;
  initialQuery?: string;
}

export const SupportDealerPicker: React.FC<SupportDealerPickerProps> = ({
  value,
  onChange,
  disabled,
  initialQuery = '',
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(() => value?.dealerName ?? initialQuery);
  const [open, setOpen] = useState(() => !value && Boolean(initialQuery.trim()));
  const [loading, setLoading] = useState(false);
  const [dealers, setDealers] = useState<ZohoDealer[]>([]);
  const [selectedDealer, setSelectedDealer] = useState<ZohoDealer | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 250);

  useEffect(() => {
    if (value) setQuery(value.dealerName);
  }, [value?.zohoCustomerId, value?.dealerName]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || disabled) return undefined;

    let cancelled = false;
    setLoading(true);
    void fetchDealers({
      page: 1,
      limit: 12,
      q: debouncedQuery.trim() || undefined,
      sortField: 'companyName',
      sortDir: 'asc',
    })
      .then(res => {
        if (!cancelled) setDealers(res.data);
      })
      .catch(() => {
        if (!cancelled) setDealers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, disabled, open]);

  useEffect(() => {
    if (!value?.zohoCustomerId) {
      setSelectedDealer(null);
      return undefined;
    }

    let cancelled = false;
    setSelectedLoading(true);
    void fetchDealerById(value.zohoCustomerId)
      .then(dealer => {
        if (!cancelled) setSelectedDealer(dealer);
      })
      .catch(() => {
        if (!cancelled) {
          const cached = dealers.find(d => d.id === value.zohoCustomerId);
          if (cached) {
            setSelectedDealer(cached);
          } else {
            setSelectedDealer({
              id: value.zohoCustomerId,
              contactName: value.dealerName,
              firstName: null,
              companyName: value.dealerName,
              email: null,
              phone: null,
              mobile: null,
              status: 'active',
              outstandingReceivable: 0,
              unusedCredits: 0,
              syncedAt: null,
              isFiltered: false,
              filterReason: null,
              assignedStaffUid: null,
              assignedStaffName: null,
              dealerStage: null,
              billingState: null,
              district: null,
              zipCode: null,
              categories: [],
              portalUserId: value.portalUserId ?? null,
              portalUserName: null,
              signedIn: Boolean(value.portalUserId),
            });
          }
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [value?.zohoCustomerId, value?.dealerName, value?.portalUserId]);

  const portalStatus = useMemo(
    () => (selectedDealer ? portalRegistrationStatus(selectedDealer) : null),
    [selectedDealer],
  );

  const selectedLocation = useMemo(() => {
    if (!selectedDealer) return '';
    return [selectedDealer.billingState, selectedDealer.district].filter(Boolean).join(' · ');
  }, [selectedDealer]);

  const pickDealer = (dealer: ZohoDealer) => {
    const next = dealerToOnBehalf(dealer);
    onChange(next);
    setSelectedDealer(dealer);
    setQuery(next.dealerName);
    setOpen(false);
  };

  return (
    <div className="support-dealer-picker" ref={rootRef}>
      <label className="sr-only" htmlFor="support-dealer-search">
        Dealer
      </label>
      <div className={`support-dealer-picker__search${open ? ' is-open' : ''}`}>
        <div className="support-dealer-picker__field">
          <Search size={16} aria-hidden className="support-dealer-picker__icon" />
          <input
            id="support-dealer-search"
            type="search"
            className="support-dealer-picker__input"
            placeholder="Search by dealer name or phone number"
            value={query}
            disabled={disabled}
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={open}
            onFocus={() => setOpen(true)}
            onChange={e => {
              setQuery(e.target.value);
              setOpen(true);
              if (value && e.target.value !== value.dealerName) onChange(null);
            }}
          />
          {loading && (
            <Loader2 size={16} className="spin-icon support-dealer-picker__spinner" aria-hidden />
          )}
        </div>

        {open && !disabled && (
          <ul className="support-dealer-picker__options" role="listbox">
            {dealers.length === 0 && !loading ? (
              <li className="support-dealer-picker__empty text-muted text-sm">No dealers match.</li>
            ) : (
              dealers.map(dealer => (
                <li key={dealer.id} role="option">
                  <button
                    type="button"
                    className={`support-dealer-picker__option${value?.zohoCustomerId === dealer.id ? ' is-selected' : ''}`}
                    onClick={() => pickDealer(dealer)}
                  >
                    <span className="support-dealer-picker__option-icon" aria-hidden>
                      <Building2 size={18} />
                    </span>
                    <span className="support-dealer-picker__option-body">
                      <span className="support-dealer-picker__option-head">
                        <strong>{dealerLabel(dealer)}</strong>
                        <span
                          className={`support-dealer-picker__option-badge${
                            dealer.signedIn ? ' is-registered' : ' is-unregistered'
                          }`}
                        >
                          {dealer.signedIn ? 'Registered' : 'Not registered'}
                        </span>
                      </span>
                      <span className="text-muted text-sm">
                        {[dealer.contactName, dealer.billingState, dealer.district]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {value && (
        <div
          className={`support-dealer-picker__status panel glass${
            portalStatus?.registered ? ' support-dealer-picker__status--registered' : ' support-dealer-picker__status--unregistered'
          }`}
        >
          {selectedLoading && !portalStatus ? (
            <span className="text-muted text-sm support-dealer-picker__status-loading">
              <Loader2 size={14} className="spin-icon" aria-hidden />
              Checking portal registration…
            </span>
          ) : portalStatus ? (
            <>
              <div className="support-dealer-picker__status-head">
                <span className="support-dealer-picker__status-icon" aria-hidden>
                  {portalStatus.registered ? <CheckCircle2 size={18} /> : <UserX size={18} />}
                </span>
                <div className="support-dealer-picker__status-copy">
                  <strong>{portalStatus.title}</strong>
                  <p className="text-sm text-muted">{portalStatus.detail}</p>
                </div>
              </div>
              <div className="support-dealer-picker__status-meta text-sm text-muted">
                <span>Zoho ID {value.zohoCustomerId}</span>
                {selectedLocation && <span>{selectedLocation}</span>}
                {portalStatus.phoneLabel && <span>{portalStatus.phoneLabel}</span>}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};

export function dateInputValueFromIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 10);
}

export function isoFromDateInput(value: string): string {
  if (!value) return new Date().toISOString();
  const [year, month, day] = value.split('-').map(Number);
  const local = new Date(year, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0);
  return local.toISOString();
}
