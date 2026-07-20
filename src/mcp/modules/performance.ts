import { z } from "zod";
import { UmamiError } from "../../api/errors.js";
import type { PerformanceMetric } from "../../api/types.js";
import { parseTimeRange } from "../../time.js";
import {
  alignPerformanceBreakdowns,
  comparePerformanceSummaries,
  DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT,
  DEFAULT_COMPARISON_MINIMUM_EVENT_COUNT,
  dimensionKeys,
  makePerformanceRequest,
  normalizePerformanceChart,
  normalizePerformanceSummary,
  PERFORMANCE_DIMENSIONS,
  PERFORMANCE_METRICS,
  parsePerformanceBreakdownRows,
  parsePerformanceReport,
  performanceFilterScope,
  rankPerformanceItems,
  upstreamCandidateLimits,
} from "../performance-utils.js";
import { boundedItems } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  boundedItemsDataSchema,
  outputSchema,
  performanceFiltersSchema,
  rangeQuery,
  resultMetaOutputSchema,
  routePerformanceFiltersSchema,
  timeSchema,
  timezoneSchema,
  unitSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const metricSchema = z
  .enum(PERFORMANCE_METRICS)
  .default("lcp")
  .describe("Core Web Vital or related loading metric");

const dimensionSchema = z.enum(PERFORMANCE_DIMENSIONS);
const comparisonModeSchema = z.enum(["previous", "year_over_year", "custom"]).default("previous");

const webVitalsOutputSchema = {
  data: z
    .object({
      metric: z.enum(PERFORMANCE_METRICS),
      summary: z.json(),
      chart: boundedItemsDataSchema,
      dataStatus: z.enum(["available", "empty", "unknown"]),
    })
    .passthrough(),
  ...resultMetaOutputSchema,
};

