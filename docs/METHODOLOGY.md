# Methodology

This document describes how the measurements in this repository are produced, in
enough detail for a school, a parent, a journalist, a privacy professional or a
technically competent third party to judge — and to repeat — the work.

It is written to be read on its own, without reading the source code. Where a
decision could reasonably have been made differently, the choice made here is
stated explicitly.

---

## 1. What this tool measures, and what it does not

The tool observes **what a browser does** while visiting a website under
controlled conditions:

* which network requests are made, to which hosts, and when;
* which cookies are set, which are stored, and which the browser blocks;
* what else is written to browser storage;
* which frames (including advertising frames) are loaded;
* what is visible on screen, and how much of the screen advertising occupies.

The tool does **not** measure:

* the purpose for which any party processes data;
* the legal basis relied on for that processing;
* whether consent was validly obtained in a legal sense;
* the contracts between the website operator and its advertising partners;
* where data is stored or to which countries it is transferred.

Those questions cannot be answered from a network capture. Any conclusion of
that kind must be drawn by a human being, with additional information, and this
tool deliberately does not draw it.

---

## 2. Experimental design

### 2.1 Unit of measurement: the run

A **run** is one browser session against one website under one consent
condition. Every run:

1. starts a **new browser process**;
2. creates a **new, empty browser context** inside it — no cookies, no local or
   session storage, no cache, no service workers, no consent state;
3. opens the website's entry URL;
4. behaves according to its consent condition;
5. records evidence continuously until the run ends;
6. closes the browser.

Nothing is shared between runs. Starting a new browser process per run — rather
than only a new context — is stricter than necessary, but it removes any
argument about state leaking between conditions.

### 2.2 The three consent conditions

| Condition | What the automation does |
|---|---|
| **A. No consent choice** | Opens the page and deliberately does not touch the consent dialog. Observes for a fixed period (default 15 s). |
| **B. Reject all** | Uses the site's own "reject all" control, then continues into an actual exercise and stays there (default 35 s). |
| **C. Accept all** | Uses the site's own "accept all" control, then follows the same exercise flow as B. |

Condition A deliberately stays on the entry page: its purpose is to show what
happens *before and without* a consent decision, which is the moment that
matters for the "prior consent" question.

### 2.3 Repetition

Programmatic advertising is auctioned per impression. Two page loads a minute
apart legitimately produce different third parties and different numbers of
requests. Each site/condition combination is therefore repeated (default 3
times) and results are reported as **median with the min–max range**, plus the
individual run values. Third-party domains are reported with a **presence
count**: "seen in 2 of 3 runs".

A single run is never presented as definitive.

### 2.4 Fixed environment

Unless deliberately changed, every run uses:

* viewport 1365 × 768 CSS pixels, device scale factor 1;
* locale `nl-NL`, timezone `Europe/Amsterdam` (these sites serve Dutch children,
  and both the consent dialog language and the advertising can depend on them);
* the Playwright-bundled Chromium, unless `AUDIT_BROWSER_CHANNEL=chrome` is set
  and Google Chrome Stable is actually available.

The exact browser name and version, the Playwright and Node versions, the
operating system, whether the run happened inside Docker, and the source-code
commit are recorded in every run file and printed on the report cover page. If
Google Chrome Stable was requested but not available, the tool falls back to
Chromium and records that fallback: the report never claims Chrome was used when
it was not.

---

## 3. Consent handling

### 3.1 Site-specific adapters, not scattered clicks

Everything site-specific lives in one place (`src/sites/definitions.ts` and the
consent adapters in `src/sites/consent/`). An adapter knows how to detect the
consent banner, how to accept, how to reject, and how to read back the resulting
state.

Selectors are chosen semantically where possible — the accessible role of the
control plus its visible text ("Alles accepteren", "Accept All", "Instellingen",
"Alles weigeren") — with a structural CSS selector only as a fallback. This
survives redesigns better than absolute CSS or XPath paths, and it also means
the automation clicks what a human would click.

The four audited sites (spellingoefenen.nl, sommenoefenen.nl, taaloefenen.nl,
redactiesommen.nl) are operated by Oefenwereld and share a single
Consentmanager.net CMP configuration, so they share one adapter.

**An observation about that dialog, recorded by the adapter itself:** at the
time of writing, the first layer of the consent dialog offers only "Instellingen"
("Settings") and "Alles accepteren" ("Accept All"). There is no reject control on
the first layer; rejecting requires opening the settings layer first. Every
reject run records the two-step path it had to take.

