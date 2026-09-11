import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { Writable } from 'node:stream';
import { getAudit, listRuns, runDir, auditDir } from '../store/store.js';
import { summarizeAudit, CONDITION_LABELS } from '../report/aggregate.js';
import { loadTrackerClassifier, TrackerClassifier } from '../trackers/dataset.js';
import { toCsv } from './csv.js';

/**
 * Builds the raw evidence bundle. The layout is documented in the README that
 * is written into the archive itself, so the export stays self-describing when
 * it is handed to a third party.
 */
export async function streamAuditZip(auditId: string, output: Writable): Promise<void> {
  const audit = getAudit(auditId);
  if (!audit) throw new Error(`Unknown audit: ${auditId}`);
  const runs = listRuns(auditId);
  const classifier = loadTrackerClassifier();
  const summary = summarizeAudit(audit, runs, classifier);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);

  archive.append(JSON.stringify(audit, null, 2), { name: 'audit/metadata.json' });
  archive.append(JSON.stringify(summary, null, 2), { name: 'audit/summary.json' });
  archive.append(summaryCsv(summary), { name: 'audit/summary.csv' });
  archive.append(domainsCsv(summary), { name: 'audit/domains.csv' });
  archive.append(exportReadme(auditId), { name: 'audit/README.md' });

  for (const run of runs) {
    const base = `audit/runs/${run.runId}`;
    const dir = runDir(auditId, run.runId);

    const { requests, cookieSetAttempts, cookieCheckpoints, storageCheckpoints, frames, ...metadataOnly } = run;
    archive.append(JSON.stringify(metadataOnly, null, 2), { name: `${base}/metadata.json` });
    archive.append(JSON.stringify(requests, null, 2), { name: `${base}/requests.json` });
    archive.append(toCsv(requests as unknown as Array<Record<string, unknown>>), { name: `${base}/requests.csv` });
    archive.append(
      JSON.stringify({ checkpoints: cookieCheckpoints, setAttempts: cookieSetAttempts }, null, 2),
      { name: `${base}/cookies.json` },
    );
    archive.append(toCsv(cookieSetAttempts as unknown as Array<Record<string, unknown>>), {
      name: `${base}/cookie-attempts.csv`,
    });
    archive.append(JSON.stringify(storageCheckpoints, null, 2), { name: `${base}/storage.json` });
    archive.append(JSON.stringify(frames, null, 2), { name: `${base}/frames.json` });
    archive.append(JSON.stringify(run.adObservations, null, 2), { name: `${base}/ad-observations.json` });
    archive.append(JSON.stringify(run.timeline, null, 2), { name: `${base}/timeline.json` });

    const screenshotsDir = path.join(dir, 'screenshots');
    if (fs.existsSync(screenshotsDir)) {
      archive.directory(screenshotsDir, `${base}/screenshots`);
    }
    for (const [file, name] of [
      ['network.har', 'network.har'],
      ['trace.zip', 'trace.zip'],
      ['video.webm', 'video.webm'],
    ] as const) {
      const full = path.join(dir, file);
      if (fs.existsSync(full)) archive.file(full, { name: `${base}/${name}` });
    }
  }

  const reportPdf = path.join(auditDir(auditId), 'report.pdf');
  if (fs.existsSync(reportPdf)) archive.file(reportPdf, { name: 'audit/report.pdf' });
  const summaryPdf = path.join(auditDir(auditId), 'publiekssamenvatting.pdf');
  if (fs.existsSync(summaryPdf)) archive.file(summaryPdf, { name: 'audit/publiekssamenvatting.pdf' });

  await archive.finalize();
}

function summaryCsv(summary: ReturnType<typeof summarizeAudit>): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const site of summary.sites) {
    for (const condition of site.conditions) {
      const row: Record<string, unknown> = {
        site_id: site.siteId,
        site_name: site.siteName,
        condition: condition.condition,
        condition_label: CONDITION_LABELS[condition.condition],
        runs_total: condition.runCount,
        runs_usable: condition.usableRunCount,
        exercise_reached: condition.exerciseReachedCount,
      };
      for (const [key, stats] of Object.entries(condition.metrics)) {
        if (!stats || typeof stats !== 'object' || !('median' in stats)) continue;
        row[`${key}_median`] = stats.median ?? '';
        row[`${key}_min`] = stats.min ?? '';
        row[`${key}_max`] = stats.max ?? '';
        row[`${key}_measured_runs`] = stats.measuredRuns;
        row[`${key}_values`] = stats.values.map((v) => (v == null ? 'not_measured' : v)).join('|');
      }
      rows.push(row);
    }
  }
  return toCsv(rows);
}

