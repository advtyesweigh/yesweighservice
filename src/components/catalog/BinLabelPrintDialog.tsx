import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import { LocalPrinterLabelPreview } from '../admin/LocalPrinterLabelPreview';
import type { BinLabelFields } from '../../lib/localPrinterLabel';
import {
  BINDING_FIELD_LABELS,
  extractBindingKeys,
  getLabelLayoutTemplateXml,
  missingBindings,
} from '../../lib/labelLayouts';
import {
  emptyLabelStudioDoc,
  getStoreLabelPrinter,
  loadLabelStudioDoc,
  type LabelPrinter,
  type LabelStudioDoc,
} from '../../lib/labelStudio';
import { PRINT_BRIDGE_START_HINT, sendBinLabel } from '../../lib/localPrinterPrint';
import { usePrintTransport } from '../../lib/usePrintTransport';
import { recordCatalogBinLabelPrint } from '../../lib/catalog';
import type { CatalogProduct } from '../../types/catalog';
import type { YesStoreItemDoc } from '../../types/yes-store';
import { encodePackedDateBatch } from '../../lib/labelLayouts/batchCode';
import { loadMrpRules } from '../../lib/catalogProductSettings';
import {
  calculateProductMrpInclGst,
  formatProductMrpInclGst,
  resolveMrpGroupRule,
} from '../../lib/catalogMrp';

export function binLabelFieldsFromStoreItem(
  product: Pick<CatalogProduct, 'id' | 'name' | 'sku'>,
  binItem: YesStoreItemDoc,
): BinLabelFields {
  const sku = (product.sku ?? '').trim() || product.id;
  return {
    sku,
    itemName: product.name.trim(),
    masterSku: '',
    masterProduct: '',
    rack: binItem.rackId.toUpperCase(),
    row: String(binItem.rowNumber),
    bin: String(binItem.binNumber),
    qrPayload: sku,
    printedOn: new Date(),
  };
}

/**
 * MRP from Product settings formula + multiplier.
 * Legacy signature: (rate, tax, multiplier?) uses gstThenMultiply.
 */
export function calculateProductLabelMrp(
  rate: number,
  taxPercentage: number,
  multiplier = 2.5,
): number {
  return calculateProductMrpInclGst(rate, taxPercentage, {
    formula: 'gstThenMultiply',
    multiplier,
  });
}

export function formatProductLabelMrp(
  rate: number,
  taxPercentage: number,
  multiplier = 2.5,
): string {
  return formatProductMrpInclGst(calculateProductLabelMrp(rate, taxPercentage, multiplier));
}

/** Fields for product/spare pack labels from a catalog product. */
export async function productPackLabelFieldsFromCatalog(
  product: Pick<
    CatalogProduct,
    | 'id'
    | 'name'
    | 'sku'
    | 'rate'
    | 'taxPercentage'
    | 'unit'
    | 'categoryId'
    | 'categoryName'
    | 'mrpOverride'
    | 'modelNumber'
    | 'approvalNumber'
  >,
  packedByName?: string | null,
): Promise<BinLabelFields> {
  const sku = (product.sku ?? '').trim() || product.id;
  const unit = (product.unit ?? 'pcs').trim() || 'pcs';
  const packedOn = new Date();
  const packedBy = ((packedByName ?? '').trim() || 'YESWEIGH').toUpperCase();
  const rules = await loadMrpRules();
  const override = Number(product.mrpOverride);
  let mrp: number;
  if (Number.isFinite(override) && override > 0) {
    mrp = Math.round(override * 100) / 100;
  } else {
    const groupRule = resolveMrpGroupRule(product, rules);
    mrp = calculateProductMrpInclGst(product.rate, product.taxPercentage, groupRule);
  }
  return {
    sku,
    itemName: product.name.trim(),
    masterSku: '',
    masterProduct: '',
    rack: '',
    row: '',
    bin: '',
    qrPayload: sku,
    printedOn: packedOn,
    qty: /nos/i.test(unit) || /pc/i.test(unit) ? '1 nos' : `1 ${unit}`,
    mrp: formatProductMrpInclGst(mrp),
    batchNo: encodePackedDateBatch(packedOn),
    packedBy,
    qcStatus: 'PASSED',
    modelNumber: (product.modelNumber ?? '').trim(),
    approvalNumber: (product.approvalNumber ?? '').trim(),
    serialNumber: '',
  };
}

type Props = {
  fields: BinLabelFields;
  /** Built-in layout id — fixed by print location (not user-selectable). */
  layoutId: string;
  /** When set, records bin label print for spare-rack SKU status after a successful print. */
  productId?: string;
  onClose: () => void;
  /** Called after print is recorded successfully. */
  onPrinted?: () => void;
};

/**
 * Preview + print with a fixed layout.
 * Always uses the hardcoded store label printer (catalog bin / item labels).
 */
