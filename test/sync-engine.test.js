import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { decrypt, deriveKey, encrypt } from '../src/sync/crypto.js';
import {
  createClock,
  setBlocklistEntry,
  setConfigField,
} from '../src/sync/document.js';
import { createKeyStore } from '../src/sync/key-store.js';
import { storageToDoc } from '../src/sync/project.js';
import { ConflictError } from '../src/sync/webdav.js';

const NOW = 2_000_000_000_000;
const SETTINGS = {
  enabled: true,
  url: 'https://dav.example/youtube-tuner.bin',
  username: 'alice',
  password: 'secret',
};
const CAPABILITIES = {
  ok: true,
  strongEtags: true,
  cas: true,
  authOk: true,
  failure: null,
};
const DEFAULT_META = {
  revision: null,
  lastSyncAt: null,
  lastError: null,
  dirty: false,
};

function copy(value) {
  return structuredClone(value);
}

// `settings` holds config and channelOverrides. They live in the same
// storage area as everything else; the split only keeps the tests readable.
function fakeStorage({ settings = {}, local = {} } = {}) {
  const values = { local: { ...copy(settings), ...copy(local) } };
  const writes = { local: [] };
  const area = (name) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return copy(values[name]);
      const output = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in values[name]) output[key] = copy(values[name][key]);
      }
      return output;
    },
    async set(items) {
      writes[name].push(copy(items));
      Object.assign(values[name], copy(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[name][key];
      }
    },
  });
  return {
    local: area('local'),
    values,
    writes,
  };
}

function fakeKeyStore(initial = null) {
  let record = initial;
  let cleared = false;
  return {
    async saveKey(value) {
      record = value;
    },
    async loadKey() {
      return record;
    },
    async clearKey() {
      record = null;
      cleared = true;
    },
    get record() {
      return record;
    },
    get cleared() {
      return cleared;
    },
  };
}

function fakeIndexedDb() {
  let created = false;
  let record;

  function requestFor(transaction, action) {
    const request = {};
    queueMicrotask(() => {
      request.result = action();
      request.onsuccess?.();
      transaction.oncomplete?.();
    });
    return request;
  }

  const database = {
    objectStoreNames: {
      contains() {
        return created;
      },
    },
    createObjectStore() {
      created = true;
    },
    transaction() {
      const transaction = {
        objectStore() {
          return {
            put(value) {
              return requestFor(transaction, () => {
                record = copy(value);
                return undefined;
              });
            },
            get() {
              return requestFor(transaction, () => copy(record));
            },
            delete() {
              return requestFor(transaction, () => {
                record = undefined;
                return undefined;
              });
            },
          };
        },
      };
      return transaction;
    },
    close() {},
  };

  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function makeEngine({
  storage,
  backend,
  keyStore = fakeKeyStore(),
  now = () => NOW,
  minIterations = 1000,
  minPassphraseLength = 1,
}) {
  return createSyncEngine({
    storage,
    backendFactory: () => backend,
    keyStore,
    now,
    log: () => {},
    // Production floors are 600000 iterations and 12 characters; the tests
    // derive keys with 1000 iterations to stay fast.
    minIterations,
    minPassphraseLength,
  });
}

async function encryptionKey(
  passphrase = 'passphrase',
  salt = new Uint8Array(32),
) {
  return deriveKey(passphrase, salt, 1000);
}

test('key store reload restores encryption metadata on a cloned CryptoKey', async () => {
  const indexedDB = fakeIndexedDb();
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index);
  const key = await encryptionKey('stored key', salt);
  await createKeyStore({ indexedDB }).saveKey({ key, salt, iters: 1000 });

  const loaded = await createKeyStore(indexedDB).loadKey();
  assert.notEqual(loaded.key, key);
  assert.deepEqual(loaded.salt, salt);
  assert.equal(loaded.iters, 1000);

  const doc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW,
  );
  assert.deepEqual(await decrypt(await encrypt(doc, loaded.key), loaded.key), doc);

  await createKeyStore(indexedDB).clearKey();
  assert.equal(await createKeyStore(indexedDB).loadKey(), null);
});

