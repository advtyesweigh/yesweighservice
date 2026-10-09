import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BadgeCheck,
  Ban,
  Box,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Layers,
  Phone,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AedMark } from '../../components/AedMark';
import { ScheduleTrainingSheet } from '../../components/software/ScheduleTrainingSheet';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import {
  useCatalogPageHeader,
  usePageHeaderSlot,
  usePageHeaderTitleMeta,
  useTopBarAction,
} from '../../context/PageHeaderContext';
import { captureElementScreenshot } from '../../lib/shareElementScreenshot';
import { callerTelHref } from '../../lib/softwarePhone';
import { sendWhatsAppFile, sendWhatsAppText, whatsappInboxChatPath } from '../../lib/whatsappInbox';
import { uniqueSoftwareSubscriptions } from '../../lib/softwareQuery';
import {
  DEFAULT_SOFTWARE_DEALER_FILTER,
  SOFTWARE_END_IN_OPTIONS,
  SOFTWARE_EXPIRED_IN_OPTIONS,
  SOFTWARE_INFORMED_OPTIONS,
  addSoftwareShopFollowUp,
  formatShopRateCardMessage,
  SOFTWARE_TZ_INDIA,
  SOFTWARE_TZ_UAE,
  canVoidSoftwareShop,
  completeSoftwareShopTraining,
  compareSoftwareShopsByIdDesc,
  formatShopDateTime,
  formatSoftwareEndDays,
  formatSoftwareRenewalCharge,
  shopRenewalQuote,
  softwareCallRenewalCharge,
  isWeighvoxSource,
  markSoftwareWhatsAppRenewalSent,
  normalizeSoftwareSubscription,
  shopFollowUpChannels,
  shopIsInformed,
  shopIsNewCustomer,
  shopIsVoided,
  shopMatchesDealerFilter,
  shopMatchesEndIn,
  shopMatchesExpiredIn,
  shopMatchesInformed,
  shopMatchesStatusFilter,
  shopSearchHaystack,
  softwareCustomerHref,
  softwareOrgLabel,
  softwareOrgTone,
  softwareRenewalWhatsAppHref,
  subscribeSoftwareShopFollowUps,
  subscribeSoftwareShopTrainings,
  subscribeSoftwareShops,
  syncSanoftShops,
  voidSoftwareShop,
} from '../../lib/softwareShops';
import type {
  SoftwareDealerFilter,
  SoftwareEndInFilter,
  SoftwareExpiredInFilter,
  SoftwareFollowUpChannel,
  SoftwareInformedFilter,
  SoftwareShop,
  SoftwareShopFollowUp,
  SoftwareShopStatus,
  SoftwareShopTraining,
} from '../../types/software-shop';
import '../../software.css';

const PAGE_SIZE = 15;

type StatusFilter = 'ALL' | SoftwareShopStatus;

type FilterDraft = {
  dealer: SoftwareDealerFilter;
  status: StatusFilter;
  subscription: string;
  endIn: SoftwareEndInFilter;
  expiredIn: SoftwareExpiredInFilter;
  informed: SoftwareInformedFilter;
};

const EMPTY_FILTER_DRAFT: FilterDraft = {
  dealer: DEFAULT_SOFTWARE_DEALER_FILTER,
  status: 'ALL',
  subscription: '',
  endIn: '',
  expiredIn: '',
  informed: '',
};

const KNOWN_SUBSCRIPTION_ORDER = [
  'sanoft lite',
  'sanoft pro',
  'sanoft elite',
  'standard',
  'premium',
  'double standard',
  'standard 18000',
  'standard 30000',
] as const;

function subscriptionSortRank(name: string): number {
  const normalized = normalizeSoftwareSubscription(name);
  if (normalized === 'standard 18000' || normalized.startsWith('standard 18000')) {
    return KNOWN_SUBSCRIPTION_ORDER.indexOf('standard 18000');
  }
  if (normalized === 'standard 30000' || normalized.startsWith('standard 30000')) {
    return KNOWN_SUBSCRIPTION_ORDER.indexOf('standard 30000');
  }
  const exact = (KNOWN_SUBSCRIPTION_ORDER as readonly string[]).indexOf(normalized);
  return exact >= 0 ? exact : Number.POSITIVE_INFINITY;
}

function sortSoftwareSubscriptions(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const rankA = subscriptionSortRank(a);
    const rankB = subscriptionSortRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b, 'en-IN');
  });
}

const STATUS_FILTER_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'ACTIVE', label: 'Active' },
  { id: 'EXPIRING SOON', label: 'Expiring soon' },
  { id: 'EXPIRED', label: 'Expired' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'VOIDED', label: 'Void' },
];

const STATUS_TILES: Array<{
  id: StatusFilter;
  label: string;
  tone: 'active' | 'expiring' | 'expired' | 'all';
  icon: LucideIcon;
}> = [
  { id: 'ACTIVE', label: 'Active', tone: 'active', icon: CheckCircle2 },
  { id: 'EXPIRING SOON', label: 'Expiring Soon', tone: 'expiring', icon: Clock },
  { id: 'EXPIRED', label: 'Expired', tone: 'expired', icon: Ban },
  { id: 'ALL', label: 'ALL', tone: 'all', icon: Layers },
];

function dash(value: string | number | null | undefined): string {
  if (value == null) return '—';
  const text = String(value).trim();
  return text || '—';
}

function hasShopFieldValue(value: string | number | null | undefined): boolean {
  if (value == null) return false;
  const text = String(value).trim();
  return Boolean(text) && text !== '—' && text !== '-';
}

function formatDmy(value: string | number | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

const FIELD_LABELS: Record<string, string> = {
  bluetoothScaleValidity: 'Bluetooth Scale',
  category: 'Category',
  country: 'Country',
  currencyName: 'Currency Name',
  customerSupportValidity: 'Customer Support',
  dealerPhone: 'Dealer Phone',
  kitchenDisplayValidity: 'Kitchen Display',
  onlineCartValidity: 'Online Cart',
  planStatus: 'Plan Status',
  queueDisplayValidity: 'Queue Display',
  quickbookSupportValidity: 'QuickBooks Support',
  subCategory: 'Sub Category',
  subscriptionType: 'Subscription Type',
  taxPreference: 'Tax Preference',
  taxRegion: 'Tax Region',
  taxType: 'Tax Type',
  warehouseValidity: 'Warehouse',
  zohoSupportValidity: 'Zoho Support',
};

const GENERAL_EXTRA_KEYS = [
  'planStatus',
  'subscriptionType',
  'category',
  'subCategory',
] as const;

const VALIDITY_EXTRA_KEYS = [
  'customerSupportValidity',
  'bluetoothScaleValidity',
  'kitchenDisplayValidity',
  'queueDisplayValidity',
  'onlineCartValidity',
  'warehouseValidity',
  'quickbookSupportValidity',
  'zohoSupportValidity',
] as const;

const CONTACT_EXTRA_KEYS = ['currencyName'] as const;

function extraValue(shop: SoftwareShop, key: string): string {
  return String(shop.extras[key] ?? '').trim();
}

function shopPlanStatus(shop: SoftwareShop): string {
  return extraValue(shop, 'planStatus');
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (ch) => ch.toUpperCase());
}

function formatFieldValue(key: string, value: string): string {
  if (/validity|date|end$/i.test(key) || /^\d{4}-\d{2}-\d{2}/.test(value)) return formatDmy(value);
  return dash(value);
}

