/**
 * WhatsApp Cloud API voice-note transcription via Speech-to-Text V2.
 * Runs in a Firestore background trigger / staff retry callable — never in the webhook.
 * Keeps text-message translation fields untouched.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import ffmpegPath from 'ffmpeg-static';
import { GoogleAuth } from 'google-auth-library';
import { assertSalesOrAdmin } from './assert-admin.js';

const PROJECT_ID = 'yesweigh-service';
const MESSAGES_COLLECTION = 'whatsappMessages';
const SETTINGS_PATH = 'whatsappSettings/config';
const GRAPH_VERSION = 'v21.0';

/** asia-south1 only exposes en-US telephony_short; chirp_2 multilingual needs asia-southeast1. */
const SPEECH_LOCATION = 'asia-southeast1';
/** Default `_` recognizer — required for Chirp 2 `language_codes: ["auto"]`. */
const SPEECH_RECOGNIZER_ID = '_';
const SPEECH_MODEL = 'chirp_2';
/**
 * Chirp 2 allows at most 3 explicit codes for multi-language, or `auto` for
 * language-agnostic detect. Passing 5+ codes returns HTTP 400 INVALID_ARGUMENT.
 */
const SPEECH_LANGUAGE_CODES = ['auto'];

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 120;
const PROCESSING_STALE_MS = 4 * 60 * 1000;
const FAIL_MESSAGE = 'Could not transcribe audio';

let cachedGcpAccessToken = '';
let cachedGcpAccessTokenAt = 0;

function trimStr(value) {
  return String(value ?? '').trim();
}

function fail(message, code = 'failed-precondition') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function envOrSetting(settings, settingKey, envKey) {
  const saved = trimStr(settings?.[settingKey]);
  if (saved) return saved;
  return trimStr(process.env[envKey]);
}

async function loadMetaAccessToken() {
  const snap = await getFirestore().doc(SETTINGS_PATH).get();
  const settings = snap.data() ?? {};
  return envOrSetting(settings, 'metaAccessToken', 'META_ACCESS_TOKEN').replace(/^Bearer\s+/i, '');
}

async function getGcpAccessToken() {
  if (cachedGcpAccessToken && Date.now() - cachedGcpAccessTokenAt < 45 * 60 * 1000) {
    return cachedGcpAccessToken;
  }
  const auth = new GoogleAuth({
    projectId: PROJECT_ID,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const response = await client.getAccessToken();
  const token = typeof response === 'string' ? response : response?.token;
  if (!token) throw fail('No GCP access token', 'unavailable');
  cachedGcpAccessToken = token;
  cachedGcpAccessTokenAt = Date.now();
  return token;
}

export function isVoiceType(type) {
  const t = trimStr(type).toLowerCase();
  return t === 'audio' || t === 'voice' || t === 'ptt';
}

export function isInbound(row) {
  const direction = trimStr(row?.direction).toLowerCase();
  if (direction === 'inbound' || direction === 'incoming' || direction === 'received') return true;
  if (direction === 'outbound' || direction === 'outgoing' || direction === 'sent') return false;
  return row?.owner !== true;
}

function isEnglishLang(code) {
  return /^en([_-]|$)/i.test(trimStr(code));
}

function graphMediaIdFromRow(row) {
  const direct = trimStr(row?.mediaId || row?.whatsappMediaId);
  if (direct && !/^wamid\./i.test(direct)) return direct;
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  for (const key of ['audio', 'voice', 'ptt', 'image', 'video', 'document', 'sticker']) {
    const part = payload[key] && typeof payload[key] === 'object' ? payload[key] : null;
    const id = trimStr(part?.id);
    if (id && !/^wamid\./i.test(id)) return id;
  }
  return '';
}

function isCachedMediaUrl(url) {
  return /firebasestorage\.googleapis\.com|storage\.googleapis\.com/i.test(trimStr(url));
}

/**
 * Mark inbound voice notes for background transcription.
 * Idempotent: never resets completed; does not re-queue active processing.
 */
export async function markTranscriptionPending(messageId, options = {}) {
  const id = trimStr(messageId).replace(/[/\s]/g, '_');
  if (!id) return { status: 'skipped', reason: 'missing-id' };
  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(id);
  const force = options.force === true;

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: 'skipped', reason: 'not-found' };
    const row = snap.data() ?? {};
    if (!isVoiceType(row.type)) return { status: 'skipped', reason: 'not-audio' };
    if (!isInbound(row)) return { status: 'skipped', reason: 'not-inbound' };

    const status = trimStr(row.transcriptionStatus).toLowerCase();
    if (!force && status === 'completed' && trimStr(row.transcript)) {
      return { status: 'skipped', reason: 'already-completed' };
    }
    if (!force && status === 'failed') {
      // Duplicate Meta webhooks must not re-bill Speech; staff retry uses force.
      return { status: 'skipped', reason: 'already-failed' };
    }
    if (!force && status === 'processing') {
      const started = row.transcriptionStartedAt?.toMillis?.() ?? 0;
      if (started && Date.now() - started < PROCESSING_STALE_MS) {
        return { status: 'skipped', reason: 'already-processing' };
      }
    }
    if (!force && status === 'pending') {
      return { status: 'skipped', reason: 'already-pending' };
    }

    tx.set(ref, {
      transcriptionStatus: 'pending',
      transcriptionError: '',
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'pending' };
  });
}

