import type { z } from "zod";
import type { UmamiClient } from "../api/client.js";
import { toSafeError, UmamiError } from "../api/errors.js";
import type { PerformanceMetric, Query, Website } from "../api/types.js";
import type { TimeInput } from "../time.js";
import { parseTimeRange } from "../time.js";
import { reportFilters } from "./report-utils.js";
import {
  appendReferrerExclusions,
  type filtersSchema,
  rangeQuery,
  serializeFilters,
} from "./schemas.js";
import {
  appendDimensionEquality,
  fetchExpandedMetricRows,
  selectChannelTotals,
  type TrafficChannel,
} from "./traffic-segmentation.js";

export const TRAFFIC_DIMENSIONS = [
  "path",
  "referrer",
  "country",
  "device",
  "channel",
  "event",
] as const;

export type TrafficDimension = (typeof TRAFFIC_DIMENSIONS)[number];

export interface TimePeriod {
  endAt: number;
  startAt: number;
}

export interface WebsiteTotals {
  bounces: number;
  pageviews: number;
  totaltime: number;
  visitors: number;
  visits: number;
}

export interface WebsiteStats extends WebsiteTotals {
  comparison?: WebsiteTotals;
}

type Filters = z.infer<typeof filtersSchema> | undefined;

function analysisFilters(filters: Filters, excludedReferrers: readonly string[] = []): Query {
  return appendReferrerExclusions(serializeFilters(filters), excludedReferrers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireNumber(record: Record<string, unknown>, key: keyof WebsiteTotals): number {
  const value = finiteNumber(record[key]);
  if (value === undefined) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid website statistics.");
  }
  return value;
}

function parseTotals(value: unknown): WebsiteTotals {
  if (!isRecord(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid website statistics.");
  }
  return {
    pageviews: requireNumber(value, "pageviews"),
    visitors: requireNumber(value, "visitors"),
    visits: requireNumber(value, "visits"),
    bounces: requireNumber(value, "bounces"),
    totaltime: requireNumber(value, "totaltime"),
  };
}

export function parseWebsiteStats(value: unknown): WebsiteStats {
  const totals = parseTotals(value);
  const comparison =
    isRecord(value) && value.comparison !== undefined ? parseTotals(value.comparison) : undefined;
  return { ...totals, ...(comparison ? { comparison } : {}) };
}

export function percentChange(current: number, comparison: number): number | null {
  if (comparison === 0) return current === 0 ? 0 : null;
  return Math.round(((current - comparison) / Math.abs(comparison)) * 10_000) / 100;
}

export function totalsChanges(current: WebsiteTotals, comparison: WebsiteTotals) {
  return Object.fromEntries(
    (Object.keys(current) as Array<keyof WebsiteTotals>).map((key) => [
      key,
      {
        absolute: current[key] - comparison[key],
        percent: percentChange(current[key], comparison[key]),
      },
    ]),
  );
}

function websiteTotals(stats: WebsiteStats): WebsiteTotals {
  return {
    pageviews: stats.pageviews,
    visitors: stats.visitors,
    visits: stats.visits,
    bounces: stats.bounces,
    totaltime: stats.totaltime,
  };
}

export function isoPeriod(period: TimePeriod) {
  return {
    start: new Date(period.startAt).toISOString(),
    end: new Date(period.endAt).toISOString(),
  };
}

export function normalizePeriod(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
): TimePeriod {
  return parseTimeRange(start, end, maxRangeDays);
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

export function comparisonPeriod(
  current: TimePeriod,
  mode: "previous" | "year_over_year",
): TimePeriod {
  if (mode === "year_over_year") {
    return {
      startAt: shiftUtcYear(current.startAt, -1),
      endAt: shiftUtcYear(current.endAt, -1),
    };
  }
  const duration = current.endAt - current.startAt;
  const endAt = current.startAt - 1;
  return { startAt: endAt - duration, endAt };
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchWebsiteStats(
  client: UmamiClient,
  websiteId: string,
  period: TimePeriod,
  maxRangeDays: number,
  filters: Filters,
  signal?: AbortSignal,
  excludedReferrers: readonly string[] = [],
): Promise<WebsiteStats> {
  return parseWebsiteStats(
    await client.get(
      `websites/${encodeURIComponent(websiteId)}/stats`,
      rangeQuery(period.startAt, period.endAt, maxRangeDays, {
        serializedFilters: analysisFilters(filters, excludedReferrers),
      }),
      signal,
    ),
  );
}

interface MetricRow {
  name: string;
  value: number;
}

interface MetricRowsResult {
  rows: MetricRow[];
  truncated: boolean;
}

const MAX_METRIC_COMPARISON_ROWS = 100;
const MAX_CHANNEL_COMPARISON_CANDIDATES = 20;

function parseMetricRows(value: unknown): MetricRow[] {
  if (!Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid metric breakdown data.");
  }
  const rows: MetricRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const number = finiteNumber(item.y);
    if (typeof item.x !== "string" || number === undefined) continue;
    rows.push({ name: item.x, value: number });
  }
  return rows;
}

async function fetchMetricRows(
  client: UmamiClient,
  websiteId: string,
  period: TimePeriod,
  maxRangeDays: number,
  dimension: TrafficDimension,
  limit: number,
  filters: Filters,
  signal?: AbortSignal,
  excludedReferrers: readonly string[] = [],
): Promise<MetricRowsResult> {
  const rows = parseMetricRows(
    await client.get(
      `websites/${encodeURIComponent(websiteId)}/metrics`,
      {
        ...rangeQuery(period.startAt, period.endAt, maxRangeDays, {
          serializedFilters: analysisFilters(filters, excludedReferrers),
        }),
        type: dimension,
        limit,
        offset: 0,
      },
      signal,
    ),
  );
  return { rows, truncated: rows.length >= limit };
}

function diffMetricRows(
  currentResult: MetricRowsResult,
  comparisonResult: MetricRowsResult,
  limit: number,
) {
  const { rows: current, truncated: currentTruncated } = currentResult;
  const { rows: comparison, truncated: comparisonTruncated } = comparisonResult;
  const names = new Set([
    ...current.map(({ name }) => name),
    ...comparison.map(({ name }) => name),
  ]);
  const currentMap = new Map(current.map(({ name, value }) => [name, value]));
  const comparisonMap = new Map(comparison.map(({ name, value }) => [name, value]));
  let omittedUncertainRows = 0;
  const rows = [...names]
    .flatMap((name) => {
      if (
        (!currentMap.has(name) && currentTruncated) ||
        (!comparisonMap.has(name) && comparisonTruncated)
      ) {
        omittedUncertainRows += 1;
        return [];
      }
      const currentValue = currentMap.get(name) ?? 0;
      const comparisonValue = comparisonMap.get(name) ?? 0;
      const delta = currentValue - comparisonValue;
      return [
        {
          name,
          current: currentValue,
          comparison: comparisonValue,
          delta,
          percent: percentChange(currentValue, comparisonValue),
          direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
        },
      ];
    })
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
  return {
    rows,
    dataQuality: {
      currentRowsTruncated: currentTruncated,
      comparisonRowsTruncated: comparisonTruncated,
      omittedUncertainRows,
    },
  };
}

export interface TrafficComparisonInput {
  channel?: TrafficChannel;
  comparison: TimePeriod;
  current: TimePeriod;
  dimensions: readonly TrafficDimension[];
  excludedReferrers?: readonly string[];
  filters?: Filters;
  limit: number;
  maxRangeDays: number;
  signal?: AbortSignal;
  website: Pick<Website, "domain" | "id" | "name">;
}

export async function compareTraffic(client: UmamiClient, input: TrafficComparisonInput) {
  const {
    channel,
    comparison,
    current,
    dimensions,
    excludedReferrers = [],
    filters,
    limit,
    maxRangeDays,
    signal,
    website,
  } = input;
  const serializedFilters = analysisFilters(filters, excludedReferrers);
  let currentTotals: WebsiteTotals;
  let comparisonTotals: WebsiteTotals;
  if (channel) {
    const channelTotals = async (period: TimePeriod): Promise<WebsiteTotals> => {
      const row = selectChannelTotals(
        await fetchExpandedMetricRows(client, {
          filters: serializedFilters,
          maxRangeDays,
          period,
          signal,
          type: "channel",
          websiteId: website.id,
        }),
        channel,
      );
      return {
        pageviews: row.pageviews,
        visitors: row.visitors,
        visits: row.visits,
        bounces: row.bounces,
        totaltime: row.totaltime,
      };
    };
    [currentTotals, comparisonTotals] = await Promise.all([
      channelTotals(current),
      channelTotals(comparison),
    ]);
  } else {
    const totals = async (period: TimePeriod) =>
      websiteTotals(
        await fetchWebsiteStats(
          client,
          website.id,
          period,
          maxRangeDays,
          filters,
          signal,
          excludedReferrers,
        ),
      );
    [currentTotals, comparisonTotals] = await Promise.all([totals(current), totals(comparison)]);
  }
  const metricFetchLimit = Math.min(MAX_METRIC_COMPARISON_ROWS, Math.max(limit * 5, 20));

  const breakdowns = await mapConcurrent(dimensions, channel ? 1 : 3, async (dimension) => {
    try {
      if (channel && dimension === "event") {
        throw new UmamiError(
          "VALIDATION_ERROR",
          "Umami cannot cross-tabulate attributed channels with custom events.",
        );
      }

      if (dimension === "channel") {
        const channelRows = async (period: TimePeriod): Promise<MetricRowsResult> => {
          const rows = await fetchExpandedMetricRows(client, {
            filters: serializedFilters,
            maxRangeDays,
            period,
            signal,
            type: "channel",
            websiteId: website.id,
          });
          return {
            rows: rows
              .filter(({ name }) => channel === undefined || name === channel)
              .map(({ name, visitors }) => ({ name, value: visitors })),
            truncated: false,
          };
        };
        const [currentChannels, comparisonChannels] = await Promise.all([
          channelRows(current),
          channelRows(comparison),
        ]);
        const difference = diffMetricRows(currentChannels, comparisonChannels, limit);
        return {
          dimension,
          status: "available" as const,
          measure: "visitors" as const,
          rows: difference.rows,
          dataQuality: difference.dataQuality,
        };
      }

      if (channel) {
        const [currentCandidates, comparisonCandidates] = await Promise.all([
          fetchMetricRows(
            client,
            website.id,
            current,
            maxRangeDays,
            dimension,
            metricFetchLimit,
            filters,
            signal,
            excludedReferrers,
          ),
          fetchMetricRows(
            client,
            website.id,
            comparison,
            maxRangeDays,
            dimension,
            metricFetchLimit,
            filters,
            signal,
            excludedReferrers,
          ),
        ]);
        const candidateScores = new Map<string, number>();
        for (const { name, value } of [...currentCandidates.rows, ...comparisonCandidates.rows]) {
          candidateScores.set(name, Math.max(candidateScores.get(name) ?? 0, value));
        }
        const allCandidates = [...candidateScores]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([name]) => name);
        const candidates = allCandidates.slice(0, MAX_CHANNEL_COMPARISON_CANDIDATES);
        let omittedUnsupportedRows = 0;
        const values = await mapConcurrent(candidates, 4, async (name) => {
          const candidateFilters = appendDimensionEquality(serializedFilters, dimension, name);
          if (!candidateFilters) {
            omittedUnsupportedRows += 1;
            return undefined;
          }
          const expanded = (period: TimePeriod) =>
            fetchExpandedMetricRows(client, {
              filters: candidateFilters,
              maxRangeDays,
              period,
              signal,
              type: "channel",
              websiteId: website.id,
            });
          const [currentRows, comparisonRows] = await Promise.all([
            expanded(current),
            expanded(comparison),
          ]);
          return {
            name,
            current: selectChannelTotals(currentRows, channel).visitors,
            comparison: selectChannelTotals(comparisonRows, channel).visitors,
          };
        });
        const difference = diffMetricRows(
          {
            rows: values.flatMap((value) =>
              value ? [{ name: value.name, value: value.current }] : [],
            ),
            truncated: false,
          },
          {
            rows: values.flatMap((value) =>
              value ? [{ name: value.name, value: value.comparison }] : [],
            ),
            truncated: false,
          },
          limit,
        );
        return {
          dimension,
          status: "available" as const,
          measure: "visitors" as const,
          rows: difference.rows,
          dataQuality: {
            ...difference.dataQuality,
            candidateRowsTruncated:
              allCandidates.length > candidates.length ||
              currentCandidates.truncated ||
              comparisonCandidates.truncated,
            candidateRows: candidates.length,
            omittedUnsupportedRows,
            fanoutRequests: candidates.length * 2,
          },
        };
      }

      const [currentRows, comparisonRows] = await Promise.all([
        fetchMetricRows(
          client,
          website.id,
          current,
          maxRangeDays,
          dimension,
          metricFetchLimit,
          filters,
          signal,
          excludedReferrers,
        ),
        fetchMetricRows(
          client,
          website.id,
          comparison,
          maxRangeDays,
          dimension,
          metricFetchLimit,
          filters,
          signal,
          excludedReferrers,
        ),
      ]);
      const difference = diffMetricRows(currentRows, comparisonRows, limit);
      return {
        dimension,
        status: "available" as const,
        measure: "visitors" as const,
        rows: difference.rows,
        dataQuality: difference.dataQuality,
      };
    } catch (error) {
      return {
        dimension,
        status: "unavailable" as const,
        error: toSafeError(error),
      };
    }
  });

  const leadingObservedChanges = breakdowns
    .filter(
      (item): item is Extract<(typeof breakdowns)[number], { status: "available" }> =>
        item.status === "available",
    )
    .flatMap((item) =>
      item.rows.slice(0, 1).map((row) => ({
        dimension: item.dimension,
        ...row,
      })),
    )
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 5);

  const pageviewDelta = currentTotals.pageviews - comparisonTotals.pageviews;
  const pageviewPercent = percentChange(currentTotals.pageviews, comparisonTotals.pageviews);
  const direction = pageviewDelta > 0 ? "increase" : pageviewDelta < 0 ? "decrease" : "flat";
  const leading = leadingObservedChanges[0];
  const subject = channel ? `${channel} channel traffic` : "Traffic";
  const explanation = leading
    ? `${subject} shows a ${direction}${pageviewPercent === null ? "" : ` of ${Math.abs(pageviewPercent)}%`}. The largest observed breakdown change is ${leading.dimension}=${leading.name} (${leading.delta > 0 ? "+" : ""}${leading.delta} visitors); this is evidence of association, not proof of causation.`
    : `${subject} shows a ${direction}${pageviewPercent === null ? "" : ` of ${Math.abs(pageviewPercent)}%`}. No authorized breakdown produced enough evidence to identify a leading observed change.`;

  return {
    dataStatus:
      currentTotals.pageviews === 0 &&
      currentTotals.visitors === 0 &&
      currentTotals.visits === 0 &&
      comparisonTotals.pageviews === 0 &&
      comparisonTotals.visitors === 0 &&
      comparisonTotals.visits === 0
        ? ("empty" as const)
        : ("available" as const),
    website,
    ...(channel ? { channel } : {}),
    currentPeriod: isoPeriod(current),
    comparisonPeriod: isoPeriod(comparison),
    current: currentTotals,
    comparison: comparisonTotals,
    changes: totalsChanges(currentTotals, comparisonTotals),
    direction,
    explanation,
    breakdownMeasure: "visitors",
    breakdowns,
    leadingObservedChanges,
    dataQuality: {
      comparisonBaselineZero: comparisonTotals.pageviews === 0,
      currentPageviews: currentTotals.pageviews,
      comparisonPageviews: comparisonTotals.pageviews,
      unavailableDimensions: breakdowns
        .filter((item) => item.status === "unavailable")
        .map(({ dimension }) => dimension),
      truncatedDimensions: breakdowns
        .filter(
          (item) =>
            item.status === "available" &&
            (item.dataQuality.currentRowsTruncated ||
              item.dataQuality.comparisonRowsTruncated ||
              ("candidateRowsTruncated" in item.dataQuality &&
                item.dataQuality.candidateRowsTruncated === true)),
        )
        .map(({ dimension }) => dimension),
      omittedUncertainRows: breakdowns
        .filter(
          (item): item is Extract<(typeof breakdowns)[number], { status: "available" }> =>
            item.status === "available",
        )
        .reduce((total, item) => total + item.dataQuality.omittedUncertainRows, 0),
    },
  };
}

const WEB_VITAL_THRESHOLDS: Record<PerformanceMetric, [number, number]> = {
  lcp: [2_500, 4_000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1_800, 3_000],
  ttfb: [800, 1_800],
};

const MIN_PERFORMANCE_SAMPLES = 100;
const MIN_PERFORMANCE_CHANGE_PERCENT = 5;
const MIN_PERFORMANCE_ABSOLUTE_CHANGE: Record<PerformanceMetric, number> = {
  lcp: 100,
  inp: 20,
  cls: 0.02,
  fcp: 100,
  ttfb: 50,
};

function vitalRating(
  metric: PerformanceMetric,
  value: number,
): "good" | "needs_improvement" | "poor" {
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs_improvement" : "poor";
}

function performanceSummary(value: unknown) {
  if (!isRecord(value) || !isRecord(value.summary)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid performance summary data.");
  }
  const summary = value.summary;
  const count = finiteNumber(summary.count);
  if (count === undefined) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid performance summary data.");
  }
  const metrics = Object.fromEntries(
    (Object.keys(WEB_VITAL_THRESHOLDS) as PerformanceMetric[]).map((metric) => {
      const row = summary[metric];
      const p75 = isRecord(row) ? finiteNumber(row.p75) : undefined;
      if (p75 === undefined) {
        throw new UmamiError(
          "INVALID_RESPONSE",
          "Umami returned invalid performance summary data.",
        );
      }
      return [metric, { p75, rating: vitalRating(metric, p75) }];
    }),
  ) as Record<PerformanceMetric, { p75: number; rating: ReturnType<typeof vitalRating> }>;
  return { count, metrics };
}

