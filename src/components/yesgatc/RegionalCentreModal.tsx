import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Save, X } from 'lucide-react';
import {
  saveYesGatcRcDetail,
  yesGatcRcOfficeName,
  type YesGatcRcDetail,
  type YesGatcRcDetailInput,
} from '../../lib/yesgatcRecords';

type FormState = {
  code: string;
  companyName: string;
  contactPerson: string;
  place: string;
  address: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  gstNumber: string;
  panCard: string;
  zohoId: string;
  certificationMethod: string;
  laboratorySealIdentification: string;
  status: string;
  active: boolean;
  vctCount: string;
  jobsCount: string;
  certifiedCount: string;
};

function emptyForm(): FormState {
  return {
    code: '',
    companyName: '',
    contactPerson: '',
    place: '',
    address: '',
    city: '',
    district: '',
    state: '',
    pincode: '',
    phone: '',
    email: '',
    gstNumber: '',
    panCard: '',
    zohoId: '',
    certificationMethod: '',
    laboratorySealIdentification: '',
    status: '',
    active: true,
    vctCount: '',
    jobsCount: '',
    certifiedCount: '',
  };
}

function formFromRow(row: YesGatcRcDetail): FormState {
  return {
    code: row.code || '',
    companyName: row.companyName || yesGatcRcOfficeName(row) || '',
    contactPerson: row.contactPerson || '',
    place: row.place || '',
    address: row.address || '',
    city: row.city || '',
    district: row.district || '',
    state: row.state || '',
    pincode: row.pincode || '',
    phone: row.phone || '',
    email: row.email || '',
    gstNumber: row.gstNumber || '',
    panCard: row.panCard || '',
    zohoId: row.zohoId || '',
    certificationMethod: row.certificationMethod || '',
    laboratorySealIdentification: row.laboratorySealIdentification || '',
    status: row.status || '',
    active: row.active !== false,
    vctCount: row.vctCount != null ? String(row.vctCount) : '',
    jobsCount: row.jobsCount != null ? String(row.jobsCount) : '',
    certifiedCount: row.certifiedCount != null ? String(row.certifiedCount) : '',
  };
}

