import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';

const mock = installChromeMock();
const {
  COLLECT_TAB_URL,
  NORMAL_BADGE_COLOR,
  POPUP_PATH,
  STALE_BADGE_COLOR,
  SUBS_COLLECTION_RESULT_MESSAGE,
  createCountsMessageHandler,
  createDomHealthState,
  createSubscriptionTabCoordinator,
  createSyncMessageHandler,
  ensureSyncPullAlarm,
  createUpdateCheckRunner,
  refreshSubscriptionIndicators,
  refreshSubs,
  updateCountsBadge,
} = await import('../src/background.js');
const {
  SUBS_FORMAT_VERSION,
  SUBS_STALE_AFTER_MS,
} = await import('../src/storage/subs.js');

beforeEach(async () => {
  await chrome.storage.local.remove(['subs', 'updateCheck']);
  await chrome.storage.sync.remove('config');
});

function tabsHarness() {
  const calls = {
    create: [],
    remove: [],
    update: [],
  };
  let nextId = 40;
  return {
    calls,
    tabs: {
      async create(options) {
        calls.create.push(options);
        return { id: nextId++ };
      },
      async remove(tabId) {
        calls.remove.push(tabId);
      },
      async update(tabId, options) {
        calls.update.push([tabId, options]);
        return { id: tabId };
      },
    },
  };
}

test('background keeps both daily maintenance alarms', () => {
  assert.deepEqual(mock.alarmCreates, [
    { name: 'refresh-subs', options: { periodInMinutes: 1440 } },
    { name: 'check-update', options: { periodInMinutes: 1440 } },
  ]);
});

test('sync pull alarm migration replaces an existing daily alarm', async () => {
  let current = {
    name: 'sync-pull',
    periodInMinutes: 1440,
  };
  const clears = [];
  const creates = [];
  const alarms = {
    async get(name) {
      assert.equal(name, 'sync-pull');
      return current;
    },
    create(name, options) {
      creates.push({ name, options });
      current = { name, ...options };
    },
    clear(name) {
      clears.push(name);
    },
  };

  assert.equal(await ensureSyncPullAlarm({ alarms }), true);
  assert.deepEqual(creates, [{
    name: 'sync-pull',
    options: { periodInMinutes: 15 },
  }]);
  assert.deepEqual(clears, []);
  assert.deepEqual(current, {
    name: 'sync-pull',
    periodInMinutes: 15,
  });
});

test('sync pull alarm already at 15 minutes is left alone', async () => {
  const alarms = {
    async get(name) {
      assert.equal(name, 'sync-pull');
      return { name, periodInMinutes: 15 };
    },
    create() {
      assert.fail('a matching alarm must not be recreated');
    },
    clear() {
      assert.fail('a matching alarm must not be cleared');
    },
  };

  assert.equal(await ensureSyncPullAlarm({ alarms }), false);
});

test('background permanently attaches the popup and has no click handler', () => {
  assert.deepEqual(mock.actionCalls.popups, [{ popup: POPUP_PATH }]);
  assert.deepEqual(mock.events.clicked, []);
});

test('fresh subscription cache needs no foreground collection tab', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Channel A', 'Channel B'],
      fetchedAt: Date.now(),
    },
  });

  assert.equal(await refreshSubs(), 2);
});

test('stale count messages keep the hidden count and use the amber badge', () => {
  const calls = { text: [], color: [] };
  updateCountsBadge({ hidden: 12, subsStale: true }, 41, {
    action: {
      setBadgeText(options) {
        calls.text.push(options);
      },
      setBadgeBackgroundColor(options) {
        calls.color.push(options);
      },
    },
  });

  assert.deepEqual(calls.text, [{ tabId: 41, text: '12' }]);
  assert.deepEqual(calls.color, [{
    tabId: 41,
    color: STALE_BADGE_COLOR,
  }]);
});

test('fresh count messages keep the hidden count and use the normal badge', () => {
  const calls = { text: [], color: [] };
  updateCountsBadge({ hidden: 3, subsStale: false }, 42, {
    action: {
      setBadgeText(options) {
        calls.text.push(options);
      },
      setBadgeBackgroundColor(options) {
        calls.color.push(options);
      },
    },
  });

  assert.deepEqual(calls.text, [{ tabId: 42, text: '3' }]);
  assert.deepEqual(calls.color, [{
    tabId: 42,
    color: NORMAL_BADGE_COLOR,
  }]);
});

