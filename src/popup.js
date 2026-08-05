import { loadConfig, saveConfig } from './storage/config.js';
import { loadSubsMeta } from './storage/subs.js';
import { friendlySyncError } from './sync/friendly-errors.js';
import {
  UPDATE_CHECK_COMPLETE_MESSAGE,
  checkForUpdate,
  isNewerVersion,
  updateAvailable,
} from './update-check.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const LATEST_RELEASE_URL =
  'https://github.com/m8-t/youtube-tuner/releases/latest';

function updateStatusElement(documentObject) {
  return documentObject.getElementById('update-status');
}

export function renderAvailableUpdate(tag, {
  documentObject = document,
} = {}) {
  const statusElement = updateStatusElement(documentObject);
  statusElement.textContent = '';
  statusElement.hidden = tag === null;
  if (tag === null) return;

  const link = documentObject.createElement('a');
  link.href = LATEST_RELEASE_URL;
  link.target = '_blank';
  link.textContent = tag;
  statusElement.append('Update ', link, ' is available.');
}

function renderNewestVersion(currentVersion, documentObject) {
  const statusElement = updateStatusElement(documentObject);
  statusElement.textContent =
    `You have the newest version (${currentVersion}).`;
  statusElement.hidden = false;
}

function renderUpdateCheckFailure(documentObject) {
  const statusElement = updateStatusElement(documentObject);
  statusElement.textContent = 'Update check failed.';
  statusElement.hidden = false;
}

function errorMessage(error) {
  return friendlySyncError(error, 'Sync failed');
}

async function loadHelpDismissed(localStorage) {
  try {
    const stored = await localStorage.get('helpDismissed');
    return stored.helpDismissed === true;
  } catch {
    return false;
  }
}

export function lastSyncText(lastSyncAt, {
  now = Date.now,
} = {}) {
  if (lastSyncAt === null || lastSyncAt === undefined) {
    return 'Last sync: never';
  }

  const date = new Date(lastSyncAt);
  const ageMs = Math.max(0, now() - date.getTime());
  if (ageMs < MINUTE_MS) return 'Last sync: just now';
  if (ageMs < HOUR_MS) {
    return `Last sync: ${Math.floor(ageMs / MINUTE_MS)} min ago`;
  }
  if (ageMs < DAY_MS) {
    return `Last sync: ${Math.floor(ageMs / HOUR_MS)} h ago`;
  }
  return `Last sync: ${date.toLocaleString()}`;
}

function renderLastSync(lastSyncAt, documentObject, now) {
  documentObject.getElementById('sync-last-sync').textContent =
    lastSyncText(lastSyncAt, { now });
}

export async function runSyncNow({
  documentObject = document,
  button = documentObject.getElementById('sync-now'),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  now = Date.now,
} = {}) {
  const statusElement = documentObject.getElementById('sync-status');
  button.disabled = true;
  try {
    const response = await sendMessage({ type: 'sync-run' });
    if (response?.ok !== true) {
      throw new Error(errorMessage(response?.error));
    }
    statusElement.textContent = 'Sync complete.';
    try {
      const status = await sendMessage({ type: 'sync-status' });
      renderLastSync(status?.lastSyncAt, documentObject, now);
    } catch {}
    return true;
  } catch (error) {
    statusElement.textContent = errorMessage(error);
    return false;
  } finally {
    button.disabled = false;
  }
}

export function subscriptionAgeText(meta) {
  if (meta === null) {
    return 'Subscription list not collected yet - click to collect.';
  }

  const ageDays = Math.floor(Math.max(0, meta.ageMs) / DAY_MS);
  const dayLabel = ageDays === 1 ? 'day' : 'days';
  const staleExplanation = meta.stale === true
    ? ' The amber badge means it needs a refresh.'
    : '';
  return `Subscription list is ${ageDays} ${dayLabel} old.` +
    staleExplanation;
}

export function requestSubscriptionRefresh({
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  closePopup = () => window.close(),
} = {}) {
  try {
    const response = sendMessage({ type: 'refresh-subs' });
    void Promise.resolve(response).catch((error) => {
      console.warn('[youtube-tuner] subscription refresh failed', error);
    });
    return response;
  } finally {
    closePopup();
  }
}

export async function setFilteringEnabled({
  config,
  enabled,
  saveConfiguration = saveConfig,
  queryTabs = (query) => chrome.tabs.query(query),
  sendTabMessage = (tabId, message) =>
    chrome.tabs.sendMessage(tabId, message),
  setBadgeText = (options) => chrome.action.setBadgeText(options),
}) {
  config.enabled = enabled;
  await saveConfiguration(config);

  const tabs = await queryTabs({ url: '*://www.youtube.com/*' });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      void Promise.resolve(
        sendTabMessage(tab.id, { type: 'rescan' }),
      ).catch(() => {});
    } catch {}
    setBadgeText({
      tabId: tab.id,
      text: config.enabled ? '' : 'off',
    });
  }
}

export async function setDailyUpdateCheckEnabled({
  config,
  enabled,
  saveConfiguration = saveConfig,
}) {
  config.updateCheck ??= {};
  config.updateCheck.enabled = enabled;
  await saveConfiguration(config);
}

