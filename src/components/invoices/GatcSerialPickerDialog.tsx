import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, X } from 'lucide-react';
import {
  certificateCapacityKg,
  listUnlinkedIwpGatcCertificates,
  type UnlinkedIwpGatcCertificate,
} from '../../lib/gatcStampedSerialAllot';
import { listAvailableNonGatcSerials } from '../../lib/nonGatcSerialAllot';

type PickerRow = {
  id: string;
  serialNumber: string;
  max?: string;
  certificateNumber?: string;
  sku?: string | null;
  productId?: string | null;
  productName?: string;
};

function compactProductToken(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isFiftyKg(kg: number | null | undefined): boolean {
  return kg != null && Number.isFinite(kg) && Math.abs(kg - 50) < 0.01;
}

function certificateIsBound(row: PickerRow): boolean {
  return Boolean(compactProductToken(row.sku) || compactProductToken(row.productId));
}

function certificateMatchesProduct(
  row: PickerRow,
  productId?: string | null,
  sku?: string | null,
  productName?: string | null,
): boolean {
  const have = [row.sku, row.productId, row.productName].map(compactProductToken).filter(Boolean);
  if (!have.length) return true;
  const want = [sku, productId, productName].map(compactProductToken).filter(Boolean);
  if (!want.length) return false;
  return want.some(token => have.includes(token));
}

function capacityLabel(row: PickerRow): string {
  const raw = String(row.max ?? '').trim();
  if (!raw) return '—';
  if (/kg|g\b|t\b/i.test(raw)) return raw;
  return `${raw} kg`;
}

export function GatcSerialPickerDialog({
  title,
  need,
  capacityKg,
  saving,
  error,
  mode = 'gatc',
  productId,
  sku,
  productName,
  invoiceId,
  invoiceNumber,
  onClose,
  onSave,
}: {
  title: string;
  need: number;
  capacityKg?: number | null;
  saving: boolean;
  error: string;
  mode?: 'gatc' | 'nongatc';
  productId?: string | null;
  sku?: string | null;
  productName?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [serverQuery, setServerQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, saving]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    const load = mode === 'nongatc'
      ? listAvailableNonGatcSerials({ productId, sku, productName: productName || title }).then(list => list.map(row => ({
        id: row.id || row.serialNumber,
        serialNumber: row.serialNumber,
      })))
      : listUnlinkedIwpGatcCertificates({
        productId,
        sku,
        productName: productName || title,
        capacityKg,
        invoiceId,
        invoiceNumber,
        query: serverQuery,
      }).then(list => list.map(row => ({
        id: row.id,
        serialNumber: row.serialNumber,
        max: row.max,
        certificateNumber: row.certificateNumber,
        sku: row.sku,
        productId: row.productId ?? null,
        productName: row.productName,
      })));
    void load
      .then(list => {
        if (!cancelled) setRows(list);
      })
      .catch(err => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : mode === 'nongatc'
                ? 'Could not load available serials.'
                : 'Could not load unlinked GATC serials.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [capacityKg, invoiceId, invoiceNumber, mode, productId, productName, serverQuery, sku, title]);

  useEffect(() => {
    if (mode !== 'gatc') return undefined;
    const needle = query.trim();
    if (needle.length < 4) {
      if (serverQuery) setServerQuery('');
      return undefined;
    }
    if (loading) return undefined;
    const localHit = rows.some(row => (
      `${row.serialNumber} ${row.max ?? ''} ${row.certificateNumber ?? ''} ${row.sku ?? ''} ${row.productName ?? ''}`
        .toLowerCase()
        .includes(needle.toLowerCase())
    ));
    if (localHit) return undefined;
    const timer = window.setTimeout(() => setServerQuery(needle), 350);
    return () => window.clearTimeout(timer);
  }, [loading, mode, query, rows, serverQuery]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const lineName = productName || title;
    const dedicated = mode === 'gatc' && rows.some(row => (
      !String(row.id).startsWith('pool:')
      && certificateIsBound(row)
      && certificateMatchesProduct(row, productId, sku, lineName)
    ));
    return rows.filter(row => {
      if (mode === 'gatc') {
        const poolRow = String(row.id).startsWith('pool:');
        const certKg = certificateCapacityKg(row as UnlinkedIwpGatcCertificate);
        if (isFiftyKg(certKg) && !isFiftyKg(capacityKg)) return false;
        if (isFiftyKg(capacityKg) && !isFiftyKg(certKg)) return false;
        if (capacityKg != null && !isFiftyKg(capacityKg) && certKg != null && certKg !== capacityKg) {
          return false;
        }
        if (!poolRow) {
          if (dedicated) {
            if (!certificateIsBound(row)) return false;
            if (!certificateMatchesProduct(row, productId, sku, lineName)) return false;
          } else if (certificateIsBound(row) && !certificateMatchesProduct(row, productId, sku, lineName)) {
            return false;
          }
        }
      }
      if (!needle) return true;
      const blob = `${row.serialNumber} ${row.max ?? ''} ${row.certificateNumber ?? ''} ${row.sku ?? ''} ${row.productName ?? ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [capacityKg, mode, productId, productName, query, rows, sku, title]);

  const toggle = (id: string) => {
    if (saving) return;
    setSelected(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : current.length >= need
          ? current
          : [...current, id]
    ));
  };

  const canSave = selected.length === need && !saving && !loading;
  const full = selected.length >= need;

  return createPortal(
    <div
      className="dealers-modal-backdrop gatc-serial-picker__backdrop"
      role="presentation"
    >
      <div
        className="gatc-serial-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gatc-serial-picker-title"
      >
        <header className="gatc-serial-picker__head">
          <div>
            <h3 id="gatc-serial-picker-title">
              {mode === 'nongatc' ? 'Add serial number' : 'Add GATC serial number'}
            </h3>
            <p className="text-muted text-sm">
              {title}
              {need ? ` · select ${need}` : ''}
              {mode === 'gatc' && capacityKg != null ? ` · ${capacityKg} kg` : ''}
            </p>
          </div>
          <button
            type="button"
            className="gatc-serial-picker__close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </header>
        <label className="gatc-serial-picker__search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search serial"
            autoFocus
          />
        </label>
        <p className="gatc-serial-picker__count">
          {selected.length} of {need} selected
          {visible.length || !loading ? ` · ${visible.length} available` : ''}
          {mode === 'gatc' && capacityKg != null ? ` · ${capacityKg} kg` : ''}
        </p>
        {loadError ? <p className="invoice-nongatc-serials__error">{loadError}</p> : null}
        {error ? <p className="invoice-nongatc-serials__error">{error}</p> : null}
        <div className="gatc-serial-picker__board">
          {loading ? (
            <p className="gatc-serial-picker__status">
              <Loader2 size={16} className="spin-icon" aria-hidden />
              {mode === 'nongatc' ? ' Loading available serials…' : ' Loading GATC serials…'}
            </p>
          ) : visible.length === 0 ? (
            <p className="gatc-serial-picker__status">
              {mode === 'nongatc'
                ? (productId || sku
                  ? 'No unused serials in this product’s allotted range.'
                  : 'No unused serials in the non-GATC allotted list.')
                : isFiftyKg(capacityKg)
                  ? 'No unused 50 kg GATC serials for this scale.'
                  : 'No unused SL printed GATC serials for this scale.'}
            </p>
          ) : (
            <div className="gatc-serial-picker__grid">
              {visible.map(row => {
                const checked = selected.includes(row.id);
                const locked = !checked && full;
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={[
                      'gatc-serial-picker__seat',
                      checked ? 'gatc-serial-picker__seat--on' : '',
                      locked ? 'gatc-serial-picker__seat--locked' : '',
                    ].filter(Boolean).join(' ')}
                    disabled={saving || locked}
                    aria-pressed={checked}
                    onClick={() => toggle(row.id)}
                  >
                    <strong>{row.serialNumber || '—'}</strong>
                    {mode === 'gatc' ? <span>{capacityLabel(row)}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="gatc-serial-picker__actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave}
            onClick={() => onSave(selected)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
