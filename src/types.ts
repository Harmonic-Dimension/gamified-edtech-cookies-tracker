/**
 * Shared data model for the audit tool.
 *
 * Design rule that runs through this whole file: an audit either *measured*
 * something or it did not. Anything that could not be measured is represented
 * explicitly (null / 'unknown' / a failure record) and never silently as 0.
 */

export type ConsentCondition = 'no_choice' | 'reject_all' | 'accept_all';

export const CONSENT_CONDITIONS: ConsentCondition[] = ['no_choice', 'reject_all', 'accept_all'];

/** Outcome of the consent automation. Never assume success. */
export type ConsentStatus =
  | 'confirmed'      // action performed AND resulting state independently confirmed
  | 'performed'      // action performed, resulting state could not be confirmed
  | 'no_banner'      // no consent banner was detected at all
  | 'failed'         // the action was attempted and failed
  | 'not_attempted'; // condition A: deliberately no interaction

export type RunStatus = 'completed' | 'partial' | 'failed';

export interface BrowserIdentity {
  /** 'chromium' (Playwright build) or 'chrome' (Google Chrome Stable channel). */
  engine: string;
  /** Channel requested via configuration, if any. */
  channel: string | null;
  /** Version string reported by the launched browser itself. */
  version: string;
  /** Whether Google Chrome Stable was actually used. */
  isGoogleChromeStable: boolean;
  executablePath: string | null;
  headless: boolean;
  userAgent: string;
}

export interface EnvironmentInfo {
  node: string;
  playwright: string;
  platform: string;
  arch: string;
  osRelease: string;
  inDocker: boolean;
  timezone: string;
  locale: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  appVersion: string;
}

export interface RunConfigSnapshot {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  observeHomepageMs: number;
  observeExerciseMs: number;
  recordVideo: boolean;
  recordTrace: boolean;
  recordHar: boolean;
  interactive: boolean;
  navigateToExercise: boolean;
}

export interface RequestRecord {
  id: string;
  /** ms since navigation start of the run. */
  tRelMs: number;
  wallClock: string;
  url: string;            // sanitized
  urlSha256: string;      // hash of the *original* URL, so identity survives sanitization
  hostname: string;
  registrableDomain: string | null;
  isThirdParty: boolean | null;
  method: string;
  resourceType: string | null;
  frameUrl: string | null;      // sanitized
  initiatorType: string | null;
  initiatorUrl: string | null;  // sanitized
  status: number | null;
  responseMimeType: string | null;
  /** Consent phase in which the request was observed. */
  phase: RunPhase;
  /** True when observed strictly before the consent action was executed. */
  beforeConsentAction: boolean;
  setCookieCount: number;
  failure: string | null;
}

export type RunPhase =
  | 'pre_consent'        // page opened, consent decision not yet made
  | 'consent_action'     // during the click(s) on the consent UI
  | 'post_consent'       // after the consent decision, still on entry page
  | 'exercise'           // on the exercise/learning page
  | 'interactive';       // manual interaction window

export interface CookieSetAttempt {
  tRelMs: number;
  /** Where the attempt was seen: response Set-Cookie, or a request carrying cookies. */
  source: 'response' | 'request';
  name: string;
  domain: string | null;
  registrableDomain: string | null;
  path: string | null;
  valueLength: number;
  valueSha256: string;
  blocked: boolean;
  /** CDP-reported reasons, e.g. ThirdPartyPhaseout, SameSiteUnspecifiedTreatedAsLax. */
  blockedReasons: string[];
  requestUrl: string | null; // sanitized
  requestDomain: string | null;
  isThirdParty: boolean | null;
  phase: RunPhase;
  beforeConsentAction: boolean;
}

export interface StoredCookie {
  name: string;
  domain: string;
  registrableDomain: string | null;
  path: string;
  expires: number;               // -1 for session cookies
  expiresIso: string | null;
  lifetimeDays: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  hostOnly: boolean | null;
  valueLength: number;
  valueSha256: string;           // raw values are never persisted
  isThirdParty: boolean | null;
}

export interface CookieCheckpoint {
  label: string;
  tRelMs: number;
  cookies: StoredCookie[];
}

export interface StorageEntry {
  key: string;
  valueLength: number;
  valueSha256: string;
  valuePreview: string | null; // only for values that look non-identifying
}

export interface OriginStorage {
  origin: string;
  localStorage: StorageEntry[] | null;
  sessionStorage: StorageEntry[] | null;
  indexedDbDatabases: string[] | null;
  cacheStorageKeys: string[] | null;
  error: string | null;
}

export interface StorageCheckpoint {
  label: string;
  tRelMs: number;
  origins: OriginStorage[];
  serviceWorkers: string[];
}

export interface FrameRecord {
  frameUrl: string;       // sanitized
  frameDomain: string | null;
  registrableDomain: string | null;
  isThirdParty: boolean | null;
  name: string | null;
  firstSeenTRelMs: number;
  phase: RunPhase;
}

export interface AdSlotObservation {
  label: string;             // checkpoint label
  tRelMs: number;
  viewport: { width: number; height: number };
  slots: AdSlotBox[];
  /** Sum of visible slot areas in CSS px^2, in-viewport only. */
  visibleAdAreaPx: number;
  viewportAreaPx: number;
  visibleAdAreaFraction: number;
  error: string | null;
}

