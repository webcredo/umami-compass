import { z } from "zod";
import { UmamiError } from "../../api/errors.js";
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

// Twenty leaves five observations in the upper quartile used by p75. This is an
// exploratory ranking guard, not a statistical-significance threshold.
const DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT = 20;

// Umami 3.2 applies these limits before Compass can validate row sample counts.
const upstreamCandidateLimits = {
  page: 500,
  pageTitle: 500,
  device: null,
  browser: 500,
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
      dataStatus: z.enum(["available", "empty", "unknown"]),
      emptyReason: z.enum(["no_data_in_range", "insufficient_sample_size"]).optional(),
      candidateItemLimit: z.number().int().positive().nullable(),
      candidateItemsEvaluated: z.number().int().nonnegative(),
      candidateItemsTruncated: z.boolean(),
      invalidItemsExcluded: z.number().int().nonnegative(),
      insufficientSampleItemsExcluded: z.number().int().nonnegative(),
      minimumSampleCount: z.number().int().positive(),
      minimumSampleCountOverridden: z.boolean(),
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

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

interface PerformanceBreakdownRow extends Record<string, unknown> {
  count: number;
  name: string;
  p50: number;
  p75: number;
  p95: number;
}

function rankPerformanceItems(
  value: unknown,
  options: {
    candidateItemLimit: number | null;
    limit: number;
    minimumSampleCount: number;
    minimumSampleCountOverridden: boolean;
  },
) {
  if (!Array.isArray(value)) {
    throw new UmamiError(
      "INVALID_RESPONSE",
      "Umami returned an unexpected performance breakdown response.",
    );
  }
  const ranked: PerformanceBreakdownRow[] = [];
  let invalidItemsExcluded = 0;
  let insufficientSampleItemsExcluded = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      invalidItemsExcluded += 1;
      continue;
    }
    const row = item as Record<string, unknown>;
    const p50 = finiteNumber(row.p50);
    const p75 = finiteNumber(row.p75);
    const p95 = finiteNumber(row.p95);
    const count = positiveInteger(row.count);
    if (
      typeof row.name !== "string" ||
      row.name.trim() === "" ||
      p50 === undefined ||
      p75 === undefined ||
      p95 === undefined ||
      count === undefined ||
      p50 < 0 ||
      p75 < p50 ||
      p95 < p75
    ) {
      invalidItemsExcluded += 1;
      continue;
    }
    if (count < options.minimumSampleCount) {
      insufficientSampleItemsExcluded += 1;
      continue;
    }
    ranked.push({ ...row, name: row.name, p50, p75, p95, count });
  }
  ranked.sort((left, right) => {
    const percentileOrder = right.p75 - left.p75;
    if (percentileOrder !== 0) return percentileOrder;
    if (right.count !== left.count) return right.count - left.count;
    return left.name.localeCompare(right.name);
  });
  const candidateItemsTruncated =
    options.candidateItemLimit !== null && value.length >= options.candidateItemLimit;
  const status =
    ranked.length > 0
      ? { dataStatus: "available" as const }
      : value.length === 0
        ? { dataStatus: "empty" as const, emptyReason: "no_data_in_range" }
        : candidateItemsTruncated
          ? { dataStatus: "unknown" as const }
          : insufficientSampleItemsExcluded > 0
            ? { dataStatus: "empty" as const, emptyReason: "insufficient_sample_size" }
            : { dataStatus: "unknown" as const };
  return {
    ...status,
    ...boundedItems(ranked, options.limit),
    candidateItemLimit: options.candidateItemLimit,
    candidateItemsEvaluated: value.length,
    candidateItemsTruncated,
    invalidItemsExcluded,
    insufficientSampleItemsExcluded,
    minimumSampleCount: options.minimumSampleCount,
    minimumSampleCountOverridden: options.minimumSampleCountOverridden,
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
          "Rank Umami 3.2 Web Vital percentiles by p75 for page, page title, device or browser. Rows default to at least 20 samples; invalid rows, undersized rows and incomplete upstream candidate coverage are reported explicitly.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          dimension: dimensionSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          limit: z.number().int().min(1).max(100).default(20),
          minimumSampleCount: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .optional()
            .describe(
              "Minimum samples required for a row to enter the p75 ranking; defaults to 20. Use 1 to include every valid row.",
            ),
          filters: filtersSchema.optional(),
        },
        outputSchema: performanceBreakdownOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          start,
          end,
          metric,
          dimension,
          timezone,
          unit,
          limit,
          minimumSampleCount,
          filters,
        },
        extra,
      ) =>
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
              ...rankPerformanceItems(report[dimensionKeys[dimension]], {
                candidateItemLimit: upstreamCandidateLimits[dimension],
                limit,
                minimumSampleCount: minimumSampleCount ?? DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT,
                minimumSampleCountOverridden: minimumSampleCount !== undefined,
              }),
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );
  },
};