test('capture diffs maps, sets, overrides, watched appends, and watched clears', async () => {
  let time = NOW;
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {
        'Channel A': { watched: { enabled: true } },
      },
    },
    local: {
      blocklist: ['Blocked A'],
      manualSubs: ['Manual A'],
      watched: ['old-video'],
    },
  });
  const engine = makeEngine({
    storage,
    backend: {},
    now: () => time,
  });
  await engine.bootstrap(null);

  time += 10;
  storage.values.local.config.viewRule.minViews = 321;
  storage.values.local.channelOverrides = {
    'Channel A': { watched: { enabled: false } },
    'Channel B': { age: { enabled: true, maxAgeDays: 7 } },
  };
  storage.values.local.blocklist = ['Blocked B'];
  storage.values.local.manualSubs = ['Manual B'];
  storage.values.local.watched.push('new-video');

  let doc = await engine.captureLocalChanges();
  assert.equal(doc.configFields['viewRule.minViews'].value, 321);
  assert.deepEqual(
    doc.overrides['Channel A'].value,
    { watched: { enabled: false } },
  );
  assert.deepEqual(
    doc.overrides['Channel B'].value,
    { age: { enabled: true, maxAgeDays: 7 } },
  );
  assert.equal(doc.blocklist['Blocked A'].present, false);
  assert.equal(doc.blocklist['Blocked B'].present, true);
  assert.equal(doc.manualSubs['Manual A'].present, false);
  assert.equal(doc.manualSubs['Manual B'].present, true);
  assert.equal(doc.watched['new-video'].lastSeen, time);

  time += 10;
  storage.values.local.channelOverrides = {
    'Channel B': { age: { enabled: true, maxAgeDays: 7 } },
  };
  doc = await engine.captureLocalChanges();
  assert.equal(doc.overrides['Channel A'].value, null);

  time += 10;
  storage.values.local.watched = [];
  doc = await engine.captureLocalChanges();
  assert.equal(doc.clearedBefore, time);
  assert.deepEqual(doc.watched, {});
});

test('capture ignores oldest-at-cap watched eviction as an explicit delete', async () => {
  let time = NOW;
  const watched = Array.from({ length: 5000 }, (_, index) => `video-${index}`);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {},
    now: () => time,
  });
  await engine.bootstrap(null);

  time += 10_000;
  storage.values.local.watched = [...watched.slice(1), 'video-new'];
  const doc = await engine.captureLocalChanges();
  assert.equal(Object.keys(doc.watched).length, 5000);
  assert.equal(doc.watched['video-0'], undefined);
  assert.equal(doc.watched['video-new'].lastSeen, time);
  assert.ok(doc.prunedBefore > 0);
});

test('runSync happy path uploads local state and persists success metadata', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncSettings: SETTINGS,
    },
  });
  const writes = [];
  const readCalls = [];
  const backend = {
    async read(...args) {
      readCalls.push(args);
      return null;
    },
    async write(blob, revision) {
      writes.push({ blob, revision });
      return '"revision-1"';
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(
    await engine.runSync(),
    { ok: true, changed: true },
  );
  assert.deepEqual(readCalls, [[]]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, null);
  const uploaded = await decrypt(writes[0].blob, key);
  assert.equal(uploaded.configFields.enabled.value, true);
  assert.deepEqual(storage.values.local.syncMeta, {
    revision: '"revision-1"',
    lastSyncAt: NOW,
    lastError: null,
    dirty: false,
  });
});

test('304 with clean local state only updates sync metadata', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const revision = '"revision-1"';
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 10,
  );
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: {
        revision,
        lastSyncAt: NOW - 100,
        lastError: null,
        dirty: false,
      },
      syncSettings: SETTINGS,
    },
  });
  const readCalls = [];
  const backend = {
    async read(...args) {
      readCalls.push(args);
      return { unchanged: true, revision };
    },
    async write() {
      assert.fail('an unchanged clean cycle must not upload');
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.deepEqual(readCalls, [[{ ifNoneMatch: revision }]]);
  assert.deepEqual(
    storage.writes.local.filter((write) => (
      'config' in write || 'channelOverrides' in write
    )),
    [],
  );
  assert.deepEqual(storage.writes.local, [{
    syncMeta: {
      revision,
      lastSyncAt: NOW,
      lastError: null,
      dirty: false,
    },
  }]);
});

test('304 uploads newly captured local changes with the stored revision', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const revision = '"revision-1"';
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 10,
  );
  const storage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: { ...DEFAULT_META, revision },
      syncSettings: SETTINGS,
    },
  });
  const writes = [];
  const backend = {
    async read(options) {
      assert.deepEqual(options, { ifNoneMatch: revision });
      return { unchanged: true, revision };
    },
    async write(blob, writeRevision) {
      writes.push({ blob, revision: writeRevision });
      return '"revision-2"';
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, revision);
  const uploaded = await decrypt(writes[0].blob, key);
  assert.equal(uploaded.configFields.enabled.value, false);
});

