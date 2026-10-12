import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../firebase';
import type { ZohoAddressRaw, ZohoDealer } from '../types/dealers';
import { dealerOrderErrorMessage } from './dealerOrders';
import { isValidGstin, normalizeGstin } from './gstin';

const functions = getFunctions(app, 'asia-south1');

export type ShippingAddressKind = 'billing' | 'shipping' | 'additional';

export interface ShippingAddress {
  addressId: string | null;
  kind: ShippingAddressKind | string;
  label: string;
  formatted: string | null;
  attention: string | null;
  address: string | null;
  street2: string | null;
  city: string | null;
  district?: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  gstin?: string | null;
}

export type NewShippingAddressInput = {
  attention: string;
  address: string;
  street2?: string;
  city: string;
  district?: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  gstin?: string;
};

export type ShippingSelection =
  | { mode: 'saved'; addressId: string }
  | { mode: 'kind'; kind: 'billing' | 'shipping' }
  | { mode: 'new'; newAddress: NewShippingAddressInput };

/** Resolve state/city/zip from the dealer's current shipping selection. */
export function resolveShippingDestination(
  selection: ShippingSelection | null | undefined,
  addresses: ShippingAddress[],
): { state: string | null; city: string | null; zip: string | null } | null {
  if (!selection) return null;

  if (selection.mode === 'new') {
    const a = selection.newAddress;
    const state = a.state?.trim() || null;
    const city = a.city?.trim() || null;
    const zip = a.zip?.trim() || null;
    if (!state && !city && !zip) return null;
    return { state, city, zip };
  }

  const match = selection.mode === 'saved'
    ? addresses.find(a => a.addressId && a.addressId === selection.addressId)
    : addresses.find(a => a.kind === selection.kind);

  if (!match) return null;
  const state = match.state?.trim() || null;
  const city = match.city?.trim() || null;
  const zip = match.zip?.trim() || null;
  if (!state && !city && !zip) return null;
  return { state, city, zip };
}

async function call<TReq, TRes>(name: string, data?: TReq, timeout = 60_000): Promise<TRes> {
  const callable = httpsCallable<TReq | undefined, TRes>(functions, name, { timeout });
  const result = await callable(data);
  return result.data;
}

