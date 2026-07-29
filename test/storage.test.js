import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';

const mock = installChromeMock();

const { loadConfig, saveConfig } = await import('../src/storage/config.js');
const { loadWatched, addWatched, clearWatched, WATCHED_CAP } =
  await import('../src/storage/watched.js');
const { loadBlocklist, addBlocked, removeBlocked } =
  await import('../src/storage/blocklist.js');
const { loadOverrides, saveOverrides } =
  await import('../src/storage/overrides.js');
const {
  loadSubs,
  loadSubsMeta,
  saveSubs,
  addSubNames,
  removeSubNames,
  loadManualSubs,
  saveManualSubs,
  unionSubs,
  normalizeNames,
  SUBS_STALE_AFTER_MS,
  SUBS_FORMAT_VERSION,
} =
  await import('../src/storage/subs.js');
const { DEFAULT_CONFIG } = await import('../src/rules/defaults.js');

beforeEach(() => mock.reset());

test('config returns defaults when nothing is stored', async () => {
  assert.deepEqual(await loadConfig(), DEFAULT_CONFIG);
});

test('config merges stored values over defaults', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, ageRule: { enabled: true, maxAgeDays: 500 } });
  const config = await loadConfig();
  assert.equal(config.ageRule.maxAgeDays, 500);
  assert.equal(config.viewRule.minViews, 5000);
});

test('a partial stored config still gets every default key', async () => {
  await chrome.storage.sync.set({ config: { enabled: false } });
  const config = await loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.viewRule.graceHours, 48);
  assert.equal(config.watchedRule.enabled, true);
});

test('config lives in sync, not local', async () => {
  await saveConfig(DEFAULT_CONFIG);
  assert.ok('config' in mock.areas.sync);
  assert.ok(!('config' in mock.areas.local));
});

test('watched set round-trips', async () => {
  await addWatched('vid1');
  await addWatched('vid2');
  const set = await loadWatched();
  assert.ok(set.has('vid1'));
  assert.ok(set.has('vid2'));
});

test('watched set does not duplicate', async () => {
  await addWatched('vid1');
  await addWatched('vid1');
  assert.equal(mock.areas.local.watched.length, 1);
});

test('watched set evicts oldest past the cap', async () => {
  const ids = Array.from({ length: WATCHED_CAP }, (_, i) => `v${i}`);
  await chrome.storage.local.set({ watched: ids });
  await addWatched('newest');
  const stored = mock.areas.local.watched;
  assert.equal(stored.length, WATCHED_CAP);
  assert.equal(stored[stored.length - 1], 'newest');
  assert.ok(!stored.includes('v0'), 'oldest id was not evicted');
});

test('re-watching moves an id to most-recent', async () => {
  await chrome.storage.local.set({ watched: ['a', 'b', 'c'] });
  await addWatched('a');
  assert.deepEqual(mock.areas.local.watched, ['b', 'c', 'a']);
});

test('clearWatched empties the set', async () => {
  await addWatched('vid1');
  await clearWatched();
  assert.equal((await loadWatched()).size, 0);
});

test('watched set lives in local, not sync', async () => {
  await addWatched('vid1');
  assert.ok('watched' in mock.areas.local);
  assert.ok(!('watched' in mock.areas.sync));
});

test('blocklist add and remove', async () => {
  await addBlocked('Bad Channel');
  assert.ok((await loadBlocklist()).has('Bad Channel'));
  await removeBlocked('Bad Channel');
  assert.ok(!(await loadBlocklist()).has('Bad Channel'));
});

test('blocklist does not duplicate', async () => {
  await addBlocked('Bad Channel');
  await addBlocked('Bad Channel');
  assert.equal(mock.areas.local.blocklist.length, 1);
});

test('subs cache is null when never fetched', async () => {
  assert.equal(await loadSubs(), null);
  assert.equal(unionSubs(null, await loadManualSubs()), null);
  await chrome.storage.local.set({ subs: { ids: ['Malformed Channel'] } });
  assert.equal(await loadSubs(), null, 'a malformed cache must fail open');
});

test('a subs cache without the current format marker is treated as absent', async () => {
  await chrome.storage.local.set({
    subs: { ids: ['Old Channel'], fetchedAt: Date.now() },
  });
  assert.equal(await loadSubs(), null);

  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION - 1,
      ids: ['Old Channel'],
      fetchedAt: Date.now(),
    },
  });
  assert.equal(await loadSubs(), null);
});

test('subs cache round-trips', async () => {
  await saveSubs(['Chan A', 'Chan B']);
  await saveManualSubs([' Manual Channel ', 'Chan A', 'Manual Channel']);
  const subs = await loadSubs();
  const manual = await loadManualSubs();
  assert.ok(subs.has('Chan A'));
  assert.ok(subs.has('Chan B'));
  assert.deepEqual([...manual], ['Manual Channel', 'Chan A']);
  assert.deepEqual(
    [...unionSubs(subs, manual)].sort(),
    ['Chan A', 'Chan B', 'Manual Channel'],
  );
  assert.ok('manualSubs' in mock.areas.local);
  assert.ok(!('manualSubs' in mock.areas.sync));
});

