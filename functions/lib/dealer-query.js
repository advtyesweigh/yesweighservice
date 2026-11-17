const INDIA_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Daman & Diu',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

const INDIA_STATE_ALIASES = {
  orissa: 'Odisha',
  uttaranchal: 'Uttarakhand',
  pondicherry: 'Puducherry',
  pondichery: 'Puducherry',
  delhi: 'Delhi',
  'delhi nct': 'Delhi',
  'nct of delhi': 'Delhi',
  'nct delhi': 'Delhi',
  'new delhi': 'Delhi',
  nct: 'Delhi',
  'jammu kashmir': 'Jammu and Kashmir',
  jk: 'Jammu and Kashmir',
  ladakh: 'Ladakh',
  'andaman nicobar': 'Andaman and Nicobar Islands',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'dadra nagar haveli': 'Daman & Diu',
  'dadra and nagar haveli': 'Daman & Diu',
  'dadra and nagar haveli and daman and diu': 'Daman & Diu',
  'daman diu': 'Daman & Diu',
  'daman and diu': 'Daman & Diu',
  dnhdd: 'Daman & Diu',
  dnh: 'Daman & Diu',
  tamilnadu: 'Tamil Nadu',
  tn: 'Tamil Nadu',
  kerla: 'Kerala',
  karnatka: 'Karnataka',
  maharastra: 'Maharashtra',
  maharasthra: 'Maharashtra',
  mh: 'Maharashtra',
  'west bangal': 'West Bengal',
  westbengal: 'West Bengal',
  wb: 'West Bengal',
  uttarpradesh: 'Uttar Pradesh',
  up: 'Uttar Pradesh',
  mp: 'Madhya Pradesh',
  andhrapradesh: 'Andhra Pradesh',
  ap: 'Andhra Pradesh',
  telengana: 'Telangana',
  ts: 'Telangana',
  tg: 'Telangana',
  gj: 'Gujarat',
  rj: 'Rajasthan',
  br: 'Bihar',
  od: 'Odisha',
  pb: 'Punjab',
  hr: 'Haryana',
  chattisgarh: 'Chhattisgarh',
  chhatisgarh: 'Chhattisgarh',
  cg: 'Chhattisgarh',
  jh: 'Jharkhand',
  ga: 'Goa',
  himachal: 'Himachal Pradesh',
  hp: 'Himachal Pradesh',
  kl: 'Kerala',
  ka: 'Karnataka',
};

const KERALA_DISTRICTS = [
  'Kasaragod',
  'Kannur',
  'Wayanad',
  'Kozhikode',
  'Malappuram',
  'Palakkad',
  'Thrissur',
  'Ernakulam',
  'Idukki',
  'Kottayam',
  'Alappuzha',
  'Pathanamthitta',
  'Kollam',
  'Thiruvananthapuram',
];

const KERALA_DISTRICT_ALIASES = {
  trivandrum: 'Thiruvananthapuram',
  tvm: 'Thiruvananthapuram',
  calicut: 'Kozhikode',
  koozhikode: 'Kozhikode',
  clt: 'Kozhikode',
  cochin: 'Ernakulam',
  kochi: 'Ernakulam',
  ekm: 'Ernakulam',
  quilon: 'Kollam',
  kottarakkara: 'Kollam',
  kottarakara: 'Kollam',
  cannanore: 'Kannur',
  palghat: 'Palakkad',
  trichur: 'Thrissur',
  allepey: 'Alappuzha',
  alleppey: 'Alappuzha',
  wynad: 'Wayanad',
  kasargod: 'Kasaragod',
  pta: 'Pathanamthitta',
  thiruvalla: 'Pathanamthitta',
  malapuram: 'Malappuram',
  thodupuzha: 'Idukki',
};

function normLocationKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripLocationNumberPrefix(raw) {
  return String(raw ?? '')
    .replace(/^[\s\u00a0\u2060]*\d+[\s\u00a0\u2060]*[.)][\s\u00a0\u2060]*/u, '')
    .trim();
}

function canonicalIndiaState(raw) {
  const key = normLocationKey(stripLocationNumberPrefix(raw));
  if (!key) return '';
  if (INDIA_STATE_ALIASES[key]) return INDIA_STATE_ALIASES[key];
  const exact = INDIA_STATES.find(name => normLocationKey(name) === key);
  return exact || '';
}

