# Architecture

Umami Compass separates transport, MCP presentation, policy, and upstream HTTP so each can evolve independently.

## Layers

1. `src/cli.ts` owns process behavior and the stdio transport. It writes no diagnostics to stdout after MCP starts.
2. `src/config.ts` resolves a single fixed API root, exactly one auth strategy, toolsets, website/team allowlists, and resource limits.
3. `src/api/client.ts` owns centralized website/team authorization, headers, generation-safe lazy login/401 refresh, redirects, timeouts, cancellation, byte-bounded JSON parsing, and safe errors.
4. `src/mcp/modules/*` maps bounded Zod inputs to documented Umami endpoint families or bounded multi-endpoint insight workflows.
5. `src/mcp/tool-module.ts` is the extension seam. Modules declare an ID and `read` or `write` access.
6. `src/server.ts` applies the central access policy, registers selected modules, and exposes common MCP resources/prompts.

The API client exposes fixed-origin `get` plus a closed `runReport` union because Umami implements read-only calculations such as performance, funnels, attribution, and heatmaps as HTTP POST. Runtime validation accepts only the reviewed report type allowlist and derives the endpoint from that type. There is no arbitrary POST, method, URL, or body surface. A future write implementation must introduce explicit methods by operation class instead of widening this union.

## Dependency direction

```text
CLI → server → policy + modules → client → Umami API
                 ↓
            shared schemas
```

Modules do not read environment variables, open sockets directly, or know about stdio. Tests inject `fetch` and can exercise the full MCP JSON-RPC boundary without a live analytics instance.

## Stable extension points

`ToolModule` is the primary extension point:

```ts
export interface ToolModule {
  id: Toolset;
  access: "read" | "write";
  register(server: McpServer, context: ToolContext): void;
}
```

Adding new toolset IDs is intentionally a reviewed change because IDs are user-facing configuration. Tools within an existing family belong in that module unless its size justifies a private submodule.

`CreateServerOptions` accepts injected modules, access policy, and `fetch`. This supports downstream composition and deterministic tests without global mocks.

## Compatibility policy

Umami 3.2.x is the reference target. The server wraps successful output under `structuredContent.data` and adds `structuredContent.meta` with a normalized data status plus applicable website, requested range, timezone, empty reason, and precise truncation state. `responseTruncated` describes an incomplete primary result; `sectionsTruncated` names bounded nested sections; aggregate `truncated` remains a compatibility alias. Primitive endpoint tools preserve new upstream fields. Insight workflows retain the aggregate evidence used for their deterministic calculations and label associations as non-causal. Period comparisons use explicit equal-length requests. When a metric top-N response may be truncated, missing rows remain unknown and are omitted from deltas instead of being treated as zero. Performance breakdowns require positive integer row counts, monotonic nonnegative percentiles, and 20 performance events per row by default; aligned comparisons return comparable rows first and exclude undersized rows unless explicitly requested. Umami uses `count(*)`, not `count(metric)`, so metric-specific sample counts remain explicitly unavailable. Explicitly bounded high-cardinality results (report arrays, performance series/breakdowns, derived channel and performance candidates, heatmap points, session activity, and multi-website workflows) keep only the requested items. Inputs are curated because allowing arbitrary query names would widen the data and security surface silently.

Performance inputs use a narrower filter schema than general analytics. Only page/title and environment fields persisted on performance events across both reference database backends are accepted. Referrer, UTM, hostname, query, event, tag, `excludeBounce`, and other unsupported scopes are rejected rather than ignored. Release-impact performance evidence returns `scope_mismatch` when a requested traffic segment depends on referrer exclusions that performance events cannot express. Derived cross-tabs make at most ten candidate requests, route groups use direct regex-filtered queries instead of averaging percentiles, and performance portfolio workflows isolate per-site failures without averaging site p75 values. Portfolio output defaults to compact, selects drill-down sites only by `detailMetric`, and labels performance-events-per-pageview as a ratio rather than collection coverage.

Umami does not expose channel as a filter or multi-field breakdown dimension. Compass derives channel cross-tabs by discovering bounded candidate rows and querying Umami's expanded channel metrics for each candidate with four workers. The response states fan-out count, candidate truncation, and unsupported rows. Referral-spam detection is likewise explicit and conservative: it requires a generated-domain pattern together with high bounce, near-zero duration, and a minimum visit count. `trafficSegment=human` converts only those candidates into native negative referrer-domain filters for traffic queries and fails closed if assessment is unavailable. Performance evidence cannot share that referrer scope in Umami 3.2 and is marked mismatched.

When Umami changes an endpoint:

1. Capture the new public contract in a fixture/test.
2. Keep an old-server fallback only when it is unambiguous and testable.
3. Document the minimum compatible version.
4. Prefer a capability probe over parsing version strings when an official probe exists.

## Threat boundaries

- The MCP host and local environment are trusted to protect secrets.
- The Umami origin is selected by the operator at startup and cannot be changed by a model.
- Website and team allowlists apply before direct website requests and typed reports, not only during resource discovery.
- Umami is treated as an untrusted network service: redirects, oversized responses, and invalid JSON fail closed; response bodies do not enter errors.
- Model context is treated as scarce and potentially retained: page/range caps, sanitized website discovery, and exclusion of raw replay streams reduce exposure.
- Tool annotations are advisory UX metadata, not authorization. Enforced policy and upstream permissions are the security boundary.
