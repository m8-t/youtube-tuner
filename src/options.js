import { loadConfig, saveConfig } from './storage/config.js';
import { loadBlocklist, removeBlocked } from './storage/blocklist.js';
import { loadWatched, clearWatched } from './storage/watched.js';
import {
  loadOverrides,
  normalizeOverrides,
  saveOverrides,
} from './storage/overrides.js';
import {
  loadSubs,
  loadSubsMeta,
  loadManualSubs,
  saveManualSubs,
  unionSubs,
} from './storage/subs.js';
import { SUBS_SCRAPE_BUDGET_MS } from './subs-refresh.js';
import { friendlySyncError } from './sync/friendly-errors.js';

const el = (id) => document.getElementById(id);

export const MANUAL_REFRESH_TIMEOUT_MS = 120 * 1000;
export const SETTINGS_FORMAT = 1;

const MANUAL_REFRESH_TIMEOUT_SECONDS = MANUAL_REFRESH_TIMEOUT_MS / 1000;
const SUBS_SCRAPE_BUDGET_SECONDS = SUBS_SCRAPE_BUDGET_MS / 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_LOCAL_KEYS = new Set(['syncDoc', 'syncMeta', 'syncSettings']);

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

function overrideMode(rule) {
  if (!rule) return 'default';
  return rule.enabled === false ? 'off' : 'custom';
}

function createModeSelect(ruleName, rule) {
  const select = document.createElement('select');
  select.className = `override-${ruleName}-mode`;
  for (const [value, label] of [
    ['default', 'Default'],
    ['off', 'Off'],
    ['custom', 'Custom'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = overrideMode(rule);
  return select;
}

function createLimitInput(ruleName, numberKey, rule, labelText) {
  const label = document.createElement('label');
  label.className = `override-limit override-${ruleName}-limit-row`;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.className = `override-${ruleName}-limit`;
  if (rule?.[numberKey] !== undefined) {
    input.value = rule[numberKey];
    input.dataset.savedValue = rule[numberKey];
  }
  label.append(input, ` ${labelText}`);
  return { label, input };
}

function updateOverrideLimit(row, ruleName) {
  const custom =
    row.querySelector(`.override-${ruleName}-mode`).value === 'custom';
  row.querySelector(`.override-${ruleName}-limit-row`).hidden = !custom;
}

function appendOverrideRow(channelName = '', override = {}) {
  const row = document.createElement('tr');

  const channelCell = document.createElement('td');
  const channel = document.createElement('input');
  channel.type = 'text';
  channel.className = 'override-channel';
  channel.value = channelName;
  channel.placeholder = 'Channel name';
  channelCell.appendChild(channel);

  const watchedCell = document.createElement('td');
  const watchedLabel = document.createElement('label');
  const watched = document.createElement('input');
  watched.type = 'checkbox';
  watched.className = 'override-watched';
  watched.checked = override.watched?.enabled !== false;
  watchedLabel.append(watched, ' Apply watched rule');
  watchedCell.appendChild(watchedLabel);

  const ageCell = document.createElement('td');
  const ageMode = createModeSelect('age', override.age);
  const ageLimit = createLimitInput(
    'age',
    'maxAgeDays',
    override.age,
    'days',
  );
  ageCell.append(ageMode, ageLimit.label);

  const viewCell = document.createElement('td');
  const viewMode = createModeSelect('view', override.view);
  const viewLimit = createLimitInput(
    'view',
    'minViews',
    override.view,
    'views',
  );
  viewCell.append(viewMode, viewLimit.label);

  const actionCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'override-remove';
  remove.textContent = 'Remove';
  actionCell.appendChild(remove);

  row.append(channelCell, watchedCell, ageCell, viewCell, actionCell);
  el('override-rows').appendChild(row);
  updateOverrideLimit(row, 'age');
  updateOverrideLimit(row, 'view');

  for (const input of row.querySelectorAll('input, select')) {
    input.addEventListener('change', async () => {
      updateOverrideLimit(row, 'age');
      updateOverrideLimit(row, 'view');
      if (channel.value.trim() || channelName) await persistOverrides();
    });
  }
  remove.addEventListener('click', async () => {
    row.remove();
    await persistOverrides();
  });
}

function readRuleOverride(row, ruleName, numberKey) {
  const mode = row.querySelector(`.override-${ruleName}-mode`).value;
  if (mode === 'default') return null;
  if (mode === 'off') return { enabled: false };
  const rule = { enabled: true };
  const input = row.querySelector(`.override-${ruleName}-limit`);
  const value = input.valueAsNumber;
  const savedValue = Number(input.dataset.savedValue);
  if (Number.isInteger(value) && value > 0) {
    rule[numberKey] = value;
  } else if (Number.isInteger(savedValue) && savedValue > 0) {
    rule[numberKey] = savedValue;
  }
  return rule;
}

function readOverrideRows() {
  const overrides = new Map();
  for (const row of el('override-rows').querySelectorAll('tr')) {
    const channelName = row.querySelector('.override-channel').value;
    const override = {};
    if (!row.querySelector('.override-watched').checked) {
      override.watched = { enabled: false };
    }
    const age = readRuleOverride(row, 'age', 'maxAgeDays');
    const view = readRuleOverride(row, 'view', 'minViews');
    if (age) override.age = age;
    if (view) override.view = view;
    overrides.set(channelName, override);
  }
  return overrides;
}

export async function persistOverrides() {
  await saveOverrides(readOverrideRows());
  await renderOverrides();
}

export async function renderOverrides() {
  const overrides = await loadOverrides();
  el('override-rows').textContent = '';
  const sorted = [...overrides]
    .sort(([first], [second]) => first.localeCompare(second));
  for (const [channelName, override] of sorted) {
    appendOverrideRow(channelName, override);
  }
}

export function addOverrideRow() {
  appendOverrideRow();
}

export async function setupOverridesEditor() {
  await renderOverrides();
  el('override-add').addEventListener('click', addOverrideRow);
}

export function validateSyncUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) throw new Error('Server URL is required');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Server URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Server URL must use https://');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('Server URL must include a file path');
  }
  if (parsed.pathname.endsWith('/')) {
    throw new Error('Server URL path must not end with /');
  }
  return {
    origin: `${parsed.origin}/*`,
    url: parsed.href,
  };
}

