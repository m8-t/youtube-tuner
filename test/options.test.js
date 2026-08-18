import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  exportSettings,
  importSettings,
  MANUAL_REFRESH_TIMEOUT_MS,
  main,
  renderOverrides,
  renderStatus,
  refreshFailureMessage,
  runManualSubscriptionRefresh,
  setupOverridesEditor,
} from '../src/options.js';
import { SUBS_SCRAPE_BUDGET_MS } from '../src/subs-refresh.js';
import {
  SUBS_FORMAT_VERSION,
  SUBS_STALE_AFTER_MS,
} from '../src/storage/subs.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import { html } from './helpers/dom.js';

function settingsHarness() {
  const mock = installChromeMock({ install: false });
  return {
    mock,
    localStorage: mock.chrome.storage.local,
    syncStorage: mock.chrome.storage.sync,
    button: { disabled: false },
    statusElement: { textContent: '' },
  };
}

test('options page has no update-check controls', () => {
  const markup = readFileSync('options.html', 'utf8');

  assert.doesNotMatch(markup, /update-check-enabled/);
  assert.doesNotMatch(markup, /check-update/);
  assert.doesNotMatch(markup, /update-status/);
});

test('options page includes the channel rules editor', () => {
  const markup = readFileSync('options.html', 'utf8');

  assert.match(markup, /<legend>Channel rules<\/legend>/);
  assert.match(markup, /id="override-rows"/);
  assert.match(markup, /id="override-add"/);
});

