import type { UmamiClient } from "../api/client.js";
import { UmamiError } from "../api/errors.js";
import type { BreakdownField, BreakdownReportRequest, Query } from "../api/types.js";
import { appendReferrerExclusions, rangeQuery, type TRAFFIC_CHANNELS } from "./schemas.js";

export type TrafficChannel = (typeof TRAFFIC_CHANNELS)[number];

export interface TrafficPeriod {
  endAt: number;
  startAt: number;
}

export interface ExpandedMetricRow {
  bounces: number;
  name: string;
  pageviews: number;
  totaltime: number;
  visitors: number;
  visits: number;
}

const MAX_EXPANDED_ROWS = 100;
const MAX_CHANNEL_CANDIDATES = 50;
const MIN_SUSPICIOUS_VISITS = 3;
const MIN_SUSPICIOUS_BOUNCE_RATE = 0.9;
const MAX_SUSPICIOUS_AVERAGE_DURATION_SECONDS = 2;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseExpandedMetricRows(value: unknown): ExpandedMetricRow[] {
  if (!Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid expanded metric data.");
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string") {
      throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid expanded metric data.");
    }
    const pageviews = finiteNumber(item.pageviews);
    const visitors = finiteNumber(item.visitors);
    const visits = finiteNumber(item.visits);
    const bounces = finiteNumber(item.bounces);
    const totaltime = finiteNumber(item.totaltime);
    if (
      pageviews === undefined ||
      visitors === undefined ||
      visits === undefined ||
      bounces === undefined ||
      totaltime === undefined
    ) {
      throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid expanded metric data.");
    }
    return { name: item.name, pageviews, visitors, visits, bounces, totaltime };
  });
}

export async function fetchExpandedMetricRows(
  client: UmamiClient,
  input: {
    excludedReferrers?: readonly string[];
    filters?: Query;
    maxRangeDays: number;
    period: TrafficPeriod;
    signal?: AbortSignal;
    type: string;
    websiteId: string;
  },
): Promise<ExpandedMetricRow[]> {
  const serializedFilters = appendReferrerExclusions(
    input.filters ?? {},
    input.excludedReferrers ?? [],
  );
  return parseExpandedMetricRows(
    await client.get(
      `websites/${encodeURIComponent(input.websiteId)}/metrics/expanded`,
      {
        ...rangeQuery(input.period.startAt, input.period.endAt, input.maxRangeDays, {
          serializedFilters,
        }),
        type: input.type,
        limit: MAX_EXPANDED_ROWS,
        offset: 0,
      },
      input.signal,
    ),
  );
}

function longestConsonantRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (/[a-z]/.test(character) && !/[aeiouy]/.test(character)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksGeneratedDomain(domain: string): boolean {
  const hostname = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/, 1)[0]
    ?.replace(/^www\./, "")
    .replace(/:\d+$/, "");
  const labels = hostname?.split(".").filter(Boolean) ?? [];
  const label = (labels.length > 1 ? labels.slice(0, -1) : labels).sort(
    (left, right) => right.length - left.length,
  )[0];
  if (!label) return false;
  const letters = label.replace(/[^a-z]/g, "");
  if (letters.length < 12) return false;
  const vowels = [...letters].filter((character) => /[aeiouy]/.test(character)).length;
  return (
    shannonEntropy(letters) >= 3.1 &&
    (vowels / letters.length < 0.24 || longestConsonantRun(letters) >= 6)
  );
}

export interface SuspiciousReferrer extends ExpandedMetricRow {
  averageVisitDurationSeconds: number;
  bounceRatePercent: number;
  confidence: "high" | "medium";
  reasons: string[];
}

export async function assessReferralSpam(
  client: UmamiClient,
  input: {
    filters?: Query;
    maxRangeDays: number;
    period: TrafficPeriod;
    signal?: AbortSignal;
    websiteId: string;
  },
) {
  const rows = await fetchExpandedMetricRows(client, {
    ...input,
    type: "referrer",
  });
  const suspiciousReferrers = rows.flatMap((row): SuspiciousReferrer[] => {
    const bounceRate = row.visits === 0 ? 0 : row.bounces / row.visits;
    const averageVisitDurationSeconds = row.visits === 0 ? 0 : row.totaltime / row.visits;
    const generatedDomain = looksGeneratedDomain(row.name);
    if (
      !generatedDomain ||
      row.visits < MIN_SUSPICIOUS_VISITS ||
      bounceRate < MIN_SUSPICIOUS_BOUNCE_RATE ||
      averageVisitDurationSeconds > MAX_SUSPICIOUS_AVERAGE_DURATION_SECONDS
    ) {
      return [];
    }
    const reasons = [
      "generated_domain_pattern",
      "very_high_bounce_rate",
      "near_zero_visit_duration",
    ];
    return [
      {
        ...row,
        bounceRatePercent: Math.round(bounceRate * 10_000) / 100,
        averageVisitDurationSeconds: Math.round(averageVisitDurationSeconds * 100) / 100,
        confidence:
          row.visits >= 20 && bounceRate >= 0.95 && averageVisitDurationSeconds <= 1
            ? "high"
            : "medium",
        reasons,
      },
    ];
  });

  return {
    suspiciousReferrers,
    excludedReferrers: suspiciousReferrers.map(({ name }) => name),
    dataQuality: {
      sourceRows: rows.length,
      sourceRowsTruncated: rows.length >= MAX_EXPANDED_ROWS,
      heuristic: true,
      thresholds: {
        minimumVisits: MIN_SUSPICIOUS_VISITS,
        minimumBounceRatePercent: MIN_SUSPICIOUS_BOUNCE_RATE * 100,
        maximumAverageVisitDurationSeconds: MAX_SUSPICIOUS_AVERAGE_DURATION_SECONDS,
      },
    },
  };
}

