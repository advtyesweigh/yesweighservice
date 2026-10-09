import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AppWindow,
  Briefcase,
  Camera,
  Check,
  CheckCheck,
  ChevronLeft,
  CircleCheck,
  DoorOpen,
  FileText,
  Film,
  Image as ImageIcon,
  Landmark,
  LayoutTemplate,
  MessageCircle,
  Mic,
  Paperclip,
  Phone,
  Search,
  Send,
  SlidersHorizontal,
  Smile,
  User,
  UserCheck,
  UserPlus,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { FIRM_PHONE } from '../../constants/brand';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';
import { YESWEIGH_BANK_DETAILS } from '../../lib/whatsappBank';
import { useAuth } from '../../context/AuthContext';
import { useTopBarAction } from '../../context/PageHeaderContext';
import { findDealersByPhoneNeedle } from '../../lib/dealers';
import { canSuperAdminWrite } from '../../lib/staffAccess';
import {
  assignWhatsAppConversation,
  chatListPhone,
  chatPace,
  conversationLastKind,
  conversationNeedsStaffReply,
  conversationPreviewLabel,
  formatInboxCustomerElapsed,
  formatWaListTime,
  formatWhatsAppNumber,
  formatWhatsAppUnread,
  loadWhatsAppSettings,
  markWhatsAppConversationRead,
  ensureWhatsAppVoiceMalayalamAudio,
  ensureWhatsAppVoiceMalayalamText,
  parseSoftwareShopIdFromText,
  retryWhatsAppTranscription,
  sendWhatsAppFile,
  sendWhatsAppText,
  setWhatsAppConversationClosed,
  setWhatsAppOutboundLanguage,
  setWhatsAppVoiceTranslate,
  softwareShopIdFromChat,
  subscribeWhatsAppAssignees,
  subscribeWhatsAppConversations,
  subscribeWhatsAppMessages,
  subscribeWhatsAppVoiceTranslate,
  whatsAppSessionOpen,
  type WhatsAppAssignee,
  type WhatsAppChatMessage,
  type WhatsAppConversation,
  type WhatsAppSettings,
} from '../../lib/whatsappInbox';
import {
  OUTBOUND_VOICE_LANGUAGE_OPTIONS,
  normalizeOutboundVoiceLanguageValue,
  outboundVoiceLanguageLabel,
} from '../../lib/outboundVoiceLanguages';
import { lookupSoftwareShopById } from '../../lib/softwareShops';
import { WhatsAppTemplatesPanel } from './WhatsAppTemplatesPanel';
import '../../whatsapp-inbox.css';

type WaTile = 'open' | 'unassigned' | 'assigned' | 'service' | 'all';
type WaBoard = 'all' | 'leads' | 'customers' | 'service';
type WaDate = 'all' | '24h' | 'today' | 'yesterday' | 'month' | 'custom';
type WaKind = 'all' | 'unread' | 'open' | 'no-reply';

type WaFilters = {
  date: WaDate;
  customDate: string;
  kind: WaKind;
};

const DEFAULT_WA_FILTERS: WaFilters = { date: 'all', customDate: '', kind: 'all' };

const COMPOSER_EMOJIS = [
  '😀', '😁', '😂', '😊', '😍', '😘', '😜', '🤔', '😮', '😢',
  '😭', '😡', '👍', '👎', '🙏', '👏', '🔥', '✅', '❤️', '🎉',
  '📌', '📞', '📍', '📄', '📸', '🎥',
];

function sameDay(left: Date, right: Date): boolean {
  return left.toDateString() === right.toDateString();
}

function matchesDate(ms: number, filters: WaFilters, now: number): boolean {
  if (filters.date === 'all') return true;
  if (!ms) return false;
  if (filters.date === '24h') return now - ms <= 24 * 60 * 60 * 1000;
  const at = new Date(ms);
  const today = new Date(now);
  if (filters.date === 'today') return sameDay(at, today);
  if (filters.date === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return sameDay(at, yesterday);
  }
  if (filters.date === 'month') {
    return at.getMonth() === today.getMonth() && at.getFullYear() === today.getFullYear();
  }
  return Boolean(filters.customDate) && at.toISOString().slice(0, 10) === filters.customDate;
}

function matchesKind(chat: WhatsAppConversation, kind: WaKind, now: number): boolean {
  if (kind === 'all') return true;
  if (kind === 'unread') return chat.unreadCount > 0 || conversationNeedsStaffReply(chat);
  if (kind === 'open') return whatsAppSessionOpen(chat.lastInboundAtMs, now);
  return conversationNeedsStaffReply(chat);
}

function matchesTile(chat: WhatsAppConversation, tile: WaTile, now: number, uid: string): boolean {
  if (tile === 'all') return true;
  if (tile === 'unassigned') return !chat.assignedToUid && !chat.assignedToName;
  if (tile === 'assigned') return Boolean(uid) && chat.assignedToUid === uid;
  if (tile === 'open') return whatsAppSessionOpen(chat.lastInboundAtMs, now) && !chat.closed;
  return false;
}

function matchesBoard(board: WaBoard): boolean {
  return board === 'all';
}

