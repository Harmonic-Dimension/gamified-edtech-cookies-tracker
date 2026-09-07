/**
 * Downloads the DuckDuckGo Tracker Radar domain map at the exact commit pinned
 * in data/trackers/tracker-radar.pin.json and converts it into the compact
 * lookup file used by the audit tool.
 *
 * Run: npm run trackers:update
 *
 * The tool works without this dataset; classification is then reported as
 * unavailable rather than as "no trackers found".
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { sha256 } from '../src/util/hash.js';
import { buildRadarFile } from '../src/trackers/dataset.js';

async function main() {
  const pinPath = path.join(config.trackerDataDir, 'tracker-radar.pin.json');
  if (!fs.existsSync(pinPath)) {
    console.error(`Pin file missing: ${pinPath}`);
    process.exit(1);
  }
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as {
    repository: string;
    commit: string;
    file: string;
  };
  const url = `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${pin.file}`;
  console.log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    console.error('The audit tool will run without Tracker Radar; classification will be reported as unavailable.');
    process.exit(2);
  }
  const text = await response.text();
  const digest = sha256(text);
  console.log(`Downloaded ${(text.length / 1e6).toFixed(1)} MB, sha256=${digest}`);
  const raw = JSON.parse(text) as Record<string, any>;
  const compact = buildRadarFile(raw, { commit: pin.commit, sourceUrl: url, sha256: digest });
  const outPath = path.join(config.trackerDataDir, 'tracker-radar-domains.json');
  fs.writeFileSync(outPath, JSON.stringify(compact));
  console.log(`Wrote ${outPath} with ${Object.keys(compact.domains).length} registrable domains.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
