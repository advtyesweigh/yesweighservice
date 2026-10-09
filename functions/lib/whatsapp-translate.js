/**
 * Inbound WhatsApp TEXT translation for staff (learning stage — never sends replies).
 *
 * Malayalam (script, Manglish hints, or Google detect): leave as-is — no translate call.
 * Any other language, including romanized Indic (Hinglish / Tanglish):
 * translate to Malayalam via Google Cloud Translation API v2.
 * Original text is never replaced — Malayalam lands on translatedText.
 *
 * Voice notes are handled by whatsapp-voice-translate.js (Sarvam), not this module.
 */
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import {
  hasMalayalamScript,
  isLatinScriptText,
  languageDisplayName,
  loadSarvamApiKey,
  messageLanguageFields,
  persistCustomerLanguage,
  sarvamIdentifyLanguage,
  sarvamTranslateSmart,
} from './whatsapp-voice-translate.js';

const PROJECT_ID = 'yesweigh-service';
const ML_LANG = 'ml-IN';
const ML_GOOGLE = 'ml';
const ENGINE_TIMEOUT_MS = 30_000;
const ENGINE_NAME = 'sarvam-translate';

/** Common Manglish / romanized-Malayalam tokens (Latin script) — free local detect. */
const MANGLISH_HINTS = new Set([
  'entha', 'entho', 'enthu', 'enthina', 'enda', 'endaanu', 'endaayirunnu',
  'und', 'undo', 'undu', 'illa', 'ille', 'alla', 'alle', 'aano', 'aanu', 'ano',
  'njan', 'njaan', 'njangal', 'njaangal', 'ningal', 'ningalkku',
  'varum', 'varunnu', 'vannu', 'povum', 'poyi', 'povaam', 'pora', 'parayu',
  'paranju', 'parayamo', 'cheyyam', 'cheyyu', 'cheythu', 'venam', 'venda',
  'vendo', 'ethra', 'evide', 'evideya', 'ippo', 'ippol', 'inne', 'naale',
  'pinne', 'appo', 'athu', 'ithu', 'athinu', 'ithinu', 'sheri', 'sherikkum',
  'nalla', 'nallath', 'okke', 'ellam', 'oru', 'randu', 'moonnu', 'nalu',
  'ado', 'eda', 'edio', 'mwone', 'mone', 'mole', 'chechi', 'cheta', 'chetta',
  'ikko', 'allee', 'tharam', 'tharaamo', 'kittum', 'kittiyo', 'ariyilla',
  'ariyamo', 'paranjille', 'namukku', 'pole', 'aanallo', 'ayirunnu',
]);

let cachedGcpAccessToken = '';
let cachedGcpAccessTokenAt = 0;

function trimStr(value) {
  return String(value ?? '').trim();
}

function isMalayalamLang(code) {
  return /^ml([_-]|$)/i.test(trimStr(code));
}

/** Map Google ISO codes (hi, en, ta) to conversation BCP-47-ish codes. */
export function googleLangToStored(code) {
  const raw = trimStr(code).replace(/_/g, '-').toLowerCase();
  if (!raw || /^(unknown|auto)$/i.test(raw)) return '';
  const base = (raw.split('-')[0] || '').toLowerCase();
  if (!base) return '';
  if (base === 'ml') return ML_LANG;
  if (base === 'en') return 'en-IN';
  if (base === 'ar') return 'ar-EG';
  if (base === 'zh') return raw.includes('tw') || raw.includes('hk') ? raw : 'zh-CN';
  if (/^[a-z]{2,3}$/.test(base)) return `${base}-IN`;
  return raw;
}

/** Conversation / Sarvam-style code → Google Translate target/source code. */
export function storedLangToGoogle(code) {
  const raw = trimStr(code).replace(/_/g, '-');
  if (!raw || /^(unknown|auto)$/i.test(raw)) return '';
  const base = (raw.split('-')[0] || '').toLowerCase();
  if (base === 'od') return 'or'; // Google uses 'or' for Odia
  return base;
}

