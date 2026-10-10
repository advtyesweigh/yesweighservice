import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ChevronRight,
  HelpCircle,
  MessageSquareWarning,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import { createSupportChatRequest, createSupportRequest, deleteSupportRequestDraft, saveSupportRequestDraft, supportComplaintGuidelinesPath } from '../../lib/dealerSupport';
import { useConfirm } from '../../context/ConfirmContext';
import { useCatalogPageHeader, useTopBarAction } from '../../context/PageHeaderContext';
import { SupportChatLogo } from './SupportChatLogo';
import { SupportRequestSubmittedSummary } from './SupportRequestSubmittedSummary';
import type { User } from '../../types';
import type {
  DealerSupportRequest,
  SupportProductDraft,
  SupportRequestType,
} from '../../types/dealer-support';
import { isInternalOpsUser } from '../../lib/staffAccess';
import { supportDisplayLabel } from '../../lib/supportStatus';
import { supportRequestStageSubtitle } from '../../lib/supportRequestDisplay';
import {
  COMPLAINT_CATEGORY_OPTIONS,
  RETURN_REASON_OPTIONS,
  SERVICE_ISSUE_OPTIONS,
  SUPPORT_INTENT_OPTIONS,
  SUPPORT_CHAT_OPTION,
  SUPPORT_TYPE_LABELS,
  complaintCategoryDisplayLabel,
  supportCategoryValueFromStored,
} from '../../types/dealer-support';
import {
  SupportEvidencePicker,
  cleanupPendingFiles,
  pendingFilesToUpload,
} from './SupportEvidencePicker';
import { SupportAttachmentPicker } from './SupportAttachmentPicker';
import { validateEvidenceFiles, startSupportFileUploadJob, supportUploadErrorMessage, type SupportSubmitProgress, type PendingSupportFile } from '../../lib/supportAttachments';
import { SupportWizardSubmitProgress } from './SupportWizardSubmitProgress';
import { SupportInvoiceProductPicker, SupportProductLineCard } from './SupportInvoiceFields';
import { SupportDeclarationStep } from './SupportDeclarationStep';
import { dateInputValueFromIso, isoFromDateInput, SupportDealerPicker } from './SupportDealerPicker';
import { SUPPORT_DECLARATION_TITLE } from '../../constants/supportDeclaration';
import type { SupportOnBehalfDealer } from '../../types/dealer-support';

type WizardStep = 'dealer' | 'intent' | 'product' | 'details' | 'declaration' | 'success';

function requestToProductDraft(request: DealerSupportRequest): SupportProductDraft | null {
  if (!request.invoiceId || !request.invoiceNumber || !request.product?.lineItemId) {
    return null;
  }
  return {
    invoiceId: request.invoiceId,
    invoiceNumber: request.invoiceNumber,
    salesOrderNumber: request.salesOrderNumber,
    lineItemId: request.product.lineItemId,
    itemId: request.product.itemId,
    itemName: request.product.name,
    itemSku: request.product.sku,
    quantity: request.product.quantity,
  };
}

function initialWizardStep(
  opsCreateMode: boolean,
  initialIntent?: SupportRequestType | null,
  productDraft?: SupportProductDraft | null,
  resumeDraft?: DealerSupportRequest | null,
  initialOnBehalfDealer?: SupportOnBehalfDealer | null,
): WizardStep {
  if (resumeDraft) return 'details';
  if (opsCreateMode && initialOnBehalfDealer && initialIntent) {
    if (productDraft) return 'details';
    if (initialIntent === 'complaint') return 'details';
    return 'product';
  }
  if (opsCreateMode) return 'dealer';
  if (productDraft && initialIntent) return 'details';
  if (initialIntent === 'complaint') return 'details';
  if (initialIntent) return 'product';
  return 'intent';
}

function progressStepState(
  step: WizardStep,
  target: 1 | 2 | 3,
): 'is-active' | 'is-done' | '' {
  const order: Record<WizardStep, number> = {
    dealer: 0,
    intent: 1,
    product: 2,
    details: 3,
    declaration: 4,
    success: 5,
  };
  const current = order[step];
  if (target < current) return 'is-done';
  if (target === current) return 'is-active';
  return '';
}

