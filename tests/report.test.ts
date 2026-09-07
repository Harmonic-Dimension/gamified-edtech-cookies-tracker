import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { config } from '../src/config.js';
import { saveAudit, saveRun, listRuns, getAudit } from '../src/store/store.js';
import { summarizeAudit } from '../src/report/aggregate.js';
import { buildReportHtml } from '../src/report/html.js';
import { generatePdfReport } from '../src/report/pdf.js';
import { streamAuditZip } from '../src/export/zip.js';
import { TrackerClassifier } from '../src/trackers/dataset.js';
import { makeRun } from './helpers/makeRun.js';
import type { AuditMetadata } from '../src/types.js';

const classifier = new TrackerClassifier(null, {
  name: 'audit-adtech-list',
  version: '1.0.0',
  description: 'test',
  curatedAt: '2026-09-06',
  advertisingCategories: ['advertising_exchange'],
  domains: { 'doubleclick.net': ['advertising_exchange'] },
});

const auditId = 'report-test-audit';
let tempDir: string;

const audit: AuditMetadata = {
  auditId,
  label: 'Test audit',
  startedAt: '2026-09-06T10:00:00.000Z',
  finishedAt: '2026-09-06T10:30:00.000Z',
  status: 'completed',
  sites: ['fixture'],
  conditions: ['no_choice', 'reject_all', 'accept_all'],
  repetitions: 2,
  environment: {
    node: 'v22', playwright: '1.63.0', platform: 'linux', arch: 'x64', osRelease: 'test',
    inDocker: true, timezone: 'Europe/Amsterdam', locale: 'nl-NL', gitCommit: 'abc123', gitDirty: false, appVersion: '1.0.0',
  },
  browser: { engine: 'chromium (Playwright bundled)', channel: null, version: '141.0', isGoogleChromeStable: false, executablePath: null, headless: true, userAgent: 'test' },
  config: {
    viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
    observeHomepageMs: 15000, observeExerciseMs: 35000, recordVideo: false, recordTrace: true, recordHar: true,
    interactive: false, navigateToExercise: true,
  },
  trackerDataset: classifier.datasetInfo(),
  runIds: [],
  notes: [],
};

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-'));
  config.resultsDir = tempDir;

  const request = (domain: string, before: boolean) => ({
    id: `${domain}-${before}`, tRelMs: 100, wallClock: '2026-09-06T10:00:01Z', url: `https://${domain}/x`,
    urlSha256: 'hash', hostname: domain, registrableDomain: domain, isThirdParty: domain !== 'fixture.test',
    method: 'GET', resourceType: 'script', frameUrl: null, initiatorType: null, initiatorUrl: null,
    status: 200, responseMimeType: null, phase: 'post_consent' as const, beforeConsentAction: before,
    setCookieCount: 0, failure: null,
  });

  const runs = [
    makeRun({
      auditId, condition: 'reject_all', repetition: 1, consent: { status: 'confirmed' },
      requests: [request('doubleclick.net', false), request('other.example', true)],
      metrics: { totalRequests: 2, thirdPartyRequests: 2, uniqueThirdPartyDomains: 2, knownTrackerDomains: 1, advertisingDomains: 1, storedCookies: 4, trackerClassificationAvailable: true },
    }),
    makeRun({
      auditId, condition: 'reject_all', repetition: 2, consent: { status: 'confirmed' },
      requests: [request('doubleclick.net', false)],
      metrics: { totalRequests: 1, thirdPartyRequests: 1, uniqueThirdPartyDomains: 1, knownTrackerDomains: 1, advertisingDomains: 1, storedCookies: 6, trackerClassificationAvailable: true },
    }),
    makeRun({
      auditId, condition: 'accept_all', repetition: 1, consent: { status: 'confirmed' },
      requests: [request('doubleclick.net', false), request('other.example', false)],
      metrics: { totalRequests: 9, thirdPartyRequests: 8, uniqueThirdPartyDomains: 2, knownTrackerDomains: 1, advertisingDomains: 1, storedCookies: 20, trackerClassificationAvailable: true },
    }),
    // A failed reject run: its zeros must never enter the aggregation.
    makeRun({
      auditId, condition: 'reject_all', repetition: 3, status: 'failed',
      consent: { status: 'failed', notes: ['Reject control not found on the settings layer.'] },
      failures: [{ stage: 'consent-action', message: 'reject button not found', fatal: false }],
      metrics: { totalRequests: 0, storedCookies: 0 },
    }),
    makeRun({ auditId, condition: 'no_choice', repetition: 1, metrics: { totalRequests: 3, uniqueThirdPartyDomains: 1, storedCookies: 2, trackerClassificationAvailable: true } }),
  ];
  audit.runIds = runs.map((run) => run.runId);
  saveAudit(audit);
  for (const run of runs) saveRun(auditId, run);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('report aggregation', () => {
  it('aggregates only usable runs and keeps failures visible', () => {
    const summary = summarizeAudit(getAudit(auditId)!, listRuns(auditId), classifier);
    const site = summary.sites[0];
    const reject = site.conditions.find((condition) => condition.condition === 'reject_all')!;
    expect(reject.runCount).toBe(3);
    expect(reject.usableRunCount).toBe(2);
    expect(reject.metrics.totalRequests.median).toBe(1.5);
    expect(reject.metrics.storedCookies.min).toBe(4);
    expect(reject.failures.length).toBe(1);
    expect(summary.failedRuns).toBe(1);
  });

  it('reports domain presence across runs', () => {
    const summary = summarizeAudit(getAudit(auditId)!, listRuns(auditId), classifier);
    const reject = summary.sites[0].conditions.find((condition) => condition.condition === 'reject_all')!;
    const dc = reject.domains.find((domain) => domain.registrableDomain === 'doubleclick.net')!;
    expect(dc.runsPresent).toBe(2);
    expect(dc.totalRuns).toBe(2);
    expect(dc.classification.label).toBe('advertising_related');
    const other = reject.domains.find((domain) => domain.registrableDomain === 'other.example')!;
    expect(other.runsPresent).toBe(1);
    expect(other.seenBeforeConsentAction).toBe(true);
  });
});