function statusClass(status: SoftwareShopStatus): string {
  if (status === 'ACTIVE') return 'software-status software-status--active';
  if (status === 'EXPIRING SOON') return 'software-status software-status--expiring';
  if (status === 'CANCELLED') return 'software-status software-status--cancelled';
  if (status === 'VOIDED') return 'software-status software-status--voided';
  return 'software-status software-status--expired';
}

function endDateClass(status: SoftwareShopStatus): string {
  if (status === 'ACTIVE') return 'software-end software-end--active';
  if (status === 'EXPIRING SOON') return 'software-end software-end--expiring';
  if (status === 'CANCELLED') return 'software-end software-end--cancelled';
  if (status === 'VOIDED') return 'software-end software-end--voided';
  return 'software-end software-end--expired';
}

function RenewalChargeValue({ shop }: { shop: SoftwareShop }) {
  const charge = softwareCallRenewalCharge(shop);
  if (!charge) return <>{formatSoftwareRenewalCharge(shop)}</>;
  const amount = charge.amount.toLocaleString(charge.currency === 'AED' ? 'en-AE' : 'en-IN', {
    maximumFractionDigits: 0,
  });
  return (
    <span className="software-charge">
      {charge.currency === 'AED' ? <AedMark className="software-aed" /> : '₹'}
      {amount}
    </span>
  );
}

function EndDateValue({
  value,
  status,
}: {
  value: string | number | null | undefined;
  status: SoftwareShopStatus;
}) {
  const text = formatDmy(value);
  if (!hasShopFieldValue(text)) return <>{text}</>;
  const days = formatSoftwareEndDays(String(value ?? ''));
  return (
    <span className={endDateClass(status)}>
      {text}
      {days ? ` (${days})` : ''}
    </span>
  );
}

function formatFollowUpWhen(value: string | null | undefined): string {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function followUpChannelLabel(channel: SoftwareFollowUpChannel | ''): string {
  if (channel === 'call') return 'Call';
  if (channel === 'whatsapp') return 'WhatsApp';
  return '';
}

function actorDisplayName(user: { displayName?: string; email?: string; loginId?: string } | null | undefined): string {
  return user?.displayName?.trim() || user?.email?.trim() || user?.loginId?.trim() || 'User';
}

function FollowUpChannelMarks({ shop }: { shop: SoftwareShop }) {
  const channels = shopFollowUpChannels(shop);
  if (!channels.length) return null;
  return (
    <span className="software-follow-tags">
      {channels.map((channel) => (
        <span
          key={channel}
          className={`software-contacted software-contacted--${channel}`}
        >
          {followUpChannelLabel(channel)}
        </span>
      ))}
    </span>
  );
}

function InformedMark({ shop }: { shop: SoftwareShop }) {
  if (!shopIsInformed(shop)) return null;
  return (
    <span className="software-informed" title="Informed" role="img" aria-label="Informed">
      <BadgeCheck size={15} strokeWidth={2.3} aria-hidden />
    </span>
  );
}

function NewCustomerMark({ shop }: { shop: SoftwareShop }) {
  if (!shopIsNewCustomer(shop)) return null;
  return (
    <span className="software-new-tag" title="New — training pending">New</span>
  );
}

function MenuUploadedMark({ shop }: { shop: SoftwareShop }) {
  if (!shop.menuUploaded) return null;
  return (
    <span className="software-menu-tag" title="Menu uploaded">Menu uploaded</span>
  );
}

function shopShowsCancelled(shop: SoftwareShop): boolean {
  return !shopIsVoided(shop) && (shop.cancelled || shop.status === 'CANCELLED');
}

function shopListTone(shop: SoftwareShop): 'is-voided' | 'is-cancelled' | '' {
  if (shopIsVoided(shop)) return 'is-voided';
  if (shopShowsCancelled(shop)) return 'is-cancelled';
  return '';
}

function StatusStamp({
  kind,
  compact = false,
}: {
  kind: 'cancelled' | 'voided';
  compact?: boolean;
}) {
  return (
    <span
      className={`software-cancelled-stamp${kind === 'voided' ? ' software-cancelled-stamp--void' : ''}${compact ? ' software-cancelled-stamp--compact' : ''}`}
      role="img"
      aria-label={kind === 'voided' ? 'Void' : 'Cancelled'}
    />
  );
}

function shopStamp(shop: SoftwareShop, compact = false) {
  if (shopIsVoided(shop)) return <StatusStamp kind="voided" compact={compact} />;
  if (shopShowsCancelled(shop)) return <StatusStamp kind="cancelled" compact={compact} />;
  return null;
}

function OrgValue({ sourceAccount }: { sourceAccount: string }) {
  return (
    <span className={`software-org software-org--${softwareOrgTone(sourceAccount)}`}>
      {softwareOrgLabel(sourceAccount)}
    </span>
  );
}

function FieldRow({ label, value, omitFromSend }: { label: string; value: React.ReactNode; omitFromSend?: boolean }) {
  return (
    <div className="software-field" {...(omitFromSend ? { 'data-shop-staff': '' } : {})}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the rate card.'));
    reader.readAsDataURL(file);
  });
}