function domainsCsv(summary: ReturnType<typeof summarizeAudit>): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const site of summary.sites) {
    for (const condition of site.conditions) {
      for (const domain of condition.domains) {
        rows.push({
          site_id: site.siteId,
          condition: condition.condition,
          domain: domain.registrableDomain,
          classification: domain.classification.label,
          classification_text: TrackerClassifier.labelText(domain.classification),
          owner: domain.classification.owner ?? '',
          dataset: domain.classification.datasetName,
          runs_present: domain.runsPresent,
          runs_total: domain.totalRuns,
          total_requests: domain.totalRequests,
          requests_per_run: domain.requestsPerRun.join('|'),
          seen_before_consent_action: domain.seenBeforeConsentAction,
          set_cookie_attempts: domain.cookieSetAttempts,
          blocked_cookie_attempts: domain.blockedCookieAttempts,
          stored_cookies: domain.storedCookies,
        });
      }
    }
  }
  return toCsv(rows);
}

function exportReadme(auditId: string): string {
  return `# Audit evidence export — ${auditId}

This archive contains the complete raw evidence for one audit, so that a technically
competent third party can verify every number in the report independently.

## Layout

    audit/
      metadata.json        audit configuration, environment, browser identity, tracker dataset version
      summary.json         aggregated results per site and consent condition (min / median / max per metric)
      summary.csv          the same aggregation, flattened for spreadsheets
      domains.csv          every third-party domain per site and condition, with classification and presence counts
      report.pdf           the shareable technical report, if it was generated before the export
      publiekssamenvatting.pdf   the plain-Dutch public summary, if it was generated
      runs/<run-id>/
        metadata.json      run metadata, consent bookkeeping, timeline, screenshots index, failures, metrics
        requests.json      every network request observed in the run
        requests.csv       the same, flattened
        cookies.json       cookie checkpoints (what was actually stored) and every Set-Cookie / cookie-send attempt
        cookie-attempts.csv the attempts, flattened, including blocked attempts and the browser's reason
        storage.json       localStorage, sessionStorage, IndexedDB databases, cache keys, service workers
        frames.json        every frame observed, with its origin and whether it is third party
        ad-observations.json geometry of detected advertising slots at each checkpoint
        timeline.json      what the runner did, when
        screenshots/       PNG screenshots at fixed checkpoints, plus cropped images of detected ad slots
        network.har        full HAR network capture (sanitised)
        trace.zip          Playwright trace: open with \`npx playwright show-trace trace.zip\`
        video.webm         session video, if recording was enabled

## Reading the values

* A metric of \`null\` (JSON) or \`not_measured\` (CSV) means the measurement did not happen or failed.
  It does **not** mean zero. Runs whose consent action could not be confirmed are excluded from the
  aggregates of that condition; the run files themselves are still included here.
* \`isThirdParty\` is computed against the registrable domain (eTLD+1) of the audited site.
* Classification labels come from the dataset named in \`audit/metadata.json\` under \`trackerDataset\`,
  pinned to an exact version.

## Sanitisation

To avoid creating a new privacy problem, this export never contains raw cookie values, raw storage values,
authorisation headers, POST bodies or response bodies. Cookie and storage values are represented by their
length and a SHA-256 hash. URL parameters that look like identifiers are replaced by
\`<redacted:len=..,sha256=..>\`, which keeps the structure of the request inspectable while removing the
identifier itself. The hashes are stable within an export, so repeated appearances of the same value can
still be correlated.

## Reproducing

    git checkout <commit from audit/metadata.json -> environment.gitCommit>
    npm run trackers:update      # installs the pinned classification dataset
    docker compose up --build
    docker compose run --rm audit npm run audit -- all
`;
}
