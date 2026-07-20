# Roadmap

The roadmap describes direction, not a compatibility promise. Proposals should be discussed in an issue before implementation.

## 0.1 — read-only foundation

- Validate core analytics, Web Vitals, analytical reports, saved reports/segments, revenue, replay metadata, and heatmaps against Umami Cloud and self-hosted 3.2 fixtures.
- Publish a signed/provenance-backed npm package and MCP Registry entry.
- Document client setup and least-privilege deployment.

## 0.2 — insight workflows

- Portfolio overview with comparison leaders, stale tracking, bounded anomalies, and isolated per-site failures.
- Evidence-based traffic-change and release-impact analysis with explicit correlation caveats.
- Tracking health checks across traffic freshness, domains, events, recorder configuration, and permissions.
- Website resolution, common result metadata, team allowlists, capability discovery, and guided prompts.

## 0.3 — traffic segmentation and quality

- Structured positive, negative, regex, and empty-value filter operators.
- Direct and channel isolation with bounded channel cross-tabs.
- Conservative referral-spam evidence and an opt-in human-traffic preset.
- Period-aligned traffic series comparison and local server capability discovery.

## 0.4 — deeper analysis

- Event and session property reports with bounded cardinality.
- Revenue chart/session reports.
- Expanded metrics, weekly sessions, and bounded replay detail.
- Saved replay metadata where public API stability permits.
- Capability discovery for differences between Cloud and self-hosted releases.
- Native performance dimensions for country × device × page without bounded Compass fan-out.
- Metric-specific and per-bucket Web Vital sample counts from upstream `count(metric)` queries.
- Navigation and connection type, cache status, edge region, and cold-versus-cached visits where upstream instrumentation exposes them safely.
- Session-scoped TTFB → FCP → LCP diagnostics with privacy-safe LCP element/resource attribution; this requires tracker, schema, and report changes beyond Umami's aggregate performance API.

The upstream contract needed for these items is detailed in [Umami 3.2 performance gaps and upstream contract proposal](docs/research/umami-performance-gaps-3.2.md).

## 0.5 — portfolio performance analysis

- Bounded portfolio-wide Core Web Vital comparison with confidence, approximate collection coverage, exclusions, isolated failures, and page/device drill-downs.
- Current-versus-previous and year-over-year Web Vital summaries plus truncation-safe aligned dimension comparisons.
- Derived two-dimensional performance breakdowns and direct regex-filtered route groups without averaging non-composable percentiles.
- Explicit performance-event count semantics, partial buckets, strict filter scope, empty-data normalization, and sanitized website discovery.
- A documented upstream contract for metric-specific counts, bot scope, native dimensions, and privacy-safe LCP attribution.

## 0.6 — remote deployment profile

- Streamable HTTP only with MCP-compliant OAuth 2.1 resource-server behavior.
- Tenant isolation, rate limits, audit logs, deployment health checks, and observability without secrets.

## Future — management modules

- Separate package/module boundary for create, update, archive, share, and report management.
- Disabled by default with explicit scopes and operator opt-in.
- Human confirmation for destructive or externally visible changes.
- Dry-run or diff previews where the Umami API permits them.
- Idempotency, audit records, rollback guidance, and a dedicated security review.

The read-only profile remains available and the default even after management capabilities exist.