const performanceBreakdownOutputSchema = {
  data: boundedItemsDataSchema
    .extend({
      metric: z.enum(PERFORMANCE_METRICS),
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

type Period = { endAt: number; startAt: number };

function comparisonPeriod(current: Period, mode: "previous" | "year_over_year"): Period {
  if (mode === "previous") {
    const duration = current.endAt - current.startAt + 1;
    return { startAt: current.startAt - duration, endAt: current.startAt - 1 };
  }
  return {
    startAt: shiftUtcYear(current.startAt, -1),
    endAt: shiftUtcYear(current.endAt, -1),
  };
}

function shiftUtcYear(timestamp: number, years: number): number {
  const source = new Date(timestamp);
  const year = source.getUTCFullYear() + years;
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(day, lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}

function resolveComparisonPeriod(input: {
  comparisonEnd?: number | string;
  comparisonMode: "previous" | "year_over_year" | "custom";
  comparisonStart?: number | string;
  current: Period;
  maxRangeDays: number;
}): Period {
  if (input.comparisonMode === "custom") {
    if (input.comparisonStart === undefined || input.comparisonEnd === undefined) {
      throw new UmamiError(
        "VALIDATION_ERROR",
        "comparisonStart and comparisonEnd are required for comparisonMode=custom.",
      );
    }
    return parseTimeRange(input.comparisonStart, input.comparisonEnd, input.maxRangeDays);
  }
  if (input.comparisonStart !== undefined || input.comparisonEnd !== undefined) {
    throw new UmamiError(
      "VALIDATION_ERROR",
      "comparisonStart and comparisonEnd can only be used with comparisonMode=custom.",
    );
  }
  return comparisonPeriod(input.current, input.comparisonMode);
}

function isoPeriod(period: Period) {
  return {
    start: new Date(period.startAt).toISOString(),
    end: new Date(period.endAt).toISOString(),
  };
}

function currentPeriod(start: number | string, end: number | string, maxRangeDays: number): Period {
  return parseTimeRange(start, end, maxRangeDays);
}

const comparisonInputSchema = {
  comparisonMode: comparisonModeSchema,
  comparisonStart: timeSchema.optional(),
  comparisonEnd: timeSchema.optional(),
};

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseCandidateMetricRows(value: unknown) {
  if (!Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid candidate metric rows.");
  }
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const count = typeof row.y === "number" ? row.y : Number(row.y);
    return typeof row.x === "string" && Number.isFinite(count) && count > 0
      ? [{ name: row.x, count }]
      : [];
  });
}

const crossTabDimensionFilter = {
  page: "path",
  pageTitle: "title",
  device: "device",
  browser: "browser",
  country: "country",
} as const;

export const performanceModule: ToolModule = {
  id: "performance",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "get_web_vitals",
      {
        title: "Get Core Web Vitals",
        description:
          "Get normalized Umami 3.2 LCP, INP, CLS, FCP and TTFB summaries plus a bounded series for one metric. Empty data, partial buckets, filter scope and unavailable upstream sample counts are explicit.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          maxPoints: z.number().int().min(1).max(1_000).default(366),
          filters: performanceFiltersSchema.optional(),
        },
        outputSchema: webVitalsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, metric, timezone, unit, maxPoints, filters }, extra) =>
        runTool(
          async () => {
            const report = parsePerformanceReport(
              await client.runReport(
                makePerformanceRequest({
                  websiteId,
                  start,
                  end,
                  maxRangeDays: config.maxRangeDays,
                  metric,
                  timezone,
                  unit,
                  filters,
                }),
                extra.signal,
              ),
            );
            const summary = normalizePerformanceSummary(report.summary);
            const chart = normalizePerformanceChart(report.chart, {
              start,
              end,
              maxRangeDays: config.maxRangeDays,
              timezone,
              unit,
            });
            return {
              metric,
              dataStatus: summary.dataStatus,
              ...(summary.dataStatus === "empty" ? { emptyReason: "no_data_in_range" } : {}),
              summary,
              chart: {
                ...boundedItems(chart.items, maxPoints),
                sampleCounts: chart.sampleCounts,
              },
              filterScope: performanceFilterScope(filters),
              diagnostics:
                metric === "lcp"
                  ? {
                      decomposition: "unavailable_upstream" as const,
                      unavailableFields: [
                        "resourceLoadDelay",
                        "resourceLoadDuration",
                        "renderDelay",
                        "lcpElementType",
                        "lcpElementUrl",
                        "cacheStatus",
                        "edgeRegion",
                      ],
                      reason:
                        "Umami 3.2 stores aggregate LCP, FCP and TTFB values but does not expose LCP attribution or session-level decomposition through the performance report.",
                    }
                  : { decomposition: "not_applicable" as const },
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
          "Rank Web Vital percentiles by page, page title, device or browser. Rows default to 20 performance events and report the upstream limitation that per-metric non-null counts are unavailable.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          dimension: dimensionSchema,
          timezone: timezoneSchema,
          unit: unitSchema,
          limit: z.number().int().min(1).max(100).default(20),
          minimumSampleCount: z.number().int().min(1).max(1_000_000_000).optional(),
          filters: performanceFiltersSchema.optional(),
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
            const report = parsePerformanceReport(
              await client.runReport(
                makePerformanceRequest({
                  websiteId,
                  start,
                  end,
                  maxRangeDays: config.maxRangeDays,
                  metric,
                  timezone,
                  unit,
                  filters,
                }),
                extra.signal,
              ),
            );
            return {
              metric,
              dimension,
              summary: normalizePerformanceSummary(report.summary),
              filterScope: performanceFilterScope(filters),
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

    server.registerTool(
      "compare_web_vitals",
      {
        title: "Compare Core Web Vitals periods",
        description:
          "Compare all five Web Vital p75 summaries against a previous, year-over-year or custom period with ratings, materiality, event-count readiness and explicit filter scope.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          ...comparisonInputSchema,
          metric: metricSchema,
          timezone: timezoneSchema,
          minimumEventCount: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .default(DEFAULT_COMPARISON_MINIMUM_EVENT_COUNT),
          filters: performanceFiltersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          start,
          end,
          comparisonMode,
          comparisonStart,
          comparisonEnd,
          metric,
          timezone,
          minimumEventCount,
          filters,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const current = currentPeriod(start, end, config.maxRangeDays);
            const comparison = resolveComparisonPeriod({
              current,
              comparisonMode,
              comparisonStart,
              comparisonEnd,
              maxRangeDays: config.maxRangeDays,
            });
            const request = (period: Period) =>
              makePerformanceRequest({
                websiteId,
                start: period.startAt,
                end: period.endAt,
                maxRangeDays: config.maxRangeDays,
                metric,
                timezone,
                unit: "day",
                filters,
              });
            const [currentReport, comparisonReport] = await Promise.all([
              client.runReport(request(current), extra.signal).then(parsePerformanceReport),
              client.runReport(request(comparison), extra.signal).then(parsePerformanceReport),
            ]);
            return {
              comparisonMode,
              periods: { current: isoPeriod(current), comparison: isoPeriod(comparison) },
              filterScope: performanceFilterScope(filters),
              ...comparePerformanceSummaries(
                currentReport.summary,
                comparisonReport.summary,
                minimumEventCount,
              ),
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "compare_performance_breakdown",
      {
        title: "Compare a Web Vital breakdown",
        description:
          "Align page, page-title, device or browser rows across two periods. Missing capped candidates remain unknown rather than being treated as zero.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          ...comparisonInputSchema,
          metric: metricSchema,
          dimension: dimensionSchema,
          timezone: timezoneSchema,
          limit: z.number().int().min(1).max(100).default(20),
          minimumSampleCount: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .default(DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT),
          filters: performanceFiltersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          start,
          end,
          comparisonMode,
          comparisonStart,
          comparisonEnd,
          metric,
          dimension,
          timezone,
          limit,
          minimumSampleCount,
          filters,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const current = currentPeriod(start, end, config.maxRangeDays);
            const comparison = resolveComparisonPeriod({
              current,
              comparisonMode,
              comparisonStart,
              comparisonEnd,
              maxRangeDays: config.maxRangeDays,
            });
            const request = (period: Period) =>
              makePerformanceRequest({
                websiteId,
                start: period.startAt,
                end: period.endAt,
                maxRangeDays: config.maxRangeDays,
                metric,
                timezone,
                unit: "day",
                filters,
              });
            const [currentReport, comparisonReport] = await Promise.all([
              client.runReport(request(current), extra.signal).then(parsePerformanceReport),
              client.runReport(request(comparison), extra.signal).then(parsePerformanceReport),
            ]);
            return {
              metric,
              dimension,
              comparisonMode,
              periods: { current: isoPeriod(current), comparison: isoPeriod(comparison) },
              summaries: {
                current: normalizePerformanceSummary(currentReport.summary),
                comparison: normalizePerformanceSummary(comparisonReport.summary),
              },
              filterScope: performanceFilterScope(filters),
              ...alignPerformanceBreakdowns(
                currentReport[dimensionKeys[dimension]],
                comparisonReport[dimensionKeys[dimension]],
                {
                  metric: metric as PerformanceMetric,
                  candidateItemLimit: upstreamCandidateLimits[dimension],
                  limit,
                  minimumSampleCount,
                },
              ),
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "get_performance_cross_tab",
      {
        title: "Cross-tabulate Web Vitals",
        description:
          "Derive a bounded two-dimensional performance breakdown through explicit fan-out. Candidate source, request count, sample limitations and truncation are reported so the result is not mistaken for a native exhaustive pivot.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          metric: metricSchema,
          candidateDimension: z.enum([...PERFORMANCE_DIMENSIONS, "country"]),
          breakdownDimension: dimensionSchema,
          candidateLimit: z.number().int().min(1).max(10).default(5),
          rowsPerCandidate: z.number().int().min(1).max(20).default(5),
          minimumSampleCount: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .default(DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT),
          filters: performanceFiltersSchema.optional(),
          timezone: timezoneSchema,
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          start,
          end,
          metric,
          candidateDimension,
          breakdownDimension,
          candidateLimit,
          rowsPerCandidate,
          minimumSampleCount,
          filters,
          timezone,
        },
        extra,
      ) =>
        runTool(
          async () => {
            if (candidateDimension === breakdownDimension) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                "candidateDimension and breakdownDimension must be different.",
              );
            }
            const candidateFilter = crossTabDimensionFilter[candidateDimension];
            if (filters && candidateFilter in filters) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                `filters.${candidateFilter} cannot be combined with candidateDimension=${candidateDimension}.`,
              );
            }
            const baseReport = parsePerformanceReport(
              await client.runReport(
                makePerformanceRequest({
                  websiteId,
                  start,
                  end,
                  maxRangeDays: config.maxRangeDays,
                  metric,
                  timezone,
                  unit: "day",
                  filters,
                }),
                extra.signal,
              ),
            );
            let candidates: Array<{ count: number; name: string }>;
            let candidateSource: "performance_events" | "traffic_metrics";
            let candidateSourceTruncated: boolean;
            if (candidateDimension === "country") {
              const sourceLimit = Math.min(candidateLimit * 5, 50);
              const rows = parseCandidateMetricRows(
                await client.get(
                  `websites/${encodeURIComponent(websiteId)}/metrics`,
                  {
                    ...rangeQuery(start, end, config.maxRangeDays, { filters }),
                    type: "country",
                    limit: sourceLimit,
                    offset: 0,
                  },
                  extra.signal,
                ),
              );
              candidates = rows.slice(0, candidateLimit);
              candidateSource = "traffic_metrics";
              candidateSourceTruncated = rows.length >= sourceLimit;
            } else {
              const parsed = parsePerformanceBreakdownRows(
                baseReport[dimensionKeys[candidateDimension]],
              );
              candidates = parsed.rows
                .filter(({ count }) => count >= minimumSampleCount)
                .sort(
                  (left, right) => right.count - left.count || left.name.localeCompare(right.name),
                )
                .slice(0, candidateLimit)
                .map(({ name, count }) => ({ name, count }));
              candidateSource = "performance_events";
              const upstreamLimit = upstreamCandidateLimits[candidateDimension];
              candidateSourceTruncated =
                upstreamLimit !== null && parsed.sourceItems >= upstreamLimit;
            }
            const groups = await mapConcurrent(candidates, 4, async (candidate) => {
              const candidateScopedFilters = {
                ...(filters ?? {}),
                [candidateFilter]: { operator: "equals", value: candidate.name },
              };
              const report = parsePerformanceReport(
                await client.runReport(
                  makePerformanceRequest({
                    websiteId,
                    start,
                    end,
                    maxRangeDays: config.maxRangeDays,
                    metric,
                    timezone,
                    unit: "day",
                    filters: candidateScopedFilters,
                  }),
                  extra.signal,
                ),
              );
              return {
                candidate,
                summary: normalizePerformanceSummary(report.summary),
                breakdown: rankPerformanceItems(report[dimensionKeys[breakdownDimension]], {
                  candidateItemLimit: upstreamCandidateLimits[breakdownDimension],
                  limit: rowsPerCandidate,
                  minimumSampleCount,
                  minimumSampleCountOverridden: true,
                }),
              };
            });
            return {
              dataStatus: groups.some(({ breakdown }) => breakdown.dataStatus === "available")
                ? ("available" as const)
                : candidates.length === 0
                  ? ("empty" as const)
                  : ("unknown" as const),
              ...(candidates.length === 0 ? { emptyReason: "no_candidates" as const } : {}),
              metric,
              candidateDimension,
              breakdownDimension,
              filterScope: performanceFilterScope(filters),
              groups,
              dataQuality: {
                nativeCrossTab: false,
                candidateSource,
                candidateSourceTruncated,
                candidateLimit,
                candidatesEvaluated: candidates.length,
                fanoutRequests: candidates.length,
                minimumSampleCount,
                sampleCountScope: "all_performance_events_in_row" as const,
                metricSampleCountsAvailable: false,
                countryCandidateCaveat:
                  candidateDimension === "country"
                    ? "Countries are discovered from traffic because Umami 3.2 does not return a country performance breakdown; low-traffic countries with performance events may be omitted."
                    : null,
              },
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "get_route_group_performance",
      {
        title: "Analyze route-group performance",
        description:
          "Measure caller-defined route templates with exact regex-filtered performance queries instead of attempting to merge non-composable percentiles from individual URLs.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          comparisonMode: z.enum(["none", "previous", "year_over_year"]).default("previous"),
          metric: metricSchema,
          routeGroups: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(200),
                  pathRegex: z
                    .string()
                    .min(1)
                    .max(500)
                    .refine((value) => {
                      try {
                        new RegExp(value);
                        return true;
                      } catch {
                        return false;
                      }
                    }, "pathRegex must be a valid regular expression"),
                })
                .strict(),
            )
            .min(1)
            .max(20)
            .refine(
              (groups) => new Set(groups.map(({ name }) => name)).size === groups.length,
              "route group names must be unique",
            ),
          minimumEventCount: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .default(DEFAULT_COMPARISON_MINIMUM_EVENT_COUNT),
          filters: routePerformanceFiltersSchema.optional(),
          timezone: timezoneSchema,
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          start,
          end,
          comparisonMode,
          metric,
          routeGroups,
          minimumEventCount,
          filters,
          timezone,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const current = currentPeriod(start, end, config.maxRangeDays);
            const comparison =
              comparisonMode === "none" ? undefined : comparisonPeriod(current, comparisonMode);
            const groups = await mapConcurrent(routeGroups, 4, async (group) => {
              const scopedFilters = {
                ...(filters ?? {}),
                path: { operator: "regex", value: group.pathRegex },
              };
              const request = (period: Period) =>
                makePerformanceRequest({
                  websiteId,
                  start: period.startAt,
                  end: period.endAt,
                  maxRangeDays: config.maxRangeDays,
                  metric,
                  timezone,
                  unit: "day",
                  filters: scopedFilters,
                });
              const currentReport = parsePerformanceReport(
                await client.runReport(request(current), extra.signal),
              );
              if (!comparison) {
                return {
                  ...group,
                  current: normalizePerformanceSummary(currentReport.summary),
                };
              }
              const comparisonReport = parsePerformanceReport(
                await client.runReport(request(comparison), extra.signal),
              );
              return {
                ...group,
                ...comparePerformanceSummaries(
                  currentReport.summary,
                  comparisonReport.summary,
                  minimumEventCount,
                ),
              };
            });
            return {
              dataStatus: groups.some((group) => {
                if ("status" in group) return group.status === "available";
                return group.current.dataStatus === "available";
              })
                ? ("available" as const)
                : ("empty" as const),
              metric,
              comparisonMode,
              periods: {
                current: isoPeriod(current),
                ...(comparison ? { comparison: isoPeriod(comparison) } : {}),
              },
              filterScope: performanceFilterScope(filters),
              groups,
              dataQuality: {
                routeGroups: routeGroups.length,
                fanoutRequests: routeGroups.length * (comparison ? 2 : 1),
                groupsMayOverlap: true,
                percentileAggregation: "direct_filtered_query" as const,
                metricSampleCountsAvailable: false,
                regexPortability:
                  "Patterns are validated as JavaScript regexes, but PostgreSQL and ClickHouse regex dialect details may differ.",
              },
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );
  },
};
