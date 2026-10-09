import { parseSoftwareShopIdFromText } from './whatsappInbox';
import {
  formatShopRateCardMessage,
  lookupSoftwareShopById,
  softwareCallRenewalCharge,
} from './softwareShops';
import type { SoftwareShop } from '../types/software-shop';

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

export function isSoftwareRenewalRequest(text: string): boolean {
  const raw = String(text || '');
  if (!/shop\s*id\s*[=:#]?\s*\d+/i.test(raw)) return false;
  return /\brenew(?:al|\s+subscription)?\b/i.test(raw);
}

function formatInr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function softwareRenewalPaymentText(shop: SoftwareShop | null, shopId: number): string {
  const name = shop?.name?.trim() || `Shop ${shopId}`;
  const charge = shop ? softwareCallRenewalCharge(shop) : null;
  const subtotal = charge?.amount || 0;
  const gst = Math.round(subtotal * GST_RATE);
  const total = subtotal + gst;
  const amountLine = total
    ? `Please pay ${formatInr(total)} to renew ${name} (${formatInr(subtotal)} + 18% GST).`
    : `Please pay the renewal amount + 18% GST for ${name}.`;
  return [
    amountLine,
    '',
    RENEWAL_BANK_DETAILS,
    '',
    'Please share the payment screenshot here after paying.',
  ].join('\n');
}

export function softwareRenewalMissingShopText(shopId: number): string {
  return `We could not find Shop ID ${shopId} in Software. Our team will help you shortly.`;
}

export async function buildSoftwareRenewalAutoReply(shopId: number): Promise<{ card: string; payment: string }> {
  const shop = await lookupSoftwareShopById(shopId);
  if (!shop) {
    return {
      card: softwareRenewalMissingShopText(shopId),
      payment: '',
    };
  }
  return {
    card: formatShopRateCardMessage(shop),
    payment: softwareRenewalPaymentText(shop, shopId),
  };
}

export function renewalShopIdFromText(text: string): number {
  if (!isSoftwareRenewalRequest(text)) return 0;
  return parseSoftwareShopIdFromText(text);
}