function clock(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function pickVoiceMimeType(): { mimeType: string; extension: string } {
  const options: Array<{ mimeType: string; extension: string }> = [
    { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
    { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
    { mimeType: 'audio/webm', extension: 'webm' },
    { mimeType: 'audio/mp4', extension: 'm4a' },
  ];
  const match = options.find(item => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(item.mimeType));
  return match ?? { mimeType: '', extension: 'webm' };
}

function LastMessagePreview({ item }: { item: WhatsAppConversation }) {
  const kind = conversationLastKind(item);
  const label = conversationPreviewLabel(item);
  const thumb = item.lastMediaUrl;
  const fallback = formatWhatsAppNumber(item.waId);

  if (!label && kind === 'text') {
    return <span className="wa-inbox__preview">{fallback}</span>;
  }

  if (kind === 'image') {
    return (
      <span className="wa-inbox__preview">
        {thumb ? (
          <img className="wa-inbox__thumb" src={thumb} alt="" />
        ) : (
          <Camera size={14} strokeWidth={2.25} className="wa-inbox__preview-icon" />
        )}
        <span>{label}</span>
      </span>
    );
  }

  if (kind === 'video' || kind === 'audio' || kind === 'file') {
    const Icon = kind === 'video' ? Film : kind === 'audio' ? Mic : FileText;
    return (
      <span className="wa-inbox__preview">
        <Icon size={14} strokeWidth={2.25} className="wa-inbox__preview-icon" />
        <span>{label}</span>
      </span>
    );
  }

  return <span className="wa-inbox__preview">{label || fallback}</span>;
}

function WaAvatar({ src, name, size = 40 }: { src: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [src]);
  const letter = name.trim().match(/^\p{L}/u)?.[0]?.toUpperCase() ?? '';
  return (
    <span className="wa-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} />
      ) : letter ? (
        letter
      ) : (
        <User size={Math.round(size * 0.48)} />
      )}
    </span>
  );
}

function TranslatedLines({ message }: { message: WhatsAppChatMessage }) {
  const original = message.text.trim();
  const translated = message.translatedText.trim();
  if (!original && !translated) return null;
  if (translated && translated !== original) {
    return (
      <div className="wa-text-translated">
        {message.messageLanguageName ? <span className="wa-lang-tag">{message.messageLanguageName}</span> : null}
        <p className="wa-original">{original}</p>
        <span className="wa-lang-tag">
          {message.direction === 'outbound'
            ? (message.translationTargetName || message.messageLanguageName || 'Translated')
            : 'Malayalam'}
        </span>
        <p>{translated}</p>
      </div>
    );
  }
  return original ? <p>{original}</p> : null;
}

function VoiceNoteExtras({ message }: { message: WhatsAppChatMessage }) {
  const inbound = message.direction === 'inbound';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mlText, setMlText] = useState(message.malayalamText);
  const [mlAudio, setMlAudio] = useState(message.malayalamAudioUrl);
  const transcript = message.transcript.trim();
  const requestedRef = useRef(false);

  useEffect(() => {
    setMlText(message.malayalamText);
    setMlAudio(message.malayalamAudioUrl);
    if (message.malayalamText) requestedRef.current = false;
  }, [message.id, message.malayalamAudioUrl, message.malayalamText]);

  const voiceBusy = /pending|processing/i.test(message.voiceTranslateStatus)
    || /pending|processing/i.test(message.transcriptionStatus);

  useEffect(() => {
    if (!inbound || mlText || requestedRef.current || busy || voiceBusy) return;
    if (!message.id) return;
    requestedRef.current = true;
    setBusy(true);
    setError('');
    void ensureWhatsAppVoiceMalayalamText(message.id)
      .then(result => {
        if (result.malayalamText) setMlText(result.malayalamText);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Could not transcribe this voice note.');
        requestedRef.current = false;
      })
      .finally(() => setBusy(false));
  }, [busy, inbound, message.id, mlText, voiceBusy]);

  const playMalayalam = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await ensureWhatsAppVoiceMalayalamAudio(message.id);
      if (result.mediaUrl) setMlAudio(result.mediaUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not play Malayalam voice.');
    } finally {
      setBusy(false);
    }
  };

  const original = transcript && transcript !== mlText ? transcript : '';
  const outboundVoice = !inbound && message.translationKind === 'voice-translate-outbound';

  return (
    <div className="wa-media-wrap--translated">
      {original || mlText || (outboundVoice && message.translatedText) ? (
        <div className="wa-text-translated">
          {original ? (
            <>
              {message.messageLanguageName ? <span className="wa-lang-tag">{message.messageLanguageName}</span> : null}
              <p className="wa-voice-ml-text">{original}</p>
            </>
          ) : null}
          {mlText ? (
            <>
              <span className="wa-lang-tag">Malayalam</span>
              <p className="wa-voice-ml-text">{mlText}</p>
            </>
          ) : null}
          {outboundVoice && message.translatedText && message.translatedText !== mlText ? (
            <>
              <span className="wa-lang-tag">{message.translationTargetName || message.messageLanguageName || 'Translated'}</span>
              <p className="wa-voice-ml-text">{message.translatedText}</p>
            </>
          ) : null}
        </div>
      ) : null}
      {mlAudio ? (
        <div className="wa-voice-ml">
          <span className="wa-lang-tag">Malayalam voice</span>
          <audio src={mlAudio} controls className="wa-inbox-bubble__audio" />
        </div>
      ) : null}
      {voiceBusy ? <p className="wa-transcript-status">Voice translating…</p> : null}
      {!mlText && busy ? <p className="wa-transcript-status">Transcribing Malayalam…</p> : null}
      {error || message.voiceTranslateError ? (
        <p className="wa-transcript-status">{error || message.voiceTranslateError}</p>
      ) : null}
      <div className="wa-voice-actions">
        {inbound && mlText && !mlAudio && !voiceBusy ? (
          <button type="button" className="wa-media-retry" onClick={() => void playMalayalam()} disabled={busy}>
            {busy ? 'Working…' : 'Play Malayalam'}
          </button>
        ) : null}
        {/failed/i.test(message.transcriptionStatus) || /failed/i.test(message.voiceTranslateStatus) ? (
          <button
            type="button"
            className="wa-media-retry"
            onClick={() => void retryWhatsAppTranscription(message.id)}
            disabled={busy}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MessageBody({
  message,
  onOpenImage,
}: {
  message: WhatsAppChatMessage;
  onOpenImage: (url: string) => void;
}) {
  const url = message.mediaUrl;
  if (message.type === 'image' && url) {
    return (
      <>
        <button type="button" className="wa-inbox-bubble__image-btn" onClick={() => onOpenImage(url)}>
          <img src={url} alt="" className="wa-inbox-bubble__image" />
        </button>
        <TranslatedLines message={message} />
      </>
    );
  }
  if (message.type === 'video' && url) {
    return (
      <>
        <video src={url} controls className="wa-inbox-bubble__video" />
        <TranslatedLines message={message} />
      </>
    );
  }
  if ((message.type === 'audio' || message.type === 'voice' || message.type === 'ptt') && url) {
    const outboundVoice = message.direction === 'outbound'
      && message.translationKind === 'voice-translate-outbound'
      && message.translatedMediaUrl;
    const playUrl = outboundVoice || url;
    return (
      <>
        <audio src={playUrl} controls className="wa-inbox-bubble__audio" />
        <VoiceNoteExtras message={message} />
      </>
    );
  }
  if ((message.type === 'document' || message.type === 'sticker') && url) {
    return (
      <>
        <a href={url} target="_blank" rel="noreferrer" className="wa-inbox-bubble__file">
          {message.fileName || message.text || 'Document'}
        </a>
        <TranslatedLines message={message} />
      </>
    );
  }
  return <TranslatedLines message={message} />;
}

function StatusTick({ status }: { status: string }) {
  if (status === 'read') return <CheckCheck size={14} className="wa-inbox-tick is-read" />;
  if (status === 'delivered') return <CheckCheck size={14} className="wa-inbox-tick" />;
  if (status === 'failed') return <span className="wa-inbox-tick is-failed">Failed</span>;
  return <Check size={14} className="wa-inbox-tick" />;
}

function chatSearchNeedle(waId: string): string {
  const digits = String(waId || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function shopIdFromMessages(items: WhatsAppChatMessage[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const shopId = parseSoftwareShopIdFromText(items[index].text);
    if (shopId) return shopId;
  }
  return 0;
}

function chatDisplayName(
  chat: WhatsAppConversation,
  shopNames: Record<number, string>,
  extraShopId = 0,
): string {
  const shopId = extraShopId || softwareShopIdFromChat(chat);
  const shopName = (shopId && shopNames[shopId]) || chat.softwareShopName || '';
  if (shopName && shopId) return `${shopName} · ${shopId}`;
  if (shopName) return shopName;
  if (shopId) return `Shop ${shopId}`;
  return chat.senderName || formatWhatsAppNumber(chat.waId);
}

export const WhatsAppInboxPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [settings, setSettings] = useState<WhatsAppSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const [chats, setChats] = useState<WhatsAppConversation[]>([]);
  const [chatError, setChatError] = useState('');
  const [queryText, setQueryText] = useState('');
  const [tile, setTile] = useState<WaTile>('open');
  const [board, setBoard] = useState<WaBoard>('all');
  const [filters, setFilters] = useState<WaFilters>(DEFAULT_WA_FILTERS);
  const [draftFilters, setDraftFilters] = useState<WaFilters>(DEFAULT_WA_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [numberFilter, setNumberFilter] = useState('all');
  const [now, setNow] = useState(() => Date.now());
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<WhatsAppChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignees, setAssignees] = useState<WhatsAppAssignee[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const documentRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const [shopNameById, setShopNameById] = useState<Record<number, string>>({});
  const shopNameByIdRef = useRef<Record<number, string>>({});

  const { user } = useAuth();
  const uid = user?.uid || '';
  const [voiceTranslate, setVoiceTranslate] = useState(false);
  const [voiceTranslateSaving, setVoiceTranslateSaving] = useState(false);
  const [outboundLangLocal, setOutboundLangLocal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadWhatsAppSettings()
      .then(next => {
        if (cancelled) return;
        setSettings(next);
      })
      .catch(err => {
        if (!cancelled) setSettingsError(err instanceof Error ? err.message : 'Could not load WhatsApp.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settings?.configured) return undefined;
    return subscribeWhatsAppConversations(setChats, err => setChatError(err.message));
  }, [settings?.configured]);

  useEffect(() => {
    if (!settings?.configured) return undefined;
    return subscribeWhatsAppAssignees(setAssignees, () => undefined);
  }, [settings?.configured]);

  useEffect(() => {
    if (!settings?.configured) return undefined;
    return subscribeWhatsAppVoiceTranslate(setVoiceTranslate);
  }, [settings?.configured]);

  const active = chats.find(chat => chat.id === activeId) ?? null;

  useEffect(() => {
    setOutboundLangLocal(null);
  }, [activeId]);

  useEffect(() => {
    const wanted = searchParams.get('chat')?.replace(/\D/g, '') || '';
    if (!wanted || !chats.length) return;
    const match = chats.find(chat => {
      const idDigits = String(chat.id || '').replace(/\D/g, '');
      const waDigits = String(chat.waId || '').replace(/\D/g, '');
      return chat.id === wanted
        || chat.waId === wanted
        || idDigits === wanted
        || waDigits === wanted
        || (wanted.length >= 10 && (idDigits.endsWith(wanted) || waDigits.endsWith(wanted)));
    });
    if (match) setActiveId(match.id);
  }, [chats, searchParams]);

  useEffect(() => {
    if (!active) {
      setMessages([]);
      return undefined;
    }
    return subscribeWhatsAppMessages(active.waId, setMessages, err => setChatError(err.message));
  }, [active?.waId]);

  useEffect(() => {
    shopNameByIdRef.current = shopNameById;
  }, [shopNameById]);

  useEffect(() => {
    const ids = new Set<number>();
    const seeded: Record<number, string> = {};
    for (const chat of chats) {
      const shopId = softwareShopIdFromChat(chat);
      if (!shopId) continue;
      ids.add(shopId);
      if (chat.softwareShopName) seeded[shopId] = chat.softwareShopName;
    }
    for (const message of messages) {
      const shopId = parseSoftwareShopIdFromText(message.text);
      if (shopId) ids.add(shopId);
    }
    if (Object.keys(seeded).length) {
      setShopNameById(current => {
        let changed = false;
        const next = { ...current };
        for (const [id, name] of Object.entries(seeded)) {
          const shopId = Number(id);
          if (next[shopId]) continue;
          next[shopId] = name;
          changed = true;
        }
        return changed ? next : current;
      });
    }
    const missing = [...ids].filter(id => !seeded[id] && !shopNameByIdRef.current[id]);
    if (!missing.length) return undefined;
    let cancelled = false;
    void Promise.all(missing.map(async (shopId) => {
      const shop = await lookupSoftwareShopById(shopId);
      return [shopId, shop?.name || `Shop ${shopId}`] as const;
    })).then((rows) => {
      if (cancelled) return;
      setShopNameById(current => {
        const next = { ...current };
        for (const [shopId, name] of rows) next[shopId] = name;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [chats, messages]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!filtersOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filtersOpen]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, activeId]);

  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview('');
      return undefined;
    }
    if (!pendingFile.type.startsWith('image/') && !pendingFile.type.startsWith('video/')) {
      setPendingPreview('');
      return undefined;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [draft]);

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
      })
      .catch(() => {
        if (!cancelled) setCameraError('Camera is not available.');
      });
    return () => {
      cancelled = true;
      cameraStreamRef.current?.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
    };
  }, [cameraOpen]);

  const activeShopId = active ? softwareShopIdFromChat(active) || shopIdFromMessages(messages) : 0;
  const activeName = active ? chatDisplayName(active, shopNameById, activeShopId) : '';

  const searched = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    return chats.filter(chat => {
      if (!matchesDate(chat.lastAtMs, filters, now)) return false;
      if (!matchesKind(chat, filters.kind, now)) return false;
      if (!needle) return true;
      const shopId = softwareShopIdFromChat(chat);
      const shopName = shopId ? shopNameById[shopId] || chat.softwareShopName : chat.softwareShopName;
      const hay = `${chat.senderName} ${shopName} ${shopId || ''} ${chat.waId} ${chat.lastText} ${chat.assignedToName}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [chats, filters, now, queryText, shopNameById]);

  const tileCounts = useMemo(() => ({
    open: searched.filter(chat => whatsAppSessionOpen(chat.lastInboundAtMs, now) && !chat.closed).length,
    unassigned: searched.filter(chat => !chat.assignedToUid && !chat.assignedToName).length,
    assigned: searched.filter(chat => uid && chat.assignedToUid === uid).length,
    service: 0,
    all: searched.length,
  }), [now, searched, uid]);

  const visibleChats = useMemo(
    () => searched.filter(chat => matchesBoard(board) && matchesTile(chat, tile, now, uid)),
    [board, now, searched, tile, uid],
  );

  const sessionOpen = active ? whatsAppSessionOpen(active.lastInboundAtMs) : false;
  const canWriteTemplates = canSuperAdminWrite(user);
  const filtersDiffer = filters.date !== 'all' || filters.kind !== 'all';
  const headerActions = useMemo(() => (
    templatesOpen ? (
      <button
        type="button"
        className="top-bar__action-btn top-bar__action-btn--icon"
        aria-label="Close templates"
        title="Close templates"
        onClick={() => setTemplatesOpen(false)}
      >
        <X size={18} />
      </button>
    ) : (
      <button
        type="button"
        className={`wa-filter-btn${filtersDiffer ? ' is-on' : ''}`}
        aria-label="Filter chats"
        onClick={() => {
          setDraftFilters(filters);
          setFiltersOpen(true);
        }}
      >
        <SlidersHorizontal size={18} />
      </button>
    )
  ), [filters, filtersDiffer, templatesOpen]);
  useTopBarAction(headerActions, Boolean(settings?.configured));

  const closePanels = () => {
    setEmojiOpen(false);
    setAttachOpen(false);
    setAssignOpen(false);
  };

  const openChat = (chat: WhatsAppConversation) => {
    setActiveId(chat.id);
    setSendError('');
    closePanels();
    setPendingFile(null);
    if (chat.unreadCount > 0) {
      void markWhatsAppConversationRead(chat.id).catch(() => undefined);
    }
  };

  const attachPickedFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setSendError('File must be under 8 MB.');
      return;
    }
    setPendingFile(file);
    setAttachOpen(false);
    setCameraOpen(false);
    setSendError('');
  };

  const sendFile = async (file: File, caption = '') => {
    if (!active) return;
    const fileBase64 = await fileToBase64(file);
    await sendWhatsAppFile({
      waId: active.waId,
      fileBase64,
      mimeType: file.type || 'application/octet-stream',
      fileName: file.name,
      caption,
    });
  };

  const onSend = async () => {
    if (!active || sending) return;
    const text = draft.trim();
    if (!text && !pendingFile && !recording) return;
    setSending(true);
    setSendError('');
    try {
      if (pendingFile) {
        await sendFile(pendingFile, text);
        setPendingFile(null);
        setDraft('');
      } else {
        await sendWhatsAppText(active.waId, text, {
          outboundVoiceLanguage: normalizeOutboundVoiceLanguageValue(active.outboundVoiceLanguage),
          outboundVoiceLanguageName: outboundVoiceLanguageLabel(active.outboundVoiceLanguage),
        });
        setDraft('');
      }
      closePanels();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const insertEmoji = (emoji: string) => {
    setDraft(current => `${current}${emoji}`);
  };

  const takeLivePhoto = () => {
    const video = cameraVideoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      setPendingFile(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      setCameraOpen(false);
      setAttachOpen(false);
    }, 'image/jpeg', 0.92);
  };

  const stopRecording = (keep: boolean, sendNow = false) => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setRecordSeconds(0);
    if (!recorder) return;
    recorder.onstop = () => {
      recorder.stream.getTracks().forEach(track => track.stop());
      if (!keep) {
        recordChunksRef.current = [];
        return;
      }
      const { mimeType, extension } = pickVoiceMimeType();
      const blob = new Blob(recordChunksRef.current, { type: mimeType || 'audio/webm' });
      recordChunksRef.current = [];
      const file = new File([blob], `voice-note.${extension}`, { type: blob.type || mimeType });
      if (sendNow) {
        void (async () => {
          setSending(true);
          try {
            await sendFile(file);
          } catch (err) {
            setSendError(err instanceof Error ? err.message : 'Could not send the voice note.');
          } finally {
            setSending(false);
          }
        })();
        return;
      }
      setPendingFile(file);
    };
    if (recorder.state !== 'inactive') recorder.stop();
  };

  const startRecording = async () => {
    if (recording) {
      stopRecording(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { mimeType } = pickVoiceMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordChunksRef.current = [];
      recorder.ondataavailable = event => {
        if (event.data.size) recordChunksRef.current.push(event.data);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => setRecordSeconds(value => value + 1), 1000);
    } catch {
      setSendError('Microphone is not available.');
    }
  };

  const assignChat = async (person: WhatsAppAssignee) => {
    if (!active) return;
    try {
      await assignWhatsAppConversation(active.id, person);
      setAssignOpen(false);
      setAttachOpen(true);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not assign this chat.');
    }
  };

  const toggleClosed = async () => {
    if (!active) return;
    try {
      await setWhatsAppConversationClosed(active.id, !active.closed);
      setAttachOpen(false);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not update this chat.');
    }
  };

  const openFromAttach = (path: string) => {
    closePanels();
    navigate(path);
  };

  const openServiceBooking = async () => {
    if (!active || serviceBusy) return;
    const waId = active.waId;
    const needle = chatSearchNeedle(waId);
    closePanels();
    setSendError('');
    setServiceBusy(true);
    try {
      const matches = needle ? await findDealersByPhoneNeedle(needle) : [];
      const matched = matches.length === 1 ? matches[0] : null;
      navigate(`/super-admin/warranty-support?wa=${encodeURIComponent(waId)}`, {
        state: {
          openWizard: true,
          intent: 'service' as const,
          dealerQuery: needle,
          dealerLookupStatus: matches.length === 0 ? 'none' : matches.length > 1 ? 'multiple' : 'matched',
          onBehalfDealer: matched
            ? {
                zohoCustomerId: matched.id,
                dealerName: matched.companyName?.trim() || matched.contactName?.trim() || 'Dealer',
                portalUserId: matched.portalUserId,
              }
            : undefined,
        },
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not look up this number.');
    } finally {
      setServiceBusy(false);
    }
  };

  const insertComposerBlock = (block: string) => {
    const text = block.trim();
    if (!text) return;
    setDraft(current => (current.trim() ? `${current.trim()}\n${text}` : text));
    closePanels();
  };

  const showMic = sessionOpen && !draft.trim() && !pendingFile && !recording;
  const canSend = Boolean(active && !sending && (draft.trim() || pendingFile || recording));

  if (!settings && !settingsError) {
    return (
      <div className="wa-inbox-page wa-inbox-page--setup">
        <p className="wa-inbox-note">Loading WhatsApp…</p>
      </div>
    );
  }

  if (!settings?.configured) {
    return (
      <div className="wa-inbox-page wa-inbox-page--setup">
        <p className="wa-inbox-note">{settingsError || 'WhatsApp is not connected.'}</p>
        <Link to="/super-admin/settings/integration?section=whatsapp">Open Integration settings</Link>
      </div>
    );
  }

  if (templatesOpen) {
    return (
      <div className="wa-inbox-page wa-inbox-page--templates">
        <WhatsAppTemplatesPanel canWrite={canWriteTemplates} />
      </div>
    );
  }

  return (
    <div className={`wa-inbox-page${active ? ' has-chat' : ''}`}>
      <aside className="wa-inbox-list" aria-label="Conversations">
        <section className="wa-tile-grid" aria-label="WhatsApp summary">
          {([
            ['open', 'Open', tileCounts.open, <MessageCircle size={15} />, 'peach'],
            ['unassigned', 'Unassigned', tileCounts.unassigned, <User size={15} />, 'sky'],
            ['assigned', 'Assigned', tileCounts.assigned, <Users size={15} />, 'green'],
            ['service', 'Service', tileCounts.service, <Wrench size={15} />, 'rose'],
            ['all', 'Total', tileCounts.all, <Briefcase size={15} />, 'slate'],
          ] as const).map(([id, label, count, icon, tone]) => (
            <button
              key={id}
              type="button"
              className={`wa-tile wa-tile--${tone}${tile === id ? ' is-active' : ''}`}
              onClick={() => setTile(current => (current === id ? 'all' : id))}
            >
              <span className="wa-tile__icon">{icon}</span>
              <strong>{count}</strong>
              <span>{label}</span>
            </button>
          ))}
        </section>
        <div className="wa-board-tabs" role="tablist" aria-label="Inbox">
          {([
            ['all', 'All', <MessageCircle size={14} key="all" />, searched.length],
            ['leads', 'Leads', <UserPlus size={14} key="leads" />, 0],
            ['customers', 'Customers', <Users size={14} key="customers" />, 0],
            ['service', 'Service', <Wrench size={14} key="service" />, 0],
          ] as const).map(([id, label, icon, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={board === id}
              className={`wa-board-tab${board === id ? ' is-active' : ''}`}
              onClick={() => setBoard(id)}
            >
              {icon}
              {label}
              <span className="wa-board-tab__count">{count}</span>
            </button>
          ))}
        </div>
        <label className="wa-list-search">
          <Search size={16} />
          <input
            value={queryText}
            onChange={event => setQueryText(event.target.value)}
            placeholder="Search name, number, message..."
            aria-label="Search chats"
          />
        </label>
        <div className="wa-inbox-list__rows">
          {visibleChats.length === 0 ? (
            <p className="wa-inbox-empty">
              {board === 'leads'
                ? 'No new leads.'
                : board === 'customers'
                  ? 'No customer chats.'
                  : board === 'service' || tile === 'service'
                    ? 'No service chats.'
                    : tile === 'assigned'
                      ? 'No chats assigned to you.'
                      : tile === 'unassigned'
                        ? 'No unassigned chats.'
                        : tile === 'open'
                          ? 'No chats inside the 24-hour window.'
                          : chats.length === 0
                            ? 'No chats yet. Messages to this number will show up here.'
                            : 'No chats match these filters.'}
            </p>
          ) : visibleChats.map(chat => {
            const unread = chat.unreadCount;
            const unreplied = conversationNeedsStaffReply(chat);
            const received = unreplied ? Math.max(unread, 1) : unread;
            const pace = chatPace(chat, now);
            const elapsedLabel = formatInboxCustomerElapsed(chat, now);
            const phone = chatListPhone(chat.waId);
            const name = chatDisplayName(chat, shopNameById);
            return (
              <div
                key={chat.id}
                role="button"
                tabIndex={0}
                className={`wa-inbox__item wa-inbox__item--${pace}${chat.id === activeId ? ' is-active' : ''}${unread ? ' has-unread' : ''}${unreplied ? ' is-unreplied' : ''}${pace === 'waiting' || pace === 'overdue' ? ' is-awaiting-reply' : ''}`}
                onClick={() => openChat(chat)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  openChat(chat);
                }}
              >
                <span className="wa-inbox__meta">
                  <span className="wa-inbox__line wa-inbox__line--name">
                    <strong>{name}</strong>
                    <span className="wa-inbox__time-col">
                      <span className={`wa-inbox__time${unread ? ' is-unread' : ''}`}>{formatWaListTime(chat.lastAtMs)}</span>
                      {elapsedLabel ? (
                        <span className="wa-inbox__waiting" title="Time since the customer's last message">
                          {elapsedLabel}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {phone ? (
                    <span className="wa-inbox__line wa-inbox__line--phone">
                      <span className="wa-inbox__phone">
                        <a
                          className="wa-inbox__call"
                          href={phone.tel}
                          aria-label={`Call ${phone.label}`}
                          title="Call"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          <Phone size={13} strokeWidth={2.25} />
                        </a>
                        <span className="wa-inbox__number">{phone.label}</span>
                        <a
                          className="wa-inbox__personal"
                          href={phone.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Message ${phone.label} on personal WhatsApp`}
                          title="Open in WhatsApp"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          <WhatsAppIcon size={17} />
                        </a>
                      </span>
                    </span>
                  ) : null}
                  <span className="wa-inbox__sub">
                    <LastMessagePreview item={chat} />
                    {received > 0 && unreplied ? (
                      <span className="wa-unread" aria-label={`${received} messages received`}>{formatWhatsAppUnread(received)}</span>
                    ) : unread > 0 ? (
                      <span className="wa-unread" aria-label={`${unread} unread`}>{formatWhatsAppUnread(unread)}</span>
                    ) : null}
                  </span>
                  <span className="wa-inbox__line wa-inbox__line--foot">
                    <span className="wa-chat-owner">{chat.assignedToName || 'Unassigned'}</span>
                    <span className="wa-inbox__stage">{chat.closed ? 'Closed' : ''}</span>
                    <span className="wa-chat-account">YesWeigh</span>
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        {chatError ? <p className="wa-inbox-error">{chatError}</p> : null}
      </aside>
      <section className="wa-inbox-thread">
        {active ? (
          <>
            <header className="wa-inbox__thread-head">
              <div className="wa-inbox__thread-row">
                <button type="button" className="wa-back" onClick={() => setActiveId('')} aria-label="Back to chats">
                  <ChevronLeft size={22} />
                </button>
                <WaAvatar
                  src={active.profileImage}
                  name={activeName}
                />
                <div className="wa-inbox__thread-copy">
                  <h3>{formatWhatsAppNumber(active.waId)}</h3>
                  <div className="wa-inbox__thread-name-row">
                    <div className="wa-inbox__thread-identity">
                      {activeName && activeName !== formatWhatsAppNumber(active.waId) ? (
                        <p className="wa-inbox__thread-name">{activeName}</p>
                      ) : null}
                      <p className="wa-inbox__thread-assignee">{active.assignedToName || 'Unassigned'}</p>
                    </div>
                    <label className="wa-outbound-lang" title="Customer language">
                      <select
                        className="wa-outbound-lang__select"
                        value={outboundLangLocal ?? normalizeOutboundVoiceLanguageValue(active.outboundVoiceLanguage)}
                        disabled={sending}
                        aria-label="Customer language"
                        onChange={event => {
                          const value = event.target.value;
                          const previous = outboundLangLocal
                            ?? normalizeOutboundVoiceLanguageValue(active.outboundVoiceLanguage);
                          setOutboundLangLocal(value);
                          setSendError('');
                          void setWhatsAppOutboundLanguage(
                            active.id,
                            value,
                            outboundVoiceLanguageLabel(value),
                          ).catch(err => {
                            setOutboundLangLocal(previous);
                            setSendError(err instanceof Error ? err.message : 'Could not save language.');
                          });
                        }}
                      >
                        {OUTBOUND_VOICE_LANGUAGE_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.value === 'auto' ? 'Auto detect' : option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label
                      className="wa-voice-translate-toggle"
                      title="Voice translate: transcribe voice notes and speak them in Malayalam"
                    >
                      <input
                        type="checkbox"
                        checked={voiceTranslate}
                        disabled={voiceTranslateSaving}
                        onChange={event => {
                          const next = event.target.checked;
                          setVoiceTranslate(next);
                          setVoiceTranslateSaving(true);
                          setSendError('');
                          void setWhatsAppVoiceTranslate(next)
                            .catch(err => {
                              setVoiceTranslate(!next);
                              setSendError(err instanceof Error ? err.message : 'Could not save Voice translate.');
                            })
                            .finally(() => setVoiceTranslateSaving(false));
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </header>
            <div className="wa-inbox-thread__messages" ref={threadRef}>
              {messages.map(message => (
                <article
                  key={message.id}
                  className={`wa-inbox-bubble wa-inbox-bubble--${message.direction}`}
                >
                  <MessageBody message={message} onOpenImage={setLightboxUrl} />
                  <footer>
                    <time>{clock(message.createdAtMs)}</time>
                    {message.direction === 'outbound' ? <StatusTick status={message.status} /> : null}
                  </footer>
                </article>
              ))}
            </div>
            {pendingFile ? (
              <div className="wa-attach-preview">
                {pendingFile.type.startsWith('image/') && pendingPreview ? (
                  <img src={pendingPreview} alt="" />
                ) : pendingFile.type.startsWith('video/') && pendingPreview ? (
                  <video src={pendingPreview} muted />
                ) : (
                  <FileText size={20} />
                )}
                <span>{pendingFile.name}</span>
                <button type="button" onClick={() => setPendingFile(null)} aria-label="Remove attachment">
                  <X size={16} />
                </button>
              </div>
            ) : null}
            {emojiOpen && !recording ? (
              <div className="wa-emoji-panel" role="listbox" aria-label="Emoji">
                {COMPOSER_EMOJIS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => insertEmoji(emoji)}
                    disabled={sending}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            {attachOpen && !recording ? (
              <div className="wa-attach-sheet" role="menu" aria-label="Attach">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const shopId = activeShopId;
                    const query = shopId ? String(shopId) : chatSearchNeedle(active.waId);
                    const params = new URLSearchParams({ wa: active.waId });
                    if (query) params.set('q', query);
                    openFromAttach(`/super-admin/software?${params.toString()}`);
                  }}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--software"><AppWindow size={22} /></span>
                  Software
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openFromAttach(`/super-admin/sales-orders/new?wa=${encodeURIComponent(active.waId)}`)}
                  disabled={sending}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--quotation" aria-hidden>
                    <span style={{ fontSize: '1.2rem', fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1 }}>₹</span>
                  </span>
                  Sales order
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => insertComposerBlock(YESWEIGH_BANK_DETAILS)}
                  disabled={sending}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--bank" aria-hidden>
                    <Landmark size={22} color="#ffffff" strokeWidth={2} />
                  </span>
                  Bank
                </button>
                <button type="button" role="menuitem" onClick={() => documentRef.current?.click()} disabled={sending}>
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--document"><FileText size={22} /></span>
                  Document
                </button>
                <button type="button" role="menuitem" onClick={() => videoRef.current?.click()} disabled={sending}>
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--video"><Film size={22} /></span>
                  Video
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAssignOpen(true);
                    setAttachOpen(false);
                    setEmojiOpen(false);
                  }}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--assign"><UserCheck size={22} /></span>
                  Assign
                </button>
                <button type="button" role="menuitem" onClick={() => void toggleClosed()}>
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--close">
                    {active.closed ? <DoorOpen size={22} /> : <CircleCheck size={22} />}
                  </span>
                  {active.closed ? 'Open' : 'Close'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void openServiceBooking()}
                  disabled={serviceBusy}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--service"><Wrench size={22} /></span>
                  {serviceBusy ? 'Looking up…' : 'Service'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closePanels();
                    setTemplatesOpen(true);
                  }}
                >
                  <span className="wa-attach-sheet__icon wa-attach-sheet__icon--template"><LayoutTemplate size={22} /></span>
                  Template
                </button>
              </div>
            ) : null}
            {assignOpen ? (
              <div className="wa-assign-sheet" role="menu" aria-label="Assign chat">
                <div className="wa-assign-sheet__head">
                  <strong>Assign</strong>
                  <button type="button" onClick={() => setAssignOpen(false)} aria-label="Close">
                    <X size={16} />
                  </button>
                </div>
                <div className="wa-assign-sheet__list">
                  {assignees.length === 0 ? (
                    <p className="text-muted text-sm">No users to assign.</p>
                  ) : assignees.map(person => (
                    <button
                      key={person.uid}
                      type="button"
                      role="menuitem"
                      className="wa-assign-sheet__row"
                      onClick={() => void assignChat(person)}
                    >
                      <User size={18} />
                      <span>{person.displayName}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {sessionOpen ? (
              <form
                className="wa-composer"
                onSubmit={event => {
                  event.preventDefault();
                  if (recording) {
                    stopRecording(true, true);
                    return;
                  }
                  void onSend();
                }}
              >
                <input ref={documentRef} type="file" hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf" onChange={attachPickedFile} />
                <input ref={videoRef} type="file" hidden accept="video/*" onChange={attachPickedFile} />
                <input ref={galleryRef} type="file" hidden accept="image/*" onChange={attachPickedFile} />
                {recording ? (
                  <div className="wa-composer__recording">
                    <span className="wa-composer__dot" />
                    <span>Recording {formatTimer(recordSeconds)}</span>
                    <button type="button" className="wa-icon-btn" onClick={() => stopRecording(false)} aria-label="Cancel voice note">
                      <X size={18} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`wa-icon-btn${emojiOpen ? ' is-active' : ''}`}
                      onClick={() => {
                        setEmojiOpen(open => !open);
                        setAttachOpen(false);
                        setAssignOpen(false);
                      }}
                      disabled={sending}
                      aria-label="Emoji"
                    >
                      <Smile size={22} />
                    </button>
                    <textarea
                      ref={composerRef}
                      className="wa-composer__input"
                      placeholder="Message"
                      rows={1}
                      value={draft}
                      aria-label="Message"
                      disabled={sending}
                      onChange={event => setDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        const el = event.currentTarget;
                        const start = el.selectionStart ?? draft.length;
                        const end = el.selectionEnd ?? start;
                        const next = `${draft.slice(0, start)}\n${draft.slice(end)}`;
                        setDraft(next);
                      }}
                    />
                    <button
                      type="button"
                      className={`wa-icon-btn${attachOpen ? ' is-active' : ''}`}
                      onClick={() => {
                        setAttachOpen(open => !open);
                        setEmojiOpen(false);
                        setAssignOpen(false);
                      }}
                      disabled={sending}
                      aria-label="Attach"
                    >
                      <Paperclip size={20} />
                    </button>
                    <button
                      type="button"
                      className="wa-icon-btn"
                      onClick={() => {
                        setCameraError('');
                        setCameraOpen(true);
                        setAttachOpen(false);
                        setEmojiOpen(false);
                      }}
                      disabled={sending}
                      aria-label="Camera"
                    >
                      <Camera size={20} />
                    </button>
                  </>
                )}
                {showMic ? (
                  <button type="button" className="wa-send" onClick={() => void startRecording()} aria-label="Record voice note">
                    <Mic size={18} />
                  </button>
                ) : (
                  <button type="submit" className="wa-send" disabled={!canSend} aria-label={recording ? 'Send voice note' : 'Send'}>
                    <Send size={18} />
                  </button>
                )}
              </form>
            ) : (
              <p className="wa-inbox-window">
                The 24-hour reply window is closed. You can answer after this customer messages again.
              </p>
            )}
            {sendError ? <p className="wa-inbox-error">{sendError}</p> : null}
          </>
        ) : (
          <div className="wa-inbox-thread__empty">
            <WhatsAppIcon size={48} />
            <strong>WhatsApp</strong>
            <p>Select a chat to reply from {formatWhatsAppNumber(settings.displayPhoneNumber || FIRM_PHONE)}.</p>
          </div>
        )}
      </section>
      {filtersOpen ? createPortal(
        <div className="wa-filter-sheet" role="presentation" onClick={() => setFiltersOpen(false)}>
          <div
            className="wa-filter-sheet__panel"
            role="dialog"
            aria-label="Filter"
            onClick={event => event.stopPropagation()}
          >
            <header>
              <strong>Filter</strong>
              <button type="button" aria-label="Close" onClick={() => setFiltersOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <label>
              Number
              <select value={numberFilter} onChange={event => setNumberFilter(event.target.value)}>
                <option value="all">All</option>
                <option value="firm">{formatWhatsAppNumber(settings.displayPhoneNumber || FIRM_PHONE)}</option>
              </select>
            </label>
            <label>
              Date
              <select
                value={draftFilters.date}
                onChange={event => setDraftFilters(current => ({ ...current, date: event.target.value as WaDate }))}
              >
                <option value="all">All dates</option>
                <option value="24h">Last 24 hours</option>
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                <option value="month">This month</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {draftFilters.date === 'custom' ? (
              <label>
                Day
                <input
                  type="date"
                  value={draftFilters.customDate}
                  onChange={event => setDraftFilters(current => ({ ...current, customDate: event.target.value }))}
                />
              </label>
            ) : null}
            <label>
              Type
              <select
                value={draftFilters.kind}
                onChange={event => setDraftFilters(current => ({ ...current, kind: event.target.value as WaKind }))}
              >
                <option value="all">All</option>
                <option value="unread">Unread</option>
                <option value="open">Open</option>
                <option value="no-reply">Waiting for reply</option>
              </select>
            </label>
            <div className="wa-filter-sheet__actions">
              <button
                type="button"
                onClick={() => {
                  setFilters(draftFilters);
                  setFiltersOpen(false);
                }}
              >
                Apply
              </button>
              <button
                type="button"
                disabled={draftFilters.date === 'all' && draftFilters.kind === 'all'}
                onClick={() => {
                  setDraftFilters(DEFAULT_WA_FILTERS);
                  setFilters(DEFAULT_WA_FILTERS);
                  setFiltersOpen(false);
                }}
              >
                Clear all
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {lightboxUrl ? createPortal(
        <button type="button" className="wa-lightbox" onClick={() => setLightboxUrl('')} aria-label="Close photo">
          <img src={lightboxUrl} alt="" />
        </button>,
        document.body,
      ) : null}
      {cameraOpen ? createPortal(
        <div className="wa-live-camera" role="dialog" aria-modal="true" aria-label="Camera">
          <video ref={cameraVideoRef} className="wa-live-camera__video" autoPlay playsInline muted />
          <button
            type="button"
            className="wa-live-camera__close"
            onClick={() => setCameraOpen(false)}
            aria-label="Close camera"
          >
            <X size={22} />
          </button>
          {cameraError ? <p className="wa-live-camera__note">{cameraError}</p> : null}
          <div className="wa-live-camera__bar">
            <button
              type="button"
              className="wa-live-camera__gallery"
              onClick={() => galleryRef.current?.click()}
              aria-label="Choose from gallery"
            >
              <ImageIcon size={22} />
            </button>
            <button type="button" className="wa-live-camera__shutter" onClick={takeLivePhoto} aria-label="Take photo" />
            <span />
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
};
