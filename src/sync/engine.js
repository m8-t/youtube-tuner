import { DEFAULT_CONFIG } from '../rules/defaults.js';
import {
  CryptoError,
  decrypt,
  deriveKey,
  encrypt,
  parseHeader,
} from './crypto.js';
import {
  clearWatched,
  createActorId,
  createClock,
  normalizeDocument,
  recordWatched,
  setBlocklistEntry,
  setConfigField,
  setManualSub,
  setOverride,
} from './document.js';
import { merge } from './merge.js';
import { docToStorage, storageToDoc } from './project.js';
import { ConflictError } from './webdav.js';

const SYNC_DOC_KEY = 'syncDoc';
const SYNC_META_KEY = 'syncMeta';
const SYNC_SETTINGS_KEY = 'syncSettings';
const DEFAULT_META = Object.freeze({
  revision: null,
  lastSyncAt: null,
  lastError: null,
  dirty: false,
});
const MAX_WRITE_ATTEMPTS = 3;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function mergeConfig(defaults, stored) {
  const output = isObject(defaults) ? clone(defaults) : {};
  if (!isObject(stored)) return output;
  for (const [key, value] of Object.entries(stored)) {
    output[key] = isObject(value) && isObject(defaults?.[key])
      ? mergeConfig(defaults[key], value)
      : clone(value);
  }
  return output;
}

function withoutUpdateCheck(config) {
  const output = clone(config);
  delete output.updateCheck;
  return output;
}

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && equal(left[key], right[key])
    ));
}

function documentsEqual(left, right) {
  return equal(normalizeDocument(left), normalizeDocument(right));
}

function timestampFrom(now) {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('now must return a non-negative integer timestamp');
  }
  return timestamp;
}

function normalizeMeta(value) {
  return {
    ...DEFAULT_META,
    ...(isObject(value) ? value : {}),
  };
}

function configured(settings) {
  return isObject(settings)
    && typeof settings.url === 'string'
    && settings.url.trim().length > 0;
}

function conflict(error) {
  return error instanceof ConflictError
    || error?.name === 'ConflictError'
    || error?.status === 412;
}