export function selectChannelTotals(
  rows: readonly ExpandedMetricRow[],
  channel: TrafficChannel,
): ExpandedMetricRow {
  return (
    rows.find(({ name }) => name === channel) ?? {
      name: channel,
      pageviews: 0,
      visitors: 0,
      visits: 0,
      bounces: 0,
      totaltime: 0,
    }
  );
}

function nextFilterKey(filters: Query, field: string): string {
  const upstreamField = field === "referrer" ? "domain" : field;
  let suffix = field === "referrer" ? 1 : 0;
  while ((suffix === 0 ? upstreamField : `${upstreamField}${suffix}`) in filters) suffix += 1;
  return suffix === 0 ? upstreamField : `${upstreamField}${suffix}`;
}

export function appendDimensionEquality(
  filters: Query,
  field: string,
  value: string,
): Query | undefined {
  if (value.includes(",")) return undefined;
  if (filters.match === "any") {
    throw new UmamiError(
      "VALIDATION_ERROR",
      'Derived channel cross-tabs cannot be combined with filters.match="any" because Umami cannot require candidate predicates outside that OR group.',
    );
  }
  return { ...filters, [nextFilterKey(filters, field)]: `eq.${value}` };
}

function requireRowFields(row: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, string> = {};
  for (const field of fields) {
    if (typeof row[field] !== "string") {
      throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid breakdown candidate data.");
    }
    result[field] = row[field];
  }
  return result;
}

export async function runDerivedChannelBreakdown(
  client: UmamiClient,
  input: {
    channel?: TrafficChannel;
    excludedReferrers?: readonly string[];
    fields: readonly (BreakdownField | "channel")[];
    filters: Query;
    limit: number;
    maxRangeDays: number;
    period: TrafficPeriod;
    signal?: AbortSignal;
    websiteId: string;
  },
) {
  const dimensions = input.fields.filter((field) => field !== "channel") as BreakdownField[];
  const baseFilters = appendReferrerExclusions(input.filters, input.excludedReferrers ?? []);
  let candidates: Array<{ values: Record<string, string> }> = [{ values: {} }];
  let sourceRowsTruncated = false;
  let omittedUnsupportedRows = 0;

  if (dimensions.length > 0) {
    const request: BreakdownReportRequest = {
      websiteId: input.websiteId,
      type: "breakdown",
      parameters: {
        startDate: new Date(input.period.startAt).toISOString(),
        endDate: new Date(input.period.endAt).toISOString(),
        fields: dimensions,
      },
      filters: baseFilters,
    };
    const result = await client.runReport(request, input.signal);
    if (!Array.isArray(result)) {
      throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid breakdown candidate data.");
    }
    const candidateLimit = Math.min(MAX_CHANNEL_CANDIDATES, Math.max(input.limit * 3, 20));
    sourceRowsTruncated = result.length > candidateLimit || result.length >= 500;
    candidates = result.slice(0, candidateLimit).map((candidate) => {
      if (!isRecord(candidate)) {
        throw new UmamiError(
          "INVALID_RESPONSE",
          "Umami returned invalid breakdown candidate data.",
        );
      }
      return { values: requireRowFields(candidate, dimensions) };
    });
  }

  const derived = await mapConcurrent(candidates, 4, async (candidate) => {
    let filters: Query | undefined = baseFilters;
    const { values } = candidate;
    for (const [field, value] of Object.entries(values)) {
      filters = appendDimensionEquality(filters, field, value);
      if (!filters) {
        omittedUnsupportedRows += 1;
        return [];
      }
    }
    const channels = await fetchExpandedMetricRows(client, {
      filters,
      maxRangeDays: input.maxRangeDays,
      period: input.period,
      signal: input.signal,
      type: "channel",
      websiteId: input.websiteId,
    });
    return channels
      .filter(({ name }) => input.channel === undefined || name === input.channel)
      .map(({ name, ...metrics }) => ({
        ...values,
        ...(input.fields.includes("channel") ? { channel: name } : {}),
        ...metrics,
      }));
  });

  const rows = derived
    .flat()
    .sort(
      (left, right) =>
        right.visitors - left.visitors ||
        right.pageviews - left.pageviews ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return {
    rows,
    dataQuality: {
      derivedChannelBreakdown: true,
      upstreamCandidateRows: candidates.length,
      sourceRowsTruncated,
      omittedUnsupportedRows,
      fanoutRequests: candidates.length,
    },
  };
}
