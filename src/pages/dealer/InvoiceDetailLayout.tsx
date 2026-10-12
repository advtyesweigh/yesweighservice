import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, FileText } from 'lucide-react';
import { FetchingLoader } from '../../components/FetchingLoader';
import { InvoiceDetailTop } from '../../components/invoices/InvoiceDetailTop';
import { useCatalogPageHeader } from '../../context/PageHeaderContext';
import { useAuth } from '../../context/AuthContext';
import { homePathForRole } from '../../types';
import {
  fetchDealerInvoiceDetailWithCache,
  formatInvoiceDate,
  invoiceErrorMessage,
  readCachedDealerInvoiceDetail,
} from '../../lib/invoices';
import type { DealerInvoiceDetail } from '../../types/invoices';
import { canNavigateBackInApp } from '../../lib/navigation';
import { documentLooksLikeMachineQc } from '../../lib/machineQc';
import {
  INVOICE_QC_REQUIRED,
  listenInvoiceMachineQc,
} from '../../lib/invoiceMachineQc';
import type { InvoiceDetailOutletContext } from './invoiceDetailContext';

export const InvoiceDetailLayout: React.FC = () => {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const base = user ? homePathForRole(user.role) : '/dealer';
  const invoicesPath = `${base}/invoices`;
  const invoiceSummaryPath = `${base}/invoices/${invoiceId}/invoice`;
  const isPdfView = pathname.endsWith('/invoice/view');

  const [invoice, setInvoice] = useState<DealerInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [qcPhotoCount, setQcPhotoCount] = useState(0);

  const handleBack = useCallback(() => {
    if (isPdfView) {
      if (canNavigateBackInApp()) {
        navigate(-1);
      } else {
        navigate(invoiceSummaryPath, { replace: true });
      }
      return;
    }
    navigate(invoicesPath);
  }, [isPdfView, navigate, invoiceSummaryPath, invoicesPath]);

  useCatalogPageHeader({
    title: invoice?.invoiceNumber ?? 'Invoice',
    subtitle: invoice?.date ? formatInvoiceDate(invoice.date) : null,
    showBack: true,
    onBack: handleBack,
  });

  useEffect(() => {
    if (!invoiceId) return;
    let cancelled = false;
    const uid = user?.uid;
    let usedCache = false;

    if (uid) {
      const cached = readCachedDealerInvoiceDetail(uid, invoiceId);
      if (cached) {
        setInvoice(cached);
        setLoading(false);
        usedCache = true;
      } else {
        setLoading(true);
      }
    } else {
      setLoading(true);
    }

    if (!usedCache) setError('');

    fetchDealerInvoiceDetailWithCache(uid, invoiceId)
      .then(data => {
        if (!cancelled) {
          setInvoice(data);
          setError('');
        }
      })
      .catch(err => {
        if (cancelled) return;
        if (!usedCache) {
          setInvoice(null);
          setError(invoiceErrorMessage(err));
        } else {
          setError('Could not refresh. Showing saved invoice.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [invoiceId, user?.uid]);

  const showQcTile = Boolean(
    invoice
    && (
      documentLooksLikeMachineQc(invoice)
      || qcPhotoCount > 0
    ),
  );

  useEffect(() => {
    if (!invoiceId) {
      setQcPhotoCount(0);
      return undefined;
    }
    return listenInvoiceMachineQc(invoiceId, doc => {
      setQcPhotoCount(doc?.images.length ?? 0);
    });
  }, [invoiceId]);

  if (!invoiceId) return null;

  const outletContext: InvoiceDetailOutletContext = {
    invoice,
    loading,
    error,
    invoiceId,
    invoicesPath,
    qcPhotoCount,
  };

  return (
    <div className={`page-content fade-in invoice-detail-page ${isPdfView ? 'invoice-detail-page--pdf-view' : ''}`}>
      {error && (
        <div className="products-inline-error panel glass invoice-detail-page__error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {loading && !invoice ? (
        <FetchingLoader label="Loading invoice…" />
      ) : !invoice ? (
        <div className="invoices-empty panel glass">
          <FileText size={36} aria-hidden />
          <h2>Invoice not found</h2>
          <p className="text-muted text-sm">This invoice may have been removed or you do not have access.</p>
        </div>
      ) : (
        <>
          {!isPdfView && (
            <InvoiceDetailTop
              invoiceId={invoiceId}
              showQc={showQcTile}
              qcCount={qcPhotoCount}
              qcRequired={INVOICE_QC_REQUIRED}
            />
          )}
          <Outlet context={outletContext} />
        </>
      )}
    </div>
  );
};
