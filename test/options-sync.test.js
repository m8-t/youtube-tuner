import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enableSync,
  exportSettings,
  formatSyncCapabilities,
  importSettings,
  setupSyncControls,
  testSyncConnection,
  validateSyncUrl,
} from '../src/options.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import { html } from './helpers/dom.js';

function syncHarness(t) {
  const mock = installChromeMock({ install: false });
  const documentObject = html(`
    <input id="sync-url" type="url">
    <input id="sync-username" type="text">
    <input id="sync-password" type="password">
    <input id="sync-passphrase" type="password">
    <button id="sync-test" type="button">Test connection</button>
    <button id="sync-enable" type="button">Enable sync</button>
    <button id="sync-disable" type="button" hidden disabled>Disable sync</button>
    <button id="sync-run" type="button" hidden>Sync now</button>
    <p id="sync-status"></p>
    <p id="sync-message"></p>
  `);
  const previousDocument = globalThis.document;
  globalThis.document = documentObject;
  t.after(() => {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  });
  return {
    documentObject,
    localStorage: mock.chrome.storage.local,
    mock,
  };
}

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

test('options page renders a Sync fieldset with its controls', () => {
  const markup = readFileSync('options.html', 'utf8');

  assert.match(markup, /<legend>Sync<\/legend>/);
  assert.match(
    markup,
    /Store the passphrase in your password manager\. It cannot be recovered — losing it means starting sync over with new data\./,
  );
  for (const id of [
    'sync-url',
    'sync-username',
    'sync-password',
    'sync-passphrase',
    'sync-test',
    'sync-enable',
    'sync-disable',
    'sync-run',
    'sync-status',
  ]) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
});

test('sync status populates status and configured fields on page setup', async (t) => {
  const harness = syncHarness(t);
  await harness.localStorage.set({
    syncSettings: {
      enabled: true,
      url: 'https://cloud.example.com/dav/youtube-tuner.bin',
      username: 'alice',
      password: 'app-secret',
    },
  });
  harness.documentObject.getElementById('sync-passphrase').value =
    'must-not-survive';
  const sent = [];

  await setupSyncControls({
    localStorage: harness.localStorage,
    requestPermission: async () => true,
    sendMessage: async (message) => {
      sent.push(message);
      return {
        configured: true,
        enabled: true,
        lastSyncAt: '2026-07-29T12:34:56.000Z',
        lastError: 'previous failure',
      };
    },
  });

  assert.deepEqual(sent, [{ type: 'sync-status' }]);
  assert.equal(
    harness.documentObject.getElementById('sync-url').value,
    'https://cloud.example.com/dav/youtube-tuner.bin',
  );
  assert.equal(
    harness.documentObject.getElementById('sync-username').value,
    'alice',
  );
  assert.equal(
    harness.documentObject.getElementById('sync-password').value,
    'app-secret',
  );
  assert.equal(
    harness.documentObject.getElementById('sync-passphrase').value,
    '',
  );
  assert.match(
    harness.documentObject.getElementById('sync-status').textContent,
    /Sync enabled\. Last sync: .+\. Last error: previous failure\./,
  );
  assert.equal(
    harness.documentObject.getElementById('sync-enable').disabled,
    true,
  );
  assert.equal(
    harness.documentObject.getElementById('sync-disable').hidden,
    false,
  );
  assert.equal(
    harness.documentObject.getElementById('sync-run').hidden,
    false,
  );
});

test('permission denial in Test connection stops before worker messaging', async (t) => {
  const harness = syncHarness(t);
  harness.documentObject.getElementById('sync-url').value =
    'https://cloud.example.com/dav/youtube-tuner.bin';
  let sent = false;

  const result = await testSyncConnection({
    requestPermission: async () => false,
    sendMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result, null);
  assert.equal(sent, false);
  assert.equal(
    harness.documentObject.getElementById('sync-message').textContent,
    'Permission denied',
  );
});

test('Test connection requests the exact origin and renders plain success copy', async (t) => {
  const harness = syncHarness(t);
  harness.documentObject.getElementById('sync-url').value =
    'https://cloud.example.com/dav/youtube-tuner.bin';
  harness.documentObject.getElementById('sync-username').value = 'alice';
  harness.documentObject.getElementById('sync-password').value = 'app-secret';
  const permissionRequests = [];
  const messages = [];

  const result = await testSyncConnection({
    requestPermission: async (request) => {
      permissionRequests.push(request);
      return true;
    },
    sendMessage: async (message) => {
      messages.push(message);
      return {
        ok: true,
        authOk: true,
        strongEtags: true,
        cas: true,
        failure: null,
      };
    },
  });

  assert.deepEqual(permissionRequests, [{
    origins: ['https://cloud.example.com/*'],
  }]);
  assert.deepEqual(messages, [{
    type: 'sync-test',
    settings: {
      url: 'https://cloud.example.com/dav/youtube-tuner.bin',
      username: 'alice',
      password: 'app-secret',
    },
  }]);
  assert.equal(result.ok, true);
  assert.equal(
    harness.documentObject.getElementById('sync-message').textContent,
    'Connection OK — server is compatible.',
  );
});

test('capability failures explain unsafe concurrent updates plainly', () => {
  const expected =
    'This server does not support safe concurrent updates, sync would risk ' +
    'data loss.';

  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: true,
    strongEtags: false,
    cas: false,
    failure: 'Probe did not return a strong ETag',
  }), expected);
  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: true,
    strongEtags: true,
    cas: false,
    failure: 'Probe stale conditional update was not rejected',
  }), expected);
});

