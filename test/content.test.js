import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  LIFELINE_PORT_NAME,
  LIFELINE_RECONNECT_DELAY_MS,
  SUBS_COLLECTION_RESULT_MESSAGE,
  createDomHealthCanary,
  createFilteringLifecycle,
  createRuntimeLifeline,
  hasStateStorageChange,
  isSupportedRoute,
  startContentScript,
  startSubscriptionCollectionMode,
  stopPassiveCollectionOnNavigation,
  subscriptionCollectionResponse,
  subscriptionCollectionResultMessage,
} from '../src/content.js';
import { HIDDEN_CLASS } from '../src/dom/applier.js';
import {
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
} from '../src/dom/block-button.js';
import { COLLAPSED_SECTION_CLASS } from '../src/dom/empty-sections.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

const lifecycleTile = `
  <yt-lockup-view-model id="tile">
    <a href="/watch?v=video1"></a>
    <a aria-label="Go to channel Blocked Channel"></a>
  </yt-lockup-view-model>
  <ytd-rich-section-renderer id="section"></ytd-rich-section-renderer>
`;

function setupFilteringLifecycle({
  pathname = '/',
  enabled = true,
  subsStale = false,
  markup = lifecycleTile,
  nativeUndoWatcher,
} = {}) {
  const doc = html(markup);
  let currentPathname = pathname;
  let currentConfig = { ...DEFAULT_CONFIG, enabled };
  const currentState = {
    subs: new Set(),
    subsStale,
    blocklist: new Set(['Blocked Channel']),
    watched: new Set(),
    locale: 'en',
  };
  const messages = [];
  const lifecycle = createFilteringLifecycle({
    documentObject: doc,
    nudgeObject: { onCounts() {} },
    getConfig: () => currentConfig,
    getState: () => currentState,
    getPathname: () => currentPathname,
    sendMessage: async (message) => messages.push(message),
    addBlockedChannel: async () => {},
    nativeUndoWatcher,
  });

  return {
    doc,
    lifecycle,
    messages,
    setEnabled(next) {
      currentConfig = { ...currentConfig, enabled: next };
    },
    setPathname(next) {
      currentPathname = next;
    },
  };
}

function assertCleanFilteringPage(doc) {
  assert.equal(doc.querySelectorAll(`.${HIDDEN_CLASS}`).length, 0);
  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
  assert.equal(
    doc.querySelectorAll(`.${NOT_INTERESTED_BUTTON_CLASS}`).length,
    0,
  );
  assert.equal(doc.querySelectorAll(`.${BLOCK_HOST_CLASS}`).length, 0);
  assert.equal(doc.querySelectorAll(`.${COLLAPSED_SECTION_CLASS}`).length, 0);
  assert.equal(doc.querySelectorAll('#ytt-styles').length, 0);
}

function createRuntimeHarness() {
  const ports = [];
  const connectCalls = [];
  const runtime = {
    id: 'test-extension-id',
    connect(options) {
      connectCalls.push(options);
      const disconnectListeners = new Set();
      const port = {
        onDisconnect: {
          addListener(listener) {
            disconnectListeners.add(listener);
          },
          removeListener(listener) {
            disconnectListeners.delete(listener);
          },
        },
        disconnect() {
          disconnectListeners.clear();
        },
        fireDisconnect() {
          for (const listener of [...disconnectListeners]) listener(port);
        },
      };
      ports.push(port);
      return port;
    },
  };
  return { connectCalls, ports, runtime };
}

function createTimerHarness() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      const index = scheduled.indexOf(timer);
      if (index !== -1) scheduled.splice(index, 1);
    },
  };
}

test('filtering routes are exactly the home feed and watch page', () => {
  assert.equal(isSupportedRoute('/'), true);
  assert.equal(isSupportedRoute('/watch'), true);
  for (const pathname of [
    '/results',
    '/feed/subscriptions',
    '/@handle',
    '/playlist',
    '/feed/channels',
  ]) {
    assert.equal(isSupportedRoute(pathname), false, pathname);
  }
});

