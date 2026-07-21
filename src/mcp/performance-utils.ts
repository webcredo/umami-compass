import { z } from "zod";
import { UmamiError } from "../api/errors.js";
import type { PerformanceMetric, PerformanceReportRequest } from "../api/types.js";
import type { TimeInput } from "../time.js";
import { parseTimeRange } from "../time.js";
import { boundedItems, reportDateRange, reportFilters } from "./report-utils.js";
import { parseUpstream, seriesRangeQuery } from "./schemas.js";

export const PERFORMANCE_METRICS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export const PERFORMANCE_DIMENSIONS = ["page", "pageTitle", "device", "browser"] as const;

export type PerformanceDimension = (typeof PERFORMANCE_DIMENSIONS)[number];
export type PerformanceRating = "good" | "needs_improvement" | "poor";
export type PerformanceUnit = "day" | "hour" | "minute" | "month" | "year";

export const DEFAULT_BREAKDOWN_MINIMUM_SAMPLE_COUNT = 20;
export const DEFAULT_COMPARISON_MINIMUM_EVENT_COUNT = 100;

export const PERFORMANCE_THRESHOLDS: Record<PerformanceMetric, [number, number]> = {
  lcp: [2_500, 4_000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1_800, 3_000],
  ttfb: [800, 1_800],
};

export const PERFORMANCE_ABSOLUTE_CHANGE: Record<PerformanceMetric, number> = {
  lcp: 100,
  inp: 20,
  cls: 0.02,
  fcp: 100,
  ttfb: 50,
};

const MIN_PERFORMANCE_CHANGE_PERCENT = 5;

export const dimensionKeys: Record<PerformanceDimension, keyof PerformanceReport> = {
  page: "pages",
  pageTitle: "pageTitles",
  device: "devices",
  browser: "browsers",
};

export const upstreamCandidateLimits: Record<PerformanceDimension, number | null> = {
  page: 500,
  pageTitle: 500,
  device: null,
  browser: 500,
};

export const performanceReportSchema = z
  .object({
    chart: z.array(z.json()),
    summary: z.json(),
    pages: z.array(z.json()).optional(),
    pageTitles: z.array(z.json()).optional(),
    devices: z.array(z.json()).optional(),
    browsers: z.array(z.json()).optional(),
  })
  .passthrough();

export type PerformanceReport = z.infer<typeof performanceReportSchema>;

const SUPPORTED_PERFORMANCE_FILTERS = new Set([
  "browser",
  "city",
  "cohort",
  "country",
  "device",
  "language",
  "match",
  "os",
  "path",
  "region",
  "title",
]);

