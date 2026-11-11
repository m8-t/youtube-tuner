import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  attachBlockButtons,
  armNativeUndo,
  disarmNativeUndo,
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  HIDE_VIDEO_BUTTON_CLASS,
  NO_BLOCK_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
  readNativeUndo,
} from '../src/dom/block-button.js';
import { readTile, TILE_SELECTOR } from '../src/dom/tile-adapter.js';

function setup(markup, defaults = {}) {
  const doc = html(markup);
  const calls = { hide: [], block: [], feedback: [], native: [] };
  const run = (overrides = {}) => attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    readTile,
    doc,
    onHideVideo: (tile, element) => calls.hide.push([tile.videoId, element.id]),
    onBlock: (channelName, tile, element) =>
      calls.block.push([channelName, tile.videoId, element.id]),
    onNativeFeedback: (tile, element) =>
      calls.feedback.push([tile.videoId, element.id]),
    onNativeAction: (request) =>
      calls.native.push([request.action, request.tile.id]),
    ...defaults,
    ...overrides,
  });
  return { doc, calls, run };
}

// readTile takes the channel from an aria-label, not from a channel href.
const tile = (id, videoId, channel) => `
  <yt-lockup-view-model id="${id}">
    <a href="/watch?v=${videoId}"></a>
    ${channel ? `<a aria-label="Go to channel ${channel}"></a>` : ''}
  </yt-lockup-view-model>`;

const one = (doc, className) => doc.querySelector(`.${className}`);
const count = (doc, className) => doc.querySelectorAll(`.${className}`).length;

test('a tile gets a local hide control and a block control', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();

  assert.equal(count(doc, HIDE_VIDEO_BUTTON_CLASS), 1);
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
  assert.ok(doc.querySelector('#a').classList.contains(BLOCK_HOST_CLASS));
});

test('LOCAL FIRST: by default no control that talks to YouTube exists', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();

  assert.equal(count(doc, NOT_INTERESTED_BUTTON_CLASS), 0);
  assert.equal(count(doc, WATCH_LATER_BUTTON_CLASS), 0);
});

test('LOCAL FIRST: hide and block report to their handlers and run no native action', () => {
  const { doc, calls, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();

  one(doc, HIDE_VIDEO_BUTTON_CLASS).click();
  one(doc, BLOCK_BUTTON_CLASS).click();

  assert.deepEqual(calls.hide, [['video1', 'a']]);
  assert.deepEqual(calls.block, [['Some Channel', 'video1', 'a']]);
  assert.deepEqual(calls.native, []);
  assert.deepEqual(calls.feedback, []);
});

test('the YouTube-feedback control appears only when offered and reports its tile', () => {
  const { doc, calls, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerNativeFeedback: true });

  const button = one(doc, NOT_INTERESTED_BUTTON_CLASS);
  assert.ok(button);
  assert.match(button.title, /tells YouTube/);
  assert.match(button.title, /Google account/);
  button.click();
  assert.deepEqual(calls.feedback, [['video1', 'a']]);

  run({ offerNativeFeedback: false });
  assert.equal(count(doc, NOT_INTERESTED_BUTTON_CLASS), 0);
});

test('controls are labelled for assistive technology and use icons, not emoji', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerWatchLater: true, offerNativeFeedback: true });

  for (const className of [
    HIDE_VIDEO_BUTTON_CLASS,
    BLOCK_BUTTON_CLASS,
    WATCH_LATER_BUTTON_CLASS,
    NOT_INTERESTED_BUTTON_CLASS,
  ]) {
    const button = one(doc, className);
    assert.ok(button.getAttribute('aria-label').length > 0, className);
    assert.equal(button.getAttribute('aria-label'), button.title);
    assert.equal(button.textContent, '');
    assert.equal(button.querySelectorAll('svg path').length, 1);
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(one(doc, BLOCK_BUTTON_CLASS).title, 'Block Some Channel');
});

test('a channel name is only ever used as text', () => {
  const { doc, run } = setup(
    tile('a', 'video1', '&lt;img src=x onerror=alert(1)&gt;'),
  );
  run();

  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.equal(
    one(doc, BLOCK_BUTTON_CLASS).dataset.channelName,
    '<img src=x onerror=alert(1)>',
  );
});

test('a throwing or rejecting handler never escapes the click', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'), {
    onHideVideo: () => {
      throw new Error('sync failure');
    },
    onBlock: async () => {
      throw new Error('async failure');
    },
  });
  run();

  assert.doesNotThrow(() => one(doc, HIDE_VIDEO_BUTTON_CLASS).click());
  assert.doesNotThrow(() => one(doc, BLOCK_BUTTON_CLASS).click());
});

