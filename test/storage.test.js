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

test('a stored config without minAgeHours loads it as 0', async () => {
  await chrome.storage.local.set({
    config: { ageRule: { enabled: true, maxAgeDays: 500 } },
  });
  const config = await loadConfig();
  assert.equal(config.ageRule.minAgeHours, 0);
  assert.equal(config.ageRule.maxAgeDays, 500);
});

test('a partial stored config still gets every default key', async () => {
  await chrome.storage.local.set({ config: { enabled: false } });
  const config = await loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.viewRule.graceHours, 48);
  assert.equal(config.watchedRule.enabled, true);
});

test('config lives in local, where no per-item quota applies', async () => {
  await saveConfig(DEFAULT_CONFIG);
  assert.ok('config' in mock.areas.local);
  assert.ok(!('config' in mock.areas.sync));
});

test('settings and channel rules move from sync to local exactly once', async () => {
  const { migrateStorageLayout } = await import('../src/storage/migrate.js');
  await chrome.storage.sync.set({
    config: { enabled: false },
    channelOverrides: { 'Channel A': { watched: { enabled: false } } },
  });

  assert.equal(await migrateStorageLayout(), true);
  assert.deepEqual(mock.areas.sync, {});
  assert.equal(mock.areas.local.config.enabled, false);
  assert.deepEqual(mock.areas.local.channelOverrides, {
    'Channel A': { watched: { enabled: false } },
  });
  assert.equal(await migrateStorageLayout(), false);
});