test('304 uploads an already-dirty document without a new capture diff', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const revision = '"revision-1"';
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 10,
  );
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: { ...DEFAULT_META, revision, dirty: true },
      syncSettings: SETTINGS,
    },
  });
  const writeRevisions = [];
  const backend = {
    async read() {
      return { unchanged: true, revision };
    },
    async write(blob, writeRevision) {
      writeRevisions.push(writeRevision);
      return '"revision-2"';
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.deepEqual(writeRevisions, [revision]);
});

test('304 upload conflict re-reads unconditionally and merges remote changes', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const storedRevision = '"revision-1"';
  const localDoc = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: false },
    {},
    [],
    [],
    [],
    'local-actor',
    NOW - 10,
  );
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 100,
  );
  setBlocklistEntry(
    remoteDoc,
    'Remote Block',
    true,
    createClock(NOW - 1, 1, 'remote-actor'),
  );
  const remoteBlob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: { ...DEFAULT_META, revision: storedRevision, dirty: true },
      syncSettings: SETTINGS,
    },
  });
  const readCalls = [];
  const writeRevisions = [];
  let reads = 0;
  const uploaded = [];
  const backend = {
    async read(...args) {
      readCalls.push(args);
      reads += 1;
      if (reads === 1) {
        return { unchanged: true, revision: storedRevision };
      }
      return { blob: remoteBlob, revision: '"revision-2"' };
    },
    async write(blob, revision) {
      writeRevisions.push(revision);
      if (writeRevisions.length === 1) throw new ConflictError();
      uploaded.push(await decrypt(blob, key));
      return '"revision-3"';
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.deepEqual(readCalls, [
    [{ ifNoneMatch: storedRevision }],
    [],
  ]);
  assert.deepEqual(writeRevisions, [storedRevision, '"revision-2"']);
  assert.equal(uploaded[0].configFields.enabled.value, false);
  assert.equal(uploaded[0].blocklist['Remote Block'].present, true);
  assert.deepEqual(storage.values.local.blocklist, ['Remote Block']);
  assert.equal(storage.values.local.syncMeta.revision, '"revision-3"');
});

test('pull apply followed by an immediate run does not upload', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 10,
  );
  const remoteDoc = copy(localDoc);
  setConfigField(
    remoteDoc,
    'enabled',
    false,
    createClock(NOW - 1, 1, 'actor-a'),
  );
  const blob = await encrypt(remoteDoc, key);
  let writes = 0;
  const backend = {
    async read() {
      return { blob, revision: '"remote"' };
    },
    async write() {
      writes += 1;
      return '"written"';
    },
  };
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: DEFAULT_META,
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.equal(storage.values.local.config.enabled, false);
  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.equal(writes, 0);
});

test('runSync retries two conflicts and succeeds on the third write', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const remoteDoc = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: true },
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 100,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: remoteDoc,
      syncSettings: SETTINGS,
    },
  });
  let reads = 0;
  let writes = 0;
  const backend = {
    async read() {
      reads += 1;
      return { blob, revision: `"revision-${reads}"` };
    },
    async write() {
      writes += 1;
      if (writes < 3) throw new ConflictError();
      return '"revision-final"';
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.equal(reads, 3);
  assert.equal(writes, 3);
  assert.equal(storage.values.local.syncMeta.revision, '"revision-final"');
});

test('runSync records an error after exhausting conflict retries', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 100,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: remoteDoc,
      syncSettings: SETTINGS,
    },
  });
  let writes = 0;
  const backend = {
    async read() {
      return { blob, revision: `"revision-${writes}"` };
    },
    async write() {
      writes += 1;
      throw new ConflictError();
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(
    await engine.runSync(),
    { error: 'Sync conflict retry limit reached' },
  );
  assert.equal(writes, 3);
  assert.equal(
    storage.values.local.syncMeta.lastError,
    'Sync conflict retry limit reached',
  );
  assert.equal(storage.values.local.syncMeta.dirty, true);
});

