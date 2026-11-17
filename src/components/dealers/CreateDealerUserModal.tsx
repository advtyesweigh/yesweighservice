import React, { useMemo, useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import {
  isValidEmail,
  isValidPhone,
  normalizeEmail,
  normalizePhone,
} from '../../lib/loginAuth';
import { dealerContactPhone } from '../../lib/dealers';
import { zohoDealerDisplayName } from '../../lib/logisticsDealers';
import type { ZohoDealer } from '../../types/dealers';

export function resolveLoginFromDealer(dealer: ZohoDealer): {
  loginId: string;
  phone?: string;
  email?: string;
} | null {
  const phone = normalizePhone(dealerContactPhone(dealer) || '');
  if (isValidPhone(phone)) {
    return { loginId: phone, phone };
  }
  const email = dealer.email ? normalizeEmail(dealer.email) : '';
  if (email && isValidEmail(email)) {
    return { loginId: email, email };
  }
  return null;
}

interface CreateDealerUserModalProps {
  dealer: ZohoDealer;
  onClose: () => void;
  onSubmit: (payload: {
    loginId: string;
    password: string;
    displayName: string;
    phone?: string;
    email?: string;
  }) => Promise<void>;
}

export const CreateDealerUserModal: React.FC<CreateDealerUserModalProps> = ({
  dealer,
  onClose,
  onSubmit,
}) => {
  const login = useMemo(() => resolveLoginFromDealer(dealer), [dealer]);
  const displayName = zohoDealerDisplayName(dealer);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login) {
      setError('This customer has no valid 10-digit phone or email for login.');
      return;
    }
    if (!password.trim()) {
      setError('Password is required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit({
        loginId: login.loginId,
        password: password.trim(),
        displayName: displayName.trim(),
        phone: login.phone,
        email: login.email,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create user.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dealers-modal-backdrop" onClick={onClose}>
      <div
        className="dealers-modal panel glass"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="create-dealer-user-title"
      >
        <div className="dealers-modal__header">
          <div>
            <h2 id="create-dealer-user-title">Create portal user</h2>
            <p className="text-muted text-sm">{displayName}</p>
          </div>
          <button type="button" className="dealers-modal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!login ? (
          <p className="dealers-modal__error">
            No valid phone or email on this Zoho customer. Add contact details in Zoho and re-sync.
          </p>
        ) : (
          <form className="dealers-modal__form" onSubmit={e => void handleSubmit(e)}>
            <label className="dealers-modal__field">
              <span>Display name</span>
              <input type="text" value={displayName} readOnly />
            </label>
            <label className="dealers-modal__field">
              <span>Login ID</span>
              <input type="text" value={login.loginId} readOnly />
            </label>
            <label className="dealers-modal__field">
              <span>Password</span>
              <div className="dealers-modal__pw">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoFocus
                  required
                />
                <button
                  type="button"
                  className="dealers-modal__pw-toggle"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            {error && <p className="dealers-modal__error">{error}</p>}
            <div className="dealers-modal__actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
