import type { RunResult, RunMetrics, ConsentEvidence } from '../../src/types.js';

const EMPTY_METRICS: RunMetrics = {
  totalRequests: null,
  thirdPartyRequests: null,
  uniqueThirdPartyDomains: null,
  requestsBeforeConsentAction: null,
  thirdPartyDomainsBeforeConsentAction: null,
  knownTrackerDomains: null,
  advertisingDomains: null,
  storedCookies: null,
  thirdPartyStoredCookies: null,
  setCookieAttempts: null,
  blockedSetCookieAttempts: null,
  blockedCookieSends: null,
  localStorageEntries: null,
  sessionStorageEntries: null,
  indexedDbDatabases: null,
  serviceWorkers: null,
  thirdPartyFrames: null,
  visibleAdSlots: null,
  maxVisibleAdAreaFraction: null,
  adCreativeChanges: null,
  trackerClassificationAvailable: false,
};

let counter = 0;

/** Builds a minimal RunResult for unit tests. */
export function makeRun(overrides: Partial<Omit<RunResult, 'metrics' | 'consent'>> & {
  metrics?: Partial<RunMetrics>;
  consent?: Partial<ConsentEvidence>;
} = {}): RunResult {
  counter += 1;
  const { metrics, consent, ...rest } = overrides;
  return {
    runId: `run-${counter}`,
    auditId: 'audit-test',
    siteId: 'fixture',
    siteName: 'Fixture',
    startUrl: 'http://first-party.test/',
    condition: 'no_choice',
    repetition: 1,
    startedAt: '2026-09-06T10:00:00.000Z',
    finishedAt: '2026-09-06T10:01:00.000Z',
    durationMs: 60000,
    status: 'completed',
    environment: {
      node: 'v22', playwright: '1.63.0', platform: 'linux', arch: 'x64', osRelease: 'test',
      inDocker: false, timezone: 'Europe/Amsterdam', locale: 'nl-NL', gitCommit: null, gitDirty: null, appVersion: '1.0.0',
    },
    browser: {
      engine: 'chromium', channel: null, version: '0', isGoogleChromeStable: false,
      executablePath: null, headless: true, userAgent: 'test',
    },
    config: {
      viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
      observeHomepageMs: 1000, observeExerciseMs: 1000, recordVideo: false, recordTrace: false, recordHar: false,
      interactive: false, navigateToExercise: false,
    },
    consent: {
      status: 'not_attempted',
      bannerDetected: true,
      bannerDetectorUsed: 'test',
      actionRequested: 'no_choice',
      stepsExecuted: [],
      bannerDismissed: null,
      stateProbe: null,
      consentActionTRelMs: null,
      notes: [],
      ...consent,
    },
    exercise: { attempted: false, reached: null, url: null, stepsExecuted: [], notes: [] },
    timeline: [],
    requests: [],
    cookieSetAttempts: [],
    cookieCheckpoints: [],
    storageCheckpoints: [],
    frames: [],
    adObservations: [],
    screenshots: [],
    failures: [],
    consoleErrors: [],
    artifacts: { har: null, trace: null, video: null, screenshotDir: 'screenshots' },
    metrics: { ...EMPTY_METRICS, ...metrics },
    ...rest,
  };
}