test('remote clock watermark persists and ratchets upward', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const firstRemote = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 20,
  );
  const secondRemote = copy(firstRemote);
  setConfigField(
    secondRemote,
    'enabled',
    false,
    createClock(NOW - 10, 100, 'remote-actor'),
  );
  const blobs = [
    await encrypt(firstRemote, key),
    await encrypt(secondRemote, key),
  ];
  let reads = 0;
  const backend = {
    async read() {
      const index = Math.min(reads, blobs.length - 1);
      reads += 1;
      return { blob: blobs[index], revision: `"revision-${reads}"` };
    },
    async write() {
      assert.fail('an adopted remote document must not be uploaded');
    },
  };
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: firstRemote,
      syncMeta: DEFAULT_META,
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 20);

  assert.deepEqual(await engine.runSync(), { ok: true, changed: true });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 10);
});

test('remote clock watermark persists when a later upload fails', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const localDoc = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: false },
    {},
    [],
    [],
    [],
    'local-actor',
    NOW - 10,
  );
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    ['Remote Block'],
    [],
    [],
    'remote-actor',
    NOW - 20,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: DEFAULT_META,
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {
      async read() {
        return { blob, revision: '"remote"' };
      },
      async write() {
        throw new Error('upload unavailable');
      },
    },
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { error: 'upload unavailable' });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 20);
});

test('stale remote data is rejected before merge or upload', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'local-actor',
    NOW - 10,
  );
  const staleRemote = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: false },
    {},
    ['Remote Block'],
    [],
    [],
    'remote-actor',
    NOW - 20,
  );
  const blob = await encrypt(staleRemote, key);
  let writes = 0;
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: { ...DEFAULT_META, maxRemoteTs: NOW - 10 },
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {
      async read() {
        return { blob, revision: '"stale"' };
      },
      async write() {
        writes += 1;
      },
    },
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), {
    error: 'remote data is older than previously seen state',
  });
  assert.equal(writes, 0);
  assert.equal(storage.values.local.config.enabled, true);
  assert.deepEqual(storage.values.local.blocklist, []);
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 10);
  assert.equal(
    storage.values.local.syncMeta.lastError,
    'remote data is older than previously seen state',
  );
});

test('remote data at the stored clock watermark is accepted', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 10,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: remoteDoc,
      syncMeta: { ...DEFAULT_META, maxRemoteTs: NOW - 10 },
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {
      async read() {
        return { blob, revision: '"equal"' };
      },
      async write() {
        assert.fail('an equal remote document must not be uploaded');
      },
    },
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 10);
});

test('a first remote pull is trusted without a clock watermark', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 50,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: remoteDoc,
      syncMeta: DEFAULT_META,
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {
      async read() {
        return { blob, revision: '"tofu"' };
      },
      async write() {
        assert.fail('an unchanged first remote must not be uploaded');
      },
    },
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 50);
});

test('304 response preserves the remote clock watermark without a write', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const revision = '"revision-watermarked"';
  const localDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'actor-a',
    NOW - 10,
  );
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncDoc: localDoc,
      syncMeta: {
        ...DEFAULT_META,
        revision,
        maxRemoteTs: NOW - 10,
      },
      syncSettings: SETTINGS,
    },
  });
  const engine = makeEngine({
    storage,
    backend: {
      async read(options) {
        assert.deepEqual(options, { ifNoneMatch: revision });
        return { unchanged: true, revision };
      },
      async write() {
        assert.fail('a clean 304 must not upload');
      },
    },
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
  });

  assert.deepEqual(await engine.runSync(), { ok: true, changed: false });
  assert.equal(storage.values.local.syncMeta.maxRemoteTs, NOW - 10);
});

test('bootstrap rejects a remote document below its clock watermark', async () => {
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 20,
  );
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncMeta: { ...DEFAULT_META, maxRemoteTs: NOW - 10 },
    },
  });

  await assert.rejects(
    makeEngine({ storage, backend: {} }).bootstrap(remoteDoc),
    /remote data is older than previously seen state/,
  );
  assert.equal(storage.values.local.syncDoc, undefined);
  assert.equal(
    storage.values.local.syncMeta.lastError,
    'remote data is older than previously seen state',
  );
});

test('bootstrap keeps local-only fields while remote config conflicts win', async () => {
  const remote = storageToDoc(
    { enabled: false },
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 1,
  );
  const storage = fakeStorage({
    settings: {
      config: {
        ...copy(DEFAULT_CONFIG),
        enabled: true,
        localOnly: 'device-2',
      },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
    },
  });
  const merged = await makeEngine({
    storage,
    backend: {},
  }).bootstrap(remote);

  assert.equal(merged.configFields.enabled.value, false);
  assert.equal(merged.configFields.enabled.clock.ts, NOW - 1);
  assert.equal(merged.configFields.localOnly.value, 'device-2');
  assert.equal(merged.configFields.localOnly.clock.ts, 0);
  assert.equal(storage.values.local.config.enabled, false);
  assert.equal(storage.values.local.config.localOnly, 'device-2');
  assert.equal(storage.values.local.syncMeta.dirty, true);
});

