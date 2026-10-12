import React, { useEffect, useMemo, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { FetchingLoader } from '../FetchingLoader';
import { ZoomableImageDialog } from '../ZoomableImageDialog';
import { invoiceErrorMessage } from '../../lib/invoices';
import {
  INVOICE_QC_REQUIRED,
  addInvoiceMachineQcImages,
  deleteInvoiceMachineQcImage,
  fetchInvoiceQcImageUrl,
  invoiceMachineQcComplete,
  listenInvoiceMachineQc,
  type InvoiceMachineQcImage,
} from '../../lib/invoiceMachineQc';

export const InvoiceMachineQcPanel: React.FC<{
  invoiceId: string;
  customerId: string;
  salesOrderId?: string | null;
  invoiceNumber?: string | null;
  canEdit: boolean;
}> = ({
  invoiceId,
  customerId,
  salesOrderId = null,
  invoiceNumber = null,
  canEdit,
}) => {
  const [images, setImages] = useState<InvoiceMachineQcImage[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    const unsub = listenInvoiceMachineQc(invoiceId, doc => {
      setImages(doc?.images ?? []);
      setLoading(false);
    });
    return unsub;
  }, [invoiceId]);

  useEffect(() => {
    let cancelled = false;
    const missing = images.filter(img => !urls[img.id]);
    if (!missing.length) return undefined;
    void Promise.all(
      missing.map(async img => {
        try {
          const url = await fetchInvoiceQcImageUrl(img.storagePath);
          return [img.id, url] as const;
        } catch {
          return [img.id, ''] as const;
        }
      }),
    ).then(entries => {
      if (cancelled) return;
      setUrls(prev => {
        const next = { ...prev };
        for (const [id, url] of entries) {
          if (url) next[id] = url;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [images, urls]);

  const complete = invoiceMachineQcComplete(images);
  const remaining = Math.max(0, INVOICE_QC_REQUIRED - images.length);
  const slots = useMemo(
    () => Array.from({ length: INVOICE_QC_REQUIRED }, (_, index) => images[index] ?? null),
    [images],
  );
  const viewerImage = viewerIndex != null ? images[viewerIndex] ?? null : null;
  const viewerSrc = viewerImage ? urls[viewerImage.id] ?? null : null;
  const busy = uploading || Boolean(deletingId);

  const uploadFiles = async (fileList: FileList | null) => {
    if (!canEdit || !fileList?.length) return;
    setUploading(true);
    setError('');
    try {
      const next = await addInvoiceMachineQcImages({
        invoiceId,
        customerId,
        salesOrderId,
        files: Array.from(fileList),
        existing: images,
      });
      setImages(next);
    } catch (err) {
      setError(invoiceErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async (imageId: string) => {
    if (!canEdit) return;
    setDeletingId(imageId);
    setError('');
    try {
      const next = await deleteInvoiceMachineQcImage({
        invoiceId,
        customerId,
        salesOrderId,
        imageId,
        existing: images,
      });
      setImages(next);
      setUrls(prev => {
        const copy = { ...prev };
        delete copy[imageId];
        return copy;
      });
      if (viewerIndex != null) {
        if (!next.length) setViewerIndex(null);
        else setViewerIndex(Math.min(viewerIndex, next.length - 1));
      }
    } catch (err) {
      setError(invoiceErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="invoice-qc-panel panel glass">
      <div className="invoice-qc-panel__head">
        <h3 className="invoice-qc-panel__title">QC photos</h3>
        <p className="text-muted text-sm">
          {invoiceNumber ? `${invoiceNumber} · ` : ''}
          {complete
            ? `${images.length} of ${INVOICE_QC_REQUIRED} uploaded`
            : `${images.length} of ${INVOICE_QC_REQUIRED} required`}
        </p>
      </div>

      {canEdit ? (
        <p className="invoice-qc-panel__hint text-sm">
          {complete
            ? 'Required QC photos are complete. Warehouse can replace a photo if needed.'
            : `Upload ${remaining} more photo${remaining === 1 ? '' : 's'}. Five photos are mandatory before dispatch.`}
        </p>
      ) : (
        <p className="invoice-qc-panel__hint text-sm">
          {complete
            ? 'Warehouse QC photos for this order.'
            : 'Warehouse has not uploaded the required QC photos yet.'}
        </p>
      )}

      {error ? <p className="dealers-modal__error">{error}</p> : null}
      {loading ? <FetchingLoader label="Loading QC photos…" /> : null}
      {uploading ? <FetchingLoader label="Uploading QC photos…" /> : null}

      <div className="invoice-qc-grid" role="list" aria-label="QC photo slots">
        {slots.map((img, index) => {
          if (img) {
            const src = urls[img.id];
            return (
              <div key={img.id} className="invoice-qc-slot invoice-qc-slot--filled" role="listitem">
                {src ? (
                  <button
                    type="button"
                    className="invoice-qc-slot__thumb"
                    onClick={() => setViewerIndex(index)}
                    aria-label={`View QC photo ${index + 1}`}
                  >
                    <img src={src} alt="" />
                  </button>
                ) : (
                  <div className="invoice-qc-slot__placeholder">Loading…</div>
                )}
                <span className="invoice-qc-slot__index">{index + 1}</span>
                {canEdit ? (
                  <button
                    type="button"
                    className="invoice-qc-slot__remove"
                    disabled={busy}
                    onClick={() => void removeImage(img.id)}
                    aria-label={`Remove photo ${index + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            );
          }
          return (
            <div key={`empty-${index}`} className="invoice-qc-slot invoice-qc-slot--empty" role="listitem">
              {canEdit ? (
                <label className="invoice-qc-slot__add">
                  <ImagePlus size={22} strokeWidth={2.1} aria-hidden />
                  <span>Photo {index + 1}</span>
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    disabled={busy}
                    onChange={event => {
                      void uploadFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </label>
              ) : (
                <span className="invoice-qc-slot__add invoice-qc-slot__add--disabled">
                  <span>Photo {index + 1}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {viewerSrc ? (
        <ZoomableImageDialog
          src={viewerSrc}
          title={`QC photo ${(viewerIndex ?? 0) + 1} of ${INVOICE_QC_REQUIRED}`}
          alt={`QC photo ${(viewerIndex ?? 0) + 1}`}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </section>
  );
};
