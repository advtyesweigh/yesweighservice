export const VALID_RACK_LETTERS = 'abcdefghjklmnpq'.split('');

export const ROW_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;
export const BIN_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type RowNumber = (typeof ROW_NUMBERS)[number];
export type BinNumber = (typeof BIN_NUMBERS)[number];

export interface YesStorePhoto {
  id: string;
  url: string;
  storagePath: string;
  fileName: string;
  uploadedAt: string;
}

export interface YesStoreRackDoc {
  id: string;
  photos: YesStorePhoto[];
  createdAt: string;
  updatedAt: string;
}

export interface YesStoreRowDoc {
  id: string;
  rackId: string;
  number: RowNumber;
  photos: YesStorePhoto[];
  createdAt: string;
  updatedAt: string;
}

export interface YesStoreBinDoc {
  id: string;
  rackId: string;
  rowId: string;
  rowNumber: RowNumber;
  number: BinNumber;
  photos: YesStorePhoto[];
  createdAt: string;
  updatedAt: string;
}

export const MAX_ITEM_PHOTOS = 2;

export type CatalogLinkMode = 'unit' | 'part';

export interface YesStoreItemDoc {
  id: string;
  quantity: number;
  rackId: string;
  rowId: string;
  rowNumber: RowNumber;
  binId: string;
  binNumber: BinNumber;
  photos: YesStorePhoto[];
  createdAt: string;
  updatedAt: string;
  /** Linked Zoho catalog product — set when super admin links an audit item. */
  catalogProductId?: string | null;
  catalogProductName?: string | null;
  catalogProductSku?: string | null;
  linkedAt?: string | null;
  linkedByUid?: string | null;
  linkedByName?: string | null;
  /** Last time an auditor confirmed or updated the counted qty. */
  lastAuditedAt?: string | null;
  lastAuditedByUid?: string | null;
  lastAuditedByName?: string | null;
  /** Warehouse staff who physically counted this bin. */
  countedAt?: string | null;
  countedByUid?: string | null;
  countedByName?: string | null;
  /** How this bin counts toward a linked Zoho product. */
  catalogLinkMode?: CatalogLinkMode | null;
  /** Bundle part name (e.g. Part A) when catalogLinkMode is part. */
  partLabel?: string | null;
  /** Parts required from this bin per one complete Zoho unit (bundle mode). */
  unitsPerProduct?: number | null;
  /** @deprecated legacy records only */
  name?: string;
  notes?: string;
}

export function isYesStoreItemLinked(
  item: Pick<YesStoreItemDoc, 'catalogProductId'>,
): boolean {
  return Boolean(item.catalogProductId?.trim());
}

export function isValidRackId(rackId: string): boolean {
  return VALID_RACK_LETTERS.includes(rackId.toLowerCase());
}

export function isValidRowNumber(value: number): value is RowNumber {
  return ROW_NUMBERS.includes(value as RowNumber);
}

export function isValidBinNumber(value: number): value is BinNumber {
  return BIN_NUMBERS.includes(value as BinNumber);
}

export function rowDocId(rackId: string, rowNumber: RowNumber): string {
  return `${rackId}_${rowNumber}`;
}

export function binDocId(rackId: string, rowNumber: RowNumber, binNumber: BinNumber): string {
  return `${rackId}_${rowNumber}_${binNumber}`;
}

export function formatLocationLabel(
  rackId: string,
  rowNumber: RowNumber,
  binNumber?: BinNumber,
): string {
  const rack = rackId.toUpperCase();
  if (binNumber == null) return `Rack ${rack} · Row ${rowNumber}`;
  return `Rack ${rack} · Row ${rowNumber} · Bin ${binNumber}`;
}

export function formatItemLocationShort(
  rackId: string,
  rowNumber: RowNumber,
  binNumber: BinNumber,
): string {
  return `${rackId.toUpperCase()} · ${rowNumber} · ${binNumber}`;
}

/** Counted bin qty. Zero is a real count (bin emptied). Missing or invalid reads as 0. */
export function readItemQuantity(item: Pick<YesStoreItemDoc, 'quantity'>): number {
  if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity)) return 0;
  return Math.max(0, Math.floor(item.quantity));
}