test('count DOM health is exposed for the active tab through sync status', async () => {
  const domHealthState = createDomHealthState({
    tabs: {
      query: async (query) => {
        assert.deepEqual(query, { active: true, currentWindow: true });
        return [{ id: 41 }];
      },
    },
  });
  const badgeUpdates = [];
  const handleCounts = createCountsMessageHandler({
    domHealthState,
    updateBadge: (message, tabId) => badgeUpdates.push([message, tabId]),
  });
  handleCounts({
    type: 'counts',
    hidden: 2,
    enabled: true,
    domHealth: 'degraded',
  }, { tab: { id: 41 } });

  const handleSync = createSyncMessageHandler({
    engine: { status: async () => ({ enabled: false }) },
    getDomHealth: () => domHealthState.active(),
  });
  const response = await new Promise((resolve) => {
    assert.equal(
      handleSync({ type: 'sync-status' }, {}, resolve),
      true,
    );
  });

  assert.deepEqual(response, {
    enabled: false,
    domHealth: 'degraded',
  });
  assert.equal(badgeUpdates.length, 1);

  domHealthState.remove(41);
  assert.equal(await domHealthState.active(), 'ok');
});

test('absent subscription indicators use amber and explain collection', async () => {
  const colors = [];
  const titles = [];

  await refreshSubscriptionIndicators({
    action: {
      setBadgeBackgroundColor(options) {
        colors.push(options);
      },
      setTitle(options) {
        titles.push(options);
      },
    },
    tabs: { query: async () => [] },
  });

  assert.deepEqual(colors, [{ color: STALE_BADGE_COLOR }]);
  assert.match(
    titles[0].title,
    /subscription list not collected yet - click to collect/i,
  );
  assert.doesNotMatch(titles[0].title, /\b\d+ days? old\b/i);
});

test('stale subscription indicators use amber and show age', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Channel A'],
      fetchedAt: Date.now() - SUBS_STALE_AFTER_MS - 1,
    },
  });
  const colors = [];
  const titles = [];

  await refreshSubscriptionIndicators({
    action: {
      setBadgeBackgroundColor(options) {
        colors.push(options);
      },
      setTitle(options) {
        titles.push(options);
      },
    },
    tabs: { query: async () => [] },
  });

  assert.deepEqual(colors, [{ color: STALE_BADGE_COLOR }]);
  assert.match(titles[0].title, /subscription list is 30 days old/i);
});

test('fresh subscription indicators use normal color', async () => {
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Channel A'],
      fetchedAt: Date.now(),
    },
  });
  const colors = [];

  await refreshSubscriptionIndicators({
    action: {
      setBadgeBackgroundColor(options) {
        colors.push(options);
      },
      setTitle() {},
    },
    tabs: { query: async () => [] },
  });

  assert.deepEqual(colors, [{ color: NORMAL_BADGE_COLOR }]);
});

test('an available update changes the tooltip without amber', async () => {
  const colors = [];
  const titles = [];

  await refreshSubscriptionIndicators({
    action: {
      setBadgeBackgroundColor(options) {
        colors.push(options);
      },
      setTitle(options) {
        titles.push(options);
      },
    },
    tabs: { query: async () => [] },
    loadMeta: async () => ({
      ageMs: 0,
      stale: false,
    }),
    loadConfiguration: async () => ({
      updateCheck: { enabled: true },
    }),
    getUpdateAvailable: async () => 'v0.7.1',
    currentVersion: '0.7.0',
  });

  assert.deepEqual(colors, [{ color: NORMAL_BADGE_COLOR }]);
  assert.match(titles[0].title, /update v0\.7\.1 available/);
});

test('a disabled update check hides any cached update nudge', async () => {
  const titles = [];

  await refreshSubscriptionIndicators({
    action: {
      setBadgeBackgroundColor() {},
      setTitle(options) {
        titles.push(options);
      },
    },
    tabs: { query: async () => [] },
    loadMeta: async () => ({
      ageMs: 0,
      stale: false,
    }),
    loadConfiguration: async () => ({
      updateCheck: { enabled: false },
    }),
    getUpdateAvailable: async () => {
      assert.fail('disabled checks must not read a cached update nudge');
    },
  });

  assert.doesNotMatch(titles[0].title, /update/i);
});

test('update check runner skips fetches when disabled and still recomputes', async () => {
  let checks = 0;
  let refreshes = 0;
  const runUpdateCheck = createUpdateCheckRunner({
    loadConfiguration: async () => ({
      updateCheck: { enabled: false },
    }),
    performCheck: async () => {
      checks += 1;
    },
    refreshIndicators: async () => {
      refreshes += 1;
    },
  });

  await runUpdateCheck();

  assert.equal(checks, 0);
  assert.equal(refreshes, 1);
});

test('update check runner fetches when enabled and then recomputes', async () => {
  const calls = [];
  const storage = { local: {} };
  const fetchFn = async () => {};
  const runUpdateCheck = createUpdateCheckRunner({
    fetchFn,
    storage,
    now: () => 123,
    currentVersion: () => '0.7.0',
    loadConfiguration: async () => ({
      updateCheck: { enabled: true },
    }),
    performCheck: async (options) => {
      calls.push(['check', options]);
    },
    refreshIndicators: async () => {
      calls.push(['refresh']);
    },
  });

  await runUpdateCheck();

  assert.deepEqual(calls, [
    ['check', {
      fetchFn,
      storage,
      now: 123,
      currentVersion: '0.7.0',
    }],
    ['refresh'],
  ]);
});

