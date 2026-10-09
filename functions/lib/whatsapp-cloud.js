import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import ffmpegPath from 'ffmpeg-static';
import {
  KNOWN_SOURCE_ACCOUNTS,
  SOFTWARE_SHOPS_COLLECTION,
  SOURCE_ACCOUNT_YESWEIGH,
  softwareShopDocId,
} from './sanoft-shops.js';
import { translateInboundMessage } from './whatsapp-translate.js';
import {
  detectAgentVoiceGender,
  isVoiceTranslateEnabled,
  loadCustomerLanguage,
  loadOutboundVoiceLanguageOverride,
  loadSarvamApiKey,
  manualOutboundLanguageFromCode,
  markVoiceTranslatePending,
  messageLanguageFields,
  persistOutboundVoiceLanguage,
  prepareOutboundVoiceTranslateReply,
  saveAgentVoiceGender,
  sarvamSpeechToText,
  sarvamTranslateSmart,
  shouldSendOriginalAgentVoice,
} from './whatsapp-voice-translate.js';
import { markTranscriptionPending } from './whatsapp-transcribe.js';

const SETTINGS_DOC = 'whatsappSettings/config';
const CONVERSATIONS = 'whatsappConversations';
const MESSAGES = 'whatsappMessages';
const GRAPH_VERSION = 'v21.0';
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const PROJECT_ID = 'yesweigh-service';

export const WHATSAPP_CLOUD_WEBHOOK_URL =
  `https://asia-south1-${PROJECT_ID}.cloudfunctions.net/ingestWhatsAppCloudWebhook`;

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

function fail(message, code = 'failed-precondition') {
  throw new HttpsError(code, message);
}

function tokensEqual(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function queryValue(req, key) {
  const direct = req.query?.[key];
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const underscored = req.query?.[key.replace(/\./g, '_')];
  if (underscored != null && String(underscored).trim()) return String(underscored).trim();
  const [head, tail] = key.split('.');
  const nested = req.query?.[head];
  if (nested && typeof nested === 'object' && nested[tail] != null) {
    return String(nested[tail]).trim();
  }
  return '';
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = rawBodyBuffer(req);
  if (!raw?.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return {};
  }
}

function rawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  return null;
}

function validHubSignature(rawBody, header, appSecret) {
  const provided = String(header ?? '').trim();
  const match = provided.match(/^sha256=([a-f0-9]+)$/i);
  if (!match || !rawBody || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(match[1].toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeWaId(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return digits;
}

function graphErrorMessage(payload, status) {
  const error = payload?.error || {};
  const detail = [
    error.error_user_msg,
    error.error_data?.details,
    error.error_user_title,
    error.message,
  ].filter(Boolean).map(value => String(value).trim()).filter(Boolean);
  const text = [...new Set(detail)].join(' — ');
  const blob = `${text} ${error.code ?? ''} ${error.error_subcode ?? ''}`;
  if (/re-engagement|24 hours|131047/i.test(blob)) {
    return 'WhatsApp only allows a reply within 24 hours of the customer’s last message.';
  }
  if (/already exists|already in use/i.test(blob)) {
    return 'A template with this name already exists.';
  }
  if (/cannot be edited|not allowed to edit|editing this template/i.test(blob)) {
    return 'Approved templates cannot be edited. Delete it and create a new one.';
  }
  if (/^invalid parameter$/i.test(text) || (Number(error.code) === 100 && !text)) {
    return 'Meta rejected this template. Approved templates cannot be changed — delete it and create a new one, and fill body samples for {{1}} variables.';
  }
  return text || `Meta API error (${status}).`;
}

async function loadSettings() {
  const snap = await getFirestore().doc(SETTINGS_DOC).get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function requireSendConfig() {
  const settings = await loadSettings();
  const accessToken = String(settings.metaAccessToken ?? '').trim();
  const phoneNumberId = String(settings.metaPhoneNumberId ?? '').replace(/\D/g, '');
  if (!accessToken || !phoneNumberId) {
    fail('Connect WhatsApp in the page settings first.');
  }
  return {
    accessToken,
    phoneNumberId,
    wabaId: String(settings.metaWabaId ?? '').replace(/\D/g, ''),
    appSecret: String(settings.metaAppSecret ?? '').trim(),
    displayPhoneNumber: String(settings.displayPhoneNumber ?? '').trim(),
    accountName: String(settings.accountName ?? '').trim() || 'Interweighing',
  };
}

async function graphGet(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', token);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) fail(graphErrorMessage(payload, response.status));
  return payload;
}

async function graphFormPost(path, token, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    if (value == null || value === '') continue;
    body.set(key, String(value));
  }
  body.set('access_token', token);
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, '')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) fail(graphErrorMessage(payload, response.status));
  return payload;
}

function messageText(message) {
  const type = String(message?.type ?? '');
  if (type === 'text') return String(message?.text?.body ?? '').trim();
  if (type === 'button') return String(message?.button?.text ?? message?.button?.payload ?? '').trim();
  if (type === 'interactive') {
    const reply = message?.interactive?.button_reply || message?.interactive?.list_reply || {};
    return String(reply.title || reply.description || '').trim();
  }
  if (type === 'reaction') return String(message?.reaction?.emoji ?? '').trim();
  const part = message?.[type];
  if (part && typeof part === 'object') return String(part.caption ?? '').trim();
  return '';
}

function mediaPart(message) {
  const type = String(message?.type ?? '');
  if (!MEDIA_TYPES.has(type)) return null;
  const part = message?.[type];
  if (!part || typeof part !== 'object' || !part.id) return null;
  return {
    id: String(part.id),
    mimeType: String(part.mime_type ?? '').trim(),
    fileName: String(part.filename ?? '').trim(),
    caption: String(part.caption ?? '').trim(),
  };
}

function previewFor(type, text) {
  if (text) return text.slice(0, 500);
  if (type === 'image') return 'Photo';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Voice message';
  if (type === 'document') return 'Document';
  if (type === 'sticker') return 'Sticker';
  if (type === 'location') return 'Location';
  if (type === 'contacts') return 'Contact';
  return type ? type : '';
}

function extFromMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg')) return 'jpg';
  if (value.includes('png')) return 'png';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  if (value.includes('mp4')) return 'mp4';
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('pdf')) return 'pdf';
  if (value.includes('webm')) return 'webm';
  return 'bin';
}

