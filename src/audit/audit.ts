import { randomUUID } from 'node:crypto';
import type { AuditMetadata, ConsentCondition, RunResult } from '../types.js';
import type { SiteDefinition } from '../sites/types.js';
import { config } from '../config.js';
import { collectEnvironment } from '../util/env.js';
import { loadTrackerClassifier } from '../trackers/dataset.js';
import { saveAudit, getAudit, listRuns } from '../store/store.js';
import { runSingleAudit, type SingleRunOptions } from './runner.js';

export interface AuditOptions {
  label?: string;
  /**
   * Continue an audit that was interrupted. Runs already recorded for a
   * site/condition/repetition are skipped, and the new runs are added to the
   * same audit so the dataset stays one coherent experiment.
   */
  resumeAuditId?: string;
  sites: SiteDefinition[];
  conditions?: ConsentCondition[];
  repetitions?: number;
  interactive?: boolean;
  headless?: boolean;
  log?: (message: string) => void;
  onRunComplete?: (run: RunResult, index: number, total: number) => void;
  shouldCancel?: () => boolean;
  runOverrides?: Partial<SingleRunOptions>;
}

/**
 * Runs the full experiment matrix: site x condition x repetition.
 *
 * Every run is independent: its own browser process, its own fresh context.
 * A failing run is recorded as failed and the matrix continues, because a
 * missing measurement must stay visible rather than disappear.
 */
export async function runAudit(options: AuditOptions): Promise<AuditMetadata> {
  const log = options.log ?? ((message: string) => console.log(message));
  const classifier = loadTrackerClassifier();

  const existing = options.resumeAuditId ? getAudit(options.resumeAuditId) : null;
  if (options.resumeAuditId && !existing) {
    throw new Error(`Cannot resume: unknown audit ${options.resumeAuditId}`);
  }
  const auditId = existing?.auditId ?? randomUUID();
  const conditions = options.conditions ?? existing?.conditions ?? config.conditions;
  const repetitions = options.repetitions ?? existing?.repetitions ?? config.repetitions;

  // What has already been measured, so a resumed audit does not repeat it.
  const alreadyDone = new Set(
    existing ? listRuns(auditId).map((run) => runKey(run.siteId, run.condition, run.repetition)) : [],
  );

  const metadata: AuditMetadata = existing
    ? {
        ...existing,
        status: 'running',
        conditions,
        repetitions,
        sites: [...new Set([...existing.sites, ...options.sites.map((site) => site.id)])],
        runIds: listRuns(auditId).map((run) => run.runId),
      }
    : {
        auditId,
        label: options.label ?? `Audit ${new Date().toISOString()}`,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        sites: options.sites.map((site) => site.id),
        conditions,
        repetitions,
        environment: collectEnvironment(),
        browser: null,
        config: {
          viewport: config.viewport,
          deviceScaleFactor: config.deviceScaleFactor,
          locale: config.locale,
          timezoneId: config.timezoneId,
          observeHomepageMs: config.observeHomepageMs,
          observeExerciseMs: config.observeExerciseMs,
          recordVideo: config.recordVideo,
          recordTrace: config.recordTrace,
          recordHar: config.recordHar,
          interactive: Boolean(options.interactive),
          navigateToExercise: config.navigateToExercise,
        },
        trackerDataset: classifier.datasetInfo(),
        runIds: [],
        notes: [],
      };
  if (existing) {
    metadata.notes.push(
      `Resumed on ${new Date().toISOString()} with ${alreadyDone.size} runs already recorded.`,
    );
  }
  if (!classifier.available) {
    metadata.notes.push(
      'No tracker classification dataset was available for this audit. Tracker/advertising counts are reported as "not measured", not as zero.',
    );
  }
  saveAudit(metadata);

  const total = options.sites.length * conditions.length * repetitions;
  let index = 0;

  for (const site of options.sites) {
    for (const condition of conditions) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        if (options.shouldCancel?.()) {
          metadata.status = 'cancelled';
          metadata.notes.push(`Audit cancelled after ${index} of ${total} runs.`);
          metadata.finishedAt = new Date().toISOString();
          saveAudit(metadata);
          return metadata;
        }
        index += 1;
        if (alreadyDone.has(runKey(site.id, condition, repetition))) {
          log(`--- [${index}/${total}] ${site.name} / ${condition} / run ${repetition}: already recorded, skipping`);
          continue;
        }
        log(`\n=== [${index}/${total}] ${site.name} / ${condition} / run ${repetition} ===`);
        try {
          const run = await runSingleAudit({
            auditId,
            site,
            condition,
            repetition,
            classifier,
            interactive: options.interactive,
            headless: options.headless,
            log,
            ...options.runOverrides,
          });
          metadata.runIds.push(run.runId);
          if (!metadata.browser) metadata.browser = run.browser;
          saveAudit(metadata);
          options.onRunComplete?.(run, index, total);
          log(
            `--- run ${run.runId.slice(0, 8)} status=${run.status} ` +
              `requests=${fmt(run.metrics.totalRequests)} third-party-domains=${fmt(run.metrics.uniqueThirdPartyDomains)} ` +
              `cookies=${fmt(run.metrics.storedCookies)} consent=${run.consent.status}`,
          );
        } catch (err) {
          log(`!!! run failed outside the runner: ${String(err)}`);
          metadata.notes.push(`Run ${index}/${total} (${site.id}/${condition}#${repetition}) crashed: ${String(err).slice(0, 300)}`);
          saveAudit(metadata);
        }
        if (config.politenessDelayMs > 0 && index < total) {
          await new Promise((resolve) => setTimeout(resolve, config.politenessDelayMs));
        }
      }
    }
  }

  metadata.status = 'completed';
  metadata.finishedAt = new Date().toISOString();
  saveAudit(metadata);
  log(`\nAudit ${auditId} finished: ${metadata.runIds.length}/${total} runs recorded.`);
  return metadata;
}

export function runKey(siteId: string, condition: string, repetition: number): string {
  return `${siteId}|${condition}|${repetition}`;
}

function fmt(value: number | null): string {
  return value == null ? 'n/a' : String(value);
}