test('content state refreshes for local state and sync channel overrides', () => {
  assert.equal(hasStateStorageChange({ watched: {} }, 'local'), true);
  assert.equal(
    hasStateStorageChange({ channelOverrides: {} }, 'sync'),
    true,
  );
  assert.equal(hasStateStorageChange({ config: {} }, 'sync'), false);
  assert.equal(
    hasStateStorageChange({ channelOverrides: {} }, 'local'),
    false,
  );
});

test('valid runtime lifeline disconnect reconnects without teardown', (t) => {
  const watcherCalls = [];
  const { doc, lifecycle } = setupFilteringLifecycle({
    nativeUndoWatcher: {
      start() { watcherCalls.push('start'); },
      stop() { watcherCalls.push('stop'); },
    },
  });
  lifecycle.sync();
  const runtimeHarness = createRuntimeHarness();
  const timerHarness = createTimerHarness();
  let teardowns = 0;
  const lifeline = createRuntimeLifeline({
    runtime: runtimeHarness.runtime,
    onInvalidated() {
      teardowns += 1;
      lifecycle.stop();
    },
    setTimeoutFn: timerHarness.setTimeoutFn,
    clearTimeoutFn: timerHarness.clearTimeoutFn,
  });
  t.after(() => {
    lifeline.stop();
    lifecycle.stop();
  });

  assert.equal(lifeline.start(), true);
  runtimeHarness.ports[0].fireDisconnect();

  assert.equal(teardowns, 0);
  assert.deepEqual(watcherCalls, ['start']);
  assert.ok(doc.querySelector(`.${HIDDEN_CLASS}`));
  assert.equal(timerHarness.scheduled.length, 1);
  assert.equal(
    timerHarness.scheduled[0].delay,
    LIFELINE_RECONNECT_DELAY_MS,
  );

  timerHarness.scheduled.shift().callback();
  assert.deepEqual(runtimeHarness.connectCalls, [
    { name: LIFELINE_PORT_NAME },
    { name: LIFELINE_PORT_NAME },
  ]);
  assert.equal(teardowns, 0);
  assert.ok(doc.querySelector(`.${HIDDEN_CLASS}`));
});

test('invalidated runtime lifeline fully tears down filtering', () => {
  const watcherCalls = [];
  const { doc, lifecycle } = setupFilteringLifecycle({
    nativeUndoWatcher: {
      start() { watcherCalls.push('start'); },
      stop() { watcherCalls.push('stop'); },
    },
  });
  lifecycle.sync();
  const runtimeHarness = createRuntimeHarness();
  const timerHarness = createTimerHarness();
  const lifeline = createRuntimeLifeline({
    runtime: runtimeHarness.runtime,
    onInvalidated: () => lifecycle.stop(),
    setTimeoutFn: timerHarness.setTimeoutFn,
    clearTimeoutFn: timerHarness.clearTimeoutFn,
  });
  lifeline.start();

  runtimeHarness.runtime.id = undefined;
  runtimeHarness.ports[0].fireDisconnect();

  assert.deepEqual(watcherCalls, ['start', 'stop']);
  assert.equal(lifecycle.active, false);
  assert.equal(timerHarness.scheduled.length, 0);
  assertCleanFilteringPage(doc);
});

test('navigating from home to results tears down every content artifact', (t) => {
  const { doc, lifecycle, setPathname } = setupFilteringLifecycle();
  t.after(() => lifecycle.stop());
  lifecycle.sync();
  assert.ok(doc.querySelector(`.${HIDDEN_CLASS}`));

  setPathname('/results');
  lifecycle.sync();

  assertCleanFilteringPage(doc);
});