test('bootstrap lets a remote tombstone remove a local blocklist entry', async () => {
  const remote = storageToDoc(
    DEFAULT_CONFIG,
    {},
    ['Local Block'],
    [],
    [],
    'remote-actor',
    NOW - 100,
  );
  setBlocklistEntry(
    remote,
    'Local Block',
    false,
    createClock(NOW - 1, 100, 'remote-actor'),
  );
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: ['Local Block'],
      manualSubs: [],
      watched: [],
    },
  });

  const merged = await makeEngine({ storage, backend: {} }).bootstrap(remote);

  assert.equal(merged.blocklist['Local Block'].present, false);
  assert.equal(merged.blocklist['Local Block'].clock.ts, NOW - 1);
  assert.deepEqual(storage.values.local.blocklist, []);
});

test('bootstrap unions watched entries using their real snapshot recency', async () => {
  const remote = storageToDoc(
    DEFAULT_CONFIG,
    {},
    [],
    [],
    ['remote-video', 'shared-video'],
    'remote-actor',
    NOW - 20,
  );
  remote.clearedBefore = NOW - 30;
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: ['local-video', 'shared-video'],
    },
  });

  const merged = await makeEngine({ storage, backend: {} }).bootstrap(remote);

  assert.deepEqual(Object.keys(merged.watched), [
    'local-video',
    'remote-video',
    'shared-video',
  ]);
  assert.equal(merged.watched['local-video'].lastSeen, NOW - 1);
  assert.equal(merged.watched['shared-video'].lastSeen, NOW);
  assert.deepEqual(storage.values.local.watched, [
    'remote-video',
    'local-video',
    'shared-video',
  ]);
});

test('bootstrap creates a document from storage when remote is empty', async () => {

  const localStorage = fakeStorage({
    settings: {
      config: { ...copy(DEFAULT_CONFIG), enabled: false },
      channelOverrides: {},
    },
    local: {
      blocklist: ['Local Block'],
      manualSubs: [],
      watched: ['local-video'],
    },
  });
  const localDoc = await makeEngine({
    storage: localStorage,
    backend: {},
  }).bootstrap(null);
  assert.equal(localDoc.configFields.enabled.value, false);
  assert.equal(localDoc.blocklist['Local Block'].present, true);
  assert.ok(localDoc.watched['local-video']);
});

test('enable uploads the conservative union and marks bootstrap dirty', async () => {
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const key = await encryptionKey('correct passphrase', salt);
  const remoteDoc = storageToDoc(
    DEFAULT_CONFIG,
    {},
    ['Remote Block'],
    [],
    [],
    'remote-actor',
    NOW - 1,
  );
  const blob = await encrypt(remoteDoc, key);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {
        'Local Channel': { watched: { enabled: false } },
      },
    },
    local: {
      blocklist: ['Local Block'],
      manualSubs: ['Local Channel'],
      watched: [],
    },
  });
  let reads = 0;
  let uploaded;
  const backend = {
    async test() {
      return CAPABILITIES;
    },
    async read() {
      reads += 1;
      if (reads === 2) {
        assert.equal(storage.values.local.syncMeta.dirty, true);
        assert.deepEqual(
          new Set(storage.values.local.blocklist),
          new Set(['Local Block', 'Remote Block']),
        );
      }
      return { blob, revision: '"remote"' };
    },
    async write(nextBlob) {
      uploaded = await decrypt(nextBlob, key);
      return '"merged"';
    },
  };

  assert.deepEqual(
    await makeEngine({ storage, backend }).enable(
      SETTINGS,
      'correct passphrase',
    ),
    { ok: true },
  );
  assert.equal(reads, 2);
  assert.equal(uploaded.blocklist['Local Block'].present, true);
  assert.equal(uploaded.blocklist['Local Block'].clock.ts, 0);
  assert.equal(uploaded.blocklist['Remote Block'].present, true);
  assert.equal(uploaded.manualSubs['Local Channel'].present, true);
  assert.deepEqual(
    uploaded.overrides['Local Channel'].value,
    { watched: { enabled: false } },
  );
  const localClocks = [
    uploaded.blocklist['Local Block'].clock,
    uploaded.manualSubs['Local Channel'].clock,
    uploaded.overrides['Local Channel'].clock,
  ];
  assert.equal(new Set(localClocks.map(({ actorId }) => actorId)).size, 1);
  assert.equal(new Set(localClocks.map(({ counter }) => counter)).size, 3);
  assert.ok(localClocks.every(({ ts }) => ts === 0));
  assert.deepEqual(
    new Set(storage.values.local.blocklist),
    new Set(['Local Block', 'Remote Block']),
  );
  assert.deepEqual(storage.values.local.manualSubs, ['Local Channel']);
});

