// Everything the content script may ask of the background worker.
//
// The content script runs inside the YouTube renderer process and is treated
// as untrusted: it has no direct storage access, every request is validated
// here, and all it can change is filter data (never settings or sync).
import { loadConfig } from '../storage/config.js';
import {
  addBlocked,
  loadBlockMeta,
  loadBlocklist,
  pinBlockHandle,
  pruneExpiredBlocks,
  removeBlocked,
  snoozeBlocked,
} from '../storage/blocklist.js';
import { addHidden, loadHidden, removeHidden } from '../storage/hidden.js';
import { addWatched, loadWatched } from '../storage/watched.js';
import { loadOverrides } from '../storage/overrides.js';
import {
  addSubNames,
  loadManualSubs,
  loadSubHandles,
  loadSubs,
  loadSubsMeta,
  removeSubNames,
  saveSubs,
} from '../storage/subs.js';
import {
  FEEDBACK_ACTIONS,
  loadFeedbackQueue,
  releaseFeedback,
  reserveFeedback,
  setFeedbackQueued,
} from '../storage/feedback.js';
import { pruneBlockStats, recordBlockHits } from '../storage/block-stats.js';
import { cleanName, cleanNames, isVideoId } from '../storage/schema.js';
import { normalizeChannelKey } from '../channel-name.js';

export const SUBS_REFRESH_ATTEMPTED_KEY = 'subsRefreshAttemptedAt';
export const YOUTUBE_TAB_PATTERN = 'https://www.youtube.com/*';

// A change to any of these keys changes what the content script must show.
export const CONTENT_STATE_KEYS = Object.freeze([
  'config',
  'channelOverrides',
  'blocklist',
  'blockMeta',
  'hiddenVideos',
  'subs',
  'manualSubs',
  'watched',
  'feedbackQueue',
]);

// A subscribe click concerns one channel; nothing legitimate sends more.
const MAX_CAPTURED_SUBS = 20;
const MAX_STATS_CHANNELS = 200;

function cleanHandles(handles, names) {
  const output = {};
  if (handles === null || typeof handles !== 'object' || Array.isArray(handles)) {
    return output;
  }
  for (const name of names) {
    if (!Object.hasOwn(handles, name)) continue;
    const handle = normalizeChannelKey(handles[name]);
    if (handle) output[name] = handle;
  }
  return output;
}

function cleanHits(hits) {
  const output = {};
  if (hits === null || typeof hits !== 'object' || Array.isArray(hits)) {
    return output;
  }
  for (const [rawName, count] of Object.entries(hits)) {
    const name = cleanName(rawName);
    if (!name || !Number.isSafeInteger(count) || count <= 0) continue;
    output[name] = count;
    if (Object.keys(output).length >= MAX_STATS_CHANNELS) break;
  }
  return output;
}

export async function readContentState() {
  const [
    config,
    subs,
    subsMeta,
    subHandles,
    manualSubs,
    blocklist,
    blockMeta,
    hidden,
    watched,
    overrides,
    feedbackQueue,
  ] = await Promise.all([
    loadConfig(),
    loadSubs(),
    loadSubsMeta(),
    loadSubHandles(),
    loadManualSubs(),
    loadBlocklist(),
    loadBlockMeta(),
    loadHidden(),
    loadWatched(),
    loadOverrides(),
    loadFeedbackQueue(),
  ]);
  return {
    config,
    subs: subs === null ? null : [...subs],
    subsStale: subsMeta === null || subsMeta.stale === true,
    subHandles: Object.fromEntries(subHandles),
    manualSubs: [...manualSubs],
    blocklist: [...blocklist],
    blockMeta: Object.fromEntries(blockMeta),
    hiddenVideos: [...hidden],
    watched: [...watched],
    overrides: Object.fromEntries(overrides),
    // Only channels that are still blocked can be waiting for feedback.
    feedbackQueue: feedbackQueue.filter((name) => blocklist.has(name)),
  };
}

const defaultStore = {
  readState: readContentState,
  loadConfig,
  loadBlocklist,
  addWatched,
  addHidden,
  removeHidden,
  addBlocked,
  removeBlocked,
  snoozeBlocked,
  pinBlockHandle,
  addSubNames,
  removeSubNames,
  saveSubs,
  reserveFeedback,
  releaseFeedback,
  setFeedbackQueued,
  recordBlockHits,
  async getCollectionAttempt() {
    const stored = await chrome.storage.local.get(SUBS_REFRESH_ATTEMPTED_KEY);
    const at = stored[SUBS_REFRESH_ATTEMPTED_KEY];
    return Number.isFinite(at) ? at : null;
  },
  async setCollectionAttempt(at) {
    await chrome.storage.local.set({ [SUBS_REFRESH_ATTEMPTED_KEY]: at });
  },
};

