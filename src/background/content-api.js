// Everything the content script may ask of the background worker.
//
// The content script runs inside the YouTube renderer process and is treated
// as untrusted: it has no direct storage access, every request is validated
// here, and all it can change is filter data (never settings or sync).
import { loadConfig } from '../storage/config.js';
import {
  addBlocked,
  loadBlocklist,
  removeBlocked,
} from '../storage/blocklist.js';
import { addWatched, loadWatched } from '../storage/watched.js';
import { loadOverrides } from '../storage/overrides.js';
import {
  addSubNames,
  loadManualSubs,
  loadSubs,
  loadSubsMeta,
  removeSubNames,
  saveSubs,
} from '../storage/subs.js';
import { cleanName, cleanNames, isVideoId } from '../storage/schema.js';

export const SUBS_REFRESH_ATTEMPTED_KEY = 'subsRefreshAttemptedAt';
export const YOUTUBE_TAB_PATTERN = 'https://www.youtube.com/*';

// A change to any of these keys changes what the content script must show.
export const CONTENT_STATE_KEYS = Object.freeze([
  'config',
  'channelOverrides',
  'blocklist',
  'subs',
  'manualSubs',
  'watched',
]);

// A subscribe click concerns one channel; nothing legitimate sends more.
const MAX_CAPTURED_SUBS = 20;

export async function readContentState() {
  const [config, subs, subsMeta, manualSubs, blocklist, watched, overrides] =
    await Promise.all([
      loadConfig(),
      loadSubs(),
      loadSubsMeta(),
      loadManualSubs(),
      loadBlocklist(),
      loadWatched(),
      loadOverrides(),
    ]);
  return {
    config,
    subs: subs === null ? null : [...subs],
    subsStale: subsMeta === null || subsMeta.stale === true,
    manualSubs: [...manualSubs],
    blocklist: [...blocklist],
    watched: [...watched],
    overrides: Object.fromEntries(overrides),
  };
}

const defaultStore = {
  readState: readContentState,
  addWatched,
  addBlocked,
  removeBlocked,
  addSubNames,
  removeSubNames,
  saveSubs,
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

    'block-add': async ({ channelName }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      await write(() => store.addBlocked(name));
      return true;
    },

    'block-remove': async ({ channelName }) => {
      const name = cleanName(channelName);
      if (!name) return false;
      await write(() => store.removeBlocked(name));
      return true;
    },

    'subs-add': async ({ names }) => {
      const cleaned = cleanNames(names, MAX_CAPTURED_SUBS);
      if (cleaned.length === 0) return false;
      return (await write(() => store.addSubNames(cleaned))) === true;
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

    'subs-save': async ({ names }) => {
      const cleaned = cleanNames(names);
      if (cleaned.length === 0) return false;
      await write(() => store.saveSubs(cleaned));
      return true;
    },
  };

  function handleContentMessage(message, _sender, sendResponse) {
    const type = message?.type;
    if (typeof type !== 'string' || !Object.hasOwn(operations, type)) {
      return undefined;
    }
    void Promise.resolve()
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