function baseMime(mimeType) {
  return String(mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** Browser MediaRecorder usually yields webm; Graph voice notes need audio/ogg (Opus). */
function needsWebmToOggTranscode(mimeType) {
  const mime = baseMime(mimeType);
  return mime === 'audio/webm' || mime === 'audio/x-matroska';
}

async function transcodeBufferToOggOpus(buffer, inputExt = 'webm') {
  if (!ffmpegPath) {
    fail('Voice note conversion is not available on the server.');
  }
  const id = randomUUID();
  const safeExt = String(inputExt || 'webm').replace(/[^\w]/g, '') || 'webm';
  const inPath = path.join(tmpdir(), `wa-in-${id}.${safeExt}`);
  const outPath = path.join(tmpdir(), `wa-out-${id}.ogg`);
  await fs.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
        '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-application', 'voip', '-f', 'ogg', outPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', err => reject(err));
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
    const out = await fs.readFile(outPath);
    if (!out.length) fail('Voice note conversion produced an empty file.', 'internal');
    return out;
  } catch (err) {
    if (err?.httpErrorCode || err?.code === 'internal' || err?.code === 'failed-precondition') throw err;
    throw fail(
      'Could not convert the voice note for WhatsApp. Try recording again.',
      'internal',
    );
  } finally {
    await Promise.all([
      fs.unlink(inPath).catch(() => {}),
      fs.unlink(outPath).catch(() => {}),
    ]);
  }
}

async function graphUploadAndSendVoice(config, waId, oggBuffer, fileName = 'voice-note.ogg') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/ogg');
  form.append('file', new Blob([oggBuffer], { type: 'audio/ogg' }), fileName);
  const uploaded = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: form,
  });
  const uploadedPayload = await uploaded.json().catch(() => ({}));
  const mediaId = String(uploadedPayload?.id ?? '').trim();
  if (!uploaded.ok || !mediaId) fail(graphErrorMessage(uploadedPayload, uploaded.status));

  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'audio',
      audio: { id: mediaId, voice: true },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(graphErrorMessage(payload, response.status));
  return String(payload?.messages?.[0]?.id ?? '').trim();
}

