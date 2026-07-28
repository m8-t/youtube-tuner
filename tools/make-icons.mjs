import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SCALE = 4;
const BACKGROUND = [0x0f, 0x0f, 0x0f, 0xff];
const FOREGROUND = [0xff, 0x00, 0x33, 0xff];

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

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new RangeError('RGBA buffer length does not match the PNG dimensions');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x >= left + width || y >= top + height) {
    return false;
  }

  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function paintRoundedRect(pixels, size, left, top, width, height, radius, color) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!insideRoundedRect(
        x + 0.5,
        y + 0.5,
        left,
        top,
        width,
        height,
        radius,
      )) {
        continue;
      }

      const offset = (y * size + x) * 4;
      pixels.set(color, offset);
    }
  }
}

function downsample(source, sourceSize, targetSize) {
  const target = Buffer.alloc(targetSize * targetSize * 4);

  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      let alpha = 0;
      const premultiplied = [0, 0, 0];

      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const sourceOffset = (
            ((y * SCALE + sy) * sourceSize) + x * SCALE + sx
          ) * 4;
          const sampleAlpha = source[sourceOffset + 3];
          alpha += sampleAlpha;
          for (let channel = 0; channel < 3; channel += 1) {
            premultiplied[channel] += source[sourceOffset + channel] * sampleAlpha;
          }
        }
      }

      const samples = SCALE * SCALE;
      const targetOffset = (y * targetSize + x) * 4;
      target[targetOffset + 3] = Math.round(alpha / samples);
      if (alpha > 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          target[targetOffset + channel] = Math.round(
            premultiplied[channel] / alpha,
          );
        }
      }
    }
  }

  return target;
}

export function renderIcon(size) {
  const renderSize = size * SCALE;
  const pixels = Buffer.alloc(renderSize * renderSize * 4);

  paintRoundedRect(
    pixels,
    renderSize,
    0,
    0,
    renderSize,
    renderSize,
    renderSize * 0.18,
    BACKGROUND,
  );

  const barHeight = renderSize * 0.11;
  const barWidths = [0.70, 0.45, 0.20];
  const firstBarTop = renderSize * 0.245;
  const barStep = renderSize * 0.20;
  for (let index = 0; index < barWidths.length; index += 1) {
    const barWidth = renderSize * barWidths[index];
    paintRoundedRect(
      pixels,
      renderSize,
      (renderSize - barWidth) / 2,
      firstBarTop + index * barStep,
      barWidth,
      barHeight,
      barHeight / 2,
      FOREGROUND,
    );
  }

  return downsample(pixels, renderSize, size);
}

export async function generateIcons(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  for (const size of ICON_SIZES) {
    const rgba = renderIcon(size);
    await writeFile(join(outputDirectory, `icon-${size}.png`), encodePng(size, size, rgba));
  }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const outputDirectory = join(repositoryRoot, 'icons');
  await generateIcons(outputDirectory);
  console.log(`Generated ${ICON_SIZES.length} icons in ${outputDirectory}`);
}
