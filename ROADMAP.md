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
- Configurable route-template grouping such as `/casinos/:slug` to keep page-level comparisons statistically useful.
- Enriched RUM dimensions for country × device × page, navigation and connection type, cache status, edge region, and cold-versus-cached visits where upstream instrumentation exposes them safely.
- Session-scoped TTFB → FCP → LCP diagnostics with LCP element/resource attribution; this requires data beyond Umami's aggregate performance report.

## 0.5 — remote deployment profile

- Streamable HTTP only with MCP-compliant OAuth 2.1 resource-server behavior.
- Tenant isolation, rate limits, audit logs, deployment health checks, and observability without secrets.

## Future — management modules

- Separate package/module boundary for create, update, archive, share, and report management.
- Disabled by default with explicit scopes and operator opt-in.
- Human confirmation for destructive or externally visible changes.
- Dry-run or diff previews where the Umami API permits them.
- Idempotency, audit records, rollback guidance, and a dedicated security review.

The read-only profile remains available and the default even after management capabilities exist.
