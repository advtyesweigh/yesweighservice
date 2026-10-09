import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { app, db } from '../firebase';

const functions = getFunctions(app, 'asia-south1');

export const WHATSAPP_CONVERSATIONS = 'whatsappConversations';
export const WHATSAPP_MESSAGES = 'whatsappMessages';
const SESSION_MS = 24 * 60 * 60 * 1000;

export type WhatsAppSettings = {
  configured: boolean;
  accountName: string;
  displayPhoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  webhookUrl: string;
  needsPhoneChoice?: boolean;
  phones?: WhatsAppPhoneChoice[];
  webhookSubscribed?: boolean;
  webhookDetail?: string;
};

export type WhatsAppPhoneChoice = {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
};

export type WhatsAppConversation = {
  id: string;
  waId: string;
  senderName: string;
  lastText: string;
  lastType: string;
  lastDirection: string;
  lastAtMs: number;
  lastInboundAtMs: number;
  unreadCount: number;
  lastMediaUrl: string;
  assignedToUid: string;
  assignedToName: string;
  profileImage: string;
  closed: boolean;
  softwareShopId: number;
  softwareShopName: string;
  outboundVoiceLanguage: string;
  outboundVoiceLanguageName: string;
};

export function parseSoftwareShopIdFromText(text: string): number {
  const match = String(text || '').match(/shop\s*id\s*[=:#]?\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function softwareShopIdFromChat(chat: Pick<WhatsAppConversation, 'softwareShopId' | 'lastText'>): number {
  return Number(chat.softwareShopId) || parseSoftwareShopIdFromText(chat.lastText);
}

export type WhatsAppMediaKind = 'text' | 'image' | 'video' | 'audio' | 'file';

export type WhatsAppAssignee = {
  uid: string;
  displayName: string;
};

export type WhatsAppChatMessage = {
  id: string;
  waId: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string;
  status: string;
  fileName: string;
  mimeType: string;
  mediaUrl: string;
  createdAtMs: number;
  translatedText: string;
  translationStatus: string;
  translationKind: string;
  translationTargetLang: string;
  translationTargetName: string;
  messageLanguageName: string;
  transcript: string;
  transcriptionStatus: string;
  voiceTranslateStatus: string;
  malayalamText: string;
  malayalamAudioUrl: string;
  translatedMediaUrl: string;
  voiceTranslateError: string;
};

function callableError(err: unknown, fallback: string): Error {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = String((err as { message?: string }).message || '').trim();
    if (message && message !== 'internal') return new Error(message);
  }
  return new Error(fallback);
}

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

export function formatWhatsAppNumber(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (!digits) return raw;
  return `+${digits}`;
}

export function whatsappInboxChatPath(waId: string): string {
  const digits = String(waId || '').replace(/\D/g, '');
  return digits
    ? `/super-admin/whatsapp?chat=${encodeURIComponent(digits)}`
    : '/super-admin/whatsapp';
}

export function chatListPhone(waId: string): { label: string; href: string; tel: string } | null {
  const digits = String(waId || '').replace(/\D/g, '');
  if (!digits) return null;
  const label = formatWhatsAppNumber(digits);
  if (!label) return null;
  return {
    label,
    href: `https://wa.me/${digits}`,
    tel: `tel:+${digits}`,
  };
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatWaListTime(ms: number): string {
  if (!ms) return '';
  const value = new Date(ms);
  const now = new Date();
  const time = value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(value, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(value, yesterday)) return 'Yesterday';
  return value.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatAwaitingReplySince(fromMs: number, nowMs = Date.now()): string {
  if (!fromMs) return '';
  const totalMinutes = Math.floor(Math.max(0, nowMs - fromMs) / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function conversationNeedsStaffReply(chat: Pick<WhatsAppConversation, 'lastDirection'>): boolean {
  const direction = String(chat.lastDirection || '').trim().toLowerCase();
  return direction === 'inbound' || direction === 'incoming' || direction === 'received';
}

export function formatInboxCustomerElapsed(
  chat: Pick<WhatsAppConversation, 'lastDirection' | 'lastAtMs' | 'lastInboundAtMs'>,
  nowMs = Date.now(),
): string {
  if (!conversationNeedsStaffReply(chat)) return '';
  const inbound = Math.max(chat.lastAtMs || 0, chat.lastInboundAtMs || 0);
  if (!inbound || inbound > nowMs) return '';
  const since = formatAwaitingReplySince(inbound, nowMs);
  if (!since) return '';
  return nowMs - inbound > SESSION_MS ? `Overdue ${since}` : `Wait ${since}`;
}

export function conversationLastKind(
  chat: Pick<WhatsAppConversation, 'lastType' | 'lastText'>,
): WhatsAppMediaKind {
  const type = String(chat.lastType || '').trim().toLowerCase();
  const text = String(chat.lastText || '').trim().toLowerCase();
  if (type === 'image' || type === 'sticker' || type === 'gif' || text === 'photo' || text === 'gif' || text === 'sticker') {
    return 'image';
  }
  if (type === 'video' || text === 'video') return 'video';
  if (type === 'audio' || type === 'voice' || type === 'ptt' || text === 'voice message') return 'audio';
  if (type === 'document' || type === 'file' || text === 'document') return 'file';
  return 'text';
}

export function conversationPreviewLabel(
  chat: Pick<WhatsAppConversation, 'lastType' | 'lastText'>,
): string {
  const kind = conversationLastKind(chat);
  const text = String(chat.lastText || '').trim();
  const usable = text && !/^https?:\/\//i.test(text);
  if (kind === 'image') {
    if (usable && text.toLowerCase() !== 'photo' && text.toLowerCase() !== 'sticker' && text.toLowerCase() !== 'gif') {
      return text;
    }
    if (String(chat.lastType || '').toLowerCase() === 'sticker' || text.toLowerCase() === 'sticker') return 'Sticker';
    if (text.toLowerCase() === 'gif') return 'GIF';
    return 'Photo';
  }
  if (kind === 'video') return usable && text.toLowerCase() !== 'video' ? text : 'Video';
  if (kind === 'audio') return usable && text.toLowerCase() !== 'voice message' ? text : 'Voice message';
  if (kind === 'file') return usable && text.toLowerCase() !== 'document' ? text : 'Document';
  return text;
}

export function formatWhatsAppUnread(count: number): string {
  if (count > 99) return '99+';
  return String(Math.max(0, count));
}

export function chatPace(
  chat: Pick<WhatsAppConversation, 'lastDirection' | 'lastInboundAtMs'>,
  nowMs = Date.now(),
): 'overdue' | 'waiting' | 'recent' | 'none' {
  if (!chat.lastInboundAtMs) return 'none';
  const age = nowMs - chat.lastInboundAtMs;
  if (!Number.isFinite(age) || age < 0) return 'none';
  if (conversationNeedsStaffReply(chat)) return age > SESSION_MS ? 'overdue' : 'waiting';
  return age <= SESSION_MS ? 'recent' : 'none';
}

export function whatsAppSessionOpen(lastInboundAtMs: number, now = Date.now()): boolean {
  return lastInboundAtMs > 0 && now - lastInboundAtMs < SESSION_MS;
}

export async function loadWhatsAppSettings(): Promise<WhatsAppSettings> {
  try {
    const fn = httpsCallable<undefined, WhatsAppSettings>(functions, 'getWhatsAppCloudSettingsFn');
    const result = await fn();
    return result.data;
  } catch (err) {
    throw callableError(err, 'Could not load WhatsApp settings.');
  }
}

export async function saveWhatsAppSettings(input: {
  metaAccessToken?: string;
  metaAppSecret?: string;
  metaWabaId?: string;
  metaPhoneNumberId?: string;
}): Promise<WhatsAppSettings> {
  try {
    const fn = httpsCallable<typeof input, WhatsAppSettings>(
      functions,
      'saveWhatsAppCloudSettingsFn',
      { timeout: 60_000 },
    );
    const result = await fn(input);
    return result.data;
  } catch (err) {
    throw callableError(err, 'Could not save WhatsApp settings.');
  }
}

export async function sendWhatsAppText(
  waId: string,
  text: string,
  options?: {
    outboundVoiceLanguage?: string;
    outboundVoiceLanguageName?: string;
    skipTranslation?: boolean;
  },
): Promise<void> {
  try {
    const fn = httpsCallable<
      {
        waId: string;
        text: string;
        outboundVoiceLanguage?: string;
        outboundVoiceLanguageName?: string;
        skipTranslation?: boolean;
      },
      { ok: boolean }
    >(
      functions,
      'sendWhatsAppCloudMessage',
      { timeout: 60_000 },
    );
    await fn({
      waId,
      text,
      outboundVoiceLanguage: options?.outboundVoiceLanguage,
      outboundVoiceLanguageName: options?.outboundVoiceLanguageName,
      skipTranslation: options?.skipTranslation === true,
    });
  } catch (err) {
    throw callableError(err, 'Could not send the message.');
  }
}

export function subscribeWhatsAppVoiceTranslate(
  onChange: (enabled: boolean) => void,
): () => void {
  return onSnapshot(
    doc(db, 'whatsappSettings', 'voiceTranslate'),
    snap => onChange(snap.data()?.enabled === true),
    () => onChange(false),
  );
}

export async function setWhatsAppVoiceTranslate(enabled: boolean): Promise<void> {
  await setDoc(
    doc(db, 'whatsappSettings', 'voiceTranslate'),
    { enabled: enabled === true, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function ensureWhatsAppVoiceMalayalamText(messageId: string): Promise<{ malayalamText?: string }> {
  const fn = httpsCallable<{ messageId: string }, { malayalamText?: string }>(
    functions,
    'ensureWhatsAppVoiceMalayalamTextFn',
    { timeout: 180_000 },
  );
  const result = await fn({ messageId });
  return result.data ?? {};
}

export async function ensureWhatsAppVoiceMalayalamAudio(messageId: string): Promise<{ mediaUrl?: string }> {
  const fn = httpsCallable<{ messageId: string }, { mediaUrl?: string }>(
    functions,
    'ensureWhatsAppVoiceMalayalamAudioFn',
    { timeout: 90_000 },
  );
  const result = await fn({ messageId });
  return result.data ?? {};
}

export async function retryWhatsAppTranscription(messageId: string): Promise<void> {
  const fn = httpsCallable<{ messageId: string }, { ok: boolean }>(
    functions,
    'retryWhatsAppTranscriptionFn',
    { timeout: 180_000 },
  );
  await fn({ messageId });
}

export async function sendWhatsAppFile(input: {
  waId: string;
  fileBase64: string;
  mimeType: string;
  fileName: string;
  caption?: string;
}): Promise<void> {
  try {
    const fn = httpsCallable<typeof input, { ok: boolean }>(
      functions,
      'sendWhatsAppCloudFileFn',
      { timeout: 180_000 },
    );
    await fn(input);
  } catch (err) {
    throw callableError(err, 'Could not send the file.');
  }
}

export function subscribeWhatsAppConversations(
  onChange: (rows: WhatsAppConversation[]) => void,
  onError: (error: Error) => void,
): () => void {
  const q = query(
    collection(db, WHATSAPP_CONVERSATIONS),
    orderBy('lastAt', 'desc'),
    limit(100),
  );
  return onSnapshot(q, snap => {
    onChange(snap.docs.map(item => {
      const data = item.data();
      return {
        id: item.id,
        waId: String(data.waId ?? item.id),
        senderName: String(data.senderName ?? ''),
        lastText: String(data.lastText ?? ''),
        lastType: String(data.lastType ?? ''),
        lastDirection: String(data.lastDirection ?? ''),
        lastAtMs: millisOf(data.lastAt),
        lastInboundAtMs: millisOf(data.lastInboundAt),
        unreadCount: Number(data.unreadCount ?? 0) || 0,
        lastMediaUrl: String(data.lastMediaUrl ?? ''),
        assignedToUid: String(data.assignedToUid ?? ''),
        assignedToName: String(data.assignedToName ?? ''),
        profileImage: String(data.profileImage ?? ''),
        closed: data.closed === true,
        softwareShopId: Number(data.softwareShopId) || 0,
        softwareShopName: String(data.softwareShopName ?? ''),
        outboundVoiceLanguage: String(data.outboundVoiceLanguage ?? 'auto'),
        outboundVoiceLanguageName: String(data.outboundVoiceLanguageName ?? ''),
      };
    }));
  }, err => onError(err));
}

export function subscribeWhatsAppMessages(
  waId: string,
  onChange: (rows: WhatsAppChatMessage[]) => void,
  onError: (error: Error) => void,
): () => void {
  const q = query(
    collection(db, WHATSAPP_MESSAGES),
    where('waId', '==', waId),
    orderBy('createdAt', 'asc'),
    limit(300),
  );
  return onSnapshot(q, snap => {
    onChange(snap.docs.map(item => {
      const data = item.data();
      const direction = data.direction === 'outbound' ? 'outbound' : 'inbound';
      return {
        id: item.id,
        waId: String(data.waId ?? waId),
        direction,
        type: String(data.type ?? 'text'),
        text: String(data.text ?? ''),
        status: String(data.status ?? ''),
        fileName: String(data.fileName ?? ''),
        mimeType: String(data.mimeType ?? ''),
        mediaUrl: String(data.mediaUrl ?? ''),
        createdAtMs: millisOf(data.createdAt),
        translatedText: String(data.translatedText ?? ''),
        translationStatus: String(data.translationStatus ?? ''),
        translationKind: String(data.translationKind ?? ''),
        translationTargetLang: String(data.translationTargetLang ?? ''),
        translationTargetName: String(data.translationTargetName ?? ''),
        messageLanguageName: String(data.messageLanguageName ?? data.customerLanguageName ?? ''),
        transcript: String(data.transcript ?? ''),
        transcriptionStatus: String(data.transcriptionStatus ?? ''),
        voiceTranslateStatus: String(data.voiceTranslateStatus ?? ''),
        malayalamText: String(data.malayalamText ?? ''),
        malayalamAudioUrl: String(data.malayalamAudioUrl ?? ''),
        translatedMediaUrl: String(data.translatedMediaUrl ?? ''),
        voiceTranslateError: String(data.voiceTranslateError ?? ''),
      };
    }));
  }, err => onError(err));
}

export async function markWhatsAppConversationRead(id: string): Promise<void> {
  await updateDoc(doc(db, WHATSAPP_CONVERSATIONS, id), { unreadCount: 0 });
}

async function patchWhatsAppConversationDoc(input: {
  id: string;
  closed?: boolean;
  assignedToUid?: string;
  assignedToName?: string;
  outboundVoiceLanguage?: string;
  outboundVoiceLanguageName?: string;
}): Promise<void> {
  try {
    const fn = httpsCallable<typeof input, { ok: boolean }>(
      functions,
      'patchWhatsAppConversationFn',
      { timeout: 30_000 },
    );
    await fn(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!/not found|unimplemented|internal|nothing to update/i.test(message)) {
      throw callableError(err, 'Could not update this chat.');
    }
    const patch: Record<string, string | boolean> = {};
    if (typeof input.closed === 'boolean') patch.closed = input.closed;
    if ('assignedToUid' in input) patch.assignedToUid = input.assignedToUid || '';
    if ('assignedToName' in input) patch.assignedToName = input.assignedToName || '';
    if ('outboundVoiceLanguage' in input) {
      patch.outboundVoiceLanguage = input.outboundVoiceLanguage || 'auto';
      patch.outboundVoiceLanguageName = input.outboundVoiceLanguageName || '';
    }
    await updateDoc(doc(db, WHATSAPP_CONVERSATIONS, input.id), patch);
  }
}

export async function setWhatsAppOutboundLanguage(
  id: string,
  language: string,
  name: string,
): Promise<void> {
  const outboundVoiceLanguage = language || 'auto';
  const outboundVoiceLanguageName = name || 'Auto detect';
  try {
    await setDoc(
      doc(db, WHATSAPP_CONVERSATIONS, id),
      {
        outboundVoiceLanguage,
        outboundVoiceLanguageName,
        outboundVoiceLanguageUpdatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch {
    await patchWhatsAppConversationDoc({
      id,
      outboundVoiceLanguage,
      outboundVoiceLanguageName,
    });
  }
}

export async function assignWhatsAppConversation(
  id: string,
  person: WhatsAppAssignee | null,
): Promise<void> {
  await patchWhatsAppConversationDoc({
    id,
    assignedToUid: person?.uid || '',
    assignedToName: person?.displayName || '',
  });
}

export async function setWhatsAppConversationClosed(id: string, closed: boolean): Promise<void> {
  await patchWhatsAppConversationDoc({ id, closed });
}

export function subscribeWhatsAppAssignees(
  onChange: (rows: WhatsAppAssignee[]) => void,
  onError: (error: Error) => void,
): () => void {
  const q = query(
    collection(db, 'users'),
    where('role', 'in', ['staff', 'super_admin']),
    limit(80),
  );
  return onSnapshot(q, snap => {
    onChange(snap.docs.flatMap(item => {
      const data = item.data();
      if (data.active === false) return [];
      const displayName = String(data.displayName || '').trim() || 'Staff';
      return [{ uid: item.id, displayName }];
    }));
  }, err => onError(err));
}

export type WhatsAppTemplateButton = {
  type: string;
  text: string;
  url: string;
  phone: string;
  urlSample?: string;
};

export type WhatsAppTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejectedReason: string;
  headerFormat: string;
  headerText: string;
  body: string;
  footer: string;
  buttons: WhatsAppTemplateButton[];
  editable: boolean;
};

export type WhatsAppTemplateInput = {
  id?: string;
  name?: string;
  language?: string;
  category: string;
  headerFormat?: string;
  headerText: string;
  headerMediaBase64?: string;
  headerMediaName?: string;
  headerMediaMime?: string;
  body: string;
  footer: string;
  buttons: WhatsAppTemplateButton[];
  headerSamples: string[];
  bodySamples: string[];
};

export async function listWhatsAppTemplates(): Promise<WhatsAppTemplate[]> {
  try {
    const fn = httpsCallable<undefined, { templates: WhatsAppTemplate[] }>(
      functions,
      'listWhatsAppTemplatesFn',
      { timeout: 60_000 },
    );
    const result = await fn();
    return result.data.templates ?? [];
  } catch (err) {
    throw callableError(err, 'Could not load WhatsApp templates.');
  }
}

export async function saveWhatsAppTemplate(input: WhatsAppTemplateInput): Promise<WhatsAppTemplate> {
  try {
    const fn = httpsCallable<WhatsAppTemplateInput, WhatsAppTemplate>(
      functions,
      'saveWhatsAppTemplateFn',
      { timeout: 120_000 },
    );
    const result = await fn(input);
    return result.data;
  } catch (err) {
    throw callableError(err, 'Could not save the WhatsApp template.');
  }
}

export async function deleteWhatsAppTemplate(id: string, name: string): Promise<void> {
  try {
    const fn = httpsCallable<{ id: string; name: string }, { ok: boolean }>(
      functions,
      'deleteWhatsAppTemplateFn',
      { timeout: 60_000 },
    );
    await fn({ id, name });
  } catch (err) {
    throw callableError(err, 'Could not delete the WhatsApp template.');
  }
}
