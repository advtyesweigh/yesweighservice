export const COMPANY_DID = '914847123223';
export const CALL_PAGE_SIZE = 10;
export const MISSED_FOLLOW_UP_TEXT = 'Have you called to Interweighing?';

export type CallListStatus = 'incoming' | 'missed' | 'received' | 'outbound';
export type CallStatusFilter = 'all' | CallListStatus;
export type CallTypeFilter = 'all' | 'sales' | 'service';
export type CallPeriod = 'last24h' | 'today' | 'yesterday' | 'month' | 'custom';

export type PhoneTower = {
  lat?: number | null;
  lng?: number | null;
  place?: string;
};

export type TranscriptTurn = {
  speaker: 'agent' | 'customer';
  text: string;
};

export type PhoneEvent = {
  id: string;
  provider: string;
  direction: string;
  from: string;
  to: string;
  didNumber: string;
  deviceLine: string;
  status: string;
  durationSeconds: number | null;
  recordingUrl: string;
  agent: string;
  employeeName: string;
  employeeUid: string;
  androidId: string;
  startedAt: string;
  endedAt: string;
  receivedAt: Date | null;
  dtmf: string;
  callType: '' | 'sales' | 'service';
  missedFollowedUp: boolean;
  missedFollowedUpBy: string;
  tower: PhoneTower | null;
  transcript: string;
  malayalamText: string;
  transcriptTurns: TranscriptTurn[];
  transcriptSingleSpeaker: boolean;
  payload: Record<string, unknown>;
  callerName: string;
};

export type CallFilters = {
  period: CallPeriod;
  customDate: string;
  agent: string;
  number: string;
  status: CallStatusFilter;
  type: CallTypeFilter;
};

export type CallRow = {
  event: PhoneEvent;
  status: CallListStatus;
  repeatCount: number;
  occurred: Date;
};

export const DEFAULT_CALL_FILTERS: CallFilters = {
  period: 'last24h',
  customDate: '',
  agent: 'all',
  number: `did:${COMPANY_DID}`,
  status: 'all',
  type: 'all',
};

