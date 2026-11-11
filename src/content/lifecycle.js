// Starts and stops filtering as the route and the kill switch change, and
// wires the scan results to the badge, the tile controls and the toast.
import { decide } from '../rules/decide.js';
import { readTile, isOutermostTile, TILE_SELECTOR } from '../dom/tile-adapter.js';
import { createApplier } from '../dom/applier.js';
import { injectStyles } from '../dom/styles.js';
import { collapseEmptySections } from '../dom/empty-sections.js';
import { attachBlockButtons } from '../dom/block-button.js';
import { removeBlockToast } from '../dom/block-toast.js';
import { createNativeUndoWatcher } from '../dom/native-undo.js';
import { isSubscribed } from '../rules/identity.js';
import { createDomHealthCanary } from './canary.js';
import { createTileActions } from './actions.js';

const SURFACES = {
  '/': 'home',
  '/watch': 'watch',
  '/feed/subscriptions': 'subscriptions',
  '/results': 'search',
};

// The kind of page a path is, or null where the extension does not filter.
export function surfaceFor(pathname) {
  return Object.hasOwn(SURFACES, pathname) ? SURFACES[pathname] : null;
}

export function isSupportedRoute(pathname) {
  return surfaceFor(pathname) !== null;
}

// Requests the lifecycle may make. Each one defaults to doing nothing, so a
// partial client (tests, a degraded background) cannot break filtering.
const NO_CLIENT = Object.freeze({
  block: async () => {},
  unblock: async () => {},
  snoozeBlock: async () => {},
  pinBlock: async () => {},
  hideVideo: async () => {},
  unhideVideo: async () => {},
  reportBlockStats: async () => {},
  reserveFeedback: async () => ({ ok: false, reason: 'disabled' }),
  releaseFeedback: async () => {},
  dequeueFeedback: async () => {},
});

export function removeContentArtifacts(doc = document) {
  removeBlockToast(doc);
  for (const button of doc.querySelectorAll('button[class*="ytt-"]')) {
    if ([...button.classList].some((name) => name.startsWith('ytt-'))) {
      button.remove();
    }
  }
  for (const element of doc.querySelectorAll('[class*="ytt-"]')) {
    for (const className of [...element.classList]) {
      if (className.startsWith('ytt-')) element.classList.remove(className);
    }
  }
  for (const style of doc.querySelectorAll('style[id^="ytt-"]')) {
    style.remove();
  }
}

export function createFilteringLifecycle({
  documentObject,
  nudgeObject,
  getConfig,
  getState,
  getPathname,
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  client = {},
  addBlockedChannel = client.block ?? NO_CLIENT.block,
  removeBlockedChannel = client.unblock ?? NO_CLIENT.unblock,
  nativeUndoWatcher = createNativeUndoWatcher({
    doc: documentObject,
    removeBlockedChannel,
  }),
  runNative,
} = {}) {
  const root = documentObject.documentElement;
  let active = false;
  let initialized = false;
  let currentPathname = null;
  let applier;
  const domHealthCanary = createDomHealthCanary();
  const actions = createTileActions({
    doc: documentObject,
    client: {
      ...NO_CLIENT,
      ...client,
      block: addBlockedChannel,
      unblock: removeBlockedChannel,
    },
    getConfig,
    getState,
    rescan: () => scan(),
    hold: (element) => applier.hold(element),
    release: (element) => applier.release(element),
    ...(runNative ? { runNative } : {}),
  });

  function sendCounts(counts) {
    try {
      Promise.resolve(sendMessage({
        type: 'counts',
        hidden: counts.hidden,
        visible: counts.visible,
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

    sendCounts(reportedCounts);
    // An incremental scan that found nothing new leaves the page as it is.
    if (counts.changed === false) return;

    collapseEmptySections({ root, doc: documentObject });
    const surface = surfaceFor(getPathname());
    attachBlockButtons({
      root,
      tileSelector: TILE_SELECTOR,
      readTile,
      tiles: counts.tiles,
      doc: documentObject,
      offerWatchLater: surface === 'watch',
      // YouTube's menu has "Not interested" on the home feed and the watch
      // page only, and only users who opted in get the control at all.
      offerNativeFeedback: getConfig().feedback?.enabled === true
        && (surface === 'home' || surface === 'watch'),
      // Everything in the subscriptions feed is a subscribed channel.
      shouldOffer: surface === 'subscriptions'
        ? () => false
        : (channelName, tile) => {
          const state = getState();
          return state.subs === null
            || !isSubscribed(tile ?? { channelName }, state);
        },
      onHideVideo: actions.hideVideo,
      onBlock: actions.blockChannel,
      onNativeFeedback: actions.tellYouTube,
    });
    actions.noteBlockedTiles(counts.tiles);
    void actions.processQueue(counts.tiles).catch(() => {});
  }

  // The decision function also needs to know which page it is on, and one
  // clock per scan keeps snooze expiry consistent across tiles.
  function decisionState() {
    return {
      ...getState(),
      surface: surfaceFor(getPathname()),
      now: Date.now(),
    };
  }

  applier = createApplier({
    root,
    decide,
    readTile,
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig,
    getState: decisionState,
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
    actions.stop();
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
