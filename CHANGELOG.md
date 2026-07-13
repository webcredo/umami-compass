# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-07-13

### Fixed

- Fail closed instead of weakening human-traffic exclusions or channel fan-out predicates when `filters.match="any"` would combine mandatory filters through upstream OR semantics.
- Fill missing time-series buckets by period, unit, and timezone before aligning current and comparison data, generate only real local-time buckets across DST, and omit aligned deltas when unequal bucket counts would shift comparisons.
- Keep release-impact traffic and Core Web Vitals in the same human-referrer scope, and exclude unfilterable performance evidence from channel-specific verdicts.
- Describe empty-referrer isolation separately from exact `direct` channel attribution, which can also depend on campaign parameters.
- Reject unsupported channel-by-event breakdowns instead of returning empty or meaningless rows.
- Apply field-specific structured-filter limits, aggregate condition/value caps, and a 16 KiB serialized-query budget.
- Reject malformed expanded-metric and derived-breakdown candidate rows instead of silently converting channel or spam evidence into zero/absent data.
- Report effective server capabilities from the enabled toolsets instead of advertising disabled insight and report features.

### Security

- Preserve mandatory exclusion and candidate predicates as fail-closed constraints rather than allowing an upstream OR group to widen the requested data scope.
- Bound structured-filter cardinality and serialized size before constructing an upstream request.

## [0.3.0] - 2026-07-13

### Added

- Add structured `equals`, `not_equals`, `contains`, `not_contains`, regex, and empty-value filter operators, including array-backed `IN` and `NOT IN` values.
- Add empty-referrer isolation for both `referrer: ""` and `referrer: { operator: "is_empty" }` without triggering Umami's external-referrer-only behavior; exact direct-channel attribution remains available through `filters.channel="direct"`.
- Add channel filters to traffic-change and release-impact analysis, plus bounded derived `channel × dimension` support in `run_breakdown_report` with explicit fan-out and truncation metadata.
- Add conservative referral-spam detection, evidence and thresholds, the opt-in `trafficSegment: "human"` preset, and a `referral_spam` tracking-health check.
- Add `compare_traffic_series` for aligned daily or finer-grained current/baseline buckets and `get_server_info` for local version, limits, toolsets, and feature discovery.

### Changed

- Include channel evidence in the default traffic-change and release-impact dimensions.
- Expand the default read-only profile from 12 to 14 tools and the full surface from 35 to 37 tools.
- Connect traffic explanations to referral-spam evidence instead of returning only a generic association caveat.

### Security

- Keep human-traffic cleanup read-only and fail closed when referral-spam assessment is unavailable for either comparison period.
- Bound derived channel cross-tabs to 50 candidate rows with four concurrent workers and expose incomplete candidate coverage instead of implying exhaustive results.

## [0.2.0] - 2026-07-13

### Added

- Add the aggregate `insights` toolset with `resolve_website`, `get_portfolio_overview`, `explain_traffic_change`, `analyze_release_impact`, and `tracking_health_check`.
- Add five guided workflows for weekly briefings, traffic investigations, release impact, tracking health, and conversion audits.
- Add the sanitized `umami://capabilities` resource for enabled toolsets, scope, authentication type, and safety limits.
- Add `UMAMI_TEAM_IDS` as a bounded team allowlist that applies to discovery and direct website/report access.

### Changed

- Return a common `meta` envelope with data status, empty reason, website, requested range, timezone, and truncation state where applicable.
- Enable the aggregate `core,insights` profile by default; row-level sessions, events, replay, and heatmaps remain opt-in.
- Expand the full read-only surface from 30 to 35 tools.
- Compare portfolio and tracking traffic against explicit equal-length baseline requests, omit uncertain top-N deltas, and require material Web Vital changes with sufficient samples before assigning a release-impact direction.
- Register guided prompts only when their required toolsets are enabled.

### Security

- Enforce the team allowlist centrally before direct website routes and typed report execution, including requests that already know a website UUID.
- Treat `UMAMI_TEAM_IDS` as a strict boundary: user-owned websites without an allowed team are excluded, and simultaneous team and website allowlists are intersected.
- Bound multi-website insight workflows to 50 websites and four concurrent website workers, while isolating safe per-site failures.

## [0.1.3] - 2026-07-13

### Fixed

- Discover websites through each visible team so member and view-only accounts no longer receive an empty `list_websites` result.
- Deduplicate direct and team discovery results before applying the requested page and optional website allowlist.

### Security

- Bound team traversal and upstream website pages, failing explicitly instead of returning a silently partial discovery result.

## [0.1.2] - 2026-07-13

### Changed

- Make documented stdio installs follow the stable npm channel with an explicit online freshness check.
- Publish and verify npm, MCP Registry metadata, and GitHub Releases from one retry-safe tag workflow.

## [0.1.1] - 2026-07-13

### Fixed

- Include team-owned websites in `list_websites` discovery and optional allowlist filtering.
- Parse Umami's paged segment/cohort response instead of rejecting it as an invalid array.
- Exclude page performance rows with missing percentiles, normalize their numeric fields, and rank valid rows by p75.
- Distinguish authorized empty replay and heatmap results from permission failures, including recorder and feature status where available.
- Normalize safe numeric SQL aggregates such as `views`, `visits`, and `totaltime` without coercing identifiers or arbitrary property values.

## [0.1.0] - 2026-07-13

### Added

- Initial Cloud and self-hosted Umami 3.2 MCP server.
- Thirty read-only tools across core, events, sessions, performance, analytical reports, revenue, replay metadata, and heatmaps.
- Core Web Vitals summaries and bounded page, title, device, and browser breakdowns.
- Saved reports, segments/cohorts, goals, funnels, journeys, retention, UTM, attribution, and multi-field breakdown reports.
- API-key, access-token, and lazy login authentication strategies.
- Website allowlist, HTTPS enforcement, bounded queries/responses, cancellation, timeout, generation-safe login refresh, and redacted errors.
- MCP resource, analytics prompt, structured tool output, and read-only annotations.
- Contributor documentation, client setup guides, API coverage research, CI, npm/MCP Registry metadata, and test suite.
- Product hero and a short Remotion explainer video; generator sources and caches remain local-only.
