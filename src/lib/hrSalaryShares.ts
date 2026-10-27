import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { PUBLIC_APP_ORIGIN } from '../constants/brand';
import { app, db } from '../firebase';
import type {
  HrSalaryShareInput,
  HrSalaryShareRecord,
  HrWorklogShareInput,
  HrWorklogShareRecord,
} from '../types/hr-salary-share';
import type {
  HrDayJoinEntry,
  HrExpenseEntry,
  HrLeaveEntry,
  HrOvertimeEntry,
  HrSalaryPeriod,
  HrSalaryProject,
  HrSalaryReceiptEntry,
  HrWorkDayEntry,
  HrWorklogEntry,
  HrWorkShiftEntry,
} from '../types/hr-salary';
import { HR_WORKLOG_TEXT_MAX, salaryPeriodKey } from '../types/hr-salary';
import type { HrHoliday } from '../types/hr-holiday';
import {
  perDayFromMonthly,
  salaryMonthDocId,
  salaryRateDays,
  dropRegularMarksWhenOtOnClosedDays,
} from './hrSalary';

const SHARE_COLLECTION = 'hrSalaryShares';
const MONTH_COLLECTION = 'hrSalaryMonths';
const functions = getFunctions(app, 'asia-south1');

export function createSalaryShareToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function salarySharePublicPath(token: string): string {
  return `/s/salary/${token}`;
}

/** Always use the public app origin so copied links work for anyone. */
export function salarySharePublicUrl(token: string): string {
  return `${PUBLIC_APP_ORIGIN.replace(/\/$/, '')}${salarySharePublicPath(token)}`;
}

export function worklogSharePublicPath(token: string): string {
  return `/s/worklog/${token}`;
}

/** Always use the public app origin so copied worklog links work for anyone. */
export function worklogSharePublicUrl(token: string): string {
  return `${PUBLIC_APP_ORIGIN.replace(/\/$/, '')}${worklogSharePublicPath(token)}`;
}

function filledWorklogEntries(entries: HrWorklogEntry[]): HrWorklogEntry[] {
  return entries
    .map(entry => ({
      id: String(entry.id ?? ''),
      date: String(entry.date ?? ''),
      text: String(entry.text ?? '').trim().slice(0, HR_WORKLOG_TEXT_MAX),
    }))
    .filter(e => e.id && e.date && e.text)
    .sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      return a.id.localeCompare(b.id);
    });
}

