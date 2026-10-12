import {
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import { parseDealerCustomerInvoice } from './admin-sales-orders';
import type { LogisticsPartnerId } from '../constants/logisticsPartners';
import {
  isBlueDartLogisticsPartnerId,
  isLogisticsPartnerId,
  logisticsPartnerLabel,
} from '../constants/logisticsPartners';
import type { User } from '../types';
import { normalizeRole } from '../types';
import { isInternalOpsUser } from './staffAccess';
import {
  extractPhoneFromText,
  isPlaceholderLogisticsAddress,
  phoneDigitsForCourier,
  resolveDeliveryAddress,
  resolveDraftDeliveryAddress,
  resolveReceiverPhoneFromSnapshot,
  zohoDealerToSnapshot,
} from './logisticsDealers';
import {
  CHANGEABLE_LOGISTICS_PARTNER_IDS,
  canChangeLogisticsBookingPartner,
  canRebookCancelledBookingViaBlueDart,
  computeVolumetricWeight,
  consignmentChargeableWeightKg,
  draftBoxesHaveRequiredPhotos,
  emptyShipmentBoxDraft,
  isApiBookedLogisticsPartner,
  isPipelineEnabledPartner,
  statusForDocument,
  type BookCourierStep,
} from './logisticsBooking';
import { fetchDealerById } from './dealers';
import type { DealerInvoiceDetail } from '../types/invoices';
import { isDelhiveryFreightBillingModeLocked } from './logisticsPrefill';
import {
  dataUrlToFile,
  deleteLogisticsPhoto,
  logisticsCaptureToDataUrl,
  resolveLogisticsPhotoUrls,
  uploadLogisticsPhoto,
} from './logisticsPhotos';
import { loadLogisticsSettings } from './logisticsSettings';
import { resolvePersistShipFromSite } from './logisticsShipFrom';
import {
  bookBlueDartShipment,
  parseBlueDartAlreadyGenerated,
} from './blueDartApi';
import { blueDartPickupPinForSite } from '../constants/blueDartPickup';
import { FIRM_GSTIN, FIRM_PHONE } from '../constants/brand';
import { extractCityState, extractDestinationCity } from './shippingLabel';
import {
  extractIndianPincode,
  fetchStCourierDeliveryOffice,
} from './stCourierTrack';
import { tryRefreshLogisticsBookingTrack } from './logisticsTrackRefresh';
import { scheduleDelhiveryDocumentsPrefetch } from './delhiveryDocuments';
import {
  isDelhiveryB2bLrn,
  isDelhiveryMasterAwb,
  normalizeDelhiveryId,
  resolveDelhiveryBookingIds,
} from './delhiveryTrack';
import type {
  LogisticsBooking,
  LogisticsBookingDraft,
  LogisticsBookingInvoice,
  LogisticsBookingStatus,
  LogisticsCourierDeliveryOffice,
  LogisticsCourierTrack,
  LogisticsComplaintLog,
  LogisticsDealerSnapshot,
  LogisticsDocumentType,
  ShipmentBox,
  ShipmentBoxDraft,
  ShipmentBoxPhoto,
} from '../types/logistics-dispatch';
import { persistClubbedInvoiceFields } from './logisticsClubInvoices';
import {
  isStaffLogisticsSite,
  STAFF_LOGISTICS_SITE_LABELS,
  type StaffLogisticsSite,
} from '../types/staff-logistics';

const COLLECTION = 'logisticsBookings';
const FIRESTORE_BATCH_LIMIT = 450;

function mapBookingInvoices(raw: unknown, fallback: {
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceValueInr: number | null;
}): LogisticsBookingInvoice[] {
  if (Array.isArray(raw)) {
    const rows: LogisticsBookingInvoice[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const invoiceId = String(row.invoiceId ?? '').trim();
      if (!invoiceId || seen.has(invoiceId)) continue;
      seen.add(invoiceId);
      const valueInr = Number(row.valueInr);
      rows.push({
        invoiceId,
        invoiceNumber: String(row.invoiceNumber ?? '').trim() || invoiceId,
        valueInr: Number.isFinite(valueInr) && valueInr > 0 ? valueInr : 0,
        ewayBillNumber: typeof row.ewayBillNumber === 'string' ? row.ewayBillNumber : null,
        ewayBillStatus: typeof row.ewayBillStatus === 'string' ? row.ewayBillStatus : null,
        ewayRequired: row.ewayRequired === true,
      });
    }
    if (rows.length) return rows;
  }
  const primaryId = fallback.invoiceId?.trim() || '';
  if (!primaryId) return [];
  return [{
    invoiceId: primaryId,
    invoiceNumber: fallback.invoiceNumber?.trim() || primaryId,
    valueInr: fallback.invoiceValueInr ?? 0,
  }];
}

function bookingInvoiceIdsFromDoc(data: DocumentData, invoices: LogisticsBookingInvoice[], invoiceId: string | null): string[] {
  const fromArray = Array.isArray(data.invoiceIds)
    ? data.invoiceIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
    : [];
  const merged = [...fromArray, ...invoices.map(row => row.invoiceId), invoiceId ?? ''];
  return [...new Set(merged.filter(Boolean))];
}

/** Newest bookingDate first; same day uses createdAt then updatedAt. */
export function compareLogisticsBookingsByBookingDateDesc(
  a: LogisticsBooking,
  b: LogisticsBooking,
): number {
  const aDate = String(a.bookingDate || '').slice(0, 10);
  const bDate = String(b.bookingDate || '').slice(0, 10);
  if (aDate !== bDate) return bDate.localeCompare(aDate);
  const aCreated = a.createdAt || a.updatedAt || '';
  const bCreated = b.createdAt || b.updatedAt || '';
  if (aCreated !== bCreated) return bCreated.localeCompare(aCreated);
  return (b.updatedAt || '').localeCompare(a.updatedAt || '');
}

function mapCourierTrack(raw: unknown): LogisticsCourierTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as DocumentData;
  const history = Array.isArray(data.history)
    ? data.history.map((item: DocumentData) => ({
      at: String(item?.at ?? ''),
      location: String(item?.location ?? ''),
      activity: String(item?.activity ?? ''),
    }))
    : [];
  return {
    awb: String(data.awb ?? ''),
    ok: Boolean(data.ok),
    error: data.error == null ? null : String(data.error),
    status: data.status == null ? null : String(data.status),
    statusType: data.statusType == null ? null : String(data.statusType),
    masterAwb: data.masterAwb == null ? null : String(data.masterAwb),
    origin: data.origin == null ? null : String(data.origin),
    destination: data.destination == null ? null : String(data.destination),
    consignmentType: data.consignmentType == null ? null : String(data.consignmentType),
    bookedAt: data.bookedAt == null ? null : String(data.bookedAt),
    deliveredAt: data.deliveredAt == null ? null : String(data.deliveredAt),
    history,
    sourceUrl: String(data.sourceUrl ?? ''),
    fetchedAt: String(data.fetchedAt ?? ''),
  };
}

function mapComplaintLogs(raw: unknown): LogisticsComplaintLog[] {
  if (!Array.isArray(raw)) return [];
  const rows: LogisticsComplaintLog[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const data = item as Record<string, unknown>;
    const at = typeof data.at === 'string' ? data.at.trim() : '';
    if (!at) continue;
    rows.push({
      at,
      notes: typeof data.notes === 'string' ? data.notes.trim() : '',
      kind: 'resolved',
      byName: typeof data.byName === 'string' ? data.byName.trim() : '',
    });
  }
  return rows;
}

function mapDelhiveryPickup(raw: unknown): import('../types/logistics-dispatch').LogisticsDelhiveryPickup | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const pickupId = typeof data.pickupId === 'string' && data.pickupId.trim()
    ? data.pickupId.trim()
    : null;
  const requestedAt = typeof data.requestedAt === 'string' && data.requestedAt.trim()
    ? data.requestedAt.trim()
    : '';
  if (!pickupId && !requestedAt && data.ok !== true && data.ok !== false) return null;
  return {
    ok: data.ok === true,
    alreadyExisted: data.alreadyExisted === true,
    pickupId,
    pickupLocationName: typeof data.pickupLocationName === 'string' ? data.pickupLocationName : null,
    pickupDate: typeof data.pickupDate === 'string' ? data.pickupDate : null,
    pickupTime: typeof data.pickupTime === 'string' ? data.pickupTime : null,
    expectedPackageCount: typeof data.expectedPackageCount === 'number' && Number.isFinite(data.expectedPackageCount)
      ? data.expectedPackageCount
      : null,
    message: typeof data.message === 'string' ? data.message : null,
    requestedAt: requestedAt || new Date(0).toISOString(),
  };
}

function mapBlueDartPickup(raw: unknown): import('../types/logistics-dispatch').LogisticsBlueDartPickup | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const requestedAt = typeof data.requestedAt === 'string' && data.requestedAt.trim()
    ? data.requestedAt.trim()
    : '';
  const registered = data.registered === true || data.ok === true;
  if (!requestedAt && data.ok !== true && data.ok !== false && data.registered !== true) {
    return null;
  }
  return {
    ok: registered,
    registered,
    pickupDate: typeof data.pickupDate === 'string' ? data.pickupDate : null,
    pickupTime: typeof data.pickupTime === 'string' ? data.pickupTime : null,
    pickupAddress: typeof data.pickupAddress === 'string' ? data.pickupAddress : null,
    pickupPin: typeof data.pickupPin === 'string' ? data.pickupPin : null,
    originArea: typeof data.originArea === 'string' ? data.originArea : null,
    destinationArea: typeof data.destinationArea === 'string' ? data.destinationArea : null,
    destinationLocation: typeof data.destinationLocation === 'string' ? data.destinationLocation : null,
    tokenNumber: typeof data.tokenNumber === 'string' ? data.tokenNumber : null,
    message: typeof data.message === 'string' ? data.message : null,
    requestedAt: requestedAt || new Date(0).toISOString(),
  };
}

function mapDelhiveryEwaySync(raw: unknown): import('../types/logistics-dispatch').LogisticsDelhiveryEwaySync | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const syncedAt = typeof data.syncedAt === 'string' && data.syncedAt.trim()
    ? data.syncedAt.trim()
    : '';
  if (!syncedAt && data.ok !== true && data.ok !== false) return null;
  const invoices = Array.isArray(data.invoices)
    ? data.invoices
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const item = row as Record<string, unknown>;
        const invNumber = String(item.inv_number ?? item.invoiceNumber ?? '').trim();
        if (!invNumber) return null;
        return {
          inv_number: invNumber,
          ewaybill: String(item.ewaybill ?? item.ewayBillNumber ?? '').trim(),
        };
      })
      .filter((row): row is { inv_number: string; ewaybill: string } => Boolean(row))
    : [];
  return {
    ok: data.ok === true,
    lrn: typeof data.lrn === 'string' && data.lrn.trim() ? data.lrn.trim() : null,
    fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
    jobId: typeof data.jobId === 'string' ? data.jobId : null,
    error: typeof data.error === 'string' ? data.error : null,
    invoices,
    syncedAt: syncedAt || new Date(0).toISOString(),
    source: data.source === 'partner_status' || data.source === 'push'
      ? data.source
      : null,
  };
}

function mapDelhiveryDocuments(
  raw: unknown,
): import('../types/logistics-dispatch').LogisticsDelhiveryDocumentsCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const lrn = String(data.lrn ?? '').replace(/\D/g, '').trim();
  if (!lrn) return null;

  const lrCopyRaw = data.lrCopy && typeof data.lrCopy === 'object'
    ? data.lrCopy as Record<string, unknown>
    : null;
  const lrCopyPath = typeof lrCopyRaw?.storagePath === 'string' ? lrCopyRaw.storagePath.trim() : '';
  const labelsRaw = data.shippingLabels && typeof data.shippingLabels === 'object'
    ? data.shippingLabels as Record<string, unknown>
    : null;
  const labelImages = Array.isArray(labelsRaw?.images)
    ? labelsRaw.images
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const image = row as Record<string, unknown>;
        const storagePath = typeof image.storagePath === 'string' ? image.storagePath.trim() : '';
        if (!storagePath) return null;
        return {
          storagePath,
          contentType: typeof image.contentType === 'string' ? image.contentType : 'image/png',
          fileName: typeof image.fileName === 'string' ? image.fileName : 'label.png',
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
    : [];
  const podRaw = data.pod && typeof data.pod === 'object'
    ? data.pod as Record<string, unknown>
    : null;
  const podPaths = Array.isArray(podRaw?.storagePaths)
    ? podRaw.storagePaths.map(path => String(path || '').trim()).filter(Boolean)
    : [];
  const codRaw = data.cod && typeof data.cod === 'object'
    ? data.cod as Record<string, unknown>
    : null;
  const codPath = typeof codRaw?.storagePath === 'string' ? codRaw.storagePath.trim() : '';
  const prefetchRaw = data.prefetchStatus && typeof data.prefetchStatus === 'object'
    ? data.prefetchStatus as Record<string, unknown>
    : null;

  return {
    lrn,
    lrCopy: lrCopyPath
      ? {
        storagePath: lrCopyPath,
        contentType: typeof lrCopyRaw?.contentType === 'string' ? lrCopyRaw.contentType : 'application/pdf',
        fileName: typeof lrCopyRaw?.fileName === 'string' ? lrCopyRaw.fileName : `${lrn}-lr-copy.pdf`,
        cachedAt: typeof lrCopyRaw?.cachedAt === 'string' ? lrCopyRaw.cachedAt : '',
      }
      : null,
    shippingLabels: labelImages.length
      ? {
        size: typeof labelsRaw?.size === 'string' ? labelsRaw.size : 'a4',
        images: labelImages,
        cachedAt: typeof labelsRaw?.cachedAt === 'string' ? labelsRaw.cachedAt : '',
      }
      : null,
    pod: podPaths.length
      ? {
        storagePaths: podPaths,
        cachedAt: typeof podRaw?.cachedAt === 'string' ? podRaw.cachedAt : '',
      }
      : null,
    cod: codPath
      ? {
        storagePath: codPath,
        contentType: typeof codRaw?.contentType === 'string' ? codRaw.contentType : 'image/jpeg',
        fileName: typeof codRaw?.fileName === 'string' ? codRaw.fileName : `${lrn}-cod.jpg`,
        cachedAt: typeof codRaw?.cachedAt === 'string' ? codRaw.cachedAt : '',
      }
      : null,
    prefetchStatus: prefetchRaw
      ? {
        lastAttemptAt: typeof prefetchRaw.lastAttemptAt === 'string' ? prefetchRaw.lastAttemptAt : undefined,
        completedAt: typeof prefetchRaw.completedAt === 'string' ? prefetchRaw.completedAt : undefined,
        lrCopy: typeof prefetchRaw.lrCopy === 'string' ? prefetchRaw.lrCopy : undefined,
        shippingLabels: typeof prefetchRaw.shippingLabels === 'string' ? prefetchRaw.shippingLabels : undefined,
        pod: typeof prefetchRaw.pod === 'string' ? prefetchRaw.pod : undefined,
        cod: typeof prefetchRaw.cod === 'string' ? prefetchRaw.cod : undefined,
      }
      : null,
  };
}

