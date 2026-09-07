import type { Page } from 'playwright';
import type { ConsentStateProbe } from '../types.js';

export interface ConsentActionResult {
  ok: boolean;
  steps: string[];
  notes: string[];
  bannerDismissed: boolean | null;
}

export interface BannerDetection {
  detected: boolean;
  detector: string | null;
}

/**
 * A consent adapter encapsulates everything site-specific about the consent
 * dialog. It must never *bypass* a CMP: it only performs the clicks a human
 * would perform, and it reads back the resulting state through the CMP's own
 * public API.
 */
export interface ConsentAdapter {
  id: string;
  description: string;
  detectBanner(page: Page, timeoutMs: number): Promise<BannerDetection>;
  reject(page: Page): Promise<ConsentActionResult>;
  accept(page: Page): Promise<ConsentActionResult>;
  /** Independent read-back of the consent state after the action. */
  probeState(page: Page): Promise<ConsentStateProbe>;
}

export type ExerciseStep =
  | { kind: 'goto'; url: string; note?: string }
  /** Navigate directly only if a preceding (optional) click did not get us there. */
  | { kind: 'gotoUnlessUrl'; url: string; pattern: string; description: string }
  | {
      kind: 'click';
      description: string;
      textPattern?: string;
      role?: 'link' | 'button';
      selector?: string;
      /** Click inside this (same-origin) iframe instead of the main document. */
      frameSelector?: string;
      optional?: boolean;
    }
  | { kind: 'wait'; ms: number; note?: string }
  | { kind: 'expectSelector'; selector: string; timeoutMs?: number; description: string }
  | { kind: 'expectUrl'; pattern: string; timeoutMs?: number; description: string };

export interface SiteDefinition {
  id: string;
  name: string;
  startUrl: string;
  /** Registrable domain treated as first party for this site. */
  firstPartyDomain: string;
  operator: string | null;
  consent: ConsentAdapter;
  /** Declarative, easily editable route into an actual learning activity. */
  exercise: {
    description: string;
    steps: ExerciseStep[];
    /** Selector in the main document proving that the exercise is on screen. */
    verifySelector?: string;
    /** Verification inside the exercise iframe, when the activity lives there. */
    verifyFrame?: {
      frameSelector: string;
      visibleSelector?: string;
      /** Something that must have disappeared, e.g. the level chooser. */
      hiddenSelector?: string;
    };
    /**
     * An honest statement of what this route can and cannot establish. It is
     * copied into every run's exercise notes and shown in the dashboard, so a
     * reader is never left to assume the automation got further than it did.
     */
    limitation?: string;
  } | null;
  /** Site-specific additional advertising containers, on top of the generic ones. */
  adSlotSelectors: string[];
  notes: string[];
}