export async function listDealerShippingAddresses(): Promise<ShippingAddress[]> {
  try {
    const res = await call<undefined, { addresses?: ShippingAddress[] }>(
      'listDealerShippingAddresses',
    );
    return Array.isArray(res.addresses) ? res.addresses : [];
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function addDealerShippingAddress(
  address: NewShippingAddressInput,
): Promise<ShippingAddress> {
  try {
    const res = await call<{ address: NewShippingAddressInput }, { address: ShippingAddress }>(
      'addDealerShippingAddress',
      { address },
    );
    return res.address;
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function listCustomerShippingAddresses(
  customerId: string,
): Promise<CustomerShippingAddressesResult> {
  try {
    const res = await call<
      { customerId: string },
      { addresses?: ShippingAddress[]; zohoSyncWarning?: string }
    >(
      'listCustomerShippingAddresses',
      { customerId },
    );
    return {
      addresses: Array.isArray(res.addresses) ? res.addresses : [],
      warning: res.zohoSyncWarning?.trim() || undefined,
    };
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function addCustomerShippingAddress(
  customerId: string,
  address: NewShippingAddressInput,
): Promise<ShippingAddress> {
  try {
    const res = await call<
      { customerId: string; address: NewShippingAddressInput },
      { address: ShippingAddress }
    >('addCustomerShippingAddress', { customerId, address });
    return res.address;
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function updateDealerShippingAddress(input: {
  addressId?: string | null;
  kind?: string | null;
  address: NewShippingAddressInput;
}): Promise<ShippingAddress> {
  try {
    const res = await call<typeof input, { address: ShippingAddress }>(
      'updateDealerShippingAddress',
      input,
    );
    return res.address;
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function deleteDealerShippingAddress(addressId: string): Promise<void> {
  try {
    await call<{ addressId: string }, { deleted?: boolean }>(
      'deleteDealerShippingAddress',
      { addressId },
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function updateCustomerShippingAddress(
  customerId: string,
  input: {
    addressId?: string | null;
    kind?: string | null;
    address: NewShippingAddressInput;
  },
): Promise<ShippingAddress> {
  try {
    const res = await call<
      { customerId: string } & typeof input,
      { address: ShippingAddress }
    >('updateCustomerShippingAddress', { customerId, ...input });
    return res.address;
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export async function deleteCustomerShippingAddress(
  customerId: string,
  addressId: string,
): Promise<void> {
  try {
    await call<{ customerId: string; addressId: string }, { deleted?: boolean }>(
      'deleteCustomerShippingAddress',
      { customerId, addressId },
    );
  } catch (err) {
    throw new Error(dealerOrderErrorMessage(err));
  }
}

export function shippingAddressToForm(addr: ShippingAddress): NewShippingAddressInput {
  return {
    attention: addr.attention?.trim() || '',
    address: addr.address?.trim() || '',
    street2: addr.street2?.trim() || '',
    city: addr.city?.trim() || '',
    district: addr.district?.trim() || '',
    state: addr.state?.trim() || '',
    zip: addr.zip?.trim() || '',
    country: addr.country?.trim() || 'India',
    phone: addr.phone?.trim() || '',
    gstin: addr.gstin?.trim() || '',
  };
}

/** Saved Zoho additional addresses can be deleted; billing/default shipping cannot. */
export function canDeleteShippingAddress(addr: ShippingAddress): boolean {
  return Boolean(addr.addressId?.trim());
}

export function canEditShippingAddress(addr: ShippingAddress): boolean {
  return Boolean(addr.addressId?.trim())
    || addr.kind === 'billing'
    || addr.kind === 'shipping';
}

export function shippingSelectionPayload(selection: ShippingSelection): {
  addressId?: string;
  kind?: string;
  newAddress?: NewShippingAddressInput;
} {
  if (selection.mode === 'saved') return { addressId: selection.addressId };
  if (selection.mode === 'kind') return { kind: selection.kind };
  return { newAddress: selection.newAddress };
}

export const EMPTY_NEW_ADDRESS: NewShippingAddressInput = {
  attention: '',
  address: '',
  street2: '',
  city: '',
  district: '',
  state: '',
  zip: '',
  country: 'India',
  phone: '',
  gstin: '',
};

export function validateNewShippingAddress(
  addr: NewShippingAddressInput,
): string | null {
  const gstin = normalizeGstin(addr.gstin);
  if (gstin && !isValidGstin(gstin)) return 'Enter a valid 15-character GSTIN, or leave it blank.';
  if (!addr.attention.trim()) return 'Attention / contact name is required.';
  if (!addr.address.trim()) return 'Address line 1 is required.';
  if (!addr.city.trim()) return 'City is required.';
  if (!addr.state.trim()) return 'State is required.';
  if (!/^\d{6}$/.test(addr.zip.trim())) return 'PIN code must be a 6-digit number.';
  if (!addr.country.trim()) return 'Country is required.';
  if (!addr.phone.trim()) return 'Phone is required.';
  return null;
}

export interface CustomerShippingAddressesResult {
  addresses: ShippingAddress[];
  warning?: string;
}

function extractPinFromText(text: string | null | undefined): string | null {
  const match = String(text ?? '').match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function mapFormattedDealerAddress(
  formatted: string | null | undefined,
  kind: 'billing' | 'shipping',
  label: string,
  dealer: Pick<
    ZohoDealer,
    | 'contactName'
    | 'companyName'
    | 'zipCode'
    | 'billingState'
    | 'district'
    | 'mobile'
    | 'phone'
  >,
): ShippingAddress | null {
  const text = formatted?.trim();
  if (!text) return null;
  const zip = dealer.zipCode?.trim() || extractPinFromText(text);
  if (!zip) return null;
  return {
    addressId: null,
    kind,
    label,
    formatted: text,
    attention: dealer.contactName?.trim() || dealer.companyName?.trim() || null,
    address: text,
    street2: null,
    city: dealer.district?.trim() || null,
    state: dealer.billingState?.trim() || null,
    zip,
    country: 'India',
    phone: dealer.mobile?.trim() || dealer.phone?.trim() || null,
  };
}

function formatRawAddress(raw: ZohoAddressRaw | null | undefined): string | null {
  if (!raw) return null;
  const parts = [
    raw.address,
    raw.street2,
    [raw.city, raw.state].filter(Boolean).join(', '),
    raw.zip,
    raw.country,
  ]
    .map(part => String(part ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function mapRawDealerAddress(
  raw: ZohoAddressRaw | null | undefined,
  kind: 'billing' | 'shipping',
  label: string,
): ShippingAddress | null {
  if (!raw) return null;
  const formatted = formatRawAddress(raw);
  if (!formatted) return null;
  return {
    addressId: null,
    kind,
    label,
    formatted,
    attention: null,
    address: raw.address?.trim() || null,
    street2: raw.street2?.trim() || null,
    city: raw.city?.trim() || null,
    state: raw.state?.trim() || null,
    zip: raw.zip != null ? String(raw.zip).trim() : null,
    country: raw.country?.trim() || null,
    phone: raw.phone?.trim() || null,
  };
}

/** Build selectable addresses from a synced dealer when Zoho address APIs fail. */
export function addressesFromDealerCache(
  dealer: Pick<
    ZohoDealer,
    | 'zohoBillingAddressRaw'
    | 'zohoShippingAddressRaw'
    | 'zohoBillingAddress'
    | 'zohoShippingAddress'
    | 'billingAddress'
    | 'shippingAddress'
    | 'contactName'
    | 'companyName'
    | 'zipCode'
    | 'billingState'
    | 'district'
    | 'mobile'
    | 'phone'
  > | null | undefined,
): ShippingAddress[] {
  if (!dealer) return [];
  const rows = [
    mapRawDealerAddress(dealer.zohoBillingAddressRaw, 'billing', 'Billing address'),
    mapRawDealerAddress(dealer.zohoShippingAddressRaw, 'shipping', 'Default shipping'),
    mapFormattedDealerAddress(
      dealer.zohoShippingAddress || dealer.shippingAddress,
      'shipping',
      'Default shipping',
      dealer,
    ),
    mapFormattedDealerAddress(
      dealer.zohoBillingAddress || dealer.billingAddress,
      'billing',
      'Billing address',
      dealer,
    ),
  ].filter((row): row is ShippingAddress => Boolean(row));

  if (!rows.some(row => row.kind === 'shipping')) {
    const zip = dealer.zipCode?.trim() || extractPinFromText(dealer.zohoShippingAddress || dealer.shippingAddress);
    const state = dealer.billingState?.trim();
    if (zip && /^\d{6}$/.test(zip) && state) {
      const attention = dealer.contactName?.trim() || dealer.companyName?.trim() || 'Shipping contact';
      const company = dealer.companyName?.trim() || dealer.contactName?.trim() || null;
      const city = dealer.district?.trim() || null;
      const formatted = [
        attention !== company ? attention : null,
        company,
        city,
        state,
        zip,
        'India',
      ].filter(Boolean).join(', ');
      rows.push({
        addressId: null,
        kind: 'shipping',
        label: 'Default shipping',
        formatted,
        attention,
        address: company || formatted,
        street2: null,
        city,
        state,
        zip,
        country: 'India',
        phone: dealer.mobile?.trim() || dealer.phone?.trim() || null,
      });
    }
  }

  const seen = new Set<string>();
  return rows.filter(row => {
    const key = row.addressId ? `id:${row.addressId}` : `kind:${row.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean((row.formatted || row.address) && row.zip?.trim());
  });
}
