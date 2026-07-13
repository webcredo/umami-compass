# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
