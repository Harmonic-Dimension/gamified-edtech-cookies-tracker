import type { Page, Locator } from 'playwright';
import type { ConsentAdapter, ConsentActionResult, BannerDetection } from '../types.js';
import type { ConsentStateProbe } from '../../types.js';
import { sha256 } from '../../util/hash.js';
import { withTimeout } from '../../util/timeout.js';

/**
 * Adapter for the Consentmanager.net CMP (TCF v2.x), as used by all four
 * oefenwereld.nl practice sites (CMP account id 66181 at time of writing).
 *
 * Observed layout (2026-09):
 *   Layer 1: "Instellingen" / "Settings"  and  "Alles accepteren" / "Accept All".
 *            There is NO reject button on the first layer.
 *   Layer 2 (after Settings): "Alles weigeren" / "Reject All", "Alles accepteren",
 *            "Opslaan + sluiten" / "Save + Exit".
 *
 * Rejecting therefore takes two clicks, which is itself an observation worth
 * recording; the runner writes it into the run timeline.
 */

const ACCEPT_TEXT = /^(alles accepteren|accepteer alles|accept all|alle akzeptieren|tout accepter)/i;
const SETTINGS_TEXT = /^(instellingen|settings|einstellungen|paramètres|meer opties|aanpassen)/i;
const REJECT_TEXT = /^(alles weigeren|weiger alles|weigeren|reject all|alles ablehnen|tout refuser|afwijzen)/i;

const BOX = '#cmpbox';
const CLS = {
  accept: '#cmpbox .cmpboxbtnyes, #cmpbox .cmpboxbtnaccept',
  settings: '#cmpbox .cmpboxbtncustom',
  reject: '#cmpbox .cmpboxbtnreject, #cmpbox .cmpboxbtnno',
};

async function clickFirstVisible(
  page: Page,
  candidates: Array<{ label: string; locator: Locator }>,
  timeoutMs: number,
): Promise<{ ok: boolean; usedLabel: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const target = candidate.locator.first();
        if (await target.isVisible({ timeout: 250 })) {
          await target.click({ timeout: 5000 });
          return { ok: true, usedLabel: candidate.label };
        }
      } catch {
        // try the next candidate
      }
    }
    await page.waitForTimeout(250);
  }
  return { ok: false, usedLabel: null };
}

async function bannerGone(page: Page, timeoutMs = 8000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const box = document.querySelector('#cmpbox') as HTMLElement | null;
        if (!box) return true;
        const style = window.getComputedStyle(box);
        return style.display === 'none' || style.visibility === 'hidden' || box.offsetParent === null;
      },
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

