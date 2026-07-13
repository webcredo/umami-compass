import { z } from "zod";
import { boundedItems } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  boundedItemsOutputSchema,
  filtersSchema,
  rangeQuery,
  recordOutputSchema,
  timeSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const currencySchema = z
  .string()
  .length(3)
  .transform((value) => value.toUpperCase())
  .describe("Three-letter display currency, for example USD or EUR");

export const revenueModule: ToolModule = {
  id: "revenue",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "get_revenue_stats",
      {
        title: "Get revenue statistics",
        description: "Get Umami 3.2 revenue totals and comparison values in a chosen currency.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          currency: currencySchema,
          filters: filtersSchema.optional(),
        },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, currency, filters }, extra) =>
        runTool(
          () => {
            client.assertWebsiteAllowed(websiteId);
            return client.get(
              `websites/${encodeURIComponent(websiteId)}/revenue/stats`,
              {
                ...rangeQuery(start, end, config.maxRangeDays, { filters }),
                currency,
              },
              extra.signal,
            );
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "get_revenue_metrics",
      {
        title: "Break down revenue metrics",
        description: "Break down Umami 3.2 revenue by country, region, referrer or channel.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          currency: currencySchema,
          type: z.enum(["country", "region", "referrer", "channel"]),
          limit: z.number().int().min(1).max(100).default(20),
          filters: filtersSchema.optional(),
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, currency, type, limit, filters }, extra) =>
        runTool(
          async () => {
            client.assertWebsiteAllowed(websiteId);
            return boundedItems(
              await client.get(
                `websites/${encodeURIComponent(websiteId)}/revenue/metrics`,
                {
                  ...rangeQuery(start, end, config.maxRangeDays, { filters }),
                  currency,
                  type,
                },
                extra.signal,
              ),
              limit,
            );
          },
          { websiteId, range: { start, end } },
        ),
    );
  },
};
