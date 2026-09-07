import type {
  AuditMetadata,
  ConsentCondition,
  DomainClassification,
  RunMetrics,
  RunResult,
} from '../types.js';
import { CONSENT_CONDITIONS } from '../types.js';
import type { TrackerClassifier } from '../trackers/dataset.js';

/**
 * Aggregation for dashboard and report.
 *
 * Programmatic advertising is variable, so a single run is never presented as
 * definitive: every metric is summarised as min / median / max over the runs
 * that actually measured it, and every third-party domain carries a
 * "seen in N of M runs" presence count.
 */

export interface MetricStats {
  values: Array<number | null>;
  measuredRuns: number;
  totalRuns: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

export interface DomainPresence {
  registrableDomain: string;
  classification: DomainClassification;
  runsPresent: number;
  totalRuns: number;
  requestsPerRun: number[];
  totalRequests: number;
  seenBeforeConsentAction: boolean;
  cookieSetAttempts: number;
  blockedCookieAttempts: number;
  storedCookies: number;
}

export interface ConditionSummary {
  condition: ConsentCondition;
  runIds: string[];
  runCount: number;
  usableRunCount: number;
  statusCounts: Record<string, number>;
  consentStatusCounts: Record<string, number>;
  exerciseReachedCount: number;
  exerciseFailedCount: number;
  metrics: Record<keyof RunMetrics, MetricStats>;
  domains: DomainPresence[];
  failures: Array<{ runId: string; stage: string; message: string; fatal: boolean }>;
}

export interface SiteSummary {
  siteId: string;
  siteName: string;
  startUrl: string;
  conditions: ConditionSummary[];
  totalRuns: number;
  latestRunAt: string | null;
}

export interface AuditSummary {
  audit: AuditMetadata;
  generatedAt: string;
  sites: SiteSummary[];
  totalRuns: number;
  failedRuns: number;
  partialRuns: number;
}

const NUMERIC_METRIC_KEYS: Array<keyof RunMetrics> = [
  'totalRequests',
  'thirdPartyRequests',
  'uniqueThirdPartyDomains',
  'requestsBeforeConsentAction',
  'thirdPartyDomainsBeforeConsentAction',
  'knownTrackerDomains',
  'advertisingDomains',
  'storedCookies',
  'thirdPartyStoredCookies',
  'setCookieAttempts',
  'blockedSetCookieAttempts',
  'blockedCookieSends',
  'localStorageEntries',
  'sessionStorageEntries',
  'indexedDbDatabases',
  'serviceWorkers',
  'thirdPartyFrames',
  'visibleAdSlots',
  'maxVisibleAdAreaFraction',
  'adCreativeChanges',
];

export function summarizeAudit(
  audit: AuditMetadata,
  runs: RunResult[],
  classifier: TrackerClassifier,
): AuditSummary {
  const siteIds = [...new Set([...audit.sites, ...runs.map((r) => r.siteId)])];
  const sites: SiteSummary[] = siteIds.map((siteId) => {
    const siteRuns = runs.filter((run) => run.siteId === siteId);
    const conditions = (audit.conditions ?? CONSENT_CONDITIONS).map((condition) =>
      summarizeCondition(condition, siteRuns.filter((run) => run.condition === condition), classifier),
    );
    return {
      siteId,
      siteName: siteRuns[0]?.siteName ?? siteId,
      startUrl: siteRuns[0]?.startUrl ?? '',
      conditions,
      totalRuns: siteRuns.length,
      latestRunAt: siteRuns.length ? siteRuns.map((r) => r.finishedAt).sort().slice(-1)[0] : null,
    };
  });

  return {
    audit,
    generatedAt: new Date().toISOString(),
    sites,
    totalRuns: runs.length,
    failedRuns: runs.filter((r) => r.status === 'failed').length,
    partialRuns: runs.filter((r) => r.status === 'partial').length,
  };
}

export function summarizeCondition(
  condition: ConsentCondition,
  runs: RunResult[],
  classifier: TrackerClassifier,
): ConditionSummary {
  const statusCounts: Record<string, number> = {};
  const consentStatusCounts: Record<string, number> = {};
  for (const run of runs) {
    statusCounts[run.status] = (statusCounts[run.status] ?? 0) + 1;
    consentStatusCounts[run.consent.status] = (consentStatusCounts[run.consent.status] ?? 0) + 1;
  }

  // A run only contributes to the measurements of its condition when the
  // condition was actually established (or, for "no choice", when the page
  // loaded at all).
  const usableRuns = runs.filter((run) => isUsable(run));

  const metrics = {} as Record<keyof RunMetrics, MetricStats>;
  for (const key of NUMERIC_METRIC_KEYS) {
    metrics[key] = statsFor(usableRuns, key);
  }
  metrics.trackerClassificationAvailable = {
    values: usableRuns.map((run) => (run.metrics.trackerClassificationAvailable ? 1 : 0)),
    measuredRuns: usableRuns.length,
    totalRuns: runs.length,
    min: null,
    median: null,
    max: null,
  };

  return {
    condition,
    runIds: runs.map((run) => run.runId),
    runCount: runs.length,
    usableRunCount: usableRuns.length,
    statusCounts,
    consentStatusCounts,
    exerciseReachedCount: runs.filter((run) => run.exercise.reached === true).length,
    exerciseFailedCount: runs.filter((run) => run.exercise.reached === false).length,
    metrics,
    domains: domainPresence(usableRuns, classifier),
    failures: runs.flatMap((run) =>
      run.failures.map((failure) => ({
        runId: run.runId,
        stage: failure.stage,
        message: failure.message,
        fatal: failure.fatal,
      })),
    ),
  };
}

/** A run is usable as evidence for its condition only if the condition held. */
export function isUsable(run: RunResult): boolean {
  if (run.status === 'failed') return false;
  if (run.condition === 'no_choice') return true;
  return run.consent.status === 'confirmed' || run.consent.status === 'performed';
}

export function statsFor(runs: RunResult[], key: keyof RunMetrics): MetricStats {
  const values = runs.map((run) => {
    const value = run.metrics[key];
    return typeof value === 'number' ? value : null;
  });
  const measured = values.filter((value): value is number => value != null);
  return {
    values,
    measuredRuns: measured.length,
    totalRuns: runs.length,
    min: measured.length ? Math.min(...measured) : null,
    median: measured.length ? median(measured) : null,
    max: measured.length ? Math.max(...measured) : null,
  };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100;
}

export function domainPresence(runs: RunResult[], classifier: TrackerClassifier): DomainPresence[] {
  const byDomain = new Map<string, DomainPresence>();
  for (const run of runs) {
    const perRunCounts = new Map<string, number>();
    for (const request of run.requests) {
      if (request.isThirdParty !== true || !request.registrableDomain) continue;
      perRunCounts.set(request.registrableDomain, (perRunCounts.get(request.registrableDomain) ?? 0) + 1);
    }
    const beforeConsentDomains = new Set(
      run.requests
        .filter((request) => request.beforeConsentAction && request.isThirdParty === true && request.registrableDomain)
        .map((request) => request.registrableDomain as string),
    );
    for (const [domain, count] of perRunCounts) {
      let entry = byDomain.get(domain);
      if (!entry) {
        entry = {
          registrableDomain: domain,
          classification: classifier.classify(domain),
          runsPresent: 0,
          totalRuns: runs.length,
          requestsPerRun: [],
          totalRequests: 0,
          seenBeforeConsentAction: false,
          cookieSetAttempts: 0,
          blockedCookieAttempts: 0,
          storedCookies: 0,
        };
        byDomain.set(domain, entry);
      }
      entry.runsPresent += 1;
      entry.requestsPerRun.push(count);
      entry.totalRequests += count;
      if (beforeConsentDomains.has(domain)) entry.seenBeforeConsentAction = true;
    }
    for (const attempt of run.cookieSetAttempts) {
      const domain = attempt.registrableDomain ?? attempt.requestDomain;
      if (!domain) continue;
      const entry = byDomain.get(domain);
      if (!entry) continue;
      if (attempt.source === 'response') entry.cookieSetAttempts += 1;
      if (attempt.blocked) entry.blockedCookieAttempts += 1;
    }
    const finalCookies = run.cookieCheckpoints[run.cookieCheckpoints.length - 1];
    for (const cookie of finalCookies?.cookies ?? []) {
      if (!cookie.registrableDomain) continue;
      const entry = byDomain.get(cookie.registrableDomain);
      if (entry) entry.storedCookies += 1;
    }
  }
  for (const entry of byDomain.values()) entry.totalRuns = runs.length;
  return [...byDomain.values()].sort((a, b) => {
    if (b.runsPresent !== a.runsPresent) return b.runsPresent - a.runsPresent;
    return b.totalRequests - a.totalRequests;
  });
}

export interface TimelineBucket {
  fromMs: number;
  toMs: number;
  thirdPartyRequests: number;
  distinctDomains: number;
}

/**
 * Third-party request activity around the moment of the consent decision,
 * bucketed in fixed intervals. Times are relative to the consent action; for
 * runs without a consent action (condition A) they are relative to page load.
 */
export function consentTimeline(
  run: RunResult,
  options: { bucketMs?: number; beforeMs?: number; afterMs?: number } = {},
): { anchorTRelMs: number; anchoredOn: 'consent_action' | 'page_load'; buckets: TimelineBucket[] } {
  const bucketMs = options.bucketMs ?? 5000;
  const beforeMs = options.beforeMs ?? 15000;
  const afterMs = options.afterMs ?? 30000;
  const anchor = run.consent.consentActionTRelMs;
  const anchorTRelMs = anchor ?? 0;
  const buckets: TimelineBucket[] = [];
  for (let start = -beforeMs; start < afterMs; start += bucketMs) {
    const from = anchorTRelMs + start;
    const to = from + bucketMs;
    const inBucket = run.requests.filter(
      (request) => request.isThirdParty === true && request.tRelMs >= from && request.tRelMs < to,
    );
    buckets.push({
      fromMs: start,
      toMs: start + bucketMs,
      thirdPartyRequests: inBucket.length,
      distinctDomains: new Set(inBucket.map((request) => request.registrableDomain).filter(Boolean)).size,
    });
  }
  return { anchorTRelMs, anchoredOn: anchor == null ? 'page_load' : 'consent_action', buckets };
}

/** Convenience for the "reject vs accept" comparison used everywhere. */
export function compareConditions(
  site: SiteSummary,
  key: keyof RunMetrics,
): { reject: MetricStats | null; accept: MetricStats | null; noChoice: MetricStats | null } {
  const find = (condition: ConsentCondition) =>
    site.conditions.find((c) => c.condition === condition)?.metrics[key] ?? null;
  return {
    reject: find('reject_all'),
    accept: find('accept_all'),
    noChoice: find('no_choice'),
  };
}

export const METRIC_LABELS: Record<string, string> = {
  totalRequests: 'Total network requests',
  thirdPartyRequests: 'Third-party requests',
  uniqueThirdPartyDomains: 'Unique third-party domains',
  requestsBeforeConsentAction: 'Requests before the consent action',
  thirdPartyDomainsBeforeConsentAction: 'Third-party domains before the consent action',
  knownTrackerDomains: 'Domains classified as tracker/advertising',
  advertisingDomains: 'Domains classified as advertising-related',
  storedCookies: 'Cookies stored in the browser',
  thirdPartyStoredCookies: 'Third-party stored cookies',
  setCookieAttempts: 'Set-Cookie attempts observed',
  blockedSetCookieAttempts: 'Set-Cookie attempts blocked by the browser',
  blockedCookieSends: 'Cookies the browser refused to send',
  localStorageEntries: 'localStorage entries',
  sessionStorageEntries: 'sessionStorage entries',
  indexedDbDatabases: 'IndexedDB databases',
  serviceWorkers: 'Service workers',
  thirdPartyFrames: 'Third-party frames',
  visibleAdSlots: 'Visible advertising slots',
  maxVisibleAdAreaFraction: 'Share of the viewport occupied by advertising',
  adCreativeChanges: 'Observed advertisement changes during the run',
};

export const CONDITION_LABELS: Record<ConsentCondition, string> = {
  no_choice: 'A. No consent choice',
  reject_all: 'B. Reject all',
  accept_all: 'C. Accept all',
};
