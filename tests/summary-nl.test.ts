import { describe, it, expect } from 'vitest';
import { buildPublicSummaryHtml } from '../src/report/summary-nl.js';
import { summarizeAudit } from '../src/report/aggregate.js';
import { TrackerClassifier } from '../src/trackers/dataset.js';
import { makeRun } from './helpers/makeRun.js';
import type { AuditMetadata } from '../src/types.js';

/**
 * The Dutch public summary is the document a non-technical reader will act on,
 * so the tests guard the properties that keep it honest: it draws no legal
 * conclusion, it never turns "could not be measured" into a zero, it names the
 * classification dataset, and its numbers are the ones the technical report
 * aggregated rather than a second, softer set.
 */

const classifier = new TrackerClassifier(null, {
  name: 'audit-adtech-list',
  version: '1.0.0',
  description: 'test',
  curatedAt: '2026-09-06',
  advertisingCategories: ['advertising_exchange'],
  domains: { 'doubleclick.net': ['advertising_exchange'] },
});

const audit: AuditMetadata = {
  auditId: 'nl-summary-audit',
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
  browser: { engine: 'chromium', channel: null, version: '141.0', isGoogleChromeStable: false, executablePath: null, headless: true, userAgent: 'test' },
  config: {
    viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
    observeHomepageMs: 15000, observeExerciseMs: 35000, recordVideo: false, recordTrace: true, recordHar: true,
    interactive: false, navigateToExercise: true,
  },
  trackerDataset: classifier.datasetInfo(),
  runIds: [],
  notes: [],
};

const runs = [
  makeRun({
    auditId: audit.auditId, condition: 'reject_all', repetition: 1, consent: { status: 'confirmed' },
    metrics: { uniqueThirdPartyDomains: 40, knownTrackerDomains: 33, storedCookies: 24, maxVisibleAdAreaFraction: 0.117, trackerClassificationAvailable: true },
  }),
  makeRun({
    auditId: audit.auditId, condition: 'reject_all', repetition: 2, consent: { status: 'confirmed' },
    metrics: { uniqueThirdPartyDomains: 44, knownTrackerDomains: 37, storedCookies: 26, maxVisibleAdAreaFraction: 0.117, trackerClassificationAvailable: true },
  }),
  makeRun({
    auditId: audit.auditId, condition: 'accept_all', repetition: 1, consent: { status: 'confirmed' },
    metrics: { uniqueThirdPartyDomains: 160, knownTrackerDomains: 120, storedCookies: 300, maxVisibleAdAreaFraction: 0.234, trackerClassificationAvailable: true },
  }),
  makeRun({
    auditId: audit.auditId, condition: 'no_choice', repetition: 1,
    metrics: { uniqueThirdPartyDomains: 9, storedCookies: 4, trackerClassificationAvailable: true },
  }),
];

function html(): string {
  const summary = summarizeAudit(audit, runs, classifier);
  return buildPublicSummaryHtml({ summary, runs, includeImages: false });
}

describe('Dutch public summary', () => {
  it('has the sections a lay reader needs, in Dutch', () => {
    const output = html();
    expect(output).toContain('lang="nl"');
    expect(output).toContain('Publiekssamenvatting');
    expect(output).toContain('In het kort');
    expect(output).toContain('Hoe is het gemeten?');
    expect(output).toContain('Wat betekent dit níet?');
    expect(output).toContain('Verantwoording');
  });

  it('draws no legal conclusion and says so explicitly', () => {
    const output = html();
    expect(output).toContain('geen oordeel');
    expect(output).toContain('juridische vraag');
    expect(output).not.toMatch(/is illegaal|overtreedt|in strijd met de wet|onrechtmatig/i);
  });

  it('names the dataset wherever a classification is used', () => {
    expect(html()).toContain('audit-adtech-list');
  });

  it('reports the same medians as the technical aggregation', () => {
    const output = html();
    // reject_all: 40 and 44 third-party domains -> median 42; cookies 24 and 26 -> 25.
    expect(output).toContain('42');
    expect(output).toContain('25');
    // accept_all cookies, for the side-by-side comparison.
    expect(output).toContain('300');
  });

  it('writes an unmeasured value as "niet gemeten", never as 0', () => {
    const bare = summarizeAudit({ ...audit, auditId: 'leeg', runIds: [] }, [], classifier);
    const output = buildPublicSummaryHtml({ summary: bare, runs: [], includeImages: false });
    expect(output).toContain('niet gemeten');
  });

  it('warns when a single repetition makes the figures one-off observations', () => {
    const single = summarizeAudit({ ...audit, repetitions: 1 }, runs, classifier);
    const output = buildPublicSummaryHtml({ summary: single, runs, includeImages: false });
    expect(output).toContain('losse waarnemingen');
  });

  it('keeps the limitations with the findings rather than hiding them at the back', () => {
    const output = html();
    // Matched on the headings, not the words: the glossary cross-references
    // "Verantwoording" earlier in the document.
    const beperkingen = output.indexOf('<h2>Wat betekent dit níet?</h2>');
    const verantwoording = output.indexOf('<h2>Verantwoording</h2>');
    expect(beperkingen).toBeGreaterThan(-1);
    expect(beperkingen).toBeLessThan(verantwoording);
    expect(output).toContain('Contact met een andere partij is niet hetzelfde als volgen');
  });
});
