import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMigratedPrivateStore,
  migrateLegacySyncState,
} from '../src/sync/private-store.js';

function memoryArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const output = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in values) output[key] = structuredClone(values[key]);
      }
      return output;
    },
    async set(items) {
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

test('legacy sync state moves out of chrome.storage exactly once', async () => {
  const legacyArea = memoryArea({
    blocklist: ['Kept'],
    syncSettings: { enabled: true, url: 'https://dav.example/f.bin', password: 'p' },
    syncMeta: { revision: '"1"' },
    syncDoc: { v: 1 },
  });
  const privateStore = memoryArea();

  assert.equal(
    await migrateLegacySyncState({ legacyArea, privateStore }),
    true,
  );
  assert.deepEqual(legacyArea.values, { blocklist: ['Kept'] });
  assert.equal(privateStore.values.syncSettings.password, 'p');
  assert.deepEqual(privateStore.values.syncMeta, { revision: '"1"' });
  assert.deepEqual(privateStore.values.syncDoc, { v: 1 });

  assert.equal(
    await migrateLegacySyncState({ legacyArea, privateStore }),
    false,
  );
});

test('a value already in the private store wins over a legacy copy', async () => {
  const legacyArea = memoryArea({ syncSettings: { url: 'https://old.example/f' } });
  const privateStore = memoryArea({
    syncSettings: { url: 'https://new.example/f' },
  });

  await migrateLegacySyncState({ legacyArea, privateStore });

  assert.equal(privateStore.values.syncSettings.url, 'https://new.example/f');
  assert.deepEqual(legacyArea.values, {});
});

test('the migrated store finishes the migration before the first read', async () => {
  const legacyArea = memoryArea({ syncSettings: { enabled: true } });
  const store = createMigratedPrivateStore({
    legacyArea,
    privateStore: memoryArea(),
  });

  assert.deepEqual(await store.get('syncSettings'), {
    syncSettings: { enabled: true },
  });
  assert.deepEqual(legacyArea.values, {});
});
