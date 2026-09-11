# Privacy, cookie, tracker and advertising audit of educational practice websites

A small, transparent research tool that runs controlled browser experiments
against educational websites used by primary-school children, and preserves
enough raw evidence that another technically competent person can check the
results independently.

It was built for four Dutch practice sites used in primary education:

* https://www.spellingoefenen.nl/
* https://www.sommenoefenen.nl/
* https://www.taaloefenen.nl/
* https://www.redactiesommen.nl/

but adding another site is a small, documented change.

> **What this is, and what it is not.** The tool records what a browser does:
> which requests are made, which cookies are set and blocked, what is stored,
> and what a child sees on screen. It does not assess lawfulness, and it does not
> claim that any observation is a violation of any rule. Objective observations
> and interpretation are kept in separate sections everywhere — in the
> dashboard, in the report and in the export. See
> [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).
> The tool was built by running the prompt ['ONE_SHOT_PROMPT.md'](ONE_SHOT_PROMPT.md) 
> in Claude Code (Opus 5 High). I have not reviewed the code personally.
> Use at your own risk.

---

## Quick start

```bash
docker compose up --build
```

Then open <http://localhost:3000>.

From the dashboard you can start an audit, watch it run, compare "reject all"
against "accept all", look at the screenshots, download the raw evidence and
generate the PDF report.

To run the full experiment from the command line:

```bash
docker compose run --rm audit npm run audit -- all
```

That performs 4 sites × 3 consent conditions × 3 repetitions = 36 runs, which
takes roughly an hour. Individual slices are cheaper:

```bash
docker compose run --rm audit npm run audit -- spellingoefenen reject
docker compose run --rm audit npm run audit -- taaloefenen accept --repeat 5
docker compose run --rm audit npm run audit -- all no_choice --repeat 1
```

If a long audit is interrupted (a laptop sleeping, Docker restarting), resume it
rather than starting over — the runs already recorded are skipped and the new
ones are added to the same audit:

```bash
docker compose run --rm audit npm run audit -- all --resume <audit-id>
```

Results appear in `./data/audits/` on the host and in the dashboard.

Evidence is bulky: a full 36-run audit writes roughly 0.5–1 GB, most of it
Playwright traces (~20 MB per run). Set `AUDIT_RECORD_TRACE=false` if you only
need the HAR files and screenshots, and delete old audit directories when you no
longer need them — each one is self-contained.

### Without Docker

```bash
npm ci
npx playwright install chromium
npm run trackers:update      # optional but recommended: pinned tracker dataset
npm run serve                # dashboard on http://localhost:3000
npm run audit -- all         # or a slice, as above
```

---

## What gets measured

Per run (one website, one consent condition, one repetition):

| Evidence | Detail |
|---|---|
| Network requests | time, URL, host, registrable domain, first/third party, method, resource type, initiator, status, frame, run phase, before/after the consent action |
| Cookie set attempts | every `Set-Cookie`, whether it was stored, and the browser's reason when it was refused |
| Cookies stored | name, domain, path, expiry, lifetime, Secure, HttpOnly, SameSite, host-only, value length, SHA-256 of the value |
| Cookie sends | cookies the browser refused to attach to a request for a policy reason |
| Browser storage | localStorage, sessionStorage, IndexedDB databases, Cache Storage keys, service workers |
| Frames | every frame and its origin, so ad frames can be matched to network activity |
| Visual advertising | screenshots at fixed checkpoints, ad-slot geometry, share of the viewport occupied, and how often the creative changed |
| Raw artifacts | Playwright trace, HAR, screenshots, optional video |

Cookie values, storage values, authorisation headers and identifier-like URL
parameters are hashed or redacted before anything is written to disk. The audit
does not create a new privacy problem of its own.

### The three consent conditions

| | Behaviour |
|---|---|
| **A. No consent choice** | Open the page, do not touch the consent dialog, observe for a fixed period |
| **B. Reject all** | Use the site's own "reject all", then continue into a real exercise and stay there |
| **C. Accept all** | Use the site's own "accept all", then the same exercise flow |

Each run starts a **new browser process** with a **new empty context**: no
cookies, no storage, no cache, no service workers, no consent state from any
earlier run.

---

## Architecture

