import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { decodePng, perceptualHash, hammingDistance } from '../src/util/png.js';

/**
 * The PNG reader exists only to tell "is this the same picture?" from "is this a
 * different advertisement?" in the report, so the tests check exactly that: that
 * real Chromium output decodes, that a picture matches itself, and that two
 * genuinely different pictures do not collapse onto one hash.
 */

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Writes a minimal 8-bit RGBA PNG with the given pixel function. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
  filter = 0,
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // rows are written unfiltered ...
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[rowStart + 1 + x * 4] = r;
      raw[rowStart + 1 + x * 4 + 1] = g;
      raw[rowStart + 1 + x * 4 + 2] = b;
      raw[rowStart + 1 + x * 4 + 3] = 255;
    }
  }
  if (filter === 2) {
    // ... unless the test wants to exercise the "up" filter, applied bottom-up
    // so the earlier rows it refers to are still unfiltered.
    for (let y = height - 1; y >= 1; y--) {
      const rowStart = y * (stride + 1);
      const previousStart = (y - 1) * (stride + 1);
      for (let i = stride - 1; i >= 0; i--) {
        raw[rowStart + 1 + i] = (raw[rowStart + 1 + i] - raw[previousStart + 1 + i]) & 0xff;
      }
      raw[rowStart] = 2;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PNG decoding', () => {
  it('decodes an unfiltered truecolour image', () => {
    const png = makePng(4, 3, (x) => [x * 10, 20, 30]);
    const image = decodePng(png);
    expect(image).not.toBeNull();
    expect(image!.width).toBe(4);
    expect(image!.height).toBe(3);
    expect([...image!.pixels.subarray(0, 4)]).toEqual([0, 20, 30, 255]);
    expect([...image!.pixels.subarray(12, 16)]).toEqual([30, 20, 30, 255]);
  });

  it('undoes the "up" scanline filter', () => {
    const pixel = (x: number, y: number): [number, number, number] => [x * 7, y * 11, 40];
    const plain = decodePng(makePng(5, 4, pixel))!;
    const filtered = decodePng(makePng(5, 4, pixel, 2))!;
    expect(filtered.pixels.equals(plain.pixels)).toBe(true);
  });

  it('returns null rather than guessing at data it does not understand', () => {
    expect(decodePng(Buffer.from('not a png at all'))).toBeNull();
    expect(decodePng(Buffer.alloc(0))).toBeNull();
  });
});

describe('perceptual hashing', () => {
  const gradient = (x: number, y: number): [number, number, number] => [(x * 3) % 256, (y * 5) % 256, 128];

  it('gives an image the same hash as itself', () => {
    const a = perceptualHash(makePng(80, 40, gradient));
    const b = perceptualHash(makePng(80, 40, gradient));
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('tolerates a one-pixel change, as when the page animates behind an empty slot', () => {
    const original = perceptualHash(makePng(80, 40, gradient))!;
    const nudged = perceptualHash(
      makePng(80, 40, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : gradient(x, y))),
    )!;
    expect(hammingDistance(original, nudged)).toBeLessThanOrEqual(4);
  });

  it('separates two genuinely different pictures', () => {
    const left = perceptualHash(makePng(80, 40, (x) => (x < 40 ? [0, 0, 0] : [255, 255, 255])))!;
    const right = perceptualHash(makePng(80, 40, (x) => (x < 40 ? [255, 255, 255] : [0, 0, 0])))!;
    expect(hammingDistance(left, right)).toBeGreaterThan(8);
  });

  it('uses a wider grid for banner-shaped images, so wide creatives stay distinguishable', () => {
    // Two banners differing only in their right-hand half: an 8x8 grid barely
    // sees this, which is why wide images get 16 columns.
    const base = (x: number): [number, number, number] => (x < 364 ? [10, 10, 10] : [240, 240, 240]);
    const variant = (x: number): [number, number, number] =>
      x < 364 ? [10, 10, 10] : x < 546 ? [240, 240, 240] : [10, 10, 10];
    const a = perceptualHash(makePng(728, 90, base))!;
    const b = perceptualHash(makePng(728, 90, variant))!;
    expect(hammingDistance(a, b)).toBeGreaterThan(4);
  });

  it('reports an infinite distance between hashes it cannot compare', () => {
    expect(hammingDistance('abcd', 'abcdef')).toBe(Number.POSITIVE_INFINITY);
  });
});
