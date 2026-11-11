// How often each blocked channel still shows up in the feed. This is what
// tells a block that costs feed slots every day from one that never matters.
// Device-local; counts only, no video data.
const KEY = 'blockStats';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HITS_PER_REPORT = 200;

export const PERSISTENT_MIN_DAYS = 5;
export const PERSISTENT_WINDOW_DAYS = 14;
export const UNSEEN_AFTER_DAYS = 180;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeBlockStats(value) {
  const stats = {};
  if (!isObject(value)) return stats;
  for (const [name, entry] of Object.entries(value)) {
    if (!isObject(entry) || name.length === 0) continue;
    const hits = Number.isSafeInteger(entry.hits) && entry.hits > 0
      ? entry.hits
      : 0;
    const days = Number.isSafeInteger(entry.days) && entry.days > 0
      ? entry.days
      : 0;
    const lastSeen = Number.isSafeInteger(entry.lastSeen) && entry.lastSeen > 0
      ? entry.lastSeen
      : 0;
    if (hits > 0 && lastSeen > 0) {
      stats[name] = { hits, days: Math.max(1, days), lastSeen };
    }
  }
  return stats;
}

export async function loadBlockStats() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return normalizeBlockStats(got[KEY]);
  } catch {
    return {};
  }
}

// `hits` maps a blocked channel name to how many of its videos were hidden.
export async function recordBlockHits(hits, {
  blocked,
  now = Date.now(),
} = {}) {
  if (!isObject(hits)) return false;
  const stats = await loadBlockStats();
  const today = Math.floor(now / DAY_MS);
  let changed = false;
  for (const [name, count] of Object.entries(hits)) {
    if (blocked && !blocked.has(name)) continue;
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const previous = stats[name];
    const sameDay = previous
      && Math.floor(previous.lastSeen / DAY_MS) === today;
    stats[name] = {
      hits: (previous?.hits ?? 0) + Math.min(count, MAX_HITS_PER_REPORT),
      days: (previous?.days ?? 0) + (sameDay ? 0 : 1),
      lastSeen: now,
    };
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [KEY]: stats });
  return changed;
}

export async function pruneBlockStats(blocked) {
  const stats = await loadBlockStats();
  const kept = Object.fromEntries(
    Object.entries(stats).filter(([name]) => blocked.has(name)),
  );
  if (Object.keys(kept).length === Object.keys(stats).length) return false;
  await chrome.storage.local.set({ [KEY]: kept });
  return true;
}

// A blocked channel that YouTube keeps recommending anyway.
export function isPersistent(entry, now = Date.now()) {
  return Boolean(entry)
    && entry.days >= PERSISTENT_MIN_DAYS
    && now - entry.lastSeen <= PERSISTENT_WINDOW_DAYS * DAY_MS;
}

// A block that has not hidden anything for a long time.
export function isUnseen(entry, addedAt, now = Date.now()) {
  const reference = entry?.lastSeen ?? addedAt ?? 0;
  return reference > 0 && now - reference > UNSEEN_AFTER_DAYS * DAY_MS;
}
