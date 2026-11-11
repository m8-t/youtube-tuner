import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_STATE_KEYS,
  createContentApi,
  createStateBroadcaster,
  lockStorageToTrustedContexts,
} from '../src/background/content-api.js';
import { createSerialQueue } from '../src/background/serial.js';
import { createClient, hydrateState } from '../src/content/client.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

function fakeStore() {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  return {
    calls,
    readState: record('readState', { blocklist: ['Blocked'] }),
    addWatched: record('addWatched'),
    addBlocked: record('addBlocked'),
    removeBlocked: record('removeBlocked'),
    addSubNames: record('addSubNames', true),
    removeSubNames: record('removeSubNames', false),
    saveSubs: record('saveSubs'),
    getCollectionAttempt: record('getCollectionAttempt', 123),
    setCollectionAttempt: record('setCollectionAttempt'),
  };
}

function harness({ now = () => 5000 } = {}) {
  const store = fakeStore();
  const handle = createContentApi({
    enqueue: createSerialQueue(),
    store,
    now,
  });
  const send = (message) => new Promise((resolve) => {
    const handled = handle(message, {}, resolve);
    if (handled !== true) resolve(undefined);
  });
  return { store, send, handle };
}

test('the content API answers a state request with the snapshot', async () => {
  const { send } = harness();
  assert.deepEqual(await send({ type: 'state-get' }), {
    ok: true,
    result: { blocklist: ['Blocked'] },
  });
});

test('unknown and prototype message types are not handled', async () => {
  const { send, store } = harness();
  for (const type of ['sync-enable', 'constructor', '__proto__', '', 7]) {
    assert.equal(await send({ type }), undefined);
  }
  assert.deepEqual(store.calls, []);
});

test('writes are validated before they reach storage', async () => {
  const { send, store } = harness();

  assert.deepEqual(await send({ type: 'watched-add', videoId: '<img>' }), {
    ok: true,
    result: false,
  });
  assert.deepEqual(await send({ type: 'block-add', channelName: { a: 1 } }), {
    ok: true,
    result: false,
  });
  assert.deepEqual(
    await send({ type: 'block-add', channelName: 'x'.repeat(201) }),
    { ok: true, result: false },
  );
  assert.deepEqual(await send({ type: 'subs-save', names: [] }), {
    ok: true,
    result: false,
  });
  assert.deepEqual(await send({ type: 'subs-add', names: 'Channel' }), {
    ok: true,
    result: false,
  });
  assert.deepEqual(store.calls, []);

  await send({ type: 'watched-add', videoId: 'abcdefghijk' });
  await send({ type: 'block-add', channelName: '  Some Channel \nsecond line' });
  await send({ type: 'block-remove', channelName: 'Some Channel' });
  await send({ type: 'subs-save', names: ['A', 'A', ' B '] });
  assert.deepEqual(store.calls, [
    ['addWatched', 'abcdefghijk'],
    ['addBlocked', 'Some Channel'],
    ['removeBlocked', 'Some Channel'],
    ['saveSubs', ['A', 'B']],
  ]);
});

test('subscribe capture is limited to a handful of names per request', async () => {
  const { send, store } = harness();
  const names = Array.from({ length: 500 }, (_, index) => `Channel ${index}`);

  assert.deepEqual(await send({ type: 'subs-add', names }), {
    ok: true,
    result: true,
  });
  assert.equal(store.calls[0][1].length, 20);
});

test('the collection throttle uses the background clock, not the message', async () => {
  const { send, store } = harness({ now: () => 777 });

  await send({ type: 'subs-attempt-set', at: 9_999_999_999_999 });

  assert.deepEqual(store.calls, [['setCollectionAttempt', 777]]);
  assert.deepEqual(await send({ type: 'subs-attempt-get' }), {
    ok: true,
    result: 123,
  });
});

test('a storage failure is reported without details', async () => {
  const store = fakeStore();
  store.addBlocked = async () => {
    throw new Error('quota details');
  };
  const handle = createContentApi({ enqueue: createSerialQueue(), store });

  const response = await new Promise((resolve) => {
    handle({ type: 'block-add', channelName: 'Channel' }, {}, resolve);
  });

  assert.deepEqual(response, { ok: false });
});