function unescapeGoogleText(translated) {
  return trimStr(translated)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Fast local guess before any Google call.
 * Malayalam script or strong Manglish tokens → skip paid APIs.
 * @returns {{ lang: string, needsMalayalam: boolean, confidence: 'high' | 'medium' | 'low', isMalayalam: boolean }}
 */
export function classifyTextLanguage(text) {
  const raw = trimStr(text);
  if (!raw) {
    return { lang: 'empty', needsMalayalam: false, confidence: 'high', isMalayalam: false };
  }
  if (hasMalayalamScript(raw)) {
    return { lang: ML_LANG, needsMalayalam: false, confidence: 'high', isMalayalam: true };
  }
  if (isLatinScriptText(raw)) {
    const tokens = raw
      .toLowerCase()
      .replace(/[^a-z\s']/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    let hits = 0;
    for (const token of tokens) {
      if (MANGLISH_HINTS.has(token)) hits += 1;
    }
    if (hits >= 1 && (hits >= 2 || tokens.length <= 5)) {
      return { lang: ML_LANG, needsMalayalam: false, confidence: 'high', isMalayalam: true };
    }
    return { lang: 'latin', needsMalayalam: true, confidence: 'medium', isMalayalam: false };
  }
  return { lang: 'other', needsMalayalam: true, confidence: 'medium', isMalayalam: false };
}

/**
 * Google Cloud Translation v2 language detect — cheaper than translate; use before translate
 * for Latin / unknown script so Malayalam (incl. Manglish) never pays for translate.
 * @returns {Promise<string>} Google ISO code (e.g. ml, hi, en)
 */
export async function detectLanguageViaGoogle(text) {
  const input = trimStr(text).slice(0, 1000);
  if (!input) return '';
  const token = await getGcpAccessToken();
  const res = await fetchWithTimeout(
    'https://translation.googleapis.com/language/translate/v2/detect',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': PROJECT_ID,
      },
      body: JSON.stringify({ q: input }),
    },
    ENGINE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`Cloud Detect HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`);
    err.code = res.status === 403 || res.status === 401 || res.status >= 500 ? 'unavailable' : 'failed';
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  const row = json?.data?.detections?.[0]?.[0] || json?.data?.detections?.[0] || {};
  return trimStr(row.language || '');
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
  if (!token) {
    const err = new Error('No GCP access token');
    err.code = 'unavailable';
    throw err;
  }
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
 * Google Cloud Translation API v2.
 * Detects source when source omitted. Never logs credentials.
 *
 * @returns {Promise<{ text: string, detectedSourceLanguage: string }>}
 */
export async function translateTextViaGoogle(text, targetLanguage, sourceLanguage = '') {
  const input = trimStr(text);
  if (!input) return { text: '', detectedSourceLanguage: '' };
  const target = storedLangToGoogle(targetLanguage) || trimStr(targetLanguage).toLowerCase();
  if (!target) {
    const err = new Error('Target language is required for Google Translate.');
    err.code = 'invalid-argument';
    throw err;
  }
  const source = storedLangToGoogle(sourceLanguage) || trimStr(sourceLanguage).toLowerCase();
  if (source && source === target) {
    return { text: input, detectedSourceLanguage: source };
  }

  const token = await getGcpAccessToken();
  const body = {
    q: input,
    target,
    format: 'text',
  };
  if (source && source !== 'auto') body.source = source;

  const res = await fetchWithTimeout('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': PROJECT_ID,
    },
    body: JSON.stringify(body),
  }, ENGINE_TIMEOUT_MS);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`Cloud Translate HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`);
    err.code = res.status === 403 || res.status === 401 || res.status >= 500 ? 'unavailable' : 'failed';
    throw err;
  }

  const json = await res.json().catch(() => ({}));
  const row = json?.data?.translations?.[0] || {};
  const translated = unescapeGoogleText(row.translatedText || '');
  if (!translated) {
    const err = new Error('Empty Cloud Translate result');
    err.code = 'failed';
    throw err;
  }
  return {
    text: translated,
    detectedSourceLanguage: trimStr(row.detectedSourceLanguage || source),
  };
}

function translationPatch(fields) {
  return {
    ...fields,
    translationUpdatedAt: FieldValue.serverTimestamp(),
  };
}

async function patchMessage(collectionName, messageId, fields) {
  if (!collectionName || !messageId) return;
  await getFirestore().collection(collectionName).doc(messageId).set(
    translationPatch(fields),
    { merge: true },
  );
}

/**
 * After the original inbound message is saved, attach Malayalam translation fields.
 * Never throws to callers — failures are logged and stored as flags.
 * Never blocks the inbound save path. Text path uses Google only (no Sarvam, no Ollama).
 * Malayalam (script / Manglish hints / Google detect) never pays for a translate call.
 */
