import type { ZohoAddressRaw, ZohoDealer } from '../types/dealers';
import type { DeliveryAddressKind, LogisticsDealerSnapshot } from '../types/logistics-dispatch';

/** True when an address string is empty or a placeholder dash. */
export function isPlaceholderLogisticsAddress(value: string | null | undefined): boolean {
  const trimmed = value?.replace(/\s+/g, ' ').trim() ?? '';
  return !trimmed || trimmed === '—' || trimmed === '-' || trimmed === '–';
}

export function formatZohoAddressMultiline(
  formatted: string | null | undefined,
  raw: ZohoAddressRaw | null | undefined,
): string {
  if (formatted?.trim()) return formatted.trim();
  if (!raw) return '—';
  const parts = [
    raw.address,
    raw.street2,
    [raw.city, raw.state, raw.zip].filter(Boolean).join(', '),
    raw.country,
  ].filter(part => Boolean(part && String(part).trim()));
  return parts.join('\n') || '—';
}

export function zohoDealerContactPerson(dealer: ZohoDealer): string {
  const primary = dealer.zohoPrimaryContact;
  if (primary?.name?.trim()) return primary.name.trim();
  const parts = [dealer.firstName, dealer.contactName].filter(Boolean);
  return parts[0]?.trim() || '—';
}

function cleanPhone(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === '—') return null;
  // Keep values that look like a phone (at least 8 digits).
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return trimmed;
}

/** Digits-only phone for courier APIs; null when missing / placeholder. */
export function phoneDigitsForCourier(value: string | null | undefined): string | null {
  const cleaned = cleanPhone(value);
  if (!cleaned) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 8) return null;
  // Prefer last 10 digits for Indian mobiles when longer (e.g. 91XXXXXXXXXX).
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Pull a phone-like token from free-form address / notes text. */
export function extractPhoneFromText(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const match = text.match(/(?:\+?\d[\d\s\-()]{7,}\d)/);
  return match ? cleanPhone(match[0]) : null;
}

/**
 * Receiver phone preference for logistics labels:
 * shipping address → billing address → contact person → anywhere else in dealer data.
 */
export function resolveReceiverPhone(dealer: ZohoDealer): string {
  const contactPersons = dealer.zohoContactPersons ?? [];
  const candidates: Array<string | null | undefined> = [
    dealer.zohoShippingAddressRaw?.phone,
    extractPhoneFromText(dealer.zohoShippingAddress ?? dealer.shippingAddress),
    dealer.zohoBillingAddressRaw?.phone,
    extractPhoneFromText(dealer.zohoBillingAddress ?? dealer.billingAddress),
    dealer.zohoPrimaryContact?.mobile,
    dealer.zohoPrimaryContact?.phone,
    ...contactPersons.flatMap(person => [person.mobile, person.phone]),
    dealer.mobile,
    dealer.whatsappNumber,
    dealer.alternateMobile,
    dealer.phone,
    extractPhoneFromText(dealer.zohoNotes),
  ];
  for (const value of candidates) {
    const phone = cleanPhone(value);
    if (phone) return phone;
  }
  return '—';
}

/** @deprecated Prefer resolveReceiverPhone — kept for existing imports. */
export function zohoDealerMobile(dealer: ZohoDealer): string {
  return resolveReceiverPhone(dealer);
}

/** Resolve phone from a persisted booking snapshot (same preference order). */
export function resolveReceiverPhoneFromSnapshot(dealer: LogisticsDealerSnapshot): string {
  const candidates: Array<string | null | undefined> = [
    dealer.shippingPhone,
    extractPhoneFromText(dealer.shippingAddress),
    dealer.billingPhone,
    extractPhoneFromText(dealer.billingAddress),
    dealer.mobile,
    extractPhoneFromText(dealer.contactPerson),
  ];
  for (const value of candidates) {
    const phone = cleanPhone(value);
    if (phone) return phone;
  }
  return '—';
}

export function zohoDealerDisplayName(dealer: ZohoDealer): string {
  return dealer.companyName?.trim() || dealer.contactName?.trim() || dealer.id;
}

export function zohoDealerToSnapshot(dealer: ZohoDealer): LogisticsDealerSnapshot {
  const shippingAddress = formatZohoAddressMultiline(
    dealer.zohoShippingAddress ?? dealer.shippingAddress,
    dealer.zohoShippingAddressRaw,
  );
  const billingAddress = formatZohoAddressMultiline(
    dealer.zohoBillingAddress ?? dealer.billingAddress,
    dealer.zohoBillingAddressRaw,
  );
  const destinationCity = (
    dealer.zohoShippingAddressRaw?.city
    || dealer.zohoBillingAddressRaw?.city
    || dealer.district
    || ''
  ).trim();

  const shippingPhone = cleanPhone(dealer.zohoShippingAddressRaw?.phone)
    || extractPhoneFromText(dealer.zohoShippingAddress ?? dealer.shippingAddress)
    || undefined;
  const billingPhone = cleanPhone(dealer.zohoBillingAddressRaw?.phone)
    || extractPhoneFromText(dealer.zohoBillingAddress ?? dealer.billingAddress)
    || undefined;

  return {
    zohoCustomerId: dealer.id,
    dealerId: dealer.portalUserId?.trim() || dealer.id,
    name: zohoDealerDisplayName(dealer),
    code: dealer.id,
    contactPerson: zohoDealerContactPerson(dealer),
    mobile: resolveReceiverPhone(dealer),
    ...(shippingPhone ? { shippingPhone } : {}),
    ...(billingPhone ? { billingPhone } : {}),
    shippingAddress,
    billingAddress,
    ...(destinationCity ? { destinationCity } : {}),
    ...(dealer.assignedStaffName?.trim()
      ? { assignedStaffName: dealer.assignedStaffName.trim() }
      : {}),
  };
}

