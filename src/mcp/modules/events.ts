import { z } from "zod";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  arrayOutputSchema,
  filtersSchema,
  outputSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  rangeQuery,
  selectSafeSeriesUnit,
  seriesRangeQuery,
  timeSchema,
  timezoneSchema,
  unitSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

export const eventsModule: ToolModule = {
  id: "events",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_events",
      {
        title: "List Umami events",
        description: "List and search custom events for a website and time range.",
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
        runTool(
          () => {
            client.assertWebsiteAllowed(websiteId);
            return client.get(
              `websites/${encodeURIComponent(websiteId)}/events`,
              {
                ...rangeQuery(start, end, config.maxRangeDays, {
                  filters: { ...filters, eventType: 2 },
                }),
                page,
                pageSize,
                search,
              },
              extra.signal,
            );
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "get_event_stats",
      {
        title: "Get event statistics",
        description: "Get aggregate custom-event statistics and comparison values.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, filters }, extra) =>
        runTool(
          () => {
            client.assertWebsiteAllowed(websiteId);
            return client.get(
              `websites/${encodeURIComponent(websiteId)}/events/stats`,
              rangeQuery(start, end, config.maxRangeDays, { filters }),
              extra.signal,
            );
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "get_event_series",
      {
        title: "Get event time series",
        description: "Get custom-event counts over time, optionally filtered to a named event.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          timezone: timezoneSchema,
          unit: unitSchema.describe(
            "Optional series unit; when omitted Compass selects the finest granularity within its point budget",
          ),
          limit: z.number().int().min(1).max(100).default(20),
          filters: filtersSchema.optional(),
        },
        outputSchema: arrayOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, timezone, unit, limit, filters }, extra) =>
        runTool(
          () => {
            client.assertWebsiteAllowed(websiteId);
            const effectiveUnit =
              unit ?? selectSafeSeriesUnit(start, end, config.maxRangeDays, limit);
            return client.get(
              `websites/${encodeURIComponent(websiteId)}/events/series`,
              {
                ...seriesRangeQuery(start, end, config.maxRangeDays, {
                  filters,
                  timezone,
                  unit: effectiveUnit,
                  seriesCount: limit,
                }),
                limit,
              },
              extra.signal,
            );
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );
  },
};
