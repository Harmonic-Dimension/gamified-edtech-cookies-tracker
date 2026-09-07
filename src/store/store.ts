import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AuditMetadata, RunResult } from '../types.js';

/**
 * Filesystem-backed result store.
 *
 * Deliberately not a database: every result is a plain JSON file inside a
 * directory named after the run, so that a reviewer can inspect the raw
 * evidence with nothing but a file browser and a text editor.
 *
 *   data/audits/<audit-id>/audit.json
 *   data/audits/<audit-id>/runs/<run-id>/run.json
 *   data/audits/<audit-id>/runs/<run-id>/screenshots/*.png
 *   data/audits/<audit-id>/runs/<run-id>/network.har
 *   data/audits/<audit-id>/runs/<run-id>/trace.zip
 *   data/audits/<audit-id>/runs/<run-id>/video.webm
 */

export function auditDir(auditId: string): string {
  return path.join(config.resultsDir, auditId);
}

export function runDir(auditId: string, runId: string): string {
  return path.join(auditDir(auditId), 'runs', runId);
}

export function ensureAuditDir(auditId: string): string {
  const dir = auditDir(auditId);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}

export function ensureRunDir(auditId: string, runId: string): string {
  const dir = runDir(auditId, runId);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  return dir;
}

export function saveAudit(metadata: AuditMetadata): void {
  ensureAuditDir(metadata.auditId);
  const file = path.join(auditDir(metadata.auditId), 'audit.json');
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2));
}

export function saveRun(auditId: string, run: RunResult): void {
  ensureRunDir(auditId, run.runId);
  const file = path.join(runDir(auditId, run.runId), 'run.json');
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
}

export function listAuditIds(): string[] {
  if (!fs.existsSync(config.resultsDir)) return [];
  return fs
    .readdirSync(config.resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(config.resultsDir, name, 'audit.json')));
}

export function getAudit(auditId: string): AuditMetadata | null {
  const file = path.join(auditDir(auditId), 'audit.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AuditMetadata;
  } catch {
    return null;
  }
}

export function listAudits(): AuditMetadata[] {
  return listAuditIds()
    .map((id) => getAudit(id))
    .filter((audit): audit is AuditMetadata => audit != null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function listRunIds(auditId: string): string[] {
  const dir = path.join(auditDir(auditId), 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(dir, name, 'run.json')));
}

export function getRun(auditId: string, runId: string): RunResult | null {
  const file = path.join(runDir(auditId, runId), 'run.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult;
  } catch {
    return null;
  }
}

export function listRuns(auditId: string): RunResult[] {
  return listRunIds(auditId)
    .map((id) => getRun(auditId, id))
    .filter((run): run is RunResult => run != null)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}

/** Most recent audit that produced at least one run. */
export function latestAuditWithRuns(): AuditMetadata | null {
  for (const audit of listAudits()) {
    if (listRunIds(audit.auditId).length > 0) return audit;
  }
  return null;
}

export function runArtifactPath(auditId: string, runId: string, relative: string): string | null {
  const base = runDir(auditId, runId);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(path.resolve(base))) return null; // path traversal guard
  return fs.existsSync(resolved) ? resolved : null;
}
