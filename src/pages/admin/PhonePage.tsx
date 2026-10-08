import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTopBarAction } from '../../context/PageHeaderContext';
import { canSuperAdminWrite } from '../../lib/staffAccess';
import { collection, limit, onSnapshot, query } from 'firebase/firestore';
import { db } from '../../firebase';
import { markMissedFollowedUp, subscribePhoneEvents } from '../../lib/phoneEvents';
import { WHATSAPP_CONVERSATIONS } from '../../lib/whatsappInbox';
import {
  CALL_PAGE_SIZE,
  COMPANY_DID,
  DEFAULT_CALL_FILTERS,
  MISSED_FOLLOW_UP_TEXT,
  activeFilterCount,
  callStats,
  callTypeFromEvent,
  collapseCalls,
  filtersDiffer,
  formatCallerNumber,
  formatElapsed,
  formatTalk,
  indiaE164,
  isIndianMobile,
  isOpenMissed,
  national10,
  preFilterEvents,
  remoteParty,
  visibleCalls,
  whenParts,
  type CallFilters,
  type CallListStatus,
  type CallPeriod,
  type CallRow,
  type CallStatusFilter,
  type CallTypeFilter,
  type PhoneEvent,
} from '../../lib/phoneLog';
import '../../phone.css';

function TranscriptIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M5 4.5A2.5 2.5 0 0 1 7.5 2h6.2c.5 0 1 .2 1.3.6l2.4 2.6c.3.4.5.8.5 1.3V14a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4.9 14V4.5Z"
      />
      <path fill="#ecfdf5" d="M8 7.2h5.2v1.2H8zm0 2.4h4.1v1.2H8z" />
      <path fill="currentColor" d="M3 16.2h2.1v1.1H3zm3.2 0h1.2v2.4H6.2zm2.2-1.1h1.2v3.5H8.4zm2.2 1.1h1.2V18h-1.2zm2.2-1.6h1.2v4.2h-1.2zm2.2.8h1.2v2.6h-1.2z" />
    </svg>
  );
}

