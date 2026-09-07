import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer, type FixtureServer } from '../fixtures/site/server.js';
import { fixtureSiteDefinition } from '../src/sites/definitions.js';
import { runSingleAudit } from '../src/audit/runner.js';
import { TrackerClassifier } from '../src/trackers/dataset.js';
import { config } from '../src/config.js';
import type { RunResult } from '../src/types.js';

/**
 * End-to-end test of the audit engine against the local fixture site.
 * No live educational website is contacted.
 */

const classifier = new TrackerClassifier(null, {
  name: 'audit-adtech-list',
  version: 'test',
  description: 'test',
  curatedAt: '2026-09-06',
  advertisingCategories: ['advertising_exchange'],
  domains: { 'adnetwork.test': ['advertising_exchange'] },
});

let fixture: FixtureServer;
let tempDir: string;
const auditId = 'fixture-audit';

async function runCondition(condition: 'no_choice' | 'reject_all' | 'accept_all'): Promise<RunResult> {
  return runSingleAudit({
    auditId,
    site: fixtureSiteDefinition(fixture.baseUrl),
    condition,
    repetition: 1,
    classifier,
    headless: true,
    browserChannel: null,
    extraBrowserArgs: [fixture.hostResolverRule],
    observeHomepageMs: 3000,
    observeExerciseMs: 3000,
    recordHar: true,
    recordTrace: false,
    recordVideo: false,
    navigateToExercise: true,
    log: () => undefined,
  });
}

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  config.resultsDir = tempDir;
});

