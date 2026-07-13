import { z } from "zod";
import { boundedItems } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  boundedItemsOutputSchema,
  filtersSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  rangeQuery,
  recordOutputSchema,
  timeSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

export const sessionsModule: ToolModule = {
  id: "sessions",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_sessions",
      {
        title: "List Umami sessions",
        description: "List and search visitor sessions for a website and time range.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          page: pageSchema,
          pageSize: pageSizeSchema,
          search: z.string().max(500).optional(),
          filters: filtersSchema.optional(),
        },
        outputSchema: pagedOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, page, pageSize, search, filters }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/sessions`,
            {
              ...rangeQuery(start, end, config.maxRangeDays, { filters }),
              page,
              pageSize,
              search,
            },
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_session_stats",
      {
        title: "Get session statistics",
        description: "Get aggregate session metrics for a website and time range.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, filters }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/sessions/stats`,
            rangeQuery(start, end, config.maxRangeDays, { filters }),
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_session",
      {
        title: "Get a session",
        description: "Get metadata for one Umami visitor session.",
        inputSchema: { websiteId: uuidSchema, sessionId: uuidSchema },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, sessionId }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/sessions/${encodeURIComponent(sessionId)}`,
            undefined,
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_session_activity",
      {
        title: "Get session activity",
        description:
          "Get a bounded list of pageviews and events that occurred during one session and time range.",
        inputSchema: {
          websiteId: uuidSchema,
          sessionId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          maxItems: z.number().int().min(1).max(1_000).default(500),
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, sessionId, start, end, maxItems }, extra) =>
        runTool(async () => {
          client.assertWebsiteAllowed(websiteId);
          return boundedItems(
            await client.get(
              `websites/${encodeURIComponent(websiteId)}/sessions/${encodeURIComponent(sessionId)}/activity`,
              rangeQuery(start, end, config.maxRangeDays),
              extra.signal,
            ),
            maxItems,
          );
        }),
    );
  },
};
