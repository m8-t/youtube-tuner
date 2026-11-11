// Validation for data that crosses a trust boundary: an imported settings
// file, and (later) messages from the content script. Anything that does not
// match is dropped, never coerced into something that looks valid.
import { DEFAULT_CONFIG } from '../rules/defaults.js';
import { normalizeChannelName } from '../channel-name.js';
import { normalizeOverrides } from './overrides.js';
import { normalizeBlockMeta } from './blocklist.js';
import { normalizeBlockStats } from './block-stats.js';
import { normalizeLedger } from './feedback.js';
import { normalizeSubHandles } from './subs.js';

export const MAX_NAME_LENGTH = 200;
export const MAX_NAMES = 10_000;
export const MAX_PATTERNS = 1_000;
export const MAX_WATCHED = 5_000;

const VIDEO_ID = /^[\w-]{5,32}$/;
const RELEASE_TAG = /^v\d+(?:\.\d+){1,3}(?:-beta\.\d+)?$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

export function cleanName(value) {
  const name = normalizeChannelName(value);
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : '';
}

export function cleanNames(value, limit = MAX_NAMES) {
  if (!Array.isArray(value)) return [];
  const names = new Set();
  for (const entry of value) {
    const name = cleanName(entry);
    if (name) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

export function cleanVideoIds(value, limit = MAX_WATCHED) {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.filter(isVideoId))];
  // Stored oldest-first, so the tail is what a cap must keep.
  return ids.slice(Math.max(0, ids.length - limit));
}

function cleanPatterns(value) {
  if (!Array.isArray(value)) return [];
  const patterns = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const pattern = entry.trim();
    if (pattern.length > 0 && pattern.length <= MAX_NAME_LENGTH) {
      patterns.add(pattern);
    }
    if (patterns.size >= MAX_PATTERNS) break;
  }
  return [...patterns];
}

function cleanLeaf(defaultValue, value) {
  if (typeof defaultValue === 'boolean') {
    return typeof value === 'boolean' ? value : defaultValue;
  }
  if (typeof defaultValue === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 1e12
      ? value
      : defaultValue;
  }
  if (Array.isArray(defaultValue)) return cleanPatterns(value);
  return defaultValue;
}

// Keeps exactly the keys the defaults define, each with the default's type.
export function cleanConfig(value, defaults = DEFAULT_CONFIG) {
  const output = {};
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const stored = isObject(value) ? value[key] : undefined;
    output[key] = isObject(defaultValue)
      ? cleanConfig(stored, defaultValue)
      : cleanLeaf(defaultValue, stored);
  }
  return output;
}

function cleanSubsEntry(value) {
  if (
    !isObject(value)
    || !Number.isInteger(value.format)
    || !Array.isArray(value.ids)
    || !Number.isFinite(value.fetchedAt)
    || value.fetchedAt < 0
  ) {
    return undefined;
  }
  const ids = cleanNames(value.ids);
  return {
    format: value.format,
    ids,
    handles: normalizeSubHandles(value.handles, new Set(ids)),
    fetchedAt: value.fetchedAt,
  };
}

function cleanBlockMeta(value) {
  if (!isObject(value)) return undefined;
  const output = {};
  for (const [name, entry] of normalizeBlockMeta(value)) {
    if (cleanName(name) === name) output[name] = entry;
  }
  return output;
}

function cleanUpdateCheck(value) {
  if (!isObject(value)) return undefined;
  const output = {};
  if (Number.isFinite(value.lastCheckedAt) && value.lastCheckedAt >= 0) {
    output.lastCheckedAt = value.lastCheckedAt;
  }
  if (typeof value.latestTag === 'string' && RELEASE_TAG.test(value.latestTag)) {
    output.latestTag = value.latestTag;
  }
  return output;
}

const CLEANERS = {
  config: (value) => (isObject(value) ? cleanConfig(value) : undefined),
  channelOverrides: (value) => (
    isObject(value) ? Object.fromEntries(normalizeOverrides(value)) : undefined
  ),
  blocklist: (value) => (Array.isArray(value) ? cleanNames(value) : undefined),
  manualSubs: (value) => (Array.isArray(value) ? cleanNames(value) : undefined),
  blockMeta: cleanBlockMeta,
  watched: (value) => (Array.isArray(value) ? cleanVideoIds(value) : undefined),
  hiddenVideos: (value) => (
    Array.isArray(value) ? cleanVideoIds(value) : undefined
  ),
  subs: cleanSubsEntry,
  blockStats: (value) => (isObject(value) ? normalizeBlockStats(value) : undefined),
  feedbackLedger: (value) => (
    Array.isArray(value) ? normalizeLedger(value) : undefined
  ),
  feedbackQueue: (value) => (Array.isArray(value) ? cleanNames(value) : undefined),
  subsRefreshAttemptedAt: (value) => (
    Number.isFinite(value) && value >= 0 ? value : undefined
  ),
  updateCheck: cleanUpdateCheck,
  helpDismissed: (value) => (typeof value === 'boolean' ? value : undefined),
};

// Every key the extension keeps in chrome.storage.local. Sync credentials
// and sync state are not here on purpose: they never leave IndexedDB.
export const DATA_KEYS = Object.freeze(Object.keys(CLEANERS));

// Keys that a format 1 export carried in its "sync" section.
export const LEGACY_SYNC_KEYS = Object.freeze(['config', 'channelOverrides']);

export function cleanStoredData(values) {
  const output = {};
  const dropped = [];
  for (const [key, value] of Object.entries(isObject(values) ? values : {})) {
    if (!Object.hasOwn(CLEANERS, key)) {
      dropped.push(key);
      continue;
    }
    const cleaned = CLEANERS[key](value);
    if (cleaned === undefined) dropped.push(key);
    else output[key] = cleaned;
  }
  return { values: output, dropped };
}

// Settings a file must not be able to switch on without the user seeing it:
// each one makes the extension send feedback into the Google account.
export function accountFeedbackFlags(config) {
  const flags = [];
  if (config?.feedback?.enabled === true) {
    flags.push('allow sending feedback to YouTube');
  }
  if (config?.blocklistRule?.sendNativeFeedback === true) {
    flags.push('send YouTube\'s "Don\'t recommend channel" when blocking');
  }
  return flags;
}
