import { z } from "zod";
import type { PerformanceMetric, PerformanceReportRequest } from "../../api/types.js";
import { boundedItems, reportDateRange, reportFilters } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  boundedItemsDataSchema,
  filtersSchema,
  parseUpstream,
  seriesRangeQuery,
  timeSchema,
  timezoneSchema,
  unitSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const metricSchema = z
  .enum(["lcp", "inp", "cls", "fcp", "ttfb"])
  .default("lcp")
  .describe("Core Web Vital or related loading metric");

const dimensionSchema = z.enum(["page", "pageTitle", "device", "browser"]);

const dimensionKeys = {
  page: "pages",
  pageTitle: "pageTitles",
  device: "devices",
  browser: "browsers",
} as const;

const performanceReportSchema = z
  .object({
    chart: z.array(z.json()),
    summary: z.json(),
    pages: z.array(z.json()).optional(),
    pageTitles: z.array(z.json()).optional(),
    devices: z.array(z.json()).optional(),
    browsers: z.array(z.json()).optional(),
  })
  .passthrough();

const webVitalsOutputSchema = {
  data: z
    .object({
      metric: z.enum(["lcp", "inp", "cls", "fcp", "ttfb"]),
      summary: z.json(),
      chart: boundedItemsDataSchema,
    })
    .passthrough(),
};

const performanceBreakdownOutputSchema = {
  data: boundedItemsDataSchema
    .extend({
      metric: z.enum(["lcp", "inp", "cls", "fcp", "ttfb"]),
      dimension: dimensionSchema,
      summary: z.json(),
    })
    .passthrough(),
};

function makeRequest(
  websiteId: string,
  start: number | string,
  end: number | string,
  maxRangeDays: number,
  metric: PerformanceMetric,
  timezone: string,
  unit: "day" | "hour" | "minute" | "month" | "year" | undefined,
  filters: Record<string, unknown> | undefined,
): PerformanceReportRequest {
  seriesRangeQuery(start, end, maxRangeDays, { timezone, unit, seriesCount: 1 });
  return {
    websiteId,
    type: "performance",
    parameters: {
      ...reportDateRange(start, end, maxRangeDays),
      metric,
      timezone,
      ...(unit ? { unit } : {}),
    },
    filters: reportFilters(filters),
  };
}

export const performanceModule: ToolModule = {
  id: "performance",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "get_web_vitals",
      {
        title: "Get Core Web Vitals",
        description:
          "Get Umami 3.2 LCP, INP, CLS, FCP and TTFB percentile summaries plus a bounded p50/p75/p95 series for one metric.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          maxPoints: z.number().int().min(1).max(1_000).default(366),
          filters: filtersSchema.optional(),
        },
        outputSchema: webVitalsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, metric, timezone, unit, maxPoints, filters }, extra) =>
        runTool(async () => {
          const request = makeRequest(
            websiteId,
            start,
            end,
            config.maxRangeDays,
            metric,
            timezone,
            unit,
            filters,
          );
          const report = parseUpstream(
            performanceReportSchema,
            await client.runReport(request, extra.signal),
            "performance report",
          );
          return {
            metric,
            summary: report.summary,
            chart: boundedItems(report.chart, maxPoints),
          };
        }),
    );

    server.registerTool(
      "get_performance_breakdown",
      {
        title: "Break down Core Web Vitals",
        description:
          "Rank Umami 3.2 Web Vital percentiles by page, page title, device or browser with explicit context limits.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          dimension: dimensionSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          limit: z.number().int().min(1).max(100).default(20),
          filters: filtersSchema.optional(),
        },
        outputSchema: performanceBreakdownOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, metric, dimension, timezone, unit, limit, filters }, extra) =>
        runTool(async () => {
          const request = makeRequest(
            websiteId,
            start,
            end,
            config.maxRangeDays,
            metric,
            timezone,
            unit,
            filters,
          );
          const report = parseUpstream(
            performanceReportSchema,
            await client.runReport(request, extra.signal),
            "performance report",
          );
          return {
            metric,
            dimension,
            summary: report.summary,
            ...boundedItems(report[dimensionKeys[dimension]], limit),
          };
        }),
    );
  },
};