function mapShareDoc(token: string, data: Record<string, unknown>): HrSalaryShareRecord | null {
  const uid = String(data.uid ?? '');
  const year = Number(data.year) || 0;
  const month = Number(data.month) || 0;
  if (!uid || !year || !month) return null;
  const leaveEntries = Array.isArray(data.leaveEntries)
    ? data.leaveEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          date: String(row.date ?? ''),
          kind: row.kind === 'half' ? 'half' as const : 'full' as const,
        };
      }).filter(e => e.date)
    : [];
  const projects = Array.isArray(data.projects)
    ? data.projects.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          color: String(row.color ?? '#94a3b8'),
        };
      }).filter(p => p.id && p.name)
    : [];
  const workDayEntries = Array.isArray(data.workDayEntries)
    ? data.workDayEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          date: String(row.date ?? ''),
          projectId: String(row.projectId ?? ''),
        };
      }).filter(e => e.date && e.projectId)
    : [];
  const workShiftEntries = Array.isArray(data.workShiftEntries)
    ? data.workShiftEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          date: String(row.date ?? ''),
          startTime: String(row.startTime ?? ''),
          endTime: String(row.endTime ?? ''),
          projectId: row.projectId != null && row.projectId !== ''
            ? String(row.projectId)
            : null,
        };
      }).filter(e => e.id && e.date)
    : [];
  const dayJoinEntries = Array.isArray(data.dayJoinEntries)
    ? data.dayJoinEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        const joinedAt = String(row.joinedAt ?? '').trim();
        const clockedOutAtRaw = row.clockedOutAt != null ? String(row.clockedOutAt).trim() : '';
        const clockedOutAt = /^\d{2}:\d{2}$/.test(clockedOutAtRaw) ? clockedOutAtRaw : null;
        return {
          date: String(row.date ?? ''),
          joinedAt,
          ...(clockedOutAt ? { clockedOutAt } : {}),
        };
      }).filter(e => e.date && e.joinedAt)
    : [];
  const worklogEntries = Array.isArray(data.worklogEntries)
    ? data.worklogEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          date: String(row.date ?? ''),
          text: String(row.text ?? '').trim().slice(0, HR_WORKLOG_TEXT_MAX),
        };
      }).filter(e => e.id && e.date)
    : [];
  const expenseEntries = Array.isArray(data.expenseEntries)
    ? data.expenseEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          date: String(row.date ?? ''),
          amount: Math.max(0, Number(row.amount) || 0),
          note: String(row.note ?? '').trim().slice(0, 120),
        };
      }).filter(e => e.id && e.date)
    : [];
  const receiptEntries = Array.isArray(data.receiptEntries)
    ? data.receiptEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          date: String(row.date ?? ''),
          kind: row.kind === 'salary_advance' ? 'salary_advance' as const : 'reimbursement' as const,
          amount: Math.max(0, Number(row.amount) || 0),
          note: String(row.note ?? '').trim().slice(0, 120),
        };
      }).filter(e => e.id && e.date)
    : [];
  const overtimeEntries = Array.isArray(data.overtimeEntries)
    ? data.overtimeEntries.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id ?? ''),
          date: String(row.date ?? ''),
          startTime: String(row.startTime ?? ''),
          endTime: String(row.endTime ?? ''),
          projectId: row.projectId != null && row.projectId !== ''
            ? String(row.projectId)
            : null,
        };
      }).filter(e => e.id && e.date)
    : [];
  const holidays = Array.isArray(data.holidays)
    ? data.holidays.map(raw => {
        const row = raw as Record<string, unknown>;
        return {
          date: String(row.date ?? ''),
          name: String(row.name ?? 'Holiday'),
        };
      }).filter(h => h.date)
    : [];

  if (String(data.kind ?? '') === 'worklog') return null;

  return {
    token,
    sourceDocId: String(data.sourceDocId ?? ''),
    uid,
    displayName: String(data.displayName ?? 'Staff'),
    year,
    month,
    period: String(data.period ?? salaryPeriodKey({ year, month })),
    monthlySalary: Math.max(0, Number(data.monthlySalary) || 0),
    perDaySalary: Math.max(0, Number(data.perDaySalary) || 0),
    otPerDaySalary: Math.max(0, Number(data.otPerDaySalary) || 0),
    leaveEntries,
    projects,
    workDayEntries,
    workShiftEntries,
    dayJoinEntries,
    worklogEntries,
    expenseEntries,
    receiptEntries,
    overtimeEntries,
    holidays,
    createdAt: String(data.createdAt ?? ''),
    updatedAt: String(data.updatedAt ?? ''),
    createdByUid: data.createdByUid != null ? String(data.createdByUid) : null,
  };
}

export async function fetchSalaryShare(token: string): Promise<HrSalaryShareRecord | null> {
  const cleaned = token.trim();
  if (!cleaned) return null;
  const snap = await getDoc(doc(db, SHARE_COLLECTION, cleaned));
  if (!snap.exists()) return null;
  return mapShareDoc(snap.id, snap.data() as Record<string, unknown>);
}

/** Live subscription to a public salary share (token doc). */
export function subscribeSalaryShare(
  token: string,
  onNext: (share: HrSalaryShareRecord | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const cleaned = token.trim();
  if (!cleaned) {
    onNext(null);
    return () => {};
  }
  return onSnapshot(
    doc(db, SHARE_COLLECTION, cleaned),
    snap => {
      if (!snap.exists()) {
        onNext(null);
        return;
      }
      onNext(mapShareDoc(snap.id, snap.data() as Record<string, unknown>));
    },
    err => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    },
  );
}

export type PublicSalaryShareUpdateInput = {
  token: string;
  monthlySalary: number;
  otPerDaySalary: number;
  leaveEntries: HrLeaveEntry[];
  projects: HrSalaryProject[];
  workDayEntries: HrWorkDayEntry[];
  workShiftEntries: HrWorkShiftEntry[];
  dayJoinEntries: HrDayJoinEntry[];
  worklogEntries: HrWorklogEntry[];
  expenseEntries: HrExpenseEntry[];
  receiptEntries: HrSalaryReceiptEntry[];
  overtimeEntries: HrOvertimeEntry[];
};

