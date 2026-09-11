import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../src/config.js';
import { ensureRunDir, runDir } from '../src/store/store.js';
import { collectCreatives } from '../src/report/creatives.js';
import { makeRun } from './helpers/makeRun.js';
import type { AdSlotBox, AdSlotObservation, RunResult } from '../src/types.js';

/**
 * The gallery turns recorded ad-slot crops into evidence a reader can look at.
 * What has to hold: it groups by slot rather than by picture, it collapses the
 * same picture seen many times, it still finds crops recorded before slots
 * carried their own file name, and it never shows something too small to be an
 * advertisement.
 */

const auditId = 'creatives-test-audit';
let tempDir: string;

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

/** A solid-colour PNG, so two "creatives" are trivially distinguishable. */
function solidPng(width: number, height: number, colour: [number, number, number]): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      raw[start + 1 + x * 4] = colour[0];
      raw[start + 1 + x * 4 + 1] = colour[1];
      raw[start + 1 + x * 4 + 2] = colour[2];
      raw[start + 1 + x * 4 + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A banner with a distinguishing block, so perceptual hashes differ clearly. */
function bannerPng(width: number, height: number, splitAt: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const value = x < splitAt ? 10 : 245;
      raw[start + 1 + x * 4] = value;
      raw[start + 1 + x * 4 + 1] = value;
      raw[start + 1 + x * 4 + 2] = value;
      raw[start + 1 + x * 4 + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function slot(overrides: Partial<AdSlotBox>): AdSlotBox {
  return {
    detector: 'container',
    selector: '[id^="google_ads"]',
    x: 0,
    y: 100,
    width: 728,
    height: 90,
    inViewport: true,
    iframeSrc: null,
    iframeDomain: null,
    screenshotSha256: 'sha-default',
    screenshotFile: null,
    ...overrides,
  };
}

function observation(label: string, slots: AdSlotBox[]): AdSlotObservation {
  return {
    label,
    tRelMs: 1000,
    viewport: { width: 1365, height: 768 },
    slots,
    visibleAdAreaPx: 0,
    viewportAreaPx: 1365 * 768,
    visibleAdAreaFraction: 0,
    error: null,
  };
}

/** Writes the crops a run's observations refer to, the way the audit would. */
function writeRun(run: RunResult, images: Record<string, Buffer>): void {
  ensureRunDir(auditId, run.runId);
  for (const [name, buffer] of Object.entries(images)) {
    fs.writeFileSync(path.join(runDir(auditId, run.runId), 'screenshots', name), buffer);
  }
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-creatives-'));
  config.resultsDir = tempDir;
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('collecting advertising creatives', () => {
  it('groups renderings by slot position, not by picture', () => {
    const runA = makeRun({
      auditId,
      runId: 'run-a',
      condition: 'reject_all',
      adObservations: [
        observation('04-exercise-0s', [slot({ screenshotSha256: 'sha-a' })]),
      ],
    });
    const runB = makeRun({
      auditId,
      runId: 'run-b',
      condition: 'accept_all',
      adObservations: [
        observation('04-exercise-0s', [slot({ screenshotSha256: 'sha-b' })]),
      ],
    });
    writeRun(runA, { 'adslot-04-exercise-0s-0.png': bannerPng(728, 90, 100) });
    writeRun(runB, { 'adslot-04-exercise-0s-0.png': bannerPng(728, 90, 620) });

    const sites = collectCreatives(auditId, [runA, runB]);
    expect(sites).toHaveLength(1);
    expect(sites[0].placements).toHaveLength(1);

    const placement = sites[0].placements[0];
    expect(placement.width).toBe(728);
    expect(placement.observationCount).toBe(2);
    expect(placement.renderings).toHaveLength(2);
    expect(placement.conditions).toEqual(['reject_all', 'accept_all']);
  });

  it('collapses the same picture seen many times into one rendering', () => {
    const runs = [1, 2, 3].map((n) =>
      makeRun({
        auditId,
        runId: `run-same-${n}`,
        condition: 'reject_all',
        adObservations: [observation('04-exercise-0s', [slot({ screenshotSha256: `sha-same-${n}` })])],
      }),
    );
    for (const run of runs) writeRun(run, { 'adslot-04-exercise-0s-0.png': solidPng(728, 90, [120, 120, 120]) });

    const placement = collectCreatives(auditId, runs)[0].placements[0];
    // Three different SHAs, one picture: the report must not claim three
    // advertisements were served.
    expect(placement.renderings).toHaveLength(1);
    expect(placement.renderings[0].sightings).toHaveLength(3);
    expect(placement.renderings[0].identicalVariants).toBe(2);
    expect(placement.observationCount).toBe(3);
  });

  it('keeps the innermost box when a slot is nested inside a container', () => {
    const run = makeRun({
      auditId,
      runId: 'run-nested',
      adObservations: [
        observation('04-exercise-0s', [
          slot({ selector: '[class*="r89-"]', x: 0, y: 100, width: 1365, height: 90, screenshotSha256: 'sha-outer' }),
          slot({ selector: 'iframe[id^="google_ads_iframe"]', x: 300, y: 100, width: 728, height: 90, screenshotSha256: 'sha-inner' }),
        ]),
      ],
    });
    writeRun(run, {
      'adslot-04-exercise-0s-0.png': solidPng(1365, 90, [10, 10, 10]),
      'adslot-04-exercise-0s-1.png': solidPng(728, 90, [200, 30, 30]),
    });

    const placements = collectCreatives(auditId, [run])[0].placements;
    expect(placements).toHaveLength(1);
    expect(placements[0].width).toBe(728);
    expect(placements[0].framesAdItself).toBe(true);
  });

  it('ignores boxes too small to be an advertisement', () => {
    const run = makeRun({
      auditId,
      runId: 'run-small',
      adObservations: [
        observation('04-exercise-0s', [
          slot({ selector: '[class*="r89-"]', x: 1335, y: 638, width: 30, height: 30, screenshotSha256: 'sha-close' }),
        ]),
      ],
    });
    writeRun(run, { 'adslot-04-exercise-0s-0.png': solidPng(30, 30, [0, 0, 0]) });

    const sites = collectCreatives(auditId, [run]);
    expect(sites).toHaveLength(0);
  });

  it('finds crops of runs recorded before slots carried their own file name', () => {
    const run = makeRun({
      auditId,
      runId: 'run-legacy',
      adObservations: [
        // screenshotFile absent, as in evidence recorded by earlier versions.
        observation('05-exercise-10s', [slot({ screenshotSha256: 'sha-legacy', screenshotFile: undefined })]),
      ],
    });
    writeRun(run, { 'adslot-05-exercise-10s-0.png': solidPng(728, 90, [30, 90, 200]) });

    const placement = collectCreatives(auditId, [run])[0].placements[0];
    expect(placement.renderings).toHaveLength(1);
    expect(fs.existsSync(placement.renderings[0].file)).toBe(true);
  });

  it('prefers the slot that carries its own file name when both exist', () => {
    const run = makeRun({
      auditId,
      runId: 'run-explicit',
      adObservations: [
        observation('05-exercise-10s', [
          slot({ screenshotSha256: 'sha-explicit', screenshotFile: 'screenshots/named-creative.png' }),
        ]),
      ],
    });
    writeRun(run, {
      'named-creative.png': solidPng(728, 90, [9, 9, 9]),
      'adslot-05-exercise-10s-0.png': solidPng(728, 90, [250, 250, 250]),
    });

    const placement = collectCreatives(auditId, [run])[0].placements[0];
    expect(path.basename(placement.renderings[0].file)).toBe('named-creative.png');
  });

  it('leaves failed runs out, so a crash is never presented as advertising', () => {
    const run = makeRun({
      auditId,
      runId: 'run-failed',
      status: 'failed',
      adObservations: [observation('04-exercise-0s', [slot({ screenshotSha256: 'sha-failed' })])],
    });
    writeRun(run, { 'adslot-04-exercise-0s-0.png': solidPng(728, 90, [1, 2, 3]) });

    expect(collectCreatives(auditId, [run])).toHaveLength(0);
  });

  it('counts crops it cannot find instead of silently dropping them', () => {
    const run = makeRun({
      auditId,
      runId: 'run-missing',
      adObservations: [observation('04-exercise-0s', [slot({ screenshotSha256: 'sha-missing' })])],
    });
    ensureRunDir(auditId, run.runId);

    const sites = collectCreatives(auditId, [run]);
    expect(sites[0].missingImages).toBe(1);
    expect(sites[0].placements).toHaveLength(0);
  });
});