test('capability failures use friendly transport errors before capability copy', () => {
  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: true,
    strongEtags: false,
    cas: false,
    failure: 'WebDAV request failed with HTTP 404',
  }), 'Sync location not found on the server. Check the folder path.');
  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: false,
    strongEtags: false,
    cas: false,
    failure: 'Probe authentication failed with HTTP 401',
  }), 'WebDAV credentials were rejected');
  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: true,
    strongEtags: false,
    cas: false,
    failure: 'WebDAV request failed',
  }), 'Could not reach the sync server. Check the URL and your connection.');
  assert.equal(formatSyncCapabilities({
    ok: false,
    authOk: true,
    strongEtags: false,
    cas: false,
    failure: 'Probe creation failed with HTTP 500',
  }), 'Probe creation failed with HTTP 500');
});

test('Enable sync clears the passphrase after worker success', async (t) => {
  const harness = syncHarness(t);
  harness.documentObject.getElementById('sync-url').value =
    'https://cloud.example.com/dav/youtube-tuner.bin';
  harness.documentObject.getElementById('sync-username').value = 'alice';
  harness.documentObject.getElementById('sync-password').value = 'app-secret';
  harness.documentObject.getElementById('sync-passphrase').value =
    'encryption-secret';
  const messages = [];

  const result = await enableSync({
    localStorage: harness.localStorage,
    requestPermission: async () => true,
    sendMessage: async (message) => {
      messages.push(message);
      if (message.type === 'sync-enable') {
        await harness.localStorage.set({
          syncSettings: {
            enabled: true,
            ...message.settings,
          },
        });
        return { ok: true };
      }
      return {
        configured: true,
        enabled: true,
        lastSyncAt: null,
        lastError: null,
      };
    },
  });

  assert.equal(result, true);
  assert.deepEqual(messages[0], {
    type: 'sync-enable',
    settings: {
      url: 'https://cloud.example.com/dav/youtube-tuner.bin',
      username: 'alice',
      password: 'app-secret',
    },
    passphrase: 'encryption-secret',
  });
  assert.deepEqual(messages[1], { type: 'sync-status' });
  assert.equal(
    harness.documentObject.getElementById('sync-passphrase').value,
    '',
  );
});

test('sync URL validation enforces an HTTPS file URL', () => {
  assert.throws(
    () => validateSyncUrl('http://cloud.example.com/dav/file.bin'),
    /https:\/\//,
  );
  assert.throws(
    () => validateSyncUrl('https://cloud.example.com/dav/folder/'),
    /must not end with \//,
  );
  assert.deepEqual(
    validateSyncUrl('https://cloud.example.com/dav/file.bin'),
    {
      origin: 'https://cloud.example.com/*',
      url: 'https://cloud.example.com/dav/file.bin',
    },
  );
});

test('settings export excludes local sync state and credentials', async () => {
  const harness = settingsHarness();
  await harness.localStorage.set({
    syncDoc: { private: 'document' },
    syncMeta: { revision: '"secret-revision"' },
    syncSettings: {
      url: 'https://cloud.example.com/dav/file.bin',
      username: 'alice',
      password: 'app-secret',
    },
    watched: ['video-1'],
  });

  const settings = await exportSettings({
    ...harness,
    createObjectURL: () => 'blob:sync-exclusion',
    revokeObjectURL: () => {},
    createElement: () => ({ click() {} }),
  });

  assert.deepEqual(settings.local, { watched: ['video-1'] });
});

test('settings import ignores local sync keys and preserves current sync state', async () => {
  const harness = settingsHarness();
  const currentSyncState = {
    syncDoc: { private: 'current-document' },
    syncMeta: { revision: '"current-revision"' },
    syncSettings: {
      url: 'https://current.example.com/dav/file.bin',
      username: 'current-user',
      password: 'current-secret',
    },
  };
  await harness.localStorage.set({
    staleLocal: true,
    ...currentSyncState,
  });
  const imported = {
    format: 1,
    local: {
      syncDoc: { private: 'imported-document' },
      syncMeta: { revision: '"imported-revision"' },
      syncSettings: {
        url: 'https://imported.example.com/dav/file.bin',
        username: 'imported-user',
        password: 'imported-secret',
      },
      watched: ['video-2'],
    },
  };

  const result = await importSettings({
    ...harness,
    file: { text: async () => JSON.stringify(imported) },
    confirmFn: () => true,
    renderResult: async () => {},
  });

  assert.equal(result, true);
  assert.deepEqual(harness.mock.areas.local, {
    ...currentSyncState,
    watched: ['video-2'],
  });
});