test('fresh-profile enable preserves the remote projection', async () => {
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const remoteKey = await encryptionKey('correct passphrase', salt);
  const remoteDoc = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: false },
    { 'Remote Channel': { watched: { enabled: false } } },
    ['Remote Block'],
    ['Remote Channel'],
    ['remote-video'],
    'remote-actor',
    NOW - 1,
  );
  const blob = await encrypt(remoteDoc, remoteKey);
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
    },
  });
  const keys = fakeKeyStore();
  const backend = {
    async test() {
      return CAPABILITIES;
    },
    async read() {
      return { blob, revision: '"remote"' };
    },
    async write() {
      assert.fail('adopting an unchanged remote must not upload');
    },
  };
  const engine = makeEngine({ storage, backend, keyStore: keys });

  assert.deepEqual(
    await engine.enable(SETTINGS, 'correct passphrase'),
    { ok: true },
  );
  assert.deepEqual(keys.record.salt, salt);
  assert.equal(keys.record.iters, 1000);
  assert.deepEqual(await decrypt(blob, keys.record.key), remoteDoc);
  assert.equal(storage.values.local.syncSettings.enabled, true);
  assert.deepEqual(storage.values.local.config, {
    ...DEFAULT_CONFIG,
    enabled: false,
  });
  assert.deepEqual(storage.values.local.channelOverrides, {
    'Remote Channel': { watched: { enabled: false } },
  });
  assert.deepEqual(storage.values.local.blocklist, ['Remote Block']);
  assert.deepEqual(storage.values.local.manualSubs, ['Remote Channel']);
  assert.deepEqual(storage.values.local.watched, ['remote-video']);
});

test('decrypt error preserves projected user data and records a safe error', async () => {
  const salt = new Uint8Array(32);
  const rightKey = await encryptionKey('right', salt);
  const wrongKey = await encryptionKey('wrong', salt);
  const remoteDoc = storageToDoc(
    { ...DEFAULT_CONFIG, enabled: false },
    {},
    ['Remote Block'],
    [],
    [],
    'remote-actor',
    NOW - 1,
  );
  const blob = await encrypt(remoteDoc, rightKey);
  const localConfig = { ...copy(DEFAULT_CONFIG), enabled: true };
  const storage = fakeStorage({
    settings: {
      config: localConfig,
      channelOverrides: {},
    },
    local: {
      blocklist: ['Local Block'],
      manualSubs: [],
      watched: [],
      syncDoc: storageToDoc(
        localConfig,
        {},
        ['Local Block'],
        [],
        [],
        'local-actor',
        NOW - 2,
      ),
      syncSettings: SETTINGS,
    },
  });
  const backend = {
    async read() {
      return { blob, revision: '"remote"' };
    },
  };
  const engine = makeEngine({
    storage,
    backend,
    keyStore: fakeKeyStore({ key: wrongKey, salt, iters: 1000 }),
  });

  assert.deepEqual(
    await engine.runSync(),
    { error: 'wrong passphrase or corrupt data' },
  );
  assert.equal(storage.values.local.config.enabled, true);
  assert.deepEqual(storage.values.local.blocklist, ['Local Block']);
  assert.equal(
    storage.values.local.syncMeta.lastError,
    'wrong passphrase or corrupt data',
  );
});

