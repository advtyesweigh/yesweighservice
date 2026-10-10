import React, { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { APP_NAME } from '../../constants/brand';
import {
  fetchDealerCreateShare,
  publicCreateDealerFromShare,
  publicFetchGstinDetails,
  type DealerCreateShareRecord,
} from '../../lib/dealerCreateShare';
import { dealerErrorMessage } from '../../lib/dealers';
import { emptyDealerAddress } from '../../lib/dealerAddress';
import { isValidPhone, normalizePhone } from '../../lib/loginAuth';

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeGstin(value: string) {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

function panFromGstin(gstin: string) {
  const next = normalizeGstin(gstin);
  return GSTIN_FORMAT.test(next) ? next.slice(2, 12) : '';
}

export const DealerCreateSharePage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [share, setShare] = useState<DealerCreateShareRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [gstin, setGstin] = useState('');
  const [gstFetching, setGstFetching] = useState(false);
  const [gstFetchStatus, setGstFetchStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [legalName, setLegalName] = useState('');
  const [gstTreatment, setGstTreatment] = useState('');
  const [taxpayerType, setTaxpayerType] = useState('');
  const [constitutionOfBusiness, setConstitutionOfBusiness] = useState('');
  const [pan, setPan] = useState('');
  const [billing, setBilling] = useState(emptyDealerAddress());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [doneName, setDoneName] = useState('');

  useEffect(() => {
    document.title = `Create dealer · ${APP_NAME}`;
    let cancelled = false;
    setLoading(true);
    setPageError('');
    void fetchDealerCreateShare(token)
      .then(next => {
        if (cancelled) return;
        setLoading(false);
        if (!next) {
          setPageError('This dealer link is invalid or has expired.');
          return;
        }
        setShare(next);
        setPhone(current => current || next.phone);
        setBilling(current => ({
          ...current,
          phone: current.phone || next.phone,
        }));
        if (next.status === 'completed') {
          setDoneName(next.companyName || 'Dealer');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setLoading(false);
        setPageError(err instanceof Error ? err.message : 'Could not open this dealer link.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleGstinFetch = async () => {
    const next = normalizeGstin(gstin);
    setGstin(next);
    if (!GSTIN_FORMAT.test(next)) {
      setError('Enter a valid 15-character GSTIN.');
      setGstFetchStatus('error');
      return;
    }
    setGstFetching(true);
    setError('');
    try {
      const details = await publicFetchGstinDetails(token.trim(), next);
      setCompanyName(details.companyName || details.tradeName || details.legalName);
      setLegalName(details.legalName);
      setGstTreatment(details.gstTreatment || 'business_gst');
      setTaxpayerType(details.taxpayerType);
      setConstitutionOfBusiness(details.constitutionOfBusiness);
      setPan(current => current.trim() || panFromGstin(next));
      setBilling(current => ({
        ...current,
        address: details.address || current.address,
        street2: details.street2 || current.street2,
        state: details.state || current.state,
        district: details.district || current.district,
        city: details.city || details.district || current.city,
        zip: details.zip || current.zip,
        country: current.country || 'India',
        phone: current.phone || details.phone.replace(/\D/g, '').slice(-10),
      }));
      if (details.phone) {
        setPhone(current => current.trim() || details.phone.replace(/\D/g, '').slice(-10));
      }
      setGstFetchStatus('success');
    } catch (err) {
      setGstFetchStatus('error');
      setError(dealerErrorMessage(err));
    } finally {
      setGstFetching(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const company = companyName.trim() || legalName.trim();
    if (!company) {
      setError('Shop / company name is required.');
      return;
    }
    const shop = phone.trim() ? normalizePhone(phone) : '';
    if (!shop || !isValidPhone(shop)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    const mail = email.trim().toLowerCase();
    if (mail && !EMAIL_FORMAT.test(mail)) {
      setError('Enter a valid email address.');
      return;
    }
    const gst = normalizeGstin(gstin);
    if (gst && !GSTIN_FORMAT.test(gst)) {
      setError('Enter a valid 15-character GSTIN.');
      setGstFetchStatus('error');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await publicCreateDealerFromShare({
        token: token.trim(),
        companyName: company,
        contactName: contactName.trim() || undefined,
        phone: shop,
        email: mail || undefined,
        gstin: gst || undefined,
        gstTreatment: gstTreatment.trim() || undefined,
        legalName: legalName.trim() || undefined,
        taxpayerType: taxpayerType.trim() || undefined,
        constitutionOfBusiness: constitutionOfBusiness.trim() || undefined,
        pan: pan.trim() || undefined,
        billing: { ...billing, phone: billing.phone || shop },
      });
      setDoneName(result.companyName || company);
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="dealer-create-public">
        <p className="dealer-create-public__state">Opening dealer form…</p>
      </div>
    );
  }

  if (pageError || !share) {
    return (
      <div className="dealer-create-public">
        <div className="dealer-create-public__state">
          <h1>Link unavailable</h1>
          <p>{pageError || 'This dealer link is invalid or has expired.'}</p>
        </div>
      </div>
    );
  }

  if (doneName || share.status === 'completed') {
    return (
      <div className="dealer-create-public">
        <div className="dealer-create-public__state">
          <h1>Dealer created</h1>
          <p>{doneName || share.companyName || 'Your dealer account'} is registered with {APP_NAME}.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dealer-create-public">
      <div className="dealers-create-modal">
        <div className="dealers-modal__header">
          <h2>Create dealer</h2>
        </div>
        <form className="dealers-modal__form" onSubmit={event => void handleSubmit(event)}>
          <section className="dealers-create-gstin">
            <h3>GSTIN</h3>
            <div className={`dealers-create-gstin__row${gstFetchStatus === 'error' ? ' is-bad' : ''}${gstFetchStatus === 'success' ? ' is-ok' : ''}`}>
              <input
                type="text"
                value={gstin}
                maxLength={15}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder="15-DIGIT GSTIN"
                aria-label="GSTIN"
                onChange={event => {
                  setGstFetchStatus('idle');
                  setGstin(event.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase());
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleGstinFetch();
                  }
                }}
              />
              <button
                type="button"
                className={`btn btn-primary dealers-create-gstin__fetch${gstFetchStatus === 'success' ? ' is-ok' : ''}`}
                onClick={() => void handleGstinFetch()}
                disabled={gstFetching || submitting}
              >
                {gstFetching ? (
                  <RefreshCw size={15} className="spin-icon" />
                ) : gstFetchStatus === 'success' ? (
                  <Check size={16} strokeWidth={2.8} />
                ) : (
                  <RefreshCw size={15} />
                )}
                {gstFetching ? 'Fetching…' : gstFetchStatus === 'success' ? 'Fetched' : 'Fetch'}
              </button>
            </div>
          </section>

          <section className="dealers-create-details">
            <h3>Details</h3>
            <label className="dealers-modal__field">
              <span>Shop / Company name</span>
              <input
                type="text"
                value={companyName}
                onChange={event => setCompanyName(event.target.value)}
                placeholder="Shop / company name"
                required
              />
            </label>
            <label className="dealers-modal__field">
              <span>Contact name</span>
              <input
                type="text"
                value={contactName}
                onChange={event => setContactName(event.target.value)}
                placeholder="Contact person"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Mobile</span>
              <input
                type="tel"
                inputMode="numeric"
                value={phone}
                onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit mobile"
                required
              />
            </label>
            <label className="dealers-modal__field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="dealers-modal__field">
              <span>Address</span>
              <input
                type="text"
                value={billing.address}
                onChange={event => setBilling(current => ({ ...current, address: event.target.value }))}
                placeholder="Street address"
              />
            </label>
            <label className="dealers-modal__field">
              <span>PIN code</span>
              <input
                type="text"
                inputMode="numeric"
                value={billing.zip}
                onChange={event => setBilling(current => ({
                  ...current,
                  zip: event.target.value.replace(/\D/g, '').slice(0, 6),
                }))}
                placeholder="PIN"
              />
            </label>
            <label className="dealers-modal__field">
              <span>State</span>
              <input
                type="text"
                value={billing.state}
                onChange={event => setBilling(current => ({ ...current, state: event.target.value }))}
              />
            </label>
            <label className="dealers-modal__field">
              <span>District</span>
              <input
                type="text"
                value={billing.district}
                onChange={event => setBilling(current => ({ ...current, district: event.target.value }))}
              />
            </label>
          </section>

          {error ? <p className="dealers-modal__error">{error}</p> : null}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create dealer'}
          </button>
        </form>
      </div>
    </div>
  );
};
