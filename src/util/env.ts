import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import type { EnvironmentInfo } from '../types.js';

const require = createRequire(import.meta.url);

export function playwrightVersion(): string {
  try {
    return require('playwright/package.json').version as string;
  } catch {
    return 'unknown';
  }
}

export function appVersion(): string {
  try {
    return require('../../package.json').version as string;
  } catch {
    return 'unknown';
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function inDocker(): boolean {
  if (process.env.AUDIT_IN_DOCKER === '1') return true;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods/.test(cgroup);
  } catch {
    return false;
  }
}

export function collectEnvironment(): EnvironmentInfo {
  const commit = process.env.AUDIT_GIT_COMMIT ?? git(['rev-parse', 'HEAD']);
  const dirtyOut = process.env.AUDIT_GIT_COMMIT ? null : git(['status', '--porcelain']);
  return {
    node: process.version,
    playwright: playwrightVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: `${os.type()} ${os.release()}`,
    inDocker: inDocker(),
    timezone: config.timezoneId,
    locale: config.locale,
    gitCommit: commit,
    gitDirty: dirtyOut == null ? null : dirtyOut.length > 0,
    appVersion: appVersion(),
  };
}
