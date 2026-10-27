/**
 * Token-gated public update of a salary share + private month doc.
 * Possession of the unguessable share token is the credential (no Auth).
 */
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';
import { dropRegularMarksWhenOtOnClosedDays } from './hr-salary-closed-day.js';
import { fetchMonthHolidays } from './hr-salary-share-holidays.js';

const SHARE_COLLECTION = 'hrSalaryShares';
const MONTH_COLLECTION = 'hrSalaryMonths';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_PROJECTS = 40;
const MAX_LEAVE = 62;
const MAX_WORK_DAYS = 62;
const MAX_WORK_SHIFTS = 200;
const MAX_OT = 200;

function periodKey(year, month) {
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
  let count = 0;
  for (const h of holidays) {
    const date = String(h?.date ?? '').trim();
    if (!date.startsWith(key)) continue;
    const [y, m, d] = date.split('-').map(Number);
    if (!y || !m || !d) continue;
    if (new Date(y, m - 1, d).getDay() === 0) continue;
    count += 1;
  }
  return count;
}

function salaryRateDays(year, month, holidays) {
  return Math.max(
    0,
    daysInMonth(year, month) - countSundays(year, month) - countWeekdayHolidays(holidays, year, month),
  );
}

function perDayFromMonthly(monthlySalary, rateDays) {
  const monthly = Math.max(0, Number(monthlySalary) || 0);
  if (!(monthly > 0) || !(rateDays > 0)) return 0;
  return Math.round((monthly / rateDays) * 100) / 100;
}

function overtimeHours(startTime, endTime) {
  const sm = TIME_RE.exec(String(startTime || '').trim());
  const em = TIME_RE.exec(String(endTime || '').trim());
  if (!sm || !em) return 0;
  let mins = (Number(em[1]) * 60 + Number(em[2])) - (Number(sm[1]) * 60 + Number(sm[2]));
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_PROJECTS) {
    throw new HttpsError('invalid-argument', `At most ${MAX_PROJECTS} projects allowed.`);
  }
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    const id = String(row?.id ?? '').trim() || randomUUID();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(row?.name ?? '').trim().slice(0, 80) || 'Project',
      color: String(row?.color ?? '#94a3b8').trim().slice(0, 32) || '#94a3b8',
    });
  }
  return out;
}

function normalizeLeave(raw, key) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_LEAVE) {
    throw new HttpsError('invalid-argument', `At most ${MAX_LEAVE} leave entries allowed.`);
  }
  const byDate = new Map();
  for (const row of raw) {
    const date = String(row?.date ?? '').trim();
    if (!date.startsWith(key)) continue;
    byDate.set(date, row?.kind === 'half' ? 'half' : 'full');
  }
  return [...byDate.entries()]
    .map(([date, kind]) => ({ date, kind }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeWorkDays(raw, key, projectIds) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_WORK_DAYS) {
    throw new HttpsError('invalid-argument', `At most ${MAX_WORK_DAYS} work-day entries allowed.`);
  }
  const byDate = new Map();
  for (const row of raw) {
    const date = String(row?.date ?? '').trim();
    const projectId = String(row?.projectId ?? '').trim();
    if (!date.startsWith(key) || !projectIds.has(projectId)) continue;
    byDate.set(date, projectId);
  }
  return [...byDate.entries()]
    .map(([date, projectId]) => ({ date, projectId }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeTimedShiftEntries(raw, key, projectIds, maxEntries, label) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > maxEntries) {
    throw new HttpsError('invalid-argument', `At most ${maxEntries} ${label} entries allowed.`);
  }
  return raw
    .map(row => {
      const projectId = row?.projectId != null && String(row.projectId).trim()
        ? String(row.projectId).trim()
        : null;
      return {
        id: String(row?.id ?? '').trim() || randomUUID(),
        date: String(row?.date ?? '').trim(),
        startTime: String(row?.startTime ?? '').trim(),
        endTime: String(row?.endTime ?? '').trim(),
        projectId: projectId && projectIds.has(projectId) ? projectId : null,
      };
    })
    .filter(e => (
      e.date.startsWith(key)
      && TIME_RE.test(e.startTime)
      && TIME_RE.test(e.endTime)
      && overtimeHours(e.startTime, e.endTime) > 0
    ))
    .sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      return a.startTime.localeCompare(b.startTime);
    });
}

