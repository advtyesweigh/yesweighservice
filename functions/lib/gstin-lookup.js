import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { authHeaders, ZOHO_API_BASE } from './zoho.js';
import { canonicalGstState } from './location-utils.js';

const COLLECTION = 'gstinPlaces';
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const GSTN_SEARCH = 'https://blog-backend.mastersindia.co/api/v1/custom/search/name_and_pan/';
const ZOHO_BOOKS_API_BASE = 'https://www.zohoapis.in/books/v3';
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const GSTIN_STATE_NAMES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

function normalizeGstin(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

function isValidGstin(value) {
  return GSTIN_FORMAT.test(normalizeGstin(value));
}

function pickText(...values) {
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function filled(value, fallback = '') {
  return pickText(value) || pickText(fallback);
}

function pickAddress(row) {
  const raw = row?.pradr ?? row?.principal_place_of_business ?? row?.address ?? row?.addr
    ?? row?.billing_address ?? {};
  if (!raw || typeof raw !== 'object') return {};
  if (raw.addr && typeof raw.addr === 'object') return raw.addr;
  return raw;
}

function mapGstTreatment(taxpayerType, gstTreatment) {
  const fromZoho = pickText(gstTreatment);
  if (fromZoho) return fromZoho;
  const raw = pickText(taxpayerType).toLowerCase();
  if (!raw) return 'business_gst';
  if (raw.includes('comp') || raw === 'com') return 'business_registered_composition';
  if (raw.includes('sez')) return 'sez';
  if (raw.includes('unreg') || raw.includes('none') || raw.includes('consumer')) return 'business_none';
  if (raw.includes('over') || raw.includes('import') || raw.includes('export')) return 'overseas';
  return 'business_gst';
}

function emptyDetails(gstin) {
  return {
    gstin,
    companyName: '',
    legalName: '',
    tradeName: '',
    gstTreatment: '',
    taxpayerType: '',
    constitutionOfBusiness: '',
    state: '',
    district: '',
    city: '',
    zip: '',
    address: '',
    street2: '',
    phone: '',
    source: '',
  };
}

function mergeDetails(...rows) {
  return rows.filter(Boolean).reduce((acc, row) => ({
    gstin: acc.gstin || row.gstin,
    companyName: filled(acc.companyName, row.companyName),
    legalName: filled(acc.legalName, row.legalName),
    tradeName: filled(acc.tradeName, row.tradeName),
    gstTreatment: filled(acc.gstTreatment, row.gstTreatment),
    taxpayerType: filled(acc.taxpayerType, row.taxpayerType),
    constitutionOfBusiness: filled(acc.constitutionOfBusiness, row.constitutionOfBusiness),
    state: filled(acc.state, row.state),
    district: filled(acc.district, row.district),
    city: filled(acc.city, row.city),
    zip: filled(acc.zip, row.zip),
    address: filled(acc.address, row.address),
    street2: filled(acc.street2, row.street2),
    phone: filled(acc.phone, row.phone),
    source: filled(acc.source, row.source),
  }), emptyDetails(rows.find(row => row?.gstin)?.gstin || ''));
}

function unwrapGstinBlob(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.gstin_details
    || payload.gst_details
    || payload.gstinDetails
    || payload.taxpayer_details
    || payload.taxpayer
    || payload.data
    || payload.details
    || payload.contact
    || (payload.legal_name || payload.trade_name || payload.gstin ? payload : null);
}

function mapGstinBlob(blob, gstin, source) {
  const row = blob && typeof blob === 'object' ? blob : {};
  const addr = pickAddress(row);
  const legalName = pickText(
    row.legal_name,
    row.legalName,
    row.LegalName,
    row.taxpayer_name,
    row.business_legal_name,
    row.lgnm,
  );
  const tradeName = pickText(
    row.trade_name,
    row.tradeName,
    row.TradeName,
    row.business_name,
    row.trader_name,
    row.tradeNam,
    row.company_name,
    row.companyName,
    row.contact_name,
  );
  const taxpayerType = pickText(row.taxpayer_type, row.taxpayerType, row.TxpType, row.dty);
  const constitutionOfBusiness = pickText(
    row.constitution_of_business,
    row.constitutionOfBusiness,
    row.ctb,
    row.business_constitution,
  );
  const companyName = tradeName || legalName;
  if (!companyName) return null;
  const zip = pickText(addr.zip, addr.zipcode, addr.pincode, addr.pin_code, addr.pncd, row.pincode, row.pncd);
  const stateCode = /^\d{2}$/.test(pickText(addr.stcd)) ? pickText(addr.stcd) : '';
  const state = pickText(
    !stateCode ? addr.stcd : '',
    addr.state,
    row.state,
    GSTIN_STATE_NAMES[stateCode || gstin.slice(0, 2)],
  );
  const district = pickText(addr.dst, addr.district, row.dst, row.district);
  const city = pickText(addr.city, addr.st, addr.locality, addr.loc, row.city, district);
  const street2 = pickText(addr.street2, addr.landMark);
  const floor = pickText(addr.flno);
  const floorPart = floor && floor.toLowerCase() !== city.toLowerCase() ? floor : '';
  const address = pickText(
    [floorPart, addr.bno, addr.bnm].filter(Boolean).join(', '),
    [addr.bno, addr.bnm, addr.st, addr.loc, addr.dst].filter(Boolean).join(', '),
    addr.address,
    typeof row.pradr === 'string' ? row.pradr : '',
    typeof row.address === 'string' ? row.address : '',
  );
  return {
    ...emptyDetails(gstin),
    companyName,
    legalName: legalName || companyName,
    tradeName: tradeName || companyName,
    gstTreatment: mapGstTreatment(taxpayerType, row.gst_treatment || row.gstTreatment),
    taxpayerType,
    constitutionOfBusiness,
    state,
    district,
    city,
    zip,
    address,
    street2,
    phone: pickText(row.phone, addr.phone),
    source,
  };
}

async function fetchGstnTaxpayer(gstin) {
  const key = normalizeGstin(gstin);
  const ref = getFirestore().collection(COLLECTION).doc(key);
  const snap = await ref.get();
  const cached = snap.data();
  if (cached?.row && cached.fetchedAtMs && Date.now() - cached.fetchedAtMs < CACHE_MS) {
    return cached.row;
  }

  const url = `${GSTN_SEARCH}?keyword=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://www.mastersindia.co',
      Referer: 'https://www.mastersindia.co/',
      'User-Agent': 'Mozilla/5.0 (compatible; YesweighGstinLookup/1.0)',
    },
  });
  const payload = await response.json().catch(() => ({}));
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : (payload?.data && typeof payload.data === 'object' ? [payload.data] : []);
  const row = rows.find(item => normalizeGstin(item?.gstin) === key) || null;
  if (!row) return cached?.row || null;

  await ref.set({
    gstin: key,
    row,
    fetchedAt: new Date().toISOString(),
    fetchedAtMs: Date.now(),
  });
  return row;
}

function booksHeaders(accessToken, orgId) {
  return {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    'X-com-zoho-books-organizationid': orgId,
  };
}

async function zohoGet(accessToken, orgId, base, path, search = {}) {
  const url = new URL(`${base}${path}`);
  url.searchParams.set('organization_id', orgId);
  for (const [key, value] of Object.entries(search)) {
    if (value != null && String(value).trim()) url.searchParams.set(key, String(value));
  }
  const headers = base === ZOHO_BOOKS_API_BASE
    ? booksHeaders(accessToken, orgId)
    : authHeaders(accessToken, orgId);
  try {
    const response = await fetch(url, { method: 'GET', headers: { ...headers, Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function lookupGstinFromZoho(accessToken, orgId, gstin) {
  const probes = [
    { base: ZOHO_BOOKS_API_BASE, path: '/gstindetails', search: { gstin } },
    { base: ZOHO_API_BASE, path: '/gstindetails', search: { gstin } },
    { base: ZOHO_BOOKS_API_BASE, path: '/settings/gstindetails', search: { gstin } },
    { base: ZOHO_API_BASE, path: '/contacts', search: { contact_type: 'customer', search_text: gstin, per_page: '25' } },
  ];
  let best = null;
  for (const probe of probes) {
    const payload = await zohoGet(accessToken, orgId, probe.base, probe.path, probe.search);
    if (!payload) continue;
    if (Array.isArray(payload.contacts)) {
      const match = payload.contacts.find(row => normalizeGstin(row?.gst_no) === gstin);
      if (!match) continue;
      const mapped = mapGstinBlob({
        ...match,
        legal_name: match.legal_name,
        trade_name: match.company_name || match.contact_name,
        gst_treatment: match.gst_treatment,
        taxpayer_type: match.taxpayer_type,
      }, gstin, 'zoho:contact');
      best = mergeDetails(mapped, best);
      continue;
    }
    const mapped = mapGstinBlob(unwrapGstinBlob(payload), gstin, `zoho:${probe.path}`);
    if (!mapped) continue;
    best = mergeDetails(mapped, best);
    if (best.legalName && best.tradeName && best.taxpayerType) break;
  }
  return best;
}

async function findExistingDealerByGstin(gstin) {
  const snap = await getFirestore()
    .collection('zohoCustomers')
    .where('zohoGstNo', '==', gstin)
    .limit(1)
    .get()
    .catch(() => null);
  const row = snap?.docs?.[0]?.data();
  if (!row) return null;
  const companyName = pickText(row.companyName, row.contactName, row.zohoLegalName);
  if (!companyName) return null;
  return {
    ...emptyDetails(gstin),
    companyName,
    legalName: pickText(row.zohoLegalName, companyName),
    tradeName: pickText(row.companyName, companyName),
    gstTreatment: pickText(row.zohoGstTreatment),
    taxpayerType: pickText(row.zohoTaxpayerType),
    constitutionOfBusiness: pickText(row.zohoConstitutionOfBusiness, row.firmType),
    state: pickText(row.billingState),
    district: pickText(row.district),
    zip: pickText(row.zipCode),
    address: pickText(row.billingAddress, row.zohoBillingAddress),
    phone: pickText(row.phone, row.mobile),
    source: 'firestore',
  };
}

export async function lookupGstinDetails(input = {}, ctx = {}) {
  const gstin = normalizeGstin(input.gstin || input.gstNo);
  if (!isValidGstin(gstin)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 15-character GSTIN.');
  }

  const [fromZoho, fromStore, gstnRow] = await Promise.all([
    ctx.accessToken && ctx.organizationId
      ? lookupGstinFromZoho(ctx.accessToken, ctx.organizationId, gstin).catch(() => null)
      : Promise.resolve(null),
    findExistingDealerByGstin(gstin).catch(() => null),
    fetchGstnTaxpayer(gstin).catch(() => null),
  ]);

  const fromGstn = gstnRow ? mapGstinBlob(gstnRow, gstin, 'gstn') : null;
  const mapped = mergeDetails(fromZoho, fromStore, fromGstn);
  const companyName = mapped.tradeName || mapped.legalName || mapped.companyName;
  if (!companyName) {
    throw new HttpsError('not-found', 'Could not fetch GST details for this GSTIN. Check the number and try again.');
  }

  mapped.companyName = companyName;
  mapped.legalName = mapped.legalName || companyName;
  mapped.tradeName = mapped.tradeName || companyName;
  mapped.gstTreatment = mapped.gstTreatment || 'business_gst';
  mapped.state = canonicalGstState(mapped.state)
    || GSTIN_STATE_NAMES[gstin.slice(0, 2)]
    || mapped.state
    || '';
  return mapped;
}
