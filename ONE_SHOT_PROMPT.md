Build a complete, runnable, Dockerized web application for performing reproducible privacy, cookie, tracker, advertising, and visual-content audits of educational websites used by primary-school children.
The immediate targets are:

* https://www.spellingoefenen.nl/
* https://www.sommenoefenen.nl/
* https://www.taaloefenen.nl/
* https://www.redactiesommen.nl/

The application should be designed as a small, transparent research tool that can produce evidence suitable for discussion with parents, teachers, and a school board. It is not intended to automatically make legal claims. It should clearly separate objective observations from interpretation.
Primary goal
I want to be able to run controlled browser experiments against these websites and answer questions such as:

* What network activity occurs before the user makes a consent choice?
* What happens after explicitly choosing “Reject all” / “Alles weigeren”?
* What happens after accepting all cookies?
* Which cookies are actually stored?
* Which cookies are attempted but blocked by the browser?
* Which third-party domains receive requests?
* Which known advertising/tracking domains are contacted?
* What browser storage is used besides cookies?
* What advertisements are visibly shown to the user?
* How much screen space is occupied by advertising?
* Do advertisements change or rotate during an exercise?
* What changes between reject and accept conditions?

The entire experiment should be reproducible and should preserve enough raw evidence that another technically competent person can independently inspect the results.
1. Technical shape
Build this as a Dockerized application.
A reasonable stack would be:

* Node.js / TypeScript
* Playwright
* Google Chrome Stable if available, otherwise Playwright Chromium with the browser identity clearly recorded
* Small local backend/API if useful
* Lightweight web dashboard
* SQLite or filesystem-based result storage
* HTML-to-PDF generation for reports

Prefer simple dependencies and transparent implementation over a complicated architecture.
The finished project must run with something close to:

```bash
docker compose up --build

```

and expose a local dashboard, for example:

```text
http://localhost:3000

```

If Chrome Stable inside Docker creates disproportionate complexity, use Playwright Chromium in Docker and document this clearly. Do not silently claim Chrome was used when it was not.
2. Audit conditions
For every website support at least these three conditions:
A. No consent choice

1. Start with a completely fresh browser context.
2. Open the target URL.
3. Do not interact with the consent dialog.
4. Observe for a fixed period.
5. Record all evidence.

B. Reject all

1. Start with a completely fresh browser context.
2. Open the target URL.
3. Explicitly choose the site's equivalent of “Reject all” / “Alles weigeren”.
4. Continue to an actual exercise where feasible.
5. Remain on the exercise long enough to allow advertisements and delayed trackers to load.
6. Record all evidence.

C. Accept all
Same process, but explicitly accept all consent options.
Every run must start in a genuinely isolated Playwright BrowserContext with:

* no cookies
* no local storage
* no session storage
* no cache inherited from earlier runs
* no service workers inherited from earlier runs
* no prior consent state

Do not reuse browser state between conditions.
3. Repeatability
Default to at least 3 runs per:

* website
* consent condition

Make the number configurable.
Record for each run:

* run UUID
* site
* target URL
* consent condition
* date/time
* timezone
* OS/container environment
* Playwright version
* Node version
* browser engine
* exact browser version
* viewport
* locale
* user agent
* screen/device scale where relevant
* experiment configuration
* source-code git commit if available

Use fixed defaults unless deliberately configured otherwise.
Suggested default desktop viewport:

```text
1365 x 768

```

Optionally support a second representative laptop/tablet viewport later, but do not let that complicate the MVP.
4. Browser/network evidence
Capture at minimum:
Requests
Every network request including:

* timestamp relative to page start
* URL
* hostname
* registrable domain / eTLD+1 where possible
* first-party vs third-party
* HTTP method
* resource type
* initiator/frame if available
* response status
* whether it happened before or after consent choice

Responses
Capture useful response metadata, particularly:

* Set-Cookie headers or equivalent cookie-set events
* blocked cookie information where Chromium DevTools Protocol exposes it
* reason a cookie was blocked, where available

Use Chrome DevTools Protocol directly when Playwright's ordinary APIs do not expose enough information.
Cookies actually stored
At relevant checkpoints, record all cookies in the browser context with:

* name
* domain
* path
* expiry
* Secure
* HttpOnly
* SameSite
* host-only/domain cookie status if available
* value length
* SHA-256 of value

DO NOT store raw cookie values in exported/public reports.
If raw values are temporarily necessary internally, sanitize them before persistence.
Browser storage
Inspect at least:

* localStorage
* sessionStorage
* IndexedDB presence/databases where practical
* service workers
* cache storage if practical

Do not over-engineer exotic fingerprinting detection in the first version.
5. HAR and trace evidence
For every audit run preserve:

* Playwright trace
* HAR or equivalent complete network capture
* screenshots
* structured JSON/CSV results

Make these raw artifacts accessible from the dashboard for technical inspection.
Avoid storing secrets or unique identifiers unsanitized in artifacts intended for sharing.
Implement a sanitization layer for:

* cookie values
* query parameters likely to contain user/session identifiers
* Authorization headers
* other obviously sensitive tokens

Preserve enough structural information to make the network evidence useful.
6. Visual advertising evidence
This is an important part of the project.
The system should capture what a child would actually see.
For each run take screenshots at useful fixed points, for example:

1. first page load
2. consent dialog visible
3. immediately after consent decision
4. exercise page immediately after loading
5. exercise page after 10 seconds
6. exercise page after 30 seconds

If the site workflow makes these checkpoints inappropriate, adapt sensibly and document what happened.
Also support optional video recording of the complete browser session.
Record all frames/iframes and their URLs so advertising frames can be correlated with network activity.
Do not assume that a cross-origin iframe can be inspected internally. A screenshot of the rendered page is sufficient evidence of its visual contents.
7. Active / interactive mode
Add a mode where I can launch one audit in a visible browser and interact with it manually.
For example, from the dashboard:

```text
Run interactively

```

or via CLI:

```bash
npm run audit:interactive -- spellingoefenen reject

```

The browser should:

* launch visibly
* start from a fresh context
* record network evidence just like an automated run
* allow me to pause/interact manually
* continue recording screenshots/video/network evidence
* allow the run to be finalized and saved

The purpose is to let me see the exact ads being shown and manually investigate unusual behaviour while preserving the technical audit trail.
If fully headed Chrome inside the main Docker container is awkward, design a practical alternative and document it. For example:

* VNC/noVNC browser inside Docker, or
* Docker for the server/dashboard plus a local Playwright interactive runner

Choose the least fragile solution.
8. Consent handling
Consent automation is critical.
Create a configurable site definition for each audited site rather than hard-coding arbitrary clicks throughout the test runner.
For example:

```ts
interface SiteDefinition {
  id: string;
  name: string;
  startUrl: string;
  rejectConsent?: ...
  acceptConsent?: ...
  navigateToExercise?: ...
}

```

Use robust semantic selectors where possible:

* button text
* accessible role
* label

Avoid brittle absolute CSS/XPath selectors unless unavoidable.
The audit must explicitly record whether:

* a consent banner appeared
* the requested consent action was successfully executed
* the expected resulting consent state could be confirmed
* automation failed or was ambiguous

Never silently label a run “reject” if the rejection action was not actually confirmed.
9. Exercise workflow
Try to proceed beyond the homepage into an actual learning activity after the consent decision.
The exact workflow can differ by site.
Keep the automation minimal and deterministic:

* select a fixed group/level where needed
* select one fixed exercise
* start the exercise
* remain on screen long enough for advertising to load

Do not try to solve educational exercises unless needed to expose the normal page.
Make these flows easy to edit later.
10. Tracker classification
Keep objective observations distinct from tracker classification.
For every third-party hostname, report:

* hostname
* registrable domain
* number of requests
* number of cookies/set attempts
* before/after consent
* classification if known

Integrate a pinned version of an open tracker dataset such as DuckDuckGo Tracker Radar if practical.
Pin the classification dataset to an exact version or git commit.
Store:

* dataset name
* dataset version/commit
* company/operator if available
* tracker category if available

Do not automatically describe every third party as a tracker.
Use wording such as:

```text
Third-party domain
Known tracker according to <dataset/version>
Advertising-related according to <dataset/version>
Unclassified

```

The raw measurement must remain usable independently of this classification.
11. Dashboard
Build a clean research dashboard.
It does not need fancy visual design, but it should make the evidence understandable to non-developers.
Overview
Show:

* websites
* latest audit date
* audit status
* number of completed runs
* browser/version used

Comparison table
For each website and condition show metrics such as:

* total requests
* third-party requests
* unique third-party domains
* known tracker domains
* advertising domains
* stored cookies
* third-party stored cookies
* Set-Cookie attempts
* blocked cookie attempts
* localStorage entries
* consent success/failure
* visible ad slots if detectable

Make “Reject all” vs “Accept all” especially easy to compare.
Site detail page
For each website show:

* results by consent condition
* variability across repeated runs
* timeline around consent action
* third-party domains
* tracker classifications
* cookie activity
* storage activity
* screenshot gallery
* video if available
* raw evidence downloads

Individual run page
Show:

* metadata
* exact experiment timeline
* screenshots
* request table
* cookie table
* frame list
* storage data
* downloadable HAR
* downloadable trace
* logs
* warnings/failures

12. Visual ad gallery
Create a dedicated visual section suitable for showing parents or a school.
For each website show screenshots of the actual learning environment after:

* no consent choice
* rejection
* acceptance

Include:

* timestamp
* condition
* run ID
* viewport
* screenshot

Make it obvious that an individual screenshot proves only:
this advertisement was visible during this specific recorded run
and does not imply that all users always see that advertisement.
If practical, allow a user to manually draw/mark advertisement regions in a screenshot in the dashboard, but this is optional and should not delay the core product.
Do not attempt unreliable AI image classification unless clearly isolated as optional analysis.
13. PDF report
Add a “Download PDF report” function.
Generate a polished but restrained report suitable for sharing with:

* parents
* teachers
* school management
* a privacy officer / DPO

The report should contain:
Title
“Privacy and Advertising Audit of Educational Practice Websites”
Include audit date and software/browser versions.
Method
Concise explanation of:

* fresh browser contexts
* consent conditions
* repeat count
* browser/version
* observation times
* tracker classification methodology

Summary
One comparison table across all four sites.
Per-site results
Include:

* objective metrics
* reject vs accept comparison
* representative screenshots
* major third-party domains
* known advertising/tracking companies
* cookies/storage observations
* unusual findings

Important limitations
Explicitly state:

* network contact is not automatically unlawful tracking
* tracker-list membership is a third-party classification
* cookie count alone does not prove illegality
* screenshots capture ads served during specific runs
* ads may vary geographically and over time
* legal compliance requires purpose, legal basis, consent implementation, contractual context, and other information beyond the technical experiment

Interpretation
Keep interpretation restrained.
Prefer:
“After explicit rejection, the browser still contacted X third-party domains classified by dataset Y as advertising/tracking.”
Avoid:
“The website illegally tracked the user.”
Unless a human reviewer explicitly writes such a legal conclusion later.
14. Raw export
Allow downloading an audit dataset as ZIP containing:

```text
audit/
  metadata.json
  summary.json
  summary.csv
  runs/
    <run-id>/
      metadata.json
      cookies.json
      requests.csv
      requests.json
      storage.json
      frames.json
      screenshots/
      trace.zip
      network.har
      video.webm     # if enabled

```

