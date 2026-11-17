import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { dealerAddressFromDealer, dealerAddressesMatch } from '../../lib/dealerAddress';
import { findPriceLevelForDealer, subscribePriceLevels } from '../../lib/priceLevels';
import type { PriceLevel } from '../../types/priceLevels';
import { DealerAddressBox } from './DealerAddressBox';
import { DealerStatusIndicator } from './DealerStatusIndicator';
import {
  topZohoContactFields,
  topZohoEmailField,
  visibleFillableFields,
} from '../../lib/dealerZohoFillable';
import { getDealerStatusMeta } from '../../lib/dealerStatus';
import { zohoDealerDisplayName } from '../../lib/logisticsDealers';
import type { ZohoDealer } from '../../types/dealers';

function formatZohoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatGstTreatment(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function displayValue(value: React.ReactNode): string {
  if (value == null || value === '') return '—';
  return String(value);
}

function ReadOnlyField({
  label,
  value,
  full,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  full?: boolean;
  multiline?: boolean;
}) {
  const isPlainText = typeof value === 'string' || typeof value === 'number' || value == null;
  const text = displayValue(value);

  return (
    <div className={`dealers-detail__field${full ? ' dealers-detail__field--full' : ''}`}>
      <span>{label}</span>
      {isPlainText ? (
        multiline ? (
          <textarea
            className="input-field dealers-detail__textarea"
            readOnly
            disabled
            value={text}
          />
        ) : (
          <input className="input-field" readOnly disabled value={text} />
        )
      ) : (
        <div className="dealers-detail__readonly-value">{value}</div>
      )}
    </div>
  );
}

function ReadOnlyToggle({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className="dealers-detail__field dealers-detail__toggle">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`dealers-detail__toggle-btn ${checked ? 'dealers-detail__toggle-btn--on' : ''}`}
        disabled
        tabIndex={-1}
      >
        <span className="dealers-detail__toggle-knob" />
      </button>
    </div>
  );
}

export const DealerDetailReadView: React.FC<{
  dealer: ZohoDealer;
  portalAccount?: {
    loginLabel: string;
    loginValue: string;
  };
}> = ({ dealer, portalAccount }) => {
  const [priceLevels, setPriceLevels] = useState<PriceLevel[]>([]);
  useEffect(() => subscribePriceLevels(docData => setPriceLevels(docData.levels)), []);
  const name = zohoDealerDisplayName(dealer);
  const statusMeta = getDealerStatusMeta({ dealerStage: dealer.dealerStage, signedIn: dealer.signedIn });
  const zohoCreatedOn = formatZohoDate(dealer.zohoCreatedTime);
  const zohoEmailField = topZohoEmailField();

  return (
    <div className="dealers-detail__form dealers-detail__form--page dealers-detail__form--readonly">
      <div className="dealers-detail__field dealers-detail__field--full dealers-detail__summary">
        <div className="dealers-detail__summary-main">
          <strong className="dealers-detail__summary-name">{name}</strong>
          {zohoCreatedOn && (
            <span className="dealers-detail__summary-meta">Created {zohoCreatedOn}</span>
          )}
        </div>
        <DealerStatusIndicator meta={statusMeta} className="dealers-detail__summary-status" />
      </div>

      <ReadOnlyField label="Contact / owner name" value={dealer.firstName} />
      {topZohoContactFields().map(field => (
        <ReadOnlyField
          key={field.key}
          label={field.label}
          value={field.getValue(dealer)}
        />
      ))}
      {zohoEmailField && (
        <ReadOnlyField
          label={zohoEmailField.label}
          value={zohoEmailField.getValue(dealer)}
        />
      )}

      <ReadOnlyField label="Status" value={dealer.dealerStage} />
      <ReadOnlyField label="KAM" value={dealer.assignedStaffName} />

      {visibleFillableFields(dealer).map(field => {
        const storedValue = field.getValue(dealer);
        const display = field.key === 'zohoGstTreatment'
          ? formatGstTreatment(storedValue)
          : storedValue;
        return (
          <ReadOnlyField
            key={field.key}
            label={field.label}
            value={display}
            full={field.full}
            multiline={field.multiline}
          />
        );
      })}

      <ReadOnlyField
        label="Place of supply"
        value={dealer.zohoPlaceOfContactLabel || dealer.zohoPlaceOfContact}
      />
      <ReadOnlyField
        label="Tax"
        value={dealer.zohoTaxName
          ? `${dealer.zohoTaxName}${dealer.zohoTaxPercentage != null ? ` (${dealer.zohoTaxPercentage}%)` : ''}`
          : null}
      />

      {(dealer.zohoTags?.length ?? 0) > 0 && (
        <ReadOnlyField
          label="Tags"
          full
          value={(
            <div className="dealers-detail__tag-list">
              {dealer.zohoTags!.map(tag => (
                <span key={tag} className="dealers-detail__tag">{tag}</span>
              ))}
            </div>
          )}
        />
      )}

      {dealer.zohoCustomFields?.map((field, index) => {
        const row = field as { label?: string; value?: unknown; api_name?: string };
        const label = row.label || row.api_name || `Custom field ${index + 1}`;
        const value = row.value != null ? String(row.value) : null;
        return <ReadOnlyField key={`${label}-${index}`} label={label} value={value} />;
      })}

      {dealerAddressesMatch(
        dealerAddressFromDealer(dealer, 'billing'),
        dealerAddressFromDealer(dealer, 'shipping'),
      ) ? (
        <DealerAddressBox
          idPrefix="billing-read"
          title="Billing and shipping address is same"
          value={dealerAddressFromDealer(dealer, 'billing')}
          disabled
          onChange={() => undefined}
        />
      ) : (
        <>
          <DealerAddressBox
            idPrefix="billing-read"
            title="Billing address"
            value={dealerAddressFromDealer(dealer, 'billing')}
            disabled
            onChange={() => undefined}
          />
          <DealerAddressBox
            idPrefix="shipping-read"
            title="Shipping address"
            value={dealerAddressFromDealer(dealer, 'shipping')}
            disabled
            onChange={() => undefined}
          />
        </>
      )}

      <ReadOnlyField
        label="Price level"
        value={findPriceLevelForDealer(priceLevels, dealer.id)?.name}
      />

      <div className="dealers-detail__field dealers-detail__field--full">
        <span>Google Maps link</span>
        <div className="dealers-detail__link-field">
          <input
            className="input-field"
            readOnly
            disabled
            value={dealer.googleMapsUrl ?? '—'}
          />
          {dealer.googleMapsUrl && (
            <a
              href={dealer.googleMapsUrl}
              className="dealers-detail__link-open"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open map"
            >
              <ExternalLink size={16} />
            </a>
          )}
        </div>
      </div>

      <ReadOnlyToggle label="Can buy spare parts" checked={dealer.canBuySpares !== false} />
      <ReadOnlyToggle label="Order online · pay offline" checked={dealer.orderPayOffline !== false} />
      <ReadOnlyToggle label="Order and pay online" checked={Boolean(dealer.orderPayOnline)} />

      {portalAccount && (
        <ReadOnlyField label={portalAccount.loginLabel} value={portalAccount.loginValue} />
      )}
    </div>
  );
};
