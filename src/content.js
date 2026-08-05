import { detectLocale } from './locale/detect.js';
import { decide } from './rules/decide.js';
import { readTile, isOutermostTile, TILE_SELECTOR } from './dom/tile-adapter.js';
import { createApplier } from './dom/applier.js';
import { injectStyles } from './dom/styles.js';
import { collapseEmptySections } from './dom/empty-sections.js';
import {
  attachBlockButtons,
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
} from './dom/block-button.js';
import { createNativeUndoWatcher } from './dom/native-undo.js';
import { createStarvationNudge } from './dom/starvation.js';
import { loadConfig, onConfigChange } from './storage/config.js';
import { loadWatched, addWatched } from './storage/watched.js';
import { loadBlocklist, addBlocked } from './storage/blocklist.js';
import { loadOverrides } from './storage/overrides.js';
import {
  addSubNames,
  loadSubs,
  loadSubsMeta,
  loadManualSubs,
  removeSubNames,
  unionSubs,
} from './storage/subs.js';
import { createSubscribeCapture } from './subs-capture.js';
import {
  collectSubscriptions,
  requestPassiveSubscriptionCollection,
  requestSubscriptionCollection,
} from './subs-refresh.js';
import { DEFAULT_CONFIG } from './rules/defaults.js';

export const SUBS_COLLECT_HASH = '#ytt-collect';
export const SUBS_COLLECTION_RESULT_MESSAGE = 'subs-collection-result';

let config = DEFAULT_CONFIG;
let state = {
  subs: null,
  subsStale: false,
  blocklist: new Set(),
  watched: new Set(),
  overrides: new Map(),
  locale: null,
};
let nudge;
let filtering;
let passiveSubscriptionCollection = null;

export function isSupportedRoute(pathname) {
  return pathname === '/' || pathname === '/watch';
}

export function createDomHealthCanary() {
  let degradedScanStreak = 0;
  let status = 'ok';

  function observe({
    totalMatchedTiles = 0,
    nullChannelNameTiles = 0,
  } = {}) {
    const degradedScan = totalMatchedTiles >= 8
      && nullChannelNameTiles / totalMatchedTiles > 0.75;
    degradedScanStreak = degradedScan ? degradedScanStreak + 1 : 0;
    status = degradedScanStreak >= 5 ? 'degraded' : 'ok';
    return status;
  }

  function reset() {
    degradedScanStreak = 0;
    status = 'ok';
    return status;
  }

  return {
    observe,
    reset,
    get status() {
      return status;
    },
  };
}

async function refreshState() {
  const [fetchedSubs, subsMeta, manualSubs, blocklist, watched, overrides] =
    await Promise.all([
      loadSubs(),
      loadSubsMeta(),
      loadManualSubs(),
      loadBlocklist(),
      loadWatched(),
      loadOverrides(),
    ]);
  state = {
    subs: unionSubs(fetchedSubs, manualSubs),
    subsStale: subsMeta === null || subsMeta.stale === true,
    blocklist,
    watched,
    overrides,
    locale: detectLocale(document),
  };
  return fetchedSubs;
}

export function hasStateStorageChange(changes, area) {
  if (area === 'sync') return Boolean(changes.channelOverrides);
  if (area !== 'local') return false;
  return Boolean(
    changes.blocklist ||
    changes.subs ||
    changes.manualSubs ||
    changes.watched,
  );
}

