import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  SOFTWARE_TZ_INDIA,
  SOFTWARE_TZ_UAE,
  defaultShopPoc,
  formatShopDateTime,
  instantToZoneParts,
  isWeighvoxSource,
  saveSoftwareShopTrainingSchedule,
  subscribeSoftwareShopTrainings,
  zonePartsToIso,
} from '../../lib/softwareShops';
import type { SoftwareShop, SoftwareShopTraining } from '../../types/software-shop';
import { RoundClockPicker } from './RoundClockPicker';

function nextHourParts(timeZone: string): { date: string; time: string } {
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const parts = instantToZoneParts(soon.toISOString(), timeZone);
  const [hour] = parts.time.split(':');
  return { date: parts.date, time: `${hour}:00` };
}

export function ScheduleTrainingSheet({
  shop,
  actorName,
  actorUid,
  onClose,
}: {
  shop: SoftwareShop;
  actorName: string;
  actorUid: string;
  onClose: () => void;
}) {
  const weighvox = isWeighvoxSource(shop.sourceAccount);
  const inputZone = weighvox ? SOFTWARE_TZ_UAE : SOFTWARE_TZ_INDIA;
  const existing = shop.trainingScheduledAt
    ? instantToZoneParts(shop.trainingScheduledAt, inputZone)
    : nextHourParts(inputZone);
  const poc = defaultShopPoc(shop);
  const [date, setDate] = useState(existing.date);
  const [time, setTime] = useState(existing.time);
  const [pocName, setPocName] = useState(poc.name);
  const [ownerPhone, setOwnerPhone] = useState(poc.ownerPhone);
  const [pocPhone, setPocPhone] = useState(poc.pocPhone);
  const [username, setUsername] = useState(poc.username);
  const [password, setPassword] = useState(poc.password);
  const [trainingPoints, setTrainingPoints] = useState('');
  const [logs, setLogs] = useState<SoftwareShopTraining[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => subscribeSoftwareShopTrainings(shop.id, setLogs, () => undefined), [shop.id]);

  const scheduledAt = useMemo(() => zonePartsToIso(date, time, inputZone), [date, inputZone, time]);
  const indiaText = scheduledAt ? formatShopDateTime(scheduledAt, SOFTWARE_TZ_INDIA) : '';
  const uaeText = scheduledAt ? formatShopDateTime(scheduledAt, SOFTWARE_TZ_UAE) : '';

  const save = async () => {
    setError('');
    if (!scheduledAt) {
      setError('Pick a date and time.');
      return;
    }
    if (!pocName.trim() || !ownerPhone.trim()) {
      setError('POC name and owner mobile are required.');
      return;
    }
    if (!username.trim() || !password.trim()) {
      setError('User ID and password are required for support.');
      return;
    }
    setSaving(true);
    try {
      await saveSoftwareShopTrainingSchedule(shop.id, {
        scheduledAt,
        userId: actorUid,
        userName: actorName,
        pocName: pocName.trim(),
        ownerPhone: ownerPhone.trim(),
        pocPhone: pocPhone.trim(),
        supportUsername: username.trim(),
        supportPassword: password.trim(),
        trainingPoints: trainingPoints.trim(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this schedule.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="software-modal-backdrop" onClick={saving ? undefined : onClose} role="presentation">
      <div
        className="software-modal software-schedule"
        role="dialog"
        aria-modal="true"
        aria-labelledby="software-schedule-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="software-modal__head">
          <div className="software-modal__head-main">
            <h2 id="software-schedule-title">Schedule training</h2>
          </div>
          <button type="button" className="software-modal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="software-modal__body">
          <p className="software-schedule__shop">{shop.name || `Shop ${shop.shopId}`}</p>
          <div className="software-schedule-form">
            <label>
              {weighvox ? 'UAE date' : 'Date'}
              <input
                className="input-field"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <div className="software-schedule-clock">
              <span className="software-schedule-clock__label">{weighvox ? 'UAE time' : 'Time'}</span>
              <RoundClockPicker value={time} onChange={setTime} />
            </div>
            <div className="software-schedule-times">
              <p><span>India</span> {indiaText || '—'}</p>
              {weighvox ? <p><span>UAE</span> {uaeText || '—'}</p> : null}
            </div>
            <h3>Point of contact</h3>
            <label>
              POC name
              <input className="input-field" value={pocName} onChange={(event) => setPocName(event.target.value)} />
            </label>
            <label>
              Owner mobile
              <input className="input-field" inputMode="tel" value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} />
            </label>
            <label>
              POC mobile
              <input className="input-field" inputMode="tel" value={pocPhone} onChange={(event) => setPocPhone(event.target.value)} />
            </label>
            <h3>Support login</h3>
            <label>
              User ID
              <input className="input-field" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
            </label>
            <label>
              Password
              <input className="input-field" type="text" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
            </label>
            <label className="software-schedule-points">
              Training points
              <textarea
                className="input-field"
                value={trainingPoints}
                onChange={(event) => setTrainingPoints(event.target.value)}
                rows={5}
                placeholder="Topics to cover in this training"
              />
            </label>
          </div>
          {error ? <p className="software-create-error">{error}</p> : null}
          {logs.length ? (
            <div className="software-training-logs software-training-logs--sheet">
              <h3>Training logs</h3>
              <ul className="software-follow__list">
                {logs.map((item) => (
                  <li key={item.id}>
                    <div className="software-follow__item-top">
                      <strong>{item.userName || 'Training'}</strong>
                      <time>
                        {weighvox && item.scheduledAt
                          ? `${formatShopDateTime(item.scheduledAt, SOFTWARE_TZ_UAE)} UAE`
                          : formatShopDateTime(item.scheduledAt, SOFTWARE_TZ_INDIA)}
                      </time>
                    </div>
                    {item.trainingPoints ? <p className="software-training-points">{item.trainingPoints}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <footer className="software-modal__foot software-create__foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Schedule'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
