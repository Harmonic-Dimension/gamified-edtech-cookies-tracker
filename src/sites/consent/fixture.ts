import type { Page } from 'playwright';
import type { ConsentAdapter, ConsentActionResult, BannerDetection } from '../types.js';
import type { ConsentStateProbe } from '../../types.js';
import { sha256 } from '../../util/hash.js';

/** Consent adapter for the local fixture site (see fixtures/site). */
export const fixtureConsentAdapter: ConsentAdapter = {
  id: 'fixture-banner',
  description: 'Simple two-button consent banner of the local fixture site.',

  async detectBanner(page: Page, timeoutMs: number): Promise<BannerDetection> {
    try {
      await page.getByRole('button', { name: /alles accepteren/i }).first()
        .waitFor({ state: 'visible', timeout: timeoutMs });
      return { detected: true, detector: 'role+text:accept-all' };
    } catch {
      return { detected: false, detector: null };
    }
  },

  async accept(page: Page): Promise<ConsentActionResult> {
    await page.getByRole('button', { name: /alles accepteren/i }).first().click({ timeout: 5000 });
    const dismissed = await bannerGone(page);
    return { ok: true, steps: ['click accept-all'], notes: [], bannerDismissed: dismissed };
  },

  async reject(page: Page): Promise<ConsentActionResult> {
    await page.getByRole('button', { name: /alles weigeren/i }).first().click({ timeout: 5000 });
    const dismissed = await bannerGone(page);
    return { ok: true, steps: ['click reject-all'], notes: [], bannerDismissed: dismissed };
  },

  async probeState(page: Page): Promise<ConsentStateProbe> {
    const state = await page.evaluate(() => (window as any).__fixtureConsentState ?? null);
    if (!state) {
      return {
        method: 'fixture:__fixtureConsentState',
        gdprApplies: null, tcStringPresent: null, tcStringSha256: null,
        purposeConsentsTrue: null, purposeConsentsTotal: null,
        vendorConsentsTrue: null, vendorConsentsTotal: null,
        raw: null, matchesRequestedCondition: null, error: 'no fixture consent state',
      };
    }
    const consented = state.decision === 'accept';
    return {
      method: 'fixture:__fixtureConsentState',
      gdprApplies: true,
      tcStringPresent: true,
      tcStringSha256: sha256(String(state.decision)),
      purposeConsentsTrue: consented ? 10 : 0,
      purposeConsentsTotal: 10,
      vendorConsentsTrue: consented ? 3 : 0,
      vendorConsentsTotal: 3,
      raw: { decision: state.decision },
      matchesRequestedCondition: null,
      error: null,
    };
  },
};

async function bannerGone(page: Page, timeoutMs = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#consent-banner') as HTMLElement | null;
      return !el || el.offsetParent === null;
    }, undefined, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
