import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Briefcase,
  Check,
  CheckCheck,
  LayoutTemplate,
  MessageCircle,
  Paperclip,
  Search,
  Send,
  SlidersHorizontal,
  User,
  UserPlus,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { FIRM_PHONE } from '../../constants/brand';
import { useAuth } from '../../context/AuthContext';
import { useTopBarAction } from '../../context/PageHeaderContext';
import { canSuperAdminWrite } from '../../lib/staffAccess';
import {
  formatWhatsAppNumber,
  loadWhatsAppSettings,
  markWhatsAppConversationRead,
  sendWhatsAppFile,
  sendWhatsAppText,
  subscribeWhatsAppConversations,
  subscribeWhatsAppMessages,
  whatsAppSessionOpen,
  type WhatsAppChatMessage,
  type WhatsAppConversation,
  type WhatsAppSettings,
} from '../../lib/whatsappInbox';
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
  if (kind === 'unread') return chat.unreadCount > 0;
  if (kind === 'open') return whatsAppSessionOpen(chat.lastInboundAtMs, now);
  return chat.lastDirection === 'inbound';
}

function matchesTile(chat: WhatsAppConversation, tile: WaTile, now: number): boolean {
  if (tile === 'all' || tile === 'unassigned') return true;
  if (tile === 'open') return whatsAppSessionOpen(chat.lastInboundAtMs, now);
  return false;
}

function matchesBoard(board: WaBoard): boolean {
  return board === 'all';
}

function clock(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
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

function MessageBody({ message }: { message: WhatsAppChatMessage }) {
  const url = message.mediaUrl;
  if (message.type === 'image' && url) {
    return (
      <>
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="" className="wa-inbox-bubble__image" />
        </a>
        {message.text ? <p>{message.text}</p> : null}
      </>
    );
  }
  if (message.type === 'video' && url) {
    return (
      <>
        <video src={url} controls className="wa-inbox-bubble__video" />
        {message.text ? <p>{message.text}</p> : null}
      </>
    );
  }
  if (message.type === 'audio' && url) {
    return <audio src={url} controls className="wa-inbox-bubble__audio" />;
  }
  if ((message.type === 'document' || message.type === 'sticker') && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="wa-inbox-bubble__file">
        {message.fileName || message.text || 'Document'}
      </a>
    );
  }
  return <p>{message.text || message.type}</p>;
}

function StatusTick({ status }: { status: string }) {
  if (status === 'read') return <CheckCheck size={14} className="wa-inbox-tick is-read" />;
  if (status === 'delivered') return <CheckCheck size={14} className="wa-inbox-tick" />;
  if (status === 'failed') return <span className="wa-inbox-tick is-failed">Failed</span>;
  return <Check size={14} className="wa-inbox-tick" />;
}

