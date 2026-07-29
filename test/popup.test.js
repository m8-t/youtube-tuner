import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { html } from './helpers/dom.js';
import {
  createManualUpdateChecker,
  initializePopup,
  requestSubscriptionRefresh,
} from '../src/popup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function popupDocument() {
  return html(`
    <input type="checkbox" id="enabled">
    <p id="subs-age"></p>
    <button id="refresh-subs" type="button">Refresh now</button>
    <button id="check-update" type="button">Check for updates</button>
    <p id="update-status" hidden></p>
    <input type="checkbox" id="update-check-enabled">
  `);
}

function popupDependencies(overrides = {}) {
  return {
    documentObject: popupDocument(),
    loadMeta: async () => ({
      ageMs: 12 * DAY_MS,
      stale: true,
    }),
    loadConfiguration: async () => ({
      enabled: true,
      updateCheck: { enabled: true },
    }),
    saveConfiguration: async () => {},
    loadAvailableUpdate: async () => null,
    queryTabs: async () => [],
    sendTabMessage: async () => {},
    setBadgeText: () => {},
    manualUpdateChecker: async () => {},
    sendMessage: async () => ({}),
    closePopup: () => {},
    ...overrides,
  };
}

function settleEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('popup lays out filtering, subscriptions, and update controls in order', () => {
  const documentObject = new JSDOM(
    readFileSync('popup.html', 'utf8'),
  ).window.document;

  assert.deepEqual(
    [...documentObject.body.querySelectorAll('[id]')]
      .map((element) => element.id),
    [
      'enabled',
      'subs-age',
      'refresh-subs',
      'check-update',
      'update-status',
      'update-check-enabled',
    ],
  );
});

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

test('popup reflects filtering and daily update values on open', async () => {
  const dependencies = popupDependencies({
    loadConfiguration: async () => ({
      enabled: false,
      updateCheck: { enabled: false },
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('enabled').checked,
    false,
  );
  assert.equal(
    dependencies.documentObject.getElementById('update-check-enabled').checked,
    false,
  );
});

test('popup filtering switch saves, rescans YouTube tabs, and updates badges', async () => {
  const saved = [];
  const queries = [];
  const messages = [];
  const badges = [];
  const dependencies = popupDependencies({
    saveConfiguration: async (config) => {
      saved.push(structuredClone(config));
    },
    queryTabs: async (query) => {
      queries.push(query);
      return [{ id: 41 }, { id: undefined }, { id: 42 }];
    },
    sendTabMessage: async (tabId, message) => {
      messages.push([tabId, message]);
    },
    setBadgeText: (options) => badges.push(options),
  });
  await initializePopup(dependencies);
  const toggle = dependencies.documentObject.getElementById('enabled');

  toggle.checked = false;
  toggle.dispatchEvent(new dependencies.documentObject.defaultView.Event(
    'change',
  ));
  await settleEvents();

  assert.deepEqual(saved, [{
    enabled: false,
    updateCheck: { enabled: true },
  }]);
  assert.deepEqual(queries, [{ url: '*://www.youtube.com/*' }]);
  assert.deepEqual(messages, [
    [41, { type: 'rescan' }],
    [42, { type: 'rescan' }],
  ]);
  assert.deepEqual(badges, [
    { tabId: 41, text: 'off' },
    { tabId: 42, text: 'off' },
  ]);
});

test('popup daily update switch persists config.updateCheck.enabled', async () => {
  const saved = [];
  const dependencies = popupDependencies({
    loadAvailableUpdate: async () => 'v0.7.1',
    saveConfiguration: async (config) => {
      saved.push(structuredClone(config));
    },
  });
  await initializePopup(dependencies);
  const toggle =
    dependencies.documentObject.getElementById('update-check-enabled');

  toggle.checked = false;
  toggle.dispatchEvent(new dependencies.documentObject.defaultView.Event(
    'change',
  ));
  await settleEvents();

  assert.deepEqual(saved, [{
    enabled: true,
    updateCheck: { enabled: false },
  }]);
  assert.equal(
    dependencies.documentObject.getElementById('update-status').hidden,
    true,
  );
});

test('popup shows a cached available update when daily checks are enabled', async () => {
  const dependencies = popupDependencies({
    loadAvailableUpdate: async () => 'v0.7.1',
  });

  await initializePopup(dependencies);

  const status = dependencies.documentObject.getElementById('update-status');
  const link = status.querySelector('a');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Update v0.7.1 is available.');
  assert.equal(
    link.href,
    'https://github.com/m8-t/youtube-tuner/releases/latest',
  );
  assert.equal(link.target, '_blank');
});

test('manual update check forces a request and renders a newer release', async () => {
  const documentObject = popupDocument();
  const button = documentObject.getElementById('check-update');
  const storage = { local: {} };
  const fetchFn = async () => {};
  const calls = [];
  let finishCheck;
  const pendingCheck = new Promise((resolve) => {
    finishCheck = resolve;
  });
  let notifications = 0;
  const checkManually = createManualUpdateChecker({
    fetchFn,
    getStorage: () => storage,
    now: () => 123,
    currentVersion: () => '0.7.0',
    performCheck: async (options) => {
      calls.push(options);
      return pendingCheck;
    },
    notifyChecked: async () => {
      notifications += 1;
    },
  });

  const checking = checkManually({ documentObject, button });
  assert.equal(button.disabled, true);
  finishCheck('v0.7.1');
  assert.equal(await checking, 'v0.7.1');

  assert.deepEqual(calls, [{
    fetchFn,
    storage,
    now: 123,
    currentVersion: '0.7.0',
    force: true,
  }]);
  assert.equal(
    documentObject.getElementById('update-status').textContent,
    'Update v0.7.1 is available.',
  );
  assert.equal(button.disabled, false);
  assert.equal(notifications, 1);
});

test('manual update check reports the newest installed version', async () => {
  const documentObject = popupDocument();
  const checkManually = createManualUpdateChecker({
    getStorage: () => ({ local: {} }),
    currentVersion: () => '0.7.0',
    performCheck: async () => 'v0.7.0',
    notifyChecked: async () => {},
  });

  assert.equal(await checkManually({ documentObject }), 'v0.7.0');
  assert.equal(
    documentObject.getElementById('update-status').textContent,
    'You have the newest version (0.7.0).',
  );
});

test('manual update check fails closed and re-enables its button', async () => {
  const documentObject = popupDocument();
  const button = documentObject.getElementById('check-update');
  const checkManually = createManualUpdateChecker({
    getStorage: () => ({ local: {} }),
    currentVersion: () => '0.7.0',
    performCheck: async () => {
      throw new Error('network failed');
    },
    notifyChecked: async () => {},
  });

  assert.equal(await checkManually({ documentObject, button }), null);
  assert.equal(
    documentObject.getElementById('update-status').textContent,
    'Update check failed.',
  );
  assert.equal(button.disabled, false);
});

test('popup wires the Check for updates button to the manual checker', async () => {
  let checks = 0;
  const dependencies = popupDependencies({
    manualUpdateChecker: async ({ button }) => {
      assert.equal(button.id, 'check-update');
      checks += 1;
    },
  });
  await initializePopup(dependencies);

  dependencies.documentObject.getElementById('check-update').click();
  await settleEvents();

  assert.equal(checks, 1);
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
