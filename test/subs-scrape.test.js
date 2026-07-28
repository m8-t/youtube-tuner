import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import { extractSubscriptionNames } from '../src/subs-scrape.js';
import {
  collectSubscriptions,
  observeSubscriptionList,
  requestSubscriptionCollection,
  saveCompleteSubscriptionResult,
} from '../src/subs-refresh.js';

function channelMarkup(count, continuationPresent = false) {
  const channels = Array.from(
    { length: count },
    (_, index) =>
      `<ytd-channel-renderer><span id="channel-title">Channel ${index}</span></ytd-channel-renderer>`,
  ).join('');
  return channels + (
    continuationPresent
      ? '<ytd-continuation-item-renderer></ytd-continuation-item-renderer>'
      : ''
  );
}

function scrapeHarness({
  counts,
  heights,
  continuations = counts.map(() => false),
  intervalMs = 100,
}) {
  const documentObject = html(channelMarkup(counts[0], continuations[0]));
  let step = 0;
  let elapsed = 0;

  Object.defineProperty(documentObject.documentElement, 'scrollHeight', {
    get: () => heights[step],
  });
  Object.defineProperty(documentObject.body, 'scrollHeight', {
    get: () => heights[step],
  });

  const scrollCalls = {
    bottom: 0,
    continuation: 0,
  };
  const windowObject = {
    innerHeight: 900,
    scrollY: 0,
    scrollTo(_x, y) {
      scrollCalls.bottom += 1;
      this.scrollY = Math.max(0, Math.min(y, heights[step] - this.innerHeight));
    },
  };
  const continuationElement = {
    scrollIntoView() {
      scrollCalls.continuation += 1;
      windowObject.scrollY = Math.max(
        0,
        heights[step] - windowObject.innerHeight,
      );
    },
  };

  return {
    documentObject,
    windowObject,
    getContinuationElement: (receivedDocument) => {
      assert.equal(receivedDocument, documentObject);
      return continuations[step] ? continuationElement : null;
    },
    now: () => elapsed,
    pause: async (milliseconds) => {
      elapsed += milliseconds;
      if (step < counts.length - 1) {
        step += 1;
        documentObject.body.innerHTML = channelMarkup(
          counts[step],
          continuations[step],
        );
      }
    },
    intervalMs,
    scrollCalls,
  };
}

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
    },
    async set(items) {
      Object.assign(values, items);
    },
  };
}

const EMPTY_DIAGNOSTICS = {
  finalNameCount: 0,
  initialNameCount: 0,
  bottomReached: false,
  elapsedMs: 0,
  scrollAttempts: 0,
  continuationPresent: null,
};