test('addSubNames does not create an absent subscription cache', async (t) => {
  const originalSet = chrome.storage.local.set;
  const writes = [];
  chrome.storage.local.set = async (items) => {
    writes.push(items);
    return originalSet(items);
  };
  t.after(() => {
    chrome.storage.local.set = originalSet;
  });

  assert.equal(await addSubNames(['New Channel']), false);
  assert.deepEqual(writes, []);
  assert.equal('subs' in mock.areas.local, false);
});

test('addSubNames does not write to a wrong-format cache', async (t) => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION - 1,
      ids: ['Existing Channel'],
      fetchedAt: 1_234_567,
    },
  });
  const originalSet = chrome.storage.local.set;
  const writes = [];
  chrome.storage.local.set = async (items) => {
    writes.push(items);
    return originalSet(items);
  };
  t.after(() => {
    chrome.storage.local.set = originalSet;
  });

  assert.equal(await addSubNames(['New Channel']), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(mock.areas.local.subs.ids, ['Existing Channel']);
});

test('addSubNames appends a normalized name without refreshing cache metadata', async () => {
  const originalEntry = {
    format: SUBS_FORMAT_VERSION,
    ids: ['Existing Channel'],
    fetchedAt: 1_234_567,
  };
  await chrome.storage.local.set({ subs: originalEntry });

  assert.equal(await addSubNames(['  New Channel  ']), true);
  assert.deepEqual(mock.areas.local.subs.ids, [
    'Existing Channel',
    'New Channel',
  ]);
  assert.equal(mock.areas.local.subs.format, originalEntry.format);
  assert.equal(mock.areas.local.subs.fetchedAt, originalEntry.fetchedAt);
});

test('addSubNames skips an already-present normalized name', async (t) => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Existing Channel'],
      fetchedAt: 1_234_567,
    },
  });
  const originalSet = chrome.storage.local.set;
  const writes = [];
  chrome.storage.local.set = async (items) => {
    writes.push(items);
    return originalSet(items);
  };
  t.after(() => {
    chrome.storage.local.set = originalSet;
  });

  assert.equal(
    await addSubNames(['\n  Existing Channel  \nExisting Channel']),
    false,
  );
  assert.deepEqual(writes, []);
});

test('removeSubNames does not create or write an absent subscription cache', async (t) => {
  const originalSet = chrome.storage.local.set;
  const writes = [];
  chrome.storage.local.set = async (items) => {
    writes.push(items);
    return originalSet(items);
  };
  t.after(() => {
    chrome.storage.local.set = originalSet;
  });

  assert.equal(await removeSubNames(['Existing Channel']), false);
  assert.deepEqual(writes, []);
  assert.equal('subs' in mock.areas.local, false);
});

test('removeSubNames removes a normalized name without refreshing cache metadata', async () => {
  const originalEntry = {
    format: SUBS_FORMAT_VERSION,
    ids: ['Keep Channel', 'Remove Channel'],
    fetchedAt: 1_234_567,
  };
  await chrome.storage.local.set({ subs: originalEntry });

  assert.equal(await removeSubNames(['  Remove Channel  ']), true);
  assert.deepEqual(mock.areas.local.subs.ids, ['Keep Channel']);
  assert.equal(mock.areas.local.subs.format, originalEntry.format);
  assert.equal(mock.areas.local.subs.fetchedAt, originalEntry.fetchedAt);
});

test('removeSubNames skips a normalized name that is not present', async (t) => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Existing Channel'],
      fetchedAt: 1_234_567,
    },
  });
  const originalSet = chrome.storage.local.set;
  const writes = [];
  chrome.storage.local.set = async (items) => {
    writes.push(items);
    return originalSet(items);
  };
  t.after(() => {
    chrome.storage.local.set = originalSet;
  });

  assert.equal(
    await removeSubNames(['\n  Absent Channel  \nAbsent Channel']),
    false,
  );
  assert.deepEqual(writes, []);
});

test('normalizeNames repairs duplicated multiline channel names', () => {
  assert.deepEqual(
    [...normalizeNames(['hessencam\n  \n  \n  \n    hessencam'])],
    ['hessencam'],
  );
});

test('loadSubs repairs dirty cached channel names', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['hessencam\n  \n  \n  \n    hessencam'],
      fetchedAt: Date.now(),
    },
  });

  const subs = await loadSubs();
  assert.deepEqual([...subs], ['hessencam']);
  assert.ok(subs.has('hessencam'));
});

