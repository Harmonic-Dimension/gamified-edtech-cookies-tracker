import type { MetricStats } from './aggregate.js';
import type { ConsentStatus, RunStatus } from '../types.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const NOT_MEASURED = '<span class="na" title="This value could not be measured in any usable run">not measured</span>';

/** Renders min / median / max, or an explicit "not measured". */
export function statCell(stats: MetricStats | null | undefined, options: { percent?: boolean } = {}): string {
  if (!stats || stats.measuredRuns === 0) return NOT_MEASURED;
  const fmt = (value: number | null) => {
    if (value == null) return '–';
    if (options.percent) return `${(value * 100).toFixed(1)}%`;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  };
  const detail = stats.values
    .map((value, index) => `run ${index + 1}: ${value == null ? 'not measured' : options.percent ? `${(value * 100).toFixed(1)}%` : value}`)
    .join('\n');
  const spread = stats.min === stats.max ? fmt(stats.median) : `${fmt(stats.median)} <span class="range">(${fmt(stats.min)}–${fmt(stats.max)})</span>`;
  const incomplete =
    stats.measuredRuns < stats.totalRuns
      ? ` <span class="warn" title="${stats.totalRuns - stats.measuredRuns} of ${stats.totalRuns} runs did not measure this">*</span>`
      : '';
  return `<span title="${escapeHtml(detail)}">${spread}${incomplete}</span>`;
}

export function statValuesList(stats: MetricStats | null | undefined, options: { percent?: boolean } = {}): string {
  if (!stats || !stats.values.length) return NOT_MEASURED;
  return stats.values
    .map((value, index) => {
      const shown = value == null ? 'not measured' : options.percent ? `${(value * 100).toFixed(1)}%` : String(value);
      return `run ${index + 1}: ${shown}`;
    })
    .join(' · ');
}

export function runStatusBadge(status: RunStatus): string {
  const label = { completed: 'completed', partial: 'partial', failed: 'failed' }[status];
  return `<span class="badge badge-${status}">${label}</span>`;
}

export function consentStatusBadge(status: ConsentStatus): string {
  const text: Record<ConsentStatus, string> = {
    confirmed: 'confirmed',
    performed: 'performed, not confirmed',
    no_banner: 'no banner found',
    failed: 'automation failed',
    not_attempted: 'no interaction (by design)',
  };
  const kind =
    status === 'confirmed' ? 'ok' : status === 'not_attempted' ? 'neutral' : status === 'performed' ? 'warn' : 'bad';
  return `<span class="badge badge-${kind}">${text[status]}</span>`;
}

export function presenceLabel(runsPresent: number, totalRuns: number): string {
  if (totalRuns === 0) return 'no usable runs';
  return `${runsPresent}/${totalRuns} runs`;
}

export function formatBytesShare(fraction: number | null): string {
  if (fraction == null) return 'not measured';
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
