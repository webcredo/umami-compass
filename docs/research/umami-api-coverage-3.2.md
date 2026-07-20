# Umami 3.2 API coverage — July 2026

This matrix was checked against the tagged Umami [`v3.2.0`](https://github.com/umami-software/umami/releases/tag/v3.2.0) source, not only the older public API examples. It separates HTTP method from semantic access: several `/api/reports/*` routes use POST to calculate and return analytics without persisting state.

## Shipped read-only surface

| Area | Umami 3.2 routes represented | Compass tools / policy |
| --- | --- | --- |
| Websites and overview | websites, stats, pageviews, metrics, active, daterange | `core`, default; paging, dimensions, series, and date range bounded |
| Events | events list, stats, series | `events`, opt-in; row-level list is sensitive and time series are capped |
| Sessions | sessions, stats, detail, activity | `sessions`, opt-in; page/activity caps and privacy warning |
| Performance | `POST /reports/performance` | `performance`, opt-in; normalized LCP/INP/CLS/FCP/TTFB summary and partial-aware series, single-period and aligned comparisons, bounded dimension rankings, derived cross-tabs, and direct route-group queries |
| Saved analysis | website reports, report detail, segments/cohorts | `reports`, opt-in; GET only for persisted objects |
| Calculated analysis | goal, funnel, journey, retention, UTM, attribution, breakdown report routes | `reports`, opt-in; closed typed semantic-read POST allowlist and bounded arrays |
| Revenue | revenue stats and metrics | `revenue`, opt-in |
| Replays | replay list metadata | `replay`, opt-in; raw rrweb event payloads excluded |
| Heatmaps | `POST /reports/heatmap` | `heatmaps`, opt-in; click/scroll page discovery and at most 1,000 detail points |
| Decision workflows | bounded combinations of websites, stats, metrics, expanded metrics, pageviews, daterange, events, recorder, and performance | `insights`, default; website resolution, portfolio, traffic-change, aligned series comparison, release-impact, traffic-quality, and tracking-health results |

Umami 3.2 performance queries return `count(*)` rather than a non-null count for each selected metric, omit counts from chart buckets, and do not apply the generated `excludeBounce` join. Performance events also omit referrer/UTM attribution and LCP element/resource decomposition. Compass exposes these as capability and scope limitations, rejects unsupported filters, and does not reinterpret zero placeholders or mismatched audiences as valid performance evidence.

See [Umami 3.2 performance gaps and upstream contract proposal](umami-performance-gaps-3.2.md) for the concrete upstream count, filter, multidimensional, and LCP-attribution changes.

## Candidate read-only additions

| Priority | Umami 3.2 area | Why it is not in 0.2 yet |
| --- | --- | --- |
| P1 | Event-data property discovery, fields, values, stats, and typed pivots | High cardinality and heterogeneous values need purpose-built schemas, pagination, redaction guidance, and fixtures. |
| P1 | Session-data properties, values, stats, and pivots | Can expose user-linked properties; needs stronger privacy controls than ordinary aggregates. |
| P1 | Revenue chart and revenue sessions | Chart is straightforward; session rows need currency validation, paging, and sensitivity tests. |
| P2 | Expanded metrics and weekly sessions | Useful convenience endpoints, but current core tools already provide most decisions with a smaller surface. |
| P2 | Replay detail, per-session replay lookup, and saved replay metadata | Raw replay events can be very large and can contain sensitive interaction data. A safe summary contract is required first. |
| P2 | Upstream capability discovery | `get_server_info` reports Compass capabilities. Cloud plans, self-hosted versions, and section permissions still need an official Umami capability endpoint rather than version guessing. |

## Deliberately excluded mutations

Website/team/user management, reset/transfer/share operations, saved report and segment writes, replay save/delete, and event/session data deletion are not exposed. Future management modules must be separately opt-in, rejected by the default read-only access policy, least-privilege, confirmation-aware, and independently security reviewed.

## Adding coverage

New tools should map one user decision to the smallest stable endpoint set. They must use a fixed path, a strict Zod input schema, website allowlist enforcement, an explicit context bound, safe error conversion, read-only annotations where truthful, and a real MCP integration test. Follow [Adding a tool](../adding-a-tool.md).