describe('report HTML', () => {
  it('contains the required sections and cautious wording', () => {
    const summary = summarizeAudit(getAudit(auditId)!, listRuns(auditId), classifier);
    const html = buildReportHtml({ summary, runs: listRuns(auditId), includeScreenshots: false });
    expect(html).toContain('Privacy and Advertising Audit of Educational Practice Websites');
    expect(html).toContain('Method');
    expect(html).toContain('Important limitations');
    expect(html).toContain('Observations');
    expect(html).toContain('Measurement problems');
    expect(html).toContain('not automatically unlawful tracking');
    expect(html).toContain('audit-adtech-list');
    expect(html).not.toMatch(/illegal|unlawfully tracked|breaks the law/i);
  });

  it('derives notable observations from the measurements, without judgement', () => {
    const summary = summarizeAudit(getAudit(auditId)!, listRuns(auditId), classifier);
    const html = buildReportHtml({ summary, runs: listRuns(auditId), includeScreenshots: false });
    expect(html).toContain('Notable observations');
    // Check the generated observations themselves: descriptive, never a legal
    // conclusion. (The surrounding report does mention lawfulness — to disclaim it.)
    const start = html.indexOf('<h3>Notable observations</h3>');
    const section = html.slice(start, html.indexOf('<h', start + 30));
    expect(section).toContain('After choosing "reject all"');
    expect(section).not.toMatch(/violat|unlawful|illegal|breach of|should not|must not/i);
  });

  it('renders unmeasured values as "not measured" rather than 0', () => {
    const emptyAudit = { ...audit, auditId: 'empty', runIds: [] };
    const summary = summarizeAudit(emptyAudit, [], classifier);
    const html = buildReportHtml({ summary, runs: [], includeScreenshots: false });
    expect(html).toContain('not measured');
  });
});

describe('PDF generation', () => {
  it('produces a valid PDF file', async () => {
    const file = await generatePdfReport(auditId, path.join(tempDir, 'out.pdf'));
    const buffer = fs.readFileSync(file);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(10_000);
  }, 180_000);
});

describe('raw export', () => {
  it('produces a ZIP with the documented layout', async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await streamAuditZip(auditId, sink);
    const zip = Buffer.concat(chunks).toString('latin1');
    expect(zip.slice(0, 2)).toBe('PK');
    for (const entry of ['audit/metadata.json', 'audit/summary.json', 'audit/summary.csv', 'audit/domains.csv', 'audit/README.md', 'requests.csv', 'cookies.json', 'storage.json', 'frames.json']) {
      expect(zip).toContain(entry);
    }
  }, 120_000);
});
