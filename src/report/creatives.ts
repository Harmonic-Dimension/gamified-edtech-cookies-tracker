import fs from 'node:fs';
import path from 'node:path';
import type { AdSlotBox, AdSlotObservation, ConsentCondition, RunResult } from '../types.js';
import { slotImageName, slotsWithImages } from '../audit/adslots.js';
import { runDir } from '../store/store.js';
import { hammingDistance, perceptualHash } from '../util/png.js';

/**
 * Presents the per-slot crops that every run already records.
 *
 * The report used to show only whole-viewport screenshots, in which a 728x90
 * banner is a thin strip a reader cannot make out, and in which the same page
 * furniture dominates every image. The audit has meanwhile photographed each
 * visible advertising slot at each checkpoint. This module selects, groups and
 * labels those crops; it measures nothing new and re-classifies nothing.
 *
 * The organising unit is the *slot position*, not the individual picture. That
 * matters, because an advertising slot that was not filled still renders: it
 * shows the page behind it. Grouping every rendering of one slot together lets
 * the report state exactly what it can support — "this is what this slot
 * displayed, at these moments, in these runs" — instead of asserting that any
 * particular picture is an advertisement. Deciding which is which is left to the
 * reader, who can see it at a glance and does not need the tool to guess: a slot
 * that served the same advertisement all audit long and a slot that was never
 * filled both produce one image, and no recorded signal separates them.
 *
 * Three mechanical selections are applied:
 *  - boxes too small to be an advertisement (close buttons, labels) are dropped;
 *  - where nested elements describe the same placement (site ad container ->
 *    Google ad container -> the advertisement's own iframe) the innermost box is
 *    used, because that is the crop that frames the creative rather than the
 *    page around it;
 *  - renderings that only differ by a pixel or two — the same picture, captured
 *    while the page animated underneath — are collapsed, so that one picture is
 *    shown once with all its sightings rather than fifteen times.
 */

/** Below this a box is furniture — a close button, a label, a spacer. */
const MIN_CREATIVE_WIDTH = 120;
const MIN_CREATIVE_HEIGHT = 40;
const MIN_CREATIVE_AREA = 12_000;

/** Selectors that match an advertisement's own frame rather than a page container. */
const AD_FRAME_SELECTOR = /google_ads_iframe|adsbygoogle|^iframe\[src/i;

export interface Sighting {
  runId: string;
  condition: ConsentCondition;
  repetition: number;
  checkpoint: string;
  tRelMs: number;
  startedAt: string;
}

/** One distinct image produced by a slot, with every moment it was seen. */
export interface Rendering {
  sha256: string;
  /** Absolute path to the crop on disk. */
  file: string;
  sightings: Sighting[];
  conditions: ConsentCondition[];
  /** Exact renderings folded into this one because they look the same. */
  identicalVariants: number;
}

/** One advertising slot, identified by where and how large it was. */
export interface SlotPlacement {
  siteId: string;
  siteName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Recorded viewport width, so the report can print the slot to scale. */
  viewportWidth: number;
  detector: string;
  selector: string;
  iframeDomain: string | null;
  /** True when the box is the advertisement's own frame rather than a page container. */
  framesAdItself: boolean;
  renderings: Rendering[];
  observationCount: number;
  runIds: string[];
  conditions: ConsentCondition[];
}

export interface SiteCreatives {
  siteId: string;
  siteName: string;
  placements: SlotPlacement[];
  /** Boxes too small to be an advertisement. */
  skippedTooSmall: number;
  /** Slots whose crop could not be located on disk. */
  missingImages: number;
  /** Total advertising-slot observations behind this gallery. */
  observationCount: number;
}

function isAdFrame(slot: AdSlotBox): boolean {
  return slot.detector === 'iframe-ad-domain' || AD_FRAME_SELECTOR.test(slot.selector);
}

function isLargeEnough(slot: AdSlotBox): boolean {
  return (
    slot.width >= MIN_CREATIVE_WIDTH &&
    slot.height >= MIN_CREATIVE_HEIGHT &&
    slot.width * slot.height >= MIN_CREATIVE_AREA
  );
}

function overlapFraction(inner: AdSlotBox, outer: AdSlotBox): number {
  const width = Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x));
  const height = Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
  const area = inner.width * inner.height;
  return area > 0 ? (width * height) / area : 0;
}

