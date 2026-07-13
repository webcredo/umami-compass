import { z } from "zod";
import type { HeatmapReportRequest } from "../../api/types.js";
import { parseTimeRange } from "../../time.js";
import { reportFilters, requireRecord } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import { filtersSchema, recordOutputSchema, timeSchema, uuidSchema } from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

function boundHeatmapResult(
  value: unknown,
  limits: { maxBuckets: number; maxPages: number; maxPoints: number },
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const result = value as Record<string, unknown>;
  const { maxBuckets, maxPages, maxPoints } = limits;
  const pages = Array.isArray(result.pages) ? result.pages : undefined;
  const points = Array.isArray(result.points) ? result.points : undefined;
  const scroll =
    typeof result.scroll === "object" && result.scroll !== null && !Array.isArray(result.scroll)
      ? (result.scroll as Record<string, unknown>)
      : undefined;
  const buckets = scroll && Array.isArray(scroll.buckets) ? scroll.buckets : undefined;
  return {
    ...result,
    ...(pages
      ? {
          pages: pages.slice(0, maxPages),
          pageLimit: maxPages,
          pagesTruncated: pages.length > maxPages,
          totalPages: pages.length,
        }
      : {}),
    ...(points
      ? {
          points: points.slice(0, maxPoints),
          pointLimit: maxPoints,
          pointsTruncated: points.length > maxPoints,
          totalPoints: points.length,
        }
      : {}),
    ...(scroll
      ? {
          scroll: {
            ...scroll,
            ...(buckets
              ? {
                  buckets: buckets.slice(0, maxBuckets),
                  bucketLimit: maxBuckets,
                  bucketsTruncated: buckets.length > maxBuckets,
                  totalBuckets: buckets.length,
                }
              : {}),
          },
        }
      : {}),
  };
}

export const heatmapsModule: ToolModule = {
  id: "heatmaps",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "get_heatmap",
      {
        title: "Get an Umami heatmap",
        description:
          "Get Umami 3.2 click or scroll heatmap data. Omit urlPath to list available pages; provide it for bounded detail points.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          mode: z.enum(["click", "scroll"]).default("click"),
          urlPath: z.string().min(1).max(500).optional(),
          maxPoints: z.number().int().min(1).max(1_000).default(500),
          maxBuckets: z.number().int().min(1).max(1_000).default(200),
          maxPages: z.number().int().min(1).max(500).default(100),
          filters: filtersSchema.optional(),
        },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, mode, urlPath, maxPoints, maxBuckets, maxPages, filters }, extra) =>
        runTool(async () => {
          const { startAt, endAt } = parseTimeRange(start, end, config.maxRangeDays);
          const body: HeatmapReportRequest = {
            websiteId,
            type: "heatmap",
            parameters: {
              startDate: new Date(startAt).toISOString(),
              endDate: new Date(endAt).toISOString(),
              mode,
              ...(urlPath === undefined ? {} : { urlPath }),
            },
            filters: reportFilters(filters),
          };
          const result = requireRecord(await client.getHeatmapReport(body, extra.signal));
          return boundHeatmapResult(result, { maxBuckets, maxPages, maxPoints });
        }),
    );
  },
};
