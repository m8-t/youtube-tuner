import { loadConfig, saveConfig } from './storage/config.js';
import { loadBlocklist, removeBlocked } from './storage/blocklist.js';
import { loadWatched, clearWatched } from './storage/watched.js';
import {
  loadSubs,
  loadSubsMeta,
  loadManualSubs,
  saveManualSubs,
  unionSubs,
} from './storage/subs.js';
import { SUBS_SCRAPE_BUDGET_MS } from './subs-refresh.js';

const el = (id) => document.getElementById(id);

export const MANUAL_REFRESH_TIMEOUT_MS = 120 * 1000;
export const SETTINGS_FORMAT = 1;

const MANUAL_REFRESH_TIMEOUT_SECONDS = MANUAL_REFRESH_TIMEOUT_MS / 1000;
const SUBS_SCRAPE_BUDGET_SECONDS = SUBS_SCRAPE_BUDGET_MS / 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const REFRESH_FAILURE_MESSAGES = {
  'no-youtube-tab':
    'Refresh failed (no-youtube-tab): open a YouTube tab and try again.',
  'content-script-no-response':
    'Refresh failed (content-script-no-response): the YouTube tab did not respond. Reload it and try again.',
  'collect-tab-closed':
    'Refresh failed (collect-tab-closed): the collection tab was closed before it finished.',
  timeout:
    `Refresh failed (timeout): no response after ${MANUAL_REFRESH_TIMEOUT_SECONDS} seconds. Try again.`,
};

function formatScrapeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';

  const {
    finalNameCount,
    initialNameCount,
    bottomReached,
    elapsedMs,
    scrollAttempts,
    continuationPresent,
  } = diagnostics;
  if (
    !Number.isInteger(finalNameCount) ||
    !Number.isInteger(initialNameCount) ||
    typeof bottomReached !== 'boolean' ||
    !Number.isFinite(elapsedMs) ||
    !Number.isInteger(scrollAttempts)
  ) {
    return '';
  }

  const scrollLabel = scrollAttempts === 1 ? 'scroll' : 'scrolls';
  const continuationLabel = continuationPresent === true
    ? 'continuation still present'
    : continuationPresent === false
      ? 'no continuation present'
      : 'continuation state unknown';
  return `${finalNameCount} names (initially ${initialNameCount}) after ` +
    `${scrollAttempts} ${scrollLabel}, ${(elapsedMs / 1000).toFixed(1)}s, ` +
    `${bottomReached ? 'bottom reached' : 'bottom not reached'}, ` +
    continuationLabel;
}

export function refreshFailureMessage(reason, diagnostics) {
  const fixedMessage = REFRESH_FAILURE_MESSAGES[reason];
  if (fixedMessage) return fixedMessage;

  const detail = formatScrapeDiagnostics(diagnostics);
  return `Refresh failed (${reason || 'unknown'})` +
    `${detail ? `: ${detail}` : ''}.`;
}

const FIELDS = [
  ['enabled', 'checked', (c) => c.enabled, (c, v) => { c.enabled = v; }],
  ['age-enabled', 'checked', (c) => c.ageRule.enabled, (c, v) => { c.ageRule.enabled = v; }],
  ['age-days', 'valueAsNumber', (c) => c.ageRule.maxAgeDays, (c, v) => { c.ageRule.maxAgeDays = v; }],
  ['view-enabled', 'checked', (c) => c.viewRule.enabled, (c, v) => { c.viewRule.enabled = v; }],
  ['view-min', 'valueAsNumber', (c) => c.viewRule.minViews, (c, v) => { c.viewRule.minViews = v; }],
  ['view-grace', 'valueAsNumber', (c) => c.viewRule.graceHours, (c, v) => { c.viewRule.graceHours = v; }],
  ['watched-enabled', 'checked', (c) => c.watchedRule.enabled, (c, v) => { c.watchedRule.enabled = v; }],
  ['block-enabled', 'checked', (c) => c.blocklistRule.enabled, (c, v) => { c.blocklistRule.enabled = v; }],
];

let config;

function render() {
  for (const [id, prop, get] of FIELDS) el(id)[prop] = get(config);
}

async function persist() {
  for (const [id, prop, , set] of FIELDS) {
    const value = el(id)[prop];
    if (prop === 'valueAsNumber' && !Number.isFinite(value)) continue;
    set(config, value);
  }
  await saveConfig(config);
}

async function renderBlocklist() {
  const list = [...await loadBlocklist()].sort();
  const ul = el('blocklist');
  ul.textContent = '';
  el('blocklist-empty').hidden = list.length > 0;

  for (const channelName of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = channelName;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Unblock';
    button.addEventListener('click', async () => {
      await removeBlocked(channelName);
      await renderBlocklist();
    });
    li.append(name, button);
    ul.appendChild(li);
  }
}

