import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { decrypt, deriveKey } from '../src/sync/crypto.js';
import {
  create,
  createClock,
  parse,
  setSubsEntry,
} from '../src/sync/document.js';
import { merge } from '../src/sync/merge.js';
import { storageToDoc } from '../src/sync/project.js';
import { loadSubs, SUBS_FORMAT_VERSION } from '../src/storage/subs.js';

const NOW = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS = {
  enabled: true,
  url: 'https://dav.example/youtube-tuner.bin',
  username: 'alice',
  password: 'secret',
};

function copy(value) {
  return structuredClone(value);
}

function fakeStorage({ sync = {}, local = {} } = {}) {
  const values = { sync: copy(sync), local: copy(local) };
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
      Object.assign(values[name], copy(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[name][key];
      }
    },
  });
  return { sync: area('sync'), local: area('local'), values };
}

function sharedBackend() {
  const remote = { blob: null, revision: null, writes: 0 };
  return {
    remote,
    async read() {
      return remote.blob === null
        ? null
        : { blob: remote.blob, revision: remote.revision };
    },
    async write(blob, revision) {
      assert.equal(revision, remote.revision);
      remote.blob = blob;
      remote.writes += 1;
      remote.revision = `"r${remote.writes}"`;
      return remote.revision;
    },
  };
}

const KEY = await deriveKey('passphrase', new Uint8Array(32), 1000);

function device({ backend, clock, enabled = true, subs, extraLocal = {} }) {
  const storage = fakeStorage({
    sync: {
      config: { ...copy(DEFAULT_CONFIG), subsSync: { enabled } },
      channelOverrides: {},
    },
    local: {
      blocklist: [],
      manualSubs: [],
      watched: [],
      syncSettings: SETTINGS,
      ...(subs === undefined ? {} : { subs }),
      ...extraLocal,
    },
  });
  const engine = createSyncEngine({
    storage,
    backendFactory: () => backend,
    keyStore: {
      async loadKey() { return { key: KEY, salt: new Uint8Array(32), iters: 1000 }; },
      async saveKey() {},
      async clearKey() {},
    },
    now: () => clock.time,
    log: () => {},
  });
  return { storage, engine };
}

const entry = (ids, fetchedAt) => ({ format: SUBS_FORMAT_VERSION, ids, fetchedAt });

async function remoteDoc(backend) {
  return decrypt(backend.remote.blob, KEY);
}

async function sync(d, clock) {
  clock.time += 1000;
  const result = await d.engine.runSync();
  assert.equal(result.error, undefined);
}

test('fresh device gets a usable subs entry projected from the remote document', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const a = device({ backend, clock, subs: entry(['Beta', 'Alpha'], 1234) });
  await sync(a, clock);

  const b = device({ backend, clock });
  await sync(b, clock);

  assert.deepEqual(b.storage.values.local.subs, {
    format: SUBS_FORMAT_VERSION,
    ids: ['Alpha', 'Beta'],
    fetchedAt: 1234,
  });
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: b.storage.local } };
  try {
    assert.deepEqual([...(await loadSubs())].sort(), ['Alpha', 'Beta']);
  } finally {
    globalThis.chrome = previous;
  }
});

test('a channel dropped by a full collection on A disappears on B', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const a = device({ backend, clock, subs: entry(['Alpha', 'Beta', 'X'], 1000) });
  await sync(a, clock);
  const b = device({ backend, clock });
  await sync(b, clock);
  assert.deepEqual(b.storage.values.local.subs.ids, ['Alpha', 'Beta', 'X']);

  a.storage.values.local.subs = entry(['Alpha', 'Beta'], 2000);
  await sync(a, clock);
  assert.equal((await remoteDoc(backend)).subs.X.present, false);
  await sync(b, clock);

  assert.deepEqual(b.storage.values.local.subs.ids, ['Alpha', 'Beta']);
  assert.equal(b.storage.values.local.subs.fetchedAt, 2000);
});

test('toggle off neither uploads nor projects subs and leaves remote entries alone', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const a = device({ backend, clock, subs: entry(['Alpha', 'Beta'], 1000) });
  await sync(a, clock);

  const local = entry(['Zed'], 500);
  const b = device({
    backend,
    clock,
    enabled: false,
    subs: local,
    extraLocal: { manualSubs: ['Manual'] },
  });
  await sync(b, clock);

  assert.deepEqual(b.storage.values.local.subs, local);
  const doc = await remoteDoc(backend);
  assert.equal(doc.manualSubs.Manual.present, true);
  assert.equal(doc.subs.Zed, undefined);
  assert.equal(doc.subs.Alpha.present, true);
  assert.equal(doc.subs.Beta.present, true);
  assert.equal(doc.subsFetchedAt, 1000);
  assert.equal(doc.configFields['subsSync.enabled'].value, false);
});

