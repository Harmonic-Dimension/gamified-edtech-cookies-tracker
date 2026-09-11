import zlib from 'node:zlib';

/**
 * Just enough PNG decoding to compare two screenshots for visual similarity.
 *
 * The audit stores a SHA-256 of every ad-slot crop, which answers "are these
 * byte-identical?". That is the right question for detecting that a creative
 * rotated, but the wrong one for presenting evidence: a slot showing the page
 * behind it produces a different SHA on every observation, because the page
 * itself animates by a pixel or two. Grouping those by SHA fills the report
 * with a dozen copies of the same picture.
 *
 * So the report additionally compares crops perceptually, with a plain average
 * hash: reduce the picture to a 64-cell greyscale grid and record for each cell
 * whether it is lighter or darker than the mean. Two crops whose hashes differ
 * in only a few bits look the same to a reader. This is used for presentation
 * only — no measured value depends on it.
 *
 * Decoding is deliberately limited to what Chromium writes for a screenshot:
 * 8 bits per channel, truecolour with or without alpha, no interlacing. Anything
 * else returns null and the caller falls back to exact SHA comparison.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  pixels: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer: Buffer): DecodedImage | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) return null;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip the CRC
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels || !idat.length) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1);
    const filter = raw[start];
    raw.copy(current, 0, start + 1, start + 1 + stride);
    unfilter(filter, current, previous, channels, stride);

    for (let column = 0; column < width; column++) {
      const from = column * channels;
      const to = (row * width + column) * 4;
      pixels[to] = current[from];
      pixels[to + 1] = current[from + 1];
      pixels[to + 2] = current[from + 2];
      pixels[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    current.copy(previous);
  }

  return { width, height, pixels };
}

/** The five PNG scanline filters, undone in place. */
function unfilter(filter: number, line: Buffer, previous: Buffer, bpp: number, stride: number): void {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < stride; i++) line[i] = (line[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous[i];
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      return;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * The hash grid always has 64 cells, but its shape follows the picture. A
 * 728x90 banner squashed into 8x8 loses almost all horizontal detail, so two
 * different banners with the same overall layout collapse onto the same hash;
 * 16x4 keeps enough of the horizontal structure to tell them apart.
 */
function hashGrid(width: number, height: number): { columns: number; rows: number } {
  return height > 0 && width / height >= 2.5 ? { columns: 16, rows: 4 } : { columns: 8, rows: 8 };
}

/**
 * 64-bit average hash of the image, as a hex string. Returns null when the
 * image cannot be decoded, in which case callers compare exact hashes instead.
 *
 * Hashes are only comparable between images of similar shape, because the grid
 * follows the aspect ratio. That is exactly how it is used: crops are compared
 * within one slot position, where every crop has the same dimensions.
 */
export function perceptualHash(buffer: Buffer): string | null {
  const image = decodePng(buffer);
  if (!image) return null;
  const { columns, rows } = hashGrid(image.width, image.height);

  // Box-average each cell, so that the hash reflects the picture rather than
  // whichever pixels a nearest-neighbour sample happened to land on.
  const cells: number[] = [];
  for (let cellY = 0; cellY < rows; cellY++) {
    for (let cellX = 0; cellX < columns; cellX++) {
      const x0 = Math.floor((cellX * image.width) / columns);
      const x1 = Math.max(x0 + 1, Math.floor(((cellX + 1) * image.width) / columns));
      const y0 = Math.floor((cellY * image.height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((cellY + 1) * image.height) / rows));
      let total = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < image.height; y++) {
        for (let x = x0; x < x1 && x < image.width; x++) {
          const index = (y * image.width + x) * 4;
          // Rec. 601 luma, which is what "looks similar" tracks best.
          total += 0.299 * image.pixels[index] + 0.587 * image.pixels[index + 1] + 0.114 * image.pixels[index + 2];
          count += 1;
        }
      }
      cells.push(count ? total / count : 0);
    }
  }

  const mean = cells.reduce((sum, value) => sum + value, 0) / cells.length;
  let hex = '';
  for (let nibble = 0; nibble < cells.length; nibble += 4) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (cells[nibble + bit] >= mean) value |= 1 << (3 - bit);
    }
    hex += value.toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}