test('blocked title options load and save patterns and the enabled checkbox', async (t) => {
  const mock = installChromeMock({ install: false });
  await mock.chrome.storage.sync.set({
    config: {
      titleRule: {
        enabled: true,
        patterns: ['Spoilers', 'Live reaction'],
      },
    },
  });
  const documentObject = new JSDOM(
    readFileSync('options.html', 'utf8'),
  ).window.document;
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  globalThis.chrome = mock.chrome;
  globalThis.document = documentObject;
  t.after(() => {
    globalThis.chrome = previousChrome;
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  });

  await main();

  const textarea = documentObject.getElementById('title-filters');
  const checkbox = documentObject.getElementById('title-enabled');
  assert.equal(textarea.value, 'Spoilers\nLive reaction');
  assert.equal(checkbox.checked, true);

  textarea.value = '  Spoilers  \n\nRecap\r\nSpoilers\n  Live reaction  ';
  documentObject.getElementById('title-filters-form').dispatchEvent(
    new documentObject.defaultView.Event('submit', { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mock.areas.sync.config.titleRule.patterns, [
    'Spoilers',
    'Recap',
    'Live reaction',
  ]);
  assert.equal(textarea.value, 'Spoilers\nRecap\nLive reaction');
  assert.equal(
    documentObject.getElementById('title-filters-status').textContent,
    'Saved.',
  );

  checkbox.checked = false;
  checkbox.dispatchEvent(
    new documentObject.defaultView.Event('change', { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mock.areas.sync.config.titleRule.enabled, false);
  assert.deepEqual(mock.areas.sync.config.titleRule.patterns, [
    'Spoilers',
    'Recap',
    'Live reaction',
  ]);
});

async function renderStatusHarness(ageMs = null) {
  const mock = installChromeMock({ install: false });
  if (ageMs !== null) {
    await mock.chrome.storage.local.set({
      subs: {
        format: SUBS_FORMAT_VERSION,
        ids: ['Channel A'],
        fetchedAt: Date.now() - ageMs,
      },
    });
  }
  const documentObject = html(`
    <p id="subs-status"></p>
    <p id="subs-refresh-prompt" hidden></p>
    <span id="watched-count"></span>
  `);
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  globalThis.chrome = mock.chrome;
  globalThis.document = documentObject;
  try {
    await renderStatus();
    return {
      status: documentObject.getElementById('subs-status').textContent,
      prompt: documentObject.getElementById('subs-refresh-prompt').textContent,
      promptHidden:
        documentObject.getElementById('subs-refresh-prompt').hidden,
    };
  } finally {
    globalThis.chrome = previousChrome;
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
}

test('options prompts collection without an age when subscriptions are absent', async () => {
  const rendered = await renderStatusHarness();

  assert.equal(rendered.promptHidden, false);
  assert.equal(
    rendered.prompt,
    'Subscription list not collected yet. Use \"Refresh now\" to collect it.',
  );
  assert.doesNotMatch(
    `${rendered.status} ${rendered.prompt}`,
    /\b\d+ days?\b/i,
  );
});

test('options renders fresh subscription cache age without a refresh prompt', async () => {
  const rendered = await renderStatusHarness(2 * 24 * 60 * 60 * 1000);

  assert.match(rendered.status, /Subscription cache age: 2 days\./);
  assert.equal(rendered.promptHidden, true);
  assert.equal(rendered.prompt, '');
});

test('options renders stale subscription cache age and a refresh prompt', async () => {
  const rendered = await renderStatusHarness(
    SUBS_STALE_AFTER_MS + 24 * 60 * 60 * 1000,
  );

  const staleAgeDays =
    SUBS_STALE_AFTER_MS / (24 * 60 * 60 * 1000) + 1;
  assert.match(
    rendered.status,
    new RegExp(`Subscription cache age: ${staleAgeDays} days\\.`),
  );
  assert.equal(rendered.promptHidden, false);
  assert.match(rendered.prompt, /Refresh now/);
});

test('settings export includes complete local and sync storage areas', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({
    subs: { format: 2, ids: ['Channel A'], fetchedAt: 123 },
    watched: ['video-1'],
  });
  await harness.syncStorage.set({
    config: { enabled: false },
    channelOverrides: {
      'Channel A': { age: { enabled: true, maxAgeDays: 30 } },
    },
  });
  let exportedBlob;
  let revokedUrl;
  let clicked = false;
  const anchor = {};

  const settings = await exportSettings({
    ...harness,
    now: () => new Date('2026-07-28T12:34:56.000Z'),
    createObjectURL(blob) {
      exportedBlob = blob;
      return 'blob:test-export';
    },
    revokeObjectURL(url) {
      revokedUrl = url;
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        ...anchor,
        click() {
          clicked = true;
          anchor.href = this.href;
          anchor.download = this.download;
        },
      };
    },
  });

  assert.deepEqual(settings, {
    format: 1,
    exportedAt: '2026-07-28T12:34:56.000Z',
    local: {
      subs: { format: 2, ids: ['Channel A'], fetchedAt: 123 },
      watched: ['video-1'],
    },
    sync: {
      config: { enabled: false },
      channelOverrides: {
        'Channel A': { age: { enabled: true, maxAgeDays: 30 } },
      },
    },
  });
  assert.deepEqual(JSON.parse(await exportedBlob.text()), settings);
  assert.equal(anchor.download, 'youtube-tuner-settings-2026-07-28.json');
  assert.equal(anchor.href, 'blob:test-export');
  assert.equal(revokedUrl, 'blob:test-export');
  assert.equal(clicked, true);
  assert.equal(harness.statusElement.textContent, 'Settings exported.');
  assert.equal(harness.button.disabled, false);
});

test('settings export revokes its object URL when download click fails', async () => {
  const harness = settingsHarness();
  let revokedUrl;

  const result = await exportSettings({
    ...harness,
    createObjectURL: () => 'blob:failed-export',
    revokeObjectURL(url) {
      revokedUrl = url;
    },
    createElement: () => ({
      click() {
        throw new Error('download click failed');
      },
    }),
  });

  assert.equal(result, null);
  assert.equal(revokedUrl, 'blob:failed-export');
  assert.match(harness.statusElement.textContent, /^Export failed:/);
  assert.equal(harness.button.disabled, false);
});

test('valid settings import replaces both areas and reports imported counts', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ staleLocal: true });
  await harness.syncStorage.set({ staleSync: true });
  const subscriptions = Array.from({ length: 330 }, (_, index) => `sub-${index}`);
  const blocked = Array.from({ length: 12 }, (_, index) => `blocked-${index}`);
  const watched = Array.from({ length: 1843 }, (_, index) => `video-${index}`);
  const imported = {
    format: 1,
    exportedAt: '2026-07-28T12:34:56.000Z',
    local: {
      subs: { format: 2, ids: subscriptions, fetchedAt: 123 },
      blocklist: blocked,
      watched,
      manualSubs: ['Manual Channel'],
    },
    sync: {
      config: { enabled: false },
      channelOverrides: {
        'Channel A': { watched: { enabled: false } },
        'Channel B': { view: { enabled: true, minViews: 1000 } },
      },
    },
  };
  let confirmationText;
  let rendered = false;

  const result = await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify(imported) },
    confirmFn(message) {
      confirmationText = message;
      return true;
    },
    renderResult: async () => {
      rendered = true;
    },
  });

  assert.equal(result, true);
  assert.match(confirmationText, /replace the existing settings/i);
  assert.deepEqual(harness.mock.areas.local, imported.local);
  assert.deepEqual(harness.mock.areas.sync, imported.sync);
  assert.equal(rendered, true);
  assert.equal(
    harness.statusElement.textContent,
    'Imported 330 subscriptions, 12 blocked channels, 1843 watched videos, 2 channel overrides.',
  );
  assert.equal(harness.button.disabled, false);
});

