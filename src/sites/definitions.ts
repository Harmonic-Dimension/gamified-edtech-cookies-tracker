import type { SiteDefinition } from './types.js';
import { consentmanagerAdapter } from './consent/consentmanager.js';
import { fixtureConsentAdapter } from './consent/fixture.js';

/**
 * Site definitions.
 *
 * Everything site-specific lives here: the entry URL, the consent adapter and a
 * short declarative route into an actual exercise. Editing a selector after a
 * site redesign should require touching only this file (or the adapter it
 * refers to).
 *
 * All four production sites are operated by Oefenwereld and share one
 * Consentmanager.net CMP configuration (account 66181) and one advertising
 * integration (Refinery89, slot containers with class prefix "r89-").
 */

/**
 * Refinery89 injects its ad slots into containers whose class or id starts with
 * "r89-". The surrounding site layout containers (.leader_div and friends) are
 * deliberately NOT listed: they wrap the exercise itself, and counting them as
 * advertising would overstate the screen space taken by ads.
 */
const R89_SLOTS = [
  '[class*="r89-"]',
  '[id*="r89-"]',
];

export const SITE_DEFINITIONS: SiteDefinition[] = [
  {
    id: 'spellingoefenen',
    name: 'SpellingOefenen.nl',
    startUrl: 'https://www.spellingoefenen.nl/',
    firstPartyDomain: 'spellingoefenen.nl',
    operator: 'Oefenwereld',
    consent: consentmanagerAdapter,
    exercise: {
      description:
        'Homepage -> "oefenen" page -> inside the exercise iframe: group 5, "Alles", Start. ' +
        'The selection screen is ordinary HTML here, so a fixed group and a fixed word set can be chosen deterministically.',
      steps: [
        { kind: 'goto', url: 'https://www.spellingoefenen.nl/oefenen.html', note: 'practice landing page' },
        { kind: 'wait', ms: 4000 },
        {
          kind: 'click',
          description: 'choose group 5 in the exercise',
          frameSelector: 'iframe#game_3',
          selector: '#wl_groep_5',
        },
        { kind: 'wait', ms: 1500 },
        {
          kind: 'click',
          description: 'choose word set "Alles"',
          frameSelector: 'iframe#game_3',
          selector: '#wl_cat_3',
        },
        { kind: 'wait', ms: 1500 },
        {
          kind: 'click',
          description: 'start the exercise',
          frameSelector: 'iframe#game_3',
          role: 'link',
          textPattern: '^start$',
        },
        { kind: 'wait', ms: 3000 },
      ],
      verifySelector: 'iframe[src*="games/oefenen"], iframe#game_3',
      verifyFrame: {
        frameSelector: 'iframe#game_3',
        visibleSelector: 'canvas',
        hiddenSelector: '#wl_groep',
      },
    },
    adSlotSelectors: R89_SLOTS,
    notes: [
      'Practice activity is embedded in a same-origin iframe (games/oefenen/index.html).',
      'The site asks visitors to disable ad blockers; advertising is the stated funding model.',
    ],
  },
  {
    id: 'sommenoefenen',
    name: 'SommenOefenen.nl',
    startUrl: 'https://www.sommenoefenen.nl/',
    firstPartyDomain: 'sommenoefenen.nl',
    operator: 'Oefenwereld',
    consent: consentmanagerAdapter,
    exercise: {
      description:
        'Homepage -> "oefenen" page, which embeds the arithmetic activity. The activity draws its own ' +
        'selection screen inside a <canvas>, so the run stays on that page rather than clicking blindly at pixel coordinates.',
      steps: [
        { kind: 'goto', url: 'https://www.sommenoefenen.nl/oefenen.html', note: 'practice landing page' },
        { kind: 'wait', ms: 5000 },
      ],
      verifySelector: 'iframe[src*="games/oefenen"], iframe[id^="game_"]',
      verifyFrame: { frameSelector: 'iframe[id^="game_"]', visibleSelector: 'canvas#myCanvas' },
      limitation:
        'The exercise itself is rendered inside a canvas element, so its "what do you want to practise" screen ' +
        'cannot be operated with semantic selectors. This run therefore measures the exercise page with the ' +
        'activity loaded and its selection screen showing, not a session in which sums are being answered. ' +
        'The page, its URL and its advertising slots are the same either way.',
    },
    adSlotSelectors: R89_SLOTS,
    notes: [],
  },
  {
    id: 'taaloefenen',
    name: 'Taaloefenen.nl',
    startUrl: 'https://www.taaloefenen.nl/',
    firstPartyDomain: 'taaloefenen.nl',
    operator: 'Oefenwereld',
    consent: consentmanagerAdapter,
    exercise: {
      description: 'Homepage -> "woordenschat" -> "oefenen" (vocabulary exercise, thiskind=1).',
      steps: [
        { kind: 'goto', url: 'https://www.taaloefenen.nl/woordenschat.html', note: 'vocabulary landing page' },
        { kind: 'wait', ms: 1500 },
        { kind: 'click', description: 'open vocabulary exercise ("oefenen")', textPattern: '^\\s*oefenen\\s*$', role: 'link', optional: true },
        { kind: 'wait', ms: 3000 },
        { kind: 'expectUrl', pattern: 'oefenen\\.html', description: 'exercise page reached', timeoutMs: 10000 },
      ],
      verifySelector: 'iframe[src*="games/taaloefenen"], iframe[id^="game_"]',
      verifyFrame: { frameSelector: 'iframe[id^="game_"]', visibleSelector: 'canvas#myCanvas' },
      limitation:
        'The vocabulary activity is rendered inside a canvas element, so its own selection screen cannot be ' +
        'operated with semantic selectors. This run measures the exercise page with the activity loaded and its ' +
        'selection screen showing, not a session in which words are being answered.',
    },
    adSlotSelectors: R89_SLOTS,
    notes: [
      'The "oefenen" link on the vocabulary page carries a fixed exercise id (thiskind=1).',
    ],
  },
  {
    id: 'redactiesommen',
    name: 'Redactiesommen.nl',
    startUrl: 'https://www.redactiesommen.nl/',
    firstPartyDomain: 'redactiesommen.nl',
    operator: 'Oefenwereld',
    consent: consentmanagerAdapter,
    exercise: {
      description:
        'Homepage -> group 5 page -> fixed "Oefenen groep 5 - midden" exercise. ' +
        'The exercise selection is encoded in the URL, so if the link click is intercepted ' +
        '(advertising overlays sometimes cover it) the same exercise is opened by URL instead.',
      steps: [
        { kind: 'goto', url: 'https://www.redactiesommen.nl/groep5.html', note: 'group 5 overview' },
        { kind: 'wait', ms: 1500 },
        {
          kind: 'click',
          description: 'start fixed exercise "Oefenen groep 5 - midden"',
          textPattern: 'Oefenen groep 5 - midden',
          role: 'link',
          optional: true,
        },
        { kind: 'wait', ms: 2000 },
        {
          kind: 'gotoUnlessUrl',
          pattern: 'oefenen\\.php',
          url: 'https://www.redactiesommen.nl/oefenen.php?a=oefenen&niveau=5&cat_1=1&cat_2=1&cat_3=1&cat_4=1&cat_5=1&cat_6=1&cat_10=1&cat_11=1&cat_12=1',
          description: 'the group 5 "midden" exercise',
        },
        { kind: 'wait', ms: 3000 },
        { kind: 'expectUrl', pattern: 'oefenen\\.php', description: 'exercise page reached', timeoutMs: 10000 },
      ],
      verifySelector: 'iframe[src*="games/oefenen"], iframe#game_3',
      verifyFrame: { frameSelector: 'iframe#game_3', visibleSelector: 'canvas#myCanvas' },
    },
    adSlotSelectors: R89_SLOTS,
    notes: [
      'Exercise selection is encoded entirely in the URL (niveau + category flags), which makes the route deterministic: ' +
        'the activity starts on the chosen level without a selection screen.',
      'The exercise itself renders inside a same-origin iframe (games/oefenen/index.php).',
    ],
  },
];

/**
 * Local fixture site used by the automated tests. It is never part of a normal
 * audit run unless explicitly requested by id.
 */
export function fixtureSiteDefinition(baseUrl: string): SiteDefinition {
  return {
    id: 'fixture',
    name: 'Local test fixture site',
    startUrl: `${baseUrl}/`,
    firstPartyDomain: 'first-party.test',
    operator: 'local fixture',
    consent: fixtureConsentAdapter,
    exercise: {
      description: 'Homepage -> exercise page.',
      steps: [
        { kind: 'click', description: 'go to exercise', textPattern: 'Start de oefening', role: 'link' },
        { kind: 'wait', ms: 1000 },
        { kind: 'expectUrl', pattern: 'exercise', description: 'exercise page reached', timeoutMs: 5000 },
      ],
      verifySelector: '#exercise',
    },
    adSlotSelectors: ['[class*="r89-"]', '.ad-slot'],
    notes: ['Synthetic site used to test the audit engine without touching live educational sites.'],
  };
}

export function getSiteDefinition(id: string): SiteDefinition | undefined {
  return SITE_DEFINITIONS.find((s) => s.id === id);
}

export function allSiteIds(): string[] {
  return SITE_DEFINITIONS.map((s) => s.id);
}