test('daily alarm updates badge and tooltip without opening a tab', async (t) => {
  const now = Date.now();
  await chrome.storage.local.set({
    subs: {
      format: SUBS_FORMAT_VERSION,
      ids: ['Channel A'],
      fetchedAt: now - SUBS_STALE_AFTER_MS - 24 * 60 * 60 * 1000,
    },
  });

  const colors = [];
  const titles = [];
  let tabCreates = 0;
  const originalColor = chrome.action.setBadgeBackgroundColor;
  const originalTitle = chrome.action.setTitle;
  const originalCreate = chrome.tabs.create;
  chrome.action.setBadgeBackgroundColor = (options) => colors.push(options);
  chrome.action.setTitle = (options) => titles.push(options);
  chrome.tabs.create = async () => {
    tabCreates += 1;
    return { id: 99 };
  };
  t.after(() => {
    chrome.action.setBadgeBackgroundColor = originalColor;
    chrome.action.setTitle = originalTitle;
    chrome.tabs.create = originalCreate;
  });

  await mock.events.alarm[0]({ name: 'refresh-subs' });

  const staleAgeDays =
    SUBS_STALE_AFTER_MS / (24 * 60 * 60 * 1000) + 1;
  assert.deepEqual(colors, [{ color: STALE_BADGE_COLOR }]);
  assert.match(
    titles[0].title,
    new RegExp(`subscription list is ${staleAgeDays} days old`, 'i'),
  );
  assert.match(titles[0].title, /refresh recommended/i);
  assert.equal(tabCreates, 0);
});

test('manual refresh creates one active marked collection tab', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });

  await coordinator.begin(() => {});

  assert.deepEqual(harness.calls.create, [{
    url: COLLECT_TAB_URL,
    active: true,
  }]);
  assert.equal(coordinator.getCollectTabId(), 40);
});

test('a second refresh focuses the existing collection tab', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });

  await coordinator.begin(() => {});
  await coordinator.begin(() => {});

  assert.equal(harness.calls.create.length, 1);
  assert.deepEqual(harness.calls.update, [[40, { active: true }]]);
});

test('failed foreground collection propagates diagnostics and closes its tab', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });
  const responses = [];
  const diagnostics = {
    finalNameCount: 98,
    initialNameCount: 98,
    bottomReached: false,
    elapsedMs: 90_000,
    scrollAttempts: 12,
    continuationPresent: true,
  };

  await coordinator.begin((response) => responses.push(response));
  assert.equal(await coordinator.receiveResult({
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: false,
    count: 98,
    reason: 'budget-expired',
    diagnostics,
  }, { tab: { id: 40 } }), true);

  assert.deepEqual(responses, [{
    complete: false,
    reason: 'budget-expired',
    diagnostics,
  }]);
  assert.deepEqual(harness.calls.remove, [40]);
  assert.equal(coordinator.getCollectTabId(), null);
});

test('successful foreground collection returns its count and closes its tab', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });
  const responses = [];

  await coordinator.begin((response) => responses.push(response));
  await coordinator.receiveResult({
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: true,
    count: 120,
  }, { tab: { id: 40 } });

  assert.deepEqual(responses, [{ complete: true, count: 120 }]);
  assert.deepEqual(harness.calls.remove, [40]);
});

test('closing the collection tab reports collect-tab-closed to every waiter', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });
  const first = [];
  const second = [];

  await coordinator.begin((response) => first.push(response));
  await coordinator.begin((response) => second.push(response));
  assert.equal(coordinator.tabRemoved(40), true);
  await Promise.resolve();

  assert.deepEqual(first, [{
    complete: false,
    reason: 'collect-tab-closed',
  }]);
  assert.deepEqual(second, [{
    complete: false,
    reason: 'collect-tab-closed',
  }]);
  assert.deepEqual(harness.calls.remove, []);
  assert.equal(coordinator.getCollectTabId(), null);
});

test('options timeout cancellation closes and clears the collection tab', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });
  const responses = [];

  await coordinator.begin((response) => responses.push(response));
  assert.equal(await coordinator.cancel(), true);

  assert.deepEqual(responses, [{ complete: false, reason: 'timeout' }]);
  assert.deepEqual(harness.calls.remove, [40]);
  assert.equal(coordinator.getCollectTabId(), null);
});

test('collection results from any other tab are ignored', async () => {
  const harness = tabsHarness();
  const coordinator = createSubscriptionTabCoordinator({
    tabs: harness.tabs,
  });
  const responses = [];

  await coordinator.begin((response) => responses.push(response));
  assert.equal(await coordinator.receiveResult({
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: true,
    count: 5,
  }, { tab: { id: 99 } }), false);

  assert.deepEqual(responses, []);
  assert.deepEqual(harness.calls.remove, []);
  assert.equal(coordinator.getCollectTabId(), 40);
});
