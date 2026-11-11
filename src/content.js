import { detectLocale } from './locale/detect.js';
import { createStarvationNudge } from './dom/starvation.js';
import { createSubscribeCapture } from './subs-capture.js';
import {
  SUBS_REFRESH_ATTEMPTED_KEY,
  requestPassiveSubscriptionCollection,
  requestSubscriptionCollection,
} from './subs-refresh.js';
import { DEFAULT_CONFIG } from './rules/defaults.js';
import { createClient, hydrateState } from './content/client.js';
import { createRuntimeLifeline } from './content/lifeline.js';
import {
  createFilteringLifecycle,
  removeContentArtifacts,
} from './content/lifecycle.js';
import {
  SUBS_COLLECT_HASH,
  SUBS_COLLECTION_RESULT_MESSAGE,
  startSubscriptionCollectionMode,
  stopPassiveCollectionOnNavigation,
} from './content/collection.js';

export {
  LIFELINE_MAX_RECONNECT_DELAY_MS,
  LIFELINE_PORT_NAME,
  LIFELINE_RECONNECT_DELAY_MS,
  createRuntimeLifeline,
} from './content/lifeline.js';
export { createDomHealthCanary } from './content/canary.js';
export {
  createFilteringLifecycle,
  isSupportedRoute,
  removeContentArtifacts,
} from './content/lifecycle.js';
export {
  SUBS_COLLECT_HASH,
  SUBS_COLLECTION_RESULT_MESSAGE,
  startSubscriptionCollectionMode,
  stopPassiveCollectionOnNavigation,
  subscriptionCollectionResponse,
  subscriptionCollectionResultMessage,
} from './content/collection.js';

let config = DEFAULT_CONFIG;
let state = {
  subs: null,
  subsStale: false,
  blocklist: new Set(),
  watched: new Set(),
  overrides: new Map(),
  locale: null,
};
let fetchedSubs = null;
let client;
let nudge;
let filtering;
let passiveSubscriptionCollection = null;
let contentTeardown = null;

function applySnapshot(raw) {
  const hydrated = hydrateState(raw, detectLocale(document));
  config = hydrated.config;
  state = hydrated.state;
  fetchedSubs = hydrated.fetchedSubs;
}

// Record every video the user actually opens. YouTube's resume-playback
// overlay is not a complete history, especially for old, completed videos.
function recordCurrentVideo() {
  const match = /[?&]v=([\w-]{5,})/.exec(location.search);
  if (!match) return;
  client.addWatched(match[1])
    .then(() => {
      state.watched.add(match[1]);
    })
    .catch(() => {});
}

function onNavigate() {
  nudge.reset();
  recordCurrentVideo();
  filtering.resetDomHealth();
  filtering.sync();
}

