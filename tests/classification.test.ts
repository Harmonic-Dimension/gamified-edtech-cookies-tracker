import { describe, it, expect } from 'vitest';
import { TrackerClassifier } from '../src/trackers/dataset.js';

const radar = {
  name: 'duckduckgo-tracker-radar',
  version: 'abc123def456',
  commit: 'abc123def4567890',
  sourceUrl: 'https://example/domain_map.json',
  sha256: 'deadbeef',
  retrievedAt: '2026-09-01T00:00:00.000Z',
  domains: {
    'doubleclick.net': ['Google LLC', 0.9] as [string | null, number | null],
    'example-analytics.com': ['Example Analytics BV', 0.1] as [string | null, number | null],
  },
};

const adtech = {
  name: 'audit-adtech-list',
  version: '1.0.0',
  description: 'test',
  curatedAt: '2026-09-06',
  advertisingCategories: ['advertising_exchange'],
  domains: {
    'doubleclick.net': ['advertising_exchange'],
    'consentmanager.net': ['consent_management'],
  },
};

describe('tracker classification', () => {
  it('labels advertising domains as advertising-related and names the dataset', () => {
    const classifier = new TrackerClassifier(radar, adtech);
    const result = classifier.classify('securepubads.g.doubleclick.net');
    expect(result.registrableDomain).toBe('doubleclick.net');
    expect(result.label).toBe('advertising_related');
    expect(result.owner).toBe('Google LLC');
    expect(TrackerClassifier.labelText(result)).toContain('audit-adtech-list@1.0.0');
    expect(TrackerClassifier.labelText(result)).toContain('duckduckgo-tracker-radar@abc123def4567890');
  });

  it('does not call every third party a tracker', () => {
    const classifier = new TrackerClassifier(radar, adtech);
    const result = classifier.classify('some-random-cdn.example');
    expect(result.label).toBe('unclassified');
    expect(TrackerClassifier.labelText(result)).toBe('Third-party domain, unclassified');
  });

  it('distinguishes non-advertising known trackers from advertising domains', () => {
    const classifier = new TrackerClassifier(radar, adtech);
    expect(classifier.classify('example-analytics.com').label).toBe('known_tracker');
    expect(classifier.classify('consentmanager.net').label).toBe('known_tracker');
  });

  it('reports "unavailable" rather than "clean" when no dataset is installed', () => {
    const classifier = new TrackerClassifier(null, null);
    expect(classifier.available).toBe(false);
    const result = classifier.classify('doubleclick.net');
    expect(result.label).toBe('unknown_dataset_unavailable');
    expect(TrackerClassifier.labelText(result)).toContain('unavailable');
    expect(classifier.datasetInfo().available).toBe(false);
  });

  it('records the pinned dataset version in its metadata', () => {
    const info = new TrackerClassifier(radar, adtech).datasetInfo();
    expect(info.commit).toBe('abc123def4567890');
    expect(info.sha256).toBe('deadbeef');
    expect(info.entryCount).toBe(2);
  });
});
