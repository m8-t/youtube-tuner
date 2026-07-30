import {
  compareClocks,
  create,
  normalizeDocument,
} from './document.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = DAY_MS;
const TOMBSTONE_TTL_MS = 90 * DAY_MS;
const WATCHED_CAP = 5000;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentTime(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('now must be a non-negative integer timestamp');
  }
  return value;
}

function isFuture(entry, now) {
  return entry.clock.ts > now + FUTURE_TOLERANCE_MS;
}

function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function compareEntries(left, right) {
  const byClock = compareClocks(left.clock, right.clock);
  if (byClock !== 0) return byClock;
  return compareStrings(JSON.stringify(left), JSON.stringify(right));
}

function isTombstone(field, entry) {
  return field === 'overrides'
    ? entry.value === null
    : (field === 'blocklist' || field === 'manualSubs')
      && entry.present === false;
}

function eligible(field, entry, now) {
  if (!entry || isFuture(entry, now)) return false;
  return !isTombstone(field, entry)
    || entry.clock.ts >= now - TOMBSTONE_TTL_MS;
}

function mergeLww(field, left, right, now) {
  const merged = {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort(compareStrings)) {
    const a = eligible(field, left[key], now) ? left[key] : null;
    const b = eligible(field, right[key], now) ? right[key] : null;
    if (!a && !b) continue;
    const winner = !a ? b : !b ? a : compareEntries(a, b) >= 0 ? a : b;
    merged[key] = cloneEntry(winner);
  }
  return merged;
}

function mergeWatched(left, right, clearedBefore, prunedBefore) {
  const watched = {};
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    const lastSeen = Math.max(
      left[id]?.lastSeen ?? 0,
      right[id]?.lastSeen ?? 0,
    );
    if (lastSeen > clearedBefore && lastSeen > prunedBefore) {
      watched[id] = { lastSeen };
    }
  }

  const ordered = Object.entries(watched).sort(([leftId, leftEntry], [rightId, rightEntry]) => (
    rightEntry.lastSeen - leftEntry.lastSeen
    || compareStrings(leftId, rightId)
  ));
  let raisedPrunedBefore = prunedBefore;
  if (ordered.length > WATCHED_CAP) {
    const evicted = ordered.slice(WATCHED_CAP);
    const boundary = evicted[0][1].lastSeen;
    const oldestKept = ordered[WATCHED_CAP - 1][1].lastSeen;
    raisedPrunedBefore = Math.max(
      raisedPrunedBefore,
      boundary === oldestKept ? Math.max(0, boundary - 1) : boundary,
    );
  }

  const kept = {};
  for (const [id, entry] of ordered.slice(0, WATCHED_CAP).sort(([a], [b]) => (
    compareStrings(a, b)
  ))) {
    kept[id] = entry;
  }
  return { watched: kept, prunedBefore: raisedPrunedBefore };
}

export function merge(localDoc, remoteDoc, now) {
  const timestamp = currentTime(now);
  const local = normalizeDocument(localDoc);
  const remote = normalizeDocument(remoteDoc);
  const actorId = [local.actorId, remote.actorId]
    .sort(compareStrings)
    .at(-1);
  const merged = create(actorId);

  for (const field of ['configFields', 'overrides', 'blocklist', 'manualSubs']) {
    merged[field] = mergeLww(
      field,
      local[field],
      remote[field],
      timestamp,
    );
  }

  merged.clearedBefore = Math.max(
    local.clearedBefore,
    remote.clearedBefore,
  );
  const prunedBefore = Math.max(local.prunedBefore, remote.prunedBefore);
  const watched = mergeWatched(
    local.watched,
    remote.watched,
    merged.clearedBefore,
    prunedBefore,
  );
  merged.watched = watched.watched;
  merged.prunedBefore = watched.prunedBefore;
  return merged;
}