/** Token-gated public edit — updates share + private month via Cloud Function. */
export async function updatePublicSalaryShareViaCallable(
  input: PublicSalaryShareUpdateInput,
): Promise<{ updatedAt: string }> {
  const fn = httpsCallable<PublicSalaryShareUpdateInput, { updatedAt?: string }>(
    functions,
    'updatePublicSalaryShare',
    { timeout: 60_000 },
  );
  const result = await fn(input);
  return { updatedAt: String(result.data?.updatedAt ?? '') };
}

export type PublicSalaryShareSwitchPeriodInput = {
  token: string;
  year: number;
  month: number;
};

/** Token-gated pull of the live holiday calendar into this salary link. */
export async function refreshPublicSalaryShareHolidays(token: string): Promise<void> {
  const fn = httpsCallable<{ token: string }, { updated?: boolean }>(
    functions,
    'refreshPublicSalaryShareHolidays',
    { timeout: 60_000 },
  );
  await fn({ token: token.trim() });
}

/** Token-gated month switch — loads month data into the same share link. */
export async function switchPublicSalarySharePeriodViaCallable(
  input: PublicSalaryShareSwitchPeriodInput,
): Promise<{ updatedAt: string; year: number; month: number }> {
  const fn = httpsCallable<
    PublicSalaryShareSwitchPeriodInput,
    { updatedAt?: string; year?: number; month?: number }
  >(
    functions,
    'switchPublicSalarySharePeriod',
    { timeout: 60_000 },
  );
  const result = await fn(input);
  return {
    updatedAt: String(result.data?.updatedAt ?? ''),
    year: Number(result.data?.year) || input.year,
    month: Number(result.data?.month) || input.month,
  };
}

/** Create or refresh a public share snapshot; returns the token. */
export async function upsertSalaryShare(
  input: HrSalaryShareInput,
  createdByUid: string,
): Promise<string> {
  const period = input.period;
  const sourceDocId = salaryMonthDocId(input.uid, period);
  const now = new Date().toISOString();
  const ref = doc(db, SHARE_COLLECTION, input.token);
  const existing = await getDoc(ref);
  const monthlySalary = Math.max(0, Number(input.monthlySalary) || 0);
  const holidayRows: HrHoliday[] = input.holidays.map((h, i) => ({
    id: `share-h-${i}-${h.date}`,
    date: h.date,
    name: h.name,
    type: 'company',
    note: null,
    createdAt: '',
    createdByUid: null,
  }));
  const cleaned = dropRegularMarksWhenOtOnClosedDays(period, holidayRows, {
    overtimeEntries: input.overtimeEntries,
    workDayEntries: input.workDayEntries,
    workShiftEntries: input.workShiftEntries ?? [],
    dayJoinEntries: input.dayJoinEntries ?? [],
  });
  const rateDays = salaryRateDays(period.year, period.month, holidayRows);
  const perDaySalary = perDayFromMonthly(monthlySalary, rateDays);
  await setDoc(
    ref,
    {
      sourceDocId,
      uid: input.uid,
      displayName: input.displayName.trim() || 'Staff',
      year: period.year,
      month: period.month,
      period: salaryPeriodKey(period),
      monthlySalary,
      perDaySalary,
      otPerDaySalary: Math.max(0, input.otPerDaySalary),
      leaveEntries: input.leaveEntries,
      projects: input.projects,
      workDayEntries: cleaned.workDayEntries,
      workShiftEntries: cleaned.workShiftEntries,
      dayJoinEntries: cleaned.dayJoinEntries,
      worklogEntries: input.worklogEntries ?? [],
      expenseEntries: input.expenseEntries ?? [],
      receiptEntries: input.receiptEntries ?? [],
      overtimeEntries: input.overtimeEntries,
      holidays: input.holidays,
      updatedAt: now,
      createdAt: existing.exists()
        ? String((existing.data() as Record<string, unknown>).createdAt ?? now)
        : now,
      createdByUid: existing.exists()
        ? ((existing.data() as Record<string, unknown>).createdByUid ?? createdByUid)
        : createdByUid,
    },
    { merge: true },
  );
  return input.token;
}

