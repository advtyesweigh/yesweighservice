import type { LogisticsPartnerId } from '../constants/logisticsPartners';
import type { StaffLogisticsSite } from './staff-logistics';

export type LogisticsBookingStatus =
  | 'label_generated'
  | 'in_transit'
  | 'delivered'
  | 'cancelled'
  | 'returned';

export type LogisticsBookingSource = 'manual' | 'invoice' | 'support';

export type DeliveryAddressKind = 'shipping' | 'billing';

/** Whether the shipment is a flat envelope/document pouch or a box. */
export type ShipmentMode = 'envelope' | 'box';

/** The two printable documents generated for a shipment. */
export type LogisticsDocumentType = 'courier_slip' | 'shipping_label';

/** Snapshot of the Zoho customer at booking time. */
export interface LogisticsDealerSnapshot {
  zohoCustomerId: string;
  /** Portal user uid when linked, otherwise Zoho contact id. */
  dealerId: string;
  name: string;
  code: string;
  contactPerson: string;
  /**
   * Receiver phone for labels / courier slip.
   * Preference: shipping address → billing address → contact person → any other field.
   */
  mobile: string;
  /** Phone on Zoho shipping address (when available). */
  shippingPhone?: string;
  /** Phone on Zoho billing address (when available). */
  billingPhone?: string;
  /** Dealer default shipping (Zoho). Per-booking Ship To is deliveryAddress, not this field. */
  shippingAddress: string;
  /** Dealer default billing (Zoho). */
  billingAddress: string;
  /** Preferred destination city for shipping labels. */
  destinationCity?: string;
  /** Portal-assigned KAM / staff at booking time (when available). */
  assignedStaffName?: string | null;
}

/** @deprecated use LogisticsDealerSnapshot */
export type Dealer = LogisticsDealerSnapshot;

/** A persisted box photo. */
export interface ShipmentBoxPhoto {
  storagePath: string;
  /** Resolved download URL or transient preview. */
  url?: string | null;
  /** Draft-side id used to keep local captures linked across save/resume. */
  clientPhotoId?: string | null;
}

/** A persisted box in a shipment. */
export interface ShipmentBox {
  id: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: number;
  volumetricWeightKg: number;
  /** photos[0] is the mandatory "inside" photo; the rest are optional. */
  photos: ShipmentBoxPhoto[];
}

/** A box photo while editing (transient data URL preview or resolved URL). */
export interface ShipmentBoxPhotoDraft {
  id: string;
  url: string;
  storagePath?: string | null;
}

/** A box while editing (string inputs for the number fields). */
export interface ShipmentBoxDraft {
  id: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
  photos: ShipmentBoxPhotoDraft[];
}

/** One invoice on a (possibly clubbed) Delhivery LR. */
export interface LogisticsBookingInvoice {
  invoiceId: string;
  invoiceNumber: string;
  /** Grand total incl. GST (INR). */
  valueInr: number;
  ewayBillNumber?: string | null;
  ewayBillStatus?: string | null;
  /** True when clubbed shipment total exceeds the e-way threshold. */
  ewayRequired?: boolean;
}

