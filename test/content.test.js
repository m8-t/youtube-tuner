import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  SUBS_COLLECTION_RESULT_MESSAGE,
  createFilteringLifecycle,
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
} = {}) {
  const doc = html(lifecycleTile);
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
