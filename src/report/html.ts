import fs from 'node:fs';
import path from 'node:path';
import type { AuditSummary, SiteSummary, ConditionSummary } from './aggregate.js';
import { CONDITION_LABELS, METRIC_LABELS } from './aggregate.js';
import type { DomainClassification, RunResult } from '../types.js';
import { escapeHtml, statCell, statValuesList, formatDateTime } from './format.js';
import { runDir } from '../store/store.js';
import { TrackerClassifier } from '../trackers/dataset.js';
import { checkpointLabel, collectCreatives, creativeDataUri } from './creatives.js';
import type { SiteCreatives, SlotPlacement } from './creatives.js';

/**
 * Builds the shareable PDF report.
 *
 * Tone rules applied throughout, per the project brief:
 *  - objective observations and interpretation are kept in separate sections;
 *  - every classification names the dataset it came from;
 *  - "could not be measured" is never rendered as 0;
 *  - no legal conclusions are drawn.
 */

export interface ReportOptions {
  summary: AuditSummary;
  runs: RunResult[];
  includeScreenshots?: boolean;
  maxScreenshotsPerCondition?: number;
  /** Advertising slots shown per website in the creative gallery. */
  maxAdSlotsPerSite?: number;
  /** Distinct images shown per advertising slot. */
  maxRenderingsPerSlot?: number;
}

const REPORT_CSS = `
  @page { size: A4; margin: 18mm 14mm 20mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; color: #1a1a1a; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0 0 4mm; }
  h2 { font-size: 14pt; margin: 10mm 0 3mm; border-bottom: 1px solid #bbb; padding-bottom: 1.5mm; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  h4 { font-size: 10.5pt; margin: 4mm 0 1.5mm; }
  p { margin: 0 0 3mm; }
  table { width: 100%; max-width: 100%; border-collapse: collapse; margin: 3mm 0 5mm; font-size: 8.6pt; table-layout: fixed; }
  th, td { border: 1px solid #ccc; padding: 1.6mm 1.6mm; text-align: left; vertical-align: top; }
  /* Data may break mid-token — domain names have no spaces. Headers may not:
     "Requests" split across two lines reads as a typo, not as a column. */
  td { overflow-wrap: anywhere; hyphens: auto; }
  th { background: #f0f0f0; font-weight: 600; overflow-wrap: break-word; }
  /* Headers wrap; only the values themselves are kept on one line, and even
     those may break rather than push the table off the page. */
  td.num, th.num { text-align: right; }
  td.num { white-space: normal; }
  td.num .range { white-space: nowrap; }
  table.metrics { table-layout: auto; }
  table.dense { font-size: 7.6pt; }
  table.dense th, table.dense td { padding: 1.1mm 1.2mm; }
  th.rot { font-size: 7.4pt; line-height: 1.15; }
  .cover { margin-bottom: 12mm; }
  .cover .subtitle { font-size: 12pt; color: #444; }
  .meta { font-size: 9pt; color: #444; }
  .na { color: #a33; font-style: italic; }
  .range { color: #666; }
  .warn { color: #b26a00; font-weight: bold; }
  .note { background: #f6f6f2; border-left: 3px solid #999; padding: 3mm 4mm; margin: 3mm 0; font-size: 9.5pt; }
  .caution { background: #fdf3e7; border-left: 3px solid #c07000; }
  .screenshot { border: 1px solid #bbb; width: 100%; margin-bottom: 1.5mm; }
  /* A slot is drawn at its share of the recorded viewport width, so the page
     keeps the proportions a visitor saw — but never below 45% of the text
     column, because an unreadable advertisement is not evidence. */
  figure.creative { margin: 0 0 3mm; page-break-inside: avoid; }
  .creative-img { display: block; border: 1px solid #999; width: 100%; }
  figure.creative figcaption { margin-top: 0.8mm; }
  .shot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
  .shot-caption { font-size: 8pt; color: #444; margin-bottom: 4mm; }
  .page-break { page-break-before: always; }
  ul { margin: 0 0 3mm; padding-left: 5mm; }
  li { margin-bottom: 1mm; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 8.5pt; overflow-wrap: anywhere; }
  .badge { font-size: 8pt; padding: 0.5mm 1.5mm; border: 1px solid #999; border-radius: 2px; }
`;

