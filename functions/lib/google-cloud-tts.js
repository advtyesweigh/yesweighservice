/**
 * Google Cloud Text-to-Speech for outbound WhatsApp voice (Arabic + Mandarin)
 * and inbox playback of a stored Malayalam transcript.
 * Uses the same Cloud Functions service account as Translation (GoogleAuth).
 * Never logs access tokens.
 */
import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = 'yesweigh-service';
const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const ENGINE_TIMEOUT_MS = 45_000;
/** Cloud TTS input soft limit — keep chunks under this. */
const CHUNK_CHARS = 4500;

let cachedGcpAccessToken = '';
let cachedGcpAccessTokenAt = 0;

function trimStr(value) {
  return String(value ?? '').trim();
}

function fail(message, code = 'unavailable') {
  const err = new Error(message);
  err.code = code;
  return err;
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
  if (!token) throw fail('No GCP access token for Text-to-Speech.');
  cachedGcpAccessToken = token;
  cachedGcpAccessTokenAt = Date.now();
  return token;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = ENGINE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize stored / UI codes to Google TTS languageCode + WaveNet voice.
 * Arabic → Modern Standard (ar-XA). Chinese → Mandarin (cmn-CN).
 * Malayalam → ml-IN (inbox playback of a stored Malayalam transcript).
 */
export function googleTtsVoiceForLanguage(languageCode, gender = '') {
  const raw = trimStr(languageCode).replace(/_/g, '-').toLowerCase();
  const base = (raw.split('-')[0] || '').toLowerCase();
  const female = String(gender || '').toLowerCase() === 'female';

  if (base === 'ar') {
    return {
      languageCode: 'ar-XA',
      name: female ? 'ar-XA-Wavenet-A' : 'ar-XA-Wavenet-B',
      ssmlGender: female ? 'FEMALE' : 'MALE',
    };
  }
  if (base === 'zh' || base === 'cmn') {
    return {
      languageCode: 'cmn-CN',
      name: female ? 'cmn-CN-Wavenet-A' : 'cmn-CN-Wavenet-B',
      ssmlGender: female ? 'FEMALE' : 'MALE',
    };
  }
  if (base === 'ml') {
    return {
      languageCode: 'ml-IN',
      name: female ? 'ml-IN-Wavenet-A' : 'ml-IN-Wavenet-B',
      ssmlGender: female ? 'FEMALE' : 'MALE',
    };
  }
  throw fail(`Google TTS is only configured for Arabic, Chinese, and Malayalam (got ${languageCode || 'empty'}).`, 'invalid-argument');
}

export function isGoogleTtsLanguage(languageCode) {
  const base = (trimStr(languageCode).replace(/_/g, '-').split('-')[0] || '').toLowerCase();
  return base === 'ar' || base === 'zh' || base === 'cmn';
}

/** Cloud TTS rejects input over 5,000 bytes. Malayalam is 3 bytes per letter. */
function chunkText(text) {
  const input = trimStr(text);
  if (!input) return [];
  const maxBytes = Math.min(CHUNK_CHARS, 4500);
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return [input];
  const pieces = [];
  let start = 0;
  while (start < input.length) {
    let end = Math.min(input.length, start + maxBytes);
    while (end > start && Buffer.byteLength(input.slice(start, end), 'utf8') > maxBytes) end -= 1;
    if (end <= start) end = Math.min(input.length, start + 1);
    if (end < input.length) {
      const space = input.lastIndexOf(' ', end);
      if (space > start + Math.floor((end - start) * 0.5)) end = space;
    }
    const piece = input.slice(start, end).trim();
    if (piece) pieces.push(piece);
    const next = end;
    start = next;
    while (start < input.length && /\s/.test(input[start])) start += 1;
    if (start === next && start < input.length && !piece) start += 1;
  }
  return pieces;
}

/**
 * Synthesize MP3 via Cloud Text-to-Speech REST.
 * @returns {Promise<Buffer>}
 */
export async function synthesizeSpeechViaGoogle(inputText, languageCode, options = {}) {
  const text = trimStr(inputText);
  if (!text) throw fail('No text for Google TTS.', 'failed-precondition');

  const voice = googleTtsVoiceForLanguage(languageCode, options.gender);
  const token = await getGcpAccessToken();
  const pieces = chunkText(text);
  const buffers = [];

  for (const piece of pieces) {
    const res = await fetchWithTimeout(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': PROJECT_ID,
      },
      body: JSON.stringify({
        input: { text: piece },
        voice: {
          languageCode: voice.languageCode,
          name: voice.name,
          ssmlGender: voice.ssmlGender,
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1,
        },
      }),
    });

    if (!res.ok) {
      // Never put the Cloud JSON body on the Error — callers show err.message in the agent UI.
      console.warn('cloud tts synthesize failed', res.status);
      throw fail(
        'Could not speak this reply in the customer language.',
        res.status === 403 || res.status === 401 || res.status >= 500 ? 'unavailable' : 'failed',
      );
    }

    const json = await res.json().catch(() => ({}));
    const b64 = trimStr(json?.audioContent);
    if (!b64) throw fail('Cloud TTS returned no audio.');
    buffers.push(Buffer.from(b64, 'base64'));
  }

  return Buffer.concat(buffers);
}