test('is idempotent across repeated scans', () => {
  const { doc, calls, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  run();
  run();

  assert.equal(count(doc, HIDE_VIDEO_BUTTON_CLASS), 1);
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
  one(doc, BLOCK_BUTTON_CLASS).click();
  assert.equal(calls.block.length, 1);
});

test('adds a watch-later control only when it is offered', () => {
  const { doc, calls, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  assert.equal(count(doc, WATCH_LATER_BUTTON_CLASS), 0);

  run({ offerWatchLater: true });
  const button = one(doc, WATCH_LATER_BUTTON_CLASS);
  assert.equal(button.title, 'Save to Watch later');
  button.click();

  assert.deepEqual(calls.native, [['watchLater', 'a']]);
  assert.deepEqual(calls.block, []);
  assert.deepEqual(calls.hide, []);
});

test('RECYCLING: removes a watch-later control when it is no longer offered', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerWatchLater: true });
  run({ offerWatchLater: false });

  assert.equal(count(doc, WATCH_LATER_BUTTON_CLASS), 0);
});

test('RECYCLING: a recycled tile reports its new video and channel', () => {
  const { doc, calls, run } = setup(tile('a', 'video1', 'Old Channel'));
  run();

  doc.querySelector('#a a[href]').setAttribute('href', '/watch?v=video2');
  doc.querySelector('#a a[aria-label]')
    .setAttribute('aria-label', 'Go to channel New Channel');
  run();

  one(doc, HIDE_VIDEO_BUTTON_CLASS).click();
  one(doc, BLOCK_BUTTON_CLASS).click();
  assert.deepEqual(calls.hide, [['video2', 'a']]);
  assert.deepEqual(calls.block, [['New Channel', 'video2', 'a']]);
  assert.equal(one(doc, BLOCK_BUTTON_CLASS).title, 'Block New Channel');
});

test('a tile without a channel can be hidden but not blocked', () => {
  const { doc, run } = setup(tile('a', 'video1', null));
  run();

  assert.equal(count(doc, HIDE_VIDEO_BUTTON_CLASS), 1);
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 0);
  assert.ok(doc.querySelector('#a').classList.contains(NO_BLOCK_CLASS));
});

test('shouldOffer decides the block control and sees the whole tile', () => {
  const seen = [];
  const { doc, run } = setup(
    tile('a', 'video1', 'Subscribed') + tile('b', 'video2', 'Stranger'),
    {
      shouldOffer: (channelName, read) => {
        seen.push([channelName, read.videoId]);
        return channelName !== 'Subscribed';
      },
    },
  );
  run();

  assert.deepEqual(seen, [['Subscribed', 'video1'], ['Stranger', 'video2']]);
  assert.equal(doc.querySelectorAll(`#a .${BLOCK_BUTTON_CLASS}`).length, 0);
  assert.equal(doc.querySelectorAll(`#b .${BLOCK_BUTTON_CLASS}`).length, 1);
  // A subscribed channel's video can still be hidden one by one.
  assert.equal(doc.querySelectorAll(`#a .${HIDE_VIDEO_BUTTON_CLASS}`).length, 1);
});

test('RECYCLING: the block control follows shouldOffer in both directions', () => {
  let offer = true;
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'), {
    shouldOffer: () => offer,
  });
  run();
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
  assert.equal(doc.querySelector('#a').classList.contains(NO_BLOCK_CLASS), false);

  offer = false;
  run();
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 0);
  assert.equal(doc.querySelector('#a').classList.contains(NO_BLOCK_CLASS), true);

  offer = true;
  run();
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
});

test('FAIL-OPEN: a throwing shouldOffer still offers the block control', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'), {
    shouldOffer: () => {
      throw new Error('broken eligibility check');
    },
  });
  run();

  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
});

test('a throwing readTile does not prevent later tiles from getting controls', () => {
  const doc = html(tile('a', 'video1', 'First') + tile('b', 'video2', 'Second'));
  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    doc,
    readTile: (element) => {
      if (element.id === 'a') throw new Error('unreadable');
      return readTile(element);
    },
  });

  assert.equal(doc.querySelectorAll(`#a .${HIDE_VIDEO_BUTTON_CLASS}`).length, 0);
  assert.equal(doc.querySelectorAll(`#b .${HIDE_VIDEO_BUTTON_CLASS}`).length, 1);
});

test('SCAN COST: tiles handed over by the scan are not read again', () => {
  const doc = html(tile('a', 'video1', 'Some Channel'));
  const element = doc.querySelector('#a');
  let reads = 0;

  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    doc,
    readTile: () => {
      reads += 1;
      return null;
    },
    tiles: [{ element, tile: readTile(element) }],
  });

  assert.equal(reads, 0);
  assert.equal(count(doc, BLOCK_BUTTON_CLASS), 1);
});

test('the native undo registry arms, reads and disarms a tile', () => {
  const doc = html(tile('a', 'video1', 'Some Channel'));
  const element = doc.querySelector('#a');

  assert.equal(armNativeUndo(element, 'Some Channel'), true);
  assert.equal(readNativeUndo(element), 'Some Channel');
  assert.equal(disarmNativeUndo(element), true);
  assert.equal(readNativeUndo(element), undefined);
  assert.equal(armNativeUndo(null, 'Some Channel'), false);
});
