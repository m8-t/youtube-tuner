import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import { createTileActions } from '../src/content/actions.js';
import { readNativeUndo } from '../src/dom/block-button.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

function setup({
  feedback = DEFAULT_CONFIG.feedback,
  sendNativeFeedback = false,
  reservation = { ok: true, id: 'r1', used: 1, limit: 3 },
  nativeResult = true,
  state: stateOverrides = {},
} = {}) {
  const doc = html('<div id="tile"></div>');
  const element = doc.getElementById('tile');
  const calls = [];
  const toasts = [];
  const timers = [];
  let rescans = 0;
  const state = {
    blocklist: new Set(),
    blockMeta: new Map(),
    blockedHandles: new Map(),
    hidden: new Set(),
    feedbackQueue: new Set(),
    ...stateOverrides,
  };
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result() : result;
  };
  const client = {
    block: record('block'),
    unblock: record('unblock'),
    snoozeBlock: record('snoozeBlock'),
    pinBlock: record('pinBlock'),
    hideVideo: record('hideVideo'),
    unhideVideo: record('unhideVideo'),
    reportBlockStats: record('reportBlockStats'),
    reserveFeedback: record('reserveFeedback', () => reservation),
    releaseFeedback: record('releaseFeedback'),
    dequeueFeedback: record('dequeueFeedback'),
  };
  const actions = createTileActions({
    doc,
    client,
    getConfig: () => ({
      ...DEFAULT_CONFIG,
      feedback,
      blocklistRule: { enabled: true, sendNativeFeedback },
    }),
    getState: () => state,
    rescan: () => { rescans += 1; },
    hold: (held) => calls.push(['hold', held.id]),
    release: (held) => calls.push(['release', held.id]),
    runNative: async (request) => {
      calls.push(['native', request.action, request.tile.id]);
      return nativeResult;
    },
    notify: (toast) => toasts.push(toast),
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });
  return {
    actions,
    calls,
    element,
    state,
    timers,
    toasts,
    rescans: () => rescans,
    names: () => calls.map(([name]) => name),
  };
}

const TILE = {
  videoId: 'video000001',
  channelName: 'News',
  channelHandle: '@news',
};
const OPTED_IN = { enabled: true, weeklyLimit: 3 };

test('LOCAL FIRST: hiding a video touches only local data and can be undone', async () => {
  const h = setup();

  await h.actions.hideVideo(TILE, h.element);

  assert.deepEqual(h.calls, [['hideVideo', 'video000001']]);
  assert.equal(h.state.hidden.has('video000001'), true);
  assert.equal(h.rescans(), 1);
  assert.equal(h.toasts[0].text, 'Video hidden.');

  await h.toasts[0].actions[0].onClick();
  assert.deepEqual(h.calls.at(-1), ['unhideVideo', 'video000001']);
  assert.equal(h.state.hidden.has('video000001'), false);
});

test('LOCAL FIRST: blocking sends nothing to YouTube by default', async () => {
  const h = setup();

  await h.actions.blockChannel('News', TILE, h.element);

  assert.deepEqual(h.calls, [['block', 'News', '@news']]);
  assert.equal(h.state.blocklist.has('News'), true);
  assert.deepEqual(h.state.blockMeta.get('News'), {
    handles: ['@news'],
    until: null,
  });
  assert.equal(h.state.blockedHandles.get('@news'), 'News');
  assert.equal(h.toasts[0].text, 'Blocked News.');
  assert.deepEqual(
    h.toasts[0].actions.map(({ label }) => label),
    ['Undo', '30 days only'],
  );
});

test('LOCAL FIRST: the native block switch does nothing without the master opt-in', async () => {
  const h = setup({ sendNativeFeedback: true });

  await h.actions.blockChannel('News', TILE, h.element);

  assert.deepEqual(h.names(), ['block']);
});

test('SNOOZE: the toast turns a fresh block into a 30-day one', async () => {
  const h = setup();
  await h.actions.blockChannel('News', TILE, h.element);

  await h.toasts[0].actions[1].onClick();

  assert.deepEqual(h.calls.at(-1), ['snoozeBlock', 'News']);
  assert.equal(h.toasts[1].text, 'Blocked News for 30 days.');
  assert.deepEqual(h.toasts[1].actions.map(({ label }) => label), ['Undo']);
});

test('undoing a block removes the name and its handles from the live state', async () => {
  const h = setup();
  await h.actions.blockChannel('News', TILE, h.element);

  await h.toasts[0].actions[0].onClick();

  assert.deepEqual(h.calls.at(-1), ['unblock', 'News']);
  assert.equal(h.state.blocklist.has('News'), false);
  assert.equal(h.state.blockMeta.has('News'), false);
  assert.equal(h.state.blockedHandles.has('@news'), false);
});

test('BUDGET: an opted-in "Not interested" is reserved, sent, then hidden locally', async () => {
  const h = setup({ feedback: OPTED_IN });

  await h.actions.tellYouTube(TILE, h.element);

  assert.deepEqual(h.calls, [
    ['reserveFeedback', {
      action: 'notInterested',
      videoId: 'video000001',
      channelName: 'News',
    }],
    ['native', 'notInterested', 'tile'],
    ['hideVideo', 'video000001'],
  ]);
  assert.equal(
    h.toasts[0].text,
    'Video hidden. Sent to YouTube (1 of 3 this week).',
  );
});

test('BUDGET: with the limit used up nothing is sent and the video is still hidden', async () => {
  const h = setup({
    feedback: OPTED_IN,
    reservation: { ok: false, reason: 'budget', used: 3, limit: 3 },
  });

  await h.actions.tellYouTube(TILE, h.element);

  assert.deepEqual(h.names(), ['reserveFeedback', 'hideVideo']);
  assert.match(h.toasts[0].text, /YouTube was not told: the weekly limit of 3 is used up\./);
});

