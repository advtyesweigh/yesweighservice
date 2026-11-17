import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Lock,
  Phone,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useTopBarAction } from '../../context/PageHeaderContext';
import { homePathForRole } from '../../types';
import { hasStaffPermission } from '../../lib/staffAccess';
import { DealerAddressBox } from '../../components/dealers/DealerAddressBox';
import { DealerCreateStatusOverlay, type DealerCreateStatusPhase } from '../../components/dealers/DealerCreateStatusOverlay';
import {
  playDealerFailSound,
  playDealerSuccessSound,
  unlockDealerActionAudio,
} from '../../lib/dealerActionSound';
import { DealerStatusIndicator } from '../../components/dealers/DealerStatusIndicator';
import { FetchingLoader } from '../../components/FetchingLoader';
import {
  dealerAddressFromDealer,
  dealerAddressesMatch,
  dealerAddressToZoho,
  formatDealerAddress,
  type DealerAddress,
} from '../../lib/dealerAddress';
import {
  deleteDealer,
  dealerErrorMessage,
  dealerStaffSelectOptions,
  fetchDealerById,
  listAssignableDealerStaff,
  patchDealer,
  pushDealerChangesToZoho,
  refreshDealerFromZoho,
} from '../../lib/dealers';
import { removeCachedDealer, upsertCachedDealer } from '../../lib/dealer-cache';
import {
  zohoPushableBaseline,
  type ZohoPushableFields,
} from '../../lib/dealerZohoPush';
import {
  blankFillableFieldKeys,
  buildZohoPushPayload,
  fillableFieldsToDraft,
  hasZohoPushChanges,
  topZohoContactFields,
  topZohoEmailField,
  visibleFillableFields,
  type ZohoFillableDraft,
  type ZohoFillableFieldDef,
  type ZohoFillableFieldKey,
} from '../../lib/dealerZohoFillable';
import { getDealerStatusMeta } from '../../lib/dealerStatus';
import { zohoDealerDisplayName } from '../../lib/logisticsDealers';
import { buildContactLinks } from '../../lib/phoneLinks';
import {
  assignDealerToPriceLevel,
  findPriceLevelForDealer,
  savePriceLevels,
  subscribePriceLevels,
} from '../../lib/priceLevels';
import type { PriceLevel } from '../../types/priceLevels';
import type { AssignableStaffOption, ZohoDealer } from '../../types/dealers';
import { DEALER_STAGES } from '../../types/dealers';

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.274-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

type OverlayDraft = Pick<
  ZohoDealer,
  | 'firstName'
  | 'email'
  | 'phone'
  | 'designation'
  | 'alternateMobile'
  | 'whatsappNumber'
  | 'dealerType'
  | 'firmType'
  | 'creditLimit'
  | 'priceLevel'
  | 'googleMapsUrl'
  | 'billingState'
  | 'district'
  | 'zipCode'
  | 'assignedStaffUid'
  | 'dealerStage'
  | 'categories'
  | 'canBuySpares'
  | 'orderPayOffline'
  | 'orderPayOnline'
  | 'adminApprovalRequired'
  | 'maxOrderLimit'
> & ZohoFillableDraft & {
  billing: DealerAddress;
  shipping: DealerAddress;
};

function dealerToDraft(dealer: ZohoDealer): OverlayDraft {
  return {
    firstName: dealer.firstName,
    email: dealer.email,
    phone: dealer.phone,
    designation: dealer.designation ?? null,
    alternateMobile: dealer.alternateMobile ?? null,
    whatsappNumber: dealer.whatsappNumber ?? null,
    dealerType: dealer.dealerType ?? null,
    firmType: dealer.firmType ?? null,
    creditLimit: dealer.creditLimit ?? null,
    priceLevel: dealer.priceLevel ?? null,
    googleMapsUrl: dealer.googleMapsUrl ?? null,
    billingState: dealer.billingState,
    district: dealer.district,
    zipCode: dealer.zipCode,
    assignedStaffUid: dealer.assignedStaffUid,
    dealerStage: dealer.dealerStage,
    categories: [...dealer.categories],
    canBuySpares: dealer.canBuySpares !== false,
    orderPayOffline: dealer.orderPayOffline !== false,
    orderPayOnline: Boolean(dealer.orderPayOnline),
    adminApprovalRequired: Boolean(dealer.adminApprovalRequired),
    maxOrderLimit: dealer.maxOrderLimit ?? null,
    billing: dealerAddressFromDealer(dealer, 'billing'),
    shipping: dealerAddressFromDealer(dealer, 'shipping'),
    ...fillableFieldsToDraft(dealer),
  };
}

function formatZohoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function FieldLabel({
  label,
  source,
}: {
  label: string;
  source?: 'zoho' | 'local';
}) {
  return (
    <span className="dealers-detail__field-label">
      {label}
      {source === 'zoho' && (
        <span
          className="dealers-detail__field-source dealers-detail__field-source--zoho"
          title="Syncs to Zoho"
          aria-label="Syncs to Zoho"
        />
      )}
      {source === 'local' && (
        <span
          className="dealers-detail__field-source dealers-detail__field-source--local"
          title="App only"
          aria-label="App only"
        />
      )}
    </span>
  );
}

function ContactNumberField({
  label,
  fieldSource,
  value,
  onChange,
  disabled,
  showCall = true,
  showWhatsApp = true,
  full,
}: {
  label: string;
  fieldSource?: 'zoho' | 'local';
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  showCall?: boolean;
  showWhatsApp?: boolean;
  full?: boolean;
}) {
  const links = value.trim() ? buildContactLinks(value) : null;

  return (
    <label className={`dealers-detail__field${full ? ' dealers-detail__field--full' : ''}`}>
      <FieldLabel label={label} source={fieldSource} />
      <div className="dealers-detail__input-actions">
        <input
          className="input-field"
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
        />
        {(showCall || showWhatsApp) && (
          <div className="dealers-detail__input-action-btns">
            {showCall && links && (
              <a
                href={links.tel}
                className="dealers-detail__icon-action dealers-detail__icon-action--call"
                aria-label={`Call ${label}`}
              >
                <Phone size={16} strokeWidth={2.25} />
              </a>
            )}
            {showWhatsApp && links && (
              <a
                href={links.whatsapp}
                className="dealers-detail__icon-action dealers-detail__icon-action--whatsapp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`WhatsApp ${label}`}
              >
                <WhatsAppIcon />
              </a>
            )}
          </div>
        )}
      </div>
    </label>
  );
}

function FlatReadOnlyField({
  label,
  value,
  full,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  full?: boolean;
  multiline?: boolean;
}) {
  const isPlainText = typeof value === 'string' || typeof value === 'number' || value == null;
  const empty = value == null || value === '';
  const text = empty ? '—' : String(value);

  return (
    <div className={`dealers-detail__field${full ? ' dealers-detail__field--full' : ''}`}>
      <span>{label}</span>
      {isPlainText ? (
        multiline ? (
          <textarea
            className="input-field dealers-detail__textarea"
            readOnly
            disabled
            value={text}
          />
        ) : (
          <input className="input-field" readOnly disabled value={text} />
        )
      ) : (
        <div className="dealers-detail__readonly-value">{value}</div>
      )}
    </div>
  );
}

