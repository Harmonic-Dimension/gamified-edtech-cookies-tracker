import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConsentCondition } from './types.js';
import { CONSENT_CONDITIONS } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export interface AppConfig {
  dataDir: string;
  resultsDir: string;
  trackerDataDir: string;
  fixturesDir: string;
  port: number;
  /** 'chrome' asks Playwright for Google Chrome Stable; null uses bundled Chromium. */
  browserChannel: string | null;
  headless: boolean;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  repetitions: number;
  conditions: ConsentCondition[];
  observeHomepageMs: number;
  observeExerciseMs: number;
  navigationTimeoutMs: number;
  recordVideo: boolean;
  recordTrace: boolean;
  recordHar: boolean;
  navigateToExercise: boolean;
  /** Extra delay between runs, to avoid hammering the audited sites. */
  politenessDelayMs: number;
  interactiveMaxMs: number;
}

export const config: AppConfig = {
  dataDir: process.env.AUDIT_DATA_DIR ?? path.join(PROJECT_ROOT, 'data'),
  resultsDir: process.env.AUDIT_RESULTS_DIR ?? path.join(process.env.AUDIT_DATA_DIR ?? path.join(PROJECT_ROOT, 'data'), 'audits'),
  trackerDataDir: process.env.AUDIT_TRACKER_DIR ?? path.join(PROJECT_ROOT, 'data', 'trackers'),
  fixturesDir: path.join(PROJECT_ROOT, 'fixtures', 'site'),
  port: envInt('PORT', 3000),
  browserChannel: process.env.AUDIT_BROWSER_CHANNEL?.trim() || null,
  headless: envBool('AUDIT_HEADLESS', true),
  viewport: {
    width: envInt('AUDIT_VIEWPORT_WIDTH', 1365),
    height: envInt('AUDIT_VIEWPORT_HEIGHT', 768),
  },
  deviceScaleFactor: Number(process.env.AUDIT_DEVICE_SCALE ?? 1),
  locale: process.env.AUDIT_LOCALE ?? 'nl-NL',
  timezoneId: process.env.AUDIT_TIMEZONE ?? 'Europe/Amsterdam',
  repetitions: envInt('AUDIT_REPETITIONS', 3),
  conditions: parseConditions(process.env.AUDIT_CONDITIONS) ?? CONSENT_CONDITIONS,
  observeHomepageMs: envInt('AUDIT_OBSERVE_HOMEPAGE_MS', 15000),
  observeExerciseMs: envInt('AUDIT_OBSERVE_EXERCISE_MS', 35000),
  navigationTimeoutMs: envInt('AUDIT_NAV_TIMEOUT_MS', 45000),
  recordVideo: envBool('AUDIT_RECORD_VIDEO', false),
  recordTrace: envBool('AUDIT_RECORD_TRACE', true),
  recordHar: envBool('AUDIT_RECORD_HAR', true),
  navigateToExercise: envBool('AUDIT_NAVIGATE_TO_EXERCISE', true),
  politenessDelayMs: envInt('AUDIT_POLITENESS_DELAY_MS', 2000),
  interactiveMaxMs: envInt('AUDIT_INTERACTIVE_MAX_MS', 15 * 60 * 1000),
};

function parseConditions(raw: string | undefined): ConsentCondition[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean) as ConsentCondition[];
  const valid = parts.filter((p) => CONSENT_CONDITIONS.includes(p));
  return valid.length ? valid : null;
}

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.resultsDir, config.trackerDataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
