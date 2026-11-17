import type { ZohoDealer } from '../types/dealers';

export type DealerFieldSource = 'zoho' | 'overlay' | 'computed' | 'system';

export interface DealerFieldDefinition {
  key: string;
  label: string;
  source: DealerFieldSource;
  getValue: (dealer: ZohoDealer) => unknown;
}

export const DEALER_FIELD_SOURCE_LABELS: Record<DealerFieldSource, string> = {
  zoho: 'Zoho',
  overlay: 'Overlay',
  computed: 'Computed',
  system: 'System',
};

export const DEALER_FIELD_SECTIONS: { id: DealerFieldSource; title: string; hint: string }[] = [
  {
    id: 'zoho',
    title: 'Zoho (synced)',
    hint: 'Pulled from Zoho Inventory on sync',
  },
  {
    id: 'overlay',
    title: 'CRM overlay & local edits',
    hint: 'Imported from yesweighmomentumhub or edited in this app',
  },
  {
    id: 'computed',
    title: 'Derived',
    hint: 'Resolved from linked records',
  },
  {
    id: 'system',
    title: 'System metadata',
    hint: 'Firestore timestamps and internal flags',
  },
];

export const DEALER_FIELD_DEFINITIONS: DealerFieldDefinition[] = [
  { key: 'id', label: 'Zoho contact ID', source: 'zoho', getValue: d => d.id },
  { key: 'contactName', label: 'Display name', source: 'zoho', getValue: d => d.contactName },
  { key: 'companyName', label: 'Company name', source: 'zoho', getValue: d => d.companyName },
  { key: 'email', label: 'Email', source: 'zoho', getValue: d => d.email },
  { key: 'mobile', label: 'Mobile', source: 'zoho', getValue: d => d.mobile },
  { key: 'status', label: 'Zoho status', source: 'zoho', getValue: d => d.status },
  {
    key: 'outstandingReceivable',
    label: 'Outstanding receivable',
    source: 'zoho',
    getValue: d => d.outstandingReceivable,
  },
  {
    key: 'unusedCredits',
    label: 'Unused credits',
    source: 'zoho',
    getValue: d => d.unusedCredits,
  },
  { key: 'syncedAt', label: 'Last Zoho sync', source: 'zoho', getValue: d => d.syncedAt },
  { key: 'zohoGstNo', label: 'GST number', source: 'zoho', getValue: d => d.zohoGstNo },
  { key: 'zohoGstTreatment', label: 'GST treatment', source: 'zoho', getValue: d => d.zohoGstTreatment },
  { key: 'zohoPanNo', label: 'PAN', source: 'zoho', getValue: d => d.zohoPanNo },
  { key: 'zohoPlaceOfContactLabel', label: 'Place of supply', source: 'zoho', getValue: d => d.zohoPlaceOfContactLabel },
  { key: 'zohoBillingAddress', label: 'Billing address', source: 'zoho', getValue: d => d.zohoBillingAddress },
  { key: 'zohoShippingAddress', label: 'Shipping address', source: 'zoho', getValue: d => d.zohoShippingAddress },
  { key: 'zohoPaymentTermsLabel', label: 'Payment terms', source: 'zoho', getValue: d => d.zohoPaymentTermsLabel },
  { key: 'zohoCreditLimit', label: 'Credit limit', source: 'zoho', getValue: d => d.zohoCreditLimit },
  { key: 'zohoPricebookName', label: 'Price book', source: 'zoho', getValue: d => d.zohoPricebookName },
  { key: 'zohoOwnerName', label: 'Zoho owner', source: 'zoho', getValue: d => d.zohoOwnerName },
  { key: 'zohoPortalStatusLabel', label: 'Portal status', source: 'zoho', getValue: d => d.zohoPortalStatusLabel },
  { key: 'zohoDetailSyncedAt', label: 'Last Zoho detail sync', source: 'zoho', getValue: d => d.zohoDetailSyncedAt },

  { key: 'firstName', label: 'Contact first name', source: 'overlay', getValue: d => d.firstName },
  { key: 'phone', label: 'Phone', source: 'overlay', getValue: d => d.phone },
  { key: 'assignedStaffUid', label: 'Assigned staff UID', source: 'overlay', getValue: d => d.assignedStaffUid },
  { key: 'dealerStage', label: 'Dealer stage', source: 'overlay', getValue: d => d.dealerStage },
  { key: 'billingState', label: 'Billing state', source: 'overlay', getValue: d => d.billingState },
  { key: 'district', label: 'District', source: 'overlay', getValue: d => d.district },
  { key: 'zipCode', label: 'Pincode', source: 'overlay', getValue: d => d.zipCode },
  { key: 'categories', label: 'Categories', source: 'overlay', getValue: d => d.categories },
  { key: 'designation', label: 'Designation', source: 'overlay', getValue: d => d.designation },
  { key: 'alternateMobile', label: 'Alternate mobile', source: 'overlay', getValue: d => d.alternateMobile },
  { key: 'whatsappNumber', label: 'WhatsApp', source: 'overlay', getValue: d => d.whatsappNumber },
  { key: 'dealerType', label: 'Dealer type', source: 'overlay', getValue: d => d.dealerType },
  { key: 'firmType', label: 'Firm type', source: 'overlay', getValue: d => d.firmType },
  { key: 'creditLimit', label: 'Credit limit', source: 'overlay', getValue: d => d.creditLimit },
  { key: 'priceLevel', label: 'Price level', source: 'overlay', getValue: d => d.priceLevel },
  { key: 'googleMapsUrl', label: 'Google Maps', source: 'overlay', getValue: d => d.googleMapsUrl },
  { key: 'canBuySpares', label: 'Can buy spares', source: 'overlay', getValue: d => d.canBuySpares },
  { key: 'orderPayOffline', label: 'Pay offline', source: 'overlay', getValue: d => d.orderPayOffline },
  { key: 'orderPayOnline', label: 'Pay online', source: 'overlay', getValue: d => d.orderPayOnline },
  { key: 'adminApprovalRequired', label: 'Admin approval', source: 'overlay', getValue: d => d.adminApprovalRequired },
  { key: 'maxOrderLimit', label: 'Max order limit', source: 'overlay', getValue: d => d.maxOrderLimit },
  { key: 'isFiltered', label: 'Filtered / hidden', source: 'overlay', getValue: d => d.isFiltered },
  { key: 'filterReason', label: 'Filter reason', source: 'overlay', getValue: d => d.filterReason },
  { key: 'portalUserId', label: 'Portal user ID', source: 'overlay', getValue: d => d.portalUserId },

  { key: 'assignedStaffName', label: 'KAM', source: 'computed', getValue: d => d.assignedStaffName },
  { key: 'portalUserName', label: 'Portal user name', source: 'computed', getValue: d => d.portalUserName },
  { key: 'portalLoginId', label: 'Portal login ID', source: 'computed', getValue: d => d.portalLoginId },
  { key: 'signedIn', label: 'Signed in to portal', source: 'computed', getValue: d => d.signedIn },

  { key: 'createdAt', label: 'Created at', source: 'system', getValue: d => d.createdAt ?? null },
  { key: 'updatedAt', label: 'Updated at', source: 'system', getValue: d => d.updatedAt ?? null },
];

export function formatDealerFieldValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString('en-IN') : '—';
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '—';
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    }
    return value;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function fieldsForSource(source: DealerFieldSource): DealerFieldDefinition[] {
  return DEALER_FIELD_DEFINITIONS.filter(field => field.source === source);
}
