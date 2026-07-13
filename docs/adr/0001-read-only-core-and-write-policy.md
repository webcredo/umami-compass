# ADR-0001: Read-only core with an explicit write policy

- Status: accepted
- Date: 2026-07-13

## Context

Umami's API includes create, update, delete, share, reset, and data-management operations. MCP tools can be selected by a model, and tool annotations alone do not enforce authorization. At the same time, the project should remain extensible enough to support carefully designed management workflows later.

## Decision

The initial package exposes only semantically read-only analytics tools. Each tool module declares `access: "read" | "write"`. Server construction applies a central `AccessPolicy`; the default `READ_ONLY_POLICY` rejects registration of every write module. The API client exposes fixed-origin `get` and a closed, runtime-checked `runReport` union because Umami 3.2 implements performance, funnel, journey, attribution, heatmap, and other report calculations as HTTP POST. It does not expose arbitrary POST, method, URL, or body input.

Raw session replay streams, arbitrary URL fetches, HTML retrieval, and database access are out of scope.

Future management capabilities require a separate design and security review. They must be opt-in, least-privilege, clearly annotated, confirm destructive actions, and have audit/idempotency tests. Read-only remains the default profile.

## Consequences

- The first release is safer to run with agents and easier to audit.
- A contributor cannot accidentally expose a write module under the default policy.
- Future write work has a stable composition point but must add explicit HTTP methods and policy configuration.
- Some users will need the Umami UI or API directly for management until that work is complete.
