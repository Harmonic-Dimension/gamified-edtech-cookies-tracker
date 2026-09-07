import type { RunResult, RunMetrics, CookieCheckpoint, StorageCheckpoint } from '../types.js';
import type { TrackerClassifier } from '../trackers/dataset.js';
import { countCreativeChanges, distinctVisibleSlots } from './adslots.js';

/**
 * Derives the per-run summary numbers.
 *
 * Rule: a metric is `null` when the corresponding measurement did not happen or
 * failed. It is 0 only when the measurement succeeded and genuinely found
 * nothing. The dashboard and PDF render null as "not measured".
 */
export function computeMetrics(
  run: Omit<RunResult, 'metrics'>,
  classifier: TrackerClassifier,
  options: { networkCaptured: boolean; cookiesCaptured: boolean; storageCaptured: boolean; adsCaptured: boolean },
): RunMetrics {
  const finalCookies = lastCheckpoint(run.cookieCheckpoints);
  const finalStorage = lastStorageCheckpoint(run.storageCheckpoints);

  const thirdPartyRequests = options.networkCaptured
    ? run.requests.filter((r) => r.isThirdParty === true)
    : null;
  const thirdPartyDomains = thirdPartyRequests
    ? new Set(thirdPartyRequests.map((r) => r.registrableDomain).filter((d): d is string => Boolean(d)))
    : null;

  const beforeConsent = options.networkCaptured ? run.requests.filter((r) => r.beforeConsentAction) : null;
  const beforeConsentThirdPartyDomains = beforeConsent
    ? new Set(
        beforeConsent
          .filter((r) => r.isThirdParty === true)
          .map((r) => r.registrableDomain)
          .filter((d): d is string => Boolean(d)),
      )
    : null;

  let knownTrackerDomains: number | null = null;
  let advertisingDomains: number | null = null;
  if (thirdPartyDomains && classifier.available) {
    knownTrackerDomains = 0;
    advertisingDomains = 0;
    for (const domain of thirdPartyDomains) {
      const classification = classifier.classify(domain);
      if (classification.label === 'known_tracker' || classification.label === 'advertising_related') {
        knownTrackerDomains += 1;
      }
      if (classification.label === 'advertising_related') advertisingDomains += 1;
    }
  }

  const localStorageEntries = countStorage(finalStorage, 'localStorage');
  const sessionStorageEntries = countStorage(finalStorage, 'sessionStorage');
  const indexedDb = finalStorage
    ? finalStorage.origins.reduce<number | null>((acc, origin) => {
        if (origin.indexedDbDatabases == null) return acc;
        return (acc ?? 0) + origin.indexedDbDatabases.length;
      }, null)
    : null;

  const adObservations = options.adsCaptured ? run.adObservations.filter((o) => o.error == null) : [];
  const visibleAdSlots = adObservations.length
    ? Math.max(...adObservations.map((o) => distinctVisibleSlots(o.slots).length))
    : null;
  const maxVisibleAdAreaFraction = adObservations.length
    ? Math.max(...adObservations.map((o) => o.visibleAdAreaFraction))
    : null;

  return {
    totalRequests: options.networkCaptured ? run.requests.length : null,
    thirdPartyRequests: thirdPartyRequests ? thirdPartyRequests.length : null,
    uniqueThirdPartyDomains: thirdPartyDomains ? thirdPartyDomains.size : null,
    requestsBeforeConsentAction: beforeConsent ? beforeConsent.length : null,
    thirdPartyDomainsBeforeConsentAction: beforeConsentThirdPartyDomains ? beforeConsentThirdPartyDomains.size : null,
    knownTrackerDomains,
    advertisingDomains,
    storedCookies: options.cookiesCaptured && finalCookies ? finalCookies.cookies.length : null,
    thirdPartyStoredCookies:
      options.cookiesCaptured && finalCookies
        ? finalCookies.cookies.filter((c) => c.isThirdParty === true).length
        : null,
    setCookieAttempts: options.networkCaptured ? run.cookieSetAttempts.filter((a) => a.source === 'response').length : null,
    blockedSetCookieAttempts: options.networkCaptured
      ? run.cookieSetAttempts.filter((a) => a.source === 'response' && a.blocked).length
      : null,
    blockedCookieSends: options.networkCaptured
      ? run.cookieSetAttempts.filter((a) => a.source === 'request' && a.blocked).length
      : null,
    localStorageEntries,
    sessionStorageEntries,
    indexedDbDatabases: indexedDb,
    serviceWorkers: finalStorage ? finalStorage.serviceWorkers.length : null,
    thirdPartyFrames: options.networkCaptured ? run.frames.filter((f) => f.isThirdParty === true).length : null,
    visibleAdSlots,
    maxVisibleAdAreaFraction,
    adCreativeChanges: countCreativeChanges(run.adObservations),
    trackerClassificationAvailable: classifier.available,
  };
}

function lastCheckpoint(checkpoints: CookieCheckpoint[]): CookieCheckpoint | null {
  return checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
}

function lastStorageCheckpoint(checkpoints: StorageCheckpoint[]): StorageCheckpoint | null {
  return checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
}

function countStorage(checkpoint: StorageCheckpoint | null, kind: 'localStorage' | 'sessionStorage'): number | null {
  if (!checkpoint) return null;
  let total: number | null = null;
  for (const origin of checkpoint.origins) {
    const entries = origin[kind];
    if (entries == null) continue;
    total = (total ?? 0) + entries.length;
  }
  return total;
}
