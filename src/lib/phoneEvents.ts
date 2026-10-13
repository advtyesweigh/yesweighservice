import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { app, db } from '../firebase';
import {
  listCallStatus,
  national10,
  remoteParty,
  type PhoneEvent,
  type PhoneTower,
  type TranscriptTurn,
} from './phoneLog';

const functions = getFunctions(app, 'asia-south1');

export const PHONE_EVENTS = 'phoneEvents';

function millisOf(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'object' && value && 'toMillis' in value) {
    const toMillis = (value as Timestamp).toMillis;
    if (typeof toMillis === 'function') return toMillis.call(value);
  }
  if (typeof value === 'object' && value && 'seconds' in value) {
    return Number((value as { seconds: number }).seconds) * 1000;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseTranscriptTurns(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(turn => {
    const row = asRecord(turn);
    const role = String(row.speaker || row.role || '');
    const speaker = role === 'agent' || role === 'customer' ? role : '';
    const text = String(row.malayalamText || row.text || '').trim();
    if (!speaker || !text) return [];
    return [{ speaker, text } satisfies TranscriptTurn];
  });
}

export function mapPhoneEvent(id: string, data: Record<string, unknown>): PhoneEvent {
  const receivedMs = millisOf(data.receivedAt);
  const turns = parseTranscriptTurns(data.transcriptTurns);
  const towerRaw = asRecord(data.tower);
  const tower: PhoneTower | null = data.tower
    ? {
      lat: towerRaw.lat == null || towerRaw.lat === '' ? null : Number(towerRaw.lat),
      lng: towerRaw.lng == null || towerRaw.lng === '' ? null : Number(towerRaw.lng),
      place: String(towerRaw.place || ''),
      lac: String(towerRaw.lac || ''),
      cid: String(towerRaw.cid || ''),
      source: String(towerRaw.source || ''),
      accuracy: towerRaw.accuracy == null || towerRaw.accuracy === '' ? null : Number(towerRaw.accuracy),
    }
    : null;
  const callType = data.callType === 'sales' || data.callType === 'service' ? data.callType : '';
  return {
    id,
    provider: String(data.provider || ''),
    direction: String(data.direction || ''),
    from: String(data.from || ''),
    to: String(data.to || ''),
    didNumber: String(data.didNumber || ''),
    deviceLine: String(data.deviceLine || ''),
    status: String(data.status || ''),
    durationSeconds: data.durationSeconds == null || data.durationSeconds === ''
      ? null
      : Number(data.durationSeconds),
    recordingUrl: String(data.recordingUrl || ''),
    agent: String(data.agent || ''),
    employeeName: String(data.employeeName || ''),
    employeeUid: String(data.employeeUid || ''),
    androidId: String(data.androidId || ''),
    startedAt: String(data.startedAt || ''),
    endedAt: String(data.endedAt || ''),
    receivedAt: receivedMs ? new Date(receivedMs) : null,
    dtmf: String(data.dtmf || ''),
    callType,
    missedFollowedUp: Boolean(data.missedFollowedUp),
    missedFollowedUpBy: String(data.missedFollowedUpBy || ''),
    tower,
    transcript: String(data.transcript || ''),
    malayalamText: String(data.malayalamText || ''),
    transcriptionStatus: String(data.transcriptionStatus || ''),
    transcriptionError: String(data.transcriptionError || ''),
    transcriptTurns: turns,
    transcriptSingleSpeaker: Boolean(data.transcriptSingleSpeaker),
    payload: asRecord(data.payload),
    callerName: String(data.callerName || ''),
  };
}

export function subscribePhoneEvents(
  onChange: (rows: PhoneEvent[]) => void,
  onError: (error: Error) => void,
): () => void {
  const q = query(collection(db, PHONE_EVENTS), orderBy('receivedAt', 'desc'), limit(1000));
  return onSnapshot(q, snap => {
    onChange(snap.docs.map(item => mapPhoneEvent(item.id, item.data())));
  }, err => onError(err));
}

export async function markMissedFollowedUp(
  events: PhoneEvent[],
  source: PhoneEvent,
  byName: string,
): Promise<void> {
  const party = national10(remoteParty(source));
  const at = source.receivedAt?.getTime() || Date.parse(source.startedAt || '') || 0;
  const related = events.filter(event => {
    if (listCallStatus(event) !== 'missed') return false;
    if (event.missedFollowedUp || event.missedFollowedUpBy) return false;
    if (national10(remoteParty(event)) !== party) return false;
    const when = event.receivedAt?.getTime() || Date.parse(event.startedAt || '') || 0;
    return Math.abs(when - at) <= 30 * 60 * 1000;
  });
  const ids = new Set([source.id, ...related.map(event => event.id)]);
  const batch = writeBatch(db);
  const now = new Date();
  ids.forEach(id => {
    batch.update(doc(db, PHONE_EVENTS, id), {
      missedFollowedUp: true,
      missedFollowedUpBy: byName,
      missedFollowedUpAt: now,
    });
  });
  await batch.commit();
}

export type PhoneTranscriptResult = {
  ok: boolean;
  status: 'completed' | 'processing';
  skipped: boolean;
  transcript: string;
  languageCode: string;
  malayalamText: string;
  turns: TranscriptTurn[];
  singleSpeaker: boolean;
};

const BARE_FUNCTION_ERROR = /^(internal|unavailable|unknown|not-found|not_found|deadline-exceeded|failed-precondition|functions\/[a-z-]+)$/i;

/** Callable failures often arrive as the bare status word "internal". */
export function phoneTranscriptErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  const message = raw.replace(/^FirebaseError:\s*/i, '').trim();
  if (message && !BARE_FUNCTION_ERROR.test(message)) return message;
  return 'Could not transcribe this recording.';
}

/** Transcribe the call recording with Sarvam. A saved transcript is returned without a new request. */
export async function transcribePhoneCall(eventId: string): Promise<PhoneTranscriptResult> {
  const callable = httpsCallable<{ eventId: string }, PhoneTranscriptResult>(
    functions,
    'transcribePhoneCallFn',
    { timeout: 540_000 },
  );
  try {
    const result = await callable({ eventId });
    const data = result.data;
    return {
      ok: data?.ok !== false,
      status: data?.status === 'processing' ? 'processing' : 'completed',
      skipped: Boolean(data?.skipped),
      transcript: String(data?.transcript || ''),
      languageCode: String(data?.languageCode || ''),
      malayalamText: String(data?.malayalamText || ''),
      turns: parseTranscriptTurns(data?.turns),
      singleSpeaker: data?.singleSpeaker === true,
    };
  } catch (err) {
    throw new Error(phoneTranscriptErrorMessage(err));
  }
}
