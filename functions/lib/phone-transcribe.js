/**
 * Call-log speech-to-text. Downloads the recording the play button already uses
 * and runs Sarvam Saaras (auto language). Saves the transcript on phoneEvents
 * so a later view does not call Sarvam again. Never logs the API key or the URL.
 */
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { loadSarvamApiKey } from './sarvam.js';
import { sarvamSpeechToText } from './whatsapp-voice-translate.js';

const EVENTS = 'phoneEvents';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SECONDS = 20 * 60;
/** Match the callable timeout so a second tap does not start a parallel job. */
const PROCESSING_WINDOW_MS = 10 * 60 * 1000;

function trim(value) {
  return String(value ?? '').trim();
}

function fail(message, code = 'failed-precondition') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isMalayalam(languageCode, text) {
  if (/^ml\b/i.test(trim(languageCode))) return true;
  return /[\u0D00-\u0D7F]/.test(String(text || ''));
}

function safeMessage(err) {
  const raw = trim(err?.message) || 'Could not transcribe this recording.';
  if (
    /api[_-]?key|subscription-key|sarvam\.ai|https?:\/\//i.test(raw)
    || /^(internal|unavailable|unknown|not-found)$/i.test(raw)
  ) {
    return 'Could not transcribe this recording.';
  }
  return raw.slice(0, 240);
}

function contentTypeFor(header, url) {
  const raw = trim(header).split(';')[0].toLowerCase();
  if (raw.startsWith('audio/')) return raw;
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg') || path.endsWith('.opus')) return 'audio/ogg';
  if (path.endsWith('.m4a') || path.endsWith('.mp4') || path.endsWith('.aac')) return 'audio/mp4';
  if (path.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

async function downloadRecording(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    console.warn('phone recording download failed', err?.name || 'error');
    throw fail('Could not download this recording.', 'unavailable');
  }
  if (!res.ok) throw fail('Could not download this recording.', 'unavailable');
  const advertised = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(advertised) && advertised > MAX_BYTES) {
    throw fail('Recording is too large to transcribe.', 'failed-precondition');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw fail('Recording is empty.', 'failed-precondition');
  if (buffer.length > MAX_BYTES) {
    throw fail('Recording is too large to transcribe.', 'failed-precondition');
  }
  return {
    buffer,
    contentType: contentTypeFor(res.headers.get('content-type'), url),
  };
}

function startedMs(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return 0;
}

/**
 * Transcribe one phoneEvents recording. Returns the saved transcript when
 * Sarvam already ran. A recent in-flight job returns status "processing".
 */
export async function transcribePhoneCall(data) {
  const eventId = trim(data?.eventId).replace(/[/\s]/g, '');
  if (!eventId) throw fail('Call is required.', 'invalid-argument');

  const ref = getFirestore().collection(EVENTS).doc(eventId);
  const claim = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw fail('Could not find that call.', 'not-found');
    const row = snap.data() || {};
    const transcript = trim(row.transcript);
    if (transcript) {
      return {
        kind: 'saved',
        transcript,
        languageCode: trim(row.transcriptLanguage),
        malayalamText: trim(row.malayalamText),
      };
    }
    const status = trim(row.transcriptionStatus).toLowerCase();
    const started = startedMs(row.transcriptionStartedAt);
    if (status === 'processing' && started && Date.now() - started < PROCESSING_WINDOW_MS) {
      return { kind: 'processing' };
    }
    const recordingUrl = trim(row.recordingUrl);
    if (!/^https?:\/\//i.test(recordingUrl)) {
      throw fail('This call has no recording to transcribe.', 'failed-precondition');
    }
    const duration = Number(row.durationSeconds);
    if (Number.isFinite(duration) && duration > MAX_SECONDS) {
      throw fail('This recording is too long to transcribe.', 'failed-precondition');
    }
    tx.set(ref, {
      transcriptionStatus: 'processing',
      transcriptionError: '',
      transcriptionStartedAt: FieldValue.serverTimestamp(),
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: 'run', recordingUrl };
  });

  if (claim.kind === 'saved') {
    return {
      ok: true,
      status: 'completed',
      skipped: true,
      transcript: claim.transcript,
      languageCode: claim.languageCode || '',
      malayalamText: claim.malayalamText || '',
    };
  }
  if (claim.kind === 'processing') {
    return {
      ok: true,
      status: 'processing',
      skipped: true,
      transcript: '',
      languageCode: '',
      malayalamText: '',
    };
  }

  try {
    const apiKey = await loadSarvamApiKey();
    if (!apiKey) throw fail('Transcription is not configured.', 'failed-precondition');
    const { buffer, contentType } = await downloadRecording(claim.recordingUrl);
    const stt = await sarvamSpeechToText(buffer, contentType, apiKey);
    const transcript = trim(stt.transcript);
    if (!transcript) throw fail('No speech detected in this recording.', 'failed-precondition');
    const languageCode = trim(stt.languageCode);
    const malayalamText = isMalayalam(languageCode, transcript) ? transcript : '';
    await ref.set({
      transcript,
      transcriptLanguage: languageCode,
      transcriptSingleSpeaker: false,
      ...(malayalamText ? { malayalamText } : {}),
      transcriptionStatus: 'completed',
      transcriptionError: '',
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      ok: true,
      status: 'completed',
      skipped: false,
      transcript,
      languageCode,
      malayalamText,
    };
  } catch (err) {
    const message = safeMessage(err);
    await ref.set({
      transcriptionStatus: 'failed',
      transcriptionError: message,
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    if (err?.code) {
      err.message = message;
      throw err;
    }
    throw fail(message, 'unavailable');
  }
}
