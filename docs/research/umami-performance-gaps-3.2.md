# Umami 3.2 performance gaps and upstream contract proposal

This note records the upstream changes required for performance evidence that Umami Compass cannot derive safely from the public Umami 3.2 API. It is an implementation reference, not a claim that these fields exist today.

## Verified 3.2 behavior

- `POST /api/reports/performance` returns a summary, one selected-metric chart, and hard-coded page, page-title, device, and browser rankings.
- Summary and ranking queries use `count(*)`. A performance event may contain a null metric, especially INP when no interaction was observed, so this is not a metric-specific sample count.
- Chart buckets return `t`, `p50`, `p75`, and `p95` without a count.
- The request layer parses `excludeBounce` and database helpers generate an exclusion join, but the performance report queries do not interpolate that join.
- Performance collection persists path, page title, Web Vitals, and environment fields. It does not persist referrer/UTM attribution, LCP element/resource attribution, cache status, or edge region on the performance event.

Relevant upstream sources are `src/app/api/reports/performance/route.ts`, `src/queries/sql/reports/getPerformance.ts`, `src/queries/sql/reports/getPerformanceMetrics.ts`, `src/app/api/send/route.ts`, and `src/tracker/index.js` in the Umami `v3.2.0` tag.

## Proposed count contract

Every percentile must carry the count of non-null values used to calculate it:

```json
{
  "chart": [
    {
      "t": "2026-07-21T00:00:00Z",
      "p50": 1200,
      "p75": 1800,
      "p95": 3200,
      "count": 37
    }
  ],
  "summary": {
    "lcp": { "p50": 1200, "p75": 1800, "p95": 3200, "count": 912 },
    "inp": { "p50": 120, "p75": 190, "p95": 410, "count": 364 }
  }
}
```

Relational SQL should use `count(metric)` and ClickHouse should use `countIf(metric is not null)` or its exact nullable equivalent. Breakdown row counts must follow the selected metric rather than all performance events.

`partial` is request-time metadata rather than stored data and can remain a Compass responsibility once bucket counts are trustworthy.

## Bounce and bot scope

The performance query must interpolate the existing `excludeBounceQuery` in both database implementations before the option can be advertised. Tests should prove that event counts change for a fixture containing one bounce and one multi-page visit.

Referral-based bot cleanup cannot be applied after collection because performance events do not retain referrer attribution. A future queryable bot scope needs one of:

1. a persisted collector classification such as `traffic_class=known_bot|browser|unknown`;
2. a stable visit/session flag joined by the performance report; or
3. a first-class saved segment whose semantics are supported by the performance query.

The existing user-agent `isbot` rejection remains collection policy, not an analytical `likely-human` filter. Compass should not infer a bot classification from device and country alone.

## Native multidimensional performance

A generic performance breakdown should accept a reviewed `fields` array and return percentile rows for combinations such as device × country or page × device:

```json
{
  "parameters": {
    "metric": "lcp",
    "fields": ["device", "country"]
  }
}
```

The response needs metric-specific counts, a documented candidate limit, deterministic ordering, and explicit truncation. Until this exists, Compass cross-tabs remain bounded fan-out with candidate-source caveats.

## LCP attribution and decomposition

Accurate decomposition must be calculated from one navigation/LCP observation, not by subtracting aggregate p75 values. The collector would need privacy-reviewed fields for:

- TTFB;
- resource load delay;
- resource load duration;
- render delay;
- LCP element type;
- a redacted or origin/path-limited LCP resource identifier;
- optional cache and edge dimensions.

Full resource URLs should not be collected by default because query strings and paths can contain user or tenant data. Any attribution field needs length limits, query/hash removal, a documented retention policy, and opt-in collection.
