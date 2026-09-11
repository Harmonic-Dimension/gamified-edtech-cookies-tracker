import type { AuditSummary, ConditionSummary, MetricStats, SiteSummary } from './aggregate.js';
import type { RunResult } from '../types.js';
import { escapeHtml, formatDateTime } from './format.js';
import { checkpointLabel, collectCreatives, creativeDataUri } from './creatives.js';
import type { SiteCreatives } from './creatives.js';

/**
 * Publiekssamenvatting — a plain-Dutch summary of the technical report.
 *
 * Written for the audience that has to act on this work but will not read a
 * forty-page measurement report: parents, teachers, a school board, a works
 * council. It is a *summary*, not a second study. Every number in it is taken
 * from the same aggregation the technical report uses; nothing is recomputed,
 * rounded differently or softened.
 *
 * The same tone rules apply as in the technical report, and they matter more
 * here, because a lay reader cannot check them:
 *  - observation and interpretation stay in separate sections;
 *  - a value that could not be measured is written as "niet gemeten", never 0;
 *  - the classification dataset is named where a classification is used;
 *  - no legal conclusion is drawn, and the document says so in as many words;
 *  - the limitations section is not an appendix but a numbered part of the
 *    argument, because the risk with a lay audience is over-reading, not
 *    under-reading.
 */

export interface PublicSummaryOptions {
  summary: AuditSummary;
  runs: RunResult[];
  includeImages?: boolean;
  /** Advertising slots shown per website. */
  maxAdSlotsPerSite?: number;
}

const CSS = `
  @page { size: A4; margin: 20mm 18mm 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 23pt; margin: 0 0 3mm; line-height: 1.2; }
  h2 { font-size: 15pt; margin: 9mm 0 3mm; border-bottom: 2px solid #333; padding-bottom: 1.5mm; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  p { margin: 0 0 3.5mm; }
  ul, ol { margin: 0 0 3.5mm; padding-left: 6mm; }
  li { margin-bottom: 1.8mm; }
  .lead { font-size: 12.5pt; color: #333; }
  .subtitle { font-size: 12pt; color: #444; margin-bottom: 5mm; }
  .meta { font-size: 9.5pt; color: #555; }
  table { width: 100%; max-width: 100%; border-collapse: collapse; margin: 3mm 0 4mm; font-size: 9.5pt; table-layout: fixed; }
  th, td { border: 1px solid #ccc; padding: 2mm; text-align: left; vertical-align: top; }
  td { overflow-wrap: anywhere; hyphens: auto; }
  th { background: #eee; font-weight: 600; overflow-wrap: break-word; }
  td.num, th.num { text-align: right; }
  .na { color: #a33; font-style: italic; }
  .box { background: #f4f4ef; border-left: 4px solid #888; padding: 3.5mm 4.5mm; margin: 4mm 0; }
  .box h3 { margin-top: 0; }
  .warn-box { background: #fdf3e7; border-left: 4px solid #c07000; }
  .key-box { background: #eef3f8; border-left: 4px solid #3a6ea5; }
  .page-break { page-break-before: always; }
  figure.creative { margin: 0 0 4mm; page-break-inside: avoid; }
  .creative-img { display: block; border: 1px solid #999; width: 100%; }
  .shot-caption { font-size: 8.5pt; color: #444; margin-top: 1mm; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 9pt; overflow-wrap: anywhere; }
  .big { font-size: 15pt; font-weight: bold; }
`;

/** Dutch for "this could not be measured" — never rendered as a zero. */
const NIET_GEMETEN = '<span class="na">niet gemeten</span>';

function getal(stats: MetricStats | null | undefined, options: { percent?: boolean } = {}): string {
  if (!stats || stats.measuredRuns === 0 || stats.median == null) return NIET_GEMETEN;
  if (options.percent) return `${(stats.median * 100).toFixed(0)}%`;
  return Number.isInteger(stats.median) ? String(stats.median) : stats.median.toFixed(1);
}

