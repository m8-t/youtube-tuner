// The content script's only way to read or change extension data. It has no
// chrome.storage access; the background worker validates every request.
import { mergeConfig } from '../storage/config.js';
import { normalizeOverrides } from '../storage/overrides.js';
import { unionSubs } from '../storage/subs.js';

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
    block: (channelName) => call('block-add', { channelName }),
    unblock: (channelName) => call('block-remove', { channelName }),
    addSubs: (names) => call('subs-add', { names: [...names] }),
    removeSubs: (names) => call('subs-remove', { names: [...names] }),
    getCollectionAttempt: () => call('subs-attempt-get'),
    markCollectionAttempt: () => call('subs-attempt-set'),
    saveSubs: (names) => call('subs-save', { names: [...names] }),
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
  return {
    config: mergeConfig(raw?.config),
    fetchedSubs,
    state: {
      subs: unionSubs(fetchedSubs, stringList(raw?.manualSubs)),
      subsStale: raw?.subsStale !== false,
      blocklist: new Set(stringList(raw?.blocklist)),
      watched: new Set(stringList(raw?.watched)),
      overrides: normalizeOverrides(raw?.overrides),
      locale,
    },
  };
}
