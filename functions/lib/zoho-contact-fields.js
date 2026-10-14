/** Map Zoho Inventory contact API payloads to read-only Firestore fields. */
import { canonicalGstState } from './location-utils.js';

export const ZOHO_ADDRESS_LINE_MAX = 100;

function splitAtBoundary(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return { head: value, tail: '' };
  const slice = value.slice(0, max);
  const breakAt = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf(' '));
  const at = breakAt >= Math.floor(max * 0.55) ? breakAt : max;
  return {
    head: value.slice(0, at).replace(/[,\s]+$/g, '').trim(),
    tail: value.slice(at).replace(/^[,\s]+/g, '').trim(),
  };
}

function capField(value, max = ZOHO_ADDRESS_LINE_MAX) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** Zoho Inventory address / street2 are each max 100 characters. */
export function fitZohoAddressLines(input = {}) {
  const first = splitAtBoundary(input.address || input.street, ZOHO_ADDRESS_LINE_MAX);
  const secondRaw = [first.tail, String(input.street2 || '').replace(/\s+/g, ' ').trim()]
    .filter(Boolean)
    .join(', ');
  const second = splitAtBoundary(secondRaw, ZOHO_ADDRESS_LINE_MAX);
  return {
    attention: capField(input.attention),
    address: first.head,
    street2: second.head,
    city: capField(input.city),
    state: capField(canonicalGstState(input.state) || input.state),
    zip: String(input.zip || '').replace(/\s+/g, '').slice(0, 12),
    country: capField(input.country || 'India') || 'India',
    phone: capField(input.phone, 50),
  };
}

export function formatZohoAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const parts = [
    addr.attention,
    addr.address,
    addr.street2,
    addr.city,
    addr.state,
    addr.zip,
    addr.country,
  ].filter(Boolean);
  if (!parts.length) return null;
  return parts.join(', ').replace(/\n/g, ', ');
}

export function extractZohoListFields(c) {
  if (!c || typeof c !== 'object') return {};
  return {
    zohoGstNo: c.gst_no ? String(c.gst_no) : null,
    zohoGstTreatment: c.gst_treatment ? String(c.gst_treatment) : null,
    zohoPanNo: c.pan_no ? String(c.pan_no) : null,
    zohoPlaceOfContact: c.place_of_contact ? String(c.place_of_contact) : null,
    zohoPlaceOfContactLabel: c.place_of_contact_formatted
      ? String(c.place_of_contact_formatted)
      : null,
    zohoPaymentTermsLabel: c.payment_terms_label ? String(c.payment_terms_label) : null,
    zohoCurrencyCode: c.currency_code ? String(c.currency_code) : null,
    zohoPortalStatus: c.portal_status ? String(c.portal_status) : null,
    zohoPortalStatusLabel: c.portal_status_formatted
      ? String(c.portal_status_formatted)
      : null,
    zohoWebsite: c.website ? String(c.website) : null,
    zohoCustomFields: Array.isArray(c.custom_fields) ? c.custom_fields : [],
    zohoTags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    zohoCreatedTime: c.created_time ? String(c.created_time) : null,
    zohoLastModifiedTime: c.last_modified_time ? String(c.last_modified_time) : null,
    zohoCustomerSubType: c.customer_sub_type ? String(c.customer_sub_type) : null,
    zohoCustomerCreditLimit: c.customer_credit_limit !== '' && c.customer_credit_limit != null
      ? Number(c.customer_credit_limit)
      : null,
  };
}

function mapContactPerson(p) {
  const name = [p.salutation, p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  return {
    id: p.contact_person_id ? String(p.contact_person_id) : null,
    salutation: p.salutation || null,
    firstName: p.first_name || null,
    lastName: p.last_name || null,
    name: name || null,
    email: p.email || null,
    phone: p.phone || null,
    mobile: p.mobile || null,
    designation: p.designation || null,
    department: p.department || null,
    isPrimary: Boolean(p.is_primary_contact),
    isAddedInPortal: Boolean(p.is_added_in_portal),
  };
}

export function extractZohoDetailFields(contact) {
  if (!contact || typeof contact !== 'object') return {};
  const listFields = extractZohoListFields(contact);
  const contactPersons = (contact.contact_persons ?? []).map(mapContactPerson);
  const primaryPerson = contactPersons.find(p => p.isPrimary) ?? contactPersons[0] ?? null;

  return {
    ...listFields,
    zohoLegalName: contact.legal_name ? String(contact.legal_name) : null,
    zohoBillingAddress: formatZohoAddress(contact.billing_address),
    zohoShippingAddress: formatZohoAddress(contact.shipping_address),
    zohoBillingAddressRaw: contact.billing_address ?? null,
    zohoShippingAddressRaw: contact.shipping_address ?? null,
    zohoContactPersons: contactPersons,
    zohoPrimaryContact: primaryPerson,
    zohoCreditLimit: contact.credit_limit != null ? Number(contact.credit_limit) : null,
    zohoPricebookName: contact.pricebook_name ? String(contact.pricebook_name) : null,
    zohoOwnerName: contact.owner_name ? String(contact.owner_name) : null,
    zohoTaxName: contact.tax_name ? String(contact.tax_name) : null,
    zohoTaxPercentage: contact.tax_percentage != null ? Number(contact.tax_percentage) : null,
    zohoBranchName: contact.branch_name ? String(contact.branch_name) : null,
    zohoLocationName: contact.location_name ? String(contact.location_name) : null,
    zohoNotes: contact.notes ? String(contact.notes) : null,
    zohoIsLinkedWithZohoCrm: Boolean(contact.is_linked_with_zohocrm),
    zohoPrimaryContactId: contact.primary_contact_id
      ? String(contact.primary_contact_id)
      : null,
    zohoHasTransaction: Boolean(contact.has_transaction),
    zohoDetailSyncedAt: new Date().toISOString(),
  };
}

export function extractZohoCoreFields(contact) {
  if (!contact || typeof contact !== 'object') return {};
  const contactPersons = (contact.contact_persons ?? []).map(mapContactPerson);
  const primaryPerson = contactPersons.find(p => p.isPrimary) ?? contactPersons[0] ?? null;
  // Prefer contact-person mobile (login number) over company/shipping phone.
  const mobile = contact.mobile
    ? String(contact.mobile)
    : (primaryPerson?.mobile ? String(primaryPerson.mobile) : null);
  return {
    contactName: String(contact.contact_name || ''),
    companyName: contact.company_name ? String(contact.company_name) : null,
    email: contact.email ? String(contact.email) : null,
    phone: contact.phone ? String(contact.phone) : null,
    mobile,
    firstName: contact.first_name ? String(contact.first_name) : null,
    status: String(contact.status || 'active'),
    outstandingReceivable: Number(contact.outstanding_receivable_amount) || 0,
    unusedCredits: Number(contact.unused_credits_receivable_amount) || 0,
  };
}