export function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function national10(value: string): string {
  const digits = digitsOnly(value);
  if (digits.length >= 12 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

export function indiaE164(value: string): string {
  const local = national10(value);
  if (local.length === 10) return `91${local}`;
  return digitsOnly(value);
}

export function isIndianMobile(value: string): boolean {
  const local = national10(value);
  return local.length === 10 && /^[6-9]/.test(local);
}

export function remoteParty(event: PhoneEvent): string {
  return String(event.direction).toLowerCase() === 'outbound' ? event.to : event.from;
}

export function occurredAt(event: PhoneEvent): Date | null {
  if (event.receivedAt) return event.receivedAt;
  const parsed = Date.parse(event.startedAt || '');
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function listCallStatus(event: PhoneEvent): CallListStatus {
  const direction = String(event.direction || '').toLowerCase();
  const status = String(event.status || '').toLowerCase();
  const duration = event.durationSeconds;
  const settled = Boolean(event.payload?.cdr);
  if (direction === 'outbound' || /outbound|outgoing/.test(status)) return 'outbound';
  const live = /ring|progress|started|start|live|incoming/.test(status);
  if (live && !(duration && duration > 0)) return 'incoming';
  const named = /answer|miss|receiv|busy|no.?answer|cancel|fail|complete|hang|abandon/.test(status);
  if (!settled && !(duration && duration > 0) && !named) return 'incoming';
  if (/miss|no.?answer|busy|cancel|fail|unanswer|not.?answer|abandon/.test(status)) return 'missed';
  return 'received';
}

export function callTypeFromEvent(event: PhoneEvent): '' | 'sales' | 'service' {
  if (event.callType === 'sales' || event.callType === 'service') return event.callType;
  const dtmf = String(event.dtmf || '').trim();
  if (dtmf.startsWith('1')) return 'sales';
  if (dtmf.startsWith('2')) return 'service';
  const payload = event.payload || {};
  const hint = String(payload.department || payload.queue || payload.ivr || '').toLowerCase();
  if (hint.includes('sale')) return 'sales';
  if (hint.includes('service')) return 'service';
  return '';
}

export function formatTalk(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

export function formatElapsed(at: Date, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - at.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const left = hours % 24;
  return left ? `${days}d ${left}h` : `${days}d`;
}

export function formatCallerNumber(raw: string, desktop: boolean): string {
  const digits = digitsOnly(raw);
  const local = national10(raw);
  if (local.length !== 10) return raw || digits;
  const compact = `${local.slice(0, 5)} ${local.slice(5)}`;
  if (digits.length === 12 && digits.startsWith('91') && desktop) return `+91 ${compact}`;
  return compact;
}

export function whenParts(date: Date): { date: string; time: string } {
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function periodRange(filters: CallFilters, now = new Date()): { start: Date; end: Date } | null {
  if (filters.period === 'last24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  }
  if (filters.period === 'today') return { start: startOfDay(now), end: now };
  if (filters.period === 'yesterday') {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 1);
    return { start, end: startOfDay(now) };
  }
  if (filters.period === 'month') {
    const start = startOfDay(now);
    start.setDate(1);
    return { start, end: now };
  }
  if (filters.period === 'custom' && filters.customDate) {
    const start = startOfDay(new Date(`${filters.customDate}T00:00:00`));
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  return null;
}

function numberMatches(event: PhoneEvent, token: string): boolean {
  if (!token || token === 'all') return true;
  const line = digitsOnly(`${event.didNumber}${event.deviceLine}`);
  const target = digitsOnly(token.replace(/^did:|^sim:/, ''));
  if (!target) return true;
  return line.endsWith(target) || digitsOnly(event.didNumber) === target || digitsOnly(event.deviceLine) === target;
}

function handlerName(event: PhoneEvent): string {
  return event.employeeName || event.agent || '';
}

export function preFilterEvents(events: PhoneEvent[], filters: CallFilters, now = new Date()): PhoneEvent[] {
  const range = periodRange(filters, now);
  return events.filter(event => {
    const at = occurredAt(event);
    if (!at) return false;
    if (range && (at < range.start || at >= range.end) && filters.period !== 'last24h') return false;
    if (range && filters.period === 'last24h' && (at < range.start || at > range.end)) return false;
    if (filters.agent !== 'all' && handlerName(event) !== filters.agent) return false;
    if (!numberMatches(event, filters.number)) return false;
    return true;
  });
}

function durationClose(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 2;
}

function companyTrunk(event: PhoneEvent): boolean {
  return digitsOnly(event.didNumber).endsWith(COMPANY_DID.slice(-10))
    || digitsOnly(event.didNumber) === COMPANY_DID;
}

function collapseDuplicates(events: PhoneEvent[]): PhoneEvent[] {
  const sorted = [...events].sort((a, b) => (occurredAt(a)?.getTime() || 0) - (occurredAt(b)?.getTime() || 0));
  const kept: PhoneEvent[] = [];
  for (const event of sorted) {
    const at = occurredAt(event)?.getTime() || 0;
    const party = national10(remoteParty(event));
    const previous = kept[kept.length - 1];
    if (!previous || !party || party.length < 8) {
      kept.push(event);
      continue;
    }
    const prevAt = occurredAt(previous)?.getTime() || 0;
    const same = party === national10(remoteParty(previous))
      && String(previous.direction).toLowerCase() === String(event.direction).toLowerCase()
      && Math.abs(at - prevAt) <= 15000
      && durationClose(previous.durationSeconds, event.durationSeconds);
    if (!same) {
      kept.push(event);
      continue;
    }
    const preferCurrent = (companyTrunk(event) && !companyTrunk(previous))
      || (event.provider !== 'staff-device' && previous.provider === 'staff-device')
      || Boolean(event.recordingUrl && !previous.recordingUrl);
    if (preferCurrent) kept[kept.length - 1] = event;
  }
  return kept;
}

function collapseRepeatMissed(events: PhoneEvent[]): CallRow[] {
  const missed = events
    .map(event => ({ event, status: listCallStatus(event), at: occurredAt(event) }))
    .filter(row => row.status === 'missed' && row.at);
  const others = events.filter(event => listCallStatus(event) !== 'missed');
  const clusters: { event: PhoneEvent; at: Date; count: number }[] = [];
  const sorted = missed.sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0));
  for (const row of sorted) {
    const party = national10(remoteParty(row.event));
    const last = clusters[clusters.length - 1];
    const lastParty = last ? national10(remoteParty(last.event)) : '';
    if (last && party && party === lastParty && row.at && row.at.getTime() - last.at.getTime() <= 30 * 60 * 1000) {
      last.event = row.event;
      last.at = row.at;
      last.count += 1;
    } else if (row.at) {
      clusters.push({ event: row.event, at: row.at, count: 1 });
    }
  }
  const rows: CallRow[] = [
    ...others.flatMap(event => {
      const occurred = occurredAt(event);
      if (!occurred) return [];
      return [{ event, status: listCallStatus(event), repeatCount: 1, occurred }];
    }),
    ...clusters.map(cluster => ({
      event: cluster.event,
      status: 'missed' as const,
      repeatCount: cluster.count,
      occurred: cluster.at,
    })),
  ];
  return rows.filter(row => {
    if (row.status !== 'missed') return true;
    const party = national10(remoteParty(row.event));
    return !rows.some(other => {
      if (other.status !== 'received' && other.status !== 'incoming') return false;
      if (national10(remoteParty(other.event)) !== party) return false;
      if (other.occurred.toDateString() !== row.occurred.toDateString()) return false;
      const delta = other.occurred.getTime() - row.occurred.getTime();
      return delta >= 0 && delta <= 10 * 60 * 1000;
    });
  });
}

export function collapseCalls(events: PhoneEvent[]): CallRow[] {
  return collapseRepeatMissed(collapseDuplicates(events))
    .sort((a, b) => b.occurred.getTime() - a.occurred.getTime());
}

export function isOpenMissed(row: CallRow): boolean {
  return row.status === 'missed' && !row.event.missedFollowedUp && !row.event.missedFollowedUpBy;
}

export function visibleCalls(rows: CallRow[], filters: CallFilters): CallRow[] {
  return rows.filter(row => {
    const type = callTypeFromEvent(row.event);
    if (filters.type !== 'all' && type !== filters.type) return false;
    if (filters.status === 'all') return true;
    if (filters.status === 'missed') return isOpenMissed(row);
    return row.status === filters.status;
  });
}

export type CallStats = {
  total: number;
  missed: number;
  received: number;
  outbound: number;
  inboundSeconds: number;
  outboundSeconds: number;
  totalSeconds: number;
};

export function callStats(rows: CallRow[]): CallStats {
  const stats: CallStats = {
    total: rows.length,
    missed: 0,
    received: 0,
    outbound: 0,
    inboundSeconds: 0,
    outboundSeconds: 0,
    totalSeconds: 0,
  };
  for (const row of rows) {
    if (row.status === 'missed' && isOpenMissed(row)) stats.missed += 1;
    if (row.status === 'received') stats.received += 1;
    if (row.status === 'outbound') stats.outbound += 1;
    const seconds = row.event.durationSeconds || 0;
    if (row.status === 'received' || row.status === 'incoming') stats.inboundSeconds += seconds;
    if (row.status === 'outbound') stats.outboundSeconds += seconds;
  }
  stats.totalSeconds = stats.inboundSeconds + stats.outboundSeconds;
  return stats;
}

export function filtersDiffer(filters: CallFilters, defaults: CallFilters = DEFAULT_CALL_FILTERS): boolean {
  return filters.period !== defaults.period
    || filters.customDate !== defaults.customDate
    || filters.agent !== defaults.agent
    || filters.number !== defaults.number
    || filters.status !== defaults.status
    || filters.type !== defaults.type;
}

export function activeFilterCount(filters: CallFilters): number {
  const defaults = DEFAULT_CALL_FILTERS;
  let count = 0;
  if (filters.period !== defaults.period || filters.customDate) count += 1;
  if (filters.agent !== defaults.agent) count += 1;
  if (filters.number !== defaults.number) count += 1;
  if (filters.status !== defaults.status) count += 1;
  if (filters.type !== defaults.type) count += 1;
  return count;
}

export function openMissedLast24h(events: PhoneEvent[], now = Date.now()): number {
  const cutoff = now - 24 * 60 * 60 * 1000;
  return collapseCalls(events).filter(row => {
    if (!isOpenMissed(row)) return false;
    if (!companyTrunk(row.event) && digitsOnly(row.event.didNumber) && digitsOnly(row.event.didNumber) !== COMPANY_DID) {
      return false;
    }
    return row.occurred.getTime() >= cutoff;
  }).length;
}
