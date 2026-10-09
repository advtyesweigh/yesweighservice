export type SoftwareShopUser = {
  userId: number | string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  blocked: boolean;
};

export type SoftwareShopStatus = 'ACTIVE' | 'EXPIRING SOON' | 'EXPIRED' | 'CANCELLED' | 'VOIDED';

export type SoftwareEndInFilter = '' | '7' | '15' | '30';

export type SoftwareExpiredInFilter = '' | '7' | '15' | '30' | '90' | '365' | 'lifetime';

export type SoftwareInformedFilter = '' | 'informed' | 'not-informed';

export type SoftwareSourceAccount = 'meezan' | 'weighvox' | 'weighvox-dubai' | 'yesweigh';

export type SoftwareDealerFilter = 'all' | 'meezan' | 'weighvox' | 'yesweigh';

export type SoftwareFollowUpChannel = 'call' | 'whatsapp';

export type SoftwareShop = {
  id: string;
  shopId: number;
  sourceAccount: string;
  name: string;
  phone: string;
  subscription: string;
  status: SoftwareShopStatus;
  rawStatus: string;
  cancelled: boolean;
  /** Local Meezan void — not a Sanoft delete. Survives dealer-list sync. */
  voided: boolean;
  cancelledAt: string | null;
  subscriptionEnd: string;
  installationDate: string;
  sanoftInstallationDate: string;
  customerId: string;
  customerName: string;
  customerOrgKey: string;
  dealer: string;
  expenseValidity: string;
  imageSupport: string;
  kotValidity: string;
  kotLite: string;
  smartScale: string;
  currency: string;
  salesBalance: number;
  country: string;
  users: SoftwareShopUser[];
  extras: Record<string, string>;
  syncedAt: string | null;
  whatsappRenewalSentAt: string | null;
  hasFollowUp: boolean;
  contactedAt: string | null;
  lastFollowUpRemarks: string;
  lastFollowUpChannel: SoftwareFollowUpChannel | '';
  contactedViaCall: boolean;
  contactedViaWhatsApp: boolean;
  isNewCustomer: boolean;
  trainingScheduledAt: string;
  trainingScheduledByName: string;
  trainingCompletedAt: string;
  pocName: string;
  pocPhone: string;
  pocEmail: string;
  ownerPhone: string;
  supportUsername: string;
  supportPassword: string;
  trainingPoints: string;
  menuUploaded: boolean;
  menuUploadedAt: string | null;
};

export type SoftwareShopFollowUp = {
  id: string;
  userId: string;
  userName: string;
  remarks: string;
  channel: SoftwareFollowUpChannel | '';
  createdAt: string | null;
};

export type SoftwareShopTraining = {
  id: string;
  userId: string;
  userName: string;
  scheduledAt: string;
  trainingPoints: string;
  pocName: string;
  ownerPhone: string;
  pocPhone: string;
  createdAt: string | null;
};

export type SoftwareShopSyncMeta = {
  count: number;
  fetched: number;
  upserted: number;
  lastSyncAt: string | null;
  error: string | null;
};

export type SoftwareShopAccountSyncResult = {
  sourceAccount: string;
  fetched: number;
  reported: number;
  upserted: number;
  renewals?: number;
  apiCalls: number;
  syncedAt: string;
};

export type ShopMenuItem = {
  serial: string;
  category: string;
  name: string;
  price: number;
};

export type ShopMenu = {
  shopId: string;
  items: ShopMenuItem[];
  source: string;
  storagePath: string;
  model: string;
  provider: string;
  itemCount: number;
  updatedAt: string | null;
  updatedByName: string;
};

export type ExtractShopMenuResult = {
  ok: boolean;
  shopId: string;
  items: ShopMenuItem[];
  storagePath: string;
  model: string;
  provider: string;
  location: string;
  pageCount: number;
  itemCount: number;
};

export type ShopMenuPosResult = {
  ok: boolean;
  restaurant?: boolean;
  itemType?: string;
  taxPercent?: number;
  taxRule?: { name: string; percent: number; created?: boolean } | null;
  categoriesCreated?: string[];
  categoriesSkipped?: string[];
  categoriesFailed?: Array<{ name: string; message: string }>;
  itemsCreated?: Array<{ name: string; id?: number; plu?: number | null; price?: number }>;
  itemsSkipped?: string[];
  itemsFailed?: Array<{ name: string; message: string }>;
  error?: string | null;
};

export type SaveShopMenuResult = {
  ok: boolean;
  shopId: string;
  itemCount: number;
  items: ShopMenuItem[];
  restaurant?: boolean;
  menuUploaded?: boolean;
  pos?: ShopMenuPosResult | null;
};

export type SoftwareShopSyncResult = {
  ok: boolean;
  collection: string;
  fetched: number;
  reported: number;
  upserted: number;
  renewals?: number;
  apiCalls: number;
  syncedAt: string;
  migrated?: number;
  accounts?: SoftwareShopAccountSyncResult[];
};
