import { z } from "zod";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  arrayOutputSchema,
  filtersSchema,
  outputSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  pageviewsDataSchema,
  pageviewsOutputSchema,
  parseUpstream,
  rangeQuery,
  recordOutputSchema,
  seriesRangeQuery,
  timeSchema,
  timezoneSchema,
  unitSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const metricTypeSchema = z.enum([
  "browser",
  "channel",
  "city",
  "country",
  "device",
  "domain",
  "entry",
  "event",
  "exit",
  "fullPath",
  "hostname",
  "language",
  "os",
  "path",
  "query",
  "referrer",
  "region",
  "screen",
  "tag",
  "title",
]);

export const coreModule: ToolModule = {
  id: "core",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_websites",
      {
        title: "List Umami websites",
        description:
          "List websites visible to the configured Umami identity. If UMAMI_WEBSITE_IDS is set, returns only that exact allowlist.",
        inputSchema: {
          page: pageSchema,
          pageSize: pageSizeSchema,
          search: z.string().max(500).optional(),
        },
        outputSchema: pagedOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ page, pageSize, search }, extra) =>
        runTool(() => client.listWebsites({ page, pageSize, search }, extra.signal)),
    );

    server.registerTool(
      "get_website",
      {
        title: "Get an Umami website",
        description: "Get metadata for one website.",
        inputSchema: { websiteId: uuidSchema },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId }, extra) => runTool(() => client.getWebsite(websiteId, extra.signal)),
    );

    server.registerTool(
      "get_website_stats",
      {
        title: "Get website statistics",
        description:
          "Get visits, visitors, pageviews, bounces, visit duration and Umami's comparison values for a time range.",
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
            `websites/${encodeURIComponent(websiteId)}/stats`,
            rangeQuery(start, end, config.maxRangeDays, { filters }),
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_pageviews",
      {
        title: "Get pageview and session series",
        description:
          "Get Umami 3.2 pageview and session time series. Both arrays are preserved in the response.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema: pageviewsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, timezone, unit, filters }, extra) =>
        runTool(async () => {
          client.assertWebsiteAllowed(websiteId);
          return parseUpstream(
            pageviewsDataSchema,
            await client.get(
              `websites/${encodeURIComponent(websiteId)}/pageviews`,
              seriesRangeQuery(start, end, config.maxRangeDays, {
                filters,
                timezone,
                unit,
                seriesCount: 2,
              }),
              extra.signal,
            ),
            "pageview series",
          );
        }),
    );

    server.registerTool(
      "get_metrics",
      {
        title: "Break down website metrics",
        description:
          "Get a ranked aggregate Umami metric breakdown such as paths, referrers, countries, devices, events, channels or URLs. Visitor identifiers are excluded from the core toolset.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          type: metricTypeSchema,
          limit: z.number().int().min(1).max(100).default(20),
          offset: z.number().int().min(0).max(10_000).default(0),
          search: z.string().max(500).optional(),
          filters: filtersSchema.optional(),
        },
        outputSchema: arrayOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, type, limit, offset, search, filters }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/metrics`,
            {
              ...rangeQuery(start, end, config.maxRangeDays, { filters }),
              type,
              limit,
              offset,
              search,
            },
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_active_visitors",
      {
        title: "Get active visitors",
        description: "Get the current number of active visitors for a website.",
        inputSchema: { websiteId: uuidSchema },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/active`,
            undefined,
            extra.signal,
          );
        }),
    );

    server.registerTool(
      "get_website_date_range",
      {
        title: "Get website data range",
        description: "Get the earliest and latest analytics timestamps available for a website.",
        inputSchema: { websiteId: uuidSchema },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/daterange`,
            undefined,
            extra.signal,
          );
        }),
    );
  },
};
