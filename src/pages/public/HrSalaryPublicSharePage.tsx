import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { HrSalaryShareView } from '../../components/hr/HrSalaryShareView';
import { APP_NAME } from '../../constants/brand';
import {
  applyDayClockPatch,
  createExpenseEntry,
  createOvertimeEntry,
  createSalaryProject,
  createSalaryReceiptEntry,
  createWorklogEntry,
  createWorkShiftEntry,
  workProjectIdForDate,
} from '../../lib/hrSalary';
import {
  refreshPublicSalaryShareHolidays,
  subscribeSalaryShare,
  switchPublicSalarySharePeriodViaCallable,
  updatePublicSalaryShareViaCallable,
} from '../../lib/hrSalaryShares';
import { salaryPeriodKey } from '../../types/hr-salary';
import type { HrSalaryShareRecord } from '../../types/hr-salary-share';
import type {
  HrDayJoinEntry,
  HrExpenseEntry,
  HrLeaveEntry,
  HrLeaveKind,
  HrOvertimeEntry,
  HrSalaryProject,
  HrSalaryReceiptEntry,
  HrSalaryReceiptKind,
  HrWorkDayEntry,
  HrWorklogEntry,
  HrWorkShiftEntry,
} from '../../types/hr-salary';

const AUTOSAVE_MS = 700;

type DraftState = {
  monthlySalary: string;
  otPerDaySalary: string;
  leaveEntries: HrLeaveEntry[];
  projects: HrSalaryProject[];
  workDayEntries: HrWorkDayEntry[];
  workShiftEntries: HrWorkShiftEntry[];
  dayJoinEntries: HrDayJoinEntry[];
  overtimeEntries: HrOvertimeEntry[];
  worklogEntries: HrWorklogEntry[];
  expenseEntries: HrExpenseEntry[];
  receiptEntries: HrSalaryReceiptEntry[];
};

function rateInputValue(n: number): string {
  if (!(n > 0)) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function draftFromShare(share: HrSalaryShareRecord): DraftState {
  return {
    monthlySalary: rateInputValue(share.monthlySalary || share.perDaySalary),
    otPerDaySalary: rateInputValue(share.otPerDaySalary),
    leaveEntries: share.leaveEntries.map(e => ({ ...e })),
    projects: share.projects.map(p => ({ ...p })),
    workDayEntries: share.workDayEntries.map(e => ({ ...e })),
    workShiftEntries: (share.workShiftEntries ?? []).map(e => ({ ...e })),
    dayJoinEntries: (share.dayJoinEntries ?? []).map(e => ({ ...e })),
    overtimeEntries: share.overtimeEntries.map(e => ({ ...e })),
    worklogEntries: (share.worklogEntries ?? []).map(e => ({ ...e })),
    expenseEntries: (share.expenseEntries ?? []).map(e => ({ ...e })),
    receiptEntries: (share.receiptEntries ?? []).map(e => ({ ...e })),
  };
}

function callableErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: string }).message)
      .replace(/^Firebase:\s*/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '');
  }
  return 'Could not save changes.';
}

