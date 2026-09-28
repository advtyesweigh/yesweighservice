/**
 * Durable local cache for logistics package photos.
 * Captures are written here immediately so a refresh / failed upload
 * never forces reopening a sealed package to retake the inside photo.
 */

const DB_NAME = 'yesweigh-logistics-photos';
const DB_VERSION = 1;
const STORE = 'photos';

export type LogisticsVaultPhotoKind = 'box' | 'final';

export interface LogisticsVaultPhoto {
  /** Primary key — draft photo id (or `final-${sessionKey}`). */
  photoId: string;
  /** Stable wizard session key (temp-* until booking id exists). */
  sessionKey: string;
  bookingId: string | null;
  boxId: string | null;
  kind: LogisticsVaultPhotoKind;
  dataUrl: string;
  storagePath: string | null;
  consignmentNo: string;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open photo vault.'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'photoId' });
        store.createIndex('sessionKey', 'sessionKey', { unique: false });
        store.createIndex('bookingId', 'bookingId', { unique: false });
      }
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export async function putLogisticsVaultPhoto(photo: LogisticsVaultPhoto): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await requestToPromise(tx.objectStore(STORE).put(photo));
    db.close();
  } catch {
    // Best-effort — in-memory draft remains the live preview.
  }
}

export async function patchLogisticsVaultPhoto(
  photoId: string,
  patch: Partial<Pick<LogisticsVaultPhoto, 'bookingId' | 'storagePath' | 'dataUrl' | 'consignmentNo' | 'sessionKey'>>,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = await requestToPromise(store.get(photoId)) as LogisticsVaultPhoto | undefined;
    if (!existing) {
      db.close();
      return;
    }
    await requestToPromise(store.put({ ...existing, ...patch }));
    db.close();
  } catch {
    // ignore
  }
}

export async function deleteLogisticsVaultPhoto(photoId: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await requestToPromise(tx.objectStore(STORE).delete(photoId));
    db.close();
  } catch {
    // ignore
  }
}

async function getAllByIndex(
  indexName: 'sessionKey' | 'bookingId',
  value: string,
): Promise<LogisticsVaultPhoto[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(indexName);
    const rows = await requestToPromise(index.getAll(value)) as LogisticsVaultPhoto[];
    db.close();
    return rows ?? [];
  } catch {
    return [];
  }
}

async function getAllVaultPhotos(): Promise<LogisticsVaultPhoto[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const rows = await requestToPromise(tx.objectStore(STORE).getAll()) as LogisticsVaultPhoto[];
    db.close();
    return rows ?? [];
  } catch {
    return [];
  }
}

/** Unuploaded captures from a closed wizard. Newest session on this phone only. */
const UNUPLOADED_VAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export async function listLatestUnuploadedVaultSession(): Promise<LogisticsVaultPhoto[]> {
  const cutoff = Date.now() - UNUPLOADED_VAULT_MAX_AGE_MS;
  const rows = (await getAllVaultPhotos()).filter(row => (
    !row.storagePath?.trim()
    && row.dataUrl.startsWith('data:')
    && !row.bookingId
    && row.createdAt >= cutoff
  ));
  if (!rows.length) return [];
  const bySession = new Map<string, LogisticsVaultPhoto[]>();
  for (const row of rows) {
    const key = row.sessionKey.trim() || row.photoId;
    const list = bySession.get(key) ?? [];
    list.push(row);
    bySession.set(key, list);
  }
  let best: LogisticsVaultPhoto[] = [];
  let bestAt = -1;
  for (const list of bySession.values()) {
    const latest = list.reduce((max, row) => Math.max(max, row.createdAt), 0);
    if (latest > bestAt) {
      bestAt = latest;
      best = list;
    }
  }
  return best.sort((a, b) => a.createdAt - b.createdAt);
}

/** Load vault photos for a booking and/or wizard session. */
export async function listLogisticsVaultPhotos(options: {
  bookingId?: string | null;
  sessionKey?: string | null;
}): Promise<LogisticsVaultPhoto[]> {
  const byId = new Map<string, LogisticsVaultPhoto>();
  if (options.bookingId?.trim()) {
    for (const row of await getAllByIndex('bookingId', options.bookingId.trim())) {
      byId.set(row.photoId, row);
    }
  }
  if (options.sessionKey?.trim()) {
    for (const row of await getAllByIndex('sessionKey', options.sessionKey.trim())) {
      byId.set(row.photoId, row);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
}

/** Point all session photos at the real booking id once the draft is created. */
export async function bindLogisticsVaultSessionToBooking(
  sessionKey: string,
  bookingId: string,
): Promise<void> {
  const rows = await listLogisticsVaultPhotos({ sessionKey });
  await Promise.all(rows.map(row => patchLogisticsVaultPhoto(row.photoId, {
    bookingId,
    sessionKey: bookingId,
  })));
}

/** Drop vault rows that are already linked in Storage (keep unuploaded captures). */
export async function clearUploadedLogisticsVaultPhotos(options: {
  bookingId?: string | null;
  sessionKey?: string | null;
}): Promise<void> {
  const rows = await listLogisticsVaultPhotos(options);
  await Promise.all(
    rows
      .filter(row => row.storagePath?.trim())
      .map(row => deleteLogisticsVaultPhoto(row.photoId)),
  );
}

function photoSessionStorage(): Storage | null {
  // localStorage survives APK process death; sessionStorage often does not.
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  return null;
}

export function logisticsPhotoSessionKey(
  existingBookingId: string | null | undefined,
  partnerId: string,
): string {
  if (existingBookingId?.trim()) return existingBookingId.trim();
  const storageKey = `logistics-photo-session:${partnerId}`;
  const fromLocal = typeof localStorage !== 'undefined'
    ? localStorage.getItem(storageKey)?.trim()
    : '';
  const fromSession = typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(storageKey)?.trim()
    : '';
  const existing = fromLocal || fromSession;
  if (existing) {
    rememberLogisticsPhotoSessionKey(partnerId, existing);
    return existing;
  }
  const created = `temp-${partnerId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  rememberLogisticsPhotoSessionKey(partnerId, created);
  return created;
}

export function rememberLogisticsPhotoSessionKey(partnerId: string, sessionKey: string): void {
  const storage = photoSessionStorage();
  if (!storage) return;
  storage.setItem(`logistics-photo-session:${partnerId}`, sessionKey);
}

export function forgetLogisticsPhotoSessionKey(partnerId: string): void {
  try {
    localStorage?.removeItem(`logistics-photo-session:${partnerId}`);
    sessionStorage?.removeItem(`logistics-photo-session:${partnerId}`);
  } catch {
    // ignore
  }
}