export interface PerformanceBreakdownRow extends Record<string, unknown> {
  count: number;
  name: string;
  p50: number;
  p75: number;
  p95: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonnegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

export function performanceRating(metric: PerformanceMetric, value: number): PerformanceRating {
  const [good, poor] = PERFORMANCE_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs_improvement" : "poor";
}

function normalizeMetricSummary(metric: PerformanceMetric, value: unknown, eventCount: number) {
  if (eventCount === 0) {
    return {
      p50: null,
      p75: null,
      p95: null,
      rating: "unavailable" as const,
      dataStatus: "empty" as const,
    };
  }
  if (!isRecord(value)) {
    return {
      p50: null,
      p75: null,
      p95: null,
      rating: "unavailable" as const,
      dataStatus: "unknown" as const,
      unavailableReason: "metric_missing_from_upstream_summary" as const,
    };
  }
  const p50 = finiteNumber(value.p50);
  const p75 = finiteNumber(value.p75);
  const p95 = finiteNumber(value.p95);
  if (
    p50 === undefined ||
    p75 === undefined ||
    p95 === undefined ||
    p50 < 0 ||
    p75 < p50 ||
    p95 < p75
  ) {
    throw new UmamiError("INVALID_RESPONSE", `Umami returned an invalid ${metric} summary.`);
  }
  if (metric !== "cls" && p50 === 0 && p75 === 0 && p95 === 0) {
    return {
      p50: null,
      p75: null,
      p95: null,
      rating: "unavailable" as const,
      dataStatus: "unknown" as const,
      unavailableReason: "zero_placeholder_or_unmeasured_metric" as const,
    };
  }
  return {
    p50,
    p75,
    p95,
    rating: performanceRating(metric, p75),
    // Umami 3.2 reports count(*) across performance events rather than
    // count(metric), so a zero percentile cannot prove that a zero value was
    // observed. Keep that limitation explicit in every normalized summary.
    dataStatus: "available" as const,
  };
}

export function normalizePerformanceSummary(value: unknown) {
  if (!isRecord(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid performance summary data.");
  }
  const eventCount = nonnegativeInteger(value.count);
  if (eventCount === undefined) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid performance summary data.");
  }
  const metrics = Object.fromEntries(
    PERFORMANCE_METRICS.map((metric) => [
      metric,
      normalizeMetricSummary(metric, value[metric], eventCount),
    ]),
  ) as Record<PerformanceMetric, ReturnType<typeof normalizeMetricSummary>>;
  return {
    dataStatus: eventCount === 0 ? ("empty" as const) : ("available" as const),
    ...(eventCount === 0 ? { emptyReason: "no_data_in_range" as const } : {}),
    performanceEventCount: eventCount,
    sampleCountScope: "all_performance_events" as const,
    metricSampleCounts: {
      status: "unavailable_upstream" as const,
      reason:
        "Umami 3.2 returns count(*) for performance events, not a non-null count for each metric.",
    },
    metrics,
  };
}

export function parsePerformanceReport(value: unknown): PerformanceReport {
  return parseUpstream(performanceReportSchema, value, "performance report");
}

export function auditPerformanceFilters(filters: Record<string, unknown> | undefined) {
  const requested = Object.entries(filters ?? {}).filter(([, value]) => value !== undefined);
  const effectiveFilters = Object.fromEntries(
    requested.filter(([name]) => SUPPORTED_PERFORMANCE_FILTERS.has(name)),
  );
  const appliedFilters = requested
    .filter(([name]) => SUPPORTED_PERFORMANCE_FILTERS.has(name))
    .map(([name]) => name)
    .sort();
  const ignoredFilters = requested
    .filter(([name]) => !SUPPORTED_PERFORMANCE_FILTERS.has(name))
    .map(([name]) => ({
      name,
      reason:
        name === "excludeBounce"
          ? "Umami 3.2 parses excludeBounce but does not use its generated join in the performance report."
          : "Umami 3.2 performance events do not persist this field consistently across supported database backends.",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    effectiveFilters,
    scope: {
      status: ignoredFilters.length > 0 ? ("partial" as const) : ("applied" as const),
      appliedFilters,
      ignoredFilters,
      semantics: "umami_performance_event_scope" as const,
    },
  };
}

export function performanceFilterScope(filters: Record<string, unknown> | undefined) {
  return auditPerformanceFilters(filters).scope;
}

export function makePerformanceRequest(input: {
  end: TimeInput;
  filters?: Record<string, unknown>;
  maxRangeDays: number;
  metric: PerformanceMetric;
  start: TimeInput;
  timezone: string;
  unit?: PerformanceUnit;
  websiteId: string;
}): PerformanceReportRequest {
  seriesRangeQuery(input.start, input.end, input.maxRangeDays, {
    timezone: input.timezone,
    unit: input.unit,
    seriesCount: 1,
  });
  return {
    websiteId: input.websiteId,
    type: "performance",
    parameters: {
      ...reportDateRange(input.start, input.end, input.maxRangeDays),
      metric: input.metric,
      timezone: input.timezone,
      ...(input.unit ? { unit: input.unit } : {}),
    },
    filters: reportFilters(input.filters),
  };
}

function bucketParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function bucketKeyFromTimestamp(timestamp: number, unit: PerformanceUnit, timezone: string) {
  const parts = bucketParts(timestamp, timezone);
  const year = parts.year ?? "";
  const month = parts.month ?? "";
  const day = parts.day ?? "";
  const hour = parts.hour ?? "";
  const minute = parts.minute ?? "";
  if (unit === "year") return year;
  if (unit === "month") return `${year}-${month}`;
  if (unit === "day") return `${year}-${month}-${day}`;
  if (unit === "hour") return `${year}-${month}-${day}T${hour}`;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function bucketKeyFromPoint(value: unknown, unit: PerformanceUnit, timezone: string) {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  if (!text) return undefined;
  if (/Z$|[+-]\d{2}:?\d{2}$/i.test(text)) {
    const timestamp = Date.parse(text);
    if (Number.isFinite(timestamp)) return bucketKeyFromTimestamp(timestamp, unit, timezone);
  }
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!match) return undefined;
  const [, year, month = "01", day = "01", hour = "00", minute = "00"] = match;
  if (unit === "year") return year;
  if (unit === "month") return `${year}-${month}`;
  if (unit === "day") return `${year}-${month}-${day}`;
  if (unit === "hour") return `${year}-${month}-${day}T${hour}`;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function partialBucketKeys(input: {
  end: TimeInput;
  maxRangeDays: number;
  now: number;
  start: TimeInput;
  timezone: string;
  unit: PerformanceUnit;
}) {
  const { startAt, endAt } = parseTimeRange(input.start, input.end, input.maxRangeDays);
  const effectiveEnd = Math.min(endAt, input.now);
  const partial = new Set<string>();
  const startKey = bucketKeyFromTimestamp(startAt, input.unit, input.timezone);
  if (startAt > 0 && bucketKeyFromTimestamp(startAt - 1, input.unit, input.timezone) === startKey) {
    partial.add(startKey);
  }
  const endKey = bucketKeyFromTimestamp(effectiveEnd, input.unit, input.timezone);
  if (bucketKeyFromTimestamp(effectiveEnd + 1, input.unit, input.timezone) === endKey) {
    partial.add(endKey);
  }
  return partial;
}

export function normalizePerformanceChart(
  chart: unknown[],
  input: {
    end: TimeInput;
    maxRangeDays: number;
    now?: number;
    start: TimeInput;
    timezone: string;
    unit?: PerformanceUnit;
  },
) {
  const unit = input.unit ?? "day";
  const partialKeys = partialBucketKeys({ ...input, now: input.now ?? Date.now(), unit });
  let pointsWithSampleCount = 0;
  const items = chart.map((value) => {
    if (!isRecord(value)) {
      throw new UmamiError("INVALID_RESPONSE", "Umami returned an invalid performance series.");
    }
    const count = nonnegativeInteger(value.count);
    if (count !== undefined) pointsWithSampleCount += 1;
    const key = bucketKeyFromPoint(value.t ?? value.timestamp, unit, input.timezone);
    return {
      ...value,
      count: count ?? null,
      partial: key !== undefined && partialKeys.has(key),
    };
  });
  return {
    items,
    sampleCounts: {
      status:
        items.length > 0 && pointsWithSampleCount === items.length
          ? ("available" as const)
          : ("unavailable_upstream" as const),
      pointsWithCount: pointsWithSampleCount,
      totalPoints: items.length,
    },
  };
}

export function parsePerformanceBreakdownRows(value: unknown) {
  if (!Array.isArray(value)) {
    throw new UmamiError(
      "INVALID_RESPONSE",
      "Umami returned an unexpected performance breakdown response.",
    );
  }
  const rows: PerformanceBreakdownRow[] = [];
  let invalidItemsExcluded = 0;
  for (const item of value) {
    if (!isRecord(item)) {
      invalidItemsExcluded += 1;
      continue;
    }
    const p50 = finiteNumber(item.p50);
    const p75 = finiteNumber(item.p75);
    const p95 = finiteNumber(item.p95);
    const count = positiveInteger(item.count);
    if (
      typeof item.name !== "string" ||
      item.name.trim() === "" ||
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
    rows.push({ ...item, name: item.name, p50, p75, p95, count });
  }
  return { rows, invalidItemsExcluded, sourceItems: value.length };
}

export function rankPerformanceItems(
  value: unknown,
  options: {
    candidateItemLimit: number | null;
    limit: number;
    minimumSampleCount: number;
    minimumSampleCountOverridden: boolean;
  },
) {
  const parsed = parsePerformanceBreakdownRows(value);
  const insufficientSampleItemsExcluded = parsed.rows.filter(
    ({ count }) => count < options.minimumSampleCount,
  ).length;
  const ranked = parsed.rows
    .filter(({ count }) => count >= options.minimumSampleCount)
    .sort(
      (left, right) =>
        right.p75 - left.p75 || right.count - left.count || left.name.localeCompare(right.name),
    );
  const candidateItemsTruncated =
    options.candidateItemLimit !== null && parsed.sourceItems >= options.candidateItemLimit;
  const status =
    ranked.length > 0
      ? { dataStatus: "available" as const }
      : parsed.sourceItems === 0
        ? { dataStatus: "empty" as const, emptyReason: "no_data_in_range" as const }
        : candidateItemsTruncated
          ? { dataStatus: "unknown" as const }
          : insufficientSampleItemsExcluded > 0
            ? {
                dataStatus: "empty" as const,
                emptyReason: "insufficient_sample_size" as const,
              }
            : { dataStatus: "unknown" as const };
  return {
    ...status,
    ...boundedItems(ranked, options.limit),
    candidateItemLimit: options.candidateItemLimit,
    candidateItemsEvaluated: parsed.sourceItems,
    candidateItemsTruncated,
    invalidItemsExcluded: parsed.invalidItemsExcluded,
    insufficientSampleItemsExcluded,
    minimumSampleCount: options.minimumSampleCount,
    minimumSampleCountOverridden: options.minimumSampleCountOverridden,
    sampleCountScope: "all_performance_events_in_row" as const,
    metricSampleCountsAvailable: false,
  };
}

export function percentChange(current: number, comparison: number): number | null {
  if (comparison === 0) return current === 0 ? 0 : null;
  return ((current - comparison) / comparison) * 100;
}

export function compareMetricValues(
  metric: PerformanceMetric,
  currentP75: number,
  comparisonP75: number,
  sufficient: boolean,
) {
  const absolute = currentP75 - comparisonP75;
  const percent = percentChange(currentP75, comparisonP75);
  const currentRating = performanceRating(metric, currentP75);
  const comparisonRating = performanceRating(metric, comparisonP75);
  const ratingOrder = { good: 0, needs_improvement: 1, poor: 2 } as const;
  const ratingDelta = ratingOrder[currentRating] - ratingOrder[comparisonRating];
  const materiallyChanged =
    Math.abs(absolute) >= PERFORMANCE_ABSOLUTE_CHANGE[metric] &&
    percent !== null &&
    Math.abs(percent) >= MIN_PERFORMANCE_CHANGE_PERCENT;
  const impact = !sufficient
    ? ("inconclusive" as const)
    : ratingDelta > 0 || (absolute > 0 && materiallyChanged)
      ? ("regressed" as const)
      : ratingDelta < 0 || (absolute < 0 && materiallyChanged)
        ? ("improved" as const)
        : ("unchanged" as const);
  return {
    currentP75,
    comparisonP75,
    absolute,
    percent,
    impact,
    material: impact === "regressed" || impact === "improved",
    currentRating,
    comparisonRating,
  };
}

export function comparePerformanceSummaries(
  currentValue: unknown,
  comparisonValue: unknown,
  minimumEventCount = DEFAULT_COMPARISON_MINIMUM_EVENT_COUNT,
) {
  const current = normalizePerformanceSummary(currentValue);
  const comparison = normalizePerformanceSummary(comparisonValue);
  const eventCountSufficient =
    current.performanceEventCount >= minimumEventCount &&
    comparison.performanceEventCount >= minimumEventCount;
  const changes = Object.fromEntries(
    PERFORMANCE_METRICS.map((metric) => {
      const currentP75 = current.metrics[metric].p75;
      const comparisonP75 = comparison.metrics[metric].p75;
      if (currentP75 === null || comparisonP75 === null) {
        return [
          metric,
          {
            currentP75,
            comparisonP75,
            absolute: null,
            percent: null,
            impact: "inconclusive" as const,
            material: false,
            currentRating: current.metrics[metric].rating,
            comparisonRating: comparison.metrics[metric].rating,
          },
        ];
      }
      return [metric, compareMetricValues(metric, currentP75, comparisonP75, eventCountSufficient)];
    }),
  ) as Record<PerformanceMetric, Record<string, unknown>>;
  const status =
    current.dataStatus === "empty" && comparison.dataStatus === "empty"
      ? ("empty" as const)
      : ("available" as const);
  return {
    status,
    ...(status === "empty" ? { emptyReason: "no_data_in_either_period" as const } : {}),
    current,
    comparison,
    minimumEventCount,
    eventCountSufficient,
    confidence:
      status === "empty"
        ? ("none" as const)
        : eventCountSufficient
          ? Math.min(current.performanceEventCount, comparison.performanceEventCount) >=
            minimumEventCount * 10
            ? ("high" as const)
            : ("medium" as const)
          : ("low" as const),
    confidenceBasis: {
      heuristic: true,
      measure: "minimum_performance_event_count_across_periods" as const,
      low: `below ${minimumEventCount}`,
      medium: `${minimumEventCount} to ${minimumEventCount * 10 - 1}`,
      high: `${minimumEventCount * 10} or more`,
      caveat: "This is a sample-readiness tier, not a statistical confidence interval.",
    },
    changes,
  };
}

export function alignPerformanceBreakdowns(
  currentValue: unknown,
  comparisonValue: unknown,
  options: {
    candidateItemLimit: number | null;
    includeInsufficient: boolean;
    limit: number;
    metric: PerformanceMetric;
    minimumSampleCount: number;
  },
) {
  const current = parsePerformanceBreakdownRows(currentValue);
  const comparison = parsePerformanceBreakdownRows(comparisonValue);
  const currentTruncated =
    options.candidateItemLimit !== null && current.sourceItems >= options.candidateItemLimit;
  const comparisonTruncated =
    options.candidateItemLimit !== null && comparison.sourceItems >= options.candidateItemLimit;
  const currentMap = new Map(current.rows.map((row) => [row.name, row]));
  const comparisonMap = new Map(comparison.rows.map((row) => [row.name, row]));
  const names = new Set([...currentMap.keys(), ...comparisonMap.keys()]);
  let omittedUncertainRows = 0;
  let insufficientSampleRows = 0;
  const rows = [...names].flatMap((name) => {
    const currentRow = currentMap.get(name);
    const comparisonRow = comparisonMap.get(name);
    if ((!currentRow && currentTruncated) || (!comparisonRow && comparisonTruncated)) {
      omittedUncertainRows += 1;
      return [];
    }
    const sufficient =
      currentRow !== undefined &&
      comparisonRow !== undefined &&
      currentRow.count >= options.minimumSampleCount &&
      comparisonRow.count >= options.minimumSampleCount;
    const hasInsufficientSample =
      (currentRow !== undefined && currentRow.count < options.minimumSampleCount) ||
      (comparisonRow !== undefined && comparisonRow.count < options.minimumSampleCount);
    if (hasInsufficientSample) insufficientSampleRows += 1;
    const change =
      currentRow && comparisonRow
        ? compareMetricValues(options.metric, currentRow.p75, comparisonRow.p75, sufficient)
        : undefined;
    return [
      {
        name,
        current: currentRow ?? null,
        comparison: comparisonRow ?? null,
        status: hasInsufficientSample
          ? ("insufficient_sample_size" as const)
          : !currentRow
            ? ("missing_current" as const)
            : !comparisonRow
              ? ("new_in_current" as const)
              : ("comparable" as const),
        ...(change ?? {
          currentP75: currentRow?.p75 ?? null,
          comparisonP75: comparisonRow?.p75 ?? null,
          absolute: null,
          percent: null,
          impact: "inconclusive" as const,
          material: false,
          currentRating:
            currentRow === undefined
              ? "unavailable"
              : performanceRating(options.metric, currentRow.p75),
          comparisonRating:
            comparisonRow === undefined
              ? "unavailable"
              : performanceRating(options.metric, comparisonRow.p75),
        }),
      },
    ];
  });
  rows.sort((left, right) => {
    const statusOrder = {
      comparable: 0,
      new_in_current: 1,
      missing_current: 1,
      insufficient_sample_size: 2,
    } as const;
    const statusDifference = statusOrder[left.status] - statusOrder[right.status];
    if (statusDifference !== 0) return statusDifference;
    const absoluteDifference =
      Math.abs(Number(right.absolute ?? 0)) - Math.abs(Number(left.absolute ?? 0));
    if (absoluteDifference !== 0) return absoluteDifference;
    return (
      Number(right.currentP75 ?? 0) - Number(left.currentP75 ?? 0) ||
      left.name.localeCompare(right.name)
    );
  });
  const includedRows = options.includeInsufficient
    ? rows
    : rows.filter(({ status }) => status !== "insufficient_sample_size");
  return {
    dataStatus:
      includedRows.length > 0
        ? ("available" as const)
        : insufficientSampleRows > 0
          ? ("empty" as const)
          : current.sourceItems === 0 && comparison.sourceItems === 0
            ? ("empty" as const)
            : ("unknown" as const),
    ...(includedRows.length === 0 && insufficientSampleRows > 0
      ? { emptyReason: "insufficient_sample_size" as const }
      : current.sourceItems === 0 && comparison.sourceItems === 0
        ? { emptyReason: "no_data_in_either_period" as const }
        : {}),
    ...boundedItems(includedRows, options.limit),
    minimumSampleCount: options.minimumSampleCount,
    includeInsufficient: options.includeInsufficient,
    dataQuality: {
      candidateItemLimit: options.candidateItemLimit,
      currentCandidateItems: current.sourceItems,
      comparisonCandidateItems: comparison.sourceItems,
      currentCandidateItemsTruncated: currentTruncated,
      comparisonCandidateItemsTruncated: comparisonTruncated,
      currentInvalidItemsExcluded: current.invalidItemsExcluded,
      comparisonInvalidItemsExcluded: comparison.invalidItemsExcluded,
      omittedUncertainRows,
      insufficientSampleRows,
      insufficientSampleRowsExcluded: options.includeInsufficient ? 0 : insufficientSampleRows,
      sampleCountScope: "all_performance_events_in_row" as const,
      metricSampleCountsAvailable: false,
    },
  };
}
