import { loadConfig, onConfigChange } from './storage/config.js';
import { loadSubs, loadSubsMeta } from './storage/subs.js';
import { createSyncEngine } from './sync/engine.js';
import * as syncKeyStore from './sync/key-store.js';
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

export async function refreshSubs({ force = false } = {}) {
  if (force) return null;
  const cached = await loadSubs();
  return cached === null ? null : cached.size;
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

  function update(message, tabId) {
    byTabId.set(
      tabId,
      message?.domHealth === 'degraded' ? 'degraded' : 'ok',
    );
  }

  function remove(tabId) {
    byTabId.delete(tabId);
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

  return { active, remove, update };
}

export function createCountsMessageHandler({
  domHealthState = createDomHealthState(),
  updateBadge = updateCountsBadge,
} = {}) {
  return function handleCountsMessage(message, sender) {
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

const syncEngine = createSyncEngine({
  storage: chrome.storage,
  backendFactory: createWebdavBackend,
  keyStore: syncKeyStore,
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

export function createSyncStorageChangeHandler({
  storage = chrome.storage,
  alarms = chrome.alarms,
} = {}) {
  return async function handleSyncStorageChange(changes, area) {
    const keys = area === 'sync'
      ? ['config', 'channelOverrides']
      : area === 'local'
        ? ['blocklist', 'manualSubs', 'watched']
        : [];
    if (!keys.some((key) => changes[key])) return false;

    const stored = await storage.local.get(['syncSettings', 'syncMeta']);
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
      await storage.local.set({
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
  backendFactory = createWebdavBackend,
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
          return await backendFactory(message.settings ?? {}).test();
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
      operation = () => engine.runSync({ force: true });
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

const handleSyncStorageChange = createSyncStorageChangeHandler();
const domHealthState = createDomHealthState();
const handleCountsMessage = createCountsMessageHandler({ domHealthState });
const handleSyncMessage = createSyncMessageHandler();
const startSyncPull = () => syncEngine.runSync();

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
chrome.runtime.onStartup.addListener(startSubscriptionRefresh);
chrome.runtime.onStartup.addListener(startUpdateCheck);
chrome.runtime.onStartup.addListener(startSyncPull);

onConfigChange(() => {
  void refreshSubscriptionIndicators();
});

chrome.storage.onChanged.addListener((changes, area) => {
  void handleSyncStorageChange(changes, area).catch((error) => {
    warnRefreshFailure('sync-change-schedule-failed', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  subscriptionTabs.tabRemoved(tabId);
  domHealthState.remove(tabId);
});

chrome.runtime.onMessage.addListener(handleSyncMessage);

chrome.runtime.onMessage.addListener(handleCountsMessage);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
});
