import { z } from "zod";
import { UmamiError } from "../../api/errors.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  arrayOutputSchema,
  filtersSchema,
  outputSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  rangeQuery,
  resultMetaOutputSchema,
  selectSafeSeriesUnit,
  seriesRangeQuery,
  timeSchema,
  timezoneSchema,
  unitSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const EVENT_PROPERTY_VALUE_LIMIT = 100;
const umamiFilterOperatorPrefix = /^(?:eq|neq|s|ns|c|dnc|re|nre|t|f|gt|lt|gte|lte|bf|af)\./;
const eventPropertyValuesSchema = z
  .array(
    z.object({ value: z.string().nullable(), total: z.number().int().nonnegative() }).passthrough(),
  )
  .max(EVENT_PROPERTY_VALUE_LIMIT);

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

    server.registerTool(
      "get_event_property_values",
      {
        title: "Get event property value counts",
        description:
          "Count occurrences of each value for one custom event property. Optionally scope the counts to one exact page path. Umami returns at most 100 values, so reaching that limit may leave other values unreported.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          eventName: z
            .string()
            .min(1)
            .max(50)
            .refine((name) => name.trim().length > 0)
            .refine((name) => !name.includes(",") && !umamiFilterOperatorPrefix.test(name), {
              message: "Event names with commas or Umami filter prefixes cannot be scoped exactly.",
            })
            .describe("Exact custom event name"),
          propertyName: z
            .string()
            .min(1)
            .max(500)
            .refine((name) => name.trim().length > 0)
            .describe("Case-sensitive custom property key"),
          path: z
            .string()
            .max(2_000)
            .refine((path) => path === "" || path.startsWith("/") || path.startsWith("#"), {
              message: 'Use a path starting with "/" or a homepage stored as "" or "#fragment".',
            })
            .refine((path) => !path.includes(","), {
              message: "Page paths with commas cannot be scoped exactly.",
            })
            .optional()
            .describe('Exact page path, such as "/" or "/pricing". Some sites store home as ""'),
        },
        outputSchema: {
          data: z.object({
            values: eventPropertyValuesSchema,
            upstreamValueLimit: z.literal(EVENT_PROPERTY_VALUE_LIMIT),
            responseTruncated: z.boolean(),
            dataStatus: z.enum(["available", "empty"]),
          }),
          ...resultMetaOutputSchema,
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, eventName, propertyName, path }, extra) =>
        runTool(
          async () => {
            const response = await client.get(
              `websites/${encodeURIComponent(websiteId)}/event-data/values`,
              {
                ...rangeQuery(start, end, config.maxRangeDays, { filters: { path } }),
                // Umami 3.2 and 3.3.0 select the event using `event`; newer versions use
                // `eventName`. Supplying both also avoids a silently unscoped legacy query.
                event: eventName,
                eventName,
                propertyName,
              },
              extra.signal,
            );
            const parsed = eventPropertyValuesSchema.safeParse(response);
            if (!parsed.success) {
              throw new UmamiError(
                "INVALID_RESPONSE",
                "Umami returned invalid event property values.",
              );
            }
            const values = parsed.data;
            return {
              values,
              upstreamValueLimit: EVENT_PROPERTY_VALUE_LIMIT,
              responseTruncated: values.length === EVENT_PROPERTY_VALUE_LIMIT,
              dataStatus: values.length === 0 ? "empty" : "available",
            };
          },
          { websiteId, range: { start, end } },
        ),
    );
  },
};
