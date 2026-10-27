import assert from 'node:assert/strict';
import test from 'node:test';
import {
  holidayPatchForShare,
  periodsFromHolidayDocs,
  salaryRateDays,
} from './hr-salary-share-holidays.js';

test('October 2026 with two weekday holidays uses 25 rate days', () => {
  const holidays = [
    { date: '2026-10-02', name: 'Gandhi Jayanthi' },
    { date: '2026-10-20', name: 'Maha Navami' },
    { date: '2026-10-04', name: 'Sunday holiday' },
  ];
  assert.equal(salaryRateDays(2026, 10, holidays), 25);
});

test('holiday patch rewrites a stale salary snapshot and the day rate', () => {
  const patch = holidayPatchForShare(
    {
      monthlySalary: 40000,
      perDaySalary: 1481.48,
      holidays: [],
    },
    [
      { date: '2026-10-20', name: 'Maha Navami' },
      { date: '2026-10-02', name: 'Gandhi Jayanthi' },
    ],
    2026,
    10,
    '2026-10-27T00:00:00.000Z',
  );
  assert.deepEqual(patch, {
    holidays: [
      { date: '2026-10-02', name: 'Gandhi Jayanthi' },
      { date: '2026-10-20', name: 'Maha Navami' },
    ],
    perDaySalary: 1600,
    updatedAt: '2026-10-27T00:00:00.000Z',
  });
});

test('holiday patch skips a share that already matches', () => {
  const holidays = [{ date: '2026-10-02', name: 'Gandhi Jayanthi' }];
  const patch = holidayPatchForShare(
    { monthlySalary: 40000, perDaySalary: 1538.46, holidays },
    holidays,
    2026,
    10,
  );
  assert.equal(patch, null);
});

test('moving a holiday refreshes both months', () => {
  assert.deepEqual(
    periodsFromHolidayDocs(
      { date: '2026-10-02' },
      { date: '2026-11-02' },
    ),
    [
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
    ],
  );
});