export async function comparePerformance(
  client: UmamiClient,
  input: {
    comparison: TimePeriod;
    current: TimePeriod;
    filters?: Filters;
    signal?: AbortSignal;
    timezone: string;
    websiteId: string;
  },
) {
  const request = (period: TimePeriod) => ({
    websiteId: input.websiteId,
    type: "performance" as const,
    parameters: {
      startDate: new Date(period.startAt).toISOString(),
      endDate: new Date(period.endAt).toISOString(),
      metric: "lcp" as const,
      timezone: input.timezone,
      unit: "day" as const,
    },
    filters: reportFilters(input.filters),
  });
  try {
    const [currentResult, comparisonResult] = await Promise.all([
      client.runReport(request(input.current), input.signal),
      client.runReport(request(input.comparison), input.signal),
    ]);
    const current = performanceSummary(currentResult);
    const comparison = performanceSummary(comparisonResult);
    const sampleSufficient =
      current.count >= MIN_PERFORMANCE_SAMPLES && comparison.count >= MIN_PERFORMANCE_SAMPLES;
    const changes = Object.fromEntries(
      (Object.keys(WEB_VITAL_THRESHOLDS) as PerformanceMetric[]).map((metric) => {
        const currentP75 = current.metrics[metric].p75;
        const comparisonP75 = comparison.metrics[metric].p75;
        const absolute = currentP75 - comparisonP75;
        const percent = percentChange(currentP75, comparisonP75);
        const ratingOrder = { good: 0, needs_improvement: 1, poor: 2 } as const;
        const currentRating = current.metrics[metric].rating;
        const comparisonRating = comparison.metrics[metric].rating;
        const ratingDelta = ratingOrder[currentRating] - ratingOrder[comparisonRating];
        const materiallyChanged =
          Math.abs(absolute) >= MIN_PERFORMANCE_ABSOLUTE_CHANGE[metric] &&
          percent !== null &&
          Math.abs(percent) >= MIN_PERFORMANCE_CHANGE_PERCENT;
        const impact = !sampleSufficient
          ? "inconclusive"
          : ratingDelta > 0 || (absolute > 0 && materiallyChanged)
            ? "regressed"
            : ratingDelta < 0 || (absolute < 0 && materiallyChanged)
              ? "improved"
              : "unchanged";
        return [
          metric,
          {
            currentP75,
            comparisonP75,
            absolute,
            percent,
            impact,
            material: impact === "regressed" || impact === "improved",
            currentRating,
            comparisonRating,
          },
        ];
      }),
    );
    const status =
      current.count === 0 && comparison.count === 0 ? ("empty" as const) : ("available" as const);
    return {
      status,
      currentSampleCount: current.count,
      comparisonSampleCount: comparison.count,
      minimumSampleCount: MIN_PERFORMANCE_SAMPLES,
      sampleSufficient,
      changes,
    };
  } catch (error) {
    return { status: "unavailable", error: toSafeError(error) };
  }
}