function mapBlueDartDocFile(
  raw: unknown,
  fallbackFileName: string,
): import('../types/logistics-dispatch').LogisticsBlueDartDocFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const storagePath = typeof data.storagePath === 'string' ? data.storagePath.trim() : '';
  if (!storagePath) return null;
  return {
    storagePath,
    contentType: typeof data.contentType === 'string' ? data.contentType : 'application/pdf',
    fileName: typeof data.fileName === 'string' ? data.fileName : fallbackFileName,
    cachedAt: typeof data.cachedAt === 'string' ? data.cachedAt : '',
    ...(typeof data.labelSize === 'string' && data.labelSize.trim()
      ? { labelSize: data.labelSize.trim() }
      : {}),
  };
}

function mapBlueDartDocuments(
  raw: unknown,
): import('../types/logistics-dispatch').LogisticsBlueDartDocumentsCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const awb = String(data.awb ?? '').replace(/\D/g, '').trim();
  if (!awb) return null;
  return {
    awb,
    waybill: mapBlueDartDocFile(data.waybill, `${awb}-100x150.pdf`),
    awbA4: mapBlueDartDocFile(data.awbA4, `${awb}-a4.pdf`),
  };
}

function maybeScheduleDelhiveryDocumentsPrefetch(booking: LogisticsBooking): void {
  if (booking.partnerId !== 'delhivery') return;
  if (booking.wizardStep) return;
  const lrn = (booking.consignmentNo || booking.trackingNo || '').replace(/\D/g, '');
  if (!lrn) return;
  scheduleDelhiveryDocumentsPrefetch({
    bookingId: booking.id,
    includePodCod: booking.status === 'delivered',
  });
}

function mapFreightBillingMode(
  raw: unknown,
): import('../types/logistics-dispatch').LogisticsFreightBillingMode | null {
  return raw === 'fod' || raw === 'btc' ? raw : null;
}

function mapCourierFreight(raw: unknown): import('../types/logistics-dispatch').LogisticsCourierFreight | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as DocumentData;
  const breakupRaw = data.breakup && typeof data.breakup === 'object'
    ? data.breakup as DocumentData
    : null;
  return {
    ok: Boolean(data.ok),
    lrn: String(data.lrn ?? ''),
    totalInr: typeof data.totalInr === 'number' && Number.isFinite(data.totalInr) ? data.totalInr : null,
    chargedWeightKg: typeof data.chargedWeightKg === 'number' && Number.isFinite(data.chargedWeightKg)
      ? data.chargedWeightKg
      : null,
    minChargedWeightKg: typeof data.minChargedWeightKg === 'number' && Number.isFinite(data.minChargedWeightKg)
      ? data.minChargedWeightKg
      : null,
    breakup: breakupRaw
      ? {
        baseFreightCharge: typeof breakupRaw.baseFreightCharge === 'number' ? breakupRaw.baseFreightCharge : null,
        fuelSurcharge: typeof breakupRaw.fuelSurcharge === 'number' ? breakupRaw.fuelSurcharge : null,
        fuelHike: typeof breakupRaw.fuelHike === 'number' ? breakupRaw.fuelHike : null,
        insuranceRov: typeof breakupRaw.insuranceRov === 'number' ? breakupRaw.insuranceRov : null,
        odaFm: typeof breakupRaw.odaFm === 'number' ? breakupRaw.odaFm : null,
        odaLm: typeof breakupRaw.odaLm === 'number' ? breakupRaw.odaLm : null,
        fm: typeof breakupRaw.fm === 'number' ? breakupRaw.fm : null,
        lm: typeof breakupRaw.lm === 'number' ? breakupRaw.lm : null,
        green: typeof breakupRaw.green === 'number' ? breakupRaw.green : null,
        preTaxFreight: typeof breakupRaw.preTaxFreight === 'number' ? breakupRaw.preTaxFreight : null,
        gst: typeof breakupRaw.gst === 'number' ? breakupRaw.gst : null,
        gstPercent: typeof breakupRaw.gstPercent === 'number' ? breakupRaw.gstPercent : null,
        markup: typeof breakupRaw.markup === 'number' ? breakupRaw.markup : null,
        otherHandlingCharges: typeof breakupRaw.otherHandlingCharges === 'number'
          ? breakupRaw.otherHandlingCharges
          : null,
      }
      : null,
    billingMode: mapFreightBillingMode(data.billingMode),
    error: data.error == null ? null : String(data.error),
    fetchedAt: String(data.fetchedAt ?? ''),
    source: String(data.source ?? 'delhivery_freight_breakup'),
  };
}

function mapCourierDeliveryOffice(raw: unknown): LogisticsCourierDeliveryOffice | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as DocumentData;
  const communication = String(data.communication ?? '').trim();
  const pincode = String(data.pincode ?? '').replace(/\D/g, '').slice(0, 6);
  if (!communication || pincode.length !== 6) return null;
  return {
    pincode,
    communication,
    serviceCenter: data.serviceCenter == null ? null : String(data.serviceCenter),
    hubCenter: data.hubCenter == null ? null : String(data.hubCenter),
    sourceUrl: String(data.sourceUrl ?? 'https://stcourier.com/pincode-search'),
    fetchedAt: String(data.fetchedAt ?? ''),
  };
}

/** Fetch ST delivery-office once; keep existing snapshot when already filled. */
async function resolveCourierDeliveryOfficeForPersist(
  partnerId: string,
  deliveryAddress: string,
  existing: LogisticsCourierDeliveryOffice | null,
): Promise<LogisticsCourierDeliveryOffice | null> {
  if (existing?.communication?.trim()) return existing;
  if (partnerId !== 'st_courier') return null;
  const pincode = extractIndianPincode(deliveryAddress);
  if (!pincode) return null;
  try {
    const result = await fetchStCourierDeliveryOffice(pincode);
    if (!result.ok || !result.communication?.trim()) return null;
    return {
      pincode: result.pincode,
      communication: result.communication.trim(),
      serviceCenter: result.serviceCenter,
      hubCenter: result.hubCenter,
      sourceUrl: result.sourceUrl,
      fetchedAt: result.fetchedAt,
    };
  } catch {
    return null;
  }
}

export interface LogisticsBookingListFilters {
  status?: LogisticsBookingStatus | '';
  partnerId?: LogisticsPartnerId | '';
  query?: string;
}

export interface PersistLogisticsBookingInput {
  draft: LogisticsBookingDraft;
  dealer: LogisticsDealerSnapshot;
  createdBy: User;
  /** When confirming or updating an existing draft booking. */
  existingBookingId?: string | null;
  /** Wizard step stored on draft saves for resume. */
  wizardStep?: string | null;
}

function resolveDealerIdForUser(user: User): string {
  if (user.role === 'dealer') return user.uid;
  if (user.dealerId) return user.dealerId;
  return user.uid;
}

function isEditableStatus(status: LogisticsBookingStatus): boolean {
  return status === 'label_generated';
}

/** Map legacy/unknown status values onto the current pipeline statuses. */
function normalizeBookingStatus(raw: string): LogisticsBookingStatus {
  switch (raw) {
    case 'label_generated':
    case 'in_transit':
    case 'delivered':
    case 'cancelled':
    case 'returned':
      return raw;
    // Removed stage — fold into In Transit
    case 'shipped':
      return 'in_transit';
    case 'canceled':
      return 'cancelled';
    // Track-unavailable aliases → Booked (label_generated)
    case 'status_not_available':
    case 'tracking_failed':
      return 'label_generated';
    // Legacy draft/booked (and aliases) → start of public pipeline
    case 'draft':
    case 'booked':
    case 'courier_booked':
    case 'pickup_pending':
    default:
      return 'label_generated';
  }
}

function mapShipmentBox(data: DocumentData): ShipmentBox {
  const photos: ShipmentBoxPhoto[] = [];
  if (Array.isArray(data.photos)) {
    for (const photo of data.photos) {
      if (typeof photo === 'string' && photo.trim()) {
        photos.push({ storagePath: photo.trim(), url: null });
        continue;
      }
      const row = photo as DocumentData | null;
      const storagePath = typeof row?.storagePath === 'string' ? row.storagePath.trim() : '';
      if (!storagePath) continue;
      const clientPhotoId = typeof row?.clientPhotoId === 'string' && row.clientPhotoId.trim()
        ? row.clientPhotoId.trim()
        : undefined;
      photos.push({
        storagePath,
        url: null,
        ...(clientPhotoId ? { clientPhotoId } : {}),
      });
    }
  }
  return {
    id: String(data.id ?? ''),
    lengthCm: data.lengthCm == null ? null : Number(data.lengthCm),
    widthCm: data.widthCm == null ? null : Number(data.widthCm),
    heightCm: data.heightCm == null ? null : Number(data.heightCm),
    weightKg: Number(data.weightKg) || 0,
    volumetricWeightKg: Number(data.volumetricWeightKg) || 0,
    photos,
  };
}

async function hydrateBookingPhotos(booking: LogisticsBooking): Promise<LogisticsBooking> {
  const paths: string[] = [];
  for (const box of booking.boxes) {
    for (const photo of box.photos) {
      if (photo.storagePath) paths.push(photo.storagePath);
    }
  }
  if (booking.finalPackagePhotoStoragePath) {
    paths.push(booking.finalPackagePhotoStoragePath);
  }

  const urls = await resolveLogisticsPhotoUrls(paths);

  const boxes = booking.boxes.map(box => ({
    ...box,
    photos: box.photos.map(photo => ({
      ...photo,
      url: photo.storagePath ? (urls.get(photo.storagePath) ?? null) : null,
    })),
  }));
  const finalPhotoUrl = booking.finalPackagePhotoStoragePath
    ? (urls.get(booking.finalPackagePhotoStoragePath) ?? null)
    : null;
  return {
    ...booking,
    boxes,
    finalPackagePhoto: finalPhotoUrl,
  };
}

/** Resolve photo URLs for an already-mapped booking (no extra Firestore getDoc). */
export async function hydrateLogisticsBookingPhotos(
  booking: LogisticsBooking,
): Promise<LogisticsBooking> {
  return hydrateBookingPhotos(booking);
}

