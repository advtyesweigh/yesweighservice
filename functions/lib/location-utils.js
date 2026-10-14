/** Simplified state/district normalization for Zoho customer sync. */

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Lakshadweep', 'Puducherry', 'Ladakh',
];

function clean(str) {
  return String(str).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

/** Names and codes IRP rejects, mapped to the GST state master. */
const STATE_ALIASES = {
  keralam: 'Kerala',
  kerela: 'Kerala',
  kerla: 'Kerala',
  kl: 'Kerala',
  32: 'Kerala',
  orissa: 'Odisha',
  orisa: 'Odisha',
  od: 'Odisha',
  21: 'Odisha',
  pondicherry: 'Puducherry',
  pondichery: 'Puducherry',
  py: 'Puducherry',
  34: 'Puducherry',
  uttaranchal: 'Uttarakhand',
  uk: 'Uttarakhand',
  ua: 'Uttarakhand',
  '05': 'Uttarakhand',
  uttarpradesh: 'Uttar Pradesh',
  up: 'Uttar Pradesh',
  '09': 'Uttar Pradesh',
  tamilnadu: 'Tamil Nadu',
  tn: 'Tamil Nadu',
  33: 'Tamil Nadu',
  chattisgarh: 'Chhattisgarh',
  chhatisgarh: 'Chhattisgarh',
  cg: 'Chhattisgarh',
  22: 'Chhattisgarh',
  telengana: 'Telangana',
  ts: 'Telangana',
  tg: 'Telangana',
  36: 'Telangana',
  maharastra: 'Maharashtra',
  maharasthra: 'Maharashtra',
  mh: 'Maharashtra',
  27: 'Maharashtra',
  newdelhi: 'Delhi',
  nctofdelhi: 'Delhi',
  delhinct: 'Delhi',
  dl: 'Delhi',
  '07': 'Delhi',
  damananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
  damandiu: 'Dadra and Nagar Haveli and Daman and Diu',
  dadraandnagarhaveli: 'Dadra and Nagar Haveli and Daman and Diu',
  dnhdd: 'Dadra and Nagar Haveli and Daman and Diu',
  dd: 'Dadra and Nagar Haveli and Daman and Diu',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  andamannicobar: 'Andaman and Nicobar Islands',
  an: 'Andaman and Nicobar Islands',
  35: 'Andaman and Nicobar Islands',
  jammuandkashmir: 'Jammu and Kashmir',
  jk: 'Jammu and Kashmir',
  '01': 'Jammu and Kashmir',
  ladakh: 'Ladakh',
  la: 'Ladakh',
  38: 'Ladakh',
  ap: 'Andhra Pradesh',
  37: 'Andhra Pradesh',
  ar: 'Arunachal Pradesh',
  12: 'Arunachal Pradesh',
  as: 'Assam',
  18: 'Assam',
  br: 'Bihar',
  10: 'Bihar',
  ga: 'Goa',
  30: 'Goa',
  gj: 'Gujarat',
  24: 'Gujarat',
  hr: 'Haryana',
  '06': 'Haryana',
  hp: 'Himachal Pradesh',
  '02': 'Himachal Pradesh',
  jh: 'Jharkhand',
  20: 'Jharkhand',
  ka: 'Karnataka',
  29: 'Karnataka',
  mp: 'Madhya Pradesh',
  23: 'Madhya Pradesh',
  mn: 'Manipur',
  14: 'Manipur',
  ml: 'Meghalaya',
  17: 'Meghalaya',
  mz: 'Mizoram',
  15: 'Mizoram',
  nl: 'Nagaland',
  13: 'Nagaland',
  pb: 'Punjab',
  '03': 'Punjab',
  rj: 'Rajasthan',
  '08': 'Rajasthan',
  sk: 'Sikkim',
  11: 'Sikkim',
  tr: 'Tripura',
  16: 'Tripura',
  wb: 'West Bengal',
  19: 'West Bengal',
  ch: 'Chandigarh',
  '04': 'Chandigarh',
  ld: 'Lakshadweep',
  31: 'Lakshadweep',
};

const CANONICAL_BY_KEY = new Map(INDIAN_STATES.map(name => [clean(name), name]));

export function normalizeStateName(rawStateName) {
  if (!rawStateName) return null;
  const trimmed = String(rawStateName).replace(/\s+/g, ' ').trim();
  const target = clean(trimmed);
  if (!target) return trimmed || null;

  if (CANONICAL_BY_KEY.has(target)) return CANONICAL_BY_KEY.get(target);
  if (STATE_ALIASES[target]) return STATE_ALIASES[target];

  // India Post / GSTN sometimes append a letter: "Keralam".
  for (const [key, canonical] of CANONICAL_BY_KEY) {
    if (target.startsWith(key) && target.slice(key.length) === 'm') return canonical;
  }

  return trimmed || null;
}

/** Official GST state name, or '' when the text is not a known state. */
export function canonicalGstState(rawStateName) {
  const normalized = normalizeStateName(rawStateName);
  if (!normalized || !INDIAN_STATES.includes(normalized)) return '';
  return normalized;
}

export function normalizeDistrictName(rawDistrict) {
  if (!rawDistrict) return null;
  return String(rawDistrict).trim().replace(/\s+/g, ' ') || null;
}

export async function lookupPincodeLocation(zip, zipCache = {}) {
  const key = String(zip ?? '').replace(/\D/g, '').slice(0, 6);
  if (key.length !== 6) return null;

  if (zipCache[key] && typeof zipCache[key] === 'object' && zipCache[key].state && zipCache[key].district) {
    return {
      state: normalizeStateName(zipCache[key].state),
      district: normalizeDistrictName(zipCache[key].district),
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.postalpincode.in/pincode/${key}`, {
      headers: { 'User-Agent': 'YesOnePlatform/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.[0]?.Status === 'Success' && data[0].PostOffice?.[0]) {
      const office = data[0].PostOffice[0];
      const district = normalizeDistrictName(office.District);
      const city = normalizeDistrictName(office.Block || office.Name) || district;
      return {
        state: normalizeStateName(office.State),
        district,
        city,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolveLiveZipDistrict(zip, zipCache = {}) {
  const cached = zipCache[String(zip ?? '').trim()];
  if (typeof cached === 'string' && cached.trim()) {
    return normalizeDistrictName(cached);
  }
  const location = await lookupPincodeLocation(zip, zipCache);
  return location?.district ?? null;
}
