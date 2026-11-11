import { loadConfig, onConfigChange } from './storage/config.js';
import { loadSubsMeta } from './storage/subs.js';
import { createSyncEngine } from './sync/engine.js';
import * as syncKeyStore from './sync/key-store.js';
import { createMigratedPrivateStore } from './sync/private-store.js';
import { ensureStorageLayout } from './storage/migrate.js';
import {
  createContentApi,
  createStateBroadcaster,
  lockStorageToTrustedContexts,
} from './background/content-api.js';
import { createSerialQueue } from './background/serial.js';
import { createWebdavBackend } from './sync/webdav.js';
import {
  UPDATE_CHECK_COMPLETE_MESSAGE,
  checkForUpdate,
  updateAvailable,
} from './update-check.js';

const SUBS_ALARM = 'refresh-subs';
const UPDATE_ALARM = 'check-update';
export const SYNC_PUSH_ALARM = 'sync-push';
export const SYNC_PULL_ALARM = 'sync-pull';
const DAY_MS = 24 * 60 * 60 * 1000;
export const NORMAL_BADGE_COLOR = '#606060';
export const STALE_BADGE_COLOR = '#B36B00';
export const COLLECT_TAB_URL =
  'https://www.youtube.com/feed/channels#ytt-collect';
export const SUBS_COLLECTION_RESULT_MESSAGE = 'subs-collection-result';
export const CANCEL_SUBS_REFRESH_MESSAGE = 'cancel-subs-refresh';
export const POPUP_PATH = 'popup.html';

export async function reinjectContentScripts({
  tabs = chrome.tabs,
  scripting = chrome.scripting,
} = {}) {
  let youtubeTabs;
  try {
    youtubeTabs = await tabs.query({ url: '*://www.youtube.com/*' });
  } catch {
    return 0;
  }

  const injections = youtubeTabs
    .filter((tab) => Number.isInteger(tab?.id))
    .map(async (tab) => {
      try {
        await scripting.executeScript({
          target: { tabId: tab.id },
          files: ['dist/content.js'],
        });
        return true;
      } catch {
        return false;
      }
    });
  const results = await Promise.all(injections);
  return results.filter(Boolean).length;
}

export function handleInstalledReinjection(details) {
  if (details?.reason !== 'install' && details?.reason !== 'update') {
    return undefined;
  }
  return reinjectContentScripts();
}

function warnRefreshFailure(reason, error) {
  if (error === undefined) {
    console.warn(`[youtube-tuner] ${reason}`);
  } else {
    console.warn(`[youtube-tuner] ${reason}`, error);
  }
}

function normalizedCollectionResponse(message) {
  if (
    message?.complete === true &&
    Number.isInteger(message.count) &&
    message.count > 0
  ) {
    return {
      complete: true,
      count: message.count,
      ...(message.diagnostics &&
      typeof message.diagnostics === 'object'
        ? { diagnostics: message.diagnostics }
        : {}),
    };
  }

  return {
    complete: false,
    reason:
      typeof message?.reason === 'string'
        ? message.reason
        : 'scrape-incomplete',
    ...(message?.diagnostics &&
    typeof message.diagnostics === 'object'
      ? { diagnostics: message.diagnostics }
      : {}),
  };
}