test('settings import normalizes channel overrides and drops junk', async () => {
  const harness = settingsHarness();
  const imported = {
    format: 1,
    sync: {
      config: { enabled: true },
      channelOverrides: {
        '  Channel A  ': {
          watched: { enabled: false, junk: true },
          age: { enabled: true, maxAgeDays: 30, junk: true },
          unknownRule: { enabled: true },
        },
        'Junk Channel': {
          watched: { enabled: 'yes' },
          age: { maxAgeDays: -4 },
        },
        '   ': { watched: { enabled: true } },
      },
    },
  };

  assert.equal(await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify(imported) },
    confirmFn: () => true,
    renderResult: async () => {},
  }), true);
  assert.deepEqual(harness.mock.areas.sync, {
    config: { enabled: true },
    channelOverrides: {
      'Channel A': {
        watched: { enabled: false },
        age: { enabled: true, maxAgeDays: 30 },
      },
    },
  });
});

function overridesHarness() {
  const mock = installChromeMock({ install: false });
  const documentObject = html(`
    <table><tbody id="override-rows"></tbody></table>
    <button id="override-add" type="button">Add channel</button>
  `);
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  globalThis.chrome = mock.chrome;
  globalThis.document = documentObject;
  return {
    documentObject,
    mock,
    restore() {
      globalThis.chrome = previousChrome;
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    },
  };
}

function change(element) {
  element.dispatchEvent(new element.ownerDocument.defaultView.Event(
    'change',
    { bubbles: true },
  ));
}

const settleChanges = () => new Promise((resolve) => setTimeout(resolve, 0));

test('channel rules render existing overrides', async (t) => {
  const harness = overridesHarness();
  t.after(harness.restore);
  await harness.mock.chrome.storage.sync.set({
    channelOverrides: {
      'Channel A': {
        watched: { enabled: false },
        age: { enabled: true, maxAgeDays: 365 },
        view: { enabled: false },
      },
    },
  });

  await renderOverrides();

  const row = harness.documentObject.querySelector('#override-rows tr');
  assert.equal(row.querySelector('.override-channel').value, 'Channel A');
  assert.equal(row.querySelector('.override-watched').checked, false);
  assert.equal(row.querySelector('.override-age-mode').value, 'custom');
  assert.equal(row.querySelector('.override-age-limit').valueAsNumber, 365);
  assert.equal(row.querySelector('.override-view-mode').value, 'off');
  assert.equal(row.querySelector('.override-view-limit-row').hidden, true);
});

