import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { AlertCircle, Download, ExternalLink, Loader2, Share2 } from 'lucide-react';
import { FetchingLoader } from '../../components/FetchingLoader';
import { shareDocumentPdf } from '../../lib/documentWhatsAppShare';
import {
  downloadAdminInvoiceDocument,
  invoiceDocumentToBlob,
  invoiceErrorMessage,
  openInvoiceDocument,
  saveInvoiceDocumentFile,
} from '../../lib/invoices';
import { base64ToUint8Array, prefersNativePdfViewer, uint8ArrayToBase64 } from '../../lib/pdfViewer';
import type { InvoiceDocumentDownload } from '../../types/invoices';
import type { AdminInvoiceDetailOutletContext } from './adminInvoiceDetailContext';

const InvoicePdfCanvas = lazy(() =>
  import('../../components/invoices/InvoicePdfCanvas').then(m => ({ default: m.InvoicePdfCanvas })),
);

export const AdminInvoicePdfViewerPage: React.FC = () => {
  const { invoice, customerId, invoiceId } = useOutletContext<AdminInvoiceDetailOutletContext>();
  const [searchParams] = useSearchParams();
  const fresh = searchParams.get('fresh') || '';
  const useNativeViewer = useMemo(() => prefersNativePdfViewer(), []);

  const [document, setDocument] = useState<InvoiceDocumentDownload | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');

  useEffect(() => {
    if (!customerId || !invoiceId || !invoice) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    const dealerUrl = invoice?.dealerCustomerInvoice?.url?.trim() || '';

    setLoading(true);
    setError('');
    setShareError('');
    setDocument(null);
    setPdfUrl(null);
    setPdfBytes(null);

    const applyDoc = (doc: InvoiceDocumentDownload) => {
      if (cancelled) return;
      setDocument(doc);
      const bytes = base64ToUint8Array(doc.contentBase64);
      if (useNativeViewer) {
        const blob = invoiceDocumentToBlob(doc);
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      } else {
        setPdfBytes(bytes);
      }
    };

    const load = dealerUrl
      ? fetch(dealerUrl)
        .then(async res => {
          if (!res.ok) throw new Error('Could not open the customer invoice PDF.');
          const bytes = new Uint8Array(await res.arrayBuffer());
          applyDoc({
            contentBase64: uint8ArrayToBase64(bytes),
            filename: invoice?.dealerCustomerInvoice?.fileName || 'customer-invoice.pdf',
            mimeType: 'application/pdf',
          });
        })
      : downloadAdminInvoiceDocument(customerId, invoiceId, 'invoice', { refresh: true })
        .then(applyDoc);

    void load
      .catch(err => {
        if (!cancelled) {
          setError(invoiceErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [customerId, invoiceId, fresh, useNativeViewer, invoice]);

  const sharePdf = async () => {
    if (!document || !invoice || sharing) return;
    setSharing(true);
    setShareError('');
    const label = invoice.invoiceNumber?.trim() || invoiceId;
    try {
      await shareDocumentPdf(document, {
        title: label,
        text: `Invoice ${label}`,
      });
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not share this PDF.');
    } finally {
      setSharing(false);
    }
  };

  if (!invoice) return null;

  return (
    <section className="invoice-detail-pdf invoice-detail-pdf--fullscreen panel glass">
      {document && !loading && !error ? (
        <div className="invoice-detail-pdf__toolbar">
          {!useNativeViewer ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm invoice-detail-pdf__toolbar-btn"
                onClick={() => openInvoiceDocument(document)}
              >
                <ExternalLink size={16} aria-hidden />
                Open PDF
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm invoice-detail-pdf__toolbar-btn"
                onClick={() => saveInvoiceDocumentFile(document)}
              >
                <Download size={16} aria-hidden />
                Download
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="invoice-detail-pdf__share"
            onClick={() => void sharePdf()}
            disabled={sharing}
            aria-label="Share invoice PDF"
          >
            {sharing ? <Loader2 size={22} className="spin-icon" aria-hidden /> : <Share2 size={22} aria-hidden />}
            Share
          </button>
        </div>
      ) : null}

      {shareError ? (
        <div className="invoice-detail-pdf__error invoice-detail-pdf__error--inline" role="alert">
          <AlertCircle size={18} />
          <p>{shareError}</p>
        </div>
      ) : null}

      {loading ? (
        <FetchingLoader label="Loading invoice PDF…" />
      ) : error ? (
        <div className="invoice-detail-pdf__error">
          <AlertCircle size={20} />
          <p>{error}</p>
        </div>
      ) : useNativeViewer && pdfUrl ? (
        <div className="invoice-detail-pdf__frame-clip">
          <iframe
            title={`Invoice ${invoice.invoiceNumber}`}
            src={pdfUrl}
            className="invoice-detail-pdf__frame"
          />
        </div>
      ) : pdfBytes ? (
        <Suspense fallback={<FetchingLoader label="Preparing PDF viewer…" />}>
          <InvoicePdfCanvas data={pdfBytes} />
        </Suspense>
      ) : null}
    </section>
  );
};
