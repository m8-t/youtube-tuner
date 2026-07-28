import { normalizeChannelName } from '../channel-name.js';

const KEY = 'subs';
const MANUAL_KEY = 'manualSubs';
export const SUBS_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const SUBS_FORMAT_VERSION = 2;

export function normalizeNames(names) {
  if (!names || typeof names[Symbol.iterator] !== 'function') return new Set();
  return new Set(
    [...names]
      .filter((name) => typeof name === 'string')
      .map(normalizeChannelName)
      .filter(Boolean),
  );
}

async function loadUsableSubsEntry() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const entry = got[KEY];
    if (!entry || !Array.isArray(entry.ids)) return null;
    if (entry.format !== SUBS_FORMAT_VERSION) return null;
    if (!Number.isFinite(entry.fetchedAt)) return null;
    return entry;
  } catch {
    return null;
  }
}

// Returns null only when the cache is absent or unusable. An old list remains
// safer than standing down the age and view rules entirely.
export async function loadSubs() {
  const entry = await loadUsableSubsEntry();
  return entry === null ? null : normalizeNames(entry.ids);
}

export async function loadSubsMeta() {
  const entry = await loadUsableSubsEntry();
  if (entry === null) return null;
  const ageMs = Date.now() - entry.fetchedAt;
  return {
    fetchedAt: entry.fetchedAt,
    ageMs,
    stale: ageMs > SUBS_STALE_AFTER_MS,
  };
}

export async function saveSubs(channelNames) {
  await chrome.storage.local.set({
    [KEY]: {
      format: SUBS_FORMAT_VERSION,
      ids: [...normalizeNames(channelNames)],
      fetchedAt: Date.now(),
    },
  });
}

export async function addSubNames(names) {
  const entry = await loadUsableSubsEntry();
  if (entry === null) return false;

  const storedNames = normalizeNames(entry.ids);
  const combinedNames = new Set([...storedNames, ...normalizeNames(names)]);
  if (combinedNames.size === storedNames.size) return false;

  await chrome.storage.local.set({
    [KEY]: {
      format: entry.format,
      ids: [...combinedNames],
      fetchedAt: entry.fetchedAt,
    },
  });
  return true;
}

export async function removeSubNames(names) {
  const entry = await loadUsableSubsEntry();
  if (entry === null) return false;

  const storedNames = normalizeNames(entry.ids);
  const namesToRemove = normalizeNames(names);
  const remainingNames = new Set(
    [...storedNames].filter((name) => !namesToRemove.has(name)),
  );
  if (remainingNames.size === storedNames.size) return false;

  await chrome.storage.local.set({
    [KEY]: {
      format: entry.format,
      ids: [...remainingNames],
      fetchedAt: entry.fetchedAt,
    },
  });
  return true;
}

export async function loadManualSubs() {
  try {
    const got = await chrome.storage.local.get(MANUAL_KEY);
    return normalizeNames(
      Array.isArray(got[MANUAL_KEY]) ? got[MANUAL_KEY] : [],
    );
  } catch {
    return new Set();
  }
}

export async function saveManualSubs(names) {
  await chrome.storage.local.set({
    [MANUAL_KEY]: [...normalizeNames(names)],
  });
}

// A fetched empty set is still a valid cache. Only the unavailable-cache
// case (null) falls back to null when the manual list is also empty.
export function unionSubs(fetched, manual) {
  const manualNames = normalizeNames(manual);
  if (fetched === null) {
    return manualNames.size > 0 ? new Set(manualNames) : null;
  }
  return new Set([...normalizeNames(fetched), ...manualNames]);
}