function isKeralaBillingState(state) {
  return canonicalIndiaState(state) === 'Kerala';
}

function canonicalKeralaDistrict(raw) {
  const key = normLocationKey(stripLocationNumberPrefix(raw));
  if (!key) return '';
  if (KERALA_DISTRICT_ALIASES[key]) return KERALA_DISTRICT_ALIASES[key];
  const exact = KERALA_DISTRICTS.find(name => normLocationKey(name) === key);
  return exact || '';
}

function parseListParam(value) {
  if (!value || value === 'all') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function getDealerStatusKey(dealer) {
  const stage = dealer.dealerStage;
  const signed = Boolean(dealer.portalUserId);
  if (stage === 'Active') return signed ? 'active-yes' : 'active-no';
  if (stage === 'Non Active') return signed ? 'non-active-yes' : 'non-active-no';
  if (stage === 'Black listed' || stage === 'Blacklisted') {
    return signed ? 'blacklisted-yes' : 'blacklisted-no';
  }
  return signed ? 'unset-yes' : 'unset-no';
}

function normalizeCategories(categories) {
  if (!categories) return [];
  if (Array.isArray(categories)) return categories.map(String);
  try {
    const parsed = JSON.parse(categories);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [String(categories)];
  }
}

export function filterDealers(dealers, query = {}) {
  let list = [...dealers];

  const explicitStageFilter = query.dealerStage && query.dealerStage !== 'all'
    && parseListParam(query.dealerStage).length > 0;
  const explicitStatusFilter = query.dealerStatus
    && parseListParam(query.dealerStatus).length > 0;

  if (!explicitStageFilter && !explicitStatusFilter) {
    const isFiltered = query.isFiltered === true || query.isFiltered === 'true';
    list = list.filter(d => Boolean(d.isFiltered) === isFiltered);
    if (isFiltered) {
      list = list.filter(d => d.filterReason === 'Manual');
    }
  }

  if (query.q?.trim()) {
    const q = query.q.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    list = list.filter(d => {
      const nameHit = String(d.contactName ?? '').toLowerCase().includes(q)
        || String(d.companyName ?? '').toLowerCase().includes(q)
        || String(d.email ?? '').toLowerCase().includes(q);
      if (nameHit) return true;
      if (qDigits.length < 4) return false;
      const phones = [d.phone, d.mobile, d.alternateMobile, d.whatsappNumber]
        .map(value => String(value ?? '').replace(/\D/g, ''))
        .filter(Boolean);
      return phones.some(phone => (
        phone.includes(qDigits)
        || (qDigits.length >= 10 && phone.slice(-10) === qDigits.slice(-10))
      ));
    });
  }

  if (query.status && query.status !== 'all') {
    list = list.filter(d => d.status === query.status);
  }

  const staffIds = parseListParam(query.assignedStaffUid);
  if (staffIds.length > 0) {
    if (staffIds.includes('unassigned')) {
      const assigned = staffIds.filter(a => a !== 'unassigned');
      list = list.filter(d =>
        !d.assignedStaffUid || assigned.includes(d.assignedStaffUid),
      );
    } else {
      list = list.filter(d => d.assignedStaffUid && staffIds.includes(d.assignedStaffUid));
    }
  }

  const stages = parseListParam(query.dealerStage);
  if (stages.length > 0) {
    list = list.filter(d => d.dealerStage && stages.includes(d.dealerStage));
  }

  const statusKeys = parseListParam(query.dealerStatus);
  if (statusKeys.length > 0) {
    list = list.filter(d => statusKeys.includes(getDealerStatusKey(d)));
  }

  const states = parseListParam(query.billingState);
  if (states.length > 0) {
    const wanted = new Set(states);
    list = list.filter(d => {
      const raw = String(d.billingState ?? '').trim();
      if (!raw) return false;
      if (wanted.has(raw)) return true;
      const canon = canonicalIndiaState(raw);
      return Boolean(canon) && wanted.has(canon);
    });
  }

  const districts = parseListParam(query.district);
  if (districts.length > 0) {
    const wanted = new Set(districts);
    list = list.filter(d => {
      const raw = String(d.district ?? '').trim();
      if (!raw) return false;
      if (wanted.has(raw)) return true;
      const canon = canonicalKeralaDistrict(raw);
      return Boolean(canon) && wanted.has(canon);
    });
  }

  const cats = parseListParam(query.categories);
  if (cats.length > 0) {
    list = list.filter(d => {
      const rowCats = normalizeCategories(d.categories);
      return cats.some(c => rowCats.includes(c));
    });
  }

  if (query.signedIn === 'true') {
    list = list.filter(d => Boolean(d.portalUserId));
  } else if (query.signedIn === 'false') {
    list = list.filter(d => !d.portalUserId);
  }

  return list;
}

export function sortDealers(dealers, sortField = 'contactName', sortDir = 'asc') {
  const dir = sortDir === 'desc' ? -1 : 1;
  const field = sortField || 'contactName';

  return [...dealers].sort((a, b) => {
    if (field === 'phone') {
      const av = String(a.phone || a.mobile || '');
      const bv = String(b.phone || b.mobile || '');
      return av.localeCompare(bv) * dir;
    }
    const av = a[field] ?? '';
    const bv = b[field] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

export function paginateDealers(dealers, page = 1, limit = 50) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;
  return {
    data: dealers.slice(skip, skip + safeLimit),
    pagination: {
      total: dealers.length,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(dealers.length / safeLimit) || 1,
    },
  };
}

export function dealerStats(dealers) {
  const roster = dealers.filter(d => !d.isFiltered);
  const counts = { active: 0, nonActive: 0, blacklisted: 0, unstaged: 0 };

  for (const dealer of roster) {
    const bucket = classifyDealerStageBucket(dealer.dealerStage);
    counts[bucket] += 1;
  }

  const total = counts.active + counts.nonActive + counts.blacklisted;

  return {
    total,
    active: counts.active,
    nonActive: counts.nonActive,
    blacklisted: counts.blacklisted,
    unstaged: counts.unstaged,
    unassignedStaff: roster.filter(d => !d.assignedStaffUid).length,
  };
}

function classifyDealerStageBucket(stage) {
  if (!stage || typeof stage !== 'string') return 'unstaged';
  const normalized = stage.trim();
  if (normalized === 'Active') return 'active';
  if (normalized === 'Non Active') return 'nonActive';
  if (normalized === 'Blacklisted' || normalized === 'Black listed') return 'blacklisted';
  return 'unstaged';
}

export function dealerLocations(dealers) {
  const active = dealers.filter(d => !d.isFiltered);
  const states = [...INDIA_STATES];
  const districtsByState = {};
  for (const state of states) {
    if (isKeralaBillingState(state)) {
      districtsByState[state] = [...KERALA_DISTRICTS];
      continue;
    }
    districtsByState[state] = Array.from(new Set(
      active
        .filter(d => canonicalIndiaState(d.billingState) === state && d.district)
        .map(d => d.district),
    )).sort((a, b) => String(a).localeCompare(String(b)));
  }
  return { states, districtsByState };
}

export function dealersToCsv(dealers) {
  const headers = ['Dealer Name', 'Contact', 'Phone', 'Assigned Staff', 'State', 'District', 'Categories', 'Stage', 'Signed In'];
  const escapeCsv = str => {
    if (str == null || str === '') return '';
    return `"${String(str).replace(/"/g, '""')}"`;
  };

  const rows = [headers.join(',')];
  for (const d of dealers) {
    const cats = normalizeCategories(d.categories);
    const name = d.contactName || d.companyName;
    const phone = d.phone || d.mobile || '';
    const staff = d.assignedStaffName || '';
    rows.push([
      escapeCsv(name),
      escapeCsv(d.firstName || ''),
      escapeCsv(phone),
      escapeCsv(staff),
      escapeCsv(d.billingState || ''),
      escapeCsv(d.district || ''),
      escapeCsv(cats.join(' | ')),
      escapeCsv(d.dealerStage || ''),
      escapeCsv(d.portalUserId ? 'Yes' : 'No'),
    ].join(','));
  }
  return rows.join('\n');
}

const KNOWN_DEALER_DOC_KEYS = new Set([
  'id',
  'contactName',
  'firstName',
  'companyName',
  'email',
  'zohoEmail',
  'phone',
  'mobile',
  'status',
  'outstandingReceivable',
  'unusedCredits',
  'syncedAt',
  'isFiltered',
  'filterReason',
  'assignedStaffUid',
  'assignedStaffName',
  'dealerStage',
  'billingState',
  'district',
  'zipCode',
  'categories',
  'portalUserId',
  'createdAt',
  'updatedAt',
  'designation',
  'alternateMobile',
  'whatsappNumber',
  'dealerType',
  'firmType',
  'creditLimit',
  'priceLevel',
  'billingAddress',
  'shippingAddress',
  'googleMapsUrl',
  'canBuySpares',
  'orderPayOffline',
  'orderPayOnline',
  'adminApprovalRequired',
  'maxOrderLimit',
  'zohoGstNo',
  'zohoGstTreatment',
  'zohoTaxpayerType',
  'zohoConstitutionOfBusiness',
  'zohoPanNo',
  'zohoPlaceOfContact',
  'zohoPlaceOfContactLabel',
  'zohoPaymentTermsLabel',
  'zohoCurrencyCode',
  'zohoPortalStatus',
  'zohoPortalStatusLabel',
  'zohoWebsite',
  'zohoCustomFields',
  'zohoTags',
  'zohoCreatedTime',
  'zohoLastModifiedTime',
  'zohoCustomerSubType',
  'zohoCustomerCreditLimit',
  'zohoLegalName',
  'zohoBillingAddress',
  'zohoShippingAddress',
  'zohoBillingAddressRaw',
  'zohoShippingAddressRaw',
  'zohoContactPersons',
  'zohoPrimaryContact',
  'zohoCreditLimit',
  'zohoPricebookName',
  'zohoOwnerName',
  'zohoTaxName',
  'zohoTaxPercentage',
  'zohoBranchName',
  'zohoLocationName',
  'zohoNotes',
  'zohoIsLinkedWithZohoCrm',
  'zohoPrimaryContactId',
  'zohoHasTransaction',
  'zohoDetailSyncedAt',
]);

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return String(value);
}

function serializeFirestoreValue(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeFirestoreValue);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = serializeFirestoreValue(nested);
    }
    return out;
  }
  return value;
}