### 3.2 The tool never bypasses a consent mechanism

The automation only performs the clicks a visitor could perform. It does not
call CMP APIs to set consent, does not write consent cookies directly, does not
block or modify any script, and does not use an ad blocker. The only API call it
makes is a **read-only** query (`__tcfapi('getTCData', 2, …)`) — the same query
every advertising vendor on the page makes — to find out what the consent state
became.

### 3.3 A run is never labelled with a choice it did not make

Each run records:

* whether a consent banner was detected at all, and how it was detected;
* which controls were clicked, in order;
* whether the banner disappeared afterwards;
* what the CMP itself reports about the resulting consent state.

From this the run gets one of five consent statuses:

| Status | Meaning |
|---|---|
| `confirmed` | The action was performed **and** the resulting state read back from the CMP matches the requested condition. |
| `performed` | The action was performed, but the resulting state could not be confirmed. |
| `no_banner` | No consent banner was found, so the requested action could not be performed. |
| `failed` | The action was attempted and failed (control not found, click failed). |
| `not_attempted` | Condition A: no interaction, by design. |

Only `confirmed` and `performed` runs count as evidence for their condition.
`failed` and `no_banner` runs are kept, shown in the dashboard and listed in the
report's "Measurement problems" section, but they are excluded from the
aggregated numbers. A rejection that did not happen is never reported as a
rejection with zero effect.

For "reject all", confirmation means the CMP reports **no** purpose consents and
**no** vendor consents. For "accept all", it means essentially all purposes are
consented.

---

## 4. Reaching a real exercise

The interesting behaviour of these sites is on the exercise pages, not only on
the homepage, so conditions B and C continue into an actual learning activity.

Each site definition contains a short, declarative route: navigate to a fixed
page, click one fixed control, verify arrival with a selector or a URL pattern.
Routes are deliberately minimal and deterministic — a fixed group, a fixed
exercise, no randomisation. The automation does **not** attempt to solve the
exercises; it only needs the normal page to be on screen.

How far each route gets differs per site, and the tool says so rather than
implying more than it did:

| Site | Route | How far it gets |
|---|---|---|
| spellingoefenen.nl | `/oefenen.html`, then inside the exercise frame: group 5 → word set "Alles" → Start | The spelling exercise itself is running. Verified by the chooser disappearing and the activity canvas becoming visible. |
| redactiesommen.nl | group 5 page → the fixed "Oefenen groep 5 - midden" exercise (the level and categories are encoded in the URL) | The word-problem exercise itself is running; the level is fixed by the URL. |
| sommenoefenen.nl | `/oefenen.html`, which embeds the arithmetic activity | The exercise page with the activity loaded, showing the activity's own selection screen. That screen is drawn inside a `<canvas>` element, so it offers nothing to click semantically; the audit does not click blindly at pixel coordinates. |
| taaloefenen.nl | `/woordenschat.html` → "oefenen" (fixed exercise id) | Same as above: the vocabulary activity is canvas-rendered, so the run stays on its selection screen. |

For the two canvas-rendered activities this makes no difference to the URL, the
page or its advertising slots — the same page is being measured — but it does
mean the measurement does not cover a session in which a child is actively
answering. That sentence is written into every affected run, into the dashboard
and into the report, so no reader has to guess.

Whether the exercise was actually reached is recorded per run
(`exercise.reached`: true / false / unknown), and verification can require an
element to be visible *and* another (such as a level chooser) to have
disappeared. A run that never reached the exercise is marked `partial` and is
visible as such.

---

## 5. What is recorded, and how

### 5.1 Network requests

Requests are captured through the **Chrome DevTools Protocol** rather than only
through the high-level automation API, because the high-level API does not
expose cookie blocking decisions. For every request the tool records: time
relative to the start of the run, URL, hostname, registrable domain, first- or
third-party, method, resource type, initiator, response status, the frame it
came from, the run phase, and whether it happened **before the consent action**.

In addition, a complete **HAR** capture is written for every run.

### 5.2 First party vs third party

A request is third party when its **registrable domain** (eTLD+1, computed with
the Public Suffix List) differs from that of the audited site. So
`js.spellingoefenen.nl` is first party for spellingoefenen.nl, and
`securepubads.g.doubleclick.net` is third party. When the comparison cannot be
made, the value is recorded as unknown rather than guessed.

### 5.3 Cookies

Three different things are recorded, and they are not the same:

