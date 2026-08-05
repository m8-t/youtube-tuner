import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  armNativeUndo,
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  disarmNativeUndo,
  readNativeUndo,
} from '../src/dom/block-button.js';
import { createNativeUndoWatcher } from '../src/dom/native-undo.js';

installChromeMock();

function setup() {
  const doc = html(`
    <yt-lockup-view-model id="tile" class="${BLOCK_HOST_CLASS}">
      <div class="ytDismissibleItemReplacedContent">
        <notification-multi-action-renderer
          class="ytNotificationMultiActionRendererHost"
        >
          <span id="message">Channel recommendations will be hidden</span>
          <button id="undo" type="button">Rückgängig</button>
        </notification-multi-action-renderer>
      </div>
      <button id="overlay" class="${BLOCK_BUTTON_CLASS}" type="button">
        Block
      </button>
    </yt-lockup-view-model>
  `);
  const removed = [];
  const watcher = createNativeUndoWatcher({
    doc,
    removeBlockedChannel: (channelName) => removed.push(channelName),
  });
  return {
    doc,
    removed,
    tile: doc.querySelector('#tile'),
    undo: doc.querySelector('#undo'),
    watcher,
  };
}

test('native Undo removes an armed channel, disarms the tile, and only runs once', () => {
  const { doc, removed, tile, undo, watcher } = setup();
  armNativeUndo(tile, 'Some Channel');
  let bubbled = 0;
  doc.body.addEventListener('click', () => {
    bubbled += 1;
  });
  watcher.start();

  const firstClick = new doc.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  undo.dispatchEvent(firstClick);
  undo.click();

  assert.deepEqual(removed, ['Some Channel']);
  assert.equal(readNativeUndo(tile), undefined);
  assert.equal(firstClick.defaultPrevented, false);
  assert.equal(bubbled, 2);
  watcher.stop();
});

test('native Undo in an unarmed tile does nothing', () => {
  const { removed, undo, watcher } = setup();
  watcher.start();

  undo.click();

  assert.deepEqual(removed, []);
  watcher.stop();
});

test('clicking notification message text in an armed tile does nothing', () => {
  const { doc, removed, tile, watcher } = setup();
  armNativeUndo(tile, 'Some Channel');
  watcher.start();

  doc.querySelector('#message').click();

  assert.deepEqual(removed, []);
  assert.equal(readNativeUndo(tile), 'Some Channel');
  disarmNativeUndo(tile);
  watcher.stop();
});

test('clicking a ytt-block overlay in an armed tile does nothing', () => {
  const { doc, removed, tile, watcher } = setup();
  armNativeUndo(tile, 'Some Channel');
  watcher.start();

  doc.querySelector('#overlay').click();

  assert.deepEqual(removed, []);
  assert.equal(readNativeUndo(tile), 'Some Channel');
  disarmNativeUndo(tile);
  watcher.stop();
});

test('stop removes the native Undo listener', () => {
  const { removed, tile, undo, watcher } = setup();
  armNativeUndo(tile, 'Some Channel');
  watcher.start();
  watcher.stop();

  undo.click();

  assert.deepEqual(removed, []);
  assert.equal(readNativeUndo(tile), 'Some Channel');
  disarmNativeUndo(tile);
});
