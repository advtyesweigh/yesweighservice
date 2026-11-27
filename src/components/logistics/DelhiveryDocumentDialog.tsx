import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Printer, Share2, X } from 'lucide-react';
import {
  LOGISTICS_LABEL_HEIGHT_MM,
  LOGISTICS_LABEL_WIDTH_MM,
} from '../../constants/localPrinterSettings';
import { shareDelhiveryDocumentFile } from '../../lib/delhiveryDocuments';
import { PRINT_BRIDGE_START_HINT } from '../../lib/localPrinterPrint';
import { usePrintTransport } from '../../lib/usePrintTransport';
import {
  printPdfBytes,
  printShippingLabelImages,
  tryPrintLabelImagesThermal,
} from '../../lib/logisticsLabelPrint';
import { ZoomableImagePreview } from './ZoomableImagePreview';
import { ZoomablePdfPreview } from './ZoomablePdfPreview';

export type DelhiveryDocumentDialogPayload = {
  title: string;
  contentType: string;
  /** PDF bytes, or null when showing images. */
  pdfBytes?: Uint8Array | null;
  /** Image object URLs (caller owns revoke on close if needed). */
  imageUrls?: string[];
  fileName: string;
  /** Optional blob for download (PDF or first image). */
  downloadBlob?: Blob | null;
  /** Stack all images at 100×150 mm with Print all (shipping labels). */
  layout?: 'document' | 'shipping_label';
  /** Optional destructive action (e.g. cancel e-way bill). */
  onCancel?: () => void;
  cancelLabel?: string;
  cancelBusy?: boolean;
  /** Hide download — share still uses the underlying blob/bytes. */
  hideDownload?: boolean;
};