async function storeDeliveredVoiceAudio(waId, whatsappMessageId, audioBuffer, languageCode) {
  const safeId = docIdForMessage(whatsappMessageId || randomUUID());
  const lang = String(languageCode || 'voice').replace(/[^\w-]/g, '') || 'voice';
  const storagePath = `whatsappMedia/${normalizeWaId(waId) || 'unknown'}/${safeId}-delivered-${lang}.mp3`;
  const bucket = getStorage().bucket();
  const downloadToken = randomUUID();
  await bucket.file(storagePath).save(audioBuffer, {
    resumable: false,
    metadata: {
      contentType: 'audio/mpeg',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
        source: 'sarvam-bulbul-outbound',
        language: lang,
        messageId: safeId,
      },
    },
  });
  return {
    storagePath,
    mimeType: 'audio/mpeg',
    mediaUrl: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`,
  };
}

function eventTime(unixSeconds) {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return Timestamp.now();
  return Timestamp.fromMillis(seconds * 1000);
}

function docIdForMessage(id) {
  return String(id || '').replace(/[/\s]/g, '_').slice(0, 700);
}

export function parseSoftwareShopIdFromText(text) {
  const match = String(text || '').match(/shop\s*id\s*[=:#]?\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function findSoftwareShopById(shopId) {
  if (!shopId) return null;
  const db = getFirestore();
  const accounts = [
    SOURCE_ACCOUNT_YESWEIGH,
    ...KNOWN_SOURCE_ACCOUNTS.filter(account => account !== SOURCE_ACCOUNT_YESWEIGH),
  ];
  for (const account of accounts) {
    const snap = await db.collection(SOFTWARE_SHOPS_COLLECTION).doc(softwareShopDocId(account, shopId)).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    return {
      id: snap.id,
      shopId,
      name: String(data.name || '').trim(),
      phone: String(data.phone || '').trim(),
      sourceAccount: String(data.sourceAccount || account),
    };
  }
  const queried = await db.collection(SOFTWARE_SHOPS_COLLECTION).where('shopId', '==', shopId).limit(5).get();
  if (queried.empty) return null;
  const preferred = queried.docs.find(row => row.data()?.sourceAccount === SOURCE_ACCOUNT_YESWEIGH) || queried.docs[0];
  const data = preferred.data() || {};
  return {
    id: preferred.id,
    shopId,
    name: String(data.name || '').trim(),
    phone: String(data.phone || '').trim(),
    sourceAccount: String(data.sourceAccount || ''),
  };
}

async function storeInboundMedia({ messageId, waId, media, accessToken }) {
  if (!media?.id || !accessToken) return '';
  const lookup = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${media.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const info = await lookup.json().catch(() => ({}));
  if (!lookup.ok || !info?.url) return '';
  const download = await fetch(info.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!download.ok) return '';
  const buffer = Buffer.from(await download.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) return '';
  const contentType = String(download.headers.get('content-type') ?? info.mime_type ?? media.mimeType ?? '')
    .split(';')[0]
    .trim() || 'application/octet-stream';
  if (/json|html|text\/plain/i.test(contentType)) return '';
  const storagePath = `whatsappMedia/${normalizeWaId(waId) || 'unknown'}/${docIdForMessage(messageId)}.${extFromMime(contentType)}`;
  const token = randomUUID();
  const bucket = getStorage().bucket();
  await bucket.file(storagePath).save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'private,max-age=86400',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

async function writeConversation(waId, patch) {
  await getFirestore().collection(CONVERSATIONS).doc(waId).set({
    waId,
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function patchWhatsAppConversation(data = {}) {
  const id = String(data.id || data.waId || '').trim();
  if (!id) throw new Error('Missing WhatsApp conversation.');
  const patch = {};
  if (typeof data.closed === 'boolean') patch.closed = data.closed;
  if ('assignedToUid' in data) patch.assignedToUid = String(data.assignedToUid || '');
  if ('assignedToName' in data) patch.assignedToName = String(data.assignedToName || '');
  if ('outboundVoiceLanguage' in data) {
    patch.outboundVoiceLanguage = String(data.outboundVoiceLanguage || 'auto');
    patch.outboundVoiceLanguageName = String(data.outboundVoiceLanguageName || '');
  }
  if (!Object.keys(patch).length) throw new Error('Nothing to update.');
  await getFirestore().collection(CONVERSATIONS).doc(id).set({
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
}

async function ingestMessages(value, accessToken) {
  const metadata = value?.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  const channelPhoneNumber = String(metadata.display_phone_number ?? '').trim();
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  const db = getFirestore();

  for (const message of messages.slice(0, 20)) {
    const waId = normalizeWaId(message?.from);
    const whatsappMessageId = String(message?.id ?? '').trim();
    if (!waId || !whatsappMessageId) continue;
    const type = String(message?.type ?? 'text') || 'text';
    const text = messageText(message);
    const media = mediaPart(message);
    const contact = (Array.isArray(value?.contacts) ? value.contacts : [])
      .find(item => normalizeWaId(item?.wa_id) === waId);
    const senderName = String(contact?.profile?.name ?? '').trim();
    const id = docIdForMessage(whatsappMessageId);
    const ref = db.collection(MESSAGES).doc(id);
    const existing = await ref.get();
    let mediaUrl = String(existing.data()?.mediaUrl ?? '');
    if (media?.id && accessToken && !mediaUrl) {
      try {
        mediaUrl = await storeInboundMedia({ messageId: whatsappMessageId, waId, media, accessToken });
      } catch (err) {
        console.warn('whatsapp media cache failed', whatsappMessageId, err?.message || err);
      }
    }
    await ref.set({
      waId,
      whatsappMessageId,
      direction: 'inbound',
      type,
      text,
      status: 'received',
      senderName,
      channelPhoneNumber,
      mimeType: media?.mimeType || '',
      fileName: media?.fileName || '',
      mediaUrl,
      createdAt: eventTime(message?.timestamp),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const shopPatch = {};
    const shopId = parseSoftwareShopIdFromText(text);
    if (shopId) {
      try {
        const shop = await findSoftwareShopById(shopId);
        const shopName = String(shop?.name || '').trim() || `Shop ${shopId}`;
        shopPatch.softwareShopId = shopId;
        shopPatch.softwareShopDocId = shop?.id || '';
        shopPatch.softwareShopName = shopName;
        shopPatch.senderName = shopName;
      } catch (err) {
        console.warn('whatsapp software shop lookup failed', shopId, err?.message || err);
        shopPatch.softwareShopId = shopId;
        shopPatch.senderName = senderName || `Shop ${shopId}`;
      }
    }
    await writeConversation(waId, {
      ...(senderName ? { senderName } : {}),
      ...shopPatch,
      lastText: previewFor(type, text),
      lastType: type,
      lastDirection: 'inbound',
      lastStatus: 'received',
      lastAt: eventTime(message?.timestamp),
      lastInboundAt: eventTime(message?.timestamp),
      channelPhoneNumber,
      closed: false,
      ...(mediaUrl ? { lastMediaUrl: mediaUrl } : {}),
      ...(existing.exists ? {} : { unreadCount: FieldValue.increment(1) }),
    });
    const isInboundVoice = type === 'audio' || type === 'voice' || type === 'ptt';
    if (isInboundVoice) {
      try {
        if (await isVoiceTranslateEnabled()) await markVoiceTranslatePending(id);
        else await markTranscriptionPending(id);
      } catch (err) {
        console.warn('whatsapp voice queue failed', err?.message || err);
      }
    } else {
      try {
        await translateInboundMessage({
          collectionName: MESSAGES,
          messageId: id,
          type,
          text,
          waId,
        });
      } catch (err) {
        console.warn('whatsapp translate failed', err?.message || err);
      }
    }
  }

  const echoes = [
    ...(Array.isArray(value?.message_echoes) ? value.message_echoes : []),
    ...(Array.isArray(value?.smb_message_echoes) ? value.smb_message_echoes : []),
  ];
  for (const message of echoes.slice(0, 20)) {
    const waId = normalizeWaId(message?.to || message?.recipient_id);
    const whatsappMessageId = String(message?.id ?? '').trim();
    if (!waId || !whatsappMessageId) continue;
    const type = String(message?.type ?? 'text') || 'text';
    const text = messageText(message);
    const id = docIdForMessage(whatsappMessageId);
    const ref = db.collection(MESSAGES).doc(id);
    const existing = await ref.get();
    if (existing.exists && existing.data()?.direction === 'outbound') continue;
    await ref.set({
      waId,
      whatsappMessageId,
      direction: 'outbound',
      type,
      text,
      status: 'sent',
      senderName: 'WhatsApp',
      channelPhoneNumber,
      createdAt: eventTime(message?.timestamp),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await writeConversation(waId, {
      lastText: previewFor(type, text),
      lastType: type,
      lastDirection: 'outbound',
      lastStatus: 'sent',
      lastAt: eventTime(message?.timestamp),
      unreadCount: 0,
      channelPhoneNumber,
    });
  }

  const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
  for (const status of statuses.slice(0, 20)) {
    const whatsappMessageId = String(status?.id ?? '').trim();
    const next = String(status?.status ?? '').trim().toLowerCase();
    if (!whatsappMessageId || !next) continue;
    await db.collection(MESSAGES).doc(docIdForMessage(whatsappMessageId)).set({
      status: next,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

export async function handleWhatsAppCloudWebhook(req, res) {
  if (req.method === 'GET') {
    const settings = await loadSettings();
    const expected = String(settings.metaVerifyToken ?? '').trim();
    const mode = queryValue(req, 'hub.mode');
    const token = queryValue(req, 'hub.verify_token');
    const challenge = queryValue(req, 'hub.challenge');
    if (!expected) {
      res.status(503).send('Save the WhatsApp verify token first.');
      return;
    }
    if (mode === 'subscribe' && tokensEqual(token, expected)) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const settings = await loadSettings();
  const appSecret = String(settings.metaAppSecret ?? '').trim();
  const rawBody = rawBodyBuffer(req);
  if (!appSecret || !validHubSignature(rawBody, req.get?.('x-hub-signature-256'), appSecret)) {
    res.status(403).send('Forbidden');
    return;
  }

  const body = parseBody(req);
  if (String(body?.object ?? '') !== 'whatsapp_business_account') {
    res.status(200).json({ ok: true, ingested: 0 });
    return;
  }

  const accessToken = String(settings.metaAccessToken ?? '').trim();
  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        if (String(change?.field ?? '') !== 'messages') continue;
        await ingestMessages(change?.value ?? {}, accessToken);
      }
    }
  } catch (err) {
    console.error('ingestWhatsAppCloudWebhook', err);
    res.status(500).send('Error');
    return;
  }
  res.status(200).json({ ok: true });
}

function publicSettings(settings) {
  const phoneNumberId = String(settings.metaPhoneNumberId ?? '').replace(/\D/g, '');
  const accessToken = String(settings.metaAccessToken ?? '').trim();
  return {
    configured: Boolean(accessToken && phoneNumberId),
    accountName: String(settings.accountName ?? '').trim(),
    displayPhoneNumber: String(settings.displayPhoneNumber ?? '').trim(),
    phoneNumberId,
    wabaId: String(settings.metaWabaId ?? '').replace(/\D/g, ''),
    verifyToken: String(settings.metaVerifyToken ?? '').trim(),
    hasAccessToken: Boolean(accessToken),
    hasAppSecret: Boolean(String(settings.metaAppSecret ?? '').trim()),
    webhookUrl: WHATSAPP_CLOUD_WEBHOOK_URL,
  };
}

export async function getWhatsAppCloudSettings() {
  return publicSettings(await loadSettings());
}

function pickPhone(numbers, requestedId) {
  const rows = Array.isArray(numbers) ? numbers : [];
  const wanted = String(requestedId ?? '').replace(/\D/g, '');
  if (wanted) {
    const match = rows.find(row => String(row.id ?? '').replace(/\D/g, '') === wanted);
    if (match) return match;
    if (!rows.length) return { id: wanted };
  }
  const firm = rows.find(row => String(row.display_phone_number ?? '').replace(/\D/g, '').endsWith('8803333444'));
  if (firm) return firm;
  if (rows.length === 1) return rows[0];
  return null;
}

async function subscribeWebhook(settings) {
  const accessToken = String(settings.metaAccessToken ?? '').trim();
  const appSecret = String(settings.metaAppSecret ?? '').trim();
  const verifyToken = String(settings.metaVerifyToken ?? '').trim();
  const wabaId = String(settings.metaWabaId ?? '').replace(/\D/g, '');
  if (!accessToken || !verifyToken || !wabaId) {
    return { subscribed: false, detail: 'Access token, verify token, and WABA id are required.' };
  }
  const debug = await graphGet('debug_token', accessToken, { input_token: accessToken });
  const appId = String(debug?.data?.app_id ?? '').replace(/\D/g, '');
  if (appSecret && appId) {
    await graphFormPost(`${appId}/subscriptions`, `${appId}|${appSecret}`, {
      object: 'whatsapp_business_account',
      callback_url: WHATSAPP_CLOUD_WEBHOOK_URL,
      verify_token: verifyToken,
      fields: 'messages',
    });
  }
  await graphFormPost(`${wabaId}/subscribed_apps`, accessToken, {
    override_callback_uri: WHATSAPP_CLOUD_WEBHOOK_URL,
    verify_token: verifyToken,
  });
  return { subscribed: true, appId, detail: '' };
}

export async function saveWhatsAppCloudSettings(data) {
  const current = await loadSettings();
  const incomingToken = String(data?.metaAccessToken ?? '').trim();
  const incomingSecret = String(data?.metaAppSecret ?? '').trim();
  const next = {
    metaAccessToken: incomingToken || String(current.metaAccessToken ?? '').trim(),
    metaAppSecret: incomingSecret || String(current.metaAppSecret ?? '').trim(),
    metaWabaId: String(data?.metaWabaId ?? current.metaWabaId ?? '').replace(/\D/g, ''),
    metaPhoneNumberId: String(data?.metaPhoneNumberId ?? current.metaPhoneNumberId ?? '').replace(/\D/g, ''),
    metaVerifyToken: String(data?.metaVerifyToken ?? current.metaVerifyToken ?? '').trim()
      || randomBytes(24).toString('hex'),
    accountName: String(data?.accountName ?? current.accountName ?? '').trim(),
    displayPhoneNumber: String(data?.displayPhoneNumber ?? current.displayPhoneNumber ?? '').trim(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!next.metaAccessToken) fail('Paste the Meta access token.', 'invalid-argument');
  if (!next.metaWabaId) fail('Paste the WhatsApp Business Account ID.', 'invalid-argument');

  let numbers = [];
  try {
    const listed = await graphGet(`${next.metaWabaId}/phone_numbers`, next.metaAccessToken, {
      fields: 'id,display_phone_number,verified_name',
    });
    numbers = Array.isArray(listed?.data) ? listed.data : [];
  } catch (err) {
    if (next.metaPhoneNumberId) {
      numbers = [];
    } else {
      throw err;
    }
  }
  const picked = pickPhone(numbers, next.metaPhoneNumberId);
  if (!picked && numbers.length > 1) {
    return {
      ...publicSettings({ ...current, ...next }),
      needsPhoneChoice: true,
      phones: numbers.map(row => ({
        id: String(row.id ?? ''),
        displayPhoneNumber: String(row.display_phone_number ?? ''),
        verifiedName: String(row.verified_name ?? ''),
      })),
    };
  }
  if (picked?.id) next.metaPhoneNumberId = String(picked.id).replace(/\D/g, '');
  if (picked?.display_phone_number) next.displayPhoneNumber = String(picked.display_phone_number);
  if (picked?.verified_name && !next.accountName) next.accountName = String(picked.verified_name);
  if (!next.metaPhoneNumberId) fail('Choose the WhatsApp phone number.', 'invalid-argument');

  await getFirestore().doc(SETTINGS_DOC).set(next, { merge: true });
  let webhook = { subscribed: false, detail: '' };
  try {
    webhook = await subscribeWebhook(next);
  } catch (err) {
    webhook = { subscribed: false, detail: err instanceof Error ? err.message : 'Could not subscribe the webhook.' };
  }
  return {
    ...publicSettings(next),
    needsPhoneChoice: false,
    phones: [],
    webhookSubscribed: webhook.subscribed,
    webhookDetail: webhook.detail || '',
  };
}

async function recordOutbound({
  waId, whatsappMessageId, type, text, fileName, mimeType, mediaUrl, sentByUid, sentByName, extra = {},
}) {
  const id = docIdForMessage(whatsappMessageId || randomUUID());
  await getFirestore().collection(MESSAGES).doc(id).set({
    waId,
    whatsappMessageId: whatsappMessageId || id,
    direction: 'outbound',
    type,
    text: text || '',
    status: 'sent',
    senderName: sentByName || 'YesWeigh',
    sentByUid: sentByUid || '',
    fileName: fileName || '',
    mimeType: mimeType || '',
    mediaUrl: mediaUrl || '',
    ...extra,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await writeConversation(waId, {
    lastText: previewFor(type, text),
    lastType: type,
    lastDirection: 'outbound',
    lastStatus: 'sent',
    lastAt: FieldValue.serverTimestamp(),
    unreadCount: 0,
  });
}

const LOGIN_OTP_TEMPLATE = 'otp';
const LOGIN_OTP_LANGUAGE = 'en_US';

function templateParameter(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {5,}/g, '    ')
    .trim()
    .slice(0, 80);
}

/** Dealer login OTP. Uses the approved Utility template `otp` (en_US): {{1}} name, {{2}} code. */
export async function sendWhatsAppLoginOtp(phone10, code, name) {
  const config = await requireSendConfig();
  const to = `91${String(phone10).replace(/\D/g, '')}`;
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: LOGIN_OTP_TEMPLATE,
        language: { code: LOGIN_OTP_LANGUAGE },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: templateParameter(name) || 'there' },
            { type: 'text', text: templateParameter(code) },
          ],
        }],
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(graphErrorMessage(payload, response.status));
  return { ok: true, id: String(payload?.messages?.[0]?.id ?? '').trim() };
}

export async function sendWhatsAppCloudText(data, actor) {
  const waId = normalizeWaId(data?.waId);
  const text = String(data?.text ?? '').trim();
  if (!waId) fail('Enter a WhatsApp number.', 'invalid-argument');
  if (!text) fail('Enter a message.', 'invalid-argument');
  const config = await requireSendConfig();
  let deliverText = text;
  const extra = {};
  const requestedRaw = String(data?.outboundVoiceLanguage ?? '').trim();
  let target = requestedRaw ? manualOutboundLanguageFromCode(requestedRaw) : null;
  if (target?.code) {
    await persistOutboundVoiceLanguage(waId, target.code).catch(() => undefined);
  } else {
    target = await loadOutboundVoiceLanguageOverride(waId);
  }
  if (!target?.code && await isVoiceTranslateEnabled()) {
    const customer = await loadCustomerLanguage(waId);
    if (customer?.code) target = customer;
  }
  if (target?.code) {
    try {
      let translated = '';
      const apiKey = await loadSarvamApiKey();
      if (apiKey) {
        const result = await sarvamTranslateSmart(text, 'auto', target.code, apiKey);
        translated = String(result?.text || '').trim();
      }
      if (!translated || translated === text) {
        const { translateTextViaGoogle } = await import('./whatsapp-translate.js');
        const google = await translateTextViaGoogle(text, target.code, '');
        translated = String(google?.text || '').trim();
      }
      if (translated && translated !== text) {
        deliverText = translated;
        extra.translationStatus = 'done';
        extra.translationKind = await isVoiceTranslateEnabled()
          ? 'voice-translate-outbound'
          : 'text';
        extra.translatedText = translated;
        extra.translationTargetLang = target.code;
        extra.translationTargetName = target.name || '';
        Object.assign(extra, messageLanguageFields(target.code));
      }
    } catch (err) {
      extra.translationError = String(err?.message || err).slice(0, 300);
    }
  }
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'text',
      text: { body: deliverText, preview_url: false },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(graphErrorMessage(payload, response.status), 'failed-precondition');
  const whatsappMessageId = String(payload?.messages?.[0]?.id ?? '').trim();
  await recordOutbound({
    waId,
    whatsappMessageId,
    type: 'text',
    text,
    sentByUid: actor?.uid,
    sentByName: actor?.name,
    extra,
  });
  return { ok: true, id: whatsappMessageId, translationError: extra.translationError || '' };
}

export async function setWhatsAppVoiceTranslate(enabled) {
  const on = enabled === true;
  const stamp = FieldValue.serverTimestamp();
  const db = getFirestore();
  await db.doc('whatsappSettings/aiAgent').set({ voiceTranslate: on, updatedAt: stamp }, { merge: true });
  await db.doc('whatsappSettings/voiceTranslate').set({ enabled: on, updatedAt: stamp }, { merge: true });
  return { ok: true, enabled: on };
}

function sendTypeForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Voice translate ON + staff voice note: STT → translate → destination-language VOICE.
 * CRM keeps staff audio on mediaUrl; delivered audio on translatedMediaUrl.
 */
async function sendTranslatedStaffVoiceReply({
  waId,
  staffBuffer,
  staffMimeType,
  stableMediaUrl,
  fileName,
  caption,
  staffUid = '',
  sentByName = '',
}) {
  const apiKey = await loadSarvamApiKey();
  if (!apiKey) {
    return {
      ok: true,
      passthrough: true,
      malayalamText: caption || '',
      transcript: caption || '',
      spokenLanguageCode: '',
      agentVoiceGender: '',
      langFields: {},
    };
  }

  let agentVoiceGender = '';
  try {
    agentVoiceGender = await detectAgentVoiceGender(staffBuffer, staffMimeType);
    if (agentVoiceGender && staffUid) {
      await saveAgentVoiceGender(staffUid, agentVoiceGender);
    }
  } catch (err) {
    console.warn('agent voice gender detect skipped', err?.message || err);
  }

  let spokenLanguageCode = '';
  let transcript = '';
  const dropdown = await loadOutboundVoiceLanguageOverride(waId);
  const dropdownCode = dropdown?.code || 'auto';
  let sttFailed = false;
  try {
    const stt = await sarvamSpeechToText(staffBuffer, staffMimeType, apiKey);
    transcript = String(stt.transcript || '').trim();
    spokenLanguageCode = String(stt.languageCode || '').trim();
  } catch (err) {
    sttFailed = true;
    console.warn('staff voice stt failed', err?.message || err);
  }

  if (shouldSendOriginalAgentVoice({
    spokenLanguageCode,
    transcript,
    dropdownLanguageCode: dropdownCode,
  })) {
    return {
      ok: true,
      passthrough: true,
      malayalamText: transcript,
      transcript,
      spokenLanguageCode: spokenLanguageCode || 'ml-IN',
      agentVoiceGender,
      langFields: messageLanguageFields(spokenLanguageCode || 'ml-IN'),
    };
  }

  if (sttFailed || !transcript) {
    fail('Could not understand the voice note. Try again or type the reply.', 'failed-precondition');
  }

  let malayalamText = transcript;
  const base = (spokenLanguageCode.split(/[-_]/)[0] || '').toLowerCase();
  const isMl = base === 'ml' || /[\u0D00-\u0D7F]/.test(transcript);
  if (!isMl) {
    try {
      const { translateTextViaGoogle } = await import('./whatsapp-translate.js');
      const google = await translateTextViaGoogle(transcript, 'ml', spokenLanguageCode || '');
      malayalamText = String(google?.text || '').trim() || transcript;
    } catch {
      malayalamText = transcript;
    }
  }

  const prepared = await prepareOutboundVoiceTranslateReply({
    waId,
    malayalamText,
    apiKey,
    agentVoiceGender,
    staffUid,
    spokenLanguageCode,
    staffInputModality: 'voice',
  });
  const destCode = prepared.customerLanguage?.code || '';
  const passthroughLangFields = spokenLanguageCode
    ? messageLanguageFields(spokenLanguageCode)
    : (/[\u0D00-\u0D7F]/.test(malayalamText)
      ? messageLanguageFields('ml-IN')
      : { messageLanguage: '', messageLanguageName: '' });

  if (prepared.mode === 'passthrough') {
    return {
      ok: true,
      passthrough: true,
      malayalamText,
      transcript,
      spokenLanguageCode,
      agentVoiceGender: agentVoiceGender || prepared.agentVoiceGender || '',
      langFields: passthroughLangFields,
    };
  }

  if (!prepared.ttsBuffer || !Buffer.isBuffer(prepared.ttsBuffer)) {
    fail('Could not synthesize destination-language voice for this reply.', 'unavailable');
  }

  const config = await requireSendConfig();
  const oggBuffer = await transcodeBufferToOggOpus(prepared.ttsBuffer, 'mp3');
  const whatsappMessageId = await graphUploadAndSendVoice(config, waId, oggBuffer);
  const stored = await storeDeliveredVoiceAudio(
    waId,
    whatsappMessageId || randomUUID(),
    prepared.ttsBuffer,
    destCode,
  );
  await recordOutbound({
    waId,
    whatsappMessageId,
    type: 'audio',
    text: malayalamText,
    fileName,
    mimeType: staffMimeType,
    mediaUrl: stableMediaUrl,
    sentByUid: staffUid,
    sentByName,
    extra: {
      malayalamText,
      transcript: transcript || malayalamText,
      transcriptionStatus: 'completed',
      transcriptionError: '',
      transcriptLanguage: '',
      translatedText: prepared.deliveredText,
      translatedMediaUrl: stored.mediaUrl,
      translatedMediaMimeType: stored.mimeType,
      translationStatus: 'done',
      translationKind: 'voice-translate-outbound',
      translationSourceLang: spokenLanguageCode || (/[\u0D00-\u0D7F]/.test(malayalamText) ? 'ml-IN' : ''),
      translationTargetLang: destCode,
      translationTargetName: prepared.customerLanguage?.name || '',
      ...(agentVoiceGender || prepared.agentVoiceGender
        ? { agentVoiceGender: agentVoiceGender || prepared.agentVoiceGender }
        : {}),
      ...(prepared.ttsSpeaker ? { ttsSpeaker: prepared.ttsSpeaker } : {}),
      ...messageLanguageFields(destCode),
    },
  });
  return { ok: true, id: whatsappMessageId, passthrough: false };
}

export async function sendWhatsAppCloudFile(data, actor) {
  const waId = normalizeWaId(data?.waId);
  const fileBase64 = String(data?.fileBase64 ?? '').trim();
  const mimeType = String(data?.mimeType ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  const fileName = String(data?.fileName ?? 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
  const caption = String(data?.caption ?? '').trim().slice(0, 1000);
  if (!waId) fail('Enter a WhatsApp number.', 'invalid-argument');
  if (!fileBase64) fail('Choose a file.', 'invalid-argument');
  const buffer = Buffer.from(fileBase64, 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    fail('File must be under 8 MB.', 'invalid-argument');
  }
  const sendType = sendTypeForMime(mimeType);
  const isVoiceNote = sendType === 'audio'
    || /^voice-note\./i.test(fileName)
    || needsWebmToOggTranscode(mimeType);

  const storagePath = `whatsappMedia/${waId}/${docIdForMessage(randomUUID())}.${extFromMime(mimeType)}`;
  const token = randomUUID();
  const bucket = getStorage().bucket();
  await bucket.file(storagePath).save(buffer, {
    resumable: false,
    metadata: {
      contentType: mimeType,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const mediaUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

  let staffMalayalamText = caption;
  let staffSpokenLang = '';
  let staffTranscript = '';
  let staffPassthroughLangFields = null;
  if (isVoiceNote && await isVoiceTranslateEnabled()) {
    const translated = await sendTranslatedStaffVoiceReply({
      waId,
      staffBuffer: buffer,
      staffMimeType: mimeType,
      stableMediaUrl: mediaUrl,
      fileName,
      caption,
      staffUid: actor?.uid,
      sentByName: actor?.name,
    });
    if (translated && !translated.passthrough) return translated;
    if (translated?.passthrough) {
      staffMalayalamText = String(translated.malayalamText || translated.transcript || '').trim() || staffMalayalamText;
      staffSpokenLang = String(translated.spokenLanguageCode || '').trim();
      staffPassthroughLangFields = translated.langFields || null;
      staffTranscript = String(translated.transcript || translated.malayalamText || '').trim();
    }
  }

  let graphBuffer = buffer;
  let graphMime = mimeType;
  let graphFileName = fileName;
  if (needsWebmToOggTranscode(mimeType)) {
    graphBuffer = await transcodeBufferToOggOpus(buffer, extFromMime(mimeType) || 'webm');
    graphMime = 'audio/ogg';
    graphFileName = fileName.replace(/\.[^.]+$/i, '') || 'voice-note';
    if (!/\.ogg$/i.test(graphFileName)) graphFileName = `${graphFileName}.ogg`;
  }

  const config = await requireSendConfig();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', graphMime);
  form.append('file', new Blob([graphBuffer], { type: graphMime }), graphFileName);
  const uploaded = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: form,
  });
  const uploadedPayload = await uploaded.json().catch(() => ({}));
  const mediaId = String(uploadedPayload?.id ?? '').trim();
  if (!uploaded.ok || !mediaId) fail(graphErrorMessage(uploadedPayload, uploaded.status));

  const mediaBody = { id: mediaId };
  if (isVoiceNote) mediaBody.voice = true;
  if (caption && sendType !== 'audio') mediaBody.caption = caption;
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: sendType,
      [sendType]: mediaBody,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(graphErrorMessage(payload, response.status));
  const whatsappMessageId = String(payload?.messages?.[0]?.id ?? '').trim();

  const extra = {};
  if (isVoiceNote) {
    const usableMl = staffMalayalamText && !/^(voice message|audio)$/i.test(staffMalayalamText)
      ? staffMalayalamText
      : '';
    Object.assign(extra, staffPassthroughLangFields || (staffSpokenLang
      ? messageLanguageFields(staffSpokenLang)
      : (usableMl && /[\u0D00-\u0D7F]/.test(usableMl)
        ? messageLanguageFields('ml-IN')
        : {})));
    extra.text = usableMl || caption || '';
    extra.malayalamText = usableMl || '';
    extra.transcript = staffTranscript || usableMl || '';
    extra.transcriptLanguage = staffSpokenLang || '';
    if (staffTranscript) {
      extra.transcriptionStatus = 'completed';
      extra.transcriptionError = '';
    }
  }

  await recordOutbound({
    waId,
    whatsappMessageId,
    type: sendType,
    text: isVoiceNote ? (staffMalayalamText || caption) : caption,
    fileName: isVoiceNote ? graphFileName : fileName,
    mimeType: isVoiceNote ? graphMime : mimeType,
    mediaUrl,
    sentByUid: actor?.uid,
    sentByName: actor?.name,
    extra,
  });
  return { ok: true, id: whatsappMessageId };
}

const TEMPLATE_CATEGORIES = new Set(['UTILITY', 'MARKETING', 'AUTHENTICATION']);
const MEDIA_HEADER_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const TEMPLATE_MEDIA_MAX_BYTES = 6 * 1024 * 1024;

function headerFormatOf(value) {
  const format = String(value ?? '').trim().toUpperCase();
  if (format === 'TEXT' || MEDIA_HEADER_FORMATS.has(format)) return format;
  return '';
}

function mimeForHeaderFormat(format, mimeType) {
  const mime = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (format === 'IMAGE' && (mime === 'image/jpeg' || mime === 'image/png')) return mime;
  if (format === 'VIDEO' && (mime === 'video/mp4' || mime === 'video/3gpp')) return mime;
  if (format === 'DOCUMENT' && mime === 'application/pdf') return mime;
  return '';
}

async function metaAppId(accessToken) {
  const debug = await graphGet('debug_token', accessToken, { input_token: accessToken });
  const appId = String(debug?.data?.app_id ?? '').replace(/\D/g, '');
  if (!appId) fail('Could not read the Meta app id from this token.');
  return appId;
}

async function uploadTemplateMediaHandle({ accessToken, buffer, fileName, mimeType }) {
  const appId = await metaAppId(accessToken);
  const session = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?${new URLSearchParams({
    file_name: fileName,
    file_length: String(buffer.length),
    file_type: mimeType,
    access_token: accessToken,
  })}`, { method: 'POST' });
  const sessionPayload = await session.json().catch(() => ({}));
  const sessionId = String(sessionPayload?.id ?? '').trim();
  if (!session.ok || !sessionId) fail(graphErrorMessage(sessionPayload, session.status));
  const uploaded = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });
  const uploadedPayload = await uploaded.json().catch(() => ({}));
  const handle = String(uploadedPayload?.h ?? '').trim();
  if (!uploaded.ok || !handle) fail(graphErrorMessage(uploadedPayload, uploaded.status));
  return handle;
}

