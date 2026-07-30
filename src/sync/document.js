import { normalizeChannelName } from '../channel-name.js';

export class DocumentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DocumentError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor';
}

function isPath(value) {
  return typeof value === 'string'
    && value.split('.').every(isSafeKey);
}

function isSyncConfigPath(value) {
  return isPath(value)
    && value !== 'updateCheck'
    && !value.startsWith('updateCheck.');
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeChannelKey(value) {
  const normalized = normalizeChannelName(value);
  return isSafeKey(normalized) ? normalized : '';
}

function cloneJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const cloned = value.map(cloneJson);
    return cloned.includes(undefined) ? undefined : cloned;
  }
  if (!isObject(value)) return undefined;
  const cloned = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSafeKey(key)) return undefined;
    const normalized = cloneJson(child);
    if (normalized === undefined) return undefined;
    cloned[key] = normalized;
  }
  return cloned;
}

function normalizeClock(value) {
  if (!isObject(value)) return null;
  if (!Number.isSafeInteger(value.ts) || value.ts < 0) return null;
  if (!Number.isSafeInteger(value.counter) || value.counter < 0) return null;
  if (typeof value.actorId !== 'string' || value.actorId.length === 0) return null;
  return {
    ts: value.ts,
    counter: value.counter,
    actorId: value.actorId,
  };
}

export function createActorId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new DocumentError('WebCrypto is unavailable');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

export function createClock(ts, counter, actorId) {
  const normalized = normalizeClock({ ts, counter, actorId });
  if (!normalized) throw new DocumentError('Invalid clock');
  return normalized;
}

export function compareClocks(left, right) {
  const a = normalizeClock(left);
  const b = normalizeClock(right);
  if (!a || !b) throw new DocumentError('Invalid clock');
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return compareStrings(a.actorId, b.actorId);
}

export const Clock = Object.freeze({
  create: createClock,
  compare: compareClocks,
});

export function create(actorId = createActorId()) {
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new DocumentError('Invalid actorId');
  }
  return {
    v: 1,
    actorId,
    configFields: {},
    overrides: {},
    blocklist: {},
    manualSubs: {},
    watched: {},
    clearedBefore: 0,
    prunedBefore: 0,
  };
}

function requireDocument(doc) {
  if (!isObject(doc) || doc.v !== 1) {
    throw new DocumentError('Invalid sync document');
  }
}

function requireClock(clock) {
  const normalized = normalizeClock(clock);
  if (!normalized) throw new DocumentError('Invalid clock');
  return normalized;
}

export function setConfigField(doc, path, value, clock) {
  requireDocument(doc);
  if (!isSyncConfigPath(path)) {
    throw new DocumentError('Invalid config field path');
  }
  const normalizedValue = cloneJson(value);
  if (normalizedValue === undefined) {
    throw new DocumentError('Config field value is not JSON-safe');
  }
  doc.configFields ??= {};
  doc.configFields[path] = {
    value: normalizedValue,
    clock: requireClock(clock),
  };
  return doc;
}

export function setOverride(doc, channelName, value, clock) {
  requireDocument(doc);
  const name = normalizeChannelKey(channelName);
  const normalizedValue = value === null ? null : normalizeOverride(value);
  if (!name || (value !== null && !normalizedValue)) {
    throw new DocumentError('Invalid channel override');
  }
  doc.overrides ??= {};
  doc.overrides[name] = {
    value: normalizedValue,
    clock: requireClock(clock),
  };
  return doc;
}

function setPresence(doc, field, name, value, clock) {
  requireDocument(doc);
  const normalizedName = field === 'blocklist'
    ? (isSafeKey(name) ? name : '')
    : normalizeChannelKey(name);
  const present = value === null
    ? false
    : (
      typeof value === 'boolean'
        ? value
        : (isObject(value) ? value.present : undefined)
    );
  if (!normalizedName || typeof present !== 'boolean') {
    throw new DocumentError(`Invalid ${field} entry`);
  }
  doc[field] ??= {};
  doc[field][normalizedName] = {
    present,
    clock: requireClock(clock),
  };
  return doc;
}

export function setBlocklistEntry(doc, pattern, value, clock) {
  return setPresence(doc, 'blocklist', pattern, value, clock);
}

export function setManualSub(doc, channelName, value, clock) {
  return setPresence(doc, 'manualSubs', channelName, value, clock);
}

export function recordWatched(doc, id, lastSeen, clock) {
  requireDocument(doc);
  if (!isSafeKey(id)) {
    throw new DocumentError('Invalid watched ID');
  }
  if (!Number.isSafeInteger(lastSeen) || lastSeen < 0) {
    throw new DocumentError('Invalid watched timestamp');
  }
  requireClock(clock);
  doc.watched ??= {};
  doc.watched[id] = {
    lastSeen: Math.max(lastSeen, doc.watched[id]?.lastSeen ?? 0),
  };
  return doc;
}

