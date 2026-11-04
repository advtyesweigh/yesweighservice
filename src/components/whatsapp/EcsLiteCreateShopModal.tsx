import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Loader2, QrCode, X } from 'lucide-react';
import {
  ECS_LITE_DEFAULT_DEVICE_NAME,
  ECS_LITE_DEFAULT_PASSWORD,
  ecsLiteCallableErrorMessage,
  ecsLitePrefillFromSoftwareShop,
  listEcsLiteCreateShopOptions,
  normalizeEcsMacInput,
  submitEcsLitePendingShop,
  verifyEcsLiteMac,
  type EcsLiteCountry,
  type EcsLiteLicenseKey,
  type EcsLitePendingShopResult,
  type EcsLiteZohoInvoiceStatus,
} from '../../lib/ecsLiteCreateShop';
import { resolveSoftwareShopForRenewal } from '../../lib/softwareShops';

type Props = {
  open: boolean;
  onClose: () => void;
  defaultPhone?: string;
  /** Software shop id linked to this WhatsApp chat (same as Software attach). */
  softwareShopId?: number;
  /** Chat / cached shop label when Software row is still loading. */
  softwareShopName?: string;
};

/** UI phases after Create Shop is clicked. */
type SubmitPhase =
  | 'idle'
  | 'ecs_working'
  | 'ecs_done'
  | 'zoho_working'
  | 'complete'
  | 'failed';

type ZohoUiResult = {
  status: EcsLiteZohoInvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  invoiceAmount: number | null;
  zohoError: string | null;
};

function phoneDigitsOnly(value: string) {
  return value.replace(/\D/g, '').slice(0, 15);
}

function keyDisplayLabel(key: EcsLiteLicenseKey) {
  const preview = key.preview || key.id;
  return key.poNumber ? `${preview} · ${key.poNumber}` : preview;
}

