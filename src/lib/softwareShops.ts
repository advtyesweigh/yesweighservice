import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, storage, app } from '../firebase';
import { DISPLAY_CACHE_KEYS, displayCacheGet, displayCacheSet } from './displayCache';
import { asDate, asRecord } from './firestoreValues';
import { callerWhatsAppHref, isLikelyWhatsAppNumber } from './softwarePhone';
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
  ExtractShopMenuResult,
  SaveShopMenuResult,
  ShopMenu,
  ShopMenuItem,
  SoftwareShopSyncMeta,
  SoftwareShopSyncResult,
  SoftwareShopUser,
} from '../types/software-shop';

export const SOFTWARE_SHOPS_COLLECTION = 'softwareShops';
export const SOFTWARE_SHOP_FOLLOW_UPS = 'followUps';
export const SOFTWARE_SHOP_TRAININGS = 'trainings';
export const SHOP_MENUS_COLLECTION = 'shopMenus';
export const SHOP_MENU_STORAGE_PREFIX = 'shop-menus';
export const SHOP_MENU_MAX_BYTES = 12 * 1024 * 1024;
export const SOFTWARE_SHOP_META_COLLECTION = 'softwareShopMeta';
export const SOFTWARE_SHOP_META_ID = 'sanoft';
export const DEFAULT_SOFTWARE_SOURCE_ACCOUNT = 'yesweigh';
export const DEFAULT_SOFTWARE_DEALER_FILTER: SoftwareDealerFilter = 'yesweigh';
export const SOFTWARE_DEALER_FILTERS: Array<{
  id: SoftwareDealerFilter;
  label: string;
  sourceAccount: string | null;
}> = [
  { id: 'all', label: 'All', sourceAccount: null },
  { id: 'meezan', label: 'Meezan', sourceAccount: 'meezan' },
  { id: 'weighvox', label: 'Weighvox', sourceAccount: 'weighvox' },
  { id: 'yesweigh', label: 'Yesweigh', sourceAccount: 'yesweigh' },
];
export const WHATSAPP_RENEWAL_COOLDOWN_DAYS = 350;
const WHATSAPP_RENEWAL_COOLDOWN_MS = WHATSAPP_RENEWAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Matches dealer portal Renewals: Days Back = 0, Days Forward = 14. */
export const SANOFT_RENEWAL_DAYS_BACK = 0;
export const SANOFT_RENEWAL_DAYS_FORWARD = 14;

/** Annual renewal charges in INR. Keys are lowercase plan names — add `standard 18000` / `standard 30000` when priced. */
export const SOFTWARE_RENEWAL_CHARGES_INR: Record<string, number> = {
  'sanoft lite': 4500,
  'sanoft pro': 5500,
  'sanoft elite': 7500,
  'standard': 2500,
  'premium': 3500,
  'double standard': 5000,
};

/** Longer Standard variants so they do not inherit the base Standard price. */
const STANDARD_SALES_PLAN_KEYS = ['standard 18000', 'standard 30000'] as const;

/** Weighvox + 971 mobile: Sanoft plans billed in AED. */
export const SOFTWARE_RENEWAL_CHARGES_AED: Record<string, number> = {
  'sanoft lite': 400,
  'sanoft pro': 450,
  'sanoft elite': 500,
  lite: 400,
  pro: 450,
  elite: 500,
  standard: 400,
  premium: 450,
};