```
src/
  types.ts                 the data model (a metric is null when it was not measured)
  config.ts                all knobs, all overridable by environment variable
  sites/
    definitions.ts         one entry per audited website: URL, consent adapter, exercise route
    types.ts               SiteDefinition / ConsentAdapter contracts
    consent/
      consentmanager.ts    adapter for the Consentmanager.net CMP used by all four sites
      fixture.ts           adapter for the local test fixture
  audit/
    runner.ts              one run: fresh context -> consent -> exercise -> evidence
    audit.ts               the site x condition x repetition matrix
    browser.ts             browser launch and genuinely fresh contexts
    network.ts             CDP-based request/cookie capture, including blocked cookies
    storage.ts             cookie and browser-storage checkpoints
    adslots.ts             visible advertising geometry and creative-change detection
    metrics.ts             per-run summary numbers
  trackers/dataset.ts      pinned classification datasets, with explicit attribution
  store/store.ts           filesystem result store (plain JSON per run)
  report/
    aggregate.ts           min / median / max, domain presence, reject-vs-accept
    html.ts                the shareable technical report
    creatives.ts           per-slot ad crops, grouped and de-duplicated for the report
    summary-nl.ts          plain-Dutch public summary, from the same aggregation
    pdf.ts                 renders both reports to PDF
    format.ts              shared rendering of "not measured", badges, stats
  util/png.ts              minimal PNG reader + average hash, to spot look-alike crops
  export/zip.ts            self-describing raw evidence bundle
  server/                  dashboard (Express, server-rendered HTML, no build step)
  cli/audit.ts             command line entry point
fixtures/site/server.ts    synthetic website used by the tests
docs/METHODOLOGY.md        how the measurement works, written for non-developers
data/
  trackers/                pinned classification datasets
  audits/<audit-id>/       results (git-ignored)
```

Results are stored as plain files, not in a database, so a reviewer can inspect
the raw evidence with a file browser and a text editor:

```
data/audits/<audit-id>/
  audit.json
  runs/<run-id>/
    run.json
    network.har
    trace.zip
    video.webm            (if enabled)
    screenshots/*.png
```

---

## The dashboard

| Page | What it shows |
|---|---|
| `/` | The four websites, when they were last audited, how many runs, which browser; starting an audit; the classification dataset in use |
| `/audits/<id>` | The comparison table across all sites and conditions |
| `/audits/<id>/sites/<site>` | Per-site detail: results by condition, variability across runs, third-party domains with classification and presence counts, cookie and storage activity, per-run table |
| `/runs/<audit>/<run>` | One run: metadata, consent bookkeeping, timeline, screenshots, ad slots, cookies, storage, frames, requests, artifacts, warnings |
| `/audits/<id>/gallery` | The visual ad gallery, laid out for showing to parents or a school board |
| `/audits/<id>/report.html` / `report.pdf` | The shareable technical report |
| `/audits/<id>/samenvatting.html` / `samenvatting.pdf` | The plain-Dutch public summary |
| `/audits/<id>/export.zip` | The raw evidence bundle |
| `/methodology` | `docs/METHODOLOGY.md` |

---

## Interactive mode

Sometimes you need to see the ads yourself and poke at the page, while still
keeping the audit trail.

```bash
npm run audit:interactive -- spellingoefenen reject
```

The browser opens visibly, starts from a fresh context, performs the requested
consent action, navigates into the exercise and then **waits for you**. Network,
cookie, storage and screenshot recording continue the whole time. Press Enter in
the terminal (or use "Finish run" in the dashboard) to end the session and save
the evidence.

Inside Docker the visible browser runs on a virtual display that is published
over noVNC:

1. start the stack (`docker compose up --build`);
2. start an interactive run from the dashboard, or with
   `docker compose exec audit npm run audit:interactive -- spellingoefenen reject`;
3. open <http://localhost:6080/vnc.html> to watch and drive the browser;
4. finish the run from the dashboard's run page.

Interactive runs are limited to `AUDIT_INTERACTIVE_MAX_MS` (default 15 minutes)
so a forgotten window cannot hold a browser open forever.

---

## The reports

Two documents are generated from the same aggregation, for two different readers.

### The technical report

```bash
npm run report -- <audit-id>
# or the "Download PDF report" button in the dashboard
```

Contents: cover page with audit date and exact software/browser versions;
method; comparison tables across all four sites; per-site results with
reject-vs-accept comparison, major third-party domains and their classification,
cookie and storage observations; **what each advertising slot displayed**, as
crops of the slots themselves; a "measurement problems" section; important
limitations; and a restrained observations section that describes what was
measured without asserting legal conclusions.

The advertising section is built from the per-slot crops the audit already
records. It is organised per slot position and shows every distinct image that
slot produced, so the report never has to assert that a particular picture is an
advertisement — an unfilled slot renders the page behind it, and the section says
so. See METHODOLOGY §5.6 for the three selection rules and why the report
declines to classify the images.

### The Dutch public summary