function formatInvoiceAmount(amount: number | null | undefined): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const rounded = Math.round(amount * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString('en-IN')
    : rounded.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₹${text}`;
}

function formatInvoiceDate(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return raw;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function ClockSpinner({ label }: { label: string }) {
  return (
    <div className="wa-ecs-clock" role="status" aria-live="polite" aria-label={label}>
      <span className="wa-ecs-clock__face" aria-hidden="true">
        <span className="wa-ecs-clock__hand wa-ecs-clock__hand--hour" />
        <span className="wa-ecs-clock__hand wa-ecs-clock__hand--minute" />
        <span className="wa-ecs-clock__dot" />
      </span>
      <span className="wa-ecs-clock__label">{label}</span>
    </div>
  );
}

function zohoFromResult(result: EcsLitePendingShopResult): ZohoUiResult {
  const invoiceNumber = result.invoiceNumber ?? result.zohoInvoiceNumber ?? null;
  const zohoError = result.zohoError ?? result.zohoInvoiceError ?? null;
  let status: EcsLiteZohoInvoiceStatus = result.zohoInvoiceStatus || 'skipped';
  if (!result.zohoInvoiceStatus) {
    if (zohoError) status = 'failed';
    else if (invoiceNumber || result.zohoInvoiceId) status = 'success';
  }
  return {
    status,
    invoiceNumber,
    invoiceDate: result.invoiceDate ?? null,
    invoiceAmount: result.invoiceAmount ?? null,
    zohoError,
  };
}

export function EcsLiteCreateShopModal({
  open,
  onClose,
  defaultPhone = '',
  softwareShopId = 0,
  softwareShopName = '',
}: Props) {
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [assignedKey, setAssignedKey] = useState<EcsLiteLicenseKey | null>(null);
  const [countries, setCountries] = useState<EcsLiteCountry[]>([{ code: 'IN', label: 'India' }]);
  const [mac, setMac] = useState('');
  const [macVerified, setMacVerified] = useState(false);
  const [macNote, setMacNote] = useState('');
  const [macChecking, setMacChecking] = useState(false);
  const [shopName, setShopName] = useState('');
  const [deviceName, setDeviceName] = useState(ECS_LITE_DEFAULT_DEVICE_NAME);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(ECS_LITE_DEFAULT_PASSWORD);
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('IN');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'not_paid'>('paid');
  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>('idle');
  const [error, setError] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [zohoResult, setZohoResult] = useState<ZohoUiResult | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrError, setQrError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRafRef = useRef(0);
  const loadGenRef = useRef(0);
  const submitGenRef = useRef(0);

  const formLocked = submitting || submitPhase === 'complete';
  const showProgress = submitPhase !== 'idle' && submitPhase !== 'failed';

  useEffect(() => {
    if (!open) return;
    const gen = loadGenRef.current + 1;
    loadGenRef.current = gen;
    submitGenRef.current += 1;
    setError('');
    setOptionsError('');
    setAssignedKey(null);
    setMac('');
    setMacVerified(false);
    setMacNote('');
    setShopName(String(softwareShopName || '').replace(/\s*·\s*\d+\s*$/, '').trim());
    setDeviceName(ECS_LITE_DEFAULT_DEVICE_NAME);
    setUsername('');
    setPassword(ECS_LITE_DEFAULT_PASSWORD);
    setShowPassword(false);
    setPhone(phoneDigitsOnly(defaultPhone));
    setCountry('IN');
    setPaymentStatus('paid');
    setSubmitting(false);
    setSubmitPhase('idle');
    setZohoResult(null);
    setLoadingOptions(true);

    void (async () => {
      try {
        const [options, shop] = await Promise.all([
          listEcsLiteCreateShopOptions(),
          resolveSoftwareShopForRenewal({
            shopId: Number(softwareShopId) || 0,
            phone: defaultPhone,
          }),
        ]);
        if (loadGenRef.current !== gen) return;

        const nextKey = options.key ?? options.keys?.[0] ?? null;
        setAssignedKey(nextKey);
        const nextCountries = options.countries?.length
          ? options.countries
          : [{ code: 'IN', label: 'India' }];
        setCountries(nextCountries);

        const prefill = ecsLitePrefillFromSoftwareShop(shop, {
          waPhone: defaultPhone,
          fallbackShopName: softwareShopName,
          countries: nextCountries,
        });

        // Only fill empty / default values so staff edits are not overwritten.
        setShopName((prev) => prev || prefill.shopName);
        setDeviceName((prev) => (
          !prev || prev === ECS_LITE_DEFAULT_DEVICE_NAME
            ? ECS_LITE_DEFAULT_DEVICE_NAME
            : prev
        ));
        setUsername((prev) => prev || prefill.username);
        setPassword((prev) => prev || ECS_LITE_DEFAULT_PASSWORD);
        setPhone((prev) => prev || prefill.phone);
        setCountry((prev) => {
          if (prev && prev !== 'IN') return prev;
          return prefill.country || prev || 'IN';
        });
      } catch (err) {
        if (loadGenRef.current !== gen) return;
        setOptionsError(ecsLiteCallableErrorMessage(err, 'Could not load ECS create-shop options.'));
        setAssignedKey(null);
      } finally {
        if (loadGenRef.current === gen) setLoadingOptions(false);
      }
    })();
  }, [open, defaultPhone, softwareShopId, softwareShopName]);

  const stopQr = () => {
    if (scanRafRef.current) {
      cancelAnimationFrame(scanRafRef.current);
    }
    scanRafRef.current = 0;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    setQrOpen(false);
  };

  useEffect(() => () => stopQr(), []);

  useEffect(() => {
    if (!qrOpen) return undefined;
    let cancelled = false;
    const cleanupMedia = () => {
      if (scanRafRef.current) {
        cancelAnimationFrame(scanRafRef.current);
        scanRafRef.current = 0;
      }
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    const run = async () => {
      setQrError('');
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setQrError('Camera not available. Type the MAC manually.');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> };
        let detector: Detector | null = null;
        const BD = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => Detector }).BarcodeDetector;
        if (typeof BD === 'function') {
          try {
            detector = new BD({ formats: ['qr_code'] });
          } catch {
            detector = null;
          }
        }
        if (!detector) {
          setQrError('QR scanning needs a browser with BarcodeDetector. Type the MAC or use Check after pasting.');
          return;
        }
        const tick = async () => {
          if (cancelled || !videoRef.current || videoRef.current.readyState < 2) {
            scanRafRef.current = requestAnimationFrame(() => { void tick(); });
            return;
          }
          try {
            const codes = await detector!.detect(videoRef.current);
            const raw = String(codes?.[0]?.rawValue || '').trim();
            if (raw) {
              const compact = raw.replace(/[^0-9a-fA-F]/g, '');
              const next = compact.length === 12 ? normalizeEcsMacInput(compact) : raw;
              setMac(next);
              setMacVerified(false);
              setMacNote('MAC filled from QR — tap Check.');
              cleanupMedia();
              setQrOpen(false);
              return;
            }
          } catch {
            /* keep scanning */
          }
          scanRafRef.current = requestAnimationFrame(() => { void tick(); });
        };
        scanRafRef.current = requestAnimationFrame(() => { void tick(); });
      } catch (err) {
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
        setQrError(
          name === 'NotAllowedError' || name === 'PermissionDeniedError'
            ? 'Camera permission denied. Type the MAC manually.'
            : 'Could not open camera. Type the MAC manually.',
        );
      }
    };
    void run();
    return () => {
      cancelled = true;
      cleanupMedia();
    };
  }, [qrOpen]);

  if (!open) return null;

  const onMacChange = (value: string) => {
    setMac(value);
    setMacVerified(false);
    setMacNote('');
  };

  const checkMac = async () => {
    setMacChecking(true);
    setError('');
    setMacNote('');
    setMacVerified(false);
    try {
      const result = await verifyEcsLiteMac(mac);
      if (result.ok && result.status === 'unregistered') {
        setMac(result.mac || normalizeEcsMacInput(mac));
        setMacVerified(true);
        setMacNote(result.message || 'Scale is online and available to attach.');
      } else {
        let text = result.message || `Verify failed (${result.status || 'unknown'}).`;
        if (result.status === 'offline') {
          text = 'Scale is offline or not connected to the server. Bring it online, then Check again.';
        } else if (result.status === 'bound') {
          text = result.message || 'This MAC is already linked to another shop.';
        }
        setMacNote(text);
      }
    } catch (err) {
      setMacNote(ecsLiteCallableErrorMessage(err, 'Could not verify MAC ID.'));
    } finally {
      setMacChecking(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || submitPhase === 'complete') return;
    setError('');
    setZohoResult(null);
    if (!macVerified) {
      setError('Check the MAC ID — scale must be online before creating the shop.');
      return;
    }
    const digits = phoneDigitsOnly(phone);
    if (digits.length < 8 || digits.length > 15) {
      setError('Phone must be digits only — country code + number (8 to 15 digits).');
      return;
    }
    if (!assignedKey?.id) {
      setError('No unused license key available — purchase or ask admin.');
      return;
    }

    const gen = submitGenRef.current + 1;
    submitGenRef.current = gen;
    setSubmitting(true);
    setSubmitPhase('ecs_working');
    stopQr();

    try {
      const result = await submitEcsLitePendingShop({
        keyId: assignedKey.id,
        mac: normalizeEcsMacInput(mac),
        shopName: shopName.trim(),
        deviceName: deviceName.trim() || ECS_LITE_DEFAULT_DEVICE_NAME,
        username: username.trim(),
        password: password || ECS_LITE_DEFAULT_PASSWORD,
        phone: digits,
        country,
        paymentStatus,
      });
      if (submitGenRef.current !== gen) return;

      const ecsOk = result.ecsCreated === true || result.pending === true;
      if (!ecsOk) {
        setSubmitPhase('failed');
        setError(result.message || 'ECS did not queue a pending approval.');
        return;
      }

      setSubmitPhase('ecs_done');
      await sleep(700);
      if (submitGenRef.current !== gen) return;

      setSubmitPhase('zoho_working');
      await sleep(550);
      if (submitGenRef.current !== gen) return;

      setZohoResult(zohoFromResult(result));
      setSubmitPhase('complete');
    } catch (err) {
      if (submitGenRef.current !== gen) return;
      setSubmitPhase('failed');
      setError(ecsLiteCallableErrorMessage(err, 'Could not submit pending ECS shop.'));
    } finally {
      if (submitGenRef.current === gen) setSubmitting(false);
    }
  };

  const amountText = formatInvoiceAmount(zohoResult?.invoiceAmount);
  const dateText = formatInvoiceDate(zohoResult?.invoiceDate);

  return createPortal(
    <div
      className="wa-ecs-modal-backdrop"
      role="presentation"
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="wa-ecs-modal panel"
        role="dialog"
        aria-modal="true"
        aria-label="Create Shop with Key"
        onClick={(ev) => ev.stopPropagation()}
      >
        <header className="wa-ecs-modal__head">
          <button
            type="button"
            className="wa-ecs-modal__close"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <X size={18} />
          </button>
        </header>

        {loadingOptions ? (
          <p className="wa-ecs-modal__status"><Loader2 size={16} className="wa-ecs-spin" /> Loading…</p>
        ) : null}
        {optionsError ? <p className="wa-ecs-modal__error">{optionsError}</p> : null}

        <form className="wa-ecs-modal__form" onSubmit={(e) => void onSubmit(e)}>
          <fieldset className="wa-ecs-modal__fieldset" disabled={formLocked}>
            <div className="wa-ecs-modal__field">
              <span>License key (inventory)</span>
              <p className="wa-ecs-modal__readonly" aria-live="polite">
                {loadingOptions
                  ? '…'
                  : assignedKey
                    ? keyDisplayLabel(assignedKey)
                    : 'No unused keys — purchase or ask admin'}
              </p>
              <p className="wa-ecs-modal__help">Uses one unused key automatically (not a picker).</p>
            </div>

            <label className="wa-ecs-modal__field">
              <span>MAC ID</span>
              <div className="wa-ecs-modal__mac-row">
                <input
                  value={mac}
                  onChange={(e) => onMacChange(e.target.value)}
                  placeholder="00:23:F0:1B:50:FD"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <button
                  type="button"
                  className="wa-ecs-modal__secondary"
                  onClick={() => void checkMac()}
                  disabled={macChecking || formLocked}
                >
                  {macChecking ? '…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="wa-ecs-modal__secondary"
                  onClick={() => setQrOpen(true)}
                  disabled={formLocked}
                >
                  <QrCode size={15} /> Scan QR
                </button>
              </div>
              <p className="wa-ecs-modal__help">Scan the MAC QR on the ECS Lite profile, or type the MAC.</p>
              {macNote ? (
                <p className={`wa-ecs-modal__mac-note${macVerified ? ' is-ok' : ' is-err'}`}>{macNote}</p>
              ) : null}
            </label>

            <label className="wa-ecs-modal__field">
              <span>Shop Name</span>
              <input value={shopName} onChange={(e) => setShopName(e.target.value)} required maxLength={80} />
            </label>

            <label className="wa-ecs-modal__field">
              <span>Device Name</span>
              <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} required maxLength={80} />
            </label>

            <label className="wa-ecs-modal__field">
              <span>Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <label className="wa-ecs-modal__field">
              <span>Password</span>
              <div className="wa-ecs-modal__pw">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="wa-ecs-modal__pw-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>

            <label className="wa-ecs-modal__field">
              <span>Phone number</span>
              <input
                value={phone}
                onChange={(e) => setPhone(phoneDigitsOnly(e.target.value))}
                inputMode="numeric"
                placeholder="919876543210"
                required
              />
              <p className="wa-ecs-modal__help">Digits only — country code + number (8 to 15 digits).</p>
            </label>

            <label className="wa-ecs-modal__field">
              <span>Country</span>
              <select value={country} onChange={(e) => setCountry(e.target.value)} required>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </label>

            <div className="wa-ecs-modal__field">
              <span id="ecs-lite-payment-status-label">Payment status</span>
              <div
                className="wa-ecs-modal__payment-tabs"
                role="tablist"
                aria-labelledby="ecs-lite-payment-status-label"
              >
                {([
                  ['paid', 'Paid'],
                  ['not_paid', 'not paid'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={paymentStatus === value}
                    className={`wa-board-tab${paymentStatus === value ? ' is-active' : ''}`}
                    onClick={() => setPaymentStatus(value)}
                    disabled={formLocked}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>

          {showProgress ? (
            <div className="wa-ecs-progress" aria-live="polite">
              {submitPhase === 'ecs_working' ? (
                <ClockSpinner label="Creating ECS lite shop…" />
              ) : null}

              {submitPhase === 'ecs_done'
                || submitPhase === 'zoho_working'
                || submitPhase === 'complete' ? (
                <p className="wa-ecs-progress__ok">ECS lite created</p>
              ) : null}

              {submitPhase === 'zoho_working' ? (
                <ClockSpinner label="Checking Zoho invoice…" />
              ) : null}

              {submitPhase === 'complete' && zohoResult ? (
                <div
                  className={`wa-ecs-progress__zoho${
                    zohoResult.status === 'success'
                      ? ' is-ok'
                      : zohoResult.status === 'failed'
                        ? ' is-err'
                        : ''
                  }`}
                >
                  {zohoResult.status === 'success' ? (
                    <>
                      <p className="wa-ecs-progress__zoho-title">Zoho invoice created</p>
                      <ul className="wa-ecs-progress__zoho-meta">
                        <li>
                          <span>Invoice</span>
                          <strong>{zohoResult.invoiceNumber || '—'}</strong>
                        </li>
                        <li>
                          <span>Date</span>
                          <strong>{dateText || '—'}</strong>
                        </li>
                        <li>
                          <span>Amount</span>
                          <strong>{amountText || '—'}</strong>
                        </li>
                      </ul>
                    </>
                  ) : zohoResult.status === 'failed' ? (
                    <>
                      <p className="wa-ecs-progress__zoho-title">Zoho invoice failed</p>
                      {zohoResult.zohoError ? (
                        <p className="wa-ecs-progress__zoho-err">{zohoResult.zohoError}</p>
                      ) : null}
                    </>
                  ) : (
                    <p className="wa-ecs-progress__zoho-title">Zoho invoice skipped</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="wa-ecs-modal__error">{error}</p> : null}

          <footer className="wa-ecs-modal__foot">
            {submitPhase === 'complete' ? (
              <button type="button" className="wa-ecs-modal__primary" onClick={onClose}>
                OK / Close
              </button>
            ) : (
              <>
                <button type="button" className="wa-ecs-modal__secondary" onClick={onClose} disabled={submitting}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="wa-ecs-modal__primary"
                  disabled={submitting || loadingOptions || !assignedKey?.id}
                >
                  {submitting ? 'Working…' : '+ Create Shop'}
                </button>
              </>
            )}
          </footer>
        </form>
      </div>

      {qrOpen ? (
        <div className="wa-ecs-qr" role="dialog" aria-label="Scan MAC QR">
          <div className="wa-ecs-qr__card">
            <p className="wa-ecs-modal__help">Point the camera at the ECS Lite MAC QR.</p>
            <video ref={videoRef} className="wa-ecs-qr__video" playsInline muted autoPlay />
            {qrError ? <p className="wa-ecs-modal__error">{qrError}</p> : null}
            <button type="button" className="wa-ecs-modal__secondary" onClick={stopQr}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