export function normalizeSoftwareSubscription(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function phoneStartsWith971(phone: string | null | undefined): boolean {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.startsWith('971') || digits.startsWith('00971');
}

export function shopUsesAedRenewal(shop: { sourceAccount?: string; phone?: string }): boolean {
  const account = String(shop.sourceAccount || '').trim();
  const weighvox = account === 'weighvox' || account === 'weighvox-dubai';
  return weighvox && phoneStartsWith971(shop.phone);
}

function chargeForSubscription(subscription: string, table: Record<string, number>): number | null {
  const key = normalizeSoftwareSubscription(subscription);
  if (!key) return null;
  for (const variant of STANDARD_SALES_PLAN_KEYS) {
    if (key === variant || key.startsWith(`${variant} `)) {
      const amount = table[variant];
      return amount == null ? null : amount;
    }
  }
  const amount = table[key];
  return amount == null ? null : amount;
}

export function softwareRenewalChargeInr(subscription: string): number | null {
  return chargeForSubscription(subscription, SOFTWARE_RENEWAL_CHARGES_INR);
}

export type SoftwareRenewalCharge = {
  amount: number;
  currency: 'INR' | 'AED';
};

export function softwareRenewalCharge(shop: {
  subscription: string;
  sourceAccount?: string;
  phone?: string;
}): SoftwareRenewalCharge | null {
  if (shopUsesAedRenewal(shop)) {
    const amount = chargeForSubscription(shop.subscription, SOFTWARE_RENEWAL_CHARGES_AED);
    return amount == null ? null : { amount, currency: 'AED' };
  }
  const amount = softwareRenewalChargeInr(shop.subscription);
  return amount == null ? null : { amount, currency: 'INR' };
}

/** Added only when quoting or calling. Never written back onto the shop. */
export const SMART_SCALE_CALL_EXTRA_INR = 1500;

type ShopQuoteFields = {
  subscription: string;
  sourceAccount?: string;
  phone?: string;
  currency?: string;
  smartScale?: string;
  extras?: Record<string, string>;
};

function shopMoneyText(shop: ShopQuoteFields): string {
  return [
    shop.currency,
    shop.extras?.currency,
    shop.extras?.currencyName,
    shop.extras?.currencySymbol,
  ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean).join(' ');
}

/** AED from the shop's own currency or a Weighvox organisation. Yesweigh is not AED by itself. */
export function shopIsAedCustomer(shop: ShopQuoteFields): boolean {
  const text = shopMoneyText(shop);
  if (/\binr\b|\brupee\b|₹/.test(text)) return false;
  if (/\baed\b|\bdirham\b|د\.إ/.test(text)) return true;
  return isWeighvoxSource(shop.sourceAccount);
}

export function shopHasSmartScale(shop: { smartScale?: string }): boolean {
  const text = String(shop.smartScale ?? '').trim();
  return Boolean(text) && text !== '—' && text !== '-';
}

/** 1500 INR when the shop has Smart Scale and is not an AED customer. */
export function smartScaleCallExtraInr(shop: ShopQuoteFields): number {
  if (!shopHasSmartScale(shop) || shopIsAedCustomer(shop)) return 0;
  const base = softwareRenewalCharge(shop);
  if (!base || base.currency === 'AED') return 0;
  return SMART_SCALE_CALL_EXTRA_INR;
}

/** Base renewal plus the Smart Scale call extra. Does not change the stored charge. */
export function softwareCallRenewalCharge(shop: ShopQuoteFields): SoftwareRenewalCharge | null {
  const base = softwareRenewalCharge(shop);
  if (!base) return null;
  return { amount: base.amount + smartScaleCallExtraInr(shop), currency: base.currency };
}

function formatRenewalAmount(charge: SoftwareRenewalCharge): string {
  const amount = charge.amount.toLocaleString(charge.currency === 'AED' ? 'en-AE' : 'en-IN', {
    maximumFractionDigits: 0,
  });
  return charge.currency === 'AED' ? `${amount} AED` : `₹${amount}`;
}

export function formatSoftwareRenewalCharge(shop: ShopQuoteFields): string {
  const charge = softwareCallRenewalCharge(shop);
  if (!charge) return '—';
  return formatRenewalAmount(charge);
}

export function formatSmartScaleCallExtra(shop: ShopQuoteFields): string {
  const extra = smartScaleCallExtraInr(shop);
  if (!extra) return '';
  return formatRenewalAmount({ amount: extra, currency: 'INR' });
}

export type ShopRenewalQuote = {
  subscriptionLabel: string;
  subscriptionAmount: string;
  smartScaleAmount: string;
  totalAmount: string;
};

/** Display quote only. The shop record keeps the base renewal. */
export function shopRenewalQuote(shop: ShopQuoteFields): ShopRenewalQuote | null {
  const base = softwareRenewalCharge(shop);
  const total = softwareCallRenewalCharge(shop);
  if (!base || !total) return null;
  return {
    subscriptionLabel: String(shop.subscription ?? '').trim() || 'Subscription',
    subscriptionAmount: formatRenewalAmount(base),
    smartScaleAmount: formatSmartScaleCallExtra(shop),
    totalAmount: formatRenewalAmount(total),
  };
}

function asString(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ymd(value: unknown): string {
  const text = asString(value);
  if (!text) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (match) return match[1];
  const date = asDate(value);
  return date ? date.toISOString().slice(0, 10) : text;
}

const INSTALL_DATE_KEYS = [
  'install_date',
  'installDate',
  'installation_date',
  'activation_date',
  'activationDate',
  'activated_at',
  'activatedAt',
  'created_date',
  'createdDate',
  'created_at',
  'createdAt',
  'date_created',
  'dateCreated',
  'shop_created',
  'shopCreated',
  'registered_date',
  'registeredDate',
  'start_date',
  'startDate',
  'subscription_start_date',
  'subscriptionStartDate',
  'subscription_start',
  'subscriptionStart',
  'created',
] as const;

function asYmdDate(value: unknown): string {
  const text = ymd(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

export function pickSanoftInstallationDate(
  row: Record<string, unknown> = {},
  extras: Record<string, string> = {},
): string {
  for (const key of INSTALL_DATE_KEYS) {
    const text = asYmdDate(row[key]) || asYmdDate(extras[key]);
    if (text) return text;
  }
  return '';
}

export function shopInstallationDate(
  shop: Pick<SoftwareShop, 'installationDate' | 'sanoftInstallationDate'>,
): string {
  return asYmdDate(shop.installationDate) || asYmdDate(shop.sanoftInstallationDate);
}

export function softwareCustomerHref(_orgKey: string, customerId: string): string {
  const id = asString(customerId);
  if (!id) return '/super-admin/dealers';
  return `/super-admin/dealers?id=${encodeURIComponent(id)}`;
}

function istTodayYmd(now = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDaysYmd(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function ymdUtcMs(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Calendar days from today (IST) to the subscription end date. */
export function softwareEndDaysFromToday(end: string, now = new Date()): number | null {
  const date = asYmdDate(end);
  if (!date) return null;
  return Math.round((ymdUtcMs(date) - ymdUtcMs(istTodayYmd(now))) / 86_400_000);
}

/** e.g. `7 days`, `1 day`, `today`, `12 days ago`. */
export function formatSoftwareEndDays(end: string, now = new Date()): string {
  const days = softwareEndDaysFromToday(end, now);
  if (days == null) return '';
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days === -1) return '1 day ago';
  if (days > 0) return `${days} days`;
  return `${Math.abs(days)} days ago`;
}

export function sanoftRenewalWindow(now = new Date()): { from: string; to: string } {
  const today = istTodayYmd(now);
  return {
    from: addDaysYmd(today, -SANOFT_RENEWAL_DAYS_BACK),
    to: addDaysYmd(today, SANOFT_RENEWAL_DAYS_FORWARD),
  };
}

function flagTrue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const text = asString(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function mentionsCancelled(value: unknown): boolean {
  return /\bcancell?ed\b/.test(asString(value).toLowerCase());
}

export function shopLooksCancelled(
  row: Record<string, unknown> = {},
  extras: Record<string, string> = {},
): boolean {
  if (
    flagTrue(row.cancelled)
    || flagTrue(row.isCancelled)
    || flagTrue(row.is_cancelled)
    || flagTrue(row.isCanceled)
    || flagTrue(row.is_canceled)
    || flagTrue(row.canceled)
  ) return true;
  if (
    flagTrue(extras.cancelled)
    || flagTrue(extras.isCancelled)
    || flagTrue(extras.isCanceled)
    || flagTrue(extras.is_cancelled)
  ) return true;
  return [
    row.rawStatus,
    row.status,
    row.planStatus,
    row.plan_status,
    extras.planStatus,
    extras.status,
    extras.rawStatus,
  ].some(mentionsCancelled);
}

/** Matches Sanoft Renewals: end date from today through +14 days (not already expired). */
export function computeShopStatus(
  subscriptionEnd: string,
  now = new Date(),
  cancelled = false,
  voided = false,
): SoftwareShopStatus {
  if (voided) return 'VOIDED';
  if (cancelled) return 'CANCELLED';
  const end = ymd(subscriptionEnd);
  if (!end) return 'EXPIRED';
  const { from, to } = sanoftRenewalWindow(now);
  if (end < from) return 'EXPIRED';
  if (end <= to) return 'EXPIRING SOON';
  return 'ACTIVE';
}

export function shopIsVoided(shop: Pick<SoftwareShop, 'voided' | 'status'>): boolean {
  return shop.voided === true || shop.status === 'VOIDED';
}

export type SoftwareShopStatusFilter = 'ALL' | 'NEW' | SoftwareShopStatus;

/** Voided shops are only in Void — never All, New, Active, Expired, or Cancelled. */
export function shopMatchesStatusFilter(
  shop: SoftwareShop,
  statusFilter: SoftwareShopStatusFilter,
): boolean {
  const voided = shopIsVoided(shop);
  if (statusFilter === 'VOIDED') return voided;
  if (voided) return false;
  if (statusFilter === 'ALL') return true;
  if (statusFilter === 'NEW') return shopIsNewCustomer(shop);
  return shop.status === statusFilter;
}

export const SOFTWARE_END_IN_OPTIONS: Array<{ id: SoftwareEndInFilter; label: string }> = [
  { id: '', label: 'All' },
  { id: '7', label: 'Next 7 days' },
  { id: '15', label: 'Next 15 days' },
  { id: '30', label: 'Next 30 days' },
];

export const SOFTWARE_EXPIRED_IN_OPTIONS: Array<{ id: SoftwareExpiredInFilter; label: string }> = [
  { id: '', label: 'All' },
  { id: '7', label: 'Last 7 days' },
  { id: '15', label: 'Last 15 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: '365', label: 'Last 365 days' },
  { id: 'lifetime', label: 'Lifetime' },
];

export const SOFTWARE_INFORMED_OPTIONS: Array<{ id: SoftwareInformedFilter; label: string }> = [
  { id: '', label: 'All' },
  { id: 'informed', label: 'Informed' },
  { id: 'not-informed', label: 'Not informed' },
];

/** Still-active shops whose subscription ends today through +N days. */
export function shopMatchesEndIn(
  shop: Pick<SoftwareShop, 'status' | 'subscriptionEnd'>,
  endIn: SoftwareEndInFilter,
  now = new Date(),
): boolean {
  if (!endIn) return true;
  if (shop.status === 'CANCELLED' || shop.status === 'EXPIRED' || shop.status === 'VOIDED') return false;
  const end = ymd(shop.subscriptionEnd);
  if (!end) return false;
  const today = istTodayYmd(now);
  if (end < today) return false;
  return end <= addDaysYmd(today, Number(endIn));
}

/** Already-expired shops whose end date falls in the selected lookback. */
export function shopMatchesExpiredIn(
  shop: Pick<SoftwareShop, 'subscriptionEnd'>,
  expiredIn: SoftwareExpiredInFilter,
  now = new Date(),
): boolean {
  if (!expiredIn) return true;
  const end = ymd(shop.subscriptionEnd);
  const today = istTodayYmd(now);
  if (!end) return expiredIn === 'lifetime';
  if (end >= today) return false;
  if (expiredIn === 'lifetime') return true;
  return end >= addDaysYmd(today, -Number(expiredIn));
}

function named(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return asString(value);
  return asString(asRecord(value).name);
}

function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const namedValue = named(row[key]);
    if (namedValue && namedValue !== '[object Object]') return namedValue;
    const text = asString(row[key]);
    if (text && text !== '[object Object]') return text;
  }
  return '';
}

function asUserList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const row = asRecord(value);
  const keys = Object.keys(row);
  if (keys.length && keys.every((key) => /^\d+$/.test(key))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((key) => row[key]);
  }
  return [];
}

function asUsers(value: unknown): SoftwareShopUser[] {
  return asUserList(value)
    .map((row) => {
      const user = asRecord(row);
      const userId = user.userId ?? user.id;
      return {
        userId: typeof userId === 'number' ? userId : asString(userId),
        username: asString(user.username),
        firstName: asString(user.firstName || user.first_name),
        lastName: asString(user.lastName || user.last_name),
        email: asString(user.email),
        blocked: user.blocked === true || user.d_is_blocked === true,
      };
    })
    .filter((user) => user.userId || user.username || user.firstName);
}

function asExtras(value: unknown): Record<string, string> {
  const row = asRecord(value);
  const extras: Record<string, string> = {};
  for (const [key, item] of Object.entries(row)) {
    if (/token|password|secret|auth/i.test(key)) continue;
    const text = asString(item);
    if (text && text !== '[object Object]') extras[key] = text;
  }
  return extras;
}

const CORE_DOC_KEYS = new Set([
  'shopId',
  'id',
  'name',
  'shop_name',
  'shopName',
  'phone',
  'mobile_no',
  'mobileNo',
  'subscription',
  'status',
  'rawStatus',
  'cancelled',
  'voided',
  'cancelledAt',
  'subscriptionEnd',
  'subscription_end_date',
  'installationDate',
  'sanoftInstallationDate',
  'customerId',
  'customerName',
  'customerOrgKey',
  'dealer',
  'expenseValidity',
  'expense_validity',
  'imageSupport',
  'image_support_validity',
  'image_support',
  'kotValidity',
  'kot_validity',
  'kotLite',
  'kot_lite_validity',
  'smartScale',
  'smart_scale_validity',
  'currency',
  'salesBalance',
  'additional_sales_balance',
  'country',
  'users',
  'extras',
  'syncedAt',
  'whatsappRenewalSentAt',
  'sourceAccount',
  'hasFollowUp',
  'contactedAt',
  'lastFollowUpRemarks',
  'lastFollowUpChannel',
  'contactedViaCall',
  'contactedViaWhatsApp',
  'isNewCustomer',
  'trainingScheduledAt',
  'trainingScheduledByUid',
  'trainingScheduledByName',
  'trainingCompletedAt',
  'pocName',
  'pocPhone',
  'pocEmail',
  'ownerPhone',
  'supportUsername',
  'supportPassword',
  'trainingPoints',
  'menuUploaded',
  'menuUploadedAt',
]);

function leftoverExtras(row: Record<string, unknown>, extras: Record<string, string>): Record<string, string> {
  const merged = { ...extras };
  for (const [key, value] of Object.entries(row)) {
    if (CORE_DOC_KEYS.has(key) || /token|password|secret|auth/i.test(key)) continue;
    if (value == null || typeof value === 'object') continue;
    const text = ymd(value) || asString(value);
    if (!text || text === '[object Object]' || merged[key]) continue;
    merged[key] = text;
  }
  return merged;
}

function extraPick(extras: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const text = asString(extras[key]);
    if (text) return text;
  }
  return '';
}

export function softwareShopDocId(sourceAccount: string, shopId: number): string {
  return `${sourceAccount || DEFAULT_SOFTWARE_SOURCE_ACCOUNT}_${shopId}`;
}

export function softwareOrgLabel(sourceAccount: string | null | undefined): string {
  const key = asString(sourceAccount);
  if (key === 'weighvox-dubai' || key === 'weighvox') return 'Weighvox';
  if (key === 'yesweigh') return 'Yesweigh';
  if (key === 'bench-cloud') return 'Bench Cloud';
  return 'Meezan';
}

export type SoftwareOrgTone = 'meezan' | 'weighvox' | 'yesweigh' | 'benchcloud';

export function softwareOrgTone(sourceAccount: string | null | undefined): SoftwareOrgTone {
  const key = asString(sourceAccount);
  if (key === 'weighvox-dubai' || key === 'weighvox') return 'weighvox';
  if (key === 'yesweigh') return 'yesweigh';
  if (key === 'bench-cloud') return 'benchcloud';
  return 'meezan';
}

export function isWeighvoxSource(sourceAccount: string | null | undefined): boolean {
  return softwareOrgTone(sourceAccount) === 'weighvox';
}

export const SOFTWARE_TZ_INDIA = 'Asia/Kolkata';
export const SOFTWARE_TZ_UAE = 'Asia/Dubai';

function zoneDateTimeParts(value: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

export function instantToZoneParts(iso: string, timeZone: string): { date: string; time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  return zoneDateTimeParts(date, timeZone);
}

export function zonePartsToIso(date: string, time: string, timeZone: string): string {
  if (!date || !time) return '';
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return '';
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shown = zoneDateTimeParts(new Date(utc), timeZone);
  const shownUtc = Date.UTC(
    Number(shown.date.slice(0, 4)),
    Number(shown.date.slice(5, 7)) - 1,
    Number(shown.date.slice(8, 10)),
    Number(shown.time.slice(0, 2)),
    Number(shown.time.slice(3, 5)),
  );
  utc -= shownUtc - utc;
  return new Date(utc).toISOString();
}

export function formatShopDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function shopIsNewCustomer(shop: SoftwareShop): boolean {
  return shop.isNewCustomer === true;
}

export function defaultShopPoc(shop: SoftwareShop): {
  name: string;
  ownerPhone: string;
  pocPhone: string;
  username: string;
  password: string;
} {
  const user = shop.users[0];
  const userName = [user?.firstName, user?.lastName].filter((part) => part && part !== '-').join(' ').trim();
  return {
    name: shop.pocName || shop.customerName || userName,
    ownerPhone: shop.ownerPhone || shop.phone,
    pocPhone: shop.pocPhone,
    username: shop.supportUsername || user?.username || '',
    password: shop.supportPassword || DEFAULT_SANOFT_SHOP_PASSWORD,
  };
}

export function shopMatchesDealerFilter(shop: SoftwareShop, dealer: SoftwareDealerFilter): boolean {
  if (dealer === 'all') return true;
  if (dealer === 'weighvox') return shop.sourceAccount === 'weighvox' || shop.sourceAccount === 'weighvox-dubai';
  if (dealer === 'meezan') return shop.sourceAccount === 'meezan' || shop.sourceAccount === 'bench-cloud';
  if (dealer === 'yesweigh') return shop.sourceAccount === 'yesweigh';
  return shop.sourceAccount === dealer;
}

function asFollowUpChannel(value: unknown): SoftwareFollowUpChannel | '' {
  const channel = asString(value);
  return channel === 'call' || channel === 'whatsapp' ? channel : '';
}

function inferSourceAccount(docId: string, row: Record<string, unknown>): string {
  const tagged = asString(row.sourceAccount);
  if (tagged === 'weighvox-dubai' || tagged === 'weighvox') return 'weighvox';
  if (tagged) return tagged;
  if (docId.startsWith('weighvox-dubai_') || docId.startsWith('weighvox_')) return 'weighvox';
  if (docId.startsWith('yesweigh_')) return 'yesweigh';
  if (docId.startsWith('bench-cloud_')) return 'bench-cloud';
  if (docId.startsWith('meezan_')) return 'meezan';
  return DEFAULT_SOFTWARE_SOURCE_ACCOUNT;
}

export function asSoftwareShop(value: unknown, docId = ''): SoftwareShop | null {
  const row = asRecord(value);
  const shopId = asNumber(row.shopId ?? row.id);
  if (!shopId) return null;
  const extras = leftoverExtras(row, asExtras(row.extras));
  const subscriptionEnd = ymd(row.subscriptionEnd ?? row.subscription_end_date)
    || ymd(extraPick(extras, 'subscriptionEnd', 'subscription_end_date'));
  const sourceAccount = inferSourceAccount(docId, row);
  const voided = flagTrue(row.voided);
  const cancelled = shopLooksCancelled(row, extras);
  return {
    id: docId || softwareShopDocId(sourceAccount, shopId),
    shopId,
    sourceAccount,
    name: pickString(row, 'name', 'shop_name', 'shopName') || extraPick(extras, 'name', 'shopName', 'shop_name'),
    phone: pickString(row, 'phone', 'mobile_no', 'mobileNo') || extraPick(extras, 'phone', 'mobileNo', 'mobile_no'),
    subscription: named(row.subscription) || pickString(row, 'subscription') || extraPick(extras, 'subscription'),
    status: computeShopStatus(subscriptionEnd, new Date(), cancelled, voided),
    rawStatus: pickString(row, 'rawStatus', 'plan_status', 'planStatus'),
    cancelled,
    voided,
    cancelledAt: asDate(row.cancelledAt)?.toISOString() ?? (asString(row.cancelledAt) || null),
    subscriptionEnd,
    installationDate: asYmdDate(row.installationDate),
    sanoftInstallationDate: asYmdDate(row.sanoftInstallationDate)
      || pickSanoftInstallationDate(row, extras),
    customerId: pickString(row, 'customerId') || extraPick(extras, 'customerId'),
    customerName: pickString(row, 'customerName') || extraPick(extras, 'customerName'),
    customerOrgKey: pickString(row, 'customerOrgKey') || extraPick(extras, 'customerOrgKey'),
    dealer: named(row.dealer) || pickString(row, 'dealer') || extraPick(extras, 'dealer'),
    expenseValidity: ymd(row.expenseValidity ?? row.expense_validity)
      || ymd(extraPick(extras, 'expenseValidity', 'expense_validity')),
    imageSupport: ymd(row.imageSupport ?? row.image_support_validity ?? row.image_support)
      || ymd(extraPick(extras, 'imageSupport', 'image_support_validity', 'image_support')),
    kotValidity: ymd(row.kotValidity ?? row.kot_validity)
      || ymd(extraPick(extras, 'kotValidity', 'kot_validity')),
    kotLite: ymd(row.kotLite ?? row.kot_lite_validity)
      || ymd(extraPick(extras, 'kotLite', 'kot_lite_validity')),
    smartScale: ymd(row.smartScale ?? row.smart_scale_validity)
      || ymd(extraPick(extras, 'smartScale', 'smart_scale_validity')),
    currency: pickString(row, 'currency') || extraPick(extras, 'currency', 'currencySymbol'),
    salesBalance: asNumber(row.salesBalance ?? row.additional_sales_balance ?? extras.salesBalance),
    country: pickString(row, 'country') || extraPick(extras, 'country'),
    users: asUsers(row.users),
    extras,
    syncedAt: asDate(row.syncedAt)?.toISOString() ?? (asString(row.syncedAt) || null),
    whatsappRenewalSentAt: asDate(row.whatsappRenewalSentAt)?.toISOString() ?? null,
    hasFollowUp: row.hasFollowUp === true || Boolean(asString(row.lastFollowUpRemarks)),
    contactedAt: asDate(row.contactedAt)?.toISOString() ?? null,
    lastFollowUpRemarks: asString(row.lastFollowUpRemarks),
    lastFollowUpChannel: asFollowUpChannel(row.lastFollowUpChannel),
    contactedViaCall: row.contactedViaCall === true,
    contactedViaWhatsApp: row.contactedViaWhatsApp === true,
    isNewCustomer: row.isNewCustomer === true,
    trainingScheduledAt: asDate(row.trainingScheduledAt)?.toISOString() ?? asString(row.trainingScheduledAt),
    trainingScheduledByName: asString(row.trainingScheduledByName),
    trainingCompletedAt: asDate(row.trainingCompletedAt)?.toISOString() ?? asString(row.trainingCompletedAt),
    pocName: asString(row.pocName),
    pocPhone: asString(row.pocPhone),
    pocEmail: asString(row.pocEmail),
    ownerPhone: asString(row.ownerPhone),
    supportUsername: asString(row.supportUsername),
    supportPassword: asString(row.supportPassword),
    trainingPoints: asString(row.trainingPoints),
    menuUploaded: flagTrue(row.menuUploaded),
    menuUploadedAt: asDate(row.menuUploadedAt)?.toISOString() ?? (asString(row.menuUploadedAt) || null),
  };
}

const SOFTWARE_LOOKUP_ACCOUNTS = [
  DEFAULT_SOFTWARE_SOURCE_ACCOUNT,
  'meezan',
  'weighvox',
  'weighvox-dubai',
  'bench-cloud',
];

export async function lookupSoftwareShopById(shopId: number): Promise<SoftwareShop | null> {
  if (!shopId) return null;
  for (const account of SOFTWARE_LOOKUP_ACCOUNTS) {
    const snap = await getDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, softwareShopDocId(account, shopId)));
    if (!snap.exists()) continue;
    return asSoftwareShop(snap.data(), snap.id);
  }
  return null;
}

function nationalPhoneDigits(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function shopPhoneDigits(shop: SoftwareShop): string[] {
  return [shop.phone, shop.ownerPhone, shop.pocPhone]
    .map(nationalPhoneDigits)
    .filter((digits) => digits.length >= 8);
}

function preferYesweighShop(rows: SoftwareShop[]): SoftwareShop | null {
  if (!rows.length) return null;
  return rows.find((shop) => shop.sourceAccount === DEFAULT_SOFTWARE_SOURCE_ACCOUNT) || rows[0];
}

async function loadSoftwareShopsForLookup(): Promise<SoftwareShop[]> {
  if (memoryShops?.length) return memoryShops;
  const cached = await displayCacheGet<SoftwareShop[]>(DISPLAY_CACHE_KEYS.softwareShops);
  if (cached?.data?.length) {
    memoryShops = cached.data;
    return cached.data;
  }
  if (import.meta.env.DEV) {
    try {
      const rows = await loadYesweighShopsFromSanoft(false);
      if (rows.length) {
        commitSoftwareShopsCache(rows);
        return rows;
      }
    } catch {
      // Firestore / Sanoft fallback below
    }
  }
  try {
    const snap = await getDocs(collection(db, SOFTWARE_SHOPS_COLLECTION));
    const rows = shopsFromSnapshot(snap.docs);
    if (rows.length) commitSoftwareShopsCache(rows);
    return rows;
  } catch {
    return [];
  }
}

/** Exact shop id, then the same phone / user match Software search uses. */
export async function resolveSoftwareShopForRenewal(input: {
  shopId: number;
  phone?: string;
}): Promise<SoftwareShop | null> {
  const shopId = Number(input.shopId) || 0;
  if (shopId) {
    const exact = await lookupSoftwareShopById(shopId);
    if (exact) return exact;
  }
  const shops = await loadSoftwareShopsForLookup();
  if (!shops.length) return null;
  if (shopId) {
    const idMatch = shops.filter((shop) => shop.shopId === shopId);
    if (idMatch.length) return preferYesweighShop(idMatch);
  }
  const idText = shopId ? String(shopId) : '';
  if (idText.length >= 4) {
    const phoneIdMatch = shops.filter((shop) => shopPhoneDigits(shop).some((digits) => digits.includes(idText)));
    if (phoneIdMatch.length === 1) return phoneIdMatch[0];
    const yesweighPhone = phoneIdMatch.filter((shop) => shop.sourceAccount === DEFAULT_SOFTWARE_SOURCE_ACCOUNT);
    if (yesweighPhone.length === 1) return yesweighPhone[0];
    const userMatch = shops.filter((shop) => shop.users.some((user) => Number(user.userId) === shopId));
    if (userMatch.length === 1) return userMatch[0];
  }
  const wa = nationalPhoneDigits(input.phone);
  if (wa.length >= 10) {
    const byWa = shops.filter((shop) => shopPhoneDigits(shop).includes(wa));
    if (byWa.length) return preferYesweighShop(byWa);
  }
  return null;
}

export function shopLooksRestaurant(name: string): boolean {
  return /\b(restaurant|hotel|cafe|caf[eé]|kitchen|chicken|biryani|food|diner|dhaba|bakery|pizza|burger|grill|tandoor|canteen|mess|cloud kitchen)\b/i
    .test(asString(name));
}

export function shopIsContacted(shop: SoftwareShop): boolean {
  return Boolean(shop.lastFollowUpRemarks) || shop.hasFollowUp
    || shop.contactedViaCall || shop.contactedViaWhatsApp;
}

/** A saved follow-up (remarks + Save) marks the shop informed. */
export function shopIsInformed(shop: SoftwareShop): boolean {
  return shopIsContacted(shop);
}

export function shopMatchesInformed(
  shop: SoftwareShop,
  informed: SoftwareInformedFilter,
): boolean {
  if (!informed) return true;
  const informedShop = shopIsInformed(shop);
  return informed === 'informed' ? informedShop : !informedShop;
}

export function shopFollowUpChannels(shop: SoftwareShop): SoftwareFollowUpChannel[] {
  const channels: SoftwareFollowUpChannel[] = [];
  if (shop.contactedViaCall) channels.push('call');
  if (shop.contactedViaWhatsApp) channels.push('whatsapp');
  return channels;
}

export function asSoftwareFollowUp(value: unknown, id: string): SoftwareShopFollowUp | null {
  const row = asRecord(value);
  const remarks = asString(row.remarks);
  if (!remarks) return null;
  return {
    id,
    userId: asString(row.userId),
    userName: asString(row.userName),
    remarks,
    channel: asFollowUpChannel(row.channel),
    createdAt: asDate(row.createdAt)?.toISOString() ?? null,
  };
}

export function subscribeSoftwareShopFollowUps(
  shopDocId: string,
  onChange: (rows: SoftwareShopFollowUp[]) => void,
  onError: (message: string) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(db, SOFTWARE_SHOPS_COLLECTION, shopDocId, SOFTWARE_SHOP_FOLLOW_UPS),
      orderBy('createdAt', 'desc'),
    ),
    (snap) => {
      const rows: SoftwareShopFollowUp[] = [];
      for (const docSnap of snap.docs) {
        const item = asSoftwareFollowUp(docSnap.data(), docSnap.id);
        if (item) rows.push(item);
      }
      onChange(rows);
    },
    (err) => onError(err.message || 'Could not load follow-up logs.'),
  );
}

export async function addSoftwareShopFollowUp(
  shopDocId: string,
  input: {
    userId: string;
    userName: string;
    remarks: string;
    channel: SoftwareFollowUpChannel;
  },
): Promise<void> {
  const remarks = asString(input.remarks);
  const userName = asString(input.userName);
  const userId = asString(input.userId);
  const channel = asFollowUpChannel(input.channel);
  if (!remarks) throw new Error('Enter remarks.');
  if (!userId || !userName) throw new Error('Sign in required.');
  if (!channel) throw new Error('Pick Call or WhatsApp.');

  const shopRef = doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId);
  const followRef = doc(collection(shopRef, SOFTWARE_SHOP_FOLLOW_UPS));
  const batch = writeBatch(db);
  batch.set(followRef, {
    userId,
    userName,
    remarks,
    channel,
    createdAt: serverTimestamp(),
  });
  batch.update(shopRef, {
    hasFollowUp: true,
    contactedAt: serverTimestamp(),
    lastFollowUpRemarks: remarks,
    lastFollowUpChannel: channel,
    ...(channel === 'call' ? { contactedViaCall: true } : { contactedViaWhatsApp: true }),
  });
  await batch.commit();
}

export const SOFTWARE_RENEWAL_WHATSAPP_TEXT = `Dear Customer,

Your software renewal is due. Kindly renew it at the earliest to avoid any interruption in service.

Thank you,
Customer Care Team
Meezan Electronic Scales Pvt. Ltd.`;

export function shouldPrefillSoftwareRenewalMessage(
  sentAt: string | null | undefined,
  now = new Date(),
): boolean {
  if (!sentAt) return true;
  const sent = asDate(sentAt);
  if (!sent) return true;
  return now.getTime() - sent.getTime() >= WHATSAPP_RENEWAL_COOLDOWN_MS;
}

/** First tap or 350+ days since last prefill: wa.me with encoded renewal text. Else phone only. */
export function softwareRenewalWhatsAppHref(
  phone: string,
  sentAt: string | null | undefined,
  now = new Date(),
): string {
  if (!isLikelyWhatsAppNumber(phone)) return '';
  if (!shouldPrefillSoftwareRenewalMessage(sentAt, now)) {
    return callerWhatsAppHref(phone);
  }
  return callerWhatsAppHref(phone, SOFTWARE_RENEWAL_WHATSAPP_TEXT);
}

export function markSoftwareWhatsAppRenewalSent(shopDocId: string): Promise<void> {
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId), {
    whatsappRenewalSentAt: serverTimestamp(),
  });
}

