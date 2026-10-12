import React, { useRef } from 'react';
import { Check, Upload } from 'lucide-react';
import { machineQcFeeForCategory, productHasMachineQc } from '../../lib/machineQc';
import type { CatalogProduct } from '../../types/catalog';

export const MachineQcInlineControl: React.FC<{
  product: Pick<CatalogProduct, 'categoryName' | 'categoryId'>;
  qcEnabled?: boolean;
  disabled?: boolean;
  /** Compact stack for under the product thumbnail. */
  compact?: boolean;
  onChange: (qcEnabled: boolean) => void;
  /** Customer sales invoice PDF — only active after QC is ticked. */
  pdfFile?: File | null;
  pdfFileName?: string | null;
  onPdfFileChange?: (file: File | null) => void;
}> = ({
  product,
  qcEnabled = false,
  disabled = false,
  compact = false,
  onChange,
  pdfFile = null,
  pdfFileName = null,
  onPdfFileChange,
}) => {
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const checked = Boolean(qcEnabled);
  const pdfActive = checked && !disabled && Boolean(onPdfFileChange);
  const hasPdf = Boolean(pdfFile?.name || pdfFileName);

  if (!productHasMachineQc(product) && !checked) return null;

  const fee = machineQcFeeForCategory(product.categoryName);
  const title = fee > 0
    ? `QC · +₹${fee.toLocaleString('en-IN')} per machine`
    : 'QC';
  const label = 'QC';

  return (
    <div className="machine-qc-stack">
      <label
        className={[
          'gatc-stamp-inline',
          'machine-qc-inline',
          'machine-qc-inline--check',
          compact ? 'machine-qc-inline--compact' : '',
        ].filter(Boolean).join(' ')}
        title={title}
      >
        <input
          type="checkbox"
          className="machine-qc-inline__checkbox"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
          aria-label={title}
        />
        <span className="gatc-stamp-inline__label">{label}</span>
      </label>
      {onPdfFileChange ? (
        <button
          type="button"
          className="machine-qc-inline__pdf"
          data-enabled={pdfActive ? 'true' : 'false'}
          data-uploaded={hasPdf ? 'true' : 'false'}
          disabled={!pdfActive}
          aria-label={
            hasPdf
              ? `Customer invoice PDF: ${pdfFile?.name || pdfFileName}`
              : pdfActive
                ? 'Upload customer sales invoice PDF'
                : 'Tick QC to upload the customer sales invoice PDF'
          }
          title={
            hasPdf
              ? (pdfFile?.name || pdfFileName || 'Invoice PDF uploaded')
              : pdfActive
                ? 'Upload customer sales invoice PDF'
                : 'Tick QC to upload the customer sales invoice PDF'
          }
          onClick={() => {
            if (!pdfActive) return;
            pdfInputRef.current?.click();
          }}
        >
          {hasPdf ? <Check size={16} strokeWidth={2.5} aria-hidden /> : <Upload size={16} strokeWidth={2.4} aria-hidden />}
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            disabled={!pdfActive}
            onChange={event => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = '';
              if (!file) return;
              const isPdf = file.type === 'application/pdf'
                || file.name.toLowerCase().endsWith('.pdf');
              if (!isPdf) {
                window.alert('Upload a PDF sales invoice.');
                return;
              }
              if (file.size > 8 * 1024 * 1024) {
                window.alert('PDF must be 8 MB or smaller.');
                return;
              }
              onPdfFileChange(file);
            }}
          />
        </button>
      ) : null}
    </div>
  );
};
