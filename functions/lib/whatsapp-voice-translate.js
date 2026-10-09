/**
 * WhatsApp Cloud API voice → Sarvam STT → Malayalam text → Bulbul TTS.
 * Runs in a Firestore background trigger after the webhook saves the message.
 * Never auto-replies. Never logs or returns the Sarvam API key.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import ffmpegPath from 'ffmpeg-static';
import { assertSalesOrAdmin } from './assert-admin.js';
import {
  extFromMime,
  isInbound,
  isVoiceType,
  loadAudioBuffer,
  probeAudioDurationSeconds,
} from './whatsapp-transcribe.js';

const MESSAGES_COLLECTION = 'whatsappMessages';
const CONVERSATIONS_COLLECTION = 'whatsappConversations';
const USERS_COLLECTION = 'users';
const AI_SETTINGS_PATH = 'whatsappSettings/aiAgent';

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_TRANSLATE_URL = 'https://api.sarvam.ai/translate';
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_LID_URL = 'https://api.sarvam.ai/text-lid';
const SARVAM_DASHBOARD_BALANCE_URL = 'https://indus.sarvam.ai/api/dhan/org/balance';
const SARVAM_PUBLIC_CREDIT_URLS = Object.freeze([
  'https://api.sarvam.ai/credits',
  'https://api.sarvam.ai/v1/credits',
  'https://api.sarvam.ai/account',
  'https://api.sarvam.ai/account/credits',
  'https://api.sarvam.ai/usage',
]);

const STT_MODEL = 'saaras:v3';
const TRANSLATE_MODEL = 'sarvam-translate:v1';
const MAYURA_MODEL = 'mayura:v1';
const TTS_MODEL = 'bulbul:v3';
const ML_LANG = 'ml-IN';
const MAYURA_CHUNK = 900;
const TRANSLATE_V1_CHUNK = 1800;
/** Saaras REST hard-caps at 30s; leave margin and chunk longer notes. */
const SARVAM_REST_MAX_SECONDS = 29;
const SARVAM_STT_CHUNK_SECONDS = 28;

/** Bulbul v3 speakers: Tier-1 female + solid male default across Indic targets. */
const BULBUL_SPEAKER_FEMALE = 'priya';
const BULBUL_SPEAKER_MALE = 'shubh';
const BULBUL_SPEAKER_DEFAULT = BULBUL_SPEAKER_MALE;

/**
 * Official bulbul:v3 gender lists from Sarvam docs
 * (https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/how-to/change-the-speaker-voice).
 * Intersected with the REST convert speaker enum — no invented names.
 */
export const BULBUL_V3_FEMALE_SPEAKERS = Object.freeze([
  'ritu', 'priya', 'neha', 'pooja', 'simran', 'kavya', 'ishita',
  'shreya', 'roopa', 'tanya', 'shruti', 'suhani', 'kavitha', 'rupali',
]);
export const BULBUL_V3_MALE_SPEAKERS = Object.freeze([
  'shubh', 'aditya', 'rahul', 'rohan', 'amit', 'dev', 'ratan', 'varun',
  'manan', 'sumit', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand',
  'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'mohit', 'rehan', 'soham',
]);
const FEMALE_SPEAKER_SET = new Set(BULBUL_V3_FEMALE_SPEAKERS);
const MALE_SPEAKER_SET = new Set(BULBUL_V3_MALE_SPEAKERS);

/** bulbul:v3 tuning defaults (pitch/loudness/preprocessing are NOT supported on v3). */
export const SARVAM_VOICE_DEFAULTS = Object.freeze({
  pace: 1,
  temperature: 0.6,
  speechSampleRate: 24000,
  femaleSpeaker: BULBUL_SPEAKER_FEMALE,
  maleSpeaker: BULBUL_SPEAKER_MALE,
});
const SAMPLE_RATES = Object.freeze([8000, 16000, 22050, 24000, 32000, 44100, 48000]);
const PREVIEW_SAMPLE_ML = '\u0d28\u0d2e\u0d38\u0d4d\u0d15\u0d3e\u0d30\u0d02\u002c\u0020\u0d2e\u0d40\u0d38\u0d3e\u0d7b\u0020\u0d35\u0d4b\u0d2f\u0d4d\u0d38\u0d4d\u0020\u0d38\u0d3e\u0d2e\u0d4d\u0d2a\u0d3f\u0d7e\u0020\u0d06\u0d23\u0d4d\u002e';
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 120;
const PROCESSING_STALE_MS = 4 * 60 * 1000;
const FAIL_MESSAGE = 'Could not voice-translate';
/** @deprecated use MAYURA_CHUNK / TRANSLATE_V1_CHUNK */
const TRANSLATE_CHUNK = TRANSLATE_V1_CHUNK;

/** Pitch boundary (Hz): adult female speech typically above this median F0. */
const FEMALE_F0_HZ = 165;
const PITCH_SAMPLE_RATE = 16000;

/** Short English display names for Sarvam / BCP-47 codes. */
const LANGUAGE_DISPLAY_NAMES = {
  hi: 'Hindi',
  en: 'English',
  ml: 'Malayalam',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  bn: 'Bengali',
  gu: 'Gujarati',
  mr: 'Marathi',
  pa: 'Punjabi',
  or: 'Odia',
  od: 'Odia',
  as: 'Assamese',
  ur: 'Urdu',
  ar: 'Arabic',
  zh: 'Chinese',
  cmn: 'Chinese',
  ne: 'Nepali',
  sa: 'Sanskrit',
  kok: 'Konkani',
  mai: 'Maithili',
  sd: 'Sindhi',
  ks: 'Kashmiri',
  doi: 'Dogri',
  sat: 'Santali',
  mni: 'Manipuri',
  brx: 'Bodo',
};

/**
 * Official bulbul:v3 language_code set (10 Indian + English India).
 * Do not list Indian languages Bulbul cannot speak.
 */
export const SARVAM_BULBUL_TTS_LANGUAGE_CODES = Object.freeze([
  'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN',
  'mr-IN', 'gu-IN', 'pa-IN', 'od-IN', 'en-IN',
]);

/** Manual outbound voice targets that use Google Cloud TTS (not Sarvam). */
export const GOOGLE_OUTBOUND_TTS_LANGUAGE_CODES = Object.freeze(['ar', 'zh-CN']);

export const OUTBOUND_VOICE_LANGUAGE_AUTO = 'auto';

function trimStr(value) {
  return String(value ?? '').trim();
}