export function createSubscriptionTabCoordinator({
  tabs = chrome.tabs,
} = {}) {
  let collectTabId = null;
  let opening = null;
  const responders = new Set();

  async function ensureCollectTab() {
    if (collectTabId !== null) {
      try {
        await tabs.update(collectTabId, { active: true });
        return collectTabId;
      } catch {
        collectTabId = null;
      }
    }

    if (opening === null) {
      opening = tabs.create({
        url: COLLECT_TAB_URL,
        active: true,
      }).then((tab) => {
        if (!Number.isInteger(tab?.id)) {
          throw new Error('collect tab has no id');
        }
        collectTabId = tab.id;
        return collectTabId;
      }).finally(() => {
        opening = null;
      });
    }
    return opening;
  }

  function respondAll(response) {
    const pending = [...responders];
    responders.clear();
    for (const respond of pending) {
      try {
        respond(response);
      } catch {}
    }
  }

  async function finish(response, { closeTab = true } = {}) {
    const tabId = collectTabId;
    collectTabId = null;
    respondAll(response);
    if (closeTab && tabId !== null) {
      await tabs.remove(tabId).catch((error) => {
        warnRefreshFailure('collect-tab-close-failed', error);
      });
    }
  }

  async function begin(sendResponse) {
    responders.add(sendResponse);
    try {
      await ensureCollectTab();
    } catch (error) {
      warnRefreshFailure('collect-tab-open-failed', error);
      await finish(
        { complete: false, reason: 'content-script-no-response' },
        { closeTab: false },
      );
    }
  }

  async function receiveResult(message, sender) {
    if (
      message?.type !== SUBS_COLLECTION_RESULT_MESSAGE ||
      sender?.tab?.id !== collectTabId
    ) {
      return false;
    }
    await finish(normalizedCollectionResponse(message));
    return true;
  }

  async function cancel() {
    if (collectTabId === null && opening === null) return false;
    if (opening !== null) {
      try {
        await opening;
      } catch {
        return false;
      }
    }
    await finish({ complete: false, reason: 'timeout' });
    return true;
  }

  function tabRemoved(tabId) {
    if (tabId !== collectTabId) return false;
    void finish(
      { complete: false, reason: 'collect-tab-closed' },
      { closeTab: false },
    );
    return true;
  }

  return {
    begin,
    cancel,
    receiveResult,
    tabRemoved,
    getCollectTabId: () => collectTabId,
  };
}

export function subscriptionListTitle(meta) {
  if (meta === null) {
    return 'youtube-tuner — subscription list not collected yet - click to collect';
  }

  const ageDays = Math.floor(Math.max(0, meta.ageMs) / DAY_MS);
  const dayLabel = ageDays === 1 ? 'day' : 'days';
  return `youtube-tuner — subscription list is ${ageDays} ${dayLabel} old` +
    (meta.stale ? ', refresh recommended' : '');
}

export function updateCountsBadge(message, tabId, {
  action = chrome.action,
} = {}) {
  action.setBadgeText({
    tabId,
    text: message.hidden > 0 ? String(message.hidden) : '',
  });
  action.setBadgeBackgroundColor({
    tabId,
    color: message.subsStale === true
      ? STALE_BADGE_COLOR
      : NORMAL_BADGE_COLOR,
  });
}

export function createDomHealthState({
  tabs = chrome.tabs,
} = {}) {
  const byTabId = new Map();
  const countsByTabId = new Map();

  function update(message, tabId) {
    countsByTabId.set(tabId, {
      hidden: Number(message?.hidden) || 0,
      visible: Number(message?.visible) || 0,
    });
    byTabId.set(
      tabId,
      message?.domHealth === 'degraded' ? 'degraded' : 'ok',
    );
  }

  function remove(tabId) {
    byTabId.delete(tabId);
    countsByTabId.delete(tabId);
  }

  function counts(tabId) {
    return countsByTabId.get(tabId) ?? null;
  }

  async function active() {
    try {
      const activeTabs = await tabs.query({ active: true, currentWindow: true });
      const tabId = activeTabs.find((tab) => Number.isInteger(tab.id))?.id;
      return tabId === undefined ? 'ok' : byTabId.get(tabId) ?? 'ok';
    } catch {
      return 'ok';
    }
  }

  return { active, counts, remove, update };
}

export function createCountsMessageHandler({
  domHealthState = createDomHealthState(),
  updateBadge = updateCountsBadge,
} = {}) {
  return function handleCountsMessage(message, sender, sendResponse) {
    if (message?.type === 'get-counts') {
      try {
        sendResponse?.(domHealthState.counts(message.tabId));
      } catch {}
      return;
    }
    if (message?.type !== 'counts') return;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    domHealthState.update(message, tabId);

    // A disabled scan reports zero hidden tiles. Keep the kill switch's "off"
    // badge instead of replacing it with an empty count.
    if (message.enabled === false) return;

    updateBadge(message, tabId);
  };
}

