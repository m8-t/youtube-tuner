import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { html } from './helpers/dom.js';
import {
  createManualUpdateChecker,
  initializePopup,
  requestSubscriptionRefresh,
  subscriptionAgeText,
} from '../src/popup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function popupDocument() {
  return html(`
    <input type="checkbox" id="enabled">
    <section id="help-panel">
      <p>Help copy</p>
      <button id="help-dismiss" type="button">Got it</button>
    </section>
    <small id="dom-health-status" class="status-line" hidden></small>
    <p id="subs-age"></p>
    <button id="refresh-subs" type="button">Refresh now</button>
    <div id="sync-row" hidden>
      <button id="sync-now" type="button">Sync now</button>
      <small id="sync-status" class="status-line"></small>
      <small id="sync-last-sync" class="status-line"></small>
    </div>
    <button id="check-update" type="button">Check for updates</button>
    <p id="update-status" hidden></p>
    <input type="checkbox" id="update-check-enabled">
    <button id="open-options" type="button">Options</button>
    <a id="help-toggle" href="#" hidden>Help</a>
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
    openOptionsPage: async () => {},
    closePopup: () => {},
    localStorage: {
      get: async () => ({}),
      set: async () => {},
    },
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
      'help-panel',
      'help-dismiss',
      'dom-health-status',
      'subs-age',
      'refresh-subs',
      'sync-row',
      'sync-now',
      'sync-status',
      'sync-last-sync',
      'check-update',
      'update-status',
      'update-check-enabled',
      'open-options',
      'help-toggle',
    ],
  );
});

test('popup includes the exact help and subscribed-exemption copy', () => {
  const documentObject = new JSDOM(
    readFileSync('popup.html', 'utf8'),
  ).window.document;

  assert.equal(
    documentObject.querySelector('#help-panel p').textContent,
    "👎 tells YouTube you're not interested. 🚫 hides all videos from that " +
      'channel (stored locally, undo in Options). Videos from channels you ' +
      'subscribe to are never hidden by the age and view rules — collect ' +
      'your subscriptions below.',
  );
  assert.match(
    documentObject.body.textContent,
    /Age and view rules skip subscribed channels\./,
  );
});

test('first-run help is expanded when helpDismissed is absent', async () => {
  const dependencies = popupDependencies();

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('help-panel').hidden,
    false,
  );
  assert.equal(
    dependencies.documentObject.getElementById('help-toggle').hidden,
    true,
  );
});

test('dismissed help is collapsed with its toggle link visible', async () => {
  const dependencies = popupDependencies({
    localStorage: {
      get: async () => ({ helpDismissed: true }),
      set: async () => {},
    },
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('help-panel').hidden,
    true,
  );
  assert.equal(
    dependencies.documentObject.getElementById('help-toggle').hidden,
    false,
  );
});

test('Got it persists helpDismissed and leaves Help able to toggle', async () => {
  const writes = [];
  const dependencies = popupDependencies({
    localStorage: {
      get: async () => ({}),
      set: async (values) => writes.push(values),
    },
  });
  await initializePopup(dependencies);
  const panel = dependencies.documentObject.getElementById('help-panel');
  const toggle = dependencies.documentObject.getElementById('help-toggle');

  dependencies.documentObject.getElementById('help-dismiss').click();
  await settleEvents();

  assert.deepEqual(writes, [{ helpDismissed: true }]);
  assert.equal(panel.hidden, true);
  assert.equal(toggle.hidden, false);
  toggle.click();
  assert.equal(panel.hidden, false);
  toggle.click();
  assert.equal(panel.hidden, true);
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
    'Subscription list is 12 days old. ' +
      'The amber badge means it needs a refresh.',
  );
});

test('popup only explains the amber badge for stale subscription metadata', () => {
  assert.equal(
    subscriptionAgeText({ ageMs: 12 * DAY_MS, stale: false }),
    'Subscription list is 12 days old.',
  );
  assert.equal(
    subscriptionAgeText({ ageMs: 31 * DAY_MS, stale: true }),
    'Subscription list is 31 days old. ' +
      'The amber badge means it needs a refresh.',
  );
  assert.equal(
    subscriptionAgeText(null),
    'Subscription list not collected yet - click to collect.',
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

test('popup Options button opens the options page and closes the popup', async () => {
  let opened = 0;
  let closed = 0;
  const dependencies = popupDependencies({
    openOptionsPage: async () => {
      opened += 1;
    },
    closePopup: () => {
      closed += 1;
    },
  });
  await initializePopup(dependencies);

  dependencies.documentObject.getElementById('open-options').click();
  await settleEvents();

  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

test('popup hides the sync row when sync is disabled', async () => {
  const sent = [];
  const dependencies = popupDependencies({
    sendMessage: async (message) => {
      sent.push(message);
      return { enabled: false };
    },
  });

  await initializePopup(dependencies);

  assert.deepEqual(sent, [{ type: 'sync-status' }]);
  assert.equal(
    dependencies.documentObject.getElementById('sync-row').hidden,
    true,
  );
});

test('popup shows the sync row when sync is enabled', async () => {
  const dependencies = popupDependencies({
    sendMessage: async () => ({ enabled: true }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-row').hidden,
    false,
  );
});

test('popup renders degraded DOM health in the status palette', async () => {
  const dependencies = popupDependencies({
    sendMessage: async () => ({
      enabled: false,
      domHealth: 'degraded',
    }),
  });

  await initializePopup(dependencies);

  const warning = dependencies.documentObject.getElementById(
    'dom-health-status',
  );
  const syncError = dependencies.documentObject.getElementById('sync-status');
  assert.equal(warning.hidden, false);
  assert.equal(
    warning.textContent,
    'Filtering may be broken by a YouTube page change. ' +
      'Try reloading the YouTube tab.',
  );
  assert.equal(
    warning.classList.contains('status-line'),
    syncError.classList.contains('status-line'),
  );
});

test('popup renders a missing or null last sync as never', async (t) => {
  for (const status of [
    { enabled: true },
    { enabled: true, lastSyncAt: null },
  ]) {
    await t.test(JSON.stringify(status), async () => {
      const dependencies = popupDependencies({
        sendMessage: async () => status,
      });

      await initializePopup(dependencies);

      assert.equal(
        dependencies.documentObject
          .getElementById('sync-last-sync').textContent,
        'Last sync: never',
      );
    });
  }
});

test('popup renders a last sync under 60 seconds ago as just now', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async () => ({
      enabled: true,
      lastSyncAt: now - 59_999,
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: just now',
  );
});

test('popup renders a last sync under 60 minutes ago in minutes', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async () => ({
      enabled: true,
      lastSyncAt: now - (17 * 60 * 1000),
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: 17 min ago',
  );
});

test('popup renders a last sync under 24 hours ago in hours', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async () => ({
      enabled: true,
      lastSyncAt: now - (9 * 60 * 60 * 1000),
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: 9 h ago',
  );
});

test('popup renders a last sync at least 24 hours ago as locale time', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const lastSyncAt = '2026-08-03T06:30:00.000Z';
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async () => ({ enabled: true, lastSyncAt }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    `Last sync: ${new Date(lastSyncAt).toLocaleString()}`,
  );
});

test('popup refreshes last sync after Sync now succeeds', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const previousSync = now - (2 * 60 * 60 * 1000);
  let statusRequests = 0;
  const sent = [];
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'sync-run') return { ok: true };
      statusRequests += 1;
      return {
        enabled: true,
        lastSyncAt: statusRequests === 1 ? previousSync : now,
      };
    },
  });
  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: 2 h ago',
  );

  dependencies.documentObject.getElementById('sync-now').click();
  await settleEvents();

  assert.deepEqual(sent, [
    { type: 'sync-status' },
    { type: 'sync-run' },
    { type: 'sync-status' },
  ]);
  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: just now',
  );
});

test('popup Sync now sends sync-run and disables the button during the run', async () => {
  const sent = [];
  let finishSync;
  const pendingSync = new Promise((resolve) => {
    finishSync = resolve;
  });
  const dependencies = popupDependencies({
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'sync-status') return { enabled: true };
      return pendingSync;
    },
  });
  await initializePopup(dependencies);
  const button = dependencies.documentObject.getElementById('sync-now');

  button.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(sent, [
    { type: 'sync-status' },
    { type: 'sync-run' },
  ]);

  finishSync({ ok: true });
  await settleEvents();
  assert.equal(button.disabled, false);
});

test('popup renders a successful manual sync', async () => {
  const dependencies = popupDependencies({
    sendMessage: async (message) => (
      message.type === 'sync-status'
        ? { enabled: true }
        : { ok: true }
    ),
  });
  await initializePopup(dependencies);

  dependencies.documentObject.getElementById('sync-now').click();
  await settleEvents();

  assert.equal(
    dependencies.documentObject.getElementById('sync-status').textContent,
    'Sync complete.',
  );
});

test('popup renders a manual sync error response', async () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const dependencies = popupDependencies({
    now: () => now,
    sendMessage: async (message) => (
      message.type === 'sync-status'
        ? { enabled: true, lastSyncAt: now - (3 * 60 * 60 * 1000) }
        : { error: 'WebDAV unavailable' }
    ),
  });
  await initializePopup(dependencies);

  dependencies.documentObject.getElementById('sync-now').click();
  await settleEvents();

  assert.equal(
    dependencies.documentObject.getElementById('sync-status').textContent,
    'WebDAV unavailable',
  );
  assert.equal(
    dependencies.documentObject.getElementById('sync-last-sync').textContent,
    'Last sync: 3 h ago',
  );
});

test('popup renders the last sync error from initial status', async () => {
  const dependencies = popupDependencies({
    sendMessage: async () => ({
      enabled: true,
      lastError: 'Previous WebDAV failure',
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-status').textContent,
    'Last sync error: Previous WebDAV failure',
  );
});

test('popup rewrites a network last-sync error in plain language', async () => {
  const dependencies = popupDependencies({
    sendMessage: async () => ({
      enabled: true,
      lastError: 'TypeError: Failed to fetch',
    }),
  });

  await initializePopup(dependencies);

  assert.equal(
    dependencies.documentObject.getElementById('sync-status').textContent,
    'Last sync error: Could not reach the sync server. ' +
      'Check the URL and your connection.',
  );
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