function fail(message, code = 'failed-precondition') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parseCreditAmount(payload, depth = 0) {
  if (payload == null || depth > 4) return null;
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : null;
  if (typeof payload === 'string') {
    const n = Number.parseFloat(payload.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof payload !== 'object') return null;
  const keys = [
    'real_time_credit_balance',
    'credits_left',
    'creditsLeft',
    'available_credits',
    'availableCredits',
    'remaining',
    'balance',
    'credits',
  ];
  for (const key of keys) {
    if (payload[key] == null) continue;
    const n = parseCreditAmount(payload[key], depth + 1);
    if (n != null) return n;
  }
  for (const nest of ['data', 'result', 'account', 'org', 'organization']) {
    if (!payload[nest] || typeof payload[nest] !== 'object') continue;
    const n = parseCreditAmount(payload[nest], depth + 1);
    if (n != null) return n;
  }
  return null;
}

async function fetchSarvamJson(url, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'api-subscription-key': apiKey,
      },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try the public Sarvam API, then the dashboard billing path, using the saved key.
 * Never logs the key or raw bodies.
 */
export async function fetchSarvamCreditBalance(apiKey) {
  for (const url of SARVAM_PUBLIC_CREDIT_URLS) {
    try {
      const { ok, json } = await fetchSarvamJson(url, apiKey);
      const remaining = parseCreditAmount(json);
      if (ok && remaining != null) return { remaining };
    } catch {
      // Try the next documented or guessed path.
    }
  }

  try {
    const { ok, json } = await fetchSarvamJson(SARVAM_DASHBOARD_BALANCE_URL, apiKey);
    const remaining = parseCreditAmount(json);
    if (ok && remaining != null) return { remaining };
  } catch {
    // Dashboard billing requires a logged-in session, not an API key.
  }

  return {
    remaining: null,
    error: 'Sarvam has no API-key balance endpoint. Check credits on the Sarvam Billing page.',
  };
}

/**
 * Callable: admin/sales. Reads the saved Sarvam key server-side; never returns it.
 */
export async function getSarvamCreditsHandler(data, context) {
  await assertSalesOrAdmin(context.auth?.uid);
  const apiKey = await loadSarvamApiKey();
  if (!apiKey) {
    return {
      remaining: null,
      error: 'Save a Sarvam AI API key to check credits.',
    };
  }
  return fetchSarvamCreditBalance(apiKey);
}

function isMalayalamLang(code) {
  return /^ml([_-]|$)/i.test(trimStr(code));
}

/**
 * Source language of an agent voice note.
 * Header "Auto detect" uses Sarvam STT (Malayalam script counts as Malayalam).
 * An explicit header language is the source control: Malayalam → original recording.
 * Any other explicit language is a real language change and may still be spoken with TTS.
 *
 * @returns {boolean} true → do not synthesize; caller sends the original recording.
 */
export function shouldSendOriginalAgentVoice({
  spokenLanguageCode = '',
  transcript = '',
  dropdownLanguageCode = '',
} = {}) {
  const dropdownRaw = trimStr(dropdownLanguageCode);
  const dropdownAuto = !dropdownRaw || /^(auto|unknown)$/i.test(dropdownRaw);
  if (!dropdownAuto) return isMalayalamLang(dropdownRaw);
  if (isMalayalamLang(spokenLanguageCode)) return true;
  return hasMalayalamScript(transcript);
}

function isEnglishLang(code) {
  return /^en([_-]|$)/i.test(trimStr(code));
}

/** True when the string is mostly Latin letters (romanized / English / Hinglish). */
export function isLatinScriptText(text) {
  const raw = trimStr(text);
  if (!raw) return false;
  const letters = raw.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  const latin = (letters.match(/[A-Za-z]/g) || []).length;
  return latin / letters.length >= 0.85;
}

/** Native Indic / other non-Latin scripts (not Malayalam alone — caller checks ML). */
export function hasIndicOrForeignScript(text) {
  return /[\u0900-\u0CFF\u0D80-\u0DFF\u0600-\u06FF\u0750-\u077F\u0400-\u04FF\u0370-\u03FF\u0590-\u05FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(
    String(text || ''),
  );
}

export function hasMalayalamScript(text) {
  return /[\u0D00-\u0D7F]/.test(String(text || ''));
}

function normalizeLangCode(code) {
  const raw = trimStr(code).replace(/_/g, '-');
  if (!raw || /^(unknown|auto)$/i.test(raw)) return '';
  // Sarvam sometimes returns "hi" — prefer regional form for India languages.
  if (/^[a-z]{2,3}$/i.test(raw)) {
    const base = raw.toLowerCase();
    if (base === 'en') return 'en-IN';
    if (base === 'ar') return 'ar';
    if (base === 'zh' || base === 'cmn') return 'zh-CN';
    if (base === 'od' || base === 'or') return 'od-IN';
    return `${base}-IN`;
  }
  const base = (raw.split('-')[0] || '').toLowerCase();
  if (base === 'or') return 'od-IN';
  if (base === 'cmn') return 'zh-CN';
  if (base === 'zh' && !/zh-tw|zh-hk/i.test(raw)) return 'zh-CN';
  return raw;
}

function isGoogleOutboundTtsLang(code) {
  const base = (normalizeLangCode(code).split('-')[0] || '').toLowerCase();
  return base === 'ar' || base === 'zh' || base === 'cmn';
}

function isAllowedManualOutboundVoiceLang(code) {
  const normalized = normalizeLangCode(code);
  if (!normalized) return false;
  if (GOOGLE_OUTBOUND_TTS_LANGUAGE_CODES.some((c) => sameLanguage(c, normalized))) return true;
  return SARVAM_BULBUL_TTS_LANGUAGE_CODES.some((c) => sameLanguage(c, normalized));
}

/**
 * Header dropdown value → destination language.
 * "auto" / empty → null (caller keeps detect behavior).
 */
export function manualOutboundLanguageFromCode(languageCode) {
  const raw = trimStr(languageCode);
  if (!raw || /^(auto|unknown)$/i.test(raw)) return null;
  const code = normalizeLangCode(raw);
  if (!code || !isAllowedManualOutboundVoiceLang(code)) return null;
  return { code, name: languageDisplayName(code), manual: true };
}

export function languageDisplayName(code) {
  const normalized = normalizeLangCode(code);
  if (!normalized) return '';
  const base = (normalized.split('-')[0] || '').toLowerCase();
  return LANGUAGE_DISPLAY_NAMES[base] || normalized;
}

/** Firestore fields for the inbox language tag on a message bubble. */
export function messageLanguageFields(languageCode) {
  const code = normalizeLangCode(languageCode);
  if (!code) return { messageLanguage: '', messageLanguageName: '' };
  return {
    messageLanguage: code,
    messageLanguageName: languageDisplayName(code),
  };
}

function sameLanguage(a, b) {
  const left = normalizeLangCode(a).toLowerCase();
  const right = normalizeLangCode(b).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  return (left.split('-')[0] || '') === (right.split('-')[0] || '');
}

/**
 * Persist detected customer voice language on the conversation.
 * Never defaults to English when detection is missing.
 */
export async function persistCustomerLanguage(waId, languageCode) {
  const id = trimStr(waId).replace(/[^\d+]/g, '');
  const code = normalizeLangCode(languageCode);
  if (!id || !code) return null;
  // Do not overwrite a real customer language with English unless STT truly detected English.
  const name = languageDisplayName(code);
  const customerLanguage = { code, name };
  await getFirestore().collection(CONVERSATIONS_COLLECTION).doc(id).set({
    customerLanguage,
    customerLanguageCode: code,
    customerLanguageName: name,
    customerLanguageUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return customerLanguage;
}

/** Read saved customerLanguage from the conversation (code + display name). */
export async function loadCustomerLanguage(waId) {
  const id = trimStr(waId).replace(/[^\d+]/g, '');
  if (!id) return null;
  const snap = await getFirestore().collection(CONVERSATIONS_COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const nested = data.customerLanguage && typeof data.customerLanguage === 'object'
    ? data.customerLanguage
    : null;
  const code = normalizeLangCode(nested?.code || data.customerLanguageCode || data.customerLanguage);
  if (!code) return null;
  const name = trimStr(nested?.name || data.customerLanguageName) || languageDisplayName(code);
  return { code, name };
}

/**
 * Per-chat outbound destination language (header dropdown).
 * Missing / "auto" → null (use detected customerLanguage for voice and text replies).
 * Checks brand-split docs (weighvox_/scangle_) first when brand is known, then legacy waId.
 */
export async function loadOutboundVoiceLanguageOverride(waId, options = {}) {
  const id = trimStr(waId).replace(/[^\d+]/g, '');
  if (!id) return null;
  const brand = trimStr(options.brand || options.cloudBrand).toLowerCase();
  const candidates = [];
  if (brand === 'weighvox' || brand === 'scangle') {
    candidates.push(`${brand}_${id}`);
  }
  candidates.push(id);
  for (const line of ['weighvox', 'scangle']) {
    const alt = `${line}_${id}`;
    if (!candidates.includes(alt)) candidates.push(alt);
  }

  const db = getFirestore();
  for (const docId of candidates) {
    const snap = await db.collection(CONVERSATIONS_COLLECTION).doc(docId).get().catch(() => null);
    if (!snap?.exists) continue;
    const data = snap.data() || {};
    const raw = trimStr(
      data.outboundVoiceLanguage
      || data.outboundVoiceLanguageCode
      || (data.outboundVoiceLanguage && typeof data.outboundVoiceLanguage === 'object'
        ? data.outboundVoiceLanguage.code
        : ''),
    );
    // Explicit auto → keep searching other candidate docs for a manual override
    // (brand-split doc may still say auto while legacy waId already has Arabic).
    if (!raw || /^(auto|unknown)$/i.test(raw)) {
      continue;
    }
    const code = normalizeLangCode(raw);
    if (!code || !isAllowedManualOutboundVoiceLang(code)) continue;
    const name = trimStr(data.outboundVoiceLanguageName) || languageDisplayName(code);
    return { code, name, manual: true };
  }
  return null;
}

/** Persist staff outbound voice language choice on the conversation (auto = clear override). */
export async function persistOutboundVoiceLanguage(waId, languageCode) {
  const id = trimStr(waId).replace(/[^\d+]/g, '');
  if (!id) return null;
  const raw = trimStr(languageCode);
  if (!raw || /^(auto|unknown)$/i.test(raw)) {
    await getFirestore().collection(CONVERSATIONS_COLLECTION).doc(id).set({
      outboundVoiceLanguage: OUTBOUND_VOICE_LANGUAGE_AUTO,
      outboundVoiceLanguageCode: OUTBOUND_VOICE_LANGUAGE_AUTO,
      outboundVoiceLanguageName: 'Auto detect',
      outboundVoiceLanguageUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { code: OUTBOUND_VOICE_LANGUAGE_AUTO, name: 'Auto detect', manual: false };
  }
  const code = normalizeLangCode(raw);
  if (!code || !isAllowedManualOutboundVoiceLang(code)) {
    throw fail('Unsupported outbound voice language.', 'invalid-argument');
  }
  const name = languageDisplayName(code);
  await getFirestore().collection(CONVERSATIONS_COLLECTION).doc(id).set({
    outboundVoiceLanguage: code,
    outboundVoiceLanguageCode: code,
    outboundVoiceLanguageName: name,
    outboundVoiceLanguageUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { code, name, manual: true };
}

function isVoiceMessageType(type) {
  return isVoiceType(type);
}

/**
 * True when the customer's latest inbound message in this chat is audio/voice.
 * Prefers conversation.lastInboundType; falls back to a messages query.
 */
function receivedAtMs(row) {
  const ts = row?.receivedAt;
  if (ts?.toMillis) return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

export async function latestInboundIsVoice(waId) {
  const id = trimStr(waId).replace(/[^\d+]/g, '');
  if (!id) return false;
  const db = getFirestore();
  const convSnap = await db.collection(CONVERSATIONS_COLLECTION).doc(id).get().catch(() => null);
  const lastInboundType = trimStr(convSnap?.data()?.lastInboundType);
  if (lastInboundType) return isVoiceMessageType(lastInboundType);

  // Avoid composite indexes: waId equality + in-memory sort (same as the CRM thread query).
  const loose = await db.collection(MESSAGES_COLLECTION)
    .where('waId', '==', id)
    .limit(80)
    .get()
    .catch(() => null);
  if (!loose || loose.empty) return false;
  const inbound = loose.docs
    .map((docSnap) => docSnap.data() || {})
    .filter((row) => isInbound(row))
    .sort((a, b) => receivedAtMs(b) - receivedAtMs(a));
  if (!inbound.length) return false;
  return isVoiceMessageType(inbound[0].type);
}

/**
 * Top-level voiceTranslate on aiAgent, Meta line flag, or mirror doc.
 * Explicit false wins. Otherwise ON when a Sarvam key is saved (default for this product).
 * Never returns the API key.
 */
export async function isVoiceTranslateEnabled() {
  const db = getFirestore();
  const [aiSnap, mirrorSnap] = await Promise.all([
    db.doc(AI_SETTINGS_PATH).get().catch(() => null),
    db.doc('whatsappSettings/voiceTranslate').get().catch(() => null),
  ]);
  const ai = aiSnap?.exists ? (aiSnap.data() || {}) : {};
  const hasKey = Boolean(trimStr(ai.sarvamApiKey));

  if (ai.voiceTranslate === false) {
    // Explicit off on aiAgent wins over mirror/line/key default.
    return false;
  }
  if (ai.voiceTranslate === true) return true;

  const lines = ai.lines && typeof ai.lines === 'object' ? ai.lines : {};
  let anyLineOn = false;
  let anyLineExplicitOff = false;
  for (const [id, row] of Object.entries(lines)) {
    if (!/^meta_/i.test(id)) continue;
    if (!row || typeof row !== 'object') continue;
    if (row.voiceTranslate === true) anyLineOn = true;
    if (row.voiceTranslate === false) anyLineExplicitOff = true;
  }
  if (anyLineOn) return true;

  if (mirrorSnap?.exists) {
    const enabled = mirrorSnap.data()?.enabled;
    if (enabled === false) return false;
    if (enabled === true) return true;
  }

  // No explicit off → default ON when the Sarvam key exists.
  if (hasKey && !anyLineExplicitOff) return true;
  return false;
}

/** Server-only: env first (CI / functions/.env), then Firestore. Never log the value. */
export async function loadSarvamApiKey() {
  const fromEnv = trimStr(process.env.SARVAM_API_KEY);
  if (fromEnv) return fromEnv;
  const snap = await getFirestore().doc(AI_SETTINGS_PATH).get();
  return trimStr(snap.data()?.sarvamApiKey);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeFemaleSpeaker(value) {
  const s = trimStr(value).toLowerCase();
  return FEMALE_SPEAKER_SET.has(s) ? s : SARVAM_VOICE_DEFAULTS.femaleSpeaker;
}

function normalizeMaleSpeaker(value) {
  const s = trimStr(value).toLowerCase();
  return MALE_SPEAKER_SET.has(s) ? s : SARVAM_VOICE_DEFAULTS.maleSpeaker;
}

function normalizeSampleRate(value) {
  const n = Number(value);
  return SAMPLE_RATES.includes(n) ? n : SARVAM_VOICE_DEFAULTS.speechSampleRate;
}

/** Normalize saved / client voice tuning. Missing fields keep today's defaults. */
export function normalizeSarvamVoiceSettings(raw) {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    pace: clampNumber(row.pace, 0.5, 2, SARVAM_VOICE_DEFAULTS.pace),
    temperature: clampNumber(row.temperature, 0.01, 2, SARVAM_VOICE_DEFAULTS.temperature),
    speechSampleRate: normalizeSampleRate(
      row.speechSampleRate ?? row.speech_sample_rate,
    ),
    femaleSpeaker: normalizeFemaleSpeaker(row.femaleSpeaker),
    maleSpeaker: normalizeMaleSpeaker(row.maleSpeaker),
  };
}

/** Server-only: load sarvamVoice from whatsappSettings/aiAgent. */
export async function loadSarvamVoiceSettings() {
  const snap = await getFirestore().doc(AI_SETTINGS_PATH).get();
  return normalizeSarvamVoiceSettings(snap.data()?.sarvamVoice);
}

/**
 * Mark inbound voice for Sarvam voice-translate pipeline.
 * Deduped by WhatsApp message id / status — never re-queues completed/failed/active.
 */
export async function markVoiceTranslatePending(messageId, options = {}) {
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

    const status = trimStr(row.voiceTranslateStatus).toLowerCase();
    if (!force && status === 'completed' && trimStr(row.malayalamAudioUrl || row.transcript)) {
      return { status: 'skipped', reason: 'already-completed' };
    }
    if (!force && status === 'failed') {
      return { status: 'skipped', reason: 'already-failed' };
    }
    if (!force && status === 'processing') {
      const started = row.voiceTranslateStartedAt?.toMillis?.() ?? 0;
      if (started && Date.now() - started < PROCESSING_STALE_MS) {
        return { status: 'skipped', reason: 'already-processing' };
      }
    }
    if (!force && status === 'pending') {
      return { status: 'skipped', reason: 'already-pending' };
    }

    tx.set(ref, {
      voiceTranslateStatus: 'pending',
      voiceTranslateError: '',
      voiceTranslateUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'pending' };
  });
}

async function claimProcessing(messageId, { force = false } = {}) {
  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(messageId);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not-found', row: null };
    const row = snap.data() ?? {};
    const status = trimStr(row.voiceTranslateStatus).toLowerCase();

    if (!force && status === 'completed' && trimStr(row.malayalamAudioUrl || row.transcript)) {
      return { ok: false, reason: 'already-completed', row };
    }
    if (status === 'processing') {
      const started = row.voiceTranslateStartedAt?.toMillis?.() ?? 0;
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
      voiceTranslateStatus: 'processing',
      voiceTranslateStartedAt: FieldValue.serverTimestamp(),
      voiceTranslateError: '',
      voiceTranslateUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, reason: 'claimed', row };
  });
}

async function patchVoiceTranslate(messageId, fields) {
  await getFirestore().collection(MESSAGES_COLLECTION).doc(messageId).set({
    ...fields,
    voiceTranslateUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function sarvamHeaders(apiKey, contentType) {
  const headers = { 'api-subscription-key': apiKey };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function parseSarvamErrorMessage(bodyText) {
  try {
    const json = JSON.parse(String(bodyText || ''));
    return trimStr(json?.error?.message || json?.message);
  } catch {
    return '';
  }
}

function isSarvamDurationLimitError(message) {
  return /duration exceeds|maximum limit of\s*30|longer audio|batch API for longer/i.test(
    String(message || ''),
  );
}

function safeSarvamError(res, bodyText) {
  const status = res?.status || 0;
  const detail = parseSarvamErrorMessage(bodyText);
  // Never include response bodies that might echo credentials; keep short.
  if (status === 401 || status === 403) return 'Sarvam API key rejected.';
  if (status === 429) return 'Sarvam rate limit exceeded.';
  if (isSarvamDurationLimitError(detail)) {
    return 'Voice note is too long for one pass. Tap Retry.';
  }
  if (/language_code/i.test(detail)) {
    return 'Could not detect speech language. Tap Retry.';
  }
  if (status === 400) return 'Could not transcribe voice note. Tap Retry.';
  return `Sarvam request failed (${status || 'error'}). Tap Retry.`;
}

/** Extract a mono 16 kHz WAV slice with ffmpeg (Saaras-friendly container). */
async function extractWavSlice(buffer, contentType, startSec, durationSec) {
  if (!ffmpegPath || !buffer?.length) {
    throw fail('Audio conversion is unavailable on this server.', 'unavailable');
  }
  const id = randomUUID();
  const safeExt = extFromMime(contentType);
  const inPath = path.join(tmpdir(), `wa-stt-in-${id}.${safeExt}`);
  const outPath = path.join(tmpdir(), `wa-stt-out-${id}.wav`);
  await fs.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(Math.max(0, Number(startSec) || 0)),
        '-t', String(Math.max(0.1, Number(durationSec) || SARVAM_STT_CHUNK_SECONDS)),
        '-i', inPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        outPath,
      ];
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
    const wav = await fs.readFile(outPath);
    if (!wav?.length) throw fail('Could not prepare audio for transcription.', 'unavailable');
    return wav;
  } finally {
    await Promise.all([
      fs.unlink(inPath).catch(() => {}),
      fs.unlink(outPath).catch(() => {}),
    ]);
  }
}

/**
 * One Saaras REST request. Always auto-detect language (`unknown`) — never send
 * display names like "Malayalam". Uses File + WAV/OGG bytes Sarvam accepts.
 */
function timestampSegments(json, offsetSeconds) {
  const offset = Number(offsetSeconds) || 0;
  const timed = json?.timestamps;
  const words = Array.isArray(timed?.words) && timed.words.length
    ? timed.words
    : (Array.isArray(timed?.chunks) ? timed.chunks : []);
  const starts = Array.isArray(timed?.start_time_seconds) ? timed.start_time_seconds : [];
  const ends = Array.isArray(timed?.end_time_seconds) ? timed.end_time_seconds : [];
  const segments = [];
  for (let i = 0; i < words.length; i += 1) {
    const text = trimStr(words[i]);
    if (!text) continue;
    const startRaw = Number(starts[i]);
    const endRaw = Number(ends[i]);
    const start = offset + (Number.isFinite(startRaw) ? startRaw : 0);
    const end = offset + (Number.isFinite(endRaw) ? endRaw : 0);
    segments.push({ text, start, end });
  }
  if (!segments.length) {
    const transcript = trimStr(json?.transcript);
    if (transcript) segments.push({ text: transcript, start: offset, end: offset });
  }
  return segments;
}

async function sarvamSpeechToTextOnce(fileBuffer, filename, mimeType, apiKey, options = {}) {
  const form = new FormData();
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);
  form.append(
    'file',
    new File([bytes], filename, { type: mimeType || 'application/octet-stream' }),
  );
  form.append('model', STT_MODEL);
  form.append('mode', 'transcribe');
  form.append('language_code', 'unknown');
  if (options.withTimestamps) form.append('with_timestamps', 'true');

  const res = await fetch(SARVAM_STT_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = fail(safeSarvamError(res, text), 'unavailable');
    err.sarvamDetail = parseSarvamErrorMessage(text);
    err.httpStatus = res.status;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  return {
    transcript: trimStr(json?.transcript),
    languageCode: normalizeLangCode(json?.language_code) || trimStr(json?.language_code),
    segments: options.withTimestamps ? timestampSegments(json, options.timeOffsetSeconds) : [],
  };
}

async function sarvamSpeechToTextChunked(buffer, contentType, apiKey, totalSeconds) {
  const duration = Number(totalSeconds);
  const span = Number.isFinite(duration) && duration > 0
    ? duration
    : MAX_AUDIO_SECONDS;
  const parts = [];
  let languageCode = '';
  for (let start = 0; start < span; start += SARVAM_STT_CHUNK_SECONDS) {
    const sliceDur = Math.min(SARVAM_STT_CHUNK_SECONDS, span - start + 0.05);
    if (sliceDur < 0.2) break;
    let wav;
    try {
      wav = await extractWavSlice(buffer, contentType, start, sliceDur);
    } catch (err) {
      console.warn('stt chunk extract failed', err?.message || err);
      break;
    }
    // Tiny trailing slices (silence) can 400 or return empty — skip empties.
    if (wav.length < 2000) continue;
    const piece = await sarvamSpeechToTextOnce(wav, 'chunk.wav', 'audio/wav', apiKey);
    if (piece.transcript) parts.push(piece.transcript);
    if (!languageCode && piece.languageCode) languageCode = piece.languageCode;
  }
  return {
    transcript: parts.join(' ').replace(/\s+/g, ' ').trim(),
    languageCode,
  };
}

/**
 * Sarvam Saaras STT. REST rejects audio over 30s — chunk longer notes.
 * Auto language detection only; Malayalam audio still returns Malayalam text (no re-TTS here).
 */
export async function sarvamSpeechToText(buffer, contentType, apiKey) {
  if (!buffer?.length) {
    throw fail('Voice note media is empty or unavailable.', 'failed-precondition');
  }

  const duration = await probeAudioDurationSeconds(buffer, extFromMime(contentType));
  if (duration != null && duration > SARVAM_REST_MAX_SECONDS) {
    return sarvamSpeechToTextChunked(buffer, contentType, apiKey, duration);
  }

  const ext = extFromMime(contentType);
  const filename = `voice.${ext}`;
  const mime = trimStr(contentType).split(';')[0] || 'audio/ogg';
  try {
    return await sarvamSpeechToTextOnce(
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
      filename,
      mime,
      apiKey,
    );
  } catch (err) {
    // Duration probe can miss OGG metadata; Sarvam still enforces the 30s REST cap.
    if (
      err?.httpStatus === 400
      && (isSarvamDurationLimitError(err?.sarvamDetail) || isSarvamDurationLimitError(err?.message))
    ) {
      return sarvamSpeechToTextChunked(
        buffer,
        contentType,
        apiKey,
        duration != null && duration > 0 ? Math.max(duration, SARVAM_STT_CHUNK_SECONDS * 2) : 60,
      );
    }
    throw err;
  }
}

async function sarvamSpeechToTextSegmentsChunked(buffer, contentType, apiKey, totalSeconds) {
  const duration = Number(totalSeconds);
  const span = Number.isFinite(duration) && duration > 0 ? duration : MAX_AUDIO_SECONDS;
  const parts = [];
  const segments = [];
  let languageCode = '';
  for (let start = 0; start < span; start += SARVAM_STT_CHUNK_SECONDS) {
    const sliceDur = Math.min(SARVAM_STT_CHUNK_SECONDS, span - start + 0.05);
    if (sliceDur < 0.2) break;
    let wav;
    try {
      wav = await extractWavSlice(buffer, contentType, start, sliceDur);
    } catch (err) {
      console.warn('stt chunk extract failed', err?.message || err);
      break;
    }
    if (wav.length < 2000) continue;
    const piece = await sarvamSpeechToTextOnce(wav, 'chunk.wav', 'audio/wav', apiKey, {
      withTimestamps: true,
      timeOffsetSeconds: start,
    });
    if (piece.transcript) parts.push(piece.transcript);
    if (piece.segments?.length) segments.push(...piece.segments);
    if (!languageCode && piece.languageCode) languageCode = piece.languageCode;
  }
  return {
    transcript: parts.join(' ').replace(/\s+/g, ' ').trim(),
    languageCode,
    segments,
  };
}

/**
 * Saaras transcription with phrase timestamps so phone channels can be interleaved.
 * Same model and language detection as sarvamSpeechToText. Does not translate.
 */
export async function sarvamSpeechToTextSegments(buffer, contentType, apiKey) {
  if (!buffer?.length) {
    throw fail('Voice note media is empty or unavailable.', 'failed-precondition');
  }
  const duration = await probeAudioDurationSeconds(buffer, extFromMime(contentType));
  if (duration != null && duration > SARVAM_REST_MAX_SECONDS) {
    return sarvamSpeechToTextSegmentsChunked(buffer, contentType, apiKey, duration);
  }
  const ext = extFromMime(contentType);
  const filename = `voice.${ext}`;
  const mime = trimStr(contentType).split(';')[0] || 'audio/ogg';
  try {
    return await sarvamSpeechToTextOnce(
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
      filename,
      mime,
      apiKey,
      { withTimestamps: true, timeOffsetSeconds: 0 },
    );
  } catch (err) {
    if (
      err?.httpStatus === 400
      && (isSarvamDurationLimitError(err?.sarvamDetail) || isSarvamDurationLimitError(err?.message))
    ) {
      return sarvamSpeechToTextSegmentsChunked(
        buffer,
        contentType,
        apiKey,
        duration != null && duration > 0 ? Math.max(duration, SARVAM_STT_CHUNK_SECONDS * 2) : 60,
      );
    }
    throw err;
  }
}

/** Sarvam language ID (POST /text-lid). Never logs the API key. */
export async function sarvamIdentifyLanguage(text, apiKey) {
  const input = trimStr(text).slice(0, 1000);
  if (!input) return { languageCode: '', scriptCode: '' };
  const res = await fetch(SARVAM_LID_URL, {
    method: 'POST',
    headers: sarvamHeaders(apiKey, 'application/json'),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const textBody = await res.text().catch(() => '');
    throw fail(safeSarvamError(res, textBody), 'unavailable');
  }
  const json = await res.json().catch(() => ({}));
  return {
    languageCode: normalizeLangCode(json?.language_code) || trimStr(json?.language_code),
    scriptCode: trimStr(json?.script_code),
  };
}

/**
 * Prefer Mayura for Latin / English / colloquial; sarvam-translate for native Indic scripts.
 */
export function preferMayuraModel(text, sourceLanguageCode, targetLanguageCode) {
  if (isLatinScriptText(text)) return true;
  if (isEnglishLang(sourceLanguageCode) || isEnglishLang(targetLanguageCode)) return true;
  if (hasIndicOrForeignScript(text) || hasMalayalamScript(text)) return false;
  // Unknown / mixed Latin-ish → Mayura handles romanized better.
  return true;
}

function chunkText(input, size) {
  const chunks = [];
  if (input.length <= size) {
    chunks.push(input);
    return chunks;
  }
  let rest = input;
  while (rest.length) {
    chunks.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return chunks;
}

/**
 * Sarvam translate. Default model sarvam-translate:v1.
 * Pass options.model = 'mayura:v1' for romanized / colloquial / English pairs.
 * Returns { text, sourceLanguageCode }. Never logs the API key.
 */
export async function sarvamTranslate(text, sourceLanguageCode, targetLanguageCode, apiKey, options = {}) {
  const input = trimStr(text);
  if (!input) return { text: '', sourceLanguageCode: '' };
  const target = normalizeLangCode(targetLanguageCode) || trimStr(targetLanguageCode);
  if (!target) throw fail('Target language is required for translate.', 'invalid-argument');
  if (sameLanguage(sourceLanguageCode, target)) {
    return { text: input, sourceLanguageCode: normalizeLangCode(sourceLanguageCode) || '' };
  }

  const model = trimStr(options.model) === MAYURA_MODEL ? MAYURA_MODEL : TRANSLATE_MODEL;
  const chunkSize = model === MAYURA_MODEL ? MAYURA_CHUNK : TRANSLATE_V1_CHUNK;

  let source = trimStr(sourceLanguageCode) || 'auto';
  if (/^unknown$/i.test(source)) source = 'auto';
  else if (source !== 'auto') source = normalizeLangCode(source) || source;

  const bodyBase = {
    source_language_code: source,
    target_language_code: target,
    model,
  };
  if (model === MAYURA_MODEL) {
    bodyBase.mode = trimStr(options.mode) || 'modern-colloquial';
    const outScript = trimStr(options.outputScript || options.output_script);
    if (outScript) bodyBase.output_script = outScript;
  }

  const parts = [];
  let detectedSource = '';
  for (const chunk of chunkText(input, chunkSize)) {
    const res = await fetch(SARVAM_TRANSLATE_URL, {
      method: 'POST',
      headers: sarvamHeaders(apiKey, 'application/json'),
      body: JSON.stringify({ ...bodyBase, input: chunk }),
    });
    if (!res.ok) {
      const textBody = await res.text().catch(() => '');
      throw fail(safeSarvamError(res, textBody), 'unavailable');
    }
    const json = await res.json().catch(() => ({}));
    parts.push(trimStr(json?.translated_text));
    if (!detectedSource && json?.source_language_code) {
      detectedSource = normalizeLangCode(json.source_language_code) || trimStr(json.source_language_code);
    }
  }
  return {
    text: parts.filter(Boolean).join(' ').trim(),
    sourceLanguageCode: detectedSource || (source !== 'auto' ? normalizeLangCode(source) : ''),
  };
}

/**
 * Translate with Mayura ↔ sarvam-translate fallback. Never calls Google/Ollama.
 * @returns {Promise<{ text: string, sourceLanguageCode: string, model: string }>}
 */
export async function sarvamTranslateSmart(text, sourceLanguageCode, targetLanguageCode, apiKey, options = {}) {
  const input = trimStr(text);
  if (!input) return { text: '', sourceLanguageCode: '', model: '' };
  const target = normalizeLangCode(targetLanguageCode) || trimStr(targetLanguageCode);
  if (sameLanguage(sourceLanguageCode, target)) {
    return {
      text: input,
      sourceLanguageCode: normalizeLangCode(sourceLanguageCode) || '',
      model: '',
    };
  }

  const primaryMayura = options.forceMayura === true
    || (options.forceTranslateV1 !== true
      && preferMayuraModel(input, sourceLanguageCode, targetLanguageCode));
  const primary = primaryMayura ? MAYURA_MODEL : TRANSLATE_MODEL;
  const fallback = primaryMayura ? TRANSLATE_MODEL : MAYURA_MODEL;
  const mode = trimStr(options.mode) || (primaryMayura ? 'code-mixed' : '');

  try {
    const first = await sarvamTranslate(input, sourceLanguageCode, target, apiKey, {
      model: primary,
      mode: primary === MAYURA_MODEL ? (mode || 'modern-colloquial') : undefined,
      outputScript: options.outputScript,
    });
    if (first.text) {
      return { text: first.text, sourceLanguageCode: first.sourceLanguageCode, model: primary };
    }
  } catch (err) {
    console.warn('sarvam primary translate failed, trying fallback', primary, err?.message || err);
  }

  const second = await sarvamTranslate(input, sourceLanguageCode, target, apiKey, {
    model: fallback,
    mode: fallback === MAYURA_MODEL ? (mode || 'modern-colloquial') : undefined,
    outputScript: options.outputScript,
  });
  return { text: second.text, sourceLanguageCode: second.sourceLanguageCode, model: fallback };
}

async function sarvamTranslateToMalayalam(text, sourceLanguageCode, apiKey) {
  const result = await sarvamTranslateSmart(text, sourceLanguageCode, ML_LANG, apiKey);
  return result.text;
}

export function normalizeAgentVoiceGender(value) {
  const g = trimStr(value).toLowerCase();
  if (g === 'female' || g === 'male') return g;
  return '';
}

/**
 * Bulbul v3 speaker for gender. Uses saved femaleSpeaker/maleSpeaker when provided;
 * otherwise priya / shubh. Unknown gender → male default.
 */
export function bulbulSpeakerForGender(gender, voiceSettings = null) {
  const voice = normalizeSarvamVoiceSettings(voiceSettings || {});
  const g = normalizeAgentVoiceGender(gender);
  if (g === 'female') return voice.femaleSpeaker;
  if (g === 'male') return voice.maleSpeaker;
  return voice.maleSpeaker || BULBUL_SPEAKER_DEFAULT;
}

/**
 * Decode audio to mono s16le PCM via ffmpeg (already on the function image).
 * Caps length so pitch check stays cheap.
 */
async function decodeAudioToPcm16Mono(buffer, contentType) {
  if (!ffmpegPath || !buffer?.length) return null;
  const id = randomUUID();
  const safeExt = extFromMime(contentType);
  const inPath = path.join(tmpdir(), `wa-pitch-in-${id}.${safeExt}`);
  const outPath = path.join(tmpdir(), `wa-pitch-out-${id}.pcm`);
  await fs.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inPath,
        '-t', '8',
        '-vn',
        '-ac', '1',
        '-ar', String(PITCH_SAMPLE_RATE),
        '-f', 's16le',
        outPath,
      ];
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
    const pcm = await fs.readFile(outPath);
    return pcm?.length ? pcm : null;
  } catch (err) {
    console.warn('voice pitch pcm decode failed', err?.message || err);
    return null;
  } finally {
    await Promise.all([
      fs.unlink(inPath).catch(() => {}),
      fs.unlink(outPath).catch(() => {}),
    ]);
  }
}

/**
 * Estimate median fundamental frequency (Hz) with short-frame autocorrelation.
 * No paid model — Sarvam STT REST does not return speaker gender.
 */
function estimateMedianF0Hz(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < Math.floor(PITCH_SAMPLE_RATE * 0.3) * 2) return null;
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Float64Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768;
  }

  const frameSize = Math.floor(PITCH_SAMPLE_RATE * 0.04); // 40 ms
  const hop = Math.floor(PITCH_SAMPLE_RATE * 0.02); // 20 ms
  const minLag = Math.floor(PITCH_SAMPLE_RATE / 300); // ~300 Hz
  const maxLag = Math.floor(PITCH_SAMPLE_RATE / 70); // ~70 Hz
  const f0s = [];

  for (let start = 0; start + frameSize + maxLag < sampleCount; start += hop) {
    let energy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const s = samples[start + i];
      energy += s * s;
    }
    if (energy < 0.01) continue; // skip near-silence

    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      for (let i = 0; i < frameSize; i += 1) {
        corr += samples[start + i] * samples[start + i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    const norm = bestCorr / energy;
    if (bestLag > 0 && norm > 0.3) {
      f0s.push(PITCH_SAMPLE_RATE / bestLag);
    }
  }

  if (f0s.length < 3) return null;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}

/**
 * Detect male/female from a voice note via median F0. Returns "female" | "male" | "".
 * Used for staff outbound (agentVoiceGender) and inbound customer Malayalam TTS.
 */
export async function detectAgentVoiceGender(buffer, contentType) {
  const pcm = await decodeAudioToPcm16Mono(buffer, contentType);
  const f0 = estimateMedianF0Hz(pcm);
  if (f0 == null || !Number.isFinite(f0)) return '';
  return f0 >= FEMALE_F0_HZ ? 'female' : 'male';
}

/** Same pitch detector; named for the inbound customer path. */
export async function detectCustomerVoiceGender(buffer, contentType) {
  return detectAgentVoiceGender(buffer, contentType);
}

/** Read persisted agent voice gender from staff user (refreshed on each staff voice note). */
export async function loadAgentVoiceGender(uid) {
  const id = trimStr(uid);
  if (!id) return '';
  const snap = await getFirestore().collection(USERS_COLLECTION).doc(id).get().catch(() => null);
  return normalizeAgentVoiceGender(snap?.data()?.agentVoiceGender);
}

/** Persist agentVoiceGender on users/{uid}; refreshed from the latest staff voice note. */
export async function saveAgentVoiceGender(uid, gender) {
  const id = trimStr(uid);
  const g = normalizeAgentVoiceGender(gender);
  if (!id || !g) return '';
  await getFirestore().collection(USERS_COLLECTION).doc(id).set({
    agentVoiceGender: g,
    agentVoiceGenderUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return g;
}

/** Bulbul TTS for any supported language_code (e.g. hi-IN, ml-IN). */
export async function sarvamTextToSpeech(inputText, languageCode, apiKey, options = {}) {
  const text = trimStr(inputText);
  if (!text) throw fail('No text for speech.', 'failed-precondition');
  const lang = normalizeLangCode(languageCode) || ML_LANG;
  const voice = normalizeSarvamVoiceSettings(options.voice || options);
  const speaker = trimStr(options.speaker)
    || bulbulSpeakerForGender(options.gender, voice)
    || BULBUL_SPEAKER_DEFAULT;

  // bulbul:v3 max ~2500 chars — chunk if needed and concatenate audio.
  const pieces = [];
  let rest = text;
  while (rest.length) {
    pieces.push(rest.slice(0, 2400));
    rest = rest.slice(2400);
  }

  const buffers = [];
  for (const piece of pieces) {
    // bulbul:v3 supports pace + temperature + sample rate (not pitch/loudness).
    const res = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: sarvamHeaders(apiKey, 'application/json'),
      body: JSON.stringify({
        text: piece,
        language_code: lang,
        model: TTS_MODEL,
        speaker,
        pace: voice.pace,
        temperature: voice.temperature,
        speech_sample_rate: voice.speechSampleRate,
        output_audio_codec: 'mp3',
      }),
    });
    if (!res.ok) {
      const textBody = await res.text().catch(() => '');
      throw fail(safeSarvamError(res, textBody), 'unavailable');
    }
    const json = await res.json().catch(() => ({}));
    const audios = Array.isArray(json?.audios) ? json.audios : [];
    const b64 = audios.map((a) => trimStr(a)).filter(Boolean).join('');
    if (!b64) throw fail('Sarvam TTS returned no audio.', 'unavailable');
    buffers.push(Buffer.from(b64, 'base64'));
  }
  return Buffer.concat(buffers);
}

/**
 * Callable preview: admin/sales. Reads sarvamApiKey server-side; never returns it.
 * Client may pass slider values + speaker for the sample (not persisted here).
 */
export async function previewSarvamVoiceHandler(data, context) {
  await assertSalesOrAdmin(context.auth?.uid);

  const apiKey = await loadSarvamApiKey();
  if (!apiKey) {
    throw fail('Sarvam API key missing. Save it in Settings → AI agent.', 'failed-precondition');
  }

  const saved = await loadSarvamVoiceSettings();
  const draft = data && typeof data === 'object' ? data : {};
  const voice = normalizeSarvamVoiceSettings({
    ...saved,
    pace: draft.pace ?? saved.pace,
    temperature: draft.temperature ?? saved.temperature,
    speechSampleRate: draft.speechSampleRate ?? draft.speech_sample_rate ?? saved.speechSampleRate,
    femaleSpeaker: draft.femaleSpeaker ?? saved.femaleSpeaker,
    maleSpeaker: draft.maleSpeaker ?? saved.maleSpeaker,
  });

  const previewGender = normalizeAgentVoiceGender(draft.previewGender || draft.gender);
  let speaker = trimStr(draft.speaker).toLowerCase();
  if (FEMALE_SPEAKER_SET.has(speaker)) {
    // ok — testing female list
  } else if (MALE_SPEAKER_SET.has(speaker)) {
    // ok — testing male list
  } else if (previewGender === 'female') {
    speaker = voice.femaleSpeaker;
  } else {
    speaker = voice.maleSpeaker;
  }

  const audioBuffer = await sarvamTextToSpeech(PREVIEW_SAMPLE_ML, ML_LANG, apiKey, {
    speaker,
    voice,
  });

  return {
    ok: true,
    mimeType: 'audio/mpeg',
    audioBase64: audioBuffer.toString('base64'),
    speaker,
    pace: voice.pace,
    temperature: voice.temperature,
    speechSampleRate: voice.speechSampleRate,
    sampleText: PREVIEW_SAMPLE_ML,
  };
}

/**
 * If conversation has no customerLanguage yet, recover it from the latest inbound
 * voice note's transcriptLanguage or text translationSourceLang.
 */
async function ensureCustomerLanguageFromInboundVoice(waId) {
  const existing = await loadCustomerLanguage(waId);
  if (existing?.code) return existing;

  const id = trimStr(waId).replace(/[^\d+]/g, '');
  if (!id) return null;
  const db = getFirestore();
  const loose = await db.collection(MESSAGES_COLLECTION)
    .where('waId', '==', id)
    .limit(80)
    .get()
    .catch(() => null);
  if (!loose || loose.empty) return null;

  const rows = loose.docs
    .map((docSnap) => docSnap.data() || {})
    .filter((row) => isInbound(row))
    .sort((a, b) => receivedAtMs(b) - receivedAtMs(a));

  for (const row of rows) {
    const fromVoice = isVoiceType(row.type) ? normalizeLangCode(row.transcriptLanguage) : '';
    const fromText = normalizeLangCode(row.translationSourceLang || row.customerLanguageCode);
    const code = fromVoice || fromText;
    if (code) return persistCustomerLanguage(id, code);
  }
  return null;
}

/**
 * Translate staff Malayalam into the chat destination language and keep modality.
 * Does not send to WhatsApp — caller performs Graph send + Firestore write.
 *
 * Destination = conversation outboundVoiceLanguage when set (Arabic, Hindi, …);
 * otherwise auto-detected customerLanguage.
 * Staff voice → customer voice in destination (never downgrade to text).
 * Staff text → customer text in destination (never upgrade to voice).
 * Malayalam source voice → passthrough: original recording, no TTS. STT still runs in the caller.
 * Other spoken languages still translate and speak the destination, including Malayalam TTS.
 * Text path: Google Translate. Voice TTS: Sarvam Bulbul (Indian + en-IN) or Google (ar / zh-CN).
 *
 * @param {'voice'|'text'} [staffInputModality] Required for correct routing; when omitted,
 *   falls back to replyToType / latest inbound (legacy).
 */
export async function prepareOutboundVoiceTranslateReply({
  waId,
  malayalamText,
  apiKey: providedKey,
  agentVoiceGender: providedGender,
  staffUid,
  replyToType,
  spokenLanguageCode = '',
  staffInputModality = '',
  brand = '',
} = {}) {
  const text = trimStr(malayalamText);
  if (!text) throw fail('Reply text is required.', 'invalid-argument');

  const autoLanguage = await ensureCustomerLanguageFromInboundVoice(waId);
  const voiceOverride = await loadOutboundVoiceLanguageOverride(waId, { brand });

  let agentVoiceGender = normalizeAgentVoiceGender(providedGender);
  if (!agentVoiceGender && staffUid) {
    agentVoiceGender = await loadAgentVoiceGender(staffUid);
  }

  // Staff modality wins: voice in → voice out, text in → text out.
  const inputModality = trimStr(staffInputModality).toLowerCase();
  let deliverAs = 'text';
  if (inputModality === 'voice' || inputModality === 'audio' || inputModality === 'ptt') {
    deliverAs = 'voice';
  } else if (inputModality === 'text') {
    deliverAs = 'text';
  } else {
    const replyType = trimStr(replyToType).toLowerCase();
    if (replyType && isVoiceMessageType(replyType)) {
      deliverAs = 'voice';
    } else if (replyType && (replyType === 'text' || replyType === 'button' || replyType === 'interactive')) {
      deliverAs = 'text';
    } else {
      deliverAs = (await latestInboundIsVoice(waId)) ? 'voice' : 'text';
    }
  }

  // Manual dropdown destination applies to both voice and text replies.
  const targetLanguage = voiceOverride || autoLanguage;
  const dropdownCode = voiceOverride?.code || OUTBOUND_VOICE_LANGUAGE_AUTO;

  // Malayalam source (header Malayalam, or Auto detect resolving to Malayalam):
  // never synthesize a voice. Caller sends the original agent recording.
  // STT still runs in the caller — this only skips TTS.
  if (
    deliverAs === 'voice'
    && shouldSendOriginalAgentVoice({
      spokenLanguageCode,
      dropdownLanguageCode: dropdownCode,
    })
  ) {
    return {
      mode: 'passthrough',
      malayalamText: text,
      deliveredText: text,
      deliverAs: 'voice',
      customerLanguage: targetLanguage,
      agentVoiceGender: agentVoiceGender || '',
      ttsSpeaker: '',
      voiceLanguageOverride: voiceOverride,
      skipRetts: true,
    };
  }

  if (!targetLanguage?.code) {
    return {
      mode: 'passthrough',
      malayalamText: text,
      deliveredText: text,
      deliverAs,
      customerLanguage: null,
      agentVoiceGender: agentVoiceGender || '',
      ttsSpeaker: '',
      voiceLanguageOverride: voiceOverride,
    };
  }

  // Target Malayalam + text, or voice whose source is already Malayalam (handled above):
  // send the original. Voice in another language still falls through to Malayalam TTS.
  const voiceNeedsMalayalamTts = deliverAs === 'voice'
    && Boolean(spokenLanguageCode)
    && !isMalayalamLang(spokenLanguageCode);
  if (sameLanguage(ML_LANG, targetLanguage.code) && !voiceNeedsMalayalamTts) {
    return {
      mode: 'passthrough',
      malayalamText: text,
      deliveredText: text,
      deliverAs,
      customerLanguage: targetLanguage,
      agentVoiceGender: agentVoiceGender || '',
      ttsSpeaker: '',
      voiceLanguageOverride: voiceOverride,
    };
  }

  // Staff audio already in the destination language → do not re-TTS.
  if (
    deliverAs === 'voice'
    && spokenLanguageCode
    && sameLanguage(spokenLanguageCode, targetLanguage.code)
  ) {
    return {
      mode: 'passthrough',
      malayalamText: text,
      deliveredText: text,
      deliverAs: 'voice',
      customerLanguage: targetLanguage,
      agentVoiceGender: agentVoiceGender || '',
      ttsSpeaker: '',
      voiceLanguageOverride: voiceOverride,
      skipRetts: true,
    };
  }

  let deliveredText = text;
  if (deliverAs === 'text') {
    const { translateTextViaGoogle } = await import('./whatsapp-translate.js');
    const translated = await translateTextViaGoogle(text, targetLanguage.code, ML_LANG);
    deliveredText = trimStr(translated?.text);
    if (!deliveredText) {
      throw fail('Could not translate the reply into the customer language.', 'unavailable');
    }
  } else if (isGoogleOutboundTtsLang(targetLanguage.code)) {
    // Arabic / Chinese only. Speak the translation, not the raw staff line.
    // Malayalam script → source ml. English or other → detect, do not force Malayalam.
    try {
      const { translateTextViaGoogle } = await import('./whatsapp-translate.js');
      const source = hasMalayalamScript(text) ? ML_LANG : (trimStr(spokenLanguageCode) || '');
      const translated = await translateTextViaGoogle(text, targetLanguage.code, source);
      deliveredText = trimStr(translated?.text);
      if (!deliveredText) {
        throw fail('Could not translate the reply into the customer language.', 'unavailable');
      }
    } catch (err) {
      console.warn('google outbound translate failed');
      if (err?.code === 'unavailable' && /customer language/i.test(String(err?.message || ''))) throw err;
      throw fail('Could not speak this reply in the customer language.', 'unavailable');
    }
  } else {
    const apiKey = trimStr(providedKey) || await loadSarvamApiKey();
    if (!apiKey) {
      throw fail('Sarvam API key missing. Save it in Settings → AI agent.', 'failed-precondition');
    }
    const translated = await sarvamTranslateSmart(text, ML_LANG, targetLanguage.code, apiKey);
    deliveredText = trimStr(translated?.text);
    if (!deliveredText) {
      throw fail('Could not translate the reply into the customer language.', 'unavailable');
    }
  }

  let ttsBuffer = null;
  let ttsSpeaker = '';
  let ttsEngine = '';
  if (deliverAs === 'voice') {
    if (isGoogleOutboundTtsLang(targetLanguage.code)) {
      try {
        const { synthesizeSpeechViaGoogle } = await import('./google-cloud-tts.js');
        ttsBuffer = await synthesizeSpeechViaGoogle(deliveredText, targetLanguage.code, {
          gender: agentVoiceGender,
        });
      } catch {
        console.warn('google outbound tts failed');
        throw fail('Could not speak this reply in the customer language.', 'unavailable');
      }
      ttsEngine = 'google';
      ttsSpeaker = agentVoiceGender === 'female' ? 'google-female' : 'google-male';
    } else {
      const apiKey = trimStr(providedKey) || await loadSarvamApiKey();
      if (!apiKey) {
        throw fail('Sarvam API key missing. Save it in Settings → AI agent.', 'failed-precondition');
      }
      const voice = await loadSarvamVoiceSettings();
      ttsSpeaker = bulbulSpeakerForGender(agentVoiceGender, voice);
      ttsBuffer = await sarvamTextToSpeech(deliveredText, targetLanguage.code, apiKey, {
        gender: agentVoiceGender,
        speaker: ttsSpeaker,
        voice,
      });
      ttsEngine = 'sarvam';
    }
  }

  return {
    mode: 'translated',
    malayalamText: text,
    deliveredText,
    deliverAs,
    customerLanguage: targetLanguage,
    agentVoiceGender,
    ttsSpeaker,
    ttsBuffer,
    ttsEngine,
    apiKeyPresent: deliverAs === 'voice' && ttsEngine === 'sarvam',
    voiceLanguageOverride: voiceOverride,
  };
}

async function storeMalayalamAudio(messageId, waId, audioBuffer, source = 'sarvam-bulbul') {
  const safeWa = trimStr(waId).replace(/[^\d+]/g, '') || 'unknown';
  const safeId = trimStr(messageId).replace(/[/\s]/g, '_');
  const storagePath = `whatsappTranslations/${safeWa}/${safeId}-ml.mp3`;
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  const downloadToken = randomUUID();
  await file.save(audioBuffer, {
    metadata: {
      contentType: 'audio/mpeg',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
        source: trimStr(source) || 'sarvam-bulbul',
        language: ML_LANG,
        messageId: safeId,
      },
    },
    resumable: false,
  });
  const mediaUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
  return { storagePath, mediaUrl, mimeType: 'audio/mpeg' };
}

/**
 * Background worker: Sarvam STT → translate to ml-IN → Bulbul TTS → Storage URL on message.
 */
export async function processWhatsAppVoiceTranslate(messageId, options = {}) {
  const id = trimStr(messageId).replace(/[/\s]/g, '_');
  if (!id) return { status: 'skipped', reason: 'missing-id' };

  const force = options.force === true;
  const claim = await claimProcessing(id, { force });
  if (!claim.ok) {
    return { status: 'skipped', reason: claim.reason };
  }

  try {
    const apiKey = await loadSarvamApiKey();
    if (!apiKey) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: 'Sarvam API key missing. Save it in Settings → AI agent.',
      });
      return { status: 'failed', reason: 'missing-key' };
    }

    const { buffer, contentType } = await loadAudioBuffer(claim.row);
    if (!buffer?.length) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: FAIL_MESSAGE,
      });
      return { status: 'failed', reason: 'empty-audio' };
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: 'Voice note is larger than 16 MB.',
      });
      return { status: 'failed', reason: 'too-large' };
    }

    const duration = await probeAudioDurationSeconds(buffer, extFromMime(contentType));
    if (duration != null && duration > MAX_AUDIO_SECONDS) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: 'Voice note is longer than 2 minutes.',
      });
      return { status: 'failed', reason: 'too-long' };
    }

    // Always STT for a Malayalam text line under the player. Malayalam audio: no translate / no TTS.
    const stt = await sarvamSpeechToText(buffer, contentType, apiKey);
    if (!stt.transcript) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: FAIL_MESSAGE,
        transcript: '',
        transcriptLanguage: stt.languageCode || '',
      });
      return { status: 'failed', reason: 'empty-transcript' };
    }

    if (stt.languageCode) {
      await persistCustomerLanguage(claim.row.waId, stt.languageCode).catch((err) => {
        console.warn('persistCustomerLanguage failed', err?.message || err);
      });
    }

    // This recording's language only. A saved customer language must not skip STT
    // or replace a non-Malayalam note, and must not skip the transcript for Malayalam.
    const spokenMalayalam = isMalayalamLang(stt.languageCode)
      || hasMalayalamScript(stt.transcript);

    if (spokenMalayalam) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'completed',
        voiceTranslateError: '',
        transcript: stt.transcript,
        transcriptLanguage: stt.languageCode || ML_LANG,
        transcriptionStatus: 'completed',
        transcriptionError: '',
        // Malayalam transcript for the inbox line — original audio stays on mediaUrl.
        malayalamText: stt.transcript,
        malayalamAudioUrl: '',
        malayalamAudioStoragePath: '',
        malayalamAudioMimeType: '',
        voiceTranslateSkipped: 'malayalam',
        ...messageLanguageFields(stt.languageCode || ML_LANG),
      });
      return {
        status: 'completed',
        languageCode: stt.languageCode || ML_LANG,
        skipped: 'malayalam',
      };
    }

    let malayalamText = await sarvamTranslateToMalayalam(
      stt.transcript,
      stt.languageCode || 'auto',
      apiKey,
    );
    if (!malayalamText) {
      await patchVoiceTranslate(id, {
        voiceTranslateStatus: 'failed',
        voiceTranslateError: 'Could not translate to Malayalam.',
        transcript: stt.transcript,
        transcriptLanguage: stt.languageCode || '',
      });
      return { status: 'failed', reason: 'translate-empty' };
    }

    // Match Malayalam TTS speaker to the customer's original voice gender.
    const customerVoiceGender = await detectCustomerVoiceGender(buffer, contentType);
    const voice = await loadSarvamVoiceSettings();
    const ttsSpeaker = bulbulSpeakerForGender(customerVoiceGender, voice);
    const audioBuffer = await sarvamTextToSpeech(malayalamText, ML_LANG, apiKey, {
      gender: customerVoiceGender,
      speaker: ttsSpeaker,
      voice,
    });
    const stored = await storeMalayalamAudio(id, claim.row.waId, audioBuffer);

    await patchVoiceTranslate(id, {
      voiceTranslateStatus: 'completed',
      voiceTranslateError: '',
      transcript: stt.transcript,
      transcriptLanguage: stt.languageCode || '',
      transcriptionStatus: 'completed',
      transcriptionError: '',
      malayalamText,
      malayalamAudioUrl: stored.mediaUrl,
      malayalamAudioStoragePath: stored.storagePath,
      malayalamAudioMimeType: stored.mimeType,
      customerVoiceGender: customerVoiceGender || '',
      customerTtsSpeaker: ttsSpeaker,
      ...messageLanguageFields(stt.languageCode || ''),
    });
    return {
      status: 'completed',
      languageCode: stt.languageCode,
      customerVoiceGender: customerVoiceGender || '',
      ttsSpeaker,
    };
  } catch (err) {
    console.warn('whatsapp voice-translate failed', id, err?.message || err);
    await patchVoiceTranslate(id, {
      voiceTranslateStatus: 'failed',
      voiceTranslateError: trimStr(err?.message).slice(0, 160) || FAIL_MESSAGE,
    }).catch(() => {});
    return { status: 'failed', reason: String(err?.message || err).slice(0, 200) };
  }
}

