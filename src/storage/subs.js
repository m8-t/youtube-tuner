import { normalizeChannelKey, normalizeChannelName } from '../channel-name.js';

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

// name -> "@handle" (or channel ID) for the names in `names`. A handle tells
// a subscribed channel from another channel that copied its display name.
export function normalizeSubHandles(handles, names) {
  const output = {};
  const allowed = names instanceof Set ? names : normalizeNames(names);
  const entries = handles instanceof Map
    ? handles.entries()
    : handles !== null && typeof handles === 'object' && !Array.isArray(handles)
      ? Object.entries(handles)
      : [];
  for (const [rawName, rawHandle] of entries) {
    const name = normalizeChannelName(rawName);
    const handle = normalizeChannelKey(rawHandle);
    if (name && handle && allowed.has(name)) output[name] = handle;
  }
  return output;
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

export async function loadSubHandles() {
  const entry = await loadUsableSubsEntry();
  if (entry === null) return new Map();
  return new Map(Object.entries(
    normalizeSubHandles(entry.handles, normalizeNames(entry.ids)),
  ));
}

export async function saveSubs(channelNames, handles = {}) {
  const names = normalizeNames(channelNames);
  await chrome.storage.local.set({
    [KEY]: {
      format: SUBS_FORMAT_VERSION,
      ids: [...names],
      handles: normalizeSubHandles(handles, names),
      fetchedAt: Date.now(),
    },
  });
}

export async function addSubNames(names, handles = {}) {
  const entry = await loadUsableSubsEntry();
  if (entry === null) return false;

  const storedNames = normalizeNames(entry.ids);
  const combinedNames = new Set([...storedNames, ...normalizeNames(names)]);
  const storedHandles = normalizeSubHandles(entry.handles, storedNames);
  const combinedHandles = {
    ...storedHandles,
    ...normalizeSubHandles(handles, combinedNames),
  };
  const handlesChanged = Object.keys(combinedHandles).some(
    (name) => combinedHandles[name] !== storedHandles[name],
  );
  if (combinedNames.size === storedNames.size && !handlesChanged) return false;

  await chrome.storage.local.set({
    [KEY]: {
      format: entry.format,
      ids: [...combinedNames],
      handles: combinedHandles,
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
      handles: normalizeSubHandles(entry.handles, remainingNames),
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