// Record every video the user actually opens. YouTube's resume-playback
// overlay is not a complete history, especially for old, completed videos.
function recordCurrentVideo() {
  const match = /[?&]v=([\w-]{5,})/.exec(location.search);
  if (!match) return;
  addWatched(match[1])
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

function removeContentArtifacts(doc = document) {
  for (const button of doc.querySelectorAll(`.${BLOCK_BUTTON_CLASS}`)) {
    button.remove();
  }
  for (const button of doc.querySelectorAll(
    `.${NOT_INTERESTED_BUTTON_CLASS}`,
  )) {
    button.remove();
  }
  for (const host of doc.querySelectorAll(`.${BLOCK_HOST_CLASS}`)) {
    host.classList.remove(BLOCK_HOST_CLASS);
  }
  doc.getElementById('ytt-styles')?.remove();
}

export function createFilteringLifecycle({
  documentObject,
  nudgeObject,
  getConfig,
  getState,
  getPathname,
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  addBlockedChannel = addBlocked,
  nativeUndoWatcher = createNativeUndoWatcher({ doc: documentObject }),
} = {}) {
  const root = documentObject.documentElement;
  let active = false;
  let initialized = false;
  let currentPathname = null;
  let applier;
  const domHealthCanary = createDomHealthCanary();

  function sendCounts(counts) {
    try {
      Promise.resolve(sendMessage({
        type: 'counts',
        ...counts,
        enabled: getConfig().enabled,
        subsStale: getState().subsStale === true,
        domHealth: domHealthCanary.status,
      })).catch(() => {});
    } catch {
      // Badge reporting must never affect filtering.
    }
  }

  function reportCounts(counts) {
    if (active) domHealthCanary.observe(counts);
    const reportedCounts = active
      ? counts
      : { hidden: 0, visible: 0 };
    nudgeObject.onCounts(reportedCounts);

    if (!active) {
      sendCounts(reportedCounts);
      return;
    }

    collapseEmptySections({ root, doc: documentObject });
    sendCounts(reportedCounts);

    attachBlockButtons({
      root,
      tileSelector: TILE_SELECTOR,
      readTile,
      doc: documentObject,
      shouldOffer: (channelName) => {
        const { subs } = getState();
        return subs === null || !subs.has(channelName.trim());
      },
      onBlock: async (channelName) => {
        await addBlockedChannel(channelName);
        getState().blocklist.add(channelName);
        scan();
      },
    });
  }

  applier = createApplier({
    root,
    decide,
    readTile,
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig,
    getState,
    onCounts: reportCounts,
  });

  function sync() {
    const pathname = getPathname();
    const next = getConfig().enabled && isSupportedRoute(pathname);
    if (initialized && pathname !== currentPathname) {
      domHealthCanary.reset();
    }
    currentPathname = pathname;
    if (initialized && next === active) {
      scan();
      return active;
    }

    initialized = true;
    active = next;
    domHealthCanary.reset();
    if (active) {
      injectStyles(documentObject);
      nativeUndoWatcher.start();
      applier.start();
    } else {
      nativeUndoWatcher.stop();
      applier.stop();
      removeContentArtifacts(documentObject);
      reportCounts({ hidden: 0, visible: 0 });
    }
    return active;
  }

  function scan() {
    if (active) {
      applier.scan();
    } else {
      reportCounts({ hidden: 0, visible: 0 });
    }
  }

  function stop() {
    initialized = true;
    active = false;
    domHealthCanary.reset();
    nativeUndoWatcher.stop();
    applier.stop();
    removeContentArtifacts(documentObject);
    reportCounts({ hidden: 0, visible: 0 });
  }

  function resetDomHealth() {
    domHealthCanary.reset();
  }

  return {
    get active() {
      return active;
    },
    reportCounts,
    resetDomHealth,
    scan,
    stop,
    sync,
  };
}

export function subscriptionCollectionResponse(result) {
  if (
    result?.complete === true &&
    Array.isArray(result.names) &&
    result.names.length > 0
  ) {
    return { count: result.names.length };
  }

  const response = {
    reason:
      typeof result?.reason === 'string'
        ? result.reason
        : 'scrape-incomplete',
  };
  if (result?.diagnostics && typeof result.diagnostics === 'object') {
    response.diagnostics = result.diagnostics;
  }
  return response;
}

export function subscriptionCollectionResultMessage(result) {
  const response = subscriptionCollectionResponse(result);
  return {
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: result?.complete === true,
    count: Array.isArray(result?.names) ? result.names.length : 0,
    ...(response.reason ? { reason: response.reason } : {}),
    ...(result?.diagnostics && typeof result.diagnostics === 'object'
      ? { diagnostics: result.diagnostics }
      : {}),
  };
}

export async function startSubscriptionCollectionMode({
  pathname,
  collectMarker,
  cachedSubs,
  subsStale = false,
  documentObject,
  windowObject,
  requestCollection = requestSubscriptionCollection,
  collect = collectSubscriptions,
  requestPassive = requestPassiveSubscriptionCollection,
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  if (pathname !== '/feed/channels') return null;

  if (collectMarker) {
    if (windowObject?.top !== windowObject) return null;
    const result = await requestCollection({
      force: true,
      collect: () => collect({ documentObject, windowObject }),
    });
    await sendMessage(subscriptionCollectionResultMessage(result));
    return { mode: 'active', result };
  }

  if (cachedSubs !== null && !subsStale) return null;
  const controller = await requestPassive({ documentObject });
  return controller === null ? null : { mode: 'passive', controller };
}

export function stopPassiveCollectionOnNavigation(controller, pathname) {
  if (pathname === '/feed/channels') return controller;
  controller?.stop();
  return null;
}

async function main({
  collectMarker = false,
  initialPathname = location.pathname,
} = {}) {
  state.locale = detectLocale(document);
  nudge = createStarvationNudge({
    scrollBy: () => window.scrollBy({
      top: window.innerHeight,
      behavior: 'instant',
    }),
  });

  filtering = createFilteringLifecycle({
    documentObject: document,
    nudgeObject: nudge,
    getConfig: () => config,
    getState: () => state,
    getPathname: () => location.pathname,
  });

  config = await loadConfig();
  const capture = createSubscribeCapture({
    documentObject: document,
    getPathname: () => location.pathname,
    getEnabled: () => config.enabled,
    addNames: addSubNames,
    removeNames: removeSubNames,
    getCachedNames: () => state.subs,
  });
  capture.start();
  const fetchedSubs = await refreshState();

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
      pathname: location.pathname,
      collectMarker: false,
      cachedSubs: fetchedSubs,
      subsStale: state.subsStale,
      documentObject: document,
      windowObject: window,
    })
      .then((started) => {
        if (started?.mode !== 'passive') return;
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
  window.addEventListener('yt-navigate-finish', () => {
    onNavigate();
    capture.reconcile();
    updatePassiveCollection();
  });

  onConfigChange((next) => {
    config = next;
    filtering.sync();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (!hasStateStorageChange(changes, area)) return;
    await refreshState();
    filtering.scan();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'rescan') filtering.scan();
  });

  if (collectMarker && initialPathname === '/feed/channels') {
    void startSubscriptionCollectionMode({
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
      filtering?.stop();
      passiveSubscriptionCollection?.stop();
      removeContentArtifacts();
      console.error('[youtube-tuner] setup failed, filtering disabled', error);
    });
  });
}