test('disable clears sync-private state but preserves user data', async () => {
  const storage = fakeStorage({
    settings: {
      config: copy(DEFAULT_CONFIG),
      channelOverrides: { Channel: { watched: { enabled: false } } },
    },
    local: {
      blocklist: ['Blocked'],
      manualSubs: ['Manual'],
      watched: ['video'],
      syncDoc: { private: true },
      syncMeta: { private: true },
      syncSettings: SETTINGS,
    },
  });
  const keys = fakeKeyStore({ key: 'placeholder' });
  const engine = makeEngine({ storage, backend: {}, keyStore: keys });

  assert.deepEqual(await engine.disable(), { ok: true });
  assert.equal(storage.values.local.syncDoc, undefined);
  assert.equal(storage.values.local.syncMeta, undefined);
  assert.equal(storage.values.local.syncSettings, undefined);
  assert.deepEqual(storage.values.local.blocklist, ['Blocked']);
  assert.deepEqual(storage.values.local.manualSubs, ['Manual']);
  assert.deepEqual(storage.values.local.watched, ['video']);
  assert.ok(storage.values.local.config);
  assert.ok(storage.values.local.channelOverrides);
  assert.equal(keys.cleared, true);
});

test('enable refuses a remote file with a weak key derivation', async () => {
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const blob = await encrypt(
    storageToDoc(DEFAULT_CONFIG, {}, [], [], [], 'remote-actor', NOW - 1),
    await encryptionKey('correct passphrase', salt),
  );
  const storage = fakeStorage();
  const keys = fakeKeyStore();
  const engine = makeEngine({
    storage,
    keyStore: keys,
    minIterations: 600_000,
    backend: {
      async test() { return CAPABILITIES; },
      async read() { return { blob, revision: '"1"' }; },
      async write() { throw new Error('must not upload'); },
    },
  });

  const result = await engine.enable(SETTINGS, 'correct passphrase');

  assert.match(result.error, /weaker key derivation/);
  assert.equal(keys.record, null);
  assert.equal(storage.values.local.syncSettings, undefined);
});

test('enable refuses a short passphrase for a new sync file', async () => {
  const storage = fakeStorage();
  const keys = fakeKeyStore();
  const engine = makeEngine({
    storage,
    keyStore: keys,
    minPassphraseLength: 12,
    backend: {
      async test() { return CAPABILITIES; },
      async read() { return null; },
      async write() { throw new Error('must not upload'); },
    },
  });

  const result = await engine.enable(SETTINGS, 'short');

  assert.match(result.error, /at least 12 characters/);
  assert.equal(keys.record, null);
});

test('status exposes the server and user but never the password', async () => {
  const storage = fakeStorage({ local: { syncSettings: SETTINGS } });
  const engine = makeEngine({ storage, backend: {} });

  const status = await engine.status();

  assert.equal(status.url, SETTINGS.url);
  assert.equal(status.username, SETTINGS.username);
  assert.equal(JSON.stringify(status).includes(SETTINGS.password), false);
});

test('a connection test reuses the saved password only for the saved server', async () => {
  const seen = [];
  const storage = fakeStorage({ local: { syncSettings: SETTINGS } });
  const engine = createSyncEngine({
    storage,
    keyStore: fakeKeyStore(),
    log: () => {},
    backendFactory: (settings) => {
      seen.push(settings);
      return { async test() { return CAPABILITIES; } };
    },
  });

  await engine.testConnection({
    url: SETTINGS.url,
    username: SETTINGS.username,
    password: '',
  });
  await engine.testConnection({
    url: 'https://other.example/file.bin',
    username: SETTINGS.username,
    password: '',
  });

  assert.equal(seen[0].password, SETTINGS.password);
  assert.equal(seen[1].password, '');
});

test('private sync state goes to the injected store, not chrome.storage', async () => {
  const storage = fakeStorage();
  const privateStorage = fakeStorage().local;
  const engine = createSyncEngine({
    storage,
    privateStorage,
    keyStore: fakeKeyStore(),
    log: () => {},
    minPassphraseLength: 1,
    backendFactory: () => ({
      async test() { return CAPABILITIES; },
      async read() { return null; },
      async write() { return '"1"'; },
    }),
  });

  const result = await engine.enable(SETTINGS, 'passphrase');

  assert.deepEqual(result, { ok: true });
  assert.equal(storage.values.local.syncSettings, undefined);
  assert.equal(storage.values.local.syncDoc, undefined);
  assert.equal(storage.values.local.syncMeta, undefined);
  assert.equal(
    (await privateStorage.get('syncSettings')).syncSettings.password,
    SETTINGS.password,
  );
});

