import { parse, serialize } from './document.js';

const VERSION = 1;
const KDF = 'PBKDF2-SHA256';
const DEFAULT_ITERS = 600_000;
const SALT_LENGTH = 32;
const NONCE_LENGTH = 12;
const textEncoder = new TextEncoder();
const keyMetadata = new WeakMap();

export class CryptoError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

function cryptoApi() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new CryptoError('WebCrypto is unavailable');
  }
  return globalThis.crypto;
}

function bytes(value, name) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new CryptoError(`${name} must be binary data`);
}

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CryptoError('Invalid envelope integer');
  }
  const encoded = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    encoded.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(encoded);
}

function decodeVarint(data, offset) {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 8; index += 1) {
    if (offset >= data.length) throw new CryptoError('Truncated envelope header');
    const byte = data[offset];
    offset += 1;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw new CryptoError('Invalid envelope integer');
    if ((byte & 0x80) === 0) return { value, offset };
    multiplier *= 128;
  }
  throw new CryptoError('Invalid envelope integer');
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeHeader(iters, salt) {
  const kdf = textEncoder.encode(KDF);
  return concat(
    encodeVarint(VERSION),
    encodeVarint(kdf.length),
    kdf,
    encodeVarint(iters),
    salt,
  );
}

function decodeHeader(data) {
  let decoded = decodeVarint(data, 0);
  const version = decoded.value;
  if (version !== VERSION) {
    throw new CryptoError(`Unsupported encrypted document v${version}`);
  }

  decoded = decodeVarint(data, decoded.offset);
  const kdfLength = decoded.value;
  const kdfEnd = decoded.offset + kdfLength;
  if (kdfEnd > data.length) throw new CryptoError('Truncated envelope header');
  const kdf = new TextDecoder('utf-8', { fatal: true })
    .decode(data.subarray(decoded.offset, kdfEnd));
  if (kdf !== KDF) throw new CryptoError(`Unsupported KDF ${kdf}`);

  decoded = decodeVarint(data, kdfEnd);
  const iters = decoded.value;
  if (iters <= 0) throw new CryptoError('Invalid PBKDF2 iteration count');
  const saltEnd = decoded.offset + SALT_LENGTH;
  if (saltEnd > data.length) throw new CryptoError('Truncated envelope header');
  return {
    version,
    kdf,
    iters,
    salt: data.slice(decoded.offset, saltEnd),
    headerEnd: saltEnd,
  };
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function requireAesKey(key) {
  if (!(key instanceof CryptoKey) || key.type !== 'secret'
      || key.algorithm?.name !== 'AES-GCM') {
    throw new CryptoError('key must be an AES-GCM CryptoKey');
  }
}

export async function deriveKey(passphrase, salt, iters = DEFAULT_ITERS) {
  const crypto = cryptoApi();
  if (typeof passphrase !== 'string') {
    throw new CryptoError('Passphrase must be a string');
  }
  const saltBytes = bytes(salt, 'salt');
  if (saltBytes.length !== SALT_LENGTH) {
    throw new CryptoError('PBKDF2 salt must be 32 bytes');
  }
  if (!Number.isSafeInteger(iters) || iters <= 0) {
    throw new CryptoError('Invalid PBKDF2 iteration count');
  }
  try {
    const material = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: saltBytes,
        iterations: iters,
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    keyMetadata.set(key, { salt: saltBytes, iters });
    return key;
  } catch (error) {
    throw new CryptoError('Key derivation failed', { cause: error });
  }
}

export async function encrypt(doc, key, { nonce } = {}) {
  const crypto = cryptoApi();
  requireAesKey(key);
  const metadata = keyMetadata.get(key);
  if (!metadata) {
    throw new CryptoError('Key derivation metadata is unavailable');
  }
  const salt = new Uint8Array(metadata.salt);
  const iters = metadata.iters;
  const nonceBytes = nonce === undefined
    ? crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
    : bytes(nonce, 'nonce');
  if (nonceBytes.length !== NONCE_LENGTH) {
    throw new CryptoError('AES-GCM nonce must be 12 bytes');
  }
  const header = encodeHeader(iters, salt);
  try {
    const plaintext = textEncoder.encode(serialize(doc));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceBytes, additionalData: header },
      key,
      plaintext,
    ));
    return concat(header, nonceBytes, ciphertext);
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('Encryption failed', { cause: error });
  }
}

export async function decrypt(blob, key) {
  const crypto = cryptoApi();
  requireAesKey(key);
  try {
    const data = bytes(blob, 'blob');
    const header = decodeHeader(data);
    const nonceEnd = header.headerEnd + NONCE_LENGTH;
    if (data.length < nonceEnd + 16) throw new CryptoError('Truncated ciphertext');
    const headerBytes = data.subarray(0, header.headerEnd);
    const nonce = data.subarray(header.headerEnd, nonceEnd);
    const ciphertext = data.subarray(nonceEnd);
    const metadata = keyMetadata.get(key);
    if (metadata && (
      metadata.iters !== header.iters
      || !equalBytes(metadata.salt, header.salt)
    )) {
      throw new CryptoError('Key derivation parameters do not match envelope');
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: headerBytes },
      key,
      ciphertext,
    );
    return parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('Decryption failed', { cause: error });
  }
}