type Props = {
  payload: DelhiveryDocumentDialogPayload;
  onClose: () => void;
  onViewed?: () => void;
};

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const DelhiveryDocumentDialog: React.FC<Props> = ({
  payload,
  onClose,
  onViewed,
}) => {
  const viewedRef = React.useRef(false);
  const images = payload.imageUrls ?? [];
  const isPdf = Boolean(payload.pdfBytes?.length);
  const isShippingLabel = payload.layout === 'shipping_label' && images.length > 0;
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [printError, setPrintError] = useState('');
  const [printSuccess, setPrintSuccess] = useState('');
  const [shareError, setShareError] = useState('');
  const transport = usePrintTransport();
  const thermal = transport === 'android' || transport === 'windows';

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    onViewed?.();
  }, [onViewed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const downloadTarget = useMemo(() => {
    if (payload.downloadBlob) {
      return { blob: payload.downloadBlob, name: payload.fileName };
    }
    if (payload.pdfBytes?.length) {
      return {
        blob: new Blob([Uint8Array.from(payload.pdfBytes)], {
          type: payload.contentType || 'application/pdf',
        }),
        name: payload.fileName,
      };
    }
    return null;
  }, [payload.downloadBlob, payload.fileName, payload.pdfBytes, payload.contentType]);

  const canShare = Boolean(downloadTarget);

  const handleShare = useCallback(async () => {
    if (!downloadTarget) return;
    setSharing(true);
    setShareError('');
    try {
      await shareDelhiveryDocumentFile({
        blob: downloadTarget.blob,
        fileName: downloadTarget.name,
        title: payload.title,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setShareError(err instanceof Error ? err.message : 'Could not share document.');
    } finally {
      setSharing(false);
    }
  }, [downloadTarget, payload.title]);

  const handlePrintPdf = useCallback(() => {
    if (!payload.pdfBytes?.length) return;
    setPrinting(true);
    setPrintError('');
    setPrintSuccess('');
    try {
      printPdfBytes(payload.pdfBytes, payload.title);
      setPrintSuccess('Opened system print dialog.');
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : 'Print failed.');
    } finally {
      setPrinting(false);
    }
  }, [payload.pdfBytes, payload.title]);

  const handlePrintAll = useCallback(async () => {
    if (!images.length) return;
    setPrinting(true);
    setPrintError('');
    setPrintSuccess('');
    try {
      try {
        const thermal = await tryPrintLabelImagesThermal(images);
        if (thermal.usedThermal) {
          setPrintSuccess(
            `Sent ${images.length} label${images.length === 1 ? '' : 's'} to the logistics printer `
            + `(${thermal.bytesSent} bytes).`,
          );
          return;
        }
      } catch (err) {
        const fallback = window.confirm(
          `${err instanceof Error ? err.message : 'Thermal print failed.'}\n\nPrint with the system dialog instead?`,
        );
        if (!fallback) return;
      }

      await printShippingLabelImages(
        images,
        images.length > 1
          ? `Shipping labels (${images.length} × ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm)`
          : `Shipping label · ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm`,
      );
      setPrintSuccess('Opened system print dialog.');
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : 'Print failed.');
    } finally {
      setPrinting(false);
    }
  }, [images]);

  return createPortal(
    <div
      className="dealers-modal-backdrop courier-slip-view-dialog__backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={[
          'dealers-modal panel glass courier-slip-view-dialog',
          isShippingLabel ? 'delhivery-label-dialog' : '',
        ].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delhivery-doc-dialog-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="dealers-modal__header courier-slip-view-dialog__header">
          <div className="courier-slip-view-dialog__title-block">
            <h2 id="delhivery-doc-dialog-title">{payload.title}</h2>
            <p className="text-muted text-sm">
              {isShippingLabel
                ? [
                  payload.fileName,
                  `${LOGISTICS_LABEL_WIDTH_MM} × ${LOGISTICS_LABEL_HEIGHT_MM} mm`,
                  images.length > 1 ? `${images.length} labels` : null,
                ].filter(Boolean).join(' · ')
                : payload.fileName}
            </p>
          </div>
          <button
            type="button"
            className="dealers-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {printError ? <p className="dealers-modal__error">{printError}</p> : null}
        {shareError ? <p className="dealers-modal__error">{shareError}</p> : null}
        {printSuccess ? (
          <p className="shipping-label-print-dialog__success text-sm">{printSuccess}</p>
        ) : null}

        <div className="courier-slip-view-dialog__body">
          {isShippingLabel ? (
            <div className="book-courier__label-preview book-courier__label-preview--stack delhivery-label-dialog__stack">
              {images.map((src, index) => (
                <div key={`${src}-${index}`} className="book-courier__label-sheet">
                  {images.length > 1 ? (
                    <p className="book-courier__label-sheet-caption">
                      {`Label ${index + 1} of ${images.length} · ${LOGISTICS_LABEL_WIDTH_MM} × ${LOGISTICS_LABEL_HEIGHT_MM} mm`}
                    </p>
                  ) : null}
                  <div className="delhivery-label-dialog__sheet">
                    <img
                      src={src}
                      alt={`Shipping label ${index + 1}`}
                      className="delhivery-label-dialog__img"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : isPdf && payload.pdfBytes ? (
            <ZoomablePdfPreview data={payload.pdfBytes} />
          ) : images[0] ? (
            <ZoomableImagePreview src={images[0]} alt={payload.title} />
          ) : (
            <p className="text-muted text-sm courier-slip-view-dialog__status">
              Document preview unavailable.
            </p>
          )}
        </div>

        {isShippingLabel ? (
          <p className="text-muted text-sm shipping-label-print-dialog__hint">
            {thermal
              ? (images.length > 1
                ? `Preview matches ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm stock. Print all sends ${images.length} separate jobs to the logistics printer.`
                : `Preview matches ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm stock sent to the logistics printer.`)
              : transport === 'none'
                ? `${PRINT_BRIDGE_START_HINT} Otherwise Print opens the system dialog`
                  + (images.length > 1
                    ? ` (${images.length} pages at ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm).`
                    : ` (${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm).`)
                : `Preview is ${LOGISTICS_LABEL_WIDTH_MM}×${LOGISTICS_LABEL_HEIGHT_MM} mm — same size as print.`}
          </p>
        ) : null}

        <div className="dealers-modal__actions courier-slip-view-dialog__actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={printing || sharing || payload.cancelBusy}
          >
            Close
          </button>
          {payload.onCancel ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={payload.onCancel}
              disabled={printing || sharing || payload.cancelBusy}
            >
              {payload.cancelBusy
                ? 'Cancelling…'
                : (payload.cancelLabel || 'Cancel')}
            </button>
          ) : null}
          {!payload.hideDownload && downloadTarget ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => downloadBlob(downloadTarget.blob, downloadTarget.name)}
              disabled={printing || sharing}
            >
              <Download size={16} aria-hidden />
              Download
            </button>
          ) : !payload.hideDownload && images[0] && !isShippingLabel ? (
            <a
              className="btn btn-secondary"
              href={images[0]}
              download={payload.fileName}
            >
              <Download size={16} aria-hidden />
              Download
            </a>
          ) : null}
          {canShare && !isShippingLabel ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleShare()}
              disabled={printing || sharing}
            >
              <Share2 size={16} aria-hidden />
              {sharing ? 'Sharing…' : 'Share'}
            </button>
          ) : null}
          {isShippingLabel ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handlePrintAll()}
              disabled={printing || sharing || images.length === 0}
            >
              <Printer size={16} aria-hidden />
              {printing
                ? 'Printing…'
                : (images.length > 1 ? 'Print all' : 'Print')}
            </button>
          ) : isPdf ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePrintPdf}
              disabled={printing || sharing || !payload.pdfBytes?.length}
            >
              <Printer size={16} aria-hidden />
              {printing ? 'Printing…' : 'Print'}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
};