export function clearWatched(doc, clearedBefore, clock) {
  requireDocument(doc);
  if (!Number.isSafeInteger(clearedBefore) || clearedBefore < 0) {
    throw new DocumentError('Invalid watched watermark');
  }
  requireClock(clock);
  doc.clearedBefore = Math.max(doc.clearedBefore ?? 0, clearedBefore);
  for (const [id, entry] of Object.entries(doc.watched ?? {})) {
    if (entry.lastSeen <= doc.clearedBefore) delete doc.watched[id];
  }
  return doc;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeRule(rule, numberKey) {
  if (!isObject(rule)) return null;
  const normalized = {};
  if (typeof rule.enabled === 'boolean') normalized.enabled = rule.enabled;
  if (positiveInteger(rule[numberKey])) normalized[numberKey] = rule[numberKey];
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeOverride(value) {
  if (!isObject(value)) return null;
  const normalized = {};
  if (isObject(value.watched) && typeof value.watched.enabled === 'boolean') {
    normalized.watched = { enabled: value.watched.enabled };
  }
  const age = normalizeRule(value.age, 'maxAgeDays');
  const view = normalizeRule(value.view, 'minViews');
  if (age) normalized.age = age;
  if (view) normalized.view = view;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function sortedEntries(value) {
  if (!isObject(value)) return [];
  return Object.entries(value).sort(([left], [right]) => (
    compareStrings(left, right)
  ));
}

function normalizeLwwMap(value, normalizeValue, normalizeKey = (key) => (
  isSafeKey(key) ? key : ''
)) {
  const normalized = {};
  for (const [key, entry] of sortedEntries(value)) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey || !isObject(entry)) continue;
    const clock = normalizeClock(entry.clock);
    const item = normalizeValue(entry);
    if (!clock || item === undefined) continue;
    const candidate = { ...item, clock };
    const current = normalized[normalizedKey];
    if (!current
        || compareClocks(candidate.clock, current.clock) > 0
        || (
          compareClocks(candidate.clock, current.clock) === 0
          && compareStrings(
            JSON.stringify(candidate),
            JSON.stringify(current),
          ) > 0
        )) {
      normalized[normalizedKey] = candidate;
    }
  }
  return normalized;
}

export function normalizeDocument(value) {
  if (!isObject(value)) throw new DocumentError('Sync document must be an object');
  if (!Number.isSafeInteger(value.v)) {
    throw new DocumentError('Sync document has no valid version');
  }
  if (value.v !== 1) throw new DocumentError(`Unsupported sync document v${value.v}`);
  if (typeof value.actorId !== 'string' || value.actorId.length === 0) {
    throw new DocumentError('Sync document has no valid actorId');
  }

  const doc = create(value.actorId);
  doc.configFields = normalizeLwwMap(
    value.configFields,
    (entry) => {
      const cloned = cloneJson(entry.value);
      return cloned === undefined ? undefined : { value: cloned };
    },
    (path) => (isSyncConfigPath(path) ? path : ''),
  );
  doc.overrides = normalizeLwwMap(value.overrides, (entry) => {
    if (entry.value === null) return { value: null };
    const normalized = normalizeOverride(entry.value);
    return normalized ? { value: normalized } : undefined;
  }, normalizeChannelKey);
  const normalizePresence = (entry) => (
    typeof entry.present === 'boolean' ? { present: entry.present } : undefined
  );
  doc.blocklist = normalizeLwwMap(
    value.blocklist,
    normalizePresence,
    (name) => (isSafeKey(name) ? name : ''),
  );
  doc.manualSubs = normalizeLwwMap(
    value.manualSubs,
    normalizePresence,
    normalizeChannelKey,
  );

  for (const [id, entry] of sortedEntries(value.watched)) {
    if (!isSafeKey(id) || !isObject(entry)) continue;
    if (!Number.isSafeInteger(entry.lastSeen) || entry.lastSeen < 0) continue;
    doc.watched[id] = { lastSeen: entry.lastSeen };
  }
  if (Number.isSafeInteger(value.clearedBefore) && value.clearedBefore >= 0) {
    doc.clearedBefore = value.clearedBefore;
  }
  if (Number.isSafeInteger(value.prunedBefore) && value.prunedBefore >= 0) {
    doc.prunedBefore = value.prunedBefore;
  }
  return doc;
}

export function parse(json) {
  let value;
  try {
    value = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (error) {
    throw new DocumentError('Invalid sync document JSON', { cause: error });
  }
  return normalizeDocument(value);
}

export function serialize(doc) {
  return JSON.stringify(normalizeDocument(doc));
}
