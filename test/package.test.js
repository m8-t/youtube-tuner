import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from '../tools/make-icons.mjs';
import { createPackage, PACKAGE_ENTRIES } from '../tools/package.mjs';

const EXPECTED_ENTRIES = [
  'dist/background.js',
  'dist/content.js',
  'dist/options.js',
  'dist/popup.js',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'manifest.json',
  'options.html',
  'popup.html',
];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function findEndOfCentralDirectory(archive) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = archive.lastIndexOf(signature);
  assert.notEqual(offset, -1, 'end-of-central-directory signature is present');
  assert.ok(offset + 22 <= archive.length, 'end-of-central-directory is complete');
  return offset;
}

function readCentralDirectoryNames(archive, endOffset) {
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString());
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

test('packager allowlist contains exactly the eleven extension paths', () => {
  assert.equal(PACKAGE_ENTRIES.length, 11);
  assert.deepEqual(PACKAGE_ENTRIES.toSorted(), EXPECTED_ENTRIES);
});

test('packager writes a ZIP with a locatable end record and exact entry count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youtube-tuner-package-'));
  try {
    for (const entry of PACKAGE_ENTRIES) {
      const path = join(root, entry);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `fixture:${entry}`);
    }
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'must-not-leak.js'), 'unwanted');

    const outputPath = join(root, 'extension.zip');
    const result = await createPackage(root, outputPath);
    const archive = await readFile(outputPath);
    const endOffset = findEndOfCentralDirectory(archive);

    assert.equal(result.entryCount, EXPECTED_ENTRIES.length);
    assert.equal(archive.readUInt16LE(endOffset + 8), EXPECTED_ENTRIES.length);
    assert.equal(archive.readUInt16LE(endOffset + 10), EXPECTED_ENTRIES.length);
    assert.deepEqual(readCentralDirectoryNames(archive, endOffset).toSorted(), EXPECTED_ENTRIES);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('PNG CRC32 implementation matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('generated icons have valid PNG signatures and expected RGBA dimensions', async () => {
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(join('icons', `icon-${size}.png`));
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    assert.equal(png.readUInt32BE(8), 13);
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8, 'uses 8-bit channels');
    assert.equal(png[25], 6, 'uses RGBA color');
    assert.equal(png[28], 0, 'is non-interlaced');
  }
});

test('manifest and package versions stay in sync', async () => {
  const [manifest, packageJson] = await Promise.all([
    readFile('manifest.json', 'utf8').then(JSON.parse),
    readFile('package.json', 'utf8').then(JSON.parse),
  ]);
  assert.equal(packageJson.version, '1.4.5');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.version_name, undefined);
  assert.deepEqual(manifest.host_permissions, ['*://*.youtube.com/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
});