function errorMessage(error) {
  if (error instanceof CryptoError) {
    return 'wrong passphrase or corrupt data';
  }
  if (
    error?.authFailure === true
    || error?.status === 401
    || error?.status === 403
  ) {
    return 'WebDAV credentials were rejected';
  }
  if (typeof error?.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return 'Sync failed';
}

function capabilityError(capabilities) {
  if (capabilities?.authOk === false) {
    return 'WebDAV credentials were rejected';
  }
  if (capabilities?.cas === false) {
    return capabilities.failure
      ?? 'WebDAV server does not support safe compare-and-swap';
  }
  if (capabilities?.strongEtags === false) {
    return capabilities.failure
      ?? 'WebDAV server does not provide strong ETags';
  }
  return capabilities?.failure ?? 'WebDAV capability check failed';
}

function clockCounter(doc, timestamp) {
  let counter = 0;
  for (const field of ['configFields', 'overrides', 'blocklist', 'manualSubs']) {
    for (const entry of Object.values(doc[field] ?? {})) {
      if (
        entry.clock?.actorId === doc.actorId
        && entry.clock.ts === timestamp
      ) {
        counter = Math.max(counter, entry.clock.counter);
      }
    }
  }
  return counter;
}

function asStoredOverrides(overrides) {
  return Object.fromEntries(overrides);
}

function storedCollection(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

function asSet(value) {
  return new Set(storedCollection(value));
}

function setsEqual(left, right) {
  return left.size === right.size
    && [...left].every((value) => right.has(value));
}

export function createSyncEngine({
  storage,
  backendFactory,
  keyStore,
  now = Date.now,
  log = console,
} = {}) {
  if (!storage?.local || !storage?.sync) {
    throw new TypeError('storage.local and storage.sync are required');
  }
  if (typeof backendFactory !== 'function') {
    throw new TypeError('backendFactory must be a function');
  }
  if (
    typeof keyStore?.saveKey !== 'function'
    || typeof keyStore?.loadKey !== 'function'
    || typeof keyStore?.clearKey !== 'function'
  ) {
    throw new TypeError('keyStore is invalid');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function report(error) {
    try {
      if (typeof log === 'function') log(error);
      else log?.warn?.('[youtube-tuner] sync failed', error);
    } catch {
      // Logging must never replace the original sync result.
    }
  }

  async function readPrivateState() {
    const stored = await storage.local.get([
      SYNC_DOC_KEY,
      SYNC_META_KEY,
      SYNC_SETTINGS_KEY,
    ]);
    return {
      doc: stored[SYNC_DOC_KEY] ?? null,
      meta: normalizeMeta(stored[SYNC_META_KEY]),
      settings: stored[SYNC_SETTINGS_KEY] ?? null,
    };
  }

  async function readProjectedState() {
    const [synced, local] = await Promise.all([
      storage.sync.get(['config', 'channelOverrides']),
      storage.local.get(['blocklist', 'manualSubs', 'watched']),
    ]);
    const overrides = synced.channelOverrides;
    return {
      config: mergeConfig(DEFAULT_CONFIG, synced.config),
      overrides: overrides instanceof Map || isObject(overrides)
        ? overrides
        : {},
      blocklist: storedCollection(local.blocklist),
      manualSubs: storedCollection(local.manualSubs),
      watched: storedCollection(local.watched),
    };
  }

  async function writeMeta(nextMeta) {
    const stored = await storage.local.get(SYNC_META_KEY);
    const current = normalizeMeta(stored[SYNC_META_KEY]);
    const next = normalizeMeta(nextMeta);
    if (!equal(current, next) || stored[SYNC_META_KEY] === undefined) {
      await storage.local.set({ [SYNC_META_KEY]: next });
    }
    return next;
  }

  async function patchMeta(patch) {
    const stored = await storage.local.get(SYNC_META_KEY);
    return writeMeta({
      ...normalizeMeta(stored[SYNC_META_KEY]),
      ...patch,
    });
  }

  async function persistDocument(doc) {
    const normalized = normalizeDocument(doc);
    const stored = await storage.local.get(SYNC_DOC_KEY);
    if (
      stored[SYNC_DOC_KEY] === undefined
      || !documentsEqual(stored[SYNC_DOC_KEY], normalized)
    ) {
      await storage.local.set({ [SYNC_DOC_KEY]: normalized });
      return true;
    }
    return false;
  }

  function storageSnapshotToDoc(state, actorId, timestamp) {
    return storageToDoc(
      state.config,
      state.overrides,
      state.blocklist,
      state.manualSubs,
      state.watched,
      actorId ?? createActorId(),
      timestamp,
    );
  }

  function demoteSnapshotClocks(doc) {
    const fields = ['configFields', 'overrides', 'blocklist', 'manualSubs'];
    for (const field of fields) {
      for (const entry of Object.values(doc[field])) {
        entry.clock = createClock(0, entry.clock.counter, doc.actorId);
      }
    }
    return doc;
  }

  async function capture(timestamp = timestampFrom(now)) {
    const [privateState, projectedState] = await Promise.all([
      readPrivateState(),
      readProjectedState(),
    ]);

    if (privateState.doc === null) {
      const initial = storageSnapshotToDoc(
        projectedState,
        undefined,
        timestamp,
      );
      await persistDocument(initial);
      await patchMeta({ dirty: true });
      return { doc: initial, changed: true };
    }

    let doc = normalizeDocument(privateState.doc);
    const before = normalizeDocument(doc);
    const snapshot = storageSnapshotToDoc(
      projectedState,
      doc.actorId,
      timestamp,
    );
    let counter = clockCounter(doc, timestamp);
    const nextClock = () => createClock(
      timestamp,
      counter += 1,
      doc.actorId,
    );

    for (const [path, entry] of Object.entries(snapshot.configFields)) {
      if (!equal(doc.configFields[path]?.value, entry.value)) {
        setConfigField(doc, path, entry.value, nextClock());
      }
    }

    for (const [name, entry] of Object.entries(snapshot.overrides)) {
      if (!equal(doc.overrides[name]?.value, entry.value)) {
        setOverride(doc, name, entry.value, nextClock());
      }
    }
    for (const [name, entry] of Object.entries(doc.overrides)) {
      if (entry.value !== null && !Object.hasOwn(snapshot.overrides, name)) {
        setOverride(doc, name, null, nextClock());
      }
    }

    for (const field of ['blocklist', 'manualSubs']) {
      const setter = field === 'blocklist' ? setBlocklistEntry : setManualSub;
      for (const name of Object.keys(snapshot[field])) {
        if (doc[field][name]?.present !== true) {
          setter(doc, name, true, nextClock());
        }
      }
      for (const [name, entry] of Object.entries(doc[field])) {
        if (entry.present && !Object.hasOwn(snapshot[field], name)) {
          setter(doc, name, false, nextClock());
        }
      }
    }

    const projectedWatched = new Set(docToStorage(doc).watched);
    const storedWatched = Object.keys(snapshot.watched);
    if (storedWatched.length === 0 && projectedWatched.size > 0) {
      clearWatched(doc, timestamp, nextClock());
    } else {
      for (const id of storedWatched) {
        if (!projectedWatched.has(id)) {
          recordWatched(doc, id, timestamp, nextClock());
        }
      }
    }

    doc = merge(doc, doc, timestamp);
    const changed = !documentsEqual(before, doc);
    if (changed) {
      await persistDocument(doc);
      await patchMeta({ dirty: true });
    }
    return { doc, changed };
  }

  async function captureLocalChanges() {
    return (await capture()).doc;
  }

  async function applyProjection(doc) {
    const state = await readProjectedState();
    const normalizedSnapshot = storageSnapshotToDoc(
      state,
      doc.actorId,
      timestampFrom(now),
    );
    const current = docToStorage(normalizedSnapshot);
    const desired = docToStorage(doc);
    const syncWrites = {};
    const localWrites = {};

    const desiredConfig = mergeConfig(DEFAULT_CONFIG, desired.configOverlay);
    desiredConfig.updateCheck = clone(state.config.updateCheck);
    if (!equal(
      withoutUpdateCheck(state.config),
      withoutUpdateCheck(desiredConfig),
    )) {
      syncWrites.config = desiredConfig;
    }

    const currentOverrides = asStoredOverrides(current.channelOverrides);
    const desiredOverrides = asStoredOverrides(desired.channelOverrides);
    if (!equal(currentOverrides, desiredOverrides)) {
      syncWrites.channelOverrides = desiredOverrides;
    }

    if (!setsEqual(asSet(current.blocklist), asSet(desired.blocklist))) {
      localWrites.blocklist = desired.blocklist;
    }
    if (!setsEqual(asSet(current.manualSubs), asSet(desired.manualSubs))) {
      localWrites.manualSubs = desired.manualSubs;
    }
    if (!equal(current.watched, desired.watched)) {
      localWrites.watched = desired.watched;
    }

    await Promise.all([
      Object.keys(syncWrites).length > 0
        ? storage.sync.set(syncWrites)
        : Promise.resolve(),
      Object.keys(localWrites).length > 0
        ? storage.local.set(localWrites)
        : Promise.resolve(),
    ]);
    return Object.keys(syncWrites).length > 0
      || Object.keys(localWrites).length > 0;
  }

  async function saveAndProject(doc) {
    const documentChanged = await persistDocument(doc);
    const projectionChanged = await applyProjection(doc);
    return documentChanged || projectionChanged;
  }

  async function decryptRemote(remote, key) {
    if (remote === null) return null;
    return decrypt(remote.blob ?? remote.doc, key);
  }

  async function fail(error, { dirty = true } = {}) {
    const message = errorMessage(error);
    report(error);
    await patchMeta({ lastError: message, dirty });
    return { error: message };
  }

  async function runSync({ force = false } = {}) {
    void force;
    try {
      const timestamp = timestampFrom(now);
      const privateState = await readPrivateState();
      if (
        privateState.settings?.enabled !== true
        || !configured(privateState.settings)
      ) {
        return { ok: true, changed: false };
      }

      const savedKey = await keyStore.loadKey();
      if (savedKey === null) {
        throw new Error('Sync encryption key is missing; enable sync again');
      }
      const backend = await backendFactory(privateState.settings);
      const captured = await capture(timestamp);
      let merged = captured.doc;
      let changed = captured.changed;
      const storedRevision = privateState.meta.revision;
      const hasStoredRevision = typeof storedRevision === 'string'
        && storedRevision.length > 0;
      let remote = hasStoredRevision
        ? await backend.read({ ifNoneMatch: storedRevision })
        : await backend.read();
      const remoteUnchanged = remote?.unchanged === true;
      let remoteDoc = remoteUnchanged
        ? null
        : await decryptRemote(remote, savedKey.key);
      let revision = remoteUnchanged
        ? storedRevision
        : remote?.revision ?? null;

      if (!remoteUnchanged && remoteDoc !== null) {
        merged = merge(merged, remoteDoc, timestamp);
      }
      if (!remoteUnchanged) {
        changed = await saveAndProject(merged) || changed;
      }

      let needsWrite = remoteUnchanged
        ? captured.changed || privateState.meta.dirty
        : remoteDoc === null || !documentsEqual(merged, remoteDoc);
      let writeAttempts = 0;
      while (needsWrite) {
        writeAttempts += 1;
        try {
          const blob = await encrypt(merged, savedKey.key);
          revision = await backend.write(blob, revision);
          changed = true;
          needsWrite = false;
        } catch (error) {
          if (!conflict(error)) throw error;
          if (writeAttempts >= MAX_WRITE_ATTEMPTS) {
            throw new Error('Sync conflict retry limit reached', {
              cause: error,
            });
          }

          remote = await backend.read();
          remoteDoc = await decryptRemote(remote, savedKey.key);
          revision = remote?.revision ?? null;
          if (remoteDoc !== null) {
            merged = merge(merged, remoteDoc, timestamp);
          }
          changed = await saveAndProject(merged) || changed;
          needsWrite = remoteDoc === null
            || !documentsEqual(merged, remoteDoc);
        }
      }

      await persistDocument(merged);
      await writeMeta({
        revision,
        lastSyncAt: timestamp,
        lastError: null,
        dirty: false,
      });
      return { ok: true, changed };
    } catch (error) {
      return fail(error);
    }
  }

  async function bootstrap(docOrNull) {
    const timestamp = timestampFrom(now);
    const [privateState, projectedState] = await Promise.all([
      readPrivateState(),
      readProjectedState(),
    ]);
    const remote = docOrNull === null
      ? null
      : normalizeDocument(docOrNull);
    let doc;

    if (privateState.doc !== null) {
      doc = normalizeDocument(privateState.doc);
      if (remote !== null) doc = merge(doc, remote, timestamp);
    } else if (remote !== null) {
      const snapshot = storageSnapshotToDoc(
        projectedState,
        undefined,
        timestamp,
      );
      doc = merge(demoteSnapshotClocks(snapshot), remote, timestamp);
    } else {
      doc = storageSnapshotToDoc(projectedState, undefined, timestamp);
    }

    const documentChanged = await persistDocument(doc);
    const projectionChanged = remote === null
      ? false
      : await applyProjection(doc);
    const differsFromRemote = remote === null
      || !documentsEqual(doc, remote);
    await patchMeta({
      dirty: differsFromRemote,
      ...(documentChanged || projectionChanged ? { lastError: null } : {}),
    });
    return doc;
  }

  async function enable(settings, passphrase) {
    try {
      const savedSettings = {
        enabled: true,
        url: settings?.url ?? '',
        username: settings?.username ?? '',
        password: settings?.password ?? '',
      };
      if (!configured(savedSettings)) {
        return { error: 'A WebDAV URL is required' };
      }

      const backend = await backendFactory(savedSettings);
      const capabilities = await backend.test();
      if (!capabilities?.ok) {
        return { error: capabilityError(capabilities) };
      }

      const remote = await backend.read();
      let salt;
      let iters;
      if (remote === null) {
        if (typeof globalThis.crypto?.getRandomValues !== 'function') {
          throw new CryptoError('WebCrypto is unavailable');
        }
        salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
      } else {
        ({ salt, iters } = parseHeader(remote.blob ?? remote.doc));
      }
      const key = await deriveKey(passphrase, salt, iters);
      const remoteDoc = await decryptRemote(remote, key);

      await keyStore.saveKey({ key, salt, iters: iters ?? 600_000 });
      await storage.local.set({
        [SYNC_SETTINGS_KEY]: savedSettings,
        [SYNC_META_KEY]: {
          revision: remote?.revision ?? null,
          lastSyncAt: null,
          lastError: null,
          dirty: remote === null,
        },
      });
      await bootstrap(remoteDoc);
      const result = await runSync({ force: true });
      return result.error ? result : { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      report(error);
      return { error: message };
    }
  }

  async function disable() {
    await Promise.all([
      storage.local.remove([
        SYNC_SETTINGS_KEY,
        SYNC_DOC_KEY,
        SYNC_META_KEY,
      ]),
      keyStore.clearKey(),
    ]);
    return { ok: true };
  }

  async function status() {
    const { settings, meta } = await readPrivateState();
    return {
      enabled: settings?.enabled === true,
      configured: configured(settings),
      lastSyncAt: meta.lastSyncAt,
      lastError: meta.lastError,
    };
  }

  return {
    captureLocalChanges,
    runSync,
    bootstrap,
    enable,
    disable,
    status,
  };
}