export const consentmanagerAdapter: ConsentAdapter = {
  id: 'consentmanager-net-tcf2',
  description:
    'Consentmanager.net CMP (TCF v2). Accept is one click on layer 1; reject requires opening "Instellingen"/"Settings" first.',

  async detectBanner(page: Page, timeoutMs: number): Promise<BannerDetection> {
    // Semantic first, structural fallback.
    const semantic = page.getByRole('link', { name: ACCEPT_TEXT })
      .or(page.getByRole('button', { name: ACCEPT_TEXT }));
    try {
      await semantic.first().waitFor({ state: 'visible', timeout: timeoutMs });
      return { detected: true, detector: 'role+text:accept-all' };
    } catch {
      // fall through
    }
    try {
      await page.locator(BOX).first().waitFor({ state: 'visible', timeout: 2000 });
      return { detected: true, detector: 'selector:#cmpbox' };
    } catch {
      return { detected: false, detector: null };
    }
  },

  async accept(page: Page): Promise<ConsentActionResult> {
    const steps: string[] = [];
    const notes: string[] = [];
    const result = await clickFirstVisible(
      page,
      [
        { label: 'role=link[name~=accept all]', locator: page.getByRole('link', { name: ACCEPT_TEXT }) },
        { label: 'role=button[name~=accept all]', locator: page.getByRole('button', { name: ACCEPT_TEXT }) },
        { label: 'css:.cmpboxbtnyes', locator: page.locator(CLS.accept) },
      ],
      12000,
    );
    if (!result.ok) {
      return { ok: false, steps, notes: ['Accept control not found or not clickable.'], bannerDismissed: null };
    }
    steps.push(`click accept-all via ${result.usedLabel}`);
    const dismissed = await bannerGone(page);
    if (!dismissed) notes.push('Consent banner still visible after clicking accept.');
    return { ok: true, steps, notes, bannerDismissed: dismissed };
  },

  async reject(page: Page): Promise<ConsentActionResult> {
    const steps: string[] = [];
    const notes: string[] = [];

    // Some CMP configurations do expose a first-layer reject; try it first so the
    // adapter keeps working if the site changes its configuration.
    const directReject = await clickFirstVisible(
      page,
      [
        { label: 'role=link[name~=reject all]', locator: page.getByRole('link', { name: REJECT_TEXT }) },
        { label: 'role=button[name~=reject all]', locator: page.getByRole('button', { name: REJECT_TEXT }) },
      ],
      2500,
    );
    if (directReject.ok) {
      steps.push(`click reject-all on first layer via ${directReject.usedLabel}`);
      notes.push('A reject control was available on the first consent layer.');
      const dismissed = await bannerGone(page);
      if (!dismissed) notes.push('Consent banner still visible after clicking reject.');
      return { ok: true, steps, notes, bannerDismissed: dismissed };
    }

    notes.push('No reject control on the first consent layer; opened the settings layer.');
    const settings = await clickFirstVisible(
      page,
      [
        { label: 'role=link[name~=settings]', locator: page.getByRole('link', { name: SETTINGS_TEXT }) },
        { label: 'role=button[name~=settings]', locator: page.getByRole('button', { name: SETTINGS_TEXT }) },
        { label: 'css:.cmpboxbtncustom', locator: page.locator(CLS.settings) },
      ],
      10000,
    );
    if (!settings.ok) {
      return {
        ok: false,
        steps,
        notes: [...notes, 'Settings control not found; reject could not be performed.'],
        bannerDismissed: null,
      };
    }
    steps.push(`open settings layer via ${settings.usedLabel}`);
    await page.waitForTimeout(750);

    const reject = await clickFirstVisible(
      page,
      [
        { label: 'role=link[name~=reject all]', locator: page.getByRole('link', { name: REJECT_TEXT }) },
        { label: 'role=button[name~=reject all]', locator: page.getByRole('button', { name: REJECT_TEXT }) },
        { label: 'css:.cmpboxbtnreject', locator: page.locator(CLS.reject) },
      ],
      10000,
    );
    if (!reject.ok) {
      return {
        ok: false,
        steps,
        notes: [...notes, 'Reject control not found on the settings layer.'],
        bannerDismissed: null,
      };
    }
    steps.push(`click reject-all on settings layer via ${reject.usedLabel}`);
    const dismissed = await bannerGone(page);
    if (!dismissed) notes.push('Consent banner still visible after clicking reject.');
    return { ok: true, steps, notes, bannerDismissed: dismissed };
  },

  async probeState(page: Page): Promise<ConsentStateProbe> {
    // Read-only query of the CMP's own public TCF API. This does not change any
    // consent state; it is the same call any TCF vendor on the page makes.
    try {
      const raw = await withTimeout(page.evaluate<Record<string, any> | { __error: string }>(() => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ __error: 'tcf-timeout' }), 5000);
          try {
            const api = (window as any).__tcfapi;
            if (typeof api !== 'function') {
              clearTimeout(timer);
              resolve({ __error: 'no-__tcfapi' });
              return;
            }
            api('getTCData', 2, (data: any, success: boolean) => {
              clearTimeout(timer);
              if (!success || !data) {
                resolve({ __error: 'getTCData-failed' });
                return;
              }
              resolve({
                gdprApplies: data.gdprApplies ?? null,
                tcString: data.tcString ?? null,
                cmpId: data.cmpId ?? null,
                cmpStatus: data.cmpStatus ?? null,
                eventStatus: data.eventStatus ?? null,
                purposeConsents: data.purpose?.consents ?? {},
                purposeLegitimateInterests: data.purpose?.legitimateInterests ?? {},
                vendorConsents: data.vendor?.consents ?? {},
                vendorLegitimateInterests: data.vendor?.legitimateInterests ?? {},
                specialFeatureOptins: data.specialFeatureOptins ?? {},
              });
            });
          } catch (err) {
            clearTimeout(timer);
            resolve({ __error: `tcf-exception: ${String(err)}` });
          }
        });
      }), 10000, 'TCF consent state probe');

      if ((raw as any).__error) {
        return emptyProbe(`tcf-v2:getTCData`, (raw as any).__error);
      }
      const data = raw as Record<string, any>;
      const purposeConsents = data.purposeConsents ?? {};
      const vendorConsents = data.vendorConsents ?? {};
      const purposeTrue = Object.values(purposeConsents).filter(Boolean).length;
      const vendorTrue = Object.values(vendorConsents).filter(Boolean).length;
      const tcString: string | null = data.tcString ?? null;
      return {
        method: 'tcf-v2:getTCData',
        gdprApplies: data.gdprApplies ?? null,
        tcStringPresent: Boolean(tcString),
        tcStringSha256: tcString ? sha256(tcString) : null,
        purposeConsentsTrue: purposeTrue,
        purposeConsentsTotal: Object.keys(purposeConsents).length,
        vendorConsentsTrue: vendorTrue,
        vendorConsentsTotal: Object.keys(vendorConsents).length,
        raw: {
          cmpId: data.cmpId ?? null,
          cmpStatus: data.cmpStatus ?? null,
          eventStatus: data.eventStatus ?? null,
          specialFeatureOptinsTrue: Object.values(data.specialFeatureOptins ?? {}).filter(Boolean).length,
          legitimateInterestPurposesTrue: Object.values(data.purposeLegitimateInterests ?? {}).filter(Boolean).length,
          legitimateInterestVendorsTrue: Object.values(data.vendorLegitimateInterests ?? {}).filter(Boolean).length,
        },
        matchesRequestedCondition: null, // filled in by the runner, which knows the condition
        error: null,
      };
    } catch (err) {
      return emptyProbe('tcf-v2:getTCData', String(err));
    }
  },
};

function emptyProbe(method: string, error: string): ConsentStateProbe {
  return {
    method,
    gdprApplies: null,
    tcStringPresent: null,
    tcStringSha256: null,
    purposeConsentsTrue: null,
    purposeConsentsTotal: null,
    vendorConsentsTrue: null,
    vendorConsentsTotal: null,
    raw: null,
    matchesRequestedCondition: null,
    error,
  };
}
