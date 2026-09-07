import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConsentCondition, RunResult } from '../types.js';
import type { SiteDefinition } from '../sites/types.js';
import { runAudit } from '../audit/audit.js';
import { config } from '../config.js';
import { runDir } from '../store/store.js';

export interface Job {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: string;
  startedAt: string;
  finishedAt: string | null;
  auditId: string | null;
  log: string[];
  cancelRequested: boolean;
  interactive: boolean;
  currentRunId: string | null;
}

const jobs = new Map<string, Job>();

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  job.progress = 'cancellation requested; finishing the current run';
  return true;
}

export function anyInteractiveJobRunning(): Job | null {
  return listJobs().find((job) => job.interactive && job.status === 'running') ?? null;
}

export interface StartJobOptions {
  sites: SiteDefinition[];
  conditions?: ConsentCondition[];
  repetitions: number;
  interactive: boolean;
  recordVideo?: boolean;
  label: string;
}

/**
 * Starts an audit in the background. The dashboard polls the job list; the
 * evidence itself is written to disk by the runner as each run completes, so a
 * crashed server never loses already-finished runs.
 */
export function startJob(options: StartJobOptions): Job {
  const job: Job = {
    id: randomUUID(),
    label: options.label,
    status: 'running',
    progress: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    auditId: null,
    log: [],
    cancelRequested: false,
    interactive: options.interactive,
    currentRunId: null,
  };
  jobs.set(job.id, job);

  const log = (message: string) => {
    job.log.push(message);
    if (job.log.length > 500) job.log.shift();
    console.log(message);
  };

  void runAudit({
    label: options.label,
    sites: options.sites,
    conditions: options.conditions,
    repetitions: options.repetitions,
    interactive: options.interactive,
    headless: options.interactive ? false : config.headless,
    log,
    shouldCancel: () => job.cancelRequested,
    onRunComplete: (run: RunResult, index: number, total: number) => {
      job.auditId = run.auditId;
      job.currentRunId = null;
      job.progress = `${index}/${total} runs completed (last: ${run.siteId} / ${run.condition} — ${run.status})`;
    },
    runOverrides: {
      recordVideo: options.recordVideo,
      waitForOperator: options.interactive
        ? async (page, runId) => {
            job.currentRunId = runId;
            job.progress = 'interactive session running — finish it from the run page';
            await waitForFinishMarker(job, runId, page);
          }
        : undefined,
    },
  })
    .then((metadata) => {
      job.auditId = metadata.auditId;
      job.status = metadata.status === 'cancelled' ? 'cancelled' : 'completed';
      job.progress = `${metadata.runIds.length} runs recorded`;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'failed';
      job.progress = String(err).slice(0, 300);
      job.finishedAt = new Date().toISOString();
    });

  return job;
}

/** The dashboard finishes an interactive run by creating a FINISH marker file. */
async function waitForFinishMarker(job: Job, runId: string, page: { isClosed(): boolean }): Promise<void> {
  const deadline = Date.now() + config.interactiveMaxMs;
  while (Date.now() < deadline) {
    if (job.cancelRequested) return;
    if (page.isClosed()) return;
    if (job.auditId) {
      const marker = path.join(runDir(job.auditId, runId), 'FINISH');
      if (fs.existsSync(marker)) {
        try { fs.unlinkSync(marker); } catch { /* ignore */ }
        return;
      }
    }
    // The audit id is only known once the first run directory exists; scan for it.
    for (const auditId of safeReaddir(config.resultsDir)) {
      const marker = path.join(runDir(auditId, runId), 'FINISH');
      if (fs.existsSync(marker)) {
        try { fs.unlinkSync(marker); } catch { /* ignore */ }
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Used by the API route: signals an in-progress interactive run to finish. */
export function signalFinish(auditId: string, runId: string): boolean {
  const dir = runDir(auditId, runId);
  if (!fs.existsSync(dir)) return false;
  fs.writeFileSync(path.join(dir, 'FINISH'), new Date().toISOString());
  return true;
}
