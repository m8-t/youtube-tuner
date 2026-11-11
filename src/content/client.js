// The content script's only way to read or change extension data. It has no
// chrome.storage access; the background worker validates every request.
import { mergeConfig } from '../storage/config.js';
import { normalizeOverrides } from '../storage/overrides.js';
import { normalizeBlockMeta } from '../storage/blocklist.js';
import { normalizeSubHandles, unionSubs } from '../storage/subs.js';

export function createClient({
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  async function call(type, payload = {}) {
    const response = await sendMessage({ ...payload, type });
    if (response?.ok !== true) {
      throw new Error(`[youtube-tuner] background rejected ${type}`);
    }
    return response.result;
  }

  return {
    getState: () => call('state-get'),
    addWatched: (videoId) => call('watched-add', { videoId }),
    hideVideo: (videoId) => call('hide-add', { videoId }),
    unhideVideo: (videoId) => call('hide-remove', { videoId }),
    block: (channelName, handle = null) =>
      call('block-add', { channelName, handle }),
    unblock: (channelName) => call('block-remove', { channelName }),
    snoozeBlock: (channelName) => call('block-snooze', { channelName }),
    pinBlock: (channelName, handle) =>
      call('block-pin', { channelName, handle }),
    reportBlockStats: (hits) => call('block-stats', { hits }),
    reserveFeedback: ({ action, videoId, channelName }) =>
      call('feedback-reserve', { action, videoId, channelName }),
    releaseFeedback: (id) => call('feedback-release', { id }),
    dequeueFeedback: (channelName) =>
      call('feedback-dequeue', { channelName }),
    addSubs: (names, handles = {}) =>
      call('subs-add', { names: [...names], handles }),
    removeSubs: (names) => call('subs-remove', { names: [...names] }),
    getCollectionAttempt: () => call('subs-attempt-get'),
    markCollectionAttempt: () => call('subs-attempt-set'),
    saveSubs: (names, handles = {}) =>
      call('subs-save', { names: [...names], handles }),
  };
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : [];
}

// Turns the serializable snapshot from the background into the lookup
// structures the decision function uses.
export function hydrateState(raw, locale) {
  const fetchedSubs = Array.isArray(raw?.subs) ? stringList(raw.subs) : null;
  const blocklist = new Set(stringList(raw?.blocklist));
  const blockMeta = new Map(
    [...normalizeBlockMeta(raw?.blockMeta)].filter(([name]) => blocklist.has(name)),
  );
  const blockedHandles = new Map();
  for (const [name, entry] of blockMeta) {
    for (const handle of entry.handles) blockedHandles.set(handle, name);
  }
  const subHandles = new Map(Object.entries(
    normalizeSubHandles(raw?.subHandles, new Set(fetchedSubs ?? [])),
  ));
  return {
    config: mergeConfig(raw?.config),
    fetchedSubs,
    state: {
      subs: unionSubs(fetchedSubs, stringList(raw?.manualSubs)),
      subsStale: raw?.subsStale !== false,
      subHandles,
      subHandleSet: new Set(subHandles.values()),
      blocklist,
      blockMeta,
      blockedHandles,
      hidden: new Set(stringList(raw?.hiddenVideos)),
      feedbackQueue: new Set(stringList(raw?.feedbackQueue)),
      watched: new Set(stringList(raw?.watched)),
      overrides: normalizeOverrides(raw?.overrides),
      locale,
    },
  };
}
