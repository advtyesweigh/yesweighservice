import { parseSoftwareShopIdFromText } from './whatsappInbox';
import {
  formatShopRateCardMessage,
  renewalAmountInclGst,
  resolveSoftwareShopForRenewal,
  softwareCallRenewalCharge,
} from './softwareShops';
import type { SoftwareShop } from '../types/software-shop';

/** Kill switch: when false, inbox/webhook must not auto-send renewal messages. Manual compose still works. */
export const SOFTWARE_RENEWAL_AUTO_REPLY_ENABLED = true;

/** Hosted flyer (Firebase Hosting `public/whatsapp/` → `dist/whatsapp/` after deploy). */
export const ECS_LITE_RENEWAL_FLYER_URL =
  'https://yesweigh-service.web.app/whatsapp/ecs-lite-renewal.jpg';

export const ECS_LITE_RENEWAL_FLYER_FILE_NAME = 'ecs-lite-renewal.jpg';
export const ECS_LITE_RENEWAL_FLYER_MIME = 'image/jpeg';

/** ECS Lite / Standard / Premium base (excl. GST). */
export const ECS_LITE_RENEWAL_BASE_INR = 1900;

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

export function isSoftwareRenewalRequest(text: string): boolean {
  const raw = String(text || '');
  if (!/shop\s*id\s*[=:#]?\s*\d+/i.test(raw)) return false;
  return /\brenew(?:al|\s+subscription)?\b/i.test(raw);
}

function formatInr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Payment follow-up: uses shop quote when available, else ECS Lite ₹1,900 + 18% GST per scale. */
export function softwareRenewalPaymentText(shop: SoftwareShop | null, shopId: number): string {
  const name = shop?.name?.trim() || `Shop ${shopId}`;
  const charge = shop ? softwareCallRenewalCharge(shop) : null;
  const base = charge?.currency === 'INR' && charge.amount
    ? charge.amount
    : ECS_LITE_RENEWAL_BASE_INR;
  const total = charge?.currency === 'INR' && charge.amount
    ? renewalAmountInclGst(charge.amount, 'INR')
    : renewalAmountInclGst(ECS_LITE_RENEWAL_BASE_INR, 'INR');
  const isLitePerScale = base === ECS_LITE_RENEWAL_BASE_INR;
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

export function softwareRenewalMissingShopText(shopId: number): string {
  return `We could not find Shop ID ${shopId} in Software. Our team will help you shortly.`;
}

export async function buildSoftwareRenewalAutoReply(
  shopId: number,
  phone = '',
): Promise<{
  card: string;
  payment: string;
  shopId: number;
  found: boolean;
  flyerUrl: string;
  flyerFileName: string;
  flyerMimeType: string;
}> {
  const shop = await resolveSoftwareShopForRenewal({ shopId, phone });
  if (!shop) {
    return {
      card: softwareRenewalMissingShopText(shopId),
      payment: softwareRenewalPaymentText(null, shopId),
      shopId,
      found: false,
      flyerUrl: ECS_LITE_RENEWAL_FLYER_URL,
      flyerFileName: ECS_LITE_RENEWAL_FLYER_FILE_NAME,
      flyerMimeType: ECS_LITE_RENEWAL_FLYER_MIME,
    };
  }
  return {
    card: formatShopRateCardMessage(shop),
    payment: softwareRenewalPaymentText(shop, shop.shopId || shopId),
    shopId: shop.shopId || shopId,
    found: true,
    flyerUrl: ECS_LITE_RENEWAL_FLYER_URL,
    flyerFileName: ECS_LITE_RENEWAL_FLYER_FILE_NAME,
    flyerMimeType: ECS_LITE_RENEWAL_FLYER_MIME,
  };
}

export function renewalShopIdFromText(text: string): number {
  if (!isSoftwareRenewalRequest(text)) return 0;
  return parseSoftwareShopIdFromText(text);
}

/** Fetch the ECS Lite flyer as base64 for WhatsApp Cloud send (same-origin first). */
export async function loadEcsLiteRenewalFlyerBase64(): Promise<{
  fileBase64: string;
  mimeType: string;
  fileName: string;
}> {
  const urls = [
    `/whatsapp/${ECS_LITE_RENEWAL_FLYER_FILE_NAME}`,
    ECS_LITE_RENEWAL_FLYER_URL,
  ];
  let response: Response | null = null;
  let lastStatus = 0;
  for (const url of urls) {
    try {
      const next = await fetch(url);
      lastStatus = next.status;
      if (next.ok) {
        response = next;
        break;
      }
    } catch {
      // try next URL (hosting can fail CORS from localhost)
    }
  }
  if (!response) {
    throw new Error(`Could not load ECS Lite flyer (${lastStatus || 'network'}).`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    fileBase64: btoa(binary),
    mimeType: ECS_LITE_RENEWAL_FLYER_MIME,
    fileName: ECS_LITE_RENEWAL_FLYER_FILE_NAME,
  };
}