function normalizeOt(raw, key, projectIds) {
  return normalizeTimedShiftEntries(raw, key, projectIds, MAX_OT, 'overtime');
}

function normalizeWorkShifts(raw, key, projectIds) {
  return normalizeTimedShiftEntries(raw, key, projectIds, MAX_WORK_SHIFTS, 'work-shift');
}

function normalizeDayJoinEntries(raw, key) {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map();
  for (const row of raw) {
    const date = String(row?.date ?? '').trim();
    const joinedAt = String(row?.joinedAt ?? '').trim();
    if (!date.startsWith(key) || !TIME_RE.test(joinedAt)) continue;
    const clockedOutAtRaw = row?.clockedOutAt != null ? String(row.clockedOutAt).trim() : '';
    const clockedOutAt = TIME_RE.test(clockedOutAtRaw) ? clockedOutAtRaw : null;
    byDate.set(date, {
      date,
      joinedAt,
      ...(clockedOutAt ? { clockedOutAt } : {}),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeWorklogEntries(raw, key) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      id: String(row?.id ?? '').trim() || randomUUID(),
      date: String(row?.date ?? '').trim(),
      text: String(row?.text ?? '').trim().slice(0, 500),
    }))
    // Keep empty draft rows so "Add worklog" survives autosave before the user types.
    .filter(e => e.date.startsWith(key))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function normalizeExpenseEntries(raw, key) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      id: String(row?.id ?? '').trim() || randomUUID(),
      date: String(row?.date ?? '').trim(),
      amount: Math.max(0, Number(row?.amount) || 0),
      note: String(row?.note ?? '').trim().slice(0, 120),
    }))
    // Keep amount=0 draft rows so "Add expense" survives autosave before the user types.
    .filter(e => e.date.startsWith(key))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeSalaryReceiptEntries(raw, key) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      id: String(row?.id ?? '').trim() || randomUUID(),
      date: String(row?.date ?? '').trim(),
      kind: row?.kind === 'salary_advance' ? 'salary_advance' : 'reimbursement',
      amount: Math.max(0, Number(row?.amount) || 0),
      note: String(row?.note ?? '').trim().slice(0, 120),
    }))
    // Keep amount=0 draft rows so "Add reimbursement/advance" survives autosave.
    .filter(e => e.date.startsWith(key))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * @param {object} payload
 * @returns {Promise<object>} updated share fields for the client
 */
