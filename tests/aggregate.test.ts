import { describe, it, expect } from 'vitest';
import { median, statsFor, summarizeCondition, isUsable, domainPresence, consentTimeline } from '../src/report/aggregate.js';
import { TrackerClassifier } from '../src/trackers/dataset.js';
import { makeRun } from './helpers/makeRun.js';

const classifier = new TrackerClassifier(null, {
  name: 'audit-adtech-list',
  version: '1.0.0',
  description: 'test',
  curatedAt: '2026-09-06',
  advertisingCategories: ['advertising_exchange'],
  domains: { 'doubleclick.net': ['advertising_exchange'] },
});

describe('statistics', () => {
  it('computes the median for odd and even sample counts', () => {
    expect(median([82, 91, 85])).toBe(85);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('ignores unmeasured runs instead of treating them as zero', () => {
    const runs = [
      makeRun({ metrics: { totalRequests: 10 } }),
      makeRun({ metrics: { totalRequests: null } }),
      makeRun({ metrics: { totalRequests: 20 } }),
    ];
    const stats = statsFor(runs, 'totalRequests');
    expect(stats.measuredRuns).toBe(2);
    expect(stats.totalRuns).toBe(3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(20);
    expect(stats.median).toBe(15);
    expect(stats.values).toEqual([10, null, 20]);
  });

  it('returns null statistics when nothing was measured', () => {
    const stats = statsFor([makeRun({ metrics: { totalRequests: null } })], 'totalRequests');
    expect(stats.median).toBeNull();
    expect(stats.measuredRuns).toBe(0);
  });
});

describe('usability of runs as evidence', () => {
  it('excludes failed runs and runs whose consent action failed', () => {
    expect(isUsable(makeRun({ status: 'failed' }))).toBe(false);
    expect(isUsable(makeRun({ condition: 'reject_all', consent: { status: 'failed' } }))).toBe(false);
    expect(isUsable(makeRun({ condition: 'reject_all', consent: { status: 'no_banner' } }))).toBe(false);
    expect(isUsable(makeRun({ condition: 'reject_all', consent: { status: 'confirmed' } }))).toBe(true);
    expect(isUsable(makeRun({ condition: 'reject_all', consent: { status: 'performed' } }))).toBe(true);
    expect(isUsable(makeRun({ condition: 'no_choice', consent: { status: 'not_attempted' } }))).toBe(true);
  });

  it('keeps unusable runs visible in the condition summary', () => {
    const summary = summarizeCondition(
      'reject_all',
      [
        makeRun({ condition: 'reject_all', consent: { status: 'confirmed' }, metrics: { totalRequests: 50 } }),
        makeRun({ condition: 'reject_all', consent: { status: 'failed' }, status: 'failed', metrics: { totalRequests: 0 } }),
      ],
      classifier,
    );
    expect(summary.runCount).toBe(2);
    expect(summary.usableRunCount).toBe(1);
    expect(summary.metrics.totalRequests.median).toBe(50);
    expect(summary.consentStatusCounts.failed).toBe(1);
  });
});

describe('domain presence', () => {
  it('counts in how many runs each third-party domain appeared', () => {
    const run = (domains: string[]) =>
      makeRun({
        requests: domains.map((domain, index) => ({
          id: `r${index}`,
          tRelMs: 100,
          wallClock: '2026-09-06T00:00:00Z',
          url: `https://${domain}/x`,
          urlSha256: 'hash',
          hostname: domain,
          registrableDomain: domain,
          isThirdParty: true,
          method: 'GET',
          resourceType: 'script',
          frameUrl: null,
          initiatorType: null,
          initiatorUrl: null,
          status: 200,
          responseMimeType: null,
          phase: 'post_consent' as const,
          beforeConsentAction: false,
          setCookieCount: 0,
          failure: null,
        })),
      });
    const presence = domainPresence(
      [run(['doubleclick.net', 'a.example']), run(['doubleclick.net']), run(['doubleclick.net', 'b.example'])],
      classifier,
    );
    const dc = presence.find((entry) => entry.registrableDomain === 'doubleclick.net');
    expect(dc?.runsPresent).toBe(3);
    expect(dc?.totalRuns).toBe(3);
    expect(dc?.classification.label).toBe('advertising_related');
    const rare = presence.find((entry) => entry.registrableDomain === 'a.example');
    expect(rare?.runsPresent).toBe(1);
    expect(rare?.totalRuns).toBe(3);
  });
});

describe('timeline around the consent decision', () => {
  const request = (tRelMs: number, domain: string) => ({
    id: `${domain}-${tRelMs}`, tRelMs, wallClock: '', url: `https://${domain}/x`, urlSha256: '',
    hostname: domain, registrableDomain: domain, isThirdParty: true, method: 'GET', resourceType: 'script',
    frameUrl: null, initiatorType: null, initiatorUrl: null, status: 200, responseMimeType: null,
    phase: 'pre_consent' as const, beforeConsentAction: true, setCookieCount: 0, failure: null,
  });

  it('buckets third-party activity relative to the consent action', () => {
    const run = makeRun({
      condition: 'reject_all',
      consent: { status: 'confirmed', consentActionTRelMs: 20_000 },
      requests: [request(17_000, 'a.example'), request(18_000, 'b.example'), request(23_000, 'c.example')],
    });
    const { anchoredOn, buckets } = consentTimeline(run);
    expect(anchoredOn).toBe('consent_action');
    const before = buckets.find((bucket) => bucket.fromMs === -5000)!;
    expect(before.thirdPartyRequests).toBe(2);
    expect(before.distinctDomains).toBe(2);
    const after = buckets.find((bucket) => bucket.fromMs === 0)!;
    expect(after.thirdPartyRequests).toBe(1);
  });

  it('anchors on page load when no consent action was taken', () => {
    const run = makeRun({ condition: 'no_choice', requests: [request(1000, 'a.example')] });
    const { anchoredOn, buckets } = consentTimeline(run);
    expect(anchoredOn).toBe('page_load');
    expect(buckets.find((bucket) => bucket.fromMs === 0)!.thirdPartyRequests).toBe(1);
  });
});
