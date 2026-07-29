import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  UPDATE_CHECK_MIN_INTERVAL_MS,
  UPDATE_CHECK_URL,
  checkForUpdate,
  isNewerVersion,
  updateAvailable,
} from '../src/update-check.js';

function updateHarness() {
  const mock = installChromeMock({ install: false });
  return {
    mock,
    storage: mock.chrome.storage,
  };
}

test('isNewerVersion compares numeric version segments', () => {
  assert.equal(isNewerVersion('0.7.1', '0.7.0'), true);
  assert.equal(isNewerVersion('0.6.9', '0.7.0'), false);
  assert.equal(isNewerVersion('0.7.0', '0.7.0'), false);
  assert.equal(isNewerVersion('v0.7.1', '0.7.0'), true);
});

test('isNewerVersion fails closed on garbage versions', () => {
  assert.equal(isNewerVersion('release-0.7.1', '0.7.0'), false);
  assert.equal(isNewerVersion('0.7.beta', '0.7.0'), false);
  assert.equal(isNewerVersion(null, '0.7.0'), false);
  assert.equal(isNewerVersion('0.7.1', undefined), false);
});

test('isNewerVersion treats missing trailing segments as zero', () => {
  assert.equal(isNewerVersion('1.2', '1.2.0'), false);
  assert.equal(isNewerVersion('1.2.1', '1.2'), true);
  assert.equal(isNewerVersion('1..2', '1.2.0'), false);
});

test('checkForUpdate stores and returns a successful release tag', async () => {
  const { mock, storage } = updateHarness();
  const calls = [];

  const result = await checkForUpdate({
    fetchFn: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        async json() {
          return { tag_name: 'v0.7.1' };
        },
      };
    },
    storage,
    now: 123_456,
    currentVersion: '0.7.0',
  });

  assert.equal(result, 'v0.7.1');
  assert.deepEqual(calls, [[
    UPDATE_CHECK_URL,
    { headers: { Accept: 'application/vnd.github+json' } },
  ]]);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: 123_456,
    latestTag: 'v0.7.1',
  });
});

test('checkForUpdate interval guard skips the fetch across restarts', async () => {
  const { storage } = updateHarness();
  const now = 90_000_000;
  await storage.local.set({
    updateCheck: {
      lastCheckedAt: now - UPDATE_CHECK_MIN_INTERVAL_MS + 1,
      latestTag: 'v0.7.1',
    },
  });
  let fetches = 0;

  const result = await checkForUpdate({
    fetchFn: async () => {
      fetches += 1;
      throw new Error('must not fetch');
    },
    storage,
    now,
    currentVersion: '0.7.0',
  });

  assert.equal(result, 'v0.7.1');
  assert.equal(fetches, 0);
});

test('checkForUpdate force bypasses the interval guard and refreshes the cache', async () => {
  const { mock, storage } = updateHarness();
  const now = 90_000_000;
  await storage.local.set({
    updateCheck: {
      lastCheckedAt: now - 1,
      latestTag: 'v0.7.1',
    },
  });
  let fetches = 0;

  const result = await checkForUpdate({
    fetchFn: async () => {
      fetches += 1;
      return {
        ok: true,
        async json() {
          return { tag_name: 'v0.7.2' };
        },
      };
    },
    storage,
    now,
    currentVersion: '0.7.0',
    force: true,
  });

  assert.equal(result, 'v0.7.2');
  assert.equal(fetches, 1);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: now,
    latestTag: 'v0.7.2',
  });
});

test('checkForUpdate stores only the timestamp on an HTTP error', async () => {
  const { mock, storage } = updateHarness();
  await storage.local.set({
    updateCheck: { lastCheckedAt: 1, latestTag: 'v9.9.9' },
  });

  const result = await checkForUpdate({
    fetchFn: async () => ({ ok: false, status: 503 }),
    storage,
    now: UPDATE_CHECK_MIN_INTERVAL_MS + 2,
    currentVersion: '0.7.0',
  });

  assert.equal(result, null);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: UPDATE_CHECK_MIN_INTERVAL_MS + 2,
  });
});

test('checkForUpdate handles a thrown fetch and clears the cached tag', async () => {
  const { mock, storage } = updateHarness();

  const result = await checkForUpdate({
    fetchFn: async () => {
      throw new Error('offline');
    },
    storage,
    now: 500,
    currentVersion: '0.7.0',
  });

  assert.equal(result, null);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: 500,
  });
});

test('checkForUpdate treats malformed response JSON as a failed check', async () => {
  const { mock, storage } = updateHarness();

  const result = await checkForUpdate({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return { tag_name: 701 };
      },
    }),
    storage,
    now: 700,
    currentVersion: '0.7.0',
  });

  assert.equal(result, null);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: 700,
  });
});

test('updateAvailable returns only a strictly newer cached tag', async () => {
  const { storage } = updateHarness();

  for (const [latestTag, expected] of [
    ['v0.7.1', 'v0.7.1'],
    ['v0.7.0', null],
    ['v0.6.9', null],
    ['not-a-version', null],
  ]) {
    await storage.local.set({
      updateCheck: { lastCheckedAt: 123, latestTag },
    });
    assert.equal(
      await updateAvailable({ storage, currentVersion: '0.7.0' }),
      expected,
    );
  }
});
