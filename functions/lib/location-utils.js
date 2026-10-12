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

export function normalizeStateName(rawStateName) {
  if (!rawStateName) return null;
  const target = clean(rawStateName);
  if (!target) return String(rawStateName).trim() || null;

  for (const canonical of INDIAN_STATES) {
    if (clean(canonical) === target) return canonical;
  }

  return String(rawStateName).trim() || null;
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
