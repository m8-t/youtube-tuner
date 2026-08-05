import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Clock,
  DocumentError,
  clearWatched,
  create,
  createClock,
  parse,
  recordWatched,
  serialize,
  setBlocklistEntry,
  setConfigField,
  setManualSub,
  setOverride,
} from '../src/sync/document.js';
import { merge } from '../src/sync/merge.js';
import {
  attachKeyMetadata,
  CryptoError,
  decrypt,
  deriveKey,
  encrypt,
  parseHeader,
} from '../src/sync/crypto.js';
import {
  docToStorage,
  storageToDoc,
} from '../src/sync/project.js';

const NOW = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function envelopeHeader(iters) {
  const kdf = new TextEncoder().encode('PBKDF2-SHA256');
  return Uint8Array.from([
    1,
    ...encodeVarint(kdf.length),
    ...kdf,
    ...encodeVarint(iters),
    ...new Uint8Array(32),
  ]);
}

function clock(ts, counter, actorId = 'actor-a') {
  return createClock(ts, counter, actorId);
}

test('clocks order by timestamp, counter, then actor ID', () => {
  assert.equal(Clock.compare(clock(1, 2, 'z'), clock(2, 0, 'a')), -1);
  assert.equal(Clock.compare(clock(2, 1, 'z'), clock(2, 2, 'a')), -1);
  assert.equal(Clock.compare(clock(2, 2, 'a'), clock(2, 2, 'z')), -1);
  assert.equal(Clock.compare(clock(2, 2, 'z'), clock(2, 2, 'z')), 0);
});

test('newer tombstones prevent stale entry resurrection', () => {
  const present = create('actor-a');
  const deleted = create('actor-b');
  setBlocklistEntry(present, 'Channel', true, clock(NOW - 2, 1));
  setBlocklistEntry(deleted, 'Channel', false, clock(NOW - 1, 1, 'actor-b'));

  assert.deepEqual(
    merge(present, deleted, NOW).blocklist.Channel,
    { present: false, clock: clock(NOW - 1, 1, 'actor-b') },
  );
  assert.deepEqual(merge(present, deleted, NOW), merge(deleted, present, NOW));
});

test('expired tombstones are garbage-collected', () => {
  const doc = create('actor-a');
  setManualSub(
    doc,
    'Old channel',
    false,
    clock(NOW - 90 * DAY_MS - 1, 1),
  );
  assert.deepEqual(merge(doc, create('actor-b'), NOW).manualSubs, {});
});

test('merge converges regardless of argument order', () => {
  const left = create('actor-a');
  const right = create('actor-b');
  setConfigField(left, 'viewRule.minViews', 100, clock(NOW - 4, 1));
  setConfigField(right, 'viewRule.minViews', 200, clock(NOW - 3, 1, 'actor-b'));
  setOverride(left, 'Channel A', { age: { maxAgeDays: 7 } }, clock(NOW, 1));
  setOverride(right, 'Channel B', { watched: { enabled: false } }, clock(NOW, 2));
  setManualSub(left, 'Manual', true, clock(NOW, 3));
  setBlocklistEntry(right, 'Blocked', true, clock(NOW, 4, 'actor-b'));
  recordWatched(left, 'video-a', NOW - 20, clock(NOW, 5));
  recordWatched(right, 'video-a', NOW - 10, clock(NOW, 5, 'actor-b'));
  recordWatched(right, 'video-b', NOW - 5, clock(NOW, 6, 'actor-b'));

  assert.deepEqual(merge(left, right, NOW), merge(right, left, NOW));
});

test('equal clocks with conflicting values still merge deterministically', () => {
  const left = create('actor-a');
  const right = create('actor-b');
  setConfigField(left, 'enabled', false, clock(NOW, 1));
  setConfigField(right, 'enabled', true, clock(NOW, 1));
  assert.deepEqual(merge(left, right, NOW), merge(right, left, NOW));
});

test('watched merge caps by recency and raises prunedBefore', () => {
  const left = create('actor-a');
  const right = create('actor-b');
  for (let index = 0; index < 5001; index += 1) {
    recordWatched(
      index % 2 ? left : right,
      `video-${index}`,
      NOW - 10_000 + index,
      clock(NOW, index + 1),
    );
  }

  const merged = merge(left, right, NOW);
  assert.equal(Object.keys(merged.watched).length, 5000);
  assert.equal(merged.watched['video-0'], undefined);
  assert.ok(merged.watched['video-5000']);
  assert.equal(merged.prunedBefore, NOW - 10_000);
  assert.deepEqual(merge(merged, merged, NOW), merged);
});

test('clearedBefore prevents stale watched entries from returning', () => {
  const stale = create('actor-a');
  const cleared = create('actor-b');
  recordWatched(stale, 'old', NOW - 10, clock(NOW - 10, 1));
  recordWatched(stale, 'new', NOW + 1, clock(NOW, 2));
  clearWatched(cleared, NOW, clock(NOW, 1, 'actor-b'));

  const merged = merge(stale, cleared, NOW);
  assert.equal(merged.watched.old, undefined);
  assert.deepEqual(merged.watched.new, { lastSeen: NOW + 1 });
  assert.equal(merged.clearedBefore, NOW);
});