export function resolveDeliveryAddress(
  dealer: LogisticsDealerSnapshot,
  kind: DeliveryAddressKind,
): string {
  const preferred = kind === 'billing' ? dealer.billingAddress : dealer.shippingAddress;
  if (!isPlaceholderLogisticsAddress(preferred)) return preferred.trim();
  const fallback = kind === 'billing' ? dealer.shippingAddress : dealer.billingAddress;
  if (!isPlaceholderLogisticsAddress(fallback)) return fallback.trim();
  return preferred?.trim() || fallback?.trim() || '—';
}

/** Collapse newlines/commas so invoice Ship To can match a dealer default tile. */
export function logisticsAddressKey(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/[,\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function logisticsAddressesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = logisticsAddressKey(a);
  const right = logisticsAddressKey(b);
  return Boolean(left && right && left === right);
}

export function hasExplicitDraftDeliveryAddress(value: string | null | undefined): boolean {
  return !isPlaceholderLogisticsAddress(value);
}

/**
 * Shipping-address phone wins over invoice-to / billing when they differ.
 * The same number is kept. When every candidate is missing, returns null.
 */
export function preferShippingPhone(
  candidates: Array<string | null | undefined>,
  billingPhone?: string | null,
): string | null {
  const billing = phoneDigitsForCourier(billingPhone);
  const phones: string[] = [];
  for (const value of candidates) {
    const phone = phoneDigitsForCourier(value);
    if (phone && !phones.includes(phone)) phones.push(phone);
  }
  if (!phones.length) return null;
  if (!billing) return phones[0];
  return phones.find(phone => phone !== billing) || phones[0];
}

/** Append a courier phone to an address line when the text does not already contain it. */
export function appendPhoneToAddressLine(
  address: string,
  phone: string | null | undefined,
): string {
  const text = address.replace(/\s+/g, ' ').trim();
  const digits = phoneDigitsForCourier(phone);
  if (!text) return digits || '';
  if (!digits || text.replace(/\D/g, '').includes(digits)) return text;
  return `${text}, ${digits}`;
}

/**
 * Consignee phone for the address selected in Deliver to.
 * A distinct invoice Ship To uses that document's shipping phone, not the
 * dealer's other address. Billing is used only when no shipping phone exists.
 */
export function resolveShippingConsigneePhone(
  draft: LogisticsDraftDeliveryFields & { customerPhone?: string | null },
  dealer?: LogisticsDealerSnapshot | null,
): string | null {
  const explicit = hasExplicitDraftDeliveryAddress(draft.deliveryAddress);
  const address = explicit
    ? String(draft.deliveryAddress).trim()
    : (dealer ? resolveDraftDeliveryAddress(dealer, draft) : '');
  const fromAddress = phoneDigitsForCourier(extractPhoneFromText(address));
  const fromDraft = phoneDigitsForCourier(draft.customerPhone);
  const dealerShip = dealer
    ? (
      phoneDigitsForCourier(dealer.shippingPhone)
      || phoneDigitsForCourier(extractPhoneFromText(dealer.shippingAddress))
    )
    : null;
  const dealerBill = dealer
    ? (
      phoneDigitsForCourier(dealer.billingPhone)
      || phoneDigitsForCourier(extractPhoneFromText(dealer.billingAddress))
    )
    : null;
  const profileFallback = dealer
    ? (
      phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(dealer))
      || phoneDigitsForCourier(dealer.mobile)
    )
    : null;

  if (!explicit && draft.deliveryAddressKind === 'billing') {
    return fromAddress || dealerBill || fromDraft || profileFallback;
  }

  const picked = preferShippingPhone(
    explicit
      ? [fromAddress, fromDraft]
      : [fromAddress, dealerShip, fromDraft],
    dealerBill,
  );
  return picked || fromDraft || profileFallback;
}

export type LogisticsDraftDeliveryFields = {
  deliveryAddressKind: DeliveryAddressKind;
  deliveryAddress?: string | null;
};

/**
 * Per-booking selected address wins (invoice Ship To). Dealer shipping/billing stay defaults.
 * Same preference as invoice display: document address, then dealer profile.
 */
