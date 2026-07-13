# Umami 3.2 API coverage — July 2026

This matrix was checked against the tagged Umami [`v3.2.0`](https://github.com/umami-software/umami/releases/tag/v3.2.0) source, not only the older public API examples. It separates HTTP method from semantic access: several `/api/reports/*` routes use POST to calculate and return analytics without persisting state.

## Shipped read-only surface

| Area | Umami 3.2 routes represented | Compass tools / policy |
| --- | --- | --- |
| Websites and overview | websites, stats, pageviews, metrics, active, daterange | `core`, default; paging, dimensions, series, and date range bounded |
| Events | events list, stats, series | `events`, opt-in; row-level list is sensitive and time series are capped |
| Sessions | sessions, stats, detail, activity | `sessions`, opt-in; page/activity caps and privacy warning |
| Performance | `POST /reports/performance` | `performance`, opt-in; LCP/INP/CLS/FCP/TTFB summary, series, and dimension breakdowns bounded |
| Saved analysis | website reports, report detail, segments/cohorts | `reports`, opt-in; GET only for persisted objects |
| Calculated analysis | goal, funnel, journey, retention, UTM, attribution, breakdown report routes | `reports`, opt-in; closed typed semantic-read POST allowlist and bounded arrays |
| Revenue | revenue stats and metrics | `revenue`, opt-in |
| Replays | replay list metadata | `replay`, opt-in; raw rrweb event payloads excluded |
| Heatmaps | `POST /reports/heatmap` | `heatmaps`, opt-in; click/scroll page discovery and at most 1,000 detail points |

## Candidate read-only additions

| Priority | Umami 3.2 area | Why it is not in 0.1 yet |
| --- | --- | --- |
| P1 | Event-data property discovery, fields, values, stats, and typed pivots | High cardinality and heterogeneous values need purpose-built schemas, pagination, redaction guidance, and fixtures. |
| P1 | Session-data properties, values, stats, and pivots | Can expose user-linked properties; needs stronger privacy controls than ordinary aggregates. |
| P1 | Revenue chart and revenue sessions | Chart is straightforward; session rows need currency validation, paging, and sensitivity tests. |
| P2 | Expanded metrics and weekly sessions | Useful convenience endpoints, but current core tools already provide most decisions with a smaller surface. |
| P2 | Replay detail, per-session replay lookup, and saved replay metadata | Raw replay events can be very large and can contain sensitive interaction data. A safe summary contract is required first. |
| P2 | Capability discovery | Cloud accounts, self-hosted versions, plans, and section permissions can differ; an official capability endpoint would be preferable to version guessing. |

## Deliberately excluded mutations

Website/team/user management, reset/transfer/share operations, saved report and segment writes, replay save/delete, and event/session data deletion are not exposed. Future management modules must be separately opt-in, rejected by the default read-only access policy, least-privilege, confirmation-aware, and independently security reviewed.

## Adding coverage

New tools should map one user decision to the smallest stable endpoint set. They must use a fixed path, a strict Zod input schema, website allowlist enforcement, an explicit context bound, safe error conversion, read-only annotations where truthful, and a real MCP integration test. Follow [Adding a tool](../adding-a-tool.md).
