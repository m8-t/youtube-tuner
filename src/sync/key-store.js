import { attachKeyMetadata } from './crypto.js';

const DATABASE_NAME = 'youtube-tuner-sync';
const DATABASE_VERSION = 1;
const STORE_NAME = 'keys';
const ACTIVE_KEY_ID = 'active';

function indexedDbFrom(options) {
  if (options?.open && typeof options.open === 'function') return options;
  return options?.indexedDB ?? globalThis.indexedDB;
}

function requireIndexedDb(indexedDB) {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw new Error('IndexedDB is unavailable');
  }
  return indexedDB;
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  throw new TypeError('salt must be binary data');
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = requireIndexedDb(indexedDB).open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('Failed to open sync key database'),
    );
  });
}

async function withStore(indexedDB, mode, operation) {
  const database = await openDatabase(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(
        request.error ?? new Error('Sync key database request failed'),
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(
        transaction.error ?? new Error('Sync key database transaction failed'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('Sync key database transaction aborted'),
      );
    });
  } finally {
    database.close();
  }
}

export function createKeyStore(options = {}) {
  const indexedDB = indexedDbFrom(options);

  async function saveKey({ key, salt, iters }) {
    if (key?.extractable !== false) {
      throw new TypeError('Sync encryption key must be non-extractable');
    }
    attachKeyMetadata(key, salt, iters);
    await withStore(indexedDB, 'readwrite', (store) => store.put({
      id: ACTIVE_KEY_ID,
      key,
      salt: copyBytes(salt),
      iters,
    }));
  }

  async function loadKey() {
    const stored = await withStore(
      indexedDB,
      'readonly',
      (store) => store.get(ACTIVE_KEY_ID),
    );
    if (stored === undefined) return null;
    const salt = copyBytes(stored.salt);
    attachKeyMetadata(stored.key, salt, stored.iters);
    return {
      key: stored.key,
      salt,
      iters: stored.iters,
    };
  }

  async function clearKey() {
    await withStore(
      indexedDB,
      'readwrite',
      (store) => store.delete(ACTIVE_KEY_ID),
    );
  }

  return { saveKey, loadKey, clearKey };
}

export function saveKey(record, options) {
  return createKeyStore(options).saveKey(record);
}

export function loadKey(options) {
  return createKeyStore(options).loadKey();
}

export function clearKey(options) {
  return createKeyStore(options).clearKey();
}
