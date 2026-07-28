import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  createSubscribeCapture,
  SUBSCRIBE_BUTTON_SELECTOR,
  OWNER_SELECTOR,
  SUBSCRIBE_LABELS,
  SUBSCRIBED_LABELS,
  UNSUB_PENDING_TTL_MS,
  CHANNEL_LINK_SELECTOR,
} from '../src/subs-capture.js';

// The owner wrapper and textless-avatar-then-named-anchor shape were verified
// in the live watch-page environment on 2026-07-28.
function captureFixture({
  label = 'Subscribe',
  channelMarkup =
    '<a href="/@channel"></a><a href="/@ChannelName">Channel Name</a>',
  insideOwner = true,
} = {}) {
  const button = `
    <ytd-subscribe-button-renderer>
      <button id="subscribe">${label}</button>
    </ytd-subscribe-button-renderer>
  `;
  const markup = insideOwner
    ? `<div id="owner">${channelMarkup}${button}</div>`
    : button;
  return html(`${markup}<button id="random">Random</button>`);
}

function setupCapture({
  doc = captureFixture(),
  pathname = '/watch',
  getPathname = () => pathname,
  enabled = true,
  addResult = true,
  removeResult = true,
  now = () => 0,
} = {}) {
  const addCalls = [];
  const removeCalls = [];
  const logCalls = [];
  const timeoutCallbacks = [];
  const capture = createSubscribeCapture({
    documentObject: doc,
    getPathname,
    getEnabled: () => enabled,
    addNames: async (names) => {
      addCalls.push(names);
      return addResult;
    },
    removeNames: async (names) => {
      removeCalls.push(names);
      return removeResult;
    },
    setTimeoutFn: (callback) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    },
    now,
    log: (...args) => logCalls.push(args),
  });
  return {
    addCalls,
    capture,
    doc,
    logCalls,
    removeCalls,
    timeoutCallbacks,
  };
}

function click(capture, target) {
  return capture.handleClick({ target });
}

function replaceOwner(doc, {
  label,
  channelName = 'Channel Name',
} = {}) {
  const owner = doc.querySelector(OWNER_SELECTOR);
  owner.replaceWith(captureFixture({
    label,
    channelMarkup: `<a href="/@channel">${channelName}</a>`,
  }).querySelector(OWNER_SELECTOR));
}

test('capture selectors and labels are exported from one module', () => {
  assert.equal(
    SUBSCRIBE_BUTTON_SELECTOR,
    'ytd-subscribe-button-renderer, yt-subscribe-button-view-model',
  );
  assert.equal(OWNER_SELECTOR, '#owner');
  assert.deepEqual([...SUBSCRIBE_LABELS], ['Abonnieren', 'Subscribe']);
  assert.deepEqual([...SUBSCRIBED_LABELS], ['Abonniert', 'Subscribed']);
  assert.equal(UNSUB_PENDING_TTL_MS, 15_000);
  assert.equal(
    CHANNEL_LINK_SELECTOR,
    'a[href^="/@"], a[href^="/channel/"]',
  );
});

test('captures an Abonnieren click from the watch-page owner', async () => {
  const { addCalls, capture, doc, logCalls } = setupCapture({
    doc: captureFixture({ label: 'Abonnieren' }),
  });

  await capture.handleClick({
    target: doc.querySelector('#subscribe'),
    composedPath: () => [doc.querySelector('#subscribe')],
  });

  assert.deepEqual(addCalls, [['Channel Name']]);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: added "Channel Name"'],
  ]);
});

test('captures a Subscribe click from the watch-page owner', async () => {
  const { addCalls, capture, doc } = setupCapture();

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, [['Channel Name']]);
});

test('Abonniert and Subscribed clicks arm unsubscribe capture without adding', async () => {
  for (const label of ['Abonniert', 'Subscribed']) {
    const {
      addCalls,
      capture,
      doc,
      logCalls,
      removeCalls,
      timeoutCallbacks,
    } = setupCapture({
      doc: captureFixture({ label }),
    });

    await capture.handleClick({ target: doc.querySelector('#subscribe') });

    assert.deepEqual(addCalls, [], label);
    assert.deepEqual(removeCalls, [], label);
    assert.deepEqual(timeoutCallbacks, [], label);
    assert.deepEqual(
      logCalls,
      [['[youtube-tuner] subs-capture: unsub-armed "Channel Name"']],
      label,
    );
  }
});

