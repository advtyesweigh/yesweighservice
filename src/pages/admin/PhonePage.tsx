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
  attendedName,
  formatCallerNumber,
  formatElapsed,
  formatTalk,
  formatTowerLocation,
  handlerName,
  indiaE164,
  isIndianMobile,
  isOpenMissed,
  national10,
  preFilterEvents,
  remoteParty,
  towerMapsHref,
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
    <svg width="15" height="15" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="3.2" y="3.4" width="5.6" height="9.2" rx="2.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.6 10.2a2.4 2.6 0 0 0 4.8 0" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 15.2v2.1M4.2 17.3h3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="11.4" y="11.2" width="1.5" height="4.6" rx="0.6" fill="currentColor" />
      <rect x="13.8" y="8.8" width="1.5" height="7" rx="0.6" fill="currentColor" />
      <rect x="16.2" y="10.2" width="1.5" height="5.6" rx="0.6" fill="currentColor" />
      <path d="M19.2 12.2h2.8M20.6 10.7 22.4 12.2 20.6 13.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24.2 6.2h2.6L29.4 9v10.2a1.3 1.3 0 0 1-1.3 1.3h-5.2a1.3 1.3 0 0 1-1.3-1.3V7.5c0-.7.6-1.3 1.3-1.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M24.4 12.4h3.4M24.4 14.6h3.4M24.4 16.8h2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
      const name = handlerName(event);
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
            <section className="phone-sort" aria-label="Sort calls">
              <button type="button" className={`phone-sort__tile${applied.status === 'all' ? ' is-active' : ''}`} onClick={() => chooseStatus('all')}>
                <span className="phone-sort__icon phone-sort__icon--total"><Phone size={16} /></span>
                <strong className="phone-sort__count">{stats.total}</strong>
                <span className="phone-sort__label">Total</span>
              </button>
              <button type="button" className={`phone-sort__tile${applied.status === 'missed' ? ' is-active' : ''}`} onClick={() => chooseStatus('missed')}>
                <span className="phone-sort__icon phone-sort__icon--missed"><PhoneMissed size={16} /></span>
                <strong className="phone-sort__count">{stats.missed}</strong>
                <span className="phone-sort__label">Missed</span>
              </button>
              <button type="button" className={`phone-sort__tile${applied.status === 'received' ? ' is-active' : ''}`} onClick={() => chooseStatus('received')}>
                <span className="phone-sort__icon phone-sort__icon--received"><PhoneIncoming size={16} /></span>
                <strong className="phone-sort__count">{stats.received}</strong>
                <span className="phone-sort__label">Received</span>
              </button>
              <button type="button" className={`phone-sort__tile${applied.status === 'outbound' ? ' is-active' : ''}`} onClick={() => chooseStatus('outbound')}>
                <span className="phone-sort__icon phone-sort__icon--outbound"><PhoneOutgoing size={16} /></span>
                <strong className="phone-sort__count">{stats.outbound}</strong>
                <span className="phone-sort__label">Outbound</span>
              </button>
              <div
                className="phone-sort__tile phone-sort__tile--duration"
                aria-label={`Duration in ${formatTalk(stats.inboundSeconds)}, out ${formatTalk(stats.outboundSeconds)}, total ${formatTalk(stats.totalSeconds)}`}
              >
                <span className="phone-sort__durations">
                  <span className="phone-sort__dur phone-sort__dur--in"><em>IN</em><strong>{formatTalk(stats.inboundSeconds)}</strong></span>
                  <span className="phone-sort__dur phone-sort__dur--out"><em>OUT</em><strong>{formatTalk(stats.outboundSeconds)}</strong></span>
                  <span className="phone-sort__dur phone-sort__dur--total"><em>Total</em><strong>{formatTalk(stats.totalSeconds)}</strong></span>
                </span>
              </div>
            </section>
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
                const followHref = openMissed ? (showWhatsApp ? whatsApp : tel) : '';
                const followedBy = row.event.missedFollowedUpBy.trim();
                const handler = handlerName(row.event);
                const attended = attendedName(row.event, row.status);
                const type = callTypeFromEvent(row.event);
                const recording = /^https?:\/\//i.test(row.event.recordingUrl);
                const showActions = row.status === 'received' && recording;
                const thisPlaying = playingId === row.event.id && playing;
                const numberLabel = formatCallerNumber(party, !desktop);
                const numberClass = `call-row__number${openMissed ? ' is-missed-open' : ''}`;
                const towerLabel = formatTowerLocation(row.event.tower);
                const mapsHref = towerMapsHref(row.event.tower);
                const missedSince = row.status === 'missed' ? formatElapsed(row.occurred, now) : '';
                const turns = row.event.transcriptTurns;
                const roles = new Set(turns.map(turn => turn.speaker));
                const hasDialogue = roles.has('agent') && roles.has('customer');
                const markFollowUp = () => {
                  if (openMissed) followUp(row.event);
                };
                const numberNode = openMissed && followHref ? (
                  <a
                    className={`${numberClass} call-row__number-link`}
                    href={followHref}
                    target={showWhatsApp ? '_blank' : undefined}
                    rel={showWhatsApp ? 'noreferrer' : undefined}
                    onClick={event => {
                      event.stopPropagation();
                      markFollowUp();
                    }}
                  >
                    {numberLabel}
                  </a>
                ) : (
                  <strong className={numberClass}>{numberLabel}</strong>
                );
                return (
                  <React.Fragment key={row.event.id}>
                    <article
                      className={`call-row${openMissed ? ' is-missed-open' : ''}`}
                      onClick={event => {
                        if (!openMissed) return;
                        const target = event.target as HTMLElement;
                        if (target.closest('a,button')) return;
                        followUp(row.event);
                      }}
                    >
                      <div className="call-row__lead">
                        <span className="call-row__sl">{serial}</span>
                        <strong className="call-row__day">{when.date}</strong>
                        <span className="call-row__clock">{when.time}</span>
                      </div>
                      <div className="call-row__caller">
                        <div className="call-row__phone">
                          {party ? (
                            <>
                              {tel ? (
                                <a className="call-row__call" href={tel} aria-label="Call number" onClick={markFollowUp}>
                                  <Phone size={14} />
                                </a>
                              ) : null}
                              {showWhatsApp && whatsApp ? (
                                <a
                                  className="call-row__wa"
                                  href={whatsApp}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label="Open WhatsApp"
                                  onClick={event => {
                                    event.stopPropagation();
                                    markFollowUp();
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                                    <path fill="currentColor" d="M12 3.2A8.7 8.7 0 0 0 4.6 16.4L3.4 20.6l4.3-1.1A8.7 8.7 0 1 0 12 3.2Zm4.9 12.3c-.2.6-1.2 1.1-1.6 1.1-.4.1-.9.1-1.5-.1-.3-.1-.8-.3-1.3-.5-2.3-1-3.8-3.4-3.9-3.5-.1-.2-.9-1.2-.9-2.3s.6-1.6.8-1.8c.2-.2.4-.3.6-.3h.4c.1 0 .3 0 .4.3.2.5.6 1.6.6 1.7.1.1 0 .3-.1.4l-.3.4c-.1.1-.2.2-.1.4.1.2.6 1 1.3 1.6.9.8 1.6 1 1.8 1.1.2.1.3.1.4-.1l.5-.6c.1-.2.3-.1.5-.1.2.1 1.3.6 1.5.7.2.1.3.2.4.3.1.2.1.6-.1 1.2Z" />
                                  </svg>
                                </a>
                              ) : null}
                              <span className="call-row__number-wrap">
                                <span className="call-row__number-line">
                                  {numberNode}
                                  {followedBy ? <span className="call-row__followed">({followedBy})</span> : null}
                                </span>
                              </span>
                            </>
                          ) : (
                            <strong className="call-row__number">—</strong>
                          )}
                        </div>
                        {row.event.callerName ? <span className="call-row__party">{row.event.callerName}</span> : null}
                        {handler ? <span className="call-row__agent">{handler}</span> : null}
                        {towerLabel ? (
                          mapsHref ? (
                            <a
                              className="call-row__tower"
                              href={mapsHref}
                              target="_blank"
                              rel="noreferrer"
                              onClick={event => event.stopPropagation()}
                            >
                              {towerLabel}
                            </a>
                          ) : <span className="call-row__tower">{towerLabel}</span>
                        ) : null}
                        {type || attended ? (
                          <span className="call-row__meta">
                            {type ? (
                              <span className="call-row__dept-line">
                                <span className={`call-row__dept call-row__dept--${type}`}>
                                  {type === 'sales' ? 'Sales' : 'Service'}
                                </span>
                              </span>
                            ) : null}
                            {attended ? <span className="call-row__attended">{attended}</span> : null}
                          </span>
                        ) : null}
                      </div>
                      <div className="call-row__rail">
                        <div className="call-row__status-col">
                          <span className={`call-row__status call-row__status--${row.status}${row.status === 'missed' && !openMissed ? ' is-attended' : ''}`}>
                            {statusWord(row.status, row.repeatCount)}
                          </span>
                          {missedSince ? (
                            <span className="call-row__since">{missedSince}</span>
                          ) : row.status === 'received' || row.status === 'outbound' ? (
                            <span className="call-row__duration">{formatTalk(row.event.durationSeconds)}</span>
                          ) : null}
                        </div>
                        {showActions ? (
                          <div className="call-row__actions">
                            <button
                              type="button"
                              className={`call-row__play call-row__play--transcript${openTranscript === row.event.id ? ' is-open' : ''}`}
                              aria-label="Call transcript"
                              aria-pressed={openTranscript === row.event.id}
                              onClick={event => {
                                event.stopPropagation();
                                setOpenTranscript(current => current === row.event.id ? '' : row.event.id);
                              }}
                            >
                              <TranscriptIcon />
                            </button>
                            {thisPlaying ? (
                              <button type="button" className="call-row__play" aria-label="Pause recording" onClick={event => { event.stopPropagation(); togglePlay(row); }}>
                                <Pause size={13} fill="currentColor" />
                              </button>
                            ) : (
                              <button type="button" className="call-row__play" aria-label="Play recording" onClick={event => { event.stopPropagation(); togglePlay(row); }}>
                                <Play size={13} fill="currentColor" />
                              </button>
                            )}
                            {playingId === row.event.id ? (
                              <>
                                {([1, 1.5, 2] as const).map(value => (
                                  <button
                                    key={value}
                                    type="button"
                                    className={`call-row__speed${rate === value ? ' is-active' : ''}`}
                                    aria-pressed={rate === value}
                                    onClick={event => {
                                      event.stopPropagation();
                                      setRate(value);
                                      if (audioRef.current) audioRef.current.playbackRate = value;
                                    }}
                                  >
                                    X{value}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className="call-row__play call-row__play--stop"
                                  aria-label="Stop recording"
                                  onClick={event => {
                                    event.stopPropagation();
                                    audioRef.current?.pause();
                                    if (audioRef.current) audioRef.current.currentTime = 0;
                                    setPlayingId('');
                                  }}
                                >
                                  <Square size={11} fill="currentColor" />
                                </button>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                    {openTranscript === row.event.id ? (
                      <div className="call-transcript" role="note">
                        {hasDialogue ? turns.map((turn, turnIndex) => (
                          <div key={`${turn.speaker}-${turnIndex}`} className={`call-transcript__turn call-transcript__turn--${turn.speaker}`}>
                            <p className="call-transcript__line">{turn.text}</p>
                          </div>
                        )) : row.event.transcriptSingleSpeaker ? (
                          <>
                            <p className="call-transcript__status">Only one speaker was detected.</p>
                            <p className="call-transcript__text">{row.event.malayalamText || row.event.transcript}</p>
                          </>
                        ) : (
                          <p className="call-transcript__text">{row.event.transcript || row.event.malayalamText || 'No transcript for this call.'}</p>
                        )}
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })}
              {rows.length > CALL_PAGE_SIZE ? (
                <nav className="call-pager" aria-label="Call list pages">
                  <span className="call-pager__meta">
                    {safePage * CALL_PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * CALL_PAGE_SIZE)} of {rows.length}
                  </span>
                  <div className="call-pager__nav">
                    <button type="button" className="call-pager__btn" aria-label="Previous page" disabled={safePage <= 0} onClick={() => setPage(current => Math.max(0, current - 1))}>
                      <ChevronLeft size={16} />
                    </button>
                    <button type="button" className="call-pager__btn" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(current => current + 1)}>
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </nav>
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