export function saveSoftwareShopInstallationDate(shopDocId: string, date: string): Promise<void> {
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId), {
    installationDate: asYmdDate(date),
  });
}

export function saveSoftwareShopCustomerLink(
  shopDocId: string,
  customer: { customerId: string; customerName: string; customerOrgKey: string } | null,
): Promise<void> {
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId), {
    customerId: asString(customer?.customerId),
    customerName: asString(customer?.customerName),
    customerOrgKey: asString(customer?.customerOrgKey),
  });
}

/** Same roles as softwareShops client updates (admin + sales/staff). */
export function canVoidSoftwareShop(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'sales' || role === 'staff' || role === 'service';
}

/** Local Meezan cancel. Does not call Sanoft. */
export function voidSoftwareShop(shopDocId: string): Promise<void> {
  const id = asString(shopDocId);
  if (!id) throw new Error('Shop is required.');
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, id), {
    voided: true,
  });
}

export function asSoftwareTraining(value: unknown, id: string): SoftwareShopTraining | null {
  const row = asRecord(value);
  const scheduledAt = asDate(row.scheduledAt)?.toISOString() ?? asString(row.scheduledAt);
  if (!scheduledAt && !asString(row.trainingPoints)) return null;
  return {
    id,
    userId: asString(row.userId),
    userName: asString(row.userName),
    scheduledAt,
    trainingPoints: asString(row.trainingPoints),
    pocName: asString(row.pocName),
    ownerPhone: asString(row.ownerPhone),
    pocPhone: asString(row.pocPhone),
    createdAt: asDate(row.createdAt)?.toISOString() ?? null,
  };
}

