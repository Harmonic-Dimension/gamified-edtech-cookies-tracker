import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runKey } from '../src/audit/audit.js';
import { config } from '../src/config.js';
import { saveAudit, saveRun, listRuns, getAudit } from '../src/store/store.js';
import { makeRun } from './helpers/makeRun.js';
import type { AuditMetadata } from '../src/types.js';

/**
 * A long audit that dies halfway must not waste the runs it already recorded.
 * The resume path is keyed on site + condition + repetition.
 */
let tempDir: string;
const auditId = 'resume-test-audit';

const audit: AuditMetadata = {
  auditId,
  label: 'Interrupted audit',
  startedAt: '2026-09-06T10:00:00.000Z',
  finishedAt: null,
  status: 'running',
  sites: ['spellingoefenen', 'taaloefenen'],
  conditions: ['reject_all', 'accept_all'],
  repetitions: 2,
  environment: {
    node: 'v22', playwright: '1.63.0', platform: 'linux', arch: 'x64', osRelease: 'test',
    inDocker: true, timezone: 'Europe/Amsterdam', locale: 'nl-NL', gitCommit: null, gitDirty: null, appVersion: '1.0.0',
  },
  browser: null,
  config: {
    viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
    observeHomepageMs: 1000, observeExerciseMs: 1000, recordVideo: false, recordTrace: false, recordHar: false,
    interactive: false, navigateToExercise: true,
  },
  trackerDataset: {
    available: false, name: 'none', version: 'n/a', commit: null, sourceUrl: null,
    sha256: null, retrievedAt: null, entryCount: null, note: null,
  },
  runIds: [],
  notes: [],
};

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-resume-'));
  config.resultsDir = tempDir;
  saveAudit(audit);
  for (const [siteId, condition, repetition] of [
    ['spellingoefenen', 'reject_all', 1],
    ['spellingoefenen', 'reject_all', 2],
    ['spellingoefenen', 'accept_all', 1],
  ] as const) {
    saveRun(auditId, makeRun({ auditId, siteId, condition, repetition }));
  }
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resuming an interrupted audit', () => {
  it('identifies exactly the runs that are still missing', () => {
    const done = new Set(listRuns(auditId).map((run) => runKey(run.siteId, run.condition, run.repetition)));
    expect(done.size).toBe(3);

    const missing: string[] = [];
    for (const site of getAudit(auditId)!.sites) {
      for (const condition of getAudit(auditId)!.conditions) {
        for (let repetition = 1; repetition <= getAudit(auditId)!.repetitions; repetition++) {
          const key = runKey(site, condition, repetition);
          if (!done.has(key)) missing.push(key);
        }
      }
    }
    expect(missing).toEqual([
      'spellingoefenen|accept_all|2',
      'taaloefenen|reject_all|1',
      'taaloefenen|reject_all|2',
      'taaloefenen|accept_all|1',
      'taaloefenen|accept_all|2',
    ]);
  });

  it('keeps the run key stable and distinct per repetition', () => {
    expect(runKey('a', 'reject_all', 1)).toBe('a|reject_all|1');
    expect(runKey('a', 'reject_all', 1)).not.toBe(runKey('a', 'reject_all', 2));
  });
});
