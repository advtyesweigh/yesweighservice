/** Auto-reply for inbound “Renew Subscription, ShopId=…” WhatsApp messages. */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Kill switch: when false, webhook must not auto-send renewal messages. Manual compose still works. */
export const SOFTWARE_RENEWAL_AUTO_REPLY_ENABLED = true;

/** ECS Lite / Standard / Premium: ₹1,900 + 18% GST = ₹2,242. */
export const SOFTWARE_RENEWAL_CHARGES_INR = {
  'sanoft lite': 4500,
  'sanoft pro': 5500,
  'sanoft elite': 7500,
  'ecs lite': 1900,
  standard: 1900,
  premium: 1900,
  'double standard': 5000,
};

export const ECS_LITE_RENEWAL_BASE_INR = 1900;
export const ECS_LITE_RENEWAL_FLYER_FILE_NAME = 'ecs-lite-renewal.jpg';
export const ECS_LITE_RENEWAL_FLYER_MIME = 'image/jpeg';
/** Firebase Hosting path after deploy (`public/whatsapp/` → site root). */
export const ECS_LITE_RENEWAL_FLYER_HOSTING_URL =
  'https://yesweigh-service.web.app/whatsapp/ecs-lite-renewal.jpg';
/** Stable Storage object written on first auto-reply (production credentials). */
export const ECS_LITE_RENEWAL_STORAGE_PATH = 'whatsappPromo/ecs-lite-renewal.jpg';
export const ECS_LITE_RENEWAL_STORAGE_TOKEN = 'ecs-lite-renewal-v1';

const SMART_SCALE_CALL_EXTRA_INR = 1500;
const GST_RATE = 0.18;

function inclGst(amount) {
  const n = Number(amount) || 0;
  if (!n) return 0;
  return n + Math.round(n * GST_RATE);
}

const GPAY_NUMBER = '8803333444';

export const RENEWAL_BANK_DETAILS = [
  'Account name: Interweighing Pvt Ltd',
  'ACCOUNT NO-3812693712',
  'KOTAK MAHINDRA BANK',
  'KARAMANA. Trivandrum',
  'IFSC  -  KKBK0009206',
  '',
  `or GPay ${GPAY_NUMBER}`,
].join('\n');

export function isSoftwareRenewalRequest(text) {
  const raw = String(text || '');
  if (!/shop\s*id\s*[=:#]?\s*\d+/i.test(raw)) return false;
  return /\brenew(?:al|\s+subscription)?\b/i.test(raw);
}

function asString(value) {
  return String(value ?? '').trim();
}

function normalizeSubscription(name) {
  return asString(name).toLowerCase().replace(/\s+/g, ' ');
}

function orgLabel(sourceAccount) {
  const key = asString(sourceAccount);
  if (key === 'weighvox-dubai' || key === 'weighvox') return 'Weighvox';
  if (key === 'yesweigh') return 'Yesweigh';
  if (key === 'bench-cloud') return 'Bench Cloud';
  return 'Meezan';
}

function shopHasSmartScale(shop) {
  const text = asString(shop?.smartScale);
  return Boolean(text) && text !== '—' && text !== '-';
}

export function softwareRenewalBaseInr(subscription) {
  const key = normalizeSubscription(subscription);
  if (!key) return 0;
  if (SOFTWARE_RENEWAL_CHARGES_INR[key] != null) return SOFTWARE_RENEWAL_CHARGES_INR[key];
  for (const [plan, amount] of Object.entries(SOFTWARE_RENEWAL_CHARGES_INR)) {
    if (key.startsWith(`${plan} `)) return amount;
  }
  return 0;
}

export function softwareRenewalPayableInr(shop) {
  const base = softwareRenewalBaseInr(shop?.subscription);
  if (!base) return { base: 0, extra: 0, subtotal: 0, gst: 0, total: 0, baseIncl: 0, extraIncl: 0 };
  const extra = shopHasSmartScale(shop) ? SMART_SCALE_CALL_EXTRA_INR : 0;
  const subtotal = base + extra;
  const baseIncl = inclGst(base);
  const extraIncl = inclGst(extra);
  const total = baseIncl + extraIncl;
  return { base, extra, subtotal, gst: total - subtotal, total, baseIncl, extraIncl };
}

function formatInr(amount) {
  return `₹${Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function formatEndDate(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(asString(ymd));
  if (!match) return asString(ymd) || '—';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatEndDays(ymd, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(asString(ymd));
  if (!match) return '';
  const end = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00+05:30`);
  if (!Number.isFinite(end)) return '';
  const startOfToday = Date.parse(
    `${now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T00:00:00+05:30`,
  );
  const days = Math.round((startOfToday - end) / 86400000);
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 0) {
    const left = -days;
    return `in ${left} day${left === 1 ? '' : 's'}`;
  }
  return 'today';
}