export function buildReportHtml(options: ReportOptions): string {
  const { summary, runs } = options;
  const includeScreenshots = options.includeScreenshots ?? true;
  const audit = summary.audit;
  const dataset = audit.trackerDataset;

  // The ad-slot crops are read from disk once and indexed by site, so that each
  // site section can show what its own slots displayed.
  const creativesBySite = new Map<string, SiteCreatives>();
  if (includeScreenshots) {
    for (const entry of collectCreatives(audit.auditId, runs)) creativesBySite.set(entry.siteId, entry);
  }

  const sections: string[] = [];
  sections.push(coverSection(summary));
  sections.push(methodSection(summary));
  sections.push(summaryTableSection(summary));
  for (const site of summary.sites) {
    sections.push(
      siteSection(site, runs, includeScreenshots, options.maxScreenshotsPerCondition ?? 1, {
        creatives: creativesBySite.get(site.siteId),
        maxSlots: options.maxAdSlotsPerSite ?? 6,
        maxRenderings: options.maxRenderingsPerSlot ?? 4,
      }, dataset.name),
    );
  }
  sections.push(failuresSection(summary));
  sections.push(limitationsSection(dataset.name, dataset.version));
  sections.push(interpretationSection(summary));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Privacy and Advertising Audit of Educational Practice Websites</title>
<style>${REPORT_CSS}</style></head>
<body>
${sections.join('\n')}
</body></html>`;
}

function coverSection(summary: AuditSummary): string {
  const audit = summary.audit;
  const env = audit.environment;
  const browser = audit.browser;
  return `
<div class="cover">
  <h1>Privacy and Advertising Audit of Educational Practice Websites</h1>
  <p class="subtitle">Technical measurement report — objective observations, separated from interpretation</p>
  <table>
    <colgroup><col style="width:30%"><col style="width:70%"></colgroup>
    <tr><th>Audit identifier</th><td><code>${escapeHtml(audit.auditId)}</code></td></tr>
    <tr><th>Audit label</th><td>${escapeHtml(audit.label)}</td></tr>
    <tr><th>Measurement period</th><td>${formatDateTime(audit.startedAt)} — ${formatDateTime(audit.finishedAt)}</td></tr>
    <tr><th>Websites examined</th><td>${summary.sites.map((s) => escapeHtml(s.siteName)).join(', ')}</td></tr>
    <tr><th>Runs recorded</th><td>${summary.totalRuns} (${summary.failedRuns} failed, ${summary.partialRuns} partial)</td></tr>
    <tr><th>Browser</th><td>${browser ? `${escapeHtml(browser.engine)} ${escapeHtml(browser.version)}${browser.isGoogleChromeStable ? ' (Google Chrome Stable)' : ''}` : 'not recorded'}</td></tr>
    <tr><th>Playwright / Node</th><td>${escapeHtml(env.playwright)} / ${escapeHtml(env.node)}</td></tr>
    <tr><th>Environment</th><td>${escapeHtml(env.osRelease)} (${escapeHtml(env.platform)}/${escapeHtml(env.arch)})${env.inDocker ? ', in Docker' : ''}</td></tr>
    <tr><th>Locale / timezone</th><td>${escapeHtml(env.locale)} / ${escapeHtml(env.timezone)}</td></tr>
    <tr><th>Viewport</th><td>${audit.config.viewport.width} × ${audit.config.viewport.height} CSS px</td></tr>
    <tr><th>Software commit</th><td><code>${escapeHtml(env.gitCommit ?? 'not available')}</code>${env.gitDirty ? ' <span class="warn">(working tree modified)</span>' : ''}</td></tr>
    <tr><th>Classification dataset</th><td>${escapeHtml(audit.trackerDataset.name)}${
      audit.trackerDataset.available ? '' : ' <span class="warn">(not installed — tracker counts are reported as not measured)</span>'
    }</td></tr>
    <tr><th>Report generated</th><td>${formatDateTime(summary.generatedAt)}</td></tr>
  </table>
  <div class="note">
    This document reports what a browser did while visiting these websites under controlled conditions.
    It records technical observations only. It does not assess lawfulness, and it does not claim that any
    observation constitutes a violation of any rule. See "Important limitations" before drawing conclusions.
  </div>
</div>`;
}

function methodSection(summary: AuditSummary): string {
  const audit = summary.audit;
  const c = audit.config;
  return `
<h2>Method</h2>
<p>
  Each measurement ("run") is an independent browser session. For every run a new browser process is started
  and a new, empty browser context is created: no cookies, no local or session storage, no cache, no service
  workers and no consent state are carried over from any earlier run. The browser then opens the website and
  behaves according to one of three consent conditions.
</p>
<table>
  <colgroup><col style="width:22%"><col style="width:78%"></colgroup>
  <tr><th>A. No consent choice</th><td>The page is opened and the consent dialog is deliberately not touched. The page is observed for ${Math.round(c.observeHomepageMs / 1000)} seconds.</td></tr>
  <tr><th>B. Reject all</th><td>The site's own "reject all" option is used. On these sites that requires opening the settings layer of the consent dialog first, because the first layer offers only "accept all" and "settings". The session then continues into an actual exercise and stays there for about ${Math.round(c.observeExerciseMs / 1000)} seconds.</td></tr>
  <tr><th>C. Accept all</th><td>The site's "accept all" option is used, followed by the same exercise flow as condition B.</td></tr>
</table>
<p>
  Each site/condition combination is repeated ${audit.repetitions} ${audit.repetitions === 1 ? 'time' : 'times'},
  because advertising and real-time bidding traffic varies between page loads. Results are therefore reported as
  median with the minimum–maximum range across runs, and third-party domains are reported with the number of
  runs in which they appeared.${audit.repetitions === 1 ? ' <strong>With a single run per condition there is no ' +
  'spread to report, so these figures should be read as one observation each, not as a stable measurement.</strong>' : ''}
</p>
<h3>What is recorded</h3>
<ul>
  <li>Every network request (time, URL, host, registrable domain, first/third party, method, resource type, response status), captured through the Chrome DevTools Protocol.</li>
  <li>Cookie activity: <code>Set-Cookie</code> attempts, cookies the browser <em>blocked</em> together with the browser's stated reason, and the cookies actually present in the browser at each checkpoint.</li>
  <li>Other browser storage: localStorage, sessionStorage, IndexedDB databases, cache storage keys and service workers.</li>
  <li>Frames and their origins, so that advertising frames can be correlated with network activity.</li>
  <li>Screenshots at fixed checkpoints, the geometry of visible advertising slots, and a Playwright trace plus a HAR network capture per run.</li>
</ul>
<h3>Consent bookkeeping</h3>
<p>
  A run is only counted as evidence for its condition if the consent action was actually carried out. After the
  action, the resulting consent state is read back through the CMP's own public TCF API (a read-only query, the
  same one that any vendor on the page performs). A run whose consent state could not be confirmed is reported
  as "performed, not confirmed"; a run where the consent control could not be found or clicked is reported as
  failed and is excluded from the measurements of that condition.
