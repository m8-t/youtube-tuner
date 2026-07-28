import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const PACKAGE_ENTRIES = [
  'manifest.json',
  'options.html',
  'popup.html',
  'dist/content.js',
  'dist/background.js',
  'dist/options.js',
  'dist/popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? (value >>> 1) ^ 0xedb88320
      : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localFileHeader(name, data, compressedData) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(compressedData.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, compressedData]);
}

function centralDirectoryHeader(name, data, compressedData, localOffset) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(compressedData.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

function endOfCentralDirectory(entryCount, directorySize, directoryOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

export async function createPackage(repositoryRoot, outputPath) {
  const files = [];
  for (const name of PACKAGE_ENTRIES) {
    const data = await readFile(join(repositoryRoot, name));
    files.push({
      name,
      data,
      compressedData: deflateRawSync(data),
    });
  }

  const localRecords = [];
  const directoryRecords = [];
  let localOffset = 0;
  for (const file of files) {
    const localRecord = localFileHeader(file.name, file.data, file.compressedData);
    localRecords.push(localRecord);
    directoryRecords.push(centralDirectoryHeader(
      file.name,
      file.data,
      file.compressedData,
      localOffset,
    ));
    localOffset += localRecord.length;
  }

  const directory = Buffer.concat(directoryRecords);
  const archive = Buffer.concat([
    ...localRecords,
    directory,
    endOfCentralDirectory(files.length, directory.length, localOffset),
  ]);
  await writeFile(outputPath, archive);
  return { outputPath, entryCount: files.length, bytes: archive.length };
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'manifest.json'), 'utf8'));
  const outputPath = join(repositoryRoot, `youtube-tuner-${manifest.version}.zip`);
  const result = await createPackage(repositoryRoot, outputPath);
  console.log(`Created ${outputPath} (${result.entryCount} files, ${result.bytes} bytes)`);
}