export function subscribeSoftwareShopTrainings(
  shopDocId: string,
  onChange: (rows: SoftwareShopTraining[]) => void,
  onError: (message: string) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(db, SOFTWARE_SHOPS_COLLECTION, shopDocId, SOFTWARE_SHOP_TRAININGS),
      orderBy('createdAt', 'desc'),
    ),
    (snap) => {
      const rows: SoftwareShopTraining[] = [];
      for (const docSnap of snap.docs) {
        const item = asSoftwareTraining(docSnap.data(), docSnap.id);
        if (item) rows.push(item);
      }
      onChange(rows);
    },
    (err) => onError(err.message || 'Could not load training logs.'),
  );
}

export async function saveSoftwareShopTrainingSchedule(
  shopDocId: string,
  input: {
    scheduledAt: string;
    userId: string;
    userName: string;
    pocName: string;
    pocPhone: string;
    ownerPhone: string;
    supportUsername: string;
    supportPassword: string;
    trainingPoints: string;
  },
): Promise<void> {
  const userId = asString(input.userId);
  const userName = asString(input.userName);
  const scheduledAt = asString(input.scheduledAt);
  const trainingPoints = asString(input.trainingPoints);
  if (!userId || !userName) throw new Error('Sign in required.');
  if (!scheduledAt) throw new Error('Pick a date and time.');

  const shopRef = doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId);
  const trainingRef = doc(collection(shopRef, SOFTWARE_SHOP_TRAININGS));
  const batch = writeBatch(db);
  batch.set(trainingRef, {
    userId,
    userName,
    scheduledAt,
    trainingPoints,
    pocName: asString(input.pocName),
    pocPhone: asString(input.pocPhone),
    ownerPhone: asString(input.ownerPhone),
    createdAt: serverTimestamp(),
  });
  batch.update(shopRef, {
    isNewCustomer: true,
    trainingScheduledAt: scheduledAt,
    trainingScheduledByUid: userId,
    trainingScheduledByName: userName,
    trainingCompletedAt: '',
    pocName: asString(input.pocName),
    pocPhone: asString(input.pocPhone),
    ownerPhone: asString(input.ownerPhone),
    supportUsername: asString(input.supportUsername),
    supportPassword: asString(input.supportPassword),
    trainingPoints,
  });
  await batch.commit();
}

