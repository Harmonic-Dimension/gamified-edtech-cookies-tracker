import { describe, it, expect } from 'vitest';
import { determineStatus, evaluateProbe } from '../src/audit/runner.js';
import { computeMetrics } from '../src/audit/metrics.js';
import { TrackerClassifier } from '../src/trackers/dataset.js';
import { makeRun } from './helpers/makeRun.js';

const classifier = new TrackerClassifier(null, null);

describe('run status', () => {
  it('marks a run failed when the page never loaded', () => {
    expect(
      determineStatus({ navigationOk: false, failures: [], consentStatus: 'not_attempted', condition: 'no_choice', exerciseAttempted: false, exerciseReached: null }),
    ).toBe('failed');
  });

  it('never labels a run "reject" when the reject action failed', () => {
    expect(
      determineStatus({ navigationOk: true, failures: [], consentStatus: 'failed', condition: 'reject_all', exerciseAttempted: true, exerciseReached: true }),
    ).toBe('failed');
    expect(
      determineStatus({ navigationOk: true, failures: [], consentStatus: 'no_banner', condition: 'reject_all', exerciseAttempted: false, exerciseReached: null }),
    ).toBe('failed');
  });

  it('marks a run partial when the consent state could not be confirmed', () => {
    expect(
      determineStatus({ navigationOk: true, failures: [], consentStatus: 'performed', condition: 'accept_all', exerciseAttempted: true, exerciseReached: true }),
    ).toBe('partial');
  });

  it('marks a run partial when the exercise was not reached', () => {
    expect(
      determineStatus({ navigationOk: true, failures: [], consentStatus: 'confirmed', condition: 'reject_all', exerciseAttempted: true, exerciseReached: false }),
    ).toBe('partial');
  });

  it('is completed only when everything worked', () => {
    expect(
      determineStatus({ navigationOk: true, failures: [], consentStatus: 'confirmed', condition: 'reject_all', exerciseAttempted: true, exerciseReached: true }),
    ).toBe('completed');
  });
});

describe('consent state bookkeeping', () => {
  it('confirms reject only when no purpose and no vendor consent is set', () => {
    expect(evaluateProbe({ purposeConsentsTrue: 0, purposeConsentsTotal: 11, vendorConsentsTrue: 0, error: null }, 'reject_all')).toBe(true);
    expect(evaluateProbe({ purposeConsentsTrue: 3, purposeConsentsTotal: 11, vendorConsentsTrue: 40, error: null }, 'reject_all')).toBe(false);
  });

  it('confirms accept only when essentially all purposes are consented', () => {
    expect(evaluateProbe({ purposeConsentsTrue: 11, purposeConsentsTotal: 11, vendorConsentsTrue: 700, error: null }, 'accept_all')).toBe(true);
    expect(evaluateProbe({ purposeConsentsTrue: 2, purposeConsentsTotal: 11, vendorConsentsTrue: 5, error: null }, 'accept_all')).toBe(false);
  });

  it('is inconclusive rather than false when the probe failed', () => {
    expect(evaluateProbe({ purposeConsentsTrue: null, purposeConsentsTotal: null, vendorConsentsTrue: null, error: 'no-__tcfapi' }, 'reject_all')).toBeNull();
  });
});

describe('metrics for failed measurements', () => {
  it('reports null, never 0, when a measurement did not happen', () => {
    const run = makeRun();
    const metrics = computeMetrics(run, classifier, {
      networkCaptured: false,
      cookiesCaptured: false,
      storageCaptured: false,
      adsCaptured: false,
    });
    expect(metrics.totalRequests).toBeNull();
    expect(metrics.storedCookies).toBeNull();
    expect(metrics.localStorageEntries).toBeNull();
    expect(metrics.visibleAdSlots).toBeNull();
    expect(metrics.blockedSetCookieAttempts).toBeNull();
    expect(metrics.knownTrackerDomains).toBeNull();
    expect(metrics.trackerClassificationAvailable).toBe(false);
  });

  it('reports 0 when the measurement succeeded and found nothing', () => {
    const run = makeRun({
      cookieCheckpoints: [{ label: 'final', tRelMs: 0, cookies: [] }],
      storageCheckpoints: [{ label: 'final', tRelMs: 0, origins: [{ origin: 'http://first-party.test', localStorage: [], sessionStorage: [], indexedDbDatabases: [], cacheStorageKeys: [], error: null }], serviceWorkers: [] }],
    });
    const metrics = computeMetrics(run, classifier, {
      networkCaptured: true,
      cookiesCaptured: true,
      storageCaptured: true,
      adsCaptured: false,
    });
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.storedCookies).toBe(0);
    expect(metrics.localStorageEntries).toBe(0);
  });

  it('keeps tracker counts unmeasured when the dataset is unavailable', () => {
    const run = makeRun({
      requests: [
        {
          id: 'r1', tRelMs: 0, wallClock: '', url: 'https://doubleclick.net/x', urlSha256: '', hostname: 'doubleclick.net',
          registrableDomain: 'doubleclick.net', isThirdParty: true, method: 'GET', resourceType: 'script', frameUrl: null,
          initiatorType: null, initiatorUrl: null, status: 200, responseMimeType: null, phase: 'pre_consent',
          beforeConsentAction: true, setCookieCount: 0, failure: null,
        },
      ],
    });
    const metrics = computeMetrics(run, classifier, { networkCaptured: true, cookiesCaptured: false, storageCaptured: false, adsCaptured: false });
    expect(metrics.thirdPartyRequests).toBe(1);
    expect(metrics.knownTrackerDomains).toBeNull();
  });
});