afterAll(async () => {
  await fixture?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('audit engine against the fixture site', () => {
  let reject: RunResult;
  let accept: RunResult;
  let noChoice: RunResult;

  beforeAll(async () => {
    noChoice = await runCondition('no_choice');
    reject = await runCondition('reject_all');
    accept = await runCondition('accept_all');
  });

  it('starts every run in a clean, isolated context', () => {
    for (const run of [noChoice, reject, accept]) {
      expect(run.failures.filter((failure) => failure.stage === 'context-isolation')).toHaveLength(0);
      const preConsent = run.cookieCheckpoints[0];
      expect(preConsent).toBeDefined();
      // Only cookies set by this run's own page load may be present.
      for (const cookie of preConsent.cookies) {
        expect(['fixture_session', 'fixture_consent']).toContain(cookie.name);
      }
    }
  });

  it('records the run as evidence only when the consent action was confirmed', () => {
    expect(reject.consent.status).toBe('confirmed');
    expect(accept.consent.status).toBe('confirmed');
    expect(noChoice.consent.status).toBe('not_attempted');
    expect(reject.consent.stateProbe?.matchesRequestedCondition).toBe(true);
    expect(accept.consent.stateProbe?.matchesRequestedCondition).toBe(true);
  });

  it('separates first-party from third-party requests', () => {
    const thirdParty = reject.requests.filter((request) => request.isThirdParty === true);
    const firstParty = reject.requests.filter((request) => request.isThirdParty === false);
    expect(firstParty.length).toBeGreaterThan(0);
    expect(thirdParty.some((request) => request.registrableDomain === 'third-party.test')).toBe(true);
    expect(firstParty.every((request) => request.registrableDomain === 'first-party.test')).toBe(true);
  });

  it('records redirect hops with their status', () => {
    const redirect = noChoice.requests.find((request) => request.url.includes('redirect-pixel'));
    expect(redirect).toBeDefined();
    expect(redirect?.status).toBe(302);
    expect(noChoice.requests.some((request) => request.url.includes('event=redirected'))).toBe(true);
  });

  it('records third-party activity that happens before any consent choice', () => {
    const before = noChoice.requests.filter(
      (request) => request.beforeConsentAction && request.isThirdParty === true,
    );
    expect(before.length).toBeGreaterThan(0);
    expect(noChoice.metrics.thirdPartyDomainsBeforeConsentAction).toBeGreaterThan(0);
  });

  it('captures cookies that the browser blocked, with the browser reason', () => {
    const blockedSet = reject.cookieSetAttempts.filter(
      (attempt) => attempt.source === 'response' && attempt.blocked,
    );
    expect(blockedSet.length).toBeGreaterThan(0);
    expect(blockedSet[0].blockedReasons.length).toBeGreaterThan(0);
    expect(reject.metrics.blockedSetCookieAttempts).toBe(blockedSet.length);
    // Cookies that simply did not apply to a request (wrong domain/path) must
    // not be counted as "blocked".
    const scopeOnly = reject.cookieSetAttempts.filter(
      (attempt) => attempt.blocked && attempt.blockedReasons.every((reason) => reason === 'DomainMismatch'),
    );
    expect(scopeOnly).toHaveLength(0);
  });

  it('never stores raw cookie values', () => {
    const serialized = JSON.stringify(reject);
    expect(serialized).not.toContain('abc123456789');
    expect(serialized).not.toContain('s-0123456789abcdef');
    const cookie = reject.cookieCheckpoints.at(-1)?.cookies.find((entry) => entry.name === 'fixture_session');
    expect(cookie?.valueSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows more third-party activity after accepting than after rejecting', () => {
    expect(accept.metrics.thirdPartyRequests).toBeGreaterThan(reject.metrics.thirdPartyRequests!);
  });

  it('reaches the exercise page and keeps recording there', () => {
    expect(reject.exercise.attempted).toBe(true);
    expect(reject.exercise.reached).toBe(true);
    expect(reject.requests.some((request) => request.phase === 'exercise')).toBe(true);
  });

  it('captures browser storage', () => {
    const storage = reject.storageCheckpoints.at(-1);
    const origin = storage?.origins.find((entry) => entry.origin.includes('first-party.test'));
    expect(origin?.localStorage?.some((entry) => entry.key === 'fixture_visit')).toBe(true);
    expect(reject.metrics.localStorageEntries).toBeGreaterThan(0);
  });

  it('writes screenshots and a HAR file to disk', () => {
    const dir = path.join(tempDir, auditId, 'runs', reject.runId);
    expect(reject.screenshots.length).toBeGreaterThan(2);
    for (const shot of reject.screenshots) {
      expect(fs.existsSync(path.join(dir, shot.file))).toBe(true);
    }
    expect(reject.artifacts.har).toBe('network.har');
    const har = JSON.parse(fs.readFileSync(path.join(dir, 'network.har'), 'utf8'));
    expect(har.log.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(har)).not.toContain('abc123456789');
  });

  it('measures visible advertising surface', () => {
    expect(accept.metrics.visibleAdSlots).toBeGreaterThan(0);
    expect(accept.metrics.maxVisibleAdAreaFraction).toBeGreaterThan(0);
    expect(accept.frames.some((frame) => frame.registrableDomain === 'adnetwork.test')).toBe(true);
  });

  it('records the browser it actually used', () => {
    expect(reject.browser.version).toMatch(/\d+/);
    expect(reject.browser.isGoogleChromeStable).toBe(false);
    expect(reject.browser.engine).toContain('chromium');
  });
});

describe('honest reporting of how far the exercise route got', () => {
  it('marks the exercise as not reached when verification fails, and says why', async () => {
    const base = fixtureSiteDefinition(fixture.baseUrl);
    const site = {
      ...base,
      exercise: {
        ...base.exercise!,
        verifySelector: '#this-selector-does-not-exist',
        limitation: 'This route cannot establish that the child is actually answering questions.',
      },
    };
    const run = await runSingleAudit({
      auditId, site, condition: 'reject_all', repetition: 98, classifier,
      headless: true, browserChannel: null, extraBrowserArgs: [fixture.hostResolverRule],
      observeHomepageMs: 1000, observeExerciseMs: 1000, recordHar: false, recordTrace: false,
      navigateToExercise: true, log: () => undefined,
    });

    expect(run.exercise.attempted).toBe(true);
    expect(run.exercise.reached).toBe(false);
    expect(run.status).toBe('partial');
    expect(run.exercise.notes.join(' ')).toContain('did not reach the expected exercise page');
  });

  it('copies a configured route limitation into every run', async () => {
    const base = fixtureSiteDefinition(fixture.baseUrl);
    const limitation = 'The activity is drawn in a canvas, so its selection screen cannot be operated.';
    const site = { ...base, exercise: { ...base.exercise!, limitation } };
    const run = await runSingleAudit({
      auditId, site, condition: 'reject_all', repetition: 97, classifier,
      headless: true, browserChannel: null, extraBrowserArgs: [fixture.hostResolverRule],
      observeHomepageMs: 1000, observeExerciseMs: 1000, recordHar: false, recordTrace: false,
      navigateToExercise: true, log: () => undefined,
    });
    expect(run.exercise.reached).toBe(true);
    expect(run.exercise.notes).toContain(limitation);
  });
});

describe('a run that hangs', () => {
  it('is abandoned by the watchdog and saved as a failed run with partial evidence', async () => {
    const base = fixtureSiteDefinition(fixture.baseUrl);
    // An adapter that never returns: without a watchdog this would stall the
    // whole audit forever.
    const site = {
      ...base,
      consent: {
        ...base.consent,
        reject: () => new Promise<never>(() => {}),
      },
    };
    const started = Date.now();
    const run = await runSingleAudit({
      auditId, site, condition: 'reject_all', repetition: 96, classifier,
      headless: true, browserChannel: null, extraBrowserArgs: [fixture.hostResolverRule],
      observeHomepageMs: 500, observeExerciseMs: 500, recordHar: false, recordTrace: false,
      navigateToExercise: true, maxRunMs: 8000, log: () => undefined,
    });

    expect(Date.now() - started).toBeLessThan(90_000);
    expect(run.status).toBe('failed');
    expect(run.failures.some((failure) => failure.stage === 'run-watchdog' && failure.fatal)).toBe(true);
    expect(run.failures.find((failure) => failure.stage === 'run-watchdog')?.message).toContain('time budget');
    // The evidence gathered before the hang is still there.
    expect(run.requests.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tempDir, auditId, 'runs', run.runId, 'run.json'))).toBe(true);
    // And it is never counted as a successful "reject" measurement.
    expect(run.consent.status).not.toBe('confirmed');
  });
});

describe('a run that crashes unexpectedly', () => {
  it('is still saved, marked failed, with the evidence collected so far', async () => {
    const broken = fixtureSiteDefinition(fixture.baseUrl);
    // An adapter that violates its contract: the runner must survive this and
    // record a failed run rather than losing the measurement entirely.
    const brokenSite = {
      ...broken,
      consent: {
        ...broken.consent,
        accept: async () => undefined as unknown as Awaited<ReturnType<typeof broken.consent.accept>>,
      },
    };
    const run = await runSingleAudit({
      auditId,
      site: brokenSite,
      condition: 'accept_all',
      repetition: 99,
      classifier,
      headless: true,
      browserChannel: null,
      extraBrowserArgs: [fixture.hostResolverRule],
      observeHomepageMs: 1000,
      observeExerciseMs: 1000,
      recordHar: false,
      recordTrace: false,
      navigateToExercise: true,
      log: () => undefined,
    });

    expect(run.status).toBe('failed');
    expect(run.failures.some((failure) => failure.stage === 'run-execution' && failure.fatal)).toBe(true);
    // Evidence gathered before the crash is preserved, not discarded.
    expect(run.requests.length).toBeGreaterThan(0);
    expect(run.screenshots.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tempDir, auditId, 'runs', run.runId, 'run.json'))).toBe(true);
  });
});