test('SYNC V2: block metadata and hidden videos travel between two devices', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const remote = { blob: null, revision: null, writes: 0 };
  const backend = {
    async read({ ifNoneMatch } = {}) {
      if (remote.blob === null) return null;
      if (ifNoneMatch && ifNoneMatch === remote.revision) {
        return { unchanged: true, revision: remote.revision };
      }
      return { blob: remote.blob, revision: remote.revision };
    },
    async write(blob) {
      remote.blob = blob;
      remote.writes += 1;
      remote.revision = `"r${remote.writes}"`;
      return remote.revision;
    },
  };
  // Real edits on two devices are seconds apart, never in the same
  // millisecond; last-writer-wins needs that to order them.
  const time = { now: NOW };
  const device = (local) => {
    const storage = fakeStorage({
      settings: { config: copy(DEFAULT_CONFIG), channelOverrides: {} },
      local: {
        blocklist: [],
        manualSubs: [],
        watched: [],
        syncSettings: SETTINGS,
        ...local,
      },
    });
    return {
      storage,
      engine: makeEngine({
        storage,
        backend,
        keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
        now: () => time.now,
      }),
    };
  };
  const sync = (target) => {
    time.now += 1000;
    return target.engine.runSync();
  };

  const a = device({
    blocklist: ['News', 'Loud'],
    blockMeta: {
      News: { handles: ['@bad-news'], until: null, addedAt: 5 },
      Loud: { handles: [], until: NOW + 1_000_000, addedAt: 6 },
    },
    hiddenVideos: ['video000001', 'video000002'],
  });
  const b = device({});

  assert.deepEqual(await sync(a), { ok: true, changed: true });
  assert.deepEqual(await sync(b), { ok: true, changed: true });

  assert.deepEqual(new Set(b.storage.values.local.blocklist), new Set(['News', 'Loud']));
  assert.deepEqual(b.storage.values.local.blockMeta, {
    News: { handles: ['@bad-news'], until: null, addedAt: 5 },
    Loud: { handles: [], until: NOW + 1_000_000, addedAt: 6 },
  });
  assert.deepEqual(
    b.storage.values.local.hiddenVideos,
    ['video000001', 'video000002'],
  );

  // B unblocks one channel and unhides one video; A follows.
  b.storage.values.local.blocklist = ['News'];
  b.storage.values.local.blockMeta = {
    News: { handles: ['@bad-news'], until: null, addedAt: 5 },
  };
  b.storage.values.local.hiddenVideos = ['video000002'];
  await sync(b);
  await sync(a);

  assert.deepEqual(a.storage.values.local.blocklist, ['News']);
  assert.deepEqual(Object.keys(a.storage.values.local.blockMeta), ['News']);
  assert.deepEqual(a.storage.values.local.hiddenVideos, ['video000002']);

  const uploaded = await decrypt(remote.blob, key);
  assert.equal(uploaded.v, 2);
  assert.equal(uploaded.hidden.video000001.present, false);
  assert.equal(uploaded.blockMeta.Loud.value, null);
});

test('SYNC V2: a document from a newer extension is reported as such', async () => {
  const salt = new Uint8Array(32);
  const key = await encryptionKey('passphrase', salt);
  const storage = fakeStorage({
    local: { syncSettings: SETTINGS, blocklist: ['Kept'] },
  });
  const engine = makeEngine({
    storage,
    keyStore: fakeKeyStore({ key, salt, iters: 1000 }),
    backend: {
      async read() {
        return {
          blob: await encryptFutureDocument(key),
          revision: '"future"',
        };
      },
      async write() {
        throw new Error('must not upload over a newer document');
      },
    },
  });

  const result = await engine.runSync();

  assert.match(result.error, /Unsupported sync document v3/);
  assert.deepEqual(storage.values.local.blocklist, ['Kept']);
});

// encrypt() only serializes valid documents, so a "version 3" envelope is
// built by hand with the same header and key.
async function encryptFutureDocument(key) {
  const valid = await encrypt(
    storageToDoc(DEFAULT_CONFIG, {}, [], [], [], 'future-actor', NOW),
    key,
  );
  const headerEnd = valid.length - 12 - 16 - new TextEncoder().encode(
    JSON.stringify(storageToDoc(DEFAULT_CONFIG, {}, [], [], [], 'future-actor', NOW)),
  ).length;
  const header = valid.slice(0, headerEnd);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header },
    key,
    new TextEncoder().encode('{"v":3,"actorId":"future-actor"}'),
  ));
  const blob = new Uint8Array(header.length + nonce.length + ciphertext.length);
  blob.set(header, 0);
  blob.set(nonce, header.length);
  blob.set(ciphertext, header.length + nonce.length);
  return blob;
}