export function mapDealerForClient(dealer, _ignoredKamsById, usersById) {
  const portalUser = dealer.portalUserId ? usersById.get(dealer.portalUserId) : null;
  const assignedStaff = dealer.assignedStaffUid ? usersById.get(dealer.assignedStaffUid) : null;
  const primary = dealer.zohoPrimaryContact;
  const mobile = dealer.mobile
    ?? primary?.mobile
    ?? null;
  return {
    id: dealer.id,
    contactName: dealer.contactName ?? '',
    firstName: dealer.firstName ?? null,
    companyName: dealer.companyName ?? null,
    email: dealer.email ?? null,
    zohoEmail: dealer.zohoEmail ?? dealer.email ?? null,
    phone: dealer.phone ?? null,
    mobile,
    status: dealer.status ?? 'active',
    outstandingReceivable: Number(dealer.outstandingReceivable ?? 0),
    unusedCredits: Number(dealer.unusedCredits ?? 0),
    syncedAt: dealer.syncedAt ?? null,
    isFiltered: Boolean(dealer.isFiltered),
    filterReason: dealer.filterReason ?? null,
    assignedStaffUid: dealer.assignedStaffUid ?? null,
    assignedStaffName: dealer.assignedStaffName
      ?? (assignedStaff?.displayName ? String(assignedStaff.displayName) : null),
    dealerStage: dealer.dealerStage ?? null,
    billingState: dealer.billingState ?? null,
    district: dealer.district ?? null,
    zipCode: dealer.zipCode ?? null,
    categories: normalizeCategories(dealer.categories),
    portalUserId: dealer.portalUserId ?? null,
    portalUserName: portalUser?.displayName ?? null,
    portalLoginId: portalUser?.loginId ?? null,
    signedIn: Boolean(dealer.portalUserId),
    designation: dealer.designation ?? null,
    alternateMobile: dealer.alternateMobile ?? null,
    whatsappNumber: dealer.whatsappNumber ?? null,
    dealerType: dealer.dealerType ?? null,
    firmType: dealer.firmType ?? null,
    creditLimit: dealer.creditLimit != null ? Number(dealer.creditLimit) : null,
    priceLevel: dealer.priceLevel ?? null,
    billingAddress: dealer.billingAddress ?? null,
    shippingAddress: dealer.shippingAddress ?? null,
    googleMapsUrl: dealer.googleMapsUrl ?? null,
    canBuySpares: dealer.canBuySpares !== false,
    orderPayOffline: dealer.orderPayOffline !== false,
    orderPayOnline: Boolean(dealer.orderPayOnline),
    adminApprovalRequired: Boolean(dealer.adminApprovalRequired),
    maxOrderLimit: dealer.maxOrderLimit != null ? Number(dealer.maxOrderLimit) : null,
    zohoGstNo: dealer.zohoGstNo ?? null,
    zohoGstTreatment: dealer.zohoGstTreatment ?? null,
    zohoTaxpayerType: dealer.zohoTaxpayerType ?? null,
    zohoConstitutionOfBusiness: dealer.zohoConstitutionOfBusiness ?? null,
    zohoPanNo: dealer.zohoPanNo ?? null,
    zohoPlaceOfContact: dealer.zohoPlaceOfContact ?? null,
    zohoPlaceOfContactLabel: dealer.zohoPlaceOfContactLabel ?? null,
    zohoPaymentTermsLabel: dealer.zohoPaymentTermsLabel ?? null,
    zohoCurrencyCode: dealer.zohoCurrencyCode ?? null,
    zohoPortalStatus: dealer.zohoPortalStatus ?? null,
    zohoPortalStatusLabel: dealer.zohoPortalStatusLabel ?? null,
    zohoWebsite: dealer.zohoWebsite ?? null,
    zohoCustomFields: Array.isArray(dealer.zohoCustomFields) ? dealer.zohoCustomFields : [],
    zohoTags: Array.isArray(dealer.zohoTags) ? dealer.zohoTags.map(String) : [],
    zohoCreatedTime: dealer.zohoCreatedTime ?? null,
    zohoLastModifiedTime: dealer.zohoLastModifiedTime ?? null,
    zohoCustomerSubType: dealer.zohoCustomerSubType ?? null,
    zohoCustomerCreditLimit: dealer.zohoCustomerCreditLimit != null
      ? Number(dealer.zohoCustomerCreditLimit)
      : null,
    zohoLegalName: dealer.zohoLegalName ?? null,
    zohoBillingAddress: dealer.zohoBillingAddress ?? null,
    zohoShippingAddress: dealer.zohoShippingAddress ?? null,
    zohoBillingAddressRaw: dealer.zohoBillingAddressRaw ?? null,
    zohoShippingAddressRaw: dealer.zohoShippingAddressRaw ?? null,
    zohoContactPersons: Array.isArray(dealer.zohoContactPersons)
      ? dealer.zohoContactPersons.map(serializeFirestoreValue)
      : [],
    zohoPrimaryContact: dealer.zohoPrimaryContact
      ? serializeFirestoreValue(dealer.zohoPrimaryContact)
      : null,
    zohoCreditLimit: dealer.zohoCreditLimit != null ? Number(dealer.zohoCreditLimit) : null,
    zohoPricebookName: dealer.zohoPricebookName ?? null,
    zohoOwnerName: dealer.zohoOwnerName ?? null,
    zohoTaxName: dealer.zohoTaxName ?? null,
    zohoTaxPercentage: dealer.zohoTaxPercentage != null ? Number(dealer.zohoTaxPercentage) : null,
    zohoBranchName: dealer.zohoBranchName ?? null,
    zohoLocationName: dealer.zohoLocationName ?? null,
    zohoNotes: dealer.zohoNotes ?? null,
    zohoIsLinkedWithZohoCrm: Boolean(dealer.zohoIsLinkedWithZohoCrm),
    zohoPrimaryContactId: dealer.zohoPrimaryContactId ?? null,
    zohoHasTransaction: Boolean(dealer.zohoHasTransaction),
    zohoDetailSyncedAt: dealer.zohoDetailSyncedAt ?? null,
  };
}

export function mapDealerDetailForClient(dealer, kamsById, usersById) {
  const base = mapDealerForClient(dealer, kamsById, usersById);
  const extraFields = {};

  for (const [key, value] of Object.entries(dealer)) {
    if (key === 'id' || KNOWN_DEALER_DOC_KEYS.has(key)) continue;
    extraFields[key] = serializeFirestoreValue(value);
  }

  return {
    ...base,
    createdAt: serializeTimestamp(dealer.createdAt),
    updatedAt: serializeTimestamp(dealer.updatedAt),
    extraFields,
  };
}
