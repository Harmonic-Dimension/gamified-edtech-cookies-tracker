import type { AuditMetadata, RunResult, ConsentCondition } from '../types.js';
import type { AuditSummary, SiteSummary, ConditionSummary } from '../report/aggregate.js';
import { CONDITION_LABELS, METRIC_LABELS, consentTimeline } from '../report/aggregate.js';
import { TrackerClassifier } from '../trackers/dataset.js';
import { renderMarkdown } from '../report/markdown.js';
import {
  escapeHtml,
  statCell,
  statValuesList,
  runStatusBadge,
  consentStatusBadge,
  formatDateTime,
} from '../report/format.js';

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; margin: 0; background: #f6f7f5; color: #1c1c1c; }
  header.top { background: #23372b; color: #fff; padding: 14px 22px; }
  header.top a { color: #cfe4d4; text-decoration: none; margin-right: 16px; }
  header.top h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; }
  main { max-width: 1500px; margin: 0 auto; padding: 22px; }
  h2 { font-size: 19px; margin: 26px 0 10px; }
  h3 { font-size: 15px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; margin-bottom: 18px; }
  th, td { border: 1px solid #dcdcd8; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eceee9; position: sticky; top: 0; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr:nth-child(even) td { background: #fbfbfa; }
  .card { background: #fff; border: 1px solid #dcdcd8; border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid #bbb; white-space: nowrap; }
  .badge-completed, .badge-ok { background: #e2f2e4; border-color: #7ba97f; }
  .badge-partial, .badge-warn { background: #fdf1dd; border-color: #d1a45a; }
  .badge-failed, .badge-bad { background: #fbe3e0; border-color: #c4776c; }
  .badge-neutral { background: #eee; }
  .na { color: #a33; font-style: italic; }
  .range { color: #777; font-weight: normal; }
  .warn { color: #b26a00; font-weight: 700; }
  .muted { color: #666; font-size: 12px; }
  a { color: #1c5c36; }
  .shot { border: 1px solid #ccc; width: 100%; display: block; background: #fff; }
  figure { margin: 0 0 14px; }
  figcaption { font-size: 11px; color: #555; padding-top: 4px; }
  button, .button { background: #23372b; color: #fff; border: 0; padding: 8px 13px; border-radius: 4px; cursor: pointer; font-size: 13px; text-decoration: none; display: inline-block; }
  button.secondary { background: #6b7d70; }
  form.inline { display: inline-block; margin-right: 8px; }
  select, input[type=number], input[type=text] { padding: 6px; border: 1px solid #bbb; border-radius: 4px; font-size: 13px; }
  .notice { background: #fdf3e7; border-left: 4px solid #c07000; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .info { background: #eef4f8; border-left: 4px solid #4a7ba1; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  pre { background: #f2f2ef; padding: 10px; overflow-x: auto; font-size: 12px; }
  .scroll { overflow-x: auto; }
  .kv { display: grid; grid-template-columns: 220px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv dt { color: #555; }
  .kv dd { margin: 0; }
  .filters { margin-bottom: 10px; font-size: 13px; }
`;

export function layout(title: string, body: string, options: { auditId?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Educational site privacy audit</title><style>${CSS}</style></head>
<body>
<header class="top">
  <h1>Privacy, cookie, tracker and advertising audit of educational practice websites</h1>
  <nav>
    <a href="/">Overview</a>
    <a href="/audits">All audits</a>
    ${options.auditId ? `<a href="/audits/${escapeHtml(options.auditId)}">Comparison</a>
    <a href="/audits/${escapeHtml(options.auditId)}/gallery">Ad gallery</a>
    <a href="/audits/${escapeHtml(options.auditId)}/report.html">Report preview</a>` : ''}
    <a href="/methodology">Methodology</a>
  </nav>
</header>
<main>${body}</main>
</body></html>`;
}

export function overviewPage(input: {
  audits: AuditMetadata[];
  latest: AuditSummary | null;
  siteRows: Array<{ siteId: string; siteName: string; startUrl: string; latestRunAt: string | null; runCount: number; status: string }>;
  datasetInfo: ReturnType<TrackerClassifier['datasetInfo']>;
  jobs: Array<{ id: string; label: string; status: string; progress: string; startedAt: string }>;
  siteOptions: Array<{ id: string; name: string }>;
}): string {
  const { latest, siteRows, datasetInfo, jobs } = input;
  const jobRows = jobs
    .map(
      (job) => `<tr><td>${escapeHtml(job.label)}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.progress)}</td>
      <td>${formatDateTime(job.startedAt)}</td>
      <td>${job.status === 'running' ? `<form method="post" action="/api/jobs/${job.id}/cancel" class="inline"><button class="secondary">Cancel</button></form>` : ''}</td></tr>`,
    )
    .join('');

  return layout('Overview', `
<div class="card">
  <h2 style="margin-top:0">Websites under audit</h2>
  <table>
    <thead><tr><th>Website</th><th>Entry URL</th><th>Latest audit</th><th class="num">Runs recorded</th><th>Status</th></tr></thead>
    <tbody>
      ${siteRows
        .map(
          (row) => `<tr>
        <td>${latest ? `<a href="/audits/${escapeHtml(latest.audit.auditId)}/sites/${escapeHtml(row.siteId)}">${escapeHtml(row.siteName)}</a>` : escapeHtml(row.siteName)}</td>
        <td class="muted">${escapeHtml(row.startUrl)}</td>
        <td>${formatDateTime(row.latestRunAt)}</td>
        <td class="num">${row.runCount}</td>
        <td>${escapeHtml(row.status)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
  <p class="muted">
    Browser used in the most recent audit:
    ${latest?.audit.browser
      ? `${escapeHtml(latest.audit.browser.engine)} ${escapeHtml(latest.audit.browser.version)}${latest.audit.browser.isGoogleChromeStable ? ' (Google Chrome Stable)' : ' — not Google Chrome Stable'}`
      : 'no audit recorded yet'}
  </p>
</div>

<div class="card">
  <h2 style="margin-top:0">Start an audit</h2>
  <form method="post" action="/api/audits">
    <label>Website
      <select name="site">
        <option value="all">All four websites</option>
        ${input.siteOptions.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join('')}
      </select>
    </label>
    <label>Condition
      <select name="condition">
        <option value="all">All three conditions</option>
        <option value="no_choice">A. No consent choice</option>
        <option value="reject_all">B. Reject all</option>
        <option value="accept_all">C. Accept all</option>
      </select>
    </label>
    <label>Repetitions <input type="number" name="repetitions" value="3" min="1" max="20" style="width:70px"></label>
    <label><input type="checkbox" name="video" value="1"> record video</label>
    <button type="submit">Run audit</button>
  </form>
  <form method="post" action="/api/audits" style="margin-top:10px">
    <input type="hidden" name="interactive" value="1">
    <input type="hidden" name="repetitions" value="1">
    <label>Interactive session:
      <select name="site">
        ${input.siteOptions.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join('')}
      </select>
    </label>
    <label>
      <select name="condition">
        <option value="reject_all">B. Reject all</option>
        <option value="accept_all">C. Accept all</option>
        <option value="no_choice">A. No consent choice</option>
      </select>
    </label>
    <button type="submit" class="secondary">Run interactively (visible browser)</button>
  </form>
  <p class="muted">
    An interactive run opens a visible browser window and keeps recording while you use the page yourself.
    Inside Docker the window is shown at <a href="http://localhost:6080/vnc.html" target="_blank" rel="noreferrer">http://localhost:6080/vnc.html</a> (noVNC).
    Finish the session from the run page to save the evidence.
  </p>
</div>

${jobs.length ? `<div class="card"><h2 style="margin-top:0">Audit jobs</h2>
  <table><thead><tr><th>Label</th><th>Status</th><th>Progress</th><th>Started</th><th></th></tr></thead><tbody>${jobRows}</tbody></table>
  <p class="muted">This page does not refresh automatically; reload to see progress.</p></div>` : ''}

<div class="card">
  <h2 style="margin-top:0">Classification dataset</h2>
  ${datasetInfo.available
    ? `<div class="kv">
        <dt>Dataset</dt><dd>${escapeHtml(datasetInfo.name)}</dd>
        <dt>Version / commit</dt><dd><code>${escapeHtml(datasetInfo.commit ?? datasetInfo.version)}</code></dd>
        <dt>Entries</dt><dd>${datasetInfo.entryCount ?? '–'} registrable domains</dd>
        <dt>Retrieved</dt><dd>${formatDateTime(datasetInfo.retrievedAt)}</dd>
        <dt>Note</dt><dd>${escapeHtml(datasetInfo.note ?? '')}</dd>
      </div>`
    : `<div class="notice">No classification dataset is installed. Tracker and advertising counts will be reported as
        "not measured" rather than as zero. Run <code>npm run trackers:update</code> to install the pinned dataset.</div>`}
</div>

<div class="card">
  <h2 style="margin-top:0">Recent audits</h2>
  <table>
    <thead><tr><th>Started</th><th>Label</th><th>Status</th><th class="num">Runs</th><th>Actions</th></tr></thead>
    <tbody>${input.audits
      .slice(0, 15)
      .map(
        (audit) => `<tr>
      <td>${formatDateTime(audit.startedAt)}</td>
      <td><a href="/audits/${escapeHtml(audit.auditId)}">${escapeHtml(audit.label)}</a></td>
      <td>${escapeHtml(audit.status)}</td>
      <td class="num">${audit.runIds.length}</td>
      <td><a href="/audits/${escapeHtml(audit.auditId)}/report.pdf">PDF</a> ·
          <a href="/audits/${escapeHtml(audit.auditId)}/samenvatting.pdf">NL</a> ·
          <a href="/audits/${escapeHtml(audit.auditId)}/export.zip">ZIP</a></td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>
</div>
`);
}

const COMPARISON_METRICS: Array<keyof typeof METRIC_LABELS> = [
  'totalRequests',
  'thirdPartyRequests',
  'uniqueThirdPartyDomains',
  'requestsBeforeConsentAction',
  'knownTrackerDomains',
  'advertisingDomains',
  'storedCookies',
  'thirdPartyStoredCookies',
  'setCookieAttempts',
  'blockedSetCookieAttempts',
  'blockedCookieSends',
  'localStorageEntries',
  'serviceWorkers',
  'thirdPartyFrames',
  'visibleAdSlots',
];

export function auditPage(summary: AuditSummary): string {
  const audit = summary.audit;
  const rows: string[] = [];
  for (const site of summary.sites) {
    for (const condition of site.conditions) {
      const confirmed = condition.consentStatusCounts.confirmed ?? 0;
      const consentCell =
        condition.condition === 'no_choice'
          ? '<span class="badge badge-neutral">no interaction</span>'
          : `${confirmed}/${condition.runCount} confirmed` +
            (condition.consentStatusCounts.failed || condition.consentStatusCounts.no_banner
              ? ` <span class="warn" title="runs where the consent action could not be carried out">· ${(condition.consentStatusCounts.failed ?? 0) + (condition.consentStatusCounts.no_banner ?? 0)} failed</span>`
              : '');
      rows.push(`<tr>
        <td><a href="/audits/${escapeHtml(audit.auditId)}/sites/${escapeHtml(site.siteId)}">${escapeHtml(site.siteName)}</a></td>
        <td>${escapeHtml(CONDITION_LABELS[condition.condition])}</td>
        <td class="num">${condition.usableRunCount}/${condition.runCount}</td>
        <td>${consentCell}</td>
        ${COMPARISON_METRICS.map((key) => `<td class="num">${statCell(condition.metrics[key as keyof ConditionSummary['metrics']])}</td>`).join('')}
        <td class="num">${statCell(condition.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
      </tr>`);
    }
  }

  return layout(`Audit ${audit.auditId.slice(0, 8)}`, `
<h2>${escapeHtml(audit.label)}</h2>
<div class="card">
  <div class="kv">
    <dt>Audit id</dt><dd><code>${escapeHtml(audit.auditId)}</code></dd>
    <dt>Started / finished</dt><dd>${formatDateTime(audit.startedAt)} — ${formatDateTime(audit.finishedAt)}</dd>
    <dt>Status</dt><dd>${escapeHtml(audit.status)}</dd>
    <dt>Runs</dt><dd>${summary.totalRuns} recorded (${summary.failedRuns} failed, ${summary.partialRuns} partial)</dd>
    <dt>Repetitions</dt><dd>${audit.repetitions} per site and condition</dd>
    <dt>Browser</dt><dd>${audit.browser ? `${escapeHtml(audit.browser.engine)} ${escapeHtml(audit.browser.version)} ${audit.browser.isGoogleChromeStable ? '(Google Chrome Stable)' : '(not Google Chrome Stable)'}` : '–'}</dd>
    <dt>Viewport / locale</dt><dd>${audit.config.viewport.width}×${audit.config.viewport.height}, ${escapeHtml(audit.config.locale)}, ${escapeHtml(audit.config.timezoneId)}</dd>
    <dt>Playwright / Node</dt><dd>${escapeHtml(audit.environment.playwright)} / ${escapeHtml(audit.environment.node)}</dd>
    <dt>Software commit</dt><dd><code>${escapeHtml(audit.environment.gitCommit ?? 'n/a')}</code>${audit.environment.gitDirty ? ' <span class="warn">(modified working tree)</span>' : ''}</dd>
    <dt>Classification dataset</dt><dd>${escapeHtml(audit.trackerDataset.name)} ${escapeHtml(audit.trackerDataset.version)}</dd>
  </div>
  <p style="margin-top:12px">
    <a class="button" href="/audits/${escapeHtml(audit.auditId)}/report.pdf">Download PDF report</a>
    <a class="button secondary" href="/audits/${escapeHtml(audit.auditId)}/samenvatting.pdf">Download publiekssamenvatting (NL)</a>
    <a class="button secondary" href="/audits/${escapeHtml(audit.auditId)}/export.zip">Download raw evidence (ZIP)</a>
    <a class="button secondary" href="/audits/${escapeHtml(audit.auditId)}/gallery">Visual ad gallery</a>
  </p>
</div>

${audit.notes.length ? `<div class="notice">${audit.notes.map((note) => escapeHtml(note)).join('<br>')}</div>` : ''}
${audit.status === 'running' || audit.status === 'cancelled'
    ? `<div class="notice">This audit is incomplete (${summary.totalRuns} of
        ${audit.sites.length * audit.conditions.length * audit.repetitions} planned runs recorded).
        Finish it without repeating the runs it already has:
        <br><code>docker compose run --rm audit npm run audit -- all --resume ${escapeHtml(audit.auditId)}</code></div>`
    : ''}

<h3>Comparison table</h3>
<p class="muted">Median across usable runs, with the min–max range. <span class="na">not measured</span> means no usable run produced this value — it is never shown as 0.
In condition A no consent action is performed, so for those rows "before the consent action" covers the whole run.</p>
<div class="scroll">
<table>
  <thead><tr>
    <th>Website</th><th>Condition</th><th class="num">Usable runs</th><th>Consent</th>
    ${COMPARISON_METRICS.map((key) => `<th class="num">${escapeHtml(METRIC_LABELS[key] ?? String(key))}</th>`).join('')}
    <th class="num">${escapeHtml(METRIC_LABELS.maxVisibleAdAreaFraction)}</th>
  </tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>
</div>
`, { auditId: audit.auditId });
}

export function sitePage(summary: AuditSummary, site: SiteSummary, runs: RunResult[]): string {
  const auditId = summary.audit.auditId;
  const conditionBlocks = site.conditions
    .map((condition) => {
      const conditionRuns = runs.filter((run) => run.condition === condition.condition);
      return `
<h3>${escapeHtml(CONDITION_LABELS[condition.condition])}</h3>
<div class="card">
  <p class="muted">${condition.usableRunCount} of ${condition.runCount} runs are usable as evidence for this condition.
  Consent bookkeeping: ${Object.entries(condition.consentStatusCounts).map(([k, v]) => `${escapeHtml(k.replace(/_/g, ' '))} ×${v}`).join(', ') || '–'}.</p>
  <table>
    <thead><tr><th>Metric</th><th>Median (min–max)</th><th>Individual runs</th></tr></thead>
    <tbody>
      ${Object.keys(METRIC_LABELS)
        .map((key) => {
          const stats = condition.metrics[key as keyof ConditionSummary['metrics']];
          const percent = key === 'maxVisibleAdAreaFraction';
          return `<tr><td>${escapeHtml(METRIC_LABELS[key])}</td>
            <td class="num">${statCell(stats, { percent })}</td>
            <td class="muted">${statValuesList(stats, { percent })}</td></tr>`;
        })
        .join('')}
    </tbody>
  </table>

  ${consentTimelineTable(conditionRuns)}

  <h4>Third-party domains</h4>
  <div class="scroll">
  <table>
    <thead><tr><th>Domain</th><th>Operator</th><th>Classification</th><th class="num">Present in</th><th class="num">Requests/run</th><th class="num">Set-Cookie attempts</th><th class="num">Blocked</th><th>Before consent action</th></tr></thead>
    <tbody>${condition.domains
      .map(
        (domain) => `<tr>
      <td><code>${escapeHtml(domain.registrableDomain)}</code></td>
      <td>${escapeHtml(domain.classification.owner ?? '–')}</td>
      <td>${escapeHtml(TrackerClassifier.labelText(domain.classification))}</td>
      <td class="num">${domain.runsPresent}/${domain.totalRuns}</td>
      <td class="num">${domain.requestsPerRun.join(' · ')}</td>
      <td class="num">${domain.cookieSetAttempts}</td>
      <td class="num">${domain.blockedCookieAttempts}</td>
      <td>${domain.seenBeforeConsentAction ? 'yes' : 'no'}</td>
    </tr>`,
      )
      .join('') || '<tr><td colspan="8" class="muted">No usable runs for this condition.</td></tr>'}</tbody>
  </table>
  </div>

  <h4>Runs</h4>
  <table>
    <thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Consent</th><th>Exercise reached</th><th class="num">Requests</th><th class="num">3rd-party domains</th><th class="num">Cookies</th><th>Evidence</th></tr></thead>
    <tbody>${conditionRuns
      .map(
        (run) => `<tr>
      <td><a href="/runs/${escapeHtml(auditId)}/${escapeHtml(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a> (#${run.repetition})</td>
      <td>${formatDateTime(run.startedAt)}</td>
      <td>${runStatusBadge(run.status)}</td>
      <td>${consentStatusBadge(run.consent.status)}</td>
      <td>${run.exercise.reached === null ? '–' : run.exercise.reached ? 'yes' : '<span class="warn">no</span>'}</td>
      <td class="num">${run.metrics.totalRequests ?? '<span class="na">n/m</span>'}</td>
      <td class="num">${run.metrics.uniqueThirdPartyDomains ?? '<span class="na">n/m</span>'}</td>
      <td class="num">${run.metrics.storedCookies ?? '<span class="na">n/m</span>'}</td>
      <td>${run.artifacts.har ? `<a href="/artifacts/${auditId}/${run.runId}/network.har">HAR</a> ` : ''}
          ${run.artifacts.trace ? `<a href="/artifacts/${auditId}/${run.runId}/trace.zip">trace</a> ` : ''}
          ${run.artifacts.video ? `<a href="/artifacts/${auditId}/${run.runId}/video.webm">video</a>` : ''}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>
</div>`;
    })
    .join('');

  return layout(site.siteName, `
<h2>${escapeHtml(site.siteName)}</h2>
<p class="muted">${escapeHtml(site.startUrl)} · audit <code>${escapeHtml(auditId)}</code></p>
${rejectAcceptComparison(site)}
${conditionBlocks}
`, { auditId });
}

/**
 * Shows third-party request activity in five-second buckets around the moment
 * the consent decision was made, so "what happened before the choice" and
 * "what happened right after it" can be read off directly.
 */
function consentTimelineTable(runs: RunResult[]): string {
  const usable = runs.filter((run) => run.status !== 'failed').slice(0, 5);
  if (!usable.length) return '';
  const timelines = usable.map((run) => ({ run, timeline: consentTimeline(run) }));
  const header = timelines[0].timeline.buckets
    .map((bucket) => `<th class="num">${bucket.fromMs / 1000}s</th>`)
    .join('');
  const rows = timelines
    .map(
      ({ run, timeline }) => `<tr>
        <td><a href="/runs/${escapeHtml(run.auditId)}/${escapeHtml(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td>
        <td class="muted">${timeline.anchoredOn === 'consent_action' ? 'consent action' : 'page load'}</td>
        ${timeline.buckets
          .map(
            (bucket) =>
              `<td class="num"${bucket.fromMs < 0 ? ' style="background:#fdf1dd"' : ''}>${bucket.thirdPartyRequests}<br><span class="muted">${bucket.distinctDomains}d</span></td>`,
          )
          .join('')}
      </tr>`,
    )
    .join('');
  return `<h4>Timeline around the consent decision</h4>
  <p class="muted">Third-party requests per five seconds, relative to the moment the consent action was performed
  (0s). The shaded columns are <em>before</em> the decision. The small number is how many distinct third-party
  domains were involved in that interval.</p>
  <div class="scroll"><table>
    <thead><tr><th>Run</th><th>0s =</th>${header}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function rejectAcceptComparison(site: SiteSummary): string {
  const reject = site.conditions.find((c) => c.condition === 'reject_all');
  const accept = site.conditions.find((c) => c.condition === 'accept_all');
  const noChoice = site.conditions.find((c) => c.condition === 'no_choice');
  if (!reject && !accept) return '';
  return `
<div class="card">
  <h3 style="margin-top:0">Reject all vs. accept all</h3>
  <table>
    <thead><tr><th>Metric</th><th class="num">A. No choice</th><th class="num">B. Reject all</th><th class="num">C. Accept all</th></tr></thead>
    <tbody>
      ${COMPARISON_METRICS.map(
        (key) => `<tr><td>${escapeHtml(METRIC_LABELS[key] ?? String(key))}</td>
        <td class="num">${statCell(noChoice?.metrics[key as keyof ConditionSummary['metrics']])}</td>
        <td class="num">${statCell(reject?.metrics[key as keyof ConditionSummary['metrics']])}</td>
        <td class="num">${statCell(accept?.metrics[key as keyof ConditionSummary['metrics']])}</td></tr>`,
      ).join('')}
      <tr><td>${escapeHtml(METRIC_LABELS.maxVisibleAdAreaFraction)}</td>
        <td class="num">${statCell(noChoice?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
        <td class="num">${statCell(reject?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
        <td class="num">${statCell(accept?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td></tr>
    </tbody>
  </table>
</div>`;
}

export function runPage(run: RunResult, options: { interactiveRunning: boolean }): string {
  const auditId = run.auditId;
  const artifact = (file: string) => `/artifacts/${auditId}/${run.runId}/${file}`;
  const finalCookies = run.cookieCheckpoints[run.cookieCheckpoints.length - 1];
  const finalStorage = run.storageCheckpoints[run.storageCheckpoints.length - 1];

  return layout(`Run ${run.runId.slice(0, 8)}`, `
<h2>${escapeHtml(run.siteName)} — ${escapeHtml(CONDITION_LABELS[run.condition])} — run #${run.repetition}</h2>
<p>${runStatusBadge(run.status)} ${consentStatusBadge(run.consent.status)}
   <span class="muted">${formatDateTime(run.startedAt)} · ${Math.round(run.durationMs / 1000)}s · <code>${escapeHtml(run.runId)}</code></span></p>

${options.interactiveRunning ? `<div class="notice">
  This interactive run is still in progress. The visible browser window is being recorded.
  <form method="post" action="/api/runs/${escapeHtml(auditId)}/${escapeHtml(run.runId)}/finish" class="inline">
    <button>Finish run and save evidence</button>
  </form>
</div>` : ''}

${run.failures.length ? `<div class="notice"><strong>Recorded problems</strong><ul>${run.failures
    .map((failure) => `<li>${failure.fatal ? '<strong>fatal</strong> ' : ''}${escapeHtml(failure.stage)}: ${escapeHtml(failure.message)}</li>`)
    .join('')}</ul></div>` : ''}

<div class="card">
  <h3 style="margin-top:0">Metadata</h3>
  <div class="kv">
    <dt>Site / URL</dt><dd>${escapeHtml(run.siteName)} — ${escapeHtml(run.startUrl)}</dd>
    <dt>Condition</dt><dd>${escapeHtml(CONDITION_LABELS[run.condition])}</dd>
    <dt>Browser</dt><dd>${escapeHtml(run.browser.engine)} ${escapeHtml(run.browser.version)} ${run.browser.isGoogleChromeStable ? '(Google Chrome Stable)' : '(not Google Chrome Stable)'} · headless=${run.browser.headless}</dd>
    <dt>User agent</dt><dd class="muted">${escapeHtml(run.browser.userAgent)}</dd>
    <dt>Viewport / scale</dt><dd>${run.config.viewport.width}×${run.config.viewport.height} @${run.config.deviceScaleFactor}</dd>
    <dt>Locale / timezone</dt><dd>${escapeHtml(run.config.locale)} / ${escapeHtml(run.config.timezoneId)}</dd>
    <dt>Environment</dt><dd>${escapeHtml(run.environment.osRelease)} · Node ${escapeHtml(run.environment.node)} · Playwright ${escapeHtml(run.environment.playwright)}${run.environment.inDocker ? ' · Docker' : ''}</dd>
    <dt>Commit</dt><dd><code>${escapeHtml(run.environment.gitCommit ?? 'n/a')}</code></dd>
    <dt>Exercise</dt><dd>${run.exercise.attempted ? `attempted, reached=${run.exercise.reached === null ? 'unknown' : run.exercise.reached}` : 'not attempted'}
      ${run.exercise.url ? `<br><span class="muted">${escapeHtml(run.exercise.url)}</span>` : ''}
      ${run.exercise.stepsExecuted.length ? `<br><span class="muted">${run.exercise.stepsExecuted.map((step) => escapeHtml(step)).join(' → ')}</span>` : ''}
      ${run.exercise.notes.length ? `<div class="info" style="margin-top:6px">${run.exercise.notes.map((note) => escapeHtml(note)).join('<br>')}</div>` : ''}</dd>
  </div>
  <p style="margin-top:10px">
    ${run.artifacts.har ? `<a class="button secondary" href="${artifact('network.har')}">HAR</a> ` : ''}
    ${run.artifacts.trace ? `<a class="button secondary" href="${artifact('trace.zip')}">Playwright trace</a> ` : ''}
    ${run.artifacts.video ? `<a class="button secondary" href="${artifact('video.webm')}">Video</a> ` : ''}
    <a class="button secondary" href="/api/runs/${escapeHtml(auditId)}/${escapeHtml(run.runId)}/run.json">run.json</a>
  </p>
</div>

<div class="card">
  <h3 style="margin-top:0">Consent bookkeeping</h3>
  <div class="kv">
    <dt>Requested action</dt><dd>${escapeHtml(run.consent.actionRequested)}</dd>
    <dt>Banner detected</dt><dd>${run.consent.bannerDetected === null ? 'unknown' : run.consent.bannerDetected ? `yes (${escapeHtml(run.consent.bannerDetectorUsed ?? '')})` : 'no'}</dd>
    <dt>Steps executed</dt><dd>${run.consent.stepsExecuted.map((step) => escapeHtml(step)).join('<br>') || '–'}</dd>
    <dt>Banner dismissed</dt><dd>${run.consent.bannerDismissed === null ? 'unknown' : run.consent.bannerDismissed ? 'yes' : 'no'}</dd>
    <dt>State read back</dt><dd>${run.consent.stateProbe
      ? `${escapeHtml(run.consent.stateProbe.method)}: purposes consented ${run.consent.stateProbe.purposeConsentsTrue ?? '?'} / ${run.consent.stateProbe.purposeConsentsTotal ?? '?'}, vendors ${run.consent.stateProbe.vendorConsentsTrue ?? '?'} / ${run.consent.stateProbe.vendorConsentsTotal ?? '?'} — matches requested condition: ${run.consent.stateProbe.matchesRequestedCondition === null ? 'inconclusive' : run.consent.stateProbe.matchesRequestedCondition ? 'yes' : 'no'}`
      : 'not probed'}</dd>
    <dt>Notes</dt><dd>${run.consent.notes.map((note) => escapeHtml(note)).join('<br>') || '–'}</dd>
  </div>
</div>

<div class="card">
  <h3 style="margin-top:0">Timeline</h3>
  <table><thead><tr><th class="num">t (s)</th><th>Event</th><th>Detail</th></tr></thead>
  <tbody>${run.timeline
    .map((entry) => `<tr><td class="num">${(entry.tRelMs / 1000).toFixed(1)}</td><td>${escapeHtml(entry.type)}</td><td>${escapeHtml(entry.detail)}</td></tr>`)
    .join('')}</tbody></table>
</div>

<div class="card">
  <h3 style="margin-top:0">Screenshots</h3>
  <div class="grid">
    ${run.screenshots
      .map(
        (shot) => `<figure>
      <a href="${artifact(shot.file.replace(/\\/g, '/'))}" target="_blank" rel="noreferrer"><img class="shot" src="${artifact(shot.file.replace(/\\/g, '/'))}" alt="${escapeHtml(shot.label)}"></a>
      <figcaption>${escapeHtml(shot.label)} · ${(shot.tRelMs / 1000).toFixed(1)}s · ${shot.viewport.width}×${shot.viewport.height}${shot.fullPage ? ' · full page' : ''}
      <br><a href="/annotate/${escapeHtml(auditId)}/${escapeHtml(run.runId)}?file=${encodeURIComponent(shot.file)}">mark advertising regions</a></figcaption>
    </figure>`,
      )
      .join('')}
  </div>
</div>

<div class="card">
  <h3 style="margin-top:0">Advertising slots observed</h3>
  ${run.adObservations
    .map(
      (observation) => `<h4>${escapeHtml(observation.label)} — ${(observation.tRelMs / 1000).toFixed(1)}s ·
        ${observation.slots.filter((slot) => slot.inViewport).length} visible slots ·
        ${(observation.visibleAdAreaFraction * 100).toFixed(1)}% of the viewport</h4>
      ${observation.error ? `<p class="notice">${escapeHtml(observation.error)}</p>` : ''}
      <table><thead><tr><th>Detector</th><th>Selector</th><th class="num">Position</th><th class="num">Size</th><th>In viewport</th><th>Frame source</th></tr></thead>
      <tbody>${observation.slots
        .map(
          (slot) => `<tr><td>${escapeHtml(slot.detector)}</td><td class="muted">${escapeHtml(slot.selector)}</td>
        <td class="num">${slot.x},${slot.y}</td><td class="num">${slot.width}×${slot.height}</td>
        <td>${slot.inViewport ? 'yes' : 'no'}</td><td class="muted">${escapeHtml(slot.iframeDomain ?? slot.iframeSrc ?? '–')}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
    .join('') || '<p class="muted">No advertising observation was recorded for this run.</p>'}
</div>

<div class="card">
  <h3 style="margin-top:0">Cookies stored at the end of the run</h3>
  ${finalCookies
    ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Domain</th><th>Path</th><th>Expires</th><th class="num">Lifetime (days)</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th><th>Host-only</th><th class="num">Value length</th><th>Value SHA-256</th><th>Party</th></tr></thead>
      <tbody>${finalCookies.cookies
        .map(
          (cookie) => `<tr><td>${escapeHtml(cookie.name)}</td><td>${escapeHtml(cookie.domain)}</td><td>${escapeHtml(cookie.path)}</td>
        <td>${cookie.expiresIso ? escapeHtml(cookie.expiresIso.slice(0, 10)) : 'session'}</td>
        <td class="num">${cookie.lifetimeDays ?? '–'}</td>
        <td>${cookie.secure ? 'yes' : 'no'}</td><td>${cookie.httpOnly ? 'yes' : 'no'}</td><td>${escapeHtml(cookie.sameSite ?? '–')}</td>
        <td>${cookie.hostOnly ? 'yes' : 'no'}</td><td class="num">${cookie.valueLength}</td>
        <td class="muted"><code>${escapeHtml(cookie.valueSha256.slice(0, 16))}…</code></td>
        <td>${cookie.isThirdParty ? 'third party' : 'first party'}</td></tr>`,
        )
        .join('')}</tbody></table></div>
      <p class="muted">Cookie values are never stored by this tool; only their length and SHA-256 hash.</p>`
    : '<p class="na">Cookies could not be captured in this run.</p>'}
</div>

<div class="card">
  <h3 style="margin-top:0">Cookie set attempts (including blocked)</h3>
  <div class="scroll"><table><thead><tr><th class="num">t (s)</th><th>Source</th><th>Name</th><th>Domain</th><th>Blocked</th><th>Reasons</th><th>Party</th><th>Before consent action</th></tr></thead>
  <tbody>${run.cookieSetAttempts
    .slice(0, 400)
    .map(
      (attempt) => `<tr><td class="num">${(attempt.tRelMs / 1000).toFixed(1)}</td><td>${escapeHtml(attempt.source)}</td>
    <td>${escapeHtml(attempt.name)}</td><td>${escapeHtml(attempt.domain ?? '–')}</td>
    <td>${attempt.blocked ? '<span class="warn">blocked</span>' : 'stored/sent'}</td>
    <td class="muted">${escapeHtml(attempt.blockedReasons.join(', '))}</td>
    <td>${attempt.isThirdParty === null ? '?' : attempt.isThirdParty ? 'third party' : 'first party'}</td>
    <td>${attempt.beforeConsentAction ? 'yes' : 'no'}</td></tr>`,
    )
    .join('')}</tbody></table></div>
  ${run.cookieSetAttempts.length > 400 ? `<p class="muted">Showing the first 400 of ${run.cookieSetAttempts.length} attempts; the full list is in the ZIP export.</p>` : ''}
</div>

<div class="card">
  <h3 style="margin-top:0">Browser storage</h3>
  ${finalStorage
    ? finalStorage.origins
        .map(
          (origin) => `<h4>${escapeHtml(origin.origin)}</h4>
      ${origin.error ? `<p class="muted">${escapeHtml(origin.error)}</p>` : ''}
      <p class="muted">localStorage: ${origin.localStorage ? `${origin.localStorage.length} entries` : 'not readable'} ·
        sessionStorage: ${origin.sessionStorage ? `${origin.sessionStorage.length} entries` : 'not readable'} ·
        IndexedDB: ${origin.indexedDbDatabases ? origin.indexedDbDatabases.join(', ') || 'none' : 'not readable'} ·
        cache storage: ${origin.cacheStorageKeys ? origin.cacheStorageKeys.join(', ') || 'none' : 'not readable'}</p>
      ${origin.localStorage && origin.localStorage.length
          ? `<table><thead><tr><th>Key</th><th class="num">Value length</th><th>Value SHA-256</th><th>Preview</th></tr></thead><tbody>${origin.localStorage
              .map(
                (entry) => `<tr><td>${escapeHtml(entry.key)}</td><td class="num">${entry.valueLength}</td>
          <td class="muted"><code>${escapeHtml(entry.valueSha256.slice(0, 16))}…</code></td><td class="muted">${escapeHtml(entry.valuePreview ?? '(withheld)')}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : ''}`,
        )
        .join('') + `<p class="muted">Service workers: ${finalStorage.serviceWorkers.length ? finalStorage.serviceWorkers.map((worker) => escapeHtml(worker)).join('<br>') : 'none'}</p>`
    : '<p class="na">Storage could not be captured in this run.</p>'}
</div>

<div class="card">
  <h3 style="margin-top:0">Frames</h3>
  <div class="scroll"><table><thead><tr><th class="num">t (s)</th><th>Frame URL</th><th>Registrable domain</th><th>Party</th><th>Phase</th></tr></thead>
  <tbody>${run.frames
    .map(
      (frame) => `<tr><td class="num">${(frame.firstSeenTRelMs / 1000).toFixed(1)}</td><td class="muted">${escapeHtml(frame.frameUrl.slice(0, 140))}</td>
    <td>${escapeHtml(frame.registrableDomain ?? '–')}</td><td>${frame.isThirdParty ? 'third party' : 'first party'}</td><td>${escapeHtml(frame.phase)}</td></tr>`,
    )
    .join('')}</tbody></table></div>
</div>

<div class="card">
  <h3 style="margin-top:0">Requests (${run.requests.length})</h3>
  <p class="muted">URLs are sanitised: identifier-like parameter values are replaced by their length and hash.</p>
  <div class="scroll" style="max-height:600px; overflow-y:auto">
  <table><thead><tr><th class="num">t (s)</th><th>Domain</th><th>Party</th><th>Type</th><th class="num">Status</th><th>Before consent</th><th>URL</th></tr></thead>
  <tbody>${run.requests
    .slice(0, 1500)
    .map(
      (request) => `<tr><td class="num">${(request.tRelMs / 1000).toFixed(1)}</td><td>${escapeHtml(request.registrableDomain ?? request.hostname)}</td>
    <td>${request.isThirdParty === null ? '?' : request.isThirdParty ? 'third' : 'first'}</td>
    <td>${escapeHtml(request.resourceType ?? '–')}</td><td class="num">${request.status ?? (request.failure ? 'failed' : '–')}</td>
    <td>${request.beforeConsentAction ? 'yes' : 'no'}</td>
    <td class="muted">${escapeHtml(request.url.slice(0, 160))}</td></tr>`,
    )
    .join('')}</tbody></table>
  </div>
  ${run.requests.length > 1500 ? `<p class="muted">Showing the first 1500 of ${run.requests.length} requests; the full list is in requests.json / requests.csv in the ZIP export.</p>` : ''}
</div>

${run.consoleErrors.length ? `<div class="card"><h3 style="margin-top:0">Browser console errors</h3><pre>${escapeHtml(run.consoleErrors.slice(0, 50).join('\n'))}</pre></div>` : ''}
`, { auditId });
}

/** Shown while a run (typically an interactive one) is still recording. */
export function inProgressRunPage(auditId: string, runId: string, interactive: boolean): string {
  return layout(`Run ${runId.slice(0, 8)}`, `
<h2>Run in progress</h2>
<div class="card">
  <p>This run is still recording. Its evidence file is written when the run finishes.</p>
  <p class="muted">Run <code>${escapeHtml(runId)}</code> · audit <code>${escapeHtml(auditId)}</code></p>
  ${interactive
    ? `<div class="info">
        The visible browser window is being recorded. Inside Docker you can watch and drive it at
        <a href="http://localhost:6080/vnc.html" target="_blank" rel="noreferrer">http://localhost:6080/vnc.html</a>.
      </div>
      <form method="post" action="/api/runs/${escapeHtml(auditId)}/${escapeHtml(runId)}/finish">
        <button>Finish run and save evidence</button>
      </form>`
    : ''}
  <p class="muted">Reload this page after finishing to see the recorded evidence.</p>
</div>
`, { auditId });
}

export function galleryPage(summary: AuditSummary, runs: RunResult[]): string {
  const auditId = summary.audit.auditId;
  const blocks = summary.sites
    .map((site) => {
      const conditions = (['no_choice', 'reject_all', 'accept_all'] as ConsentCondition[])
        .map((condition) => {
          const conditionRuns = runs.filter(
            (run) => run.siteId === site.siteId && run.condition === condition && run.status !== 'failed',
          );
          const figures = conditionRuns
            .slice(0, 3)
            .flatMap((run) => {
              const shots = run.screenshots.filter(
                (shot) => !shot.fullPage && /exercise|after-consent|after-10s|first-load/.test(shot.label),
              );
              const shot = shots.find((s) => /exercise-10s/.test(s.label)) ?? shots[shots.length - 1] ?? shots[0];
              if (!shot) return [];
              return [`<figure>
              <a href="/artifacts/${auditId}/${run.runId}/${shot.file}" target="_blank" rel="noreferrer">
                <img class="shot" src="/artifacts/${auditId}/${run.runId}/${shot.file}" alt="${escapeHtml(shot.label)}">
              </a>
              <figcaption>
                ${escapeHtml(shot.label)} · ${(shot.tRelMs / 1000).toFixed(0)}s into the run<br>
                ${escapeHtml(CONDITION_LABELS[condition])} · run <a href="/runs/${auditId}/${run.runId}">${escapeHtml(run.runId.slice(0, 8))}</a><br>
                ${formatDateTime(run.startedAt)} · ${shot.viewport.width}×${shot.viewport.height}
              </figcaption>
            </figure>`];
            })
            .join('');
          if (!figures) return `<h4>${escapeHtml(CONDITION_LABELS[condition])}</h4><p class="muted">No usable screenshots for this condition.</p>`;
          return `<h4>${escapeHtml(CONDITION_LABELS[condition])}</h4><div class="grid">${figures}</div>`;
        })
        .join('');
      return `<div class="card"><h3 style="margin-top:0">${escapeHtml(site.siteName)}</h3>${conditions}</div>`;
    })
    .join('');

  return layout('Visual ad gallery', `
<h2>What was on screen during the recorded runs</h2>
<div class="notice">
  Each image shows the advertising that was served during that one specific recorded run, at that moment, from
  this measurement environment. Programmatic advertising is chosen per impression: a different child, at a
  different moment, will generally see different advertisements. These screenshots prove that <em>this</em>
  advertisement was visible during <em>this</em> recorded run — nothing more.
</div>
${blocks}
`, { auditId });
}

export function annotatePage(auditId: string, runId: string, file: string, existing: unknown): string {
  const src = `/artifacts/${auditId}/${runId}/${file}`;
  return layout('Mark advertising regions', `
<h2>Mark advertising regions</h2>
<p class="muted">Drag on the screenshot to mark an area you consider advertising, then give it a short label.
Annotations are stored alongside the run and are included in the ZIP export. They are human judgements and are
kept separate from the automatic measurements.</p>
<div class="card">
  <div style="position:relative; display:inline-block">
    <img id="shot" src="${escapeHtml(src)}" style="max-width:100%; display:block">
    <canvas id="overlay" style="position:absolute; left:0; top:0; cursor:crosshair"></canvas>
  </div>
  <p><input type="text" id="label" placeholder="label, e.g. 'banner top'" style="width:260px">
     <button id="save">Save annotations</button>
     <button id="clear" class="secondary">Clear</button></p>
  <pre id="out">${escapeHtml(JSON.stringify(existing ?? [], null, 2))}</pre>
</div>
<script>
  const img = document.getElementById('shot');
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');
  let regions = ${JSON.stringify(existing ?? [])};
  let drag = null;
  function resize() { canvas.width = img.clientWidth; canvas.height = img.clientHeight; draw(); }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2; ctx.strokeStyle = '#c02020'; ctx.fillStyle = 'rgba(192,32,32,0.15)'; ctx.font = '12px sans-serif';
    for (const r of regions) {
      const x = r.xRel * canvas.width, y = r.yRel * canvas.height, w = r.wRel * canvas.width, h = r.hRel * canvas.height;
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#c02020'; ctx.fillText(r.label || '', x + 4, y + 14); ctx.fillStyle = 'rgba(192,32,32,0.15)';
    }
    if (drag) { ctx.strokeRect(drag.x, drag.y, drag.w, drag.h); }
  }
  img.addEventListener('load', resize); window.addEventListener('resize', resize);
  canvas.addEventListener('mousedown', (e) => { const r = canvas.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, w: 0, h: 0 }; });
  canvas.addEventListener('mousemove', (e) => { if (!drag) return; const r = canvas.getBoundingClientRect(); drag.w = e.clientX - r.left - drag.x; drag.h = e.clientY - r.top - drag.y; draw(); });
  canvas.addEventListener('mouseup', () => {
    if (!drag) return;
    if (Math.abs(drag.w) > 5 && Math.abs(drag.h) > 5) {
      const x = Math.min(drag.x, drag.x + drag.w), y = Math.min(drag.y, drag.y + drag.h);
      regions.push({ label: document.getElementById('label').value || 'advertising', xRel: x / canvas.width, yRel: y / canvas.height, wRel: Math.abs(drag.w) / canvas.width, hRel: Math.abs(drag.h) / canvas.height });
    }
    drag = null; draw(); document.getElementById('out').textContent = JSON.stringify(regions, null, 2);
  });
  document.getElementById('clear').addEventListener('click', () => { regions = []; draw(); document.getElementById('out').textContent = '[]'; });
  document.getElementById('save').addEventListener('click', async () => {
    await fetch('/api/annotations/${auditId}/${runId}', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: ${JSON.stringify(file)}, regions })
    });
    alert('Saved.');
  });
  resize();
</script>
`, { auditId });
}

/** Chrome-only page for simple content (audit list, job status). */
export function simplePage(title: string, body: string, options: { auditId?: string } = {}): string {
  return layout(title, body, options);
}

export function methodologyPage(markdown: string): string {
  return layout(
    'Methodology',
    `<div class="card" style="max-width:60em; line-height:1.55">
       <h2 style="margin-top:0">Methodology</h2>
       ${renderMarkdown(markdown)}
     </div>`,
  );
}

export function errorPage(message: string): string {
  return layout('Not found', `<div class="card"><h2>Something is missing</h2><p>${escapeHtml(message)}</p><p><a href="/">Back to the overview</a></p></div>`);
}
