import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  attachBlockButtons,
  disarmNativeUndo,
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  NO_BLOCK_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
  readNativeUndo,
} from '../src/dom/block-button.js';
import { readTile, TILE_SELECTOR } from '../src/dom/tile-adapter.js';

function setup(markup, defaultShouldOffer) {
  const doc = html(markup);
  const blocked = [];
  const nativeActions = [];
  const run = ({
    offerWatchLater = false,
    dismissAction = 'notInterested',
    shouldOffer = defaultShouldOffer,
  } = {}) => {
    const options = {
      root: doc.body,
      tileSelector: TILE_SELECTOR,
      readTile,
      onBlock: (name) => blocked.push(name),
      onNativeAction: (request) => nativeActions.push(request.action),
      offerWatchLater,
      dismissAction,
      doc,
    };
    if (shouldOffer !== undefined) options.shouldOffer = shouldOffer;
    attachBlockButtons(options);
  };
  return { doc, blocked, nativeActions, run };
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

test('a rejected block write warns with the channel name and never throws', async (t) => {
  const doc = html(tile('a', 'video1', 'Some Channel'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });
  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    readTile,
    onBlock: async () => {
      throw new Error('storage rejected');
    },
    onNativeAction: () => {},
    doc,
  });

  assert.doesNotThrow(() => {
    doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();
  });
  await Promise.resolve();

  assert.deepEqual(warnings, [[
    '[youtube-tuner] block failed for "Some Channel" — storage write rejected; if this tab predates an extension update, reload it',
  ]]);
});

test('clicking the block button arms its tile with the channel name', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  const element = doc.querySelector('#a');

  doc.querySelector(`.${BLOCK_BUTTON_CLASS}`).click();

  assert.equal(readNativeUndo(element), 'Some Channel');
  disarmNativeUndo(element);
});

test('is idempotent across repeated scans', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  run();
  run();

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
});

test('adds a watch-later button when it is offered', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerWatchLater: true });

  const button = doc.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`);
  assert.ok(button);
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '\u{1F552}');
  assert.equal(button.title, 'Save to Watch later');
  assert.equal(button.dataset.videoId, 'video1');
});

test('does not add a watch-later button when it is not offered', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerWatchLater: false });

  assert.equal(
    doc.querySelectorAll(`.${WATCH_LATER_BUTTON_CLASS}`).length,
    0,
  );
});

test('RECYCLING: removes a watch-later button when it is no longer offered', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run({ offerWatchLater: true });
  assert.ok(doc.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`));

  run({ offerWatchLater: false });

  assert.equal(doc.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`), null);
});

test('watch-later uses only the native action without blocking or arming undo', () => {
  const doc = html(tile('a', 'video1', 'Some Channel'));
  const blocked = [];
  const nativeActions = [];
  const armed = [];
  attachBlockButtons({
    root: doc.body,
    tileSelector: TILE_SELECTOR,
    readTile,
    onBlock: (name) => blocked.push(name),
    onNativeAction: (request) => nativeActions.push(request.action),
    offerWatchLater: true,
    registry: { arm: (...args) => armed.push(args) },
    doc,
  });

  doc.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`).click();

  assert.deepEqual(nativeActions, ['watchLater']);
  assert.deepEqual(blocked, []);
  assert.deepEqual(armed, []);
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
  run({ offerWatchLater: true });

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 0);
  assert.ok(doc.querySelector('#a').classList.contains(BLOCK_HOST_CLASS));
  assert.ok(doc.querySelector('#a').classList.contains(NO_BLOCK_CLASS));
});

test('RECYCLING: removes an existing button when shouldOffer becomes false', () => {
  const { doc, run } = setup(tile('a', 'video1', 'Some Channel'));
  run();
  assert.ok(doc.querySelector(`.${BLOCK_BUTTON_CLASS}`));

  run({ shouldOffer: () => false });

  assert.equal(doc.querySelector(`.${BLOCK_BUTTON_CLASS}`), null);
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

test('thumbs-down dispatches the configured native action', () => {
  const { doc, nativeActions, run } =
    setup(tile('a', 'video1', 'Some Channel'));
  run({ dismissAction: 'hide' });

  doc.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`).click();

  assert.deepEqual(nativeActions, ['hide']);
});

test('RECYCLING: thumbs-down reads its re-stamped action at click time', () => {
  const { doc, nativeActions, run } =
    setup(tile('a', 'video1', 'Some Channel'));
  run({ dismissAction: 'notInterested' });
  const button = doc.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`);
  assert.equal(button.dataset.action, 'notInterested');
  assert.equal(button.title, 'Not interested in this video');

  run({ dismissAction: 'hide' });

  assert.equal(
    doc.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`),
    button,
  );
  assert.equal(button.dataset.action, 'hide');
  assert.equal(button.title, 'Hide from subscriptions feed');
  button.click();
  assert.deepEqual(nativeActions, ['hide']);
});

test('adds a button when shouldOffer returns true', () => {
  const { doc, run } = setup(
    tile('a', 'video1', 'Other Channel'),
    () => true,
  );
  run({ offerWatchLater: true });

  assert.equal(doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`).length, 1);
  assert.equal(doc.querySelector('#a').classList.contains(NO_BLOCK_CLASS), false);
});

test('RECYCLING: updates the no-block class when the offer state flips', () => {
  let offered = true;
  const { doc, run } = setup(
    tile('a', 'video1', 'Some Channel'),
    () => offered,
  );
  const element = doc.querySelector('#a');

  run({ offerWatchLater: true });
  assert.equal(element.classList.contains(NO_BLOCK_CLASS), false);

  offered = false;
  run({ offerWatchLater: true });
  assert.ok(element.classList.contains(NO_BLOCK_CLASS));

  offered = true;
  run({ offerWatchLater: true });
  assert.equal(element.classList.contains(NO_BLOCK_CLASS), false);
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