test('navigating from results back to home restores filtering', (t) => {
  const { doc, lifecycle, setPathname } = setupFilteringLifecycle({
    pathname: '/results',
  });
  t.after(() => lifecycle.stop());
  lifecycle.sync();
  assertCleanFilteringPage(doc);

  setPathname('/');
  lifecycle.sync();

  assert.ok(doc.querySelector(`.${HIDDEN_CLASS}`));
  assert.equal(doc.querySelectorAll('#ytt-styles').length, 1);
  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('repeated navigation events on one route do not duplicate artifacts', (t) => {
  const { doc, lifecycle } = setupFilteringLifecycle();
  t.after(() => lifecycle.stop());

  for (let index = 0; index < 4; index += 1) {
    lifecycle.sync();
  }

  assert.equal(doc.querySelectorAll('#ytt-styles').length, 1);
  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
  assert.equal(
    doc.querySelectorAll(`.${NOT_INTERESTED_BUTTON_CLASS}`).length,
    1,
  );
});

test('disabling on a supported route leaves a completely clean page', (t) => {
  const { doc, lifecycle, setEnabled } = setupFilteringLifecycle();
  t.after(() => lifecycle.stop());
  lifecycle.sync();
  assert.ok(doc.querySelector(`.${COLLAPSED_SECTION_CLASS}`));

  setEnabled(false);
  lifecycle.sync();

  assertCleanFilteringPage(doc);
});

test('filtering deactivation stops the native Undo watcher', (t) => {
  const calls = [];
  let started = false;
  const nativeUndoWatcher = {
    start() {
      if (started) return;
      started = true;
      calls.push('start');
    },
    stop() {
      if (!started) return;
      started = false;
      calls.push('stop');
    },
  };
  const { lifecycle, setEnabled } = setupFilteringLifecycle({
    nativeUndoWatcher,
  });
  t.after(() => lifecycle.stop());

  lifecycle.sync();
  lifecycle.sync();
  setEnabled(false);
  lifecycle.sync();

  assert.deepEqual(calls, ['start', 'stop']);
});

test('re-enabling on a supported route restores filtering without reload', (t) => {
  const { doc, lifecycle, setEnabled } = setupFilteringLifecycle({
    enabled: false,
  });
  t.after(() => lifecycle.stop());
  lifecycle.sync();
  assertCleanFilteringPage(doc);

  setEnabled(true);
  lifecycle.sync();

  assert.ok(doc.querySelector(`.${HIDDEN_CLASS}`));
  assert.ok(doc.querySelector(`.${COLLAPSED_SECTION_CLASS}`));
  assert.equal(doc.querySelectorAll('#ytt-styles').length, 1);
  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('/feed/channels runs marked and passive collection with filtering closed', async (t) => {
  const { doc, lifecycle } = setupFilteringLifecycle({
    pathname: '/feed/channels',
  });
  t.after(() => lifecycle.stop());
  lifecycle.sync();
  assert.equal(lifecycle.active, false);

  const windowObject = doc.defaultView;
  const marked = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: true,
    cachedSubs: new Set(['Cached']),
    documentObject: doc,
    windowObject,
    requestCollection: async ({ collect }) => collect(),
    collect: async () => ({ names: ['Marked'], complete: true }),
    sendMessage: async () => {},
  });
  let passiveCalls = 0;
  const controller = { stop() {} };
  const passive = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: false,
    cachedSubs: null,
    documentObject: doc,
    windowObject,
    requestPassive: async () => {
      passiveCalls += 1;
      return controller;
    },
  });

  assert.equal(marked.mode, 'active');
  assert.deepEqual(marked.result.names, ['Marked']);
  assert.deepEqual(passive, { mode: 'passive', controller });
  assert.equal(passiveCalls, 1);
  assertCleanFilteringPage(doc);
});

test('inactive count reports send zero without modifying the DOM', (t) => {
  const { doc, lifecycle, messages } = setupFilteringLifecycle({
    pathname: '/results',
  });
  t.after(() => lifecycle.stop());
  lifecycle.sync();

  lifecycle.reportCounts({ hidden: 9, visible: 4 });

  assert.deepEqual(
    {
      hidden: messages.at(-1).hidden,
      visible: messages.at(-1).visible,
    },
    { hidden: 0, visible: 0 },
  );
  assertCleanFilteringPage(doc);
});

test('count reports include the captured subscription nudge flag', (t) => {
  const { lifecycle, messages } = setupFilteringLifecycle({
    pathname: '/',
    subsStale: true,
  });
  t.after(() => lifecycle.stop());

  lifecycle.sync();
  lifecycle.reportCounts({ hidden: 3, visible: 4 });

  assert.equal(messages.at(-1).subsStale, true);
});