function BlankOrReadOnlyZohoField({
  field,
  dealer,
  draftValue,
  editable,
  disabled,
  onChange,
}: {
  field: ZohoFillableFieldDef;
  dealer: ZohoDealer;
  draftValue: string;
  editable: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const storedValue = field.getValue(dealer);
  const displayValue = field.key === 'zohoGstTreatment'
    ? formatGstTreatment(storedValue)
    : storedValue;

  if (!editable) {
    return (
      <FlatReadOnlyField
        label={field.label}
        value={displayValue}
        full={field.full}
        multiline={field.multiline}
      />
    );
  }

  const input = field.multiline ? (
    <textarea
      className="input-field dealers-detail__textarea"
      rows={3}
      value={draftValue}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    />
  ) : (
    <input
      className="input-field"
      value={draftValue}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    />
  );

  return (
    <label className={`dealers-detail__field${field.full ? ' dealers-detail__field--full' : ''}`}>
      <FieldLabel label={field.label} source="zoho" />
      {input}
    </label>
  );
}

function formatGstTreatment(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function ToggleField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="dealers-detail__field dealers-detail__toggle">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`dealers-detail__toggle-btn ${checked ? 'dealers-detail__toggle-btn--on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="dealers-detail__toggle-knob" />
      </button>
    </label>
  );
}

const PULL_REFRESH_THRESHOLD = 72;
const PULL_REFRESH_MAX = 96;

export const DealerDetailPage: React.FC = () => {
  const { dealerId } = useParams<{ dealerId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canDeleteDealer = hasStaffPermission(user, 'dealers.edit');
  const preview = (location.state as { dealer?: ZohoDealer } | null)?.dealer;

  const [dealer, setDealer] = useState<ZohoDealer | null>(
    preview && preview.id === dealerId ? preview : null,
  );
  const [draft, setDraft] = useState<OverlayDraft | null>(
    preview && preview.id === dealerId ? dealerToDraft(preview) : null,
  );
  const [assignableStaff, setAssignableStaff] = useState<AssignableStaffOption[]>([]);
  const [loading, setLoading] = useState(!dealer);
  const [error, setError] = useState('');
  const [priceLevels, setPriceLevels] = useState<PriceLevel[]>([]);
  const [savingPriceLevel, setSavingPriceLevel] = useState(false);
  const [separateShipping, setSeparateShipping] = useState(() => {
    if (preview && preview.id === dealerId) {
      const next = dealerToDraft(preview);
      return !dealerAddressesMatch(next.billing, next.shipping);
    }
    return false;
  });
  const [saving, setSaving] = useState(false);
  const [deletePhase, setDeletePhase] = useState<DealerCreateStatusPhase | null>(null);
  const [deleteSuccessLabel, setDeleteSuccessLabel] = useState('Dealer deleted');
  const [refreshingZoho, setRefreshingZoho] = useState(false);
  const [zohoBaseline, setZohoBaseline] = useState<ZohoPushableFields | null>(
    preview && preview.id === dealerId ? zohoPushableBaseline(preview) : null,
  );
  const [blankFillableKeys, setBlankFillableKeys] = useState<ZohoFillableFieldKey[]>(
    preview && preview.id === dealerId ? blankFillableFieldKeys(preview) : [],
  );
  const [pullOffset, setPullOffset] = useState(0);
  const pullStateRef = useRef({ startY: 0, pulling: false, distance: 0 });

  const applyLoadedDealer = useCallback((data: ZohoDealer) => {
    const next = dealerToDraft(data);
    setDealer(data);
    setDraft(next);
    setZohoBaseline(zohoPushableBaseline(data));
    setBlankFillableKeys(blankFillableFieldKeys(data));
    setSeparateShipping(!dealerAddressesMatch(next.billing, next.shipping));
    upsertCachedDealer(data);
  }, []);

  const loadDealer = useCallback(async () => {
    if (!dealerId) return;
    setError('');
    setDealer(prev => {
      if (!prev) setLoading(true);
      return prev;
    });
    try {
      const data = await fetchDealerById(dealerId);
      applyLoadedDealer(data);
      setError('');
    } catch (err) {
      setDealer(prev => {
        if (!prev) setError(dealerErrorMessage(err));
        return prev;
      });
    } finally {
      setLoading(false);
    }
  }, [applyLoadedDealer, dealerId]);

  const refreshZoho = useCallback(async () => {
    if (!dealerId) return;
    setRefreshingZoho(true);
    setError('');
    try {
      const data = await refreshDealerFromZoho(dealerId);
      applyLoadedDealer(data);
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setRefreshingZoho(false);
    }
  }, [applyLoadedDealer, dealerId]);

  const refreshZohoRef = useRef(refreshZoho);
  refreshZohoRef.current = refreshZoho;

  useEffect(() => {
    const onTouchStart = (event: TouchEvent) => {
      if (refreshingZoho || window.scrollY > 4) return;
      pullStateRef.current.startY = event.touches[0]?.clientY ?? 0;
      pullStateRef.current.pulling = true;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!pullStateRef.current.pulling || window.scrollY > 4) return;
      const currentY = event.touches[0]?.clientY ?? 0;
      const delta = currentY - pullStateRef.current.startY;
      if (delta <= 0) {
        pullStateRef.current.distance = 0;
        setPullOffset(0);
        return;
      }
      const distance = Math.min(delta * 0.55, PULL_REFRESH_MAX);
      pullStateRef.current.distance = distance;
      setPullOffset(distance);
      if (distance > 8) {
        event.preventDefault();
      }
    };

    const onTouchEnd = () => {
      if (!pullStateRef.current.pulling) return;
      const shouldRefresh = pullStateRef.current.distance >= PULL_REFRESH_THRESHOLD;
      pullStateRef.current.pulling = false;
      pullStateRef.current.distance = 0;
      setPullOffset(0);
      if (shouldRefresh) {
        void refreshZohoRef.current();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [refreshingZoho]);

  useEffect(() => {
    void loadDealer();
  }, [loadDealer]);

  useEffect(() => {
    void listAssignableDealerStaff()
      .then(setAssignableStaff)
      .catch(err => console.error('Dealer detail meta load failed:', err));
  }, []);

  useEffect(() => subscribePriceLevels(docData => setPriceLevels(docData.levels)), []);

  const applyBillingAddress = (billing: DealerAddress, keepSeparate = separateShipping) => {
    setDraft(d => {
      if (!d) return d;
      const shipping = keepSeparate ? d.shipping : { ...billing };
      return {
        ...d,
        billing,
        shipping,
        zipCode: billing.zip || null,
        billingState: billing.state || null,
        district: billing.district || null,
        billingAddress: formatDealerAddress(billing) || null,
        shippingAddress: formatDealerAddress(shipping) || null,
      };
    });
  };

  const applyShippingAddress = (shipping: DealerAddress) => {
    setDraft(d => d ? {
      ...d,
      shipping,
      shippingAddress: formatDealerAddress(shipping) || null,
    } : d);
  };

  const dirty = useMemo(() => {
    if (!dealer || !draft) return false;
    return JSON.stringify(dealerToDraft(dealer)) !== JSON.stringify(draft);
  }, [dealer, draft]);

  const saveDraft = async () => {
    if (!dealer || !draft || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const payload = zohoBaseline
        ? buildZohoPushPayload(draft, dealer, zohoBaseline, blankFillableKeys)
        : {};
      const billingChanged = !dealerAddressesMatch(draft.billing, dealerAddressFromDealer(dealer, 'billing'));
      const nextShipping = separateShipping ? draft.shipping : draft.billing;
      const shippingChanged = !dealerAddressesMatch(
        nextShipping,
        dealerAddressFromDealer(dealer, 'shipping'),
      );
      if (billingChanged) payload.billing_address = dealerAddressToZoho(draft.billing);
      if (shippingChanged) payload.shipping_address = dealerAddressToZoho(nextShipping);
      if (hasZohoPushChanges(payload)) {
        await pushDealerChangesToZoho(dealer.id, payload);
      }
      await patchDealer(dealer.id, {
        ...draft,
        zipCode: draft.billing.zip || null,
        billingState: draft.billing.state || null,
        district: draft.billing.district || null,
        billingAddress: formatDealerAddress(draft.billing) || null,
        shippingAddress: formatDealerAddress(nextShipping) || null,
      });
      const refreshed = await fetchDealerById(dealer.id);
      const kamName = refreshed.assignedStaffName?.trim()
        || assignableStaff.find(row => row.uid === refreshed.assignedStaffUid)?.displayName
        || null;
      applyLoadedDealer({
        ...refreshed,
        assignedStaffName: kamName,
      });
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const assignPriceLevel = async (levelId: string) => {
    if (!dealer || !levelId || savingPriceLevel) return;
    const currentId = findPriceLevelForDealer(priceLevels, dealer.id)?.id ?? '';
    if (currentId === levelId) return;
    setSavingPriceLevel(true);
    setError('');
    try {
      await savePriceLevels(
        assignDealerToPriceLevel(priceLevels, dealer.id, levelId),
        user?.uid ?? null,
      );
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setSavingPriceLevel(false);
    }
  };

  const revertDraft = () => {
    if (!dealer || !dirty) return;
    applyLoadedDealer(dealer);
    setError('');
  };

  const blockDealer = async () => {
    if (!dealer) return;
    if (!window.confirm(`Block ${zohoDealerDisplayName(dealer)}?`)) return;
    setSaving(true);
    setError('');
    try {
      await patchDealer(dealer.id, {
        dealerStage: 'Black listed',
        isFiltered: true,
        filterReason: 'Manual',
      });
      await loadDealer();
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteDealer = async () => {
    if (!dealer || !canDeleteDealer) return;
    const label = zohoDealerDisplayName(dealer);
    const ok = await confirm({
      title: 'Delete dealer',
      message: `Delete ${label} from YesOne? If it is already gone from Zoho it will still be removed here. If Zoho has transactions, the dealer will be voided instead.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    unlockDealerActionAudio();
    setSaving(true);
    setDeletePhase('creating');
    setError('');
    try {
      const result = await deleteDealer(dealer.id);
      const successLabel = result.action === 'deleted' ? 'Dealer deleted' : 'Dealer voided';
      setDeleteSuccessLabel(successLabel);
      setDeletePhase('success');
      playDealerSuccessSound();
      if (result.action === 'deleted') {
        removeCachedDealer(dealer.id);
        const base = user ? homePathForRole(user.role) : '/super-admin';
        window.setTimeout(() => navigate(`${base}/dealers`), 1100);
        return;
      }
      await loadDealer();
      window.setTimeout(() => setDeletePhase(current => (current === 'success' ? null : current)), 1100);
    } catch (err) {
      const message = dealerErrorMessage(err);
      setError(message);
      setDeletePhase('fail');
      playDealerFailSound();
      window.setTimeout(() => setDeletePhase(current => (current === 'fail' ? null : current)), 2200);
    } finally {
      setSaving(false);
    }
  };

  const teamButton = useMemo(
    () => (
      <button
        type="button"
        className="top-bar__action-btn top-bar__action-btn--primary dealer-team__add-btn"
        onClick={() => {
          if (!user || !dealerId) return;
          navigate(`${homePathForRole(user.role)}/dealers/${dealerId}/team`, {
            state: dealer ? { dealer } : undefined,
          });
        }}
      >
        <Users size={16} strokeWidth={2.4} />
        Team
      </button>
    ),
    [dealer, dealerId, navigate, user],
  );
  useTopBarAction(teamButton, user?.role === 'super_admin' && Boolean(dealerId));

  if (!dealerId) return null;

  const name = dealer ? zohoDealerDisplayName(dealer) : '';
  const statusMeta = dealer && draft
    ? getDealerStatusMeta({ dealerStage: draft.dealerStage, signedIn: dealer.signedIn })
    : null;
  const zohoCreatedOn = dealer ? formatZohoDate(dealer.zohoCreatedTime) : null;

  const setFillableDraftField = (key: ZohoFillableFieldKey, value: string) => {
    setDraft(d => {
      if (!d) return d;
      return { ...d, [key]: value || null };
    });
  };

  const zohoEmailField = topZohoEmailField();
  const pullRefreshLabel = refreshingZoho
    ? 'Refreshing from Zoho…'
    : pullOffset >= PULL_REFRESH_THRESHOLD
      ? 'Release to refresh'
      : 'Pull down to refresh';

  return (
    <div
      className={`page-content fade-in dealers-detail-page${dirty ? ' dealers-detail-page--dirty' : ''}`}
    >
      {(pullOffset > 0 || refreshingZoho) && (
        <div
          className="dealers-detail__pull-refresh"
          style={{ height: refreshingZoho ? PULL_REFRESH_MAX : Math.max(pullOffset, 32) }}
          aria-live="polite"
        >
          <RefreshCw size={18} className={refreshingZoho ? 'spin-icon' : undefined} />
          <span>{pullRefreshLabel}</span>
        </div>
      )}

      <div
        className="dealers-detail-page__body"
        style={pullOffset > 0 && !refreshingZoho ? { transform: `translateY(${pullOffset}px)` } : undefined}
      >
      {error && (
        <div className="products-inline-error">
          <span>{error}</span>
        </div>
      )}

      {loading && !dealer ? (
        <FetchingLoader label="Fetching dealer" />
      ) : !dealer || !draft ? (
        <p className="text-muted">Dealer not found.</p>
      ) : (
        <div className="dealers-detail__form dealers-detail__form--page">
          <div className="dealers-detail__field dealers-detail__field--full dealers-detail__summary">
            <div className="dealers-detail__summary-main">
              <strong className="dealers-detail__summary-name">{name}</strong>
              {zohoCreatedOn && (
                <span className="dealers-detail__summary-meta">Created {zohoCreatedOn}</span>
              )}
            </div>
            {statusMeta && (
              <DealerStatusIndicator
                meta={statusMeta}
                className="dealers-detail__summary-status"
              />
            )}
          </div>

          <label className="dealers-detail__field">
            <FieldLabel label="Contact / owner name" source="zoho" />
            <input
              className="input-field"
              value={draft.firstName ?? ''}
              disabled={saving}
              onChange={e => setDraft(d => d ? { ...d, firstName: e.target.value || null } : d)}
            />
          </label>
          {topZohoContactFields().map(field => (
            <ContactNumberField
              key={field.key}
              label={field.label}
              fieldSource="zoho"
              value={field.getDraftValue(draft) ?? ''}
              disabled={saving || !blankFillableKeys.includes(field.key)}
              showCall
              showWhatsApp
              onChange={v => setFillableDraftField(field.key, v)}
            />
          ))}
          {zohoEmailField && (
            <BlankOrReadOnlyZohoField
              field={zohoEmailField}
              dealer={dealer}
              editable={blankFillableKeys.includes('zohoEmail')}
              draftValue={zohoEmailField.getDraftValue(draft) ?? ''}
              disabled={saving}
              onChange={value => setFillableDraftField('zohoEmail', value)}
            />
          )}

          <label className="dealers-detail__field">
            <FieldLabel label="Status" source="local" />
            <select
              className="catalog-select"
              value={draft.dealerStage ?? ''}
              disabled={saving}
              onChange={e => setDraft(d => d ? { ...d, dealerStage: e.target.value || null } : d)}
            >
              <option value="">Unset</option>
              {DEALER_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="dealers-detail__field dealers-detail__field--full">
            <FieldLabel label="KAM" source="local" />
            <select
              className="catalog-select"
              value={draft.assignedStaffUid ?? ''}
              disabled={saving}
              onChange={e => setDraft(d => d ? {
                ...d,
                assignedStaffUid: e.target.value || null,
              } : d)}
            >
              <option value="">Unassigned</option>
              {dealerStaffSelectOptions(assignableStaff, {
                uid: draft.assignedStaffUid,
                name: dealer.assignedStaffName,
              }).map(s => (
                <option key={s.uid} value={s.uid}>{s.displayName}</option>
              ))}
            </select>
            <span className="dealers-detail__staff-hint">
              Only KAMs with at least one linked Zoho salesperson can be assigned.
            </span>
          </label>

          {visibleFillableFields(dealer).map(field => (
            <BlankOrReadOnlyZohoField
              key={field.key}
              field={field}
              dealer={dealer}
              editable={blankFillableKeys.includes(field.key)}
              draftValue={field.getDraftValue(draft) ?? ''}
              disabled={saving}
              onChange={value => setFillableDraftField(field.key, value)}
            />
          ))}

          <FlatReadOnlyField
            label="Place of supply"
            value={dealer.zohoPlaceOfContactLabel || dealer.zohoPlaceOfContact}
          />
          <FlatReadOnlyField
            label="Tax"
            value={dealer.zohoTaxName
              ? `${dealer.zohoTaxName}${dealer.zohoTaxPercentage != null ? ` (${dealer.zohoTaxPercentage}%)` : ''}`
              : null}
          />

          {(dealer.zohoTags?.length ?? 0) > 0 && (
            <FlatReadOnlyField
              label="Tags"
              full
              value={(
                <div className="dealers-detail__tag-list">
                  {dealer.zohoTags!.map(tag => (
                    <span key={tag} className="dealers-detail__tag">{tag}</span>
                  ))}
                </div>
              )}
            />
          )}
          {dealer.zohoCustomFields?.map((field, index) => {
            const row = field as { label?: string; value?: unknown; api_name?: string };
            const label = row.label || row.api_name || `Custom field ${index + 1}`;
            const value = row.value != null ? String(row.value) : null;
            return (
              <FlatReadOnlyField key={`${label}-${index}`} label={label} value={value} />
            );
          })}

          {!separateShipping ? (
            <DealerAddressBox
              idPrefix="billing"
              title="Billing and shipping address is same"
              value={draft.billing}
              disabled={saving}
              onChange={billing => applyBillingAddress(billing, false)}
              extra={(
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={saving}
                  onClick={() => setSeparateShipping(true)}
                >
                  Different shipping
                </button>
              )}
            />
          ) : (
            <>
              <DealerAddressBox
                idPrefix="billing"
                title="Billing address"
                value={draft.billing}
                disabled={saving}
                onChange={billing => applyBillingAddress(billing, true)}
              />
              <DealerAddressBox
                idPrefix="shipping"
                title="Shipping address"
                value={draft.shipping}
                disabled={saving}
                onChange={applyShippingAddress}
                extra={(
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={saving}
                    onClick={() => {
                      applyBillingAddress(draft.billing, false);
                      setSeparateShipping(false);
                    }}
                  >
                    <Copy size={14} />
                    Same as billing
                  </button>
                )}
              />
            </>
          )}

          <label className="dealers-detail__field">
            <FieldLabel label="Price level" source="local" />
            <select
              className="catalog-select"
              value={findPriceLevelForDealer(priceLevels, dealer.id)?.id ?? ''}
              disabled={saving || savingPriceLevel || priceLevels.length === 0}
              onChange={e => void assignPriceLevel(e.target.value)}
            >
              {priceLevels.length === 0 ? (
                <option value="">Loading…</option>
              ) : (
                priceLevels.map(level => (
                  <option key={level.id} value={level.id}>{level.name}</option>
                ))
              )}
            </select>
          </label>
          <label className="dealers-detail__field dealers-detail__field--full">
            <span>Google Maps link</span>
            <div className="dealers-detail__link-field">
              <input
                className="input-field"
                value={draft.googleMapsUrl ?? ''}
                disabled={saving}
                onChange={e => setDraft(d => d ? { ...d, googleMapsUrl: e.target.value || null } : d)}
                placeholder="https://maps.google.com/…"
              />
              {draft.googleMapsUrl && (
                <a
                  href={draft.googleMapsUrl}
                  className="dealers-detail__link-open"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open map"
                >
                  <ExternalLink size={16} />
                </a>
              )}
            </div>
          </label>

          <ToggleField
            label="Can buy spare parts"
            checked={draft.canBuySpares ?? true}
            disabled={saving}
            onChange={v => setDraft(d => d ? { ...d, canBuySpares: v } : d)}
          />
          <ToggleField
            label="Order online · pay offline"
            checked={draft.orderPayOffline ?? true}
            disabled={saving}
            onChange={v => setDraft(d => d ? { ...d, orderPayOffline: v } : d)}
          />
          <ToggleField
            label="Order and pay online"
            checked={draft.orderPayOnline ?? false}
            disabled={saving}
            onChange={v => setDraft(d => d ? { ...d, orderPayOnline: v } : d)}
          />

          <div className="dealers-detail__field dealers-detail__field--full dealers-detail__actions-row">
            <button
              type="button"
              className="btn btn-secondary dealers-detail__action--warn"
              disabled={saving}
              onClick={() => void blockDealer()}
            >
              <Lock size={16} />
              Block dealer
            </button>
            {canDeleteDealer ? (
              <button
                type="button"
                className="btn btn-primary dealers-detail__action--delete"
                disabled={saving}
                onClick={() => void handleDeleteDealer()}
              >
                <Trash2 size={16} />
                Delete
              </button>
            ) : null}
          </div>
        </div>
      )}

      </div>

      {deletePhase ? (
        <DealerCreateStatusOverlay
          phase={deletePhase}
          cover="page"
          workingLabel="Deleting dealer…"
          successLabel={deleteSuccessLabel}
          failLabel={error || 'Could not delete dealer'}
        />
      ) : null}

      {dirty && dealer && (
        <div className="dealers-detail__save-float" role="region" aria-label="Unsaved changes">
          <div className="dealers-detail__save-float-actions">
            <button
              type="button"
              className="btn btn-secondary dealers-detail__save-float-btn dealers-detail__save-float-btn--revert"
              disabled={saving || refreshingZoho}
              onClick={revertDraft}
              aria-label="Revert changes"
              title="Revert changes"
            >
              <RotateCcw size={18} />
            </button>
            <button
              type="button"
              className="btn btn-primary dealers-detail__save-float-btn"
              disabled={saving || refreshingZoho}
              onClick={() => void saveDraft()}
              aria-label={saving ? 'Saving changes' : 'Save changes'}
              title={saving ? 'Saving…' : 'Save changes'}
            >
              <Save size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
