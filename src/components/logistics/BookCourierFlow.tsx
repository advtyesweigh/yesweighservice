import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Barcode,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Combine,
  Keyboard,
  Lock,
  Mail,
  MapPin,
  Package,
  Pencil,
  Plus,
  Printer,
  ScanLine,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { DecimalTextInput } from '../DecimalAmountInput';
import { FIRM_GSTIN, FIRM_NAME, FIRM_PHONE } from '../../constants/brand';
import {
  BLUE_DART_AIR_MAX_CHARGEABLE_KG,
  BLUE_DART_AIR_MIN_CHARGEABLE_KG,
  BLUE_DART_DP_MAX_CHARGEABLE_KG,
  blueDartAirMaxChargeableExceeded,
  blueDartAirMaxChargeableReason,
  blueDartDpMaxChargeableExceeded,
  blueDartDpMaxChargeableReason,
} from '../../constants/blueDartRates';
import { logisticsPartnerLabel, isBlueDartLogisticsPartnerId } from '../../constants/logisticsPartners';
import type { LogisticsPartnerId } from '../../constants/logisticsPartners';
import {
  ST_COURIER_TAMIL_NADU_MAX_CHARGEABLE_KG,
  isTamilNaduDestination,
  stCourierTamilNaduMaxChargeableExceeded,
  stCourierTamilNaduMaxChargeableReason,
} from '../../lib/stCourierZone';
import { fetchDealerById } from '../../lib/dealers';
import {
  ensureDealersCached,
  peekCachedDealers,
  subscribeDealerCache,
} from '../../lib/dealer-cache';
import {
  SHIPMENT_MODES,
  bookCourierStepsForBooking,
  bookStepFlowIndex,
  bookStepProgressVisualState,
  ceilChargeableWeightKg,
  combineShipmentBoxDrafts,
  computeVolumetricWeight,
  draftBoxesHaveRequiredPhotos,
  emptyBookingDraft,
  emptyShipmentBoxDraft,
  isApiBookedLogisticsPartner,
  parseCourierBarcode,
  suggestCombinedBoxDims,
  sumDraftBoxWeightsKg,
  type BookCourierStep,
} from '../../lib/logisticsBooking';
import {
  dealerMatchesLogisticsQuery,
  hasExplicitDraftDeliveryAddress,
  isPlaceholderLogisticsAddress,
  logisticsAddressesMatch,
  logisticsDealerHasDeliveryAddress,
  mergeZohoDealerLists,
  phoneDigitsForCourier,
  preferRicherZohoDealer,
  reconcileDocumentDeliveryAddress,
  resolveDraftDeliveryAddress,
  resolveReceiverPhoneFromSnapshot,
  zohoDealerToSnapshot,
} from '../../lib/logisticsDealers';
import {
  findLogisticsBookingForInvoice,
  persistLogisticsBooking,
  uploadLogisticsBookingFinalPackagePhoto,
} from '../../lib/logisticsBookings';
import {
  logisticsCaptureToDataUrl,
  resolveLogisticsPhotoUrls,
} from '../../lib/logisticsPhotos';
import {
  extractCityState,
  extractDestinationCity,
} from '../../lib/shippingLabel';
import {
  bindLogisticsVaultSessionToBooking,
  clearUploadedLogisticsVaultPhotos,
  deleteLogisticsVaultPhoto,
  forgetLogisticsPhotoSessionKey,
  listLatestUnuploadedVaultSession,
  listLogisticsVaultPhotos,
  logisticsPhotoSessionKey,
  patchLogisticsVaultPhoto,
  putLogisticsVaultPhoto,
  rememberLogisticsPhotoSessionKey,
  type LogisticsVaultPhoto,
} from '../../lib/logisticsPhotoVault';
import {
  clearLogisticsWizardDraft,
  loadLogisticsWizardDraft,
  saveLogisticsWizardDraft,
} from '../../lib/logisticsWizardDraftStore';
import { holdNativeAppAlive } from '../../lib/nativeAppKeepAlive';
import { bookDelhiveryShipment } from '../../lib/delhiveryB2b';
import {
  bookBlueDartShipment,
  cancelBlueDartWaybill,
  parseBlueDartAlreadyGenerated,
} from '../../lib/blueDartApi';
import { blueDartPickupPinForSite } from '../../constants/blueDartPickup';
import { pinFromText } from '../../lib/delhiveryQuote';
import { fetchAdminInvoiceDetail } from '../../lib/admin-invoices';
import { resolveInvoiceFreightBillingMode } from '../../lib/logisticsPrefill';
import {
  clubbedFreightBillingMode,
  listClubbableDelhiveryInvoices,
  mapInvoiceToClubbedRow,
  mergeClubbedBookingBoxes,
  normalizeDraftClubbedInvoices,
  type ClubbableDelhiveryInvoice,
} from '../../lib/logisticsClubInvoices';
import {
  hydrateInvoiceFieldsForDelhiveryBooking,
  positiveInvoiceTotalInr,
} from '../../lib/logisticsInvoiceValue';
import { DEFAULT_STAFF_LOGISTICS_SITE } from '../../constants/logisticsSettings';
import {
  loadLogisticsSettings,
  type LogisticsSiteContact,
} from '../../lib/logisticsSettings';
import { DelhiveryQuoteStrip } from './DelhiveryQuoteStrip';
import {
  fetchInvoiceBranchShipFrom,
  type InvoiceBranchShipFrom,
} from '../../lib/logisticsShipFrom';
import {
  buildShippingLabelViewModel,
  formatShippingBookingTime,
} from '../../lib/shippingLabel';
import {
  buildCourierSlipFromDraft,
  buildCourierSlipShareBlob,
  shareCourierSlipImage,
} from '../../lib/courierSlipImage';
import {
  printShippingLabelCanvases,
  tryPrintShippingLabelsThermal,
} from '../../lib/logisticsLabelPrint';
import { ZoomableImagePreview } from './ZoomableImagePreview';
import { ZoomablePdfPreview } from './ZoomablePdfPreview';
import { PhotoLightbox } from './PhotoLightbox';
import type { User } from '../../types';
import type { ZohoDealer } from '../../types/dealers';
import type {
  DeliveryAddressKind,
  LogisticsBooking,
  LogisticsBookingDraft,
  LogisticsDealerSnapshot,
  ShipmentBoxDraft,
  ShipmentMode,
} from '../../types/logistics-dispatch';
import type { StaffLogisticsSite } from '../../types/staff-logistics';
import {
  spareBoxDefinitionMatchesDraftDims,
  spareBoxDefinitionToDraftDims,
  type SpareBoxDefinition,
} from '../../types/spare-box-definitions';
import {
  STAFF_LOGISTICS_SITES,
  STAFF_LOGISTICS_SITE_LABELS,
  isStaffLogisticsSite,
} from '../../types/staff-logistics';
import { deliveryPartnerTabForLogisticsPartner } from '../../constants/deliveryPartnerTabs';
import { fetchCatalog, formatCurrency } from '../../lib/catalog';
import { bookingNeedsEwayBill, clubbedEwayBillRequiredLabel, clubbedInvoiceTotalInr, clubbedNeedsEwayBill } from '../../constants/ewayBill';
import { ensureInvoiceEwayBill } from '../../lib/invoiceEwayBill';
import { isInternalOpsUser } from '../../lib/staffAccess';
import { base64ToUint8Array } from '../../lib/pdfViewer';
import {
  EwayBillGeneratePreviewBody,
  ewayBillDocumentDateLabel,
  isEwayTransporterMissing,
} from './EwayBillGeneratePreview';
import { BarcodeScanner } from './BarcodeScanner';
import { ShippingLabelBitmapPreview } from './ShippingLabelBitmapPreview';

type BoxNumberField = 'lengthCm' | 'widthCm' | 'heightCm' | 'weightKg';

function newPhotoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `photo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function mergeVaultPhotosIntoDraft(
  prev: LogisticsBookingDraft,
  vaultPhotos: LogisticsVaultPhoto[],
): LogisticsBookingDraft {
  if (!vaultPhotos.length) return prev;
  let changed = false;
  const boxes = [...prev.boxes];
  const vaultBoxIds = [...new Set(
    vaultPhotos
      .filter(photo => photo.kind === 'box' && photo.boxId)
      .map(photo => String(photo.boxId)),
  )];
  for (const boxId of vaultBoxIds) {
    if (!boxes.some(box => box.id === boxId)) {
      boxes.push({ ...emptyShipmentBoxDraft(), id: boxId });
      changed = true;
    }
  }

  const nextBoxes = boxes.map(box => {
    const vaultForBox = vaultPhotos.filter(
      photo => photo.kind === 'box' && photo.boxId === box.id,
    );
    if (!vaultForBox.length) return box;
    const photos = [...box.photos];
    for (const vault of vaultForBox) {
      const idx = photos.findIndex(photo => photo.id === vault.photoId);
      if (idx >= 0) {
        const current = photos[idx];
        const nextUrl = current.url?.startsWith('data:')
          ? current.url
          : (vault.dataUrl || current.url);
        const nextPath = current.storagePath || vault.storagePath || null;
        if (nextUrl !== current.url || nextPath !== current.storagePath) {
          photos[idx] = { ...current, url: nextUrl, storagePath: nextPath };
          changed = true;
        }
      } else if (vault.dataUrl || vault.storagePath) {
        photos.push({
          id: vault.photoId,
          url: vault.dataUrl || '',
          storagePath: vault.storagePath,
        });
        changed = true;
      }
    }
    return photos === box.photos ? box : { ...box, photos };
  });

  const vaultFinal = vaultPhotos.find(photo => photo.kind === 'final');
  let finalPackagePhoto = prev.finalPackagePhoto;
  let finalPackagePhotoStoragePath = prev.finalPackagePhotoStoragePath;
  if (vaultFinal) {
    if (!finalPackagePhoto?.trim() && vaultFinal.dataUrl) {
      finalPackagePhoto = vaultFinal.dataUrl;
      changed = true;
    }
    if (!finalPackagePhotoStoragePath?.trim() && vaultFinal.storagePath) {
      finalPackagePhotoStoragePath = vaultFinal.storagePath;
      changed = true;
    }
  }

  if (!changed) return prev;
  return { ...prev, boxes: nextBoxes, finalPackagePhoto, finalPackagePhotoStoragePath };
}

function draftHasCapturedPhotos(draft: LogisticsBookingDraft): boolean {
  if (draft.finalPackagePhoto?.trim() || draft.finalPackagePhotoStoragePath?.trim()) return true;
  return draft.boxes.some(box => box.photos.some(photo =>
    Boolean(photo.url?.trim() || photo.storagePath?.trim()),
  ));
}

/** Drop the blank starter box after orphan vault photos rebuild the real boxes. */
function dropEmptyPlaceholderBoxes(draft: LogisticsBookingDraft): LogisticsBookingDraft {
  const kept = draft.boxes.filter(box => (
    box.photos.length > 0
    || Boolean(box.lengthCm.trim() || box.widthCm.trim() || box.heightCm.trim())
    || (Number.parseFloat(box.weightKg) || 0) > 0
  ));
  if (!kept.length || kept.length === draft.boxes.length) return draft;
  return { ...draft, boxes: kept };
}

function sessionKeyForWizard(partnerId: LogisticsPartnerId): string {
  const stored = loadLogisticsWizardDraft();
  if (stored?.partnerId === partnerId && stored.sessionKey.trim()) {
    rememberLogisticsPhotoSessionKey(partnerId, stored.sessionKey);
    return stored.sessionKey;
  }
  return logisticsPhotoSessionKey(null, partnerId);
}

function boxVolumetric(
  box: ShipmentBoxDraft,
  partnerId?: LogisticsPartnerId,
): number {
  return computeVolumetricWeight(
    box.lengthCm ? Number.parseFloat(box.lengthCm) : null,
    box.widthCm ? Number.parseFloat(box.widthCm) : null,
    box.heightCm ? Number.parseFloat(box.heightCm) : null,
    partnerId,
  );
}

function positiveCm(value: string | undefined): number | null {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Delhivery LTL needs real L×B×H — no silent 30 cm defaults. */
function boxHasRequiredLbh(box: ShipmentBoxDraft): boolean {
  return Boolean(positiveCm(box.lengthCm) && positiveCm(box.widthCm) && positiveCm(box.heightCm));
}

type DeliveryTileKind = DeliveryAddressKind | 'selected';

function applyDealerDeliveryToDraft(
  prev: LogisticsBookingDraft,
  snapshot: LogisticsDealerSnapshot,
  gstin?: string | null,
): LogisticsBookingDraft {
  const reconciled = reconcileDocumentDeliveryAddress(
    snapshot,
    prev.deliveryAddress,
    prev.deliveryAddressKind,
  );
  return {
    ...prev,
    deliveryAddressKind: reconciled.deliveryAddressKind,
    deliveryAddress: reconciled.deliveryAddress,
    customerPhone: prev.customerPhone?.trim()
      || phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(snapshot))
      || phoneDigitsForCourier(snapshot.mobile)
      || prev.customerPhone
      || null,
    customerGstin: normalizeGstinForCourier(prev.customerGstin)
      || normalizeGstinForCourier(gstin)
      || prev.customerGstin
      || null,
  };
}

interface BookCourierFlowProps {
  partnerId: LogisticsPartnerId;
  user: User;
  initialDraft?: Partial<LogisticsBookingDraft>;
  initialDealerQuery?: string;
  initialStep?: BookCourierStep;
  onClose: () => void;
  onComplete: (booking: LogisticsBooking) => void;
  /** Called when a saved booking is updated after final submit (e.g. late outer photo). */
  onBookingUpdated?: (booking: LogisticsBooking) => void;
}

function StepProgress({
  step,
  partnerId,
  includeEwayBill,
  includeClubInvoices,
}: {
  step: BookCourierStep;
  partnerId: LogisticsPartnerId;
  includeEwayBill: boolean;
  includeClubInvoices: boolean;
}) {
  const progressOptions = { includeEwayBill, includeClubInvoices };
  const steps = bookCourierStepsForBooking(partnerId, progressOptions);

  return (
    <ol className="book-courier__progress" aria-label="Booking progress">
      {steps.map((item, index) => {
        const visual = bookStepProgressVisualState(
          item.id,
          step,
          partnerId,
          progressOptions,
        );
        const done = visual === 'done';
        const current = visual === 'current';
        return (
          <li
            key={item.id}
            className={[
              'book-courier__progress-item',
              done ? 'is-done' : '',
              current ? 'is-current' : '',
            ].filter(Boolean).join(' ')}
            aria-current={current ? 'step' : undefined}
          >
            <span className="book-courier__progress-dot" aria-hidden>
              {done ? <Check size={15} strokeWidth={3} /> : index + 1}
            </span>
            <span className="book-courier__progress-label">{item.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function pincodeFromAddress(address: string): string {
  const match = /\b(\d{6})\b/.exec(String(address ?? ''));
  return match?.[1] ?? '';
}

function cityStateFromAddress(address: string): { city?: string; state?: string } {
  const pair = extractCityState(address);
  if (pair) {
    const [city, state] = pair.split(',').map(part => part.trim());
    if (city && state) return { city, state };
    if (city) return { city };
  }
  const city = extractDestinationCity(address);
  return city && city !== '—' ? { city } : {};
}

function normalizeGstinForCourier(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[0-9A-Z]{15}$/.test(text) ? text : null;
}

/** Delhivery Shipper Copy ignores labeled phone/GSTIN fields; embed for print. */
function addressWithPrintContacts(
  address: string,
  phone: string | null | undefined,
  gstin: string | null | undefined,
): string {
  let text = address.replace(/\s+/g, ' ').trim();
  if (!text) return text;
  const phoneValue = phoneDigitsForCourier(phone);
  if (phoneValue && !text.replace(/\D/g, '').includes(phoneValue)) {
    text = `${text}, Ph: ${phoneValue}`;
  }
  const gst = normalizeGstinForCourier(gstin);
  if (gst && !text.toUpperCase().includes(gst)) {
    text = `${text}, GSTIN: ${gst}`;
  }
  return text;
}

export const BookCourierFlow: React.FC<BookCourierFlowProps> = ({
  partnerId,
  user,
  initialDraft,
  initialDealerQuery,
  initialStep: initialStepProp,
  onClose,
  onComplete,
  onBookingUpdated,
}) => {
  const isDelhivery = partnerId === 'delhivery';
  const isBlueDart = isBlueDartLogisticsPartnerId(partnerId);
  const isApiCourier = isApiBookedLogisticsPartner(partnerId);
  const isOps = isInternalOpsUser(user);
  const initialStep = initialStepProp
    ?? (isApiCourier ? 'address' : 'scan');
  const [step, setStep] = useState<BookCourierStep>(() => {
    const boxes = initialDraft?.boxes?.length
      ? initialDraft.boxes
      : emptyBookingDraft(partnerId).boxes;
    const photosReady = draftBoxesHaveRequiredPhotos(boxes)
      || (boxes.length > 0 && boxes.every(box => box.photos.length > 0));
    if (photosReady) return initialStep;
    if (initialStep === 'review' || initialStep === 'label' || initialStep === 'final_photo') {
      return 'box';
    }
    return initialStep;
  });
  const [bookingDelhivery, setBookingDelhivery] = useState(false);
  const [delhiveryBookError, setDelhiveryBookError] = useState('');
  const [bookingBlueDart, setBookingBlueDart] = useState(false);
  const [blueDartBookError, setBlueDartBookError] = useState('');
  const [cancellingBlueDart, setCancellingBlueDart] = useState(false);
  const blueDartCreditRefNonceRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<LogisticsBookingDraft>(() => ({
    ...emptyBookingDraft(partnerId),
    ...initialDraft,
    partnerId,
    boxes: initialDraft?.boxes?.length ? initialDraft.boxes : emptyBookingDraft(partnerId).boxes,
  }));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const includeClubInvoices = isDelhivery && draft.source === 'invoice' && Boolean(draft.invoiceId?.trim());
  const showEwayWizardStep = useMemo(
    () => isOps && bookingNeedsEwayBill({
      invoiceId: draft.invoiceId,
      invoiceIds: normalizeDraftClubbedInvoices(draft).map(row => row.invoiceId),
      invoices: normalizeDraftClubbedInvoices(draft),
      invoiceValueInr: draft.invoiceValueInr,
    }),
    [draft, isOps],
  );
  const progressOptions = useMemo(
    () => ({ includeEwayBill: showEwayWizardStep, includeClubInvoices }),
    [includeClubInvoices, showEwayWizardStep],
  );
  const photoSessionKeyRef = useRef(sessionKeyForWizard(partnerId));
  const persistEnabledRef = useRef(true);
  const [booking, setBooking] = useState<LogisticsBooking | null>(null);
  const [ewayBillStatus, setEwayBillStatus] = useState<string | null>(null);
  const [ewayBillNumber, setEwayBillNumber] = useState<string | null>(null);
  const [ewayEnsuring, setEwayEnsuring] = useState(false);
  const [ewayGenerateError, setEwayGenerateError] = useState('');
  const [ewayTransporterName, setEwayTransporterName] = useState<string | null>(null);
  const [clubCandidates, setClubCandidates] = useState<ClubbableDelhiveryInvoice[]>([]);
  const [clubLoading, setClubLoading] = useState(false);
  const [clubError, setClubError] = useState('');
  const [clubSelectedIds, setClubSelectedIds] = useState<string[]>([]);
  const [clubPrimary, setClubPrimary] = useState<ClubbableDelhiveryInvoice | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dealerQuery, setDealerQuery] = useState(initialDealerQuery ?? '');
  const [dealers, setDealers] = useState<ZohoDealer[]>([]);
  const [dealersLoading, setDealersLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingCourier, setEditingCourier] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [restoredVaultNote, setRestoredVaultNote] = useState('');
  const [shipFromOpen, setShipFromOpen] = useState(false);
  const [fromAddresses, setFromAddresses] = useState<Record<StaffLogisticsSite, string>>({
    cochin: '',
    head_office: '',
  });
  const [fromSiteContacts, setFromSiteContacts] = useState<Record<StaffLogisticsSite, LogisticsSiteContact>>({
    cochin: { phone: '', gstin: '' },
    head_office: { phone: '', gstin: '' },
  });
  const [spareBoxDefinitions, setSpareBoxDefinitions] = useState<SpareBoxDefinition[]>([]);
  const [invoiceBranchShipFrom, setInvoiceBranchShipFrom] = useState<InvoiceBranchShipFrom | null>(null);
  const [freightBillingModeLocked, setFreightBillingModeLocked] = useState(false);
  const shipFromLockedByInvoice = Boolean(invoiceBranchShipFrom);
  const shipFromRef = useRef<HTMLDivElement>(null);
  const shippingLabelCanvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const finalPhotoCaptureInputRef = useRef<HTMLInputElement>(null);
  const [courierSlipPdfBytes, setCourierSlipPdfBytes] = useState<Uint8Array | null>(null);
  const [courierSlipPreviewUrl, setCourierSlipPreviewUrl] = useState<string | null>(null);
  const [sharingCourierSlip, setSharingCourierSlip] = useState(false);
  const [courierSlipError, setCourierSlipError] = useState('');
  const [combineSelectMode, setCombineSelectMode] = useState(false);
  const [combineSelectedIds, setCombineSelectedIds] = useState<string[]>([]);
  const [combineFormOpen, setCombineFormOpen] = useState(false);
  const [combineDims, setCombineDims] = useState({
    lengthCm: '',
    widthCm: '',
    heightCm: '',
    weightKg: '',
  });

  const selectedDealer = useMemo<LogisticsDealerSnapshot | null>(() => {
    const dealer = dealers.find(item => item.id === draft.zohoCustomerId);
    return dealer ? zohoDealerToSnapshot(dealer) : null;
  }, [dealers, draft.zohoCustomerId]);

  const ewayLrNumber = (booking?.consignmentNo || draft.consignmentNo || '').trim();
  const ewayGeneratePreview = useMemo(() => ({
    invoiceNumber: draft.invoiceNumber?.trim() || draft.invoiceId?.trim() || '—',
    invoiceTotalInr: Number(booking?.invoiceValueInr ?? draft.invoiceValueInr ?? 0),
    consigneeName: selectedDealer?.name?.trim() || booking?.dealer.name?.trim() || '—',
    partnerLabel: logisticsPartnerLabel(partnerId),
    transporterName: ewayTransporterName,
    lrNumber: ewayLrNumber || null,
    transportMode: 'Road',
    supplyType: 'Supply',
    transactionType: 'Regular',
    documentDate: ewayBillDocumentDateLabel(),
  }), [
    booking?.dealer.name,
    booking?.invoiceValueInr,
    draft.consignmentNo,
    draft.invoiceId,
    draft.invoiceNumber,
    draft.invoiceValueInr,
    ewayLrNumber,
    ewayTransporterName,
    partnerId,
    selectedDealer?.name,
  ]);

  useEffect(() => {
    if (step !== 'eway_bill' || !booking) return;
    let cancelled = false;
    void loadLogisticsSettings()
      .then(settings => {
        if (cancelled) return;
        const tab = deliveryPartnerTabForLogisticsPartner(partnerId);
        setEwayTransporterName(settings.partnerTransporters[tab]?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setEwayTransporterName(null);
      });

    const customerId = booking.dealer.zohoCustomerId?.trim() || draft.zohoCustomerId.trim();
    const invoiceId = booking.invoiceId?.trim() || draft.invoiceId?.trim();
    if (!customerId || !invoiceId) {
      return () => { cancelled = true; };
    }

    void ensureInvoiceEwayBill({
      customerId,
      invoiceId,
      partnerId: booking.partnerId,
      lrNumber: ewayLrNumber || null,
      bookingId: booking.id,
      invoiceTotalInr: booking.invoiceValueInr ?? draft.invoiceValueInr ?? null,
      autoGenerate: false,
      forceRequired: clubbedNeedsEwayBill(
        booking.invoices?.length ? booking.invoices : normalizeDraftClubbedInvoices(draft),
      ),
    })
      .then(result => {
        if (cancelled) return;
        setEwayBillStatus(result.status ?? null);
        setEwayBillNumber(result.ewaybillNumber ?? null);
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [
    booking,
    draft.invoiceId,
    draft.invoiceValueInr,
    draft.zohoCustomerId,
    ewayLrNumber,
    partnerId,
    step,
  ]);

  const filteredDealers = useMemo(() => {
    const q = dealerQuery.trim();
    if (!q) return [];
    return dealers
      .filter(dealer => dealerMatchesLogisticsQuery(dealer, q))
      .slice(0, 30);
  }, [dealers, dealerQuery]);

  const addressTiles = useMemo(() => {
    if (!selectedDealer) return [] as Array<{ kind: DeliveryTileKind; address: string }>;
    const selectedDoc = draft.deliveryAddress?.trim() ?? '';
    const shipping = selectedDealer.shippingAddress?.trim() ?? '';
    const billing = selectedDealer.billingAddress?.trim() ?? '';
    const tiles: Array<{ kind: DeliveryTileKind; address: string }> = [];
    const selectedIsDistinct = hasExplicitDraftDeliveryAddress(selectedDoc)
      && !logisticsAddressesMatch(selectedDoc, shipping)
      && !logisticsAddressesMatch(selectedDoc, billing);
    if (selectedIsDistinct) {
      tiles.push({ kind: 'selected', address: selectedDoc });
    }
    if (shipping && !isPlaceholderLogisticsAddress(shipping)) {
      tiles.push({ kind: 'shipping', address: shipping });
    }
    if (billing && !isPlaceholderLogisticsAddress(billing) && !logisticsAddressesMatch(billing, shipping)) {
      tiles.push({ kind: 'billing', address: billing });
    }
    return tiles;
  }, [draft.deliveryAddress, selectedDealer]);

  const galleryUrls = useMemo(() => {
    const urls = draft.boxes.flatMap(box =>
      box.photos
        .map(photo => photo.url?.trim())
        .filter((url): url is string => Boolean(url)),
    );
    const finalUrl = draft.finalPackagePhoto?.trim();
    if (finalUrl) urls.push(finalUrl);
    return urls;
  }, [draft.boxes, draft.finalPackagePhoto]);

  const openPreview = useCallback((url: string) => {
    const index = galleryUrls.indexOf(url);
    if (index >= 0) setPreviewIndex(index);
  }, [galleryUrls]);

  useEffect(() => {
    const zohoId = (initialDraft?.zohoCustomerId || draft.zohoCustomerId)?.trim();
    if (!zohoId) return;
    let cancelled = false;
    void fetchDealerById(zohoId)
      .then(dealer => {
        if (cancelled) return;
        setDealers(prev => {
          const idx = prev.findIndex(item => item.id === dealer.id);
          if (idx < 0) return [dealer, ...prev];
          const next = [...prev];
          next[idx] = preferRicherZohoDealer(prev[idx], dealer);
          return next;
        });
        const snapshot = zohoDealerToSnapshot(dealer);
        setDraft(prev => {
          if (prev.zohoCustomerId !== dealer.id) return prev;
          const next = applyDealerDeliveryToDraft(prev, snapshot, dealer.zohoGstNo);
          if (
            next.deliveryAddressKind === prev.deliveryAddressKind
            && (next.deliveryAddress ?? null) === (prev.deliveryAddress ?? null)
            && next.customerPhone === (prev.customerPhone ?? null)
            && next.customerGstin === (prev.customerGstin ?? null)
          ) {
            return prev;
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per selected Zoho id
  }, [initialDraft?.zohoCustomerId, draft.zohoCustomerId]);

  // Keep the APK from reloading while this wizard is open (screen-off / sticker / camera).
  useEffect(() => holdNativeAppAlive('book-courier'), []);

  // Resume opens with storage paths only — resolve display URLs + restore local vault captures.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      let vaultPhotos = await listLogisticsVaultPhotos({
        sessionKey: photoSessionKeyRef.current,
      });
      let recoveredOrphans = false;
      if (!vaultPhotos.length && !draftHasCapturedPhotos(draftRef.current)) {
        const orphans = await listLatestUnuploadedVaultSession();
        if (!cancelled && orphans.length) {
          const sessionKey = photoSessionKeyRef.current;
          await Promise.all(orphans.map(row => patchLogisticsVaultPhoto(row.photoId, {
            sessionKey,
            bookingId: null,
          })));
          if (cancelled) return;
          vaultPhotos = orphans.map(row => ({ ...row, sessionKey, bookingId: null }));
          recoveredOrphans = true;
        }
      }

      if (!cancelled && vaultPhotos.length) {
        setDraft(prev => {
          let next = mergeVaultPhotosIntoDraft(prev, vaultPhotos);
          if (recoveredOrphans) next = dropEmptyPlaceholderBoxes(next);
          if (next === prev) return prev;
          draftRef.current = next;
          return next;
        });
        if (recoveredOrphans) {
          const count = vaultPhotos.filter(photo => photo.kind === 'box').length;
          setRestoredVaultNote(
            count > 0
              ? `Restored ${count} package photo${count === 1 ? '' : 's'} saved on this phone. Fill L × B × H and weight if those fields are empty, then confirm.`
              : 'Restored package photos saved on this phone. Fill L × B × H and weight if those fields are empty, then confirm.',
          );
          setStep('box');
        }
      }

      const paths: string[] = [];
      for (const box of draftRef.current.boxes) {
        for (const photo of box.photos) {
          if (photo.storagePath?.trim() && !photo.url?.trim()) {
            paths.push(photo.storagePath);
          }
        }
      }
      const finalPath = draftRef.current.finalPackagePhotoStoragePath?.trim();
      if (finalPath && !draftRef.current.finalPackagePhoto?.trim()) {
        paths.push(finalPath);
      }
      if (!paths.length) return;

      const urls = await resolveLogisticsPhotoUrls(paths);
      if (cancelled) return;
      setDraft(prev => {
        let changed = false;
        const boxes = prev.boxes.map(box => ({
          ...box,
          photos: box.photos.map(photo => {
            const path = photo.storagePath?.trim();
            if (!path || photo.url?.trim()) return photo;
            const url = urls.get(path);
            if (!url) return photo;
            changed = true;
            return { ...photo, url };
          }),
        }));
        let finalPackagePhoto = prev.finalPackagePhoto;
        const storedFinal = prev.finalPackagePhotoStoragePath?.trim();
        if (storedFinal && !finalPackagePhoto?.trim()) {
          const url = urls.get(storedFinal);
          if (url) {
            finalPackagePhoto = url;
            changed = true;
          }
        }
        if (!changed) return prev;
        const next = { ...prev, boxes, finalPackagePhoto };
        draftRef.current = next;
        return next;
      });
    };

    void restore().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const persist = () => {
      if (!persistEnabledRef.current) return;
      saveLogisticsWizardDraft({
        partnerId,
        step,
        dealerQuery,
        sessionKey: photoSessionKeyRef.current,
        draft: draftRef.current,
      });
    };
    persist();
    const timer = window.setTimeout(persist, 250);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    const onPageHide = () => persist();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      persist();
    };
  }, [dealerQuery, partnerId, step, draft]);

  useEffect(() => {
    if (step !== 'address') return;
    let cancelled = false;
    const cached = peekCachedDealers();
    if (cached?.length) {
      setDealers(prev => mergeZohoDealerLists(prev, cached));
      setDealersLoading(false);
    } else {
      setDealersLoading(true);
    }

    const unsubscribe = subscribeDealerCache((list, complete) => {
      if (cancelled) return;
      setDealers(prev => mergeZohoDealerLists(prev, list));
      if (complete || list.length > 0) setDealersLoading(false);
    });

    void ensureDealersCached()
      .then(list => {
        if (!cancelled) {
          setDealers(prev => mergeZohoDealerLists(prev, list));
          setDealersLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled && !peekCachedDealers()?.length) {
          setDealers([]);
          setDealersLoading(false);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [step]);

  useEffect(() => {
    void loadLogisticsSettings().then(settings => {
      setFromAddresses(settings.fromAddresses);
      setFromSiteContacts(settings.fromSiteContacts);
      setSpareBoxDefinitions(settings.spareBoxDefinitions);
      setDraft(prev => {
        // Invoice-linked: keep SO/invoice branch prefill.
        if (prev.source === 'invoice') {
          if (isStaffLogisticsSite(prev.shipFromSite)) return prev;
          return { ...prev, shipFromSite: DEFAULT_STAFF_LOGISTICS_SITE };
        }
        // Keep draft choice; otherwise app default (Cochin).
        if (isStaffLogisticsSite(prev.shipFromSite)) return prev;
        return { ...prev, shipFromSite: DEFAULT_STAFF_LOGISTICS_SITE };
      });
    });
  }, []);

  // Lock ship-from to the invoice’s sales-order branch when booking from an invoice.
  useEffect(() => {
    if (draft.source !== 'invoice') {
      setInvoiceBranchShipFrom(null);
      return;
    }
    const invoiceId = draft.invoiceId?.trim() || '';
    const customerId = draft.zohoCustomerId?.trim() || '';
    if (!invoiceId || !customerId) {
      setInvoiceBranchShipFrom(null);
      return;
    }
    let cancelled = false;
    void fetchInvoiceBranchShipFrom({ invoiceId, customerId, isOps: true })
      .then(branch => {
        if (cancelled) return;
        setInvoiceBranchShipFrom(branch);
        if (!branch) return;
        setDraft(prev => (
          prev.shipFromSite === branch.site
            ? prev
            : { ...prev, shipFromSite: branch.site }
        ));
      })
      .catch(() => {
        if (!cancelled) setInvoiceBranchShipFrom(null);
      });
    return () => { cancelled = true; };
  }, [draft.source, draft.invoiceId, draft.zohoCustomerId]);

  // Invoice-linked Delhivery: BTC/FOD always from the invoice freight line (read-only).
  useEffect(() => {
    if (draft.source !== 'invoice' || partnerId !== 'delhivery') {
      setFreightBillingModeLocked(false);
      return;
    }
    const invoiceId = draft.invoiceId?.trim() || '';
    const customerId = draft.zohoCustomerId?.trim() || '';
    if (!invoiceId || !customerId) {
      setFreightBillingModeLocked(false);
      return;
    }
    let cancelled = false;
    void fetchAdminInvoiceDetail(customerId, invoiceId)
      .then(invoice => {
        if (cancelled) return;
        setFreightBillingModeLocked(true);
        const mode = resolveInvoiceFreightBillingMode(invoice) || 'btc';
        const invoiceTotal = Number(invoice.total);
        setDraft(prev => {
          const next = {
            ...prev,
            freightBillingMode: mode,
            ...(Number.isFinite(invoiceTotal) && invoiceTotal > 0
              ? { invoiceValueInr: invoiceTotal }
              : {}),
          };
          if (
            prev.freightBillingMode === next.freightBillingMode
            && prev.invoiceValueInr === next.invoiceValueInr
          ) {
            return prev;
          }
          draftRef.current = next;
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setFreightBillingModeLocked(false);
      });
    return () => { cancelled = true; };
  }, [draft.source, draft.invoiceId, draft.zohoCustomerId, partnerId]);

  useEffect(() => {
    if (step !== 'club_invoices' || !includeClubInvoices) return;
    const invoiceId = draft.invoiceId?.trim() || '';
    const customerId = draft.zohoCustomerId?.trim() || '';
    if (!invoiceId || !customerId) return;
    let cancelled = false;
    setClubLoading(true);
    setClubError('');
    void (async () => {
      try {
        const primaryDetail = await fetchAdminInvoiceDetail(customerId, invoiceId);
        if (cancelled) return;
        const primaryKey = {
          invoiceId,
          invoiceNumber: primaryDetail.invoiceNumber?.trim() || invoiceId,
          date: primaryDetail.date,
          valueInr: Number(primaryDetail.total) || 0,
          freightBillingMode: resolveInvoiceFreightBillingMode(primaryDetail) || 'fod',
          gstin: String(primaryDetail.customerGstin ?? ''),
          pincode: '',
          detail: primaryDetail,
        } satisfies ClubbableDelhiveryInvoice;
        setClubPrimary(primaryKey);
        setClubSelectedIds([invoiceId]);
        const listed = await listClubbableDelhiveryInvoices({
          customerId,
          primaryInvoiceId: invoiceId,
          primary: primaryDetail,
        });
        if (cancelled) return;
        const available: ClubbableDelhiveryInvoice[] = [];
        for (const row of listed) {
          const existing = await findLogisticsBookingForInvoice(row.invoiceId);
          if (existing && existing.status !== 'cancelled' && existing.status !== 'returned') continue;
          available.push(row);
        }
        if (!cancelled) setClubCandidates(available);
      } catch (err) {
        if (!cancelled) {
          setClubError(err instanceof Error ? err.message : 'Could not load invoices to club.');
        }
      } finally {
        if (!cancelled) setClubLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [draft.invoiceId, draft.zohoCustomerId, includeClubInvoices, step]);

  useEffect(() => {
    if (!shipFromOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!shipFromRef.current?.contains(event.target as Node)) {
        setShipFromOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [shipFromOpen]);

  useEffect(() => {
    if (step !== 'box') setShipFromOpen(false);
  }, [step]);

  const updateDraft = useCallback(<K extends keyof LogisticsBookingDraft>(
    key: K,
    value: LogisticsBookingDraft[K],
  ) => {
    setDraft(prev => {
      const next = { ...prev, [key]: value };
      draftRef.current = next;
      return next;
    });
  }, []);

  const applyScannedCode = useCallback((raw: string) => {
    const parsed = parseCourierBarcode(raw, partnerId);
    setDraft(prev => ({
      ...prev,
      barcodeRaw: raw,
      consignmentNo: parsed.consignmentNo ?? prev.consignmentNo,
      branch: parsed.branch ?? prev.branch,
      serviceType: parsed.serviceType ?? prev.serviceType,
      bookingDate: parsed.bookingDate ?? prev.bookingDate,
    }));
  }, [partnerId]);

  const handleCameraDetected = useCallback((raw: string) => {
    applyScannedCode(raw);
    setCameraOpen(false);
  }, [applyScannedCode]);

  const handleScanContinue = useCallback(() => {
    if (draft.barcodeRaw.trim()) {
      applyScannedCode(draft.barcodeRaw);
    }
    setStep('address');
  }, [applyScannedCode, draft.barcodeRaw]);

  const selectDealer = useCallback((dealer: ZohoDealer) => {
    const snapshot = zohoDealerToSnapshot(dealer);
    setDealers(prev => {
      const idx = prev.findIndex(item => item.id === dealer.id);
      if (idx < 0) return [dealer, ...prev];
      const next = [...prev];
      next[idx] = preferRicherZohoDealer(prev[idx], dealer);
      return next;
    });
    setDraft(prev => ({
      ...applyDealerDeliveryToDraft(prev, snapshot, dealer.zohoGstNo),
      zohoCustomerId: dealer.id,
      dealerId: dealer.portalUserId?.trim() || dealer.id,
    }));
    setDealerQuery('');
    // List-cache rows often lack Zoho street addresses — refresh detail immediately.
    if (!logisticsDealerHasDeliveryAddress(snapshot)) {
      void fetchDealerById(dealer.id)
        .then(detailed => {
          setDealers(prev => {
            const idx = prev.findIndex(item => item.id === detailed.id);
            if (idx < 0) return [detailed, ...prev];
            const next = [...prev];
            next[idx] = preferRicherZohoDealer(prev[idx], detailed);
            return next;
          });
          const detailedSnap = zohoDealerToSnapshot(detailed);
          setDraft(prev => {
            if (prev.zohoCustomerId !== detailed.id) return prev;
            return applyDealerDeliveryToDraft(prev, detailedSnap, detailed.zohoGstNo);
          });
        })
        .catch(() => undefined);
    }
  }, []);

  const clearDealer = useCallback(() => {
    setDraft(prev => ({ ...prev, zohoCustomerId: '', dealerId: '' }));
    setDealerQuery('');
  }, []);

  const setShipmentMode = useCallback((mode: ShipmentMode) => {
    setDraft(prev => ({
      ...prev,
      shipmentMode: mode,
      boxes: mode === 'envelope'
        ? prev.boxes.slice(0, 1)
        : (prev.boxes.length ? prev.boxes : [emptyShipmentBoxDraft()]),
    }));
    if (mode === 'envelope') {
      setCombineSelectMode(false);
      setCombineSelectedIds([]);
      setCombineFormOpen(false);
    }
  }, []);

  const updateBoxField = useCallback((boxId: string, key: BoxNumberField, value: string) => {
    setDraft(prev => ({
      ...prev,
      boxes: prev.boxes.map(box => (box.id === boxId ? { ...box, [key]: value } : box)),
    }));
  }, []);

  const applySpareBoxDefinition = useCallback((boxId: string, definitionId: string) => {
    if (!definitionId) return;
    const def = spareBoxDefinitions.find(row => row.id === definitionId);
    if (!def) return;
    const dims = spareBoxDefinitionToDraftDims(def);
    setDraft(prev => ({
      ...prev,
      boxes: prev.boxes.map(box => (
        box.id === boxId
          ? {
              ...box,
              lengthCm: dims.lengthCm,
              widthCm: dims.widthCm,
              heightCm: dims.heightCm,
            }
          : box
      )),
    }));
  }, [spareBoxDefinitions]);

  const addBox = useCallback(() => {
    setDraft(prev => ({ ...prev, boxes: [...prev.boxes, emptyShipmentBoxDraft()] }));
  }, []);

  const removeBox = useCallback((boxId: string) => {
    setDraft(prev => (prev.boxes.length <= 1
      ? prev
      : { ...prev, boxes: prev.boxes.filter(box => box.id !== boxId) }));
    setCombineSelectedIds(prev => prev.filter(id => id !== boxId));
  }, []);

  const exitCombineMode = useCallback(() => {
    setCombineSelectMode(false);
    setCombineSelectedIds([]);
    setCombineFormOpen(false);
    setCombineDims({ lengthCm: '', widthCm: '', heightCm: '', weightKg: '' });
  }, []);

  const toggleCombineBox = useCallback((boxId: string) => {
    setCombineSelectedIds(prev => (
      prev.includes(boxId) ? prev.filter(id => id !== boxId) : [...prev, boxId]
    ));
  }, []);

  const openCombineForm = useCallback(() => {
    const selected = draftRef.current.boxes.filter(box => combineSelectedIds.includes(box.id));
    if (selected.length < 2) return;
    const suggested = suggestCombinedBoxDims(selected);
    setCombineDims({
      lengthCm: suggested.lengthCm,
      widthCm: suggested.widthCm,
      heightCm: suggested.heightCm,
      weightKg: sumDraftBoxWeightsKg(selected),
    });
    setCombineFormOpen(true);
  }, [combineSelectedIds]);

  const applyCombineBoxes = useCallback(() => {
    if (combineSelectedIds.length < 2) return;
    const weight = Number.parseFloat(combineDims.weightKg) || 0;
    if (weight <= 0) {
      window.alert('Enter the combined box actual weight (kg).');
      return;
    }
    setDraft(prev => {
      const nextBoxes = combineShipmentBoxDrafts(prev.boxes, combineSelectedIds, combineDims);
      const next = { ...prev, boxes: nextBoxes };
      draftRef.current = next;
      return next;
    });
    exitCombineMode();
  }, [combineDims, combineSelectedIds, exitCombineMode]);

  const applyDraft = useCallback((updater: (prev: LogisticsBookingDraft) => LogisticsBookingDraft) => {
    setDraft(prev => {
      const next = updater(prev);
      draftRef.current = next;
      return next;
    });
  }, []);

  const selectDeliveryTile = useCallback((tile: { kind: DeliveryTileKind; address: string }) => {
    applyDraft(prev => {
      if (tile.kind === 'selected') {
        return { ...prev, deliveryAddress: tile.address };
      }
      return {
        ...prev,
        deliveryAddressKind: tile.kind,
        deliveryAddress: null,
      };
    });
  }, [applyDraft]);

  /** Create LR via Delhivery B2B API when no consignment is set yet. */
  const ensureDelhiveryLrn = useCallback(async (): Promise<boolean> => {
    if (!isDelhivery) return true;
    if (draftRef.current.consignmentNo.trim()) return true;
    if (!selectedDealer) {
      setDelhiveryBookError('Select a delivery address before booking Delhivery.');
      return false;
    }
    if (draftRef.current.shipmentMode !== 'envelope'
      && draftRef.current.boxes.some(box => !boxHasRequiredLbh(box))) {
      setDelhiveryBookError('Enter L × B × H (cm) for every box before creating a Delhivery LR.');
      return false;
    }
    setBookingDelhivery(true);
    setDelhiveryBookError('');
    try {
      const address = resolveDraftDeliveryAddress(selectedDealer, draftRef.current);
      const pin = pincodeFromAddress(address);
      if (!pin) {
        throw new Error('Delivery address needs a 6-digit pincode for Delhivery booking.');
      }
      const fromAddress = (fromAddresses[draftRef.current.shipFromSite] ?? '').trim();
      const siteContact = fromSiteContacts[draftRef.current.shipFromSite] ?? { phone: '', gstin: '' };
      const shipperPhone = phoneDigitsForCourier(siteContact.phone)
        || phoneDigitsForCourier(FIRM_PHONE);
      const shipperGstin = normalizeGstinForCourier(siteContact.gstin)
        || normalizeGstinForCourier(FIRM_GSTIN);
      if (!shipperPhone) {
        throw new Error('Ship-from phone is missing. Set it in Logistics Settings → Sites.');
      }
      if (!shipperGstin) {
        throw new Error('Ship-from GSTIN is missing or invalid. Set a 15-character GSTIN in Logistics Settings → Sites.');
      }

      const consigneePhone = phoneDigitsForCourier(draftRef.current.customerPhone)
        || phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(selectedDealer))
        || phoneDigitsForCourier(selectedDealer.mobile);
      if (!consigneePhone) {
        throw new Error('Consignee phone is required before creating a Delhivery LR.');
      }
      const consigneeGstin = normalizeGstinForCourier(draftRef.current.customerGstin);
      if (!consigneeGstin) {
        throw new Error('Consignee GSTIN is required before creating a Delhivery LR (15 characters).');
      }

      const deliveryPlace = cityStateFromAddress(address);
      const shipFromPlace = cityStateFromAddress(fromAddress);
      const shipFromPin = pincodeFromAddress(fromAddress) || pin;
      const invoiceId = draftRef.current.invoiceId?.trim() || '';
      const customerId = draftRef.current.zohoCustomerId?.trim() || '';
      const fromInvoice = draftRef.current.source === 'invoice' || Boolean(invoiceId);
      const clubbed = normalizeDraftClubbedInvoices(draftRef.current);
      let invoiceNumber = draftRef.current.invoiceNumber?.trim() || '';
      let invoiceValueInr = positiveInvoiceTotalInr(draftRef.current.invoiceValueInr);
      const resolvedClubbed: Array<{
        invoiceId: string;
        invoiceNumber: string;
        invoiceValueInr: number;
      }> = [];
      if (fromInvoice) {
        if (!invoiceId || !customerId) {
          throw new Error(
            'Invoice total (incl. GST) is required before booking Delhivery. Use Book Courier from the invoice.',
          );
        }
        const rows = clubbed.length ? clubbed : [{
          invoiceId,
          invoiceNumber,
          valueInr: invoiceValueInr,
        }];
        for (const row of rows) {
          const hydrated = await hydrateInvoiceFieldsForDelhiveryBooking({
            customerId,
            invoiceId: row.invoiceId,
            knownNumber: row.invoiceNumber,
            knownTotal: row.valueInr,
          });
          resolvedClubbed.push({
            invoiceId: row.invoiceId,
            invoiceNumber: hydrated.invoiceNumber?.trim() || row.invoiceNumber,
            invoiceValueInr: hydrated.invoiceValueInr,
          });
        }
        invoiceNumber = resolvedClubbed[0]?.invoiceNumber || invoiceNumber;
        invoiceValueInr = resolvedClubbed.reduce((sum, row) => sum + row.invoiceValueInr, 0);
      }
      const shipperRef = (
        draftRef.current.salesOrderNumber?.trim()
        || invoiceBranchShipFrom?.salesOrderNumber?.trim()
        || invoiceNumber
        || `YW-${Date.now()}`
      );
      const siteLabel = STAFF_LOGISTICS_SITE_LABELS[draftRef.current.shipFromSite];

      const result = await bookDelhiveryShipment({
        shipFromSite: draftRef.current.shipFromSite,
        orderId: shipperRef,
        consignee: {
          name: selectedDealer.name,
          phone: consigneePhone,
          address: addressWithPrintContacts(address, consigneePhone, consigneeGstin),
          city: selectedDealer.destinationCity?.trim() || deliveryPlace.city,
          state: deliveryPlace.state,
          pincode: pin,
          country: 'India',
          gstin: consigneeGstin,
        },
        returnAddress: fromAddress
          ? {
            name: siteLabel,
            phone: shipperPhone,
            address: addressWithPrintContacts(fromAddress, shipperPhone, shipperGstin),
            city: shipFromPlace.city,
            state: shipFromPlace.state,
            pincode: shipFromPin,
            country: 'India',
          }
          : null,
        billingAddress: fromAddress
          ? {
            name: FIRM_NAME,
            company: FIRM_NAME,
            consignor: siteLabel,
            address: addressWithPrintContacts(fromAddress, shipperPhone, shipperGstin),
            city: shipFromPlace.city || 'NA',
            state: shipFromPlace.state || 'NA',
            pin: shipFromPin,
            phone: shipperPhone,
            gst_number: shipperGstin,
          }
          : {
            name: FIRM_NAME,
            company: FIRM_NAME,
            consignor: FIRM_NAME,
            address: 'Pickup warehouse',
            city: 'NA',
            state: 'NA',
            pin,
            phone: shipperPhone,
            gst_number: shipperGstin,
          },
        boxes: draftRef.current.boxes.map(box => ({
          lengthCm: positiveCm(box.lengthCm) ?? undefined,
          widthCm: positiveCm(box.widthCm) ?? undefined,
          heightCm: positiveCm(box.heightCm) ?? undefined,
          weightKg: Number.parseFloat(box.weightKg) || undefined,
          quantity: 1,
        })),
        invoiceId: invoiceId || null,
        zohoCustomerId: customerId || null,
        invoiceNumber: invoiceNumber || draftRef.current.invoiceNumber,
        invoiceValueInr,
        ...(resolvedClubbed.length > 1 ? { invoices: resolvedClubbed } : {}),
        productsDesc: 'Weighing equipment',
        sellerGstin: shipperGstin,
        shippingMode: 'Surface',
        paymentMode: 'Prepaid',
        // Freight only: FOD / BTC — never goods CoD.
        // Note: this Delhivery client rejects FoP (BTC) on LTL /manifest; FOD works.
        freightBillingMode: draftRef.current.freightBillingMode === 'fod' ? 'fod' : 'btc',
      });
      const lrn = String(result.lrn || '').trim();
      if (!lrn) throw new Error('Delhivery did not return an LR number.');
      const masterAwb = String(result.masterAwb || '').replace(/\D/g, '').trim() || null;
      const pickupRaw = result.pickup;
      const delhiveryPickup = pickupRaw
        ? {
          ok: pickupRaw.ok === true,
          alreadyExisted: pickupRaw.alreadyExisted === true,
          pickupId: pickupRaw.pickupId?.trim() || null,
          pickupLocationName: pickupRaw.pickupLocationName ?? null,
          pickupDate: pickupRaw.pickupDate ?? null,
          pickupTime: pickupRaw.pickupTime ?? null,
          expectedPackageCount: pickupRaw.expectedPackageCount ?? null,
          message: pickupRaw.message ?? null,
          requestedAt: pickupRaw.requestedAt || new Date().toISOString(),
        }
        : null;
      applyDraft(prev => ({
        ...prev,
        ...(invoiceNumber ? { invoiceNumber } : {}),
        ...(invoiceValueInr > 0 ? { invoiceValueInr } : {}),
        ...(resolvedClubbed.length
          ? {
            clubbedInvoices: resolvedClubbed.map(row => ({
              invoiceId: row.invoiceId,
              invoiceNumber: row.invoiceNumber,
              valueInr: row.invoiceValueInr,
            })),
          }
          : {}),
        consignmentNo: lrn,
        barcodeRaw: prev.barcodeRaw || lrn,
        serviceType: 'Surface',
        branch: 'Delhivery B2B',
        ...(masterAwb ? { masterAwb } : {}),
        ...(delhiveryPickup ? { delhiveryPickup } : {}),
      }));
      return true;
    } catch (err) {
      setDelhiveryBookError(err instanceof Error ? err.message : 'Could not book Delhivery LR.');
      return false;
    } finally {
      setBookingDelhivery(false);
    }
  }, [applyDraft, fromAddresses, fromSiteContacts, invoiceBranchShipFrom, isDelhivery, selectedDealer]);

  /** Create AWB via Blue Dart GenerateWayBill when no consignment is set yet. */
  const ensureBlueDartAwb = useCallback(async (): Promise<boolean> => {
    if (!isBlueDart) return true;
    if (draftRef.current.consignmentNo.trim()) return true;
    if (!selectedDealer) {
      setBlueDartBookError('Select a delivery address before booking Blue Dart.');
      return false;
    }
    if (draftRef.current.shipmentMode !== 'envelope'
      && draftRef.current.boxes.some(box => !boxHasRequiredLbh(box))) {
      setBlueDartBookError('Enter L × B × H (cm) for every box before creating a Blue Dart AWB.');
      return false;
    }
    setBookingBlueDart(true);
    setBlueDartBookError('');
    try {
      const address = resolveDraftDeliveryAddress(selectedDealer, draftRef.current);
      const pin = pincodeFromAddress(address);
      if (!pin) {
        throw new Error('Delivery address needs a 6-digit pincode for Blue Dart booking.');
      }
      const fromAddress = (fromAddresses[draftRef.current.shipFromSite] ?? '').trim();
      const siteContact = fromSiteContacts[draftRef.current.shipFromSite] ?? { phone: '', gstin: '' };
      const shipperPhone = phoneDigitsForCourier(siteContact.phone)
        || phoneDigitsForCourier(FIRM_PHONE);
      const shipperGstin = normalizeGstinForCourier(siteContact.gstin)
        || normalizeGstinForCourier(FIRM_GSTIN);
      if (!shipperPhone) {
        throw new Error('Ship-from phone is missing. Set it in Logistics Settings → Sites.');
      }
      const consigneePhone = phoneDigitsForCourier(draftRef.current.customerPhone)
        || phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(selectedDealer))
        || phoneDigitsForCourier(selectedDealer.mobile);
      if (!consigneePhone) {
        throw new Error('Consignee phone is required before creating a Blue Dart AWB.');
      }
      const consigneeGstin = normalizeGstinForCourier(draftRef.current.customerGstin);
      const deliveryPlace = cityStateFromAddress(address);
      const shipFromPlace = cityStateFromAddress(fromAddress);
      const shipFromPin = blueDartPickupPinForSite(draftRef.current.shipFromSite)
        || pincodeFromAddress(fromAddress);
      const invoiceId = draftRef.current.invoiceId?.trim() || '';
      const customerId = draftRef.current.zohoCustomerId?.trim() || '';
      const fromInvoice = draftRef.current.source === 'invoice' || Boolean(invoiceId);
      let invoiceNumber = draftRef.current.invoiceNumber?.trim() || '';
      let invoiceValueInr = positiveInvoiceTotalInr(draftRef.current.invoiceValueInr);
      if (fromInvoice && invoiceId && customerId) {
        const hydrated = await hydrateInvoiceFieldsForDelhiveryBooking({
          customerId,
          invoiceId,
          knownNumber: invoiceNumber,
          knownTotal: invoiceValueInr,
        });
        invoiceNumber = hydrated.invoiceNumber?.trim() || invoiceNumber;
        invoiceValueInr = hydrated.invoiceValueInr || invoiceValueInr;
      }
      const shipperBase = (
        draftRef.current.salesOrderNumber?.trim()
        || invoiceBranchShipFrom?.salesOrderNumber?.trim()
        || invoiceNumber
        || `YW-${Date.now()}`
      );
      const retryNonce = blueDartCreditRefNonceRef.current;
      const shipperRef = retryNonce
        ? `${shipperBase.replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}${retryNonce}`.slice(0, 20)
        : shipperBase.slice(0, 20);
      const siteLabel = STAFF_LOGISTICS_SITE_LABELS[draftRef.current.shipFromSite];
      const result = await bookBlueDartShipment({
        partnerId,
        shipFromSite: draftRef.current.shipFromSite,
        orderId: shipperRef,
        consignee: {
          name: selectedDealer.name,
          phone: consigneePhone,
          address,
          city: selectedDealer.destinationCity?.trim() || deliveryPlace.city,
          state: deliveryPlace.state,
          pincode: pin,
          gstin: consigneeGstin || undefined,
        },
        returnAddress: fromAddress
          ? {
            name: siteLabel,
            phone: shipperPhone,
            address: fromAddress,
            city: shipFromPlace.city,
            state: shipFromPlace.state,
            pincode: shipFromPin,
          }
          : null,
        boxes: draftRef.current.boxes.map(box => ({
          lengthCm: positiveCm(box.lengthCm) ?? undefined,
          widthCm: positiveCm(box.widthCm) ?? undefined,
          heightCm: positiveCm(box.heightCm) ?? undefined,
          weightKg: Number.parseFloat(box.weightKg) || undefined,
          quantity: 1,
        })),
        shipmentMode: draftRef.current.shipmentMode === 'envelope' ? 'envelope' : 'box',
        invoiceId: invoiceId || null,
        zohoCustomerId: customerId || null,
        invoiceNumber: invoiceNumber || draftRef.current.invoiceNumber,
        invoiceValueInr,
        sellerGstin: shipperGstin || undefined,
        freightBillingMode: draftRef.current.freightBillingMode === 'fod' ? 'fod' : 'btc',
      });
      const awb = String(result.awb || '').replace(/\D/g, '').trim();
      if (!awb) throw new Error('Blue Dart did not return an AWB.');
      applyDraft(prev => ({
        ...prev,
        ...(invoiceNumber ? { invoiceNumber } : {}),
        ...(invoiceValueInr > 0 ? { invoiceValueInr } : {}),
        consignmentNo: awb,
        barcodeRaw: prev.barcodeRaw || awb,
        branch: 'Blue Dart',
        ...(result.documents ? { blueDartDocuments: result.documents } : {}),
        blueDartPickup: {
          ok: result.pickupRegistered === true,
          registered: result.pickupRegistered === true,
          pickupDate: result.pickupDate ?? null,
          pickupTime: result.pickupTime ?? null,
          pickupAddress: result.pickupAddress ?? fromAddress ?? null,
          pickupPin: result.pickupPin ?? shipFromPin ?? null,
          originArea: result.originArea ?? null,
          destinationArea: result.destinationArea ?? null,
          destinationLocation: result.destinationLocation ?? null,
          tokenNumber: result.pickupToken ?? null,
          message: result.pickupMessage
            || (result.pickupRegistered
              ? `Pickup requested at ${result.pickupPin || shipFromPin || 'site address'}`
              : 'Not registered'),
          requestedAt: new Date().toISOString(),
        },
      }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not book Blue Dart AWB.';
      setBlueDartBookError(message);
      return false;
    } finally {
      setBookingBlueDart(false);
    }
  }, [
    applyDraft,
    fromAddresses,
    fromSiteContacts,
    invoiceBranchShipFrom,
    isBlueDart,
    partnerId,
    selectedDealer,
  ]);

  const ensureDealerAddressHydrated = useCallback(async (): Promise<LogisticsDealerSnapshot | null> => {
    const zohoId = draftRef.current.zohoCustomerId?.trim();
    if (!zohoId) return selectedDealer;

    const kind = draftRef.current.deliveryAddressKind;
    const hasDocumentAddress = hasExplicitDraftDeliveryAddress(draftRef.current.deliveryAddress);
    if (
      selectedDealer
      && (hasDocumentAddress || logisticsDealerHasDeliveryAddress(selectedDealer, kind))
    ) {
      return selectedDealer;
    }

    try {
      const detailed = await fetchDealerById(zohoId);
      setDealers(prev => {
        const idx = prev.findIndex(item => item.id === detailed.id);
        if (idx < 0) return [detailed, ...prev];
        const next = [...prev];
        next[idx] = preferRicherZohoDealer(prev[idx], detailed);
        return next;
      });
      const snapshot = zohoDealerToSnapshot(detailed);
      const nextDraft = applyDealerDeliveryToDraft(draftRef.current, snapshot, detailed.zohoGstNo);
      if (
        nextDraft.deliveryAddressKind !== draftRef.current.deliveryAddressKind
        || (nextDraft.deliveryAddress ?? null) !== (draftRef.current.deliveryAddress ?? null)
        || nextDraft.customerPhone !== draftRef.current.customerPhone
        || nextDraft.customerGstin !== draftRef.current.customerGstin
      ) {
        setDraft(prev => (
          prev.zohoCustomerId === detailed.id
            ? applyDealerDeliveryToDraft(prev, snapshot, detailed.zohoGstNo)
            : prev
        ));
        draftRef.current = nextDraft;
      }
      return snapshot;
    } catch {
      return selectedDealer;
    }
  }, [selectedDealer]);

  const discardWizardSnapshot = useCallback(() => {
    persistEnabledRef.current = false;
    clearLogisticsWizardDraft();
    forgetLogisticsPhotoSessionKey(partnerId);
  }, [partnerId]);

  const finishWizardAfterBooking = useCallback((created: LogisticsBooking) => {
    setBooking(created);
    if (showEwayWizardStep && created.ewayBillStatus !== 'generated') {
      setEwayBillStatus(created.ewayBillStatus ?? null);
      setEwayBillNumber(created.ewayBillNumber ?? null);
      setEwayGenerateError('');
      setStep('eway_bill');
      return;
    }
    discardWizardSnapshot();
    if (isApiCourier) {
      onComplete(created);
      return;
    }
    setStep('complete');
  }, [discardWizardSnapshot, isApiCourier, onComplete, showEwayWizardStep]);

  const finishWizardFromEwayStep = useCallback(() => {
    if (!booking) return;
    discardWizardSnapshot();
    if (isApiCourier) {
      onComplete(booking);
      return;
    }
    setStep('complete');
  }, [booking, discardWizardSnapshot, isApiCourier, onComplete]);

  const openEwayPdfFromResult = useCallback((contentBase64: string, mimeType: string) => {
    const bytes = base64ToUint8Array(contentBase64);
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType || 'application/pdf' });
    if ((mimeType || '').includes('html')) {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  const handleWizardGenerateEway = useCallback(async () => {
    if (!booking) return;
    const customerId = booking.dealer.zohoCustomerId?.trim() || draft.zohoCustomerId.trim();
    const rows = (booking.invoices?.length
      ? booking.invoices
      : normalizeDraftClubbedInvoices(draft)
    ).filter(row => row.invoiceId);
    const forceRequired = clubbedNeedsEwayBill(rows);
    const targets = forceRequired
      ? rows
      : rows.filter(row => clubbedNeedsEwayBill([row]));
    if (!customerId || !targets.length) return;
    setEwayEnsuring(true);
    setEwayGenerateError('');
    try {
      let lastNumber: string | null = null;
      let lastStatus: string | null = null;
      let lastPdf: { contentBase64: string; mimeType: string } | null = null;
      const failures: string[] = [];
      for (const row of targets) {
        try {
          const result = await ensureInvoiceEwayBill({
            customerId,
            invoiceId: row.invoiceId,
            partnerId: booking.partnerId,
            lrNumber: ewayLrNumber || null,
            bookingId: booking.id,
            invoiceTotalInr: row.valueInr || booking.invoiceValueInr || null,
            autoGenerate: true,
            forceRequired,
          });
          lastStatus = result.status ?? lastStatus;
          if (result.ewaybillNumber) lastNumber = result.ewaybillNumber;
          if (result.contentBase64) {
            lastPdf = {
              contentBase64: result.contentBase64,
              mimeType: result.mimeType || 'application/pdf',
            };
          }
          if (result.status !== 'generated' && result.required !== false) {
            failures.push(`${row.invoiceNumber}: ${result.message || result.status || 'not generated'}`);
          }
        } catch (err) {
          failures.push(`${row.invoiceNumber}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }
      setEwayBillStatus(failures.length ? 'missing' : (lastStatus ?? null));
      setEwayBillNumber(lastNumber);
      if (lastPdf) {
        openEwayPdfFromResult(lastPdf.contentBase64, lastPdf.mimeType);
      }
      if (failures.length) {
        setEwayGenerateError(failures.join(' '));
      }
    } catch (err) {
      setEwayGenerateError(
        err instanceof Error ? err.message : 'Could not generate e-way bill.',
      );
    } finally {
      setEwayEnsuring(false);
    }
  }, [
    booking,
    draft,
    ewayLrNumber,
    openEwayPdfFromResult,
  ]);

  const handleConfirmShipment = useCallback(async () => {
    const dealer = await ensureDealerAddressHydrated();
    if (!dealer) return;
    setSaving(true);
    try {
      const created = await persistLogisticsBooking({
        draft: draftRef.current,
        dealer,
        createdBy: user,
      });
      const previousSession = photoSessionKeyRef.current;
      photoSessionKeyRef.current = created.id;
      void bindLogisticsVaultSessionToBooking(previousSession, created.id);
      void clearUploadedLogisticsVaultPhotos({
        bookingId: created.id,
        sessionKey: created.id,
      });
      finishWizardAfterBooking(created);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not save shipment.');
    } finally {
      setSaving(false);
    }
  }, [ensureDealerAddressHydrated, finishWizardAfterBooking, user]);

  const wizardHasProgress = useCallback((): boolean => {
    const current = draftRef.current;
    if (current.zohoCustomerId.trim()) return true;
    if (current.consignmentNo.trim() || current.barcodeRaw.trim()) return true;
    if (current.boxes.some(box => box.photos.length > 0)) return true;
    if (current.finalPackagePhoto?.trim()) return true;
    return step !== 'scan' && step !== 'address' && step !== 'complete' && step !== 'eway_bill';
  }, [step]);

  const addBoxPhoto = useCallback(async (boxId: string, file: File | undefined) => {
    if (!file) return;
    const photoId = newPhotoId();
    const dataUrl = await logisticsCaptureToDataUrl(file);
    const sessionKey = photoSessionKeyRef.current;

    await putLogisticsVaultPhoto({
      photoId,
      sessionKey,
      bookingId: null,
      boxId,
      kind: 'box',
      dataUrl,
      storagePath: null,
      consignmentNo: draftRef.current.consignmentNo.trim(),
      createdAt: Date.now(),
    });

    applyDraft(prev => ({
      ...prev,
      boxes: prev.boxes.map(box => (box.id === boxId
        ? { ...box, photos: [...box.photos, { id: photoId, url: dataUrl }] }
        : box)),
    }));
  }, [applyDraft]);

  const removeBoxPhoto = useCallback((boxId: string, photoId: string) => {
    void deleteLogisticsVaultPhoto(photoId);
    applyDraft(prev => ({
      ...prev,
      boxes: prev.boxes.map(box => (box.id === boxId
        ? { ...box, photos: box.photos.filter(photo => photo.id !== photoId) }
        : box)),
    }));
  }, [applyDraft]);

  const handleFinalPhotoChange = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const dataUrl = await logisticsCaptureToDataUrl(file);
    const photoId = `final-${photoSessionKeyRef.current}`;
    await putLogisticsVaultPhoto({
      photoId,
      sessionKey: photoSessionKeyRef.current,
      bookingId: null,
      boxId: null,
      kind: 'final',
      dataUrl,
      storagePath: null,
      consignmentNo: draftRef.current.consignmentNo.trim(),
      createdAt: Date.now(),
    });
    applyDraft(prev => ({
      ...prev,
      finalPackagePhoto: dataUrl,
      finalPackagePhotoStoragePath: null,
    }));
  }, [applyDraft]);

  const requestClose = useCallback(() => {
    if (step === 'eway_bill') {
      finishWizardFromEwayStep();
      return;
    }
    if (step === 'complete' || saving || ewayEnsuring) {
      if (step === 'complete') onClose();
      return;
    }
    if (wizardHasProgress()) {
      const leave = window.confirm(
        'Leave without submitting this shipment? Captured photos and this booking will be discarded.',
      );
      if (!leave) return;
    }
    discardWizardSnapshot();
    onClose();
  }, [discardWizardSnapshot, ewayEnsuring, finishWizardFromEwayStep, step, saving, wizardHasProgress, onClose]);

  const handleFinish = useCallback(() => {
    discardWizardSnapshot();
    if (booking) onComplete(booking);
  }, [booking, discardWizardSnapshot, onComplete]);

  const isEnvelope = draft.shipmentMode === 'envelope';
  const isBlueDartAir = partnerId === 'bluedart_air';
  const isBlueDartDomestic = partnerId === 'bluedart_domestic';
  const recoveredBlueDartAwb = isBlueDart
    ? (parseBlueDartAlreadyGenerated(blueDartBookError)?.awb ?? null)
    : null;
  const isStCourier = partnerId === 'st_courier';
  const canProceedScan = Boolean(draft.barcodeRaw.trim() || draft.consignmentNo.trim());
  const boxesValid = draftBoxesHaveRequiredPhotos(draft.boxes)
    && draft.boxes.every(box => {
      if (isEnvelope) return true;
      if ((Number.parseFloat(box.weightKg) || 0) <= 0) return false;
      if ((isDelhivery || isBlueDart) && !boxHasRequiredLbh(box)) return false;
      return true;
    });
  const delhiveryNeedsLbh = (isDelhivery || isBlueDart)
    && !isEnvelope
    && draft.boxes.some(box => !boxHasRequiredLbh(box));
  const totalActualWeight = draft.boxes.reduce(
    (total, box) => total + (Number.parseFloat(box.weightKg) || 0),
    0,
  );
  const totalVolumetricWeight = draft.boxes.reduce(
    (sum, box) => sum + boxVolumetric(box, partnerId),
    0,
  );
  /** BDDP: consignment steps every 0.5 kg. Other partners: sum of per-box max(act, vol). */
  const totalChargeableWeight = partnerId === 'bluedart_domestic'
    ? ceilChargeableWeightKg(
      Math.max(totalActualWeight, totalVolumetricWeight),
      partnerId,
    )
    : draft.boxes.reduce((sum, box) => {
      const actual = Number.parseFloat(box.weightKg) || 0;
      return sum + Math.max(actual, boxVolumetric(box, partnerId));
    }, 0);
  const deliveryAddressText = selectedDealer
    ? resolveDraftDeliveryAddress(selectedDealer, draft)
    : (draft.deliveryAddress?.trim() || '');
  const stCourierTamilNaduOverMax = isStCourier
    && isTamilNaduDestination(deliveryAddressText)
    && stCourierTamilNaduMaxChargeableExceeded(totalChargeableWeight);
  const blueDartAirOverMax = isBlueDartAir
    && blueDartAirMaxChargeableExceeded(totalChargeableWeight);
  const blueDartDpOverMax = isBlueDartDomestic
    && blueDartDpMaxChargeableExceeded(totalChargeableWeight);
  const canProceedBox = boxesValid
    && !blueDartAirOverMax
    && !blueDartDpOverMax
    && !stCourierTamilNaduOverMax;
  const delhiveryDestPin = deliveryAddressText
    ? pinFromText(deliveryAddressText)
    : '';
  const delhiveryOriginPin = pinFromText(fromAddresses[draft.shipFromSite] ?? '');
  const delhiveryQuoteDimensions = draft.boxes.map(box => ({
    length_cm: Math.max(1, Math.round(Number.parseFloat(box.lengthCm) || 30)),
    width_cm: Math.max(1, Math.round(Number.parseFloat(box.widthCm) || 30)),
    height_cm: Math.max(1, Math.round(Number.parseFloat(box.heightCm) || 30)),
    box_count: 1,
  }));
  const delhiveryResolvedContacts = useMemo(() => {
    const siteContact = fromSiteContacts[draft.shipFromSite] ?? { phone: '', gstin: '' };
    const shipperPhone = phoneDigitsForCourier(siteContact.phone)
      || phoneDigitsForCourier(FIRM_PHONE);
    const shipperGstin = normalizeGstinForCourier(siteContact.gstin)
      || normalizeGstinForCourier(FIRM_GSTIN);
    const consigneePhone = phoneDigitsForCourier(draft.customerPhone)
      || (
        selectedDealer
          ? (
            phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(selectedDealer))
            || phoneDigitsForCourier(selectedDealer.mobile)
          )
          : null
      );
    const consigneeGstin = normalizeGstinForCourier(draft.customerGstin);
    return { shipperPhone, shipperGstin, consigneePhone, consigneeGstin };
  }, [
    draft.customerGstin,
    draft.customerPhone,
    draft.shipFromSite,
    fromSiteContacts,
    selectedDealer,
  ]);
  const delhiveryContactIssues = useMemo(() => {
    if (!isDelhivery) return [] as string[];
    const issues: string[] = [];
    if (!delhiveryResolvedContacts.shipperPhone) {
      issues.push('Ship-from phone is missing — set it under Logistics → Sites.');
    }
    if (!delhiveryResolvedContacts.shipperGstin) {
      issues.push('Ship-from GSTIN is missing or invalid — set a 15-character GSTIN under Logistics → Sites.');
    }
    if (!selectedDealer) {
      issues.push('Select a delivery address.');
    } else if (!delhiveryResolvedContacts.consigneePhone) {
      issues.push('Consignee phone is missing — enter it below or add it on the dealer / invoice.');
    }
    if (!delhiveryResolvedContacts.consigneeGstin) {
      issues.push('Consignee GSTIN is missing or invalid — enter a 15-character GSTIN below.');
    }
    return issues;
  }, [delhiveryResolvedContacts, isDelhivery, selectedDealer]);
  const canCreateDelhiveryLrn = !isDelhivery
    || Boolean(draft.consignmentNo.trim())
    || delhiveryContactIssues.length === 0;

  const blueDartContactIssues = useMemo(() => {
    if (!isBlueDart) return [] as string[];
    const issues: string[] = [];
    if (!delhiveryResolvedContacts.shipperPhone) {
      issues.push('Ship-from phone is missing — set it under Logistics → Sites.');
    }
    if (!selectedDealer) {
      issues.push('Select a delivery address.');
    } else if (!delhiveryResolvedContacts.consigneePhone) {
      issues.push('Consignee phone is missing — enter it below or add it on the dealer / invoice.');
    }
    return issues;
  }, [delhiveryResolvedContacts, isBlueDart, selectedDealer]);
  const canCreateBlueDartAwb = !isBlueDart
    || Boolean(draft.consignmentNo.trim())
    || blueDartContactIssues.length === 0;

  const confirmDelhiveryFromReview = useCallback(async () => {
    if (!canCreateDelhiveryLrn) {
      setDelhiveryBookError(
        delhiveryContactIssues[0] || 'Phone and GSTIN are required before booking.',
      );
      return;
    }
    const ok = await ensureDelhiveryLrn();
    if (!ok) return;
    await handleConfirmShipment();
  }, [
    canCreateDelhiveryLrn,
    delhiveryContactIssues,
    ensureDelhiveryLrn,
    handleConfirmShipment,
  ]);

  const confirmBlueDartFromReview = useCallback(async () => {
    if (!canCreateBlueDartAwb) {
      setBlueDartBookError(
        blueDartContactIssues[0] || 'Consignee phone is required before booking.',
      );
      return;
    }
    const ok = await ensureBlueDartAwb();
    if (!ok) return;
    await handleConfirmShipment();
  }, [
    blueDartContactIssues,
    canCreateBlueDartAwb,
    ensureBlueDartAwb,
    handleConfirmShipment,
  ]);

  const cancelRecoveredBlueDartAwb = useCallback(async () => {
    const existing = parseBlueDartAlreadyGenerated(blueDartBookError);
    if (!existing) return;
    const leave = window.confirm(
      `Cancel Blue Dart AWB ${existing.awb}? After it is cancelled you can Generate AWB again from this screen.`,
    );
    if (!leave) return;
    setCancellingBlueDart(true);
    setBlueDartBookError('');
    try {
      await cancelBlueDartWaybill(existing.awb);
      blueDartCreditRefNonceRef.current = Date.now().toString(36).slice(-6);
      applyDraft(prev => ({
        ...prev,
        consignmentNo: '',
        barcodeRaw: prev.barcodeRaw === existing.awb ? '' : prev.barcodeRaw,
      }));
    } catch (err) {
      setBlueDartBookError(
        err instanceof Error ? err.message : 'Could not cancel Blue Dart AWB.',
      );
    } finally {
      setCancellingBlueDart(false);
    }
  }, [applyDraft, blueDartBookError]);

  const shippingLabelCount = isEnvelope ? 1 : Math.max(1, draft.boxes.length);
  const buildShippingLabelsForDealer = useCallback((
    dealer: LogisticsDealerSnapshot,
    addressKind: DeliveryAddressKind = draft.deliveryAddressKind,
  ) => {
    const deliveryAddress = resolveDraftDeliveryAddress(dealer, {
      deliveryAddressKind: addressKind,
      deliveryAddress: draft.deliveryAddress,
    });
    const fromName = STAFF_LOGISTICS_SITE_LABELS[draft.shipFromSite];
    const fromAddress = (fromAddresses[draft.shipFromSite] ?? '').trim();
    const bookingTime = formatShippingBookingTime();
    return Array.from({ length: shippingLabelCount }, (_, index) => {
      const box = draft.boxes[index];
      const boxActual = box ? (Number.parseFloat(box.weightKg) || 0) : totalActualWeight;
      const boxChargeable = box
        ? ceilChargeableWeightKg(
          Math.max(boxActual, boxVolumetric(box, partnerId)),
          partnerId,
        )
        : totalChargeableWeight;
      const inside = box?.photos?.[0];
      return buildShippingLabelViewModel({
        fromName,
        fromAddress: fromAddress || '—',
        dealer,
        deliveryAddress,
        numberOfBoxes: shippingLabelCount,
        boxIndex: index + 1,
        lengthCm: box?.lengthCm,
        widthCm: box?.widthCm,
        heightCm: box?.heightCm,
        serviceType: draft.serviceType,
        grossWeightKg: isEnvelope ? totalActualWeight : boxActual,
        chargeableWeightKg: isEnvelope ? totalChargeableWeight : boxChargeable,
        partnerId,
        consignmentNo: draft.consignmentNo,
        bookingBranch: draft.branch,
        bookingDate: draft.bookingDate,
        bookingTime,
        bookedBy: user.displayName?.trim() || user.loginId?.trim() || 'YESWEIGH',
        shipmentMode: draft.shipmentMode,
        insidePhotoUrl: inside?.url,
        insidePhotoStoragePath: inside?.storagePath,
      });
    });
  }, [
    draft.deliveryAddressKind,
    draft.deliveryAddress,
    draft.shipFromSite,
    draft.consignmentNo,
    draft.branch,
    draft.bookingDate,
    draft.serviceType,
    draft.shipmentMode,
    draft.boxes,
    fromAddresses,
    shippingLabelCount,
    totalActualWeight,
    totalChargeableWeight,
    partnerId,
    isEnvelope,
    user.displayName,
    user.loginId,
  ]);

  const shippingLabels = useMemo(
    () => (selectedDealer ? buildShippingLabelsForDealer(selectedDealer) : []),
    [selectedDealer, buildShippingLabelsForDealer],
  );

  const handlePrintShippingLabels = useCallback(async () => {
    try {
      const dealer = await ensureDealerAddressHydrated();
      if (!dealer) {
        window.alert('Select a dealer before printing the shipping label.');
        return;
      }
      const site = draftRef.current.shipFromSite;
      const fromAddress = (fromAddresses[site] ?? '').trim();
      if (isPlaceholderLogisticsAddress(fromAddress)) {
        window.alert(
          'Ship-from (FROM) address is missing. Set it under Admin → Logistics → Sites for this location, then print again.',
        );
        return;
      }
      const deliveryAddress = resolveDraftDeliveryAddress(dealer, draftRef.current);
      if (isPlaceholderLogisticsAddress(deliveryAddress)) {
        window.alert(
          'Delivery (TO) address is missing. Use the invoice Ship To or refresh the dealer from Zoho, then print again.',
        );
        return;
      }

      const labels = buildShippingLabelsForDealer(dealer, draftRef.current.deliveryAddressKind);
      // Drop stale canvas slots if box count shrank since last render.
      shippingLabelCanvasRefs.current.length = labels.length;
      try {
        const thermal = await tryPrintShippingLabelsThermal(labels);
        if (thermal.usedThermal) {
          updateDraft('labelGenerated', true);
          return;
        }
      } catch (err) {
        const fallback = window.confirm(
          `${err instanceof Error ? err.message : 'Thermal print failed.'}\n\nPrint with the system dialog instead?`,
        );
        if (!fallback) return;
      }
      printShippingLabelCanvases(
        shippingLabelCanvasRefs.current.slice(0, labels.length),
        labels.length > 1
          ? `Shipping labels (${labels.length} × 100×150 mm)`
          : 'Shipping label',
      );
      updateDraft('labelGenerated', true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Print failed.');
    }
  }, [buildShippingLabelsForDealer, ensureDealerAddressHydrated, fromAddresses, updateDraft]);

  useEffect(() => {
    if (step !== 'label') return;
    void ensureDealerAddressHydrated();
  }, [step, ensureDealerAddressHydrated]);

  const courierSlip = useMemo(() => {
    if (!selectedDealer) return null;
    const fromName = STAFF_LOGISTICS_SITE_LABELS[draft.shipFromSite];
    const fromAddress = (fromAddresses[draft.shipFromSite] || FIRM_NAME).trim();
    return buildCourierSlipFromDraft({
      partnerId,
      draft,
      dealer: selectedDealer,
      deliveryAddress: resolveDraftDeliveryAddress(selectedDealer, draft),
      piecesLabel: isEnvelope ? '1 envelope' : `${draft.boxes.length} box(es)`,
      weightKg: totalChargeableWeight || totalActualWeight,
      fromName,
      fromAddress,
      generatedBy: user.displayName?.trim() || user.loginId?.trim() || 'YESWEIGH',
    });
  }, [
    selectedDealer,
    partnerId,
    draft,
    isEnvelope,
    totalChargeableWeight,
    totalActualWeight,
    fromAddresses,
    user.displayName,
    user.loginId,
  ]);

  useEffect(() => {
    if (!courierSlip || step !== 'label') {
      setCourierSlipPdfBytes(null);
      setCourierSlipPreviewUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setCourierSlipError('');
    setCourierSlipPdfBytes(null);
    setCourierSlipPreviewUrl(null);
    void buildCourierSlipShareBlob(courierSlip)
      .then(async ({ blob, mimeType }) => {
        if (!active) return;
        if (mimeType === 'application/pdf') {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!active) return;
          setCourierSlipPdfBytes(bytes);
        } else {
          objectUrl = URL.createObjectURL(blob);
          setCourierSlipPreviewUrl(objectUrl);
        }
      })
      .catch(err => {
        if (active) {
          setCourierSlipError(err instanceof Error ? err.message : 'Could not build courier slip.');
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [courierSlip, step]);

  const handleShareCourierSlip = useCallback(async () => {
    if (!courierSlip) return;
    setSharingCourierSlip(true);
    setCourierSlipError('');
    try {
      await shareCourierSlipImage(courierSlip);
      updateDraft('labelGenerated', true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setCourierSlipError(err instanceof Error ? err.message : 'Share failed.');
    } finally {
      setSharingCourierSlip(false);
    }
  }, [courierSlip, updateDraft]);

  const goBack = () => {
    switch (step) {
      case 'scan': onClose(); break;
      case 'address':
        if (isApiCourier && !draft.consignmentNo.trim() && !draft.barcodeRaw.trim()) {
          onClose();
        } else {
          setStep('scan');
        }
        break;
      case 'club_invoices': setStep('address'); break;
      case 'box': setStep(includeClubInvoices ? 'club_invoices' : 'address'); break;
      case 'review': setStep('box'); break;
      case 'label': setStep('review'); break;
      case 'final_photo':
        setStep(isApiCourier ? 'review' : 'label');
        break;
      case 'eway_bill':
      case 'complete':
        break;
      default: onClose();
    }
  };

  const stepNumberLabel = (() => {
    if (step === 'complete') return 'Completed';
    const steps = bookCourierStepsForBooking(partnerId, progressOptions);
    const idx = bookStepFlowIndex(step, partnerId, progressOptions);
    const flowLabels: Record<string, string> = {
      scan: 'Scan',
      address: 'Address',
      club_invoices: 'Invoices',
      box: 'Box',
      review: 'Review',
      label: 'Label',
      final_photo: 'Photo',
      eway_bill: 'E-way bill',
    };
    const stage = flowLabels[step] ?? steps.find(item => item.id === step)?.label ?? 'Step';
    return `${stage} · Step ${idx + 1} of ${steps.length}`;
  })();

  return createPortal(
    <div className="delivery-method-backdrop" role="presentation" onClick={() => void requestClose()}>
      <div
        className="delivery-method-dialog delivery-method-dialog--form book-courier"
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-courier-title"
        onClick={event => event.stopPropagation()}
      >
        <span className="delivery-method-dialog__glow delivery-method-dialog__glow--tl" aria-hidden />
        <span className="delivery-method-dialog__glow delivery-method-dialog__glow--br" aria-hidden />

        <header className="delivery-method-dialog__header">
          {step !== 'complete' && step !== 'eway_bill' ? (
            <button type="button" className="delivery-method-dialog__back" onClick={goBack} aria-label="Go back">
              <ChevronLeft size={22} aria-hidden />
            </button>
          ) : (
            <span className="delivery-method-dialog__header-spacer" aria-hidden />
          )}
          <div className="delivery-method-dialog__hero">
            <h2 id="book-courier-title" className="delivery-method-dialog__title">
              <span>BOOK</span>
              <span className="delivery-method-dialog__title-accent">COURIER</span>
            </h2>
            <p className="delivery-method-dialog__subtitle">
              {logisticsPartnerLabel(partnerId)} · {stepNumberLabel}
            </p>
          </div>
          {step !== 'complete' ? (
            <button
              type="button"
              className="delivery-method-dialog__close"
              onClick={() => void requestClose()}
              aria-label="Close and return to list"
              disabled={saving}
            >
              <X size={20} aria-hidden />
            </button>
          ) : (
            <span className="delivery-method-dialog__header-spacer" aria-hidden />
          )}
        </header>

        <StepProgress
          step={step}
          partnerId={partnerId}
          includeEwayBill={showEwayWizardStep}
          includeClubInvoices={includeClubInvoices}
        />

        <div className="book-courier__body">
          {/* SCREEN 1 — SCAN */}
          {step === 'scan' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                <ScanLine size={18} aria-hidden />
                {isDelhivery ? (
                  <>Enter <span className="accent">LR</span> (optional)</>
                ) : (
                  <>Scan <span className="accent">Courier</span> Barcode</>
                )}
              </h3>
              <p className="book-courier__hint text-muted text-sm">
                {isDelhivery
                  ? 'Enter an existing Delhivery LR, or skip — an LR will be created via API after review.'
                  : 'Scan the barcode on the courier slip or enter the code manually.'}
              </p>

              {cameraOpen ? (
                <BarcodeScanner onDetected={handleCameraDetected} onClose={() => setCameraOpen(false)} />
              ) : (
                <button
                  type="button"
                  className="book-courier__scan-visual book-courier__scan-visual--button"
                  onClick={() => setCameraOpen(true)}
                >
                  <Barcode size={44} strokeWidth={1.25} aria-hidden />
                  <span>Tap to scan barcode</span>
                </button>
              )}

              <div className="book-courier__actions">
                {!cameraOpen && (
                  <button type="button" className="btn btn-primary" onClick={() => setCameraOpen(true)}>
                    <Camera size={16} aria-hidden />
                    Scan with Camera
                  </button>
                )}
              </div>

              <div className="book-courier__manual">
                <span className="book-courier__manual-label">
                  <Keyboard size={14} aria-hidden />
                  Or enter manually
                </span>
                <label className="courier-dialog__field">
                  <span>Consignment / barcode number</span>
                  <input
                    type="text"
                    value={draft.barcodeRaw}
                    onChange={event => updateDraft('barcodeRaw', event.target.value)}
                    placeholder="Enter consignment / barcode"
                    autoComplete="off"
                    inputMode="text"
                  />
                </label>
              </div>

              <button
                type="button"
                className="btn btn-primary book-courier__next"
                disabled={!isDelhivery && !canProceedScan}
                onClick={handleScanContinue}
              >
                {isDelhivery && !canProceedScan ? 'Skip & Next' : 'Confirm & Next'}
              </button>
            </section>
          )}

          {/* SCREEN 2 — ADDRESS */}
          {step === 'address' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                <MapPin size={18} aria-hidden />
                Select <span className="accent">Delivery</span> Address
              </h3>
              {!selectedDealer ? (
                <div className="book-courier__autosuggest">
                  <label className="book-courier__search">
                    <Search size={16} aria-hidden />
                    <input
                      type="text"
                      value={dealerQuery}
                      onChange={event => setDealerQuery(event.target.value)}
                      placeholder="Search dealer by name, code or mobile"
                      autoComplete="off"
                    />
                  </label>
                  {dealerQuery.trim() && (
                    <div className="book-courier__suggest" role="listbox" aria-label="Dealer suggestions">
                      {dealersLoading && dealers.length === 0 && (
                        <p className="book-courier__suggest-empty text-muted text-sm">Loading dealers…</p>
                      )}
                      {filteredDealers.map(dealer => {
                        const snapshot = zohoDealerToSnapshot(dealer);
                        const addressRaw = (snapshot.shippingAddress?.trim()
                          || snapshot.billingAddress?.trim()
                          || '');
                        const address = addressRaw && addressRaw !== '—' ? addressRaw : '';
                        return (
                          <button
                            key={dealer.id}
                            type="button"
                            role="option"
                            aria-selected={false}
                            className="book-courier__suggest-item"
                            onClick={() => selectDealer(dealer)}
                          >
                            <strong>{snapshot.name}</strong>
                            <span className="book-courier__dealer-code">{snapshot.code}</span>
                            <span className="text-muted">{snapshot.contactPerson} · {snapshot.mobile}</span>
                            {address ? (
                              <span className="book-courier__suggest-address">{address}</span>
                            ) : (
                              <span className="book-courier__suggest-address book-courier__suggest-address--empty">
                                No address on file
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {!dealersLoading && filteredDealers.length === 0 && (
                        <p className="book-courier__suggest-empty text-muted text-sm">
                          No dealers match “{dealerQuery}”.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="book-courier__selected-dealer">
                  <div className="book-courier__selected-head">
                    <span className="book-courier__selected-copy">
                      <strong>{selectedDealer.name}</strong>
                      <span className="book-courier__dealer-code">{selectedDealer.code}</span>
                      <span className="text-muted">
                        {selectedDealer.contactPerson} · {selectedDealer.mobile}
                      </span>
                    </span>
                    <button type="button" className="book-courier__change" onClick={clearDealer}>
                      <Pencil size={13} aria-hidden /> Change
                    </button>
                  </div>

                  <p className="book-courier__address-heading">Deliver to</p>
                  <div className="book-courier__address-tiles">
                    {addressTiles.map(tile => {
                      const hasOverride = hasExplicitDraftDeliveryAddress(draft.deliveryAddress);
                      const selected = tile.kind === 'selected'
                        ? hasOverride
                        : (!hasOverride && draft.deliveryAddressKind === tile.kind);
                      const tileLabel = tile.kind === 'selected'
                        ? (draft.source === 'invoice' ? 'Invoice Ship To' : 'Selected address')
                        : tile.kind === 'shipping' ? 'Shipping address' : 'Billing address';
                      return (
                        <div
                          key={tile.kind}
                          className={`book-courier__address-tile${selected ? ' is-selected' : ''}`}
                        >
                          <button
                            type="button"
                            className="book-courier__address-tile-main"
                            onClick={() => selectDeliveryTile(tile)}
                          >
                            <span className="book-courier__address-tile-head">
                              <span className="book-courier__address-tile-label">
                                {tileLabel}
                              </span>
                              {selected && <Check size={15} strokeWidth={3} aria-hidden />}
                            </span>
                            <span className="book-courier__address-tile-body">{tile.address}</span>
                          </button>
                          {selected && (
                            <button
                              type="button"
                              className="btn btn-primary book-courier__address-next"
                              onClick={() => setStep(includeClubInvoices ? 'club_invoices' : 'box')}
                            >
                              Next
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {addressTiles.length === 0 && (
                      <p className="text-muted text-sm">No delivery address on file for this dealer.</p>
                    )}
                  </div>
                  {isDelhivery && delhiveryDestPin ? (
                    <DelhiveryQuoteStrip
                      originPin={delhiveryOriginPin || null}
                      destinationPin={delhiveryDestPin}
                      weightKg={totalChargeableWeight || totalActualWeight || 5}
                      freightBillingMode={draft.freightBillingMode === 'fod' ? 'fod' : 'btc'}
                      includeEstimate={Boolean(delhiveryOriginPin)}
                      dimensions={delhiveryQuoteDimensions}
                    />
                  ) : null}
                </div>
              )}
            </section>
          )}

          {step === 'club_invoices' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                <Combine size={18} aria-hidden />
                Club <span className="accent">invoices</span>
              </h3>
              <p className="book-courier__hint text-muted text-sm">
                Same dealer and ship-to can share one Delhivery LR. Put charged freight on one
                invoice only (or FOD ₹0 on all). If the clubbed total exceeds ₹50,000, each
                invoice gets its own e-way bill.
              </p>
              {clubError ? (
                <p className="book-courier__hint text-sm" role="alert">{clubError}</p>
              ) : null}
              {clubLoading && !clubPrimary ? (
                <p className="text-muted text-sm">Loading invoices…</p>
              ) : (
                <div className="book-courier__club-list">
                  {clubPrimary ? (
                    <label className="book-courier__club-row is-primary">
                      <input type="checkbox" checked disabled />
                      <span>
                        <strong>{clubPrimary.invoiceNumber}</strong>
                        <span className="text-muted"> Primary · {clubPrimary.freightBillingMode.toUpperCase()}</span>
                      </span>
                      <span>{formatCurrency(clubPrimary.valueInr)}</span>
                    </label>
                  ) : null}
                  {clubCandidates.map(row => {
                    const checked = clubSelectedIds.includes(row.invoiceId);
                    return (
                      <label key={row.invoiceId} className="book-courier__club-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setClubSelectedIds(prev => (
                              checked
                                ? prev.filter(id => id !== row.invoiceId)
                                : [...prev, row.invoiceId]
                            ));
                          }}
                        />
                        <span>
                          <strong>{row.invoiceNumber}</strong>
                          <span className="text-muted"> {row.freightBillingMode.toUpperCase()}</span>
                        </span>
                        <span>{formatCurrency(row.valueInr)}</span>
                      </label>
                    );
                  })}
                  {!clubLoading && clubCandidates.length === 0 ? (
                    <p className="text-muted text-sm">No other unbooked Delhivery invoices for this ship-to.</p>
                  ) : null}
                </div>
              )}
              {(() => {
                const selected = [
                  clubPrimary,
                  ...clubCandidates.filter(row => clubSelectedIds.includes(row.invoiceId)),
                ].filter((row): row is ClubbableDelhiveryInvoice => Boolean(row));
                const sum = selected.reduce((total, row) => total + row.valueInr, 0);
                return (
                  <p className="book-courier__hint text-sm">
                    {selected.length} invoice{selected.length === 1 ? '' : 's'} · {formatCurrency(sum)}.
                    {' '}
                    {clubbedEwayBillRequiredLabel({ invoiceCount: selected.length, clubbedTotalInr: sum })}
                  </p>
                );
              })()}
              <button
                type="button"
                className="btn btn-primary book-courier__next"
                disabled={clubLoading || !clubPrimary}
                onClick={() => {
                  void (async () => {
                    if (!clubPrimary) return;
                    setClubLoading(true);
                    setClubError('');
                    try {
                      const selected = [
                        clubPrimary,
                        ...clubCandidates.filter(row => clubSelectedIds.includes(row.invoiceId)),
                      ];
                      const catalog = await fetchCatalog();
                      const productsById = new Map(catalog.items.map(item => [item.id, item]));
                      const details = selected.map(row => row.detail);
                      const boxes = mergeClubbedBookingBoxes(details, productsById);
                      const invoices = selected.map(row => mapInvoiceToClubbedRow(row.detail));
                      applyDraft(prev => ({
                        ...prev,
                        clubbedInvoices: invoices,
                        invoiceValueInr: clubbedInvoiceTotalInr(invoices),
                        freightBillingMode: clubbedFreightBillingMode(details),
                        boxes: boxes.length ? boxes : prev.boxes,
                      }));
                      setStep('box');
                    } catch (err) {
                      setClubError(err instanceof Error ? err.message : 'Could not club invoices.');
                    } finally {
                      setClubLoading(false);
                    }
                  })();
                }}
              >
                {clubLoading ? 'Loading…' : 'Next'}
              </button>
            </section>
          )}

          {/* SCREEN 3 — BOX DETAILS */}
          {step === 'box' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                <Package size={18} aria-hidden />
                {isEnvelope ? 'Envelope' : 'Package'} <span className="accent">Details</span>
              </h3>

              <div className="book-courier__mode" role="radiogroup" aria-label="Shipment type">
                {SHIPMENT_MODES.map(mode => (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.shipmentMode === mode.id}
                    className={`book-courier__mode-btn${draft.shipmentMode === mode.id ? ' is-selected' : ''}`}
                    onClick={() => setShipmentMode(mode.id)}
                  >
                    {mode.id === 'envelope' ? <Mail size={18} aria-hidden /> : <Package size={18} aria-hidden />}
                    <span>{mode.label}</span>
                  </button>
                ))}
              </div>

              <div className="book-courier__field" ref={shipFromRef}>
                <span id="book-courier-ship-from-label">Ship from site</span>
                <button
                  type="button"
                  className={`book-courier__site-trigger${shipFromOpen ? ' is-open' : ''}${
                    shipFromLockedByInvoice ? ' is-locked' : ''
                  }`}
                  aria-haspopup="listbox"
                  aria-expanded={shipFromOpen}
                  aria-labelledby="book-courier-ship-from-label"
                  disabled={shipFromLockedByInvoice}
                  onClick={() => {
                    if (shipFromLockedByInvoice) return;
                    setShipFromOpen(open => !open);
                  }}
                >
                  <span className="book-courier__site-trigger-copy">
                    <strong>{STAFF_LOGISTICS_SITE_LABELS[draft.shipFromSite]}</strong>
                    {isBlueDart && blueDartPickupPinForSite(draft.shipFromSite) ? (
                      <span className="book-courier__site-trigger-address">
                        Blue Dart pickup {blueDartPickupPinForSite(draft.shipFromSite)}
                      </span>
                    ) : null}
                    {(fromAddresses[draft.shipFromSite] ?? '').trim() ? (
                      <span className="book-courier__site-trigger-address">
                        {fromAddresses[draft.shipFromSite].trim()}
                      </span>
                    ) : null}
                  </span>
                  {!shipFromLockedByInvoice ? (
                    <ChevronDown size={16} strokeWidth={2.25} aria-hidden />
                  ) : null}
                </button>
                {shipFromLockedByInvoice && invoiceBranchShipFrom ? (
                  <p className="book-courier__ship-from-lock text-muted text-sm">
                    Locked to invoice branch ({invoiceBranchShipFrom.branchLabel}
                    {invoiceBranchShipFrom.salesOrderNumber
                      ? ` · SO ${invoiceBranchShipFrom.salesOrderNumber}`
                      : ''}
                    ).
                  </p>
                ) : null}
                {shipFromOpen && !shipFromLockedByInvoice && (
                  <div
                    className="book-courier__site-menu"
                    role="listbox"
                    aria-label="Ship from site"
                  >
                    {STAFF_LOGISTICS_SITES.map(site => {
                      const selected = draft.shipFromSite === site;
                      const address = (fromAddresses[site] ?? '').trim();
                      return (
                        <button
                          key={site}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`book-courier__site-option${selected ? ' is-selected' : ''}`}
                          onClick={() => {
                            updateDraft('shipFromSite', site);
                            setShipFromOpen(false);
                          }}
                        >
                          <span className="book-courier__site-option-head">
                            <strong>{STAFF_LOGISTICS_SITE_LABELS[site]}</strong>
                            {selected ? <Check size={14} strokeWidth={2.5} aria-hidden /> : null}
                          </span>
                          {isBlueDart && blueDartPickupPinForSite(site) ? (
                            <span className="book-courier__site-option-address">
                              Blue Dart pickup {blueDartPickupPinForSite(site)}
                            </span>
                          ) : null}
                          {address ? (
                            <span className="book-courier__site-option-address">{address}</span>
                          ) : (
                            <span className="book-courier__site-option-address book-courier__site-option-address--empty">
                              No from-address configured
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {!isEnvelope && (
                <p className="book-courier__box-count-hint text-muted text-sm">
                  {draft.boxes.length} box{draft.boxes.length === 1 ? '' : 'es'}
                  {' · '}
                  {shippingLabelCount} shipping label{shippingLabelCount === 1 ? '' : 's'}
                </p>
              )}
              {restoredVaultNote ? (
                <p className="book-courier__hint text-sm" role="status">{restoredVaultNote}</p>
              ) : null}

              <div className="book-courier__boxes">
                {draft.boxes.map((box, index) => (
                  <BoxCard
                    key={box.id}
                    box={box}
                    index={index}
                    partnerId={partnerId}
                    isEnvelope={isEnvelope}
                    dimsRequired={isDelhivery || isBlueDart}
                    spareBoxDefinitions={spareBoxDefinitions}
                    canRemove={!isEnvelope && draft.boxes.length > 1 && !combineSelectMode}
                    selectMode={combineSelectMode}
                    selected={combineSelectedIds.includes(box.id)}
                    onToggleSelect={() => toggleCombineBox(box.id)}
                    onField={(key, value) => updateBoxField(box.id, key, value)}
                    onApplySpareBoxDefinition={definitionId => applySpareBoxDefinition(box.id, definitionId)}
                    onAddPhoto={file => void addBoxPhoto(box.id, file)}
                    onRemovePhoto={photoId => removeBoxPhoto(box.id, photoId)}
                    onPreview={openPreview}
                    onRemoveBox={() => removeBox(box.id)}
                  />
                ))}
              </div>

              {!isEnvelope && (
                <div className="book-courier__box-actions">
                  <button type="button" className="book-courier__add-box" onClick={addBox}>
                    <Plus size={16} aria-hidden /> Add another box
                  </button>
                  {draft.boxes.length >= 2 && !combineSelectMode && (
                    <button
                      type="button"
                      className="book-courier__combine-toggle"
                      onClick={() => {
                        setCombineSelectMode(true);
                        setCombineSelectedIds([]);
                        setCombineFormOpen(false);
                      }}
                    >
                      <Combine size={16} aria-hidden /> Combine boxes
                    </button>
                  )}
                  {combineSelectMode && (
                    <div className="book-courier__combine-bar">
                      <p className="book-courier__combine-bar-copy">
                        Select 2 or more boxes to pack into one with new L × B × H.
                        {combineSelectedIds.length > 0 && (
                          <>
                            {' '}
                            <strong>{combineSelectedIds.length} selected</strong>
                            {combineSelectedIds.length >= 2 && (
                              <>
                                {' → '}
                                {draft.boxes.length - combineSelectedIds.length + 1}
                                {' '}
                                box
                                {draft.boxes.length - combineSelectedIds.length + 1 === 1 ? '' : 'es'}
                                {' / '}
                                {draft.boxes.length - combineSelectedIds.length + 1}
                                {' '}
                                label
                                {draft.boxes.length - combineSelectedIds.length + 1 === 1 ? '' : 's'}
                              </>
                            )}
                          </>
                        )}
                      </p>
                      <div className="book-courier__combine-bar-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={exitCombineMode}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={combineSelectedIds.length < 2}
                          onClick={openCombineForm}
                        >
                          <Combine size={14} aria-hidden />
                          Enter new LBH
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {combineFormOpen && combineSelectedIds.length >= 2 && (
                <div className="book-courier__combine-form">
                  <h4 className="book-courier__combine-form-title">
                    Combined box · new dimensions
                  </h4>
                  <p className="book-courier__hint text-muted text-sm">
                    Replaces {combineSelectedIds.length} boxes with 1.
                    LBH is suggested as max L × max B × stacked H (editable).
                    Photos are kept; box and label counts update to match.
                  </p>
                  <p className="book-courier__box-label">
                    Dimensions (cm)
                    <span className="book-courier__box-opt"> · auto · editable</span>
                  </p>
                  <div className="book-courier__dim-cards">
                    {([
                      ['Length (L)', 'lengthCm'],
                      ['Breadth (W)', 'widthCm'],
                      ['Height (H)', 'heightCm'],
                    ] as Array<[string, 'lengthCm' | 'widthCm' | 'heightCm']>).map(([label, key]) => (
                      <label className="book-courier__dim-card" key={key}>
                        <span className="book-courier__dim-card-title">{label}</span>
                        <span className="book-courier__dim-card-value">
                          <DecimalTextInput
                            value={combineDims[key]}
                            onChange={next => setCombineDims(prev => ({ ...prev, [key]: next }))}
                            decimals={1}
                            placeholder="—"
                            aria-label={`Combined ${label}`}
                          />
                          <em>cm</em>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="book-courier__box-label book-courier__box-label--tight">Weight</p>
                  <div className="book-courier__weight-cards">
                    <label className="book-courier__weight-card">
                      <span className="book-courier__weight-card-title">
                        <Lock size={13} aria-hidden /> Actual Weight
                      </span>
                      <span className="book-courier__weight-card-value">
                        <DecimalTextInput
                          value={combineDims.weightKg}
                          onChange={next => setCombineDims(prev => ({ ...prev, weightKg: next }))}
                          placeholder="0.00"
                          aria-label="Combined actual weight in kg"
                        />
                        <em>kg</em>
                      </span>
                    </label>
                    <div className="book-courier__weight-card">
                      <span className="book-courier__weight-card-title">
                        <Package size={13} aria-hidden /> Chargeable Weight
                      </span>
                      <span className="book-courier__weight-card-value">
                        <strong>
                          {ceilChargeableWeightKg(
                            Math.max(
                              Number.parseFloat(combineDims.weightKg) || 0,
                              computeVolumetricWeight(
                                combineDims.lengthCm ? Number.parseFloat(combineDims.lengthCm) : null,
                                combineDims.widthCm ? Number.parseFloat(combineDims.widthCm) : null,
                                combineDims.heightCm ? Number.parseFloat(combineDims.heightCm) : null,
                                partnerId,
                              ),
                            ),
                            partnerId,
                          ).toFixed(2)}
                        </strong>
                        <em>kg</em>
                      </span>
                    </div>
                  </div>
                  <div className="book-courier__combine-form-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setCombineFormOpen(false)}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={applyCombineBoxes}
                    >
                      <Check size={16} aria-hidden />
                      Combine into 1 box
                    </button>
                  </div>
                </div>
              )}

              {isDelhivery && delhiveryDestPin ? (
                <DelhiveryQuoteStrip
                  originPin={delhiveryOriginPin || null}
                  destinationPin={delhiveryDestPin}
                  weightKg={totalChargeableWeight || totalActualWeight || 5}
                  freightBillingMode={draft.freightBillingMode === 'fod' ? 'fod' : 'btc'}
                  dimensions={delhiveryQuoteDimensions}
                  includeEstimate={Boolean(delhiveryOriginPin)}
                />
              ) : null}

              {isBlueDartAir ? (
                <p className="text-sm book-courier__hint text-muted">
                  Blue Dart Air: min
                  {' '}
                  {BLUE_DART_AIR_MIN_CHARGEABLE_KG}
                  {' '}
                  kg chargeable · max
                  {' '}
                  {BLUE_DART_AIR_MAX_CHARGEABLE_KG}
                  {' '}
                  kg.
                </p>
              ) : null}

              {isBlueDartDomestic ? (
                <p className="text-sm book-courier__hint text-muted">
                  Blue Dart Domestic Priority: billed every 0.5 kg · max
                  {' '}
                  {BLUE_DART_DP_MAX_CHARGEABLE_KG}
                  {' '}
                  kg chargeable.
                </p>
              ) : null}

              {blueDartAirOverMax ? (
                <p className="text-sm book-courier__hint" role="alert">
                  {blueDartAirMaxChargeableReason(totalChargeableWeight)}.
                  {' '}
                  Use Surface or another partner (Air max
                  {' '}
                  {BLUE_DART_AIR_MAX_CHARGEABLE_KG}
                  {' '}
                  kg).
                </p>
              ) : null}

              {blueDartDpOverMax ? (
                <p className="text-sm book-courier__hint" role="alert">
                  {blueDartDpMaxChargeableReason(totalChargeableWeight)}.
                  {' '}
                  Use Air, Surface, or another partner (Domestic Priority max
                  {' '}
                  {BLUE_DART_DP_MAX_CHARGEABLE_KG}
                  {' '}
                  kg).
                </p>
              ) : null}

              {stCourierTamilNaduOverMax ? (
                <p className="text-sm book-courier__hint" role="alert">
                  {stCourierTamilNaduMaxChargeableReason(totalChargeableWeight)}.
                  {' '}
                  Kerala has no ST weight cap — pick another partner for Tamil Nadu over
                  {' '}
                  {ST_COURIER_TAMIL_NADU_MAX_CHARGEABLE_KG}
                  {' '}
                  kg.
                </p>
              ) : null}

              <button
                type="button"
                className="btn btn-primary book-courier__next"
                disabled={!canProceedBox || combineSelectMode}
                onClick={() => setStep('review')}
              >
                {stCourierTamilNaduOverMax
                  ? `ST max ${ST_COURIER_TAMIL_NADU_MAX_CHARGEABLE_KG} kg to TN`
                  : blueDartAirOverMax
                    ? `Air max ${BLUE_DART_AIR_MAX_CHARGEABLE_KG} kg`
                    : blueDartDpOverMax
                      ? `DP max ${BLUE_DART_DP_MAX_CHARGEABLE_KG} kg`
                      : delhiveryNeedsLbh
                        ? 'Enter L × B × H to continue'
                        : 'Confirm & Next'}
              </button>
            </section>
          )}

          {/* SCREEN 4 — REVIEW */}
          {step === 'review' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                Review &amp; <span className="accent">Confirm</span>
              </h3>

              <div className="book-courier__review-card">
                <div className="book-courier__review-head">
                  <h4>Courier Details</h4>
                  <button type="button" className="book-courier__edit" onClick={() => setEditingCourier(v => !v)}>
                    <Pencil size={13} aria-hidden /> {editingCourier ? 'Done' : 'Edit'}
                  </button>
                </div>
                {editingCourier ? (
                  <div className="book-courier__review-edit">
                    <label className="courier-dialog__field">
                      <span>Consignment / tracking no.</span>
                      <input type="text" value={draft.consignmentNo}
                        onChange={e => updateDraft('consignmentNo', e.target.value)} />
                    </label>
                    <div className="courier-dialog__field-row">
                      <label className="courier-dialog__field">
                        <span>Service type</span>
                        <input type="text" value={draft.serviceType}
                          onChange={e => updateDraft('serviceType', e.target.value)} />
                      </label>
                      <label className="courier-dialog__field">
                        <span>Branch</span>
                        <input type="text" value={draft.branch}
                          onChange={e => updateDraft('branch', e.target.value)} />
                      </label>
                    </div>
                  </div>
                ) : (
                  <dl className="book-courier__kv">
                    <div><dt>Partner</dt><dd>{logisticsPartnerLabel(partnerId)}</dd></div>
                    <div>
                      <dt>Tracking No.</dt>
                      <dd>
                        {draft.consignmentNo || (isDelhivery
                          ? 'Will create via Delhivery API'
                          : isBlueDart
                            ? 'Will create via Blue Dart API'
                            : '—')}
                      </dd>
                    </div>
                    <div><dt>Service Type</dt><dd>{draft.serviceType || (isDelhivery ? 'Surface' : '—')}</dd></div>
                    <div><dt>Branch</dt><dd>{draft.branch || (isDelhivery ? 'Delhivery B2B' : '—')}</dd></div>
                  </dl>
                )}
              </div>

              {isDelhivery && delhiveryBookError ? (
                <p className="book-courier__slip-error" role="alert">{delhiveryBookError}</p>
              ) : null}
              {isBlueDart && blueDartBookError ? (
                <p className="book-courier__slip-error" role="alert">
                  {blueDartBookError}
                  {recoveredBlueDartAwb ? (
                    <>
                      {' '}
                      Cancel this AWB first, then Generate AWB again from this screen.
                    </>
                  ) : null}
                </p>
              ) : null}
              {isBlueDart && recoveredBlueDartAwb && !bookingBlueDart ? (
                <button
                  type="button"
                  className="btn btn-secondary book-courier__next"
                  disabled={cancellingBlueDart || saving}
                  onClick={() => void cancelRecoveredBlueDartAwb()}
                >
                  {cancellingBlueDart
                    ? 'Cancelling AWB…'
                    : `Cancel AWB ${recoveredBlueDartAwb}`}
                </button>
              ) : null}
              {isBlueDart && bookingBlueDart ? (
                <p className="text-sm book-courier__hint text-muted" role="status">
                  Generating AWB with Blue Dart — stay on this screen.
                </p>
              ) : null}

              <div className="book-courier__review-card">
                <div className="book-courier__review-head">
                  <h4>Delivery Address</h4>
                  <button type="button" className="book-courier__edit" onClick={() => setStep('address')}>
                    <Pencil size={13} aria-hidden /> Edit
                  </button>
                </div>
                {selectedDealer && (
                  <p className="book-courier__review-address">
                    <strong>{selectedDealer.name}</strong>
                    <span className="book-courier__dealer-code">{selectedDealer.code}</span>
                    <span>{selectedDealer.contactPerson} · {selectedDealer.mobile}</span>
                    <span className="text-muted">{deliveryAddressText}</span>
                  </p>
                )}
              </div>

              {draft.invoiceId?.trim() ? (
                <div className="book-courier__review-card">
                  <div className="book-courier__review-head">
                    <h4>Invoices</h4>
                    {includeClubInvoices ? (
                      <button type="button" className="book-courier__edit" onClick={() => setStep('club_invoices')}>
                        <Pencil size={13} aria-hidden /> Edit
                      </button>
                    ) : null}
                  </div>
                  <ul className="book-courier__club-review">
                    {normalizeDraftClubbedInvoices(draft).map(row => (
                      <li key={row.invoiceId}>
                        <strong>{row.invoiceNumber}</strong>
                        <span>{formatCurrency(row.valueInr)}</span>
                      </li>
                    ))}
                  </ul>
                  {normalizeDraftClubbedInvoices(draft).length > 1 ? (
                    <p className="text-muted text-sm">
                      {clubbedEwayBillRequiredLabel({
                        invoiceCount: normalizeDraftClubbedInvoices(draft).length,
                        clubbedTotalInr: clubbedInvoiceTotalInr(normalizeDraftClubbedInvoices(draft)),
                      })}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {isDelhivery && !draft.consignmentNo.trim() ? (
                <div className="book-courier__review-card">
                  <div className="book-courier__review-head">
                    <h4>Phone &amp; GSTIN</h4>
                  </div>
                  <dl className="book-courier__kv">
                    <div>
                      <dt>Ship-from phone</dt>
                      <dd>{delhiveryResolvedContacts.shipperPhone || 'Missing'}</dd>
                    </div>
                    <div>
                      <dt>Ship-from GSTIN</dt>
                      <dd>{delhiveryResolvedContacts.shipperGstin || 'Missing'}</dd>
                    </div>
                  </dl>
                  <div className="book-courier__contact-fields">
                    <label>
                      <span>Consignee phone</span>
                      <input
                        type="tel"
                        value={draft.customerPhone ?? ''}
                        placeholder={delhiveryResolvedContacts.consigneePhone || '10-digit mobile'}
                        disabled={bookingDelhivery}
                        onChange={event => {
                          const customerPhone = event.currentTarget.value;
                          applyDraft(prev => ({ ...prev, customerPhone }));
                        }}
                      />
                    </label>
                    <label>
                      <span>Consignee GSTIN</span>
                      <input
                        type="text"
                        value={draft.customerGstin ?? ''}
                        placeholder="15-character GSTIN"
                        autoCapitalize="characters"
                        maxLength={15}
                        disabled={bookingDelhivery}
                        onChange={event => {
                          const customerGstin = event.currentTarget.value.toUpperCase();
                          applyDraft(prev => ({ ...prev, customerGstin }));
                        }}
                      />
                    </label>
                  </div>
                  {delhiveryContactIssues.length > 0 ? (
                    <ul className="book-courier__slip-error" role="alert">
                      {delhiveryContactIssues.map(issue => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted text-sm" style={{ marginBottom: 0 }}>
                      Phone and GSTIN are ready for Delhivery booking.
                    </p>
                  )}
                </div>
              ) : null}

              <div className="book-courier__review-card">
                <div className="book-courier__review-head">
                  <h4>Package Details</h4>
                  <button type="button" className="book-courier__edit" onClick={() => setStep('box')}>
                    <Pencil size={13} aria-hidden /> Edit
                  </button>
                </div>
                <dl className="book-courier__kv">
                  <div><dt>Shipment Type</dt><dd>{isEnvelope ? 'Envelope' : 'Box'}</dd></div>
                  {!isEnvelope && (
                    <>
                      <div><dt>No. of Boxes</dt><dd>{draft.boxes.length}</dd></div>
                      <div><dt>Total Actual Weight</dt><dd>{totalActualWeight.toFixed(2)} kg</dd></div>
                      {draft.boxes.map((box, index) => (
                        <div key={box.id}>
                          <dt>Box {index + 1}</dt>
                          <dd>
                            {box.lengthCm && box.widthCm && box.heightCm
                              ? `${box.lengthCm} × ${box.widthCm} × ${box.heightCm} cm · `
                              : ''}
                            {(Number.parseFloat(box.weightKg) || 0).toFixed(2)} kg
                          </dd>
                        </div>
                      ))}
                    </>
                  )}
                </dl>
              </div>

              <div className="book-courier__review-card">
                <div className="book-courier__review-head">
                  <h4>Package Photos</h4>
                </div>
                <div className="book-courier__gallery">
                  {draft.boxes.flatMap((box, boxIndex) => box.photos.map(photo => (
                    <div key={photo.id} className="book-courier__thumb">
                      <button type="button" onClick={() => openPreview(photo.url)} aria-label={`Preview ${isEnvelope ? 'envelope' : `box ${boxIndex + 1}`} photo`}>
                        <img src={photo.url} alt={isEnvelope ? 'Envelope' : `Box ${boxIndex + 1}`} />
                      </button>
                      <span>{isEnvelope ? 'Envelope' : `Box ${boxIndex + 1}`}</span>
                    </div>
                  )))}
                  {!draftBoxesHaveRequiredPhotos(draft.boxes) && (
                    <p className="text-muted text-sm">No package photo yet. Add one on the Box step to continue.</p>
                  )}
                </div>
              </div>

              {isDelhivery ? (
                <div className="book-courier__review-card">
                  <div className="book-courier__review-head">
                    <h4>Freight billing</h4>
                  </div>
                  {freightBillingModeLocked ? (
                    <>
                      <p className="text-muted text-sm" style={{ marginTop: 0 }}>
                        Taken from the invoice Delhivery freight line — not editable here.
                        {' '}
                        ₹0 freight = FOD; charged freight = BTC.
                      </p>
                      <div className="logistics-booking__billing-mode-actions">
                        <span
                          className={[
                            'btn btn-secondary',
                            (draft.freightBillingMode || 'btc') === 'btc' ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          aria-current={(draft.freightBillingMode || 'btc') === 'btc'}
                        >
                          BTC
                        </span>
                        <span
                          className={[
                            'btn btn-secondary',
                            draft.freightBillingMode === 'fod' ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          aria-current={draft.freightBillingMode === 'fod'}
                        >
                          FOD
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-muted text-sm" style={{ marginTop: 0 }}>
                        BTC bills freight to YesWeigh (default when FoP is not enabled on the Delhivery account).
                        FOD collects freight from the consignee on delivery.
                      </p>
                      <div className="logistics-booking__billing-mode-actions">
                        <button
                          type="button"
                          className={[
                            'btn btn-secondary',
                            (draft.freightBillingMode || 'btc') === 'btc' ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          disabled={
                            bookingDelhivery
                            || Boolean(draft.consignmentNo.trim())
                          }
                          onClick={() => applyDraft(prev => ({ ...prev, freightBillingMode: 'btc' }))}
                        >
                          BTC
                        </button>
                        <button
                          type="button"
                          className={[
                            'btn btn-secondary',
                            draft.freightBillingMode === 'fod' ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          disabled={
                            bookingDelhivery
                            || Boolean(draft.consignmentNo.trim())
                          }
                          onClick={() => applyDraft(prev => ({ ...prev, freightBillingMode: 'fod' }))}
                        >
                          FOD
                        </button>
                      </div>
                    </>
                  )}
                  {Boolean(draft.consignmentNo.trim()) ? (
                    <p className="text-muted text-sm" style={{ marginBottom: 0 }}>
                      LR already created — billing mode is fixed for this shipment.
                    </p>
                  ) : null}
                  {delhiveryDestPin ? (
                    <DelhiveryQuoteStrip
                      originPin={delhiveryOriginPin || null}
                      destinationPin={delhiveryDestPin}
                      weightKg={totalChargeableWeight || totalActualWeight || 5}
                      freightBillingMode={draft.freightBillingMode === 'fod' ? 'fod' : 'btc'}
                      dimensions={delhiveryQuoteDimensions}
                      includeEstimate={Boolean(delhiveryOriginPin)}
                    />
                  ) : null}
                </div>
              ) : null}

              {boxesValid ? (
                <button
                  type="button"
                  className="btn btn-primary book-courier__next"
                  disabled={
                    bookingDelhivery
                    || bookingBlueDart
                    || cancellingBlueDart
                    || saving
                    || !canCreateDelhiveryLrn
                    || !canCreateBlueDartAwb
                    || Boolean(isBlueDart && recoveredBlueDartAwb)
                  }
                  onClick={() => {
                    if (isDelhivery) {
                      void confirmDelhiveryFromReview();
                      return;
                    }
                    if (isBlueDart) {
                      void confirmBlueDartFromReview();
                      return;
                    }
                    setStep('label');
                  }}
                >
                  {bookingDelhivery || bookingBlueDart || saving
                    ? (isDelhivery
                      ? ((draft.source === 'invoice' || Boolean(draft.invoiceId?.trim()))
                        && !(positiveInvoiceTotalInr(draft.invoiceValueInr) > 0)
                        ? 'Waiting for invoice & booking…'
                        : 'Booking Delhivery…')
                      : isBlueDart
                        ? 'Booking Blue Dart…'
                        : 'Saving…')
                    : (isDelhivery
                      ? (canCreateDelhiveryLrn
                        ? (draft.consignmentNo.trim() ? 'Confirm shipment' : 'Create LR & Confirm')
                        : 'Fix phone & GSTIN to continue')
                      : isBlueDart
                        ? (canCreateBlueDartAwb
                          ? (draft.consignmentNo.trim()
                            ? 'Confirm shipment'
                            : (recoveredBlueDartAwb ? 'Cancel AWB first' : 'Generate AWB'))
                          : 'Fix phone to continue')
                        : 'Next')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary book-courier__next"
                  onClick={() => setStep('box')}
                >
                  {delhiveryNeedsLbh
                    ? 'Enter L × B × H to continue'
                    : 'Add package photo to continue'}
                </button>
              )}
            </section>
          )}

          {/* SCREEN 5 — LABELS (non-Delhivery) */}
          {!isApiCourier && step === 'label' && selectedDealer && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                Print <span className="accent">Labels</span>
              </h3>
              <p className="book-courier__hint text-muted text-sm">
                Print the shipping label on the logistics printer. The courier slip is share-only
                {partnerId === 'st_courier'
                  ? ' (filled ST Courier POD PDF)'
                  : ''}
                {' '}— it is not sent to the label printer.
              </p>

              <div className="book-courier__label-grid">
                <article className="book-courier__label-card">
                  <header className="book-courier__label-card-head">
                    <h4>
                      Shipping label
                      {shippingLabelCount > 1 ? ` · ${shippingLabelCount} pcs` : ''}
                    </h4>
                    <div className="book-courier__label-print-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void handlePrintShippingLabels()}
                        disabled={
                          isPlaceholderLogisticsAddress(fromAddresses[draft.shipFromSite])
                          || isPlaceholderLogisticsAddress(deliveryAddressText)
                        }
                      >
                        <Printer size={14} aria-hidden />
                        {shippingLabelCount > 1 ? 'Print all' : 'Print'}
                      </button>
                    </div>
                  </header>
                  {isPlaceholderLogisticsAddress(fromAddresses[draft.shipFromSite])
                    || isPlaceholderLogisticsAddress(deliveryAddressText) ? (
                      <p className="book-courier__hint text-muted text-sm" role="alert">
                        {isPlaceholderLogisticsAddress(fromAddresses[draft.shipFromSite])
                          ? 'Ship-from (FROM) address is missing. Set it under Admin → Logistics → Sites for this location before the label can be shown.'
                          : 'Delivery (TO) address is missing. Use the invoice Ship To or refresh the dealer from Zoho before the label can be shown.'}
                      </p>
                    ) : (
                      <>
                        <div className="book-courier__label-preview book-courier__label-preview--stack">
                          {shippingLabels.map((label, index) => (
                            <div
                              key={`ship-${label.boxIndex}`}
                              className="book-courier__label-sheet"
                            >
                              {shippingLabelCount > 1 && (
                                <p className="book-courier__label-sheet-caption">
                                  {`Label ${label.boxIndex} of ${shippingLabelCount} · 100 × 150 mm`}
                                </p>
                              )}
                              <ShippingLabelBitmapPreview
                                label={label}
                                ref={el => {
                                  shippingLabelCanvasRefs.current[index] = el;
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        <p className="book-courier__hint text-muted text-sm">
                          {shippingLabelCount > 1
                            ? `Exact 203 DPI preview — ${shippingLabelCount} separate 100×150 mm labels (one per box). Print all sends each as its own page.`
                            : 'Exact 203 DPI print preview — what you see is what the logistics printer receives.'}
                        </p>
                      </>
                    )}
                </article>

                <article className="book-courier__label-card">
                  <header className="book-courier__label-card-head">
                    <h4>Courier slip</h4>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!courierSlip || sharingCourierSlip}
                      onClick={() => void handleShareCourierSlip()}
                    >
                      <Share2 size={14} aria-hidden />
                      {sharingCourierSlip ? 'Sharing…' : 'Share'}
                    </button>
                  </header>
                  <div className="book-courier__label-preview book-courier__slip-preview">
                    {courierSlipError && (
                      <p className="book-courier__slip-error">{courierSlipError}</p>
                    )}
                    {courierSlipPdfBytes ? (
                      <ZoomablePdfPreview data={courierSlipPdfBytes} />
                    ) : courierSlipPreviewUrl ? (
                      <ZoomableImagePreview src={courierSlipPreviewUrl} alt="Courier slip" />
                    ) : (
                      <p className="text-muted text-sm book-courier__slip-preparing">
                        Preparing courier slip…
                      </p>
                    )}
                  </div>
                  <p className="book-courier__hint text-muted text-sm">
                    {partnerId === 'st_courier'
                      ? 'Pinch or use + / − to zoom · drag to pan · Share sends the filled POD PDF.'
                      : 'Pinch or use + / − to zoom · drag to pan · Share via WhatsApp or any app.'}
                  </p>
                </article>
              </div>

              <div className="book-courier__final-photo-actions book-courier__label-next-row">
                <button
                  type="button"
                  className="btn btn-secondary book-courier__next"
                  disabled={saving}
                  onClick={() => {
                    const next = { ...draftRef.current, labelGenerated: true };
                    draftRef.current = next;
                    setDraft(next);
                    setStep('final_photo');
                  }}
                >
                  Add outer photo
                </button>
                <button
                  type="button"
                  className="btn btn-primary book-courier__next"
                  disabled={saving}
                  onClick={() => {
                    const next = { ...draftRef.current, labelGenerated: true };
                    draftRef.current = next;
                    setDraft(next);
                    void handleConfirmShipment();
                  }}
                >
                  <CheckCircle2 size={16} aria-hidden />
                  {saving ? 'Saving…' : 'Skip photo & Confirm'}
                </button>
              </div>
            </section>
          )}

          {/* SCREEN 6 — FINAL PACKAGE PHOTO (optional, non-Delhivery) */}
          {!isApiCourier && step === 'final_photo' && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                Capture <span className="accent">Outer</span> Package Photo
              </h3>
              <p className="book-courier__hint text-muted text-sm">
                Optional — capture proof that the shipping label is pasted correctly,
                or skip and confirm without it.
              </p>

              {draft.finalPackagePhoto ? (
                <div className="book-courier__final-photo">
                  <img
                    src={draft.finalPackagePhoto}
                    alt="Final package"
                    onClick={() => openPreview(draft.finalPackagePhoto!)}
                  />
                  <div className="book-courier__final-photo-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => finalPhotoCaptureInputRef.current?.click()}
                    >
                      <Camera size={14} aria-hidden /> Retake
                    </button>
                  </div>
                </div>
              ) : (
                <div className="book-courier__final-photo-actions">
                  <button
                    type="button"
                    className="book-courier__scan-visual book-courier__scan-visual--button"
                    onClick={() => finalPhotoCaptureInputRef.current?.click()}
                  >
                    <Camera size={36} strokeWidth={1.25} aria-hidden />
                    <span>Capture outer package photo</span>
                  </button>
                </div>
              )}
              <input
                ref={finalPhotoCaptureInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={event => {
                  void handleFinalPhotoChange(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />

              <button
                type="button"
                className="btn btn-primary book-courier__next"
                disabled={saving}
                onClick={() => void handleConfirmShipment()}
              >
                <CheckCircle2 size={16} aria-hidden />
                {saving
                  ? 'Saving…'
                  : (draft.finalPackagePhoto ? 'Confirm booking' : 'Skip photo & Confirm')}
              </button>
            </section>
          )}

          {/* SCREEN — E-WAY BILL (invoice-linked, ops, > ₹50k) */}
          {step === 'eway_bill' && booking && (
            <section className="book-courier__section">
              <h3 className="book-courier__section-title">
                Generate <span className="accent">E-way bill</span>
              </h3>
              {ewayBillStatus === 'generated' ? (
                <>
                  <div className="book-courier__success-badge book-courier__success-badge--compact">
                    <CheckCircle2 size={32} aria-hidden />
                  </div>
                  <p className="book-courier__hint text-sm">
                    E-way bill ready
                    {ewayBillNumber ? `: ${ewayBillNumber}` : '.'}
                  </p>
                </>
              ) : (
                <div className="logistics-eway-generate__body book-courier__eway-panel">
                  <EwayBillGeneratePreviewBody
                    preview={ewayGeneratePreview}
                    error={ewayGenerateError}
                    intro={clubbedEwayBillRequiredLabel({
                      invoiceCount: Math.max(
                        1,
                        (booking.invoices?.length || normalizeDraftClubbedInvoices(draft).length),
                      ),
                      clubbedTotalInr: booking.invoiceValueInr ?? draft.invoiceValueInr ?? 0,
                    }) + ' Confirm to create the e-way bill in Zoho for each invoice on this LR, or skip and do it later from shipment details.'}
                  />
                </div>
              )}
              <div className="book-courier__final-photo-actions book-courier__label-next-row">
                {ewayBillStatus !== 'generated' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary book-courier__next"
                      disabled={ewayEnsuring}
                      onClick={finishWizardFromEwayStep}
                    >
                      Skip for now
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary book-courier__next"
                      disabled={ewayEnsuring || isEwayTransporterMissing(ewayGeneratePreview)}
                      onClick={() => void handleWizardGenerateEway()}
                    >
                      {ewayEnsuring ? 'Generating…' : (
                        (booking.invoices?.length || 0) > 1
                          ? `Generate ${booking.invoices?.length} e-way bills`
                          : 'Generate e-way bill'
                      )}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary book-courier__next"
                    onClick={finishWizardFromEwayStep}
                  >
                    {isDelhivery ? 'View shipment' : 'Continue'}
                  </button>
                )}
              </div>
            </section>
          )}

          {/* SCREEN 7 — COMPLETED */}
          {step === 'complete' && booking && (
            <section className="book-courier__section book-courier__success">
              <div className="book-courier__success-badge">
                <CheckCircle2 size={44} aria-hidden />
              </div>
              <h3 className="book-courier__success-title">Shipment Booked</h3>
              <div className="book-courier__success-track">
                <span>Tracking Number</span>
                <strong>{booking.trackingNo}</strong>
              </div>
              <dl className="book-courier__kv">
                <div><dt>Courier</dt><dd>{logisticsPartnerLabel(booking.partnerId)}</dd></div>
                <div><dt>Dealer</dt><dd>{booking.dealer.name}</dd></div>
                <div><dt>Boxes</dt><dd>{booking.numberOfBoxes}</dd></div>
                <div><dt>Weight</dt><dd>{booking.actualWeightKg.toFixed(2)} kg</dd></div>
              </dl>
              {!booking.finalPackagePhoto && !booking.finalPackagePhotoStoragePath && (
                <div className="book-courier__success-photo">
                  <p className="book-courier__hint text-muted text-sm">
                    Outer package photo still missing — add it now or later from shipment details.
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={saving}
                    onClick={() => finalPhotoCaptureInputRef.current?.click()}
                  >
                    <Camera size={14} aria-hidden />
                    {saving ? 'Uploading…' : 'Add outer package photo'}
                  </button>
                  <input
                    ref={finalPhotoCaptureInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={event => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      void (async () => {
                        setSaving(true);
                        try {
                          const updated = await uploadLogisticsBookingFinalPackagePhoto(
                            booking,
                            file,
                            user,
                          );
                          setBooking(updated);
                          onBookingUpdated?.(updated);
                        } catch (err) {
                          window.alert(err instanceof Error ? err.message : 'Could not upload photo.');
                        } finally {
                          setSaving(false);
                        }
                      })();
                    }}
                  />
                </div>
              )}
              <div className="book-courier__success-actions">
                <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
                <button type="button" className="btn btn-primary" onClick={handleFinish}>View Shipment</button>
              </div>
            </section>
          )}
        </div>

        {previewIndex != null && galleryUrls[previewIndex] && (
          <PhotoLightbox
            urls={galleryUrls}
            index={previewIndex}
            onClose={() => setPreviewIndex(null)}
            onIndexChange={setPreviewIndex}
          />
        )}
      </div>
    </div>,
    document.body,
  );
};

interface BoxCardProps {
  box: ShipmentBoxDraft;
  index: number;
  partnerId: LogisticsPartnerId;
  isEnvelope: boolean;
  /** When true (Delhivery), L×B×H is required before booking. */
  dimsRequired?: boolean;
  spareBoxDefinitions?: SpareBoxDefinition[];
  canRemove: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onField: (key: BoxNumberField, value: string) => void;
  onApplySpareBoxDefinition?: (definitionId: string) => void;
  onAddPhoto: (file: File | undefined) => void;
  onRemovePhoto: (photoId: string) => void;
  onPreview: (url: string) => void;
  onRemoveBox: () => void;
}

const BoxCard: React.FC<BoxCardProps> = ({
  box,
  index,
  partnerId,
  isEnvelope,
  dimsRequired = false,
  spareBoxDefinitions = [],
  canRemove,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onField,
  onApplySpareBoxDefinition,
  onAddPhoto,
  onRemovePhoto,
  onPreview,
  onRemoveBox,
}) => {
  const photoCaptureInputRef = useRef<HTMLInputElement>(null);
  const volumetric = boxVolumetric(box, partnerId);
  const actualWeight = Number.parseFloat(box.weightKg) || 0;
  const chargeableWeight = ceilChargeableWeightKg(
    Math.max(actualWeight, volumetric),
    partnerId,
  );
  const matchedSpareBoxId = spareBoxDefinitions.find(def => (
    spareBoxDefinitionMatchesDraftDims(def, box)
  ))?.id ?? '';

  return (
    <section className={`book-courier__box${selected ? ' is-selected-combine' : ''}`}>
      <div className="book-courier__box-head">
        <h4 className="book-courier__box-title">
          {selectMode && (
            <button
              type="button"
              className={`book-courier__box-check${selected ? ' is-checked' : ''}`}
              aria-pressed={selected}
              aria-label={`${selected ? 'Deselect' : 'Select'} box ${index + 1}`}
              onClick={onToggleSelect}
            >
              {selected ? <Check size={14} aria-hidden /> : null}
            </button>
          )}
          {isEnvelope ? 'Envelope' : `Box ${index + 1}`}
        </h4>
        {canRemove && (
          <button type="button" className="book-courier__box-remove" onClick={onRemoveBox} aria-label={`Remove box ${index + 1}`}>
            <Trash2 size={15} aria-hidden />
          </button>
        )}
      </div>

      {!isEnvelope && (
        <>
          <p className="book-courier__box-label">
            Dimensions (cm)
            {dimsRequired ? (
              <span className="book-courier__box-req"> * required</span>
            ) : (
              <span className="book-courier__box-opt"> · optional</span>
            )}
          </p>
          {spareBoxDefinitions.length > 0 && onApplySpareBoxDefinition && (
            <label className="book-courier__spare-box-preset">
              <span>Spare box</span>
              <select
                value={matchedSpareBoxId}
                aria-label={`Spare box preset for box ${index + 1}`}
                onChange={e => {
                  const nextId = e.target.value;
                  if (nextId) onApplySpareBoxDefinition(nextId);
                }}
              >
                <option value="">Custom L×B×H</option>
                {spareBoxDefinitions.map(def => (
                  <option key={def.id} value={def.id}>
                    {def.name} ({def.lengthCm}×{def.breadthCm}×{def.heightCm} cm)
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="book-courier__dim-cards">
            {([
              ['Length (L)', 'lengthCm'],
              ['Breadth (W)', 'widthCm'],
              ['Height (H)', 'heightCm'],
            ] as Array<[string, BoxNumberField]>).map(([label, key]) => (
              <label className="book-courier__dim-card" key={key}>
                <span className="book-courier__dim-card-title">{label}</span>
                <span className="book-courier__dim-card-value">
                  <DecimalTextInput
                    value={box[key]}
                    onChange={next => onField(key, next)}
                    decimals={1}
                    placeholder="—"
                    aria-label={dimsRequired ? `${label} (required)` : `${label} (optional)`}
                  />
                  <em>cm</em>
                </span>
              </label>
            ))}
          </div>

          <p className="book-courier__box-label book-courier__box-label--tight">Weight</p>
          <div className="book-courier__weight-cards">
            <label className="book-courier__weight-card">
              <span className="book-courier__weight-card-title"><Lock size={13} aria-hidden /> Actual Weight</span>
              <span className="book-courier__weight-card-value">
                <DecimalTextInput
                  value={box.weightKg}
                  onChange={next => onField('weightKg', next)}
                  placeholder="0.00"
                  aria-label="Actual weight in kg"
                />
                <em>kg</em>
              </span>
            </label>
            <div className="book-courier__weight-card">
              <span className="book-courier__weight-card-title"><Package size={13} aria-hidden /> Chargeable Weight</span>
              <span className="book-courier__weight-card-value">
                <strong>{chargeableWeight.toFixed(2)}</strong>
                <em>kg</em>
              </span>
            </div>
          </div>
        </>
      )}

      <p className="book-courier__box-label">
        {isEnvelope ? 'Envelope Photos' : 'Package Photos'}
        <span className="book-courier__box-req"> * inside photo required · camera only</span>
      </p>
      <div className="book-courier__photo-grid">
        {box.photos.map((photo, photoIndex) => (
          <div className="book-courier__photo-cell" key={photo.id}>
            <button
              type="button"
              className="book-courier__photo-open"
              onClick={() => onPreview(photo.url)}
              aria-label={`Preview photo ${photoIndex + 1}`}
            >
              <img src={photo.url} alt="" />
            </button>
            <button
              type="button"
              className="book-courier__photo-del"
              onClick={() => onRemovePhoto(photo.id)}
              aria-label={`Remove photo ${photoIndex + 1}`}
            >
              <X size={13} aria-hidden />
            </button>
            <span className="book-courier__photo-cap">
              {photoIndex === 0 ? 'Inside view' : `Photo ${photoIndex + 1}`}
            </span>
          </div>
        ))}
        <button
          type="button"
          className="book-courier__photo-add"
          onClick={() => photoCaptureInputRef.current?.click()}
        >
          <Camera size={20} aria-hidden />
          <span>{box.photos.length === 0 ? 'Capture inside' : 'Capture'}</span>
          {box.photos.length > 0 && <em className="book-courier__photo-add-opt">Optional</em>}
        </button>
      </div>
      <input
        ref={photoCaptureInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={event => {
          onAddPhoto(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </section>
  );
};
