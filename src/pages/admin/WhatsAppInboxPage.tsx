import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, Paperclip, Search, Send, Settings } from 'lucide-react';
import { FIRM_NAME, FIRM_PHONE } from '../../constants/brand';
import {
  formatWhatsAppNumber,
  loadWhatsAppSettings,
  markWhatsAppConversationRead,
  saveWhatsAppSettings,
  sendWhatsAppFile,
  sendWhatsAppText,
  subscribeWhatsAppConversations,
  subscribeWhatsAppMessages,
  whatsAppSessionOpen,
  type WhatsAppChatMessage,
  type WhatsAppConversation,
  type WhatsAppPhoneChoice,
  type WhatsAppSettings,
} from '../../lib/whatsappInbox';
import '../../whatsapp-inbox.css';

/** Interweighing Pvt Ltd WhatsApp Business Account and +91 88033 33444. */
const DEFAULT_WABA_ID = '935267172861360';
const DEFAULT_PHONE_NUMBER_ID = '1288718687667400';

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
  const [setupOpen, setSetupOpen] = useState(false);
  const [token, setToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [wabaId, setWabaId] = useState(DEFAULT_WABA_ID);
  const [phoneNumberId, setPhoneNumberId] = useState(DEFAULT_PHONE_NUMBER_ID);
  const [phones, setPhones] = useState<WhatsAppPhoneChoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [copied, setCopied] = useState('');

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
        setWabaId(next.wabaId || DEFAULT_WABA_ID);
        setPhoneNumberId(next.phoneNumberId || DEFAULT_PHONE_NUMBER_ID);
        setSetupOpen(!next.configured);
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

  const copyText = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(''), 1400);
    } catch {
      setSaveNote('Could not copy that.');
    }
  };

  const openChat = (chat: WhatsAppConversation) => {
    setActiveId(chat.id);
    setSendError('');
    if (chat.unreadCount > 0) {
      void markWhatsAppConversationRead(chat.id).catch(() => undefined);
    }
  };

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveNote('');
    setSettingsError('');
    try {
      const next = await saveWhatsAppSettings({
        metaAccessToken: token,
        metaAppSecret: appSecret,
        metaWabaId: wabaId,
        metaPhoneNumberId: phoneNumberId,
      });
      setSettings(next);
      setPhones(next.phones ?? []);
      setToken('');
      setAppSecret('');
      if (next.needsPhoneChoice) {
        setSaveNote('Choose the phone number for this inbox.');
        return;
      }
      setSetupOpen(false);
      setSaveNote(next.webhookSubscribed
        ? 'WhatsApp connected. New messages will appear here.'
        : (next.webhookDetail || 'Saved. Subscribe the webhook in Meta if messages do not arrive.'));
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Could not save WhatsApp.');
    } finally {
      setSaving(false);
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

  const setup = (
    <form className="wa-inbox-setup" onSubmit={onSave}>
      <h2>Connect Meta WhatsApp</h2>
      <p>
        One inbox for {FIRM_NAME}, {formatWhatsAppNumber(FIRM_PHONE)}.
        Paste the Cloud API token from the Meta app that owns this number.
      </p>
      <label>
        Access token
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={event => setToken(event.target.value)}
          placeholder={settings?.hasAccessToken ? 'Saved — paste only to replace' : 'System user token'}
        />
      </label>
      <label>
        App secret
        <input
          type="password"
          autoComplete="off"
          value={appSecret}
          onChange={event => setAppSecret(event.target.value)}
          placeholder={settings?.hasAppSecret ? 'Saved — paste only to replace' : 'App settings → Basic'}
        />
      </label>
      <label>
        WhatsApp Business Account ID
        <input
          value={wabaId}
          onChange={event => setWabaId(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
        />
      </label>
      <label>
        Phone number ID
        <input
          value={phoneNumberId}
          onChange={event => setPhoneNumberId(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Filled automatically when this account has one number"
        />
      </label>
      {phones.length > 0 ? (
        <fieldset className="wa-inbox-phones">
          <legend>Phone number</legend>
          {phones.map(phone => (
            <label key={phone.id}>
              <input
                type="radio"
                name="wa-phone"
                checked={phoneNumberId === phone.id}
                onChange={() => setPhoneNumberId(phone.id)}
              />
              <span>
                {phone.verifiedName || 'WhatsApp'}
                {' '}
                {phone.displayPhoneNumber}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {settings?.webhookUrl ? (
        <div className="wa-inbox-copy">
          <span>Webhook</span>
          <code>{settings.webhookUrl}</code>
          <button type="button" onClick={() => void copyText(settings.webhookUrl, 'url')}>
            {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
      {settings?.verifyToken ? (
        <div className="wa-inbox-copy">
          <span>Verify token</span>
          <code>{settings.verifyToken}</code>
          <button type="button" onClick={() => void copyText(settings.verifyToken, 'token')}>
            {copied === 'token' ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
      {settingsError ? <p className="wa-inbox-error">{settingsError}</p> : null}
      {saveNote ? <p className="wa-inbox-note">{saveNote}</p> : null}
      <div className="wa-inbox-setup__actions">
        <button type="submit" className="wa-inbox-primary" disabled={saving}>
          {saving ? 'Connecting…' : 'Connect'}
        </button>
        {settings?.configured ? (
          <button type="button" className="wa-inbox-ghost" onClick={() => setSetupOpen(false)}>
            Close
          </button>
        ) : null}
      </div>
    </form>
  );

  if (!settings && !settingsError) {
    return (
      <div className="wa-inbox-page wa-inbox-page--setup">
        <p className="wa-inbox-note">Loading WhatsApp…</p>
      </div>
    );
  }

  if (!settings?.configured || setupOpen) {
    return <div className="wa-inbox-page wa-inbox-page--setup">{setup}</div>;
  }

  return (
    <div className={`wa-inbox-page${active ? ' has-chat' : ''}`}>
      <aside className="wa-inbox-list">
        <header className="wa-inbox-list__head">
          <div>
            <strong>{settings.accountName || FIRM_NAME}</strong>
            <span>{formatWhatsAppNumber(settings.displayPhoneNumber || FIRM_PHONE)}</span>
          </div>
          <button type="button" className="wa-inbox-icon" aria-label="WhatsApp settings" onClick={() => setSetupOpen(true)}>
            <Settings size={18} />
          </button>
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
