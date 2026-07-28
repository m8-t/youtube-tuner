import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCrx,
  extensionIdFromCrxId,
  runCrxCli,
} from '../tools/crx.mjs';

function privateKey() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function readVarint(buffer, start) {
  let offset = start;
  let value = 0;
  let multiplier = 1;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, offset };
    multiplier *= 128;
  }
  throw new Error('truncated varint');
}

function protobufFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    assert.equal(tag.value & 7, 2, 'all CRX header fields are bytes');
    const length = readVarint(buffer, offset);
    offset = length.offset;
    const end = offset + length.value;
    assert.ok(end <= buffer.length, 'protobuf field is complete');
    fields.push({
      number: Math.floor(tag.value / 8),
      value: buffer.subarray(offset, end),
    });
    offset = end;
  }
  return fields;
}

function field(fields, number) {
  const match = fields.find((candidate) => candidate.number === number);
  assert.ok(match, `protobuf field ${number} is present`);
  return match.value;
}

test('CRX3 container has the documented prefix and exact header length', () => {
  const zipBytes = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x74, 0x65, 0x73, 0x74,
  ]);
  const result = buildCrx(zipBytes, privateKey());

  assert.equal(result.bytes.subarray(0, 4).toString('ascii'), 'Cr24');
  assert.equal(result.bytes.readUInt32LE(4), 3);
  assert.equal(result.bytes.readUInt32LE(8), result.headerLength);
  assert.equal(
    result.headerLength,
    result.bytes.length - 12 - zipBytes.length,
  );
  assert.deepEqual(result.bytes.subarray(12 + result.headerLength), zipBytes);
});

test('CRX3 signature verifies against its embedded public key and exact payload', () => {
  const zipBytes = Buffer.from('fixture zip bytes');
  const result = buildCrx(zipBytes, privateKey());
  const header = result.bytes.subarray(12, 12 + result.headerLength);
  const headerFields = protobufFields(header);
  const proofFields = protobufFields(field(headerFields, 2));
  const publicKeyDer = field(proofFields, 1);
  const signature = field(proofFields, 2);
  const signedHeaderData = field(headerFields, 10000);
  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeaderData.length);
  const payload = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'utf8'),
    signedHeaderLength,
    signedHeaderData,
    zipBytes,
  ]);
  const embeddedCrxId = field(protobufFields(signedHeaderData), 1);
  const expectedCrxId = createHash('sha256')
    .update(publicKeyDer)
    .digest()
    .subarray(0, 16);
  const publicKey = createPublicKey({
    key: publicKeyDer,
    type: 'spki',
    format: 'der',
  });

  assert.deepEqual(embeddedCrxId, expectedCrxId);
  assert.equal(
    verify('sha256', payload, {
      key: publicKey,
      padding: constants.RSA_PKCS1_PADDING,
    }, signature),
    true,
  );
});

test('CRX extension ID is deterministic for a given RSA key', () => {
  const key = privateKey();
  const first = buildCrx(Buffer.from('first zip'), key);
  const repeated = buildCrx(Buffer.from('second zip'), key);

  assert.deepEqual(first.crxId, repeated.crxId);
  assert.equal(first.extensionId, repeated.extensionId);
  assert.equal(first.extensionId, extensionIdFromCrxId(first.crxId));
  assert.match(first.extensionId, /^[a-p]{32}$/);

  const secondKey = privateKey();
  const second = buildCrx(Buffer.from('first zip'), secondKey);

  assert.notEqual(first.extensionId, second.extensionId);
  assert.notDeepEqual(first.crxId, second.crxId);
});

test('CRX CLI fails clearly when its private key file is missing', async () => {
  const missingKey = join(
    tmpdir(),
    `youtube-tuner-missing-${process.pid}-${Date.now()}.pem`,
  );
  const messages = [];
  const status = await runCrxCli({
    env: { YTT_CRX_KEY: missingKey },
    logError: (message) => messages.push(message),
  });
  const output = messages.join('\n');

  assert.notEqual(status, 0);
  assert.match(output, /YTT_CRX_KEY/);
  assert.match(output, /key\.pem/);
  assert.match(output, /private key not found/i);
});
