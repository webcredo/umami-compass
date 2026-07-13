# Adding a tool

Use this checklist for a read-only Umami endpoint.

1. Confirm the endpoint and query names against the tagged Umami source and public API documentation. Record the reference version in the pull request.
2. Choose the existing module that owns the endpoint family. Propose a new toolset only when users need to enable/disable the family independently.
3. Define strict, bounded Zod inputs. Reuse `uuidSchema`, `timeSchema`, `filtersSchema`, paging schemas, and `rangeQuery`.
4. Use a fixed `websites/{websiteId}/...` path so the client enforces both website and team allowlists centrally. For direct object paths such as `reports/{reportId}`, call and await `client.assertWebsiteAccessible(websiteId, extra.signal)` first. Closed report requests enforce the same policy inside `client.runReport`.
5. Encode every path segment and pass `extra.signal` to the client.
6. Wrap the handler with `runTool`, provide `outputSchema`, pass the applicable website/range/timezone metadata, and use honest annotations.
7. Do not transform away upstream fields. If a normalized response is valuable, include both raw evidence and the normalization, and test both.
8. Add client-level tests for the URL/headers and an MCP integration test for tool name, schema, annotations, structured output, and safe failure.
9. Update README tool tables and `CHANGELOG.md`.
10. Run `pnpm check` and `npm pack --dry-run`.

Example shape:

```ts
server.registerTool(
  "get_example",
  {
    title: "Get example analytics",
    description: "Explain the decision this evidence supports.",
    inputSchema: { websiteId: uuidSchema, start: timeSchema, end: timeSchema },
    outputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  ({ websiteId, start, end }, extra) =>
    runTool(
      () =>
        client.get(
          `websites/${encodeURIComponent(websiteId)}/example`,
          rangeQuery(start, end, config.maxRangeDays),
          extra.signal,
        ),
      { websiteId, range: { start, end } },
    ),
);
```

## Adding management functionality

Do not add `POST`, `PUT`, `PATCH`, or `DELETE` to `UmamiClient.get` or disguise a mutation as a read tool. A semantically read-only Umami report may extend the closed `ReadOnlyReportRequest` union only with tagged-source evidence and a runtime allowlist update. Start management work with a design proposal covering scopes, confirmation UX, idempotency, auditability, rollback, privacy, and upstream authorization. Management must live in an `access: "write"` module and remain excluded by the default `READ_ONLY_POLICY`.
