// Runs the real content script against the real background handlers in one
// process, connected only through the message channel, and prints what
// happened as JSON. It runs in a child process because the content script
// needs window/document globals that must not leak into other tests.
import { JSDOM } from 'jsdom';
import { installChromeMock } from './chrome-mock.js';

const dom = new JSDOM(`<html lang="en"><head></head><body>
  <yt-lockup-view-model id="blocked">
    <a href="/watch?v=video000001"></a>
    <a href="/@blocked" aria-label="Go to channel Blocked Channel"></a>
  </yt-lockup-view-model>
  <yt-lockup-view-model id="namesake">
    <a href="/watch?v=video000003"></a>
    <a href="/@someone-else" aria-label="Go to channel Blocked Channel"></a>
  </yt-lockup-view-model>
  <yt-lockup-view-model id="other">
    <a href="/watch?v=video000002"></a>
    <a aria-label="Go to channel Other Channel"></a>
  </yt-lockup-view-model>
</body></html>`, { url: 'https://www.youtube.com/', pretendToBeVisual: true });

const mock = installChromeMock();
const storageReads = [];
const contentSender = {
  id: mock.chrome.runtime.id,
  url: 'https://www.youtube.com/',
  origin: 'https://www.youtube.com',
  frameId: 0,
  tab: { id: 1 },
};
const sentTypes = [];

function deliver(message, sender) {
  return new Promise((resolve) => {
    let pending = false;
    for (const listener of [...mock.events.message]) {
      if (listener(message, sender, resolve) === true) pending = true;
    }
    if (!pending) resolve(undefined);
  });
}

mock.chrome.runtime.sendMessage = (message) => {
  sentTypes.push(message.type);
  return deliver(message, contentSender);
};
mock.chrome.tabs.query = async () => [{ id: 1 }];
mock.chrome.tabs.sendMessage = async (_tabId, message) => {
  await deliver(message, { id: mock.chrome.runtime.id });
};

await mock.chrome.storage.local.set({
  blocklist: ['Blocked Channel'],
  blockMeta: {
    'Blocked Channel': { handles: ['@blocked'], until: null, addedAt: 1 },
  },
});
await import('../../src/background.js');

// From here on, count every direct storage call: the content script must
// make none.
for (const method of ['get', 'set', 'remove']) {
  const original = mock.chrome.storage.local[method];
  mock.chrome.storage.local[method] = function tracked(...args) {
    storageReads.push(new Error().stack.includes('/src/content') ? 'content' : 'other');
    return original.apply(this, args);
  };
}

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hidden = (id) => document.getElementById(id).classList.contains('ytt-hidden');

await import('../../src/content.js');
await wait(150);
const afterStart = {
  blocked: hidden('blocked'),
  namesake: hidden('namesake'),
  other: hidden('other'),
};
const controls = {
  otherHasBlockButton: document.querySelector('#other .ytt-block') !== null,
  styleInjected: document.getElementById('ytt-styles') !== null,
};

document.querySelector('#other .ytt-block').click();
await wait(300);
const afterBlock = {
  other: hidden('other'),
  stored: (await mock.chrome.storage.local.get('blocklist')).blocklist,
  toast: document.querySelector('.ytt-block-toast')?.textContent ?? null,
};

document.querySelector('.ytt-block-toast button').click();
await wait(300);
const afterUndo = {
  other: hidden('other'),
  stored: (await mock.chrome.storage.local.get('blocklist')).blocklist,
};

// Hiding one video is local: it is stored, and nothing asks YouTube.
document.querySelector('#other .ytt-hide-video').click();
await wait(300);
const afterHide = {
  other: hidden('other'),
  stored: (await mock.chrome.storage.local.get('hiddenVideos')).hiddenVideos,
  feedbackControls: document.querySelectorAll('.ytt-not-interested').length,
};

// A settings change made in the options page reaches the tab as a push.
await mock.chrome.storage.local.set({ config: { enabled: false } });
await wait(300);
const afterDisable = {
  blocked: hidden('blocked'),
  anyControl: document.querySelector('[class*="ytt-"]') !== null,
};

console.log(JSON.stringify({
  afterStart,
  controls,
  afterBlock,
  afterUndo,
  afterHide,
  afterDisable,
  contentStorageCalls: storageReads.filter((who) => who === 'content').length,
  sentTypes: [...new Set(sentTypes)].sort(),
}));
process.exit(0);