export async function renderStatus(refreshResult = null) {
  const [fetched, meta, manual, watched] = await Promise.all([
    loadSubs(),
    loadSubsMeta(),
    loadManualSubs(),
    loadWatched(),
  ]);
  const combined = unionSubs(fetched, manual);
  let subscriptionStatus;

  if (fetched === null && manual.size === 0) {
    subscriptionStatus =
      'Subscription list unavailable. The age and view rules are standing down so your own subscriptions are not filtered.';
  } else if (fetched === null) {
    subscriptionStatus =
      `${manual.size} manually listed channels exempt from the age and view rules.`;
  } else {
    subscriptionStatus =
      `${combined.size} channels cached or manually listed and exempt from the age and view rules.`;
  }

  if (meta !== null) {
    const ageDays = Math.floor(Math.max(0, meta.ageMs) / DAY_MS);
    const dayLabel = ageDays === 1 ? 'day' : 'days';
    subscriptionStatus +=
      ` Subscription cache age: ${ageDays} ${dayLabel}.`;
  }

  if (Number.isInteger(refreshResult?.count)) {
    subscriptionStatus =
      `Refreshed ${refreshResult.count} subscribed channels. ${subscriptionStatus}`;
  } else if (refreshResult?.reason) {
    subscriptionStatus =
      `${refreshFailureMessage(
        refreshResult.reason,
        refreshResult.diagnostics,
      )} ${subscriptionStatus}`;
  }

  el('subs-status').textContent = subscriptionStatus;
  const refreshPrompt = el('subs-refresh-prompt');
  const needsNudge = meta === null || meta.stale === true;
  refreshPrompt.hidden = !needsNudge;
  if (meta === null) {
    refreshPrompt.textContent =
      'Subscription list not collected yet. Use \"Refresh now\" to collect it.';
  } else if (meta.stale === true) {
    refreshPrompt.textContent =
      'The subscription list is stale. Use “Refresh now” to update it.';
  } else {
    refreshPrompt.textContent = '';
  }
  el('watched-count').textContent = `${watched.size} videos remembered. `;
}

async function renderManualSubs() {
  const manual = await loadManualSubs();
  el('manual-subs').value = [...manual].join('\n');
}

function isStorageObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSettingsFile(settings) {
  if (!isStorageObject(settings)) {
    throw new Error('the file must contain a settings object');
  }
  if (settings.format !== SETTINGS_FORMAT) {
    throw new Error(`unsupported or missing format (expected ${SETTINGS_FORMAT})`);
  }

  const hasLocal = Object.hasOwn(settings, 'local');
  const hasSync = Object.hasOwn(settings, 'sync');
  if (!hasLocal && !hasSync) {
    throw new Error('the file contains neither local nor sync settings');
  }
  if (hasLocal && !isStorageObject(settings.local)) {
    throw new Error('local settings must be an object');
  }
  if (hasSync && !isStorageObject(settings.sync)) {
    throw new Error('sync settings must be an object');
  }

  return { hasLocal, hasSync };
}

async function replaceStorageArea(storageArea, values, previous) {
  if (Object.keys(values).length > 0) await storageArea.set(values);
  const obsoleteKeys = Object.keys(previous)
    .filter((key) => !Object.hasOwn(values, key));
  if (obsoleteKeys.length > 0) await storageArea.remove(obsoleteKeys);
}

function importedCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function importSuccessMessage(settings) {
  const subscriptions = importedCount(settings.local?.subs?.ids);
  const blocked = importedCount(settings.local?.blocklist);
  const watched = importedCount(settings.local?.watched);
  return `Imported ${subscriptions} subscriptions, ${blocked} blocked channels, ` +
    `${watched} watched videos.`;
}

async function rerenderImportedSettings() {
  config = await loadConfig();
  render();
  await Promise.all([renderBlocklist(), renderStatus(), renderManualSubs()]);
}

export async function exportSettings({
  button = el('settings-export'),
  statusElement = el('settings-status'),
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
  now = () => new Date(),
  BlobCtor = Blob,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  createElement = (tagName) => document.createElement(tagName),
} = {}) {
  button.disabled = true;
  try {
    const exportedAt = now().toISOString();
    const [local, sync] = await Promise.all([
      localStorage.get(null),
      syncStorage.get(null),
    ]);
    const settings = {
      format: SETTINGS_FORMAT,
      exportedAt,
      local,
      sync,
    };
    const blob = new BlobCtor(
      [JSON.stringify(settings, null, 2)],
      { type: 'application/json' },
    );
    const url = createObjectURL(blob);
    try {
      const anchor = createElement('a');
      anchor.href = url;
      anchor.download =
        `youtube-tuner-settings-${exportedAt.slice(0, 10)}.json`;
      anchor.click();
    } finally {
      revokeObjectURL(url);
    }
    statusElement.textContent = 'Settings exported.';
    return settings;
  } catch (error) {
    statusElement.textContent = `Export failed: ${error.message}`;
    return null;
  } finally {
    button.disabled = false;
  }
}

