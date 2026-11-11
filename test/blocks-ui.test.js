import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installChromeMock } from './helpers/chrome-mock.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

// Not installed globally at import: the suite runs in one process and every
// file has its own mock. Each test installs this one and puts the old back.
const mock = installChromeMock({ install: false });
const {
  pruneUnseenBlocks,
  renderBlocklist,
  renderFeedback,
  renderHidden,
} = await import('../src/options/blocks-ui.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 500 * DAY;
const markup = readFileSync('options.html', 'utf8');

function page(t) {
  const documentObject = new JSDOM(markup).window.document;
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  mock.reset();
  globalThis.document = documentObject;
  globalThis.chrome = mock.chrome;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    globalThis.chrome = previousChrome;
  });
  return documentObject;
}

const rowTexts = (doc) => [...doc.querySelectorAll('#block-rows tr')]
  .map((row) => [...row.querySelectorAll('td')].slice(0, 4)
    .map((cell) => cell.textContent));
const buttons = (doc, index = 0) =>
  [...doc.querySelectorAll('#block-rows tr')][index]
    .querySelectorAll('button');

test('the blocked-channel table shows identity, duration and recurrence', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({
    blocklist: ['Spam', 'Legacy', 'Snoozed'],
    blockMeta: {
      Spam: { handles: ['@spam'], until: null, addedAt: NOW - 30 * DAY },
      Snoozed: { handles: [], until: NOW + 10 * DAY, addedAt: NOW - DAY },
    },
    blockStats: {
      Spam: { hits: 42, days: 7, lastSeen: NOW - DAY },
    },
  });

  const result = await renderBlocklist({ now: NOW });

  assert.deepEqual(result.persistent, ['Spam']);
  assert.equal(doc.getElementById('block-table').hidden, false);
  assert.equal(doc.getElementById('blocklist-empty').hidden, true);
  const rows = rowTexts(doc);
  assert.deepEqual(rows.map((row) => row[0]), ['Legacy', 'Snoozed', 'Spam']);
  assert.equal(rows[0][1], 'by name');
  assert.equal(rows[0][2], 'permanent');
  assert.match(rows[1][2], /^until /);
  assert.equal(rows[2][1], '@spam');
  assert.match(rows[2][3], /42 videos hidden on 7 days.*keeps coming back/);
  assert.match(
    doc.getElementById('block-persistent').textContent,
    /YouTube keeps recommending this blocked channel: Spam\./,
  );
});

test('a channel name is rendered as text in the table', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({ blocklist: ['<img src=x onerror=alert(1)>'] });

  await renderBlocklist({ now: NOW });

  assert.equal(doc.querySelectorAll('#block-rows img').length, 0);
  assert.equal(rowTexts(doc)[0][0], '<img src=x onerror=alert(1)>');
});

test('the "tell YouTube" action exists only after opt-in and toggles the queue', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({ blocklist: ['Spam'] });

  await renderBlocklist({ now: NOW });
  assert.deepEqual(
    [...buttons(doc)].map((button) => button.textContent),
    ['Unblock', '30 days only'],
  );

  await chrome.storage.local.set({
    config: { ...DEFAULT_CONFIG, feedback: { enabled: true, weeklyLimit: 3 } },
  });
  await renderBlocklist({ now: NOW });
  assert.equal(buttons(doc)[2].textContent, 'Tell YouTube next time');

  buttons(doc)[2].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(mock.areas.local.feedbackQueue, ['Spam']);
  assert.equal(buttons(doc)[2].textContent, 'Do not tell YouTube');
});

test('snooze, make permanent and unblock work from the table', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({
    blocklist: ['Spam'],
    feedbackQueue: ['Spam'],
  });
  await renderBlocklist({ now: NOW });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  buttons(doc)[1].click();
  await settle();
  assert.ok(mock.areas.local.blockMeta.Spam.until > Date.now());
  assert.equal(buttons(doc)[1].textContent, 'Make permanent');

  buttons(doc)[1].click();
  await settle();
  assert.equal(mock.areas.local.blockMeta.Spam.until, null);

  buttons(doc)[0].click();
  await settle();
  assert.deepEqual(mock.areas.local.blocklist, []);
  assert.deepEqual(mock.areas.local.feedbackQueue, []);
  assert.equal(doc.getElementById('blocklist-empty').hidden, false);
});

test('blocks not seen for 180 days are listed and can be removed together', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({
    blocklist: ['Ancient', 'Recent', 'Active'],
    blockMeta: {
      Ancient: { handles: [], until: null, addedAt: NOW - 300 * DAY },
      Recent: { handles: [], until: null, addedAt: NOW - 10 * DAY },
      Active: { handles: [], until: null, addedAt: NOW - 300 * DAY },
    },
    blockStats: { Active: { hits: 3, days: 2, lastSeen: NOW - 5 * DAY } },
  });

  const { unseen } = await renderBlocklist({ now: NOW });
  assert.deepEqual(unseen, ['Ancient']);
  assert.equal(doc.getElementById('block-prune').hidden, false);
  assert.match(doc.getElementById('block-unseen').textContent, /1 blocked channel has not shown up/);

  assert.deepEqual(await pruneUnseenBlocks({ now: NOW }), ['Ancient']);
  assert.deepEqual(mock.areas.local.blocklist, ['Recent', 'Active']);
  assert.equal(doc.getElementById('block-prune').hidden, true);
});

test('the feedback section shows the budget and the log of what was sent', async (t) => {
  const doc = page(t);

  await renderFeedback({ now: NOW });
  assert.equal(
    doc.getElementById('feedback-status').textContent,
    'Off. Nothing is sent to YouTube.',
  );
  assert.equal(doc.getElementById('feedback-ledger-empty').hidden, false);

  await chrome.storage.local.set({
    config: { ...DEFAULT_CONFIG, feedback: { enabled: true, weeklyLimit: 3 } },
    feedbackLedger: [
      { id: 'a', at: NOW - 20 * DAY, action: 'notInterested', videoId: 'video000001', channelName: 'Old' },
      { id: 'b', at: NOW - DAY, action: 'dontRecommendChannel', videoId: '', channelName: '<b>Spam</b>' },
    ],
  });
  const { budget, entries } = await renderFeedback({ now: NOW });

  assert.deepEqual(budget, { used: 1, limit: 3, remaining: 2 });
  assert.equal(entries, 2);
  assert.equal(
    doc.getElementById('feedback-status').textContent,
    'Used this week: 1 of 3.',
  );
  const items = [...doc.querySelectorAll('#feedback-ledger li')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Don't recommend channel - <b>Spam<\/b>$/);
  assert.match(items[1].textContent, /Not interested - Old - video video000001$/);
  assert.equal(doc.querySelectorAll('#feedback-ledger b').length, 0);
});

test('the hidden-video count is shown', async (t) => {
  const doc = page(t);
  await chrome.storage.local.set({ hiddenVideos: ['video000001'] });

  assert.equal(await renderHidden(), 1);
  assert.equal(
    doc.getElementById('hidden-count').textContent,
    '1 video hidden by hand. ',
  );
});

test('the options page has the feedback opt-in off and documents the limit', () => {
  const doc = new JSDOM(markup).window.document;

  assert.equal(doc.getElementById('feedback-enabled').checked, false);
  assert.equal(doc.getElementById('feedback-limit').max, '20');
  assert.match(doc.body.textContent, /Off by default\. With this on/);
  assert.doesNotMatch(doc.body.textContent, /\p{Extended_Pictographic}/u);
});