test('an unknown owner-button label logs label-mismatch', async () => {
  const { addCalls, capture, doc, logCalls, removeCalls } = setupCapture({
    doc: captureFixture({ label: 'Unknown label' }),
  });

  await click(capture, doc.querySelector('#subscribe'));

  assert.deepEqual(addCalls, []);
  assert.deepEqual(removeCalls, []);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: label-mismatch'],
  ]);
});

test('unsubscribe removal requires two agreeing fresh document reads', async () => {
  const {
    capture,
    doc,
    logCalls,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
  });

  await click(capture, doc.querySelector('#subscribe'));
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  assert.equal(timeoutCallbacks.length, 1);

  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, []);
  assert.equal(timeoutCallbacks.length, 1);

  replaceOwner(doc, { label: 'Abonnieren' });
  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, [['Channel Name']]);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: unsub-armed "Channel Name"'],
    ['[youtube-tuner] subs-capture: removed "Channel Name"'],
  ]);

  await click(capture, doc.querySelector('#random'));
  assert.deepEqual(timeoutCallbacks, []);
  assert.deepEqual(removeCalls, [['Channel Name']]);
});

test('a subscribed first re-read keeps unsubscribe pending for a later flip', async () => {
  const {
    capture,
    doc,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
  });

  await click(capture, doc.querySelector('#subscribe'));
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, []);
  assert.deepEqual(timeoutCallbacks, []);

  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, [['Channel Name']]);
});

test('a transient subscribe label that disagrees on confirm never removes', async () => {
  const {
    capture,
    doc,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
  });

  await click(capture, doc.querySelector('#subscribe'));
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  assert.equal(timeoutCallbacks.length, 1);

  replaceOwner(doc, { label: 'Abonniert' });
  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, []);

  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  await timeoutCallbacks.shift()();
  assert.deepEqual(removeCalls, [['Channel Name']]);
});

test('an unsubscribe pending past its TTL is dropped on the next click', async () => {
  let currentNow = 10;
  const {
    capture,
    doc,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
    now: () => currentNow,
  });

  await click(capture, doc.querySelector('#subscribe'));
  currentNow += UNSUB_PENDING_TTL_MS + 1;
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));

  assert.deepEqual(timeoutCallbacks, []);
  assert.deepEqual(removeCalls, []);
});

test('an unsubscribe pending is dropped after SPA pathname change', async () => {
  let pathname = '/watch';
  const {
    capture,
    doc,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
    getPathname: () => pathname,
  });

  await click(capture, doc.querySelector('#subscribe'));
  pathname = '/results';
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  pathname = '/watch';
  await click(capture, doc.querySelector('#random'));

  assert.deepEqual(timeoutCallbacks, []);
  assert.deepEqual(removeCalls, []);
});

test('a fresh re-read with a different owner name never removes', async () => {
  const {
    capture,
    doc,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
  });

  await click(capture, doc.querySelector('#subscribe'));
  replaceOwner(doc, {
    label: 'Abonnieren',
    channelName: 'Different Channel',
  });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();

  assert.deepEqual(timeoutCallbacks, []);
  assert.deepEqual(removeCalls, []);
});

test('unsubscribe removal logs a no-op result and clears pending', async () => {
  const {
    capture,
    doc,
    logCalls,
    removeCalls,
    timeoutCallbacks,
  } = setupCapture({
    doc: captureFixture({ label: 'Abonniert' }),
    removeResult: false,
  });

  await click(capture, doc.querySelector('#subscribe'));
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  await timeoutCallbacks.shift()();

  assert.deepEqual(removeCalls, [['Channel Name']]);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: unsub-armed "Channel Name"'],
    ['[youtube-tuner] subs-capture: remove-noop'],
  ]);
  await click(capture, doc.querySelector('#random'));
  assert.deepEqual(timeoutCallbacks, []);
});

test('unsubscribe removal errors are logged, caught, and clear pending', async () => {
  const doc = captureFixture({ label: 'Abonniert' });
  const error = new Error('storage failed');
  const logCalls = [];
  const removeCalls = [];
  const timeoutCallbacks = [];
  const capture = createSubscribeCapture({
    documentObject: doc,
    getPathname: () => '/watch',
    getEnabled: () => true,
    addNames: async () => true,
    removeNames: async (names) => {
      removeCalls.push(names);
      throw error;
    },
    setTimeoutFn: (callback) => timeoutCallbacks.push(callback),
    now: () => 0,
    log: (...args) => logCalls.push(args),
  });

  await click(capture, doc.querySelector('#subscribe'));
  replaceOwner(doc, { label: 'Abonnieren' });
  await click(capture, doc.querySelector('#random'));
  await timeoutCallbacks.shift()();
  await assert.doesNotReject(timeoutCallbacks.shift()());

  assert.deepEqual(removeCalls, [['Channel Name']]);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: unsub-armed "Channel Name"'],
    ['[youtube-tuner] subs-capture: remove-failed', error],
  ]);
  await click(capture, doc.querySelector('#random'));
  assert.deepEqual(timeoutCallbacks, []);
});