export async function importSettings({
  file,
  button = el('settings-import'),
  statusElement = el('settings-status'),
  confirmFn = (message) => window.confirm(message),
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
  readFileText = (selectedFile) => selectedFile.text(),
  renderResult = rerenderImportedSettings,
} = {}) {
  button.disabled = true;
  try {
    if (!file) throw new Error('no settings file was selected');

    let settings;
    try {
      settings = JSON.parse(await readFileText(file));
    } catch {
      throw new Error('the selected file is not valid JSON');
    }
    const { hasLocal, hasSync } = validateSettingsFile(settings);

    const confirmed = confirmFn(
      'Importing this file will replace the existing settings in each ' +
      'included storage area. Continue?',
    );
    if (!confirmed) {
      statusElement.textContent = 'Import cancelled.';
      return false;
    }

    const replacements = [];
    if (hasLocal) {
      replacements.push({ storageArea: localStorage, values: settings.local });
    }
    if (hasSync) {
      replacements.push({ storageArea: syncStorage, values: settings.sync });
    }
    const previousValues = await Promise.all(
      replacements.map(({ storageArea }) => storageArea.get(null)),
    );
    try {
      await Promise.all(replacements.map(
        ({ storageArea, values }, index) =>
          replaceStorageArea(storageArea, values, previousValues[index]),
      ));
    } catch (error) {
      try {
        await Promise.all(replacements.map(
          ({ storageArea, values }, index) =>
            replaceStorageArea(storageArea, previousValues[index], values),
        ));
      } catch {}
      throw error;
    }
    await renderResult();
    statusElement.textContent = importSuccessMessage(settings);
    return true;
  } catch (error) {
    statusElement.textContent = `Import failed: ${error.message}`;
    return false;
  } finally {
    button.disabled = false;
  }
}

export async function runManualSubscriptionRefresh({
  button = el('subs-refresh'),
  statusElement = el('subs-status'),
  confirmFn = (message) => window.confirm(message),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  renderResult = renderStatus,
  timeoutMs = MANUAL_REFRESH_TIMEOUT_MS,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  button.disabled = true;
  const confirmed = confirmFn(
    'This will open your YouTube channels page in a new tab, scroll to the ' +
    'end of your subscription list (about 20 seconds), and close the tab ' +
    'automatically. Continue?',
  );
  if (!confirmed) {
    statusElement.textContent = 'Refresh cancelled.';
    button.disabled = false;
    return;
  }

  statusElement.textContent =
    'Refreshing subscriptions. A tab will open, scroll by itself, and close. ' +
    `This can take up to ${SUBS_SCRAPE_BUDGET_SECONDS} seconds...`;

  let timer;
  try {
    const response = await Promise.race([
      sendMessage({ type: 'refresh-subs' }),
      new Promise((resolve) => {
        timer = scheduleTimeout(
          () => {
            resolve({ reason: 'timeout' });
            try {
              void Promise.resolve(
                sendMessage({ type: 'cancel-subs-refresh' }),
              ).catch(() => {});
            } catch {}
          },
          timeoutMs,
        );
      }),
    ]);

    await renderResult(
      Number.isInteger(response?.count)
        ? response
        : response && typeof response === 'object'
          ? {
              ...response,
              reason: response.reason || 'content-script-no-response',
            }
          : { reason: 'content-script-no-response' },
    );
  } catch (error) {
    console.warn('[youtube-tuner] content-script-no-response', error);
    await renderResult({ reason: 'content-script-no-response' });
  } finally {
    if (timer !== undefined) cancelTimeout(timer);
    button.disabled = false;
  }
}

async function main() {
  config = await loadConfig();
  render();
  await Promise.all([renderBlocklist(), renderStatus(), renderManualSubs()]);

  for (const [id] of FIELDS) el(id).addEventListener('change', persist);

  el('subs-refresh').addEventListener('click', async () => {
    await runManualSubscriptionRefresh();
  });

  el('manual-subs-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const names = el('manual-subs').value.split(/\r?\n/);
    await saveManualSubs(names);
    await Promise.all([renderManualSubs(), renderStatus()]);
    el('manual-subs-status').textContent = 'Saved.';
  });

  el('watched-clear').addEventListener('click', async () => {
    await clearWatched();
    await renderStatus();
  });

  el('settings-export').addEventListener('click', async () => {
    await exportSettings();
  });

  el('settings-import').addEventListener('click', () => {
    el('settings-file').click();
  });

  el('settings-file').addEventListener('change', async (event) => {
    await importSettings({ file: event.target.files?.[0] });
    event.target.value = '';
  });
}

if (typeof document !== 'undefined') {
  main().catch((error) => {
    console.error('[youtube-tuner] options setup failed', error);
  });
}