test('the serial queue runs writes one at a time and survives a failure', async () => {
  const enqueue = createSerialQueue();
  const order = [];
  const slow = enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push('slow');
  });
  const failing = enqueue(async () => {
    order.push('failing');
    throw new Error('boom');
  });
  const last = enqueue(async () => {
    order.push('last');
    return 'done';
  });

  await slow;
  await assert.rejects(failing, /boom/);
  assert.equal(await last, 'done');
  assert.deepEqual(order, ['slow', 'failing', 'last']);
});

test('a relevant storage change is pushed to every YouTube tab once', async () => {
  const sent = [];
  const timers = [];
  const broadcaster = createStateBroadcaster({
    readState: async () => ({ blocklist: ['Blocked'] }),
    setTimeoutFn: (callback) => timers.push(callback),
    tabs: {
      async query(query) {
        assert.deepEqual(query, { url: 'https://www.youtube.com/*' });
        return [{ id: 1 }, { id: 2 }, { id: undefined }];
      },
      async sendMessage(tabId, message) {
        if (tabId === 2) throw new Error('no receiver');
        sent.push([tabId, message]);
      },
    },
  });

  for (const key of CONTENT_STATE_KEYS) {
    assert.equal(broadcaster.onStorageChanged({ [key]: {} }, 'local'), true);
  }
  assert.equal(broadcaster.onStorageChanged({ updateCheck: {} }, 'local'), false);
  assert.equal(broadcaster.onStorageChanged({ config: {} }, 'sync'), false);
  assert.equal(timers.length, 1);

  assert.equal(await broadcaster.broadcast(), 1);
  assert.deepEqual(sent, [
    [1, { type: 'state', state: { blocklist: ['Blocked'] } }],
  ]);
});

test('storage is locked to trusted contexts where the browser supports it', async () => {
  const levels = [];
  const area = (name) => ({
    async setAccessLevel(options) {
      levels.push([name, options.accessLevel]);
    },
  });

  assert.equal(await lockStorageToTrustedContexts({
    storage: { local: area('local'), sync: area('sync') },
  }), 2);
  assert.deepEqual(levels, [
    ['local', 'TRUSTED_CONTEXTS'],
    ['sync', 'TRUSTED_CONTEXTS'],
  ]);
  assert.equal(await lockStorageToTrustedContexts({
    storage: { local: {}, sync: {} },
  }), 0);
});

test('the client unwraps results and throws on a rejected request', async () => {
  const messages = [];
  const client = createClient({
    sendMessage: async (message) => {
      messages.push(message);
      return message.type === 'block-add'
        ? { ok: false }
        : { ok: true, result: 'value' };
    },
  });

  assert.equal(await client.addWatched('abcdefghijk'), 'value');
  await assert.rejects(client.block('Channel'), /rejected block-add/);
  assert.deepEqual(messages[0], { type: 'watched-add', videoId: 'abcdefghijk' });
});

test('a payload can never override the message type', async () => {
  const messages = [];
  const client = createClient({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });

  await client.addSubs(new Set(['A']));

  assert.deepEqual(messages, [{ type: 'subs-add', names: ['A'] }]);
});

test('a state snapshot hydrates into lookup structures', () => {
  const { config, fetchedSubs, state } = hydrateState({
    config: { enabled: false },
    subs: ['Fetched'],
    subsStale: false,
    manualSubs: ['Manual'],
    blocklist: ['Blocked', 7],
    watched: ['abcdefghijk'],
    overrides: { 'Channel A': { watched: { enabled: false } } },
  }, 'de');

  assert.equal(config.enabled, false);
  assert.equal(config.viewRule.minViews, DEFAULT_CONFIG.viewRule.minViews);
  assert.deepEqual(fetchedSubs, ['Fetched']);
  assert.deepEqual([...state.subs].sort(), ['Fetched', 'Manual']);
  assert.equal(state.subsStale, false);
  assert.deepEqual([...state.blocklist], ['Blocked']);
  assert.equal(state.watched.has('abcdefghijk'), true);
  assert.deepEqual(state.overrides.get('Channel A'), {
    watched: { enabled: false },
  });
  assert.equal(state.locale, 'de');
});

test('a missing or malformed snapshot fails open', () => {
  const { config, fetchedSubs, state } = hydrateState(undefined, 'en');

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(fetchedSubs, null);
  assert.equal(state.subs, null);
  assert.equal(state.subsStale, true);
  assert.equal(state.blocklist.size, 0);
  assert.equal(state.watched.size, 0);
});