/** The median with its spread, for readers who want to know how stable it is. */
function getalMetSpreiding(stats: MetricStats | null | undefined, options: { percent?: boolean } = {}): string {
  if (!stats || stats.measuredRuns === 0 || stats.median == null) return NIET_GEMETEN;
  const base = getal(stats, options);
  if (stats.min === stats.max) return base;
  const fmt = (value: number | null) =>
    value == null ? '–' : options.percent ? `${(value * 100).toFixed(0)}%` : String(value);
  return `${base} <span class="meta">(${fmt(stats.min)}–${fmt(stats.max)})</span>`;
}

function conditie(site: SiteSummary, name: 'no_choice' | 'reject_all' | 'accept_all'): ConditionSummary | undefined {
  return site.conditions.find((condition) => condition.condition === name);
}

function meervoud(count: number, enkel: string, meer: string): string {
  return count === 1 ? enkel : meer;
}

export function buildPublicSummaryHtml(options: PublicSummaryOptions): string {
  const { summary, runs } = options;
  const includeImages = options.includeImages ?? true;

  const creativesBySite = new Map<string, SiteCreatives>();
  if (includeImages) {
    for (const entry of collectCreatives(summary.audit.auditId, runs)) creativesBySite.set(entry.siteId, entry);
  }

  const sections = [
    voorpagina(summary),
    watIsDit(summary),
    inHetKort(summary),
    begrippen(),
    hoeGemeten(summary),
    deCijfers(summary),
    includeImages ? watKreegJeTeZien(summary, creativesBySite, options.maxAdSlotsPerSite ?? 3) : '',
    watBetekentDitNiet(summary),
    watKunJeDoen(),
    verantwoording(summary),
  ];

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><title>Publiekssamenvatting — reclame en volgtechnieken op oefenwebsites voor kinderen</title>
<style>${CSS}</style></head>
<body>
${sections.filter(Boolean).join('\n')}
</body></html>`;
}

function voorpagina(summary: AuditSummary): string {
  const namen = summary.sites.map((site) => site.siteName);
  return `
<h1>Wat gebeurt er op de achtergrond van oefenwebsites voor kinderen?</h1>
<p class="subtitle">Publiekssamenvatting van een technisch meetrapport — geschreven voor ouders, leerkrachten en schoolbesturen</p>
<p class="lead">
  ${namen.length} ${meervoud(namen.length, 'website waar kinderen', 'websites waar kinderen')} oefenen met taal en rekenen
  (${namen.map((naam) => escapeHtml(naam)).join(', ')}) ${meervoud(namen.length, 'is', 'zijn')} technisch onderzocht.
  Gemeten is wat de browser doet terwijl een kind aan het oefenen is: welke andere bedrijven contact krijgen,
  wat er op het apparaat wordt opgeslagen, en welke advertenties er in beeld komen.
</p>
<div class="box warn-box">
  <h3>Lees dit eerst</h3>
  <p style="margin-bottom:0">
    Dit document beschrijft <strong>metingen</strong>, geen oordeel. Er staat in wat er technisch gebeurde. Er staat
    <strong>niet</strong> in of dat mag of niet mag: dat is een juridische vraag die met deze metingen niet te
    beantwoorden is. Het hoofdstuk "Wat betekent dit níet" hoort er net zo goed bij als de cijfers.
  </p>
</div>`;
}

function watIsDit(summary: AuditSummary): string {
  return `
<h2>Waar gaat dit over?</h2>
<p>
  Veel gratis oefenwebsites voor het basisonderwijs verdienen geld met advertenties. Om advertenties te kunnen
  verkopen wordt bij het openen van de pagina contact gelegd met andere bedrijven: advertentiebeurzen, meetbedrijven
  en partijen die profielen opbouwen. Dat gebeurt in een fractie van een seconde en is voor een kind — en meestal ook
  voor een volwassene — onzichtbaar.
</p>
<p>
  Dit onderzoek maakt dat zichtbaar. Een computer heeft de websites geopend zoals een kind dat zou doen, is naar een
  echte oefening gegaan, en heeft alles opgeschreven wat de browser ondertussen deed. Dat is
  ${summary.totalRuns} keer herhaald${summary.failedRuns ? `, waarvan ${summary.failedRuns} ${meervoud(summary.failedRuns, 'meting mislukte', 'metingen mislukten')}` : ''},
  omdat advertenties elke keer anders zijn.
</p>`;
}

/**
 * The headline findings, assembled from the same aggregates as the technical
 * report. Everything here is a description of a measurement; the wording stays
 * away from motive ("om je te volgen") and from judgement ("te veel").
 */
function inHetKort(summary: AuditSummary): string {
  const punten: string[] = [];

  for (const site of summary.sites) {
    const weiger = conditie(site, 'reject_all');
    const accept = conditie(site, 'accept_all');
    const geenKeuze = conditie(site, 'no_choice');
    const regels: string[] = [];

    const weigerDomeinen = weiger?.metrics.uniqueThirdPartyDomains;
    const weigerTrackers = weiger?.metrics.knownTrackerDomains;
    if (weigerDomeinen && weigerDomeinen.measuredRuns > 0) {
      regels.push(
        `Na op <strong>"alles weigeren"</strong> te klikken kreeg de browser nog steeds contact met ` +
          `<strong>${getal(weigerDomeinen)}</strong> andere partijen` +
          (weigerTrackers && weigerTrackers.measuredRuns > 0
            ? `, waarvan er <strong>${getal(weigerTrackers)}</strong> in de gebruikte dataset als volg- of advertentiepartij staan.`
            : '.'),
      );
    }
    const weigerCookies = weiger?.metrics.storedCookies;
    const acceptCookies = accept?.metrics.storedCookies;
    if (weigerCookies?.measuredRuns && acceptCookies?.measuredRuns) {
      regels.push(
        `Na "alles weigeren" stonden er <strong>${getal(weigerCookies)}</strong> cookies op het apparaat; ` +
          `na "alles accepteren" <strong>${getal(acceptCookies)}</strong>.`,
      );
    }
    const geenKeuzeDomeinen = geenKeuze?.metrics.uniqueThirdPartyDomains;
    if (geenKeuzeDomeinen && geenKeuzeDomeinen.measuredRuns > 0) {
      regels.push(
        `Wie de cookiemelding gewoon laat staan en niets kiest: ook dan werd er contact gelegd met ` +
          `<strong>${getal(geenKeuzeDomeinen)}</strong> andere partijen.`,
      );
    }
    const reclame = accept?.metrics.maxVisibleAdAreaFraction;
    if (reclame && reclame.measuredRuns > 0 && (reclame.median ?? 0) > 0) {
      regels.push(
        `Op het drukste moment was <strong>${getal(reclame, { percent: true })}</strong> van het scherm advertentieruimte.`,
      );
    }

    if (regels.length) {
      punten.push(`<h3>${escapeHtml(site.siteName)}</h3><ul>${regels.map((regel) => `<li>${regel}</li>`).join('')}</ul>`);
    }
  }

  if (!punten.length) {
    return `<h2>In het kort</h2><p>Er zijn geen bruikbare metingen, dus er valt niets samen te vatten.</p>`;
  }

  return `
<h2>In het kort</h2>
<p>
  De belangrijkste uitkomsten per website. Alle getallen zijn de middelste waarde (mediaan) van de herhaalde
  metingen. "Andere partijen" betekent: andere bedrijven dan de website zelf, waarmee de browser contact legde.
</p>
${punten.join('')}
<div class="box key-box">
  <p style="margin-bottom:0">
    <strong>De rode draad:</strong> "alles weigeren" maakte in deze metingen wel degelijk verschil — er werden veel
    minder partijen benaderd en veel minder cookies opgeslagen dan na "alles accepteren" — maar het zette het
    contact met andere partijen niet stil. Wat die partijen vervolgens met de gegevens doen, is met deze metingen
    niet vast te stellen.
  </p>
</div>`;
}

function begrippen(): string {
  return `
<h2>Vijf begrippen, kort uitgelegd</h2>
<table>
  <colgroup><col style="width:26%"><col style="width:74%"></colgroup>
  <tr><th>Cookie</th><td>Een klein bestandje dat een website op het apparaat zet. Sommige zijn nodig om de site te laten werken (bijvoorbeeld onthouden waar je gebleven bent). Andere dienen om bezoekers te herkennen en te volgen.</td></tr>
  <tr><th>Derde partij</th><td>Een ander bedrijf dan de website die je bezoekt. Een oefenwebsite kan bij het laden tientallen andere bedrijven aanroepen, meestal voor advertenties.</td></tr>
  <tr><th>Tracker</th><td>Een techniek waarmee een bedrijf bezoekers over verschillende websites heen kan herkennen. Of iets een tracker is, is hier bepaald aan de hand van een openbare lijst — zie "Verantwoording".</td></tr>
  <tr><th>Cookiemelding</th><td>Het venster met "accepteren" en "instellingen". Bij de onderzochte sites zit "alles weigeren" niet in het eerste venster, maar een laag dieper, achter "instellingen".</td></tr>
  <tr><th>Advertentieveiling</th><td>Zodra de pagina opent, wordt in milliseconden geboden op de advertentieruimte. Daarvoor wordt informatie over de bezoeker rondgestuurd. Dit gebeurt automatisch en is niet zichtbaar.</td></tr>
</table>`;
}

function hoeGemeten(summary: AuditSummary): string {
  const config = summary.audit.config;
  return `
<h2>Hoe is het gemeten?</h2>
<p>
  Elke meting begint met een <em>volledig schone browser</em>: geen cookies, geen geschiedenis, geen eerdere keuze.
  Daarna wordt de website geopend en gebeurt er één van drie dingen:
</p>
<table>
  <colgroup><col style="width:30%"><col style="width:70%"></colgroup>
  <tr><th>A. Niets kiezen</th><td>De cookiemelding blijft staan, er wordt niet op geklikt. Zo kijken we wat er gebeurt vóór en zonder toestemming.</td></tr>
  <tr><th>B. Alles weigeren</th><td>Er wordt doorgeklikt naar "instellingen" en daar alles geweigerd. Daarna wordt er ongeveer ${Math.round(config.observeExerciseMs / 1000)} seconden echt geoefend.</td></tr>
  <tr><th>C. Alles accepteren</th><td>Er wordt op "alles accepteren" geklikt en daarna dezelfde oefening gedaan.</td></tr>
</table>
<p>
  Elke combinatie is ${summary.audit.repetitions} keer herhaald, omdat advertenties per keer verschillen. Er is
  <strong>niet</strong> ingelogd, er zijn <strong>geen</strong> persoonsgegevens ingevuld en er is <strong>niet</strong>
  op advertenties geklikt. De inhoud van cookies is nergens bewaard — alleen dát ze er waren.
</p>
${
  summary.audit.repetitions < 2
    ? '<p><strong>Let op:</strong> bij deze meting is elke situatie maar één keer uitgevoerd. De getallen zijn dan losse waarnemingen en geen stabiel gemiddelde.</p>'
    : ''
}`;
}

function deCijfers(summary: AuditSummary): string {
  const rijen: string[] = [];
  for (const site of summary.sites) {
    for (const [naam, key] of [
      ['A. Niets gekozen', 'no_choice'],
      ['B. Alles geweigerd', 'reject_all'],
      ['C. Alles geaccepteerd', 'accept_all'],
    ] as const) {
      const conditionSummary = conditie(site, key);
      if (!conditionSummary) continue;
      rijen.push(`<tr>
        <td>${escapeHtml(site.siteName)}</td>
        <td>${escapeHtml(naam)}</td>
        <td class="num">${getalMetSpreiding(conditionSummary.metrics.uniqueThirdPartyDomains)}</td>
        <td class="num">${getalMetSpreiding(conditionSummary.metrics.knownTrackerDomains)}</td>
        <td class="num">${getalMetSpreiding(conditionSummary.metrics.storedCookies)}</td>
        <td class="num">${getalMetSpreiding(conditionSummary.metrics.maxVisibleAdAreaFraction, { percent: true })}</td>
      </tr>`);
    }
  }

  return `
<h2 class="page-break">De cijfers op een rij</h2>
<p>
  Middelste waarde van de herhaalde metingen, met tussen haakjes de laagste en hoogste waarde. Waar
  "${'niet gemeten'}" staat, kon de waarde niet worden vastgesteld — dat betekent <em>niet</em> nul.
</p>
<table>
  <colgroup><col style="width:22%"><col style="width:20%"><col style="width:15%"><col style="width:15%"><col style="width:14%"><col style="width:14%"></colgroup>
  <thead><tr>
    <th>Website</th><th>Situatie</th>
    <th class="num">Andere partijen</th>
    <th class="num">Waarvan volg- of advertentiepartij</th>
    <th class="num">Cookies op het apparaat</th>
    <th class="num">Deel van het scherm met reclame</th>
  </tr></thead>
  <tbody>${rijen.join('')}</tbody>
</table>
<p class="meta">
  "Volg- of advertentiepartij" is de indeling van ${escapeHtml(summary.audit.trackerDataset.name)}, een openbare lijst
  van derden. Dat een domein op die lijst staat, is de inschatting van die lijst — geen juridisch oordeel. Dat er
  contact met een partij is, betekent op zichzelf ook niet dat er gegevens over het kind zijn gedeeld.
</p>`;
}

/**
 * The advertisements themselves. For a lay reader this is the part that makes
 * the abstraction concrete, so it gets the same evidence treatment as in the
 * technical report — including the caveat that these are the advertisements
 * served on one occasion, not a claim about any advertiser.
 */
function watKreegJeTeZien(
  summary: AuditSummary,
  creativesBySite: Map<string, SiteCreatives>,
  maxSlots: number,
): string {
  const blokken: string[] = [];

  for (const site of summary.sites) {
    const creatives = creativesBySite.get(site.siteId);
    if (!creatives?.placements.length) continue;

    // The technical report shows every advertising slot, including the ones that
    // stayed empty, because an audit has to account for all of them. A summary
    // for a lay reader does not: a picture of the website labelled
    // "advertentieruimte" only confuses. So only slots that demonstrably carried
    // changing content, or that are an advertisement's own frame, are shown here
    // — and where a slot showed several things, two of them are shown, so the
    // reader sees the variation rather than one picture presented as the truth.
    const teTonen = creatives.placements
      .filter((placement) => placement.framesAdItself || placement.renderings.length > 1)
      .slice(0, maxSlots);

    const figuren: string[] = [];
    for (const placement of teTonen) {
      for (const rendering of placement.renderings.slice(0, placement.framesAdItself ? 1 : 2)) {
      const dataUri = creativeDataUri(rendering.file);
      if (!dataUri) continue;
      const situaties = rendering.conditions
        .map((condition) => ({ no_choice: 'niets gekozen', reject_all: 'alles geweigerd', accept_all: 'alles geaccepteerd' })[condition])
        .join(' en ');
      const momenten = [...new Set(rendering.sightings.map((sighting) => sighting.checkpoint))]
        .map((checkpoint) => NEDERLANDSE_MOMENTEN[checkpoint] ?? checkpointLabel(checkpoint))
        .join('; ');
      const share = placement.viewportWidth > 0 ? (placement.width / placement.viewportWidth) * 100 : 100;
      figuren.push(`<figure class="creative" style="width:${Math.round(Math.min(100, Math.max(50, share)))}%">
        <img class="creative-img" src="${dataUri}" alt="Advertentieruimte van ${placement.width} bij ${placement.height} pixels op ${escapeHtml(site.siteName)}">
        <figcaption class="shot-caption">
          ${escapeHtml(site.siteName)} · ${placement.width} × ${placement.height} pixels · situatie: ${escapeHtml(situaties)} · ${escapeHtml(momenten)}
        </figcaption>
      </figure>`);
      }
    }

    if (figuren.length) {
      blokken.push(`<h3>${escapeHtml(site.siteName)}</h3>${figuren.join('')}`);
    }
  }

  if (!blokken.length) return '';

  return `
<h2 class="page-break">Wat kreeg een kind te zien?</h2>
<p>
  Hieronder staan uitsneden van de advertentieruimtes zelf, zoals ze tijdens de metingen in beeld kwamen. Ze zijn
  bijgesneden op de advertentieruimte, zodat te zien is wat er werkelijk stond.
</p>
<div class="box warn-box">
  <p style="margin-bottom:0">
    <strong>Belangrijk:</strong> advertenties worden per keer opnieuw gekozen. Dit zijn de advertenties die déze
    browser op dát moment kreeg. Een ander kind, op een ander moment, ziet iets anders. Dit is dus geen uitspraak
    over een adverteerder, en ook geen bewering dat elk kind dit te zien krijgt. Was een advertentieruimte op dat
    moment leeg, dan zie je de website erdoorheen in plaats van een advertentie.
  </p>
</div>
${blokken.join('')}
<p class="meta">
  In het technische rapport staat van elke afbeelding bij welke meting, op welk moment en in welke situatie hij is
  vastgelegd, samen met alle andere advertenties die in dezelfde ruimte zijn waargenomen.
</p>`;
}

const NEDERLANDSE_MOMENTEN: Record<string, string> = {
  '01-first-load': 'meteen na het openen van de pagina',
  '02-consent-dialog': 'terwijl de cookiemelding in beeld stond',
  '03-post-consent': 'vlak na de cookiekeuze',
  '04-exercise-0s': 'zodra de oefening geladen was',
  '05-exercise-10s': '10 seconden bezig met de oefening',
  '06-exercise-30s': '30 seconden bezig met de oefening',
};

function watBetekentDitNiet(summary: AuditSummary): string {
  return `
<h2>Wat betekent dit níet?</h2>
<p>
  Dit is het belangrijkste hoofdstuk van deze samenvatting. Metingen als deze worden gemakkelijk sterker gelezen
  dan ze zijn.
</p>
<ol>
  <li><strong>Dit zegt niet dat er iets illegaals gebeurt.</strong> Of dit mag, hangt af van zaken die je in een
      meting niet kunt zien: met welk doel gegevens worden verwerkt, op welke juridische grondslag, en hoe de
      toestemming precies is ingericht. Daar doet dit onderzoek geen uitspraak over.</li>
  <li><strong>Contact met een andere partij is niet hetzelfde als volgen.</strong> Een deel van die verbindingen is
      gewoon nodig: lettertypen, video's, het afleveren van plaatjes.</li>
  <li><strong>Een tracker-lijst is een inschatting, geen vonnis.</strong> De indeling komt van
      ${escapeHtml(summary.audit.trackerDataset.name)} en weerspiegelt de werkwijze en peildatum van die lijst.</li>
  <li><strong>Het aantal cookies zegt op zichzelf weinig.</strong> Wat telt is waarvoor ze dienen en hoe lang ze
      blijven staan — niet hoeveel het er zijn.</li>
  <li><strong>Deze metingen komen uit één situatie.</strong> Eén land, één netwerk, één apparaat, één moment,
      zonder adblocker. Elders kan het er anders uitzien.</li>
  <li><strong>Een computer is geen kind.</strong> Sommige advertentiesystemen behandelen geautomatiseerde browsers
      anders. Bij een echt, langer kinderbezoek kan het beeld verschillen.</li>
  <li><strong>Mislukte metingen zijn geen nul.</strong> Waar iets niet gemeten kon worden, staat dat er — het
      betekent niet dat er niets gebeurde.</li>
</ol>`;
}

function watKunJeDoen(): string {
  return `
<h2>Wat kun je hiermee?</h2>
<p>Deze samenvatting is bedoeld om een gesprek mogelijk te maken, niet om het te beëindigen. Bruikbare vragen:</p>
<h3>Aan de makers van de website</h3>
<ul>
  <li>Welke andere partijen ontvangen gegevens van bezoekers, en met welk doel?</li>
  <li>Op welke juridische grondslag gebeurt dat, en hoe is dat geregeld met die partijen?</li>
  <li>Wat gebeurt er technisch precies wanneer een bezoeker "alles weigeren" kiest?</li>
  <li>Is er rekening mee gehouden dat de bezoekers grotendeels kinderen zijn?</li>
  <li>Waarom staat "alles weigeren" niet in het eerste venster van de cookiemelding?</li>
</ul>
<h3>Binnen de school</h3>
<ul>
  <li>Welke websites raden we leerlingen aan, en weten we wat daar gebeurt?</li>
  <li>Is er een advertentievrij of betaald alternatief voor de sites die we gebruiken?</li>
  <li>Wat spreken we af over gebruik thuis, waar de school geen zicht op heeft?</li>
  <li>Wie kijkt hiernaar — de ICT-coördinator, de functionaris gegevensbescherming, het bestuur?</li>
</ul>`;
}

function verantwoording(summary: AuditSummary): string {
  const audit = summary.audit;
  return `
<h2>Verantwoording</h2>
<table>
  <colgroup><col style="width:34%"><col style="width:66%"></colgroup>
  <tr><th>Onderzochte websites</th><td>${summary.sites.map((site) => escapeHtml(site.siteName)).join(', ')}</td></tr>
  <tr><th>Periode van meten</th><td>${formatDateTime(audit.startedAt)} — ${formatDateTime(audit.finishedAt)}</td></tr>
  <tr><th>Aantal metingen</th><td>${summary.totalRuns} in totaal, ${audit.repetitions} per situatie per website${summary.failedRuns ? `; ${summary.failedRuns} mislukt en niet meegeteld` : ''}</td></tr>
  <tr><th>Browser en scherm</th><td>${audit.browser ? escapeHtml(`${audit.browser.engine} ${audit.browser.version}`) : 'niet vastgelegd'}, ${audit.config.viewport.width} × ${audit.config.viewport.height} pixels</td></tr>
  <tr><th>Taal en tijdzone</th><td>${escapeHtml(audit.environment.locale)} / ${escapeHtml(audit.environment.timezone)}</td></tr>
  <tr><th>Lijst voor indeling</th><td>${escapeHtml(audit.trackerDataset.name)} (${escapeHtml(audit.trackerDataset.version)})</td></tr>
  <tr><th>Kenmerk van dit onderzoek</th><td><code>${escapeHtml(audit.auditId)}</code></td></tr>
  <tr><th>Opgesteld op</th><td>${formatDateTime(summary.generatedAt)}</td></tr>
</table>
<p>
  Deze samenvatting hoort bij een uitgebreid technisch rapport. Daarin staat elke meting afzonderlijk, met alle
  aangeroepen domeinen, cookies, mislukte metingen en beperkingen. Daarnaast is er een bestand met het complete
  ruwe bewijsmateriaal: de netwerkopnames, de schermafbeeldingen en de gestructureerde meetgegevens. Daarmee kan
  iemand met technische kennis elk getal in dit document zelf controleren.
</p>
<p class="meta">
  Alle getallen in deze samenvatting komen rechtstreeks uit dezelfde berekening als het technische rapport; er is
  niets apart afgerond of vereenvoudigd. Waar deze samenvatting en het technische rapport elkaar zouden tegenspreken,
  geldt het technische rapport.
</p>`;
}