function parseOptionalInt(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function RegionalCentreModal({
  mode,
  row,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  row: YesGatcRcDetail | null;
  onClose: () => void;
  onSaved: (next: YesGatcRcDetail) => void;
}) {
  const [form, setForm] = useState<FormState>(() => (row ? formFromRow(row) : emptyForm()));
  const [editing, setEditing] = useState(mode === 'create');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm(row ? formFromRow(row) : emptyForm());
    setEditing(mode === 'create');
    setError('');
  }, [mode, row]);

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

  const patch = (next: Partial<FormState>) => {
    setForm(prev => ({ ...prev, ...next }));
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const companyName = form.companyName.trim();
    const code = form.code.trim().toUpperCase();
    if (!companyName && !code) {
      setError('Company name or RC code is required.');
      return;
    }
    setSaving(true);
    setError('');
    const payload: YesGatcRcDetailInput = {
      id: mode === 'edit' ? row?.id : undefined,
      code,
      name: companyName || code,
      companyName: companyName || code,
      contactPerson: form.contactPerson.trim() || null,
      place: form.place.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      district: form.district.trim() || null,
      state: form.state.trim() || null,
      pincode: form.pincode.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      gstNumber: form.gstNumber.trim() || null,
      panCard: form.panCard.trim() || null,
      zohoId: form.zohoId.trim() || null,
      certificationMethod: form.certificationMethod.trim() || null,
      laboratorySealIdentification: form.laboratorySealIdentification.trim() || null,
      status: form.status.trim() || null,
      active: form.active,
      vctCount: parseOptionalInt(form.vctCount),
      jobsCount: parseOptionalInt(form.jobsCount),
      certifiedCount: parseOptionalInt(form.certifiedCount),
    };
    try {
      const saved = await saveYesGatcRcDetail(payload, { create: mode === 'create' });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save regional centre.');
      setSaving(false);
    }
  };

  const title = mode === 'create'
    ? 'Add regional centre'
    : (yesGatcRcOfficeName(row!) || row?.code || 'Regional centre');
  const readOnly = !editing;

  return createPortal(
    <div className="dealers-modal-backdrop" onClick={() => { if (!saving) onClose(); }}>
      <div
        className="dealers-modal dealers-create-modal regional-centre-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="regional-centre-modal-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="dealers-modal__header">
          <h2 id="regional-centre-modal-title">{title}</h2>
          <button
            type="button"
            className="dealers-modal__close"
            onClick={() => { if (!saving) onClose(); }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form className="dealers-modal__form" onSubmit={event => void handleSave(event)}>
          <section className="dealers-create-details">
            <h3>Centre</h3>
            <label className="dealers-modal__field">
              <span>Company name</span>
              <input
                value={form.companyName}
                onChange={event => patch({ companyName: event.target.value })}
                readOnly={readOnly}
                required={mode === 'create'}
              />
            </label>
            <label className="dealers-modal__field">
              <span>RC code</span>
              <input
                value={form.code}
                onChange={event => patch({ code: event.target.value.toUpperCase() })}
                readOnly={readOnly}
                maxLength={12}
              />
            </label>
            <label className="dealers-modal__field">
              <span>Contact person</span>
              <input
                value={form.contactPerson}
                onChange={event => patch({ contactPerson: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>Phone</span>
              <input
                value={form.phone}
                onChange={event => patch({ phone: event.target.value })}
                readOnly={readOnly}
                inputMode="tel"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={event => patch({ email: event.target.value })}
                readOnly={readOnly}
              />
            </label>
          </section>

          <section className="dealers-create-details">
            <h3>Location</h3>
            <label className="dealers-modal__field">
              <span>Place</span>
              <input
                value={form.place}
                onChange={event => patch({ place: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>City / district</span>
              <input
                value={form.city}
                onChange={event => patch({ city: event.target.value, district: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>State</span>
              <input
                value={form.state}
                onChange={event => patch({ state: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>PIN</span>
              <input
                value={form.pincode}
                onChange={event => patch({ pincode: event.target.value })}
                readOnly={readOnly}
                inputMode="numeric"
              />
            </label>
            <label className="dealers-modal__field dealers-modal__field--wide">
              <span>Address</span>
              <textarea
                value={form.address}
                onChange={event => patch({ address: event.target.value })}
                readOnly={readOnly}
                rows={3}
              />
            </label>
          </section>

          <section className="dealers-create-details">
            <h3>Compliance & counts</h3>
            <label className="dealers-modal__field">
              <span>GSTIN</span>
              <input
                value={form.gstNumber}
                onChange={event => patch({ gstNumber: event.target.value.toUpperCase() })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>PAN</span>
              <input
                value={form.panCard}
                onChange={event => patch({ panCard: event.target.value.toUpperCase() })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>Zoho ID</span>
              <input
                value={form.zohoId}
                onChange={event => patch({ zohoId: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>Certification method</span>
              <input
                value={form.certificationMethod}
                onChange={event => patch({ certificationMethod: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>Lab seal ID</span>
              <input
                value={form.laboratorySealIdentification}
                onChange={event => patch({ laboratorySealIdentification: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field">
              <span>VCT</span>
              <input
                value={form.vctCount}
                onChange={event => patch({ vctCount: event.target.value })}
                readOnly={readOnly}
                inputMode="numeric"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Jobs</span>
              <input
                value={form.jobsCount}
                onChange={event => patch({ jobsCount: event.target.value })}
                readOnly={readOnly}
                inputMode="numeric"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Certified</span>
              <input
                value={form.certifiedCount}
                onChange={event => patch({ certifiedCount: event.target.value })}
                readOnly={readOnly}
                inputMode="numeric"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Status</span>
              <input
                value={form.status}
                onChange={event => patch({ status: event.target.value })}
                readOnly={readOnly}
              />
            </label>
            <label className="dealers-modal__field regional-centre-modal__active">
              <span>Active</span>
              <input
                type="checkbox"
                checked={form.active}
                onChange={event => patch({ active: event.target.checked })}
                disabled={readOnly}
              />
            </label>
          </section>

          {row?.dealerName ? (
            <p className="text-muted text-sm regional-centre-modal__dealer">
              Linked dealer: {row.dealerName}
            </p>
          ) : null}

          {error ? <p className="dealers-modal__error" role="alert">{error}</p> : null}

          <div className="dealers-modal__actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              {editing ? 'Cancel' : 'Close'}
            </button>
            {mode === 'edit' && !editing ? (
              <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? <Loader2 size={16} className="spin-icon" /> : <Save size={16} />}
                {mode === 'create' ? 'Add centre' : 'Save changes'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
