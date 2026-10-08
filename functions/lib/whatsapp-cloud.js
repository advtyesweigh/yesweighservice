import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';

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
  const error = payload?.error;
  const detail = String(error?.error_data?.details || error?.message || '').trim();
  if (/re-engagement|24 hours|131047/i.test(`${detail} ${error?.code ?? ''}`)) {
    return 'WhatsApp only allows a reply within 24 hours of the customer’s last message.';
  }
  return detail || `Meta API error (${status}).`;
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

function eventTime(unixSeconds) {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return Timestamp.now();
  return Timestamp.fromMillis(seconds * 1000);
}

function docIdForMessage(id) {
  return String(id || '').replace(/[/\s]/g, '_').slice(0, 700);
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
    await writeConversation(waId, {
      ...(senderName ? { senderName } : {}),
      lastText: previewFor(type, text),
      lastType: type,
      lastDirection: 'inbound',
      lastStatus: 'received',
      lastAt: eventTime(message?.timestamp),
      lastInboundAt: eventTime(message?.timestamp),
      channelPhoneNumber,
      ...(existing.exists ? {} : { unreadCount: FieldValue.increment(1) }),
    });
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

async function recordOutbound({ waId, whatsappMessageId, type, text, fileName, mimeType, mediaUrl, sentByUid, sentByName }) {
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

export async function sendWhatsAppCloudText(data, actor) {
  const waId = normalizeWaId(data?.waId);
  const text = String(data?.text ?? '').trim();
  if (!waId) fail('Enter a WhatsApp number.', 'invalid-argument');
  if (!text) fail('Enter a message.', 'invalid-argument');
  const config = await requireSendConfig();
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
      text: { body: text, preview_url: false },
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
  });
  return { ok: true, id: whatsappMessageId };
}

function sendTypeForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
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
  const config = await requireSendConfig();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);
  const uploaded = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: form,
  });
  const uploadedPayload = await uploaded.json().catch(() => ({}));
  const mediaId = String(uploadedPayload?.id ?? '').trim();
  if (!uploaded.ok || !mediaId) fail(graphErrorMessage(uploadedPayload, uploaded.status));

  const mediaBody = { id: mediaId };
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

  const storagePath = `whatsappMedia/${waId}/${docIdForMessage(whatsappMessageId || randomUUID())}.${extFromMime(mimeType)}`;
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
  await recordOutbound({
    waId,
    whatsappMessageId,
    type: sendType,
    text: caption,
    fileName,
    mimeType,
    mediaUrl,
    sentByUid: actor?.uid,
    sentByName: actor?.name,
  });
  return { ok: true, id: whatsappMessageId };
}
