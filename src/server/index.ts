import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs, PROJECT_ROOT } from '../config.js';
import { SITE_DEFINITIONS, getSiteDefinition } from '../sites/definitions.js';
import { loadTrackerClassifier } from '../trackers/dataset.js';
import { summarizeAudit } from '../report/aggregate.js';
import { generatePdfReport, generateReportHtml } from '../report/pdf.js';
import { streamAuditZip } from '../export/zip.js';
import {
  getAudit,
  getRun,
  listAudits,
  listRuns,
  latestAuditWithRuns,
  runArtifactPath,
  runDir,
} from '../store/store.js';
import type { ConsentCondition } from '../types.js';
import { CONSENT_CONDITIONS } from '../types.js';
import { listJobs, startJob, cancelJob, signalFinish, getJob } from './jobs.js';
import {
  inProgressRunPage,
  overviewPage,
  simplePage,
  auditPage,
  sitePage,
  runPage,
  galleryPage,
  annotatePage,
  methodologyPage,
  errorPage,
} from './views.js';
import { escapeHtml } from '../report/format.js';

/**
 * Local research dashboard. No authentication, no accounts, no cloud: this is a
 * tool that runs on one machine and reads files from disk.
 */
export function createApp(): express.Express {
  ensureDirs();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (_req, res) => {
    const audits = listAudits();
    const latestAudit = latestAuditWithRuns();
    const classifier = loadTrackerClassifier(true);
    let latestSummary = null;
    let siteRows = SITE_DEFINITIONS.map((site) => ({
      siteId: site.id,
      siteName: site.name,
      startUrl: site.startUrl,
      latestRunAt: null as string | null,
      runCount: 0,
      status: 'never audited',
    }));
    if (latestAudit) {
      const runs = listRuns(latestAudit.auditId);
      latestSummary = summarizeAudit(latestAudit, runs, classifier);
      siteRows = SITE_DEFINITIONS.map((site) => {
        const siteRuns = runs.filter((run) => run.siteId === site.id);
        const failed = siteRuns.filter((run) => run.status === 'failed').length;
        return {
          siteId: site.id,
          siteName: site.name,
          startUrl: site.startUrl,
          latestRunAt: siteRuns.length ? siteRuns.map((run) => run.finishedAt).sort().slice(-1)[0] : null,
          runCount: siteRuns.length,
          status: siteRuns.length === 0 ? 'not in latest audit' : failed ? `${failed} of ${siteRuns.length} runs failed` : 'ok',
        };
      });
    }
    res.send(
      overviewPage({
        audits,
        latest: latestSummary,
        siteRows,
        datasetInfo: classifier.datasetInfo(),
        jobs: listJobs().map((job) => ({
          id: job.id,
          label: job.label,
          status: job.status,
          progress: job.progress + (job.auditId ? ` — audit ${job.auditId.slice(0, 8)}` : ''),
          startedAt: job.startedAt,
        })),
        siteOptions: SITE_DEFINITIONS.map((site) => ({ id: site.id, name: site.name })),
      }),
    );
  });

  app.get('/audits', (_req, res) => {
    const rows = listAudits()
      .map(
        (audit) => `<tr>
          <td><a href="/audits/${escapeHtml(audit.auditId)}">${escapeHtml(audit.label)}</a></td>
          <td>${escapeHtml(audit.startedAt)}</td>
          <td>${escapeHtml(audit.status)}</td>
          <td class="num">${audit.runIds.length}</td>
          <td><a href="/audits/${escapeHtml(audit.auditId)}/report.pdf">PDF</a> ·
              <a href="/audits/${escapeHtml(audit.auditId)}/export.zip">ZIP</a></td>
        </tr>`,
      )
      .join('');
    res.send(
      simplePage(
        'All audits',
        `<h2>All audits</h2><div class="card"><table>
          <thead><tr><th>Label</th><th>Started</th><th>Status</th><th class="num">Runs</th><th>Downloads</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="muted">No audits recorded yet.</td></tr>'}</tbody>
        </table></div>`,
      ),
    );
  });

  app.get('/audits/:auditId', (req, res) => {
    const audit = getAudit(req.params.auditId);
    if (!audit) return res.status(404).send(errorPage('This audit does not exist.'));
    const runs = listRuns(audit.auditId);
    const summary = summarizeAudit(audit, runs, loadTrackerClassifier());
    res.send(auditPage(summary));
  });

  app.get('/audits/:auditId/sites/:siteId', (req, res) => {
    const audit = getAudit(req.params.auditId);
    if (!audit) return res.status(404).send(errorPage('This audit does not exist.'));
    const runs = listRuns(audit.auditId);
    const summary = summarizeAudit(audit, runs, loadTrackerClassifier());
    const site = summary.sites.find((entry) => entry.siteId === req.params.siteId);
    if (!site) return res.status(404).send(errorPage('This website is not part of this audit.'));
    res.send(sitePage(summary, site, runs.filter((run) => run.siteId === site.siteId)));
  });

  app.get('/audits/:auditId/gallery', (req, res) => {
    const audit = getAudit(req.params.auditId);
    if (!audit) return res.status(404).send(errorPage('This audit does not exist.'));
    const runs = listRuns(audit.auditId);
    const summary = summarizeAudit(audit, runs, loadTrackerClassifier());
    res.send(galleryPage(summary, runs));
  });

  app.get('/runs/:auditId/:runId', (req, res) => {
    const run = getRun(req.params.auditId, req.params.runId);
    if (!run) {
      // An interactive run has a directory but no run.json until it finishes.
      const job = listJobs().find(
        (entry) => entry.status === 'running' && entry.currentRunId === req.params.runId,
      );
      if (job) {
        return res.send(inProgressRunPage(req.params.auditId, req.params.runId, job.interactive));
      }
      return res.status(404).send(errorPage('This run does not exist.'));
    }
    res.send(runPage(run, { interactiveRunning: false }));
  });

  app.get('/api/runs/:auditId/:runId/run.json', (req, res) => {
    const run = getRun(req.params.auditId, req.params.runId);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  });

  app.get('/artifacts/:auditId/:runId/*splat', (req, res) => {
    // Express 5 hands a wildcard match over as an array of path segments.
    const raw = (req.params as Record<string, unknown>).splat;
    const relative = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
    const resolved = runArtifactPath(req.params.auditId, req.params.runId, relative);
    if (!resolved) return res.status(404).send('not found');
    res.sendFile(resolved);
  });

  app.get('/audits/:auditId/report.html', async (req, res) => {
    try {
      res.send(await generateReportHtml(req.params.auditId));
    } catch (err) {
      res.status(500).send(errorPage(String(err)));
    }
  });

  app.get('/audits/:auditId/report.pdf', async (req, res) => {
    try {
      const file = await generatePdfReport(req.params.auditId);
      res.download(file, `privacy-audit-${req.params.auditId.slice(0, 8)}.pdf`);
    } catch (err) {
      res.status(500).send(errorPage(String(err)));
    }
  });

  app.get('/audits/:auditId/export.zip', async (req, res) => {
    const audit = getAudit(req.params.auditId);
    if (!audit) return res.status(404).send(errorPage('This audit does not exist.'));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${req.params.auditId.slice(0, 8)}.zip"`);
    try {
      await streamAuditZip(req.params.auditId, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).send(errorPage(String(err)));
      else res.end();
    }
  });

  app.get('/annotate/:auditId/:runId', (req, res) => {
    const file = String(req.query.file ?? '');
    const existing = readAnnotations(req.params.auditId, req.params.runId, file);
    res.send(annotatePage(req.params.auditId, req.params.runId, file, existing));
  });

  app.post('/api/annotations/:auditId/:runId', (req, res) => {
    const { file, regions } = req.body ?? {};
    if (typeof file !== 'string' || !Array.isArray(regions)) return res.status(400).json({ error: 'bad request' });
    const dir = runDir(req.params.auditId, req.params.runId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'unknown run' });
    const target = path.join(dir, 'annotations.json');
    const all = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
    all[file] = { regions, savedAt: new Date().toISOString(), note: 'Manual human annotation, not an automatic measurement.' };
    fs.writeFileSync(target, JSON.stringify(all, null, 2));
    res.json({ ok: true });
  });

  app.post('/api/audits', (req, res) => {
    const siteId = String(req.body.site ?? 'all');
    const conditionRaw = String(req.body.condition ?? 'all');
    const repetitions = Math.max(1, Math.min(20, Number(req.body.repetitions ?? config.repetitions)));
    const interactive = String(req.body.interactive ?? '') === '1';
    const recordVideo = String(req.body.video ?? '') === '1';

    const sites = siteId === 'all' ? SITE_DEFINITIONS : [getSiteDefinition(siteId)].filter(Boolean);
    if (!sites.length || !sites[0]) return res.status(400).send(errorPage(`Unknown website: ${siteId}`));

    const conditions: ConsentCondition[] | undefined =
      conditionRaw === 'all' ? undefined : CONSENT_CONDITIONS.includes(conditionRaw as ConsentCondition) ? [conditionRaw as ConsentCondition] : undefined;

    const job = startJob({
      sites: sites as NonNullable<(typeof sites)[number]>[],
      conditions,
      repetitions: interactive ? 1 : repetitions,
      interactive,
      recordVideo,
      label: `${siteId} / ${conditionRaw}${interactive ? ' (interactive)' : ''} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    });
    res.redirect(`/jobs/${job.id}`);
  });

  app.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).send(errorPage('Unknown job.'));
    res.send(
      simplePage('Audit job', `
      <h2>Audit job</h2>
      <div class="card">
        <p><strong>${escapeHtml(job.label)}</strong></p>
        <p>Status: ${escapeHtml(job.status)} — ${escapeHtml(job.progress)}</p>
        ${job.auditId ? `<p><a href="/audits/${escapeHtml(job.auditId)}">Open audit results</a></p>` : ''}
        ${job.interactive && job.currentRunId && job.auditId
          ? `<div class="info">The visible browser is being recorded. Inside Docker you can watch it at
               <a href="http://localhost:6080/vnc.html" target="_blank" rel="noreferrer">http://localhost:6080/vnc.html</a>.</div>
             <form method="post" action="/api/runs/${escapeHtml(job.auditId)}/${escapeHtml(job.currentRunId)}/finish"><button>Finish interactive run</button></form>`
          : ''}
        <p class="muted">This page does not refresh by itself. Reload to see progress.</p>
        <pre>${escapeHtml(job.log.slice(-60).join('\n'))}</pre>
      </div>`, { auditId: job.auditId ?? undefined }),
    );
  });

  app.get('/api/jobs', (_req, res) => {
    res.json(listJobs());
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    cancelJob(req.params.id);
    res.redirect('/');
  });

  app.post('/api/runs/:auditId/:runId/finish', (req, res) => {
    const ok = signalFinish(req.params.auditId, req.params.runId);
    if (!ok) return res.status(404).send(errorPage('Unknown run.'));
    res.redirect(`/runs/${req.params.auditId}/${req.params.runId}`);
  });

  app.get('/methodology', (_req, res) => {
    const file = path.join(PROJECT_ROOT, 'docs', 'METHODOLOGY.md');
    const markdown = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'docs/METHODOLOGY.md is missing.';
    res.send(methodologyPage(markdown));
  });

  app.use((_req, res) => {
    res.status(404).send(errorPage('Unknown page.'));
  });

  return app;
}

function readAnnotations(auditId: string, runId: string, file: string): unknown {
  try {
    const target = path.join(runDir(auditId, runId), 'annotations.json');
    if (!fs.existsSync(target)) return [];
    const all = JSON.parse(fs.readFileSync(target, 'utf8'));
    return all[file]?.regions ?? [];
  } catch {
    return [];
  }
}

const invokedDirectly = process.argv[1] && /server[\/\\]index\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Audit dashboard listening on http://localhost:${config.port}`);
    console.log(`Results directory: ${config.resultsDir}`);
    const classifier = loadTrackerClassifier();
    const info = classifier.datasetInfo();
    console.log(`Tracker dataset: ${info.available ? `${info.name} (${info.entryCount} domains)` : 'UNAVAILABLE — run npm run trackers:update'}`);
  });
}
