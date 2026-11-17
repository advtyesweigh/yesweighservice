import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, KeyRound, Lock, Phone, ShieldCheck } from 'lucide-react';
import {
  LoginHeroFeatures,
  LoginHeroHelp,
  LoginHeroTrust,
} from '../components/auth/LoginHeroChrome';
import { FitSingleLine } from '../components/invoices/FitSingleLine';
import { Logo } from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import { landingPathForRole } from '../types';
import { isValidPhone, normalizePhone } from '../lib/loginAuth';
import {
  completeDealerPasswordReset,
  completeDealerSignup,
  lookupDealerByPhone,
  sendDealerLoginOtp,
  verifyDealerLoginOtp,
  type DealerLookupOption,
  type DealerLookupResult,
  type DealerOtpPurpose,
} from '../lib/dealerLogin';

type Step = 'phone' | 'select' | 'otp' | 'password' | 'registered';

export const DealerLogin: React.FC = () => {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [purpose, setPurpose] = useState<DealerOtpPurpose>(
    searchParams.get('mode') === 'reset' ? 'reset' : 'signup',
  );
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [dealerInfo, setDealerInfo] = useState<DealerLookupResult | null>(null);
  const [dealerOptions, setDealerOptions] = useState<DealerLookupOption[]>([]);
  const [selectedDealerId, setSelectedDealerId] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    if (!loading && user) {
      navigate(landingPathForRole(user.role), { replace: true });
    }
  }, [user, loading, navigate]);

  const normalizedPhone = normalizePhone(phone);
  const isReset = purpose === 'reset';

  const resetTransient = () => {
    setError('');
    setInfo('');
    setOtp('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setSetupToken('');
  };

  const applyDealerSelection = (dealer: DealerLookupOption): Step => {
    setSelectedDealerId(dealer.dealerId);
    setDealerInfo({
      found: true,
      multiple: false,
      dealerId: dealer.dealerId,
      displayName: dealer.displayName,
      companyName: dealer.companyName ?? null,
      hasPortalAccount: dealer.hasPortalAccount,
    });

    if (isReset) {
      if (!dealer.hasPortalAccount) {
        setInfo('This dealer has no portal account yet. Activate the portal first.');
        setStep('phone');
        return 'phone';
      }
      setStep('otp');
      return 'otp';
    }

    if (dealer.hasPortalAccount) {
      setStep('registered');
      return 'registered';
    }
    setStep('otp');
    return 'otp';
  };

  const sendOtpForDealer = async (dealerId: string, otpPurpose: DealerOtpPurpose) => {
    setError('');
    setInfo('');
    if (!dealerId) {
      setError('Select which dealer account to use.');
      return;
    }
    setSubmitting(true);
    try {
      await sendDealerLoginOtp(normalizedPhone, dealerId, otpPurpose);
      setInfo('OTP sent to your WhatsApp number.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send OTP.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePhoneContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!isValidPhone(normalizedPhone)) {
      setError('Enter a 10-digit WhatsApp number.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await lookupDealerByPhone(normalizedPhone);
      if (!result.found) {
        setError('This number is not in our records.');
        return;
      }

      const options = result.multiple && result.dealers?.length
        ? result.dealers
        : result.dealerId
          ? [{
              dealerId: result.dealerId,
              displayName: result.displayName ?? 'Dealer',
              hasPortalAccount: Boolean(result.hasPortalAccount),
              companyName: result.companyName ?? null,
            }]
          : [];

      const filtered = isReset
        ? options.filter(d => d.hasPortalAccount)
        : options;

      if (isReset && filtered.length === 0) {
        setError('No active portal account for this phone. Activate your dealer portal first.');
        return;
      }

      if (filtered.length > 1) {
        setDealerOptions(filtered);
        setDealerInfo(null);
        setSelectedDealerId('');
        setStep('select');
        return;
      }

      const only = filtered[0];
      if (!only) {
        setError('Dealer lookup failed. Try again.');
        return;
      }
      const next = applyDealerSelection(only);
      if (next === 'otp') {
        await sendOtpForDealer(only.dealerId, isReset ? 'reset' : purpose);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!/^\d{6}$/.test(otp.trim())) {
      setError('Enter the 6-digit OTP from WhatsApp.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await verifyDealerLoginOtp(normalizedPhone, otp);
      setSetupToken(result.setupToken);
      setDisplayName(result.displayName);
      if (result.purpose === 'reset' || result.purpose === 'signup') {
        setPurpose(result.purpose);
      }
      setStep('password');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.trim().length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (isReset) {
        await completeDealerPasswordReset(normalizedPhone, setupToken, password);
      } else {
        await completeDealerSignup(normalizedPhone, setupToken, password);
      }
      await login(normalizedPhone, password);
      navigate(landingPathForRole('dealer'), { replace: true });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (isReset ? 'Could not reset password.' : 'Could not complete signup.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisteredSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password.trim()) {
      setError('Enter your password.');
      return;
    }

    setSubmitting(true);
    try {
      await login(normalizedPhone, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const startResetFromRegistered = () => {
    setPurpose('reset');
    resetTransient();
    setStep('otp');
    void sendOtpForDealer(selectedDealerId, 'reset');
  };

  const startSignupMode = () => {
    setPurpose('signup');
    setStep('phone');
    setDealerInfo(null);
    setDealerOptions([]);
    setSelectedDealerId('');
    resetTransient();
  };

  if (loading) {
    return (
      <div className="login-hero">
        <div className="loader-ring" />
      </div>
    );
  }

  return (
    <div className="login-hero login-hero--flow">
      <div className="login-hero__inner">
        <header className="login-hero__brand">
          <Logo size="md" className="login-hero__logo" />
          <h1 className="login-hero__welcome">Welcome to YesOne</h1>
          <p className="login-hero__tagline">One platform. Unlimited possibilities.</p>
        </header>

        <LoginHeroFeatures />

        <div className="login-hero__form-wrap">
        {step !== 'phone' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm dealer-login-back"
            onClick={() => {
              if (step === 'select' || step === 'registered') {
                setStep('phone');
              } else {
                setStep(dealerOptions.length > 1 ? 'select' : 'phone');
              }
              resetTransient();
            }}
          >
            <ArrowLeft size={16} /> Change number
          </button>
        )}

        {error && <div className="login-error">{error}</div>}
        {info && <div className="dealer-login-info">{info}</div>}

        {step === 'phone' && (
          <form onSubmit={e => void handlePhoneContinue(e)} className="login-hero__form login-hero__form--signup-phone">
            <div className="form-group">
              <div className="input-icon-wrap">
                <Phone size={18} className="input-icon" />
                <input
                  id="dealer-phone"
                  type="tel"
                  inputMode="numeric"
                  className="input-field input-with-icon login-hero__input"
                  placeholder="WhatsApp number"
                  aria-label="WhatsApp number"
                  value={phone}
                  onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  required
                  autoFocus
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                />
              </div>
            </div>

            <button type="submit" className="login-hero__submit" disabled={submitting}>
              {submitting ? <span className="spinner-inline login-hero__spinner" /> : <>Continue</>}
            </button>
          </form>
        )}

        {step === 'registered' && dealerInfo?.found && (
          <form
            onSubmit={e => void handleRegisteredSignIn(e)}
            className="login-hero__form login-hero__form--signup-phone dealer-login-registered"
          >
            <p className="dealer-login-registered__label">This number is already registered</p>
            <p className="dealer-login-registered__name">
              <FitSingleLine className="dealer-login-registered__name-text" minPx={12}>
                {dealerInfo.displayName || dealerInfo.companyName}
              </FitSingleLine>
            </p>
            <div className="form-group">
              <div className="input-icon-wrap">
                <Lock size={18} className="input-icon" />
                <input
                  id="dealer-signin-password"
                  type={showPassword ? 'text' : 'password'}
                  className="input-field input-with-icon login-hero__input"
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoFocus
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="input-icon-right"
                  onClick={() => setShowPassword(visible => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" className="login-hero__submit" disabled={submitting}>
              {submitting ? <span className="spinner-inline login-hero__spinner" /> : <>Sign in</>}
            </button>
            <button
              type="button"
              className="login-hero__forgot dealer-login-registered__forgot"
              onClick={startResetFromRegistered}
            >
              Forgot password
            </button>
          </form>
        )}

        {step === 'select' && dealerOptions.length > 0 && (
          <div className="login-form">
            <p className="text-muted text-sm dealer-login-select-intro">
              This number has more than one company. Tap yours.
            </p>
            <ul className="dealer-login-picker" role="listbox" aria-label="Dealer accounts">
              {dealerOptions.map(dealer => {
                const location = [dealer.district, dealer.billingState].filter(Boolean).join(', ');
                return (
                  <li key={dealer.dealerId}>
                    <button
                      type="button"
                      role="option"
                      className="dealer-login-picker__option"
                      onClick={() => {
                        const next = applyDealerSelection(dealer);
                        if (next === 'otp') {
                          void sendOtpForDealer(dealer.dealerId, isReset ? 'reset' : purpose);
                        }
                      }}
                      disabled={submitting}
                    >
                      <div className="dealer-login-picker__body">
                        <strong>{dealer.displayName}</strong>
                        {dealer.companyName && dealer.companyName !== dealer.displayName && (
                          <span className="text-muted text-sm">{dealer.companyName}</span>
                        )}
                        {location && <span className="text-muted text-sm">{location}</span>}
                      </div>
                      <span
                        className={`dealer-login-picker__badge${
                          dealer.hasPortalAccount ? ' is-registered' : ''
                        }`}
                      >
                        {isReset
                          ? 'Reset password'
                          : dealer.hasPortalAccount
                            ? 'Sign in'
                            : 'New'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {step === 'otp' && dealerInfo?.found && (
          <div className="login-form">
            <div className="dealer-login-panel">
              <ShieldCheck size={18} />
              <div>
                <strong>{dealerInfo.displayName}</strong>
                <p className="text-muted text-sm">Phone ending {normalizedPhone.slice(-4)}</p>
              </div>
            </div>

            <form onSubmit={e => void handleVerifyOtp(e)} className="login-hero__form mt-3">
              <div className="form-group">
                <label htmlFor="dealer-otp">WhatsApp OTP</label>
                <div className="input-icon-wrap">
                  <KeyRound size={18} className="input-icon" />
                  <input
                    id="dealer-otp"
                    type="text"
                    inputMode="numeric"
                    className="input-field input-with-icon login-hero__input"
                    placeholder={submitting ? 'Sending OTP…' : '6-digit code'}
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    autoFocus
                  />
                </div>
              </div>
              <button type="submit" className="login-hero__submit" disabled={submitting}>
                {submitting ? <span className="spinner-inline login-hero__spinner" /> : <>Verify OTP</>}
              </button>
              <button
                type="button"
                className="login-hero__forgot"
                onClick={() => void sendOtpForDealer(selectedDealerId, purpose)}
                disabled={submitting}
              >
                Resend OTP
              </button>
            </form>
          </div>
        )}

        {step === 'password' && (
          <form
            onSubmit={e => void handleSetPassword(e)}
            className="login-hero__form login-hero__form--signup-phone login-hero__form--set-password"
          >
            <div className="dealer-login-setpw-head">
              <Lock size={16} strokeWidth={1.85} aria-hidden />
              <div className="dealer-login-setpw-copy">
                <strong>{isReset ? 'Choose a new password' : 'Set your password'}</strong>
                <FitSingleLine className="dealer-login-setpw-name" minPx={11}>
                  {displayName || dealerInfo?.displayName}
                </FitSingleLine>
              </div>
            </div>

            <div className="form-group">
              <div className="input-icon-wrap">
                <Lock size={18} className="input-icon" />
                <input
                  id="dealer-password"
                  type={showPassword ? 'text' : 'password'}
                  className="input-field input-with-icon login-hero__input"
                  name="yw-dealer-password"
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoFocus
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                />
                <button
                  type="button"
                  className="input-icon-right"
                  onClick={() => setShowPassword(visible => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className="form-group">
              <div className="input-icon-wrap">
                <Lock size={18} className="input-icon" />
                <input
                  id="dealer-password-confirm"
                  type={showPassword ? 'text' : 'password'}
                  className="input-field input-with-icon login-hero__input"
                  name="yw-dealer-password-confirm"
                  placeholder="Confirm password"
                  aria-label="Confirm password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                />
                <button
                  type="button"
                  className="input-icon-right"
                  onClick={() => setShowPassword(visible => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button type="submit" className="login-hero__submit" disabled={submitting}>
              {submitting
                ? <span className="spinner-inline login-hero__spinner" />
                : (isReset ? <>Save & sign in</> : <>Create account</>)}
            </button>
          </form>
        )}
        </div>

        <div className="login-hero__dock">
          {step === 'phone' && (
            <>
              <div className="login-hero__bottom-bar">
                <span className="login-hero__bottom-title">Already user</span>
                <Link to="/login" className="login-hero__bottom-link">
                  Sign in
                </Link>
              </div>
              {isReset ? (
                <p className="login-hero__hint">
                  New here?{' '}
                  <button type="button" className="login-hero__forgot" onClick={startSignupMode}>
                    Create account
                  </button>
                </p>
              ) : null}
            </>
          )}

          <LoginHeroHelp />
          <LoginHeroTrust />
        </div>
      </div>
    </div>
  );
};