export function softwareRenewalCardText(shop, shopId) {
  const id = Number(shop?.shopId || shopId) || 0;
  const name = asString(shop?.name) || `Shop ${id}`;
  const end = formatEndDate(shop?.subscriptionEnd);
  const days = formatEndDays(shop?.subscriptionEnd);
  const payable = softwareRenewalPayableInr(shop);
  const lines = [
    `*${name}*`,
    `Shop ID: ${id || '—'}`,
    `Organisation: ${orgLabel(shop?.sourceAccount)}`,
    `Phone: ${asString(shop?.phone) || '—'}`,
    `Subscription: ${asString(shop?.subscription) || '—'}`,
  ];
  if (payable.total) {
    const planLabel = asString(shop?.subscription) || 'Renewal';
    if (payable.base === ECS_LITE_RENEWAL_BASE_INR && !payable.extra) {
      lines.push(`${planLabel}: ${formatInr(payable.baseIncl)} per scale`);
      lines.push('Unlimited Sales Logs');
    } else {
      lines.push(`${planLabel}: ${formatInr(payable.baseIncl)}`);
      if (payable.extra) lines.push(`Smart Scale: ${formatInr(payable.extraIncl)}`);
    }
    lines.push(`Total (incl. 18% GST): ${formatInr(payable.total)}`);
  }
  lines.push(`End date: ${days ? `${end} (${days})` : end}`);
  return lines.join('\n');
}

export function softwareRenewalPaymentText(shop, shopId) {
  const id = Number(shop?.shopId || shopId) || 0;
  const name = asString(shop?.name) || `Shop ${id}`;
  const payable = softwareRenewalPayableInr(shop);
  const base = payable.subtotal || ECS_LITE_RENEWAL_BASE_INR;
  const total = payable.total || inclGst(ECS_LITE_RENEWAL_BASE_INR);
  const isLitePerScale = base === ECS_LITE_RENEWAL_BASE_INR && !payable.extra;
  const amountLines = isLitePerScale
    ? [
        `Please pay ${formatInr(total)} per scale to renew ${name}.`,
        '₹1,900 + 18% GST = ₹2,242 per scale.',
        'Includes Unlimited Sales Logs.',
      ]
    : [
        `Please pay ${formatInr(total)} to renew ${name} (${formatInr(base)} + 18% GST).`,
        'Includes Unlimited Sales Logs.',
      ];
  return [
    ...amountLines,
    '',
    RENEWAL_BANK_DETAILS,
    '',
    'Please share the payment screenshot here after paying.',
    '',
    'Customer care Team',
    'Interweighing Pvt Ltd',
  ].join('\n');
}

export function softwareRenewalMissingShopText(shopId) {
  return `We could not find Shop ID ${shopId} in Software. Our team will help you shortly.`;
}

export function ecsLiteRenewalFlyerAssetPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'assets',
    'whatsapp',
    ECS_LITE_RENEWAL_FLYER_FILE_NAME,
  );
}
