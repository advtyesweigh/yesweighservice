import React, { useState } from 'react';
import { LogOut, MapPin, Pencil } from 'lucide-react';
import { formatZohoAddressMultiline, zohoDealerDisplayName } from '../../lib/logisticsDealers';
import { buildContactLinks } from '../../lib/phoneLinks';
import type { ZohoAddressRaw, ZohoDealer } from '../../types/dealers';

function display(value: string | null | undefined): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text && text !== '—' ? text : '';
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'D';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function contactName(dealer: ZohoDealer, fallback?: string | null): string {
  return display(
    dealer.zohoPrimaryContact?.name
    || dealer.zohoContactPersons?.find(person => person.isPrimary)?.name
    || dealer.zohoContactPersons?.[0]?.name
    || dealer.firstName
    || dealer.contactName
    || fallback,
  );
}

function addressText(
  formatted: string | null | undefined,
  raw: ZohoAddressRaw | null | undefined,
): string {
  const text = formatZohoAddressMultiline(formatted, raw);
  return text === '—' ? '' : text;
}

function addressDraftValue(
  formatted: string | null | undefined,
  raw: ZohoAddressRaw | null | undefined,
): string {
  return display(raw?.address) || addressText(formatted, raw);
}

function mapsQuery(dealer: ZohoDealer, shipping: string, billing: string): string {
  const parts = [
    shipping || billing,
    display(dealer.zipCode),
    display(dealer.district),
    display(dealer.billingState),
  ].filter(Boolean);
  return parts.join(', ');
}