1. **Cookies actually stored** — read from the browser at each checkpoint, with
   name, domain, path, expiry, lifetime, Secure, HttpOnly, SameSite, host-only
   status, value length and a SHA-256 hash of the value.
2. **Set-Cookie attempts** — every cookie a response tried to set, whether or
   not it was stored, together with the browser's reason when it was refused
   (for example third-party cookie phase-out, or SameSite rules).
3. **Cookies not sent with a request** — where the browser declined to attach a
   cookie for a policy reason.

For (3) the tool distinguishes *policy* blocking (the interesting case) from
*scope* mismatches — a cookie for another domain or path simply did not apply to
that request. Scope mismatches are recorded but not counted as "blocked",
because counting them would inflate the number with bookkeeping noise.

### 5.4 Other browser storage

At each checkpoint, for every frame the browser lets us read: localStorage and
sessionStorage (keys, value lengths, value hashes), IndexedDB database names,
Cache Storage keys, and the context's service workers. Cross-origin frames
cannot be read; that is recorded as "not readable" for that origin — never as
"empty".

### 5.5 Frames

Every frame and its origin is recorded, so an advertising frame on screen can be
correlated with the network activity that produced it. Cross-origin advertising
frames are **not** inspected internally; a screenshot of the rendered page is
treated as sufficient evidence of what was visible.

### 5.6 Visual advertising

Screenshots are taken at fixed checkpoints: first load, consent dialog visible,
immediately after the consent decision, exercise loaded, exercise + 10 s,
exercise + 30 s, and a full-page screenshot at the end. Video recording of the
whole session is optional.

Advertising surface is measured from two independent detectors, and each
detected slot records which detector found it:

* **container** — an element matching a known ad-slot container selector. For
  these four sites that is Refinery89's `r89-*` containers, plus generic Google
  Publisher Tag / AdSense containers. Site layout containers are deliberately
  *not* included, because counting them would overstate the advertising share.
* **iframe-ad-domain** — an iframe whose source domain is classified as
  advertising-related by the tracker dataset.

The visible advertising area is the **union** of the in-viewport slot
rectangles, so an ad iframe nested inside its slot container is not counted
twice. The result is reported as a share of the viewport.

Each detected slot is also captured as a small cropped image and hashed, which
is how "did the advertisement change during the exercise?" is answered: the
number of times a slot's rendered pixels changed between checkpoints.

Those crops are also what the report shows. A whole-viewport screenshot answers
"what did the page look like"; it answers "what was advertised" badly, because on
a printed page a 728x90 banner is a strip a few millimetres tall. The report
therefore presents the crops themselves, organised **per slot position** rather
than per picture, with every distinct image that slot produced across the audit.

Three mechanical rules decide what is shown. None of them is a judgement about
the picture:

* Boxes below roughly 120x40 px are dropped. They are close buttons and labels,
  not advertisements.