export const BinLabelPrintDialog: React.FC<Props> = ({
  fields,
  layoutId,
  productId,
  onClose,
  onPrinted,
}) => {
  const [studio, setStudio] = useState<LabelStudioDoc>(emptyLabelStudioDoc);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [fieldDraft, setFieldDraft] = useState<BinLabelFields>(() => ({
    ...fields,
    printedOn: new Date(),
  }));
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const transport = usePrintTransport();

  const layoutXml = useMemo(() => getLabelLayoutTemplateXml(layoutId), [layoutId]);

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);
    void loadLabelStudioDoc()
      .then(loaded => {
        if (!active) return;
        setStudio(loaded);
      })
      .catch(() => {
        if (active) setStudio(emptyLabelStudioDoc());
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setFieldDraft({ ...fields, printedOn: new Date() });
  }, [fields]);

  const printer: LabelPrinter = useMemo(() => getStoreLabelPrinter(studio), [studio]);

  const requiredKeys = useMemo(() => extractBindingKeys(layoutXml), [layoutXml]);
  const missing = useMemo(
    () => missingBindings(requiredKeys, fieldDraft),
    [requiredKeys, fieldDraft],
  );
  /** Stable order — never rebuild from `missing` alone (that reorders as fields fill). */
  const editableKeys = useMemo(() => {
    const printTimeKeys = ['serialNumber'] as const;
    const missingSet = new Set(missing);
    const keys: string[] = [];
    for (const key of printTimeKeys) {
      if (requiredKeys.includes(key)) keys.push(key);
    }
    for (const key of requiredKeys) {
      if (key === 'printedOn' || key === 'packedOn') continue;
      if (printTimeKeys.includes(key as (typeof printTimeKeys)[number])) continue;
      if (missingSet.has(key)) keys.push(key);
    }
    return keys;
  }, [missing, requiredKeys]);
  const canPrint = missing.length === 0 && Boolean(printer.host.trim());

  const handlePrint = async () => {
    setPrinting(true);
    setError('');
    setSuccess('');
    try {
      if (missing.length) {
        throw new Error(`Fill missing fields: ${missing.map(k => BINDING_FIELD_LABELS[k] ?? k).join(', ')}`);
      }
      if (!printer.host.trim()) {
        throw new Error('Set the store label printer IP in Admin → Settings → Label printing.');
      }
      const result = await sendBinLabel({
        host: printer.host.trim(),
        port: printer.port,
        layoutXml,
        fields: { ...fieldDraft, printedOn: new Date() },
      });
      const printedSku = fieldDraft.sku.trim();
      const printedName = fieldDraft.itemName.trim();
      if (productId?.trim() && printedSku && fieldDraft.rack?.trim()) {
        await recordCatalogBinLabelPrint(productId.trim(), printedSku, printedName);
        onPrinted?.();
        window.dispatchEvent(new CustomEvent('yes-catalog-bin-label-printed', {
          detail: { productId: productId.trim() },
        }));
      }
      setSuccess(
        `Sent via ${printer.name} to ${printer.host.trim()}:${printer.port} (${result.bytesSent} bytes).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Print failed.');
    } finally {
      setPrinting(false);
    }
  };

  const updateField = (key: keyof BinLabelFields, value: string) => {
    setFieldDraft(prev => {
      const next = { ...prev, [key]: value } as BinLabelFields;
      if (key === 'sku' && (!prev.qrPayload.trim() || prev.qrPayload === prev.sku)) {
        next.qrPayload = value;
      }
      return next;
    });
  };

  return createPortal(
    <div className="dealers-modal-backdrop bin-label-print-dialog__backdrop" onClick={onClose}>
      <div
        className="dealers-modal panel glass bin-label-print-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bin-label-print-title"
      >
        <div className="dealers-modal__header">
          <div>
            <h2 id="bin-label-print-title">Print label</h2>
            <p className="text-muted text-sm">
              {fields.sku}
              {fields.rack ? ` · Rack ${fields.rack} / Row ${fields.row} / Bin ${fields.bin}` : ''}
              {` · ${printer.name}`}
            </p>
          </div>
          <button type="button" className="dealers-modal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && <p className="dealers-modal__error">{error}</p>}
        {success && <p className="bin-label-print-dialog__success text-sm">{success}</p>}

        {loadingSettings ? (
          <div className="bin-label-print-dialog__loading">
            <div className="loader-ring" />
          </div>
        ) : (
          <>
            {editableKeys.length > 0 && (
              <div className="bin-label-print-dialog__missing">
                <h3 className="settings-logistics__title">
                  {missing.length > 0 ? 'Fill missing fields' : 'Label fields'}
                </h3>
                <div className="settings-local-printer__fields-grid">
                  {editableKeys.map(key => {
                    const fieldKey = key as keyof BinLabelFields;
                    const value = typeof fieldDraft[fieldKey] === 'string'
                      ? (fieldDraft[fieldKey] as string)
                      : '';
                    return (
                      <label key={key} className="settings-locations__field">
                        <span>{BINDING_FIELD_LABELS[key] ?? key}</span>
                        <input
                          type="text"
                          value={value}
                          onChange={e => updateField(fieldKey, e.target.value)}
                          autoComplete="off"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <LocalPrinterLabelPreview
              layoutXml={layoutXml}
              fields={fieldDraft}
              hideHead
            />

            {transport === 'windows' && (
              <p className="text-muted text-sm bin-label-print-dialog__hint">
                This PC sends the label to the store printer through the local print bridge.
              </p>
            )}
            {transport === 'none' && (
              <p className="text-muted text-sm bin-label-print-dialog__hint">
                {PRINT_BRIDGE_START_HINT}
              </p>
            )}
          </>
        )}

        <div className="dealers-modal__actions bin-label-print-dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={printing}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handlePrint()}
            disabled={printing || loadingSettings || !canPrint}
          >
            <Printer size={16} aria-hidden />
            {printing ? 'Printing…' : 'Print'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