export async function updatePublicSalaryShare(payload = {}) {
  const token = String(payload.token ?? '').trim();
  if (!token || token.length < 16 || token.length > 128) {
    throw new HttpsError('invalid-argument', 'Invalid share token.');
  }

  const db = getFirestore();
  const shareRef = db.collection(SHARE_COLLECTION).doc(token);
  const shareSnap = await shareRef.get();
  if (!shareSnap.exists) {
    throw new HttpsError('not-found', 'This salary link is invalid or has been removed.');
  }

  const existing = shareSnap.data() || {};
  const uid = String(existing.uid ?? '').trim();
  const year = Number(existing.year) || 0;
  const month = Number(existing.month) || 0;
  if (!uid || !year || !month) {
    throw new HttpsError('failed-precondition', 'Share document is incomplete.');
  }

  const key = periodKey(year, month);
  const sourceDocId = String(existing.sourceDocId ?? '').trim() || `${uid}_${key}`;
  const holidays = await fetchMonthHolidays(db, year, month);
  const projects = normalizeProjects(payload.projects);
  const projectIds = new Set(projects.map(p => p.id));
  const leaveEntries = normalizeLeave(payload.leaveEntries, key);
  const dayJoinEntries = normalizeDayJoinEntries(payload.dayJoinEntries, key);
  const worklogEntries = normalizeWorklogEntries(payload.worklogEntries, key);
  const expenseEntries = normalizeExpenseEntries(payload.expenseEntries, key);
  const receiptEntries = normalizeSalaryReceiptEntries(payload.receiptEntries, key);
  const workShiftEntries = normalizeWorkShifts(payload.workShiftEntries, key, projectIds);
  const shiftDates = new Set(workShiftEntries.map(e => e.date));
  // Whole-day XOR daytime shifts: drop whole-day rows for dates that have shifts.
  const workDayEntries = normalizeWorkDays(payload.workDayEntries, key, projectIds)
    .filter(e => !shiftDates.has(e.date));
  const overtimeEntries = normalizeOt(payload.overtimeEntries, key, projectIds);
  const cleaned = dropRegularMarksWhenOtOnClosedDays(year, month, holidays, {
    overtimeEntries,
    workDayEntries,
    workShiftEntries,
    dayJoinEntries,
  });
  const workDayEntriesSaved = cleaned.workDayEntries;
  const workShiftEntriesSaved = cleaned.workShiftEntries;
  const dayJoinEntriesSaved = cleaned.dayJoinEntries;
  const monthlySalary = Math.max(0, Number(payload.monthlySalary) || 0);
  const otPerDaySalary = Math.max(0, Number(payload.otPerDaySalary) || 0);
  const rateDays = salaryRateDays(year, month, holidays);
  const perDaySalary = perDayFromMonthly(monthlySalary, rateDays);
  const now = new Date().toISOString();

  const monthRef = db.collection(MONTH_COLLECTION).doc(sourceDocId);
  const monthSnap = await monthRef.get();
  const prevToken = monthSnap.exists
    ? (monthSnap.data()?.publicShareToken ?? token)
    : token;

  await monthRef.set({
    uid,
    year,
    month,
    period: key,
    monthlySalary,
    perDaySalary,
    otPerDaySalary,
    sundayPerDaySalary: 0,
    leaveEntries,
    leaveDates: leaveEntries.filter(e => e.kind === 'full').map(e => e.date),
    projects,
    workDayEntries: workDayEntriesSaved,
    workShiftEntries: workShiftEntriesSaved,
    dayJoinEntries: dayJoinEntriesSaved,
    worklogEntries,
    expenseEntries,
    receiptEntries,
    overtimeEntries,
    overtimeDates: [],
    publicShareToken: prevToken || token,
    updatedAt: now,
    updatedByUid: 'public_share',
  }, { merge: true });

  if (uid.startsWith('ext_') && (monthlySalary > 0 || otPerDaySalary > 0)) {
    const employeeId = uid.slice('ext_'.length);
    if (employeeId) {
      const patch = {};
      if (monthlySalary > 0) patch.defaultMonthlySalary = monthlySalary;
      if (otPerDaySalary > 0) patch.defaultOtPerDaySalary = otPerDaySalary;
      await db.collection('hrPayrollEmployees').doc(employeeId).set(patch, { merge: true });
    }
  }

  await shareRef.set({
    sourceDocId,
    uid,
    displayName: String(existing.displayName ?? 'Staff').trim() || 'Staff',
    year,
    month,
    period: key,
    monthlySalary,
    perDaySalary,
    otPerDaySalary,
    leaveEntries,
    projects,
    workDayEntries: workDayEntriesSaved,
    workShiftEntries: workShiftEntriesSaved,
    dayJoinEntries: dayJoinEntriesSaved,
    worklogEntries,
    expenseEntries,
    receiptEntries,
    overtimeEntries,
    holidays,
    updatedAt: now,
    createdAt: existing.createdAt || now,
    createdByUid: existing.createdByUid ?? null,
  }, { merge: true });

  return {
    token,
    updatedAt: now,
    monthlySalary,
    perDaySalary,
    otPerDaySalary,
    leaveEntries,
    projects,
    workDayEntries: workDayEntriesSaved,
    workShiftEntries: workShiftEntriesSaved,
    dayJoinEntries: dayJoinEntriesSaved,
    worklogEntries,
    expenseEntries,
    receiptEntries,
    overtimeEntries,
    holidays,
  };
}
