import { normalizeChannelKey } from '../channel-name.js';

const KEY = 'blocklist';
const META_KEY = 'blockMeta';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HANDLES = 8;

export const SNOOZE_DAYS = 30;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMetaEntry(entry) {
  if (!isObject(entry)) return null;
  const handles = [];
  for (const handle of Array.isArray(entry.handles) ? entry.handles : []) {
    const key = normalizeChannelKey(handle);
    if (key && !handles.includes(key)) handles.push(key);
    if (handles.length >= MAX_HANDLES) break;
  }
  return {
    handles,
    until: Number.isSafeInteger(entry.until) && entry.until > 0
      ? entry.until
      : null,
    addedAt: Number.isSafeInteger(entry.addedAt) && entry.addedAt >= 0
      ? entry.addedAt
      : 0,
  };
}

// name -> { handles, until, addedAt }. `handles` pins a block to the channels
// it was made for, so a namesake is not hidden with it. `until` makes the
// block temporary (a snooze).
export function normalizeBlockMeta(value) {
  const meta = new Map();
  const entries = value instanceof Map
    ? value.entries()
    : isObject(value) ? Object.entries(value) : [];
  for (const [name, entry] of entries) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const normalized = normalizeMetaEntry(entry);
    if (normalized) meta.set(name, normalized);
  }
  return meta;
}

async function read() {
  try {
    const got = await chrome.storage.local.get([KEY, META_KEY]);
    return {
      list: Array.isArray(got[KEY]) ? got[KEY] : [],
      meta: normalizeBlockMeta(got[META_KEY]),
    };
  } catch {
    return { list: [], meta: new Map() };
  }
}

async function write(list, meta) {
  // Meta only exists for blocked names.
  const kept = new Map([...meta].filter(([name]) => list.includes(name)));
  await chrome.storage.local.set({
    [KEY]: list,
    [META_KEY]: Object.fromEntries(kept),
  });
}

export async function loadBlocklist() {
  return new Set((await read()).list);
}

export async function loadBlockMeta() {
  const { list, meta } = await read();
  return new Map([...meta].filter(([name]) => list.includes(name)));
}

// Blocking a channel that is already blocked makes a snooze permanent and
// adds the handle, so a second channel with the same name can be blocked too.
export async function addBlocked(channelName, {
  handle = null,
  now = Date.now(),
} = {}) {
  if (!channelName) return;
  const { list, meta } = await read();
  const key = normalizeChannelKey(handle);
  const existing = meta.get(channelName);
  const alreadyListed = list.includes(channelName);
  const handles = existing ? [...existing.handles] : [];
  if (key && !handles.includes(key) && handles.length < MAX_HANDLES) {
    handles.push(key);
  }
  const unchanged = alreadyListed
    && existing
    && existing.until === null
    && handles.length === existing.handles.length;
  if (unchanged) return;

  if (!alreadyListed) list.push(channelName);
  meta.set(channelName, {
    handles,
    until: null,
    addedAt: existing?.addedAt || now,
  });
  await write(list, meta);
}

export async function removeBlocked(channelName) {
  const { list, meta } = await read();
  meta.delete(channelName);
  await write(list.filter((name) => name !== channelName), meta);
}

// Turns an existing block into one that ends by itself.
export async function snoozeBlocked(channelName, {
  days = SNOOZE_DAYS,
  now = Date.now(),
} = {}) {
  const { list, meta } = await read();
  if (!list.includes(channelName)) return false;
  const existing = meta.get(channelName);
  meta.set(channelName, {
    handles: existing?.handles ?? [],
    until: now + days * DAY_MS,
    addedAt: existing?.addedAt || now,
  });
  await write(list, meta);
  return true;
}

// A block made before handles were recorded has none. The first time its
// name is seen together with a handle, it is pinned to that channel.
export async function pinBlockHandle(channelName, handle) {
  const key = normalizeChannelKey(handle);
  if (!key) return false;
  const { list, meta } = await read();
  if (!list.includes(channelName)) return false;
  const existing = meta.get(channelName);
  if (existing && existing.handles.length > 0) return false;
  meta.set(channelName, {
    handles: [key],
    until: existing?.until ?? null,
    addedAt: existing?.addedAt ?? 0,
  });
  await write(list, meta);
  return true;
}

export async function pruneExpiredBlocks(now = Date.now()) {
  const { list, meta } = await read();
  const expired = list.filter((name) => {
    const until = meta.get(name)?.until;
    return until !== null && until !== undefined && until <= now;
  });
  if (expired.length === 0) return [];
  for (const name of expired) meta.delete(name);
  await write(list.filter((name) => !expired.includes(name)), meta);
  return expired;
}