export interface AdSlotBox {
  /** How this element was recognised as advertising surface. */
  detector: string;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inViewport: boolean;
  iframeSrc: string | null;   // sanitized
  iframeDomain: string | null;
  /** Perceptual-ish fingerprint of the rendered slot, to detect rotation. */
  screenshotSha256: string | null;
}

export interface ScreenshotRecord {
  label: string;
  tRelMs: number;
  file: string;              // relative to run directory
  fullPage: boolean;
  viewport: { width: number; height: number };
  sha256: string;
}

export interface TimelineEvent {
  tRelMs: number;
  type: string;
  detail: string;
}

export interface RunFailure {
  stage: string;
  message: string;
  fatal: boolean;
}

export interface ConsentEvidence {
  status: ConsentStatus;
  bannerDetected: boolean | null;
  bannerDetectorUsed: string | null;
  actionRequested: ConsentCondition;
  stepsExecuted: string[];
  bannerDismissed: boolean | null;
  /** Independent probe of the resulting consent state (TCF / CMP API / cookies). */
  stateProbe: ConsentStateProbe | null;
  consentActionTRelMs: number | null;
  notes: string[];
}

export interface ConsentStateProbe {
  method: string;                 // e.g. 'tcf-v2:getTCData'
  gdprApplies: boolean | null;
  tcStringPresent: boolean | null;
  tcStringSha256: string | null;
  purposeConsentsTrue: number | null;
  purposeConsentsTotal: number | null;
  vendorConsentsTrue: number | null;
  vendorConsentsTotal: number | null;
  raw: Record<string, unknown> | null;
  matchesRequestedCondition: boolean | null;
  error: string | null;
}

export interface RunArtifacts {
  har: string | null;
  trace: string | null;
  video: string | null;
  screenshotDir: string;
}

export interface RunResult {
  runId: string;
  auditId: string;
  siteId: string;
  siteName: string;
  startUrl: string;
  condition: ConsentCondition;
  repetition: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: RunStatus;
  environment: EnvironmentInfo;
  browser: BrowserIdentity;
  config: RunConfigSnapshot;
  consent: ConsentEvidence;
  exercise: {
    attempted: boolean;
    reached: boolean | null;
    url: string | null;
    stepsExecuted: string[];
    notes: string[];
  };
  timeline: TimelineEvent[];
  requests: RequestRecord[];
  cookieSetAttempts: CookieSetAttempt[];
  cookieCheckpoints: CookieCheckpoint[];
  storageCheckpoints: StorageCheckpoint[];
  frames: FrameRecord[];
  adObservations: AdSlotObservation[];
  screenshots: ScreenshotRecord[];
  failures: RunFailure[];
  consoleErrors: string[];
  artifacts: RunArtifacts;
  metrics: RunMetrics;
}

/**
 * Per-run summary numbers. `null` means "could not be measured in this run" and
 * must be rendered as such (never as 0) in dashboard and report.
 */
export interface RunMetrics {
  totalRequests: number | null;
  thirdPartyRequests: number | null;
  uniqueThirdPartyDomains: number | null;
  requestsBeforeConsentAction: number | null;
  thirdPartyDomainsBeforeConsentAction: number | null;
  knownTrackerDomains: number | null;
  advertisingDomains: number | null;
  storedCookies: number | null;
  thirdPartyStoredCookies: number | null;
  setCookieAttempts: number | null;
  /** Set-Cookie responses the browser refused to store. */
  blockedSetCookieAttempts: number | null;
  /** Cookies the browser refused to send with a request for policy reasons. */
  blockedCookieSends: number | null;
  localStorageEntries: number | null;
  sessionStorageEntries: number | null;
  indexedDbDatabases: number | null;
  serviceWorkers: number | null;
  thirdPartyFrames: number | null;
  visibleAdSlots: number | null;
  maxVisibleAdAreaFraction: number | null;
  adCreativeChanges: number | null;
  trackerClassificationAvailable: boolean;
}

export interface AuditMetadata {
  auditId: string;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  sites: string[];
  conditions: ConsentCondition[];
  repetitions: number;
  environment: EnvironmentInfo;
  browser: BrowserIdentity | null;
  config: RunConfigSnapshot;
  trackerDataset: TrackerDatasetInfo;
  runIds: string[];
  notes: string[];
}

export interface TrackerDatasetInfo {
  available: boolean;
  name: string;
  version: string;
  /** Upstream commit / release the data was pinned to. */
  commit: string | null;
  sourceUrl: string | null;
  sha256: string | null;
  retrievedAt: string | null;
  entryCount: number | null;
  note: string | null;
}

export type TrackerCategoryLabel =
  | 'known_tracker'
  | 'advertising_related'
  | 'third_party'
  | 'unclassified'
  | 'unknown_dataset_unavailable';

export interface DomainClassification {
  registrableDomain: string;
  label: TrackerCategoryLabel;
  owner: string | null;
  categories: string[];
  datasetName: string;
  datasetVersion: string;
}
