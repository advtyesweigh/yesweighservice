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

function phoneDigitsOnly(value: string) {
  return value.replace(/\D/g, '').slice(0, 15);
}

function keyDisplayLabel(key: EcsLiteLicenseKey) {
  const preview = key.preview || key.id;
  return key.poNumber ? `${preview} · ${key.poNumber}` : preview;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrError, setQrError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRafRef = useRef(0);
  const loadGenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const gen = loadGenRef.current + 1;
    loadGenRef.current = gen;
    setError('');
    setSuccess('');
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
    if (submitting) return;
    setError('');
    setSuccess('');
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
    setSubmitting(true);
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
      });
      if (!result.pending) {
        setError(result.message || 'ECS did not queue a pending approval.');
        return;
      }
      setSuccess(result.message || 'Sent for dealer PIN approval.');
    } catch (err) {
      setError(ecsLiteCallableErrorMessage(err, 'Could not submit pending ECS shop.'));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="wa-ecs-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="wa-ecs-modal panel"
        role="dialog"
        aria-modal="true"
        aria-label="Create Shop with Key"
        onClick={(ev) => ev.stopPropagation()}
      >
        <header className="wa-ecs-modal__head">
          <div>
            <h2>Create Shop with Key</h2>
            <p className="wa-ecs-modal__hint">
              Submits a pending request to ECS (dealer PIN approval). Username must be unique across ECS Lite.
            </p>
          </div>
          <button type="button" className="wa-ecs-modal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {loadingOptions ? (
          <p className="wa-ecs-modal__status"><Loader2 size={16} className="wa-ecs-spin" /> Loading…</p>
        ) : null}
        {optionsError ? <p className="wa-ecs-modal__error">{optionsError}</p> : null}

        <form className="wa-ecs-modal__form" onSubmit={(e) => void onSubmit(e)}>
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
                disabled={submitting}
              />
              <button
                type="button"
                className="wa-ecs-modal__secondary"
                onClick={() => void checkMac()}
                disabled={macChecking || submitting}
              >
                {macChecking ? '…' : 'Check'}
              </button>
              <button
                type="button"
                className="wa-ecs-modal__secondary"
                onClick={() => setQrOpen(true)}
                disabled={submitting}
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
            <input value={shopName} onChange={(e) => setShopName(e.target.value)} required maxLength={80} disabled={submitting} />
          </label>

          <label className="wa-ecs-modal__field">
            <span>Device Name</span>
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} required maxLength={80} disabled={submitting} />
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
              disabled={submitting}
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
                disabled={submitting}
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
              disabled={submitting}
            />
            <p className="wa-ecs-modal__help">Digits only — country code + number (8 to 15 digits).</p>
          </label>

          <label className="wa-ecs-modal__field">
            <span>Country</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)} required disabled={submitting}>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </label>

          {error ? <p className="wa-ecs-modal__error">{error}</p> : null}
          {success ? <p className="wa-ecs-modal__success">{success}</p> : null}

          <footer className="wa-ecs-modal__foot">
            <button type="button" className="wa-ecs-modal__secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="wa-ecs-modal__primary"
              disabled={submitting || loadingOptions || !assignedKey?.id || Boolean(success)}
            >
              {submitting ? 'Submitting…' : '+ Create Shop'}
            </button>
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