test('the subscribe add path still works after unsubscribe restructuring', async () => {
  const { addCalls, capture, doc, removeCalls, timeoutCallbacks } =
    setupCapture({
      doc: captureFixture({ label: 'Abonnieren' }),
    });

  await click(capture, doc.querySelector('#subscribe'));

  assert.deepEqual(addCalls, [['Channel Name']]);
  assert.deepEqual(removeCalls, []);
  assert.deepEqual(timeoutCallbacks, []);
});

test('does not capture a subscribe button outside the owner renderer', async () => {
  const { addCalls, capture, doc, logCalls } = setupCapture({
    doc: captureFixture({ insideOwner: false }),
  });

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, []);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: outside-owner'],
  ]);
});

test('random clicks bail silently', async () => {
  const { addCalls, capture, doc, logCalls } = setupCapture();

  await capture.handleClick({ target: doc.querySelector('#random') });

  assert.deepEqual(addCalls, []);
  assert.deepEqual(logCalls, []);
});

test('route and enabled gates prevent capture', async () => {
  for (const options of [
    { pathname: '/' },
    { enabled: false },
  ]) {
    const { addCalls, capture, doc, logCalls } = setupCapture(options);

    await capture.handleClick({ target: doc.querySelector('#subscribe') });

    assert.deepEqual(addCalls, []);
    assert.deepEqual(logCalls, []);
  }
});

test('an owner without a channel anchor bails with a reason', async () => {
  const { addCalls, capture, doc, logCalls } = setupCapture({
    doc: captureFixture({ channelMarkup: '<span>Channel Name</span>' }),
  });

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, []);
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: no-channel-name'],
  ]);
});

test('skips the textless avatar anchor and captures the named anchor first non-empty line', async () => {
  const { addCalls, capture, doc } = setupCapture({
    doc: captureFixture({
      channelMarkup: `
        <a href="/@channel"></a>
        <a href="/@Imperial">

          Imperial War Museums
          ignored later line
        </a>
      `,
    }),
  });

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, [['Imperial War Museums']]);
});

test('normalizes a duplicated multiline owner channel name', async () => {
  const { addCalls, capture, doc } = setupCapture({
    doc: captureFixture({
      channelMarkup: `
        <a href="/channel/example">
          hessencam



          hessencam
        </a>
      `,
    }),
  });

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, [['hessencam']]);
});

test('a false add result logs the no-cache or already-present bail', async () => {
  const { addCalls, capture, doc, logCalls } = setupCapture({
    addResult: false,
  });

  await capture.handleClick({ target: doc.querySelector('#subscribe') });

  assert.deepEqual(addCalls, [['Channel Name']]);
  assert.deepEqual(logCalls, [['[youtube-tuner] subs-capture: no-cache']]);
});

test('add errors are caught and logged without escaping into the page', async () => {
  const doc = captureFixture();
  const error = new Error('storage failed');
  const logCalls = [];
  const capture = createSubscribeCapture({
    documentObject: doc,
    getPathname: () => '/watch',
    getEnabled: () => true,
    addNames: async () => {
      throw error;
    },
    removeNames: async () => true,
    log: (...args) => logCalls.push(args),
  });

  await assert.doesNotReject(
    capture.handleClick({ target: doc.querySelector('#subscribe') }),
  );
  assert.deepEqual(logCalls, [
    ['[youtube-tuner] subs-capture: add-failed', error],
  ]);
});

test('stop detaches the capture-phase click listener', async () => {
  const { addCalls, capture, doc } = setupCapture();
  const subscribe = doc.querySelector('#subscribe');
  capture.start();

  subscribe.dispatchEvent(new doc.defaultView.MouseEvent('click', {
    bubbles: true,
    composed: true,
  }));
  await Promise.resolve();
  assert.deepEqual(addCalls, [['Channel Name']]);

  addCalls.length = 0;
  capture.stop();

  subscribe.dispatchEvent(new doc.defaultView.MouseEvent('click', {
    bubbles: true,
    composed: true,
  }));
  await Promise.resolve();

  assert.deepEqual(addCalls, []);
});