/** Firestore onWrite: queue work when voiceTranslateStatus becomes pending. */
export async function handleVoiceTranslateWrite(change) {
  const after = change.after.exists ? change.after.data() : null;
  if (!after) return null;
  if (trimStr(after.voiceTranslateStatus).toLowerCase() !== 'pending') return null;
  if (!isVoiceType(after.type) || !isInbound(after)) return null;

  const before = change.before.exists ? change.before.data() : null;
  const beforeStatus = trimStr(before?.voiceTranslateStatus).toLowerCase();
  if (beforeStatus === 'pending') return null;

  return processWhatsAppVoiceTranslate(change.after.id, { force: false });
}

/** Media-type placeholders must never be treated as transcript / Malayalam text. */
function isPlaceholderVoiceText(text) {
  const t = trimStr(text);
  if (!t) return true;
  return /^(voice message|audio|\[voice\]|\[audio\]|photo|video|document)$/i.test(t);
}

/**
 * Malayalam line for a real transcript. Returns the transcript itself when it is already Malayalam.
 * Translation failure returns '' so callers can still show the original words.
 */
export async function malayalamLineForTranscript(transcript, languageCode) {
  const text = trimStr(transcript);
  if (!text) return '';
  if (isMalayalamLang(languageCode) || hasMalayalamScript(text)) return text;
  const apiKey = await loadSarvamApiKey();
  try {
    return trimStr(await translateTranscriptToMalayalam(text, languageCode, apiKey));
  } catch (err) {
    console.warn('malayalam line failed', err?.message || err);
    return '';
  }
}