export async function refreshSubscriptionIndicators({
  action = chrome.action,
  tabs = chrome.tabs,
  loadMeta = loadSubsMeta,
  loadConfiguration = loadConfig,
  getUpdateAvailable = updateAvailable,
  storage = chrome.storage,
  currentVersion = chrome.runtime.getManifest().version,
} = {}) {
  const [meta, config] = await Promise.all([
    loadMeta(),
    loadConfiguration(),
  ]);
  let latestTag = null;
  if (config.updateCheck.enabled) {
    try {
      latestTag = await getUpdateAvailable({ storage, currentVersion });
    } catch {}
  }
  const needsNudge = meta === null || meta.stale === true;
  const color = needsNudge
    ? STALE_BADGE_COLOR
    : NORMAL_BADGE_COLOR;
  const title = subscriptionListTitle(meta) +
    (latestTag === null ? '' : ` - update ${latestTag} available`);
  action.setBadgeBackgroundColor({ color });
  action.setTitle({ title });

  try {
    const youtubeTabs = await tabs.query({ url: '*://www.youtube.com/*' });
    for (const tab of youtubeTabs) {
      if (!Number.isInteger(tab.id)) continue;
      action.setBadgeBackgroundColor({ tabId: tab.id, color });
      action.setTitle({ tabId: tab.id, title });
    }
  } catch {
    // The default action state above still covers new tabs.
  }
  return meta;
}

const YOUTUBE_ORIGIN = 'https://www.youtube.com';

// Who may send which message. Content scripts run inside the YouTube renderer
// and are the less trusted side: they may report, never configure.
export const MESSAGE_ACCESS = Object.freeze({
  'sync-status': 'extension',
  'sync-test': 'extension',
  'sync-enable': 'extension',
  'sync-disable': 'extension',
  'sync-run': 'extension',
  'get-counts': 'extension',
  'refresh-subs': 'extension',
  [CANCEL_SUBS_REFRESH_MESSAGE]: 'extension',
  [UPDATE_CHECK_COMPLETE_MESSAGE]: 'extension',
  counts: 'content',
  [SUBS_COLLECTION_RESULT_MESSAGE]: 'content',
  'state-get': 'content',
  'watched-add': 'content',
  'block-add': 'content',
  'block-remove': 'content',
  'subs-add': 'content',
  'subs-remove': 'content',
  'subs-attempt-get': 'content',
  'subs-attempt-set': 'content',
  'subs-save': 'content',
});

function isExtensionPage(sender, runtime) {
  // Compared as strings: URL.origin is not defined the same way for the
  // chrome-extension scheme everywhere.
  const base = runtime.getURL('');
  if (typeof base !== 'string' || !base.endsWith('/')) return false;
  if (typeof sender.url === 'string') return sender.url.startsWith(base);
  return typeof sender.origin === 'string' && `${sender.origin}/` === base;
}

function isYouTubeTopFrame(sender) {
  let origin = sender.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return false;
    }
  }
  return origin === YOUTUBE_ORIGIN
    && Number.isInteger(sender.tab?.id)
    && (sender.frameId === undefined || sender.frameId === 0);
}

