import { normalizeChannelName } from '../channel-name.js';
import {
  create,
  createClock,
  normalizeDocument,
  recordWatched,
  setBlocklistEntry,
  setConfigField,
  setManualSub,
  setOverride,
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
  const manualSubs = Object.entries(doc.manualSubs)
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
    manualSubs,
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
  for (const name of iterable(manualSubs)) {
    const channelName = normalizeChannelName(name);
    if (!channelName) continue;
    try {
      setManualSub(doc, channelName, true, nextClock());
    } catch {
      // Malformed stored entries are discarded.
    }
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