export function saveSoftwareShopSupportLogin(
  shopDocId: string,
  input: { username: string; password: string },
): Promise<void> {
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId), {
    supportUsername: asString(input.username),
    supportPassword: asString(input.password),
  });
}

export function completeSoftwareShopTraining(shopDocId: string): Promise<void> {
  return updateDoc(doc(db, SOFTWARE_SHOPS_COLLECTION, shopDocId), {
    isNewCustomer: false,
    trainingCompletedAt: new Date().toISOString(),
  });
}

export function compareSoftwareShopsByIdDesc(a: SoftwareShop, b: SoftwareShop): number {
  if (b.shopId !== a.shopId) return b.shopId - a.shopId;
  return a.sourceAccount.localeCompare(b.sourceAccount);
}

function isNamespacedShopId(id: string): boolean {
  return /^(meezan|weighvox-dubai|weighvox|yesweigh|bench-cloud)_\d+$/.test(id);
}

export function uniqueSoftwareShops(shops: SoftwareShop[]): SoftwareShop[] {
  const byKey = new Map<string, SoftwareShop>();
  for (const shop of shops) {
    const key = `${shop.sourceAccount}:${shop.shopId}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, shop);
      continue;
    }
    if (isNamespacedShopId(shop.id) && !isNamespacedShopId(current.id)) {
      byKey.set(key, shop);
    }
  }
  return [...byKey.values()];
}

const DEV_SHOP_CACHE_MS = 10 * 60 * 1000;
let devShopsCache: { at: number; shops: SoftwareShop[] } | null = null;
let devShopsInflight: Promise<SoftwareShop[]> | null = null;
let memoryShops: SoftwareShop[] | null = null;

function commitSoftwareShopsCache(shops: SoftwareShop[]): void {
  memoryShops = shops;
  displayCacheSet(DISPLAY_CACHE_KEYS.softwareShops, shops);
}

function shopsFromSnapshot(docs: Array<{ id: string; data: () => unknown }>): SoftwareShop[] {
  const rows: SoftwareShop[] = [];
  for (const docSnap of docs) {
    const shop = asSoftwareShop(docSnap.data(), docSnap.id);
    if (shop && shopMatchesDealerFilter(shop, 'yesweigh')) rows.push(shop);
  }
  rows.sort(compareSoftwareShopsByIdDesc);
  return uniqueSoftwareShops(rows);
}

async function loadYesweighShopsFromSanoft(force = false): Promise<SoftwareShop[]> {
  if (!force && devShopsCache && Date.now() - devShopsCache.at < DEV_SHOP_CACHE_MS) {
    return devShopsCache.shops;
  }
  if (!devShopsInflight) {
    devShopsInflight = (async () => {
      const response = await fetch('/__software/shops', { method: force ? 'POST' : 'GET' });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        shops?: unknown[];
      };
      if (!response.ok) {
        throw new Error(payload.error || 'Could not load YesWeigh shops from Sanoft.');
      }
      const rows: SoftwareShop[] = [];
      for (const item of payload.shops || []) {
        const record = asRecord(item);
        const shop = asSoftwareShop(record, asString(record.id));
        if (shop && shopMatchesDealerFilter(shop, 'yesweigh')) rows.push(shop);
      }
      rows.sort(compareSoftwareShopsByIdDesc);
      const shops = uniqueSoftwareShops(rows);
      devShopsCache = { at: Date.now(), shops };
      return shops;
    })().finally(() => {
      devShopsInflight = null;
    });
  }
  return devShopsInflight;
}

export function subscribeSoftwareShops(
  onChange: (shops: SoftwareShop[]) => void,
  onError: (message: string) => void,
): Unsubscribe {
  let stopped = false;
  let emitted = false;

  const emit = (shops: SoftwareShop[]) => {
    if (stopped) return;
    emitted = true;
    commitSoftwareShopsCache(shops);
    onChange(shops);
  };

  if (memoryShops?.length) {
    emitted = true;
    onChange(memoryShops);
  }

  void displayCacheGet<SoftwareShop[]>(DISPLAY_CACHE_KEYS.softwareShops).then((entry) => {
    if (stopped || !Array.isArray(entry?.data) || !entry.data.length) return;
    if (!memoryShops?.length) emit(entry.data);
  });

  const loadDevFallback = () => {
    if (!import.meta.env.DEV) return;
    void loadYesweighShopsFromSanoft(false)
      .then((rows) => {
        if (rows.length) emit(rows);
        else if (!emitted) emit([]);
      })
      .catch((err: unknown) => {
        if (!emitted) onError(err instanceof Error ? err.message : 'Could not load software shops.');
      });
  };

  const unsub = onSnapshot(
    collection(db, SOFTWARE_SHOPS_COLLECTION),
    (snap) => {
      const rows = shopsFromSnapshot(snap.docs);
      if (rows.length) {
        emit(rows);
        return;
      }
      if (emitted) {
        emit(rows);
        return;
      }
      loadDevFallback();
      if (!import.meta.env.DEV) emit(rows);
    },
    (err) => {
      if (emitted) return;
      if (import.meta.env.DEV) {
        loadDevFallback();
        return;
      }
      onError(err.message || 'Could not load software shops.');
    },
  );

  const onRefresh = () => {
    if (import.meta.env.DEV) loadDevFallback();
  };
  if (import.meta.env.DEV) {
    window.addEventListener('software-shops-refresh', onRefresh);
  }

  return () => {
    stopped = true;
    unsub();
    if (import.meta.env.DEV) {
      window.removeEventListener('software-shops-refresh', onRefresh);
    }
  };
}

export function subscribeSoftwareShopMeta(
  onChange: (meta: SoftwareShopSyncMeta | null) => void,
  onError: (message: string) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, SOFTWARE_SHOP_META_COLLECTION),
    (snap) => {
      const docSnap = snap.docs.find((row) => row.id === SOFTWARE_SHOP_META_ID);
      if (!docSnap) {
        onChange(null);
        return;
      }
      const data = asRecord(docSnap.data());
      onChange({
        count: asNumber(data.upserted || data.fetched || data.count),
        fetched: asNumber(data.fetched),
        upserted: asNumber(data.upserted),
        lastSyncAt: asDate(data.lastSyncAt)?.toISOString() ?? (asString(data.lastSyncAt) || null),
        error: asString(data.error) || null,
      });
    },
    (err) => onError(err.message || 'Could not load software sync status.'),
  );
}

const functions = getFunctions(app, 'asia-south1');

export async function syncSanoftShops(sourceAccount: 'all' | string = 'yesweigh'): Promise<SoftwareShopSyncResult> {
  if (import.meta.env.DEV) {
    const shops = await loadYesweighShopsFromSanoft(true);
    window.dispatchEvent(new Event('software-shops-refresh'));
    return {
      ok: true,
      collection: SOFTWARE_SHOPS_COLLECTION,
      fetched: shops.length,
      reported: shops.length,
      upserted: shops.length,
      renewals: 0,
      apiCalls: 0,
      syncedAt: new Date().toISOString(),
    };
  }
  const fn = httpsCallable<{ sourceAccount: string }, SoftwareShopSyncResult>(
    functions,
    'syncSanoftShops',
    { timeout: 300_000 },
  );
  const result = await fn({ sourceAccount });
  return result.data;
}

export const DEFAULT_SANOFT_SHOP_PASSWORD = 'test@12345';
export const MEEZAN_SANOFT_DEALER_ID = 14;

export type SoftwareCreateProduct = 'sanoft' | 'bench-cloud';
export type SanoftCreatePlanKey = 'sanoft-lite' | 'sanoft-pro' | 'sanoft-elite';

export type CreateSanoftShopInput = {
  planKey: SanoftCreatePlanKey;
  shopName: string;
  fullName: string;
  email: string;
  mobile: string;
  username?: string;
  password?: string;
};

export type CreateSanoftShopResult = {
  ok: boolean;
  shopId: number;
  shopDocId: string;
  name: string;
  username: string;
  password: string;
  plan: string;
  sourceAccount: string;
  dealerId: number;
  currency?: string;
  currencySymbol?: string | null;
  currencyApplied?: boolean;
};

const USERNAME_MAX = 16;
const USERNAME_PART = 8;
const USERNAME_SKIP = /^(and|the|of|for|a|an|shop)$/;

function usernamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, USERNAME_PART);
}

export function suggestSanoftUsername(shopName: string, fullName = ''): string {
  const source = shopName.trim() || fullName.trim();
  const words = source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !USERNAME_SKIP.test(word));
  const first = usernamePart(words[0] || '');
  const last = usernamePart(words.length > 1 ? words[words.length - 1] : '');
  const slug = (first && last && first !== last ? `${first}.${last}` : first || last)
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, USERNAME_MAX);
  return slug || 'shop';
}

export async function createSanoftShop(_input: CreateSanoftShopInput): Promise<CreateSanoftShopResult> {
  throw new Error('Creating a Sanoft shop from YesWeigh is not enabled yet.');
}

export type SendBenchCloudOtpResult = {
  sent: boolean;
  emailed: boolean;
  via?: string;
  otp?: string;
};

export type CreateBenchCloudShopInput = {
  email: string;
  password: string;
  otp: string;
  shopName: string;
  whatsapp: string;
  address: string;
  pin: string;
  district: string;
  state: string;
};

export async function sendBenchCloudSignupOtp(_email: string): Promise<SendBenchCloudOtpResult> {
  throw new Error('Bench Cloud signup is not available in YesWeigh.');
}

export async function createBenchCloudShop(_input: CreateBenchCloudShopInput): Promise<CreateSanoftShopResult> {
  throw new Error('Bench Cloud signup is not available in YesWeigh.');
}

export function canManageShopMenu(role: string | null | undefined): boolean {
  return canVoidSoftwareShop(role);
}

function asMenuItem(value: unknown): ShopMenuItem | null {
  const row = asRecord(value);
  const name = asString(row.name);
  const price = Number(row.price);
  if (!name || !Number.isFinite(price)) return null;
  return {
    serial: asString(row.serial) || '',
    category: asString(row.category),
    name,
    price,
  };
}

export function asShopMenu(value: unknown, shopId: string): ShopMenu {
  const row = asRecord(value);
  const items = Array.isArray(row.items) ? row.items.map(asMenuItem).filter((item): item is ShopMenuItem => Boolean(item)) : [];
  return {
    shopId: asString(row.shopId) || shopId,
    items,
    source: asString(row.source),
    storagePath: asString(row.storagePath),
    model: asString(row.model),
    provider: asString(row.provider),
    itemCount: Number(row.itemCount) || items.length,
    updatedAt: asDate(row.updatedAt)?.toISOString() ?? (asString(row.updatedAt) || null),
    updatedByName: asString(row.updatedByName),
  };
}

export function subscribeShopMenu(
  shopDocId: string,
  onChange: (menu: ShopMenu | null) => void,
  onError: (message: string) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, SHOP_MENUS_COLLECTION, shopDocId),
    (snap) => onChange(snap.exists() ? asShopMenu(snap.data(), shopDocId) : null),
    (err) => onError(err.message || 'Could not load this shop menu.'),
  );
}

async function compressMenuImage(file: File): Promise<{ blob: Blob; mimeType: string; fileName: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not compress this image.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => (next ? resolve(next) : reject(new Error('Could not compress this image.'))), 'image/jpeg', 0.82);
  });
  return { blob, mimeType: 'image/jpeg', fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

export async function prepareShopMenuFile(file: File): Promise<{ blob: Blob; mimeType: string; fileName: string }> {
  const type = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    if (file.size > SHOP_MENU_MAX_BYTES) throw new Error('PDF must be 12 MB or smaller.');
    return { blob: file, mimeType: 'application/pdf', fileName: file.name || 'menu.pdf' };
  }
  if (!type.startsWith('image/') && !/\.(jpg|jpeg|png|webp)$/i.test(name)) {
    throw new Error('Upload a PDF, JPG, or PNG menu.');
  }
  if (file.size > SHOP_MENU_MAX_BYTES) throw new Error('Image must be 12 MB or smaller.');
  return compressMenuImage(file);
}

export async function uploadShopMenuFile(shopDocId: string, file: File): Promise<{ storagePath: string; mimeType: string; fileName: string }> {
  const prepared = await prepareShopMenuFile(file);
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const safe = prepared.fileName.replace(/[^\w.\-]+/g, '_') || 'menu';
  const storagePath = `${SHOP_MENU_STORAGE_PREFIX}/${shopDocId}/${id}-${safe}`;
  await uploadBytes(ref(storage, storagePath), prepared.blob, { contentType: prepared.mimeType });
  return { storagePath, mimeType: prepared.mimeType, fileName: prepared.fileName };
}

export function extractShopMenu(_input: {
  shopId: string;
  storagePath?: string;
  imageBase64?: string;
  mimeType?: string;
  fileName?: string;
}): Promise<ExtractShopMenuResult> {
  throw new Error('Shop menu extract is not available in YesWeigh yet.');
}

export function saveShopMenu(_input: {
  shopId: string;
  items: ShopMenuItem[];
  merge?: boolean;
  storagePath?: string;
  model?: string;
  provider?: string;
  isRestaurant?: boolean;
  pushToSanoft?: boolean;
}): Promise<SaveShopMenuResult> {
  throw new Error('Shop menu save is not available in YesWeigh yet.');
}

export function shopSearchHaystack(shop: SoftwareShop): string {
  return [
    shop.shopId,
    shop.sourceAccount,
    softwareOrgLabel(shop.sourceAccount),
    shop.name,
    shop.phone,
    shop.subscription,
    shop.status,
    shop.subscriptionEnd,
    shop.installationDate,
    shop.sanoftInstallationDate,
    shop.customerName,
    shop.customerId,
    shop.pocName,
    shop.pocPhone,
    shop.ownerPhone,
    shop.supportUsername,
    shop.trainingPoints,
    shopIsNewCustomer(shop) ? 'new training' : '',
    shopIsVoided(shop) ? 'voided void' : '',
    !shopIsVoided(shop) && (shop.cancelled || shop.status === 'CANCELLED') ? 'cancelled' : '',
    shop.menuUploaded ? 'menu uploaded' : '',
    shop.dealer,
    shopIsContacted(shop) ? 'contacted' : '',
    shop.contactedViaCall ? 'call called' : '',
    shop.contactedViaWhatsApp ? 'whatsapp' : '',
    ...shop.users.map((user) => `${user.username} ${user.firstName} ${user.lastName}`),
  ].join(' ').toLowerCase();
}

export function formatShopRateCardMessage(shop: SoftwareShop): string {
  const days = formatSoftwareEndDays(shop.subscriptionEnd);
  const end = shop.subscriptionEnd || '—';
  const endLine = days ? `${end} (${days})` : end;
  const planStatus = String(shop.extras?.planStatus ?? '').trim() || '—';
  const quote = shopRenewalQuote(shop);
  return [
    `*${shop.name || `Shop ${shop.shopId}`}*`,
    `Organisation: ${softwareOrgLabel(shop.sourceAccount)}`,
    `Phone: ${shop.phone || '—'}`,
    `Subscription: ${shop.subscription || '—'}`,
    `Plan status: ${planStatus}`,
    ...(quote ? [
      `${quote.subscriptionLabel}: ${quote.subscriptionAmount}`,
      ...(quote.smartScaleAmount ? [`Smart Scale: ${quote.smartScaleAmount}`] : []),
      `Total: ${quote.totalAmount}`,
    ] : []),
    `End date: ${endLine}`,
  ].join('\n');
}
