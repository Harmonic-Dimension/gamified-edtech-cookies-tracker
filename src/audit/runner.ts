import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  ConsentCondition,
  ConsentEvidence,
  ConsentStatus,
  RunFailure,
  RunPhase,
  RunResult,
  RunStatus,
  ScreenshotRecord,
  TimelineEvent,
} from '../types.js';
import type { SiteDefinition, ExerciseStep } from '../sites/types.js';
import { config } from '../config.js';
import { collectEnvironment } from '../util/env.js';
import { sha256 } from '../util/hash.js';
import { sanitizeUrl, sanitizeHarObject } from '../util/sanitize.js';
import { withTimeout, settleWithin, isTimeoutError } from '../util/timeout.js';
import { launchBrowser, createFreshContext, assertCleanContext } from './browser.js';
import { NetworkRecorder } from './network.js';
import { captureCookies, captureStorage } from './storage.js';
import { observeAdSlots } from './adslots.js';
import { computeMetrics } from './metrics.js';
import { ensureRunDir, saveRun } from '../store/store.js';
import type { TrackerClassifier } from '../trackers/dataset.js';

export interface SingleRunOptions {
  auditId: string;
  site: SiteDefinition;
  condition: ConsentCondition;
  repetition: number;
  classifier: TrackerClassifier;
  interactive?: boolean;
  headless?: boolean;
  browserChannel?: string | null;
  extraBrowserArgs?: string[];
  observeHomepageMs?: number;
  observeExerciseMs?: number;
  recordVideo?: boolean;
  recordTrace?: boolean;
  recordHar?: boolean;
  navigateToExercise?: boolean;
  /** Hard limit for the experiment itself, excluding any interactive wait. */
  maxRunMs?: number;
  log?: (message: string) => void;
  /** Resolves when the operator finishes an interactive session. */
  waitForOperator?: (page: Page, runId: string) => Promise<void>;
}

