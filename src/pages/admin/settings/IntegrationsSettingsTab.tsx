import React, { useEffect, useState } from 'react';
import { Check, Copy, Phone } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { FIRM_NAME, FIRM_PHONE } from '../../../constants/brand';
import { useAuth } from '../../../context/AuthContext';
import { copyTextToClipboard } from '../../../lib/clipboard';
import { COMPANY_DID } from '../../../lib/phoneLog';
import { canSuperAdminWrite } from '../../../lib/staffAccess';
import {
  formatWhatsAppNumber,
  loadWhatsAppSettings,
  saveWhatsAppSettings,
  type WhatsAppPhoneChoice,
  type WhatsAppSettings,
} from '../../../lib/whatsappInbox';
import '../../../whatsapp-inbox.css';

const DEFAULT_WABA_ID = '935267172861360';
const DEFAULT_PHONE_NUMBER_ID = '1288718687667400';
const VOXBAY_WEBHOOK_URL = 'https://asia-south1-yesweigh-service.cloudfunctions.net/ingestVoxbayCall';

function trunkLabel(digits: string): string {
  if (digits === COMPANY_DID) return '0484 712 3223';
  return digits;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyTextToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="yesgatc-webhook__field">
      <span>{label}</span>
      <div className="yesgatc-webhook__copy-row">
        <input readOnly value={value} onFocus={event => event.currentTarget.select()} />
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="integration-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WhatsAppIntegration() {
  const { user } = useAuth();
  const canWrite = canSuperAdminWrite(user);
  const [settings, setSettings] = useState<WhatsAppSettings | null>(null);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [wabaId, setWabaId] = useState(DEFAULT_WABA_ID);
  const [phoneNumberId, setPhoneNumberId] = useState(DEFAULT_PHONE_NUMBER_ID);
  const [phones, setPhones] = useState<WhatsAppPhoneChoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadWhatsAppSettings()
      .then(next => {
        if (cancelled) return;
        setSettings(next);
        setWabaId(next.wabaId || DEFAULT_WABA_ID);
        setPhoneNumberId(next.phoneNumberId || DEFAULT_PHONE_NUMBER_ID);
        setPhones(next.phones ?? []);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load WhatsApp.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setNote('');
    setError('');
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
      setNote(next.needsPhoneChoice
        ? 'Choose the phone number for this inbox.'
        : next.webhookSubscribed
          ? 'WhatsApp connected.'
          : (next.webhookDetail || 'Saved.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save WhatsApp.');
    } finally {
      setSaving(false);
    }
  };

  if (!settings && !error) return <p className="settings-locations__loading">Loading WhatsApp…</p>;

  return (
    <div className="yesgatc-webhook">
      <h4>Meta WhatsApp</h4>
      <div className="integration-facts">
        <Fact label="Status" value={settings?.configured ? 'Connected' : 'Not connected'} />
        <Fact label="Account" value={settings?.accountName || FIRM_NAME} />
        <Fact label="Number" value={formatWhatsAppNumber(settings?.displayPhoneNumber || FIRM_PHONE)} />
        <Fact label="Business account" value={settings?.wabaId || DEFAULT_WABA_ID} />
        <Fact label="Phone number ID" value={settings?.phoneNumberId || DEFAULT_PHONE_NUMBER_ID} />
        <Fact label="Access token" value={settings?.hasAccessToken ? 'Saved' : 'Missing'} />
        <Fact label="App secret" value={settings?.hasAppSecret ? 'Saved' : 'Missing'} />
        <Fact label="Webhook" value={settings?.webhookSubscribed ? 'Subscribed' : 'Not subscribed'} />
      </div>
      {settings?.webhookUrl ? <CopyField label="Webhook URL" value={settings.webhookUrl} /> : null}
      {settings?.verifyToken ? <CopyField label="Verify token" value={settings.verifyToken} /> : null}
      <form className="wa-inbox-setup integration-form" onSubmit={onSave}>
        <h2>{settings?.configured ? 'Replace credentials' : 'Connect Meta WhatsApp'}</h2>
        <p>Cloud API credentials for {FIRM_NAME}. Tokens stay on the server.</p>
        <label>
          Access token
          <input
            type="password"
            autoComplete="off"
            value={token}
            disabled={!canWrite}
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
            disabled={!canWrite}
            onChange={event => setAppSecret(event.target.value)}
            placeholder={settings?.hasAppSecret ? 'Saved — paste only to replace' : 'App settings → Basic'}
          />
        </label>
        <label>
          WhatsApp Business Account ID
          <input
            value={wabaId}
            disabled={!canWrite}
            onChange={event => setWabaId(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label>
          Phone number ID
          <input
            value={phoneNumberId}
            disabled={!canWrite}
            onChange={event => setPhoneNumberId(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
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
                  disabled={!canWrite}
                  checked={phoneNumberId === phone.id}
                  onChange={() => setPhoneNumberId(phone.id)}
                />
                <span>{phone.verifiedName || 'WhatsApp'} {phone.displayPhoneNumber}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p className="settings-locations__error">{error}</p> : null}
        {note ? <p className="text-muted text-sm">{note}</p> : null}
        <div className="wa-inbox-setup__actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !canWrite}>
            {saving ? 'Saving…' : settings?.configured ? 'Save' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

function VoxbayIntegration() {
  return (
    <div className="yesgatc-webhook">
      <h4>Voxbay</h4>
      <div className="integration-facts">
        <Fact label="Status" value="Webhook registered" />
        <Fact label="Configuration" value="YesWeigh Phone" />
        <Fact label="Trunk" value={trunkLabel(COMPANY_DID)} />
        <Fact label="Events" value="Start, connect, end, CDR, keypad" />
      </div>
      <CopyField label="Webhook URL" value={VOXBAY_WEBHOOK_URL} />
      <p className="text-muted text-sm">
        Voxbay posts call events for {trunkLabel(COMPANY_DID)} to this URL. Calls then show on the Phone page.
      </p>
    </div>
  );
}

export const IntegrationsSettingsTab: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const section = params.get('section') === 'voxbay' ? 'voxbay' : 'whatsapp';

  const choose = (next: 'whatsapp' | 'voxbay') => {
    const query = new URLSearchParams(params);
    query.set('section', next);
    setParams(query, { replace: true });
  };

  return (
    <section className="settings-locations panel glass">
      <header className="settings-locations__header">
        <h3>Integration</h3>
      </header>
      <nav className="integration-tabs" aria-label="Integrations">
        <button type="button" className={section === 'whatsapp' ? 'is-active' : ''} onClick={() => choose('whatsapp')}>
          WhatsApp
        </button>
        <button type="button" className={section === 'voxbay' ? 'is-active' : ''} onClick={() => choose('voxbay')}>
          <Phone size={15} />
          Voxbay
        </button>
      </nav>
      {section === 'whatsapp' ? <WhatsAppIntegration /> : <VoxbayIntegration />}
    </section>
  );
};