interface SupportWizardProps {
  user: User;
  productDraft: SupportProductDraft | null;
  initialIntent?: SupportRequestType | null;
  resumeDraft?: DealerSupportRequest | null;
  opsCreateMode?: boolean;
  initialOnBehalfDealer?: SupportOnBehalfDealer | null;
  initialDealerQuery?: string;
  dealerLookupStatus?: 'none' | 'multiple' | 'matched' | null;
  onCancel: () => void;
  onSuccess: (requestNumber: string, type: SupportRequestType, requestId: string) => void;
  onDraftSaved?: (requestNumber: string, requestId: string) => void;
}

const INTENT_ICONS: Record<SupportRequestType, React.ReactNode> = {
  service: <Wrench size={22} strokeWidth={2.2} />,
  return: <RotateCcw size={22} strokeWidth={2.2} />,
  complaint: <MessageSquareWarning size={22} strokeWidth={2.2} />,
  chat: <SupportChatLogo size={28} />,
};

function supportActionErrorMessage(err: unknown, fallback: string): string {
  return supportUploadErrorMessage(err, fallback);
}

export const SupportWizard: React.FC<SupportWizardProps> = ({
  user,
  productDraft,
  initialIntent,
  resumeDraft,
  opsCreateMode = false,
  initialOnBehalfDealer = null,
  initialDealerQuery = '',
  dealerLookupStatus = null,
  onCancel,
  onSuccess,
  onDraftSaved,
}) => {
  const [step, setStep] = useState<WizardStep>(() =>
    initialWizardStep(opsCreateMode, initialIntent, productDraft, resumeDraft, initialOnBehalfDealer),
  );
  const [intent, setIntent] = useState<SupportRequestType | null>(
    resumeDraft?.type ?? initialIntent ?? null,
  );
  const [category, setCategory] = useState(() => {
    if (resumeDraft) {
      return supportCategoryValueFromStored(resumeDraft.type, resumeDraft.category);
    }
    return initialIntent === 'service' ? 'repair' : initialIntent === 'return' ? 'doa' : 'logistics_delivery';
  });
  const [description, setDescription] = useState(resumeDraft?.description ?? '');
  const [serialNumber, setSerialNumber] = useState(resumeDraft?.product?.serialNumber ?? '');
  const [productSelection, setProductSelection] = useState<SupportProductDraft | null>(
    productDraft ?? (resumeDraft ? requestToProductDraft(resumeDraft) : null),
  );
  const [proceedWithoutInvoice, setProceedWithoutInvoice] = useState(
    () => Boolean(resumeDraft && !requestToProductDraft(resumeDraft)),
  );
  const [draftRequestId, setDraftRequestId] = useState(resumeDraft?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState(() => {
    if (dealerLookupStatus === 'none') {
      return 'No dealer is linked to this WhatsApp number. Search and select one to continue.';
    }
    if (dealerLookupStatus === 'multiple') {
      return 'Several dealers share this number. Select the right one.';
    }
    return '';
  });
  const [submittedRequestNumber, setSubmittedRequestNumber] = useState('');
  const [createdRequestId, setCreatedRequestId] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingSupportFile[]>([]);
  const [submitProgress, setSubmitProgress] = useState<SupportSubmitProgress | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [declarationAgreed, setDeclarationAgreed] = useState(false);
  const [submittedRequest, setSubmittedRequest] = useState<DealerSupportRequest | null>(null);
  const [onBehalfDealer, setOnBehalfDealer] = useState<SupportOnBehalfDealer | null>(() => {
    if (initialOnBehalfDealer?.zohoCustomerId) return initialOnBehalfDealer;
    if (!resumeDraft?.createdOnBehalfOf || !resumeDraft.zohoCustomerId) return null;
    return {
      zohoCustomerId: resumeDraft.zohoCustomerId,
      dealerName: resumeDraft.dealerName ?? 'Dealer',
      portalUserId: resumeDraft.dealerId !== resumeDraft.zohoCustomerId ? resumeDraft.dealerId : null,
    };
  });
  const [occurredAtDate, setOccurredAtDate] = useState(() =>
    dateInputValueFromIso(resumeDraft?.createdAt ?? new Date().toISOString()),
  );
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  const draftRequestIdRef = useRef(draftRequestId);
  draftRequestIdRef.current = draftRequestId;
  const ensureDraftInflight = useRef<Promise<string> | null>(null);

  const isBusy = submitting || savingDraft || discarding || startingChat;

  const categoryOptions = useMemo(() => {
    if (intent === 'return') return RETURN_REASON_OPTIONS;
    if (intent === 'complaint') return COMPLAINT_CATEGORY_OPTIONS;
    return SERVICE_ISSUE_OPTIONS;
  }, [intent]);

  const categoryLabel = useMemo(
    () => categoryOptions.find(option => option.value === category)?.label ?? category,
    [category, categoryOptions],
  );

  const needsProduct = intent === 'service' || intent === 'return';
  const isGeneralSupport = intent === 'complaint';
  const invoiceCacheKey = onBehalfDealer?.zohoCustomerId ?? user.uid;
  const invoiceCustomerId = onBehalfDealer?.zohoCustomerId;

  const handleDealerNext = () => {
    if (!onBehalfDealer) {
      setError('Select a dealer to continue.');
      return;
    }
    if (!occurredAtDate) {
      setError('Select the request date.');
      return;
    }
    setError('');
    setStep('intent');
  };

  const selectIntent = (value: SupportRequestType) => {
    setIntent(value);
    setCategory(
      value === 'service' ? 'repair' : value === 'return' ? 'doa' : 'logistics_delivery',
    );
    setError('');
  };

  const proceedWithIntent = (value: SupportRequestType) => {
    if (value === 'chat') return;
    selectIntent(value);
    setStep(value === 'complaint' ? 'details' : 'product');
  };

  const startGenericChat = async () => {
    if (startingChat) return;
    setStartingChat(true);
    setError('');
    try {
      const request = await createSupportChatRequest(user);
      onSuccess(request.requestNumber, 'chat', request.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start chat.');
    } finally {
      setStartingChat(false);
    }
  };

  const hasProductLink = Boolean(productDraft || productSelection);

  const handleProductSelectionChange = useCallback((draft: SupportProductDraft | null) => {
    setProductSelection(draft);
    if (draft) {
      setProceedWithoutInvoice(false);
      setError('');
    }
  }, []);

  const handleProceedWithoutInvoiceChange = useCallback((checked: boolean) => {
    setProceedWithoutInvoice(checked);
    setError('');
    if (checked) {
      setProductSelection(null);
    }
  }, []);

  const handleProductNext = useCallback(() => {
    if (needsProduct && !hasProductLink && !proceedWithoutInvoice) {
      setError(
        intent === 'return'
          ? 'Select a product invoiced in the last 10 days.'
          : 'Select an invoice and product, or choose to continue without an invoice.',
      );
      return;
    }
    setError('');
    setStep('details');
  }, [intent, needsProduct, hasProductLink, proceedWithoutInvoice]);

  const buildRequestPayload = () => {
    const selection = productDraft ?? productSelection;
    const categoryDisplay = isGeneralSupport
      ? complaintCategoryDisplayLabel(category)
      : categoryLabel;

    return {
      type: intent!,
      requestId: draftRequestId || undefined,
      onBehalfOf: opsCreateMode ? onBehalfDealer ?? undefined : undefined,
      occurredAt: opsCreateMode ? isoFromDateInput(occurredAtDate) : undefined,
      invoiceId: isGeneralSupport ? null : selection?.invoiceId ?? null,
      invoiceNumber: isGeneralSupport ? null : selection?.invoiceNumber ?? null,
      salesOrderNumber: isGeneralSupport ? null : selection?.salesOrderNumber ?? null,
      lineItemId: isGeneralSupport ? null : selection?.lineItemId ?? null,
      itemId: isGeneralSupport ? null : selection?.itemId ?? null,
      itemName: isGeneralSupport ? undefined : selection?.itemName,
      itemSku: isGeneralSupport ? null : selection?.itemSku ?? null,
      serialNumber: isGeneralSupport ? null : serialNumber.trim() || null,
      quantity: isGeneralSupport ? undefined : selection?.quantity ?? 1,
      category: categoryDisplay,
      subject: isGeneralSupport ? categoryDisplay : undefined,
      description: description.trim(),
    };
  };

  const ensureDraftId = useCallback(async () => {
    if (draftRequestIdRef.current) return draftRequestIdRef.current;
    if (ensureDraftInflight.current) return ensureDraftInflight.current;

    const work = saveSupportRequestDraft(user, buildRequestPayload()).then(saved => {
      draftRequestIdRef.current = saved.id;
      setDraftRequestId(saved.id);
      return saved.id;
    });
    ensureDraftInflight.current = work;
    try {
      return await work;
    } finally {
      if (ensureDraftInflight.current === work) ensureDraftInflight.current = null;
    }
  }, [user]);

  const handleEvidenceFileReady = useCallback((file: PendingSupportFile) => {
    void ensureDraftId()
      .then(requestId => {
        startSupportFileUploadJob(requestId, file.id, file.file, {
          isInitial: true,
          alreadyPrepared: true,
        });
      })
      .catch(() => {
        // Submit still uploads if the draft could not be created yet.
      });
  }, [ensureDraftId]);

  const handleSaveDraft = async () => {
    if (!intent) return;

    if (needsProduct && !hasProductLink && !proceedWithoutInvoice) {
      setError('Select an invoice and product, or continue without an invoice, before saving a draft.');
      return;
    }

    setSavingDraft(true);
    setSubmitProgress({ phase: 'preparing', label: 'Saving draft…', percent: null });
    setError('');
    try {
      const saved = await saveSupportRequestDraft(user, buildRequestPayload());
      draftRequestIdRef.current = saved.id;
      setDraftRequestId(saved.id);
      setSubmitProgress({ phase: 'finalizing', label: 'Draft saved', percent: 100 });
      onDraftSaved?.(saved.requestNumber, saved.id);
    } catch (err) {
      setError(supportActionErrorMessage(err, 'Could not save draft.'));
    } finally {
      setSavingDraft(false);
      setSubmitProgress(null);
    }
  };

  const handleDiscardDraft = async () => {
    if (!draftRequestId) {
      onCancel();
      return;
    }
    const ok = await confirm({
      title: 'Discard draft?',
      message: 'This will permanently delete the saved draft.',
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return;

    setDiscarding(true);
    setError('');
    try {
      await deleteSupportRequestDraft(user, draftRequestId);
      onCancel();
    } catch (err) {
      setError(supportActionErrorMessage(err, 'Could not discard draft.'));
    } finally {
      setDiscarding(false);
    }
  };

  const validateDetails = (): boolean => {
    if (!intent) return false;

    if (!description.trim()) {
      setError('Please describe the issue.');
      return false;
    }
    if (needsProduct && !(intent === 'service' && proceedWithoutInvoice) && !serialNumber.trim()) {
      setError('Enter the serial number or MAC ID.');
      return false;
    }
    if (!isGeneralSupport && !opsCreateMode) {
      const evidenceError = validateEvidenceFiles(pendingFiles, {
        videoOnly: intent === 'service' && proceedWithoutInvoice,
      });
      if (evidenceError) {
        setError(evidenceError);
        return false;
      }
    }
    return true;
  };

  const handleDetailsNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateDetails()) return;
    setError('');
    if (isGeneralSupport || opsCreateMode) {
      void submitRequestRef.current();
      return;
    }
    setStep('declaration');
  };

  const submitRequestRef = useRef<() => Promise<void>>(async () => {});

  submitRequestRef.current = async () => {
    if (!intent) return;

    setSubmitting(true);
    setSubmitProgress({ phase: 'preparing', label: 'Starting submit…', percent: 2 });
    setError('');
    try {
      const created = await createSupportRequest(user, {
        ...buildRequestPayload(),
        attachmentFiles: pendingFilesToUpload(pendingFiles),
        pendingFileIds: pendingFiles.map(file => file.id),
      }, setSubmitProgress);
      cleanupPendingFiles(pendingFiles);
      setPendingFiles([]);
      setStep('success');
      setSubmittedRequestNumber(created.requestNumber);
      setCreatedRequestId(created.id);
    } catch (err) {
      setError(supportActionErrorMessage(err, 'Could not submit request.'));
    } finally {
      setSubmitting(false);
      setSubmitProgress(null);
    }
  };

  const handleDeclarationContinue = useCallback(() => {
    if (!declarationAgreed) {
      setError('You must agree to the Warranty & Service Declaration to continue.');
      return;
    }
    const evidenceError = validateEvidenceFiles(pendingFiles, {
      videoOnly: intent === 'service' && proceedWithoutInvoice,
    });
    if (evidenceError) {
      setError(evidenceError);
      setStep('details');
      return;
    }
    setError('');
    void submitRequestRef.current();
  }, [declarationAgreed, pendingFiles, intent, proceedWithoutInvoice]);

  const wizardTitle = useMemo(() => {
    if (step === 'success') {
      return submittedRequest?.requestNumber ?? submittedRequestNumber ?? 'Request submitted';
    }
    if (step === 'declaration') return SUPPORT_DECLARATION_TITLE;
    if (step === 'dealer') return 'Dealer & date';
    if (step === 'intent') return opsCreateMode ? 'Request type' : 'New request';
    if (step === 'product') return intent === 'service' ? 'Product complaint' : needsProduct ? 'Invoice & product' : 'Link invoice';
    if (isGeneralSupport) return 'General support';
    return 'Request details';
  }, [step, intent, needsProduct, isGeneralSupport, submittedRequest, submittedRequestNumber]);

  const wizardSubtitle = useMemo(() => {
    if (step !== 'success' || !submittedRequest) return null;
    return supportRequestStageSubtitle(submittedRequest)
      || supportDisplayLabel(submittedRequest, isInternalOpsUser(user) ? 'staff' : 'dealer');
  }, [step, submittedRequest, user]);

  const handleWizardBack = useCallback(() => {
    if (step === 'intent' || step === 'success') {
      onCancel();
      return;
    }
    if (step === 'product') {
      if (initialIntent) onCancel();
      else setStep('intent');
      return;
    }
    if (step === 'declaration') {
      setStep('details');
      return;
    }
    if (step === 'details') {
      if (productDraft) {
        onCancel();
        return;
      }
      if (isGeneralSupport) {
        if (initialIntent) onCancel();
        else setStep('intent');
        return;
      }
      setStep('product');
    }
  }, [step, initialIntent, productDraft, isGeneralSupport, onCancel]);

  const handleSuccessDone = useCallback(() => {
    if (submittedRequestNumber && intent && createdRequestId) {
      onSuccess(submittedRequestNumber, intent, createdRequestId);
      return;
    }
    onCancel();
  }, [submittedRequestNumber, intent, createdRequestId, onSuccess, onCancel]);

  // Keep action handlers in refs so the top-bar slot identity stays stable.
  // Unstable callback deps would recreate the slot every render and loop via
  // useTopBarAction → PageHeaderContext → parent re-render (React #185).
  const proceedWithIntentRef = useRef(proceedWithIntent);
  proceedWithIntentRef.current = proceedWithIntent;
  const handleProductNextRef = useRef(handleProductNext);
  handleProductNextRef.current = handleProductNext;
  const handleDeclarationContinueRef = useRef(handleDeclarationContinue);
  handleDeclarationContinueRef.current = handleDeclarationContinue;
  const handleSuccessDoneRef = useRef(handleSuccessDone);
  handleSuccessDoneRef.current = handleSuccessDone;

  useCatalogPageHeader({
    title: wizardTitle,
    subtitle: wizardSubtitle,
    showBack: step !== 'success',
    onBack: handleWizardBack,
  });

  const wizardTopBarAction = useMemo(() => {
    if (step === 'intent' && intent) {
      const selectedIntent = intent;
      return (
        <button
          type="button"
          className="top-bar__action-btn top-bar__action-btn--primary"
          onClick={() => proceedWithIntentRef.current(selectedIntent)}
        >
          Next
        </button>
      );
    }
    if (step === 'product' && intent) {
      return (
        <button
          type="button"
          className="top-bar__action-btn top-bar__action-btn--primary"
          onClick={() => handleProductNextRef.current()}
          disabled={isBusy}
        >
          Next
        </button>
      );
    }
    if (step === 'details' && intent) {
      return (
        <button
          type="button"
          className="top-bar__action-btn top-bar__action-btn--primary"
          onClick={() => formRef.current?.requestSubmit()}
          disabled={isBusy}
        >
          {isGeneralSupport ? (submitting ? 'Submitting…' : 'Submit') : 'Next'}
        </button>
      );
    }
    if (step === 'declaration') {
      return (
        <button
          type="button"
          className="top-bar__action-btn top-bar__action-btn--primary"
          onClick={() => handleDeclarationContinueRef.current()}
          disabled={isBusy || !declarationAgreed}
        >
          {submitting ? 'Submitting…' : 'Continue'}
        </button>
      );
    }
    if (step === 'success') {
      return (
        <button
          type="button"
          className="top-bar__action-btn top-bar__action-btn--primary"
          onClick={() => handleSuccessDoneRef.current()}
        >
          Done
        </button>
      );
    }
    return null;
  }, [step, intent, isBusy, submitting, isGeneralSupport, declarationAgreed]);

  useTopBarAction(wizardTopBarAction, Boolean(wizardTopBarAction));

  if (step === 'success' && intent) {
    return (
      <div className="support-wizard__success-wrap">
        <div className="support-wizard__success panel glass">
          <div className="support-wizard__success-icon" aria-hidden>
            {INTENT_ICONS[intent]}
          </div>
          <h3>Request submitted</h3>
          {submittedRequestNumber && (
            <p className="support-wizard__request-number">{submittedRequestNumber}</p>
          )}
          <p className="text-muted text-sm">
            Your {SUPPORT_TYPE_LABELS[intent].toLowerCase()} request has been logged.
            {' '}Review the ticket details below.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSuccessDone}
          >
            Back to requests
          </button>
        </div>

        {createdRequestId && (
          <SupportRequestSubmittedSummary
            requestId={createdRequestId}
            user={user}
            onRequestLoaded={setSubmittedRequest}
            onCancelled={handleSuccessDone}
          />
        )}
      </div>
    );
  }

  const selectedProduct = productDraft ?? productSelection;

  return (
    <div className={['support-wizard', step === 'product' ? 'support-wizard--product' : ''].filter(Boolean).join(' ')}>
      <div
        className={`support-wizard__progress support-wizard__progress--three${
          step === 'dealer'
          || step === 'intent'
          || step === 'declaration'
          || (step === 'details' && (isGeneralSupport || opsCreateMode))
            ? ' support-wizard__progress--hidden'
            : ''
        }`}
        aria-hidden={
          step === 'dealer'
          || step === 'intent'
          || step === 'declaration'
          || (step === 'details' && (isGeneralSupport || opsCreateMode))
        }
      >
        <span className={progressStepState(step, 1)}>1</span>
        <span className="support-wizard__progress-line" />
        <span className={progressStepState(step, 2)}>2</span>
        <span className="support-wizard__progress-line" />
        <span className={progressStepState(step, 3)}>3</span>
      </div>

      {error && <p className="support-wizard__error">{error}</p>}

      {step === 'dealer' && opsCreateMode && (
        <section className="support-wizard__step support-wizard__step--details panel glass">
          <div className="support-wizard__step-body">
            <SupportDealerPicker
              value={onBehalfDealer}
              onChange={setOnBehalfDealer}
              disabled={isBusy}
              initialQuery={initialDealerQuery}
            />
            <div className="form-group">
              <label htmlFor="support-occurred-at">Request date</label>
              <input
                id="support-occurred-at"
                type="date"
                className="catalog-select"
                value={occurredAtDate}
                max={dateInputValueFromIso(new Date().toISOString())}
                onChange={e => setOccurredAtDate(e.target.value)}
                disabled={isBusy}
                required
              />
            </div>
          </div>
          <div className="support-wizard__actions support-wizard__actions--dock">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={isBusy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleDealerNext} disabled={isBusy}>
              Continue
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      )}

      {step === 'intent' && (
        <section className="support-wizard__intent">
          <h2 className="support-wizard__question">What do you need help with?</h2>

          <div className="support-wizard__options" role="radiogroup" aria-label="Support type">
            {SUPPORT_INTENT_OPTIONS.map(option => {
              const selected = intent === option.value;
              return (
                <div
                  key={option.value}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  className={`support-wizard__option support-wizard__option--${option.value} ${selected ? 'is-selected' : ''}`}
                  onClick={() => selectIntent(option.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectIntent(option.value);
                    }
                  }}
                >
                  <span className="support-wizard__option-icon">{INTENT_ICONS[option.value]}</span>
                  <span className="support-wizard__option-body">
                    <strong>{option.title}</strong>
                    <span className="support-wizard__option-desc">{option.description}</span>
                    {option.hint ? (
                      <span className="support-wizard__option-hint">{option.hint}</span>
                    ) : null}
                    {selected && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm support-wizard__option-next"
                        onClick={e => {
                          e.stopPropagation();
                          proceedWithIntent(option.value);
                        }}
                      >
                        Next
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </span>
                  {!selected && (
                    <ChevronRight size={20} className="support-wizard__option-chevron" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>

          {!opsCreateMode && (
          <button
            type="button"
            className="support-wizard__option support-wizard__option--chat"
            disabled={startingChat}
            onClick={() => void startGenericChat()}
          >
            <span className="support-wizard__option-icon support-wizard__option-icon--chat-logo">
              <SupportChatLogo size={30} />
            </span>
            <span className="support-wizard__option-body">
              <strong>{SUPPORT_CHAT_OPTION.title}</strong>
              <span className="support-wizard__option-desc">{SUPPORT_CHAT_OPTION.description}</span>
              <span className="support-wizard__option-hint">{SUPPORT_CHAT_OPTION.hint}</span>
            </span>
            <ChevronRight size={20} className="support-wizard__option-chevron" aria-hidden />
          </button>
          )}

          {!opsCreateMode && (
          <div className="support-wizard__help-footer">
            <h3 className="support-wizard__help-title">Need help choosing?</h3>
            <Link
              to={supportComplaintGuidelinesPath(user.role)}
              state={{ openWizard: true }}
              className="support-wizard__guidelines-link"
            >
              <span className="support-wizard__guidelines-link-icon" aria-hidden>
                <HelpCircle size={18} />
              </span>
              <span className="support-wizard__guidelines-link-label">View Complaint Guidelines</span>
              <ChevronRight size={18} className="support-wizard__guidelines-link-chevron" aria-hidden />
            </Link>
          </div>
          )}
        </section>
      )}

      {step === 'product' && intent && needsProduct && (
        <section className="support-wizard__step support-wizard__step--details support-wizard__step--product-picker">
          <div className="support-wizard__step-body">
            {intent === 'return' && (
              <h3 className="support-wizard__question">
                Select a product invoiced in the last 10 days
              </h3>
            )}

            {productDraft && (
              <SupportProductLineCard
                invoiceNumber={productDraft.invoiceNumber}
                invoiceDate={productDraft.invoiceDate}
                name={productDraft.itemName}
                sku={productDraft.itemSku}
                quantity={productDraft.quantity}
                imageUrl={productDraft.imageUrl}
                serials={productDraft.serialNumbers}
                staticCard
              />
            )}

            {!productDraft && (
              <>
                {intent === 'service' && (
                  <>
                    <label className="support-wizard__no-invoice support-wizard__no-invoice--priority">
                      <input
                        type="checkbox"
                        checked={proceedWithoutInvoice}
                        disabled={isBusy}
                        onChange={e => handleProceedWithoutInvoiceChange(e.target.checked)}
                      />
                      <span>
                        Continue without an invoice
                        <span className="support-wizard__no-invoice-hint">
                          Use this when the product is out of warranty or the invoice is not available.
                        </span>
                        {proceedWithoutInvoice && (
                          <span className="support-wizard__out-of-warranty-disclaimer">
                            This request will be treated as an out of warranty service.
                          </span>
                        )}
                      </span>
                    </label>
                    {proceedWithoutInvoice && (
                      <button
                        type="button"
                        className="btn btn-primary support-wizard__out-of-warranty-next"
                        disabled={isBusy}
                        onClick={handleProductNext}
                      >
                        Next
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </>
                )}

                {!(intent === 'service' && proceedWithoutInvoice) && (
                  <>
                    {intent === 'service' && (
                      <h4 className="support-wizard__warranty-heading">Products under warranty</h4>
                    )}
                    <SupportInvoiceProductPicker
                      key={proceedWithoutInvoice ? 'no-invoice' : 'with-invoice'}
                      cacheKey={invoiceCacheKey}
                      customerId={invoiceCustomerId}
                      value={productSelection}
                      onChange={handleProductSelectionChange}
                      onNext={handleProductNext}
                      onMatchedSerial={setSerialNumber}
                      disabled={isBusy || proceedWithoutInvoice}
                      invoiceRequired={!proceedWithoutInvoice}
                      requestType={intent === 'service' || intent === 'return' ? intent : undefined}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {step === 'details' && intent && (
        <form
          ref={formRef}
          className={[
            'support-wizard__step support-wizard__step--details panel glass',
            isBusy && submitProgress ? 'support-wizard__step--busy' : '',
          ].filter(Boolean).join(' ')}
          onSubmit={e => handleDetailsNext(e)}
        >
          <div className="support-wizard__step-body">
          {(intent === 'return' || isGeneralSupport) && (
            <h3 className="support-wizard__question">
              {intent === 'return' && 'Replacement request details'}
              {isGeneralSupport && 'What do you need help with?'}
            </h3>
          )}

          {selectedProduct ? (
            <SupportProductLineCard
              invoiceNumber={selectedProduct.invoiceNumber}
              invoiceDate={selectedProduct.invoiceDate}
              name={selectedProduct.itemName}
              sku={selectedProduct.itemSku}
              quantity={selectedProduct.quantity}
              imageUrl={selectedProduct.imageUrl}
              serials={selectedProduct.serialNumbers}
              staticCard
            />
          ) : (
            needsProduct && proceedWithoutInvoice && (
              <p className="text-sm text-muted support-wizard__no-invoice-banner">
                This request will be treated as an out of warranty service. Upload a complaint video below.
              </p>
            )
          )}

          {needsProduct && !(intent === 'service' && proceedWithoutInvoice) && (
            <div className="form-group">
              <label htmlFor="support-serial">
                Serial number / MAC ID
                <span className="form-label__required" aria-hidden> *</span>
              </label>
              <input
                id="support-serial"
                className="catalog-select"
                value={serialNumber}
                onChange={e => setSerialNumber(e.target.value)}
                placeholder="Enter serial number or MAC ID"
                disabled={isBusy}
                required
              />
            </div>
          )}

          {isGeneralSupport ? (
            <fieldset className="form-group support-wizard__categories">
              <legend className="support-wizard__categories-label">
                Issue category
                <span className="form-label__required" aria-hidden> *</span>
              </legend>
              <div className="support-wizard__categories-grid" role="radiogroup" aria-label="Issue category">
                {COMPLAINT_CATEGORY_OPTIONS.map(option => {
                  const selected = category === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`support-wizard__category${selected ? ' is-selected' : ''}`}
                      onClick={() => setCategory(option.value)}
                      disabled={isBusy}
                    >
                      <span className="support-wizard__category-emoji" aria-hidden>{option.emoji}</span>
                      <span className="support-wizard__category-label">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <div className="form-group">
              <label htmlFor="support-category">
                {intent === 'service' && 'Issue type'}
                {intent === 'return' && 'Replacement reason'}
                <span className="form-label__required" aria-hidden> *</span>
              </label>
              <select
                id="support-category"
                className="catalog-select"
                value={category}
                onChange={e => setCategory(e.target.value)}
              >
                {categoryOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="support-description">
              {isGeneralSupport ? 'Describe your issue' : 'Describe the problem'}
              <span className="form-label__required" aria-hidden> *</span>
            </label>
            <textarea
              id="support-description"
              className="service-request-form__textarea"
              rows={4}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={
                intent === 'return'
                  ? proceedWithoutInvoice && !selectedProduct
                    ? 'Product name/model, when the fault started, error messages, and why there is no invoice…'
                    : 'When did the fault start? Any error messages or photos available?'
                  : isGeneralSupport
                    ? 'Include relevant order numbers, dates, or names if helpful — invoice and product details are not required.'
                    : proceedWithoutInvoice && !selectedProduct
                      ? 'Product name/model, symptoms, error codes, when it started, and why there is no invoice…'
                      : 'Symptoms, error codes, when it started, etc.'
              }
            />
          </div>

          <div className="form-group form-group--flush">
            {isGeneralSupport ? (
              <SupportAttachmentPicker
                files={pendingFiles}
                onChange={setPendingFiles}
                disabled={isBusy}
              />
            ) : (
              <SupportEvidencePicker
                files={pendingFiles}
                onChange={setPendingFiles}
                disabled={isBusy}
                videoOnly={intent === 'service' && proceedWithoutInvoice}
                onFileReady={handleEvidenceFileReady}
                onCaptureStart={() => { void ensureDraftId(); }}
              />
            )}
          </div>
          </div>

          <div className="support-wizard__actions support-wizard__actions--dock" aria-label="Form actions">
            {isBusy && submitProgress && (
              <SupportWizardSubmitProgress progress={submitProgress} />
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void (draftRequestId ? handleDiscardDraft() : onCancel())}
              disabled={isBusy}
            >
              {draftRequestId ? 'Discard draft' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void handleSaveDraft()}
              disabled={isBusy || opsCreateMode}
            >
              {savingDraft ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={isBusy}
            >
              {isGeneralSupport || opsCreateMode ? (submitting ? 'Submitting…' : 'Submit') : 'Next'}
              {!isGeneralSupport && !opsCreateMode && <ArrowRight size={16} />}
            </button>
          </div>
        </form>
      )}

      {step === 'declaration' && intent && (
        <SupportDeclarationStep
          agreed={declarationAgreed}
          onAgreedChange={setDeclarationAgreed}
          onContinue={handleDeclarationContinue}
          disabled={isBusy}
          submitting={submitting}
          submitProgress={submitProgress}
          error={error}
        />
      )}
    </div>
  );
};