test('channel rules add and edit rows persist normalized overrides', async (t) => {
  const harness = overridesHarness();
  t.after(harness.restore);
  await setupOverridesEditor();

  harness.documentObject.getElementById('override-add').click();
  let row = harness.documentObject.querySelector('#override-rows tr');
  const channel = row.querySelector('.override-channel');
  channel.value = '  Channel A  ';
  row.querySelector('.override-watched').checked = false;
  row.querySelector('.override-age-mode').value = 'custom';
  row.querySelector('.override-age-limit').value = '90';
  change(channel);
  await settleChanges();

  assert.deepEqual(harness.mock.areas.sync.channelOverrides, {
    'Channel A': {
      watched: { enabled: false },
      age: { enabled: true, maxAgeDays: 90 },
    },
  });

  row = harness.documentObject.querySelector('#override-rows tr');
  row.querySelector('.override-view-mode').value = 'custom';
  row.querySelector('.override-view-limit').value = '2500';
  change(row.querySelector('.override-view-limit'));
  await settleChanges();

  assert.deepEqual(harness.mock.areas.sync.channelOverrides['Channel A'].view, {
    enabled: true,
    minViews: 2500,
  });
});

test('channel rules remove rows and ignore garbage number input', async (t) => {
  const harness = overridesHarness();
  t.after(harness.restore);
  await harness.mock.chrome.storage.sync.set({
    channelOverrides: {
      'Channel A': { age: { enabled: true, maxAgeDays: 30 } },
      'Channel B': { view: { enabled: true, minViews: 1000 } },
    },
  });
  await setupOverridesEditor();

  let rows = harness.documentObject.querySelectorAll('#override-rows tr');
  const channelARow = [...rows].find((row) =>
    row.querySelector('.override-channel').value === 'Channel A');
  channelARow.querySelector('.override-age-limit').value = '1.5';
  change(channelARow.querySelector('.override-age-limit'));
  await settleChanges();

  assert.deepEqual(harness.mock.areas.sync.channelOverrides['Channel A'], {
    age: { enabled: true, maxAgeDays: 30 },
  });

  rows = harness.documentObject.querySelectorAll('#override-rows tr');
  const channelBRow = [...rows].find((row) =>
    row.querySelector('.override-channel').value === 'Channel B');
  channelBRow.querySelector('.override-remove').click();
  await settleChanges();

  assert.deepEqual(harness.mock.areas.sync.channelOverrides, {
    'Channel A': { age: { enabled: true, maxAgeDays: 30 } },
  });
});

test('malformed settings JSON leaves storage untouched', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ watched: ['keep-local'] });
  await harness.syncStorage.set({ config: { enabled: true } });
  const before = structuredClone(harness.mock.areas);
  let confirmed = false;

  const result = await importSettings({
    ...harness,
    file: { text: async () => '{"format":1,' },
    confirmFn: () => {
      confirmed = true;
      return true;
    },
    renderResult: async () => assert.fail('must not render after a failed import'),
  });

  assert.equal(result, false);
  assert.equal(confirmed, false);
  assert.deepEqual(harness.mock.areas, before);
  assert.match(harness.statusElement.textContent, /^Import failed:/);
  assert.equal(harness.button.disabled, false);
});

test('wrong-shape settings object leaves storage untouched', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ watched: ['keep-local'] });
  await harness.syncStorage.set({ config: { enabled: true } });
  const before = structuredClone(harness.mock.areas);

  const result = await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify({ local: {}, sync: {} }) },
    confirmFn: () => assert.fail('invalid data must not be confirmed'),
    renderResult: async () => assert.fail('invalid data must not render'),
  });

  assert.equal(result, false);
  assert.deepEqual(harness.mock.areas, before);
  assert.match(harness.statusElement.textContent, /missing format/i);
  assert.equal(harness.button.disabled, false);
});

test('settings import rejects an array as the local storage area', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ watched: ['keep-local'] });
  await harness.syncStorage.set({ config: { enabled: true } });
  const before = JSON.stringify(harness.mock.areas);

  const result = await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify({ format: 1, local: [] }) },
    confirmFn: () => assert.fail('invalid data must not be confirmed'),
    renderResult: async () => assert.fail('invalid data must not render'),
  });

  assert.equal(result, false);
  assert.equal(JSON.stringify(harness.mock.areas), before);
  assert.match(harness.statusElement.textContent, /^Import failed:/);
  assert.equal(harness.button.disabled, false);
});