test('BUDGET: a menu that does not offer the action gives the slot back', async () => {
  const h = setup({ feedback: OPTED_IN, nativeResult: false });

  await h.actions.tellYouTube(TILE, h.element);

  assert.deepEqual(h.names(), [
    'reserveFeedback',
    'native',
    'releaseFeedback',
    'hideVideo',
  ]);
  assert.deepEqual(h.calls[2], ['releaseFeedback', 'r1']);
  assert.match(h.toasts[0].text, /nothing was sent/);
});

test('BUDGET: without opt-in the feedback action only hides locally', async () => {
  const h = setup();

  await h.actions.tellYouTube(TILE, h.element);

  assert.deepEqual(h.names(), ['hideVideo']);
});

test("BUDGET: an opted-in block sends \"Don't recommend channel\" first, then blocks locally", async () => {
  const h = setup({ feedback: OPTED_IN, sendNativeFeedback: true });

  await h.actions.blockChannel('News', TILE, h.element);

  assert.deepEqual(h.names(), ['reserveFeedback', 'native', 'block']);
  assert.deepEqual(h.calls[1], ['native', 'dontRecommendChannel', 'tile']);
  assert.equal(readNativeUndo(h.element), 'News');
  assert.equal(
    h.toasts[0].text,
    'Blocked News. Sent to YouTube (1 of 3 this week).',
  );
});

test('BUDGET: a refused native signal never stops the local block', async () => {
  const h = setup({
    feedback: OPTED_IN,
    sendNativeFeedback: true,
    reservation: { ok: false, reason: 'budget', used: 3, limit: 3 },
  });

  await h.actions.blockChannel('News', TILE, h.element);

  assert.deepEqual(h.names(), ['reserveFeedback', 'block']);
  assert.equal(h.state.blocklist.has('News'), true);
});

const blockedTile = (videoId, extra = {}) => ({
  element: null,
  tile: { videoId, channelName: 'Spam', channelHandle: null, ...extra },
  verdict: { hide: true, reason: 'blocked' },
});

test('STATS: each recommended video of a blocked channel counts once per page', () => {
  const h = setup({ state: { blocklist: new Set(['Spam']) } });
  const tiles = [
    blockedTile('video000001'),
    blockedTile('video000002'),
    { element: null, tile: { videoId: 'video000003', channelName: 'Fine' }, verdict: { hide: false, reason: 'shown' } },
    { element: null, tile: { videoId: 'video000004', channelName: 'Old' }, verdict: { hide: true, reason: 'age' } },
  ];

  h.actions.noteBlockedTiles(tiles);
  h.actions.noteBlockedTiles(tiles);
  assert.equal(h.timers.length, 1);
  h.actions.flushStats();

  assert.deepEqual(h.calls, [['reportBlockStats', { Spam: 2 }]]);
  h.actions.flushStats();
  assert.equal(h.calls.length, 1);
});

test('IDENTITY: a name-only block is pinned once when its handle shows up', () => {
  const h = setup({ state: { blocklist: new Set(['Spam']) } });

  h.actions.noteBlockedTiles([
    blockedTile('video000001', { channelHandle: '@spam' }),
    blockedTile('video000002', { channelHandle: '@spam' }),
  ]);

  assert.deepEqual(
    h.calls.filter(([name]) => name === 'pinBlock'),
    [['pinBlock', 'Spam', '@spam']],
  );
});

test('QUEUE: a marked channel gets one budgeted signal on a held tile', async () => {
  const h = setup({
    feedback: OPTED_IN,
    state: {
      blocklist: new Set(['Spam']),
      feedbackQueue: new Set(['Spam']),
    },
  });
  const tiles = [{ ...blockedTile('video000001'), element: h.element }];

  assert.equal(await h.actions.processQueue(tiles), true);

  assert.deepEqual(h.calls, [
    ['hold', 'tile'],
    ['reserveFeedback', {
      action: 'notInterested',
      videoId: 'video000001',
      channelName: 'Spam',
    }],
    ['native', 'notInterested', 'tile'],
    ['release', 'tile'],
    ['dequeueFeedback', 'Spam'],
  ]);
  assert.equal(h.state.feedbackQueue.has('Spam'), false);
  assert.match(h.toasts[0].text, /Told YouTube you are not interested in Spam\./);

  // Nothing is left in the queue, so a second scan does nothing.
  assert.equal(await h.actions.processQueue(tiles), false);
  assert.equal(h.calls.length, 5);
});

test('QUEUE: a refused or failed attempt is not repeated on the same page', async () => {
  const h = setup({
    feedback: OPTED_IN,
    reservation: { ok: false, reason: 'budget', used: 3, limit: 3 },
    state: {
      blocklist: new Set(['Spam']),
      feedbackQueue: new Set(['Spam']),
    },
  });
  const tiles = [{ ...blockedTile('video000001'), element: h.element }];

  assert.equal(await h.actions.processQueue(tiles), false);
  assert.equal(await h.actions.processQueue(tiles), false);

  assert.deepEqual(h.names(), ['hold', 'reserveFeedback', 'release']);
  assert.equal(h.state.feedbackQueue.has('Spam'), true);
});

test('QUEUE: nothing happens without opt-in, even for a marked channel', async () => {
  const h = setup({
    state: {
      blocklist: new Set(['Spam']),
      feedbackQueue: new Set(['Spam']),
    },
  });

  assert.equal(await h.actions.processQueue([
    { ...blockedTile('video000001'), element: h.element },
  ]), false);
  assert.deepEqual(h.calls, []);
});