export interface LogisticsBookingDraft {
  partnerId: LogisticsPartnerId;
  source: LogisticsBookingSource;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Extra invoices clubbed onto the same Delhivery LR (includes primary). */
  clubbedInvoices?: LogisticsBookingInvoice[];
  /** Linked SO number when booking from an invoice (used as Delhivery shipper reference). */
  salesOrderNumber?: string | null;
  /** Invoice grand total (INR) for courier invoice value / FOV. Clubbed = sum. */
  invoiceValueInr?: number | null;
  /** Consignee GSTIN from invoice / Zoho customer when available. */
  customerGstin?: string | null;
  /** Consignee phone from invoice when dealer snapshot phone is missing. */
  customerPhone?: string | null;
  supportRequestId: string | null;
  supportRequestNumber: string | null;
  barcodeRaw: string;
  consignmentNo: string;
  branch: string;
  serviceType: string;
  bookingDate: string;
  zohoCustomerId: string;
  dealerId: string;
  deliveryAddressKind: DeliveryAddressKind;
  /**
   * Selected delivery address for this booking only (invoice Ship To).
   * When set, labels/slips use this; dealerSnapshot shipping/billing stay the dealer defaults.
   */
  deliveryAddress?: string | null;
  shipFromSite: StaffLogisticsSite;
  shipmentMode: ShipmentMode;
  boxes: ShipmentBoxDraft[];
  /** Transient data URL until uploaded on confirm. */
  finalPackagePhoto: string | null;
  /** Set when resuming a saved booking; wizard resolves this to a display URL. */
  finalPackagePhotoStoragePath?: string | null;
  labelGenerated: boolean;
  /**
   * Delhivery only: FOD (consignee pays freight) vs BTC (bill to client).
   * Sent as freight_mode on manifest create when FOD.
   */
  freightBillingMode?: LogisticsFreightBillingMode | null;
  /** Delhivery first-mile pickup after Create LR (stashed until persist). */
  delhiveryPickup?: LogisticsDelhiveryPickup | null;
  /** Delhivery Master AWB (MWB) when known at Create LR. */
  masterAwb?: string | null;
  /** Blue Dart waybill PDF cache (set after GenerateWayBill). */
  blueDartDocuments?: LogisticsBlueDartDocumentsCache | null;
  /** Blue Dart RegisterPickup result from GenerateWayBill. */
  blueDartPickup?: LogisticsBlueDartPickup | null;
}

/** Persisted ST Courier track snapshot (from hourly sync / live fetch). */
export interface LogisticsCourierTrackHistoryItem {
  at: string;
  location: string;
  activity: string;
}

export interface LogisticsCourierTrack {
  awb: string;
  ok: boolean;
  error: string | null;
  status: string | null;
  /** Delhivery StatusType when present (DL / UD / RT / CN / …). */
  statusType?: string | null;
  /** Delhivery Master AWB (MWB) when track used Express packages/json fallback. */
  masterAwb?: string | null;
  origin: string | null;
  destination: string | null;
  consignmentType: string | null;
  bookedAt: string | null;
  /** Courier delivery date/time string when available. */
  deliveredAt: string | null;
  history: LogisticsCourierTrackHistoryItem[];
  sourceUrl: string;
  fetchedAt: string;
}

/** Delhivery freight billing: FOD = consignee pays freight; BTC = bill to client. */
export type LogisticsFreightBillingMode = 'fod' | 'btc';

/** Delhivery first-mile pickup request snapshot (after Create LR). */
export interface LogisticsDelhiveryPickup {
  ok: boolean;
  alreadyExisted?: boolean;
  pickupId: string | null;
  pickupLocationName?: string | null;
  pickupDate?: string | null;
  pickupTime?: string | null;
  expectedPackageCount?: number | null;
  message?: string | null;
  requestedAt: string;
}

/** Blue Dart first-mile pickup registered with GenerateWayBill. */
export interface LogisticsBlueDartPickup {
  ok: boolean;
  registered: boolean;
  pickupDate?: string | null;
  pickupTime?: string | null;
  pickupAddress?: string | null;
  pickupPin?: string | null;
  originArea?: string | null;
  destinationArea?: string | null;
  destinationLocation?: string | null;
  tokenNumber?: string | null;
  message?: string | null;
  requestedAt: string;
}

/** Last attempt to push invoice e-way bill numbers onto the Delhivery LR. */
export interface LogisticsDelhiveryEwaySync {
  ok: boolean;
  lrn: string | null;
  fingerprint?: string | null;
  jobId?: string | null;
  error?: string | null;
  invoices?: Array<{ inv_number: string; ewaybill: string }>;
  syncedAt: string;
  /** `partner_status` = already on Delhivery (portal/track); `push` = our PUT. */
  source?: 'partner_status' | 'push' | null;
}