test('the layout migration never overwrites newer local settings', async () => {
  const { migrateStorageLayout } = await import('../src/storage/migrate.js');
  await chrome.storage.local.set({ config: { enabled: true } });
  await chrome.storage.sync.set({ config: { enabled: false } });

  await migrateStorageLayout();

  assert.equal(mock.areas.local.config.enabled, true);
  assert.deepEqual(mock.areas.sync, {});
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
  await chrome.storage.local.set({
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
  await chrome.storage.local.set({ channelOverrides: ['not', 'an', 'object'] });
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

test('overrides save to local with normalized keys and empty entries removed', async () => {
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

  assert.deepEqual(mock.areas.local.channelOverrides, {
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
  assert.equal('channelOverrides' in mock.areas.sync, false);
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

const blocklistStore = await import('../src/storage/blocklist.js');
const hiddenStore = await import('../src/storage/hidden.js');
const feedbackStore = await import('../src/storage/feedback.js');
const statsStore = await import('../src/storage/block-stats.js');
const subsStore = await import('../src/storage/subs.js');
const DAY = 24 * 60 * 60 * 1000;

test('BLOCKS: a block records its handle and time', async () => {
  await blocklistStore.addBlocked('News', { handle: '@News', now: 1000 });

  assert.deepEqual([...await blocklistStore.loadBlocklist()], ['News']);
  assert.deepEqual((await blocklistStore.loadBlockMeta()).get('News'), {
    handles: ['@news'],
    until: null,
    addedAt: 1000,
  });
});

test('BLOCKS: blocking a namesake adds a second handle to the same name', async () => {
  await blocklistStore.addBlocked('News', { handle: '@news-one', now: 1 });
  await blocklistStore.addBlocked('News', { handle: '@news-two', now: 2 });

  assert.deepEqual([...await blocklistStore.loadBlocklist()], ['News']);
  assert.deepEqual(
    (await blocklistStore.loadBlockMeta()).get('News').handles,
    ['@news-one', '@news-two'],
  );
});

test('BLOCKS: a snooze sets an end and blocking again makes it permanent', async () => {
  await blocklistStore.addBlocked('Loud', { now: 1000 });
  assert.equal(
    await blocklistStore.snoozeBlocked('Loud', { days: 30, now: 1000 }),
    true,
  );
  assert.equal(
    (await blocklistStore.loadBlockMeta()).get('Loud').until,
    1000 + 30 * DAY,
  );

  await blocklistStore.addBlocked('Loud', { now: 2000 });
  assert.equal((await blocklistStore.loadBlockMeta()).get('Loud').until, null);
  assert.equal(await blocklistStore.snoozeBlocked('Never Blocked'), false);
});

test('BLOCKS: expired snoozes are pruned, permanent blocks stay', async () => {
  await blocklistStore.addBlocked('Permanent', { now: 1 });
  await blocklistStore.addBlocked('Snoozed', { now: 1 });
  await blocklistStore.snoozeBlocked('Snoozed', { days: 1, now: 1 });

  assert.deepEqual(await blocklistStore.pruneExpiredBlocks(DAY), []);
  assert.deepEqual(await blocklistStore.pruneExpiredBlocks(2 * DAY), ['Snoozed']);
  assert.deepEqual([...await blocklistStore.loadBlocklist()], ['Permanent']);
  assert.equal((await blocklistStore.loadBlockMeta()).has('Snoozed'), false);
});

test('BLOCKS: a legacy name-only block is pinned to the first handle seen', async () => {
  await chrome.storage.local.set({ blocklist: ['Legacy'] });

  assert.equal(await blocklistStore.pinBlockHandle('Legacy', '@first'), true);
  assert.equal(await blocklistStore.pinBlockHandle('Legacy', '@second'), false);
  assert.equal(await blocklistStore.pinBlockHandle('Unknown', '@x'), false);
  assert.equal(await blocklistStore.pinBlockHandle('Legacy', 'not a handle'), false);
  assert.deepEqual(
    (await blocklistStore.loadBlockMeta()).get('Legacy').handles,
    ['@first'],
  );
});

test('BLOCKS: unblocking removes the metadata too', async () => {
  await blocklistStore.addBlocked('Gone', { handle: '@gone', now: 1 });
  await blocklistStore.removeBlocked('Gone');

  assert.deepEqual(mock.areas.local.blocklist, []);
  assert.deepEqual(mock.areas.local.blockMeta, {});
});

test('HIDDEN: videos are added, removed, capped and cleared', async () => {
  await hiddenStore.addHidden('video000001');
  await hiddenStore.addHidden('video000002');
  await hiddenStore.addHidden('video000001');
  assert.deepEqual(mock.areas.local.hiddenVideos, ['video000002', 'video000001']);

  await hiddenStore.removeHidden('video000002');
  assert.deepEqual([...await hiddenStore.loadHidden()], ['video000001']);

  await chrome.storage.local.set({
    hiddenVideos: Array.from({ length: hiddenStore.HIDDEN_CAP }, (_, i) => `v-${i}`),
  });
  await hiddenStore.addHidden('newest-video');
  assert.equal(mock.areas.local.hiddenVideos.length, hiddenStore.HIDDEN_CAP);
  assert.equal(mock.areas.local.hiddenVideos.at(-1), 'newest-video');
  assert.equal(mock.areas.local.hiddenVideos.includes('v-0'), false);

  await hiddenStore.clearHidden();
  assert.deepEqual(mock.areas.local.hiddenVideos, []);
});

test('BUDGET: a reservation is refused once the weekly limit is used', async () => {
  let id = 0;
  const reserve = (now) => feedbackStore.reserveFeedback({
    action: 'notInterested',
    videoId: 'video000001',
    channelName: 'Channel',
    limit: 2,
    now,
    createId: () => `id-${id += 1}`,
  });

  assert.deepEqual(await reserve(1000), { ok: true, id: 'id-1', used: 1, limit: 2 });
  assert.deepEqual(await reserve(2000), { ok: true, id: 'id-2', used: 2, limit: 2 });
  assert.deepEqual(await reserve(3000), {
    ok: false,
    reason: 'budget',
    used: 2,
    limit: 2,
  });
  // A week later the first two no longer count.
  assert.equal((await reserve(2000 + 7 * DAY + 1)).ok, true);
});

test('BUDGET: a released reservation gives the slot back', async () => {
  const first = await feedbackStore.reserveFeedback({
    action: 'dontRecommendChannel',
    limit: 1,
    now: 1000,
    createId: () => 'only',
  });
  assert.equal(first.ok, true);
  assert.equal(await feedbackStore.releaseFeedback('only'), true);
  assert.equal(await feedbackStore.releaseFeedback('only'), false);
  assert.deepEqual(
    await feedbackStore.feedbackBudget({ limit: 1, now: 1000 }),
    { used: 0, limit: 1, remaining: 1 },
  );
});

test('BUDGET: the limit is capped and unknown actions are refused', async () => {
  assert.equal(feedbackStore.effectiveWeeklyLimit(9999), feedbackStore.MAX_WEEKLY_LIMIT);
  assert.equal(feedbackStore.effectiveWeeklyLimit(-1), 0);
  assert.equal(feedbackStore.effectiveWeeklyLimit('3'), 0);
  assert.equal((await feedbackStore.reserveFeedback({
    action: 'watchLater',
    limit: 5,
    now: 1,
  })).ok, false);
  assert.equal((await feedbackStore.reserveFeedback({
    action: 'notInterested',
    limit: 0,
    now: 1,
  })).reason, 'budget');
});

test('STATS: hits count per day and only for blocked channels', async () => {
  const blocked = new Set(['Spam']);
  await statsStore.recordBlockHits({ Spam: 3, 'Not Blocked': 9 }, { blocked, now: DAY });
  await statsStore.recordBlockHits({ Spam: 2 }, { blocked, now: DAY + 5 });
  await statsStore.recordBlockHits({ Spam: 1 }, { blocked, now: 3 * DAY });

  assert.deepEqual(await statsStore.loadBlockStats(), {
    Spam: { hits: 6, days: 2, lastSeen: 3 * DAY },
  });
});

test('STATS: persistent and unseen blocks are told apart', () => {
  const now = 400 * DAY;
  assert.equal(
    statsStore.isPersistent({ hits: 40, days: 6, lastSeen: now - DAY }, now),
    true,
  );
  assert.equal(
    statsStore.isPersistent({ hits: 40, days: 2, lastSeen: now - DAY }, now),
    false,
  );
  assert.equal(
    statsStore.isPersistent({ hits: 40, days: 9, lastSeen: now - 30 * DAY }, now),
    false,
  );
  assert.equal(statsStore.isUnseen(undefined, now - 181 * DAY, now), true);
  assert.equal(statsStore.isUnseen(undefined, now - 10 * DAY, now), false);
  assert.equal(
    statsStore.isUnseen({ hits: 1, days: 1, lastSeen: now - 200 * DAY }, 1, now),
    true,
  );
  assert.equal(statsStore.isUnseen(undefined, 0, now), false);
});

test('SUBS: handles are stored with the list and follow removals', async () => {
  await subsStore.saveSubs(['Channel A', 'Channel B'], {
    'Channel A': '@A-Handle',
    'Not In List': '@x',
    'Channel B': 'garbage value',
  });
  assert.deepEqual(
    Object.fromEntries(await subsStore.loadSubHandles()),
    { 'Channel A': '@a-handle' },
  );

  assert.equal(
    await subsStore.addSubNames(['Channel C'], { 'Channel C': '@c' }),
    true,
  );
  // A known name with a newly learned handle is a change too.
  assert.equal(
    await subsStore.addSubNames(['Channel B'], { 'Channel B': '@b' }),
    true,
  );
  assert.equal(await subsStore.removeSubNames(['Channel A']), true);
  assert.deepEqual(
    Object.fromEntries(await subsStore.loadSubHandles()),
    { 'Channel B': '@b', 'Channel C': '@c' },
  );
});

test('the old native-feedback switch turns the new master switch on once', async () => {
  const { migrateStorageLayout } = await import('../src/storage/migrate.js');
  await chrome.storage.local.set({
    config: { blocklistRule: { enabled: true, sendNativeFeedback: true } },
  });

  assert.equal(await migrateStorageLayout(), true);
  assert.deepEqual(mock.areas.local.config.feedback, {
    enabled: true,
    weeklyLimit: 3,
  });
  assert.equal(await migrateStorageLayout(), false);
});
