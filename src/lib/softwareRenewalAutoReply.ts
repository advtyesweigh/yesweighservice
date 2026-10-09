import { parseSoftwareShopIdFromText } from './whatsappInbox';
import {
  formatShopRateCardMessage,
  resolveSoftwareShopForRenewal,
  softwareCallRenewalCharge,
} from './softwareShops';
import type { SoftwareShop } from '../types/software-shop';

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
  const total = charge?.amount || 0;
  const amountLine = total
    ? `Please pay ${formatInr(total)} to renew ${name}.`
    : `Please pay the renewal amount for ${name}.`;
  return [
    amountLine,
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
): Promise<{ card: string; payment: string; shopId: number; found: boolean }> {
  const shop = await resolveSoftwareShopForRenewal({ shopId, phone });
  if (!shop) {
    return {
      card: softwareRenewalMissingShopText(shopId),
      payment: '',
      shopId,
      found: false,
    };
  }
  return {
    card: formatShopRateCardMessage(shop),
    payment: softwareRenewalPaymentText(shop, shop.shopId || shopId),
    shopId: shop.shopId || shopId,
    found: true,
  };
}

export function renewalShopIdFromText(text: string): number {
  if (!isSoftwareRenewalRequest(text)) return 0;
  return parseSoftwareShopIdFromText(text);
}
