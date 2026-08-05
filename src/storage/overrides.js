import { normalizeChannelName } from '../channel-name.js';

const KEY = 'channelOverrides';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeWatched(rule) {
  if (!isObject(rule) || typeof rule.enabled !== 'boolean') return null;
  return { enabled: rule.enabled };
}

function normalizeRule(rule, numberKey) {
  if (!isObject(rule)) return null;
  const normalized = {};
  if (typeof rule.enabled === 'boolean') normalized.enabled = rule.enabled;
  if (positiveInteger(rule[numberKey])) {
    normalized[numberKey] = rule[numberKey];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeEntry(entry) {
  if (!isObject(entry)) return null;
  const normalized = {};
  const watched = normalizeWatched(entry.watched);
  const age = normalizeRule(entry.age, 'maxAgeDays');
  const view = normalizeRule(entry.view, 'minViews');
  if (watched) normalized.watched = watched;
  if (age) normalized.age = age;
  if (view) normalized.view = view;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function entries(overrides) {
  if (overrides instanceof Map) return overrides.entries();
  if (!isObject(overrides)) return [];
  return Object.entries(overrides);
}

export function normalizeOverrides(overrides) {
  const normalized = new Map();
  for (const [channelName, entry] of entries(overrides)) {
    const name = normalizeChannelName(channelName);
    const value = normalizeEntry(entry);
    if (name && value) normalized.set(name, value);
  }
  return normalized;
}

export async function loadOverrides() {
  try {
    const got = await chrome.storage.sync.get(KEY);
    return normalizeOverrides(got[KEY]);
  } catch {
    return new Map();
  }
}

export async function saveOverrides(overrides) {
  await chrome.storage.sync.set({
    [KEY]: Object.fromEntries(normalizeOverrides(overrides)),
  });
}