test('an empty subs list is a valid cache, not an absent one', async () => {
  await saveSubs([]);
  const subs = await loadSubs();
  assert.notEqual(subs, null);
  assert.equal(subs.size, 0);
  const combined = unionSubs(subs, new Set());
  assert.notEqual(combined, null);
  assert.equal(combined.size, 0);
});

test('loadSubs returns names from a cache older than the stale threshold', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Chan A'],
      fetchedAt: Date.now() - SUBS_STALE_AFTER_MS - 1000,
    },
  });
  const stale = await loadSubs();
  assert.deepEqual([...stale], ['Chan A']);
});

test('loadSubs rejects a cache with non-array ids', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: 'Chan A',
      fetchedAt: Date.now(),
    },
  });
  assert.equal(await loadSubs(), null);
});

test('loadSubs rejects a cache with non-finite fetchedAt', async () => {
  for (const fetchedAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await chrome.storage.local.set({
      subs: {
        format: SUBS_FORMAT_VERSION,
        ids: ['Chan A'],
        fetchedAt,
      },
    });
    assert.equal(await loadSubs(), null);
  }
});

test('loadSubsMeta changes stale at SUBS_STALE_AFTER_MS', async (t) => {
  const now = 2_000_000_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Chan A'],
      fetchedAt: now - SUBS_STALE_AFTER_MS + 1,
    },
  });
  assert.deepEqual(await loadSubsMeta(), {
    fetchedAt: now - SUBS_STALE_AFTER_MS + 1,
    ageMs: SUBS_STALE_AFTER_MS - 1,
    stale: false,
  });

  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Chan A'],
      fetchedAt: now - SUBS_STALE_AFTER_MS - 1,
    },
  });
  assert.deepEqual(await loadSubsMeta(), {
    fetchedAt: now - SUBS_STALE_AFTER_MS - 1,
    ageMs: SUBS_STALE_AFTER_MS + 1,
    stale: true,
  });
});

test('overrides load normalized valid entries and drop garbage', async () => {
  await chrome.storage.sync.set({
    channelOverrides: {
      '  Channel A  \nIgnored': {
        watched: { enabled: false, garbage: true },
        age: { enabled: true, maxAgeDays: 365, garbage: 'ignored' },
        view: { enabled: 'yes', minViews: 1000 },
        garbage: true,
      },
      'Channel B': {
        watched: { enabled: true },
        age: { enabled: false, maxAgeDays: Number.POSITIVE_INFINITY },
        view: 'invalid',
      },
      'Garbage Channel': {
        age: { enabled: 'yes', maxAgeDays: 0 },
        view: { minViews: 1.5 },
      },
      'Invalid Entry': null,
    },
  });

  assert.deepEqual(await loadOverrides(), new Map([
    ['Channel A', {
      watched: { enabled: false },
      age: { enabled: true, maxAgeDays: 365 },
      view: { minViews: 1000 },
    }],
    ['Channel B', {
      watched: { enabled: true },
      age: { enabled: false },
    }],
  ]));
});

test('overrides fail closed for malformed storage and storage errors', async (t) => {
  await chrome.storage.sync.set({ channelOverrides: ['not', 'an', 'object'] });
  assert.deepEqual(await loadOverrides(), new Map());

  const originalGet = chrome.storage.sync.get;
  chrome.storage.sync.get = async () => {
    throw new Error('storage unavailable');
  };
  t.after(() => {
    chrome.storage.sync.get = originalGet;
  });
  assert.deepEqual(await loadOverrides(), new Map());
});

test('overrides save to sync with normalized keys and empty entries removed', async () => {
  await saveOverrides(new Map([
    ['  Channel A \nIgnored', {
      watched: { enabled: false },
      age: { enabled: true, maxAgeDays: 90.5 },
      view: { minViews: 2500, garbage: true },
    }],
    ['Empty Channel', {}],
    ['', { age: { enabled: true } }],
    ['Channel B', {
      age: { enabled: 'yes', maxAgeDays: 30 },
      view: { enabled: false, minViews: -10 },
    }],
  ]));

  assert.deepEqual(mock.areas.sync.channelOverrides, {
    'Channel A': {
      watched: { enabled: false },
      age: { enabled: true },
      view: { minViews: 2500 },
    },
    'Channel B': {
      age: { maxAgeDays: 30 },
      view: { enabled: false },
    },
  });
  assert.equal('channelOverrides' in mock.areas.local, false);
});

test('overrides round-trip every supported field', async () => {
  const overrides = {
    'Channel A': {
      watched: { enabled: false },
      age: { enabled: true, maxAgeDays: 365 },
      view: { enabled: false, minViews: 1000 },
    },
  };

  await saveOverrides(overrides);
  assert.deepEqual(await loadOverrides(), new Map(Object.entries(overrides)));
});