function assertFailure(result, reason, diagnostics) {
  assert.equal(result.complete, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(result.diagnostics, diagnostics);
}

test('extracts rendered channel names from a Document and dedupes them', () => {
  const documentObject = html(`
    <ytd-channel-renderer>
      <a id="channel-title"> Channel A </a>
    </ytd-channel-renderer>
    <ytd-grid-channel-renderer>
      <span id="channel-title">Channel B</span>
    </ytd-grid-channel-renderer>
    <yt-lockup-view-model>
      <a href="/@channel-c"><span class="yt-core-attributed-string">Channel C</span></a>
    </yt-lockup-view-model>
    <ytd-channel-renderer>
      <span id="channel-title">Channel A</span>
    </ytd-channel-renderer>
  `);

  assert.deepEqual(extractSubscriptionNames(documentObject), [
    'Channel A',
    'Channel B',
    'Channel C',
  ]);
  assert.deepEqual(extractSubscriptionNames(null), []);
});

test('extracts the first channel name from duplicated multiline text', () => {
  const documentObject = html(`
    <ytd-channel-renderer>
      <span id="channel-title"></span>
    </ytd-channel-renderer>
  `);
  documentObject.querySelector('#channel-title').textContent =
    'hessencam\n  \n  \n  \n    hessencam';

  assert.deepEqual(extractSubscriptionNames(documentObject), ['hessencam']);
});

test('extracts first non-empty lines from fallback attributes without collapsing spaces', () => {
  const elements = [
    {
      textContent: '\n ',
      getAttribute: (name) => (
        name === 'aria-label' ? '\n  Aria  Channel\nDuplicate' : null
      ),
    },
    {
      textContent: '',
      getAttribute: (name) => (
        name === 'title' ? '\n  Title  Channel\nDuplicate' : ''
      ),
    },
  ];
  const documentObject = {
    querySelectorAll: () => elements,
  };

  assert.deepEqual(extractSubscriptionNames(documentObject), [
    'Aria  Channel',
    'Title  Channel',
  ]);
});

test('scrape scrolls a present continuation element into view', async () => {
  const harness = scrapeHarness({
    counts: [5],
    heights: [1000],
    continuations: [true],
  });
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 1000,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(harness.scrollCalls.continuation, 3);
  assert.equal(harness.scrollCalls.bottom, 0);
});

test('scrape falls back to scrolling to the bottom without a continuation', async () => {
  const harness = scrapeHarness({
    counts: [5],
    heights: [1000],
  });

  const result = await collectSubscriptions({
    documentObject: harness.documentObject,
    windowObject: harness.windowObject,
    getContinuationElement: harness.getContinuationElement,
    now: harness.now,
    pause: harness.pause,
    intervalMs: harness.intervalMs,
    budgetMs: 1000,
  });

  assert.equal(result.complete, true);
  assert.equal(harness.scrollCalls.continuation, 0);
  assert.equal(harness.scrollCalls.bottom, 3);
});

test('scrape above 98 stabilizes at the bottom and is saved', async () => {
  const harness = scrapeHarness({
    counts: [98, 98, 98, 98, 120, 120, 120, 120],
    heights: [1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000],
  });
  const saves = [];

  const result = await requestSubscriptionCollection({
    force: true,
    storage: memoryStorage(),
    now: 1000,
    collect: () => collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 1000,
    }),
    save: async (names) => saves.push(names),
  });

  assert.equal(result.complete, true);
  assert.equal(result.names.length, 120);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].length, 120);
});

test('a small complete account is saved without needing its count to grow', async () => {
  const harness = scrapeHarness({
    counts: [5],
    heights: [1000],
  });
  const saves = [];

  const result = await requestSubscriptionCollection({
    force: true,
    storage: memoryStorage(),
    now: 1000,
    collect: () => collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 1000,
    }),
    save: async (names) => saves.push(names),
  });

  assert.equal(result.complete, true);
  assert.equal(result.names.length, 5);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], result.names);
});

test('a continuation at budget expiry is incomplete and is never saved', async () => {
  const harness = scrapeHarness({
    counts: [98, 98, 98, 98, 105, 110, 115, 120],
    heights: [1000, 1000, 1000, 1000, 1200, 1400, 1600, 1800],
    continuations: [true, true, true, true, true, true, true, true],
  });
  let saveCalls = 0;

  const result = await requestSubscriptionCollection({
    force: true,
    storage: memoryStorage(),
    now: 1000,
    collect: () => collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 700,
    }),
    save: async () => {
      saveCalls += 1;
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.names.length, 120);
  assert.equal(result.reason, 'budget-expired');
  assert.deepEqual(result.diagnostics, {
    finalNameCount: 120,
    initialNameCount: 98,
    bottomReached: false,
    elapsedMs: 700,
    scrollAttempts: 4,
    continuationPresent: true,
  });
  assert.equal(saveCalls, 0, 'saveSubs must not be called');
});

test('growing counts save only after the continuation disappears', async () => {
  const harness = scrapeHarness({
    counts: [2, 2, 2, 2, 4, 6, 6, 6, 6, 6],
    heights: [1000, 1000, 1000, 1000, 1500, 2000, 2000, 2000, 2000, 2000],
    continuations: [true, true, true, true, true, false, false, false, false, false],
  });
  const saves = [];

  const result = await requestSubscriptionCollection({
    force: true,
    storage: memoryStorage(),
    now: 1000,
    collect: () => collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 1200,
    }),
    save: async (names) => saves.push(names),
  });

  assert.equal(result.complete, true);
  assert.equal(result.names.length, 6);
  assert.equal(result.diagnostics.continuationPresent, false);
  assert.equal(harness.scrollCalls.continuation, 2);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], result.names);
});