async function downloadFromMeta(mediaId, accessToken) {
  const lookup = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const info = await lookup.json().catch(() => ({}));
  if (!lookup.ok || !info?.url) {
    throw fail(
      lookup.status === 404 || lookup.status === 400
        ? 'Media is no longer available from WhatsApp.'
        : 'Could not look up WhatsApp media.',
      'failed-precondition',
    );
  }
  const download = await fetch(String(info.url), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!download.ok) {
    throw fail(
      download.status === 404
        ? 'Media is no longer available from WhatsApp.'
        : 'Could not download WhatsApp media.',
      'failed-precondition',
    );
  }
  const buffer = Buffer.from(await download.arrayBuffer());
  const contentType = String(
    download.headers.get('content-type') ?? info.mime_type ?? 'audio/ogg',
  ).split(';')[0].trim() || 'audio/ogg';
  return { buffer, contentType };
}

async function downloadFromStorage(storagePath) {
  const pathName = trimStr(storagePath).replace(/^\/+/, '');
  if (!pathName || pathName.includes('..') || !/^whatsappMedia\//.test(pathName)) {
    return null;
  }
  const file = getStorage().bucket().file(pathName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  const [meta] = await file.getMetadata().catch(() => [{}]);
  const contentType = String(meta?.contentType ?? 'audio/ogg').split(';')[0].trim() || 'audio/ogg';
  return { buffer, contentType };
}

export async function loadAudioBuffer(row) {
  const storagePath = trimStr(row.storagePath);
  if (storagePath) {
    const fromStorage = await downloadFromStorage(storagePath);
    if (fromStorage?.buffer?.length) return fromStorage;
  }

  // Prefer Meta media id (never expose URL/token to clients).
  const mediaId = graphMediaIdFromRow(row);
  if (mediaId) {
    const accessToken = await loadMetaAccessToken();
    if (!accessToken) throw fail('Save the Meta access token in Settings → WhatsApp.', 'failed-precondition');
    return downloadFromMeta(mediaId, accessToken);
  }

  // Last resort: Firebase download URL already on the message (Storage, not Meta).
  const mediaUrl = trimStr(row.mediaUrl);
  if (isCachedMediaUrl(mediaUrl)) {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw fail('Could not download cached voice note.', 'failed-precondition');
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = String(res.headers.get('content-type') || row.mimeType || 'audio/ogg')
      .split(';')[0].trim() || 'audio/ogg';
    return { buffer, contentType };
  }

  throw fail('Voice note media is not available for transcription.', 'failed-precondition');
}

function parseFfmpegDurationSeconds(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  if (![hours, mins, secs].every(Number.isFinite)) return null;
  return hours * 3600 + mins * 60 + secs;
}

export async function probeAudioDurationSeconds(buffer, extHint = 'ogg') {
  if (!ffmpegPath || !buffer?.length) return null;
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const safeExt = String(extHint || 'ogg').replace(/[^\w]/g, '') || 'ogg';
  const inPath = path.join(tmpdir(), `wa-probe-${id}.${safeExt}`);
  await fs.writeFile(inPath, buffer);
  try {
    const stderr = await new Promise((resolve) => {
      const child = spawn(ffmpegPath, ['-hide_banner', '-i', inPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errText = '';
      child.stderr.on('data', (chunk) => {
        errText += String(chunk);
        if (errText.length > 8000) errText = errText.slice(-8000);
      });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(errText));
    });
    return parseFfmpegDurationSeconds(stderr);
  } finally {
    await fs.unlink(inPath).catch(() => {});
  }
}

export function extFromMime(mime) {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('wav')) return 'wav';
  if (type.includes('amr')) return 'amr';
  return 'ogg';
}

function recognizerName() {
  return `projects/${PROJECT_ID}/locations/${SPEECH_LOCATION}/recognizers/${SPEECH_RECOGNIZER_ID}`;
}

function speechRecognizeUrl() {
  return `https://${SPEECH_LOCATION}-speech.googleapis.com/v2/${recognizerName()}:recognize`;
}

/** Staff-safe error text — never include tokens, full API bodies, or stack traces. */
function sanitizeTranscriptionError(err) {
  const raw = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
  if (!raw) return FAIL_MESSAGE;
  if (/language_codes|INVALID_ARGUMENT|Invalid arguments/i.test(raw)) {
    return 'Speech language settings rejected. Try again in a moment.';
  }
  if (/PERMISSION_DENIED|403|UNAUTHENTICATED|401/i.test(raw)) {
    return 'Speech-to-Text access denied. Check GCP Speech permissions.';
  }
  if (/Media is no longer available|Could not look up|Could not download|not available for transcription|Save the Meta access token/i.test(raw)) {
    return raw.slice(0, 180);
  }
  if (/Speech-to-Text HTTP/i.test(raw)) {
    return `Speech-to-Text failed (${raw.match(/HTTP\s+(\d+)/i)?.[1] || 'error'}).`;
  }
  if (/abort|timeout|ECONN|ENOTFOUND|fetch failed|unavailable/i.test(raw)) {
    return 'Speech-to-Text timed out. Tap Retry.';
  }
  return FAIL_MESSAGE;
}

async function recognizeWithSpeechV2(buffer) {
  const token = await getGcpAccessToken();
  // Chirp 2 language-agnostic path (auto). If the region rejects auto, fall back to
  // three primary Indian languages (API hard-caps multi-language at 3 codes).
  const attempts = [
    SPEECH_LANGUAGE_CODES,
    ['en-IN', 'ml-IN', 'hi-IN'],
  ];
  let lastErr = null;
  for (const languageCodes of attempts) {
    const body = {
      config: {
        autoDecodingConfig: {},
        languageCodes,
        model: SPEECH_MODEL,
        features: { enableAutomaticPunctuation: true },
      },
      content: buffer.toString('base64'),
    };
    const res = await fetch(speechRecognizeUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': PROJECT_ID,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return res.json().catch(() => ({}));
    }
    const text = await res.text().catch(() => '');
    const snippet = text.replace(/\s+/g, ' ').slice(0, 240);
    lastErr = new Error(`Speech-to-Text HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    lastErr.code = res.status === 404 ? 'not-found' : 'unavailable';
    // Only retry the 3-language set when auto / language_codes was the problem.
    if (!/language_codes|INVALID_ARGUMENT|Invalid arguments/i.test(snippet) && res.status !== 400) {
      throw lastErr;
    }
  }
  throw lastErr || fail(FAIL_MESSAGE, 'unavailable');
}

function extractRecognition(resultJson) {
  const results = Array.isArray(resultJson?.results) ? resultJson.results : [];
  const parts = [];
  let languageCode = '';
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const row of results) {
    const alt = Array.isArray(row?.alternatives) ? row.alternatives[0] : null;
    const transcript = trimStr(alt?.transcript);
    if (transcript) parts.push(transcript);
    if (!languageCode) languageCode = trimStr(row?.languageCode);
    const conf = Number(alt?.confidence);
    if (Number.isFinite(conf) && conf > 0) {
      confidenceSum += conf;
      confidenceCount += 1;
    }
  }

  const transcript = parts.join(' ').replace(/\s+/g, ' ').trim();
  const confidence = confidenceCount ? confidenceSum / confidenceCount : null;
  return { transcript, languageCode, confidence };
}

async function translateToMalayalam(text) {
  const token = await getGcpAccessToken();
  const res = await fetch('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': PROJECT_ID,
    },
    body: JSON.stringify({ q: text, target: 'ml', format: 'text' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw fail(`Cloud Translate HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`, 'unavailable');
  }
  const json = await res.json().catch(() => ({}));
  const translated = trimStr(json?.data?.translations?.[0]?.translatedText || '');
  return translated
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function claimProcessing(messageId, { force = false } = {}) {
  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(messageId);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not-found', row: null };
    const row = snap.data() ?? {};
    const status = trimStr(row.transcriptionStatus).toLowerCase();

    // Never double-bill a successful transcript.
    if (status === 'completed' && trimStr(row.transcript)) {
      return { ok: false, reason: 'already-completed', row };
    }
    // In-flight work wins unless the claim is stale (crash / timeout).
    if (status === 'processing') {
      const started = row.transcriptionStartedAt?.toMillis?.() ?? 0;
      if (started && Date.now() - started < PROCESSING_STALE_MS) {
        return { ok: false, reason: 'already-processing', row };
      }
    }
    if (!force && status && status !== 'pending' && status !== 'failed') {
      return { ok: false, reason: `status-${status || 'empty'}`, row };
    }
    if (!isVoiceType(row.type) || !isInbound(row)) {
      return { ok: false, reason: 'not-inbound-audio', row };
    }

    tx.set(ref, {
      transcriptionStatus: 'processing',
      transcriptionStartedAt: FieldValue.serverTimestamp(),
      transcriptionError: '',
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, reason: 'claimed', row };
  });
}

async function patchTranscription(messageId, fields) {
  await getFirestore().collection(MESSAGES_COLLECTION).doc(messageId).set({
    ...fields,
    transcriptionUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Background worker: download audio server-side, Speech-to-Text V2, save on same message.
 * @param {string} messageId
 * @param {{ force?: boolean }} [options]
 */
export async function processWhatsAppTranscription(messageId, options = {}) {
  const id = trimStr(messageId).replace(/[/\s]/g, '_');
  if (!id) return { status: 'skipped', reason: 'missing-id' };

  const force = options.force === true;
  const claim = await claimProcessing(id, { force });
  if (!claim.ok) {
    return { status: 'skipped', reason: claim.reason };
  }

  try {
    const { buffer, contentType } = await loadAudioBuffer(claim.row);
    if (!buffer?.length) {
      await patchTranscription(id, {
        transcriptionStatus: 'failed',
        transcriptionError: 'Voice note media is empty or unavailable.',
        transcript: '',
        englishTranslation: '',
        malayalamText: '',
      });
      return { status: 'failed', reason: 'empty-audio' };
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      await patchTranscription(id, {
        transcriptionStatus: 'failed',
        transcriptionError: 'Voice note is larger than 16 MB.',
        transcript: '',
        englishTranslation: '',
        malayalamText: '',
      });
      return { status: 'failed', reason: 'too-large' };
    }

    const duration = await probeAudioDurationSeconds(buffer, extFromMime(contentType));
    if (duration != null && duration > MAX_AUDIO_SECONDS) {
      await patchTranscription(id, {
        transcriptionStatus: 'failed',
        transcriptionError: 'Voice note is longer than 2 minutes.',
        transcript: '',
        englishTranslation: '',
        malayalamText: '',
      });
      return { status: 'failed', reason: 'too-long' };
    }

    const recognition = await recognizeWithSpeechV2(buffer);
    const { transcript, languageCode, confidence } = extractRecognition(recognition);

    if (!transcript) {
      await patchTranscription(id, {
        transcriptionStatus: 'failed',
        transcriptionError: 'No speech detected in this voice note.',
        transcript: '',
        transcriptLanguage: languageCode || '',
        transcriptConfidence: confidence,
        englishTranslation: '',
        malayalamText: '',
      });
      return { status: 'failed', reason: 'empty-transcript' };
    }

    const isMl = /^ml([_-]|$)/i.test(String(languageCode || ''))
      || /[\u0D00-\u0D7F]/.test(transcript);
    let malayalamText = '';
    // Malayalam audio is transcribed and stored. Do not translate it, and do not drop the line.
    if (isMl) {
      malayalamText = transcript;
    } else {
      try {
        const translated = await translateToMalayalam(transcript);
        if (translated && translated.toLowerCase() !== transcript.toLowerCase()) {
          malayalamText = translated;
        }
      } catch (err) {
        console.warn('whatsapp voice translate-to-ml skipped', id, err?.message || err);
      }
    }

    await patchTranscription(id, {
      transcriptionStatus: 'completed',
      transcriptionError: '',
      transcript,
      transcriptLanguage: languageCode || (isMl ? 'ml-IN' : ''),
      transcriptConfidence: confidence,
      englishTranslation: '',
      malayalamText,
      messageLanguage: languageCode || '',
      messageLanguageName: '',
    });
    return { status: 'completed', languageCode };
  } catch (err) {
    console.warn('whatsapp transcription failed', id, err?.message || err);
    const safe = sanitizeTranscriptionError(err);
    await patchTranscription(id, {
      transcriptionStatus: 'failed',
      transcriptionError: safe,
      transcript: '',
      englishTranslation: '',
      malayalamText: '',
    }).catch(() => {});
    return { status: 'failed', reason: String(err?.message || err).slice(0, 200) };
  }
}

/** Firestore onWrite: queue work when transcriptionStatus becomes pending. */
export async function handleTranscriptionWrite(change) {
  const after = change.after.exists ? change.after.data() : null;
  if (!after) return null;
  if (trimStr(after.transcriptionStatus).toLowerCase() !== 'pending') return null;
  if (!isVoiceType(after.type) || !isInbound(after)) return null;

  const before = change.before.exists ? change.before.data() : null;
  const beforeStatus = trimStr(before?.transcriptionStatus).toLowerCase();
  // Avoid re-entry when other fields merge while still pending.
  if (beforeStatus === 'pending') return null;

  return processWhatsAppTranscription(change.after.id, { force: false });
}

/** Staff retry — idempotent; no Speech charge when already completed. */
export async function retryWhatsAppTranscriptionHandler(data, context) {
  await assertSalesOrAdmin(context.auth?.uid);
  const messageId = trimStr(data?.messageId).replace(/[/\s]/g, '_');
  if (!messageId) throw fail('Message is required.', 'invalid-argument');

  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(messageId);
  const snap = await ref.get();
  if (!snap.exists) throw fail('Could not find that WhatsApp message.', 'not-found');
  const row = snap.data() ?? {};
  if (!isVoiceType(row.type) || !isInbound(row)) {
    throw fail('Only inbound voice notes can be transcribed.', 'failed-precondition');
  }

  const status = trimStr(row.transcriptionStatus).toLowerCase();
  if (status === 'completed' && trimStr(row.transcript)) {
    return {
      ok: true,
      status: 'completed',
      skipped: true,
      reason: 'already-completed',
      transcript: trimStr(row.transcript),
    };
  }

  // Run inline (do not flip to pending first — that would also wake the Firestore trigger).
  const result = await processWhatsAppTranscription(messageId, { force: true });
  return { ok: true, ...result };
}