export function mapLogisticsBookingDoc(id: string, data: DocumentData): LogisticsBooking {
  const dealer = (data.dealerSnapshot ?? {}) as LogisticsDealerSnapshot;
  const partnerId = isLogisticsPartnerId(String(data.partnerId ?? ''))
    ? String(data.partnerId) as LogisticsPartnerId
    : 'st_courier';
  const status = normalizeBookingStatus(String(data.status ?? 'label_generated'));
  const shipmentMode = data.shipmentMode === 'envelope' ? 'envelope' : 'box';
  const boxes = Array.isArray(data.boxes)
    ? data.boxes.map((box: DocumentData) => mapShipmentBox(box))
    : [];
  const numberOfBoxes = boxes.length || Number(data.numberOfBoxes) || 1;
  const actualWeightKg = boxes.length
    ? boxes.reduce((total, box) => total + box.weightKg, 0)
    : Number(data.actualWeightKg) || 0;
  const volumetricWeightKg = boxes.length
    ? boxes.reduce((total, box) => total + box.volumetricWeightKg, 0)
    : Number(data.volumetricWeightKg) || 0;
  const chargeableWeightKg = typeof data.chargeableWeightKg === 'number'
    ? data.chargeableWeightKg
    : boxes.length
      ? boxes.reduce((total, box) => total + Math.max(box.weightKg || 0, box.volumetricWeightKg || 0), 0)
      : Math.max(actualWeightKg, volumetricWeightKg);
  const courierTrack = mapCourierTrack(data.courierTrack);
  const courierFreight = mapCourierFreight(data.courierFreight);
  const courierDeliveryOffice = mapCourierDeliveryOffice(data.courierDeliveryOffice);
  const invoiceId = typeof data.invoiceId === 'string' ? data.invoiceId : null;
  const invoiceNumber = typeof data.invoiceNumber === 'string' ? data.invoiceNumber : null;
  const invoiceValueInr = typeof data.invoiceValueInr === 'number' && Number.isFinite(data.invoiceValueInr)
    ? data.invoiceValueInr
    : null;
  const invoices = mapBookingInvoices(data.invoices, {
    invoiceId,
    invoiceNumber,
    invoiceValueInr,
  });
  const invoiceIds = bookingInvoiceIdsFromDoc(data, invoices, invoiceId);

  return {
    id,
    orderRef: String(data.orderRef ?? ''),
    source: (data.source === 'invoice' || data.source === 'support') ? data.source : 'manual',
    invoiceId,
    invoiceNumber,
    invoiceIds,
    invoices,
    invoiceValueInr,
    supportRequestId: typeof data.supportRequestId === 'string' ? data.supportRequestId : null,
    supportRequestNumber: typeof data.supportRequestNumber === 'string' ? data.supportRequestNumber : null,
    complaintLogs: mapComplaintLogs(data.complaintLogs),
    complaintResolvedAt: typeof data.complaintResolvedAt === 'string' && data.complaintResolvedAt.trim()
      ? data.complaintResolvedAt.trim()
      : null,
    partnerId,
    consignmentNo: String(data.consignmentNo ?? ''),
    trackingNo: String(data.trackingNo ?? data.consignmentNo ?? ''),
    masterAwb: typeof data.masterAwb === 'string' && data.masterAwb.trim()
      ? data.masterAwb.trim()
      : (typeof data.courierTrack?.masterAwb === 'string' && data.courierTrack.masterAwb.trim()
        ? String(data.courierTrack.masterAwb).trim()
        : null),
    branch: String(data.branch ?? ''),
    serviceType: String(data.serviceType ?? ''),
    bookingDate: String(data.bookingDate ?? ''),
    dealer,
    deliveryAddressKind: data.deliveryAddressKind === 'billing' ? 'billing' : 'shipping',
    deliveryAddress: (() => {
      const kind = data.deliveryAddressKind === 'billing' ? 'billing' : 'shipping';
      const stored = String(data.deliveryAddress ?? '').trim();
      if (!isPlaceholderLogisticsAddress(stored)) return stored;
      return resolveDeliveryAddress(dealer, kind);
    })(),
    shipFromSite: isStaffLogisticsSite(data.shipFromSite) ? data.shipFromSite : 'cochin',
    shipFromAddress: String(data.shipFromAddress ?? ''),
    shipmentMode,
    boxes,
    numberOfBoxes,
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    finalPackagePhoto: null,
    finalPackagePhotoStoragePath: typeof data.finalPackagePhotoStoragePath === 'string'
      ? data.finalPackagePhotoStoragePath
      : null,
    labelGenerated: Boolean(data.shippingLabelGenerated ?? data.labelGenerated),
    courierSlipGenerated: Boolean(data.courierSlipGenerated),
    shippingLabelGenerated: Boolean(data.shippingLabelGenerated ?? data.labelGenerated),
    packingSlipGenerated: Boolean(data.packingSlipGenerated),
    status,
    wizardStep: typeof data.wizardStep === 'string' ? data.wizardStep : null,
    courierTrack,
    trackFetchedAt: typeof data.trackFetchedAt === 'string'
      ? data.trackFetchedAt
      : (courierTrack?.fetchedAt || null),
    courierFreight,
    actualFreightInr: typeof data.actualFreightInr === 'number' && Number.isFinite(data.actualFreightInr)
      ? data.actualFreightInr
      : (courierFreight?.totalInr ?? null),
    freightFetchedAt: typeof data.freightFetchedAt === 'string'
      ? data.freightFetchedAt
      : (courierFreight?.fetchedAt || null),
    freightBillingMode: mapFreightBillingMode(data.freightBillingMode)
      ?? courierFreight?.billingMode
      ?? null,
    freightBillingModeSource: (
      data.freightBillingModeSource === 'booking'
      || data.freightBillingModeSource === 'api'
      || data.freightBillingModeSource === 'inferred'
      || data.freightBillingModeSource === 'manual'
        ? data.freightBillingModeSource
        : null
    ),
    delhiveryPickup: mapDelhiveryPickup(data.delhiveryPickup),
    blueDartPickup: mapBlueDartPickup(data.blueDartPickup),
    delhiveryEwaySync: mapDelhiveryEwaySync(data.delhiveryEwaySync),
    delhiveryDocuments: mapDelhiveryDocuments(data.delhiveryDocuments),
    blueDartDocuments: mapBlueDartDocuments(data.blueDartDocuments),
    ewayBillNumber: typeof data.ewayBillNumber === 'string' ? data.ewayBillNumber : null,
    ewayBillStatus: typeof data.ewayBillStatus === 'string' ? data.ewayBillStatus : null,
    freightDiffSettledAt: typeof data.freightDiffSettledAt === 'string'
      ? data.freightDiffSettledAt
      : null,
    freightDiffSettledInvoiceId: typeof data.freightDiffSettledInvoiceId === 'string'
      ? data.freightDiffSettledInvoiceId
      : null,
    freightDiffSettledSalesOrderId: typeof data.freightDiffSettledSalesOrderId === 'string'
      ? data.freightDiffSettledSalesOrderId
      : null,
    courierDeliveryOffice,
    deliveredAt: typeof data.deliveredAt === 'string' ? data.deliveredAt : null,
    inTransitAt: typeof data.inTransitAt === 'string' ? data.inTransitAt : null,
    createdAt: String(data.createdAt ?? ''),
    updatedAt: String(data.updatedAt ?? data.createdAt ?? ''),
    createdByUid: String(data.createdByUid ?? ''),
    createdByName: String(data.createdByName ?? ''),
    dealerCustomerInvoice: parseDealerCustomerInvoice(data.dealerCustomerInvoice),
  };
}