/**
 * Of every group of boxes describing the same placement, keeps the smallest.
 * `distinctVisibleSlots` in the audit keeps the largest, because there it counts
 * placements; here the goal is the tightest crop of what was displayed.
 */
function innermostBoxes(
  candidates: Array<{ slot: AdSlotBox; index: number }>,
): Array<{ slot: AdSlotBox; index: number }> {
  const bySize = [...candidates].sort((a, b) => a.slot.width * a.slot.height - b.slot.width * b.slot.height);
  const kept: Array<{ slot: AdSlotBox; index: number }> = [];
  for (const candidate of bySize) {
    const containsKept = kept.some((other) => overlapFraction(other.slot, candidate.slot) >= 0.9);
    if (!containsKept) kept.push(candidate);
  }
  return kept;
}

/**
 * Resolves the crop belonging to a slot. Runs recorded before slots carried
 * their own file name fall back to the deterministic name the capture code has
 * always used, which is why `slotsWithImages` is shared with the capture side.
 */
function resolveSlotImage(
  auditId: string,
  run: RunResult,
  observation: AdSlotObservation,
  slot: AdSlotBox,
  index: number,
): string | null {
  const dir = runDir(auditId, run.runId);
  const candidates = [
    slot.screenshotFile,
    path.posix.join('screenshots', slotImageName('adslot', observation.label, index)),
  ].filter((value): value is string => Boolean(value));
  for (const relative of candidates) {
    const file = path.join(dir, relative);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const CONDITION_ORDER: ConsentCondition[] = ['no_choice', 'reject_all', 'accept_all'];

/**
 * Bits that may differ before two crops of the same slot count as different
 * pictures. Chosen against this project's own evidence: crops of one banner
 * captured in different runs sit at 0–1 bits apart, while genuinely different
 * banners in the same slot sit far above this.
 */
const PERCEPTUAL_DISTANCE = 4;

/**
 * Collapses renderings that look the same to a reader. Exact SHA equality has
 * already been applied; this catches the remaining case where the page animated
 * a pixel underneath an unfilled slot, which would otherwise present one picture
 * as a dozen separate observations.
 *
 * Crops that cannot be decoded keep their own entry, so an unreadable image is
 * never silently merged into an unrelated one.
 */
function mergeLookalikes(renderings: Rendering[]): Rendering[] {
  const clusters: Array<{ hash: string | null; rendering: Rendering }> = [];
  for (const rendering of renderings) {
    let hash: string | null = null;
    try {
      hash = perceptualHash(fs.readFileSync(rendering.file));
    } catch {
      hash = null;
    }
    const match = hash
      ? clusters.find((entry) => entry.hash && hammingDistance(entry.hash, hash as string) <= PERCEPTUAL_DISTANCE)
      : undefined;
    if (match) {
      match.rendering.sightings.push(...rendering.sightings);
      match.rendering.identicalVariants += 1;
      for (const condition of rendering.conditions) {
        if (!match.rendering.conditions.includes(condition)) match.rendering.conditions.push(condition);
      }
      continue;
    }
    clusters.push({ hash, rendering });
  }
  return clusters.map((entry) => entry.rendering);
}

export function collectCreatives(auditId: string, runs: RunResult[]): SiteCreatives[] {
  const bySite = new Map<string, SiteCreatives>();
  const byPlacement = new Map<string, SlotPlacement>();

  for (const run of runs) {
    if (run.status === 'failed') continue;
    let site = bySite.get(run.siteId);
    if (!site) {
      site = {
        siteId: run.siteId,
        siteName: run.siteName,
        placements: [],
        skippedTooSmall: 0,
        missingImages: 0,
        observationCount: 0,
      };
      bySite.set(run.siteId, site);
    }

    for (const observation of run.adObservations ?? []) {
      const photographed = slotsWithImages(observation.slots).filter(({ slot }) => slot.screenshotSha256);
      const large = photographed.filter(({ slot }) => isLargeEnough(slot));
      site.skippedTooSmall += photographed.length - large.length;

      for (const { slot, index } of innermostBoxes(large)) {
        const file = resolveSlotImage(auditId, run, observation, slot, index);
        if (!file) {
          site.missingImages += 1;
          continue;
        }

        const key = `${run.siteId}|${slot.x}:${slot.y}:${slot.width}x${slot.height}`;
        let placement = byPlacement.get(key);
        if (!placement) {
          placement = {
            siteId: run.siteId,
            siteName: run.siteName,
            x: slot.x,
            y: slot.y,
            width: slot.width,
            height: slot.height,
            viewportWidth: observation.viewport.width || slot.width,
            detector: slot.detector,
            selector: slot.selector,
            iframeDomain: slot.iframeDomain,
            framesAdItself: isAdFrame(slot),
            renderings: [],
            observationCount: 0,
            runIds: [],
            conditions: [],
          };
          byPlacement.set(key, placement);
          site.placements.push(placement);
        }

        placement.observationCount += 1;
        if (!placement.runIds.includes(run.runId)) placement.runIds.push(run.runId);
        if (!placement.conditions.includes(run.condition)) placement.conditions.push(run.condition);

        let rendering = placement.renderings.find((entry) => entry.sha256 === slot.screenshotSha256);
        if (!rendering) {
          rendering = {
            sha256: slot.screenshotSha256 as string,
            file,
            sightings: [],
            conditions: [],
            identicalVariants: 0,
          };
          placement.renderings.push(rendering);
        }
        rendering.sightings.push({
          runId: run.runId,
          condition: run.condition,
          repetition: run.repetition,
          checkpoint: observation.label,
          tRelMs: observation.tRelMs,
          startedAt: run.startedAt,
        });
        if (!rendering.conditions.includes(run.condition)) rendering.conditions.push(run.condition);
      }
    }
  }

  for (const site of bySite.values()) {
    // A slot that produced one image in every observation, and is not an
    // advertisement's own frame, displayed the page behind it throughout. It is
    // counted rather than shown.
    for (const placement of site.placements) {
      // Fold look-alikes first: a slot showing the page behind it produces a
      // new SHA on every observation, which would otherwise present one picture
      // as a dozen separate renderings.
      placement.renderings = mergeLookalikes(placement.renderings);
      site.observationCount += placement.observationCount;
      for (const rendering of placement.renderings) {
        rendering.conditions.sort((a, b) => CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b));
        rendering.sightings.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.tRelMs - b.tRelMs);
      }
      // Renderings seen most often first: that is the one a visitor was most
      // likely to meet, and it keeps the truncation below predictable.
      placement.renderings.sort(
        (a, b) => b.sightings.length - a.sightings.length || a.sha256.localeCompare(b.sha256),
      );
      placement.conditions.sort((a, b) => CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b));
    }
    // Crops framing the advertisement itself are the clearest evidence; after
    // that, the slots that changed most carried the most advertising.
    site.placements.sort(
      (a, b) =>
        Number(b.framesAdItself) - Number(a.framesAdItself) ||
        b.renderings.length - a.renderings.length ||
        b.width * b.height - a.width * a.height ||
        a.y - b.y,
    );
  }

  // A site with nothing showable is dropped, but one whose crops went missing is
  // kept: the report must say that evidence could not be located rather than
  // render an empty space that reads as "no advertising was observed".
  return [...bySite.values()].filter((site) => site.placements.length || site.missingImages);
}

/** Inlines a crop so the report stays a single self-contained file. */
export function creativeDataUri(file: string, maxBytes = 2_000_000): string | null {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.length > maxBytes) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

export const CHECKPOINT_LABELS: Record<string, string> = {
  '01-first-load': 'immediately after the page opened',
  '02-consent-dialog': 'while the consent dialog was on screen',
  '03-post-consent': 'just after the consent choice',
  '04-exercise-0s': 'when the exercise had just loaded',
  '05-exercise-10s': '10 seconds into the exercise',
  '06-exercise-30s': '30 seconds into the exercise',
};

export function checkpointLabel(checkpoint: string): string {
  return CHECKPOINT_LABELS[checkpoint] ?? checkpoint;
}