export function createManualUpdateChecker({
  fetchFn = (...args) => fetch(...args),
  getStorage = () => chrome.storage,
  now = Date.now,
  currentVersion = () => chrome.runtime.getManifest().version,
  performCheck = checkForUpdate,
  notifyChecked = () => chrome.runtime.sendMessage({
    type: UPDATE_CHECK_COMPLETE_MESSAGE,
  }),
} = {}) {
  return async function runManualUpdateCheck({
    documentObject = document,
    button = documentObject.getElementById('check-update'),
  } = {}) {
    button.disabled = true;
    try {
      const installedVersion = currentVersion();
      const latestTag = await performCheck({
        fetchFn,
        storage: getStorage(),
        now: now(),
        currentVersion: installedVersion,
        force: true,
      });
      if (typeof latestTag !== 'string') {
        renderUpdateCheckFailure(documentObject);
        return null;
      }

      if (isNewerVersion(latestTag, installedVersion)) {
        renderAvailableUpdate(latestTag, { documentObject });
      } else {
        renderNewestVersion(installedVersion, documentObject);
      }
      return latestTag;
    } catch {
      renderUpdateCheckFailure(documentObject);
      return null;
    } finally {
      try {
        await notifyChecked();
      } catch {}
      button.disabled = false;
    }
  };
}

export async function initializePopup({
  documentObject = document,
  loadMeta = loadSubsMeta,
  loadConfiguration = loadConfig,
  saveConfiguration = saveConfig,
  loadAvailableUpdate = () => updateAvailable({
    storage: chrome.storage,
    currentVersion: chrome.runtime.getManifest().version,
  }),
  queryTabs = (query) => chrome.tabs.query(query),
  sendTabMessage = (tabId, message) =>
    chrome.tabs.sendMessage(tabId, message),
  setBadgeText = (options) => chrome.action.setBadgeText(options),
  manualUpdateChecker = createManualUpdateChecker(),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  openOptionsPage = () => chrome.runtime.openOptionsPage(),
  closePopup = () => window.close(),
  localStorage = chrome.storage.local,
  now = Date.now,
} = {}) {
  const [meta, config, helpDismissed] = await Promise.all([
    loadMeta(),
    loadConfiguration(),
    loadHelpDismissed(localStorage),
  ]);
  const ageElement = documentObject.getElementById('subs-age');
  const refreshButton = documentObject.getElementById('refresh-subs');
  const enabledToggle = documentObject.getElementById('enabled');
  const updateButton = documentObject.getElementById('check-update');
  const dailyUpdateToggle =
    documentObject.getElementById('update-check-enabled');
  const syncRow = documentObject.getElementById('sync-row');
  const syncButton = documentObject.getElementById('sync-now');
  const syncStatus = documentObject.getElementById('sync-status');
  const domHealthStatus = documentObject.getElementById('dom-health-status');
  const optionsButton = documentObject.getElementById('open-options');
  const helpPanel = documentObject.getElementById('help-panel');
  const helpDismissButton = documentObject.getElementById('help-dismiss');
  const helpToggle = documentObject.getElementById('help-toggle');

  helpPanel.hidden = helpDismissed;
  helpToggle.hidden = !helpDismissed;

  let latestTag = null;
  if (config.updateCheck?.enabled === true) {
    try {
      latestTag = await loadAvailableUpdate();
    } catch {}
  }

  syncRow.hidden = true;
  try {
    const status = await sendMessage({ type: 'sync-status' });
    if (status?.domHealth === 'degraded') {
      domHealthStatus.textContent =
        'Filtering may be broken by a YouTube page change. ' +
        'Try reloading the YouTube tab.';
      domHealthStatus.hidden = false;
    } else {
      domHealthStatus.textContent = '';
      domHealthStatus.hidden = true;
    }
    if (status?.enabled === true) {
      syncRow.hidden = false;
      renderLastSync(status.lastSyncAt, documentObject, now);
      if (status.lastError) {
        syncStatus.textContent =
          `Last sync error: ${errorMessage(status.lastError)}`;
      }
    }
  } catch {}

  ageElement.textContent = subscriptionAgeText(meta);
  enabledToggle.checked = config.enabled;
  dailyUpdateToggle.checked = config.updateCheck?.enabled === true;
  renderAvailableUpdate(latestTag, { documentObject });

  helpDismissButton.addEventListener('click', () => {
    try {
      const saved = localStorage.set({ helpDismissed: true });
      void Promise.resolve(saved).catch(() => {});
    } catch {}
    helpPanel.hidden = true;
    helpToggle.hidden = false;
  });

  helpToggle.addEventListener('click', (event) => {
    event.preventDefault();
    helpPanel.hidden = !helpPanel.hidden;
  });

  enabledToggle.addEventListener('change', () => {
    void setFilteringEnabled({
      config,
      enabled: enabledToggle.checked,
      saveConfiguration,
      queryTabs,
      sendTabMessage,
      setBadgeText,
    }).catch((error) => {
      console.warn('[youtube-tuner] kill switch failed', error);
    });
  });

  refreshButton.addEventListener('click', () => {
    requestSubscriptionRefresh({ sendMessage, closePopup });
  });

  updateButton.addEventListener('click', () => {
    void manualUpdateChecker({
      documentObject,
      button: updateButton,
    });
  });

  optionsButton.addEventListener('click', () => {
    try {
      const response = openOptionsPage();
      void Promise.resolve(response).catch((error) => {
        console.warn('[youtube-tuner] opening options failed', error);
      });
    } finally {
      closePopup();
    }
  });

  syncButton.addEventListener('click', () => {
    void runSyncNow({
      documentObject,
      button: syncButton,
      sendMessage,
      now,
    });
  });

  dailyUpdateToggle.addEventListener('change', () => {
    if (!dailyUpdateToggle.checked) {
      renderAvailableUpdate(null, { documentObject });
    }
    void setDailyUpdateCheckEnabled({
      config,
      enabled: dailyUpdateToggle.checked,
      saveConfiguration,
    }).catch((error) => {
      console.warn('[youtube-tuner] update setting failed', error);
    });
  });

  return { config, latestTag, meta };
}

if (typeof document !== 'undefined') {
  initializePopup().catch((error) => {
    console.error('[youtube-tuner] popup setup failed', error);
  });
}
