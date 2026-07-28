import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  initializePopup,
  requestSubscriptionRefresh,
} from '../src/popup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function popupDocument() {
  return html(`
    <p id="subs-age"></p>
    <button id="refresh-subs" type="button">Refresh now</button>
    <input type="checkbox" id="enabled">
  `);
}

function popupDependencies(overrides = {}) {
  return {
    documentObject: popupDocument(),
    loadMeta: async () => ({
      ageMs: 12 * DAY_MS,
      stale: true,
    }),
    loadConfiguration: async () => ({ enabled: true }),
    saveConfiguration: async () => {},
    sendMessage: async () => ({}),
    closePopup: () => {},
    ...overrides,
  };
}

test('popup Refresh now sends exactly the existing refresh-subs message', () => {
  const sent = [];
  let closed = false;

  requestSubscriptionRefresh({
    sendMessage(message) {
      sent.push(message);
      return Promise.resolve({});
    },
    closePopup() {
      closed = true;
    },
  });

  assert.deepEqual(sent, [{ type: 'refresh-subs' }]);
  assert.equal(closed, true);
});

test('popup renders the stale subscription age in days', async () => {
  const dependencies = popupDependencies();

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('subs-age').textContent,
    'Subscription list is 12 days old.',
  );
});

test('popup explains collection without an age when subscriptions are absent', async () => {
  const dependencies = popupDependencies({
    loadMeta: async () => null,
  });

  await initializePopup(dependencies);

  const text =
    dependencies.documentObject.getElementById('subs-age').textContent;
  assert.equal(
    text,
    'Subscription list not collected yet - click to collect.',
  );
  assert.doesNotMatch(text, /\b\d+ days?\b/i);
});

test('popup reflects the current filtering value on open', async () => {
  const dependencies = popupDependencies({
    loadConfiguration: async () => ({ enabled: false }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('enabled').checked,
    false,
  );
});

test('popup filtering toggle flips and saves config.enabled', async () => {
  const saved = [];
  const dependencies = popupDependencies({
    saveConfiguration: async (config) => {
      saved.push(structuredClone(config));
    },
  });
  await initializePopup(dependencies);
  const toggle = dependencies.documentObject.getElementById('enabled');

  toggle.checked = false;
  toggle.dispatchEvent(new dependencies.documentObject.defaultView.Event(
    'change',
  ));
  await Promise.resolve();

  assert.deepEqual(saved, [{ enabled: false }]);
});

test('popup refresh never calls window.confirm', async (t) => {
  const dependencies = popupDependencies();
  const windowObject = dependencies.documentObject.defaultView;
  const previousWindow = globalThis.window;
  let confirmations = 0;
  windowObject.confirm = () => {
    confirmations += 1;
    return true;
  };
  globalThis.window = windowObject;
  t.after(() => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  });

  await initializePopup(dependencies);
  dependencies.documentObject.getElementById('refresh-subs').click();

  assert.equal(confirmations, 0);
});