* Where nested elements describe one placement (site container -> Google
  container -> the advertisement's own iframe), the **innermost** box is used.
  That is the crop that frames the creative rather than the page around it.
  Note this is the opposite of `distinctVisibleSlots`, which keeps the outermost
  box because it counts placements rather than framing them.
* Crops that are byte-different but visually identical are collapsed, using a
  64-cell average hash of the image (`src/util/png.ts`). This is needed because
  a slot that was *not* filled still renders — it shows the page behind it — and
  the page animates by a pixel between checkpoints, producing a new SHA-256 every
  time. Without this step one unfilled slot appears as fifteen "different
  advertisements". The perceptual hash affects presentation only; no measured
  value depends on it.

The report deliberately does **not** try to decide which crops are advertisements
and which are an empty slot showing the page through it. No recorded signal
separates a slot that served the same advertisement all audit long from a slot
that was never filled, and guessing would put a claim in the report that the
evidence cannot carry. Instead each image is captioned with the slot, the
condition, the checkpoint and the run, and the section says in as many words that
an unfilled slot renders the page behind it.

---

## 6. Classification of third parties

Observation and classification are kept apart.

The observation is: *this domain was contacted, this many times, in this many
runs, before or after the consent action.* That stands on its own and does not
depend on anyone's tracker list.

The classification is a separate, attributed lookup:

* **DuckDuckGo Tracker Radar**, pinned to an exact upstream commit recorded in
  `data/trackers/tracker-radar.pin.json` and in every audit's metadata. Presence
  in that dataset is reported as *"known tracker according to
  duckduckgo-tracker-radar@\<commit\>"*. Tracker Radar also supplies the name of
  the company operating the domain.
* **`data/trackers/bundled-adtech-list.json`**, a hand-curated list maintained in
  this repository, used only for the narrower *advertising-related* label and
  always attributed to itself (*"advertising-related according to
  audit-adtech-list@1.0.0"*).

Wording used everywhere:

```
Third-party domain, unclassified
Known tracker according to <dataset@version>
Advertising-related according to <dataset@version>
Classification unavailable (no dataset installed)
```

A third-party domain is **not** described as a tracker merely because it is a
third party. If no dataset is installed, tracker and advertising counts are
reported as *not measured* — never as zero.

---

## 7. Failed and ambiguous measurements

The rule throughout the tool: **"could not measure" is never turned into `0`.**

Every run also has a hard time budget (navigation timeout + the configured
observation windows + several minutes of slack). A page that wedges — it does
happen, usually while an advertising frame is loading — is abandoned when the
budget expires: the evidence collected up to that point is kept, the run is
marked `failed` with a `run-watchdog` entry, and the audit moves on to the next
run instead of stalling. Individual calls that have no timeout of their own
(reading page storage, writing the trace, flushing the HAR file on close) are
bounded in the same way and report what could not be written.

Internally, a metric that was not measured is `null`, and the dashboard, the
report and the CSV export render it as *not measured*. This applies when:

* the page never loaded;
* the consent dialog was not found, or the reject/accept control had changed;
* navigation into the exercise failed;
* the browser crashed or a step timed out;
* a screenshot or a storage read failed;
* the tracker dataset was unavailable.

Run status is `completed`, `partial` or `failed`, and the reasons are listed on
the run page and summarised in the report's "Measurement problems" section. A
condition summary always shows *usable runs / total runs*.

---

## 8. Data minimisation inside the audit itself

An audit of privacy practices should not create a new privacy problem. So:

* No accounts are created and no log-in takes place.
* No real names, e-mail addresses or other personal data are entered anywhere.
* Advertisements are never clicked, and no attempt is made to influence an ad
  auction.
* **Cookie values are never stored.** Only their length and a SHA-256 hash are
  written to disk.
* Storage values are stored the same way; a short human-readable preview is kept
  only for values that are short, simple and do not look like identifiers.
* URL parameters that look like identifiers, and any unusually long parameter
  value, are replaced by `redacted.len<N>.sha256-<hash>` — the parameter name and
  the structure of the request survive, the identifier does not.
* Authorisation and cookie headers, POST bodies and response bodies are removed
  from the HAR.
* Hashes are stable within an export, so a repeated identifier can still be
  correlated across requests without the identifier itself being published.

---

## 9. Reproducing an audit

Everything needed is pinned: the Node dependencies (exact versions plus a
lockfile), the Playwright version, the Docker base image tag, and the tracker
classification dataset commit. Each audit records the commit of this software
that produced it.

```bash
git checkout <environment.gitCommit from the audit metadata>
npm run trackers:update          # installs the pinned classification dataset
docker compose up --build        # dashboard on http://localhost:3000
docker compose run --rm audit npm run audit -- all
```

If a long audit is interrupted, it can be continued without repeating the runs
it already has:

```bash
docker compose run --rm audit npm run audit -- all --resume <audit-id>
```

Results will not be *identical* — advertising is auctioned per impression, and
third parties change over time — but the method, the environment and the
analysis are fully specified, and the raw evidence of every earlier run is
preserved for comparison.

---

## 10. Known threats to validity

* **Automation may be detected.** Some advertising systems treat automated
  browsers differently. The browser is not disguised beyond disabling the most
  obvious automation flag; results may differ from an ordinary visit.
* **One vantage point.** All measurements come from one network location, one
  operating system and one browser build. Advertising is heavily
  geo-dependent.
* **Short sessions.** Runs last tens of seconds. Behaviour over a long session,
  or across repeat visits by the same child, is not captured.
* **No ad blocker, no browser extensions.** Real children may or may not have
  them.
* **Site changes.** These sites can change their consent dialog or their layout
  at any time. When they do, the adapter fails loudly and the run is recorded as
  failed — but until the adapter is updated, no measurement is possible.
* **The classification dataset has a cut-off date** and its own methodology; a
  domain missing from it is not evidence that the domain is harmless.
* **The exercise routes are minimal.** A child would click far more than this
  automation does, which may trigger further advertising behaviour that is not
  captured here.