export async function runSingleAudit(options: SingleRunOptions): Promise<RunResult> {
  const {
    auditId,
    site,
    condition,
    repetition,
    classifier,
    interactive = false,
  } = options;
  const log = options.log ?? (() => undefined);

  const runId = randomUUID();
  const dir = ensureRunDir(auditId, runId);
  const screenshotDir = path.join(dir, 'screenshots');
  const startedAt = new Date().toISOString();
  const startWall = Date.now();

  const observeHomepageMs = options.observeHomepageMs ?? config.observeHomepageMs;
  const observeExerciseMs = options.observeExerciseMs ?? config.observeExerciseMs;
  const recordVideo = options.recordVideo ?? config.recordVideo;
  const recordTrace = options.recordTrace ?? config.recordTrace;
  const recordHar = options.recordHar ?? config.recordHar;
  const navigateToExercise = options.navigateToExercise ?? config.navigateToExercise;
  const headless = options.headless ?? (interactive ? false : config.headless);

  const timeline: TimelineEvent[] = [];
  const failures: RunFailure[] = [];
  const screenshots: ScreenshotRecord[] = [];

  let t0 = performance.now();
  let phase: RunPhase = 'pre_consent';
  let consentActionDone = false;
  const now = () => Math.round(performance.now() - t0);
  const event = (type: string, detail: string) => {
    timeline.push({ tRelMs: now(), type, detail });
    log(`[${runId.slice(0, 8)}] ${type}: ${detail}`);
  };
  const fail = (stage: string, err: unknown, fatal = false) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    failures.push({ stage, message: message.slice(0, 800), fatal });
    event('failure', `${stage}: ${message.slice(0, 200)}`);
  };

  const harPath = recordHar ? path.join(dir, 'network.har') : null;
  const videoDir = recordVideo ? path.join(dir, 'video') : null;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let recorder: NetworkRecorder | null = null;
  let navigationOk = false;
  let cookiesCaptured = false;
  let storageCaptured = false;
  let adsCaptured = false;
  let tracePath: string | null = null;
  let videoPath: string | null = null;

  const adObservations: RunResult['adObservations'] = [];
  const cookieCheckpoints: RunResult['cookieCheckpoints'] = [];
  const storageCheckpoints: RunResult['storageCheckpoints'] = [];

  const consent: ConsentEvidence = {
    status: condition === 'no_choice' ? 'not_attempted' : 'failed',
    bannerDetected: null,
    bannerDetectorUsed: null,
    actionRequested: condition,
    stepsExecuted: [],
    bannerDismissed: null,
    stateProbe: null,
    consentActionTRelMs: null,
    notes: [],
  };

  const exercise: RunResult['exercise'] = {
    attempted: false,
    reached: null,
    url: null,
    stepsExecuted: [],
    notes: [],
  };

  const launch = await launchBrowser({
    headless,
    channel: options.browserChannel === undefined ? config.browserChannel : options.browserChannel,
    extraArgs: options.extraBrowserArgs,
  });
  browser = launch.browser;
  const browserIdentity = launch.identity;
  for (const note of launch.notes) {
    failures.push({ stage: 'browser-launch', message: note, fatal: false });
  }

  // A hung page must not stall the audit. The budget covers navigation, the
  // configured observation windows and generous slack; interactive sessions add
  // their own allowance because a human is deliberately taking their time.
  const runBudgetMs =
    options.maxRunMs ??
    config.navigationTimeoutMs + observeHomepageMs + observeExerciseMs + 240_000 +
      (interactive ? config.interactiveMaxMs + 60_000 : 0);

  try {
    // Inner try: whatever goes wrong during the experiment itself, the teardown
    // below still runs, so a crashed run is saved as a *failed run with partial
    // evidence* rather than disappearing.
    try {
      const experiment = (async () => {
      context = await createFreshContext(browser, {
        recordHarPath: harPath,
        recordVideoDir: videoDir,
      });

      const cleanliness = await assertCleanContext(context);
      if (!cleanliness.clean) {
        failures.push({
          stage: 'context-isolation',
          message: `Context was not empty at start: ${cleanliness.details.join('; ')}`,
          fatal: false,
        });
      }
      event('context', `fresh browser process + fresh context (clean=${cleanliness.clean})`);

      if (recordTrace) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch((err) => {
          fail('trace-start', err);
        });
      }

      recorder = new NetworkRecorder(
        site.firstPartyDomain,
        () => t0,
        () => phase,
        () => consentActionDone,
      );
      await recorder.attachToContext(context);

      page = await context.newPage();
      browserIdentity.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');

      const takeScreenshot = async (label: string, fullPage = false) => {
        if (!page || page.isClosed()) return;
        try {
          const file = path.join(screenshotDir, `${String(screenshots.length).padStart(2, '0')}-${label}.png`);
          const buffer = await page.screenshot({ path: file, fullPage, timeout: 20000 });
          screenshots.push({
            label,
            tRelMs: now(),
            file: path.relative(dir, file),
            fullPage,
            viewport: page.viewportSize() ?? config.viewport,
            sha256: sha256(buffer),
          });
          event('screenshot', label);
        } catch (err) {
          fail(`screenshot:${label}`, err);
        }
      };

      const observeAds = async (label: string) => {
        if (!page || page.isClosed()) return;
        try {
          const observation = await observeAdSlots(page, site.adSlotSelectors, classifier, label, now(), {
            captureSlotImages: true,
            outDir: screenshotDir,
            runIdPrefix: 'adslot',
          });
          adObservations.push(observation);
          if (!observation.error) adsCaptured = true;
          // Ad iframes are often injected without firing Playwright frame events.
          recorder?.noteFrameUrls(
            observation.slots
              .filter((slot) => slot.iframeSrc)
              .map((slot) => ({ url: slot.iframeSrc as string, name: null })),
          );
        } catch (err) {
          fail(`ad-observation:${label}`, err);
        }
      };

      const checkpoint = async (label: string) => {
        if (!context) return;
        try {
          cookieCheckpoints.push(await captureCookies(context, site.firstPartyDomain, label, now()));
          cookiesCaptured = true;
        } catch (err) {
          fail(`cookie-checkpoint:${label}`, err);
        }
        try {
          storageCheckpoints.push(await captureStorage(context, context.pages(), label, now()));
          storageCaptured = true;
        } catch (err) {
          fail(`storage-checkpoint:${label}`, err);
        }
      };

      // ---- Phase 1: open the site, no interaction at all -------------------
      t0 = performance.now();
      phase = 'pre_consent';
      event('navigate', `goto ${site.startUrl}`);
      try {
        await page.goto(site.startUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
        navigationOk = true;
      } catch (err) {
        fail('navigate-start-url', err, true);
      }

      if (navigationOk) {
        await page.waitForTimeout(2500);
        await takeScreenshot('01-first-load');

        // ---- Phase 2: consent banner ---------------------------------------
        let detection = { detected: false, detector: null as string | null };
        try {
          detection = await site.consent.detectBanner(page, 12000);
        } catch (err) {
          fail('consent-detect', err);
        }
        consent.bannerDetected = detection.detected;
        consent.bannerDetectorUsed = detection.detector;
        event('consent-banner', detection.detected ? `detected via ${detection.detector}` : 'not detected');
        if (detection.detected) await takeScreenshot('02-consent-dialog');

        if (condition === 'no_choice') {
          // Deliberately no interaction. Observe the page as it is.
          consent.status = 'not_attempted';
          consent.notes.push('Condition A: the consent dialog was deliberately not interacted with.');
          await checkpoint('before-observation');
          event('observe', `waiting ${observeHomepageMs} ms without any consent choice`);
          await observeAds('03-no-choice-initial');
          await page.waitForTimeout(Math.min(10000, observeHomepageMs));
          await takeScreenshot('03-after-10s-no-choice');
          await observeAds('03-no-choice-10s');
          if (observeHomepageMs > 10000) {
            await page.waitForTimeout(observeHomepageMs - 10000);
            await takeScreenshot('04-after-full-observation-no-choice');
            await observeAds('04-no-choice-end');
          }
        } else {
          await checkpoint('pre-consent');
          phase = 'consent_action';
          const action = condition === 'accept_all' ? 'accept' : 'reject';
          event('consent-action', `performing "${action}"`);
          let actionResult = { ok: false, steps: [] as string[], notes: [] as string[], bannerDismissed: null as boolean | null };
          if (!detection.detected) {
            consent.status = 'no_banner';
            consent.notes.push(
              'No consent banner was detected, so the requested consent action could not be performed. ' +
                'This run must NOT be read as a measurement of the requested condition.',
            );
          } else {
            try {
              actionResult =
                action === 'accept' ? await site.consent.accept(page) : await site.consent.reject(page);
            } catch (err) {
              fail('consent-action', err);
            }
            consent.stepsExecuted = actionResult.steps;
            consent.notes.push(...actionResult.notes);
            consent.bannerDismissed = actionResult.bannerDismissed;
            consentActionDone = actionResult.ok;
            consent.consentActionTRelMs = actionResult.ok ? now() : null;
            consent.status = actionResult.ok ? 'performed' : 'failed';
            event('consent-action', actionResult.ok ? `executed: ${actionResult.steps.join(' -> ')}` : 'FAILED');
          }

          phase = 'post_consent';
          await page.waitForTimeout(2500);
          await takeScreenshot('03-after-consent-decision');

          // Independent read-back of the resulting consent state.
          if (consent.status === 'performed') {
            try {
              const probe = await site.consent.probeState(page);
              probe.matchesRequestedCondition = evaluateProbe(probe, condition);
              consent.stateProbe = probe;
              if (probe.matchesRequestedCondition === true) {
                consent.status = 'confirmed';
                event('consent-confirm', `state confirmed via ${probe.method}`);
              } else if (probe.matchesRequestedCondition === false) {
                consent.status = 'performed';
                consent.notes.push(
                  `The consent state read back through ${probe.method} does not clearly match the requested "${condition}" condition.`,
                );
                event('consent-confirm', 'state does NOT match requested condition');
              } else {
                consent.notes.push(`Consent state could not be confirmed (${probe.error ?? 'inconclusive probe'}).`);
                event('consent-confirm', 'inconclusive');
              }
            } catch (err) {
              fail('consent-probe', err);
            }
          }

          await checkpoint('post-consent');
          await observeAds('03-post-consent');

          // ---- Phase 3: continue into an actual exercise --------------------
          if (navigateToExercise && site.exercise) {
            phase = 'exercise';
            exercise.attempted = true;
            const outcome = await runExerciseSteps(page, site.exercise.steps, event, fail);
            exercise.stepsExecuted = outcome.steps;
            exercise.notes.push(...outcome.notes);
            exercise.url = sanitizeUrl(page.url());
            exercise.reached = await verifyExerciseReached(page, site, exercise.notes);
            if (site.exercise.limitation) exercise.notes.push(site.exercise.limitation);
            event('exercise', `reached=${exercise.reached} url=${exercise.url}`);

            await takeScreenshot('04-exercise-loaded');
            await observeAds('04-exercise-0s');
            await page.waitForTimeout(10000);
            await takeScreenshot('05-exercise-10s');
            await observeAds('05-exercise-10s');
            const remaining = Math.max(0, observeExerciseMs - 10000);
            if (remaining > 0) {
              await page.waitForTimeout(Math.min(remaining, 20000));
              await takeScreenshot('06-exercise-30s');
              await observeAds('06-exercise-30s');
              const rest = remaining - Math.min(remaining, 20000);
              if (rest > 0) await page.waitForTimeout(rest);
            }
            await takeScreenshot('07-exercise-end-fullpage', true);
          } else if (!site.exercise) {
            exercise.notes.push('This site definition has no exercise route configured.');
          }
        }

        // ---- Optional interactive window ------------------------------------
        if (interactive && options.waitForOperator) {
          phase = 'interactive';
          event('interactive', 'waiting for the operator to finish the session');
          try {
            await options.waitForOperator(page, runId);
          } catch (err) {
            fail('interactive-wait', err);
          }
          await takeScreenshot('08-interactive-end');
          await observeAds('08-interactive-end');
          event('interactive', 'operator finished the session');
        }

        await checkpoint('final');
      }

      })();
      await withTimeout(experiment, runBudgetMs, `run watchdog (${Math.round(runBudgetMs / 1000)}s)`);
    } catch (err) {
      if (isTimeoutError(err)) {
        fail(
          'run-watchdog',
          `The run exceeded its time budget of ${Math.round(runBudgetMs / 1000)}s and was abandoned. ` +
            'Evidence collected up to that point is kept; the run is marked failed.',
          true,
        );
      } else {
        fail('run-execution', err, true);
      }
    }

    // ---- Teardown ---------------------------------------------------------
    // The handles above are assigned inside the experiment closure, which the
    // compiler's flow analysis cannot see; re-widening them here keeps the
    // declared types without changing the values.
    const live = { context, recorder, page } as {
      context: BrowserContext | null;
      recorder: NetworkRecorder | null;
      page: Page | null;
    };
    const liveContext = live.context;
    const liveRecorder = live.recorder;
    const livePage = live.page;

    if (recordTrace && liveContext) {
      tracePath = path.join(dir, 'trace.zip');
      const stopped = await settleWithin(
        liveContext.tracing.stop({ path: tracePath }).then(() => true).catch((err: unknown) => {
          fail('trace-stop', err);
          return false;
        }),
        120_000,
        false,
      );
      if (!stopped) {
        fail('trace-stop', 'Writing the Playwright trace did not finish in time; the trace may be missing.');
        tracePath = null;
      }
    }
    await settleWithin(liveRecorder?.detach() ?? Promise.resolve(), 15_000, undefined);

    const requests = liveRecorder?.requests ?? [];
    const cookieAttempts = liveRecorder?.cookieAttempts ?? [];
    const frames = liveRecorder?.frames ?? [];
    const consoleErrors = liveRecorder?.consoleErrors ?? [];

    if (recordVideo && liveContext && livePage && !livePage.isClosed()) {
      const video = livePage.video();
      await closeContextSafely(liveContext, fail);
      context = null;
      if (video) {
        try {
          const target = path.join(dir, 'video.webm');
          await withTimeout(video.saveAs(target), 120_000, 'saving the session video');
          videoPath = 'video.webm';
        } catch (err) {
          fail('video-save', err);
        }
      }
    } else if (liveContext) {
      await closeContextSafely(liveContext, fail);
      context = null;
    }

    if (harPath && fs.existsSync(harPath)) {
      try {
        const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        fs.writeFileSync(harPath, JSON.stringify(sanitizeHarObject(har)));
      } catch (err) {
        fail('har-sanitize', err);
      }
    }

    const status: RunStatus = determineStatus({
      navigationOk,
      failures,
      consentStatus: consent.status,
      condition,
      exerciseAttempted: exercise.attempted,
      exerciseReached: exercise.reached,
    });

    const base: Omit<RunResult, 'metrics'> = {
      runId,
      auditId,
      siteId: site.id,
      siteName: site.name,
      startUrl: site.startUrl,
      condition,
      repetition,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startWall,
      status,
      environment: collectEnvironment(),
      browser: browserIdentity,
      config: {
        viewport: config.viewport,
        deviceScaleFactor: config.deviceScaleFactor,
        locale: config.locale,
        timezoneId: config.timezoneId,
        observeHomepageMs,
        observeExerciseMs,
        recordVideo,
        recordTrace,
        recordHar,
        interactive,
        navigateToExercise,
      },
      consent,
      exercise,
      timeline,
      requests,
      cookieSetAttempts: cookieAttempts,
      cookieCheckpoints,
      storageCheckpoints,
      frames,
      adObservations,
      screenshots,
      failures,
      consoleErrors,
      artifacts: {
        har: harPath && fs.existsSync(harPath) ? 'network.har' : null,
        trace: tracePath && fs.existsSync(tracePath) ? 'trace.zip' : null,
        video: videoPath,
        screenshotDir: 'screenshots',
      },
    };

    const metrics = computeMetrics(base, classifier, {
      networkCaptured: navigationOk,
      cookiesCaptured,
      storageCaptured,
      adsCaptured,
    });

    const result: RunResult = { ...base, metrics };
    saveRun(auditId, result);
    cleanupVideoDir(dir);
    return result;
  } finally {
    // Last-resort cleanup. Closing the browser also kills anything the context
    // was still doing, so a wedged context can never outlive its run.
    const remaining = { context } as { context: BrowserContext | null };
    if (remaining.context) {
      await settleWithin(remaining.context.close().catch(() => undefined), 30_000, undefined);
    }
    if (browser) {
      await settleWithin(browser.close().catch(() => undefined), 30_000, undefined);
    }
  }
}

