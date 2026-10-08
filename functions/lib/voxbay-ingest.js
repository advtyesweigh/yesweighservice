import { createHmac, timingSafeEqual } from 'node:crypto';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

const EVENTS = new Set(['call_start', 'call_connect', 'call_end', 'cdr', 'dtmf']);
const DIRECTIONS = new Set(['incoming', 'outgoing', 'transfer']);
const RANK = { call_start: 1, dtmf: 1, call_connect: 2, call_end: 3, cdr: 4 };

function text(value) {
  return String(value ?? '').trim();
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function callTypeOf(dtmf, body) {
  const explicit = text(body.callType || body.department).toLowerCase();
  if (explicit === 'sales' || explicit === 'service') return explicit;
  const key = text(dtmf);
  if (key.startsWith('1')) return 'sales';
  if (key.startsWith('2')) return 'service';
  const hint = text(body.department || body.queue || body.ivr).toLowerCase();
  if (hint.includes('sale')) return 'sales';
  if (hint.includes('service')) return 'service';
  return '';
}

function secondsOf(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function parseWhen(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return Timestamp.fromDate(new Date(parsed));
}

function docId(callId, eventId) {
  const raw = digits(callId) || text(callId).replace(/[^\w-]/g, '') || text(eventId).replace(/[^\w-]/g, '');
  return `vx_${raw || 'event'}`.slice(0, 700);
}

function headerEvent(req) {
  const raw = text(req.get('x-voxbay-event')).toLowerCase();
  const [event, direction] = raw.split('.');
  if (!EVENTS.has(event) || !DIRECTIONS.has(direction)) return null;
  return { event, direction, id: text(req.get('x-voxbay-event-id')) };
}

export async function handleVoxbayCall(req, res, secret = '') {
  if (req.method === 'GET') {
    res.status(200).send('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('POST only');
    return;
  }
  const meta = headerEvent(req);
  if (!meta?.id || !/^t=\d+,v1=[a-f0-9]+/i.test(text(req.get('x-voxbay-signature')))) {
    res.status(401).send('Unauthorized');
    return;
  }
  if (secret) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
    const id = meta.id;
    const header = text(req.get('x-voxbay-signature'));
    const stamp = (header.match(/t=(\d+)/) || [])[1] || '';
    const signed = createHmac('sha256', secret).update(`${id}.${stamp}.${raw.toString('utf8')}`).digest('hex');
    const given = (header.match(/v1=([a-f0-9]+)/i) || [])[1] || '';
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(signed, 'hex');
    if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).send('Unauthorized');
      return;
    }
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const direction = meta.direction === 'outgoing' ? 'outbound' : 'inbound';
  const dtmf = text(body.dtmf || body.key);
  const when = parseWhen(body.startedAt) || parseWhen(body.endedAt) || Timestamp.now();
  const id = docId(body.callId, meta.id);
  const next = {
    provider: 'voxbay',
    direction,
    from: text(body.from),
    to: text(body.to),
    didNumber: digits(body.did),
    deviceLine: '',
    status: text(body.status) || (meta.event === 'call_start' ? 'ringing' : ''),
    durationSeconds: secondsOf(body.duration),
    recordingUrl: /^https?:\/\//i.test(text(body.recordingUrl)) ? text(body.recordingUrl) : '',
    agent: text(body.agent),
    employeeName: text(body.agent),
    employeeUid: '',
    androidId: '',
    startedAt: text(body.startedAt),
    endedAt: text(body.endedAt),
    receivedAt: when,
    dtmf,
    callType: callTypeOf(dtmf, body),
    callerName: text(body.callerName),
    eventRank: RANK[meta.event] || 1,
    voxbayEvent: `${meta.event}.${meta.direction}`,
    payload: {
      cdr: meta.event === 'cdr' || meta.event === 'call_end',
      event: meta.event,
      extension: text(body.extension),
      agentPhone: text(body.agentPhone),
      totalDuration: body.totalDuration ?? null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = getFirestore().collection('phoneEvents').doc(id);
  await getFirestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() || {} : {};
    if (meta.event === 'dtmf') {
      tx.set(ref, {
        dtmf: next.dtmf || prev.dtmf || '',
        callType: next.callType || prev.callType || '',
        provider: 'voxbay',
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { ...next, missedFollowedUp: false, missedFollowedUpBy: '' }),
      }, { merge: true });
      return;
    }
    if (Number(prev.eventRank || 0) > next.eventRank) return;
    tx.set(ref, {
      ...next,
      missedFollowedUp: Boolean(prev.missedFollowedUp),
      missedFollowedUpBy: text(prev.missedFollowedUpBy),
      createdAt: prev.createdAt || FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  res.status(200).json({ ok: true });
}
