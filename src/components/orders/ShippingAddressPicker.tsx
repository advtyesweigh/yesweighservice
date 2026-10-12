import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, MapPin, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { dealerErrorMessage, fetchGstinDetails, lookupDealerPincode } from '../../lib/dealers';
import { isValidGstin, normalizeGstin } from '../../lib/gstin';
import { indiaStateSelectOptions, indiaStateSelectValue } from '../../lib/indiaStates';
import {
  EMPTY_NEW_ADDRESS,
  canDeleteShippingAddress,
  canEditShippingAddress,
  deleteCustomerShippingAddress,
  deleteDealerShippingAddress,
  shippingAddressToForm,
  updateCustomerShippingAddress,
  updateDealerShippingAddress,
  type NewShippingAddressInput,
  type ShippingAddress,
  type ShippingSelection,
  validateNewShippingAddress,
} from '../../lib/shippingAddresses';

type ShippingAddressPickerProps = {
  addresses: ShippingAddress[];
  loading?: boolean;
  error?: string;
  warning?: string;
  disabled?: boolean;
  value: ShippingSelection | null;
  onChange: (next: ShippingSelection | null) => void;
  onRefresh?: () => void;
  /** Show edit / delete on address cards (dealer cart + staff when managing a customer). */
  allowManage?: boolean;
  /** When set with allowManage, use staff customer address APIs. */
  customerId?: string;
};

type EditTarget = {
  addressId: string | null;
  kind: string;
  label: string;
};

function selectionKey(sel: ShippingSelection | null): string {
  if (!sel) return '';
  if (sel.mode === 'saved') return `id:${sel.addressId}`;
  if (sel.mode === 'kind') return `kind:${sel.kind}`;
  return 'new';
}

function addressOptionKey(addr: ShippingAddress): string {
  if (addr.addressId) return `id:${addr.addressId}`;
  return `kind:${addr.kind}`;
}

function formatNewAddressPreview(draft: NewShippingAddressInput): string {
  return [
    draft.attention.trim(),
    draft.address.trim(),
    draft.street2?.trim(),
    [draft.city.trim(), draft.state.trim()].filter(Boolean).join(', '),
    draft.zip.trim(),
  ].filter(Boolean).join('\n') || 'Fill in the new address below';
}

function trimAddressInput(next: NewShippingAddressInput): NewShippingAddressInput {
  return {
    attention: next.attention.trim(),
    address: next.address.trim(),
    street2: next.street2?.trim() || '',
    city: next.city.trim(),
    district: next.district?.trim() || '',
    state: next.state.trim(),
    zip: next.zip.trim(),
    country: next.country.trim() || 'India',
    phone: next.phone.trim(),
    gstin: normalizeGstin(next.gstin),
  };
}