function matchesClientFilters(booking: LogisticsBooking, filters: LogisticsBookingListFilters): boolean {
  if (filters.status && booking.status !== filters.status) return false;
  if (filters.partnerId && booking.partnerId !== filters.partnerId) return false;
  const q = filters.query?.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    booking.consignmentNo,
    booking.trackingNo,
    booking.orderRef,
    booking.dealer.name,
    booking.dealer.code,
    booking.invoiceNumber,
    ...(booking.invoices ?? []).map(row => row.invoiceNumber),
    booking.supportRequestNumber,
    logisticsPartnerLabel(booking.partnerId),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

async function uploadDraftBoxPhotos(
  bookingId: string,
  draft: LogisticsBookingDraft,
  existingFinalPackagePhotoStoragePath: string | null = null,
  existingBoxes: ShipmentBox[] = [],
): Promise<{
  boxes: ShipmentBox[];
  finalPackagePhotoStoragePath: string | null;
}> {
  const isEnvelope = draft.shipmentMode === 'envelope';
  const boxes = await Promise.all(draft.boxes.map(async (box, boxIndex) => {
    const existingBox = existingBoxes.find(item => item.id === box.id);
    const uploaded: Array<ShipmentBoxPhoto | null> = await Promise.all(box.photos.map(async (photo, photoIndex) => {
      if (photo.storagePath?.trim()) {
        return {
          storagePath: photo.storagePath.trim(),
          url: photo.url ?? null,
          clientPhotoId: photo.id,
        };
      }
      if (!photo.url || !photo.url.startsWith('data:')) {
        // Keep already-linked server photos when draft preview URL is https/empty.
        const existingById = existingBox?.photos.find(item => item.clientPhotoId === photo.id);
        if (existingById?.storagePath) {
          return {
            storagePath: existingById.storagePath,
            url: photo.url || existingById.url || null,
            clientPhotoId: photo.id,
          };
        }
        return null;
      }
      const file = await dataUrlToFile(photo.url, `box-${boxIndex + 1}-${photoIndex + 1}.jpg`);
      const storagePath = await uploadLogisticsPhoto(bookingId, `box-${box.id}-${photo.id}`, file);
      return {
        storagePath,
        url: photo.url,
        clientPhotoId: photo.id,
      };
    }));

    const photos: ShipmentBoxPhoto[] = uploaded.filter((photo): photo is ShipmentBoxPhoto => photo != null);
    // Never drop server photos that are missing from a stale local draft snapshot.
    for (const existingPhoto of existingBox?.photos ?? []) {
      if (!existingPhoto.storagePath) continue;
      if (photos.some(photo => photo.storagePath === existingPhoto.storagePath)) continue;
      photos.push({
        storagePath: existingPhoto.storagePath,
        url: existingPhoto.url ?? null,
        ...(existingPhoto.clientPhotoId ? { clientPhotoId: existingPhoto.clientPhotoId } : {}),
      });
    }

    const length = !isEnvelope && box.lengthCm ? Number.parseFloat(box.lengthCm) : null;
    const width = !isEnvelope && box.widthCm ? Number.parseFloat(box.widthCm) : null;
    const height = !isEnvelope && box.heightCm ? Number.parseFloat(box.heightCm) : null;
    return {
      id: box.id,
      lengthCm: length,
      widthCm: width,
      heightCm: height,
      weightKg: isEnvelope ? 0 : (Number.parseFloat(box.weightKg) || 0),
      volumetricWeightKg: isEnvelope
        ? 0
        : computeVolumetricWeight(length, width, height, draft.partnerId),
      photos,
    } satisfies ShipmentBox;
  }));

  let finalPackagePhotoStoragePath: string | null = existingFinalPackagePhotoStoragePath;
  if (draft.finalPackagePhoto?.startsWith('data:')) {
    const file = await dataUrlToFile(draft.finalPackagePhoto, 'final-package.jpg');
    finalPackagePhotoStoragePath = await uploadLogisticsPhoto(bookingId, 'final-package', file);
  }

  return { boxes, finalPackagePhotoStoragePath };
}

function firestoreStringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function dealerCustomerInvoiceForInvoiceId(invoiceId: string | null | undefined) {
  const id = String(invoiceId || '').trim();
  if (!id) return null;
  try {
    const snap = await getDocs(
      query(collection(db, 'salesOrders'), where('zohoInvoiceId', '==', id), limit(1)),
    );
    if (snap.empty) return null;
    return parseDealerCustomerInvoice(snap.docs[0].data()?.dealerCustomerInvoice);
  } catch {
    return null;
  }
}

async function buildBookingPayload(input: PersistLogisticsBookingInput & {
  bookingId: string;
  status: LogisticsBookingStatus;
  createdAt: string;
  existingFinalPackagePhotoStoragePath?: string | null;
  existingOrderRef?: string | null;
  /** Preserve on update — Firestore rules lock these for ops writes. */
  existingCreatedByUid?: string | null;
  existingCreatedByName?: string | null;
  existingDealerId?: string | null;
  existingZohoCustomerId?: string | null;
}): Promise<Record<string, unknown>> {
  const {
    draft,
    dealer,
    createdBy,
    bookingId,
    status,
    createdAt,
    wizardStep,
    existingFinalPackagePhotoStoragePath = null,
    existingOrderRef = null,
    existingCreatedByUid = null,
    existingCreatedByName = null,
    existingDealerId = null,
    existingZohoCustomerId = null,
  } = input;
  const settings = await loadLogisticsSettings();
  const shipFromSite = await resolvePersistShipFromSite(draft);
  const shipFromAddress = settings.fromAddresses[shipFromSite]?.trim() || '';
  const now = new Date().toISOString();
  const orderRef = existingOrderRef
    || draft.invoiceNumber
    || draft.supportRequestNumber
    || `ORD-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;

  const existingSnap = await getDoc(doc(db, COLLECTION, bookingId)).catch(() => null);
  const existingData = existingSnap?.exists() ? existingSnap.data() : null;
  const existingBoxes = existingData && Array.isArray(existingData.boxes)
    ? existingData.boxes.map((box: DocumentData) => mapShipmentBox(box))
    : [];
  const existingDeliveryOffice = mapCourierDeliveryOffice(existingData?.courierDeliveryOffice);

  const { boxes, finalPackagePhotoStoragePath } = await uploadDraftBoxPhotos(
    bookingId,
    draft,
    existingFinalPackagePhotoStoragePath,
    existingBoxes,
  );
  const actualWeightKg = boxes.reduce((total, box) => total + box.weightKg, 0);
  const volumetricWeightKg = boxes.reduce((total, box) => total + box.volumetricWeightKg, 0);
  const chargeableWeightKg = consignmentChargeableWeightKg(boxes, draft.partnerId);
  const createdByName = existingCreatedByName
    || createdBy.displayName?.trim()
    || createdBy.loginId?.trim()
    || createdBy.email?.trim()
    || 'YESWEIGH';
  const deliveryAddress = resolveDraftDeliveryAddress(dealer, draft);
  const courierDeliveryOffice = await resolveCourierDeliveryOfficeForPersist(
    draft.partnerId,
    deliveryAddress,
    existingDeliveryOffice,
  );
  const dealerCustomerInvoice = parseDealerCustomerInvoice(existingData?.dealerCustomerInvoice)
    || await dealerCustomerInvoiceForInvoiceId(draft.invoiceId);

  return {
    orderRef,
    source: draft.source,
    ...persistClubbedInvoiceFields(draft),
    supportRequestId: draft.supportRequestId ?? null,
    supportRequestNumber: draft.supportRequestNumber ?? null,
    partnerId: draft.partnerId,
    consignmentNo: draft.consignmentNo.trim(),
    trackingNo: (
      (draft.partnerId === 'delhivery' && draft.masterAwb?.trim())
        ? draft.masterAwb.trim()
        : draft.consignmentNo.trim()
    ),
    ...(draft.partnerId === 'delhivery' && draft.masterAwb?.trim()
      ? { masterAwb: draft.masterAwb.trim() }
      : (draft.partnerId === 'delhivery' && typeof existingData?.masterAwb === 'string' && existingData.masterAwb.trim()
        ? { masterAwb: existingData.masterAwb.trim() }
        : {})),
    branch: draft.branch.trim(),
    serviceType: draft.serviceType.trim(),
    bookingDate: draft.bookingDate || new Date().toISOString().slice(0, 10),
    // Top-level dealer keys are immutable in Firestore update rules — keep the stored values.
    zohoCustomerId: existingZohoCustomerId || draft.zohoCustomerId,
    dealerId: existingDealerId || draft.dealerId,
    dealerSnapshot: {
      zohoCustomerId: dealer.zohoCustomerId,
      dealerId: dealer.dealerId,
      name: dealer.name,
      code: dealer.code,
      contactPerson: dealer.contactPerson,
      mobile: dealer.mobile,
      shippingAddress: dealer.shippingAddress,
      billingAddress: dealer.billingAddress,
      ...(dealer.destinationCity?.trim()
        ? { destinationCity: dealer.destinationCity.trim() }
        : {}),
    },
    deliveryAddressKind: draft.deliveryAddressKind,
    deliveryAddress,
    shipFromSite,
    shipFromAddress,
    shipmentMode: draft.shipmentMode,
    numberOfBoxes: Math.max(boxes.length, 1),
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    boxes: boxes.map(box => ({
      id: box.id,
      lengthCm: box.lengthCm,
      widthCm: box.widthCm,
      heightCm: box.heightCm,
      weightKg: box.weightKg,
      volumetricWeightKg: box.volumetricWeightKg,
      photos: firestoreBoxPhotos(box.photos),
    })),
    finalPackagePhotoStoragePath: finalPackagePhotoStoragePath ?? null,
    labelGenerated: isApiBookedLogisticsPartner(draft.partnerId)
      ? Boolean(draft.consignmentNo.trim())
      : Boolean(draft.labelGenerated),
    courierSlipGenerated: isApiBookedLogisticsPartner(draft.partnerId)
      ? false
      : Boolean(draft.labelGenerated),
    shippingLabelGenerated: isApiBookedLogisticsPartner(draft.partnerId)
      ? false
      : Boolean(draft.labelGenerated),
    packingSlipGenerated: false,
    status,
    wizardStep: wizardStep ?? null,
    ...(courierDeliveryOffice ? { courierDeliveryOffice } : {}),
    // Delhivery: capture FOD/BTC at booking (default BTC). Sync may infer later if unset.
    ...(draft.partnerId === 'delhivery'
      ? (() => {
        const pickup = draft.delhiveryPickup || mapDelhiveryPickup(existingData?.delhiveryPickup);
        const ewaySync = mapDelhiveryEwaySync(existingData?.delhiveryEwaySync);
        return {
          freightBillingMode: (
            draft.freightBillingMode === 'fod' || draft.freightBillingMode === 'btc'
              ? draft.freightBillingMode
              : 'btc'
          ),
          freightBillingModeSource: 'booking' as const,
          ...(pickup ? { delhiveryPickup: pickup } : {}),
          ...(ewaySync ? { delhiveryEwaySync: ewaySync } : {}),
        };
      })()
      : {}),
    ...(draft.blueDartDocuments?.awb
      ? { blueDartDocuments: draft.blueDartDocuments }
      : (mapBlueDartDocuments(existingData?.blueDartDocuments)
        ? { blueDartDocuments: mapBlueDartDocuments(existingData?.blueDartDocuments) }
        : {})),
    ...(isBlueDartLogisticsPartnerId(draft.partnerId)
      ? (() => {
        const pickup = draft.blueDartPickup || mapBlueDartPickup(existingData?.blueDartPickup);
        return pickup ? { blueDartPickup: pickup } : {};
      })()
      : {}),
    ...(mapComplaintLogs(existingData?.complaintLogs).length
      ? { complaintLogs: mapComplaintLogs(existingData?.complaintLogs) }
      : {}),
    ...(typeof existingData?.complaintResolvedAt === 'string' && existingData.complaintResolvedAt.trim()
      ? { complaintResolvedAt: existingData.complaintResolvedAt.trim() }
      : {}),
    ...(dealerCustomerInvoice ? { dealerCustomerInvoice } : {}),
    createdAt,
    updatedAt: now,
    createdByUid: existingCreatedByUid || createdBy.uid,
    createdByName,
  };
}

function firestoreBoxPhotos(photos: ShipmentBoxPhoto[]): Array<{
  storagePath: string;
  clientPhotoId?: string;
}> {
  return photos
    .filter(photo => Boolean(photo.storagePath?.trim()))
    .map(photo => ({
      storagePath: photo.storagePath.trim(),
      ...(photo.clientPhotoId?.trim() ? { clientPhotoId: photo.clientPhotoId.trim() } : {}),
    }));
}

function formatLogisticsPersistError(err: unknown, fallback: string): Error {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const code = typeof err === 'object' && err && 'code' in err
    ? String((err as { code?: string }).code ?? '')
    : '';
  if (code.includes('permission-denied') || /permission/i.test(message)) {
    return new Error(
      'Could not save logistics booking (permission denied). Deploy the latest Firestore rules for logistics bookings.',
    );
  }
  if (/unsupported field value|undefined/i.test(message)) {
    return new Error('Could not save logistics booking because some fields were empty. Try again.');
  }
  return err instanceof Error ? err : new Error(fallback);
}

/** Build box records for a draft without uploading new data-URL photos. */
function boxesWithoutNewUploads(draft: LogisticsBookingDraft): ShipmentBox[] {
  const isEnvelope = draft.shipmentMode === 'envelope';
  return draft.boxes.map(box => {
    const length = !isEnvelope && box.lengthCm ? Number.parseFloat(box.lengthCm) : null;
    const width = !isEnvelope && box.widthCm ? Number.parseFloat(box.widthCm) : null;
    const height = !isEnvelope && box.heightCm ? Number.parseFloat(box.heightCm) : null;
    return {
      id: box.id,
      lengthCm: length,
      widthCm: width,
      heightCm: height,
      weightKg: isEnvelope ? 0 : (Number.parseFloat(box.weightKg) || 0),
      volumetricWeightKg: isEnvelope
        ? 0
        : computeVolumetricWeight(length, width, height, draft.partnerId),
      photos: box.photos
        .filter(photo => Boolean(photo.storagePath))
        .map(photo => ({ storagePath: photo.storagePath as string, url: photo.url ?? null })),
    };
  });
}

function draftHasPendingPhotoUploads(draft: LogisticsBookingDraft): boolean {
  const pendingBoxes = draft.boxes.some(box =>
    box.photos.some(photo => !photo.storagePath && Boolean(photo.url?.startsWith('data:'))),
  );
  const pendingFinal = Boolean(draft.finalPackagePhoto?.startsWith('data:'));
  return pendingBoxes || pendingFinal;
}

/**
 * Storage rules for logistics photos allow ops create without a booking doc,
 * but reads (and some environments) expect the booking to exist first.
 * Write a minimal draft stub before uploading new photos when creating.
 */
async function ensureDraftBookingStub(input: {
  bookingRef: ReturnType<typeof doc>;
  draft: LogisticsBookingDraft;
  dealer: LogisticsDealerSnapshot;
  createdBy: User;
  createdAt: string;
  existingOrderRef: string | null;
  existingCreatedByUid: string | null;
  existingCreatedByName: string | null;
  isNew: boolean;
}): Promise<void> {
  if (!input.isNew) return;
  const now = new Date().toISOString();
  const orderRef = input.existingOrderRef
    || input.draft.invoiceNumber
    || input.draft.supportRequestNumber
    || `ORD-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const createdByName = input.existingCreatedByName
    || input.createdBy.displayName?.trim()
    || input.createdBy.loginId?.trim()
    || input.createdBy.email?.trim()
    || 'YESWEIGH';
  await setDoc(input.bookingRef, {
    orderRef,
    source: input.draft.source,
    ...persistClubbedInvoiceFields(input.draft),
    supportRequestId: input.draft.supportRequestId ?? null,
    supportRequestNumber: input.draft.supportRequestNumber ?? null,
    partnerId: input.draft.partnerId,
    consignmentNo: input.draft.consignmentNo.trim(),
    trackingNo: input.draft.consignmentNo.trim(),
    branch: input.draft.branch.trim(),
    serviceType: input.draft.serviceType.trim(),
    bookingDate: input.draft.bookingDate || now.slice(0, 10),
    zohoCustomerId: input.draft.zohoCustomerId,
    dealerId: input.draft.dealerId,
    dealerSnapshot: {
      zohoCustomerId: input.dealer.zohoCustomerId,
      dealerId: input.dealer.dealerId,
      name: input.dealer.name,
      code: input.dealer.code,
      contactPerson: input.dealer.contactPerson,
      mobile: input.dealer.mobile,
      shippingAddress: input.dealer.shippingAddress,
      billingAddress: input.dealer.billingAddress,
      ...(input.dealer.destinationCity?.trim()
        ? { destinationCity: input.dealer.destinationCity.trim() }
        : {}),
    },
    deliveryAddressKind: input.draft.deliveryAddressKind,
    deliveryAddress: resolveDraftDeliveryAddress(input.dealer, input.draft),
    shipFromSite: input.draft.shipFromSite,
    shipFromAddress: '',
    shipmentMode: input.draft.shipmentMode,
    numberOfBoxes: Math.max(input.draft.boxes.length, 1),
    actualWeightKg: 0,
    volumetricWeightKg: 0,
    chargeableWeightKg: 0,
    boxes: input.draft.boxes.map(box => ({
      id: box.id,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      weightKg: 0,
      volumetricWeightKg: 0,
      // Keep already-uploaded paths — never wipe with [] on stub create/merge.
      photos: firestoreBoxPhotos(
        box.photos
          .filter(photo => Boolean(photo.storagePath?.trim()))
          .map(photo => ({
            storagePath: photo.storagePath as string,
            clientPhotoId: photo.id,
            url: photo.url ?? null,
          })),
      ),
    })),
    finalPackagePhotoStoragePath: null,
    labelGenerated: false,
    courierSlipGenerated: false,
    shippingLabelGenerated: false,
    packingSlipGenerated: false,
    status: 'label_generated',
    wizardStep: 'box',
    createdAt: input.createdAt,
    updatedAt: now,
    createdByUid: input.existingCreatedByUid || input.createdBy.uid,
    createdByName,
  }, { merge: true });
}

/**
 * Immediately link one uploaded box photo onto the booking document.
 * Used right after capture so the inside photo is tied to the logistics
 * booking id even if the user leaves before the next full draft save.
 */
export async function attachLogisticsBoxPhoto(input: {
  bookingId: string;
  boxId: string;
  storagePath: string;
  clientPhotoId: string;
}): Promise<void> {
  const bookingId = input.bookingId.trim();
  const boxId = input.boxId.trim();
  const storagePath = input.storagePath.trim();
  const clientPhotoId = input.clientPhotoId.trim();
  if (!bookingId || !boxId || !storagePath) return;

  const bookingRef = doc(db, COLLECTION, bookingId);
  const snap = await getDoc(bookingRef);
  if (!snap.exists()) return;
  const data = snap.data() ?? {};
  const boxes = Array.isArray(data.boxes) ? [...data.boxes] : [];
  let found = false;
  const nextBoxes = boxes.map((raw: DocumentData) => {
    if (String(raw?.id ?? '') !== boxId) return raw;
    found = true;
    const photos = Array.isArray(raw.photos) ? [...raw.photos] : [];
    const already = photos.some((photo: DocumentData) => {
      const path = typeof photo?.storagePath === 'string' ? photo.storagePath : '';
      const id = typeof photo?.clientPhotoId === 'string' ? photo.clientPhotoId : '';
      return path === storagePath || (clientPhotoId && id === clientPhotoId);
    });
    if (already) {
      return {
        ...raw,
        photos: photos.map((photo: DocumentData) => {
          const id = typeof photo?.clientPhotoId === 'string' ? photo.clientPhotoId : '';
          if (clientPhotoId && id === clientPhotoId) {
            return { storagePath, clientPhotoId };
          }
          return photo;
        }),
      };
    }
    return {
      ...raw,
      photos: [...photos, { storagePath, clientPhotoId }],
    };
  });
  if (!found) {
    nextBoxes.push({
      id: boxId,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      weightKg: 0,
      volumetricWeightKg: 0,
      photos: [{ storagePath, clientPhotoId }],
    });
  }
  await updateDoc(bookingRef, {
    boxes: nextBoxes,
    updatedAt: new Date().toISOString(),
  });
}

export async function attachLogisticsFinalPackagePhoto(input: {
  bookingId: string;
  storagePath: string;
}): Promise<void> {
  const bookingId = input.bookingId.trim();
  const storagePath = input.storagePath.trim();
  if (!bookingId || !storagePath) return;
  await updateDoc(doc(db, COLLECTION, bookingId), {
    finalPackagePhotoStoragePath: storagePath,
    updatedAt: new Date().toISOString(),
  });
}

export async function persistLogisticsBookingDraft(
  input: PersistLogisticsBookingInput,
): Promise<LogisticsBooking> {
  const { draft, dealer, createdBy, existingBookingId, wizardStep } = input;
  if (!draft.zohoCustomerId.trim()) throw new Error('Select a dealer before saving a draft.');

  const now = new Date().toISOString();
  const isNew = !existingBookingId;
  const bookingRef = existingBookingId
    ? doc(db, COLLECTION, existingBookingId)
    : doc(collection(db, COLLECTION));

  let createdAt = now;
  let existingFinalPackagePhotoStoragePath: string | null = null;
  let existingOrderRef: string | null = null;
  let existingCreatedByUid: string | null = null;
  let existingCreatedByName: string | null = null;
  let existingBoxes: ShipmentBox[] = [];
  let existingDeliveryOffice: LogisticsCourierDeliveryOffice | null = null;
  if (existingBookingId) {
    const existing = await getDoc(bookingRef);
    if (!existing.exists()) throw new Error('Draft booking not found.');
    const existingWizardStep = typeof existing.data()?.wizardStep === 'string'
      ? existing.data()?.wizardStep
      : null;
    // Any open wizard step (including final_photo after labels) can still be saved.
    if (!existingWizardStep?.trim()) {
      throw new Error('Only in-progress bookings can be updated this way.');
    }
    createdAt = String(existing.data()?.createdAt ?? now);
    existingFinalPackagePhotoStoragePath = typeof existing.data()?.finalPackagePhotoStoragePath === 'string'
      ? existing.data()?.finalPackagePhotoStoragePath
      : null;
    existingOrderRef = typeof existing.data()?.orderRef === 'string'
      ? existing.data()?.orderRef
      : null;
    existingCreatedByUid = typeof existing.data()?.createdByUid === 'string'
      ? existing.data()?.createdByUid
      : null;
    existingCreatedByName = typeof existing.data()?.createdByName === 'string'
      ? existing.data()?.createdByName
      : null;
    existingBoxes = Array.isArray(existing.data()?.boxes)
      ? existing.data()!.boxes.map((box: DocumentData) => mapShipmentBox(box))
      : [];
    existingDeliveryOffice = mapCourierDeliveryOffice(existing.data()?.courierDeliveryOffice);
  }

  try {
    if (draftHasPendingPhotoUploads(draft)) {
      await ensureDraftBookingStub({
        bookingRef,
        draft,
        dealer,
        createdBy,
        createdAt,
        existingOrderRef,
        existingCreatedByUid,
        existingCreatedByName,
        isNew,
      });
    }

    let photoResult: {
      boxes: ShipmentBox[];
      finalPackagePhotoStoragePath: string | null;
    };
    let photoUploadWarning = '';
    try {
      photoResult = await uploadDraftBoxPhotos(
        bookingRef.id,
        draft,
        existingFinalPackagePhotoStoragePath,
        existingBoxes,
      );
    } catch (photoErr) {
      // Never wipe newly captured data-URL photos by saving an empty photo list.
      if (draftHasPendingPhotoUploads(draft)) {
        throw photoErr instanceof Error
          ? photoErr
          : new Error('Could not upload package photos. Try again.');
      }
      photoUploadWarning = photoErr instanceof Error
        ? photoErr.message
        : 'Some photos could not be uploaded.';
      // Prefer already-stored photos on the draft, else keep whatever was on the server.
      const fallbackBoxes = boxesWithoutNewUploads(draft);
      photoResult = {
        boxes: fallbackBoxes.map(box => {
          if (box.photos.length) return box;
          const existing = existingBoxes.find(item => item.id === box.id);
          return existing ? { ...box, photos: existing.photos } : box;
        }),
        finalPackagePhotoStoragePath: existingFinalPackagePhotoStoragePath,
      };
    }

    const settings = await loadLogisticsSettings();
    const shipFromSite = await resolvePersistShipFromSite(draft);
    const shipFromAddress = settings.fromAddresses[shipFromSite]?.trim() || '';
    const orderRef = existingOrderRef
      || draft.invoiceNumber
      || draft.supportRequestNumber
      || `ORD-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const { boxes, finalPackagePhotoStoragePath } = photoResult;
    const actualWeightKg = boxes.reduce((total, box) => total + box.weightKg, 0);
    const volumetricWeightKg = boxes.reduce((total, box) => total + box.volumetricWeightKg, 0);
    const chargeableWeightKg = consignmentChargeableWeightKg(boxes, draft.partnerId);
    const createdByName = existingCreatedByName
      || createdBy.displayName?.trim()
      || createdBy.loginId?.trim()
      || createdBy.email?.trim()
      || 'YESWEIGH';
    const labelsPrinted = Boolean(draft.labelGenerated);

    const photosReady = boxes.every(box => box.photos.length > 0);
    const storedWizardStep = (
      (wizardStep === 'review' || wizardStep === 'label' || wizardStep === 'final_photo')
      && !photosReady
    )
      ? 'box'
      : (wizardStep ?? 'box');

    const deliveryAddress = resolveDraftDeliveryAddress(dealer, draft);
    const courierDeliveryOffice = await resolveCourierDeliveryOfficeForPersist(
      draft.partnerId,
      deliveryAddress,
      existingDeliveryOffice,
    );

    const payload: Record<string, unknown> = {
      orderRef,
      source: draft.source,
      ...persistClubbedInvoiceFields(draft),
      supportRequestId: draft.supportRequestId ?? null,
      supportRequestNumber: draft.supportRequestNumber ?? null,
      partnerId: draft.partnerId,
      consignmentNo: draft.consignmentNo.trim(),
      trackingNo: draft.consignmentNo.trim(),
      branch: draft.branch.trim(),
      serviceType: draft.serviceType.trim(),
      bookingDate: draft.bookingDate || now.slice(0, 10),
      zohoCustomerId: draft.zohoCustomerId,
      dealerId: draft.dealerId,
      dealerSnapshot: {
        zohoCustomerId: dealer.zohoCustomerId,
        dealerId: dealer.dealerId,
        name: dealer.name,
        code: dealer.code,
        contactPerson: dealer.contactPerson,
        mobile: dealer.mobile,
        shippingAddress: dealer.shippingAddress,
        billingAddress: dealer.billingAddress,
        ...(dealer.destinationCity?.trim()
          ? { destinationCity: dealer.destinationCity.trim() }
          : {}),
      },
      deliveryAddressKind: draft.deliveryAddressKind,
      deliveryAddress,
      shipFromSite,
      shipFromAddress,
      shipmentMode: draft.shipmentMode,
      numberOfBoxes: Math.max(boxes.length, 1),
      actualWeightKg,
      volumetricWeightKg,
      chargeableWeightKg,
      boxes: boxes.map(box => ({
        id: box.id,
        lengthCm: box.lengthCm,
        widthCm: box.widthCm,
        heightCm: box.heightCm,
        weightKg: box.weightKg,
        volumetricWeightKg: box.volumetricWeightKg,
        photos: firestoreBoxPhotos(box.photos),
      })),
      finalPackagePhotoStoragePath: finalPackagePhotoStoragePath ?? null,
      labelGenerated: labelsPrinted,
      courierSlipGenerated: labelsPrinted,
      shippingLabelGenerated: labelsPrinted,
      packingSlipGenerated: false,
      status: 'label_generated',
      wizardStep: storedWizardStep,
      ...(courierDeliveryOffice ? { courierDeliveryOffice } : {}),
      createdAt,
      updatedAt: now,
      createdByUid: existingCreatedByUid || createdBy.uid,
      createdByName,
    };

    await setDoc(bookingRef, payload);
    if (photoUploadWarning && typeof window !== 'undefined') {
      window.setTimeout(() => {
        window.alert(`Draft saved, but photos need attention:\n${photoUploadWarning}`);
      }, 0);
    }
    const booking = mapLogisticsBookingDoc(bookingRef.id, payload);
    return hydrateBookingPhotos(booking);
  } catch (err) {
    throw formatLogisticsPersistError(err, 'Could not save draft.');
  }
}

export async function persistLogisticsBooking(
  input: PersistLogisticsBookingInput,
): Promise<LogisticsBooking> {
  const { draft, dealer, createdBy, existingBookingId } = input;
  if (!draft.consignmentNo.trim()) throw new Error('Consignment number is required.');
  if (!draft.zohoCustomerId.trim()) throw new Error('Select a dealer.');
  if (!draft.boxes.length) throw new Error('Add at least one box.');
  if (draft.boxes.some(box => box.photos.length === 0)) {
    throw new Error('Each box needs at least the inside photo.');
  }

  const clubbed = persistClubbedInvoiceFields(draft);
  await Promise.all(clubbed.invoiceIds.map(async invoiceId => {
    const already = await findLogisticsBookingForInvoice(invoiceId);
    if (!already) return;
    if (already.status === 'cancelled' || already.status === 'returned') return;
    if (existingBookingId && already.id === existingBookingId) return;
    throw new Error(
      `Invoice ${already.invoiceNumber || invoiceId} already has a logistics booking.`,
    );
  }));

  const now = new Date().toISOString();
  const bookingRef = existingBookingId
    ? doc(db, COLLECTION, existingBookingId)
    : doc(collection(db, COLLECTION));

  let createdAt = now;
  let existingFinalPackagePhotoStoragePath: string | null = null;
  let existingOrderRef: string | null = null;
  let existingCreatedByUid: string | null = null;
  let existingCreatedByName: string | null = null;
  let existingDealerId: string | null = null;
  let existingZohoCustomerId: string | null = null;
  if (existingBookingId) {
    const existing = await getDoc(bookingRef);
    if (!existing.exists()) throw new Error('Booking not found.');
    const data = existing.data() ?? {};
    createdAt = firestoreStringField(data.createdAt) || now;
    existingFinalPackagePhotoStoragePath = firestoreStringField(data.finalPackagePhotoStoragePath);
    existingOrderRef = firestoreStringField(data.orderRef);
    existingCreatedByUid = firestoreStringField(data.createdByUid);
    existingCreatedByName = firestoreStringField(data.createdByName);
    existingDealerId = firestoreStringField(data.dealerId);
    existingZohoCustomerId = firestoreStringField(data.zohoCustomerId);
  }

  try {
    const labelsPrinted = isApiBookedLogisticsPartner(draft.partnerId)
      ? Boolean(draft.consignmentNo.trim())
      : Boolean(draft.labelGenerated);
    if (!labelsPrinted) {
      throw new Error(
        draft.partnerId === 'delhivery'
          ? 'Create the Delhivery LR before confirming the shipment.'
          : isApiBookedLogisticsPartner(draft.partnerId)
            ? 'Create the Blue Dart AWB before confirming the shipment.'
            : 'Generate the shipping label before confirming the shipment.',
      );
    }
    const payload = await buildBookingPayload({
      draft,
      dealer,
      createdBy,
      bookingId: bookingRef.id,
      status: 'label_generated',
      createdAt,
      wizardStep: null,
      existingFinalPackagePhotoStoragePath,
      existingOrderRef,
      existingCreatedByUid,
      existingCreatedByName,
      existingDealerId,
      existingZohoCustomerId,
    });

    await setDoc(bookingRef, payload);
    const booking = mapLogisticsBookingDoc(bookingRef.id, payload);
    await tryRefreshLogisticsBookingTrack(booking);
    const refreshed = await fetchLogisticsBooking(booking.id);
    const result = await hydrateBookingPhotos(refreshed || booking);
    maybeScheduleDelhiveryDocumentsPrefetch(result);
    return result;
  } catch (err) {
    throw formatLogisticsPersistError(err, 'Could not save shipment.');
  }
}

/** Convert a saved booking (usually a draft) into wizard draft + step for resume. */
export function bookingToWizardState(booking: LogisticsBooking): {
  draft: LogisticsBookingDraft;
  step: string;
  dealerQuery: string;
} {
  const step = typeof booking.wizardStep === 'string' && booking.wizardStep
    ? booking.wizardStep
    : 'box';
  return {
    dealerQuery: booking.dealer.name || booking.dealer.code || '',
    step,
    draft: {
      partnerId: booking.partnerId,
      source: booking.source,
      invoiceId: booking.invoiceId,
      invoiceNumber: booking.invoiceNumber,
      clubbedInvoices: booking.invoices?.length ? booking.invoices : undefined,
      invoiceValueInr: booking.invoiceValueInr ?? null,
      supportRequestId: booking.supportRequestId,
      supportRequestNumber: booking.supportRequestNumber,
      barcodeRaw: booking.consignmentNo,
      consignmentNo: booking.consignmentNo,
      branch: booking.branch,
      serviceType: booking.serviceType,
      bookingDate: booking.bookingDate,
      zohoCustomerId: booking.dealer.zohoCustomerId || '',
      dealerId: booking.dealer.dealerId || '',
      deliveryAddressKind: booking.deliveryAddressKind,
      deliveryAddress: booking.deliveryAddress || null,
      shipFromSite: booking.shipFromSite,
      shipmentMode: booking.shipmentMode,
      boxes: booking.boxes.map(box => ({
        id: box.id,
        lengthCm: box.lengthCm == null ? '' : String(box.lengthCm),
        widthCm: box.widthCm == null ? '' : String(box.widthCm),
        heightCm: box.heightCm == null ? '' : String(box.heightCm),
        weightKg: box.weightKg ? String(box.weightKg) : '',
        photos: box.photos
          .filter(photo => Boolean(photo.storagePath || photo.url))
          .map((photo, index) => ({
            id: photo.clientPhotoId?.trim() || `saved-${box.id}-${index}`,
            url: photo.url || '',
            storagePath: photo.storagePath,
          })),
      })),
      finalPackagePhoto: booking.finalPackagePhoto,
      finalPackagePhotoStoragePath: booking.finalPackagePhotoStoragePath,
      labelGenerated: booking.labelGenerated,
      ...(booking.partnerId === 'delhivery'
        ? {
          freightBillingMode: booking.freightBillingMode === 'fod' ? 'fod' as const : 'btc' as const,
          ...(booking.masterAwb ? { masterAwb: booking.masterAwb } : {}),
          ...(booking.delhiveryPickup ? { delhiveryPickup: booking.delhiveryPickup } : {}),
        }
        : {}),
      ...(booking.blueDartDocuments ? { blueDartDocuments: booking.blueDartDocuments } : {}),
      ...(booking.blueDartPickup ? { blueDartPickup: booking.blueDartPickup } : {}),
    },
  };
}

/** If a draft was saved past Box without package photos, reopen on Box so Next works. */
export function clampWizardStepForDraftPhotos(
  step: BookCourierStep,
  boxes: ReadonlyArray<Pick<ShipmentBoxDraft, 'photos'>>,
): BookCourierStep {
  if (draftBoxesHaveRequiredPhotos(boxes)) return step;
  if (step === 'review' || step === 'label' || step === 'final_photo') return 'box';
  return step;
}

export async function fetchLogisticsBooking(id: string): Promise<LogisticsBooking | null> {
  const snap = await getDoc(doc(db, COLLECTION, id));
  if (!snap.exists()) return null;
  const booking = mapLogisticsBookingDoc(snap.id, snap.data());
  return hydrateBookingPhotos(booking);
}

function rankLogisticsBookingsForInvoice(
  bookings: LogisticsBooking[],
): LogisticsBooking | null {
  if (!bookings.length) return null;
  const ranked = [...bookings].sort((a, b) => {
    const aClosed = a.status === 'returned' || a.status === 'cancelled' ? 1 : 0;
    const bClosed = b.status === 'returned' || b.status === 'cancelled' ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;
    return compareLogisticsBookingsByBookingDateDesc(a, b);
  });
  return ranked[0] ?? null;
}

/** Latest logistics booking linked to an invoice (prefer active over cancelled/returned). */
export async function findLogisticsBookingForInvoice(
  invoiceId: string,
): Promise<LogisticsBooking | null> {
  const id = invoiceId.trim();
  if (!id) return null;
  const [primarySnap, clubbedSnap] = await Promise.all([
    getDocs(query(collection(db, COLLECTION), where('invoiceId', '==', id), limit(10))),
    getDocs(query(collection(db, COLLECTION), where('invoiceIds', 'array-contains', id), limit(10))),
  ]);
  const byId = new Map<string, LogisticsBooking>();
  for (const snap of [primarySnap, clubbedSnap]) {
    for (const docSnap of snap.docs) {
      byId.set(docSnap.id, mapLogisticsBookingDoc(docSnap.id, docSnap.data()));
    }
  }
  return rankLogisticsBookingsForInvoice([...byId.values()]);
}

const INVOICE_LOGISTICS_IN_CHUNK = 10;

function addBookingToInvoiceMap(
  grouped: Map<string, LogisticsBooking[]>,
  booking: LogisticsBooking,
) {
  const ids = [
    ...(booking.invoiceIds ?? []),
    ...(booking.invoices ?? []).map(row => row.invoiceId),
    booking.invoiceId,
  ];
  for (const invoiceId of [...new Set(ids.map(id => String(id || '').trim()).filter(Boolean))]) {
    const list = grouped.get(invoiceId);
    if (list) list.push(booking);
    else grouped.set(invoiceId, [booking]);
  }
}

/** Batch lookup of linked logistics bookings for invoice list rows. */
export async function findLogisticsBookingsForInvoices(
  invoiceIds: readonly string[],
): Promise<Map<string, LogisticsBooking>> {
  const ids = [...new Set(invoiceIds.map(id => String(id || '').trim()).filter(Boolean))];
  const byInvoice = new Map<string, LogisticsBooking>();
  if (!ids.length) return byInvoice;

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += INVOICE_LOGISTICS_IN_CHUNK) {
    chunks.push(ids.slice(i, i + INVOICE_LOGISTICS_IN_CHUNK));
  }

  const snaps = await Promise.all([
    ...chunks.map(chunk =>
      getDocs(query(collection(db, COLLECTION), where('invoiceId', 'in', chunk))),
    ),
    ...chunks.map(chunk =>
      getDocs(query(collection(db, COLLECTION), where('invoiceIds', 'array-contains-any', chunk))),
    ),
  ]);

  const grouped = new Map<string, LogisticsBooking[]>();
  for (const snap of snaps) {
    for (const docSnap of snap.docs) {
      addBookingToInvoiceMap(grouped, mapLogisticsBookingDoc(docSnap.id, docSnap.data()));
    }
  }

  for (const [invoiceId, list] of grouped) {
    const best = rankLogisticsBookingsForInvoice(list);
    if (best) byInvoice.set(invoiceId, best);
  }
  return byInvoice;
}

async function fetchDealerBookings(user: User): Promise<LogisticsBooking[]> {
  const dealerId = resolveDealerIdForUser(user);
  const queries = [
    query(
      collection(db, COLLECTION),
      where('dealerId', '==', dealerId),
      orderBy('bookingDate', 'desc'),
      limit(100),
    ),
  ];
  if (user.zohoCustomerId?.trim()) {
    queries.push(
      query(
        collection(db, COLLECTION),
        where('zohoCustomerId', '==', user.zohoCustomerId.trim()),
        orderBy('bookingDate', 'desc'),
        limit(100),
      ),
    );
  }

  const snaps = await Promise.all(queries.map(q => getDocs(q)));
  const byId = new Map<string, LogisticsBooking>();
  for (const snap of snaps) {
    for (const docSnap of snap.docs) {
      byId.set(docSnap.id, mapLogisticsBookingDoc(docSnap.id, docSnap.data()));
    }
  }
  return [...byId.values()].sort(compareLogisticsBookingsByBookingDateDesc);
}

/** True when a booking is for one of the given Zoho invoices. */
export function logisticsBookingMatchesInvoiceKeys(
  booking: Pick<LogisticsBooking, 'invoiceId' | 'invoiceIds' | 'invoices' | 'invoiceNumber'>,
  invoiceIds: Set<string>,
  invoiceNumbers: Set<string>,
): boolean {
  const ids = [
    booking.invoiceId,
    ...(booking.invoiceIds ?? []),
    ...(booking.invoices ?? []).map(row => row.invoiceId),
  ].map(id => String(id ?? '').trim()).filter(Boolean);
  if (ids.some(id => invoiceIds.has(id))) return true;

  const numbers = [
    booking.invoiceNumber,
    ...(booking.invoices ?? []).map(row => row.invoiceNumber),
  ].map(value => String(value ?? '').trim().toUpperCase()).filter(Boolean);
  return numbers.some(value => invoiceNumbers.has(value));
}

export async function listLogisticsBookings(
  user: User,
  filters: LogisticsBookingListFilters = {},
): Promise<LogisticsBooking[]> {
  const base = isInternalOpsUser(user)
    ? (await getDocs(query(collection(db, COLLECTION), orderBy('bookingDate', 'desc'), limit(250))))
      .docs.map(docSnap => mapLogisticsBookingDoc(docSnap.id, docSnap.data()))
    : await fetchDealerBookings(user);

  const filtered = base.filter(booking => matchesClientFilters(booking, filters));
  // List consumers do not need photo URLs; hydrate only in fetchLogisticsBooking / after persist.
  return [...filtered].sort(compareLogisticsBookingsByBookingDateDesc);
}

export function subscribeLogisticsBookings(
  user: User,
  onChange: (bookings: LogisticsBooking[]) => void,
  onError?: (error: Error) => void,
  filters: LogisticsBookingListFilters = {},
): Unsubscribe {
  if (!isInternalOpsUser(user)) {
    let active = true;
    const refresh = () => {
      void listLogisticsBookings(user, filters)
        .then(bookings => { if (active) onChange(bookings); })
        .catch(err => onError?.(err instanceof Error ? err : new Error('Could not load logistics bookings.')));
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }

  const q = query(collection(db, COLLECTION), orderBy('bookingDate', 'desc'), limit(250));

  return onSnapshot(q, async snapshot => {
    try {
      // List view does not render photos — skip hydration to avoid Storage read 403 spam.
      const bookings = snapshot.docs
        .map(docSnap => mapLogisticsBookingDoc(docSnap.id, docSnap.data()))
        .filter(booking => matchesClientFilters(booking, filters))
        .sort(compareLogisticsBookingsByBookingDateDesc);
      onChange(bookings);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Could not load logistics bookings.'));
    }
  }, err => {
    onError?.(err instanceof Error ? err : new Error('Could not load logistics bookings.'));
  });
}

export async function generateLogisticsDocument(
  booking: LogisticsBooking,
  document: LogisticsDocumentType,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to generate shipment documents.');
  }
  const updatedAt = new Date().toISOString();
  const status = statusForDocument(booking.status, document);
  const patch: Record<string, unknown> = { status, updatedAt };
  const next: LogisticsBooking = { ...booking, status, updatedAt };
  if (document === 'courier_slip') {
    patch.courierSlipGenerated = true;
    next.courierSlipGenerated = true;
  } else {
    patch.shippingLabelGenerated = true;
    patch.labelGenerated = true;
    next.shippingLabelGenerated = true;
    next.labelGenerated = true;
  }
  await updateDoc(doc(db, COLLECTION, booking.id), patch);
  return next;
}

export async function updateLogisticsBookingStatus(
  booking: LogisticsBooking,
  status: LogisticsBookingStatus,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update shipment status.');
  }
  const updatedAt = new Date().toISOString();
  await updateDoc(doc(db, COLLECTION, booking.id), { status, updatedAt });
  return { ...booking, status, updatedAt };
}

export async function resolveLogisticsComplaint(
  booking: LogisticsBooking,
  notes: string,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to resolve this complaint.');
  }
  const at = new Date().toISOString();
  const entry: LogisticsComplaintLog = {
    at,
    notes: notes.trim(),
    kind: 'resolved',
    byName: user.displayName?.trim() || user.loginId?.trim() || user.email?.trim() || 'Staff',
  };
  await updateDoc(doc(db, COLLECTION, booking.id), {
    complaintLogs: arrayUnion(entry),
    complaintResolvedAt: at,
    updatedAt: at,
  });
  return {
    ...booking,
    complaintLogs: [...(booking.complaintLogs || []), entry],
    complaintResolvedAt: at,
    updatedAt: at,
  };
}

/**
 * Mark Delhivery freight billing as FOD (consignee) or BTC (bill to client).
 * Used when Delhivery One is updated and the freight API does not yet return the mode.
 */
export async function updateLogisticsBookingFreightBillingMode(
  booking: LogisticsBooking,
  mode: import('../types/logistics-dispatch').LogisticsFreightBillingMode,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update freight billing mode.');
  }
  if (booking.partnerId !== 'delhivery') {
    throw new Error('Freight billing mode applies to Delhivery bookings only.');
  }
  if (mode !== 'fod' && mode !== 'btc') {
    throw new Error('Freight billing mode must be fod or btc.');
  }
  if (isDelhiveryFreightBillingModeLocked(booking)) {
    throw new Error('BTC/FOD is fixed from the invoice freight line and cannot be changed.');
  }
  const updatedAt = new Date().toISOString();
  const courierFreight = booking.courierFreight
    ? { ...booking.courierFreight, billingMode: mode }
    : null;
  const patch: Record<string, unknown> = {
    freightBillingMode: mode,
    freightBillingModeSource: 'manual',
    updatedAt,
  };
  if (courierFreight) patch.courierFreight = courierFreight;
  await updateDoc(doc(db, COLLECTION, booking.id), patch);
  return {
    ...booking,
    freightBillingMode: mode,
    freightBillingModeSource: 'manual',
    courierFreight,
    updatedAt,
  };
}

/**
 * Fill missing Delhivery LRN and/or Master AWB on an existing booking, then caller can Refresh.
 */
export async function updateLogisticsBookingDelhiveryIds(
  booking: LogisticsBooking,
  input: { lrn?: string | null; masterAwb?: string | null },
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update Delhivery IDs.');
  }
  if (booking.partnerId !== 'delhivery') {
    throw new Error('Only Delhivery bookings support LRN / Master AWB edits.');
  }

  const current = resolveDelhiveryBookingIds(booking);
  const lrnRaw = input.lrn != null ? String(input.lrn).trim() : null;
  const mwbRaw = input.masterAwb != null ? String(input.masterAwb).trim() : null;

  if (lrnRaw != null && lrnRaw && !isDelhiveryB2bLrn(lrnRaw)) {
    throw new Error('LRN must be a 9-digit Delhivery LR number.');
  }
  if (mwbRaw != null && mwbRaw && !isDelhiveryMasterAwb(mwbRaw)) {
    throw new Error('Master AWB looks invalid (expected a long waybill, e.g. 14 digits).');
  }

  const lrn = lrnRaw != null
    ? (normalizeDelhiveryId(lrnRaw) || null)
    : current.lrn;
  const masterAwb = mwbRaw != null
    ? (normalizeDelhiveryId(mwbRaw) || null)
    : current.masterAwb;

  if (!lrn && !masterAwb) {
    throw new Error('Enter an LRN or Master AWB.');
  }

  const consignmentNo = lrn || masterAwb || booking.consignmentNo;
  const trackingNo = masterAwb || lrn || booking.trackingNo;
  const updatedAt = new Date().toISOString();
  const patch: Record<string, unknown> = {
    consignmentNo,
    trackingNo,
    updatedAt,
  };
  if (masterAwb) patch.masterAwb = masterAwb;

  await updateDoc(doc(db, COLLECTION, booking.id), patch);
  const updated = {
    ...booking,
    consignmentNo,
    trackingNo,
    ...(masterAwb ? { masterAwb } : {}),
    updatedAt,
  };
  if (lrn) maybeScheduleDelhiveryDocumentsPrefetch(updated);
  return updated;
}

export async function updateLogisticsBookingDelhiveryPickup(
  booking: LogisticsBooking,
  pickup: import('../types/logistics-dispatch').LogisticsDelhiveryPickup,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update Delhivery pickup.');
  }
  if (booking.partnerId !== 'delhivery') {
    throw new Error('Only Delhivery bookings support pickup requests.');
  }
  const updatedAt = new Date().toISOString();
  await updateDoc(doc(db, COLLECTION, booking.id), {
    delhiveryPickup: pickup,
    updatedAt,
  });
  return { ...booking, delhiveryPickup: pickup, updatedAt };
}

export async function updateLogisticsBookingsDelhiveryPickup(
  bookings: readonly LogisticsBooking[],
  pickup: import('../types/logistics-dispatch').LogisticsDelhiveryPickup,
  user: User,
): Promise<LogisticsBooking[]> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update Delhivery pickup.');
  }
  const targets = bookings.filter(booking => booking.partnerId === 'delhivery');
  if (!targets.length) return [];
  const updatedAt = new Date().toISOString();
  for (let i = 0; i < targets.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = targets.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const booking of chunk) {
      batch.update(doc(db, COLLECTION, booking.id), {
        delhiveryPickup: pickup,
        updatedAt,
      });
    }
    await batch.commit();
  }
  return targets.map(booking => ({ ...booking, delhiveryPickup: pickup, updatedAt }));
}

export async function fetchLogisticsBookingsByPickupDate(
  date: string,
): Promise<LogisticsBooking[]> {
  const ymd = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return [];
  const [delhiverySnap, blueDartSnap] = await Promise.all([
    getDocs(query(
      collection(db, COLLECTION),
      where('delhiveryPickup.pickupDate', '==', ymd),
      limit(150),
    )),
    getDocs(query(
      collection(db, COLLECTION),
      where('blueDartPickup.pickupDate', '==', ymd),
      limit(150),
    )),
  ]);
  const byId = new Map<string, LogisticsBooking>();
  for (const snap of [...delhiverySnap.docs, ...blueDartSnap.docs]) {
    byId.set(snap.id, mapLogisticsBookingDoc(snap.id, snap.data()));
  }
  return [...byId.values()];
}

/** Correct ship-from site/address from logistics settings (e.g. match invoice branch). */
export async function updateLogisticsBookingShipFrom(
  booking: LogisticsBooking,
  site: StaffLogisticsSite,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update ship-from.');
  }
  if (!isStaffLogisticsSite(site)) {
    throw new Error('Invalid ship-from site.');
  }
  const settings = await loadLogisticsSettings();
  const shipFromAddress = settings.fromAddresses[site]?.trim() || '';
  const updatedAt = new Date().toISOString();
  await updateDoc(doc(db, COLLECTION, booking.id), {
    shipFromSite: site,
    shipFromAddress,
    updatedAt,
  });
  return {
    ...booking,
    shipFromSite: site,
    shipFromAddress,
    updatedAt,
  };
}

/**
 * Push Sites ship-from addresses onto every logistics booking for that site.
 * Skips docs that already match. Empty Sites values clear booking addresses.
 */
export async function syncLogisticsShipFromAddressesToAllBookings(
  fromAddresses: Record<StaffLogisticsSite, string>,
): Promise<{ updated: number; scanned: number }> {
  const updatedAt = new Date().toISOString();
  const snap = await getDocs(collection(db, COLLECTION));
  const pending: Array<{ id: string; shipFromSite: StaffLogisticsSite; shipFromAddress: string }> = [];

  for (const row of snap.docs) {
    const data = row.data();
    const shipFromSite = isStaffLogisticsSite(data.shipFromSite) ? data.shipFromSite : 'cochin';
    const shipFromAddress = fromAddresses[shipFromSite]?.trim() || '';
    const currentAddress = String(data.shipFromAddress ?? '').trim();
    const siteNeedsFix = !isStaffLogisticsSite(data.shipFromSite);
    if (!siteNeedsFix && currentAddress === shipFromAddress) continue;
    pending.push({ id: row.id, shipFromSite, shipFromAddress });
  }

  for (let i = 0; i < pending.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = pending.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const item of chunk) {
      batch.update(doc(db, COLLECTION, item.id), {
        shipFromSite: item.shipFromSite,
        shipFromAddress: item.shipFromAddress,
        updatedAt,
      });
    }
    await batch.commit();
  }

  return { updated: pending.length, scanned: snap.size };
}

/** Upload or replace the outer package (label-pasted) photo on any booking stage. */
export async function uploadLogisticsBookingFinalPackagePhoto(
  booking: LogisticsBooking,
  file: File,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to update shipment photos.');
  }
  const dataUrl = await logisticsCaptureToDataUrl(file);
  const stamped = await dataUrlToFile(dataUrl, 'final-package.jpg');
  const storagePath = await uploadLogisticsPhoto(booking.id, 'final-package', stamped);
  const updatedAt = new Date().toISOString();
  const previousPath = booking.finalPackagePhotoStoragePath?.trim() || null;
  await updateDoc(doc(db, COLLECTION, booking.id), {
    finalPackagePhotoStoragePath: storagePath,
    updatedAt,
  });
  if (previousPath && previousPath !== storagePath) {
    void deleteLogisticsPhoto(previousPath).catch(() => undefined);
  }
  return hydrateLogisticsBookingPhotos({
    ...booking,
    finalPackagePhotoStoragePath: storagePath,
    finalPackagePhoto: dataUrl,
    updatedAt,
  });
}

export async function cancelLogisticsBooking(
  booking: LogisticsBooking,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to cancel shipments.');
  }
  if (booking.status === 'delivered' || booking.status === 'returned') {
    throw new Error('Delivered or returned shipments cannot be cancelled.');
  }
  return updateLogisticsBookingStatus(booking, 'cancelled', user);
}

function serviceTypeForPartner(partnerId: LogisticsPartnerId): string {
  if (partnerId === 'trackon_air') return 'Air';
  if (partnerId === 'trackon_surface') return 'Surface';
  if (partnerId === 'bluedart_air') return 'Air';
  if (partnerId === 'bluedart_surface') return 'Surface';
  if (partnerId === 'bluedart_domestic') return 'Domestic Priority';
  return '';
}

/**
 * Switch a confirmed manual booking (ST / Trackon / DTDC / …) to another
 * non-API partner. Recalculates volumetric weight, clears the old carrier’s
 * track/slip, and stores the new AWB.
 */
export async function changeLogisticsBookingPartner(
  booking: LogisticsBooking,
  input: { partnerId: LogisticsPartnerId; consignmentNo: string },
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to change the courier.');
  }
  if (!canChangeLogisticsBookingPartner(booking)) {
    throw new Error(
      isApiBookedLogisticsPartner(booking.partnerId)
        ? 'Cancel the Delhivery / Blue Dart LR, then book the new courier.'
        : 'This shipment cannot change courier.',
    );
  }
  const nextPartnerId = input.partnerId;
  if (!CHANGEABLE_LOGISTICS_PARTNER_IDS.includes(nextPartnerId)) {
    throw new Error('That courier cannot be assigned on an existing booking.');
  }
  if (nextPartnerId === booking.partnerId) {
    throw new Error('Pick a different courier.');
  }
  const consignmentNo = input.consignmentNo.trim();
  if (!consignmentNo) {
    throw new Error('Enter the new courier AWB / consignment number.');
  }

  const boxes = booking.boxes.map(box => ({
    ...box,
    volumetricWeightKg: booking.shipmentMode === 'envelope'
      ? 0
      : computeVolumetricWeight(box.lengthCm, box.widthCm, box.heightCm, nextPartnerId),
  }));
  const actualWeightKg = boxes.reduce((total, box) => total + box.weightKg, 0);
  const volumetricWeightKg = boxes.reduce((total, box) => total + box.volumetricWeightKg, 0);
  const chargeableWeightKg = consignmentChargeableWeightKg(boxes, nextPartnerId);
  const serviceType = serviceTypeForPartner(nextPartnerId);
  const updatedAt = new Date().toISOString();
  const leavingSt = booking.partnerId === 'st_courier' && nextPartnerId !== 'st_courier';
  const courierDeliveryOffice = leavingSt
    ? null
    : (nextPartnerId === 'st_courier'
      ? await resolveCourierDeliveryOfficeForPersist(
        nextPartnerId,
        booking.deliveryAddress,
        booking.courierDeliveryOffice ?? null,
      )
      : (booking.courierDeliveryOffice ?? null));

  const patch: Record<string, unknown> = {
    partnerId: nextPartnerId,
    consignmentNo,
    trackingNo: consignmentNo,
    serviceType,
    boxes: boxes.map(box => ({
      id: box.id,
      lengthCm: box.lengthCm,
      widthCm: box.widthCm,
      heightCm: box.heightCm,
      weightKg: box.weightKg,
      volumetricWeightKg: box.volumetricWeightKg,
      photos: firestoreBoxPhotos(box.photos),
    })),
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    courierSlipGenerated: false,
    courierTrack: deleteField(),
    trackFetchedAt: deleteField(),
    courierFreight: deleteField(),
    actualFreightInr: deleteField(),
    freightFetchedAt: deleteField(),
    updatedAt,
  };
  if (courierDeliveryOffice) {
    patch.courierDeliveryOffice = courierDeliveryOffice;
  } else {
    patch.courierDeliveryOffice = deleteField();
  }

  await updateDoc(doc(db, COLLECTION, booking.id), patch);

  return {
    ...booking,
    partnerId: nextPartnerId,
    consignmentNo,
    trackingNo: consignmentNo,
    serviceType,
    boxes,
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    courierSlipGenerated: false,
    courierTrack: null,
    trackFetchedAt: null,
    courierFreight: null,
    actualFreightInr: null,
    freightFetchedAt: null,
    courierDeliveryOffice: courierDeliveryOffice ?? undefined,
    updatedAt,
  };
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

/**
 * Rebook a cancelled shipment on Blue Dart Domestic Priority using the
 * existing boxes (LBH + weight), invoice number/date, Head Office pickup,
 * and consignee pin from this booking.
 */
export async function rebookCancelledBookingViaBlueDartDomestic(
  booking: LogisticsBooking,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to book Blue Dart.');
  }
  if (!canRebookCancelledBookingViaBlueDart(booking)) {
    throw new Error('Only a cancelled shipment can be rebooked on Blue Dart Domestic Priority.');
  }
  if (!booking.boxes.length) {
    throw new Error('This booking has no boxes. Add box size and weight first.');
  }
  const missingDims = booking.boxes.some(box =>
    !(Number(box.lengthCm) > 0 && Number(box.widthCm) > 0 && Number(box.heightCm) > 0),
  );
  if (missingDims) {
    throw new Error('Each box needs length, breadth, and height (cm) before Blue Dart booking.');
  }

  const destPin = extractIndianPincode(booking.deliveryAddress)
    || extractIndianPincode(booking.dealer.shippingAddress)
    || extractIndianPincode(booking.dealer.billingAddress);
  if (!destPin || destPin.length !== 6) {
    throw new Error('Consignee pincode is missing on the delivery address.');
  }

  const consigneePhone = phoneDigitsForCourier(resolveReceiverPhoneFromSnapshot(booking.dealer))
    || phoneDigitsForCourier(booking.dealer.mobile)
    || phoneDigitsForCourier(extractPhoneFromText(booking.deliveryAddress));
  if (!consigneePhone) {
    throw new Error('Consignee phone is required before creating a Blue Dart AWB.');
  }

  const settings = await loadLogisticsSettings();
  const shipFromSite: StaffLogisticsSite = 'head_office';
  const fromAddress = (settings.fromAddresses[shipFromSite] ?? '').trim()
    || booking.shipFromAddress.trim();
  if (!fromAddress || isPlaceholderLogisticsAddress(fromAddress)) {
    throw new Error('Head Office ship-from address is missing. Set it in Logistics Settings → Sites.');
  }
  const siteContact = settings.fromSiteContacts[shipFromSite];
  const shipperPhone = phoneDigitsForCourier(siteContact?.phone) || phoneDigitsForCourier(FIRM_PHONE);
  if (!shipperPhone) {
    throw new Error('Ship-from phone is missing. Set it in Logistics Settings → Sites.');
  }
  const shipperGstin = String(siteContact?.gstin || FIRM_GSTIN).trim().toUpperCase() || undefined;
  const shipFromPin = blueDartPickupPinForSite(shipFromSite)
    || extractIndianPincode(fromAddress)
    || '';
  const deliveryPlace = cityStateFromAddress(booking.deliveryAddress);
  const shipFromPlace = cityStateFromAddress(fromAddress);
  const partnerId: LogisticsPartnerId = 'bluedart_domestic';
  const invoiceNumber = booking.invoiceNumber?.trim() || '';
  const invoiceValueInr = Number(booking.invoiceValueInr) > 0
    ? Number(booking.invoiceValueInr)
    : 0;
  const orderId = (
    invoiceNumber
    || booking.bookingDate?.trim()
    || `YW-${Date.now()}`
  );
  const boxes = booking.boxes.map(box => ({
    ...box,
    volumetricWeightKg: computeVolumetricWeight(
      box.lengthCm,
      box.widthCm,
      box.heightCm,
      partnerId,
    ),
  }));
  const boxesForApi = boxes.map(box => ({
    lengthCm: Number(box.lengthCm) || undefined,
    widthCm: Number(box.widthCm) || undefined,
    heightCm: Number(box.heightCm) || undefined,
    weightKg: (Number(box.weightKg) > 0 ? box.weightKg : box.volumetricWeightKg) || undefined,
    quantity: 1,
  }));

  let result: Awaited<ReturnType<typeof bookBlueDartShipment>> | null = null;
  try {
    result = await bookBlueDartShipment({
      partnerId,
      shipFromSite,
      orderId,
      consignee: {
        name: booking.dealer.name,
        phone: consigneePhone,
        address: booking.deliveryAddress,
        city: booking.dealer.destinationCity?.trim() || deliveryPlace.city,
        state: deliveryPlace.state,
        pincode: destPin,
      },
      returnAddress: {
        name: STAFF_LOGISTICS_SITE_LABELS[shipFromSite],
        phone: shipperPhone,
        address: fromAddress,
        city: shipFromPlace.city,
        state: shipFromPlace.state,
        pincode: shipFromPin,
      },
      boxes: boxesForApi,
      shipmentMode: booking.shipmentMode === 'envelope' ? 'envelope' : 'box',
      invoiceId: booking.invoiceId,
      zohoCustomerId: booking.dealer.zohoCustomerId,
      invoiceNumber: invoiceNumber || null,
      invoiceValueInr: invoiceValueInr || null,
      sellerGstin: shipperGstin,
      freightBillingMode: booking.freightBillingMode === 'fod' ? 'fod' : 'btc',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    const existing = parseBlueDartAlreadyGenerated(message);
    if (!existing) throw err;
    result = {
      ok: true,
      awb: existing.awb,
      pickupRegistered: false,
      pickupDate: null,
      pickupTime: null,
      pickupAddress: null,
      pickupPin: null,
      originArea: null,
      destinationArea: existing.destinationArea,
      destinationLocation: existing.destinationLocation,
      pickupToken: null,
      pickupMessage: 'Waybill already generated — continuing.',
      documents: null,
    };
  }

  if (!result) {
    throw new Error('Blue Dart did not return a booking result.');
  }

  const awb = String(result.awb || '').replace(/\D/g, '').trim();
  if (!awb) throw new Error('Blue Dart did not return an AWB.');

  const normalizedBoxes = boxes.map(box => ({
    ...box,
    weightKg: Number(box.weightKg) > 0 ? box.weightKg : box.volumetricWeightKg,
  }));
  const actualWeightKg = normalizedBoxes.reduce((total, b) => total + (Number(b.weightKg) || 0), 0);
  const volumetricWeightKg = normalizedBoxes.reduce((total, b) => total + b.volumetricWeightKg, 0);
  const chargeableWeightKg = consignmentChargeableWeightKg(
    normalizedBoxes,
    partnerId,
  );
  const updatedAt = new Date().toISOString();
  const pickup = {
    ok: result.pickupRegistered === true,
    registered: result.pickupRegistered === true,
    pickupDate: result.pickupDate ?? null,
    pickupTime: result.pickupTime ?? null,
    pickupAddress: result.pickupAddress ?? fromAddress,
    pickupPin: result.pickupPin ?? shipFromPin,
    originArea: result.originArea ?? null,
    destinationArea: result.destinationArea ?? null,
    destinationLocation: result.destinationLocation ?? null,
    tokenNumber: result.pickupToken ?? null,
    message: result.pickupMessage
      || (result.pickupRegistered
        ? `Pickup requested at ${result.pickupPin || shipFromPin || 'Head Office'}`
        : 'Not registered'),
    requestedAt: new Date().toISOString(),
  };

  const patch: Record<string, unknown> = {
    partnerId,
    consignmentNo: awb,
    trackingNo: awb,
    branch: 'Blue Dart',
    serviceType: 'Domestic Priority',
    shipFromSite,
    shipFromAddress: fromAddress,
    status: 'label_generated',
    wizardStep: null,
    boxes: boxes.map(box => ({
      id: box.id,
      lengthCm: box.lengthCm,
      widthCm: box.widthCm,
      heightCm: box.heightCm,
      weightKg: Number(box.weightKg) > 0 ? box.weightKg : box.volumetricWeightKg,
      volumetricWeightKg: box.volumetricWeightKg,
      photos: firestoreBoxPhotos(box.photos),
    })),
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    courierSlipGenerated: false,
    shippingLabelGenerated: false,
    labelGenerated: false,
    courierTrack: deleteField(),
    trackFetchedAt: deleteField(),
    courierFreight: deleteField(),
    actualFreightInr: deleteField(),
    freightFetchedAt: deleteField(),
    delhiveryPickup: deleteField(),
    delhiveryDocuments: deleteField(),
    courierDeliveryOffice: deleteField(),
    blueDartPickup: pickup,
    updatedAt,
  };
  if (result.documents) {
    patch.blueDartDocuments = result.documents;
  }

  await updateDoc(doc(db, COLLECTION, booking.id), patch);
  const next = await fetchLogisticsBooking(booking.id);
  if (!next) throw new Error('Blue Dart AWB was created but the booking could not be reloaded.');
  return next;
}

export async function returnLogisticsBooking(
  booking: LogisticsBooking,
  user: User,
): Promise<LogisticsBooking> {
  if (!isInternalOpsUser(user)) {
    throw new Error('You do not have permission to mark shipments returned.');
  }
  if (booking.status === 'cancelled') {
    throw new Error('Cancelled shipments cannot be marked returned.');
  }
  return updateLogisticsBookingStatus(booking, 'returned', user);
}

export async function deleteLogisticsBookingPermanently(
  bookingId: string,
  user: User,
): Promise<void> {
  if (normalizeRole(user.role) !== 'super_admin') {
    throw new Error('Only super admin can permanently delete shipments.');
  }

  const bookingRef = doc(db, COLLECTION, bookingId);
  const snap = await getDoc(bookingRef);
  if (snap.exists()) {
    const booking = mapLogisticsBookingDoc(snap.id, snap.data());
    const storagePaths = [
      ...booking.boxes.flatMap(box => box.photos.map(photo => photo.storagePath)),
      booking.finalPackagePhotoStoragePath,
    ].filter((path): path is string => Boolean(path?.trim()));
    await Promise.all(storagePaths.map(path => deleteLogisticsPhoto(path)));
  }

  await deleteDoc(bookingRef);
}

/**
 * Unlinked bookings for a delivery partner (no invoiceId), newest first.
 * Same-customer rows are sorted to the top when preferZohoCustomerId is set.
 */
export async function listUnlinkedLogisticsBookingsForPartner(
  partnerId: LogisticsPartnerId,
  options?: { preferZohoCustomerId?: string; limitCount?: number },
): Promise<LogisticsBooking[]> {
  if (!isLogisticsPartnerId(partnerId)) return [];
  const preferCustomer = options?.preferZohoCustomerId?.trim() || '';
  const limitCount = Math.min(Math.max(options?.limitCount ?? 250, 1), 250);
  const snap = await getDocs(
    query(collection(db, COLLECTION), orderBy('bookingDate', 'desc'), limit(limitCount)),
  );
  const rows = snap.docs
    .map(docSnap => mapLogisticsBookingDoc(docSnap.id, docSnap.data()))
    .filter(booking => {
      if (booking.partnerId !== partnerId) return false;
      if (booking.status === 'cancelled' || booking.status === 'returned') return false;
      return !booking.invoiceId?.trim();
    });

  if (!preferCustomer) {
    return rows.sort(compareLogisticsBookingsByBookingDateDesc);
  }

  return [...rows].sort((a, b) => {
    const aSame = a.dealer.zohoCustomerId.trim() === preferCustomer ? 0 : 1;
    const bSame = b.dealer.zohoCustomerId.trim() === preferCustomer ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return compareLogisticsBookingsByBookingDateDesc(a, b);
  });
}

/** @deprecated use listUnlinkedLogisticsBookingsForPartner */
export async function listUnlinkedLogisticsBookingsForCustomer(
  zohoCustomerId: string,
  options?: { limitCount?: number },
): Promise<LogisticsBooking[]> {
  const customerId = zohoCustomerId.trim();
  if (!customerId) return [];
  const limitCount = Math.min(Math.max(options?.limitCount ?? 40, 1), 100);
  const snap = await getDocs(
    query(
      collection(db, COLLECTION),
      where('zohoCustomerId', '==', customerId),
      orderBy('bookingDate', 'desc'),
      limit(limitCount),
    ),
  );
  return snap.docs
    .map(docSnap => mapLogisticsBookingDoc(docSnap.id, docSnap.data()))
    .filter(booking => {
      if (booking.status === 'cancelled' || booking.status === 'returned') return false;
      const linked = booking.invoiceId?.trim();
      return !linked;
    });
}

/** Attach an existing unlinked booking to an invoice. */
export async function linkLogisticsBookingToInvoice(input: {
  bookingId: string;
  invoiceId: string;
  invoiceNumber: string;
  zohoCustomerId: string;
  invoiceValueInr?: number | null;
  /** Delhivery BTC/FOD from invoice freight line when linking. */
  freightBillingMode?: import('../types/logistics-dispatch').LogisticsFreightBillingMode | null;
  user: User;
}): Promise<LogisticsBooking> {
  if (!canCreateLogisticsBooking(input.user)) {
    throw new Error('You do not have permission to link logistics bookings.');
  }
  const bookingId = input.bookingId.trim();
  const invoiceId = input.invoiceId.trim();
  const invoiceNumber = input.invoiceNumber.trim();
  const zohoCustomerId = input.zohoCustomerId.trim();
  if (!bookingId || !invoiceId) throw new Error('Booking and invoice are required.');

  const already = await findLogisticsBookingForInvoice(invoiceId);
  if (already && already.status !== 'cancelled' && already.status !== 'returned') {
    throw new Error('This invoice already has a logistics booking.');
  }

  const bookingRef = doc(db, COLLECTION, bookingId);
  const snap = await getDoc(bookingRef);
  if (!snap.exists()) throw new Error('Logistics booking not found.');
  const booking = mapLogisticsBookingDoc(snap.id, snap.data());

  if (booking.invoiceId?.trim()) {
    throw new Error('That logistics entry is already linked to an invoice.');
  }
  if (booking.status === 'cancelled' || booking.status === 'returned') {
    throw new Error('Cannot link a cancelled or returned booking.');
  }

  const updatedAt = new Date().toISOString();
  const patch: Record<string, unknown> = {
    invoiceId,
    invoiceNumber: invoiceNumber || null,
    invoiceIds: [invoiceId],
    invoices: [{
      invoiceId,
      invoiceNumber: invoiceNumber || invoiceId,
      valueInr: Number.isFinite(Number(input.invoiceValueInr)) ? Number(input.invoiceValueInr) : 0,
    }],
    invoiceValueInr: Number.isFinite(Number(input.invoiceValueInr))
      ? Number(input.invoiceValueInr)
      : null,
    source: 'invoice',
    orderRef: invoiceNumber || booking.orderRef || `INV-${invoiceId.slice(0, 8)}`,
    updatedAt,
  };
  // Keep dealer snapshot; only align top-level customer id when empty.
  if (!booking.dealer.zohoCustomerId.trim() && zohoCustomerId) {
    patch.zohoCustomerId = zohoCustomerId;
  }
  if (
    booking.partnerId === 'delhivery'
    && (input.freightBillingMode === 'fod' || input.freightBillingMode === 'btc')
  ) {
    patch.freightBillingMode = input.freightBillingMode;
    patch.freightBillingModeSource = 'booking';
  }

  await updateDoc(bookingRef, patch);

  const linked: LogisticsBooking = {
    ...booking,
    invoiceId,
    invoiceNumber: invoiceNumber || null,
    invoiceValueInr: Number.isFinite(Number(input.invoiceValueInr))
      ? Number(input.invoiceValueInr)
      : booking.invoiceValueInr ?? null,
    source: 'invoice',
    orderRef: invoiceNumber || booking.orderRef,
    ...(booking.partnerId === 'delhivery'
      && (input.freightBillingMode === 'fod' || input.freightBillingMode === 'btc')
      ? {
        freightBillingMode: input.freightBillingMode,
        freightBillingModeSource: 'booking' as const,
      }
      : {}),
    updatedAt,
  };
  await tryRefreshLogisticsBookingTrack(linked);
  const refreshed = await fetchLogisticsBooking(linked.id);
  const result = refreshed || linked;
  maybeScheduleDelhiveryDocumentsPrefetch(result);
  return result;
}

export function canEditLogisticsBooking(booking: LogisticsBooking, user: User): boolean {
  if (!isInternalOpsUser(user)) return false;
  return isEditableStatus(booking.status);
}

export function canCreateLogisticsBooking(user: User): boolean {
  return isInternalOpsUser(user);
}

export type RecordInvoiceLogisticsLrInput = {
  invoice: Pick<
    DealerInvoiceDetail,
    | 'invoiceNumber'
    | 'date'
    | 'total'
    | 'customerName'
    | 'customerPhone'
    | 'shippingPhone'
    | 'shippingAddress'
    | 'billingAddress'
  >;
  invoiceId: string;
  zohoCustomerId: string;
  consignmentNo: string;
  boxCount: number;
  createdBy: User;
  partnerId: LogisticsPartnerId;
  shipFromSite?: StaffLogisticsSite | null;
};

function dealerSnapshotFromInvoice(
  invoice: RecordInvoiceLogisticsLrInput['invoice'],
  zohoCustomerId: string,
): LogisticsDealerSnapshot {
  const name = invoice.customerName?.trim() || zohoCustomerId;
  const shipping = invoice.shippingAddress?.trim() || '';
  const billing = invoice.billingAddress?.trim() || shipping;
  const shippingPhone = phoneDigitsForCourier(invoice.shippingPhone)
    || phoneDigitsForCourier(extractPhoneFromText(shipping))
    || undefined;
  return {
    zohoCustomerId,
    dealerId: zohoCustomerId,
    name,
    code: zohoCustomerId,
    contactPerson: name,
    mobile: shippingPhone || invoice.customerPhone?.trim() || '',
    ...(shippingPhone ? { shippingPhone } : {}),
    shippingAddress: shipping || billing || name,
    billingAddress: billing || shipping || name,
  };
}

/**
 * Create a confirmed logistics booking from an existing LR + box count
 * (no wizard photos / label print). Used for older invoices.
 */
export async function recordInvoiceLogisticsBooking(
  input: RecordInvoiceLogisticsLrInput,
): Promise<LogisticsBooking> {
  if (!canCreateLogisticsBooking(input.createdBy)) {
    throw new Error('You do not have permission to create logistics bookings.');
  }

  const consignmentRaw = input.consignmentNo.trim();
  if (!consignmentRaw) throw new Error('LR / consignment number is required.');

  const boxCount = Math.floor(Number(input.boxCount));
  if (!Number.isFinite(boxCount) || boxCount < 1 || boxCount > 99) {
    throw new Error('Enter a box count between 1 and 99.');
  }

  const zohoCustomerId = input.zohoCustomerId.trim();
  if (!zohoCustomerId) throw new Error('Customer is required.');

  const existing = await findLogisticsBookingForInvoice(input.invoiceId);
  if (existing && existing.status !== 'cancelled' && existing.status !== 'returned') {
    throw new Error('This invoice already has a logistics booking.');
  }

  const partnerId = input.partnerId;
  if (!isLogisticsPartnerId(partnerId) || !isPipelineEnabledPartner(partnerId)) {
    throw new Error('This courier partner is not available for logistics booking.');
  }
  if (partnerId === 'delhivery') {
    throw new Error(
      'Delhivery must be booked from the invoice (Book Courier) or by linking an existing LR.',
    );
  }

  const consignmentNo = consignmentRaw;
  const trackingNo = consignmentRaw;

  let dealer = dealerSnapshotFromInvoice(input.invoice, zohoCustomerId);
  try {
    const zoho = await fetchDealerById(zohoCustomerId);
    dealer = zohoDealerToSnapshot(zoho);
  } catch {
    // Invoice snapshot is enough for a manual LR record.
  }

  const settings = await loadLogisticsSettings();
  const shipFromSite = isStaffLogisticsSite(input.shipFromSite)
    ? input.shipFromSite
    : 'cochin';
  const shipFromAddress = settings.fromAddresses[shipFromSite]?.trim() || '';

  const boxes = Array.from({ length: boxCount }, () => {
    const draft = emptyShipmentBoxDraft();
    return {
      id: draft.id,
      lengthCm: null as number | null,
      widthCm: null as number | null,
      heightCm: null as number | null,
      weightKg: 0,
      volumetricWeightKg: 0,
      photos: [] as Array<{ storagePath: string }>,
    };
  });

  const now = new Date().toISOString();
  const bookingDate = (input.invoice.date || now).slice(0, 10);
  const bookingRef = doc(collection(db, COLLECTION));
  const createdByName = input.createdBy.displayName?.trim()
    || input.createdBy.loginId?.trim()
    || input.createdBy.email?.trim()
    || 'YESWEIGH';
  const deliveryAddress = resolveDraftDeliveryAddress(dealer, {
    deliveryAddressKind: 'shipping',
    deliveryAddress: input.invoice.shippingAddress?.trim() || null,
  });

  const payload: Record<string, unknown> = {
    orderRef: input.invoice.invoiceNumber || `INV-${bookingRef.id.slice(0, 8)}`,
    source: 'invoice',
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoice.invoiceNumber ?? null,
    invoiceValueInr: Number.isFinite(Number(input.invoice.total)) ? Number(input.invoice.total) : null,
    supportRequestId: null,
    supportRequestNumber: null,
    partnerId,
    consignmentNo,
    trackingNo,
    branch: '',
    serviceType: '',
    bookingDate,
    zohoCustomerId: dealer.zohoCustomerId,
    dealerId: dealer.dealerId,
    dealerSnapshot: {
      zohoCustomerId: dealer.zohoCustomerId,
      dealerId: dealer.dealerId,
      name: dealer.name,
      code: dealer.code,
      contactPerson: dealer.contactPerson,
      mobile: dealer.mobile,
      shippingAddress: dealer.shippingAddress,
      billingAddress: dealer.billingAddress,
      ...(dealer.destinationCity?.trim()
        ? { destinationCity: dealer.destinationCity.trim() }
        : {}),
    },
    deliveryAddressKind: 'shipping',
    deliveryAddress,
    shipFromSite,
    shipFromAddress,
    shipmentMode: 'box',
    numberOfBoxes: boxes.length,
    actualWeightKg: 0,
    volumetricWeightKg: 0,
    chargeableWeightKg: 0,
    boxes,
    finalPackagePhotoStoragePath: null,
    labelGenerated: true,
    courierSlipGenerated: true,
    shippingLabelGenerated: true,
    packingSlipGenerated: false,
    status: 'label_generated',
    wizardStep: null,
    createdAt: now,
    updatedAt: now,
    createdByUid: input.createdBy.uid,
    createdByName,
  };

  try {
    await setDoc(bookingRef, payload);
    const booking = mapLogisticsBookingDoc(bookingRef.id, payload);
    await tryRefreshLogisticsBookingTrack(booking);
    const refreshed = await fetchLogisticsBooking(booking.id);
    const result = refreshed || booking;
    maybeScheduleDelhiveryDocumentsPrefetch(result);
    return result;
  } catch (err) {
    throw formatLogisticsPersistError(err, 'Could not create logistics entry.');
  }
}

export function canDeleteLogisticsBooking(user: User): boolean {
  return normalizeRole(user.role) === 'super_admin';
}