/** Official Delhivery documents cached in Storage (paths + metadata only). */
export interface LogisticsDelhiveryDocumentsCache {
  lrn: string;
  lrCopy?: {
    storagePath: string;
    contentType: string;
    fileName: string;
    cachedAt: string;
  } | null;
  shippingLabels?: {
    size: string;
    images: Array<{
      storagePath: string;
      contentType: string;
      fileName: string;
    }>;
    cachedAt: string;
  } | null;
  pod?: {
    storagePaths: string[];
    cachedAt: string;
  } | null;
  cod?: {
    storagePath: string;
    contentType: string;
    fileName?: string;
    cachedAt: string;
  } | null;
  prefetchStatus?: {
    lastAttemptAt?: string;
    completedAt?: string;
    lrCopy?: string;
    shippingLabels?: string;
    pod?: string;
    cod?: string;
    lrCopyError?: string;
    shippingLabelsError?: string;
    podError?: string;
    codError?: string;
  } | null;
}

export type LogisticsBlueDartDocFile = {
  storagePath: string;
  contentType: string;
  fileName: string;
  cachedAt: string;
  /** Official A4S, or A4S shrink-to-fit on 100×150 mm stock. */
  labelSize?: 'a4s' | '100x150' | string;
};

/** Official Blue Dart waybill cached in Storage after GenerateWayBill. */
export interface LogisticsBlueDartDocumentsCache {
  awb: string;
  /** 100×150 mm thermal shipping label. */
  waybill?: LogisticsBlueDartDocFile | null;
  /** Official A4S waybill (PrinterLableSize 0). */
  awbA4?: LogisticsBlueDartDocFile | null;
}

/** Delhivery freight-breakup snapshot (after weight captured). */
export interface LogisticsCourierFreightBreakup {
  baseFreightCharge: number | null;
  fuelSurcharge: number | null;
  fuelHike: number | null;
  insuranceRov: number | null;
  odaFm: number | null;
  odaLm: number | null;
  fm: number | null;
  lm: number | null;
  green: number | null;
  preTaxFreight: number | null;
  gst: number | null;
  gstPercent: number | null;
  markup: number | null;
  otherHandlingCharges: number | null;
}

export interface LogisticsCourierFreight {
  ok: boolean;
  lrn: string;
  totalInr: number | null;
  chargedWeightKg: number | null;
  minChargedWeightKg: number | null;
  breakup: LogisticsCourierFreightBreakup | null;
  /** FOD / BTC when known from API or ops. */
  billingMode?: LogisticsFreightBillingMode | null;
  error: string | null;
  fetchedAt: string;
  source: string;
}