/**
 * Sarvam speech-to-text, then a Malayalam line when the speech is not already Malayalam.
 * Throws when the recording cannot be understood. Never fills in guessed words.
 */
export async function transcribeAudioToMalayalam(buffer, contentType) {
  const apiKey = await loadSarvamApiKey();
  if (!apiKey) {
    throw fail('Transcription is not configured.', 'failed-precondition');
  }
  const stt = await sarvamSpeechToText(buffer, contentType, apiKey);
  const transcript = trimStr(stt.transcript);
  if (!transcript) {
    throw fail('Could not transcribe this recording.', 'failed-precondition');
  }
  const languageCode = trimStr(stt.languageCode);
  const malayalamText = await malayalamLineForTranscript(transcript, languageCode);
  return { transcript, languageCode, malayalamText };
}

async function translateTranscriptToMalayalam(text, sourceLanguageCode, apiKey) {
  const input = trimStr(text);
  if (!input) return '';
  if (isMalayalamLang(sourceLanguageCode) || hasMalayalamScript(input)) return input;
  try {
    const { translateTextViaGoogle } = await import('./whatsapp-translate.js');
    const google = await translateTextViaGoogle(input, 'ml', sourceLanguageCode || '');
    const out = trimStr(google?.text);
    if (out) return out;
  } catch (err) {
    console.warn('google translate to ml failed', err?.message || err);
  }
  if (!apiKey) return '';
  return sarvamTranslateToMalayalam(input, sourceLanguageCode || 'auto', apiKey);
}

