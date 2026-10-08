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
import { db } from '../firebase';
import {
  listCallStatus,
  national10,
  remoteParty,
  type PhoneEvent,
  type PhoneTower,
  type TranscriptTurn,
} from './phoneLog';

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

export function mapPhoneEvent(id: string, data: Record<string, unknown>): PhoneEvent {
  const receivedMs = millisOf(data.receivedAt);
  const turns = Array.isArray(data.transcriptTurns) ? data.transcriptTurns : [];
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
    transcriptTurns: turns.flatMap(turn => {
      const row = asRecord(turn);
      const speaker = row.speaker === 'agent' ? 'agent' : row.speaker === 'customer' ? 'customer' : '';
      const text = String(row.text || '').trim();
      if (!speaker || !text) return [];
      return [{ speaker, text } satisfies TranscriptTurn];
    }),
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