export function senderKind(sender, { runtime = chrome.runtime } = {}) {
  try {
    if (!sender || sender.id !== runtime.id) return 'unknown';
    if (isExtensionPage(sender, runtime)) return 'extension';
    if (isYouTubeTopFrame(sender)) return 'content';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// Drops any message whose type is unknown or whose sender is not the kind
// that type is reserved for.
export function guardMessages(handler, {
  access = MESSAGE_ACCESS,
  kindOf = senderKind,
} = {}) {
  return function guardedHandler(message, sender, sendResponse) {
    const type = message?.type;
    if (typeof type !== 'string' || !Object.hasOwn(access, type)) {
      return undefined;
    }
    if (kindOf(sender) !== access[type]) return undefined;
    return handler(message, sender, sendResponse);
  };
}

const subscriptionTabs = createSubscriptionTabCoordinator();

function startSubscriptionRefresh() {
  return refreshSubscriptionIndicators();
}

export function createUpdateCheckRunner({
  fetchFn = fetch,
  storage = chrome.storage,
  now = Date.now,
  currentVersion = () => chrome.runtime.getManifest().version,
  loadConfiguration = loadConfig,
  performCheck = checkForUpdate,
  refreshIndicators = refreshSubscriptionIndicators,
} = {}) {
  return async function runUpdateCheck() {
    const config = await loadConfiguration();
    if (config.updateCheck.enabled) {
      try {
        await performCheck({
          fetchFn,
          storage,
          now: now(),
          currentVersion: currentVersion(),
        });
      } catch (error) {
        warnRefreshFailure('update-check-failed', error);
      }
    }
    return refreshIndicators();
  };
}

const startUpdateCheck = createUpdateCheckRunner();

const privateStore = createMigratedPrivateStore({
  legacyArea: chrome.storage.local,
  onError: (error) => warnRefreshFailure('sync-state-migration-failed', error),
});

// One queue for every read-modify-write on filter data: requests from tabs
// and the sync engine's own capture and projection.
const enqueueWrite = createSerialQueue();

const syncEngine = createSyncEngine({
  storage: chrome.storage,
  backendFactory: createWebdavBackend,
  keyStore: syncKeyStore,
  privateStorage: privateStore,
  lock: enqueueWrite,
});

function syncFailure(error) {
  if (
    error?.authFailure === true
    || error?.status === 401
    || error?.status === 403
  ) {
    return 'WebDAV credentials were rejected';
  }
  return typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Sync failed';
}

export async function ensureSyncPullAlarm({
  alarms = chrome.alarms,
} = {}) {
  if (typeof alarms.get !== 'function') return false;
  const existing = await alarms.get(SYNC_PULL_ALARM);
  if (existing?.periodInMinutes === 15) return false;
  alarms.create(SYNC_PULL_ALARM, { periodInMinutes: 15 });
  return true;
}

const SYNCED_STORAGE_KEYS = [
  'config',
  'channelOverrides',
  'blocklist',
  'manualSubs',
  'subs',
  'watched',
];

export function createSyncStorageChangeHandler({
  storage = chrome.storage,
  privateStorage = storage.local,
  alarms = chrome.alarms,
} = {}) {
  return async function handleSyncStorageChange(changes, area) {
    if (area !== 'local') return false;
    if (!SYNCED_STORAGE_KEYS.some((key) => changes[key])) return false;

    const stored = await privateStorage.get(['syncSettings', 'syncMeta']);
    if (stored.syncSettings?.enabled !== true) return false;
    const meta = {
      revision: null,
      lastSyncAt: null,
      lastError: null,
      dirty: false,
      ...(stored.syncMeta && typeof stored.syncMeta === 'object'
        ? stored.syncMeta
        : {}),
    };
    if (!meta.dirty) {
      await privateStorage.set({
        syncMeta: { ...meta, dirty: true },
      });
    }

    if (typeof alarms.get !== 'function') return true;
    const pending = await alarms.get(SYNC_PUSH_ALARM);
    if (!pending) {
      alarms.create(SYNC_PUSH_ALARM, { delayInMinutes: 0.5 });
    }
    return true;
  };
}

export function createSyncMessageHandler({
  engine = syncEngine,
  backendFactory = null,
  getDomHealth = () => domHealthState.active(),
} = {}) {
  function capabilitiesFailure(error) {
    return {
      ok: false,
      strongEtags: false,
      cas: false,
      authOk: !(
        error?.authFailure === true
        || error?.status === 401
        || error?.status === 403
      ),
      failure: syncFailure(error),
    };
  }

  return function handleSyncMessage(message, _sender, sendResponse) {
    let operation;
    if (message?.type === 'sync-status') {
      operation = async () => ({
        ...await engine.status(),
        domHealth: await getDomHealth(),
      });
    } else if (message?.type === 'sync-test') {
      operation = async () => {
        try {
          // An injected factory is the test seam; production goes through
          // the engine so a saved password can be reused.
          return backendFactory !== null
            ? await backendFactory(message.settings ?? {}).test()
            : await engine.testConnection(message.settings ?? {});
        } catch (error) {
          return capabilitiesFailure(error);
        }
      };
    } else if (message?.type === 'sync-enable') {
      operation = () => engine.enable(
        message.settings ?? {},
        message.passphrase,
      );
    } else if (message?.type === 'sync-disable') {
      operation = () => engine.disable();
    } else if (message?.type === 'sync-run') {
      operation = () => engine.runSync();
    } else {
      return undefined;
    }

    void Promise.resolve()
      .then(operation)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: syncFailure(error) }));
    return true;
  };
}