test('absent or unusable local subs never tombstone the document', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const a = device({ backend, clock, subs: entry(['Alpha', 'Beta'], 1000) });
  await sync(a, clock);

  delete a.storage.values.local.subs;
  let doc = await a.engine.captureLocalChanges();
  assert.equal(doc.subs.Alpha.present, true);
  assert.equal(doc.subs.Beta.present, true);

  a.storage.values.local.subs = { format: 1, ids: [], fetchedAt: 5 };
  doc = await a.engine.captureLocalChanges();
  assert.equal(doc.subs.Alpha.present, true);
  assert.equal(doc.subs.Beta.present, true);
  assert.equal(doc.subsFetchedAt, 1000);
});

test('subsFetchedAt merges as max and projection never lowers local fetchedAt', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const a = device({ backend, clock, subs: entry(['Alpha', 'Beta'], 1000) });
  await sync(a, clock);

  const b = device({ backend, clock, subs: entry(['Alpha'], 5000) });
  await sync(b, clock);

  assert.equal(b.storage.values.local.subs.fetchedAt, 5000);
  assert.deepEqual(b.storage.values.local.subs.ids, ['Alpha', 'Beta']);
  assert.equal((await remoteDoc(backend)).subsFetchedAt, 5000);

  const left = create('actor-a');
  const right = create('actor-b');
  left.subsFetchedAt = 7;
  right.subsFetchedAt = 9;
  assert.equal(merge(left, right, NOW).subsFetchedAt, 9);
  assert.equal(merge(right, left, NOW).subsFetchedAt, 9);
});

test('subs tombstones are garbage-collected like the other presence maps', () => {
  const left = create('actor-a');
  const right = create('actor-b');
  setSubsEntry(left, 'Old', false, createClock(NOW - 91 * DAY_MS, 1, 'actor-a'));
  setSubsEntry(right, 'New', false, createClock(NOW - DAY_MS, 1, 'actor-b'));
  const merged = merge(left, right, NOW);
  assert.equal(merged.subs.Old, undefined);
  assert.equal(merged.subs.New.present, false);
});

test('documents from 1.6.x normalize to empty subs and drop garbage entries', () => {
  const legacy = parse({ v: 1, actorId: 'a' });
  assert.deepEqual(legacy.subs, {});
  assert.equal(legacy.subsFetchedAt, 0);

  const goodClock = createClock(NOW, 1, 'a');
  const parsed = parse({
    v: 1,
    actorId: 'a',
    subs: {
      Good: { present: true, clock: goodClock },
      BadPresent: { present: 'yes', clock: goodClock },
      BadClock: { present: true, clock: { ts: -1 } },
      __proto__: { present: true, clock: goodClock },
      Junk: 7,
    },
    subsFetchedAt: 1.5,
  });
  assert.deepEqual(Object.keys(parsed.subs), ['Good']);
  assert.equal(parsed.subsFetchedAt, 0);
  assert.equal(parse({ v: 1, actorId: 'a', subsFetchedAt: -3 }).subsFetchedAt, 0);
  assert.equal(parse({ v: 1, actorId: 'a', subsFetchedAt: 42 }).subsFetchedAt, 42);
});

test('storageToDoc ignores unusable subs entries', () => {
  const doc = storageToDoc({}, {}, [], [], [], 'a', NOW, { ids: ['A'], fetchedAt: 'x' });
  assert.deepEqual(doc.subs, {});
  assert.equal(doc.subsFetchedAt, 0);
});

test('bootstrap merge demotes local subs clocks and takes the larger fetchedAt', async () => {
  const backend = sharedBackend();
  const clock = { time: NOW };
  const d = device({ backend, clock, subs: entry(['Local'], 9000) });
  const remote = storageToDoc(
    d.storage.values.sync.config,
    {},
    [],
    [],
    [],
    'remote-actor',
    NOW - 10,
    entry(['Remote'], 4000),
  );
  assert.equal(remote.subsFetchedAt, 4000);

  const doc = await d.engine.bootstrap(remote);
  assert.equal(doc.subs.Local.present, true);
  assert.equal(doc.subs.Local.clock.ts, 0);
  assert.equal(doc.subs.Remote.present, true);
  assert.equal(doc.subsFetchedAt, 9000);
  assert.deepEqual(d.storage.values.local.subs.ids, ['Local', 'Remote']);
  assert.equal(d.storage.values.local.subs.fetchedAt, 9000);
});
