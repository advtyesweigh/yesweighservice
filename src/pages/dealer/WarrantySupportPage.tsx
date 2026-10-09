import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, LifeBuoy, Plus } from 'lucide-react';
import { SupportWizard } from '../../components/support/SupportWizard';
import { useAuth } from '../../context/AuthContext';
import { fetchDealerSupportRequests, supportBasePath, supportDetailPath } from '../../lib/dealerSupport';
import { StaffSupportQueue } from '../../components/support/StaffSupportQueue';
import { canMutateDealerSupport } from '../../lib/dealerAccess';
import { isInternalOpsUser, canCreateSupportOnBehalf } from '../../lib/staffAccess';
import { whatsappInboxChatPath } from '../../lib/whatsappInbox';
import type {
  DealerSupportRequest,
  SupportOnBehalfDealer,
  SupportProductDraft,
  SupportRequestType,
} from '../../types/dealer-support';
import { isSupportDraft } from '../../lib/supportStatus';
import { DealerSupportRequestList } from '../../components/support/DealerSupportRequestList';

interface LocationState {
  draft?: SupportProductDraft;
  intent?: SupportRequestType;
  resumeDraft?: DealerSupportRequest;
  createdRequestNumber?: string;
  createdRequestType?: SupportRequestType;
  openWizard?: boolean;
  onBehalfDealer?: SupportOnBehalfDealer;
  dealerQuery?: string;
  dealerLookupStatus?: 'none' | 'multiple' | 'matched';
}

export const WarrantySupportPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const state = (location.state as LocationState | null) ?? {};
  const waId = String(searchParams.get('wa') || '').replace(/\D/g, '');

  const isOps = isInternalOpsUser(user);
  const canCreateOnBehalf = canCreateSupportOnBehalf(user);
  const canUseSupport = user?.role === 'dealer' || user?.role === 'dealer_staff';
  const canMutateSupport = canMutateDealerSupport(user);
  const supportPath = user && canUseSupport ? supportBasePath(user.role) : '/dealer/warranty-support';

  const [requests, setRequests] = useState<DealerSupportRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showWizard, setShowWizard] = useState(
    (canMutateSupport || canCreateOnBehalf)
      && Boolean(state.draft || state.intent || state.resumeDraft || state.openWizard),
  );
  const [draftMessage, setDraftMessage] = useState('');
  const [resumeDraft, setResumeDraft] = useState<DealerSupportRequest | null>(
    state.resumeDraft ?? null,
  );

  const productDraft = state.draft ?? null;
  const initialIntent = state.intent ?? (productDraft ? 'service' : null);
  const initialOnBehalfDealer = state.onBehalfDealer ?? null;
  const initialDealerQuery = state.dealerQuery ?? '';
  const dealerLookupStatus = state.dealerLookupStatus ?? null;

  const load = useCallback(async () => {
    if (!user || !canUseSupport) return;
    setLoading(true);
    setError('');
    try {
      setRequests(await fetchDealerSupportRequests(user));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load support requests.');
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [user, canUseSupport]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canMutateSupport && !canCreateOnBehalf) {
      setShowWizard(false);
      return;
    }
    if (state.draft || state.intent || state.resumeDraft || state.openWizard) {
      setShowWizard(true);
    }
    if (state.resumeDraft) {
      setResumeDraft(state.resumeDraft);
    }
  }, [state.draft, state.intent, state.resumeDraft, state.openWizard, canMutateSupport, canCreateOnBehalf]);

  const openRequest = useCallback((request: DealerSupportRequest) => {
    if (!user) return;
    if (isSupportDraft(request)) {
      if (!canMutateSupport) return;
      setResumeDraft(request);
      setShowWizard(true);
      setDraftMessage('');
      return;
    }
    navigate(supportDetailPath(user.role, request.id));
  }, [user, navigate, canMutateSupport]);

  const closeWizard = useCallback(() => {
    setShowWizard(false);
    setResumeDraft(null);
    if (waId) {
      navigate(whatsappInboxChatPath(waId));
      return;
    }
    navigate(supportPath, { replace: true, state: {} });
  }, [navigate, supportPath, waId]);

  const handleDraftSaved = useCallback((requestNumber: string) => {
    setDraftMessage(`Draft ${requestNumber} saved. You can continue it anytime from your list.`);
    setShowWizard(false);
    setResumeDraft(null);
    navigate(supportPath, { replace: true, state: {} });
    void load();
  }, [load, navigate, supportPath]);

  const handleWizardSuccess = useCallback(() => {
    setShowWizard(false);
    setResumeDraft(null);
    navigate(supportPath, { replace: true, state: {} });
    void load();
  }, [load, navigate, supportPath]);

  const startNewRequest = useCallback(() => {
    setShowWizard(true);
    setDraftMessage('');
  }, []);

  const createAction = useMemo(
    () => (
      <button
        type="button"
        className="cart-header-btn cart-header-btn--primary"
        onClick={startNewRequest}
        aria-label="New request"
        title="New request"
      >
        <Plus size={22} />
      </button>
    ),
    [startNewRequest],
  );

  if (!canUseSupport && !isOps) {
    return (
      <div className="page-content fade-in warranty-support-page">
        <div className="warranty-support-page__empty panel glass">
          <LifeBuoy size={40} aria-hidden />
          <h3>Warranty &amp; Support</h3>
          <p className="text-muted text-sm">Available to dealer accounts.</p>
        </div>
      </div>
    );
  }

  if (isOps && user) {
    return (
      <div className="page-content fade-in warranty-support-page">
        {showWizard ? (
          <SupportWizard
            user={user}
            productDraft={null}
            initialIntent={initialIntent}
            opsCreateMode={canCreateOnBehalf}
            initialOnBehalfDealer={initialOnBehalfDealer}
            initialDealerQuery={initialDealerQuery}
            dealerLookupStatus={dealerLookupStatus}
            onCancel={closeWizard}
            onSuccess={handleWizardSuccess}
          />
        ) : (
          <StaffSupportQueue />
        )}
      </div>
    );
  }

  if (!canUseSupport) {
    return null;
  }

  return (
    <div className="page-content fade-in warranty-support-page">
      {draftMessage && !showWizard && (
        <div className="services-page__success panel glass">
          {draftMessage}
        </div>
      )}


      {error && (
        <div className="products-inline-error panel glass services-page__error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {showWizard ? (
        <SupportWizard
          user={user!}
          productDraft={productDraft}
          initialIntent={initialIntent}
          resumeDraft={resumeDraft}
          onCancel={closeWizard}
          onSuccess={handleWizardSuccess}
          onDraftSaved={handleDraftSaved}
        />
      ) : (
        <DealerSupportRequestList
          requests={requests}
          loading={loading}
          onOpenRequest={openRequest}
          onRefresh={load}
          trailingAction={(canMutateSupport || canCreateOnBehalf) ? createAction : null}
        />
      )}
    </div>
  );
};
