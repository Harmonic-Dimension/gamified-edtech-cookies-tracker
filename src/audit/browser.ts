import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { BrowserIdentity } from '../types.js';
import { config } from '../config.js';

export interface LaunchResult {
  browser: Browser;
  identity: BrowserIdentity;
  notes: string[];
}

/**
 * Launches a browser and records exactly which browser it is.
 *
 * If AUDIT_BROWSER_CHANNEL=chrome is requested but Google Chrome Stable is not
 * installed, we fall back to the bundled Chromium and say so. The report must
 * never claim Chrome was used when it was not.
 */
export async function launchBrowser(options: {
  headless?: boolean;
  channel?: string | null;
  extraArgs?: string[];
} = {}): Promise<LaunchResult> {
  const headless = options.headless ?? config.headless;
  const requestedChannel = options.channel === undefined ? config.browserChannel : options.channel;
  const notes: string[] = [];
  const args = [
    '--disable-features=Translate',
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
    ...(options.extraArgs ?? []),
  ];

  let browser: Browser | null = null;
  let usedChannel: string | null = requestedChannel;
  if (requestedChannel) {
    try {
      browser = await chromium.launch({ headless, channel: requestedChannel, args });
    } catch (err) {
      notes.push(
        `Requested browser channel "${requestedChannel}" could not be launched (${String(err).slice(0, 160)}); ` +
          'fell back to the Playwright-bundled Chromium. This is recorded in the run metadata.',
      );
      usedChannel = null;
    }
  }
  if (!browser) {
    browser = await chromium.launch({ headless, args });
  }

  const version = browser.version();
  const identity: BrowserIdentity = {
    engine: usedChannel ? usedChannel : 'chromium (Playwright bundled)',
    channel: usedChannel,
    version,
    isGoogleChromeStable: usedChannel === 'chrome',
    executablePath: null,
    headless,
    userAgent: '',
  };
  return { browser, identity, notes };
}

export interface FreshContextOptions {
  recordHarPath?: string | null;
  recordVideoDir?: string | null;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  deviceScaleFactor?: number;
}

/**
 * Creates a genuinely isolated context: Playwright contexts start with no
 * cookies, no local/session storage, no service workers and their own network
 * cache partition. On top of that the runner launches a *new browser process*
 * per run, so nothing at all is shared between conditions.
 */
export async function createFreshContext(browser: Browser, options: FreshContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport ?? config.viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? config.deviceScaleFactor,
    locale: options.locale ?? config.locale,
    timezoneId: options.timezoneId ?? config.timezoneId,
    serviceWorkers: 'allow',
    ignoreHTTPSErrors: false,
    ...(options.recordHarPath
      ? { recordHar: { path: options.recordHarPath, content: 'omit' as const, mode: 'full' as const } }
      : {}),
    ...(options.recordVideoDir
      ? { recordVideo: { dir: options.recordVideoDir, size: options.viewport ?? config.viewport } }
      : {}),
  });
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  context.setDefaultTimeout(15000);
  return context;
}

/** Sanity check that a context really is empty before the run starts. */
export async function assertCleanContext(context: BrowserContext): Promise<{ clean: boolean; details: string[] }> {
  const details: string[] = [];
  const cookies = await context.cookies();
  if (cookies.length) details.push(`context started with ${cookies.length} cookies`);
  const workers = context.serviceWorkers();
  if (workers.length) details.push(`context started with ${workers.length} service workers`);
  return { clean: details.length === 0, details };
}
