import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlySyncError } from '../src/sync/friendly-errors.js';

test('sync errors are mapped to plain language with unknown errors passed through', async (t) => {
  const cases = [
    {
      input: 'TypeError: Failed to fetch',
      expected:
        'Could not reach the sync server. Check the URL and your connection.',
    },
    {
      input: 'NetworkError when attempting to fetch resource.',
      expected:
        'Could not reach the sync server. Check the URL and your connection.',
    },
    {
      input: 'WebDAV request failed',
      expected:
        'Could not reach the sync server. Check the URL and your connection.',
    },
    {
      input: 'WebDAV request failed with HTTP 404',
      expected:
        'Sync location not found on the server. Check the folder path.',
    },
    {
      input: 'remote data is older than previously seen state',
      expected:
        'The server returned older data than this device has already seen. ' +
        'If you restored a server backup on purpose, disable and re-enable sync.',
    },
    {
      input: 'WebDAV credentials were rejected',
      expected: 'WebDAV credentials were rejected',
    },
    {
      input: 'WebDAV request failed with HTTP 401',
      expected: 'WebDAV request failed with HTTP 401',
    },
    {
      input: 'WebDAV request failed with HTTP 403',
      expected: 'WebDAV request failed with HTTP 403',
    },
    {
      input: 'An unfamiliar server error',
      expected: 'An unfamiliar server error',
    },
  ];

  for (const { input, expected } of cases) {
    await t.test(input, () => {
      assert.equal(friendlySyncError(input), expected);
    });
  }
});

test('sync error mapping accepts Error objects and a caller fallback', () => {
  assert.equal(
    friendlySyncError(new TypeError('Failed to fetch')),
    'Could not reach the sync server. Check the URL and your connection.',
  );
  assert.equal(friendlySyncError(null, 'Unknown error'), 'Unknown error');
});
