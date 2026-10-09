/**
 * Phone-ready display cache. IndexedDB survives app kill and poor networks;
 * memory + sessionStorage stay the sync first paint.
 */

const DB_NAME = 'yesweigh-display-cache';
const DB_VERSION = 1;
const STORE = 'kv';

export const DISPLAY_CACHE_KEYS = {
  catalog: 'catalog.v3',
  dealers: 'dealers.v3',
  softwareShops: 'softwareShops.v1',
} as const;

type Envelope<T> = {
  savedAt: number;
  data: T;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Could not open display cache.'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export async function displayCacheGet<T>(key: string): Promise<Envelope<T> | null> {
  try {
    const db = await openDb();
    const raw = await requestToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Envelope<T>;
    if (typeof entry.savedAt !== 'number' || entry.data === undefined) return null;
    return entry;
  } catch {
    return null;
  }
}

export function displayCacheSet<T>(key: string, data: T): void {
  const entry: Envelope<T> = { savedAt: Date.now(), data };
  void openDb()
    .then(db => requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, key)))
    .catch(() => undefined);
}

export function displayCacheRemove(key: string): void {
  void openDb()
    .then(db => requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)))
    .catch(() => undefined);
}

export function displayCacheRemovePrefix(prefix: string): void {
  void openDb()
    .then(async db => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const keys = await requestToPromise(store.getAllKeys());
      await Promise.all(
        keys
          .filter(item => String(item).startsWith(prefix))
          .map(item => requestToPromise(store.delete(item))),
      );
    })
    .catch(() => undefined);
}