/**
 * Closing a context also flushes the HAR file, which is where a wedged browser
 * tends to hang. Give it a bounded amount of time and record it as a failure
 * rather than waiting forever.
 */
async function closeContextSafely(
  context: BrowserContext,
  fail: (stage: string, err: unknown, fatal?: boolean) => void,
): Promise<void> {
  const closed = await settleWithin(
    context.close().then(() => true).catch((err) => {
      fail('context-close', err);
      return false;
    }),
    120_000,
    false,
  );
  if (!closed) {
    fail(
      'context-close',
      'Closing the browser context (which writes the HAR file) did not finish in time. ' +
        'The HAR for this run may be missing or truncated.',
    );
  }
}

function cleanupVideoDir(dir: string): void {
  const videoDir = path.join(dir, 'video');
  try {
    if (fs.existsSync(videoDir)) fs.rmSync(videoDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function determineStatus(input: {
  navigationOk: boolean;
  failures: RunFailure[];
  consentStatus: ConsentStatus;
  condition: ConsentCondition;
  exerciseAttempted: boolean;
  exerciseReached: boolean | null;
}): RunStatus {
  if (!input.navigationOk) return 'failed';
  if (input.failures.some((f) => f.fatal)) return 'failed';
  if (input.condition !== 'no_choice') {
    if (input.consentStatus === 'failed' || input.consentStatus === 'no_banner') return 'failed';
    if (input.consentStatus === 'performed') return 'partial'; // action done, state not confirmed
  }
  if (input.exerciseAttempted && input.exerciseReached === false) return 'partial';
  if (input.failures.length > 0) return 'partial';
  return 'completed';
}

/**
 * Decides whether the consent state read back from the CMP matches what we
 * asked for. Returns null when the probe cannot support a conclusion.
 */
export function evaluateProbe(
  probe: { purposeConsentsTrue: number | null; purposeConsentsTotal: number | null; vendorConsentsTrue: number | null; error: string | null },
  condition: ConsentCondition,
): boolean | null {
  if (probe.error) return null;
  if (probe.purposeConsentsTrue == null || probe.purposeConsentsTotal == null) return null;
  if (condition === 'reject_all') {
    return probe.purposeConsentsTrue === 0 && (probe.vendorConsentsTrue ?? 0) === 0;
  }
  if (condition === 'accept_all') {
    return probe.purposeConsentsTrue > 0 && probe.purposeConsentsTrue >= probe.purposeConsentsTotal - 1;
  }
  return null;
}

/**
 * Decides whether the run really reached the learning activity. Both checks are
 * optional; when a site definition configures neither, "reached" stays unknown
 * (null) rather than being assumed true.
 */
async function verifyExerciseReached(
  page: Page,
  site: SiteDefinition,
  notes: string[],
): Promise<boolean | null> {
  const spec = site.exercise;
  if (!spec) return null;
  let verdict: boolean | null = null;

  if (spec.verifySelector) {
    try {
      await page.locator(spec.verifySelector).first().waitFor({ state: 'attached', timeout: 10000 });
      verdict = true;
    } catch {
      notes.push(
        `Verification selector "${spec.verifySelector}" was not found; the run did not reach the expected exercise page.`,
      );
      return false;
    }
  }

  if (spec.verifyFrame) {
    const frame = page.frameLocator(spec.verifyFrame.frameSelector);
    if (spec.verifyFrame.visibleSelector) {
      try {
        await frame.locator(spec.verifyFrame.visibleSelector).first().waitFor({ state: 'visible', timeout: 15000 });
        verdict = true;
      } catch {
        notes.push(
          `Inside the exercise frame, "${spec.verifyFrame.visibleSelector}" never became visible; the activity did not start.`,
        );
        return false;
      }
    }
    if (spec.verifyFrame.hiddenSelector) {
      try {
        await frame.locator(spec.verifyFrame.hiddenSelector).first().waitFor({ state: 'hidden', timeout: 15000 });
        verdict = true;
      } catch {
        notes.push(
          `Inside the exercise frame, "${spec.verifyFrame.hiddenSelector}" was still visible; the run appears to have stopped at a selection screen.`,
        );
        return false;
      }
    }
  }

  return verdict;
}

async function runExerciseSteps(
  page: Page,
  steps: ExerciseStep[],
  event: (type: string, detail: string) => void,
  fail: (stage: string, err: unknown, fatal?: boolean) => void,
): Promise<{ ok: boolean; steps: string[]; notes: string[] }> {
  const executed: string[] = [];
  const notes: string[] = [];
  let ok = true;
  for (const step of steps) {
    try {
      switch (step.kind) {
        case 'goto': {
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
          executed.push(`goto ${step.url}`);
          event('exercise-step', `goto ${step.url}`);
          break;
        }
        case 'gotoUnlessUrl': {
          if (new RegExp(step.pattern).test(page.url())) {
            executed.push(`already at ${step.description}`);
          } else {
            notes.push(
              `The link click did not lead to ${step.description}; navigated to the fixed exercise URL instead.`,
            );
            await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
            executed.push(`goto (fallback) ${step.url}`);
            event('exercise-step', `fallback goto ${step.url}`);
          }
          break;
        }
        case 'wait': {
          await page.waitForTimeout(step.ms);
          executed.push(`wait ${step.ms}ms`);
          break;
        }
        case 'click': {
          // A step may target a control inside a same-origin exercise iframe.
          const scope = step.frameSelector ? page.frameLocator(step.frameSelector) : page;
          const locator = step.selector
            ? scope.locator(step.selector)
            : step.role
              ? scope.getByRole(step.role, { name: new RegExp(step.textPattern ?? '.', 'i') })
              : scope.getByText(new RegExp(step.textPattern ?? '.', 'i'));
          try {
            await locator.first().click({ timeout: 8000 });
            executed.push(`click: ${step.description}`);
            event('exercise-step', `click ${step.description}`);
          } catch (err) {
            if (step.optional) {
              notes.push(`Optional step skipped (${step.description}): control not found.`);
              executed.push(`skipped: ${step.description}`);
            } else {
              ok = false;
              notes.push(`Required step failed (${step.description}).`);
              fail(`exercise-step:${step.description}`, err);
            }
          }
          break;
        }
        case 'expectSelector': {
          await page.locator(step.selector).first().waitFor({ state: 'attached', timeout: step.timeoutMs ?? 10000 });
          executed.push(`verified: ${step.description}`);
          break;
        }
        case 'expectUrl': {
          await page.waitForURL(new RegExp(step.pattern), { timeout: step.timeoutMs ?? 10000 });
          executed.push(`verified url: ${step.description}`);
          break;
        }
      }
    } catch (err) {
      ok = false;
      notes.push(`Exercise step failed: ${step.kind}`);
      fail(`exercise-step:${step.kind}`, err);
    }
  }
  return { ok, steps: executed, notes };
}