test('DOM health degrades on the fifth consecutive failing scan', () => {
  const canary = createDomHealthCanary();
  const failingScan = {
    totalMatchedTiles: 8,
    nullChannelNameTiles: 7,
  };

  for (let scan = 1; scan < 5; scan += 1) {
    assert.equal(canary.observe(failingScan), 'ok');
  }
  assert.equal(canary.observe(failingScan), 'degraded');
});

test('a healthy DOM scan resets the degraded streak', () => {
  const canary = createDomHealthCanary();
  const failingScan = {
    totalMatchedTiles: 8,
    nullChannelNameTiles: 7,
  };
  for (let scan = 0; scan < 4; scan += 1) canary.observe(failingScan);

  assert.equal(canary.observe({
    totalMatchedTiles: 8,
    nullChannelNameTiles: 6,
  }), 'ok');
  for (let scan = 0; scan < 4; scan += 1) {
    assert.equal(canary.observe(failingScan), 'ok');
  }
  assert.equal(canary.observe(failingScan), 'degraded');
});

test('stopping filtering resets degraded DOM health', (t) => {
  const markup = Array.from(
    { length: 8 },
    (_, index) => `<yt-lockup-view-model>
      <a href="/watch?v=video${index}"></a>
    </yt-lockup-view-model>`,
  ).join('');
  const { lifecycle, messages } = setupFilteringLifecycle({ markup });
  t.after(() => lifecycle.stop());

  lifecycle.sync();
  for (let scan = 1; scan < 5; scan += 1) lifecycle.scan();
  assert.equal(messages.at(-1).domHealth, 'degraded');

  lifecycle.stop();
  assert.equal(messages.at(-1).domHealth, 'ok');
  lifecycle.sync();
  assert.equal(messages.at(-1).domHealth, 'ok');
});

test('a route change resets degraded DOM health', (t) => {
  const markup = Array.from(
    { length: 8 },
    (_, index) => `<yt-lockup-view-model>
      <a href="/watch?v=video${index}"></a>
    </yt-lockup-view-model>`,
  ).join('');
  const { lifecycle, messages, setPathname } = setupFilteringLifecycle({
    markup,
  });
  t.after(() => lifecycle.stop());

  lifecycle.sync();
  for (let scan = 1; scan < 5; scan += 1) lifecycle.scan();
  assert.equal(messages.at(-1).domHealth, 'degraded');

  setPathname('/watch');
  lifecycle.sync();
  assert.equal(messages.at(-1).domHealth, 'ok');
});

test('a subframe never starts the content script or subscription collection', () => {
  let starts = 0;
  const top = {};
  const subframe = { top };

  assert.equal(
    startContentScript(subframe, () => {
      starts += 1;
    }),
    false,
  );
  assert.equal(starts, 0);
});

test('marker in a top-level subscriptions page runs automatic collection', async () => {
  const windowObject = {
    scrollToCalls: 0,
    scrollTo() {
      this.scrollToCalls += 1;
    },
  };
  windowObject.top = windowObject;
  const documentObject = {};
  const requests = [];
  const collects = [];
  const messages = [];

  const started = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: true,
    cachedSubs: new Set(['Cached']),
    documentObject,
    windowObject,
    requestCollection: async (options) => {
      requests.push(options);
      return options.collect();
    },
    collect: async (options) => {
      collects.push(options);
      return {
        names: ['Channel A', 'Channel B'],
        complete: true,
        diagnostics: { scrollAttempts: 3 },
      };
    },
    sendMessage: async (message) => messages.push(message),
  });

  assert.equal(started.mode, 'active');
  assert.equal(requests[0].force, true);
  assert.deepEqual(collects, [{ documentObject, windowObject }]);
  assert.deepEqual(messages, [{
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: true,
    count: 2,
    diagnostics: { scrollAttempts: 3 },
  }]);
});

