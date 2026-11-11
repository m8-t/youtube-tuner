import { loadConfig, saveConfig } from './storage/config.js';
import { loadWatched, clearWatched } from './storage/watched.js';
import {
  loadSubs,
  loadSubsMeta,
  loadManualSubs,
  saveManualSubs,
  unionSubs,
} from './storage/subs.js';
import { SUBS_SCRAPE_BUDGET_MS } from './subs-refresh.js';
import { ensureStorageLayout } from './storage/migrate.js';
import { el } from './options/dom.js';
import { exportSettings, importSettings } from './options/backup.js';
import {
  renderOverrides,
  setupOverridesEditor,
} from './options/overrides-ui.js';
import { setupSyncControls } from './options/sync-ui.js';
import {
  renderBlocklist,
  renderFeedback,
  renderHidden,
  setupBlocksUi,
} from './options/blocks-ui.js';

export {
  SETTINGS_FORMAT,
  exportSettings,
  importSettings,
} from './options/backup.js';
export {
  addOverrideRow,
  persistOverrides,
  renderOverrides,
  setupOverridesEditor,
} from './options/overrides-ui.js';
export {
  disableSync,
  enableSync,
  formatSyncCapabilities,
  refreshSyncStatus,
  renderSyncStatus,
  runSyncNow,
  setupSyncControls,
  testSyncConnection,
  validateSyncUrl,
} from './options/sync-ui.js';

export const MANUAL_REFRESH_TIMEOUT_MS = 120 * 1000;

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
  ['age-min-hours', 'valueAsNumber', (c) => c.ageRule.minAgeHours, (c, v) => { c.ageRule.minAgeHours = v; }],
  ['view-enabled', 'checked', (c) => c.viewRule.enabled, (c, v) => { c.viewRule.enabled = v; }],
  ['view-min', 'valueAsNumber', (c) => c.viewRule.minViews, (c, v) => { c.viewRule.minViews = v; }],
  ['view-grace', 'valueAsNumber', (c) => c.viewRule.graceHours, (c, v) => { c.viewRule.graceHours = v; }],
  ['watched-enabled', 'checked', (c) => c.watchedRule.enabled, (c, v) => { c.watchedRule.enabled = v; }],
  ['block-enabled', 'checked', (c) => c.blocklistRule.enabled, (c, v) => { c.blocklistRule.enabled = v; }],
  ['block-native', 'checked', (c) => c.blocklistRule.sendNativeFeedback, (c, v) => { c.blocklistRule.sendNativeFeedback = v; }],
  ['feedback-enabled', 'checked', (c) => c.feedback.enabled, (c, v) => { c.feedback.enabled = v; }],
  ['feedback-limit', 'valueAsNumber', (c) => c.feedback.weeklyLimit, (c, v) => { c.feedback.weeklyLimit = Math.max(0, Math.min(20, Math.floor(v))); }],
  ['subs-sync-enabled', 'checked', (c) => c.subsSync.enabled, (c, v) => { c.subsSync.enabled = v; }],
  ['title-enabled', 'checked', (c) => c.titleRule.enabled, (c, v) => { c.titleRule.enabled = v; }],
];

let config;

function render() {
  for (const [id, prop, get] of FIELDS) el(id)[prop] = get(config);
}

async function persist() {
  config = await loadConfig();
  for (const [id, prop, , set] of FIELDS) {
    const value = el(id)[prop];
    if (prop === 'valueAsNumber' && !Number.isFinite(value)) continue;
    set(config, value);
  }
  await saveConfig(config);
  // The feedback switch changes what the block list offers.
  await Promise.all([renderBlocklist(), renderFeedback()]);
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

function renderTitleFilters() {
  const patterns = Array.isArray(config.titleRule.patterns)
    ? config.titleRule.patterns.filter((pattern) => typeof pattern === 'string')
    : [];
  el('title-filters').value = patterns.join('\n');
}

async function rerenderImportedSettings() {
  config = await loadConfig();
  render();
  renderTitleFilters();
  await Promise.all([
    renderBlocklist(),
    renderHidden(),
    renderFeedback(),
    renderStatus(),
    renderManualSubs(),
    renderOverrides(),
  ]);
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

export async function main() {
  await ensureStorageLayout();
  config = await loadConfig();
  render();
  renderTitleFilters();
  await Promise.all([
    renderBlocklist(),
    renderHidden(),
    renderFeedback(),
    renderStatus(),
    renderManualSubs(),
    setupOverridesEditor(),
    setupSyncControls(),
  ]);
  setupBlocksUi();

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

  el('title-filters-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const patterns = el('title-filters').value
      .split(/\r?\n/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    config = await loadConfig();
    config.titleRule.patterns = [...new Set(patterns)];
    await saveConfig(config);
    renderTitleFilters();
    el('title-filters-status').textContent = 'Saved.';
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
    await importSettings({
      file: event.target.files?.[0],
      renderResult: rerenderImportedSettings,
    });
    event.target.value = '';
  });
}

if (typeof document !== 'undefined') {
  main().catch((error) => {
    console.error('[youtube-tuner] options setup failed', error);
  });
}