function mapsEmbedSrc(mapsUrl: string | null | undefined, query: string): string | null {
  const url = mapsUrl?.trim() ?? '';
  if (url.includes('/maps/embed')) return url;
  const coord = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (coord) {
    return `https://www.google.com/maps?q=${coord[1]},${coord[2]}&z=16&output=embed`;
  }
  const q = url || query.trim();
  if (!q) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(q)}&z=15&output=embed`;
}

function mapsOpenHref(mapsUrl: string | null | undefined, query: string): string | null {
  const url = mapsUrl?.trim();
  if (url) return url;
  const q = query.trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function Field({
  label,
  value,
  href,
  full,
}: {
  label: string;
  value: string;
  href?: string | null;
  full?: boolean;
}) {
  const shown = value || '—';
  return (
    <div className={`dealer-profile__field${full ? ' dealer-profile__field--full' : ''}`}>
      <dt>{label}</dt>
      <dd>
        {href && value ? (
          <a href={href}>{shown}</a>
        ) : (
          shown
        )}
      </dd>
    </div>
  );
}

type AddressKind = 'billing' | 'shipping';

function AddressCard({
  title,
  value,
  canEdit,
  editing,
  draft,
  saving,
  error,
  onEdit,
  onCancel,
  onChange,
  onSave,
}: {
  title: string;
  value: string;
  canEdit: boolean;
  editing: boolean;
  draft: string;
  saving: boolean;
  error: string;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <section className={`dealer-profile__address${editing ? ' dealer-profile__address--editing' : ''}`}>
      <div className="dealer-profile__address-head">
        <h3>{title}</h3>
        {canEdit && !editing ? (
          <button
            type="button"
            className="dealer-profile__edit"
            onClick={onEdit}
            aria-label={`Edit ${title}`}
          >
            <Pencil size={14} strokeWidth={2.2} />
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea
            className="input-field dealer-profile__address-input"
            rows={4}
            value={draft}
            onChange={e => onChange(e.target.value)}
            disabled={saving}
            autoFocus
          />
          {error ? <p className="dealer-profile__address-error">{error}</p> : null}
          <div className="dealer-profile__address-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : (
        <p>{value || '—'}</p>
      )}
    </section>
  );
}

export const DealerPortalProfile: React.FC<{
  dealer: ZohoDealer;
  personFallback?: string | null;
  canEditAddresses?: boolean;
  onSaveAddresses?: (patch: {
    billingAddress?: string;
    shippingAddress?: string;
  }) => Promise<void>;
  onSignOut?: () => void;
}> = ({
  dealer,
  personFallback,
  canEditAddresses = false,
  onSaveAddresses,
  onSignOut,
}) => {
  const dealerName = display(zohoDealerDisplayName(dealer)) || 'Dealer';
  const name = contactName(dealer, personFallback);
  const phone = display(
    dealer.phone
    || dealer.zohoPrimaryContact?.phone
    || dealer.zohoContactPersons?.[0]?.phone,
  );
  const mobile = display(
    dealer.mobile
    || dealer.zohoPrimaryContact?.mobile
    || dealer.zohoContactPersons?.[0]?.mobile,
  );
  const email = display(dealer.email || dealer.zohoEmail || dealer.zohoPrimaryContact?.email);
  const gst = display(dealer.zohoGstNo);
  const pan = display(dealer.zohoPanNo);
  const billing = addressText(
    dealer.zohoBillingAddress || dealer.billingAddress,
    dealer.zohoBillingAddressRaw,
  );
  const shipping = addressText(
    dealer.zohoShippingAddress || dealer.shippingAddress,
    dealer.zohoShippingAddressRaw,
  );
  const pin = display(
    dealer.zipCode
    || dealer.zohoShippingAddressRaw?.zip
    || dealer.zohoBillingAddressRaw?.zip,
  );
  const district = display(
    dealer.district
    || dealer.zohoShippingAddressRaw?.city
    || dealer.zohoBillingAddressRaw?.city,
  );
  const state = display(
    dealer.billingState
    || dealer.zohoShippingAddressRaw?.state
    || dealer.zohoBillingAddressRaw?.state,
  );
  const query = mapsQuery(dealer, shipping, billing);
  const embedSrc = mapsEmbedSrc(dealer.googleMapsUrl, query);
  const mapHref = mapsOpenHref(dealer.googleMapsUrl, query);
  const phoneHref = phone ? buildContactLinks(phone)?.tel : null;
  const mobileHref = mobile ? buildContactLinks(mobile)?.tel : null;

  const [editing, setEditing] = useState<AddressKind | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const startEdit = (kind: AddressKind) => {
    if (!canEditAddresses || saving) return;
    setEditing(kind);
    setError('');
    setDraft(
      kind === 'billing'
        ? addressDraftValue(
          dealer.zohoBillingAddress || dealer.billingAddress,
          dealer.zohoBillingAddressRaw,
        )
        : addressDraftValue(
          dealer.zohoShippingAddress || dealer.shippingAddress,
          dealer.zohoShippingAddressRaw,
        ),
    );
  };

  const cancelEdit = () => {
    if (saving) return;
    setEditing(null);
    setDraft('');
    setError('');
  };

  const saveEdit = async () => {
    if (!editing || !onSaveAddresses) return;
    const next = draft.trim();
    if (next.length < 8) {
      setError('Enter a complete address.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSaveAddresses(
        editing === 'billing'
          ? { billingAddress: next }
          : { shippingAddress: next },
      );
      setEditing(null);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save address.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="dealer-profile">
      <header className="dealer-profile__header">
        <div className="dealer-profile__mark" aria-hidden>{initialsFromName(dealerName)}</div>
        <div className="dealer-profile__identity">
          <h2 className="dealer-profile__name">{dealerName}</h2>
        </div>
      </header>

      <dl className="dealer-profile__grid">
        <Field label="Name" value={name} full />
        <Field label="Phone" value={phone} href={phoneHref} />
        <Field label="Mobile" value={mobile} href={mobileHref} />
        <Field
          label="Email"
          value={email}
          href={email ? `mailto:${email}` : null}
          full
        />
        <Field label="GST number" value={gst} />
        <Field label="PAN" value={pan} />
      </dl>

      <div className="dealer-profile__addresses">
        <AddressCard
          title="Billing address"
          value={billing}
          canEdit={canEditAddresses}
          editing={editing === 'billing'}
          draft={draft}
          saving={saving}
          error={editing === 'billing' ? error : ''}
          onEdit={() => startEdit('billing')}
          onCancel={cancelEdit}
          onChange={setDraft}
          onSave={() => void saveEdit()}
        />
        <AddressCard
          title="Shipping address"
          value={shipping}
          canEdit={canEditAddresses}
          editing={editing === 'shipping'}
          draft={draft}
          saving={saving}
          error={editing === 'shipping' ? error : ''}
          onEdit={() => startEdit('shipping')}
          onCancel={cancelEdit}
          onChange={setDraft}
          onSave={() => void saveEdit()}
        />
      </div>

      <dl className="dealer-profile__grid dealer-profile__grid--location">
        <Field label="PIN" value={pin} />
        <Field label="District" value={district} />
        <Field label="State" value={state} />
      </dl>

      <section className="dealer-profile__map">
        <div className="dealer-profile__map-head">
          <h3>Google Map</h3>
          {mapHref ? (
            <a
              className="dealer-profile__map-open"
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MapPin size={14} strokeWidth={2.25} />
              Open
            </a>
          ) : null}
        </div>
        {embedSrc ? (
          <iframe
            title="Dealer location"
            src={embedSrc}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
        ) : (
          <p className="dealer-profile__map-empty">Map is not available for this account.</p>
        )}
      </section>

      {onSignOut ? (
        <button type="button" className="dealer-profile__signout" onClick={onSignOut}>
          <LogOut size={16} strokeWidth={2.1} />
          Sign out
        </button>
      ) : null}
    </article>
  );
};