```bash
npm run report -- <audit-id> --nl        # both documents
npm run report -- <audit-id> --only-nl   # just the summary
# or the "Download publiekssamenvatting (NL)" button in the dashboard
```

A plain-Dutch summary for the people who have to act on this work but will not
read a forty-page measurement report: parents, teachers, a school board. It has
the headline numbers, a five-term glossary, a selection of the advertisements,
and a "Wat betekent dit níet" chapter that is part of the argument rather than an
appendix — with a lay audience the risk is over-reading, not under-reading.

Every number comes from the same aggregation as the technical report, so the two
cannot drift apart; where they would conflict, the summary says the technical
report governs. The same tone rules are enforced by tests: no legal conclusion,
"niet gemeten" never rendered as 0, and the classification dataset named wherever
a classification is used.

---

## Result schema

The authoritative definition is `src/types.ts`. The essentials:

* `RunResult.metrics.*` — a number, or `null` meaning **not measured**. Never
  read `null` as zero.
* `RunResult.consent.status` — `confirmed` | `performed` | `no_banner` |
  `failed` | `not_attempted`. Only `confirmed` and `performed` runs are
  aggregated into a condition's results.
* `RunResult.status` — `completed` | `partial` | `failed`.
* `RequestRecord.isThirdParty` — computed against the registrable domain
  (eTLD+1) of the audited site; `null` when it cannot be determined.
* `StoredCookie.valueSha256` / `valueLength` — raw cookie values are never
  stored.
* `AdSlotObservation.visibleAdAreaFraction` — union of in-viewport ad-slot
  rectangles divided by the viewport area.

The ZIP export contains its own README describing the same layout, so the bundle
stays self-describing when handed to a third party.

---

## Configuration

Every setting has a default and an environment variable.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Dashboard port |
| `AUDIT_REPETITIONS` | `3` | Runs per site and condition |
| `AUDIT_CONDITIONS` | all three | e.g. `reject_all,accept_all` |
| `AUDIT_VIEWPORT_WIDTH` / `_HEIGHT` | `1365` / `768` | Viewport |
| `AUDIT_LOCALE` | `nl-NL` | Browser locale |
| `AUDIT_TIMEZONE` | `Europe/Amsterdam` | Browser timezone |
| `AUDIT_OBSERVE_HOMEPAGE_MS` | `15000` | Condition A observation time |
| `AUDIT_OBSERVE_EXERCISE_MS` | `35000` | Time spent on the exercise page |
| `AUDIT_HEADLESS` | `true` | Headless browser |
| `AUDIT_BROWSER_CHANNEL` | unset | Set to `chrome` to use Google Chrome Stable when installed |
| `AUDIT_RECORD_TRACE` / `_HAR` / `_VIDEO` | `true` / `true` / `false` | Artifacts |
| `AUDIT_NAVIGATE_TO_EXERCISE` | `true` | Continue into the exercise after consent |
| `AUDIT_POLITENESS_DELAY_MS` | `2000` | Pause between runs |
| `AUDIT_INTERACTIVE_MAX_MS` | `900000` | Interactive session limit |
| — | derived | Each run also has a hard watchdog budget (navigation timeout + observation windows + 4 min slack). A wedged page is abandoned, recorded as a failed run, and the audit continues. |
| `AUDIT_DATA_DIR` / `AUDIT_RESULTS_DIR` / `AUDIT_TRACKER_DIR` | `./data/...` | Storage locations |
| `AUDIT_GIT_COMMIT` | from `git` | Recorded source revision (used inside Docker, where `.git` is absent) |

### Google Chrome Stable vs Chromium

By default the tool uses the **Playwright-bundled Chromium** and records exactly
that, in the run metadata and on the report cover page. Google Chrome Stable
inside the Docker image would mean shipping a browser from a third-party apt
repository and pinning it separately, which is disproportionate here — so the
image uses Chromium and says so.

If you want Chrome Stable, install it and ask for it explicitly:

```bash
npx playwright install chrome
AUDIT_BROWSER_CHANNEL=chrome npm run audit -- all
```

If Chrome is requested but cannot be launched, the tool falls back to Chromium
**and records the fallback as a run warning**. The report never claims Chrome
was used when it was not.

---

## Adding another website

1. Add an entry to `SITE_DEFINITIONS` in `src/sites/definitions.ts`:

```ts
{
  id: 'example',
  name: 'Example.nl',
  startUrl: 'https://www.example.nl/',
  firstPartyDomain: 'example.nl',
  operator: 'Example BV',
  consent: consentmanagerAdapter,        // or a new adapter, see below
  exercise: {
    description: 'Homepage -> practice page -> start exercise',
    steps: [
      { kind: 'goto', url: 'https://www.example.nl/oefenen' },
      { kind: 'wait', ms: 2000 },
      { kind: 'click', description: 'start', role: 'link', textPattern: '^start', optional: true },
      { kind: 'expectUrl', pattern: 'oefenen', description: 'exercise reached' },
    ],
    verifySelector: '#exercise',
  },
  adSlotSelectors: ['[class*="r89-"]'],
  notes: [],
}
```

   Steps may target a control inside a same-origin exercise iframe
   (`frameSelector`), verification may require an element inside that frame to be
   visible and another (a level chooser, say) to have disappeared
   (`verifyFrame`), and `limitation` records in plain language anything the route
   cannot establish — it is copied into every run, the dashboard and the report.

2. If the site uses a different consent platform, add an adapter in
   `src/sites/consent/` implementing `ConsentAdapter`: `detectBanner`,
   `accept`, `reject` and `probeState`. Prefer role + visible text over CSS
   selectors, and make `probeState` an honest read-back — return an error rather
   than a guess when the state cannot be determined.

3. Run one slice and check the run page before trusting the numbers:

```bash
npm run audit -- example reject --repeat 1
```

## Updating consent selectors after a site redesign

When a site changes its dialog, reject/accept runs start failing with
`consent-action` errors and show up as **failed** in the dashboard — they do not
silently become "zero trackers". Fix the adapter (usually one text pattern or
one class in `src/sites/consent/consentmanager.ts`), then re-run one slice to
confirm `consent.status` is `confirmed` again.

## Updating the tracker dataset

The dataset is pinned to an exact upstream commit in
`data/trackers/tracker-radar.pin.json`, and the derived lookup file is checked
in so a fresh clone can classify domains without network access. Tracker Radar
is published by DuckDuckGo under CC BY-NC-SA 4.0; see
[`data/trackers/README.md`](data/trackers/README.md) for provenance and terms.

To move to a newer version, edit the `commit` field and run:

```bash
npm run trackers:update
```

The version, the source URL and the SHA-256 of the downloaded file are recorded
in every audit that uses it. The narrower "advertising-related" label comes from
`data/trackers/bundled-adtech-list.json`, a hand-curated list in this repository
with its own version number; edit and bump it when you add domains.

---

## Tests

```bash
npm test          # unit tests + engine test against the local fixture site
npm run typecheck

# or inside the container, with the same browser build the audits use:
docker compose run --rm audit npm test
```

The suite covers clean-context creation, first/third-party classification,
cookie and URL sanitisation, consent-state bookkeeping, failed-run handling,
tracker classification, report aggregation, PDF generation and the ZIP export.

The engine test runs the real audit engine against a **local fixture website**
(`fixtures/site/server.ts`) that behaves like the real thing — consent banner,
first-party cookie, third-party resources, a simulated tracker that sets a
blocked third-party cookie, a delayed request, an ad iframe and different
behaviour after accept and reject. No live educational site is contacted by the
test suite.

---

## Known limitations

* **Chromium, not Chrome Stable, by default** (see above).
* Measurements come from one network location, one OS and one browser build.
  Advertising is strongly geo- and time-dependent.
* Automated browsers may be treated differently by some ad systems.
* Sessions are short (tens of seconds) and the automation does not solve the
  exercises; a real child's session may trigger more behaviour.
* On sommenoefenen.nl and taaloefenen.nl the learning activity is drawn inside a
  `<canvas>`, which offers nothing to click semantically. Those runs measure the
  exercise page with the activity loaded and its own selection screen showing.
  Each such run states this in its notes rather than implying it got further.
* Cross-origin advertising frames are never inspected internally — only their
  rendered pixels and their network activity are evidence.
* Ad-slot detection is selector-based and therefore site-specific; a redesign
  can make it miss slots. The detector that found each slot is recorded so this
  can be checked.
* The tracker dataset has a cut-off date and its own methodology; absence from
  it is not evidence that a domain is harmless.
* There is no authentication and no multi-user support, by design: this runs
  locally.

## Scope and conduct

The tool observes normal page behaviour. It does not log in, does not submit
personal data, does not click advertisements, does not simulate ad clicks, does
not attempt to influence ad auctions, and does not bypass consent mechanisms or
ad-technology protections. Requests are spaced by a politeness delay.

## License

MIT — see [LICENSE](LICENSE). You may use, modify and redistribute this,
including commercially, as long as the copyright notice and licence text stay
with it. The software is provided "as is", with no warranty and no liability
on the part of the authors, and nothing in it constitutes legal advice or a
finding of unlawfulness.