test('local-only settings import leaves sync storage untouched', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ staleLocal: true });
  await harness.syncStorage.set({ config: { enabled: true }, keep: 'sync' });
  const originalSync = structuredClone(harness.mock.areas.sync);
  const local = {
    subs: { format: 2, ids: ['Imported Channel'], fetchedAt: 123 },
    watched: ['video-1'],
  };

  const result = await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify({ format: 1, local }) },
    confirmFn: () => true,
    renderResult: async () => {},
  });

  assert.equal(result, true);
  assert.deepEqual(harness.mock.areas.local, local);
  assert.deepEqual(harness.mock.areas.sync, originalSync);
  assert.equal(harness.button.disabled, false);
});

test('declining settings import leaves both storage areas untouched', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({ watched: ['keep-local'] });
  await harness.syncStorage.set({ config: { enabled: true } });
  const before = structuredClone(harness.mock.areas);
  let rendered = false;

  const result = await importSettings({
    ...harness,
    file: {
      text: async () => JSON.stringify({
        format: 1,
        local: { watched: ['replacement'] },
        sync: { config: { enabled: false } },
      }),
    },
    confirmFn: () => false,
    renderResult: async () => {
      rendered = true;
    },
  });

  assert.equal(result, false);
  assert.equal(rendered, false);
  assert.deepEqual(harness.mock.areas, before);
  assert.equal(harness.statusElement.textContent, 'Import cancelled.');
  assert.equal(harness.button.disabled, false);
});

test('options renders every refresh failure reason distinctly', () => {
  const reasons = [
    'no-youtube-tab',
    'content-script-no-response',
    'collect-tab-closed',
    'budget-expired',
    'continuation-present',
    'count-unstable',
    'doc-inaccessible',
    'empty-names',
    'bottom-not-reached',
    'scrape-exception',
    'scrape-incomplete',
  ];
  const diagnostics = {
    finalNameCount: 98,
    initialNameCount: 90,
    bottomReached: true,
    elapsedMs: 45_000,
    scrollAttempts: 12,
    continuationPresent: false,
  };
  const messages = reasons.map((reason) =>
    refreshFailureMessage(reason, diagnostics));

  assert.equal(new Set(messages).size, reasons.length);
  assert.match(messages[0], /open a YouTube tab/i);
  assert.match(messages[1], /did not respond/i);
  assert.match(messages[2], /closed before it finished/i);
  for (const [index, reason] of reasons.entries()) {
    assert.match(messages[index], new RegExp(reason));
  }
  for (const message of messages.slice(3)) {
    assert.match(
      message,
      /98 names \(initially 90\) after 12 scrolls, 45\.0s, bottom reached, no continuation present/,
    );
  }
});

test('options timeout stays strictly above the scrape budget', () => {
  assert.ok(MANUAL_REFRESH_TIMEOUT_MS > SUBS_SCRAPE_BUDGET_MS);
});

test('manual refresh times out at its configured bound and always re-enables the button', async () => {
  const button = { disabled: false };
  const statusElement = { textContent: '' };
  const rendered = [];
  let scheduledFor;
  let cancelled;
  const sent = [];

  await runManualSubscriptionRefresh({
    button,
    statusElement,
    confirmFn: () => true,
    sendMessage: (message) => {
      sent.push(message);
      return new Promise(() => {});
    },
    renderResult: async (result) => rendered.push(result),
    scheduleTimeout(callback, milliseconds) {
      scheduledFor = milliseconds;
      queueMicrotask(callback);
      return 42;
    },
    cancelTimeout(timer) {
      cancelled = timer;
    },
  });

  assert.equal(scheduledFor, MANUAL_REFRESH_TIMEOUT_MS);
  assert.match(
    statusElement.textContent,
    new RegExp(`up to ${SUBS_SCRAPE_BUDGET_MS / 1000} seconds`, 'i'),
  );
  assert.match(
    statusElement.textContent,
    /A tab will open, scroll by itself, and close\./,
  );
  assert.deepEqual(rendered, [{ reason: 'timeout' }]);
  assert.deepEqual(sent, [
    { type: 'refresh-subs' },
    { type: 'cancel-subs-refresh' },
  ]);
  assert.equal(button.disabled, false);
  assert.equal(cancelled, 42);
});