export const ShippingAddressPicker: React.FC<ShippingAddressPickerProps> = ({
  addresses,
  loading = false,
  error = '',
  warning = '',
  disabled = false,
  value,
  onChange,
  onRefresh,
  allowManage = false,
  customerId,
}) => {
  const radioName = useId();
  const [expanded, setExpanded] = useState(false);
  const [showNew, setShowNew] = useState(value?.mode === 'new');
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState<NewShippingAddressInput>(
    value?.mode === 'new' ? value.newAddress : EMPTY_NEW_ADDRESS,
  );
  const [formError, setFormError] = useState('');
  const [lookingUpPin, setLookingUpPin] = useState(false);
  const [pinError, setPinError] = useState('');
  const [lookingUpGstin, setLookingUpGstin] = useState(false);
  const [gstFetchStatus, setGstFetchStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [gstFetchError, setGstFetchError] = useState('');
  const lastGstLookup = useRef('');
  const lastPinLookup = useRef('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const editing = Boolean(editTarget);
  const formOpen = showNew || editing;

  useEffect(() => {
    if (value?.mode === 'new' && !editTarget) {
      setShowNew(true);
      setDraft(value.newAddress);
      setExpanded(true);
    }
  }, [value, editTarget]);

  useEffect(() => {
    if (!formOpen) return;
    const pin = draft.zip.replace(/\D/g, '').slice(0, 6);
    if (pin.length !== 6) return;
    void applyPinLocation(pin);
    // Re-run when the PIN changes so an already-typed code still fills city and state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.zip, formOpen]);

  // Default to first shipping, else first address, once loaded.
  useEffect(() => {
    if (value || loading || !addresses.length || formOpen) return;
    const preferred = addresses.find(a => a.kind === 'shipping')
      || addresses.find(a => a.addressId)
      || addresses[0];
    if (!preferred) return;
    if (preferred.addressId) {
      onChange({ mode: 'saved', addressId: preferred.addressId, phone: preferred.phone });
    } else if (preferred.kind === 'billing' || preferred.kind === 'shipping') {
      onChange({ mode: 'kind', kind: preferred.kind, phone: preferred.phone });
    }
  }, [addresses, loading, value, formOpen, onChange]);

  const selectedKey = selectionKey(value);

  const options = useMemo(
    () => addresses.filter(a => (a.formatted || a.address) && Boolean(a.zip?.trim())),
    [addresses],
  );

  const selectedAddress = useMemo(() => {
    if (formOpen) return null;
    return options.find(addr => addressOptionKey(addr) === selectedKey) ?? null;
  }, [options, selectedKey, formOpen]);

  const summaryLabel = showNew && !editing
    ? 'New shipping address'
    : editing
      ? `Edit ${editTarget?.label || 'address'}`
      : selectedAddress?.label || (loading ? 'Loading…' : 'No address selected');

  const summaryText = showNew && !editing
    ? formatNewAddressPreview(draft)
    : editing
      ? formatNewAddressPreview(draft)
      : selectedAddress?.formatted || selectedAddress?.address || (
        loading ? 'Loading addresses…' : 'Choose a shipping address'
      );

  const bumpNewSelection = (next: NewShippingAddressInput) => {
    setFormError('');
    const err = validateNewShippingAddress(next);
    if (!err) {
      onChange({ mode: 'new', newAddress: trimAddressInput(next) });
    } else {
      onChange(null);
      setFormError(err);
    }
  };

  const updateDraft = (patch: Partial<NewShippingAddressInput>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    setActionError('');
    if (editing) {
      setFormError(validateNewShippingAddress(next) || '');
      return;
    }
    bumpNewSelection(next);
  };

  const applyPinLocation = async (pin: string) => {
    if (pin.length !== 6 || pin === lastPinLookup.current) return;
    lastPinLookup.current = pin;
    setLookingUpPin(true);
    setPinError('');
    try {
      const loc = await lookupDealerPincode(pin);
      const current = draftRef.current;
      if (current.zip.replace(/\D/g, '').slice(0, 6) !== pin) return;
      updateDraft({
        zip: pin,
        state: indiaStateSelectValue(loc.state) || current.state,
        district: loc.district || current.district || '',
        city: loc.city || loc.district || current.city,
      });
    } catch {
      lastPinLookup.current = '';
      setPinError('PIN not found. Enter city, district and state.');
    } finally {
      setLookingUpPin(false);
    }
  };

  const handleGstinLookup = async (raw?: string) => {
    const current = draftRef.current;
    const gstin = normalizeGstin(raw ?? current.gstin);
    if (!gstin) {
      setGstFetchStatus('idle');
      setGstFetchError('');
      return;
    }
    if (!isValidGstin(gstin)) {
      setGstFetchStatus('error');
      setGstFetchError('Enter a valid 15-character GSTIN, or leave it blank to fill the address manually.');
      updateDraft({ gstin });
      return;
    }
    if (gstin === lastGstLookup.current && gstFetchStatus === 'ok') return;
    lastGstLookup.current = gstin;
    setLookingUpGstin(true);
    setGstFetchError('');
    updateDraft({ gstin });
    try {
      const details = await fetchGstinDetails(gstin);
      const latest = draftRef.current;
      const attention = latest.attention.trim()
        || details.tradeName
        || details.companyName
        || details.legalName
        || '';
      const phoneDigits = (details.phone || '').replace(/\D/g, '').slice(-10);
      const zip = details.zip.replace(/\D/g, '').slice(0, 6) || latest.zip;
      updateDraft({
        gstin,
        attention,
        address: details.address || latest.address,
        street2: details.street2 || latest.street2 || '',
        city: details.city || details.district || latest.city,
        district: details.district || latest.district || '',
        state: indiaStateSelectValue(details.state) || latest.state,
        zip,
        country: latest.country || 'India',
        phone: latest.phone.trim() || phoneDigits,
      });
      if (zip.length === 6) void applyPinLocation(zip);
      setGstFetchStatus('ok');
    } catch (err) {
      lastGstLookup.current = '';
      setGstFetchStatus('error');
      setGstFetchError(
        dealerErrorMessage(err)
        || 'Could not look up this GSTIN. Fill the address manually.',
      );
    } finally {
      setLookingUpGstin(false);
    }
  };

  const selectSaved = (addr: ShippingAddress) => {
    setShowNew(false);
    setEditTarget(null);
    setFormError('');
    setActionError('');
    if (addr.addressId) {
      onChange({ mode: 'saved', addressId: addr.addressId, phone: addr.phone });
    } else if (addr.kind === 'billing' || addr.kind === 'shipping') {
      onChange({ mode: 'kind', kind: addr.kind, phone: addr.phone });
    }
    setExpanded(false);
  };

  const startEdit = (addr: ShippingAddress) => {
    if (!canEditShippingAddress(addr)) return;
    setShowNew(false);
    setEditTarget({
      addressId: addr.addressId,
      kind: addr.kind,
      label: addr.label,
    });
    setDraft(shippingAddressToForm(addr));
    setFormError('');
    setActionError('');
    setExpanded(true);
  };

  const cancelForm = () => {
    setShowNew(false);
    setEditTarget(null);
    setDraft(EMPTY_NEW_ADDRESS);
    setFormError('');
    setActionError('');
    setGstFetchStatus('idle');
    setGstFetchError('');
    lastGstLookup.current = '';
    lastPinLookup.current = '';
    if (value?.mode === 'new') onChange(null);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const err = validateNewShippingAddress(draft);
    if (err) {
      setFormError(err);
      return;
    }
    const address = trimAddressInput(draft);
    setSaving(true);
    setActionError('');
    try {
      const payload = {
        addressId: editTarget.addressId,
        kind: editTarget.addressId ? null : editTarget.kind,
        address,
      };
      const updated = customerId
        ? await updateCustomerShippingAddress(customerId, payload)
        : await updateDealerShippingAddress(payload);

      setEditTarget(null);
      setDraft(EMPTY_NEW_ADDRESS);
      setFormError('');
      if (updated.addressId) {
        onChange({ mode: 'saved', addressId: updated.addressId, phone: updated.phone });
      } else if (updated.kind === 'billing' || updated.kind === 'shipping') {
        onChange({ mode: 'kind', kind: updated.kind, phone: updated.phone });
      }
      onRefresh?.();
      setExpanded(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update address.');
    } finally {
      setSaving(false);
    }
  };

  const removeAddress = async (addr: ShippingAddress) => {
    const id = addr.addressId?.trim();
    if (!id || !canDeleteShippingAddress(addr)) return;
    const ok = window.confirm(
      `Delete this saved address?\n\n${addr.formatted || addr.address || 'Address'}`,
    );
    if (!ok) return;

    setDeletingId(id);
    setActionError('');
    try {
      if (customerId) {
        await deleteCustomerShippingAddress(customerId, id);
      } else {
        await deleteDealerShippingAddress(id);
      }
      if (value?.mode === 'saved' && value.addressId === id) {
        onChange(null);
      }
      if (editTarget?.addressId === id) {
        setEditTarget(null);
        setDraft(EMPTY_NEW_ADDRESS);
      }
      onRefresh?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete address.');
    } finally {
      setDeletingId(null);
    }
  };

  const formBusy = disabled || saving || Boolean(deletingId);

  return (
    <div className={`ship-addr-picker${disabled ? ' is-disabled' : ''}${expanded ? ' is-expanded' : ''}`}>
      <div className="ship-addr-picker__head">
        <h4 className="ship-addr-picker__title">
          <MapPin size={16} aria-hidden />
          Shipping address
        </h4>
        {onRefresh ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={formBusy || loading}
            onClick={onRefresh}
          >
            Refresh
          </button>
        ) : null}
      </div>

      {loading && !selectedAddress && !formOpen ? (
        <p className="ship-addr-picker__status text-muted text-sm">
          <Loader2 size={14} className="spin-icon" aria-hidden />
          Loading addresses…
        </p>
      ) : null}
      {error ? <p className="ship-addr-picker__error text-sm">{error}</p> : null}
      {!error && warning ? (
        <p className="ship-addr-picker__status text-muted text-sm">{warning}</p>
      ) : null}
      {actionError ? <p className="ship-addr-picker__error text-sm">{actionError}</p> : null}

      {!expanded ? (
        <button
          type="button"
          className="ship-addr-picker__summary"
          disabled={disabled}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <span className="ship-addr-picker__summary-body">
            <span className="ship-addr-picker__summary-label">{summaryLabel}</span>
            <span className="ship-addr-picker__summary-text">{summaryText}</span>
          </span>
          <span className="ship-addr-picker__summary-action">
            Change
            <ChevronDown size={14} aria-hidden />
          </span>
        </button>
      ) : (
        <>
          <div className="ship-addr-picker__expanded-bar">
            <span className="text-muted text-sm">
              {editing ? 'Edit shipping address' : 'Select a shipping address'}
            </span>
            {!editing ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={disabled || !value}
                onClick={() => setExpanded(false)}
              >
                Done
              </button>
            ) : null}
          </div>

          {!editing ? (
            <div className="ship-addr-picker__list" role="radiogroup" aria-label="Saved shipping addresses">
              {options.map(addr => {
                const key = addressOptionKey(addr);
                const checked = !showNew && selectedKey === key;
                const canEdit = allowManage && canEditShippingAddress(addr);
                const canDelete = allowManage && canDeleteShippingAddress(addr);
                const isDeleting = Boolean(addr.addressId && deletingId === addr.addressId);
                return (
                  <div
                    key={key}
                    className={`ship-addr-picker__option${checked ? ' is-selected' : ''}`}
                  >
                    <label className="ship-addr-picker__option-select">
                      <input
                        type="radio"
                        name={radioName}
                        checked={checked}
                        disabled={formBusy}
                        onChange={() => selectSaved(addr)}
                      />
                      <span className="ship-addr-picker__option-body">
                        <span className="ship-addr-picker__option-label">{addr.label}</span>
                        <span className="ship-addr-picker__option-text">
                          {addr.formatted || '—'}
                        </span>
                      </span>
                    </label>
                    {canEdit || canDelete ? (
                      <span className="ship-addr-picker__option-actions">
                        {canEdit ? (
                          <button
                            type="button"
                            className="ship-addr-picker__icon-btn"
                            title="Edit address"
                            aria-label={`Edit ${addr.label}`}
                            disabled={formBusy}
                            onClick={() => startEdit(addr)}
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                        ) : null}
                        {canDelete ? (
                          <button
                            type="button"
                            className="ship-addr-picker__icon-btn is-danger"
                            title="Delete address"
                            aria-label={`Delete ${addr.label}`}
                            disabled={formBusy}
                            onClick={() => { void removeAddress(addr); }}
                          >
                            {isDeleting
                              ? <Loader2 size={14} className="spin-icon" aria-hidden />
                              : <Trash2 size={14} aria-hidden />}
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                );
              })}

              <label className={`ship-addr-picker__option${showNew ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={radioName}
                  checked={showNew}
                  disabled={formBusy}
                  onChange={() => {
                    setShowNew(true);
                    setEditTarget(null);
                    setExpanded(true);
                    onChange(null);
                    setFormError(validateNewShippingAddress(draft) || '');
                    setActionError('');
                  }}
                />
                <span className="ship-addr-picker__option-body">
                  <span className="ship-addr-picker__option-label">
                    <Plus size={14} aria-hidden />
                    New shipping address
                  </span>
                  <span className="ship-addr-picker__option-text text-muted">
                    Saved to Zoho on this customer
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {formOpen ? (
            <div className="ship-addr-picker__form">
              {editing ? (
                <p className="ship-addr-picker__form-hint text-muted text-sm">
                  Updating {editTarget?.label || 'address'} in Zoho.
                  {!editTarget?.addressId
                    ? ' Billing and default shipping are updated on the contact.'
                    : null}
                </p>
              ) : (
                <p className="ship-addr-picker__form-hint text-muted text-sm">
                  Enter GSTIN to fill the address from Zoho, or leave it blank and type the fields yourself.
                </p>
              )}
              <label>
                GSTIN
                <span className={`ship-addr-picker__gst${gstFetchStatus === 'error' ? ' is-bad' : ''}${gstFetchStatus === 'ok' ? ' is-ok' : ''}`}>
                  <input
                    value={draft.gstin || ''}
                    disabled={formBusy}
                    maxLength={15}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="15-character GSTIN (optional)"
                    onChange={e => {
                      setGstFetchStatus('idle');
                      setGstFetchError('');
                      updateDraft({
                        gstin: e.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 15),
                      });
                    }}
                    onBlur={() => { void handleGstinLookup(); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleGstinLookup();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm ship-addr-picker__gst-btn"
                    disabled={formBusy || lookingUpGstin}
                    onClick={() => { void handleGstinLookup(); }}
                  >
                    {lookingUpGstin
                      ? <Loader2 size={14} className="spin-icon" aria-hidden />
                      : <Search size={14} aria-hidden />}
                    Search
                  </button>
                </span>
              </label>
              {gstFetchError ? <p className="ship-addr-picker__error text-sm">{gstFetchError}</p> : null}
              {gstFetchStatus === 'ok' ? (
                <p className="ship-addr-picker__form-hint text-muted text-sm">
                  Address filled from GSTIN. You can still edit any field.
                </p>
              ) : null}
              <label>
                Attention / contact name *
                <input
                  value={draft.attention}
                  disabled={formBusy}
                  onChange={e => updateDraft({ attention: e.target.value })}
                  autoComplete="name"
                />
              </label>
              <label>
                Address line 1 *
                <input
                  value={draft.address}
                  disabled={formBusy}
                  onChange={e => updateDraft({ address: e.target.value })}
                  autoComplete="address-line1"
                />
              </label>
              <label>
                Address line 2
                <input
                  value={draft.street2 || ''}
                  disabled={formBusy}
                  onChange={e => updateDraft({ street2: e.target.value })}
                  autoComplete="address-line2"
                />
              </label>
              <div className="ship-addr-picker__row">
                <label>
                  PIN code *
                  <input
                    value={draft.zip}
                    disabled={formBusy || lookingUpPin}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    onChange={e => {
                      const zip = e.target.value.replace(/\D/g, '').slice(0, 6);
                      updateDraft({ zip });
                      if (zip.length === 6) void applyPinLocation(zip);
                    }}
                    onBlur={() => {
                      const pin = draftRef.current.zip.replace(/\D/g, '').slice(0, 6);
                      if (pin.length === 6) void applyPinLocation(pin);
                    }}
                    autoComplete="postal-code"
                  />
                  {lookingUpPin ? (
                    <span className="ship-addr-picker__pin-hint">Looking up city, district and state…</span>
                  ) : pinError ? (
                    <span className="ship-addr-picker__error text-sm">{pinError}</span>
                  ) : null}
                </label>
                <label>
                  City *
                  <input
                    value={draft.city}
                    disabled={formBusy}
                    onChange={e => updateDraft({ city: e.target.value })}
                    autoComplete="address-level2"
                  />
                </label>
              </div>
              <div className="ship-addr-picker__row">
                <label>
                  District
                  <input
                    value={draft.district || ''}
                    disabled={formBusy}
                    onChange={e => updateDraft({ district: e.target.value })}
                  />
                </label>
                <label>
                  State *
                  <select
                    value={indiaStateSelectValue(draft.state)}
                    disabled={formBusy}
                    onChange={e => updateDraft({ state: e.target.value })}
                    autoComplete="address-level1"
                  >
                    <option value="">Select state</option>
                    {indiaStateSelectOptions(draft.state).map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="ship-addr-picker__row">
                <label>
                  Country *
                  <input
                    value={draft.country}
                    disabled={formBusy}
                    onChange={e => updateDraft({ country: e.target.value })}
                    autoComplete="country-name"
                  />
                </label>
                <label>
                  Phone *
                  <input
                    value={draft.phone}
                    disabled={formBusy}
                    inputMode="tel"
                    onChange={e => updateDraft({ phone: e.target.value })}
                    autoComplete="tel"
                  />
                </label>
              </div>
              {formError ? <p className="ship-addr-picker__error text-sm">{formError}</p> : null}
              {editing ? (
                <div className="ship-addr-picker__form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={formBusy}
                    onClick={cancelForm}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={formBusy || Boolean(formError)}
                    onClick={() => { void saveEdit(); }}
                  >
                    {saving ? (
                      <>
                        <Loader2 size={14} className="spin-icon" aria-hidden />
                        Saving…
                      </>
                    ) : (
                      'Save address'
                    )}
                  </button>
                </div>
              ) : (
                <div className="ship-addr-picker__form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={formBusy}
                    onClick={cancelForm}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