</p>
<h3>Classification of third parties</h3>
<p>
  Contacted domains are first reported as a plain observation: this domain was contacted, this many times, in
  this many runs. Separately, each domain is looked up in
  <strong>${escapeHtml(audit.trackerDataset.name)}</strong> (${escapeHtml(audit.trackerDataset.version)}), pinned to a fixed version
  so the classification is reproducible. Wording follows the dataset: "known tracker according to …",
  "advertising-related according to …", or "third-party domain, unclassified". A domain being contacted is not
  in itself evidence of tracking.
</p>
<h3>Data minimisation in this audit</h3>
<p>
  The audit does not log in, does not submit personal data, does not click advertisements and does not interact
  with ad auctions. Cookie values, storage values, authorisation headers and identifier-like URL parameters are
  replaced by their length and a SHA-256 hash before anything is written to disk, so the evidence files can be
  shared without redistributing identifiers.
</p>`;
}

/**
 * The cross-site summary, as two tables rather than one.
 *
 * Twelve numeric columns do not fit an A4 page at a legible size, and a table
 * that runs off the edge of the paper loses the reader the numbers entirely.
 * Splitting it along the obvious seam — what the browser fetched, and what was
 * then stored or shown — keeps every column readable and costs nothing, because
 * the two halves share the same row for each site and condition.
 */
function summaryTableSection(summary: AuditSummary): string {
  const identity = (site: SiteSummary, condition: ConditionSummary) => `
  <td>${escapeHtml(site.siteName)}</td>
  <td>${escapeHtml(CONDITION_LABELS[condition.condition])}</td>
  <td class="num">${condition.usableRunCount}/${condition.runCount}</td>`;

  const trafficRows: string[] = [];
  const storageRows: string[] = [];
  for (const site of summary.sites) {
    for (const condition of site.conditions) {
      trafficRows.push(`
<tr>${identity(site, condition)}
  <td class="num">${statCell(condition.metrics.totalRequests)}</td>
  <td class="num">${statCell(condition.metrics.thirdPartyRequests)}</td>
  <td class="num">${statCell(condition.metrics.uniqueThirdPartyDomains)}</td>
  <td class="num">${statCell(condition.metrics.knownTrackerDomains)}</td>
  <td class="num">${statCell(condition.metrics.advertisingDomains)}</td>
</tr>`);
      storageRows.push(`