export async function translateInboundMessage(input) {
  const collectionName = trimStr(input?.collectionName);
  const messageId = trimStr(input?.messageId);
  if (!collectionName || !messageId) return { status: 'skipped', reason: 'missing-id' };

  const type = trimStr(input?.type || 'text').toLowerCase();
  const text = trimStr(input?.text);
  const waId = trimStr(input?.waId);
  const isVoice = type === 'audio' || type === 'voice' || type === 'ptt';
  const isText = !isVoice && (type === 'text' || type === '' || Boolean(text));

  const markMalayalamSkip = async () => {
    if (waId) {
      await persistCustomerLanguage(waId, ML_LANG).catch(() => {});
    }
    await patchMessage(collectionName, messageId, {
      translationStatus: 'skipped',
      translationKind: 'text',
      translationSourceLang: ML_LANG,
      translationTargetLang: ML_LANG,
      translationError: '',
      translatedText: '',
      customerLanguageCode: ML_LANG,
      customerLanguageName: languageDisplayName(ML_LANG),
      translationEngine: ENGINE_NAME,
      ...messageLanguageFields(ML_LANG),
    });
    return { status: 'skipped', reason: 'malayalam' };
  };

  try {
    if (isVoice) {
      return { status: 'skipped', reason: 'voice-uses-voice-translate' };
    }

    if (!isText || !text || /^(voice message|photo|video|document|sticker|message|audio|image)$/i.test(text)) {
      return { status: 'skipped', reason: 'not-text' };
    }

    // Idempotency: skip if this message already has a Malayalam translation.
    const existing = await getFirestore().collection(collectionName).doc(messageId).get().catch(() => null);
    const existingRow = existing?.exists ? (existing.data() || {}) : {};
    if (
      trimStr(existingRow.translationStatus).toLowerCase() === 'done'
      && trimStr(existingRow.translatedText)
      && /^ml/i.test(trimStr(existingRow.translationTargetLang) || 'ml')
    ) {
      return { status: 'skipped', reason: 'already-done' };
    }

    // 1) Free local detect: Malayalam script or Manglish tokens → stop (no Google call).
    const classified = classifyTextLanguage(text);
    if (classified.isMalayalam || hasMalayalamScript(text)) {
      return markMalayalamSkip();
    }

    try {
      let detectedStored = '';
      const apiKey = await loadSarvamApiKey();
      if (apiKey && (classified.lang === 'latin' || classified.confidence !== 'high')) {
        try {
          const detectedSarvam = await sarvamIdentifyLanguage(text, apiKey);
          detectedStored = googleLangToStored(detectedSarvam?.languageCode) || trimStr(detectedSarvam?.languageCode);
          if (isMalayalamLang(detectedStored)) {
            return markMalayalamSkip();
          }
        } catch (detectErr) {
          console.warn('sarvam detect skipped', detectErr?.message || detectErr);
        }
      }
      if (!detectedStored && (classified.lang === 'latin' || classified.confidence !== 'high')) {
        try {
          const detectedGoogle = await detectLanguageViaGoogle(text);
          detectedStored = googleLangToStored(detectedGoogle);
          if (isMalayalamLang(detectedStored)) {
            return markMalayalamSkip();
          }
        } catch (detectErr) {
          console.warn('google detect skipped', detectErr?.message || detectErr);
        }
      }

      let malayalam = '';
      let detected = detectedStored || classified.lang;
      if (apiKey) {
        const result = await sarvamTranslateSmart(text, detectedStored || 'auto', ML_LANG, apiKey);
        malayalam = trimStr(result.text);
        detected = googleLangToStored(result.sourceLanguageCode) || detectedStored || classified.lang;
      } else {
        const result = await translateTextViaGoogle(
          text,
          ML_GOOGLE,
          detectedStored ? storedLangToGoogle(detectedStored) : '',
        );
        malayalam = trimStr(result.text);
        detected = googleLangToStored(result.detectedSourceLanguage) || detectedStored || classified.lang;
      }

      // Safety net if detect was skipped/failed but source is Malayalam.
      if (isMalayalamLang(detected) || hasMalayalamScript(text)) {
        return markMalayalamSkip();
      }

      if (!malayalam || malayalam === text) {
        if (waId && detected && !isMalayalamLang(detected)) {
          await persistCustomerLanguage(waId, detected).catch(() => {});
        }
        await patchMessage(collectionName, messageId, {
          translationStatus: 'skipped',
          translationKind: 'text',
          translationSourceLang: detected || '',
          translationTargetLang: ML_LANG,
          translationError: '',
          translatedText: '',
          translationEngine: ENGINE_NAME,
        });
        return { status: 'skipped', reason: 'same-as-original' };
      }

      if (waId && detected) {
        await persistCustomerLanguage(waId, detected).catch((err) => {
          console.warn('persistCustomerLanguage failed', err?.message || err);
        });
      }

      await patchMessage(collectionName, messageId, {
        translationStatus: 'done',
        translationKind: 'text',
        translationSourceLang: detected || '',
        translationTargetLang: ML_LANG,
        translationError: '',
        translatedText: malayalam,
        translatedMediaUrl: '',
        customerLanguageCode: detected || '',
        customerLanguageName: detected ? languageDisplayName(detected) : '',
        translationEngine: ENGINE_NAME,
        ...messageLanguageFields(detected || ''),
      });
      return { status: 'done', sourceLang: detected };
    } catch (err) {
      const unavailable = err?.code === 'unavailable'
        || /abort|timeout|fetch|ECONN|unreachable|Cloud Translate|Cloud Detect/i.test(err?.message || '');
      await patchMessage(collectionName, messageId, {
        translationStatus: unavailable ? 'unavailable' : 'failed',
        translationKind: 'text',
        translationSourceLang: classified.lang,
        translationTargetLang: ML_LANG,
        translationError: String(err?.message || err).slice(0, 300),
        translationEngine: ENGINE_NAME,
      });
      return { status: unavailable ? 'unavailable' : 'failed' };
    }
  } catch (err) {
    console.warn('whatsapp translate failed', messageId, err?.message || err);
    try {
      await patchMessage(collectionName, messageId, {
        translationStatus: 'failed',
        translationError: String(err?.message || err).slice(0, 300),
        translationEngine: ENGINE_NAME,
      });
    } catch {
      /* ignore */
    }
    return { status: 'failed' };
  }
}