export const HrSalaryPublicSharePage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [share, setShare] = useState<HrSalaryShareRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [switchingPeriod, setSwitchingPeriod] = useState(false);
  const [periodError, setPeriodError] = useState('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const draftRef = useRef<DraftState | null>(null);
  const shareUpdatedAtRef = useRef('');
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holidayRefreshKey = useRef('');

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setLoading(true);
    setError('');
    setShare(null);
    setDraft(null);
    setEditMode(false);
    setSelectedDate(null);
    dirtyRef.current = false;
    const unsub = subscribeSalaryShare(
      token,
      next => {
        setLoading(false);
        if (!next) {
          setShare(null);
          setError('This salary link is invalid or has been removed.');
          return;
        }
        setError('');
        setShare(next);
        shareUpdatedAtRef.current = next.updatedAt;
        // Don't clobber local edits while dirty / mid-save.
        if (!dirtyRef.current && !savingRef.current) {
          setDraft(draftFromShare(next));
        }
      },
      err => {
        setLoading(false);
        setError(err.message || 'Unable to load this salary page.');
      },
    );
    return () => {
      unsub();
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [token]);

  useEffect(() => {
    if (!share) return;
    document.title = `${share.displayName} · ${share.period} · ${APP_NAME}`;
  }, [share]);

  useEffect(() => {
    if (!token.trim() || !share) return;
    const key = `${token.trim()}:${share.year}-${String(share.month).padStart(2, '0')}`;
    if (holidayRefreshKey.current === key) return;
    holidayRefreshKey.current = key;
    void refreshPublicSalaryShareHolidays(token).catch(() => {});
  }, [share, token]);

  const persistDraft = useCallback(async () => {
    const current = draftRef.current;
    if (!current || !token.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaveStatus('saving');
    setSaveError('');
    const savedSnapshot = JSON.stringify(current);
    try {
      const result = await updatePublicSalaryShareViaCallable({
        token: token.trim(),
        monthlySalary: Math.max(0, Number.parseFloat(current.monthlySalary) || 0),
        otPerDaySalary: Math.max(0, Number.parseFloat(current.otPerDaySalary) || 0),
        leaveEntries: current.leaveEntries,
        projects: current.projects,
        workDayEntries: current.workDayEntries,
        workShiftEntries: current.workShiftEntries,
        dayJoinEntries: current.dayJoinEntries,
        worklogEntries: current.worklogEntries,
        expenseEntries: current.expenseEntries,
        receiptEntries: current.receiptEntries,
        overtimeEntries: current.overtimeEntries,
      });
      // Keep dirty if the user typed while this save was in flight.
      dirtyRef.current = JSON.stringify(draftRef.current) !== savedSnapshot;
      if (result.updatedAt) shareUpdatedAtRef.current = result.updatedAt;
      setSaveStatus('saved');
      window.setTimeout(() => {
        setSaveStatus(prev => (prev === 'saved' ? 'idle' : prev));
      }, 1600);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(callableErrorMessage(err));
    } finally {
      savingRef.current = false;
      if (dirtyRef.current) {
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        autosaveTimer.current = setTimeout(() => {
          void persistDraft();
        }, AUTOSAVE_MS);
      }
    }
  }, [token]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void persistDraft();
    }, AUTOSAVE_MS);
  }, [persistDraft]);

  const patchDraft = useCallback((patch: Partial<DraftState>) => {
    setDraft(prev => {
      if (!prev) return prev;
      return { ...prev, ...patch };
    });
    scheduleSave();
  }, [scheduleSave]);

  const enterEdit = () => {
    if (share) setDraft(draftFromShare(share));
    setEditMode(true);
    setSaveStatus('idle');
    setSaveError('');
  };

  const exitEdit = () => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    if (dirtyRef.current) void persistDraft();
    setEditMode(false);
    setSelectedDate(null);
  };

  const handleMonthChange = async (value: string) => {
    if (!share || switchingPeriod) return;
    const [year, month] = value.split('-').map(Number);
    if (!year || !month) return;
    if (year === share.year && month === share.month) return;

    setPeriodError('');
    setSwitchingPeriod(true);
    try {
      if (dirtyRef.current && editMode) {
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        await persistDraft();
        if (dirtyRef.current) {
          setPeriodError('Could not save changes before switching month.');
          return;
        }
      }
      await switchPublicSalarySharePeriodViaCallable({
        token: token.trim(),
        year,
        month,
      });
      dirtyRef.current = false;
      setEditMode(false);
      setSelectedDate(null);
      setSaveStatus('idle');
      setSaveError('');
    } catch (err) {
      setPeriodError(callableErrorMessage(err));
    } finally {
      setSwitchingPeriod(false);
    }
  };

  const display = useMemo(() => {
    if (editMode && draft && share) {
      return {
        ...share,
        monthlySalary: Math.max(0, Number.parseFloat(draft.monthlySalary) || 0),
        otPerDaySalary: Math.max(0, Number.parseFloat(draft.otPerDaySalary) || 0),
        leaveEntries: draft.leaveEntries,
        projects: draft.projects,
        workDayEntries: draft.workDayEntries,
        workShiftEntries: draft.workShiftEntries,
        dayJoinEntries: draft.dayJoinEntries,
        worklogEntries: draft.worklogEntries,
        expenseEntries: draft.expenseEntries,
        receiptEntries: draft.receiptEntries,
        overtimeEntries: draft.overtimeEntries,
      };
    }
    return share;
  }, [editMode, draft, share]);

  const editHandlers = useMemo(() => {
    if (!editMode || !draft) return null;
    return {
      monthlySalaryInput: draft.monthlySalary,
      otPerDaySalaryInput: draft.otPerDaySalary,
      onMonthlySalaryChange: (value: string) => patchDraft({ monthlySalary: value }),
      onOtPerDayChange: (value: string) => patchDraft({ otPerDaySalary: value }),
      onAddProject: () => {
        const project = createSalaryProject(
          `Project ${draft.projects.length + 1}`,
          draft.projects,
        );
        setActiveProjectId(project.id);
        const isFirst = draft.projects.length === 0;
        patchDraft({
          projects: [...draft.projects, project],
          workShiftEntries: isFirst
            ? draft.workShiftEntries.map(entry => (
              entry.projectId ? entry : { ...entry, projectId: project.id }
            ))
            : draft.workShiftEntries,
          overtimeEntries: isFirst
            ? draft.overtimeEntries.map(entry => (
              entry.projectId ? entry : { ...entry, projectId: project.id }
            ))
            : draft.overtimeEntries,
        });
      },
      onRenameProject: (projectId: string, name: string) => {
        patchDraft({
          projects: draft.projects.map(p => (
            p.id === projectId ? { ...p, name } : p
          )),
        });
      },
      onRemoveProject: (projectId: string) => {
        patchDraft({
          projects: draft.projects.filter(p => p.id !== projectId),
          workDayEntries: draft.workDayEntries.filter(e => e.projectId !== projectId),
          workShiftEntries: draft.workShiftEntries.map(e => (
            e.projectId === projectId ? { ...e, projectId: null } : e
          )),
          overtimeEntries: draft.overtimeEntries.map(e => (
            e.projectId === projectId ? { ...e, projectId: null } : e
          )),
        });
        if (activeProjectId === projectId) {
          setActiveProjectId(draft.projects.find(p => p.id !== projectId)?.id ?? null);
        }
      },
      selectedDate,
      onSelectDate: setSelectedDate,
      onSetLeave: (date: string, kind: HrLeaveKind | null) => {
        const next = draft.leaveEntries.filter(e => e.date !== date);
        if (kind) next.push({ date, kind });
        patchDraft({
          leaveEntries: next.sort((a, b) => a.date.localeCompare(b.date)),
        });
      },
      onSetDayProject: (date: string, projectId: string | null) => {
        const next = draft.workDayEntries.filter(e => e.date !== date);
        if (projectId) next.push({ date, projectId });
        if (projectId) setActiveProjectId(projectId);
        patchDraft({
          workDayEntries: next.sort((a, b) => a.date.localeCompare(b.date)),
          workShiftEntries: draft.workShiftEntries.filter(e => e.date !== date),
          dayJoinEntries: draft.dayJoinEntries.filter(e => e.date !== date),
        });
      },
      onSetDayClock: (date: string, patch: { joinedAt?: string | null; clockedOutAt?: string | null }) => {
        patchDraft({
          dayJoinEntries: applyDayClockPatch(date, draft.dayJoinEntries, patch),
        });
      },
      onAddWorkShift: (date: string) => {
        let projects = draft.projects;
        const dayProject = workProjectIdForDate(draft.workDayEntries, date);
        let projectId = (
          dayProject
          || (activeProjectId && projects.some(p => p.id === activeProjectId)
            ? activeProjectId
            : null)
          || projects[0]?.id
          || null
        );
        if (!projectId) {
          const project = createSalaryProject('Project 1', projects);
          projects = [project];
          projectId = project.id;
        }
        if (activeProjectId !== projectId) setActiveProjectId(projectId);
        const existing = draft.workShiftEntries.filter(e => e.date === date);
        const entry = existing.length === 0
          ? createWorkShiftEntry(date, '09:30', '17:30', projectId)
          : createWorkShiftEntry(date, '14:00', '18:00', projectId);
        patchDraft({
          projects,
          workDayEntries: draft.workDayEntries.filter(e => e.date !== date),
          dayJoinEntries: draft.dayJoinEntries.filter(e => e.date !== date),
          workShiftEntries: [...draft.workShiftEntries, entry],
        });
      },
      onPatchWorkShift: (
        entryId: string,
        patch: Partial<Pick<HrWorkShiftEntry, 'startTime' | 'endTime' | 'projectId'>>,
      ) => {
        patchDraft({
          workShiftEntries: draft.workShiftEntries.map(entry => (
            entry.id === entryId ? { ...entry, ...patch } : entry
          )),
        });
      },
      onRemoveWorkShift: (entryId: string) => {
        patchDraft({
          workShiftEntries: draft.workShiftEntries.filter(e => e.id !== entryId),
        });
      },
      onAddOt: (date: string) => {
        let projects = draft.projects;
        const dayProject = workProjectIdForDate(draft.workDayEntries, date);
        let projectId = (
          dayProject
          || (activeProjectId && projects.some(p => p.id === activeProjectId)
            ? activeProjectId
            : null)
          || projects[0]?.id
          || null
        );
        if (!projectId) {
          const project = createSalaryProject('Project 1', projects);
          projects = [project];
          projectId = project.id;
        }
        if (activeProjectId !== projectId) setActiveProjectId(projectId);
        const existing = draft.overtimeEntries.filter(e => e.date === date);
        const startTime = existing.length === 0 ? '18:00' : '06:00';
        const endTime = existing.length === 0 ? '20:00' : '08:00';
        patchDraft({
          projects,
          overtimeEntries: [
            ...draft.overtimeEntries,
            createOvertimeEntry(date, startTime, endTime, projectId),
          ],
        });
      },
      onPatchOt: (
        entryId: string,
        patch: Partial<Pick<HrOvertimeEntry, 'startTime' | 'endTime' | 'projectId'>>,
      ) => {
        patchDraft({
          overtimeEntries: draft.overtimeEntries.map(entry => (
            entry.id === entryId ? { ...entry, ...patch } : entry
          )),
        });
      },
      onRemoveOt: (entryId: string) => {
        patchDraft({
          overtimeEntries: draft.overtimeEntries.filter(e => e.id !== entryId),
        });
      },
      onAddWorklog: (date: string) => {
        patchDraft({
          worklogEntries: [...draft.worklogEntries, createWorklogEntry(date)],
        });
      },
      onPatchWorklog: (
        entryId: string,
        patch: Partial<Pick<HrWorklogEntry, 'text'>>,
      ) => {
        patchDraft({
          worklogEntries: draft.worklogEntries.map(entry => (
            entry.id === entryId ? { ...entry, ...patch } : entry
          )),
        });
      },
      onRemoveWorklog: (entryId: string) => {
        patchDraft({
          worklogEntries: draft.worklogEntries.filter(e => e.id !== entryId),
        });
      },
      onAddExpense: (date: string) => {
        patchDraft({
          expenseEntries: [...draft.expenseEntries, createExpenseEntry(date)],
        });
      },
      onPatchExpense: (
        entryId: string,
        patch: Partial<Pick<HrExpenseEntry, 'amount' | 'note'>>,
      ) => {
        patchDraft({
          expenseEntries: draft.expenseEntries.map(entry => (
            entry.id === entryId ? { ...entry, ...patch } : entry
          )),
        });
      },
      onRemoveExpense: (entryId: string) => {
        patchDraft({
          expenseEntries: draft.expenseEntries.filter(e => e.id !== entryId),
        });
      },
      onAddReceipt: (date: string, kind: HrSalaryReceiptKind) => {
        patchDraft({
          receiptEntries: [...draft.receiptEntries, createSalaryReceiptEntry(date, kind)],
        });
      },
      onPatchReceipt: (
        entryId: string,
        patch: Partial<Pick<HrSalaryReceiptEntry, 'amount' | 'note' | 'kind'>>,
      ) => {
        patchDraft({
          receiptEntries: draft.receiptEntries.map(entry => (
            entry.id === entryId ? { ...entry, ...patch } : entry
          )),
        });
      },
      onRemoveReceipt: (entryId: string) => {
        patchDraft({
          receiptEntries: draft.receiptEntries.filter(e => e.id !== entryId),
        });
      },
    };
  }, [editMode, draft, selectedDate, activeProjectId, patchDraft]);

  if (loading) {
    return (
      <div className="hr-salary-public">
        <div className="hr-salary-public__state">
          <div className="loader-ring" />
          <p>Loading salary page…</p>
        </div>
      </div>
    );
  }

  if (error || !share || !display) {
    return (
      <div className="hr-salary-public">
        <div className="hr-salary-public__state">
          <h1>Link unavailable</h1>
          <p>{error || 'This salary link is invalid or has been removed.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hr-salary-public">
      <div className="hr-salary-public__shell">
        <div className="hr-salary-public__toolbar" role="group" aria-label="Page controls">
          <label className="hr-salary-public__month">
            <span className="text-sm text-muted">Month</span>
            <input
              type="month"
              className="input-field"
              value={salaryPeriodKey({ year: display.year, month: display.month })}
              disabled={switchingPeriod}
              onChange={e => {
                void handleMonthChange(e.target.value);
              }}
            />
          </label>
          <div className="hr-salary-public__mode-toggle">
            <button
              type="button"
              className={!editMode ? 'is-active' : ''}
              onClick={exitEdit}
            >
              View
            </button>
            <button
              type="button"
              className={editMode ? 'is-active' : ''}
              onClick={enterEdit}
            >
              Edit
            </button>
          </div>
          {switchingPeriod ? (
            <span className="hr-salary-public__toolbar-hint text-muted text-sm">
              Loading month…
            </span>
          ) : null}
          {periodError ? (
            <span className="hr-salary-public__toolbar-hint text-sm" role="alert">
              {periodError}
            </span>
          ) : null}
          {editMode ? (
            <span className="hr-salary-public__toolbar-hint text-muted text-sm">
              Changes save automatically to Firebase
            </span>
          ) : null}
        </div>
        <HrSalaryShareView
          displayName={display.displayName}
          period={{ year: display.year, month: display.month }}
          monthlySalary={display.monthlySalary}
          perDaySalary={display.perDaySalary}
          otPerDaySalary={display.otPerDaySalary}
          leaveEntries={display.leaveEntries}
          projects={display.projects}
          workDayEntries={display.workDayEntries}
          workShiftEntries={display.workShiftEntries}
          dayJoinEntries={display.dayJoinEntries ?? []}
          worklogEntries={display.worklogEntries ?? []}
          expenseEntries={display.expenseEntries ?? []}
          receiptEntries={display.receiptEntries ?? []}
          overtimeEntries={display.overtimeEntries}
          holidays={display.holidays}
          edit={editHandlers}
          saveStatus={editMode ? saveStatus : 'idle'}
          saveError={saveError}
        />
      </div>
    </div>
  );
};