function statusWord(status: CallListStatus, repeatCount: number): string {
  if (status === 'missed') return repeatCount > 1 ? `Missed (${repeatCount})` : 'Missed';
  if (status === 'outbound') return 'Outbound';
  if (status === 'incoming') return 'Incoming';
  return 'Received';
}

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 960px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 960px)');
    const onChange = () => setDesktop(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

function FilterFields({
  draft,
  setDraft,
  numbers,
  agents,
  onApply,
  onClear,
}: {
  draft: CallFilters;
  setDraft: React.Dispatch<React.SetStateAction<CallFilters>>;
  numbers: { value: string; label: string }[];
  agents: string[];
  onApply: () => void;
  onClear: () => void;
}) {
  const dirty = filtersDiffer(draft);
  return (
    <div className="phone-filter">
      <label>
        Number
        <select value={draft.number} onChange={event => setDraft(current => ({ ...current, number: event.target.value }))}>
          <option value="all">All</option>
          {numbers.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label>
        Period
        <select
          value={draft.period}
          onChange={event => setDraft(current => ({ ...current, period: event.target.value as CallPeriod }))}
        >
          <option value="last24h">Last 24 hours</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="month">This month</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {draft.period === 'custom' ? (
        <label>
          Date
          <input
            type="date"
            value={draft.customDate}
            onChange={event => setDraft(current => ({ ...current, customDate: event.target.value }))}
          />
        </label>
      ) : null}
      <label>
        Agent
        <select value={draft.agent} onChange={event => setDraft(current => ({ ...current, agent: event.target.value }))}>
          <option value="all">All agents</option>
          {agents.map(agent => <option key={agent} value={agent}>{agent}</option>)}
        </select>
      </label>
      <div className="phone-filter__chips">
        <span>Status</span>
        {(['all', 'received', 'missed', 'outbound'] as CallStatusFilter[]).map(status => (
          <button
            key={status}
            type="button"
            className={draft.status === status ? 'is-on' : ''}
            onClick={() => setDraft(current => ({ ...current, status }))}
          >
            {status === 'all' ? 'All' : status[0].toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>
      <div className="phone-filter__chips">
        <span>Type</span>
        {(['all', 'sales', 'service'] as CallTypeFilter[]).map(type => (
          <button
            key={type}
            type="button"
            className={draft.type === type ? 'is-on' : ''}
            onClick={() => setDraft(current => ({ ...current, type }))}
          >
            {type === 'all' ? 'All' : type === 'sales' ? 'Sales' : 'Service'}
          </button>
        ))}
      </div>
      <div className="phone-filter__actions">
        <button type="button" className="phone-filter__apply" onClick={onApply}>Apply</button>
        <button type="button" className="phone-filter__clear" disabled={!dirty} onClick={onClear}>Clear all</button>
      </div>
    </div>
  );
}

export const PhonePage: React.FC = () => {
  const { user } = useAuth();
  const canWrite = canSuperAdminWrite(user);
  const desktop = useDesktop();
  const [params, setParams] = useSearchParams();
  const initialStatus = params.get('status');
  const [events, setEvents] = useState<PhoneEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState<CallFilters>(() => ({
    ...DEFAULT_CALL_FILTERS,
    status: initialStatus === 'missed' || initialStatus === 'received' || initialStatus === 'outbound'
      ? initialStatus
      : 'all',
  }));
  const [draft, setDraft] = useState<CallFilters>(applied);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [playingId, setPlayingId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [openTranscript, setOpenTranscript] = useState('');
  const [waDigits, setWaDigits] = useState<Set<string>>(() => new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => subscribePhoneEvents(rows => {
    setEvents(rows);
    setLoaded(true);
  }, err => {
    setError(err.message);
    setLoaded(true);
  }), []);

  useEffect(() => onSnapshot(
    query(collection(db, WHATSAPP_CONVERSATIONS), limit(200)),
    snap => {
      const next = new Set<string>();
      snap.docs.forEach(item => {
        const local = national10(String(item.data().waId || item.id));
        if (local) next.add(local);
      });
      setWaDigits(next);
    },
    () => undefined,
  ), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    audioRef.current?.pause();
    setPlaying(false);
    setPlayingId('');
  }, [applied, page]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const dated = useMemo(() => collapseCalls(preFilterEvents(events, applied)), [applied, events]);
  const stats = useMemo(() => callStats(dated), [dated]);
  const rows = useMemo(() => visibleCalls(dated, applied), [applied, dated]);
  const pageCount = Math.max(1, Math.ceil(rows.length / CALL_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * CALL_PAGE_SIZE, safePage * CALL_PAGE_SIZE + CALL_PAGE_SIZE);

  const numbers = useMemo(() => {
    const options = [{ value: `did:${COMPANY_DID}`, label: '0484 712 3223' }];
    const seen = new Set<string>([COMPANY_DID]);
    events.forEach(event => {
      const line = event.deviceLine.replace(/\D/g, '');
      if (!line || seen.has(line) || line.endsWith(COMPANY_DID.slice(-10))) return;
      seen.add(line);
      options.push({ value: `sim:${line}`, label: event.employeeName || event.agent || line });
    });
    return options;
  }, [events]);

  const agents = useMemo(() => {
    const names = new Set<string>();
    events.forEach(event => {
      const name = event.employeeName || event.agent;
      if (name) names.add(name);
    });
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [events]);

  const filterButton = useMemo(() => (
    loaded && !desktop ? (
      <button
        type="button"
        className={`phone-filter-btn${filtersDiffer(applied) ? ' is-on' : ''}`}
        aria-label="Filter calls"
        onClick={() => {
          setDraft(applied);
          setSheetOpen(true);
        }}
      >
        <SlidersHorizontal size={18} />
      </button>
    ) : null
  ), [applied, desktop, loaded]);
  useTopBarAction(filterButton, loaded && !desktop);

  const syncStatus = (status: CallStatusFilter) => {
    const next = new URLSearchParams(params);
    if (status === 'all' || status === 'incoming') next.delete('status');
    else next.set('status', status);
    setParams(next, { replace: true });
  };

  const chooseStatus = (status: 'all' | 'missed' | 'received' | 'outbound') => {
    const nextStatus: CallStatusFilter = applied.status === status ? 'all' : status;
    const next = nextStatus === 'all'
      ? { ...applied, status: 'all' as const, type: 'all' as const }
      : { ...applied, status: nextStatus };
    setApplied(next);
    setDraft(next);
    setPage(0);
    syncStatus(next.status);
  };

  const applyDraft = () => {
    setApplied(draft);
    setPage(0);
    setSheetOpen(false);
    syncStatus(draft.status);
  };

  const clearFilters = () => {
    setDraft(DEFAULT_CALL_FILTERS);
    setApplied(DEFAULT_CALL_FILTERS);
    setPage(0);
    setSheetOpen(false);
    syncStatus('all');
  };

  const followUp = (event: PhoneEvent) => {
    if (!canWrite) return;
    const name = user?.displayName || 'Staff';
    void markMissedFollowedUp(events, event, name).catch(err => {
      setError(err instanceof Error ? err.message : 'Could not mark that call.');
    });
  };

  const togglePlay = (row: CallRow) => {
    const audio = audioRef.current;
    if (!audio || !row.event.recordingUrl) return;
    if (playingId === row.event.id) {
      if (playing) audio.pause();
      else void audio.play();
      return;
    }
    audio.src = row.event.recordingUrl;
    audio.playbackRate = rate;
    setPlayingId(row.event.id);
    void audio.play();
  };

  const filters = (
    <FilterFields
      draft={desktop ? draft : draft}
      setDraft={setDraft}
      numbers={numbers}
      agents={agents}
      onApply={applyDraft}
      onClear={clearFilters}
    />
  );

  return (
    <div className="call-page">
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPlayingId('');
        }}
      />
      {!loaded ? (
        <div className="call-page__loading">
          <span className="call-page__spinner" />
          Loading calls
        </div>
      ) : events.length === 0 ? (
        <div className="call-page__empty">
          <Phone size={28} />
          <p>{error || 'Waiting for the first call.'}</p>
        </div>
      ) : (
        <div className="call-page__grid">
          <div className="call-page__main">
            <div className="phone-sort">
              {([
                ['all', 'Total', stats.total, <Phone size={15} />],
                ['missed', 'Missed', stats.missed, <PhoneMissed size={15} />],
                ['received', 'Received', stats.received, <PhoneIncoming size={15} />],
                ['outbound', 'Outbound', stats.outbound, <PhoneOutgoing size={15} />],
              ] as const).map(([status, label, count, icon]) => (
                <button
                  key={status}
                  type="button"
                  className={`phone-sort__tile is-${status}${applied.status === status || (status === 'all' && applied.status === 'all') ? ' is-active' : ''}`}
                  onClick={() => chooseStatus(status)}
                >
                  <span className="phone-sort__icon">{icon}</span>
                  <strong>{count}</strong>
                  <em>{label}</em>
                </button>
              ))}
              <div className="phone-sort__duration" aria-label="Talk time">
                <span><em>IN</em><strong>{formatTalk(stats.inboundSeconds)}</strong></span>
                <span><em>OUT</em><strong>{formatTalk(stats.outboundSeconds)}</strong></span>
                <span><em>Total</em><strong>{formatTalk(stats.totalSeconds)}</strong></span>
              </div>
            </div>
            {error ? <p className="call-page__error">{error}</p> : null}
            <div className="call-list">
              <div className="call-list__head">
                <span>When</span>
                <span>Caller Details</span>
                <span>Status</span>
              </div>
              {rows.length === 0 ? (
                <p className="call-page__empty-inline">No calls match these filters.</p>
              ) : pageRows.map((row, index) => {
                const serial = String(safePage * CALL_PAGE_SIZE + index + 1).padStart(2, '0');
                const when = whenParts(row.occurred);
                const party = remoteParty(row.event);
                const local = national10(party);
                const e164 = indiaE164(party);
                const openMissed = isOpenMissed(row);
                const showWhatsApp = isIndianMobile(party) || waDigits.has(local);
                const tel = e164 ? `tel:+${e164}` : '';
                const whatsApp = e164
                  ? `https://wa.me/${e164}${openMissed ? `?text=${encodeURIComponent(MISSED_FOLLOW_UP_TEXT)}` : ''}`
                  : '';
                const numberHref = openMissed && showWhatsApp ? whatsApp : tel;
                const handler = row.event.employeeName || row.event.agent;
                const type = callTypeFromEvent(row.event);
                const recording = /^https?:\/\//i.test(row.event.recordingUrl);
                const showActions = row.status === 'received' && recording;
                const thisPlaying = playingId === row.event.id && playing;
                return (
                  <article
                    key={row.event.id}
                    className={`call-row${openMissed ? ' is-open-missed' : ''}`}
                    onClick={event => {
                      if (!openMissed) return;
                      const target = event.target as HTMLElement;
                      if (target.closest('a,button')) return;
                      followUp(row.event);
                    }}
                  >
                    <div className="call-row__when">
                      <strong>{serial}</strong>
                      <span>{when.date}</span>
                      <time>{when.time}</time>
                    </div>
                    <div className="call-row__caller">
                      <div className="call-row__phone">
                        {tel ? (
                          <a
                            className="call-row__chip"
                            href={tel}
                            aria-label="Call"
                            onClick={() => {
                              if (openMissed) followUp(row.event);
                            }}
                          >
                            <Phone size={15} />
                          </a>
                        ) : null}
                        {showWhatsApp && whatsApp ? (
                          <a
                            className="call-row__chip call-row__chip--wa"
                            href={whatsApp}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="WhatsApp"
                            onClick={() => {
                              if (openMissed) followUp(row.event);
                            }}
                          >
                            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                              <path fill="currentColor" d="M12 3.2A8.7 8.7 0 0 0 4.6 16.4L3.4 20.6l4.3-1.1A8.7 8.7 0 1 0 12 3.2Zm4.9 12.3c-.2.6-1.2 1.1-1.6 1.1-.4.1-.9.1-1.5-.1-.3-.1-.8-.3-1.3-.5-2.3-1-3.8-3.4-3.9-3.5-.1-.2-.9-1.2-.9-2.3s.6-1.6.8-1.8c.2-.2.4-.3.6-.3h.4c.1 0 .3 0 .4.3.2.5.6 1.6.6 1.7.1.1 0 .3-.1.4l-.3.4c-.1.1-.2.2-.1.4.1.2.6 1 1.3 1.6.9.8 1.6 1 1.8 1.1.2.1.3.1.4-.1l.5-.6c.1-.2.3-.1.5-.1.2.1 1.3.6 1.5.7.2.1.3.2.4.3.1.2.1.6-.1 1.2Z" />
                            </svg>
                          </a>
                        ) : null}
                        {numberHref ? (
                          <a
                            className="call-row__number"
                            href={numberHref}
                            target={numberHref.startsWith('http') ? '_blank' : undefined}
                            rel="noreferrer"
                            onClick={() => {
                              if (openMissed) followUp(row.event);
                            }}
                          >
                            {formatCallerNumber(party, desktop)}
                            {row.event.missedFollowedUpBy ? <span> ({row.event.missedFollowedUpBy})</span> : null}
                          </a>
                        ) : (
                          <span className="call-row__number">{formatCallerNumber(party, desktop)}</span>
                        )}
                      </div>
                      {row.event.callerName ? <p className="call-row__party">{row.event.callerName}</p> : null}
                      {handler ? <p className="call-row__agent">{handler}</p> : null}
                      {row.event.tower?.place ? (
                        row.event.tower.lat != null && row.event.tower.lng != null ? (
                          <a
                            className="call-row__tower"
                            href={`https://www.google.com/maps?q=${row.event.tower.lat},${row.event.tower.lng}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.event.tower.place}
                          </a>
                        ) : <p className="call-row__tower">{row.event.tower.place}</p>
                      ) : null}
                      <div className="call-row__meta">
                        {type ? (
                          <span className={`call-row__dept is-${type}`}>
                            <i />
                            {type === 'sales' ? 'Sales' : 'Service'}
                          </span>
                        ) : null}
                        {row.event.agent ? <span className="call-row__attended">Attended by {row.event.agent}</span> : null}
                      </div>
                    </div>
                    <div className="call-row__status">
                      <span className={`call-row__pill is-${row.status}${row.event.missedFollowedUp ? ' is-attended' : ''}`}>
                        {statusWord(row.status, row.repeatCount)}
                      </span>
                      <time>
                        {row.status === 'missed'
                          ? formatElapsed(row.occurred, now)
                          : formatTalk(row.event.durationSeconds)}
                      </time>
                      {showActions ? (
                        <div className="call-row__actions">
                          <button
                            type="button"
                            className="call-row__transcript"
                            aria-label="Transcript"
                            onClick={() => setOpenTranscript(current => current === row.event.id ? '' : row.event.id)}
                          >
                            <TranscriptIcon />
                          </button>
                          <button
                            type="button"
                            className="call-row__play"
                            aria-label={thisPlaying ? 'Pause' : 'Play'}
                            onClick={() => togglePlay(row)}
                          >
                            {thisPlaying ? <Pause size={14} /> : <Play size={14} />}
                          </button>
                          {playingId === row.event.id ? (
                            <>
                              {([1, 1.5, 2] as const).map(value => (
                                <button
                                  key={value}
                                  type="button"
                                  className={`call-row__rate${rate === value ? ' is-on' : ''}`}
                                  onClick={() => {
                                    setRate(value);
                                    if (audioRef.current) audioRef.current.playbackRate = value;
                                  }}
                                >
                                  X{value}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="call-row__stop"
                                aria-label="Stop"
                                onClick={() => {
                                  audioRef.current?.pause();
                                  if (audioRef.current) audioRef.current.currentTime = 0;
                                  setPlayingId('');
                                }}
                              >
                                <Square size={12} />
                              </button>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {openTranscript === row.event.id ? (
                      <div className="call-transcript">
                        {row.event.transcriptTurns.length ? row.event.transcriptTurns.map((turn, turnIndex) => (
                          <p key={`${turn.speaker}-${turnIndex}`} className={`is-${turn.speaker}`}>
                            <strong>{turn.speaker === 'agent' ? 'Agent' : 'Customer'}</strong>
                            {turn.text}
                          </p>
                        )) : (
                          <p>{row.event.transcript || row.event.malayalamText || 'No transcript for this call.'}</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {rows.length > CALL_PAGE_SIZE ? (
                <footer className="call-list__pager">
                  <span>
                    {safePage * CALL_PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * CALL_PAGE_SIZE)} of {rows.length}
                  </span>
                  <button type="button" aria-label="Previous page" disabled={safePage <= 0} onClick={() => setPage(current => Math.max(0, current - 1))}>
                    <ChevronLeft size={16} />
                  </button>
                  <button type="button" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(current => current + 1)}>
                    <ChevronRight size={16} />
                  </button>
                </footer>
              ) : null}
            </div>
          </div>
          {desktop ? (
            <aside className="phone-rail">
              <h2>Filter</h2>
              {filters}
            </aside>
          ) : null}
        </div>
      )}
      {sheetOpen && !desktop ? createPortal(
        <div className="phone-sheet" role="presentation" onClick={() => setSheetOpen(false)}>
          <div
            className="phone-sheet__panel"
            role="dialog"
            aria-label="Filter"
            onClick={event => event.stopPropagation()}
          >
            <header>
              <strong>Filter</strong>
              <button type="button" aria-label="Close filters" onClick={() => setSheetOpen(false)}>
                <X size={18} />
              </button>
            </header>
            {filters}
            {activeFilterCount(draft) ? <p className="phone-filter__count">{activeFilterCount(draft)} active</p> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
};