export function createContentApi({
  enqueue,
  store = defaultStore,
  now = Date.now,
  // Resolves once one-time storage migrations are done. Nothing is read
  // before that, or a tab could briefly see default settings.
  ready = Promise.resolve(),
} = {}) {
  if (typeof enqueue !== 'function') {
    throw new TypeError('enqueue must be a function');
  }

  const write = (task) => enqueue(task);

  const operations = {
    'state-get': () => store.readState(),

    'watched-add': async ({ videoId }) => {
      if (!isVideoId(videoId)) return false;
      await write(() => store.addWatched(videoId));
      return true;
    },

    'hide-add': async ({ videoId }) => {
      if (!isVideoId(videoId)) return false;
      await write(() => store.addHidden(videoId));
      return true;
    },

    'hide-remove': async ({ videoId }) => {
      if (!isVideoId(videoId)) return false;
      await write(() => store.removeHidden(videoId));
      return true;
    },

    'block-add': async ({ channelName, handle }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      await write(() => store.addBlocked(name, {
        handle: normalizeChannelKey(handle),
        now: now(),
      }));
      return true;
    },

    // Always the fixed snooze length and the background clock: the page
    // cannot ask for a block that ends in a hundred years, or yesterday.
    'block-snooze': async ({ channelName }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      return (await write(() => store.snoozeBlocked(name, { now: now() })))
        === true;
    },

    'block-pin': async ({ channelName, handle }) => {
      const name = cleanName(channelName);
      const key = normalizeChannelKey(handle);
      if (!name || !key) return false;
      return (await write(() => store.pinBlockHandle(name, key))) === true;
    },

    'block-remove': async ({ channelName }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      await write(() => store.removeBlocked(name));
      return true;
    },

    'subs-add': async ({ names, handles }) => {
      const cleaned = cleanNames(names, MAX_CAPTURED_SUBS);
      if (cleaned.length === 0) return false;
      return (await write(() => store.addSubNames(
        cleaned,
        cleanHandles(handles, cleaned),
      ))) === true;
    },

    'subs-remove': async ({ names }) => {
      const cleaned = cleanNames(names, MAX_CAPTURED_SUBS);
      if (cleaned.length === 0) return false;
      return (await write(() => store.removeSubNames(cleaned))) === true;
    },

    'subs-attempt-get': () => store.getCollectionAttempt(),

    // The time is taken here, not from the message: a forged far-future
    // value would otherwise throttle passive collection forever.
    'subs-attempt-set': async () => {
      await write(() => store.setCollectionAttempt(now()));
      return true;
    },

    'subs-save': async ({ names, handles }) => {
      const cleaned = cleanNames(names);
      if (cleaned.length === 0) return false;
      await write(() => store.saveSubs(cleaned, cleanHandles(handles, cleaned)));
      return true;
    },

    // The budget is decided here, from the stored settings and the stored
    // log, never from what the page claims.
    'feedback-reserve': ({ action, videoId, channelName }) => write(async () => {
      const config = await store.loadConfig();
      if (config.feedback?.enabled !== true) {
        return { ok: false, reason: 'disabled' };
      }
      if (!FEEDBACK_ACTIONS.includes(action)) {
        return { ok: false, reason: 'unknown-action' };
      }
      if (
        action === 'dontRecommendChannel'
        && config.blocklistRule?.sendNativeFeedback !== true
      ) {
        return { ok: false, reason: 'disabled' };
      }
      return store.reserveFeedback({
        action,
        videoId: isVideoId(videoId) ? videoId : '',
        channelName: cleanName(channelName),
        limit: config.feedback.weeklyLimit,
        now: now(),
      });
    }),

    'feedback-release': async ({ id }) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
        return false;
      }
      return (await write(() => store.releaseFeedback(id))) === true;
    },

    'feedback-dequeue': async ({ channelName }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      await write(() => store.setFeedbackQueued(name, false));
      return true;
    },

    'block-stats': async ({ hits }) => {
      const cleaned = cleanHits(hits);
      if (Object.keys(cleaned).length === 0) return false;
      return (await write(async () => store.recordBlockHits(cleaned, {
        blocked: await store.loadBlocklist(),
        now: now(),
      }))) === true;
    },
  };

  function handleContentMessage(message, _sender, sendResponse) {
    const type = message?.type;
    if (typeof type !== 'string' || !Object.hasOwn(operations, type)) {
      return undefined;
    }
    void Promise.resolve(ready)
      .catch(() => {})
      .then(() => operations[type](message))
      .then(
        (result) => sendResponse({ ok: true, result }),
        () => sendResponse({ ok: false }),
      );
    return true;
  }

  handleContentMessage.types = Object.freeze(Object.keys(operations));
  return handleContentMessage;
}

// Pushes a fresh state snapshot to every YouTube tab after a storage change.
export function createStateBroadcaster({
  tabs = chrome.tabs,
  readState = readContentState,
  delayMs = 50,
  setTimeoutFn = setTimeout,
} = {}) {
  let timer = null;

  async function broadcast() {
    let state;
    let youtubeTabs;
    try {
      [state, youtubeTabs] = await Promise.all([
        readState(),
        tabs.query({ url: YOUTUBE_TAB_PATTERN }),
      ]);
    } catch {
      return 0;
    }
    let sent = 0;
    await Promise.all(youtubeTabs.map(async (tab) => {
      if (!Number.isInteger(tab?.id)) return;
      try {
        await tabs.sendMessage(tab.id, { type: 'state', state });
        sent += 1;
      } catch {
        // A tab without a live content script is not an error.
      }
    }));
    return sent;
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return false;
    if (!CONTENT_STATE_KEYS.some((key) => changes[key])) return false;
    if (timer !== null) return true;
    timer = setTimeoutFn(() => {
      timer = null;
      void broadcast();
    }, delayMs);
    return true;
  }

  return { broadcast, onStorageChanged };
}

// Daily housekeeping: end snoozes that ran out and drop statistics for
// channels that are no longer blocked.
export async function runBlockMaintenance({ now = Date.now() } = {}) {
  const expired = await pruneExpiredBlocks(now);
  await pruneBlockStats(await loadBlocklist());
  return expired;
}

// Content scripts can reach chrome.storage unless the extension says
// otherwise. Nothing in the content script needs it any more.
export async function lockStorageToTrustedContexts({
  storage = chrome.storage,
} = {}) {
  let locked = 0;
  for (const area of [storage.local, storage.sync]) {
    try {
      if (typeof area?.setAccessLevel !== 'function') continue;
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      locked += 1;
    } catch {
      // Older browsers: the content script still never touches storage.
    }
  }
  return locked;
}