Include a README in the export explaining the schema.
15. Reproducibility
This project should be unusually careful about reproducibility.
Pin:

* Node dependencies
* Playwright version
* Docker image
* tracker dataset version

Provide commands such as:

```bash
docker compose up --build
docker compose run audit npm run audit:all
docker compose run audit npm run audit -- spellingoefenen reject

```

or an equivalently clean interface.
Also expose the same actions from the dashboard.
A fresh checkout should be sufficient to reproduce the experiment.
16. Safety and privacy of the research data
The audit itself should not create a new privacy problem.
Therefore:

* do not publish raw unique cookie IDs
* hash cookie values
* redact authentication/session tokens
* sanitize URLs before report/export where appropriate
* do not use personal accounts
* do not submit real names/email addresses
* do not log into the websites
* do not intentionally click advertisements
* do not simulate ad clicks
* do not attempt to manipulate ad auctions

We only want to observe normal page behaviour.
17. Statistical presentation
Because programmatic advertising is variable, do not present a single run as definitive.
For repeated runs show:

* minimum
* median
* maximum
* individual run values where useful

For example:

```text
Third-party requests after Reject All:
run 1: 82
run 2: 91
run 3: 85
median: 85

```

For domain presence, distinguish:

* appeared in 1/3 runs
* appeared in 2/3 runs
* appeared in 3/3 runs

This is especially useful for rotating ad-tech providers.
18. Failure handling
The system must treat failed or ambiguous experiments as failed/ambiguous, not as valid zero results.
Examples:

* consent dialog not found
* reject button changed
* exercise navigation failed
* browser crashed
* timeout
* network unavailable
* screenshot failed
* tracker dataset unavailable

Surface these prominently in the dashboard and PDF.
Never turn “could not measure” into `0`.
19. Tests
Add automated tests for the research infrastructure itself.
At minimum test:

* clean context creation
* first-party vs third-party classification
* cookie sanitization
* URL sanitization
* consent-state bookkeeping
* report aggregation
* failed-run handling
* tracker classification
* PDF generation

Where possible add a tiny local fixture website that behaves like:

* consent banner
* first-party cookie
* third-party-like resource
* simulated tracker
* delayed resource
* reject/accept behaviour

Use this fixture to test the audit engine without depending on the live educational sites.
20. Documentation
Write a strong README covering:

* purpose
* architecture
* installation
* running with Docker
* launching audits
* interactive mode
* dashboard
* PDF generation
* result schema
* methodology
* known limitations
* adding another website
* updating consent selectors
* updating the tracker dataset

Also create:

```text
docs/METHODOLOGY.md

```

This should be written so that a school, parent, journalist, privacy professional, or technically competent third party can understand how the measurement was performed.
21. Scope discipline
Prioritize a functioning end-to-end research tool over elaborate UI.
The MVP is successful if I can:

1. clone the repository
2. run Docker Compose
3. open the dashboard
4. audit all four websites
5. run reject/no-choice/accept conditions
6. repeat each condition
7. inspect cookies and network activity
8. see actual screenshots of ads served during the runs
9. run a visible interactive session
10. compare reject vs accept
11. download raw evidence
12. generate a credible PDF report

Do not add authentication, cloud hosting, user management, or other SaaS features.
Everything should work locally.
22. Implementation approach
Before coding, inspect the four live sites enough to determine:

* their current consent interface
* robust reject/accept selectors
* a deterministic route into an exercise
* whether advertisements appear on homepage or only exercise pages
* any site-specific behaviour relevant to measurement

Then implement the site adapters accordingly.
Do not bypass consent mechanisms or ad-tech protections.
If a site changes or cannot be reliably automated, represent this transparently in the site adapter and result status.
Make reasonable implementation decisions independently rather than stopping for clarification.
At the end, provide:

1. the complete implementation
2. Docker configuration
3. tests
4. documentation
5. a brief architecture summary
6. exact commands to run the full audit
7. any known limitations