async function main({
  collectMarker = false,
  initialPathname = location.pathname,
} = {}) {
  // A newly injected copy shares the page DOM with any orphaned copy.
  try { removeContentArtifacts(document); } catch {}

  let capture = null;
  let onNavigation = null;
  let onRuntimeMessage = null;
  let lifeline = null;
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    try { lifeline?.stop(); } catch {}
    try { capture?.stop(); } catch {}
    try { passiveSubscriptionCollection?.stop(); } catch {}
    passiveSubscriptionCollection = null;
    try { filtering?.stop(); } catch {}
    try {
      if (onNavigation) {
        window.removeEventListener('yt-navigate-finish', onNavigation);
      }
    } catch {}
    try {
      if (onRuntimeMessage) {
        chrome.runtime.onMessage.removeListener?.(onRuntimeMessage);
      }
    } catch {}
    try { removeContentArtifacts(document); } catch {}
  };
  contentTeardown = teardown;
  lifeline = createRuntimeLifeline({ onInvalidated: teardown });
  lifeline.start();
  if (tornDown) return;

  state.locale = detectLocale(document);
  nudge = createStarvationNudge({
    isNearBottom: (sy, ih, sh) => sh <= ih || sy + ih >= sh - ih * 0.5,
    scrollBy: () => window.scrollBy({
      top: window.innerHeight,
      behavior: 'instant',
    }),
  });

  client = createClient();
  filtering = createFilteringLifecycle({
    documentObject: document,
    nudgeObject: nudge,
    getConfig: () => config,
    getState: () => state,
    getPathname: () => location.pathname,
    addBlockedChannel: client.block,
    removeBlockedChannel: client.unblock,
  });

  // One request brings settings and filter data; later changes are pushed.
  applySnapshot(await client.getState());
  if (tornDown) return;
  capture = createSubscribeCapture({
    documentObject: document,
    getPathname: () => location.pathname,
    getEnabled: () => config.enabled,
    addNames: client.addSubs,
    removeNames: client.removeSubs,
    getCachedNames: () => state.subs,
  });
  capture.start();

  // The collection throttle and the result live in the background; these
  // adapters give the collection code the storage shape it expects.
  const attemptStorage = {
    async get() {
      return {
        [SUBS_REFRESH_ATTEMPTED_KEY]: await client.getCollectionAttempt(),
      };
    },
    async set() {
      await client.markCollectionAttempt();
    },
  };
  const collectionOptions = {
    requestCollection: (options) => requestSubscriptionCollection({
      ...options,
      storage: attemptStorage,
      save: client.saveSubs,
    }),
    requestPassive: (options) => requestPassiveSubscriptionCollection({
      ...options,
      storage: attemptStorage,
      save: client.saveSubs,
    }),
  };

  filtering.sync();
  recordCurrentVideo();
  capture.reconcile();

  // YouTube is a SPA: it fires yt-navigate-finish instead of reloading.
  let passiveAttempted = false;
  const updatePassiveCollection = () => {
    if (location.pathname !== '/feed/channels') {
      passiveSubscriptionCollection = stopPassiveCollectionOnNavigation(
        passiveSubscriptionCollection,
        location.pathname,
      );
      return;
    }
    if (
      collectMarker ||
      (fetchedSubs !== null && !state.subsStale) ||
      passiveAttempted
    ) return;

    passiveAttempted = true;
    void startSubscriptionCollectionMode({
      ...collectionOptions,
      pathname: location.pathname,
      collectMarker: false,
      cachedSubs: fetchedSubs,
      subsStale: state.subsStale,
      documentObject: document,
      windowObject: window,
    })
      .then((started) => {
        if (started?.mode !== 'passive') return;
        if (tornDown) {
          try { started.controller?.stop(); } catch {}
          return;
        }
        passiveSubscriptionCollection = started.controller;
        passiveSubscriptionCollection = stopPassiveCollectionOnNavigation(
          passiveSubscriptionCollection,
          location.pathname,
        );
      })
      .catch((error) => {
        console.warn(
          '[youtube-tuner] failed to start passive subscription collection',
          error,
        );
      });
  };
  onNavigation = () => {
    if (tornDown) return;
    onNavigate();
    capture.reconcile();
    updatePassiveCollection();
  };
  window.addEventListener('yt-navigate-finish', onNavigation);

  onRuntimeMessage = (message) => {
    if (tornDown) return;
    try {
      if (message?.type === 'rescan') {
        filtering.scan();
      } else if (message?.type === 'state') {
        applySnapshot(message.state);
        filtering.sync();
      }
    } catch {
      // A bad push must not escape into the page.
    }
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  if (collectMarker && initialPathname === '/feed/channels') {
    void startSubscriptionCollectionMode({
      ...collectionOptions,
      pathname: initialPathname,
      collectMarker,
      cachedSubs: fetchedSubs,
      documentObject: document,
      windowObject: window,
    }).catch(async (error) => {
      console.warn('[youtube-tuner] scrape-exception', error);
      await chrome.runtime.sendMessage({
        type: SUBS_COLLECTION_RESULT_MESSAGE,
        complete: false,
        count: 0,
        reason: 'scrape-exception',
        diagnostics: {
          finalNameCount: 0,
          initialNameCount: 0,
          bottomReached: false,
          elapsedMs: 0,
          scrollAttempts: 0,
          continuationPresent: null,
        },
      }).catch(() => {});
    });
  } else {
    updatePassiveCollection();
  }
}

export function startContentScript(windowObject, start = main) {
  if (windowObject.top !== windowObject) return false;
  start();
  return true;
}

if (typeof window !== 'undefined') {
  // Read once before YouTube's SPA router can change or clear the marker.
  const collectMarker = window.location.hash === SUBS_COLLECT_HASH;
  const initialPathname = window.location.pathname;
  startContentScript(window, () => {
    void main({ collectMarker, initialPathname }).catch((error) => {
      // Fail-open: a partial setup must not leave any video hidden.
      try { contentTeardown?.(); } catch {}
      try { filtering?.stop(); } catch {}
      try { passiveSubscriptionCollection?.stop(); } catch {}
      try { removeContentArtifacts(); } catch {}
      try {
        console.error(
          '[youtube-tuner] setup failed, filtering disabled',
          error,
        );
      } catch {}
    });
  });
}
