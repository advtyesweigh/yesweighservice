import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
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

export async function sendWhatsAppText(waId: string, text: string): Promise<void> {
  try {
    const fn = httpsCallable<{ waId: string; text: string }, { ok: boolean }>(
      functions,
      'sendWhatsAppCloudMessage',
      { timeout: 60_000 },
    );
    await fn({ waId, text });
  } catch (err) {
    throw callableError(err, 'Could not send the message.');
  }
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
      { timeout: 120_000 },
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
      };
    }));
  }, err => onError(err));
}

export async function markWhatsAppConversationRead(id: string): Promise<void> {
  await updateDoc(doc(db, WHATSAPP_CONVERSATIONS, id), { unreadCount: 0 });
}
