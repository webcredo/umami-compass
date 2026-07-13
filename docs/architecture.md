# Architecture

Umami Compass separates transport, MCP presentation, policy, and upstream HTTP so each can evolve independently.

## Layers

1. `src/cli.ts` owns process behavior and the stdio transport. It writes no diagnostics to stdout after MCP starts.
2. `src/config.ts` resolves a single fixed API root, exactly one auth strategy, toolsets, allowlists, and resource limits.
3. `src/api/client.ts` owns headers, generation-safe lazy login/401 refresh, redirects, timeouts, cancellation, byte-bounded JSON parsing, and safe errors.
4. `src/mcp/modules/*` maps bounded Zod inputs to documented Umami endpoint families.
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

Umami 3.2.x is the reference target. The server normally wraps successful upstream JSON under `structuredContent.data`, preserving new fields. Explicitly bounded high-cardinality results (report arrays, performance series/breakdowns, heatmap points, and session activity) add truncation metadata and keep the first requested items. Inputs are curated because allowing arbitrary query names would widen the data and security surface silently.

When Umami changes an endpoint:

1. Capture the new public contract in a fixture/test.
2. Keep an old-server fallback only when it is unambiguous and testable.
3. Document the minimum compatible version.
4. Prefer a capability probe over parsing version strings when an official probe exists.

## Threat boundaries

- The MCP host and local environment are trusted to protect secrets.
- The Umami origin is selected by the operator at startup and cannot be changed by a model.
- Umami is treated as an untrusted network service: redirects, oversized responses, and invalid JSON fail closed; response bodies do not enter errors.
- Model context is treated as scarce and potentially retained: page/range caps and exclusion of raw replay streams reduce exposure.
- Tool annotations are advisory UX metadata, not authorization. Enforced policy and upstream permissions are the security boundary.
