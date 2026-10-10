import { Timestamp } from 'firebase/firestore';

export function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const row = value as { toDate?: unknown; seconds?: unknown; _seconds?: unknown };
    if (typeof row.toDate === 'function') {
      try {
        const date = (row.toDate as () => Date)();
        if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
      } catch {
        // Fall through to seconds / string parsing.
      }
    }
    const seconds = Number(row.seconds ?? row._seconds);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    const timestamp = /Timestamp\(seconds=(\d+)/.exec(raw);
    if (timestamp) {
      const parsed = new Date(Number(timestamp[1]) * 1000);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (/^\d{10,13}$/.test(raw)) {
      const ms = raw.length > 10 ? Number(raw) : Number(raw) * 1000;
      const parsed = new Date(ms);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
