export type SoftwareStatusFilter = 'all' | 'active' | 'expiring' | 'expired';

export type SoftwareQuery = {
  search: string;
  status: SoftwareStatusFilter;
  subscription: string;
};

export const EMPTY_SOFTWARE_QUERY: SoftwareQuery = {
  search: '',
  status: 'all',
  subscription: '',
};

export const SOFTWARE_STATUS_FILTERS: { id: SoftwareStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'expiring', label: 'Expiring soon' },
  { id: 'expired', label: 'Expired' },
];

export const SOFTWARE_EXPIRING_SOON_DAYS = 14;

/** Loose row shape so Sanoft sync can fill this without a page rewrite. */
export type SoftwareLicenseLike = {
  name?: string;
  customerName?: string;
  companyName?: string;
  email?: string;
  productName?: string;
  serial?: string;
  licenseKey?: string;
  subscription?: string;
  plan?: string;
  planName?: string;
  status?: string;
  expiresAt?: string;
  expiryDate?: string;
  validTill?: string;
  endDate?: string;
};

export function softwareSubscription(row: SoftwareLicenseLike): string {
  return (row.subscription || row.plan || row.planName || '').trim();
}

export function uniqueSoftwareSubscriptions(rows: SoftwareLicenseLike[]): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const value = softwareSubscription(row);
    if (value) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'en-IN'));
}

function parseExpiry(row: SoftwareLicenseLike): number | null {
  const raw = row.expiresAt || row.expiryDate || row.validTill || row.endDate || '';
  if (!raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function softwareStatus(
  row: SoftwareLicenseLike,
  now = Date.now(),
): Exclude<SoftwareStatusFilter, 'all'> {
  const expiry = parseExpiry(row);
  if (expiry != null) {
    if (expiry < now) return 'expired';
    const soon = now + SOFTWARE_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
    if (expiry <= soon) return 'expiring';
    return 'active';
  }
  const status = (row.status || '').toLowerCase();
  if (status.includes('expired')) return 'expired';
  if (status.includes('expir')) return 'expiring';
  if (status.includes('inactive') || status.includes('cancel')) return 'expired';
  return 'active';
}

function haystack(row: SoftwareLicenseLike): string {
  return [
    row.name,
    row.customerName,
    row.companyName,
    row.email,
    row.productName,
    row.serial,
    row.licenseKey,
    softwareSubscription(row),
    row.status,
  ].join(' ').toLowerCase();
}

export function filterSoftwareLicenses(
  rows: SoftwareLicenseLike[],
  query: SoftwareQuery,
  now = Date.now(),
): SoftwareLicenseLike[] {
  const terms = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    if (query.status !== 'all' && softwareStatus(row, now) !== query.status) return false;
    if (query.subscription && softwareSubscription(row) !== query.subscription) return false;
    if (terms.length && !terms.every(term => haystack(row).includes(term))) return false;
    return true;
  });
}
