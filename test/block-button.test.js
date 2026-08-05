import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  attachBlockButtons,
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  dismissBlockToast,
  NOT_INTERESTED_BUTTON_CLASS,
  showBlockToast,
  TOAST_CLASS,
  TOAST_UNDO_CLASS,
} from '../src/dom/block-button.js';
import { readTile, TILE_SELECTOR } from '../src/dom/tile-adapter.js';

function setup(markup, shouldOffer) {
  const doc = html(markup);
  const blocked = [];
  const nativeActions = [];
  const run = () => {
    const options = {
      root: doc.body,
      tileSelector: TILE_SELECTOR,
      readTile,
      onBlock: (name) => blocked.push(name),
      onNativeAction: (request) => nativeActions.push(request.action),
      showToast: () => {},
      doc,
    };
    if (shouldOffer !== undefined) options.shouldOffer = shouldOffer;
    attachBlockButtons(options);
  };
  return { doc, blocked, nativeActions, run };
}

function settleEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

// readTile takes the channel from an aria-label, not from a channel href.
const tile = (id, videoId, channel) => `
  <yt-lockup-view-model id="${id}">
    <a href="/watch?v=${videoId}"></a>
    <a aria-label="Go to channel ${channel}"></a>
  </yt-lockup-view-model>`;

test('adds a button and host class to a tile that has a channel', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
  assert.ok(doc.querySelector('#a').classList.contains(BLOCK_HOST_CLASS));
});

test('clicking the button reports the trimmed channel name', () => {
  const { doc, blocked, run } = setup(tile('a', 'video1', '  Some Channel  '));
  run();
  doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();

  assert.deepEqual(blocked, ['Some Channel']);
});

test('block button fires the native action and unconditional local block write', () => {
  const { doc, blocked, nativeActions, run } =
    setup(tile('a', 'video1', 'Some Channel'));
  run();
  doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();

  assert.deepEqual(nativeActions, ['dontRecommendChannel']);
  assert.deepEqual(blocked, ['Some Channel']);
});

test('is idempotent across repeated scans', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  run();
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('a recycled tile reports its new channel', () => {
  const { doc, blocked, run } = setup(tile('a', 'video1', 'First Channel'));
  run();
  doc.querySelector('[aria-label^="Go to channel"]')
    .setAttribute('aria-label', 'Go to channel Second Channel');
  run();
  doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();

  assert.deepEqual(blocked, ['Second Channel']);
});

test('does not add a button to a tile without a channel', () => {
  const { doc, run } = setup(`
    <yt-lockup-view-model id="a">
      <a href="/watch?v=video1"></a>
    </yt-lockup-view-model>`);
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
});

test('does not add a button when shouldOffer returns false', () => {
  const { doc, run } = setup(
    tile('a', 'video1', 'Subscribed Channel'),
    () => false,
  );
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
  assert.ok(doc.querySelector('#a').classList.contains(BLOCK_HOST_CLASS));
});

test('subscribed tiles show not-interested but suppress block-channel', () => {
  const { doc, blocked, nativeActions, run } = setup(
    tile('a', 'video1', 'Subscribed Channel'),
    () => false,
  );
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
  const notInterested =
    doc.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`);
  assert.ok(notInterested);
  notInterested.click();
  assert.deepEqual(nativeActions, ['notInterested']);
  assert.deepEqual(blocked, []);
});

test('adds a button when shouldOffer returns true', () => {
  const { doc, run } = setup(
    tile('a', 'video1', 'Other Channel'),
    () => true,
  );
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('omitting shouldOffer preserves the default button behavior', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('RECYCLING: removes an existing button when the new channel is rejected', () => {
  const subscribed = new Set(['Subscribed Channel']);
  const { doc, run } = setup(
    tile('a', 'video1', 'Other Channel'),
    (channelName) => !subscribed.has(channelName),
  );
  run();

  doc.querySelector('[aria-label^="Go to channel"]')
    .setAttribute('aria-label', 'Go to channel Subscribed Channel');
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
  assert.ok(doc.querySelector('#a').classList.contains(BLOCK_HOST_CLASS));
});

test('RECYCLING: adds a button when the new channel is offered', () => {
  const subscribed = new Set(['Subscribed Channel']);
  const { doc, run } = setup(
    tile('a', 'video1', 'Subscribed Channel'),
    (channelName) => !subscribed.has(channelName),
  );
  run();
  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);

  doc.querySelector('[aria-label^="Go to channel"]')
    .setAttribute('aria-label', 'Go to channel Other Channel');
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
  assert.equal(
    doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).dataset.channelName,
    'Other Channel',
  );
});

test('null subscription state offers the block button', () => {
  const subs = null;
  const { doc, run } = setup(
    tile('a', 'video1', 'Unknown Subscription Status'),
    (channelName) => subs === null || !subs.has(channelName.trim()),
  );
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('a throwing readTile does not prevent later tiles from getting buttons', () => {
  const doc = html(tile('a', 'video1', 'First Channel') + tile('b', 'video2', 'Second Channel'));
  const throwingReadTile = (element) => {
    if (element.id === 'a') throw new Error('unreadable tile');
    return readTile(element);
  };

  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    readTile: throwingReadTile,
    onBlock: () => {},
    doc,
  });

  assert.equal(doc.querySelector('#a').querySelector(`.${BLOCK_BUTTON_CLASS}`), null);
  assert.ok(doc.querySelector('#b').querySelector(`.${BLOCK_BUTTON_CLASS}`));
});

test('a successful block renders the channel toast and Undo removes it', async () => {
  const doc = html(tile('a', 'video1', 'Some Channel'));
  const removed = [];
  const timers = [];

  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    readTile,
    onBlock: async () => {},
    onNativeAction: async () => {},
    removeBlockedChannel: async (channelName) => removed.push(channelName),
    showToast: (channelName, options) => showBlockToast(channelName, {
      ...options,
      setTimer(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimer() {},
    }),
    doc,
  });

  doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();
  await settleEvents();

  const toast = doc.querySelector(`.${TOAST_CLASS}`);
  assert.ok(toast);
  assert.equal(toast.firstChild.textContent, 'Blocked Some Channel');
  assert.equal(timers[0].delay, 6_000);
  toast.querySelector(`.${TOAST_UNDO_CLASS}`).click();
  await settleEvents();
  assert.deepEqual(removed, ['Some Channel']);
  assert.equal(doc.querySelector(`.${TOAST_CLASS}`), null);
});

test('a block toast auto-dismisses after six seconds', () => {
  const doc = html('');
  let expire;
  showBlockToast('Timed Channel', {
    doc,
    setTimer(callback, delay) {
      assert.equal(delay, 6_000);
      expire = callback;
      return 1;
    },
    clearTimer() {},
  });
  assert.ok(doc.querySelector(`.${TOAST_CLASS}`));

  expire();

  assert.equal(doc.querySelector(`.${TOAST_CLASS}`), null);
});

test('a second block replaces the existing toast', () => {
  const doc = html('');
  const cleared = [];
  let nextTimer = 0;
  const options = {
    doc,
    setTimer() {
      nextTimer += 1;
      return nextTimer;
    },
    clearTimer(timer) {
      cleared.push(timer);
    },
  };

  showBlockToast('First Channel', options);
  showBlockToast('Second Channel', options);

  const toasts = doc.querySelectorAll(`.${TOAST_CLASS}`);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].firstChild.textContent, 'Blocked Second Channel');
  assert.deepEqual(cleared, [1]);
  dismissBlockToast(doc);
});
