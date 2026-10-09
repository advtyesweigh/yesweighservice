import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Paperclip, Plus, Trash2, X } from 'lucide-react';
import {
  deleteWhatsAppTemplate,
  listWhatsAppTemplates,
  saveWhatsAppTemplate,
  type WhatsAppTemplate,
  type WhatsAppTemplateButton,
} from '../../lib/whatsappInbox';
import { FIRM_NAME } from '../../constants/brand';

type ButtonDraft = {
  type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
  text: string;
  url: string;
  phone: string;
  urlSample: string;
};

type HeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';

type Draft = {
  id: string;
  name: string;
  language: string;
  category: string;
  headerFormat: HeaderFormat;
  headerText: string;
  headerFile: File | null;
  headerFileName: string;
  body: string;
  footer: string;
  buttons: ButtonDraft[];
  headerSamples: string[];
  bodySamples: string[];
  status: string;
  rejectedReason: string;
  editable: boolean;
};

const TEMPLATE_DELETE_PASSWORD = '1010';

const TEMPLATE_CATEGORIES = [
  { value: 'UTILITY', label: 'Utility' },
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'AUTHENTICATION', label: 'Authentication' },
];

const HEADER_TYPES: Array<{ value: HeaderFormat; label: string }> = [
  { value: 'NONE', label: 'None' },
  { value: 'TEXT', label: 'Text' },
  { value: 'IMAGE', label: 'Image' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'DOCUMENT', label: 'Document' },
];

const HEADER_ACCEPT: Record<'IMAGE' | 'VIDEO' | 'DOCUMENT', string> = {
  IMAGE: 'image/jpeg,image/png',
  VIDEO: 'video/mp4,video/3gpp',
  DOCUMENT: 'application/pdf',
};

const TEMPLATE_MEDIA_MAX_BYTES = 6 * 1024 * 1024;

