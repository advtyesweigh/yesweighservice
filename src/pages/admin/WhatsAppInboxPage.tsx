import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, CheckCheck, LayoutTemplate, Paperclip, Search, Send, Settings } from 'lucide-react';
import { FIRM_NAME, FIRM_PHONE } from '../../constants/brand';
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
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, activeId]);

  const visibleChats = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter(chat => {
      const hay = `${chat.senderName} ${chat.waId} ${chat.lastText}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [chats, queryText]);

  const sessionOpen = active ? whatsAppSessionOpen(active.lastInboundAtMs) : false;
  const { user } = useAuth();
  const canWriteTemplates = canSuperAdminWrite(user);
  const templateAction = useMemo(() => (
    <button
      type="button"
      className={`top-bar__action-btn top-bar__action-btn--icon${templatesOpen ? ' is-active' : ''}`}
      aria-label="Message templates"
      title="Message templates"
      onClick={() => setTemplatesOpen(open => !open)}
    >
      <LayoutTemplate size={18} />
    </button>
  ), [templatesOpen]);
  useTopBarAction(templateAction, Boolean(settings?.configured));

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
        <header className="wa-inbox-list__head">
          <div>
            <strong>{settings.accountName || FIRM_NAME}</strong>
            <span>{formatWhatsAppNumber(settings.displayPhoneNumber || FIRM_PHONE)}</span>
          </div>
          <Link className="wa-inbox-icon" aria-label="WhatsApp settings" to="/super-admin/settings/integration?section=whatsapp">
            <Settings size={18} />
          </Link>
        </header>
        <label className="wa-inbox-search">
          <Search size={16} />
          <input
            value={queryText}
            onChange={event => setQueryText(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
        </label>
        <div className="wa-inbox-list__rows">
          {visibleChats.length === 0 ? (
            <p className="wa-inbox-empty">No chats yet. Messages to this number will show up here.</p>
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
    </div>
  );
};
