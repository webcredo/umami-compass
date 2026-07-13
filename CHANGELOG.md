# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