function syncFormValues() {
  const { origin, url } = validateSyncUrl(el('sync-url').value);
  return {
    origin,
    passphrase: el('sync-passphrase').value,
    settings: {
      url,
      username: el('sync-username').value,
      password: el('sync-password').value,
    },
  };
}

function errorMessage(error) {
  return friendlySyncError(error, 'Unknown error');
}

function formatLastSync(value) {
  if (value === null || value === undefined || value === '') return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function renderSyncStatus(status = {}, settings = {}) {
  const configuredSettings = settings || {};
  el('sync-url').value =
    typeof configuredSettings.url === 'string' ? configuredSettings.url : '';
  el('sync-username').value =
    typeof configuredSettings.username === 'string'
      ? configuredSettings.username
      : '';
  el('sync-password').value =
    typeof configuredSettings.password === 'string'
      ? configuredSettings.password
      : '';
  el('sync-passphrase').value = '';

  const enabled = status.enabled === true;
  el('sync-enable').hidden = enabled;
  el('sync-enable').disabled = enabled;
  el('sync-disable').hidden = !enabled;
  el('sync-disable').disabled = !enabled;
  el('sync-run').hidden = !enabled;
  el('sync-run').disabled = !enabled;

  const lastSync = status.configured === false
    ? 'never'
    : formatLastSync(status.lastSyncAt);
  let text =
    `Sync ${enabled ? 'enabled' : 'disabled'}. ` +
    `Last sync: ${lastSync}.`;
  if (status.lastError) {
    const lastError = errorMessage(status.lastError);
    const punctuation = /[.!?]$/.test(lastError) ? '' : '.';
    text += ` Last error: ${lastError}${punctuation}`;
  }
  el('sync-status').textContent = text;
}

export async function refreshSyncStatus({
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  localStorage = chrome.storage.local,
} = {}) {
  const [status, stored] = await Promise.all([
    sendMessage({ type: 'sync-status' }),
    localStorage.get('syncSettings'),
  ]);
  const settings = stored.syncSettings || status?.settings || {};
  renderSyncStatus(status, settings);
  return status;
}

async function requestSyncPermission(requestPermission) {
  const values = syncFormValues();
  const granted = await requestPermission({ origins: [values.origin] });
  if (!granted) {
    el('sync-message').textContent = 'Permission denied';
    return null;
  }
  return values;
}

export function formatSyncCapabilities(capabilities = {}) {
  if (capabilities.ok === true) {
    return 'Connection OK — server is compatible.';
  }

  const failure = typeof capabilities.failure === 'string'
    ? capabilities.failure
    : '';
  const friendlyFailure = friendlySyncError(failure, '');
  if (capabilities.authOk === false) {
    return 'WebDAV credentials were rejected';
  }
  if (failure && friendlyFailure !== failure) {
    return friendlyFailure;
  }
  if (
    (capabilities.strongEtags === false &&
      (!failure || /etag/i.test(failure))) ||
    (capabilities.cas === false &&
      (capabilities.strongEtags === true ||
        /conditional update/i.test(failure)))
  ) {
    return 'This server does not support safe concurrent updates, sync would ' +
      'risk data loss.';
  }
  return failure || 'Server compatibility could not be confirmed.';
}

export async function testSyncConnection({
  button = el('sync-test'),
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  button.disabled = true;
  try {
    const values = await requestSyncPermission(requestPermission);
    if (values === null) return null;
    const response = await sendMessage({
      type: 'sync-test',
      settings: values.settings,
    });
    if (response?.error && !response.capabilities) {
      throw new Error(errorMessage(response.error));
    }
    const capabilities = response?.capabilities || response || {};
    try {
      console.info('[youtube-tuner] sync capability test', capabilities);
    } catch {}
    el('sync-message').textContent =
      formatSyncCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    el('sync-message').textContent =
      `Connection test failed: ${errorMessage(error)}`;
    return null;
  } finally {
    button.disabled = false;
  }
}

export async function enableSync({
  button = el('sync-enable'),
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  localStorage = chrome.storage.local,
} = {}) {
  button.disabled = true;
  let enabled = false;
  try {
    const values = await requestSyncPermission(requestPermission);
    if (values === null) return false;
    const response = await sendMessage({
      type: 'sync-enable',
      settings: values.settings,
      passphrase: values.passphrase,
    });
    if (response?.ok !== true) {
      throw new Error(errorMessage(response?.error || 'Sync could not be enabled'));
    }
    el('sync-passphrase').value = '';
    el('sync-message').textContent = 'Sync enabled.';
    enabled = true;
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Enable failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
    if (enabled) {
      try {
        await refreshSyncStatus({ sendMessage, localStorage });
      } catch (error) {
        el('sync-message').textContent =
          `Status refresh failed: ${errorMessage(error)}`;
      }
    }
  }
}

export async function disableSync({
  button = el('sync-disable'),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  localStorage = chrome.storage.local,
} = {}) {
  button.disabled = true;
  let disabled = false;
  try {
    const response = await sendMessage({ type: 'sync-disable' });
    if (response?.error) throw new Error(errorMessage(response.error));
    el('sync-message').textContent = 'Sync disabled.';
    disabled = true;
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Disable failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
    if (disabled) {
      try {
        await refreshSyncStatus({ sendMessage, localStorage });
      } catch (error) {
        el('sync-message').textContent =
          `Status refresh failed: ${errorMessage(error)}`;
      }
    }
  }
}

export async function runSyncNow({
  button = el('sync-run'),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  button.disabled = true;
  try {
    const response = await sendMessage({ type: 'sync-run' });
    if (response?.ok !== true) {
      throw new Error(errorMessage(response?.error || 'Sync failed'));
    }
    el('sync-message').textContent = 'Sync complete.';
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Sync failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
  }
}

export async function setupSyncControls({
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  localStorage = chrome.storage.local,
} = {}) {
  el('sync-test').addEventListener('click', async () => {
    await testSyncConnection({ requestPermission, sendMessage });
  });
  el('sync-enable').addEventListener('click', async () => {
    await enableSync({ requestPermission, sendMessage, localStorage });
  });
  el('sync-disable').addEventListener('click', async () => {
    await disableSync({ sendMessage, localStorage });
  });
  el('sync-run').addEventListener('click', async () => {
    await runSyncNow({ sendMessage });
  });

  try {
    return await refreshSyncStatus({ sendMessage, localStorage });
  } catch (error) {
    el('sync-message').textContent =
      `Status unavailable: ${errorMessage(error)}`;
    return null;
  }
}

function isStorageObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function excludeSyncLocalValues(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => !SYNC_LOCAL_KEYS.has(key)),
  );
}

function preserveSyncLocalValues(values, previous) {
  const replacement = { ...values };
  for (const key of SYNC_LOCAL_KEYS) {
    if (Object.hasOwn(previous, key)) replacement[key] = previous[key];
  }
  return replacement;
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
  const overrides = isStorageObject(settings.sync?.channelOverrides)
    ? Object.keys(settings.sync.channelOverrides).length
    : 0;
  return `Imported ${subscriptions} subscriptions, ${blocked} blocked channels, ` +
    `${watched} watched videos, ${overrides} channel overrides.`;
}

async function rerenderImportedSettings() {
  config = await loadConfig();
  render();
  await Promise.all([
    renderBlocklist(),
    renderStatus(),
    renderManualSubs(),
    renderOverrides(),
  ]);
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
    const [storedLocal, sync] = await Promise.all([
      localStorage.get(null),
      syncStorage.get(null),
    ]);
    const local = excludeSyncLocalValues(storedLocal);
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
      replacements.push({
        preserveSyncLocal: true,
        storageArea: localStorage,
        values: excludeSyncLocalValues(settings.local),
      });
    }
    if (hasSync) {
      const syncValues = { ...settings.sync };
      if (Object.hasOwn(syncValues, 'channelOverrides')) {
        syncValues.channelOverrides = Object.fromEntries(
          normalizeOverrides(syncValues.channelOverrides),
        );
      }
      replacements.push({ storageArea: syncStorage, values: syncValues });
    }
    const previousValues = await Promise.all(
      replacements.map(({ storageArea }) => storageArea.get(null)),
    );
    const replacementValues = replacements.map(
      ({ preserveSyncLocal, values }, index) =>
        preserveSyncLocal
          ? preserveSyncLocalValues(values, previousValues[index])
          : values,
    );
    try {
      await Promise.all(replacements.map(
        ({ storageArea }, index) =>
          replaceStorageArea(
            storageArea,
            replacementValues[index],
            previousValues[index],
          ),
      ));
    } catch (error) {
      try {
        await Promise.all(replacements.map(
          ({ storageArea }, index) =>
            replaceStorageArea(
              storageArea,
              previousValues[index],
              replacementValues[index],
            ),
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
  await Promise.all([
    renderBlocklist(),
    renderStatus(),
    renderManualSubs(),
    setupOverridesEditor(),
    setupSyncControls(),
  ]);

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
