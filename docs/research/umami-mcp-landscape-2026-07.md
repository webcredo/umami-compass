# Umami MCP landscape review — July 2026

This review explains why Umami Compass exists and establishes a reproducible quality baseline. It is a dated snapshot, not a claim that other projects cannot improve.

## Reference points

- Umami [`v3.2.0`](https://github.com/umami-software/umami/releases/tag/v3.2.0), published 2026-06-24, including heatmaps, replay improvements, event/session property reporting, split revenue APIs, and tracker/API fixes.
- The official [Umami API documentation](https://umami.is/docs/api) for Cloud and self-hosted authentication.
- MCP specification [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) and its [security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices).
- Stable TypeScript SDK [`v1.29.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.29.0). The v2 line was still pre-release during this review.

## Projects inspected

- [Macawls/umami-mcp-server](https://github.com/Macawls/umami-mcp-server)
- [mikusnuz/umami-mcp](https://github.com/mikusnuz/umami-mcp)
- [Alurith/umami-mcp-server](https://github.com/Alurith/umami-mcp-server)
- [MurkyPuma/umami-mcp-server](https://github.com/MurkyPuma/umami-mcp-server)

We inspected code, manifests, tests, transport/auth behavior, and endpoint mappings. Where practical, we ran each repository's test suite and a mock-Umami MCP handshake.

## Findings

| Quality property | Compass target | Landscape finding |
| --- | --- | --- |
| Umami Cloud API-key header | `x-umami-api-key` | At least one broad server sent API keys as Bearer tokens, which does not match the Cloud contract. |
| Umami 3.2 pageviews | Preserve `pageviews` and `sessions` arrays | At least one active server modeled an older point shape and discarded the sessions series. |
| Mutations | No mutations in default package | One server exposed 24 mutation calls among 66 tools without a comparable default-deny policy. |
| SSRF/context boundary | Fixed configured API origin | One server exposed arbitrary HTML/screenshot URL retrieval alongside analytics tools. |
| Scope controls | Website allowlist + modular toolsets | No inspected server combined both controls. |
| MCP contract | Structured content, output schemas, annotations, cancellation | Coverage was partial or absent across inspected servers. |
| Contributor confidence | Unit + real MCP integration tests, architecture docs, CI matrix | Some projects had solid tests; others had none or only a small surface. None combined the full target. |

Macawls was the most established read-only implementation inspected and demonstrated useful test discipline. Alurith provided a small, safe read-only surface whose mock handshake behaved correctly. These are meaningful strengths. Umami Compass differentiates itself by combining those safety properties with correct Cloud auth, a broader Umami 3.2 surface, enforced scope controls, structured MCP output, and explicit future write governance.

## Acceptance criteria for Umami Compass 0.1

- Cloud and self-hosted auth have independent header/login tests.
- The Umami 3.2 pageviews fixture proves the sessions series is preserved.
- Every listed tool has `readOnlyHint: true`, `destructiveHint: false`, and an output schema.
- No tool input can select a host or URL.
- Redirects fail closed and error text excludes upstream bodies and credentials.
- Page size, time range, timeout, HTTPS, toolset, and website scope are bounded centrally.
- The test suite performs an actual MCP initialize/list/call exchange.
- Future write modules are rejected by the default access policy.

Re-run this assessment before the first stable release and update claims if upstream projects change.
