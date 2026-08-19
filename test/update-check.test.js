import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import {
  BETA_UPDATE_CHECK_URL,
  UPDATE_CHECK_MIN_INTERVAL_MS,
  UPDATE_CHECK_URL,
  checkForUpdate,
  isNewerVersion,
  updateAvailable,
} from '../src/update-check.js';

function updateHarness({
  version = '0.7.0',
  versionName,
} = {}) {
  const mock = installChromeMock();
  mock.chrome.runtime.getManifest = () => ({
    version,
    ...(versionName === undefined ? {} : { version_name: versionName }),
  });
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

test('stable installs ignore prerelease versions entirely', async () => {
  const { mock, storage } = updateHarness({ version: '1.4.6' });
  const calls = [];

  const result = await checkForUpdate({
    fetchFn: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        async json() {
          return { tag_name: 'v1.4.7-beta.3', prerelease: true };
        },
      };
    },
    storage,
    now: 1_000,
    currentVersion: '1.4.6',
  });

  assert.equal(result, null);
  assert.deepEqual(calls, [[
    UPDATE_CHECK_URL,
    { headers: { Accept: 'application/vnd.github+json' } },
  ]]);
  assert.deepEqual(mock.areas.local.updateCheck, { lastCheckedAt: 1_000 });
});

test('beta installs are nudged to the same-base stable release', async () => {
  const { mock, storage } = updateHarness({
    version: '1.4.6.2',
    versionName: '1.4.7-beta.2',
  });
  const calls = [];

  const result = await checkForUpdate({
    fetchFn: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        async json() {
          return [{ tag_name: 'v1.4.7', draft: false }];
        },
      };
    },
    storage,
    now: 2_000,
    currentVersion: '1.4.6.2',
  });

  assert.equal(result, 'v1.4.7');
  assert.deepEqual(calls, [[
    BETA_UPDATE_CHECK_URL,
    { headers: { Accept: 'application/vnd.github+json' } },
  ]]);
  assert.deepEqual(mock.areas.local.updateCheck, {
    lastCheckedAt: 2_000,
    latestTag: 'v1.4.7',
  });
  assert.equal(
    await updateAvailable({ storage, currentVersion: '1.4.6.2' }),
    'v1.4.7',
  );
});

test('beta installs are nudged to a newer beta release', async () => {
  const { storage } = updateHarness({
    version: '1.4.6.1',
    versionName: '1.4.7-beta.1',
  });

  await checkForUpdate({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return [
          { tag_name: 'v1.4.7-beta.2', draft: false },
          { tag_name: 'v1.4.7-beta.3', draft: false },
        ];
      },
    }),
    storage,
    now: 3_000,
    currentVersion: '1.4.6.1',
  });

  assert.equal(
    await updateAvailable({ storage, currentVersion: '1.4.6.1' }),
    'v1.4.7-beta.3',
  );
});

test('beta installs are not nudged by older stable or equal tags', async () => {
  for (const tag of ['v1.4.6', 'v1.4.7-beta.2']) {
    const { storage } = updateHarness({
      version: '1.4.6.2',
      versionName: '1.4.7-beta.2',
    });
    await storage.local.set({
      updateCheck: { lastCheckedAt: 4_000, latestTag: tag },
    });

    assert.equal(
      await updateAvailable({ storage, currentVersion: '1.4.6.2' }),
      null,
    );
  }
});

test('beta installs ignore unparseable tags without a nudge', async () => {
  const { mock, storage } = updateHarness({
    version: '1.4.6.2',
    versionName: '1.4.7-beta.2',
  });

  const result = await checkForUpdate({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return [{ tag_name: 'nightly', draft: false }];
      },
    }),
    storage,
    now: 5_000,
    currentVersion: '1.4.6.2',
  });

  assert.equal(result, null);
  assert.deepEqual(mock.areas.local.updateCheck, { lastCheckedAt: 5_000 });
  assert.equal(
    await updateAvailable({ storage, currentVersion: '1.4.6.2' }),
    null,
  );
});

test('beta installs filter and ignore draft releases', async () => {
  const { storage } = updateHarness({
    version: '1.4.6.2',
    versionName: '1.4.7-beta.2',
  });

  const result = await checkForUpdate({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return [
          { tag_name: 'v1.5.0', draft: true },
          { tag_name: 'v1.4.7-beta.2', draft: false },
        ];
      },
    }),
    storage,
    now: 6_000,
    currentVersion: '1.4.6.2',
  });

  assert.equal(result, 'v1.4.7-beta.2');
  assert.equal(
    await updateAvailable({ storage, currentVersion: '1.4.6.2' }),
    null,
  );
});