function cleanTemplateText(value, max) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function placeholderCount(text, label) {
  const nums = [];
  const re = /\{\{(\d+)\}\}/g;
  let match = re.exec(text);
  while (match) {
    nums.push(Number(match[1]));
    match = re.exec(text);
  }
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  unique.forEach((n, index) => {
    if (n !== index + 1) {
      fail(`${label} placeholders must be {{1}}, {{2}}, and so on, in order.`, 'invalid-argument');
    }
  });
  return unique.length;
}

function samplesFor(count, raw, label) {
  const list = Array.isArray(raw) ? raw.map(value => templateParameter(value)) : [];
  if (count === 0) return [];
  if (list.length !== count || list.some(value => !value)) {
    fail(`${label} needs a sample for each variable.`, 'invalid-argument');
  }
  return list;
}

function templateNameOf(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(name)) {
    fail('Name must start with a letter and use only lowercase letters, numbers, and underscores.', 'invalid-argument');
  }
  return name;
}

function templateLanguageOf(value) {
  const language = String(value ?? '').trim();
  if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) {
    fail('Language must look like en or en_US.', 'invalid-argument');
  }
  return language;
}

function buttonFromInput(button) {
  const type = String(button?.type ?? '').trim().toUpperCase();
  const text = cleanTemplateText(button?.text, 25);
  if (!text) fail('Each button needs text.', 'invalid-argument');
  if (type === 'QUICK_REPLY') return { type, text };
  if (type === 'PHONE_NUMBER') {
    const phone = String(button?.phone ?? '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 8) {
      fail('Enter a phone number for the call button.', 'invalid-argument');
    }
    return { type, text, phone_number: phone };
  }
  if (type === 'URL') {
    const url = cleanTemplateText(button?.url, 2000);
    if (!/^https:\/\//i.test(url)) fail('Button links must start with https://.', 'invalid-argument');
    const count = placeholderCount(url, 'Button link');
    if (count > 1) fail('A button link can use only {{1}}.', 'invalid-argument');
    const next = { type, text, url };
    if (count === 1) {
      const sample = templateParameter(button?.urlSample);
      if (!/^https:\/\//i.test(sample)) {
        fail('The button link sample must be a full https:// URL.', 'invalid-argument');
      }
      next.example = [sample];
    }
    return next;
  }
  fail('Choose a website, call, or quick reply button.', 'invalid-argument');
}

function componentsFromInput(input) {
  const headerFormat = headerFormatOf(input?.headerFormat) || (cleanTemplateText(input?.headerText, 60) ? 'TEXT' : '');
  const headerText = headerFormat === 'TEXT' ? cleanTemplateText(input?.headerText, 60) : '';
  const body = cleanTemplateText(input?.body, 1024);
  const footer = cleanTemplateText(input?.footer, 60);
  if (!body) fail('The message body is required.', 'invalid-argument');
  const components = [];
  if (MEDIA_HEADER_FORMATS.has(headerFormat)) {
    const handle = String(input?.headerHandle ?? '').trim();
    if (!handle) fail('Attach a sample file for the media header.', 'invalid-argument');
    components.push({
      type: 'HEADER',
      format: headerFormat,
      example: { header_handle: [handle] },
    });
  } else if (headerText) {
    const count = placeholderCount(headerText, 'Header');
    if (count > 1) fail('The header can use only {{1}}.', 'invalid-argument');
    const header = { type: 'HEADER', format: 'TEXT', text: headerText };
    if (count === 1) {
      header.example = { header_text: samplesFor(1, input?.headerSamples, 'Header') };
    }
    components.push(header);
  }
  const bodyCount = placeholderCount(body, 'Body');
  const bodyComponent = { type: 'BODY', text: body };
  if (bodyCount) {
    bodyComponent.example = { body_text: [samplesFor(bodyCount, input?.bodySamples, 'Body')] };
  }
  components.push(bodyComponent);
  if (footer) {
    if (placeholderCount(footer, 'Footer')) fail('The footer cannot use variables.', 'invalid-argument');
    components.push({ type: 'FOOTER', text: footer });
  }
  const buttons = Array.isArray(input?.buttons) ? input.buttons.slice(0, 3).map(buttonFromInput) : [];
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  return components;
}

function templateView(row) {
  const components = Array.isArray(row?.components) ? row.components : [];
  const header = components.find(part => part?.type === 'HEADER');
  const body = components.find(part => part?.type === 'BODY');
  const footer = components.find(part => part?.type === 'FOOTER');
  const buttons = components.find(part => part?.type === 'BUTTONS');
  const headerFormat = String(header?.format ?? '');
  return {
    id: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    language: String(row?.language ?? ''),
    status: String(row?.status ?? ''),
    category: String(row?.category ?? ''),
    rejectedReason: String(row?.rejected_reason ?? ''),
    headerFormat,
    headerText: headerFormat === 'TEXT' ? String(header?.text ?? '') : '',
    body: String(body?.text ?? ''),
    footer: String(footer?.text ?? ''),
    buttons: (Array.isArray(buttons?.buttons) ? buttons.buttons : []).map(button => ({
      type: String(button?.type ?? ''),
      text: String(button?.text ?? ''),
      url: String(button?.url ?? ''),
      phone: String(button?.phone_number ?? ''),
    })),
    editable: TEMPLATE_CATEGORIES.has(String(row?.category ?? ''))
      && (!headerFormat || headerFormat === 'TEXT' || MEDIA_HEADER_FORMATS.has(headerFormat)),
  };
}

async function graphRequest(method, path, token, { query, body } = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) fail(graphErrorMessage(payload, response.status));
  return payload;
}