export const WhatsAppInboxPage: React.FC = () => {
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
  const [sendError, setSendError] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  const active = chats.find(chat => chat.id === activeId) ?? null;

  useEffect(() => {
    if (!active) {
      setMessages([]);
      return undefined;
    }
    return subscribeWhatsAppMessages(active.waId, setMessages, err => setChatError(err.message));
  }, [active?.waId]);

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

  const searched = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    return chats.filter(chat => {
      if (!matchesDate(chat.lastAtMs, filters, now)) return false;
      if (!matchesKind(chat, filters.kind, now)) return false;
      if (!needle) return true;
      const hay = `${chat.senderName} ${chat.waId} ${chat.lastText}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [chats, filters, now, queryText]);

  const tileCounts = useMemo(() => ({
    open: searched.filter(chat => whatsAppSessionOpen(chat.lastInboundAtMs, now)).length,
    unassigned: searched.length,
    assigned: 0,
    service: 0,
    all: searched.length,
  }), [now, searched]);

  const visibleChats = useMemo(
    () => searched.filter(chat => matchesBoard(board) && matchesTile(chat, tile, now)),
    [board, now, searched, tile],
  );

  const sessionOpen = active ? whatsAppSessionOpen(active.lastInboundAtMs) : false;
  const { user } = useAuth();
  const canWriteTemplates = canSuperAdminWrite(user);
  const filtersDiffer = filters.date !== 'all' || filters.kind !== 'all';
  const headerActions = useMemo(() => (
    <>
      {templatesOpen ? null : (
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
      )}
      <button
        type="button"
        className={`top-bar__action-btn top-bar__action-btn--icon${templatesOpen ? ' is-active' : ''}`}
        aria-label="Message templates"
        title="Message templates"
        onClick={() => setTemplatesOpen(open => !open)}
      >
        <LayoutTemplate size={18} />
      </button>
    </>
  ), [filters, filtersDiffer, templatesOpen]);
  useTopBarAction(headerActions, Boolean(settings?.configured));

  const openChat = (chat: WhatsAppConversation) => {
    setActiveId(chat.id);
    setSendError('');
    if (chat.unreadCount > 0) {
      void markWhatsAppConversationRead(chat.id).catch(() => undefined);
    }
  };

  const onSend = async () => {
    if (!active || sending) return;
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setSendError('');
    try {
      await sendWhatsAppText(active.waId, text);
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !active) return;
    if (file.size > 8 * 1024 * 1024) {
      setSendError('File must be under 8 MB.');
      return;
    }
    setSending(true);
    setSendError('');
    try {
      const fileBase64 = await fileToBase64(file);
      await sendWhatsAppFile({
        waId: active.waId,
        fileBase64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        caption: draft.trim(),
      });
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send the file.');
    } finally {
      setSending(false);
    }
  };

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
      <aside className="wa-inbox-list">
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
                      : tile === 'open'
                        ? 'No chats inside the 24-hour window.'
                        : chats.length === 0
                          ? 'No chats yet. Messages to this number will show up here.'
                          : 'No chats match these filters.'}
            </p>
          ) : visibleChats.map(chat => (
            <button
              key={chat.id}
              type="button"
              className={`wa-inbox-row${chat.id === activeId ? ' is-active' : ''}`}
              onClick={() => openChat(chat)}
            >
              <span className="wa-inbox-avatar" aria-hidden>
                {(chat.senderName || chat.waId).slice(0, 1).toUpperCase()}
              </span>
              <span className="wa-inbox-row__body">
                <span className="wa-inbox-row__top">
                  <strong>{chat.senderName || formatWhatsAppNumber(chat.waId)}</strong>
                  <time>{clock(chat.lastAtMs)}</time>
                </span>
                <span className="wa-inbox-row__preview">
                  <em>{chat.lastText || 'Message'}</em>
                  {chat.unreadCount > 0 ? <b>{chat.unreadCount}</b> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
        {chatError ? <p className="wa-inbox-error">{chatError}</p> : null}
      </aside>
      <section className="wa-inbox-thread">
        {active ? (
          <>
            <header className="wa-inbox-thread__head">
              <button type="button" className="wa-inbox-icon wa-inbox-back" aria-label="Back to chats" onClick={() => setActiveId('')}>
                <ArrowLeft size={18} />
              </button>
              <div>
                <strong>{active.senderName || formatWhatsAppNumber(active.waId)}</strong>
                <span>{formatWhatsAppNumber(active.waId)}</span>
              </div>
            </header>
            <div className="wa-inbox-thread__messages" ref={threadRef}>
              {messages.map(message => (
                <article
                  key={message.id}
                  className={`wa-inbox-bubble wa-inbox-bubble--${message.direction}`}
                >
                  <MessageBody message={message} />
                  <footer>
                    <time>{clock(message.createdAtMs)}</time>
                    {message.direction === 'outbound' ? <StatusTick status={message.status} /> : null}
                  </footer>
                </article>
              ))}
            </div>
            {sessionOpen ? (
              <form
                className="wa-inbox-composer"
                onSubmit={event => {
                  event.preventDefault();
                  void onSend();
                }}
              >
                <input ref={fileRef} type="file" hidden onChange={event => void onFile(event)} />
                <button
                  type="button"
                  className="wa-inbox-icon"
                  aria-label="Attach file"
                  disabled={sending}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={18} />
                </button>
                <textarea
                  value={draft}
                  rows={1}
                  placeholder="Message"
                  aria-label="Message"
                  disabled={sending}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void onSend();
                    }
                  }}
                />
                <button type="submit" className="wa-inbox-send" aria-label="Send" disabled={sending || !draft.trim()}>
                  <Send size={18} />
                </button>
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
    </div>
  );
};
