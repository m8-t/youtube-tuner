import { normalizeChannelName } from '../channel-name.js';
import {
  create,
  createClock,
  normalizeDocument,
  recordWatched,
  setBlockMeta,
  setBlocklistEntry,
  setHiddenEntry,
  setConfigField,
  setManualSub,
  setOverride,
  setSubsEntry,
} from './document.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    if (!isObject(current[part])) return;
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(value);
}

function flattenConfig(value, prefix = '', output = []) {
  if (!isObject(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'updateCheck' || path.startsWith('updateCheck.')) continue;
    if (isObject(child)) flattenConfig(child, path, output);
    else if (child !== undefined) output.push([path, child]);
  }
  return output;
}

function entries(value) {
  if (value instanceof Map) return value.entries();
  return isObject(value) ? Object.entries(value) : [];
}

function iterable(value) {
  return typeof value !== 'string'
    && value
    && typeof value[Symbol.iterator] === 'function'
    ? value
    : [];
}

export function docToStorage(value) {
  const doc = normalizeDocument(value);
  const configOverlay = {};
  for (const [path, entry] of Object.entries(doc.configFields)) {
    setPath(configOverlay, path, entry.value);
  }

  const channelOverrides = new Map();
  for (const [name, entry] of Object.entries(doc.overrides)) {
    if (entry.value !== null) channelOverrides.set(name, structuredClone(entry.value));
  }

  const blocklist = Object.entries(doc.blocklist)
    .filter(([, entry]) => entry.present)
    .map(([name]) => name);
  // Metadata only means something for a name that is still blocked.
  const blockMeta = {};
  for (const [name, entry] of Object.entries(doc.blockMeta)) {
    if (entry.value !== null && doc.blocklist[name]?.present === true) {
      blockMeta[name] = structuredClone(entry.value);
    }
  }
  // Oldest first, like the stored list, so its cap drops the oldest.
  const hidden = Object.entries(doc.hidden)
    .filter(([, entry]) => entry.present)
    .sort(([leftId, left], [rightId, right]) => (
      left.clock.ts - right.clock.ts
      || left.clock.counter - right.clock.counter
      || compareStrings(leftId, rightId)
    ))
    .map(([id]) => id);
  const manualSubs = Object.entries(doc.manualSubs)
    .filter(([, entry]) => entry.present)
    .map(([name]) => name);
  const subs = Object.entries(doc.subs)
    .filter(([, entry]) => entry.present)
    .map(([name]) => name);
  const watched = Object.entries(doc.watched)
    .filter(([, entry]) => (
      entry.lastSeen > doc.clearedBefore
      && entry.lastSeen > doc.prunedBefore
    ))
    .sort(([leftId, leftEntry], [rightId, rightEntry]) => (
      leftEntry.lastSeen - rightEntry.lastSeen
      || compareStrings(leftId, rightId)
    ))
    .map(([id]) => id);
  return {
    configOverlay,
    channelOverrides,
    blocklist,
    blockMeta,
    manualSubs,
    subs,
    subsFetchedAt: doc.subsFetchedAt,
    hidden,
    watched,
  };
}

export function storageToDoc(
  config,
  overrides,
  blocklist,
  manualSubs,
  watched,
  actorId,
  now,
  subs = null,
  { blockMeta = {}, hidden = [] } = {},
) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative integer timestamp');
  }
  const doc = create(actorId);
  let counter = 0;
  const nextClock = () => createClock(now, counter += 1, actorId);

  for (const [path, value] of flattenConfig(config)) {
    try {
      setConfigField(doc, path, value, nextClock());
    } catch {
      // Malformed stored fields do not become part of the canonical document.
    }
  }
  for (const [name, value] of entries(overrides)) {
    const channelName = normalizeChannelName(name);
    if (!channelName) continue;
    try {
      setOverride(doc, channelName, value, nextClock());
    } catch {
      // Existing storage loaders discard malformed overrides too.
    }
  }
  for (const name of iterable(blocklist)) {
    if (typeof name === 'string' && name.length > 0) {
      try {
        setBlocklistEntry(doc, name, true, nextClock());
      } catch {
        // Malformed stored entries are discarded.
      }
    }
  }
  for (const [name, value] of entries(blockMeta)) {
    if (!Object.hasOwn(doc.blocklist, name)) continue;
    try {
      setBlockMeta(doc, name, value, nextClock());
    } catch {
      // Malformed stored entries are discarded.
    }
  }
  for (const id of iterable(hidden)) {
    if (typeof id !== 'string' || id.length === 0) continue;
    try {
      setHiddenEntry(doc, id, true, nextClock());
    } catch {
      // Malformed stored entries are discarded.
    }
  }
  for (const name of iterable(manualSubs)) {
    const channelName = normalizeChannelName(name);
    if (!channelName) continue;
    try {
      setManualSub(doc, channelName, true, nextClock());
    } catch {
      // Malformed stored entries are discarded.
    }
  }
  if (isObject(subs) && Number.isSafeInteger(subs.fetchedAt) && subs.fetchedAt >= 0) {
    for (const name of iterable(subs.ids)) {
      const channelName = normalizeChannelName(name);
      if (!channelName) continue;
      try {
        setSubsEntry(doc, channelName, true, nextClock());
      } catch {
        // Malformed stored entries are discarded.
      }
    }
    doc.subsFetchedAt = subs.fetchedAt;
  }

  const ids = [...iterable(watched)]
    .filter((id) => typeof id === 'string' && id.length > 0);
  const unique = [...new Set(ids)];
  const firstTimestamp = Math.max(1, now - unique.length + 1);
  unique.forEach((id, index) => {
    try {
      recordWatched(doc, id, firstTimestamp + index, nextClock());
    } catch {
      // Malformed stored entries are discarded.
    }
  });
  return doc;
}