test('an unchanged count with a continuation fails closed and is not saved', async () => {
  const harness = scrapeHarness({
    counts: [98],
    heights: [1000],
    continuations: [true],
  });
  let saveCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const result = await requestSubscriptionCollection({
      force: true,
      storage: memoryStorage(),
      now: 1000,
      collect: () => collectSubscriptions({
        documentObject: harness.documentObject,
        windowObject: harness.windowObject,
        getContinuationElement: harness.getContinuationElement,
        now: harness.now,
        pause: harness.pause,
        intervalMs: harness.intervalMs,
        budgetMs: 1000,
      }),
      save: async () => {
        saveCalls += 1;
      },
    });

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'continuation-present');
    assert.equal(result.names.length, 98);
    assert.equal(saveCalls, 0, 'saveSubs must not be called');
  } finally {
    console.warn = originalWarn;
  }
});

test('a stable continuation element fails closed with continuation-present', async () => {
  const harness = scrapeHarness({
    counts: [5],
    heights: [1000],
    continuations: [true],
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const result = await collectSubscriptions({
      documentObject: harness.documentObject,
      windowObject: harness.windowObject,
      getContinuationElement: harness.getContinuationElement,
      now: harness.now,
      pause: harness.pause,
      intervalMs: harness.intervalMs,
      budgetMs: 1000,
    });

    assertFailure(result, 'continuation-present', {
      finalNameCount: 5,
      initialNameCount: 5,
      bottomReached: true,
      elapsedMs: 600,
      scrollAttempts: 3,
      continuationPresent: true,
    });
    assert.equal(result.names.length, 5);
    assert.equal(
      warnings.some(([message]) => message ===
        '[youtube-tuner] continuation-present'),
      true,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('an inaccessible document fails closed with doc-inaccessible', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const result = await collectSubscriptions({
      windowObject: {},
      documentObject: null,
    });

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'doc-inaccessible');
    assert.ok(result.diagnostics.elapsedMs >= 0);
    assert.equal(result.diagnostics.bottomReached, false);
    assert.equal(result.diagnostics.continuationPresent, null);
    assert.equal(result.diagnostics.initialNameCount, 0);
    assert.equal(result.diagnostics.finalNameCount, 0);
    assert.equal(result.diagnostics.scrollAttempts, 0);
    assert.deepEqual(result.names, []);
    assert.equal(
      warnings.some(([message]) => message ===
        '[youtube-tuner] doc-inaccessible'),
      true,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('a last-check count change resets stability and fails closed', async () => {
  const harness = scrapeHarness({
    counts: [98, 98, 98, 98, 120, 120, 120, 121],
    heights: [1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000],
  });

  const result = await collectSubscriptions({
    documentObject: harness.documentObject,
    windowObject: harness.windowObject,
    getContinuationElement: harness.getContinuationElement,
    now: harness.now,
    pause: harness.pause,
    intervalMs: harness.intervalMs,
    budgetMs: 800,
  });

  assertFailure(result, 'count-unstable', {
    finalNameCount: 121,
    initialNameCount: 98,
    bottomReached: true,
    elapsedMs: 800,
    scrollAttempts: 5,
    continuationPresent: false,
  });
  assert.equal(result.names.length, 121);
});

test('stable content that never reaches the bottom is incomplete', async () => {
  const harness = scrapeHarness({
    counts: [98, 120, 120, 120, 120],
    heights: [1000, 2000, 2000, 2000, 2000],
  });
  harness.windowObject.scrollTo = () => {};

  const result = await collectSubscriptions({
    documentObject: harness.documentObject,
    windowObject: harness.windowObject,
    getContinuationElement: harness.getContinuationElement,
    now: harness.now,
    pause: harness.pause,
    intervalMs: harness.intervalMs,
    budgetMs: 500,
  });

  assertFailure(result, 'bottom-not-reached', {
    finalNameCount: 120,
    initialNameCount: 98,
    bottomReached: false,
    elapsedMs: 500,
    scrollAttempts: 1,
    continuationPresent: false,
  });
});

test('an empty settled scrape returns empty-names with counters', async () => {
  const harness = scrapeHarness({
    counts: [1, 1, 1, 1, 0, 0, 0, 0],
    heights: [900, 900, 900, 900, 900, 900, 900, 900],
  });

  const result = await collectSubscriptions({
    documentObject: harness.documentObject,
    windowObject: harness.windowObject,
    getContinuationElement: harness.getContinuationElement,
    now: harness.now,
    pause: harness.pause,
    intervalMs: harness.intervalMs,
    budgetMs: 1000,
  });

  assertFailure(result, 'empty-names', {
    finalNameCount: 0,
    initialNameCount: 1,
    bottomReached: true,
    elapsedMs: 700,
    scrollAttempts: 4,
    continuationPresent: false,
  });
});

test('an unexpected scrape error returns scrape-exception with counters', async () => {
  const harness = scrapeHarness({
    counts: [5],
    heights: [900],
  });

  const result = await collectSubscriptions({
    documentObject: harness.documentObject,
    windowObject: harness.windowObject,
    getContinuationElement: harness.getContinuationElement,
    extractNames: () => {
      throw new Error('broken extractor');
    },
    now: harness.now,
    pause: harness.pause,
  });

  assertFailure(result, 'scrape-exception', {
    ...EMPTY_DIAGNOSTICS,
    continuationPresent: false,
  });
});

test('automatic collection requests are throttled for one hour', async () => {
  const now = 1_000_000;
  const storage = memoryStorage({ subsRefreshAttemptedAt: now - 1 });
  let collectCalls = 0;

  const result = await requestSubscriptionCollection({
    storage,
    now,
    collect: async () => {
      collectCalls += 1;
      return { names: ['Channel A'], complete: true };
    },
  });

  assertFailure(result, 'refresh-throttled', EMPTY_DIAGNOSTICS);
  assert.deepEqual(result.names, []);
  assert.equal(collectCalls, 0);
});

test('forced collection bypasses the retry guard', async () => {
  const now = 1_000_000;
  const storage = memoryStorage({ subsRefreshAttemptedAt: now - 1 });
  let collectCalls = 0;

  const result = await requestSubscriptionCollection({
    storage,
    now,
    force: true,
    collect: async () => {
      collectCalls += 1;
      return { names: [], complete: false };
    },
  });

  assert.equal(result.complete, false);
  assert.equal(collectCalls, 1);
  assert.equal(storage.values.subsRefreshAttemptedAt, now);
});

test('passive mode saves after the sentinel disappears and names stay stable', async () => {
  const documentObject = html(channelMarkup(4, true));
  const saves = [];
  let disconnected = false;
  let complete;
  const completed = new Promise((resolve) => {
    complete = resolve;
  });
  class Observer {
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }

  const controller = observeSubscriptionList({
    documentObject,
    MutationObserverObject: Observer,
    scheduleTimeout: () => 1,
    cancelTimeout: () => {},
    save: async (names) => saves.push(names),
    onComplete: complete,
  });

  documentObject.body.innerHTML = channelMarkup(4, false);
  controller.check();
  controller.check();
  controller.check();
  controller.check();
  const result = await completed;

  assert.equal(result.complete, true);
  assert.equal(result.names.length, 4);
  assert.equal(result.diagnostics.continuationPresent, false);
  assert.equal(result.diagnostics.scrollAttempts, 0);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], result.names);
  assert.equal(disconnected, true);
  assert.equal(controller.isActive(), false);
});

test('stopping passive mode on navigation saves nothing and reports no error', async () => {
  const documentObject = html(channelMarkup(4, true));
  let saveCalls = 0;
  let errorCalls = 0;
  class Observer {
    observe() {}
    disconnect() {}
  }

  const controller = observeSubscriptionList({
    documentObject,
    MutationObserverObject: Observer,
    scheduleTimeout: () => 1,
    cancelTimeout: () => {},
    save: async () => {
      saveCalls += 1;
    },
    onError: () => {
      errorCalls += 1;
    },
  });

  controller.stop();
  documentObject.body.innerHTML = channelMarkup(4, false);
  controller.check();
  controller.check();
  controller.check();
  controller.check();
  await Promise.resolve();

  assert.equal(saveCalls, 0);
  assert.equal(errorCalls, 0);
  assert.equal(controller.isActive(), false);
});

test('the save gate requires complete true and a non-empty names array', async () => {
  const saves = [];
  const save = async (names) => saves.push(names);

  assert.equal(await saveCompleteSubscriptionResult({
    complete: false,
    names: ['Partial Channel'],
  }, save), false);
  assert.equal(await saveCompleteSubscriptionResult({
    complete: true,
    names: [],
  }, save), false);
  assert.equal(await saveCompleteSubscriptionResult({
    complete: true,
    names: new Set(['Wrong Shape']),
  }, save), false);
  assert.equal(await saveCompleteSubscriptionResult({
    complete: true,
    names: ['Complete Channel'],
  }, save), true);

  assert.deepEqual(saves, [['Complete Channel']]);
});