export function resolveDraftDeliveryAddress(
  dealer: LogisticsDealerSnapshot | null | undefined,
  draft: LogisticsDraftDeliveryFields,
): string {
  if (hasExplicitDraftDeliveryAddress(draft.deliveryAddress)) {
    return String(draft.deliveryAddress).trim();
  }
  if (!dealer) return '—';
  return resolveDeliveryAddress(dealer, draft.deliveryAddressKind);
}

export function logisticsDealerHasDeliveryAddress(
  dealer: LogisticsDealerSnapshot,
  kind?: DeliveryAddressKind,
): boolean {
  if (kind) return !isPlaceholderLogisticsAddress(resolveDeliveryAddress(dealer, kind));
  return !isPlaceholderLogisticsAddress(dealer.shippingAddress)
    || !isPlaceholderLogisticsAddress(dealer.billingAddress);
}

export function zohoDealerHasLogisticsAddress(dealer: ZohoDealer): boolean {
  return logisticsDealerHasDeliveryAddress(zohoDealerToSnapshot(dealer));
}

/** Prefer the dealer record that actually has Zoho address detail. */
export function preferRicherZohoDealer(existing: ZohoDealer, incoming: ZohoDealer): ZohoDealer {
  const existingHas = zohoDealerHasLogisticsAddress(existing);
  const incomingHas = zohoDealerHasLogisticsAddress(incoming);
  if (incomingHas && !existingHas) return incoming;
  if (existingHas && !incomingHas) return existing;
  const existingDetail = Boolean(
    existing.zohoShippingAddressRaw
    || existing.zohoBillingAddressRaw
    || existing.zohoDetailSyncedAt
    || existing.zohoShippingAddress
    || existing.zohoBillingAddress,
  );
  const incomingDetail = Boolean(
    incoming.zohoShippingAddressRaw
    || incoming.zohoBillingAddressRaw
    || incoming.zohoDetailSyncedAt
    || incoming.zohoShippingAddress
    || incoming.zohoBillingAddress,
  );
  if (incomingDetail && !existingDetail) return incoming;
  if (existingDetail && !incomingDetail) return existing;
  return incoming;
}

/** Merge dealer lists without letting thin list-cache rows wipe address detail. */
export function mergeZohoDealerLists(current: ZohoDealer[], incoming: ZohoDealer[]): ZohoDealer[] {
  const byId = new Map(current.map(dealer => [dealer.id, dealer]));
  for (const dealer of incoming) {
    const prev = byId.get(dealer.id);
    byId.set(dealer.id, prev ? preferRicherZohoDealer(prev, dealer) : dealer);
  }
  const seen = new Set<string>();
  const out: ZohoDealer[] = [];
  for (const dealer of incoming) {
    const merged = byId.get(dealer.id);
    if (!merged || seen.has(dealer.id)) continue;
    out.push(merged);
    seen.add(dealer.id);
  }
  for (const dealer of current) {
    if (seen.has(dealer.id)) continue;
    out.push(dealer);
    seen.add(dealer.id);
  }
  return out;
}

export function preferredDeliveryAddressKind(
  dealer: LogisticsDealerSnapshot,
  current: DeliveryAddressKind = 'shipping',
): DeliveryAddressKind {
  if (!isPlaceholderLogisticsAddress(dealer.shippingAddress)) return 'shipping';
  if (!isPlaceholderLogisticsAddress(dealer.billingAddress)) return 'billing';
  return current;
}

/**
 * If the document address is a dealer default, use that tile and leave the snapshot unchanged.
 * A distinct invoice Ship To stays on the booking only.
 */
export function reconcileDocumentDeliveryAddress(
  dealer: LogisticsDealerSnapshot,
  documentAddress: string | null | undefined,
  currentKind: DeliveryAddressKind = 'shipping',
): { deliveryAddressKind: DeliveryAddressKind; deliveryAddress: string | null } {
  const selected = documentAddress?.trim() || '';
  if (isPlaceholderLogisticsAddress(selected)) {
    return {
      deliveryAddressKind: preferredDeliveryAddressKind(dealer, currentKind),
      deliveryAddress: null,
    };
  }
  if (logisticsAddressesMatch(selected, dealer.shippingAddress)) {
    return { deliveryAddressKind: 'shipping', deliveryAddress: null };
  }
  if (logisticsAddressesMatch(selected, dealer.billingAddress)) {
    return { deliveryAddressKind: 'billing', deliveryAddress: null };
  }
  return { deliveryAddressKind: currentKind, deliveryAddress: selected };
}

export function dealerMatchesLogisticsQuery(dealer: ZohoDealer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const snapshot = zohoDealerToSnapshot(dealer);
  const haystack = [
    snapshot.name,
    snapshot.code,
    snapshot.contactPerson,
    snapshot.mobile,
    dealer.email,
    dealer.zohoEmail,
    dealer.phone,
    snapshot.shippingAddress,
    snapshot.billingAddress,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}
