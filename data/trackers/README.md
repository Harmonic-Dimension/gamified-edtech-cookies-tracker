# Classification datasets

Two separate sources, kept apart so that every classification in the dashboard
and in the report can name where it came from.

## `tracker-radar-domains.json` — DuckDuckGo Tracker Radar (derived)

A compact derivative of `build-data/generated/domain_map.json` from
[duckduckgo/tracker-radar](https://github.com/duckduckgo/tracker-radar), pinned
to the exact commit recorded in `tracker-radar.pin.json`. For each registrable
domain it keeps only the owning company and the prevalence value.

The file records the upstream commit, the source URL and the SHA-256 of the
original download, and those values are copied into every audit's metadata.

Regenerate (or move to a newer pinned commit — edit `tracker-radar.pin.json`
first) with:

```bash
npm run trackers:update
```

It is checked in so that a fresh clone can classify domains without network
access. Tracker Radar is published by DuckDuckGo under **CC BY-NC-SA 4.0**; that
licence travels with this derived file. Attribution to DuckDuckGo Tracker Radar,
with the pinned commit, is printed wherever the classification is used.

If the dataset is missing, the tool still runs: tracker and advertising counts
are then reported as *not measured*, never as zero.

## `bundled-adtech-list.json` — in-repo curated list

A hand-curated list of advertising, ad-technology, identity-sync, analytics,
social-advertising, consent-management and push-messaging domains, maintained in
this repository with its own version number. It is used only for the narrower
**advertising-related** label, and every statement derived from it is attributed
to `audit-adtech-list@<version>`.

It is explicitly *not* an authoritative industry dataset. It exists so that
"advertising-related" has an inspectable source that a reader can check by
opening one JSON file. When you add domains, bump the `version` field so audits
remain traceable to the exact list that produced them.