async function saveSalaryMonthTokenField(
  uid: string,
  period: HrSalaryPeriod,
  token: string,
  field: 'publicShareToken' | 'publicWorklogShareToken',
): Promise<void> {
  await updateDoc(doc(db, MONTH_COLLECTION, salaryMonthDocId(uid, period)), {
    [field]: token,
  }).catch(async () => {
    // Month doc may not exist yet — create a minimal merge.
    await setDoc(
      doc(db, MONTH_COLLECTION, salaryMonthDocId(uid, period)),
      {
        uid,
        year: period.year,
        month: period.month,
        period: salaryPeriodKey(period),
        [field]: token,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  });
}

/** Persist share token on the private salary-month doc for reuse. */
export async function saveSalaryMonthShareToken(
  uid: string,
  period: HrSalaryPeriod,
  token: string,
): Promise<void> {
  await saveSalaryMonthTokenField(uid, period, token, 'publicShareToken');
}

/** Persist worklog-only share token on the private salary-month doc for reuse. */
export async function saveSalaryMonthWorklogShareToken(
  uid: string,
  period: HrSalaryPeriod,
  token: string,
): Promise<void> {
  await saveSalaryMonthTokenField(uid, period, token, 'publicWorklogShareToken');
}

function mapWorklogShareDoc(
  token: string,
  data: Record<string, unknown>,
): HrWorklogShareRecord | null {
  if (String(data.kind ?? '') !== 'worklog') return null;
  const uid = String(data.uid ?? '');
  const year = Number(data.year) || 0;
  const month = Number(data.month) || 0;
  if (!uid || !year || !month) return null;
  return {
    token,
    sourceDocId: String(data.sourceDocId ?? ''),
    uid,
    displayName: String(data.displayName ?? 'Staff'),
    year,
    month,
    period: String(data.period ?? salaryPeriodKey({ year, month })),
    worklogEntries: filledWorklogEntries(
      Array.isArray(data.worklogEntries) ? data.worklogEntries as HrWorklogEntry[] : [],
    ),
    createdAt: String(data.createdAt ?? ''),
    updatedAt: String(data.updatedAt ?? ''),
    createdByUid: data.createdByUid != null ? String(data.createdByUid) : null,
  };
}

/** Live subscription to a public worklog-only share (token doc). */
export function subscribeWorklogShare(
  token: string,
  onNext: (share: HrWorklogShareRecord | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const cleaned = token.trim();
  if (!cleaned) {
    onNext(null);
    return () => {};
  }
  return onSnapshot(
    doc(db, SHARE_COLLECTION, cleaned),
    snap => {
      if (!snap.exists()) {
        onNext(null);
        return;
      }
      onNext(mapWorklogShareDoc(snap.id, snap.data() as Record<string, unknown>));
    },
    err => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    },
  );
}

/** Create or refresh a worklog-only public share snapshot; returns the token. */
export async function upsertWorklogShare(
  input: HrWorklogShareInput,
  createdByUid: string,
): Promise<string> {
  const period = input.period;
  const sourceDocId = salaryMonthDocId(input.uid, period);
  const now = new Date().toISOString();
  const ref = doc(db, SHARE_COLLECTION, input.token);
  const existing = await getDoc(ref);
  await setDoc(
    ref,
    {
      kind: 'worklog',
      sourceDocId,
      uid: input.uid,
      displayName: input.displayName.trim() || 'Staff',
      year: period.year,
      month: period.month,
      period: salaryPeriodKey(period),
      worklogEntries: filledWorklogEntries(input.worklogEntries ?? []),
      updatedAt: now,
      createdAt: existing.exists()
        ? String((existing.data() as Record<string, unknown>).createdAt ?? now)
        : now,
      createdByUid: existing.exists()
        ? ((existing.data() as Record<string, unknown>).createdByUid ?? createdByUid)
        : createdByUid,
    },
    { merge: true },
  );
  return input.token;
}