/** Destination delivery-office contact from ST pincode search (fetched once). */
export interface LogisticsCourierDeliveryOffice {
  pincode: string;
  communication: string;
  serviceCenter?: string | null;
  hubCenter?: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

/** Staff complaint resolve entry shown in courier tracking history. */
export interface LogisticsComplaintLog {
  at: string;
  notes: string;
  kind: 'resolved';
  byName: string;
}

export interface LogisticsBooking {
  id: string;
  orderRef: string;
  source: LogisticsBookingSource;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** All invoice ids on this booking (includes invoiceId). Used for array-contains lookup. */
  invoiceIds?: string[];
  /** Per-invoice values and e-way status when several invoices share one LR. */
  invoices?: LogisticsBookingInvoice[];
  /** Invoice grand total (INR) — e-way threshold and courier FOV. Clubbed = sum. */
  invoiceValueInr?: number | null;
  supportRequestId: string | null;
  supportRequestNumber: string | null;
  /** Staff resolve notes logged onto this shipment (shown in tracking history). */
  complaintLogs?: LogisticsComplaintLog[];
  complaintResolvedAt?: string | null;
  partnerId: LogisticsPartnerId;
  consignmentNo: string;
  trackingNo: string;
  /** Delhivery Master AWB (MWB) when known. */
  masterAwb?: string | null;
  branch: string;
  serviceType: string;
  bookingDate: string;
  dealer: LogisticsDealerSnapshot;
  deliveryAddressKind: DeliveryAddressKind;
  deliveryAddress: string;
  shipFromSite: StaffLogisticsSite;
  shipFromAddress: string;
  shipmentMode: ShipmentMode;
  boxes: ShipmentBox[];
  /** Total boxes (boxes.length). */
  numberOfBoxes: number;
  /** Sum of box actual weights. */
  actualWeightKg: number;
  /** Sum of box volumetric weights. */
  volumetricWeightKg: number;
  /** Sum of per-box chargeable weights (max actual/volumetric). */
  chargeableWeightKg?: number;
  finalPackagePhoto: string | null;
  finalPackagePhotoStoragePath: string | null;
  /** @deprecated legacy alias of shippingLabelGenerated */
  labelGenerated: boolean;
  courierSlipGenerated: boolean;
  shippingLabelGenerated: boolean;
  /** @deprecated no longer surfaced in the UI */
  packingSlipGenerated?: boolean;
  status: LogisticsBookingStatus;
  /** Wizard step while booking is still in progress (`null` once confirmed). */
  wizardStep?: string | null;
  /** Last persisted ST Courier track (status + history). */
  courierTrack?: LogisticsCourierTrack | null;
  /** ISO timestamp of last ST track fetch (mirrors courierTrack.fetchedAt). */
  trackFetchedAt?: string | null;
  /** Delhivery actual freight from freight-breakup API (post weight capture). */
  courierFreight?: LogisticsCourierFreight | null;
  /** Convenience mirror of courierFreight.totalInr when available. */
  actualFreightInr?: number | null;
  /** ISO timestamp of last Delhivery freight-breakup fetch. */
  freightFetchedAt?: string | null;
  /** Delhivery freight billing: fod (consignee) or btc (bill to client). */
  freightBillingMode?: LogisticsFreightBillingMode | null;
  /** How freightBillingMode was set: booking UI, Delhivery API, estimate inference, or ops. */
  freightBillingModeSource?: 'booking' | 'api' | 'inferred' | 'manual' | null;
  /** Delhivery first-mile pickup request (auto after Create LR). */
  delhiveryPickup?: LogisticsDelhiveryPickup | null;
  /** Blue Dart RegisterPickup snapshot from GenerateWayBill. */
  blueDartPickup?: LogisticsBlueDartPickup | null;
  /** Result of pushing e-way bill numbers onto the Delhivery LR after Zoho generation. */
  delhiveryEwaySync?: LogisticsDelhiveryEwaySync | null;
  /**
   * Official Delhivery docs cached in Firebase Storage after first open
   * (LR copy / shipping labels / POD / COD). Paths only — not file bytes.
   */
  delhiveryDocuments?: LogisticsDelhiveryDocumentsCache | null;
  /** Official Blue Dart waybill PDF cached in Storage after GenerateWayBill. */
  blueDartDocuments?: LogisticsBlueDartDocumentsCache | null;
  /** E-way bill number mirrored from linked invoice when generated. */
  ewayBillNumber?: string | null;
  ewayBillStatus?: string | null;
  /** Set when this booking's BTC freight Diff was fully settled onto an invoiced SO. */
  freightDiffSettledAt?: string | null;
  freightDiffSettledInvoiceId?: string | null;
  freightDiffSettledSalesOrderId?: string | null;
  /** Destination office Communication from ST pincode search (once per booking). */
  courierDeliveryOffice?: LogisticsCourierDeliveryOffice | null;
  /** ISO or ST delivery timestamp when booking was marked delivered via sync. */
  deliveredAt?: string | null;
  inTransitAt?: string | null;
  /** Meezan / dealer sales invoice PDF to pack instead of the YESWEIGH invoice. */
  dealerCustomerInvoice?: {
    storagePath: string;
    url: string;
    fileName: string;
    uploadedAt: string | null;
    uploadedByUid: string | null;
    uploadedByName: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  createdByUid: string;
  createdByName: string;
}

/** @deprecated Prefer LogisticsPartnerId from logisticsPartners */
export type CourierPartnerId = LogisticsPartnerId | 'ecosafe' | 'aps';