async function requireTemplateConfig() {
  const config = await requireSendConfig();
  if (!config.wabaId) fail('Connect the WhatsApp account before managing templates.');
  return config;
}

const TEMPLATE_FIELDS = 'id,name,language,status,category,rejected_reason,components';

export async function listWhatsAppTemplates() {
  const config = await requireTemplateConfig();
  const rows = [];
  let after = '';
  for (let page = 0; page < 8; page += 1) {
    const payload = await graphGet(`${config.wabaId}/message_templates`, config.accessToken, {
      limit: 100,
      fields: TEMPLATE_FIELDS,
      after,
    });
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...data.map(templateView));
    after = String(payload?.paging?.cursors?.after ?? '');
    if (!after || !data.length) break;
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  return { templates: rows };
}

async function readWhatsAppTemplate(config, id) {
  const payload = await graphRequest('GET', id, config.accessToken, {
    query: { fields: TEMPLATE_FIELDS },
  });
  return templateView(payload);
}

export async function saveWhatsAppTemplate(input) {
  const config = await requireTemplateConfig();
  const id = String(input?.id ?? '').replace(/\D/g, '');
  const category = String(input?.category ?? '').trim().toUpperCase();
  if (!TEMPLATE_CATEGORIES.has(category)) {
    fail('Category must be Utility, Marketing, or Authentication.', 'invalid-argument');
  }
  const headerFormat = headerFormatOf(input?.headerFormat) || (cleanTemplateText(input?.headerText, 60) ? 'TEXT' : '');
  let headerHandle = String(input?.headerHandle ?? '').trim();
  if (MEDIA_HEADER_FORMATS.has(headerFormat)) {
    const fileBase64 = String(input?.headerMediaBase64 ?? '').trim();
    if (!fileBase64) fail('Attach a sample file for the media header.', 'invalid-argument');
    const buffer = Buffer.from(fileBase64, 'base64');
    if (!buffer.length || buffer.length > TEMPLATE_MEDIA_MAX_BYTES) {
      fail('Header media must be under 6 MB.', 'invalid-argument');
    }
    const fileName = String(input?.headerMediaName ?? 'header').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'header';
    const mimeType = mimeForHeaderFormat(headerFormat, input?.headerMediaMime);
    if (!mimeType) {
      fail(
        headerFormat === 'IMAGE' ? 'Use a JPEG or PNG image.'
          : headerFormat === 'VIDEO' ? 'Use an MP4 video.'
            : 'Use a PDF document.',
        'invalid-argument',
      );
    }
    headerHandle = await uploadTemplateMediaHandle({
      accessToken: config.accessToken,
      buffer,
      fileName,
      mimeType,
    });
  }
  const components = componentsFromInput({ ...input, headerFormat, headerHandle });
  if (id) {
    const current = await readWhatsAppTemplate(config, id).catch(() => null);
    if (String(current?.status ?? '').toUpperCase() === 'APPROVED') {
      fail('Approved templates cannot be edited. Delete it and create a new one.', 'failed-precondition');
    }
    await graphRequest('POST', id, config.accessToken, {
      body: { category, components },
    });
    return readWhatsAppTemplate(config, id);
  }
  const created = await graphRequest('POST', `${config.wabaId}/message_templates`, config.accessToken, {
    body: {
      name: templateNameOf(input?.name),
      language: templateLanguageOf(input?.language || 'en_US'),
      category,
      parameter_format: 'POSITIONAL',
      allow_category_change: true,
      components,
    },
  });
  const createdId = String(created?.id ?? '').replace(/\D/g, '');
  if (!createdId) fail('Meta did not return the new template.');
  return readWhatsAppTemplate(config, createdId);
}

export async function deleteWhatsAppTemplate(input) {
  const config = await requireTemplateConfig();
  const id = String(input?.id ?? '').replace(/\D/g, '');
  const name = templateNameOf(input?.name);
  if (!name) fail('Choose a template to delete.', 'invalid-argument');
  const path = `${config.wabaId}/message_templates`;
  const query = id ? { hsm_id: id, name } : { name };
  await graphRequest('DELETE', path, config.accessToken, { query });
  return { ok: true };
}
