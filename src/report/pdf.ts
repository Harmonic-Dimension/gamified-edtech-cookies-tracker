import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildReportHtml } from './html.js';
import { buildPublicSummaryHtml } from './summary-nl.js';
import { summarizeAudit } from './aggregate.js';
import { getAudit, listRuns, auditDir } from '../store/store.js';
import { loadTrackerClassifier } from '../trackers/dataset.js';

/**
 * Renders the HTML report to PDF using the same browser engine that performs
 * the audit, so no extra rendering dependency is introduced.
 */
export async function generatePdfReport(auditId: string, outputPath?: string): Promise<string> {
  const audit = getAudit(auditId);
  if (!audit) throw new Error(`Unknown audit: ${auditId}`);
  const runs = listRuns(auditId);
  const classifier = loadTrackerClassifier();
  const summary = summarizeAudit(audit, runs, classifier);
  const html = buildReportHtml({ summary, runs });

  const target = outputPath ?? path.join(auditDir(auditId), 'report.pdf');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: target,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-size:7pt;color:#777;width:100%;padding:0 14mm;">Privacy and Advertising Audit of Educational Practice Websites</div>',
      footerTemplate:
        '<div style="font-size:7pt;color:#777;width:100%;padding:0 14mm;display:flex;justify-content:space-between;">' +
        `<span>Audit ${auditId.slice(0, 8)} · generated ${new Date().toISOString().slice(0, 10)}</span>` +
        '<span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      margin: { top: '20mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    return target;
  } finally {
    await browser.close();
  }
}

/**
 * The plain-Dutch public summary, as its own document.
 *
 * Deliberately a separate file rather than a chapter of the technical report:
 * the two have different readers, and a lay summary bound into a forty-page
 * measurement report is read by neither. It is generated from the same
 * aggregation, so the two cannot drift apart.
 */
export async function generatePublicSummaryPdf(auditId: string, outputPath?: string): Promise<string> {
  const html = await generatePublicSummaryHtml(auditId);
  const target = outputPath ?? path.join(auditDir(auditId), 'publiekssamenvatting.pdf');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: target,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;">Publiekssamenvatting — reclame en volgtechnieken op oefenwebsites voor kinderen</div>',
      footerTemplate:
        '<div style="font-size:7pt;color:#777;width:100%;padding:0 18mm;display:flex;justify-content:space-between;">' +
        `<span>Onderzoek ${auditId.slice(0, 8)} · samenvatting bij het technische rapport</span>` +
        '<span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      margin: { top: '20mm', bottom: '18mm', left: '18mm', right: '18mm' },
    });
    return target;
  } finally {
    await browser.close();
  }
}

export async function generatePublicSummaryHtml(auditId: string): Promise<string> {
  const audit = getAudit(auditId);
  if (!audit) throw new Error(`Unknown audit: ${auditId}`);
  const runs = listRuns(auditId);
  const summary = summarizeAudit(audit, runs, loadTrackerClassifier());
  return buildPublicSummaryHtml({ summary, runs });
}

export async function generateReportHtml(auditId: string): Promise<string> {
  const audit = getAudit(auditId);
  if (!audit) throw new Error(`Unknown audit: ${auditId}`);
  const runs = listRuns(auditId);
  const classifier = loadTrackerClassifier();
  const summary = summarizeAudit(audit, runs, classifier);
  return buildReportHtml({ summary, runs });
}

const invokedDirectly = process.argv[1] && /report[\/\\]pdf\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const auditId = process.argv[2];
  if (!auditId) {
    console.error('Usage: npm run report -- <audit-id> [--nl] [--only-nl]');
    console.error('  --nl       also write the plain-Dutch public summary');
    console.error('  --only-nl  write only the plain-Dutch public summary');
    process.exit(1);
  }
  const flags = process.argv.slice(3);
  const onlyDutch = flags.includes('--only-nl');
  const alsoDutch = onlyDutch || flags.includes('--nl');

  (async () => {
    if (!onlyDutch) {
      console.log(`Report written to ${await generatePdfReport(auditId)}`);
    }
    if (alsoDutch) {
      console.log(`Public summary (NL) written to ${await generatePublicSummaryPdf(auditId)}`);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
