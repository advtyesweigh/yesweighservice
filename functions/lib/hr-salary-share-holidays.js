/**
 * Salary links store a holiday snapshot because the public page cannot read hrHolidays.
 * Keep that snapshot aligned with the holiday calendar.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

const SHARE_COLLECTION = 'hrSalaryShares';
const HOLIDAY_COLLECTION = 'hrHolidays';

export function periodKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function countSundays(year, month) {
  let count = 0;
  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day += 1) {
    if (new Date(year, month - 1, day).getDay() === 0) count += 1;
  }
  return count;
}

function countWeekdayHolidays(holidays, year, month) {
  const key = periodKey(year, month);
  const dates = new Set();
  for (const holiday of holidays) {
    const date = String(holiday?.date ?? '').trim();
    if (!date.startsWith(key)) continue;
    const [y, m, d] = date.split('-').map(Number);
    if (!y || !m || !d) continue;
    if (new Date(y, m - 1, d).getDay() === 0) continue;
    dates.add(date);
  }
  return dates.size;
}

export function salaryRateDays(year, month, holidays) {
  return Math.max(
    0,
    daysInMonth(year, month) - countSundays(year, month) - countWeekdayHolidays(holidays, year, month),
  );
}

export function perDayFromMonthly(monthlySalary, rateDays) {
  const monthly = Math.max(0, Number(monthlySalary) || 0);
  if (!(monthly > 0) || !(rateDays > 0)) return 0;
  return Math.round((monthly / rateDays) * 100) / 100;
}

export function normalizeHolidayList(raw) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const date = String(row?.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const name = String(row?.name ?? '').trim().slice(0, 120) || 'Holiday';
    const key = `${date}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, name });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return out;
}

export function periodsFromHolidayDocs(before, after) {
  const keys = new Set();
  for (const row of [before, after]) {
    const date = String(row?.date ?? '').trim();
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
    if (!match) continue;
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    keys.add(`${Number(match[1])}-${month}`);
  }
  return [...keys].map(key => {
    const [year, month] = key.split('-').map(Number);
    return { year, month };
  });
}

/**
 * Fields to merge onto a salary share, or null when the snapshot already matches.
 * Legacy shares with no monthly salary keep their stored per-day rate.
 */
export function holidayPatchForShare(share, holidays, year, month, now = new Date().toISOString()) {
  const next = normalizeHolidayList(holidays);
  const prev = normalizeHolidayList(share?.holidays);
  const monthlySalary = Math.max(0, Number(share?.monthlySalary) || 0);
  const prevPerDay = Math.round((Number(share?.perDaySalary) || 0) * 100) / 100;
  const perDaySalary = monthlySalary > 0
    ? perDayFromMonthly(monthlySalary, salaryRateDays(year, month, next))
    : prevPerDay;
  const sameHolidays = next.length === prev.length
    && next.every((holiday, index) => holiday.date === prev[index].date && holiday.name === prev[index].name);
  if (sameHolidays && prevPerDay === perDaySalary) return null;
  return {
    holidays: next,
    perDaySalary,
    updatedAt: now,
  };
}

export async function fetchMonthHolidays(db, year, month) {
  const key = periodKey(year, month);
  const lastDay = String(daysInMonth(year, month)).padStart(2, '0');
  const snap = await db.collection(HOLIDAY_COLLECTION)
    .where('date', '>=', `${key}-01`)
    .where('date', '<=', `${key}-${lastDay}`)
    .get();
  return normalizeHolidayList(snap.docs.map(docSnap => docSnap.data() || {}));
}

export async function syncSalarySharesForPeriod(db, year, month) {
  const holidays = await fetchMonthHolidays(db, year, month);
  const snap = await db.collection(SHARE_COLLECTION)
    .where('period', '==', periodKey(year, month))
    .get();
  let batch = db.batch();
  let ops = 0;
  let updated = 0;
  const commit = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (String(data.kind ?? '') === 'worklog') continue;
    const patch = holidayPatchForShare(data, holidays, year, month);
    if (!patch) continue;
    batch.set(docSnap.ref, patch, { merge: true });
    ops += 1;
    updated += 1;
    if (ops >= 400) await commit();
  }
  await commit();
  return updated;
}

/** Token-gated refresh so an already-open salary link picks up calendar edits. */
export async function refreshPublicSalaryShareHolidays(payload = {}) {
  const token = String(payload.token ?? '').trim();
  if (!token || token.length < 16 || token.length > 128) {
    throw new HttpsError('invalid-argument', 'Invalid share token.');
  }

  const db = getFirestore();
  const ref = db.collection(SHARE_COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'This salary link is invalid or has been removed.');
  }

  const existing = snap.data() || {};
  if (String(existing.kind ?? '') === 'worklog') {
    throw new HttpsError('failed-precondition', 'Not a salary share.');
  }
  const year = Number(existing.year) || 0;
  const month = Number(existing.month) || 0;
  if (!year || month < 1 || month > 12) {
    throw new HttpsError('failed-precondition', 'Share document is incomplete.');
  }

  const holidays = await fetchMonthHolidays(db, year, month);
  const updated = await db.runTransaction(async tx => {
    const latestSnap = await tx.get(ref);
    const latest = latestSnap.data() || {};
    if (Number(latest.year) !== year || Number(latest.month) !== month) return false;
    const patch = holidayPatchForShare(latest, holidays, year, month);
    if (!patch) return false;
    tx.set(ref, patch, { merge: true });
    return true;
  });
  return { updated, holidays };
}