test('manual refresh passes scrape diagnostics through to status rendering', async () => {
  const button = { disabled: false };
  const statusElement = { textContent: '' };
  const diagnostics = {
    finalNameCount: 98,
    initialNameCount: 98,
    bottomReached: false,
    elapsedMs: 45_000,
    scrollAttempts: 12,
    continuationPresent: true,
  };
  const rendered = [];

  await runManualSubscriptionRefresh({
    button,
    statusElement,
    confirmFn: () => true,
    sendMessage: async () => ({
      reason: 'continuation-present',
      diagnostics,
    }),
    renderResult: async (result) => rendered.push(result),
    scheduleTimeout: () => 42,
    cancelTimeout: () => {},
  });

  assert.deepEqual(rendered, [{
    reason: 'continuation-present',
    diagnostics,
  }]);
  assert.equal(button.disabled, false);
});

test('closing the collection tab surfaces the reason and re-enables the button', async () => {
  const button = { disabled: false };
  const statusElement = { textContent: '' };
  const rendered = [];

  await runManualSubscriptionRefresh({
    button,
    statusElement,
    confirmFn: () => true,
    sendMessage: async () => ({ reason: 'collect-tab-closed' }),
    renderResult: async (result) => rendered.push(result),
    scheduleTimeout: () => 42,
    cancelTimeout: () => {},
  });

  assert.deepEqual(rendered, [{ reason: 'collect-tab-closed' }]);
  assert.equal(button.disabled, false);
});

test('manual refresh cancellation sends no message and re-enables the button', async () => {
  const button = { disabled: false };
  const statusElement = { textContent: 'Ready.' };
  const sent = [];
  const rendered = [];
  let confirmationText;
  let timeoutScheduled = false;

  await runManualSubscriptionRefresh({
    button,
    statusElement,
    confirmFn: (message) => {
      confirmationText = message;
      return false;
    },
    sendMessage: async (message) => {
      sent.push(message);
      return { count: 1 };
    },
    renderResult: async (result) => rendered.push(result),
    scheduleTimeout: () => {
      timeoutScheduled = true;
      return 42;
    },
  });

  assert.equal(
    confirmationText,
    'This will open your YouTube channels page in a new tab, scroll to the end of your subscription list (about 20 seconds), and close the tab automatically. Continue?',
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(rendered, []);
  assert.equal(timeoutScheduled, false);
  assert.equal(statusElement.textContent, 'Refresh cancelled.');
  assert.equal(button.disabled, false);
});

test('manual refresh acceptance proceeds with the existing refresh flow', async () => {
  const button = { disabled: false };
  const statusElement = { textContent: '' };
  const sent = [];
  const rendered = [];
  let confirmationText;
  let cancelled;

  await runManualSubscriptionRefresh({
    button,
    statusElement,
    confirmFn: (message) => {
      confirmationText = message;
      return true;
    },
    sendMessage: async (message) => {
      sent.push(message);
      return { count: 3 };
    },
    renderResult: async (result) => rendered.push(result),
    scheduleTimeout: () => 42,
    cancelTimeout: (timer) => {
      cancelled = timer;
    },
  });

  assert.equal(
    confirmationText,
    'This will open your YouTube channels page in a new tab, scroll to the end of your subscription list (about 20 seconds), and close the tab automatically. Continue?',
  );
  assert.deepEqual(sent, [{ type: 'refresh-subs' }]);
  assert.deepEqual(rendered, [{ count: 3 }]);
  assert.match(statusElement.textContent, /Refreshing subscriptions/);
  assert.equal(cancelled, 42);
  assert.equal(button.disabled, false);
});