const handleSyncStorageChange = createSyncStorageChangeHandler({
  privateStorage: privateStore,
});
const domHealthState = createDomHealthState();
const handleCountsMessage = createCountsMessageHandler({ domHealthState });
const handleSyncMessage = createSyncMessageHandler();
const startSyncPull = () => syncEngine.runSync();

const stateBroadcaster = createStateBroadcaster();
const handleContentMessage = createContentApi({ enqueue: enqueueWrite });

void lockStorageToTrustedContexts();
void ensureStorageLayout();

chrome.action.setPopup({ popup: POPUP_PATH });
chrome.alarms.create(SUBS_ALARM, { periodInMinutes: 1440 });
chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1440 });
void ensureSyncPullAlarm().catch((error) => {
  warnRefreshFailure('sync-pull-alarm-create-failed', error);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SUBS_ALARM) return startSubscriptionRefresh();
  if (alarm.name === UPDATE_ALARM) return startUpdateCheck();
  if (alarm.name === SYNC_PUSH_ALARM) return syncEngine.runSync();
  if (alarm.name === SYNC_PULL_ALARM) return startSyncPull();
  return undefined;
});
chrome.runtime.onInstalled.addListener(startSubscriptionRefresh);
chrome.runtime.onInstalled.addListener(startUpdateCheck);
chrome.runtime.onInstalled.addListener(startSyncPull);
chrome.runtime.onInstalled.addListener(handleInstalledReinjection);
chrome.runtime.onConnect.addListener(() => {});
chrome.runtime.onStartup.addListener(startSubscriptionRefresh);
chrome.runtime.onStartup.addListener(startUpdateCheck);
chrome.runtime.onStartup.addListener(startSyncPull);

onConfigChange(() => {
  void refreshSubscriptionIndicators();
});

chrome.storage.onChanged.addListener((changes, area) => {
  stateBroadcaster.onStorageChanged(changes, area);
  void handleSyncStorageChange(changes, area).catch((error) => {
    warnRefreshFailure('sync-change-schedule-failed', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  subscriptionTabs.tabRemoved(tabId);
  domHealthState.remove(tabId);
});

chrome.runtime.onMessage.addListener(guardMessages(handleSyncMessage));

chrome.runtime.onMessage.addListener(guardMessages(handleCountsMessage));

chrome.runtime.onMessage.addListener(guardMessages(handleContentMessage));

chrome.runtime.onMessage.addListener(guardMessages((message, sender, sendResponse) => {
  if (message?.type === UPDATE_CHECK_COMPLETE_MESSAGE) {
    void startSubscriptionRefresh();
    return;
  }
  if (message?.type === 'refresh-subs') {
    void subscriptionTabs.begin(sendResponse);
    return true;
  }
  if (message?.type === SUBS_COLLECTION_RESULT_MESSAGE) {
    void subscriptionTabs.receiveResult(message, sender);
    return;
  }
  if (message?.type === CANCEL_SUBS_REFRESH_MESSAGE) {
    void subscriptionTabs.cancel();
  }
}));
