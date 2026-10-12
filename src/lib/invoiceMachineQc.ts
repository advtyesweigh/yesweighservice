import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { auth, db, storage } from '../firebase';
import { formatStorageUploadError } from './storageErrors';
import { documentLooksLikeMachineQc } from './machineQc';

export const INVOICE_QC_REQUIRED = 5;
export const INVOICE_QC_MAX = 5;
const MAX_QC_BYTES = 12 * 1024 * 1024;
const COLLECTION = 'invoiceMachineQc';
const STORAGE_PREFIX = 'invoice-qc';

export type InvoiceMachineQcImage = {
  id: string;
  storagePath: string;
  fileName: string;
  contentType: string;
  uploadedAt: string;
  uploadedByUid: string | null;
  uploadedByName: string | null;
};

export type InvoiceMachineQcDoc = {
  invoiceId: string;
  customerId: string;
  salesOrderId: string | null;
  images: InvoiceMachineQcImage[];
  updatedAt: string;
};

function isAllowedQcImage(file: File): boolean {
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function qcExtension(file: File): string {
  const type = String(file.type || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('heic') || type.includes('heif')) return 'heic';
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (match?.[1] === 'png' || match?.[1] === 'webp' || match?.[1] === 'heic' || match?.[1] === 'heif') {
    return match[1];
  }
  return 'jpg';
}

export function invoiceMachineQcComplete(
  images?: InvoiceMachineQcImage[] | null,
): boolean {
  return (images?.length ?? 0) >= INVOICE_QC_REQUIRED;
}

/** QC-requested invoices cannot dispatch until 5 warehouse photos are uploaded. */
export function invoiceNeedsMandatoryQcPhotos(
  invoice: {
    qcRequested?: boolean | null;
    dealerCustomerInvoice?: { url?: string | null; storagePath?: string | null } | null;
    lineItems?: Array<{
      qcEnabled?: boolean | null;
      qcFeePerUnit?: number | null;
      description?: string | null;
    } | null | undefined> | null;
  } | null | undefined,
  photoCount: number,
): boolean {
  if (!invoice || !documentLooksLikeMachineQc(invoice)) return false;
  return photoCount < INVOICE_QC_REQUIRED;
}

export function parseInvoiceMachineQcImages(raw: unknown): InvoiceMachineQcImage[] {
  if (!Array.isArray(raw)) return [];
  const out: InvoiceMachineQcImage[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const data = row as Record<string, unknown>;
    const storagePath = String(data.storagePath ?? '').trim();
    const id = String(data.id ?? '').trim();
    if (!storagePath || !id) continue;
    out.push({
      id,
      storagePath,
      fileName: String(data.fileName ?? 'qc-photo.jpg').trim() || 'qc-photo.jpg',
      contentType: String(data.contentType ?? 'image/jpeg').trim() || 'image/jpeg',
      uploadedAt: data.uploadedAt ? String(data.uploadedAt) : '',
      uploadedByUid: data.uploadedByUid ? String(data.uploadedByUid) : null,
      uploadedByName: data.uploadedByName ? String(data.uploadedByName) : null,
    });
  }
  return out.slice(0, INVOICE_QC_MAX);
}

export function parseInvoiceMachineQcDoc(
  invoiceId: string,
  data: Record<string, unknown> | null | undefined,
): InvoiceMachineQcDoc | null {
  if (!data) return null;
  const images = parseInvoiceMachineQcImages(data.images);
  return {
    invoiceId,
    customerId: String(data.customerId ?? '').trim(),
    salesOrderId: data.salesOrderId ? String(data.salesOrderId).trim() || null : null,
    images,
    updatedAt: data.updatedAt ? String(data.updatedAt) : '',
  };
}

export async function fetchInvoiceMachineQc(
  invoiceId: string,
): Promise<InvoiceMachineQcDoc | null> {
  const id = String(invoiceId || '').trim();
  if (!id) return null;
  const snap = await getDoc(doc(db, COLLECTION, id));
  if (!snap.exists()) return null;
  return parseInvoiceMachineQcDoc(id, snap.data() as Record<string, unknown>);
}

export function listenInvoiceMachineQc(
  invoiceId: string,
  onNext: (doc: InvoiceMachineQcDoc | null) => void,
): Unsubscribe {
  const id = String(invoiceId || '').trim();
  if (!id) {
    onNext(null);
    return () => undefined;
  }
  return onSnapshot(
    doc(db, COLLECTION, id),
    snap => {
      onNext(snap.exists()
        ? parseInvoiceMachineQcDoc(id, snap.data() as Record<string, unknown>)
        : null);
    },
    () => onNext(null),
  );
}

export async function fetchInvoiceQcImageUrl(storagePath: string): Promise<string> {
  const path = String(storagePath || '').trim();
  if (!path) throw new Error('Photo path is missing.');
  return getDownloadURL(ref(storage, path));
}

async function persistImages(input: {
  invoiceId: string;
  customerId: string;
  salesOrderId?: string | null;
  images: InvoiceMachineQcImage[];
}): Promise<InvoiceMachineQcImage[]> {
  const invoiceId = String(input.invoiceId || '').trim();
  const customerId = String(input.customerId || '').trim();
  if (!invoiceId) throw new Error('Invoice is required.');
  if (!customerId) throw new Error('Customer is required.');
  const images = input.images.slice(0, INVOICE_QC_MAX);
  await setDoc(doc(db, COLLECTION, invoiceId), {
    invoiceId,
    customerId,
    salesOrderId: String(input.salesOrderId || '').trim() || null,
    images,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return images;
}

export async function addInvoiceMachineQcImages(input: {
  invoiceId: string;
  customerId: string;
  salesOrderId?: string | null;
  files: File[];
  existing?: InvoiceMachineQcImage[] | null;
}): Promise<InvoiceMachineQcImage[]> {
  const files = (input.files ?? []).filter(Boolean);
  if (!files.length) throw new Error('Choose one or more photos to upload.');
  const existing = Array.isArray(input.existing) ? [...input.existing] : [];
  if (existing.length + files.length > INVOICE_QC_MAX) {
    throw new Error(`Upload exactly ${INVOICE_QC_REQUIRED} QC photos.`);
  }
  const user = auth.currentUser;
  const uploaded: InvoiceMachineQcImage[] = [];
  for (const file of files) {
    if (file.size > MAX_QC_BYTES) {
      throw new Error(`Each photo must be under 12 MB (${file.name}).`);
    }
    if (!isAllowedQcImage(file)) {
      throw new Error(`Upload photos only (JPG / PNG / HEIC). Skipped ${file.name}.`);
    }
    const imageId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `qc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const ext = qcExtension(file);
    const storagePath = `${STORAGE_PREFIX}/${input.invoiceId}/${imageId}.${ext}`;
    const contentType = file.type || (ext === 'png' ? 'image/png' : 'image/jpeg');
    try {
      await uploadBytes(ref(storage, storagePath), file, { contentType });
    } catch (err) {
      throw new Error(formatStorageUploadError(err, `Could not upload ${file.name}.`));
    }
    uploaded.push({
      id: imageId,
      storagePath,
      fileName: file.name,
      contentType,
      uploadedAt: new Date().toISOString(),
      uploadedByUid: user?.uid ?? null,
      uploadedByName: user?.displayName?.trim() || user?.email?.trim() || null,
    });
  }
  return persistImages({
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    salesOrderId: input.salesOrderId,
    images: [...existing, ...uploaded],
  });
}

export async function deleteInvoiceMachineQcImage(input: {
  invoiceId: string;
  customerId: string;
  salesOrderId?: string | null;
  imageId: string;
  existing?: InvoiceMachineQcImage[] | null;
}): Promise<InvoiceMachineQcImage[]> {
  const existing = Array.isArray(input.existing) ? input.existing : [];
  const target = existing.find(row => row.id === input.imageId);
  const next = existing.filter(row => row.id !== input.imageId);
  if (target?.storagePath) {
    try {
      await deleteObject(ref(storage, target.storagePath));
    } catch {
      /* keep metadata removal even if the file is already gone */
    }
  }
  return persistImages({
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    salesOrderId: input.salesOrderId,
    images: next,
  });
}
