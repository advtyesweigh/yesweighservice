/** Official India states and UTs, states first then UTs. */
export const INDIA_STATES = [
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
] as const;

export type IndiaState = (typeof INDIA_STATES)[number];

const CANONICAL = new Map(INDIA_STATES.map(name => [normKey(name), name]));

const ALIASES: Record<string, string> = {
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
  kerala: 'Kerala',
  keralam: 'Kerala',
  kerela: 'Kerala',
  kl: 'Kerala',
  kerla: 'Kerala',
  karnataka: 'Karnataka',
  karnatka: 'Karnataka',
  ka: 'Karnataka',
  maharashtra: 'Maharashtra',
  maharastra: 'Maharashtra',
  maharasthra: 'Maharashtra',
  mh: 'Maharashtra',
  'west bengal': 'West Bengal',
  'west bangal': 'West Bengal',
  westbengal: 'West Bengal',
  wb: 'West Bengal',
  'uttar pradesh': 'Uttar Pradesh',
  uttarpradesh: 'Uttar Pradesh',
  up: 'Uttar Pradesh',
  'madhya pradesh': 'Madhya Pradesh',
  mp: 'Madhya Pradesh',
  'andhra pradesh': 'Andhra Pradesh',
  andhrapradesh: 'Andhra Pradesh',
  ap: 'Andhra Pradesh',
  telangana: 'Telangana',
  telengana: 'Telangana',
  ts: 'Telangana',
  tg: 'Telangana',
  gujarat: 'Gujarat',
  gj: 'Gujarat',
  rajasthan: 'Rajasthan',
  rj: 'Rajasthan',
  bihar: 'Bihar',
  br: 'Bihar',
  odisha: 'Odisha',
  od: 'Odisha',
  punjab: 'Punjab',
  pb: 'Punjab',
  haryana: 'Haryana',
  hr: 'Haryana',
  assam: 'Assam',
  as: 'Assam',
  chhattisgarh: 'Chhattisgarh',
  chattisgarh: 'Chhattisgarh',
  chhatisgarh: 'Chhattisgarh',
  cg: 'Chhattisgarh',
  jharkhand: 'Jharkhand',
  jh: 'Jharkhand',
  goa: 'Goa',
  ga: 'Goa',
  'himachal pradesh': 'Himachal Pradesh',
  himachal: 'Himachal Pradesh',
  hp: 'Himachal Pradesh',
};

export const UNSPECIFIED_STATE = 'Unspecified';

/** Official picker names (28 states, then 8 UTs). */
export const INDIA_STATE_NAMES: readonly string[] = [...INDIA_STATES];

/** Zoho Books / Inventory India state picker (same names as INDIA_STATES). */
export function indiaStateSelectValue(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const canonical = canonicalIndiaState(trimmed);
  return canonical === UNSPECIFIED_STATE ? trimmed : canonical;
}

export function indiaStateSelectOptions(current?: string | null): string[] {
  const cur = indiaStateSelectValue(current);
  if (cur && !INDIA_STATE_NAMES.includes(cur as IndiaState)) {
    return [cur, ...INDIA_STATE_NAMES];
  }
  return [...INDIA_STATE_NAMES];
}

export function normKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function stripLocationNumberPrefix(raw: string): string {
  return raw
    .replace(/^[\s\u00a0\u2060]*\d+[\s\u00a0\u2060]*[.)][\s\u00a0\u2060]*/u, '')
    .trim();
}

export function canonicalIndiaState(raw: string | null | undefined): string {
  const key = normKey(stripLocationNumberPrefix(String(raw ?? '')));
  if (!key) return UNSPECIFIED_STATE;
  return ALIASES[key] ?? CANONICAL.get(key) ?? UNSPECIFIED_STATE;
}
