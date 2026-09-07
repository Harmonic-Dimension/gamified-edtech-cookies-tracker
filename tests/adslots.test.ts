import { describe, it, expect } from 'vitest';
import { unionArea, countCreativeChanges, distinctVisibleSlots } from '../src/audit/adslots.js';
import type { AdSlotObservation } from '../src/types.js';

describe('visible advertising area', () => {
  it('does not count overlapping rectangles twice', () => {
    // An ad iframe nested inside its slot container.
    const area = unionArea([
      { x0: 0, y0: 0, x1: 728, y1: 90 },
      { x0: 0, y0: 0, x1: 728, y1: 90 },
    ]);
    expect(area).toBe(728 * 90);
  });

  it('adds up disjoint rectangles', () => {
    expect(unionArea([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 20, y0: 0, x1: 30, y1: 10 }])).toBe(200);
  });

  it('handles partial overlap', () => {
    expect(unionArea([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 0, x1: 15, y1: 10 }])).toBe(150);
  });

  it('returns 0 for no rectangles', () => {
    expect(unionArea([])).toBe(0);
  });
});

describe('counting distinct advertising placements', () => {
  const box = (x: number, y: number, w: number, h: number, detector = 'container') => ({
    detector, selector: 'sel', x, y, width: w, height: h, inViewport: true,
    iframeSrc: null, iframeDomain: null, screenshotSha256: null,
  });

  it('counts a nested ad iframe and its container as one placement', () => {
    const slots = [box(0, 0, 1365, 90), box(198, 0, 970, 90, 'iframe-ad-domain')];
    expect(distinctVisibleSlots(slots)).toHaveLength(1);
  });

  it('counts separate placements separately', () => {
    expect(distinctVisibleSlots([box(0, 0, 728, 90), box(0, 400, 300, 250)])).toHaveLength(2);
  });

  it('ignores slots outside the viewport', () => {
    const offscreen = { ...box(0, 2000, 728, 90), inViewport: false };
    expect(distinctVisibleSlots([box(0, 0, 728, 90), offscreen])).toHaveLength(1);
  });
});

describe('advertisement rotation', () => {
  const observation = (label: string, hash: string): AdSlotObservation => ({
    label,
    tRelMs: 0,
    viewport: { width: 1365, height: 768 },
    slots: [{ detector: 'container', selector: '.r89', x: 0, y: 0, width: 728, height: 90, inViewport: true, iframeSrc: null, iframeDomain: null, screenshotSha256: hash }],
    visibleAdAreaPx: 65520,
    viewportAreaPx: 1048320,
    visibleAdAreaFraction: 0.0625,
    error: null,
  });

  it('counts a change when the rendered creative differs between checkpoints', () => {
    expect(countCreativeChanges([observation('a', 'hash1'), observation('b', 'hash2'), observation('c', 'hash2')])).toBe(1);
  });

  it('returns null when there is nothing to compare', () => {
    expect(countCreativeChanges([observation('a', 'hash1')])).toBeNull();
    expect(countCreativeChanges([])).toBeNull();
  });
});
