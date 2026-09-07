import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));

/**
 * The CLI argument parser is easy to get subtly wrong (an option value being
 * mistaken for a positional argument), and a wrong parse silently audits the
 * wrong thing, so it gets its own test.
 */
function runCli(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', path.join('src', 'cli', 'audit.ts'), ...args], {
      encoding: 'utf8',
      // Never write into the real results directory from a test.
      env: { ...process.env, AUDIT_REPETITIONS: '1', AUDIT_RESULTS_DIR: resultsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('command line parsing', () => {
  it('shows usage with --help and does not start a browser', () => {
    const result = runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('Usage: npm run audit');
    expect(result.output).toContain('spellingoefenen');
  });

  it('rejects an unknown site', () => {
    const result = runCli(['doesnotexist', '--help-not-a-flag']);
    expect(result.output).toContain('Unknown site');
  });

  it('rejects an unknown condition', () => {
    const result = runCli(['spellingoefenen', 'maybe']);
    expect(result.output).toContain('Unknown condition');
  });

  it('does not mistake an option value for a condition', () => {
    // Regression: `--label "Full audit ..."` used to be parsed as a condition.
    const result = runCli(['spellingoefenen', '--label', 'Full audit: 4 sites', '--repeat', 'not-a-number']);
    expect(result.output).not.toContain('Unknown condition');
    expect(result.output).toContain('--repeat must be a positive whole number');
  });

  it('refuses a repetition count that would silently produce no runs', () => {
    expect(runCli(['spellingoefenen', 'reject', '--repeat', '0']).output).toContain('positive whole number');
    expect(runCli(['spellingoefenen', 'reject', '--repeat', '2.5']).output).toContain('positive whole number');
  });
});
