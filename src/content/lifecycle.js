// Starts and stops filtering as the route and the kill switch change, and
// wires the scan results to the badge, the tile controls and the toast.
import { decide } from '../rules/decide.js';
import { readTile, isOutermostTile, TILE_SELECTOR } from '../dom/tile-adapter.js';
import { createApplier } from '../dom/applier.js';
import { injectStyles } from '../dom/styles.js';
import { collapseEmptySections } from '../dom/empty-sections.js';
import { attachBlockButtons } from '../dom/block-button.js';
import { showBlockToast, removeBlockToast } from '../dom/block-toast.js';
import { createNativeUndoWatcher } from '../dom/native-undo.js';
import { createDomHealthCanary } from './canary.js';

export function isSupportedRoute(pathname) {
  return pathname === '/' || pathname === '/watch' || pathname === '/feed/subscriptions';
}

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
  addBlockedChannel = async () => {},
  removeBlockedChannel = async () => {},
  nativeUndoWatcher = createNativeUndoWatcher({
    doc: documentObject,
    removeBlockedChannel,
  }),
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
    attachBlockButtons({
      root,
      tileSelector: TILE_SELECTOR,
      readTile,
      tiles: counts.tiles,
      doc: documentObject,
      offerWatchLater: getPathname() === '/watch',
      dismissAction: getPathname() === '/feed/subscriptions'
        ? 'hide'
        : 'notInterested',
      shouldOffer: getPathname() === '/feed/subscriptions'
        ? () => false
        : (channelName) => {
          const { subs } = getState();
          return subs === null || !subs.has(channelName.trim());
        },
      onBlock: async (channelName) => {
        await addBlockedChannel(channelName);
        getState().blocklist.add(channelName);
        scan();
      },
      sendNativeFeedback: getConfig().blocklistRule?.sendNativeFeedback === true,
      onLocalBlock: (channelName) => {
        showBlockToast({
          doc: documentObject,
          channelName,
          onUndo: async () => {
            try {
              await removeBlockedChannel(channelName);
              getState().blocklist.delete(channelName);
              scan();
            } catch {
              // Undo failures must not surface in the page.
            }
          },
        });
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