const TEMPLATE_LANGUAGES = [
  { value: 'en_US', label: 'English (US)' },
  { value: 'en_GB', label: 'English (UK)' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'kn', label: 'Kannada' },
  { value: 'mr', label: 'Marathi' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'bn', label: 'Bengali' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'ur', label: 'Urdu' },
  { value: 'ar', label: 'Arabic' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt_BR', label: 'Portuguese (BR)' },
  { value: 'fr', label: 'French' },
];

const EMPTY: Draft = {
  id: '',
  name: '',
  language: 'en_US',
  category: 'UTILITY',
  headerFormat: 'NONE',
  headerText: '',
  headerFile: null,
  headerFileName: '',
  body: '',
  footer: FIRM_NAME,
  buttons: [],
  headerSamples: [],
  bodySamples: [],
  status: '',
  rejectedReason: '',
  editable: true,
};

function headerFormatFrom(template: WhatsAppTemplate): HeaderFormat {
  const format = String(template.headerFormat || '').toUpperCase();
  if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT' || format === 'TEXT') return format;
  return template.headerText ? 'TEXT' : 'NONE';
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

function placeholderIndexes(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

function resizeSamples(current: string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => current[index] ?? '');
}

function buttonDraft(button?: Partial<WhatsAppTemplateButton>): ButtonDraft {
  const type = button?.type === 'PHONE_NUMBER' || button?.type === 'QUICK_REPLY' ? button.type : 'URL';
  return {
    type,
    text: button?.text ?? '',
    url: button?.url ?? '',
    phone: button?.phone ?? '',
    urlSample: button?.urlSample ?? '',
  };
}

function draftFrom(template: WhatsAppTemplate): Draft {
  return {
    id: template.id,
    name: template.name,
    language: template.language || 'en_US',
    category: template.category || 'UTILITY',
    headerFormat: headerFormatFrom(template),
    headerText: template.headerText,
    headerFile: null,
    headerFileName: '',
    body: template.body,
    footer: template.footer,
    buttons: template.buttons.map(button => buttonDraft(button)),
    headerSamples: [],
    bodySamples: [],
    status: template.status,
    rejectedReason: template.rejectedReason,
    editable: template.editable,
  };
}

function statusLabel(status: string): string {
  const value = status.toLowerCase();
  if (value === 'approved') return 'Approved';
  if (value === 'pending') return 'In review';
  if (value === 'rejected') return 'Rejected';
  if (value === 'paused') return 'Paused';
  return status || 'New';
}

export const WhatsAppTemplatesPanel: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [rows, setRows] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queryText, setQueryText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [mediaPreview, setMediaPreview] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await listWhatsAppTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load templates.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const headerCount = draft?.headerFormat === 'TEXT' ? placeholderIndexes(draft.headerText).length : 0;
  const bodyCount = placeholderIndexes(draft?.body ?? '').length;
  const mediaHeader = draft?.headerFormat === 'IMAGE' || draft?.headerFormat === 'VIDEO' || draft?.headerFormat === 'DOCUMENT';

  useEffect(() => {
    if (!draft?.headerFile) {
      setMediaPreview('');
      return undefined;
    }
    const url = URL.createObjectURL(draft.headerFile);
    setMediaPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft?.headerFile]);

  useEffect(() => {
    setDraft(current => {
      if (!current) return current;
      const headerSamples = resizeSamples(current.headerSamples, headerCount > 1 ? 0 : headerCount);
      const bodySamples = resizeSamples(current.bodySamples, bodyCount);
      if (
        headerSamples.length === current.headerSamples.length
        && bodySamples.length === current.bodySamples.length
        && headerSamples.every((value, index) => value === current.headerSamples[index])
        && bodySamples.every((value, index) => value === current.bodySamples[index])
      ) return current;
      return { ...current, headerSamples, bodySamples };
    });
  }, [headerCount, bodyCount]);

  const visible = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(row => `${row.name} ${row.language} ${row.category} ${row.status}`.toLowerCase().includes(needle));
  }, [queryText, rows]);

  const locked = !canWrite || !draft?.editable;
  const loginTemplate = draft?.name === 'otp';
  const isApproved = Boolean(draft?.id && draft.status.toUpperCase() === 'APPROVED');

  const resetDeleteConfirm = () => {
    setConfirmDelete(false);
    setDeletePassword('');
  };

  const update = (patch: Partial<Draft>) => {
    setDraft(current => (current ? { ...current, ...patch } : current));
    setNote('');
    resetDeleteConfirm();
  };

  const onSave = async () => {
    if (!draft || locked) return;
    if (draft.id && draft.status.toUpperCase() === 'APPROVED') {
      setError('Approved templates cannot be edited. Delete it with password 1010, then create a new one.');
      return;
    }
    const buttons = draft.buttons.filter(button => button.text.trim());
    const media = draft.headerFormat === 'IMAGE' || draft.headerFormat === 'VIDEO' || draft.headerFormat === 'DOCUMENT';
    if (media && !draft.headerFile) {
      setError('Attach a sample image, video, or PDF for the header.');
      return;
    }
    if (draft.headerFile && draft.headerFile.size > TEMPLATE_MEDIA_MAX_BYTES) {
      setError('Header media must be under 6 MB.');
      return;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      const saved = await saveWhatsAppTemplate({
        id: draft.id || undefined,
        name: draft.name,
        language: draft.language,
        category: draft.category,
        headerFormat: draft.headerFormat === 'NONE' ? '' : draft.headerFormat,
        headerText: draft.headerFormat === 'TEXT' ? draft.headerText : '',
        headerMediaBase64: draft.headerFile ? await fileToBase64(draft.headerFile) : '',
        headerMediaName: draft.headerFile?.name || '',
        headerMediaMime: draft.headerFile?.type || '',
        body: draft.body,
        footer: FIRM_NAME,
        buttons,
        headerSamples: draft.headerFormat === 'TEXT' ? draft.headerSamples : [],
        bodySamples: draft.bodySamples,
      });
      setDraft(draftFrom(saved));
      setNote(saved.status.toUpperCase() === 'APPROVED'
        ? 'Saved.'
        : 'Saved. Meta has to approve it before it can be sent.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!draft?.id || !canWrite) return;
    if (deletePassword !== TEMPLATE_DELETE_PASSWORD) {
      setError('Enter password 1010 to delete.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await deleteWhatsAppTemplate(draft.id, draft.name);
      setDraft(null);
      setConfirmDelete(false);
      setDeletePassword('');
      setNote('Template deleted.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the template.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`wa-templates${draft ? '' : ' wa-templates--list-only'}`}>
      <aside className="wa-templates__list">
        <div className="wa-inbox-search">
          <input
            value={queryText}
            onChange={event => setQueryText(event.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
          />
          {canWrite ? (
            <button
              type="button"
              className="wa-inbox-icon"
              aria-label="New template"
              onClick={() => {
                setDraft({ ...EMPTY, buttons: [] });
                setNote('');
                setError('');
                resetDeleteConfirm();
              }}
            >
              <Plus size={18} />
            </button>
          ) : null}
        </div>
        <div className="wa-templates__rows">
          {loading ? <p className="wa-inbox-empty">Loading…</p> : null}
          {error && !draft ? <p className="wa-inbox-error">{error}</p> : null}
          {!loading && !error && visible.length === 0 ? (
            <p className="wa-inbox-empty">No templates.</p>
          ) : null}
          {visible.map(row => (
            <button
              key={row.id}
              type="button"
              className={`wa-templates__row${draft?.id === row.id ? ' is-active' : ''}`}
              onClick={() => {
                setDraft(draftFrom(row));
                setNote('');
                setError('');
                resetDeleteConfirm();
              }}
            >
              <strong>{row.name}</strong>
              <b className={`wa-templates__status is-${row.status.toLowerCase()}`}>{statusLabel(row.status)}</b>
            </button>
          ))}
        </div>
      </aside>
      {draft ? (
      <section className="wa-templates__editor">
          <form
            onSubmit={event => {
              event.preventDefault();
              if (confirmDelete) {
                void onDelete();
                return;
              }
              void onSave();
            }}
          >
            <button
              type="button"
              className="wa-templates__back"
              onClick={() => setDraft(null)}
            >
              <ChevronLeft size={18} />
              Templates
            </button>
            <div className="wa-templates__fields">
              <label>
                Name
                <input
                  value={draft.name}
                  disabled={locked || Boolean(draft.id)}
                  onChange={event => update({ name: event.target.value.toLowerCase() })}
                  placeholder="order_update"
                  required
                />
              </label>
              <label>
                Language
                <select
                  value={draft.language}
                  disabled={locked || Boolean(draft.id)}
                  onChange={event => update({ language: event.target.value })}
                  required
                >
                  {TEMPLATE_LANGUAGES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                  {draft.language && !TEMPLATE_LANGUAGES.some(option => option.value === draft.language) ? (
                    <option value={draft.language}>{draft.language}</option>
                  ) : null}
                </select>
              </label>
              <label>
                Category
                <select
                  value={draft.category}
                  disabled={locked}
                  onChange={event => update({ category: event.target.value })}
                >
                  {TEMPLATE_CATEGORIES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                  {draft.category && !TEMPLATE_CATEGORIES.some(option => option.value === draft.category) ? (
                    <option value={draft.category}>{draft.category}</option>
                  ) : null}
                </select>
              </label>
            </div>
            {draft.status ? (
              <p className={`wa-templates__status-line is-${draft.status.toLowerCase()}`}>
                {statusLabel(draft.status)}
                {draft.rejectedReason && draft.rejectedReason.toUpperCase() !== 'NONE'
                  ? ` — ${draft.rejectedReason}`
                  : ''}
              </p>
            ) : null}
            {loginTemplate ? (
              <p className="wa-inbox-note">
                Dealer login sends this template. Saving it sends it back to Meta review, and login codes stop until it is approved again.
              </p>
            ) : null}
            <label>
              Header
              <select
                value={draft.headerFormat}
                disabled={locked}
                onChange={event => {
                  const headerFormat = HEADER_TYPES.some(option => option.value === event.target.value)
                    ? event.target.value as HeaderFormat
                    : 'NONE';
                  update({
                    headerFormat,
                    headerText: headerFormat === 'TEXT' ? draft.headerText : '',
                    headerFile: null,
                    headerFileName: '',
                    headerSamples: headerFormat === 'TEXT' ? draft.headerSamples : [],
                  });
                }}
              >
                {HEADER_TYPES.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {draft.headerFormat === 'TEXT' ? (
              <label>
                Header text
                <input
                  value={draft.headerText}
                  maxLength={60}
                  disabled={locked}
                  onChange={event => update({ headerText: event.target.value })}
                  placeholder="Optional"
                />
              </label>
            ) : null}
            {mediaHeader ? (
              <div className="wa-templates__media">
                <input
                  ref={mediaInputRef}
                  type="file"
                  accept={
                    draft.headerFormat === 'IMAGE'
                    || draft.headerFormat === 'VIDEO'
                    || draft.headerFormat === 'DOCUMENT'
                      ? HEADER_ACCEPT[draft.headerFormat]
                      : undefined
                  }
                  hidden
                  onChange={event => {
                    const file = event.target.files?.[0] || null;
                    event.target.value = '';
                    if (!file) return;
                    if (file.size > TEMPLATE_MEDIA_MAX_BYTES) {
                      setError('Header media must be under 6 MB.');
                      return;
                    }
                    update({ headerFile: file, headerFileName: file.name });
                  }}
                />
                <div className="wa-templates__media-row">
                  <button
                    type="button"
                    className="wa-inbox-ghost"
                    disabled={locked}
                    onClick={() => mediaInputRef.current?.click()}
                  >
                    <Paperclip size={16} />
                    {draft.headerFile || draft.headerFileName ? 'Replace media' : 'Attach media'}
                  </button>
                  {draft.headerFile || draft.headerFileName ? (
                    <span className="wa-templates__media-name">
                      {draft.headerFileName || draft.headerFile?.name}
                      {canWrite && draft.editable ? (
                        <button
                          type="button"
                          className="wa-inbox-icon"
                          aria-label="Remove media"
                          onClick={() => update({ headerFile: null, headerFileName: '' })}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </span>
                  ) : (
                    <span className="wa-templates__media-hint">
                      {draft.headerFormat === 'IMAGE' ? 'JPEG or PNG, under 6 MB'
                        : draft.headerFormat === 'VIDEO' ? 'MP4, under 6 MB'
                          : 'PDF, under 6 MB'}
                    </span>
                  )}
                </div>
                {draft.headerFormat === 'IMAGE' && mediaPreview ? (
                  <img className="wa-templates__media-preview" src={mediaPreview} alt="" />
                ) : null}
                {draft.headerFormat === 'VIDEO' && mediaPreview ? (
                  <video className="wa-templates__media-preview" src={mediaPreview} controls muted />
                ) : null}
              </div>
            ) : null}
            {draft.headerSamples.length === 1 ? (
              <label>
                Header sample for {'{{1}}'}
                <input
                  value={draft.headerSamples[0]}
                  disabled={locked}
                  onChange={event => update({ headerSamples: [event.target.value] })}
                  required
                />
              </label>
            ) : null}
            <label>
              Body
              <textarea
                value={draft.body}
                maxLength={1024}
                rows={5}
                disabled={locked}
                onChange={event => update({ body: event.target.value })}
                placeholder={'Hi {{1}}, your code is {{2}}.'}
                required
              />
            </label>
            {draft.bodySamples.map((sample, index) => (
              <label key={`body-sample-${index + 1}`}>
                Body sample for {`{{${index + 1}}}`}
                <input
                  value={sample}
                  disabled={locked}
                  onChange={event => {
                    const bodySamples = [...draft.bodySamples];
                    bodySamples[index] = event.target.value;
                    update({ bodySamples });
                  }}
                  required
                />
              </label>
            ))}
            <label>
              Footer
              <input value={FIRM_NAME} maxLength={60} disabled readOnly />
            </label>
            <div className="wa-templates__buttons">
              <div className="wa-templates__buttons-head">
                <span>Buttons</span>
                {canWrite && draft.editable && draft.buttons.length < 3 ? (
                  <button
                    type="button"
                    className="wa-inbox-ghost"
                    onClick={() => update({ buttons: [...draft.buttons, buttonDraft()] })}
                  >
                    Add button
                  </button>
                ) : null}
              </div>
              {draft.buttons.map((button, index) => (
                <div key={`button-${index}`} className="wa-templates__button">
                  <select
                    value={button.type}
                    disabled={locked}
                    aria-label="Button type"
                    onChange={event => {
                      const buttons = [...draft.buttons];
                      const type = event.target.value;
                      buttons[index] = buttonDraft({
                        ...button,
                        type: type === 'PHONE_NUMBER' || type === 'QUICK_REPLY' ? type : 'URL',
                      });
                      update({ buttons });
                    }}
                  >
                    <option value="URL">Website</option>
                    <option value="PHONE_NUMBER">Call</option>
                    <option value="QUICK_REPLY">Quick reply</option>
                  </select>
                  <input
                    value={button.text}
                    maxLength={25}
                    disabled={locked}
                    aria-label="Button text"
                    placeholder="Button text"
                    onChange={event => {
                      const buttons = [...draft.buttons];
                      buttons[index] = { ...button, text: event.target.value };
                      update({ buttons });
                    }}
                  />
                  {button.type === 'URL' ? (
                    <input
                      value={button.url}
                      disabled={locked}
                      aria-label="Button link"
                      placeholder="https://"
                      onChange={event => {
                        const buttons = [...draft.buttons];
                        buttons[index] = { ...button, url: event.target.value };
                        update({ buttons });
                      }}
                    />
                  ) : null}
                  {button.type === 'URL' && button.url.includes('{{1}}') ? (
                    <input
                      value={button.urlSample}
                      disabled={locked}
                      aria-label="Button link sample"
                      placeholder="https:// sample for {{1}}"
                      onChange={event => {
                        const buttons = [...draft.buttons];
                        buttons[index] = { ...button, urlSample: event.target.value };
                        update({ buttons });
                      }}
                    />
                  ) : null}
                  {button.type === 'PHONE_NUMBER' ? (
                    <input
                      value={button.phone}
                      disabled={locked}
                      aria-label="Button phone"
                      placeholder="+918803333444"
                      onChange={event => {
                        const buttons = [...draft.buttons];
                        buttons[index] = { ...button, phone: event.target.value };
                        update({ buttons });
                      }}
                    />
                  ) : null}
                  {canWrite && draft.editable ? (
                    <button
                      type="button"
                      className="wa-inbox-icon"
                      aria-label="Remove button"
                      onClick={() => update({ buttons: draft.buttons.filter((_, item) => item !== index) })}
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {error ? <p className="wa-inbox-error">{error}</p> : null}
            {note ? <p className="wa-inbox-note">{note}</p> : null}
            {isApproved ? (
              <p className="wa-inbox-note">Approved templates cannot be edited. Delete it, then create a new one.</p>
            ) : null}
            {canWrite ? (
              <div className="wa-inbox-setup__actions">
                {!isApproved && draft.editable ? (
                <button type="submit" className="wa-inbox-primary" disabled={busy}>
                  {busy ? 'Saving…' : draft.id ? 'Save' : 'Create'}
                </button>
                ) : null}
                {draft.id && !confirmDelete ? (
                  <button type="button" className="wa-inbox-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                ) : null}
                {draft.id && confirmDelete ? (
                  <>
                    <input
                      type="password"
                      className="wa-templates__delete-pin"
                      value={deletePassword}
                      onChange={event => setDeletePassword(event.target.value)}
                      placeholder="Password"
                      aria-label="Delete password"
                      autoComplete="off"
                      inputMode="numeric"
                      disabled={busy}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void onDelete();
                        }
                      }}
                    />
                    <button type="button" className="wa-templates__danger" disabled={busy} onClick={() => void onDelete()}>
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            ) : error ? null : null}
          </form>
      </section>
      ) : null}
    </div>
  );
};
