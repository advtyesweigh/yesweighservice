import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock } from 'lucide-react';

type Face = 'hour' | 'minute';

function parseTime(value: string): { hour24: number; minute: number } {
  const [rawHour, rawMinute] = value.split(':');
  const hour24 = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour24: Number.isFinite(hour24) ? ((hour24 % 24) + 24) % 24 : 9,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function hour12From24(hour24: number): number {
  const hour = hour24 % 12;
  return hour === 0 ? 12 : hour;
}

export function RoundClockPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { hour24, minute } = parseTime(value);
  const [open, setOpen] = useState(false);
  const [face, setFace] = useState<Face>('hour');
  const afternoon = hour24 >= 12;
  const hour12 = hour12From24(hour24);

  const marks = useMemo(
    () => (face === 'hour'
      ? Array.from({ length: 12 }, (_, index) => (index === 0 ? 12 : index))
      : Array.from({ length: 12 }, (_, index) => index * 5)),
    [face],
  );

  const selected = face === 'hour' ? hour12 : Math.round(minute / 5) * 5 % 60;
  const angle = ((face === 'hour' ? hour12 % 12 : selected / 5) / 12) * 360;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const openClock = () => {
    setFace('hour');
    setOpen(true);
  };

  const pick = (mark: number) => {
    if (face === 'hour') {
      const nextHour = afternoon ? (mark === 12 ? 12 : mark + 12) : (mark === 12 ? 0 : mark);
      onChange(`${pad(nextHour)}:${pad(minute)}`);
      setFace('minute');
      return;
    }
    onChange(`${pad(hour24)}:${pad(mark)}`);
    setOpen(false);
  };

  const setAfternoon = (nextAfternoon: boolean) => {
    const base = hour24 % 12;
    const nextHour = nextAfternoon ? (base === 0 ? 12 : base + 12) : base;
    onChange(`${pad(nextHour)}:${pad(minute)}`);
  };

  return (
    <>
      <button
        type="button"
        className="input-field round-clock-trigger"
        onClick={openClock}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Clock size={16} aria-hidden />
        <span>{pad(hour12)}:{pad(minute)} {afternoon ? 'PM' : 'AM'}</span>
      </button>
      {open
        ? createPortal(
            <div className="round-clock-overlay" onClick={() => setOpen(false)} role="presentation">
              <div
                className="round-clock-popup"
                role="dialog"
                aria-modal="true"
                aria-label="Pick a time"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="round-clock">
                  <div className="round-clock__readout" role="group" aria-label="Selected time">
                    <button
                      type="button"
                      className={`round-clock__part${face === 'hour' ? ' is-active' : ''}`}
                      onClick={() => setFace('hour')}
                    >
                      {pad(hour12)}
                    </button>
                    <span>:</span>
                    <button
                      type="button"
                      className={`round-clock__part${face === 'minute' ? ' is-active' : ''}`}
                      onClick={() => setFace('minute')}
                    >
                      {pad(minute)}
                    </button>
                    <div className="round-clock__ampm">
                      <button type="button" className={!afternoon ? 'is-active' : ''} onClick={() => setAfternoon(false)}>AM</button>
                      <button type="button" className={afternoon ? 'is-active' : ''} onClick={() => setAfternoon(true)}>PM</button>
                    </div>
                  </div>
                  <div className="round-clock__face" role="group" aria-label={face === 'hour' ? 'Hours' : 'Minutes'}>
                    <span className="round-clock__hand" style={{ transform: `rotate(${angle}deg)` }} />
                    <span className="round-clock__hub" />
                    {marks.map((mark) => {
                      const slot = face === 'hour' ? mark % 12 : mark / 5;
                      const deg = (slot / 12) * 360;
                      return (
                        <button
                          key={`${face}-${mark}`}
                          type="button"
                          className={`round-clock__mark${mark === selected ? ' is-selected' : ''}`}
                          style={{ transform: `rotate(${deg}deg) translateY(-5.35rem) rotate(-${deg}deg)` }}
                          onClick={() => pick(mark)}
                        >
                          {face === 'minute' ? pad(mark) : mark}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button type="button" className="btn btn-primary round-clock-popup__done" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
