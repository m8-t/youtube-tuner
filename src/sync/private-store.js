// Sync secrets (WebDAV credentials, sync document, sync state) live here and
// not in chrome.storage: IndexedDB of the extension origin is unreachable from
// content scripts, chrome.storage is reachable from them by default.
const DATABASE_NAME = 'youtube-tuner-private';
const DATABASE_VERSION = 1;
const STORE_NAME = 'values';

export const PRIVATE_KEYS = Object.freeze([
  'syncDoc',
  'syncMeta',
  'syncSettings',
]);

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB || typeof indexedDB.open !== 'function') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('Failed to open private database'),
    );
  });
}

async function transact(indexedDB, mode, operation) {
  const database = await openDatabase(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;
      try {
        result = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(
        transaction.error ?? new Error('Private database transaction failed'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('Private database transaction aborted'),
      );
    });
  } finally {
    database.close();
  }
}

function keyList(keys) {
  return Array.isArray(keys) ? keys : [keys];
}

// Same get/set/remove shape as a chrome.storage area, so the sync engine can
// take either.
export function createPrivateStore({
  indexedDB = globalThis.indexedDB,
} = {}) {
  async function get(keys) {
    const output = {};
    await transact(indexedDB, 'readonly', (store) => {
      for (const key of keyList(keys)) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result !== undefined) output[key] = request.result;
        };
      }
    });
    return output;
  }

  async function set(items) {
    await transact(indexedDB, 'readwrite', (store) => {
      for (const [key, value] of Object.entries(items)) store.put(value, key);
    });
  }

  async function remove(keys) {
    await transact(indexedDB, 'readwrite', (store) => {
      for (const key of keyList(keys)) store.delete(key);
    });
  }

  return { get, set, remove };
}

// Versions up to 1.7.0 kept these keys in chrome.storage.local. Move them
// once; a value already present in the private store wins.
export async function migrateLegacySyncState({ legacyArea, privateStore }) {
  const legacy = await legacyArea.get([...PRIVATE_KEYS]);
  const present = PRIVATE_KEYS.filter((key) => legacy[key] !== undefined);
  if (present.length === 0) return false;

  const existing = await privateStore.get(present);
  const moved = {};
  for (const key of present) {
    if (existing[key] === undefined) moved[key] = legacy[key];
  }
  if (Object.keys(moved).length > 0) await privateStore.set(moved);
  await legacyArea.remove(present);
  return true;
}

// Every operation waits for the one-time migration, so the engine never sees
// an empty store while legacy data is still in chrome.storage.
export function createMigratedPrivateStore({
  legacyArea,
  privateStore = createPrivateStore(),
  onError = () => {},
} = {}) {
  let ready = null;
  function whenReady() {
    ready ??= migrateLegacySyncState({ legacyArea, privateStore })
      .catch((error) => {
        try { onError(error); } catch {}
      });
    return ready;
  }
  return {
    ready: whenReady,
    async get(keys) {
      await whenReady();
      return privateStore.get(keys);
    },
    async set(items) {
      await whenReady();
      return privateStore.set(items);
    },
    async remove(keys) {
      await whenReady();
      return privateStore.remove(keys);
    },
  };
}