test('marker cannot run automatic collection in a subframe', async () => {
  const windowObject = { top: {} };
  let requests = 0;

  const started = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: true,
    cachedSubs: null,
    documentObject: {},
    windowObject,
    requestCollection: async () => {
      requests += 1;
    },
  });

  assert.equal(started, null);
  assert.equal(requests, 0);
});

test('unmarked subscriptions page with an absent cache starts passive mode without scrolling', async () => {
  const windowObject = {
    top: null,
    scrollCalls: 0,
    scrollTo() {
      this.scrollCalls += 1;
    },
  };
  windowObject.top = windowObject;
  const controller = { stop() {} };
  let passiveCalls = 0;
  let activeCalls = 0;

  const started = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: false,
    cachedSubs: null,
    documentObject: {},
    windowObject,
    requestCollection: async () => {
      activeCalls += 1;
    },
    requestPassive: async () => {
      passiveCalls += 1;
      return controller;
    },
  });
  assert.deepEqual(started, { mode: 'passive', controller });
  assert.equal(passiveCalls, 1);
  assert.equal(activeCalls, 0);
  assert.equal(windowObject.scrollCalls, 0);
});

test('unmarked subscriptions page starts passive mode for a stale cache', async () => {
  const controller = { stop() {} };
  let passiveCalls = 0;

  const started = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: false,
    cachedSubs: new Set(['Channel A']),
    subsStale: true,
    documentObject: {},
    windowObject: {},
    requestPassive: async () => {
      passiveCalls += 1;
      return controller;
    },
  });

  assert.deepEqual(started, { mode: 'passive', controller });
  assert.equal(passiveCalls, 1);
});

test('unmarked subscriptions page does not start passive mode for a fresh cache', async () => {
  let passiveCalls = 0;

  const started = await startSubscriptionCollectionMode({
    pathname: '/feed/channels',
    collectMarker: false,
    cachedSubs: new Set(['Channel A']),
    subsStale: false,
    documentObject: {},
    windowObject: {},
    requestPassive: async () => {
      passiveCalls += 1;
    },
  });

  assert.equal(started, null);
  assert.equal(passiveCalls, 0);
});

test('pages outside the subscriptions feed start neither collection mode', async () => {
  let calls = 0;
  const result = await startSubscriptionCollectionMode({
    pathname: '/watch',
    collectMarker: true,
    cachedSubs: null,
    requestCollection: async () => {
      calls += 1;
    },
    requestPassive: async () => {
      calls += 1;
    },
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('yt-navigate-finish routing stops incomplete passive observation on navigation away', () => {
  let stops = 0;
  const controller = {
    stop() {
      stops += 1;
    },
  };

  assert.equal(
    stopPassiveCollectionOnNavigation(controller, '/feed/channels'),
    controller,
  );
  assert.equal(stops, 0);
  assert.equal(
    stopPassiveCollectionOnNavigation(controller, '/watch'),
    null,
  );
  assert.equal(stops, 1);
});

test('content result preserves a scrape reason and all diagnostics', () => {
  const diagnostics = {
    finalNameCount: 98,
    initialNameCount: 98,
    bottomReached: false,
    elapsedMs: 45_000,
    scrollAttempts: 12,
    continuationPresent: true,
  };

  assert.deepEqual(subscriptionCollectionResponse({
    names: Array(98).fill('Channel'),
    complete: false,
    reason: 'budget-expired',
    diagnostics,
  }), {
    reason: 'budget-expired',
    diagnostics,
  });
  assert.deepEqual(subscriptionCollectionResultMessage({
    names: Array(98).fill('Channel'),
    complete: false,
    reason: 'budget-expired',
    diagnostics,
  }), {
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: false,
    count: 98,
    reason: 'budget-expired',
    diagnostics,
  });
});

test('content response only reports a count for a non-empty complete scrape', () => {
  assert.deepEqual(subscriptionCollectionResponse({
    names: ['Channel A', 'Channel B'],
    complete: true,
  }), { count: 2 });
  assert.deepEqual(subscriptionCollectionResponse({
    names: [],
    complete: true,
  }), { reason: 'scrape-incomplete' });
});
