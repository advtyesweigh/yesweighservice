/** Auto-reply for inbound “Renew Subscription, ShopId=…” WhatsApp messages. */

export const SOFTWARE_RENEWAL_CHARGES_INR = {
  'sanoft lite': 4500,
  'sanoft pro': 5500,
  'sanoft elite': 7500,
  standard: 2500,
  premium: 3500,
  'double standard': 5000,
};

const SMART_SCALE_CALL_EXTRA_INR = 1500;
const GST_RATE = 0.18;

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
  if (!base) return { base: 0, extra: 0, subtotal: 0, gst: 0, total: 0 };
  const extra = shopHasSmartScale(shop) ? SMART_SCALE_CALL_EXTRA_INR : 0;
  const subtotal = base + extra;
  const gst = Math.round(subtotal * GST_RATE);
  return { base, extra, subtotal, gst, total: subtotal + gst };
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
  if (payable.subtotal) {
    lines.push(`${asString(shop?.subscription) || 'Renewal'}: ${formatInr(payable.base)}`);
    if (payable.extra) lines.push(`Smart Scale: ${formatInr(payable.extra)}`);
    lines.push(`Total: ${formatInr(payable.subtotal)}`);
  }
  lines.push(`End date: ${days ? `${end} (${days})` : end}`);
  return lines.join('\n');
}

export function softwareRenewalPaymentText(shop, shopId) {
  const id = Number(shop?.shopId || shopId) || 0;
  const name = asString(shop?.name) || `Shop ${id}`;
  const payable = softwareRenewalPayableInr(shop);
  const amountLine = payable.total
    ? `Please pay ${formatInr(payable.total)} to renew ${name} (${formatInr(payable.subtotal)} + 18% GST).`
    : `Please pay the renewal amount + 18% GST for ${name}.`;
  return [
    amountLine,
    '',
    RENEWAL_BANK_DETAILS,
    '',
    'Please share the payment screenshot here after paying.',
  ].join('\n');
}

export function softwareRenewalMissingShopText(shopId) {
  return `We could not find Shop ID ${shopId} in Software. Our team will help you shortly.`;
}
