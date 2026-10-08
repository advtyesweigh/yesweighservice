import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  deleteWhatsAppTemplate,
  listWhatsAppTemplates,
  saveWhatsAppTemplate,
  type WhatsAppTemplate,
  type WhatsAppTemplateButton,
} from '../../lib/whatsappInbox';

type ButtonDraft = {
  type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
  text: string;
  url: string;
  phone: string;
  urlSample: string;
};

type Draft = {
  id: string;
  name: string;
  language: string;
  category: string;
  headerText: string;
  body: string;
  footer: string;
  buttons: ButtonDraft[];
  headerSamples: string[];
  bodySamples: string[];
  status: string;
  rejectedReason: string;
  editable: boolean;
};

const EMPTY: Draft = {
  id: '',
  name: '',
  language: 'en_US',
  category: 'UTILITY',
  headerText: '',
  body: '',
  footer: '',
  buttons: [],
  headerSamples: [],
  bodySamples: [],
  status: '',
  rejectedReason: '',
  editable: true,
};

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
    headerText: template.headerText,
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

  const headerCount = placeholderIndexes(draft?.headerText ?? '').length;
  const bodyCount = placeholderIndexes(draft?.body ?? '').length;

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

  const update = (patch: Partial<Draft>) => {
    setDraft(current => (current ? { ...current, ...patch } : current));
    setNote('');
    setConfirmDelete(false);
  };

  const onSave = async () => {
    if (!draft || locked) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const saved = await saveWhatsAppTemplate({
        id: draft.id || undefined,
        name: draft.name,
        language: draft.language,
        category: draft.category,
        headerText: draft.headerText,
        body: draft.body,
        footer: draft.footer,
        buttons: draft.buttons,
        headerSamples: draft.headerSamples,
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
    if (!draft?.id || locked) return;
    setBusy(true);
    setError('');
    try {
      await deleteWhatsAppTemplate(draft.id, draft.name);
      setDraft(null);
      setConfirmDelete(false);
      setNote('Template deleted.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the template.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wa-templates">
      <aside className="wa-templates__list">
        <header className="wa-templates__bar">
          <strong>Templates</strong>
          {canWrite ? (
            <button
              type="button"
              className="wa-inbox-icon"
              aria-label="New template"
              onClick={() => {
                setDraft({ ...EMPTY, buttons: [] });
                setNote('');
                setError('');
                setConfirmDelete(false);
              }}
            >
              <Plus size={18} />
            </button>
          ) : null}
        </header>
        <label className="wa-inbox-search">
          <input
            value={queryText}
            onChange={event => setQueryText(event.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
          />
        </label>
        <div className="wa-templates__rows">
          {loading ? <p className="wa-inbox-empty">Loading templates…</p> : null}
          {!loading && !error && visible.length === 0 ? (
            <p className="wa-inbox-empty">No templates yet.</p>
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
                setConfirmDelete(false);
              }}
            >
              <span>
                <strong>{row.name}</strong>
                <em>{row.language} · {row.category === 'MARKETING' ? 'Marketing' : row.category === 'UTILITY' ? 'Utility' : row.category}</em>
              </span>
              <b className={`wa-templates__status is-${row.status.toLowerCase()}`}>{statusLabel(row.status)}</b>
            </button>
          ))}
        </div>
      </aside>
      <section className="wa-templates__editor">
        {draft ? (
          <form
            onSubmit={event => {
              event.preventDefault();
              void onSave();
            }}
          >
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
                <input
                  value={draft.language}
                  disabled={locked || Boolean(draft.id)}
                  onChange={event => update({ language: event.target.value })}
                  placeholder="en_US"
                  required
                />
              </label>
              <label>
                Category
                <select
                  value={draft.category}
                  disabled={locked}
                  onChange={event => update({ category: event.target.value === 'MARKETING' ? 'MARKETING' : 'UTILITY' })}
                >
                  <option value="UTILITY">Utility</option>
                  <option value="MARKETING">Marketing</option>
                  {draft.category !== 'UTILITY' && draft.category !== 'MARKETING' ? (
                    <option value={draft.category}>{draft.category}</option>
                  ) : null}
                </select>
              </label>
            </div>
            {draft.status ? (
              <p className={`wa-templates__status-line is-${draft.status.toLowerCase()}`}>
                {statusLabel(draft.status)}
                {draft.rejectedReason ? ` — ${draft.rejectedReason}` : ''}
              </p>
            ) : null}
            {loginTemplate ? (
              <p className="wa-inbox-note">
                Dealer login sends this template. Saving it sends it back to Meta review, and login codes stop until it is approved again.
              </p>
            ) : null}
            {!draft.editable ? (
              <p className="wa-inbox-note">
                This template uses a media header or an authentication layout. Edit that kind in Meta.
              </p>
            ) : null}
            <label>
              Header
              <input
                value={draft.headerText}
                maxLength={60}
                disabled={locked}
                onChange={event => update({ headerText: event.target.value })}
                placeholder="Optional"
              />
            </label>
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
              <input
                value={draft.footer}
                maxLength={60}
                disabled={locked}
                onChange={event => update({ footer: event.target.value })}
                placeholder="Optional"
              />
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
            {canWrite && draft.editable ? (
              <div className="wa-inbox-setup__actions">
                <button type="submit" className="wa-inbox-primary" disabled={busy}>
                  {busy ? 'Saving…' : draft.id ? 'Save' : 'Create'}
                </button>
                {draft.id && !confirmDelete ? (
                  <button type="button" className="wa-inbox-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                ) : null}
                {draft.id && confirmDelete ? (
                  <button type="button" className="wa-templates__danger" disabled={busy} onClick={() => void onDelete()}>
                    Delete {draft.name}
                  </button>
                ) : null}
              </div>
            ) : error ? null : null}
          </form>
        ) : (
          <div className="wa-inbox-thread__empty">
            <strong>Message templates</strong>
            <p>Create a template or open one to edit it. Meta reviews every change before it can be sent.</p>
            {error ? <p className="wa-inbox-error">{error}</p> : null}
          </div>
        )}
      </section>
    </div>
  );
};
