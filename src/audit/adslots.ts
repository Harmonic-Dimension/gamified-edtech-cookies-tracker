import type { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import type { AdSlotObservation, AdSlotBox } from '../types.js';
import { sanitizeUrl } from '../util/sanitize.js';
import { sha256 } from '../util/hash.js';
import { registrableDomainOf } from '../util/domains.js';
import type { TrackerClassifier } from '../trackers/dataset.js';

/**
 * Visual advertising measurement.
 *
 * Two independent detectors, both recorded per slot so a reader can see *why*
 * something was counted:
 *   - "container": an element matching a known ad-slot container selector
 *     (site-specific, e.g. Refinery89's `r89-*` classes, plus generic GPT /
 *     AdSense containers).
 *   - "iframe-ad-domain": an iframe whose source domain is classified as
 *     advertising-related by the tracker dataset.
 *
 * Nothing here inspects the *inside* of a cross-origin ad frame: only the
 * rendered geometry and a hash of the rendered pixels are recorded.
 */

const GENERIC_AD_SELECTORS = [
  'ins.adsbygoogle',
  'iframe[id^="google_ads_iframe"]',
  'div[id^="div-gpt-ad"]',
  '[id^="google_ads"]',
  '[data-google-query-id]',
  '[class*="advertisement"]',
  '[id*="advertisement"]',
];

interface RawBox {
  detector: string;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  iframeSrc: string | null;
}

export async function observeAdSlots(
  page: Page,
  siteSelectors: string[],
  classifier: TrackerClassifier,
  label: string,
  tRelMs: number,
  options: { captureSlotImages: boolean; outDir?: string; runIdPrefix?: string } = { captureSlotImages: false },
): Promise<AdSlotObservation> {
  const selectors = [...siteSelectors, ...GENERIC_AD_SELECTORS];
  let raw: { boxes: RawBox[]; iframes: Array<RawBox & { src: string }>; viewport: { width: number; height: number } };
  try {
    raw = await page.evaluate(
      ({ selectors }) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const boxes: any[] = [];
        const seen = new Set<Element>();
        for (const selector of selectors) {
          let elements: Element[] = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch {
            continue;
          }
          for (const el of elements) {
            if (seen.has(el)) continue;
            seen.add(el);
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            const iframe = el.tagName === 'IFRAME' ? (el as HTMLIFrameElement) : el.querySelector('iframe');
            boxes.push({
              detector: 'container',
              selector,
              x: rect.x + window.scrollX,
              y: rect.y + window.scrollY,
              width: rect.width,
              height: rect.height,
              iframeSrc: iframe?.src || null,
            });
          }
        }
        const iframes = Array.from(document.querySelectorAll('iframe')).map((frame) => {
          const rect = frame.getBoundingClientRect();
          const style = window.getComputedStyle(frame);
          return {
            detector: 'iframe',
            selector: 'iframe',
            src: frame.src || '',
            name: frame.name || null,
            x: rect.x + window.scrollX,
            y: rect.y + window.scrollY,
            width: rect.width,
            height: rect.height,
            hidden: style.display === 'none' || style.visibility === 'hidden',
            iframeSrc: frame.src || null,
          };
        });
        return { boxes, iframes, viewport };
      },
      { selectors },
    );
  } catch (err) {
    return {
      label,
      tRelMs,
      viewport: page.viewportSize() ?? { width: 0, height: 0 },
      slots: [],
      visibleAdAreaPx: 0,
      viewportAreaPx: 0,
      visibleAdAreaFraction: 0,
      error: `ad slot probe failed: ${String(err).slice(0, 200)}`,
    };
  }

  const slots: AdSlotBox[] = [];
  const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
  const scrollX = await page.evaluate(() => window.scrollX).catch(() => 0);
  const viewport = raw.viewport;

  const pushBox = (box: RawBox, detector: string) => {
    const inViewport =
      box.y + box.height > scrollY &&
      box.y < scrollY + viewport.height &&
      box.x + box.width > scrollX &&
      box.x < scrollX + viewport.width;
    slots.push({
      detector,
      selector: box.selector,
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      inViewport,
      iframeSrc: box.iframeSrc ? sanitizeUrl(box.iframeSrc) : null,
      iframeDomain: box.iframeSrc ? registrableDomainOf(box.iframeSrc) : null,
      screenshotSha256: null,
    });
  };

  for (const box of raw.boxes) pushBox(box, 'container');

  for (const frame of raw.iframes) {
    if ((frame as any).hidden) continue;
    if (frame.width < 20 || frame.height < 20) continue;
    const src = frame.src;
    if (!src || !/^https?:/i.test(src)) continue;
    const domain = registrableDomainOf(src);
    if (!domain) continue;
    const classification = classifier.classify(domain);
    if (classification.label === 'advertising_related' || classification.label === 'known_tracker') {
      pushBox({ ...frame, detector: 'iframe-ad-domain', selector: `iframe[src*="${domain}"]` }, 'iframe-ad-domain');
    }
  }

  // Rendered-pixel hash per slot, used to detect creative rotation between
  // checkpoints. Limited to the first few in-viewport slots to keep runs fast.
  if (options.captureSlotImages && options.outDir) {
    const targets = slots.filter((s) => s.inViewport).slice(0, 8);
    for (const [index, slot] of targets.entries()) {
      try {
        const buffer = await page.screenshot({
          clip: {
            x: Math.max(0, slot.x - scrollX),
            y: Math.max(0, slot.y - scrollY),
            width: Math.max(1, Math.min(slot.width, viewport.width)),
            height: Math.max(1, Math.min(slot.height, viewport.height)),
          },
          timeout: 10000,
        });
        slot.screenshotSha256 = sha256(buffer);
        const file = path.join(options.outDir, `${options.runIdPrefix ?? 'slot'}-${label}-${index}.png`);
        fs.writeFileSync(file, buffer);
      } catch {
        slot.screenshotSha256 = null;
      }
    }
  }

  const visibleRects = slots
    .filter((s) => s.inViewport)
    .map((s) => ({
      x0: Math.max(s.x - scrollX, 0),
      y0: Math.max(s.y - scrollY, 0),
      x1: Math.min(s.x - scrollX + s.width, viewport.width),
      y1: Math.min(s.y - scrollY + s.height, viewport.height),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);

  const visibleAdAreaPx = Math.round(unionArea(visibleRects));
  const viewportAreaPx = viewport.width * viewport.height;

  return {
    label,
    tRelMs,
    viewport,
    slots,
    visibleAdAreaPx,
    viewportAreaPx,
    visibleAdAreaFraction: viewportAreaPx > 0 ? visibleAdAreaPx / viewportAreaPx : 0,
    error: null,
  };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Union area of possibly overlapping rectangles (sweep over x boundaries).
 * Overlap matters here: an ad iframe nested inside its slot container must not
 * be counted twice.
 */
export function unionArea(rects: Rect[]): number {
  if (!rects.length) return 0;
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const stripX0 = xs[i];
    const stripX1 = xs[i + 1];
    const width = stripX1 - stripX0;
    if (width <= 0) continue;
    const intervals = rects
      .filter((r) => r.x0 <= stripX0 && r.x1 >= stripX1)
      .map((r) => [r.y0, r.y1] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let currentStart = -Infinity;
    let currentEnd = -Infinity;
    for (const [start, end] of intervals) {
      if (start > currentEnd) {
        if (currentEnd > currentStart) covered += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      } else if (end > currentEnd) {
        currentEnd = end;
      }
    }
    if (currentEnd > currentStart) covered += currentEnd - currentStart;
    total += covered * width;
  }
  return total;
}

/**
 * Several selectors legitimately match the same advertisement: Refinery89 wraps
 * each slot in a container, and Google's ad iframe sits inside that container
 * again. For counting *placements* (rather than measuring area) we keep only
 * the outermost rectangle of each nested group.
 */
export function distinctVisibleSlots(slots: AdSlotBox[]): AdSlotBox[] {
  const visible = slots
    .filter((slot) => slot.inViewport && slot.width > 0 && slot.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const kept: AdSlotBox[] = [];
  for (const slot of visible) {
    const containedInKept = kept.some((other) => {
      const overlapWidth = Math.max(0, Math.min(other.x + other.width, slot.x + slot.width) - Math.max(other.x, slot.x));
      const overlapHeight = Math.max(0, Math.min(other.y + other.height, slot.y + slot.height) - Math.max(other.y, slot.y));
      const overlap = overlapWidth * overlapHeight;
      return overlap >= 0.9 * slot.width * slot.height;
    });
    if (!containedInKept) kept.push(slot);
  }
  return kept;
}

/**
 * Counts how often a slot's rendered pixels changed between checkpoints.
 * Slots are matched by position+size, which is stable for a fixed viewport.
 */
export function countCreativeChanges(observations: AdSlotObservation[]): number | null {
  const withHashes = observations.filter((o) => o.slots.some((s) => s.screenshotSha256));
  if (withHashes.length < 2) return null;
  const lastBySlot = new Map<string, string>();
  let changes = 0;
  for (const observation of withHashes) {
    for (const slot of distinctVisibleSlots(observation.slots)) {
      if (!slot.screenshotSha256) continue;
      const key = `${slot.x}:${slot.y}:${slot.width}x${slot.height}`;
      const previous = lastBySlot.get(key);
      if (previous && previous !== slot.screenshotSha256) changes += 1;
      lastBySlot.set(key, slot.screenshotSha256);
    }
  }
  return changes;
}
