import {
  constants,
  createHash,
  createPublicKey,
  sign,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\0', 'utf8');

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function bytesField(fieldNumber, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([
    encodeVarint((fieldNumber * 8) + 2),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

export function extensionIdFromCrxId(crxId) {
  return Buffer.from(crxId).toString('hex').replace(
    /[0-9a-f]/g,
    (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)),
  );
}

export function buildCrx(zipBytes, privateKey) {
  const archive = Buffer.from(zipBytes);
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = bytesField(1, crxId);
  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeaderData.length);
  const signedPayload = Buffer.concat([
    SIGNED_DATA_PREFIX,
    signedHeaderLength,
    signedHeaderData,
    archive,
  ]);
  const signature = sign('sha256', signedPayload, {
    key: privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  const proof = Buffer.concat([
    bytesField(1, publicKeyDer),
    bytesField(2, signature),
  ]);
  const header = Buffer.concat([
    bytesField(2, proof),
    bytesField(10000, signedHeaderData),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  return {
    bytes: Buffer.concat([prefix, header, archive]),
    crxId,
    extensionId: extensionIdFromCrxId(crxId),
    headerLength: header.length,
  };
}

export async function createCrx({
  zipPath,
  outputPath,
  privateKey,
}) {
  const zipBytes = await readFile(zipPath);
  const result = buildCrx(zipBytes, privateKey);
  await writeFile(outputPath, result.bytes);
  return { ...result, outputPath };
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

export async function runCrxCli({
  root = repositoryRoot,
  env = process.env,
  log = console.log,
  logError = console.error,
} = {}) {
  const defaultKeyPath = join(root, 'key.pem');
  const configuredKeyPath = env.YTT_CRX_KEY;
  const keyPath = configuredKeyPath
    ? (isAbsolute(configuredKeyPath)
        ? configuredKeyPath
        : resolve(configuredKeyPath))
    : defaultKeyPath;

  try {
    let privateKey;
    try {
      privateKey = await readFile(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(
        `RSA private key not found at ${keyPath}. Set YTT_CRX_KEY to your ` +
        `.pem path or place the key at the default path ${defaultKeyPath}.`,
      );
    }

    const manifest = JSON.parse(
      await readFile(join(root, 'manifest.json'), 'utf8'),
    );
    const zipPath = join(
      root,
      `youtube-tuner-${manifest.version}.zip`,
    );
    const outputPath = join(
      root,
      `youtube-tuner-${manifest.version}.crx`,
    );
    const result = await createCrx({ zipPath, outputPath, privateKey });
    log(
      `Created ${result.outputPath} (${result.bytes.length} bytes)`,
    );
    log(`Extension ID: ${result.extensionId}`);
    return 0;
  } catch (error) {
    logError(`CRX build failed: ${error.message}`);
    return 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCrxCli();
}