function ShopWhatsAppCard({
  shop,
  cardRef,
}: {
  shop: SoftwareShop;
  cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const quote = shopRenewalQuote(shop);
  const days = formatSoftwareEndDays(shop.subscriptionEnd);
  const end = shop.subscriptionEnd ? formatDmy(shop.subscriptionEnd) : '—';
  const rows: Array<[string, string]> = [
    ['Shop ID', String(shop.shopId || '—')],
    ['Organisation', softwareOrgLabel(shop.sourceAccount)],
    ['Phone', shop.phone || '—'],
    ['Subscription', shop.subscription || '—'],
    ['Expiry', days ? `${end} (${days})` : end],
  ];
  if (quote) {
    rows.push([quote.subscriptionLabel, quote.subscriptionAmount]);
    if (quote.smartScaleAmount) rows.push(['Smart Scale', quote.smartScaleAmount]);
    rows.push(['Total', quote.totalAmount]);
  }
  return (
    <div
      ref={cardRef}
      style={{
        width: 360,
        padding: 20,
        background: '#ffffff',
        color: '#111827',
        fontFamily: 'Arial, Helvetica, sans-serif',
        borderRadius: 18,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6b7280', fontWeight: 700 }}>
        YesWeigh renewal
      </div>
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>
        {shop.name || `Shop ${shop.shopId}`}
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid #e5e7eb',
            fontSize: 14,
          }}
        >
          <span style={{ color: '#6b7280' }}>{label}</span>
          <span style={{ fontWeight: 700, textAlign: 'right' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

async function shopCardImageFile(card: HTMLElement, shopId: string | number): Promise<File> {
  const width = Math.max(card.offsetWidth, 360);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;background:#ffffff;`;
  const clone = card.cloneNode(true) as HTMLElement;
  clone.hidden = false;
  clone.style.display = 'block';
  clone.style.overflow = 'visible';
  clone.style.height = 'auto';
  clone.style.maxHeight = 'none';
  clone.style.width = `${width}px`;
  clone.style.background = '#ffffff';
  clone.querySelectorAll('[data-shop-staff]').forEach(node => node.remove());
  clone.querySelectorAll('a').forEach(anchor => {
    if (!anchor.textContent?.trim()) anchor.remove();
  });
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    const id = String(shopId || 'shop').replace(/[^\w.-]+/g, '-');
    const shot = await captureElementScreenshot(clone, {
      backgroundColor: '#ffffff',
      format: 'jpeg',
      quality: 0.92,
      fileName: `shop-${id}.jpg`,
    });
    if (!shot.blob.size) throw new Error('Could not generate a rate card for this shop.');
    return new File([shot.blob], shot.fileName, { type: shot.mimeType });
  } finally {
    host.remove();
  }
}

function TrainingLogList({
  shop,
  logs,
  loading,
}: {
  shop: SoftwareShop;
  logs: SoftwareShopTraining[];
  loading?: boolean;
}) {
  const fallback = !logs.length && (shop.trainingScheduledAt || shop.trainingPoints)
    ? [{
      id: 'latest',
      userId: '',
      userName: shop.trainingScheduledByName,
      scheduledAt: shop.trainingScheduledAt,
      trainingPoints: shop.trainingPoints,
      pocName: shop.pocName,
      ownerPhone: shop.ownerPhone,
      pocPhone: shop.pocPhone,
      createdAt: shop.trainingScheduledAt,
    } satisfies SoftwareShopTraining]
    : logs;

  return (
    <section className="software-card software-training-logs">
      <h3>Training logs</h3>
      {loading && !fallback.length ? (
        <p className="text-muted text-sm software-empty">Loading training logs…</p>
      ) : !fallback.length ? (
        <p className="text-muted text-sm software-empty">No training logs yet.</p>
      ) : (
        <ul className="software-follow__list">
          {fallback.map((item) => (
            <li key={item.id}>
              <div className="software-follow__item-top">
                <strong>{dash(item.userName) || 'Training'}</strong>
                <time dateTime={item.scheduledAt || item.createdAt || undefined}>
                  {isWeighvoxSource(shop.sourceAccount) && item.scheduledAt
                    ? `${formatShopDateTime(item.scheduledAt, SOFTWARE_TZ_UAE)} UAE · ${formatShopDateTime(item.scheduledAt, SOFTWARE_TZ_INDIA)} India`
                    : formatShopDateTime(item.scheduledAt || item.createdAt || '', SOFTWARE_TZ_INDIA) || formatFollowUpWhen(item.createdAt)}
                </time>
              </div>
              {item.pocName ? <p>POC: {item.pocName}</p> : null}
              {item.trainingPoints ? <p className="software-training-points">{item.trainingPoints}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SoftwareCustomerPicker({ shop }: { shop: SoftwareShop }) {
  if (!shop.customerName && !shop.customerId) return <span>—</span>;
  const href = softwareCustomerHref(shop.customerOrgKey, shop.customerId);
  return (
    <Link className="software-customer-link" to={href} onClick={(event) => event.stopPropagation()}>
      {dash(shop.customerName || shop.customerId)}
    </Link>
  );
}

function stopPhoneAction(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function SoftwarePhoneActions({
  shop,
  phone,
  compact = true,
  onPrefillSent,
}: {
  shop: SoftwareShop;
  phone: string;
  compact?: boolean;
  onPrefillSent?: (shopDocId: string) => void;
}) {
  const callHref = callerTelHref(phone);
  const waHref = softwareRenewalWhatsAppHref(phone, shop.whatsappRenewalSentAt);
  const prefill = waHref.includes('?text=');
  const iconSize = compact ? 13 : 17;

  const onWhatsAppClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    stopPhoneAction(event);
    if (!waHref) return;
    // Open this render's href first (text= on first touch / after 350 days).
    // Writing sentAt before navigation re-renders the <a> without ?text=.
    event.preventDefault();
    window.open(waHref, '_blank', 'noopener,noreferrer');
    if (!prefill) return;
    onPrefillSent?.(shop.id);
    void markSoftwareWhatsAppRenewalSent(shop.id).catch(() => undefined);
  };

  return (
    <span className={`software-phone${compact ? ' software-phone--compact' : ' software-phone--detail'}${phone.trim() ? '' : ' is-empty'}`}>
      {callHref ? (
        <a
          className="customers-item__call"
          href={callHref}
          aria-label="Call"
          onClick={stopPhoneAction}
          onKeyDown={stopPhoneAction}
        >
          <Phone size={iconSize} />
        </a>
      ) : null}
      <span className="software-phone__num">{dash(phone)}</span>
      {waHref ? (
        <a
          className="customers-item__wa"
          href={waHref}
          target="_blank"
          rel="noreferrer"
          aria-label="WhatsApp"
          onClick={onWhatsAppClick}
          onKeyDown={stopPhoneAction}
        >
          <WhatsAppIcon size={iconSize} />
        </a>
      ) : null}
    </span>
  );
}

function pageItems(current: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const marks = new Set([0, total - 1, current]);
  for (let i = current - 1; i <= current + 1; i += 1) {
    if (i > 0 && i < total - 1) marks.add(i);
  }
  const ordered = [...marks].sort((a, b) => a - b);
  const items: Array<number | 'gap'> = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (i > 0 && ordered[i] - ordered[i - 1] > 1) items.push('gap');
    items.push(ordered[i]);
  }
  return items;
}

export type SoftwareShopShareTarget = {
  waId: string;
};

export const SoftwareDetailsModal: React.FC<{
  shop: SoftwareShop;
  onClose: () => void;
  onPrefillSent?: (shopDocId: string) => void;
  initialMenuOpen?: boolean;
  /** When set, this card was opened from a WhatsApp chat and Send delivers the rate card there. */
  shareTarget?: SoftwareShopShareTarget | null;
  onShared?: () => void;
}> = ({
  shop,
  onClose,
  onPrefillSent,
  initialMenuOpen = false,
  shareTarget = null,
  onShared,
}) => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [tab, setTab] = useState<'details' | 'followup'>('details');
  const [followUps, setFollowUps] = useState<SoftwareShopFollowUp[]>([]);
  const [followLoading, setFollowLoading] = useState(true);
  const [followError, setFollowError] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidError, setVoidError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');
  const [trainingOver, setTrainingOver] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(Boolean(initialMenuOpen));
  const [trainings, setTrainings] = useState<SoftwareShopTraining[]>([]);
  const [trainingLoading, setTrainingLoading] = useState(true);
  const [remarks, setRemarks] = useState('');
  const [channel, setChannel] = useState<SoftwareFollowUpChannel>('call');
  const followLogsRef = useRef<HTMLDivElement>(null);
  const shopCardRef = useRef<HTMLDivElement>(null);
  const actorUid = user?.uid || '';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (scheduleOpen) {
        setScheduleOpen(false);
        return;
      }
      onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, menuOpen, scheduleOpen]);

  useEffect(() => {
    setFollowLoading(true);
    return subscribeSoftwareShopFollowUps(
      shop.id,
      (rows) => {
        setFollowUps((prev) => {
          const pending = prev.filter((row) => (
            row.id.startsWith('pending-')
            && !rows.some((item) => (
              item.remarks === row.remarks
              && item.userId === row.userId
              && item.channel === row.channel
            ))
          ));
          return [...pending, ...rows];
        });
        setFollowLoading(false);
      },
      (message) => {
        setFollowError(message);
        setFollowLoading(false);
      },
    );
  }, [shop.id]);

  useEffect(() => {
    setTrainingLoading(true);
    return subscribeSoftwareShopTrainings(
      shop.id,
      (rows) => {
        setTrainings(rows);
        setTrainingLoading(false);
      },
      () => setTrainingLoading(false),
    );
  }, [shop.id]);

  const actorName = actorDisplayName(user);
  const generalExtraKeys = GENERAL_EXTRA_KEYS.filter((key) => hasShopFieldValue(extraValue(shop, key)));
  const validityExtraKeys = VALIDITY_EXTRA_KEYS.filter((key) => hasShopFieldValue(extraValue(shop, key)));
  const contactExtraKeys = CONTACT_EXTRA_KEYS.filter((key) => {
    const value = extraValue(shop, key);
    if (!hasShopFieldValue(value)) return false;
    if (key === 'currencyName' && (value === shop.currency || extraValue(shop, 'currencySymbol') === value)) return false;
    return true;
  });
  const showValidityCard = Boolean(
    hasShopFieldValue(shop.expenseValidity)
    || hasShopFieldValue(shop.imageSupport)
    || hasShopFieldValue(shop.kotValidity)
    || hasShopFieldValue(shop.kotLite)
    || hasShopFieldValue(shop.smartScale)
    || validityExtraKeys.length,
  );
  const renewalCharge = formatSoftwareRenewalCharge(shop);
  const renewalQuote = shopRenewalQuote(shop);
  const showContactCard = Boolean(
    hasShopFieldValue(shop.phone)
    || hasShopFieldValue(shop.subscriptionEnd)
    || hasShopFieldValue(renewalCharge)
    || hasShopFieldValue(shop.currency)
    || contactExtraKeys.length,
  );

  const cancelled = shopShowsCancelled(shop);
  const voided = shopIsVoided(shop);
  const canVoid = canVoidSoftwareShop(user?.role) && !cancelled && !voided;
  const fromWhatsApp = Boolean(String(shareTarget?.waId || '').replace(/\D/g, ''));
  const canSaveFollowUp = Boolean(remarks.trim() && channel && user);

  const shareRateCard = async () => {
    if (sharing) return;
    const text = formatShopRateCardMessage(shop).trim();
    if (!text) {
      setShareError('Could not generate a rate card for this shop.');
      return;
    }
    setSharing(true);
    setShareError('');
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: shop.name || `Shop ${shop.shopId}`,
          text,
        });
        return;
      }
      await navigator.clipboard.writeText(text);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setShareError(err instanceof Error ? err.message : 'Could not share rate card.');
    } finally {
      setSharing(false);
    }
  };

  const sendRateCard = async () => {
    const waId = String(shareTarget?.waId || '').replace(/\D/g, '');
    if (!waId || sharing) return;
    const caption = formatShopRateCardMessage(shop).trim().slice(0, 1000);
    if (!caption) {
      setShareError('Could not generate a rate card for this shop.');
      return;
    }
    setSharing(true);
    setShareError('');
    try {
      const card = shopCardRef.current;
      let sentFile = false;
      if (card) {
        try {
          const file = await shopCardImageFile(card, shop.shopId || shop.id);
          if (file.size) {
            await sendWhatsAppFile({
              waId,
              fileBase64: await fileToBase64(file),
              mimeType: file.type || 'image/jpeg',
              fileName: file.name,
              caption,
            });
            sentFile = true;
          }
        } catch {
          sentFile = false;
        }
      }
      if (!sentFile) await sendWhatsAppText(waId, caption);
      await markSoftwareWhatsAppRenewalSent(shop.id).catch(() => undefined);
      onPrefillSent?.(shop.id);
      onShared?.();
      onClose();
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not send the rate card.');
    } finally {
      setSharing(false);
    }
  };
  const visibleFollowUps = useMemo(() => {
    return [...followUps].sort((a, b) => {
      if (a.createdAt === b.createdAt) return 0;
      if (!a.createdAt) return -1;
      if (!b.createdAt) return 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }, [followUps]);
  const saveFollowUp = async () => {
    const text = remarks.trim();
    if (!text || !user) return;
    if (!channel) {
      setFollowError('Pick Call or WhatsApp.');
      return;
    }
    const pendingId = `pending-${Date.now()}`;
    const pending: SoftwareShopFollowUp = {
      id: pendingId,
      userId: user.uid,
      userName: actorName,
      remarks: text,
      channel,
      createdAt: new Date().toISOString(),
    };
    setSaving(true);
    setFollowError('');
    setFollowUps((prev) => [pending, ...prev]);
    followLogsRef.current?.scrollTo({ top: 0 });
    try {
      await addSoftwareShopFollowUp(shop.id, {
        userId: user.uid,
        userName: actorName,
        remarks: text,
        channel,
      });
      setRemarks('');
      setChannel('call');
    } catch (err) {
      setFollowUps((prev) => prev.filter((row) => row.id !== pendingId));
      setFollowError(err instanceof Error ? err.message : 'Could not save this log.');
    } finally {
      setSaving(false);
    }
  };

  const voidShop = async () => {
    const ok = await confirm({
      title: 'Void this shop?',
      message: 'This marks the shop Void in Meezan. It does not delete the shop from Sanoft, and it stays out of All.',
      confirmLabel: 'Void',
      destructive: true,
    });
    if (!ok) return;
    setVoiding(true);
    setVoidError('');
    try {
      await voidSoftwareShop(shop.id);
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'Could not void this shop.');
    } finally {
      setVoiding(false);
    }
  };

  return createPortal(
    <div className="software-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className={`software-modal${voided ? ' is-voided' : cancelled ? ' is-cancelled' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="software-shop-title"
        onClick={(event) => event.stopPropagation()}
      >
        {shopStamp(shop)}
        <header className="software-modal__head">
          <div className="software-modal__head-main">
            <div className="software-modal__title-row">
              <h2 id="software-shop-title">Shop Details</h2>
              <MenuUploadedMark shop={shop} />
              {voided ? <span className={statusClass('VOIDED')}>Void</span> : null}
              {cancelled ? <span className={statusClass('CANCELLED')}>Cancelled</span> : null}
            </div>
            <div className="software-modal__tabs" role="tablist" aria-label="Shop details sections">
              <button
                type="button"
                role="tab"
                className={`software-modal__tab${tab === 'details' ? ' is-active' : ''}`}
                aria-selected={tab === 'details'}
                onClick={() => setTab('details')}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                className={`software-modal__tab${tab === 'followup' ? ' is-active' : ''}`}
                aria-selected={tab === 'followup'}
                onClick={() => setTab('followup')}
              >
                Follow-up
              </button>
              <button
                type="button"
                className="software-modal__tab software-modal__schedule-btn"
                onClick={() => setScheduleOpen(true)}
              >
                Schedule
              </button>
            </div>
          </div>
          <button type="button" className="software-modal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div
          className="software-modal__body"
          style={tab === 'followup' ? { overflow: 'hidden' } : undefined}
        >
          {tab === 'followup' ? (
            <section
              className="software-card software-follow"
              style={{
                display: 'flex',
                flexDirection: 'column',
                flex: '1 1 auto',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              <form
                className="software-follow__form"
                style={{ flex: '0 1 auto', minHeight: 0, overflow: 'auto' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveFollowUp();
                }}
              >
                <div className="software-follow__toolbar">
                  <button
                    type="submit"
                    className="btn btn-primary software-follow__log-btn"
                    disabled={saving || !canSaveFollowUp}
                  >
                    {saving ? 'Saving…' : 'Log reminder'}
                  </button>
                </div>
                <span className="org-filter-panel__label">Channel</span>
                <div className="org-filter-panel__chips">
                  {([
                    { id: 'call', label: 'Call' },
                    { id: 'whatsapp', label: 'WhatsApp' },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`org-filter-tabs__btn${channel === option.id ? ' is-active' : ''}`}
                      onClick={() => setChannel(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <label className="software-follow__field">
                  <span>Remarks</span>
                  <textarea
                    className="input-field"
                    value={remarks}
                    onChange={(event) => setRemarks(event.target.value)}
                    rows={8}
                    required
                    style={{ minHeight: 'min(220px, 32vh)', width: '100%' }}
                  />
                </label>
                <dl className="software-follow__meta">
                  <div>
                    <dt>Logged by</dt>
                    <dd>{actorName}</dd>
                  </div>
                  <div>
                    <dt>Date &amp; time</dt>
                    <dd>{formatFollowUpWhen(new Date().toISOString())}</dd>
                  </div>
                </dl>
                <div className="software-follow__actions">
                  <button type="submit" className="btn btn-primary" disabled={saving || !canSaveFollowUp}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
              {followError ? <p className="software-toolbar__err">{followError}</p> : null}
              <div
                ref={followLogsRef}
                className="software-follow__logs"
                style={{
                  flex: '1 1 auto',
                  minHeight: 140,
                  overflowY: 'auto',
                }}
              >
                {followLoading && !visibleFollowUps.length ? (
                  <p className="text-muted text-sm software-empty">Loading follow-up logs…</p>
                ) : !visibleFollowUps.length ? (
                  <p className="text-muted text-sm software-empty">No follow-up logs yet.</p>
                ) : (
                  <ul className="software-follow__list">
                    {visibleFollowUps.map((item) => (
                      <li key={item.id}>
                        <div className="software-follow__item-top">
                          <strong>{dash(item.userName)}</strong>
                          <time dateTime={item.createdAt || undefined}>{formatFollowUpWhen(item.createdAt)}</time>
                        </div>
                        {item.channel ? (
                          <span className="software-follow__channel">{followUpChannelLabel(item.channel)}</span>
                        ) : null}
                        <p>{item.remarks}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : (
          <div className="software-shop-send-card">
          <section className="software-card">
            <dl>
              {hasShopFieldValue(softwareOrgLabel(shop.sourceAccount)) ? (
                <FieldRow label="Organisation" value={<OrgValue sourceAccount={shop.sourceAccount} />} />
              ) : null}
              {hasShopFieldValue(shop.shopId) ? <FieldRow label="Shop ID" value={shop.shopId} /> : null}
              {hasShopFieldValue(shop.name) ? <FieldRow label="Shop Name" value={dash(shop.name)} /> : null}
              {shopIsNewCustomer(shop) ? <FieldRow label="Customer" value={<NewCustomerMark shop={shop} />} /> : null}
              {hasShopFieldValue(shop.trainingScheduledAt) ? (
                <FieldRow
                  label="Training"
                  value={
                    isWeighvoxSource(shop.sourceAccount)
                      ? `${formatShopDateTime(shop.trainingScheduledAt, SOFTWARE_TZ_UAE)} UAE · ${formatShopDateTime(shop.trainingScheduledAt, SOFTWARE_TZ_INDIA)} India`
                      : formatShopDateTime(shop.trainingScheduledAt, SOFTWARE_TZ_INDIA)
                  }
                />
              ) : null}
              {hasShopFieldValue(shop.pocName) ? <FieldRow label="POC" value={shop.pocName} /> : null}
              {hasShopFieldValue(shop.ownerPhone) ? <FieldRow label="Owner mobile" value={shop.ownerPhone} /> : null}
              {hasShopFieldValue(shop.pocPhone) ? <FieldRow label="POC mobile" value={shop.pocPhone} /> : null}
              {hasShopFieldValue(shop.supportUsername) ? (
                <FieldRow label="User ID" value={<span className="software-user-id">{shop.supportUsername}</span>} />
              ) : null}
              {hasShopFieldValue(shop.supportPassword) ? (
                <FieldRow label="Password" value={shop.supportPassword} omitFromSend />
              ) : null}
              <FieldRow label="Link customer" value={<SoftwareCustomerPicker shop={shop} />} omitFromSend />
              {hasShopFieldValue(shop.subscription) ? (
                <FieldRow label="Subscription" value={dash(shop.subscription)} />
              ) : null}
              {generalExtraKeys.map((key) => (
                <FieldRow key={key} label={fieldLabel(key)} value={formatFieldValue(key, extraValue(shop, key))} />
              ))}
            </dl>
          </section>

          {showValidityCard ? (
          <section className="software-card">
            <h3>
              <Calendar size={15} />
              Validity &amp; Services
            </h3>
            <dl>
              {hasShopFieldValue(shop.expenseValidity) ? (
                <FieldRow label="Expense Validity" value={formatDmy(shop.expenseValidity)} />
              ) : null}
              {hasShopFieldValue(shop.imageSupport) ? (
                <FieldRow label="Image Support" value={formatDmy(shop.imageSupport)} />
              ) : null}
              {hasShopFieldValue(shop.kotValidity) ? (
                <FieldRow label="KOT Validity" value={formatDmy(shop.kotValidity)} />
              ) : null}
              {hasShopFieldValue(shop.kotLite) ? (
                <FieldRow label="KOT Lite" value={formatDmy(shop.kotLite)} />
              ) : null}
              {hasShopFieldValue(shop.smartScale) ? (
                <FieldRow label="Smart Scale" value={formatDmy(shop.smartScale)} />
              ) : null}
              {validityExtraKeys.map((key) => (
                <FieldRow key={key} label={fieldLabel(key)} value={formatDmy(extraValue(shop, key))} />
              ))}
            </dl>
          </section>
          ) : null}

          {showContactCard ? (
          <section className="software-card">
            <h3>
              <Box size={15} />
              Contact &amp; Billing
            </h3>
            <dl>
              {hasShopFieldValue(shop.phone) ? (
                <FieldRow label="Mobile Number" value={<SoftwarePhoneActions shop={shop} phone={shop.phone} compact={false} onPrefillSent={onPrefillSent} />} />
              ) : null}
              {hasShopFieldValue(shop.subscriptionEnd) ? (
                <FieldRow
                  label="Expiry Date"
                  value={<EndDateValue value={shop.subscriptionEnd} status={shop.status} />}
                />
              ) : null}
              {renewalQuote ? (
                <>
                  <FieldRow
                    label={renewalQuote.subscriptionLabel}
                    value={<span className="software-charge">{renewalQuote.subscriptionAmount}</span>}
                  />
                  {renewalQuote.smartScaleAmount ? (
                    <FieldRow label="Smart Scale" value={<span className="software-charge">{renewalQuote.smartScaleAmount}</span>} />
                  ) : null}
                  <FieldRow label="Total" value={<span className="software-charge">{renewalQuote.totalAmount}</span>} />
                </>
              ) : null}
              {hasShopFieldValue(shop.currency) ? <FieldRow label="Currency" value={dash(shop.currency)} /> : null}
              {contactExtraKeys.map((key) => (
                <FieldRow key={key} label={fieldLabel(key)} value={formatFieldValue(key, extraValue(shop, key))} />
              ))}
            </dl>
          </section>
          ) : null}

          {shop.users.length ? (
            <section className="software-card">
              <h3>
                <UserRound size={15} />
                Users
              </h3>
              {shop.users.map((user) => {
                const personName = [user.firstName, user.lastName].filter((part) => part && part !== '-').join(' ');
                return (
                  <dl key={String(user.userId || user.username)}>
                    <FieldRow
                      label="User ID"
                      value={<span className="software-user-id">{dash(user.username)}</span>}
                    />
                    {hasShopFieldValue(personName) ? <FieldRow label="Name" value={personName} /> : null}
                    {hasShopFieldValue(user.email) ? <FieldRow label="Email" value={user.email} /> : null}
                    {user.blocked ? <FieldRow label="Status" value="Blocked" /> : null}
                  </dl>
                );
              })}
            </section>
          ) : null}
          <div data-shop-staff>
            <TrainingLogList shop={shop} logs={trainings} loading={trainingLoading} />
          </div>
          </div>
          )}
          {fromWhatsApp ? (
            <div className="software-wa-send-host" aria-hidden="true">
              <ShopWhatsAppCard shop={shop} cardRef={shopCardRef} />
            </div>
          ) : null}
        </div>

        {voidError ? <p className="software-toolbar__err software-modal__void-err">{voidError}</p> : null}
        {shareError ? <p className="software-toolbar__err software-modal__void-err">{shareError}</p> : null}
        <footer className="software-modal__foot software-modal__foot--split">
          {shopIsNewCustomer(shop) ? (
            <button
              type="button"
              className="btn"
              disabled={trainingOver}
              onClick={() => {
                setTrainingOver(true);
                void completeSoftwareShopTraining(shop.id).catch(() => setTrainingOver(false));
              }}
            >
              {trainingOver ? 'Saving…' : 'Training over'}
            </button>
          ) : <span />}
          <div className="software-modal__foot-end">
            {canVoid ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={voiding}
                onClick={() => void voidShop()}
              >
                {voiding ? 'Voiding…' : 'Void'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={sharing}
              onClick={() => void (fromWhatsApp ? sendRateCard() : shareRateCard())}
              title={fromWhatsApp ? 'Send rate card to this WhatsApp chat' : 'Share rate card'}
            >
              {sharing ? (fromWhatsApp ? 'Sending…' : 'Sharing…') : (fromWhatsApp ? 'Send' : 'Share')}
            </button>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
        {scheduleOpen ? (
          <ScheduleTrainingSheet
            shop={shop}
            actorName={actorName}
            actorUid={actorUid}
            onClose={() => setScheduleOpen(false)}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export const SoftwarePage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [shops, setShops] = useState<SoftwareShop[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [dealerFilter, setDealerFilter] = useState<SoftwareDealerFilter>(DEFAULT_SOFTWARE_DEALER_FILTER);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [subscriptionFilter, setSubscriptionFilter] = useState('');
  const [endInFilter, setEndInFilter] = useState<SoftwareEndInFilter>('');
  const [expiredInFilter, setExpiredInFilter] = useState<SoftwareExpiredInFilter>('');
  const [informedFilter, setInformedFilter] = useState<SoftwareInformedFilter>('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [openMenuOnSelect, setOpenMenuOnSelect] = useState(false);
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTER_DRAFT);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [prefillSentAt, setPrefillSentAt] = useState<Record<string, string>>({});
  const autoSyncAttempted = useRef(false);
  const pendingShopQuery = useRef('');
  const [returnWaId, setReturnWaId] = useState('');
  const returnWaIdRef = useRef('');
  const shopsView = useMemo(
    () => shops.map((shop) => {
      const local = prefillSentAt[shop.id];
      if (!local) return shop;
      const remoteMs = shop.whatsappRenewalSentAt ? Date.parse(shop.whatsappRenewalSentAt) : Number.NaN;
      const localMs = Date.parse(local);
      if (Number.isFinite(remoteMs) && remoteMs >= localMs) return shop;
      return { ...shop, whatsappRenewalSentAt: local };
    }),
    [prefillSentAt, shops],
  );
  const dealerShops = useMemo(
    () => shopsView.filter((shop) => shopMatchesDealerFilter(shop, dealerFilter)),
    [dealerFilter, shopsView],
  );
  const selected = selectedId == null ? null : shopsView.find((shop) => shop.id === selectedId) ?? null;
  const subscriptions = useMemo(
    () => sortSoftwareSubscriptions(uniqueSoftwareSubscriptions(dealerShops)),
    [dealerShops],
  );

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const counts = useMemo(() => {
    let active = 0;
    let expiring = 0;
    let expired = 0;
    let all = 0;
    for (const shop of dealerShops) {
      if (shopIsVoided(shop)) continue;
      all += 1;
      if (shop.status === 'ACTIVE') active += 1;
      else if (shop.status === 'EXPIRING SOON') expiring += 1;
      else if (shop.status === 'EXPIRED') expired += 1;
    }
    return { all, active, expiring, expired };
  }, [dealerShops]);

  useEffect(() => {
    const unsubShops = subscribeSoftwareShops(
      (rows) => {
        setShops(rows);
        setLoading(false);
      },
      (message) => {
        setError(message);
        setLoading(false);
      },
    );
    return () => {
      unsubShops();
    };
  }, []);

  const refresh = useCallback(async () => {
    setSyncing(true);
    setError('');
    try {
      await syncSanoftShops('yesweigh');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh shops.');
    } finally {
      setSyncing(false);
    }
  }, [dealerFilter]);

  useEffect(() => {
    if (loading || autoSyncAttempted.current || shops.length > 0) return;
    autoSyncAttempted.current = true;
    void refresh();
  }, [loading, refresh, shops.length]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dealerShops
      .filter((shop) => {
        if (!shopMatchesStatusFilter(shop, statusFilter)) return false;
        if (subscriptionFilter && shop.subscription !== subscriptionFilter) return false;
        if (!shopMatchesEndIn(shop, endInFilter)) return false;
        if (!shopMatchesExpiredIn(shop, expiredInFilter)) return false;
        if (!shopMatchesInformed(shop, informedFilter)) return false;
        if (q && !shopSearchHaystack(shop).includes(q)) return false;
        return true;
      })
      .sort(compareSoftwareShopsByIdDesc);
  }, [dealerShops, endInFilter, expiredInFilter, informedFilter, search, statusFilter, subscriptionFilter]);

  const tileCount = (id: StatusFilter) => {
    if (id === 'ACTIVE') return counts.active;
    if (id === 'EXPIRING SOON') return counts.expiring;
    if (id === 'EXPIRED') return counts.expired;
    return counts.all;
  };

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const paged = visible.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const pageStart = visible.length === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const pageEnd = currentPage * PAGE_SIZE + paged.length;
  const shopCountLabel = pageCount > 1
    ? `${pageStart}–${pageEnd} of ${visible.length}`
    : `${visible.length} ${visible.length === 1 ? 'shop' : 'shops'}`;

  const headerLead = useMemo(
    () => (
      <div className="customers-top-lead">
        <label className="customers-top-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            placeholder="Search shops…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            aria-label="Search shops"
          />
        </label>
      </div>
    ),
    [search],
  );

  useEffect(() => {
    const shop = searchParams.get('shop')?.trim();
    const q = searchParams.get('q')?.trim();
    const wa = String(searchParams.get('wa') || '').replace(/\D/g, '');
    if (wa && wa !== returnWaIdRef.current) {
      returnWaIdRef.current = wa;
      setReturnWaId(wa);
    }
    if (!shop && !q) return;
    setStatusFilter('ALL');
    setPage(0);
    if (q) {
      setSearch(q);
      pendingShopQuery.current = q;
    }
    if (shop) setSelectedId(shop);
    setSearchParams(wa ? { wa } : {}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const q = pendingShopQuery.current.trim();
    if (!q || !shopsView.length) return;
    const shopId = Number(q);
    const match = Number.isFinite(shopId) && shopId
      ? shopsView.find((shop) => shop.shopId === shopId)
      : shopsView.find((shop) => shopSearchHaystack(shop).includes(q.toLowerCase()));
    if (!match) return;
    pendingShopQuery.current = '';
    setSelectedId(match.id);
  }, [shopsView]);

  const closeFilter = useCallback(() => setFilterOpen(false), []);
  const toggleFilter = useCallback(() => {
    setFilterOpen((open) => {
      if (open) return false;
      setDraft({
        dealer: dealerFilter,
        status: statusFilter,
        subscription: subscriptionFilter,
        endIn: endInFilter,
        expiredIn: expiredInFilter,
        informed: informedFilter,
      });
      return true;
    });
  }, [dealerFilter, endInFilter, expiredInFilter, informedFilter, statusFilter, subscriptionFilter]);
  const applyFilters = useCallback(() => {
    const nextDealerShops = shopsView.filter((shop) => shopMatchesDealerFilter(shop, draft.dealer));
    const nextSubscription = nextDealerShops.some((shop) => shop.subscription === draft.subscription)
      ? draft.subscription
      : '';
    setDealerFilter(draft.dealer);
    setStatusFilter(draft.status);
    setSubscriptionFilter(nextSubscription);
    setEndInFilter(draft.endIn);
    setExpiredInFilter(draft.expiredIn);
    setInformedFilter(draft.informed);
    setPage(0);
    setFilterOpen(false);
  }, [draft, shopsView]);
  const clearAllFilters = useCallback(() => {
    setDraft(EMPTY_FILTER_DRAFT);
    setDealerFilter(EMPTY_FILTER_DRAFT.dealer);
    setStatusFilter(EMPTY_FILTER_DRAFT.status);
    setSubscriptionFilter(EMPTY_FILTER_DRAFT.subscription);
    setEndInFilter(EMPTY_FILTER_DRAFT.endIn);
    setExpiredInFilter(EMPTY_FILTER_DRAFT.expiredIn);
    setInformedFilter(EMPTY_FILTER_DRAFT.informed);
    setPage(0);
  }, []);
  const hasDraftFilters = draft.dealer !== EMPTY_FILTER_DRAFT.dealer
    || draft.status !== EMPTY_FILTER_DRAFT.status
    || draft.subscription !== EMPTY_FILTER_DRAFT.subscription
    || draft.endIn !== EMPTY_FILTER_DRAFT.endIn
    || draft.expiredIn !== EMPTY_FILTER_DRAFT.expiredIn
    || draft.informed !== EMPTY_FILTER_DRAFT.informed;
  const canClearAll = hasDraftFilters
    || dealerFilter !== EMPTY_FILTER_DRAFT.dealer
    || statusFilter !== EMPTY_FILTER_DRAFT.status
    || subscriptionFilter !== EMPTY_FILTER_DRAFT.subscription
    || endInFilter !== EMPTY_FILTER_DRAFT.endIn
    || expiredInFilter !== EMPTY_FILTER_DRAFT.expiredIn
    || informedFilter !== EMPTY_FILTER_DRAFT.informed;
  const hasActiveFilters = dealerFilter !== EMPTY_FILTER_DRAFT.dealer
    || statusFilter !== EMPTY_FILTER_DRAFT.status
    || subscriptionFilter !== EMPTY_FILTER_DRAFT.subscription
    || endInFilter !== EMPTY_FILTER_DRAFT.endIn
    || expiredInFilter !== EMPTY_FILTER_DRAFT.expiredIn
    || informedFilter !== EMPTY_FILTER_DRAFT.informed
    || search.trim() !== '';

  const headerActions = useMemo(
    () => (
      <div className="catalog-header-actions">
        <button
          type="button"
          className={`catalog-header-filter-btn${syncing ? ' is-syncing' : ''}`}
          onClick={() => void refresh()}
          disabled={syncing}
          aria-label="Refresh from Sanoft"
          title="Refresh from Sanoft"
        >
          <RefreshCw size={20} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          className={[
            'catalog-header-filter-btn',
            filterOpen ? 'catalog-header-filter-btn--open' : '',
            hasActiveFilters ? 'catalog-header-filter-btn--active' : '',
          ].filter(Boolean).join(' ')}
          onClick={toggleFilter}
          aria-expanded={filterOpen}
          aria-haspopup="dialog"
          aria-label="Open filters"
          title="Filter"
        >
          <SlidersHorizontal size={20} strokeWidth={2.25} />
        </button>
      </div>
    ),
    [filterOpen, hasActiveFilters, refresh, syncing, toggleFilter],
  );

  const leaveToWhatsApp = useCallback(() => {
    if (!returnWaId) return;
    navigate(whatsappInboxChatPath(returnWaId));
  }, [navigate, returnWaId]);

  const closeShop = useCallback(() => {
    setSelectedId(null);
    setOpenMenuOnSelect(false);
    if (returnWaId) {
      navigate(whatsappInboxChatPath(returnWaId));
    }
  }, [navigate, returnWaId]);

  const openShop = useCallback((shopDocId: string) => {
    setSelectedId(shopDocId);
  }, []);

  const recordPrefillSent = useCallback((shopDocId: string) => {
    setPrefillSentAt((current) => ({ ...current, [shopDocId]: new Date().toISOString() }));
  }, []);

  useCatalogPageHeader({
    title: '',
    mobileCompactHeader: isMobile,
    showBack: Boolean(returnWaId),
    onBack: returnWaId ? leaveToWhatsApp : null,
  });
  usePageHeaderSlot(headerLead, isMobile);
  usePageHeaderTitleMeta(headerLead, !isMobile);
  useTopBarAction(headerActions);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (filterOpen) closeFilter();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeFilter, filterOpen]);

  return (
    <div className={`page-content fade-in software-page${isMobile ? ' software-page--mobile' : ''}`}>
      {filterOpen ? createPortal(
        <>
          <button
            type="button"
            className="org-filter-backdrop"
            aria-label="Close filters"
            onClick={closeFilter}
          />
          <section className="org-filter-panel glass" aria-label="Software filters">
            <div className="org-filter-panel__head">
              <h2>Filter</h2>
              <button type="button" className="org-filter-panel__close" onClick={closeFilter} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <span className="org-filter-panel__label">Informed</span>
            <select
              className="input-field"
              value={draft.informed}
              onChange={(event) => setDraft((current) => ({
                ...current,
                informed: event.target.value as SoftwareInformedFilter,
              }))}
              aria-label="Informed"
            >
              {SOFTWARE_INFORMED_OPTIONS.map((option) => (
                <option key={option.id || 'all'} value={option.id}>{option.label}</option>
              ))}
            </select>
            <span className="org-filter-panel__label">Status</span>
            <select
              className="input-field"
              value={draft.status}
              onChange={(event) => setDraft((current) => ({
                ...current,
                status: event.target.value as StatusFilter,
              }))}
              aria-label="Status"
            >
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <span className="org-filter-panel__label">End in</span>
            <select
              className="input-field"
              value={draft.endIn}
              onChange={(event) => setDraft((current) => ({
                ...current,
                endIn: event.target.value as SoftwareEndInFilter,
              }))}
              aria-label="End in"
            >
              {SOFTWARE_END_IN_OPTIONS.map((option) => (
                <option key={option.id || 'all'} value={option.id}>{option.label}</option>
              ))}
            </select>
            <span className="org-filter-panel__label">Expired in</span>
            <select
              className="input-field"
              value={draft.expiredIn}
              onChange={(event) => setDraft((current) => ({
                ...current,
                expiredIn: event.target.value as SoftwareExpiredInFilter,
              }))}
              aria-label="Expired in"
            >
              {SOFTWARE_EXPIRED_IN_OPTIONS.map((option) => (
                <option key={option.id || 'all'} value={option.id}>{option.label}</option>
              ))}
            </select>
            <span className="org-filter-panel__label">Subscription</span>
            <select
              className="input-field"
              value={draft.subscription}
              onChange={(event) => setDraft((current) => ({ ...current, subscription: event.target.value }))}
              aria-label="Subscription"
            >
              <option value="">All subscriptions</option>
              {subscriptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <div className="org-filter-panel__footer">
              <button type="button" className="org-filter-panel__apply" onClick={applyFilters}>
                Apply
              </button>
              <button
                type="button"
                className="org-filter-panel__clear"
                onClick={clearAllFilters}
                disabled={!canClearAll}
              >
                Clear all
              </button>
            </div>
          </section>
        </>,
        document.body,
      ) : null}
      <div className="stat-grid stat-grid--wide software-tiles" role="group" aria-label="Filter shops by status">
        {STATUS_TILES.map((tile) => {
          const Icon = tile.icon;
          const selectedTile = statusFilter === tile.id;
          return (
            <button
              key={tile.id}
              type="button"
              className={`stat-card glass software-tile software-tile--${tile.tone}${selectedTile ? ' is-selected' : ''}`}
              onClick={() => {
                setStatusFilter(tile.id);
                setPage(0);
              }}
              aria-pressed={selectedTile}
            >
              <div className={`stat-icon software-tile__icon software-tile__icon--${tile.tone}`}>
                <Icon size={isMobile ? 15 : 22} strokeWidth={2.2} />
              </div>
              <div className="stat-content">
                <h3>{tile.label}</h3>
                <p className="stat-value">{tileCount(tile.id)}</p>
              </div>
            </button>
          );
        })}
      </div>

      <section className={`panel glass software-panel${isMobile ? ' software-panel--mobile' : ''}`}>
        {error ? (
          <div className="software-toolbar">
            <p className="software-toolbar__err">{error}</p>
          </div>
        ) : null}

        <div className="software-table-wrap">
          {loading ? (
            <p className="text-muted text-sm software-empty">
              {syncing ? 'Refreshing shops from Sanoft…' : 'Loading shops…'}
            </p>
          ) : !dealerShops.length ? (
            <p className="text-muted text-sm software-empty">
              {dealerFilter === 'yesweigh'
                ? 'No Yesweigh shops yet.'
                : dealerFilter === 'weighvox'
                  ? 'No Weighvox shops yet. Use refresh to sync from Sanoft.'
                  : 'No software licenses yet. Use refresh to sync from Sanoft.'}
            </p>
          ) : !visible.length ? (
            <p className="text-muted text-sm software-empty">
              {search.trim() || subscriptionFilter || endInFilter || expiredInFilter || informedFilter
                ? 'No shops match these filters.'
                : 'No shops in this status.'}
            </p>
          ) : isMobile ? (
            <ul className="software-cards">
              {paged.map((shop) => (
                <li key={shop.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    className={['software-shop-card', selectedId === shop.id ? 'is-selected' : '', shopListTone(shop)].filter(Boolean).join(' ')}
                    onClick={() => openShop(shop.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openShop(shop.id);
                      }
                    }}
                    aria-label={`Open details for ${shop.name || shop.shopId}`}
                  >
                    {shopStamp(shop)}
                    <div className="software-shop-card__top">
                      <span className="software-row__id">{shop.shopId}</span>
                      <span className="software-shop-card__marks">
                        <FollowUpChannelMarks shop={shop} />
                        <NewCustomerMark shop={shop} />
                        <InformedMark shop={shop} />
                        <MenuUploadedMark shop={shop} />
                        <span className={statusClass(shop.status)}>{shop.status}</span>
                      </span>
                    </div>
                    <p className="software-shop-card__name">{dash(shop.name)}</p>
                    <dl className="software-shop-card__meta">
                      <div>
                        <dt>Organisation</dt>
                        <dd><OrgValue sourceAccount={shop.sourceAccount} /></dd>
                      </div>
                      <div className="software-shop-card__phone">
                        <dt>Phone</dt>
                        <dd><SoftwarePhoneActions shop={shop} phone={shop.phone} onPrefillSent={recordPrefillSent} /></dd>
                      </div>
                      <div>
                        <dt>Subscription</dt>
                        <dd>{dash(shop.subscription)}</dd>
                      </div>
                      <div>
                        <dt>Plan status</dt>
                        <dd>{dash(shopPlanStatus(shop))}</dd>
                      </div>
                      <div>
                        <dt>Renewal charges</dt>
                        <dd><RenewalChargeValue shop={shop} /></dd>
                      </div>
                      <div>
                        <dt>End date</dt>
                        <dd><EndDateValue value={shop.subscriptionEnd} status={shop.status} /></dd>
                      </div>
                    </dl>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <table className="data-table software-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Shop name</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Subscription</th>
                  <th scope="col">Plan status</th>
                  <th scope="col">Renewal charges</th>
                  <th scope="col">Status</th>
                  <th scope="col">End date</th>
                  <th scope="col">Organisation</th>
                  <th scope="col" className="software-row__details">Details</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((shop) => (
                  <tr
                    key={shop.id}
                    className={[
                      selectedId === shop.id ? 'is-selected' : '',
                      shopListTone(shop),
                    ].filter(Boolean).join(' ')}
                    tabIndex={0}
                    aria-label={`Open details for ${shop.name || shop.shopId}`}
                    onClick={() => openShop(shop.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openShop(shop.id);
                      }
                    }}
                  >
                    <td className="software-row__id">{shop.shopId}</td>
                    <td className="software-row__name">
                      <span className="software-row__name-wrap">
                        <span className="software-row__name-text">{dash(shop.name)}</span>
                        {shopStamp(shop, true)}
                        <NewCustomerMark shop={shop} />
                        <InformedMark shop={shop} />
                      </span>
                    </td>
                    <td className="software-row__phone">
                      <SoftwarePhoneActions shop={shop} phone={shop.phone} onPrefillSent={recordPrefillSent} />
                    </td>
                    <td className="software-row__sub">{dash(shop.subscription)}</td>
                    <td className="software-row__plan">{dash(shopPlanStatus(shop))}</td>
                    <td className="software-row__charge">
                      <RenewalChargeValue shop={shop} />
                    </td>
                    <td className="software-row__status">
                      <span className={statusClass(shop.status)}>{shop.status}</span>
                    </td>
                    <td className="software-row__end">
                      <EndDateValue value={shop.subscriptionEnd} status={shop.status} />
                    </td>
                    <td className="software-row__org">
                      <span className="software-row__org-wrap">
                        <OrgValue sourceAccount={shop.sourceAccount} />
                        <MenuUploadedMark shop={shop} />
                        <FollowUpChannelMarks shop={shop} />
                      </span>
                    </td>
                    <td className="software-row__details">
                      <button
                        type="button"
                        className="software-details-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          openShop(shop.id);
                        }}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && visible.length > 0 ? (
          <nav className="software-pager" aria-label="Shop list pages">
            {pageCount > 1 ? (
              <button
                type="button"
                className="software-pager__btn"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage <= 0}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
            ) : null}
            {pageCount > 1 ? (
              <div className="software-pager__pages">
                {pageItems(currentPage, pageCount).map((item, index) =>
                  item === 'gap' ? (
                    <span key={`gap-${index}`} className="software-pager__gap" aria-hidden>
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      className={`software-pager__num${item === currentPage ? ' is-current' : ''}`}
                      onClick={() => setPage(item)}
                      aria-label={`Page ${item + 1}`}
                      aria-current={item === currentPage ? 'page' : undefined}
                    >
                      {item + 1}
                    </button>
                  ),
                )}
              </div>
            ) : null}
            <span className="software-pager__count">{shopCountLabel}</span>
            {pageCount > 1 ? (
              <span className="software-pager__compact">
                {currentPage + 1} / {pageCount}
              </span>
            ) : null}
            {pageCount > 1 ? (
              <button
                type="button"
                className="software-pager__btn"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>
            ) : null}
          </nav>
        ) : null}
      </section>

      {selected ? (
        <SoftwareDetailsModal
          shop={selected}
          initialMenuOpen={openMenuOnSelect}
          shareTarget={returnWaId ? { waId: returnWaId } : null}
          onClose={closeShop}
          onPrefillSent={recordPrefillSent}
        />
      ) : null}
    </div>
  );
};
