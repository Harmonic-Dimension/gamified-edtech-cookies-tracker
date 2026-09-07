import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ConsentCondition } from '../types.js';
import { config, ensureDirs } from '../config.js';
import { SITE_DEFINITIONS, getSiteDefinition, allSiteIds } from '../sites/definitions.js';
import { runAudit } from '../audit/audit.js';
import { loadTrackerClassifier } from '../trackers/dataset.js';
import { runDir } from '../store/store.js';

/**
 * Command line entry point.
 *
 *   npm run audit -- all
 *   npm run audit -- spellingoefenen reject
 *   npm run audit -- taaloefenen accept --repeat 5
 *   npm run audit:interactive -- spellingoefenen reject
 */

const CONDITION_ALIASES: Record<string, ConsentCondition> = {
  none: 'no_choice',
  no: 'no_choice',
  nochoice: 'no_choice',
  no_choice: 'no_choice',
  geen: 'no_choice',
  reject: 'reject_all',
  reject_all: 'reject_all',
  rejectall: 'reject_all',
  weigeren: 'reject_all',
  accept: 'accept_all',
  accept_all: 'accept_all',
  acceptall: 'accept_all',
  accepteren: 'accept_all',
};

function usage(): void {
  console.log(`
Usage: npm run audit -- <site|all> [condition] [options]

  site        one of: ${allSiteIds().join(', ')}, or "all"
  condition   no_choice | reject_all | accept_all (default: all three)

Options:
  --repeat <n>      repetitions per site/condition (default ${config.repetitions})
  --interactive     launch a visible browser and wait for the operator
  --headed          launch a visible browser without waiting
  --no-exercise     stay on the entry page, do not navigate into an exercise
  --video           record video of the session
  --label <text>    label for this audit
  --resume <id>     continue an interrupted audit: runs already recorded are
                    skipped and new runs are added to that same audit

Examples:
  npm run audit -- all
  npm run audit -- spellingoefenen reject --repeat 5
  npm run audit:interactive -- spellingoefenen reject
  npm run audit -- all --resume 5bfa7f21-3f60-4ba6-b507-d7db13e0c9d6
`);
}

export async function main(argv: string[]): Promise<void> {
  ensureDirs();
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  // Options that take a value; everything else starting with "--" is a flag.
  // Without this distinction, `--label "my audit"` would leave "my audit"
  // among the positional arguments and be mistaken for a condition.
  const VALUE_OPTIONS = new Set(['repeat', 'label', 'resume']);
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^--/, '');
    if (VALUE_OPTIONS.has(name)) {
      const value = args[i + 1];
      if (value == null || value.startsWith('--')) {
        console.error(`Option --${name} needs a value.`);
        process.exitCode = 1;
        return;
      }
      options.set(name, value);
      i += 1;
    } else {
      flags.add(name);
    }
  }
  const flag = (name: string): boolean => flags.has(name);
  const option = (name: string): string | null => options.get(name) ?? null;

  const siteArg = positional[0] ?? 'all';
  const conditionArg = positional[1] ? positional[1].toLowerCase() : null;

  const sites =
    siteArg === 'all'
      ? SITE_DEFINITIONS
      : [getSiteDefinition(siteArg)].filter((site): site is NonNullable<typeof site> => Boolean(site));
  if (!sites.length) {
    console.error(`Unknown site "${siteArg}". Known sites: ${allSiteIds().join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let conditions: ConsentCondition[] | undefined;
  if (conditionArg) {
    const condition = CONDITION_ALIASES[conditionArg];
    if (!condition) {
      console.error(`Unknown condition "${conditionArg}".`);
      process.exitCode = 1;
      return;
    }
    conditions = [condition];
  }

  const interactive = flag('interactive');
  let repetitions = interactive ? 1 : config.repetitions;
  if (option('repeat') != null) {
    const parsed = Number(option('repeat'));
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`--repeat must be a positive whole number (got "${option('repeat')}").`);
      process.exitCode = 1;
      return;
    }
    repetitions = parsed;
  }

  const classifier = loadTrackerClassifier();
  const dataset = classifier.datasetInfo();
  console.log(`Tracker classification: ${dataset.available ? `${dataset.name} (${dataset.entryCount} domains)` : 'UNAVAILABLE'}`);
  if (!dataset.available) {
    console.log('  -> tracker/advertising counts will be reported as "not measured", never as 0.');
    console.log('  -> run `npm run trackers:update` to install the pinned DuckDuckGo Tracker Radar dataset.');
  }

  const resumeAuditId = option('resume');
  if (resumeAuditId) {
    console.log(`Resuming audit ${resumeAuditId}: runs that were already recorded will be skipped.`);
  }

  const metadata = await runAudit({
    label: option('label') ?? `${siteArg} / ${conditionArg ?? 'all conditions'}${interactive ? ' (interactive)' : ''}`,
    resumeAuditId: resumeAuditId ?? undefined,
    sites,
    conditions,
    repetitions,
    interactive,
    headless: interactive || flag('headed') ? false : config.headless,
    runOverrides: {
      navigateToExercise: flag('no-exercise') ? false : config.navigateToExercise,
      recordVideo: flag('video') ? true : config.recordVideo,
      waitForOperator: interactive ? waitForOperator : undefined,
    },
  });

  console.log(`\nAudit id: ${metadata.auditId}`);
  console.log(`Results:  ${path.join(config.resultsDir, metadata.auditId)}`);
  console.log(`Dashboard: http://localhost:${config.port}/audits/${metadata.auditId}`);
}

/**
 * Interactive mode: the run pauses here while the operator uses the visible
 * browser. Recording continues the whole time. The session ends when the
 * operator presses Enter in the terminal, when the dashboard writes a FINISH
 * file into the run directory, or after AUDIT_INTERACTIVE_MAX_MS.
 */
export async function waitForOperator(page: Page, runId: string): Promise<void> {
  console.log('\n>>> Interactive session running.');
  console.log('>>> Interact with the page in the visible browser window.');
  console.log('>>> Press Enter here (or use "Finish run" in the dashboard) to end the session and save the evidence.\n');

  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(poller);
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve();
    };
    const onData = () => finish();
    try {
      process.stdin.resume();
      process.stdin.on('data', onData);
    } catch {
      // no TTY (e.g. inside Docker without -it): rely on the file/timeout paths
    }
    const poller = setInterval(() => {
      if (page.isClosed()) {
        finish();
        return;
      }
      // The dashboard signals "finish" by creating this file.
      const dirs = fs.existsSync(config.resultsDir) ? fs.readdirSync(config.resultsDir) : [];
      for (const auditId of dirs) {
        const marker = path.join(runDir(auditId, runId), 'FINISH');
        if (fs.existsSync(marker)) {
          try { fs.unlinkSync(marker); } catch { /* ignore */ }
          finish();
          return;
        }
      }
    }, 1000);
    const timer = setTimeout(finish, config.interactiveMaxMs);
  });
}

const invokedDirectly = process.argv[1] && /cli[\/\\]audit\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