test('clocks more than 24 hours in the future lose', () => {
  const valid = create('actor-a');
  const future = create('actor-b');
  setConfigField(valid, 'enabled', false, clock(NOW, 1));
  setConfigField(
    future,
    'enabled',
    true,
    clock(NOW + DAY_MS + 1, 1, 'actor-b'),
  );
  setOverride(
    future,
    'Future only',
    { watched: { enabled: true } },
    clock(NOW + DAY_MS + 1, 2, 'actor-b'),
  );

  const merged = merge(valid, future, NOW);
  assert.equal(merged.configFields.enabled.value, false);
  assert.equal(merged.overrides['Future only'], undefined);
});

test('document parser drops malformed fields and rejects newer versions', () => {
  const doc = create('actor-a');
  doc.configFields.valid = { value: true, clock: clock(NOW, 1) };
  doc.configFields.bad = { value: Infinity, clock: clock(NOW, 2) };
  doc.overrides.bad = { value: { age: { maxAgeDays: -1 } }, clock: clock(NOW, 3) };
  doc.watched.bad = { lastSeen: 'yesterday' };
  assert.deepEqual(Object.keys(parse(serialize(doc)).configFields), ['valid']);
  assert.throws(() => parse('{"v":2,"actorId":"future"}'), DocumentError);
});

test('encryption round-trips a document with a non-extractable AES key', async () => {
  const salt = Uint8Array.from({ length: 32 }, (_, index) => index);
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 32);
  const key = await deriveKey('correct horse battery staple', salt, 1000);
  const doc = create('actor-a');
  setConfigField(doc, 'enabled', false, clock(NOW, 1));

  const blob = await encrypt(doc, key, { nonce });
  assert.equal(key.extractable, false);
  assert.deepEqual(await decrypt(blob, key), doc);
});

test('encryption generates a fresh nonce for each call', async () => {
  const key = await deriveKey('passphrase', new Uint8Array(32), 1000);
  const doc = create('actor-a');
  const first = await encrypt(doc, key);
  const second = await encrypt(doc, key);
  assert.notDeepEqual(first, second);
  assert.deepEqual(await decrypt(first, key), doc);
  assert.deepEqual(await decrypt(second, key), doc);
});

test('encryption rejects AES-GCM keys not created by deriveKey', async () => {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  await assert.rejects(
    encrypt(create('actor-a'), key),
    (error) => (
      error instanceof CryptoError
      && error.message === 'Key derivation metadata is unavailable'
    ),
  );
});

test('decryption with the wrong key fails', async () => {
  const salt = new Uint8Array(32);
  const key = await deriveKey('right', salt, 1000);
  const wrongKey = await deriveKey('wrong', salt, 1000);
  const blob = await encrypt(create('actor-a'), key, { nonce: new Uint8Array(12) });
  await assert.rejects(decrypt(blob, wrongKey), CryptoError);
});

test('tampering with authenticated header data fails decryption', async () => {
  const salt = new Uint8Array(32);
  const key = await deriveKey('passphrase', salt, 1000);
  const blob = await encrypt(create('actor-a'), key, { nonce: new Uint8Array(12) });
  blob[17] ^= 1;
  await assert.rejects(decrypt(blob, key), CryptoError);
});

test('encrypted envelope versions newer than v1 are rejected', async () => {
  const salt = new Uint8Array(32);
  const key = await deriveKey('passphrase', salt, 1000);
  const blob = await encrypt(create('actor-a'), key, { nonce: new Uint8Array(12) });
  blob[0] = 2;
  await assert.rejects(decrypt(blob, key), CryptoError);
});

test('encrypted envelope accepts the maximum PBKDF2 iteration count', () => {
  assert.equal(parseHeader(envelopeHeader(10_000_000)).iters, 10_000_000);
});

test('encrypted envelope rejects excessive PBKDF2 iteration counts', () => {
  assert.throws(
    () => parseHeader(envelopeHeader(10_000_001)),
    (error) => (
      error instanceof CryptoError
      && error.message === 'Excessive PBKDF2 iteration count: 10000001'
    ),
  );
});

test('key metadata rejects excessive PBKDF2 iteration counts', async () => {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  assert.throws(
    () => attachKeyMetadata(key, new Uint8Array(32), 10_000_001),
    (error) => (
      error instanceof CryptoError
      && error.message === 'Excessive PBKDF2 iteration count: 10000001'
    ),
  );
});

test('storage projection round-trips existing storage shapes', () => {
  const config = {
    enabled: false,
    ageRule: { enabled: true, maxAgeDays: 30 },
    viewRule: { enabled: false, minViews: 1000, graceHours: 12 },
    watchedRule: { enabled: true },
    blocklistRule: { enabled: true },
    updateCheck: { enabled: false },
  };
  const overrides = new Map([
    ['Channel A', { watched: { enabled: false } }],
    ['Channel B', {
      age: { enabled: true, maxAgeDays: 10 },
      view: { enabled: false, minViews: 50 },
    }],
  ]);
  const projected = docToStorage(storageToDoc(
    config,
    overrides,
    ['Blocked A', 'Blocked B'],
    new Set(['Manual A', 'Manual B']),
    ['oldest', 'middle', 'newest'],
    'actor-a',
    NOW,
  ));

  const { updateCheck, ...syncableConfig } = config;
  assert.deepEqual(projected.configOverlay, syncableConfig);
  assert.deepEqual(projected.channelOverrides, overrides);
  assert.deepEqual(projected.blocklist, ['Blocked A', 'Blocked B']);
  assert.deepEqual(projected.manualSubs, ['Manual A', 'Manual B']);
  assert.deepEqual(projected.watched, ['oldest', 'middle', 'newest']);
});
