import React, { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { DecimalAmountInput } from '../DecimalAmountInput';
import { QuantityStepper } from '../QuantityStepper';
import { GatcStampingInlineControl } from '../catalog/GatcStampingInlineControl';
import type { GatcStampingChoice } from '../catalog/GatcStampingChoiceDialog';
import { formatCurrency } from '../../lib/catalog';
import { combinedCartRate, productHasLinkedGatc } from '../../lib/gatcCart';
import type { CatalogProduct } from '../../types/catalog';
import type { DraftEditLine } from './SalesOrderDraftLineEditor';

type Props = {
  line: DraftEditLine;
  catalogProduct?: CatalogProduct;
  /** Other product lines (for GATC sibling rules). */
  siblingLines: DraftEditLine[];
  allowRateEdit?: boolean;
  disabled?: boolean;
  onChange: (next: DraftEditLine) => void;
  onRemove: () => void;
  onAddSibling?: (choice: GatcStampingChoice) => void;
};

export const SoLineInlineEditor: React.FC<Props> = ({
  line,
  catalogProduct,
  siblingLines,
  allowRateEdit = true,
  disabled = false,
  onChange,
  onRemove,
  onAddSibling,
}) => {
  const canStamp = Boolean(catalogProduct && productHasLinkedGatc(catalogProduct));
  const hasStamping = Boolean(line.gatcStampingPriceId);
  const usedGatcIds = useMemo(() => {
    const ids: string[] = [];
    for (const row of siblingLines) {
      if (row.productId !== line.productId) continue;
      if (row.lineId === line.lineId) continue;
      const id = row.gatcStampingPriceId?.trim();
      if (id) ids.push(id);
    }
    return ids;
  }, [siblingLines, line.productId, line.lineId]);

  const hasUnstampedSibling = siblingLines.some(
    row => row.productId === line.productId
      && row.lineId !== line.lineId
      && !row.gatcStampingPriceId,
  );

  const catalogListRate = catalogProduct
    ? Math.round(Number(catalogProduct.rate) * 100) / 100
    : null;
  const customized = catalogListRate != null
    && Math.round(line.catalogRate * 100) !== Math.round(catalogListRate * 100);

  return (
    <div className="so-line-inline" data-capture-ignore="1">
      <div className="so-line-inline__row">
        {allowRateEdit ? (
          <label className="so-line-inline__rate">
            <span className="text-muted text-sm">Base rate</span>
            <DecimalAmountInput
              className="input-field so-line-inline__rate-input"
              value={line.catalogRate}
              min={0}
              decimals={2}
              disabled={disabled}
              onChange={next => {
                if (next == null) return;
                const catalogRate = Math.round(next * 100) / 100;
                onChange({
                  ...line,
                  catalogRate,
                  rate: combinedCartRate(catalogRate, line.gatcFeePerUnit, line.qcFeePerUnit ?? 0),
                });
              }}
              aria-label={`Base rate for ${line.name}`}
            />
            {customized && catalogListRate != null ? (
              <span className="text-muted text-sm">was {formatCurrency(catalogListRate)}</span>
            ) : null}
            {line.gatcFeePerUnit > 0 ? (
              <span className="text-muted text-sm">
                + {formatCurrency(line.gatcFeePerUnit)} stamping
                {line.gatcStampingRange ? ` (${line.gatcStampingRange})` : ''}
                {' = '}
                {formatCurrency(line.rate)}
              </span>
            ) : null}
          </label>
        ) : (
          <span className="text-muted text-sm">{formatCurrency(line.rate)}</span>
        )}

        <QuantityStepper
          value={line.quantity}
          onChange={quantity => {
            onChange({ ...line, quantity: Math.max(1, Math.floor(quantity) || 1) });
          }}
          disabled={disabled}
          className="so-line-inline__qty"
          buttonClassName="so-line-inline__qty-btn"
          inputClassName="so-line-inline__qty-input"
          aria-label={`Quantity for ${line.name}`}
        />

        <strong className="so-line-inline__total">
          {formatCurrency(line.rate * line.quantity)}
        </strong>

        <button
          type="button"
          className="so-line-inline__remove"
          aria-label={`Remove ${line.name}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {canStamp && catalogProduct ? (
        <GatcStampingInlineControl
          product={catalogProduct}
          valueId={line.gatcStampingPriceId}
          hasStamping={hasStamping}
          usedGatcIds={usedGatcIds}
          hasUnstampedSibling={hasUnstampedSibling}
          disabled={disabled}
          onChange={choice => {
            const gatcStampingPriceId = choice.withStamping
              ? (choice.gatcStampingPriceId?.trim() || null)
              : null;
            const gatcFeePerUnit = gatcStampingPriceId
              ? Math.round(Number(choice.gatcFeePerUnit ?? 0) * 100) / 100
              : 0;
            onChange({
              ...line,
              gatcStampingPriceId,
              gatcFeePerUnit,
              gatcStampingRange: gatcStampingPriceId
                ? (choice.gatcStampingRange?.trim() || null)
                : null,
              rate: combinedCartRate(line.catalogRate, gatcFeePerUnit, line.qcFeePerUnit ?? 0),
            });
          }}
          onAddSibling={onAddSibling}
        />
      ) : null}
    </div>
  );
};