function isStoredTranslationAudioUrl(value) {
  const url = trimStr(value);
  if (!/^https?:\/\//i.test(url)) return false;
  return /firebasestorage\.googleapis\.com|storage\.googleapis\.com/i.test(url);
}

/**
 * Malayalam line to speak. Stored malayalamText first.
 * A Malayalam-script transcript/text counts when that field was not filled.
 * Never speaks a non-Malayalam transcript.
 */
function malayalamTranscriptFromRow(row) {
  const stored = trimStr(row?.malayalamText);
  if (stored && !isPlaceholderVoiceText(stored)) return stored;
  const candidates = [row?.transcript, row?.text, row?.caption, row?.translatedText];
  for (const value of candidates) {
    const text = trimStr(value);
    if (!text || isPlaceholderVoiceText(text)) continue;
    if (hasMalayalamScript(text)) return text;
  }
  return '';
}

/**
 * Callable: speak the stored Malayalam transcript for inbox playback.
 * Reuses a saved malayalamAudioUrl. Otherwise Google Cloud TTS (same path as Arabic/Chinese).
 * Never sends WhatsApp. Never returns provider error bodies.
 */
export async function ensureWhatsAppVoiceMalayalamAudioHandler(data, context) {
  await assertSalesOrAdmin(context.auth?.uid);
  const messageId = trimStr(data?.messageId).replace(/[/\s]/g, '_');
  if (!messageId) throw fail('Message is required.', 'invalid-argument');

  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(messageId);
  const snap = await ref.get();
  if (!snap.exists) throw fail('Could not find that WhatsApp message.', 'not-found');
  const row = snap.data() ?? {};
  if (!isVoiceType(row.type)) {
    throw fail('Only voice notes can be spoken in Malayalam.', 'failed-precondition');
  }

  const existingUrl = trimStr(row.malayalamAudioUrl);
  if (isStoredTranslationAudioUrl(existingUrl)) {
    return { ok: true, mediaUrl: existingUrl, mimeType: trimStr(row.malayalamAudioMimeType) || 'audio/mpeg', skipped: true };
  }

  // Malayalam source: never synthesize a second Malayalam voice. The original recording is the voice.
  // transcriptLanguage is the spoken source. messageLanguage may be the destination chip.
  const transcriptLang = trimStr(row.transcriptLanguage || '');
  const sourceIsMalayalam = trimStr(row.voiceTranslateSkipped) === 'malayalam'
    || isMalayalamLang(transcriptLang);
  const originalUrl = trimStr(row.mediaUrl);
  if (sourceIsMalayalam && /^https?:\/\//i.test(originalUrl)) {
    return {
      ok: true,
      mediaUrl: originalUrl,
      mimeType: trimStr(row.mimeType) || 'audio/ogg',
      skipped: true,
      reason: 'malayalam-source',
    };
  }

  const speak = malayalamTranscriptFromRow(row);
  if (!speak) throw fail('No Malayalam transcript to speak.', 'failed-precondition');

  let audioBuffer = null;
  try {
    const apiKey = await loadSarvamApiKey();
    if (apiKey) audioBuffer = await sarvamTextToSpeech(speak, ML_LANG, apiKey);
  } catch (err) {
    console.warn('malayalam inbox sarvam tts failed', err?.code || 'error');
  }
  if (!audioBuffer) {
    try {
      const { synthesizeSpeechViaGoogle } = await import('./google-cloud-tts.js');
      audioBuffer = await synthesizeSpeechViaGoogle(speak, ML_LANG);
    } catch (err) {
      console.warn('malayalam inbox tts failed', err?.code || 'error');
      throw fail('Could not play the Malayalam voice.', 'unavailable');
    }
  }

  const stored = await storeMalayalamAudio(messageId, row.waId, audioBuffer, 'google-cloud-tts');
  await ref.set({
    malayalamAudioUrl: stored.mediaUrl,
    malayalamAudioStoragePath: stored.storagePath,
    malayalamAudioMimeType: stored.mimeType,
    malayalamAudioUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true, mediaUrl: stored.mediaUrl, mimeType: stored.mimeType, skipped: false };
}

/**
 * Callable: fill Malayalam text under a voice bubble (inbound or outbound).
 * Chip language = spoken SOURCE from Sarvam STT (never default Malayalam).
 * Line under player = Malayalam transcript/translation via Google (Sarvam fallback).
 * Never sends to WhatsApp. Re-runs when stored text is only a media placeholder.
 */
export async function ensureWhatsAppVoiceMalayalamTextHandler(data, context) {
  await assertSalesOrAdmin(context.auth?.uid);
  const messageId = trimStr(data?.messageId).replace(/[/\s]/g, '_');
  if (!messageId) throw fail('Message is required.', 'invalid-argument');

  const ref = getFirestore().collection(MESSAGES_COLLECTION).doc(messageId);
  const snap = await ref.get();
  if (!snap.exists) throw fail('Could not find that WhatsApp message.', 'not-found');
  const row = snap.data() ?? {};
  if (!isVoiceType(row.type)) {
    throw fail('Only voice notes can be transcribed.', 'failed-precondition');
  }

  const force = Boolean(data?.force);
  const existingMl = trimStr(row.malayalamText);
  const usableExisting = existingMl && !isPlaceholderVoiceText(existingMl) ? existingMl : '';

  // Already have real Malayalam script under the player — keep it, but fix a wrong chip if STT lang is known.
  if (!force && usableExisting && hasMalayalamScript(usableExisting)) {
    const spoken = trimStr(row.transcriptLanguage || '');
    const patch = { voiceMalayalamTextUpdatedAt: FieldValue.serverTimestamp() };
    if (spoken && !isMalayalamLang(row.messageLanguage) && !isMalayalamLang(spoken)) {
      Object.assign(patch, messageLanguageFields(spoken));
    } else if (spoken) {
      Object.assign(patch, messageLanguageFields(spoken));
    } else if (!trimStr(row.messageLanguage) && hasMalayalamScript(usableExisting)) {
      Object.assign(patch, messageLanguageFields(ML_LANG));
    }
    if (!existingMl) patch.malayalamText = usableExisting;
    await ref.set(patch, { merge: true });
    return {
      ok: true,
      status: 'completed',
      skipped: true,
      malayalamText: usableExisting,
      languageCode: spoken || row.messageLanguage || '',
    };
  }

  // Non-script Latin "malayalamText" that is not a placeholder may still be wrong (e.g. English).
  // Only skip when we also have a real spoken-language tag that is not a blind Malayalam default
  // with no transcript — force STT when tag is ml but transcript missing / placeholder.
  const spokenKnown = trimStr(row.transcriptLanguage || '');
  const blindMlDefault = isMalayalamLang(row.messageLanguage)
    && !spokenKnown
    && (isPlaceholderVoiceText(row.text) || isPlaceholderVoiceText(row.caption) || !trimStr(row.transcript));
  if (!force && usableExisting && !blindMlDefault && spokenKnown) {
    return {
      ok: true,
      status: 'completed',
      skipped: true,
      malayalamText: usableExisting,
      languageCode: spokenKnown,
    };
  }

  const outbound = !isInbound(row);
  // Prefer a real stored transcript — never "Voice message".
  let storedSource = '';
  if (!isPlaceholderVoiceText(row.transcript)) storedSource = trimStr(row.transcript);
  else if (!isPlaceholderVoiceText(row.englishTranslation)) storedSource = trimStr(row.englishTranslation);

  const apiKey = await loadSarvamApiKey();

  let transcript = storedSource;
  let spokenLang = spokenKnown;
  let malayalamText = '';

  if (transcript && spokenLang && !blindMlDefault && !force) {
    malayalamText = await translateTranscriptToMalayalam(transcript, spokenLang, apiKey);
  } else {
    // Sarvam STT — source of truth for spoken language (outbound English, inbound Hindi, etc.).
    if (!apiKey) {
      throw fail('Sarvam API key missing. Save it in Settings → AI agent.', 'failed-precondition');
    }
    const { buffer, contentType } = await loadAudioBuffer(row);
    if (!buffer?.length) {
      throw fail('Voice note media is empty or unavailable.', 'failed-precondition');
    }
    const stt = await sarvamSpeechToText(buffer, contentType, apiKey);
    if (!stt.transcript) {
      throw fail('Could not understand the voice note.', 'failed-precondition');
    }
    transcript = stt.transcript;
    spokenLang = trimStr(stt.languageCode) || spokenLang || '';
    malayalamText = await translateTranscriptToMalayalam(transcript, spokenLang, apiKey);
  }

  if (!malayalamText) {
    throw fail('Could not produce Malayalam text for this voice note.', 'unavailable');
  }

  // Chip = spoken SOURCE only. Never invent Malayalam when language is unknown.
  const langFields = spokenLang
    ? messageLanguageFields(spokenLang)
    : { messageLanguage: '', messageLanguageName: '' };

  const textPatch = {};
  if (outbound && (isPlaceholderVoiceText(row.text) || !trimStr(row.text))) {
    textPatch.text = malayalamText;
  }
  if (outbound && (isPlaceholderVoiceText(row.caption) || !trimStr(row.caption))) {
    textPatch.caption = malayalamText;
  }

  await ref.set({
    malayalamText,
    transcript,
    transcriptLanguage: spokenLang || row.transcriptLanguage || '',
    transcriptionStatus: 'completed',
    transcriptionError: '',
    // Clear a prior Sarvam STT failure so the bubble stops showing HTTP 400.
    voiceTranslateError: '',
    ...(isMalayalamLang(spokenLang) || hasMalayalamScript(malayalamText)
      ? {
          voiceTranslateStatus: 'completed',
          voiceTranslateSkipped: 'malayalam',
          malayalamAudioUrl: '',
          malayalamAudioStoragePath: '',
          malayalamAudioMimeType: '',
        }
      : {}),
    ...textPatch,
    ...langFields,
    voiceMalayalamTextUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    ok: true,
    status: 'completed',
    malayalamText,
    languageCode: spokenLang || '',
    languageName: languageDisplayName(spokenLang) || '',
  };
}

