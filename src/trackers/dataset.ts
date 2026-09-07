import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sha256 } from '../util/hash.js';
import { registrableDomainOf } from '../util/domains.js';
import type { DomainClassification, TrackerDatasetInfo, TrackerCategoryLabel } from '../types.js';

/**
 * Tracker classification.
 *
 * Two clearly separated sources, so that every statement in the report can name
 * the dataset that produced it:
 *
 *  1. DuckDuckGo Tracker Radar, pinned to an exact upstream commit and fetched
 *     by `npm run trackers:update`. Presence in that dataset is reported as
 *     "known tracker according to Tracker Radar <commit>". Tracker Radar also
 *     names the owning company.
 *  2. `data/trackers/bundled-adtech-list.json`, a hand-curated list maintained
 *     in this repository, used only for the narrower "advertising-related"
 *     label and always attributed to itself.
 *
 * When neither is available, classification is reported as UNAVAILABLE. It is
 * never silently downgraded to "no trackers found".
 */

interface RadarFile {
  name: string;
  version: string;
  commit: string | null;
  sourceUrl: string | null;
  sha256: string | null;
  retrievedAt: string | null;
  /** registrable domain -> [ownerName, prevalence] */
  domains: Record<string, [string | null, number | null]>;
}

interface AdtechFile {
  name: string;
  version: string;
  description: string;
  curatedAt: string;
  advertisingCategories: string[];
  domains: Record<string, string[]>;
}

export class TrackerClassifier {
  private radar: RadarFile | null = null;
  private adtech: AdtechFile | null = null;
  private info: TrackerDatasetInfo;
  private cache = new Map<string, DomainClassification>();

  constructor(radar: RadarFile | null, adtech: AdtechFile | null) {
    this.radar = radar;
    this.adtech = adtech;
    const parts: string[] = [];
    if (radar) parts.push(`${radar.name}@${radar.commit ?? radar.version}`);
    if (adtech) parts.push(`${adtech.name}@${adtech.version}`);
    this.info = {
      available: Boolean(radar || adtech),
      name: parts.join(' + ') || 'none',
      version: radar?.version ?? adtech?.version ?? 'n/a',
      commit: radar?.commit ?? null,
      sourceUrl: radar?.sourceUrl ?? null,
      sha256: radar?.sha256 ?? null,
      retrievedAt: radar?.retrievedAt ?? adtech?.curatedAt ?? null,
      entryCount: radar ? Object.keys(radar.domains).length : adtech ? Object.keys(adtech.domains).length : null,
      note: radar
        ? 'DuckDuckGo Tracker Radar pinned to an exact upstream commit; advertising labels come from the in-repo curated list.'
        : adtech
          ? 'Tracker Radar not installed. Only the in-repo curated advertising list is available; "known tracker" cannot be evaluated.'
          : 'No classification dataset available. Domains are reported as third parties only.',
    };
  }

  datasetInfo(): TrackerDatasetInfo {
    return this.info;
  }

  get available(): boolean {
    return this.info.available;
  }

  get radarAvailable(): boolean {
    return this.radar != null;
  }

  classify(domainOrUrl: string): DomainClassification {
    const registrable = domainOrUrl.includes('/')
      ? registrableDomainOf(domainOrUrl)
      : registrableDomainOf(`http://${domainOrUrl}`) ?? domainOrUrl;
    const key = (registrable ?? domainOrUrl).toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    let label: TrackerCategoryLabel = 'third_party';
    let owner: string | null = null;
    const categories: string[] = [];
    const datasets: string[] = [];

    if (!this.available) {
      const unavailable: DomainClassification = {
        registrableDomain: key,
        label: 'unknown_dataset_unavailable',
        owner: null,
        categories: [],
        datasetName: 'none',
        datasetVersion: 'n/a',
      };
      this.cache.set(key, unavailable);
      return unavailable;
    }

    if (this.adtech) {
      const cats = this.adtech.domains[key];
      if (cats) {
        categories.push(...cats);
        datasets.push(`${this.adtech.name}@${this.adtech.version}`);
        if (cats.some((c) => this.adtech!.advertisingCategories.includes(c))) {
          label = 'advertising_related';
        } else {
          label = 'known_tracker';
        }
      }
    }

    if (this.radar) {
      const hit = this.radar.domains[key];
      if (hit) {
        owner = hit[0];
        datasets.push(`${this.radar.name}@${this.radar.commit ?? this.radar.version}`);
        if (label === 'third_party') label = 'known_tracker';
      }
    }

    if (label === 'third_party') label = 'unclassified';

    const result: DomainClassification = {
      registrableDomain: key,
      label,
      owner,
      categories,
      datasetName: datasets.join(' + ') || this.info.name,
      datasetVersion: this.info.version,
    };
    this.cache.set(key, result);
    return result;
  }

  /** Human-readable, deliberately cautious wording used in dashboard and report. */
  static labelText(c: DomainClassification): string {
    switch (c.label) {
      case 'known_tracker':
        return `Known tracker according to ${c.datasetName}`;
      case 'advertising_related':
        return `Advertising-related according to ${c.datasetName}`;
      case 'unclassified':
        return 'Third-party domain, unclassified';
      case 'unknown_dataset_unavailable':
        return 'Classification unavailable (no dataset installed)';
      default:
        return 'Third-party domain';
    }
  }
}

let cached: TrackerClassifier | null = null;

export function loadTrackerClassifier(force = false): TrackerClassifier {
  if (cached && !force) return cached;
  const radarPath = path.join(config.trackerDataDir, 'tracker-radar-domains.json');
  const adtechPath = path.join(config.trackerDataDir, 'bundled-adtech-list.json');
  let radar: RadarFile | null = null;
  let adtech: AdtechFile | null = null;
  try {
    if (fs.existsSync(radarPath)) radar = JSON.parse(fs.readFileSync(radarPath, 'utf8')) as RadarFile;
  } catch {
    radar = null;
  }
  try {
    if (fs.existsSync(adtechPath)) adtech = JSON.parse(fs.readFileSync(adtechPath, 'utf8')) as AdtechFile;
  } catch {
    adtech = null;
  }
  cached = new TrackerClassifier(radar, adtech);
  return cached;
}

/** Used by the fetch script; exported so tests can build a classifier in memory. */
export function buildRadarFile(
  raw: Record<string, any>,
  meta: { commit: string; sourceUrl: string; sha256: string },
): RadarFile {
  const domains: Record<string, [string | null, number | null]> = {};
  for (const [host, value] of Object.entries(raw)) {
    const registrable = registrableDomainOf(`http://${host}`) ?? host;
    const ownerName: string | null =
      (value?.owner?.displayName as string) ?? (value?.owner?.name as string) ?? (value?.entityName as string) ?? null;
    const prevalence: number | null = typeof value?.prevalence === 'number' ? value.prevalence : null;
    const existing = domains[registrable];
    if (!existing || (prevalence ?? 0) > (existing[1] ?? 0)) {
      domains[registrable] = [ownerName, prevalence];
    }
  }
  return {
    name: 'duckduckgo-tracker-radar',
    version: meta.commit.slice(0, 12),
    commit: meta.commit,
    sourceUrl: meta.sourceUrl,
    sha256: meta.sha256,
    retrievedAt: new Date().toISOString(),
    domains,
  };
}

export function hashOf(text: string): string {
  return sha256(text);
}
