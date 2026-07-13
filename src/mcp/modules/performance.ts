import { z } from "zod";
import type { PerformanceMetric, PerformanceReportRequest } from "../../api/types.js";
import { boundedItems, reportDateRange, reportFilters } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  boundedItemsDataSchema,
  filtersSchema,
  parseUpstream,
  resultMetaOutputSchema,
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
  ...resultMetaOutputSchema,
};

const performanceBreakdownOutputSchema = {
  data: boundedItemsDataSchema
    .extend({
      metric: z.enum(["lcp", "inp", "cls", "fcp", "ttfb"]),
      dimension: dimensionSchema,
      summary: z.json(),
      invalidItemsExcluded: z.number().int().nonnegative(),
    })
    .passthrough(),
  ...resultMetaOutputSchema,
};

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function rankPerformanceItems(value: unknown, limit: number) {
  if (!Array.isArray(value)) return boundedItems(value, limit);
  const ranked: Array<Record<string, unknown> & { p50: number; p75: number; p95: number }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const p50 = finiteNumber(row.p50);
    const p75 = finiteNumber(row.p75);
    const p95 = finiteNumber(row.p95);
    if (p50 === undefined || p75 === undefined || p95 === undefined) continue;
    const count = finiteNumber(row.count);
    ranked.push({ ...row, p50, p75, p95, ...(count === undefined ? {} : { count }) });
  }
  ranked.sort((left, right) => {
    const percentileOrder = (right.p75 as number) - (left.p75 as number);
    if (percentileOrder !== 0) return percentileOrder;
    const countOrder = finiteNumber(right.count) ?? 0;
    const leftCount = finiteNumber(left.count) ?? 0;
    if (countOrder !== leftCount) return countOrder - leftCount;
    return String(left.name ?? "").localeCompare(String(right.name ?? ""));
  });
  return {
    ...boundedItems(ranked, limit),
    invalidItemsExcluded: value.length - ranked.length,
  };
}

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
        runTool(
          async () => {
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
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "get_performance_breakdown",
      {
        title: "Break down Core Web Vitals",
        description:
          "Rank Umami 3.2 Web Vital percentiles by p75 for page, page title, device or browser. Rows without numeric percentiles are excluded and reported explicitly.",
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
        runTool(
          async () => {
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
              ...rankPerformanceItems(report[dimensionKeys[dimension]], limit),
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );
  },
};