<tr>${identity(site, condition)}
  <td class="num">${statCell(condition.metrics.storedCookies)}</td>
  <td class="num">${statCell(condition.metrics.thirdPartyStoredCookies)}</td>
  <td class="num">${statCell(condition.metrics.blockedSetCookieAttempts)}</td>
  <td class="num">${statCell(condition.metrics.visibleAdSlots)}</td>
  <td class="num">${statCell(condition.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
</tr>`);
    }
  }

  const identityHeader = `
      <th style="width:19%">Website</th><th style="width:15%">Condition</th><th class="num" style="width:9%">Usable runs</th>`;

  return `
<h2 class="page-break">Summary across all websites</h2>
<p class="meta">Values are the median across usable runs, with the minimum–maximum range in brackets. "not measured" means the value could not be established in any usable run; it does not mean zero. An asterisk marks metrics that some runs could not measure. The two tables below describe the same runs: the first what the browser fetched, the second what was stored or shown.</p>

<h3>Network activity</h3>
<table class="dense">
  <thead>
    <tr>${identityHeader}
      <th class="num rot">Requests</th>
      <th class="num rot">Third-party requests</th>
      <th class="num rot">Third-party domains</th>
      <th class="num rot">Tracker / advertising domains</th>
      <th class="num rot">Advertising domains</th>
    </tr>
  </thead>
  <tbody>${trafficRows.join('')}</tbody>
</table>

<h3>Storage and advertising surface</h3>
<table class="dense">
  <thead>
    <tr>${identityHeader}
      <th class="num rot">Cookies stored</th>
      <th class="num rot">Third-party cookies</th>
      <th class="num rot">Set-Cookie blocked by browser</th>
      <th class="num rot">Visible ad slots</th>
      <th class="num rot">Ad share of viewport</th>
    </tr>
  </thead>
  <tbody>${storageRows.join('')}</tbody>
</table>`;
}

function siteSection(
  site: SiteSummary,
  runs: RunResult[],
  includeScreenshots: boolean,
  maxScreenshots: number,
  ads: { creatives?: SiteCreatives; maxSlots: number; maxRenderings: number },
  datasetName: string,
): string {
  const siteRuns = runs.filter((run) => run.siteId === site.siteId);
  const reject = site.conditions.find((c) => c.condition === 'reject_all');
  const accept = site.conditions.find((c) => c.condition === 'accept_all');
  const noChoice = site.conditions.find((c) => c.condition === 'no_choice');

  const metricRows = (
    [
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
      'sessionStorageEntries',
      'indexedDbDatabases',
      'serviceWorkers',
      'thirdPartyFrames',
      'visibleAdSlots',
    ] as const
  )
    .map(
      (key) => `<tr>
      <td>${escapeHtml(METRIC_LABELS[key] ?? key)}</td>
      <td class="num">${statCell(noChoice?.metrics[key])}</td>
      <td class="num">${statCell(reject?.metrics[key])}</td>
      <td class="num">${statCell(accept?.metrics[key])}</td>
    </tr>`,
    )
    .join('');

  const adRow = `<tr>
    <td>${escapeHtml(METRIC_LABELS.maxVisibleAdAreaFraction)}</td>
    <td class="num">${statCell(noChoice?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
    <td class="num">${statCell(reject?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
    <td class="num">${statCell(accept?.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
  </tr>`;

  return `
<h2 class="page-break">${escapeHtml(site.siteName)}</h2>
<p class="meta">${escapeHtml(site.startUrl)} — ${site.totalRuns} runs, most recent ${formatDateTime(site.latestRunAt)}</p>

${exerciseRouteNote(siteRuns)}

<h3>Objective measurements per consent condition</h3>
<table>
  <colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup>
  <thead><tr><th>Metric</th><th class="num">A. No choice</th><th class="num">B. Reject all</th><th class="num">C. Accept all</th></tr></thead>
  <tbody>${metricRows}${adRow}</tbody>
</table>

<p class="meta">In condition A no consent action is performed, so for that column "before the consent action" covers the entire run.</p>

<h3>Consent handling</h3>
${consentTable(site)}

<h3>Third-party domains contacted</h3>
${domainTable(reject, 'B. Reject all', datasetName)}
${domainTable(accept, 'C. Accept all', datasetName)}

<h3>Cookies and other storage</h3>
${cookieNarrative(site)}

<h3>Notable observations</h3>
${notableObservations(site, siteRuns)}

${includeScreenshots && ads.creatives ? adSlotGallery(ads.creatives, ads.maxSlots, ads.maxRenderings) : ''}

${includeScreenshots ? screenshotSection(site, siteRuns, maxScreenshots) : ''}
`;
}

/**
 * States plainly how far into the learning activity the automation got, and
 * anything it could not establish. Taken from the runs themselves so it can
 * never drift away from what actually happened.
 */
function exerciseRouteNote(runs: RunResult[]): string {
  const withExercise = runs.filter((run) => run.exercise.attempted);
  if (!withExercise.length) return '';
  const notes = [...new Set(withExercise.flatMap((run) => run.exercise.notes))];
  const reached = withExercise.filter((run) => run.exercise.reached === true).length;
  const urls = [...new Set(withExercise.map((run) => run.exercise.url).filter(Boolean))] as string[];
  return `<div class="note">
    <strong>Route into the learning activity.</strong>
    The exercise page was reached in ${reached} of ${withExercise.length} runs that attempted it${
      urls.length ? `, at ${urls.map((url) => `<code>${escapeHtml(url.slice(0, 110))}</code>`).join(', ')}` : ''
    }.
    ${notes.length ? `<br>${notes.map((note) => escapeHtml(note)).join('<br>')}` : ''}
  </div>`;
}

function consentTable(site: SiteSummary): string {
  const rows = site.conditions
    .map((condition) => {
      const consentCounts = Object.entries(condition.consentStatusCounts)
        .map(([status, count]) => `${escapeHtml(status.replace(/_/g, ' '))}: ${count}`)
        .join(', ');
      const statusCounts = Object.entries(condition.statusCounts)
        .map(([status, count]) => `${escapeHtml(status)}: ${count}`)
        .join(', ');
      return `<tr>
        <td>${escapeHtml(CONDITION_LABELS[condition.condition])}</td>
        <td>${consentCounts || '–'}</td>
        <td>${statusCounts || '–'}</td>
        <td class="num">${condition.exerciseReachedCount}/${condition.runCount}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <colgroup><col style="width:22%"><col style="width:38%"><col style="width:25%"><col style="width:15%"></colgroup>
    <thead><tr><th>Condition</th><th>Consent bookkeeping</th><th>Run status</th><th class="num">Exercise reached</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="meta">"confirmed" means the consent state was read back from the site's own consent management platform and matched the requested choice. Runs that are not confirmed are excluded from the measurements above where the condition could not be established.</p>`;
}

/**
 * The dataset name and pinned version are stated once under each table rather
 * than repeated in all 25 rows: spelled out per row they are longer than the
 * domain names and crowd the numbers off the page, while saying nothing new.
 */
function shortClassification(classification: DomainClassification): string {
  switch (classification.label) {
    case 'known_tracker':
      return 'Known tracker';
    case 'advertising_related':
      return 'Advertising-related';
    case 'unclassified':
      return 'Unclassified';
    case 'unknown_dataset_unavailable':
      return 'No dataset installed';
    default:
      return 'Third-party domain';
  }
}

function domainTable(condition: ConditionSummary | undefined, title: string, datasetName: string): string {
  if (!condition || !condition.domains.length) {
    return `<h4>${escapeHtml(title)}</h4><p class="meta">No usable runs, so no domain list can be reported for this condition.</p>`;
  }
  const rows = condition.domains
    .slice(0, 25)
    .map(
      (domain) => `<tr>
      <td><code>${escapeHtml(domain.registrableDomain)}</code></td>
      <td>${escapeHtml(domain.classification.owner ?? '–')}</td>
      <td>${escapeHtml(shortClassification(domain.classification))}</td>
      <td class="num">${domain.runsPresent}/${domain.totalRuns}</td>
      <td class="num">${domain.totalRequests}</td>
      <td class="num">${domain.cookieSetAttempts}</td>
      <td class="num">${domain.blockedCookieAttempts}</td>
    </tr>`,
    )
    .join('');
  // Column widths are fixed: domain names and operator names are long and would
  // otherwise push the numeric columns off the right-hand edge of the page.
  return `<h4>${escapeHtml(title)}</h4>
  <table class="dense">
    <colgroup>
      <col style="width:25%"><col style="width:21%"><col style="width:16%">
      <col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:8%">
    </colgroup>
    <thead><tr>
      <th>Domain</th><th>Operator (per dataset)</th><th>Classification</th>
      <th class="num">Present in</th><th class="num">Requests</th>
      <th class="num">Set-Cookie attempts</th><th class="num">Blocked</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="meta">
    "Known tracker" and "Advertising-related" are the classifications of
    <strong>${escapeHtml(datasetName)}</strong>, pinned to the version named on the cover page.
    "Unclassified" means the dataset lists no classification for the domain, not that it does nothing.
    ${condition.domains.length > 25 ? `${condition.domains.length - 25} further domains are listed in the raw export.` : ''}
  </p>`;
}

/**
 * A short, mechanically derived list of things a reader is likely to want
 * pointed out. Every item is a description of a measurement, with the numbers
 * attached; none of them is a judgement.
 */
function notableObservations(site: SiteSummary, runs: RunResult[]): string {
  const items: string[] = [];
  const usable = (condition: string) =>
    runs.filter((run) => run.condition === condition && run.status !== 'failed');

  const noChoice = site.conditions.find((condition) => condition.condition === 'no_choice');
  if (noChoice && noChoice.metrics.uniqueThirdPartyDomains.measuredRuns > 0) {
    const domains = noChoice.metrics.uniqueThirdPartyDomains;
    const trackers = noChoice.metrics.knownTrackerDomains;
    items.push(
      `Without any consent choice, ${domains.median} third-party domains were contacted (median across ` +
        `${domains.measuredRuns} runs, range ${domains.min}–${domains.max})` +
        (trackers.measuredRuns > 0 ? `, of which ${trackers.median} are classified as tracking or advertising.` : '.'),
    );
    const cookies = noChoice.metrics.storedCookies;
    if (cookies.measuredRuns > 0 && (cookies.median ?? 0) > 0) {
      items.push(`Without any consent choice, ${cookies.median} cookies were present in the browser at the end of the run (median).`);
    }
  }

  const reject = site.conditions.find((condition) => condition.condition === 'reject_all');
  const accept = site.conditions.find((condition) => condition.condition === 'accept_all');
  if (reject && reject.metrics.knownTrackerDomains.measuredRuns > 0) {
    const trackers = reject.metrics.knownTrackerDomains;
    items.push(
      `After choosing "reject all", ${trackers.median} domains classified as tracking or advertising were still ` +
        `contacted (median, range ${trackers.min}–${trackers.max}).`,
    );
  }
  if (reject && accept) {
    const rejectDomains = new Set(reject.domains.map((domain) => domain.registrableDomain));
    const acceptOnly = accept.domains.filter((domain) => !rejectDomains.has(domain.registrableDomain));
    const rejectOnly = reject.domains.filter(
      (domain) => !accept.domains.some((other) => other.registrableDomain === domain.registrableDomain),
    );
    if (acceptOnly.length) {
      items.push(
        `${acceptOnly.length} third-party domains appeared only after acceptance, for example ` +
          acceptOnly.slice(0, 5).map((domain) => `<code>${escapeHtml(domain.registrableDomain)}</code>`).join(', ') + '.',
      );
    }
    if (rejectOnly.length) {
      items.push(
        `${rejectOnly.length} third-party domains appeared in the reject condition but not in the accept condition, ` +
          'which is a reminder that programmatic advertising varies between page loads.',
      );
    }
  }

  const persistent = longestCookies(runs);
  if (persistent.length) {
    const longest = persistent[0];
    items.push(
      `The longest-lived cookie observed was <code>${escapeHtml(longest.name)}</code> for ` +
        `<code>${escapeHtml(longest.domain)}</code>, with about ${Math.round(longest.lifetimeDays)} days to run ` +
        `(${persistent.length} cookies observed with a lifetime over one year).`,
    );
  }

  const blocked = reject?.metrics.blockedSetCookieAttempts;
  if (blocked && blocked.measuredRuns > 0 && (blocked.median ?? 0) > 0) {
    items.push(
      `After rejection, the browser itself refused ${blocked.median} attempts to set a cookie (median). These are ` +
        'attempts that were made and blocked by the browser, not cookies that were stored.',
    );
  }

  const beforeConsent = usable('reject_all')
    .flatMap((run) => run.requests.filter((request) => request.beforeConsentAction && request.isThirdParty === true))
    .map((request) => request.registrableDomain)
    .filter((domain): domain is string => Boolean(domain));
  if (beforeConsent.length) {
    const distinct = [...new Set(beforeConsent)];
    items.push(
      `In the reject runs, ${distinct.length} distinct third-party domains had already been contacted before the ` +
        'rejection was recorded, in the seconds between the page opening and the consent dialog being answered.',
    );
  }

  if (!items.length) return '<p class="meta">No usable runs, so nothing can be reported for this website.</p>';
  return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function longestCookies(runs: RunResult[]): Array<{ name: string; domain: string; lifetimeDays: number }> {
  const found: Array<{ name: string; domain: string; lifetimeDays: number }> = [];
  for (const run of runs) {
    const final = run.cookieCheckpoints[run.cookieCheckpoints.length - 1];
    for (const cookie of final?.cookies ?? []) {
      if (cookie.lifetimeDays != null && cookie.lifetimeDays > 365) {
        found.push({ name: cookie.name, domain: cookie.domain, lifetimeDays: cookie.lifetimeDays });
      }
    }
  }
  return found.sort((a, b) => b.lifetimeDays - a.lifetimeDays);
}

function cookieNarrative(site: SiteSummary): string {
  const parts = site.conditions.map((condition) => {
    const stored = condition.metrics.storedCookies;
    const third = condition.metrics.thirdPartyStoredCookies;
    const blocked = condition.metrics.blockedSetCookieAttempts;
    const local = condition.metrics.localStorageEntries;
    return `<li><strong>${escapeHtml(CONDITION_LABELS[condition.condition])}</strong>:
      cookies stored ${statValuesList(stored)}; third-party cookies ${statValuesList(third)};
      Set-Cookie attempts blocked by the browser ${statValuesList(blocked)}; localStorage entries ${statValuesList(local)}.</li>`;
  });
  return `<ul>${parts.join('')}</ul>
  <p class="meta">Cookie values themselves are not reproduced anywhere in this report or in the exported evidence; only lengths and hashes are stored.</p>`;
}

/**
 * Shows the advertising each slot actually displayed, cropped to the slot.
 *
 * A whole-viewport screenshot answers "what did the page look like"; it is a
 * poor way to answer "what was advertised to the child using it", because the
 * banner is a strip a few millimetres tall on the printed page. These crops were
 * recorded by the audit at every checkpoint and are simply being shown.
 *
 * Each slot is presented with every distinct image it produced, so the report
 * never has to assert that a given picture is an advertisement: where a slot was
 * not filled it rendered the page behind it, and that is visible as such.
 */
function adSlotGallery(creatives: SiteCreatives, maxSlots: number, maxRenderings: number): string {
  const blocks = creatives.placements.slice(0, maxSlots).map((placement) => slotBlock(placement, maxRenderings));
  if (!blocks.length) {
    if (!creatives.missingImages) return '';
    return `<h3>What the advertising slots displayed</h3>
    <p class="meta">
      ${creatives.missingImages} advertising-slot ${creatives.missingImages === 1 ? 'image was' : 'images were'}
      recorded during the runs but could not be located in the evidence directory, so no images can be shown here.
      This is a gap in the evidence, not an observation that no advertising was displayed.
    </p>`;
  }

  const hiddenSlots = Math.max(0, creatives.placements.length - maxSlots);
  return `
<h3>What the advertising slots displayed</h3>
<div class="note caution">
  These images are crops of the advertising slots themselves, taken from the recorded runs, at the checkpoints
  named under each image. Advertising is selected per impression and varies by time, location, device and
  network: these are the advertisements served to this browser on this occasion, not what every visitor sees,
  and naming them is not a claim about any advertiser. Where a slot was not filled at that moment it rendered
  the page behind it, so some images show the website rather than an advertisement — that is what was on screen.
</div>
${blocks.join('')}
${hiddenSlots ? `<p class="meta">${hiddenSlots} further advertising ${hiddenSlots === 1 ? 'slot is' : 'slots are'} recorded in the raw evidence bundle but not shown here.</p>` : ''}
${creatives.skippedTooSmall ? `<p class="meta">${creatives.skippedTooSmall} photographed ${creatives.skippedTooSmall === 1 ? 'element was' : 'elements were'} too small to be an advertisement (close buttons and labels) and are not shown.</p>` : ''}
${creatives.missingImages ? `<p class="meta">${creatives.missingImages} recorded slot ${creatives.missingImages === 1 ? 'image' : 'images'} could not be located in the evidence directory and ${creatives.missingImages === 1 ? 'is' : 'are'} therefore not shown.</p>` : ''}`;
}

/**
 * The width to print a slot at, as a percentage of the text column: its real
 * share of the browser viewport, floored so that narrow creatives stay legible.
 */
function scaledWidthPercent(placement: SlotPlacement): number {
  const share = placement.viewportWidth > 0 ? (placement.width / placement.viewportWidth) * 100 : 100;
  return Math.round(Math.min(100, Math.max(45, share)));
}

function slotBlock(placement: SlotPlacement, maxRenderings: number): string {
  const shown = placement.renderings.slice(0, maxRenderings);
  const figures = shown
    .map((rendering) => {
      const dataUri = creativeDataUri(rendering.file);
      if (!dataUri) return '';
      const checkpoints = [...new Set(rendering.sightings.map((sighting) => sighting.checkpoint))];
      const runs = new Set(rendering.sightings.map((sighting) => sighting.runId));
      const conditions = rendering.conditions.map((condition) => CONDITION_LABELS[condition]).join(', ');
      return `<figure class="creative" style="width:${scaledWidthPercent(placement)}%">
        <img class="creative-img" src="${dataUri}" alt="Advertising slot ${placement.width}×${placement.height} on ${escapeHtml(placement.siteName)}">
        <figcaption class="shot-caption">
          ${escapeHtml(conditions)} · ${escapeHtml(checkpoints.map(checkpointLabel).join('; '))} ·
          seen in ${runs.size} ${runs.size === 1 ? 'run' : 'runs'} (${rendering.sightings.length} ${rendering.sightings.length === 1 ? 'observation' : 'observations'}) ·
          image <code>${escapeHtml(rendering.sha256.slice(0, 12))}</code>
        </figcaption>
      </figure>`;
    })
    .filter(Boolean);
  if (!figures.length) return '';

  const hidden = placement.renderings.length - shown.length;
  const distinct = placement.renderings.length;
  return `
<h4>Slot of ${placement.width} × ${placement.height} px at (${placement.x}, ${placement.y})</h4>
<p class="meta">
  ${distinct === 1 ? 'One image' : `${distinct} different images`} across ${placement.observationCount}
  ${placement.observationCount === 1 ? 'observation' : 'observations'} in ${placement.runIds.length}
  ${placement.runIds.length === 1 ? 'run' : 'runs'} ·
  ${placement.conditions.map((condition) => escapeHtml(CONDITION_LABELS[condition])).join(', ')} ·
  detected as <code>${escapeHtml(placement.selector)}</code>${
    placement.framesAdItself
      ? ' (the advertisement’s own frame)'
      : ' (the site’s advertising container, so the crop may include page around the advertisement)'
  }${placement.iframeDomain ? ` · frame served from <code>${escapeHtml(placement.iframeDomain)}</code>` : ''}
</p>
${figures.join('')}
${hidden > 0 ? `<p class="meta">${hidden} further distinct ${hidden === 1 ? 'image' : 'images'} from this slot are in the raw evidence bundle.</p>` : ''}`;
}

function screenshotSection(site: SiteSummary, runs: RunResult[], maxPerCondition: number): string {
  const blocks: string[] = [];
  for (const condition of site.conditions) {
    const conditionRuns = runs.filter((run) => run.condition === condition.condition && run.status !== 'failed');
    const shots: string[] = [];
    for (const run of conditionRuns.slice(0, 1)) {
      const chosen = pickScreenshots(run, maxPerCondition);
      for (const shot of chosen) {
        const dataUri = readScreenshotDataUri(run, shot.file);
        if (!dataUri) continue;
        shots.push(`<figure style="margin:0">
          <img class="screenshot" src="${dataUri}" alt="${escapeHtml(shot.label)}">
          <figcaption class="shot-caption">
            ${escapeHtml(shot.label)} — ${Math.round(shot.tRelMs / 1000)}s into the run ·
            ${escapeHtml(CONDITION_LABELS[condition.condition])} ·
            run <code>${escapeHtml(run.runId.slice(0, 8))}</code> ·
            ${shot.viewport.width}×${shot.viewport.height} · ${formatDateTime(run.startedAt)}
          </figcaption>
        </figure>`);
      }
    }
    if (shots.length) {
      blocks.push(`<h4>${escapeHtml(CONDITION_LABELS[condition.condition])}</h4><div class="shot-grid">${shots.join('')}</div>`);
    }
  }
  if (!blocks.length) return '';
  return `<h3>What was on screen</h3>
  <div class="note caution">
    Each screenshot shows advertising that was served during that one specific recorded run. Advertising is
    selected per impression and varies by time, location and network conditions; these images do not show what
    every user sees, and they are not a claim about any particular advertiser.
  </div>
  ${blocks.join('')}`;
}

function pickScreenshots(run: RunResult, max: number) {
  const preferredOrder = ['05-exercise-10s', '04-exercise-loaded', '06-exercise-30s', '03-after-consent-decision', '03-after-10s-no-choice', '01-first-load'];
  const picked: RunResult['screenshots'] = [];
  for (const label of preferredOrder) {
    const shot = run.screenshots.find((s) => s.label === label && !s.fullPage);
    if (shot && !picked.includes(shot)) picked.push(shot);
    if (picked.length >= max) break;
  }
  return picked;
}

function readScreenshotDataUri(run: RunResult, relativeFile: string): string | null {
  try {
    const file = path.join(runDir(run.auditId, run.runId), relativeFile);
    if (!fs.existsSync(file)) return null;
    const buffer = fs.readFileSync(file);
    if (buffer.length > 4_000_000) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function failuresSection(summary: AuditSummary): string {
  const rows: string[] = [];
  for (const site of summary.sites) {
    for (const condition of site.conditions) {
      const failed = condition.runCount - condition.usableRunCount;
      if (failed > 0 || condition.failures.length) {
        rows.push(`<tr>
          <td>${escapeHtml(site.siteName)}</td>
          <td>${escapeHtml(CONDITION_LABELS[condition.condition])}</td>
          <td class="num">${failed}/${condition.runCount}</td>
          <td>${escapeHtml(summariseFailures(condition))}</td>
        </tr>`);
      }
    }
  }
  if (!rows.length) {
    return `<h2>Measurement problems</h2><p>No runs failed and no measurement problems were recorded for this audit.</p>`;
  }
  return `
<h2 class="page-break">Measurement problems</h2>
<p>
  The following runs could not be used, or could only partly be used. They are listed here because a failed
  measurement must not be read as an absence of activity.
</p>
<table>
  <colgroup><col style="width:26%"><col style="width:22%"><col style="width:14%"><col style="width:38%"></colgroup>
  <thead><tr><th>Website</th><th>Condition</th><th class="num">Unusable runs</th><th>Recorded problems</th></tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>`;
}

function summariseFailures(condition: ConditionSummary): string {
  const counts = new Map<string, number>();
  for (const failure of condition.failures) {
    counts.set(failure.stage, (counts.get(failure.stage) ?? 0) + 1);
  }
  if (!counts.size) return 'consent state could not be established';
  return [...counts.entries()].map(([stage, count]) => `${stage} (${count}×)`).join('; ');
}

function limitationsSection(datasetName: string, datasetVersion: string): string {
  return `
<h2 class="page-break">Important limitations</h2>
<ul>
  <li>A network request to a third party is an observation, not automatically unlawful tracking. Many third-party
      requests serve functional purposes such as fonts, video players or content delivery.</li>
  <li>Membership of a tracker list is a classification made by a third party
      (${escapeHtml(datasetName)}, ${escapeHtml(datasetVersion)}). It reflects that dataset's methodology and cut-off date,
      not a legal determination.</li>
  <li>The number of cookies, on its own, says nothing about lawfulness. What matters legally is the purpose of
      each cookie, its legal basis, and whether consent was validly obtained — none of which can be read from
      a network capture.</li>
  <li>Screenshots show advertisements that were served during specific recorded runs. Programmatic advertising is
      selected per impression; a different visitor, at a different moment, will generally see different
      advertisements.</li>
  <li>Advertising and tracker behaviour varies by geography, network, device, browser, time of day and the
      presence of ad blockers. These measurements were taken from one environment, described on the cover page.</li>
  <li>Automation may itself influence what is served: some ad systems treat automated browsers differently.</li>
  <li>The audit deliberately does not log in, does not solve exercises, does not click advertisements and does not
      interact with ad auctions. Behaviour during a longer, genuinely human session may differ.</li>
  <li>Assessing compliance requires information this measurement cannot provide: the purposes of processing, the
      legal basis relied on, the details of the consent implementation, data processing agreements, retention, and
      international transfers.</li>
</ul>`;
}

function interpretationSection(summary: AuditSummary): string {
  const observations: string[] = [];
  for (const site of summary.sites) {
    const reject = site.conditions.find((c) => c.condition === 'reject_all');
    const accept = site.conditions.find((c) => c.condition === 'accept_all');
    const noChoice = site.conditions.find((c) => c.condition === 'no_choice');
    const parts: string[] = [];

    if (noChoice && noChoice.usableRunCount > 0) {
      const domains = noChoice.metrics.uniqueThirdPartyDomains;
      if (domains.measuredRuns > 0) {
        parts.push(
          `Without any consent choice, the browser contacted a median of ${domains.median} distinct third-party domains ` +
            `(range ${domains.min}–${domains.max} across ${domains.measuredRuns} runs).`,
        );
      }
    }
    if (reject && reject.usableRunCount > 0) {
      const domains = reject.metrics.uniqueThirdPartyDomains;
      const trackers = reject.metrics.knownTrackerDomains;
      if (domains.measuredRuns > 0) {
        parts.push(
          `After explicitly choosing "reject all", the browser still contacted a median of ${domains.median} third-party domains ` +
            `(range ${domains.min}–${domains.max})` +
            (trackers.measuredRuns > 0
              ? `, of which a median of ${trackers.median} are classified as tracking or advertising by ${escapeHtml(summary.audit.trackerDataset.name)}.`
              : '.'),
        );
      }
      const cookies = reject.metrics.storedCookies;
      if (cookies.measuredRuns > 0) {
        parts.push(`After rejection, a median of ${cookies.median} cookies were present in the browser at the end of the run.`);
      }
    }
    if (reject && accept && reject.usableRunCount > 0 && accept.usableRunCount > 0) {
      const r = reject.metrics.uniqueThirdPartyDomains.median;
      const a = accept.metrics.uniqueThirdPartyDomains.median;
      if (r != null && a != null) {
        parts.push(
          `Comparing the two conditions, the median number of distinct third-party domains was ${r} after rejection and ${a} after acceptance.`,
        );
      }
    }
    if (!parts.length) {
      parts.push('No usable runs were available for this website, so no observations can be reported.');
    }
    observations.push(`<h3>${escapeHtml(site.siteName)}</h3><ul>${parts.map((p) => `<li>${p}</li>`).join('')}</ul>`);
  }

  return `
<h2 class="page-break">Observations</h2>
<p>
  This section restates the measurements in plain language. It deliberately stops at description. Whether any of
  this is lawful, proportionate or appropriate for a website used by primary-school children is a judgement for
  the reader — a school board, a parent, a data protection officer — and would require the additional information
  listed under "Important limitations".
</p>
${observations.join('')}
<div class="note">
  Suggested next step for a school or a DPO: ask the website operator which third parties receive personal data,
  for which purposes and on which legal basis, and how the "reject all" choice is implemented technically. The
  raw evidence bundle accompanying this report (HAR files, traces, screenshots and structured JSON) allows a
  technically competent third party to verify every number above independently.
</div>`;
}
