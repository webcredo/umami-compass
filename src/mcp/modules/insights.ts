import { z } from "zod";
import { toSafeError, UmamiError } from "../../api/errors.js";
import type { PagedResponse, Query, Website } from "../../api/types.js";
import { parseTimeRange } from "../../time.js";
import {
  alignTrafficSeries,
  comparePerformance,
  compareTraffic,
  comparisonPeriod,
  fetchWebsiteStats,
  finiteNumber,
  isoPeriod,
  mapConcurrent,
  normalizePeriod,
  percentChange,
  type TimePeriod,
  TRAFFIC_DIMENSIONS,
  type TrafficDimension,
  totalsChanges,
  type WebsiteTotals,
} from "../insights-utils.js";
import { requirePagedResponse } from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  appendReferrerExclusions,
  filtersSchema,
  outputSchema,
  pageviewsDataSchema,
  parseUpstream,
  rangeQuery,
  segmentedFiltersSchema,
  serializeFilters,
  seriesRangeQuery,
  timeSchema,
  timezoneSchema,
  trafficSegmentSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";
import {
  assessReferralSpam,
  type TrafficChannel,
  type TrafficPeriod,
} from "../traffic-segmentation.js";

const trafficDimensionSchema = z.enum(TRAFFIC_DIMENSIONS);
const websiteLimitSchema = z.number().int().min(1).max(50).default(25);
const MIN_RELEASE_TRAFFIC_CHANGE_PERCENT = 10;
const MIN_RELEASE_TRAFFIC_PAGEVIEWS = 500;
const MIN_RELEASE_AUDIENCE_SAMPLES = 100;
const MAX_RELEASE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releaseTimestampSchema = timeSchema.refine(
  (value) =>
    typeof value === "number" || (/T/i.test(value) && /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())),
  "releaseAt must be Unix milliseconds or an ISO 8601 date-time with an explicit timezone",
);
const otherReleaseSchema = z
  .object({
    releaseAt: releaseTimestampSchema,
    id: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(1_000).optional(),
  })
  .strict();

function materialDirection(percent: number | null | undefined) {
  if (percent === null || percent === undefined) return "neutral" as const;
  if (percent >= MIN_RELEASE_TRAFFIC_CHANGE_PERCENT) return "positive" as const;
  if (percent <= -MIN_RELEASE_TRAFFIC_CHANGE_PERCENT) return "negative" as const;
  return "neutral" as const;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

async function safeReferralSpamAssessment(
  client: Parameters<typeof assessReferralSpam>[0],
  input: {
    filters: Query;
    maxRangeDays: number;
    period: TrafficPeriod;
    signal?: AbortSignal;
    websiteId: string;
  },
) {
  try {
    return { status: "available" as const, ...(await assessReferralSpam(client, input)) };
  } catch (error) {
    return { status: "unavailable" as const, error: toSafeError(error) };
  }
}

async function trafficQualityComparison(
  client: Parameters<typeof assessReferralSpam>[0],
  input: {
    comparison: TrafficPeriod;
    current: TrafficPeriod;
    filters: Query;
    maxRangeDays: number;
    signal?: AbortSignal;
    trafficSegment: "all" | "human";
    websiteId: string;
  },
) {
  const assess = (period: TrafficPeriod) =>
    safeReferralSpamAssessment(client, {
      filters: input.filters,
      maxRangeDays: input.maxRangeDays,
      period,
      signal: input.signal,
      websiteId: input.websiteId,
    });
  const [current, comparison] = await Promise.all([
    assess(input.current),
    assess(input.comparison),
  ]);
  if (
    input.trafficSegment === "human" &&
    (current.status !== "available" || comparison.status !== "available")
  ) {
    throw new UmamiError(
      "UPSTREAM_ERROR",
      "The human-traffic preset could not assess referral spam for both periods.",
    );
  }
  const excludedReferrers =
    input.trafficSegment === "human"
      ? [
          ...new Set(
            [current, comparison].flatMap((assessment) =>
              assessment.status === "available" ? assessment.excludedReferrers : [],
            ),
          ),
        ]
      : [];
  return {
    method: "conservative_heuristic" as const,
    trafficSegment: input.trafficSegment,
    current,
    comparison,
    excludedReferrers,
    exclusionApplied: excludedReferrers.length > 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function websitePage(value: unknown): PagedResponse<Website> {
  const page = requirePagedResponse(value);
  if (
    !page.data.every((item) => isRecord(item) && typeof item.id === "string" && item.id.length > 0)
  ) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned an invalid website list.");
  }
  return page as PagedResponse<Website>;
}

function websiteSummary(website: Website) {
  return {
    id: website.id,
    ...(typeof website.name === "string" ? { name: website.name } : {}),
    ...(typeof website.domain === "string" ? { domain: website.domain } : {}),
    ...(typeof website.teamId === "string" ? { teamId: website.teamId } : {}),
  };
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return (
      trimmed
        .replace(/^https?:\/\//, "")
        .split(/[/?#]/, 1)[0]
        ?.replace(/^www\./, "")
        .replace(/\.$/, "") ?? trimmed
    );
  }
}

function scoreWebsite(website: Website, query: string, normalizedDomain: string) {
  const id = website.id.toLowerCase();
  const name = typeof website.name === "string" ? website.name.trim().toLowerCase() : "";
  const domain = typeof website.domain === "string" ? normalizeDomain(website.domain) : "";
  if (id === query) return { score: 100, matchType: "id" as const, confidence: "exact" as const };
  if (domain && domain === normalizedDomain) {
    return { score: 95, matchType: "domain" as const, confidence: "exact" as const };
  }
  if (name && name === query) {
    return { score: 90, matchType: "name" as const, confidence: "exact" as const };
  }
  if (domain && (domain.startsWith(normalizedDomain) || normalizedDomain.startsWith(domain))) {
    return { score: 70, matchType: "domain" as const, confidence: "strong" as const };
  }
  if (name?.startsWith(query)) {
    return { score: 65, matchType: "name" as const, confidence: "strong" as const };
  }
  if (domain?.includes(normalizedDomain) || name?.includes(query)) {
    return {
      score: 50,
      matchType: domain.includes(normalizedDomain) ? ("domain" as const) : ("name" as const),
      confidence: "fuzzy" as const,
    };
  }
  return { score: 0, matchType: "none" as const, confidence: "none" as const };
}

function dateValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function currentTotals(stats: Awaited<ReturnType<typeof fetchWebsiteStats>>): WebsiteTotals {
  return {
    pageviews: stats.pageviews,
    visitors: stats.visitors,
    visits: stats.visits,
    bounces: stats.bounces,
    totaltime: stats.totaltime,
  };
}

const ZERO_TOTALS: WebsiteTotals = {
  pageviews: 0,
  visitors: 0,
  visits: 0,
  bounces: 0,
  totaltime: 0,
};

function sumTotals(values: WebsiteTotals[]): WebsiteTotals {
  return values.reduce(
    (total, value) => ({
      pageviews: total.pageviews + value.pageviews,
      visitors: total.visitors + value.visitors,
      visits: total.visits + value.visits,
      bounces: total.bounces + value.bounces,
      totaltime: total.totaltime + value.totaltime,
    }),
    { ...ZERO_TOTALS },
  );
}

async function portfolioSite(
  client: Parameters<typeof fetchWebsiteStats>[0],
  website: Website,
  period: TimePeriod,
  baselinePeriod: TimePeriod,
  maxRangeDays: number,
  staleAfterHours: number,
  anomalyThresholdPercent: number,
  anomalyMinimumPageviews: number,
  now: number,
  signal?: AbortSignal,
) {
  try {
    const [stats, baselineStats, dateRangeResult] = await Promise.all([
      fetchWebsiteStats(client, website.id, period, maxRangeDays, undefined, signal),
      fetchWebsiteStats(client, website.id, baselinePeriod, maxRangeDays, undefined, signal),
      client
        .get(`websites/${encodeURIComponent(website.id)}/daterange`, undefined, signal)
        .catch((error) => ({ dateRangeError: toSafeError(error) })),
    ]);
    const current = currentTotals(stats);
    const comparison = currentTotals(baselineStats);
    const lastDataAt =
      isRecord(dateRangeResult) && !("dateRangeError" in dateRangeResult)
        ? dateValue(dateRangeResult.endDate)
        : undefined;
    const freshnessUnavailable = isRecord(dateRangeResult) && "dateRangeError" in dateRangeResult;
    const stale =
      !freshnessUnavailable &&
      (lastDataAt === undefined || now - lastDataAt > staleAfterHours * 3_600_000);
    const pageviewPercent = percentChange(current.pageviews, comparison.pageviews);
    const anomalous =
      (comparison.pageviews === 0 && current.pageviews >= anomalyMinimumPageviews) ||
      (pageviewPercent !== null &&
        Math.abs(pageviewPercent) >= anomalyThresholdPercent &&
        Math.max(current.pageviews, comparison.pageviews) >= anomalyMinimumPageviews);
    const dataStatus = freshnessUnavailable
      ? "freshness_unknown"
      : lastDataAt === undefined
        ? "never_tracked"
        : current.pageviews === 0
          ? "no_data_in_range"
          : stale
            ? "stale"
            : "fresh";
    return {
      status: "available" as const,
      website: websiteSummary(website),
      current,
      comparison,
      changes: totalsChanges(current, comparison),
      tracking: {
        dataStatus,
        ...(lastDataAt === undefined ? {} : { lastDataAt: new Date(lastDataAt).toISOString() }),
        stale,
        ...(isRecord(dateRangeResult) && "dateRangeError" in dateRangeResult
          ? { dateRangeError: dateRangeResult.dateRangeError }
          : {}),
      },
      anomaly: anomalous
        ? {
            metric: "pageviews",
            percent: pageviewPercent,
            direction:
              comparison.pageviews === 0
                ? "new_activity"
                : (pageviewPercent ?? 0) > 0
                  ? "spike"
                  : "drop",
          }
        : null,
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      website: websiteSummary(website),
      error: toSafeError(error),
    };
  }
}

function parseMetricNames(value: unknown): Array<{ name: string; value: number }> {
  if (!Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid metric data.");
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.x !== "string") return [];
    const number = finiteNumber(item.y);
    return number === undefined ? [] : [{ name: item.x, value: number }];
  });
}

type HealthCheckName = "traffic" | "domain" | "events" | "recorder" | "referral_spam";

async function healthSite(
  client: Parameters<typeof fetchWebsiteStats>[0],
  website: Website,
  period: TimePeriod,
  options: {
    checks: readonly HealthCheckName[];
    dropThresholdPercent: number;
    expectEvents: boolean;
    expectHeatmap: boolean;
    expectReplay: boolean;
    maxRangeDays: number;
    minimumPageviews: number;
    signal?: AbortSignal;
    staleAfterHours: number;
  },
) {
  const issues: Array<{
    check: HealthCheckName;
    code: string;
    evidence?: unknown;
    message: string;
    severity: "error" | "warning";
  }> = [];
  const checks: Record<string, unknown> = {};

  await mapConcurrent(options.checks, 1, async (check) => {
    try {
      if (check === "traffic") {
        const [stats, baselineStats, range] = await Promise.all([
          fetchWebsiteStats(
            client,
            website.id,
            period,
            options.maxRangeDays,
            undefined,
            options.signal,
          ),
          fetchWebsiteStats(
            client,
            website.id,
            comparisonPeriod(period, "previous"),
            options.maxRangeDays,
            undefined,
            options.signal,
          ),
          client.get<Record<string, unknown>>(
            `websites/${encodeURIComponent(website.id)}/daterange`,
            undefined,
            options.signal,
          ),
        ]);
        const lastDataAt = dateValue(range.endDate);
        const comparison = currentTotals(baselineStats);
        const change = percentChange(stats.pageviews, comparison.pageviews);
        checks.traffic = {
          status: "available",
          pageviews: stats.pageviews,
          comparisonPageviews: comparison.pageviews,
          changePercent: change,
          ...(lastDataAt === undefined ? {} : { lastDataAt: new Date(lastDataAt).toISOString() }),
        };
        if (lastDataAt === undefined) {
          issues.push({
            check,
            code: "NO_ANALYTICS_DATA",
            message: "The website has no discoverable analytics data range.",
            severity: "error",
          });
        } else if (Date.now() - lastDataAt > options.staleAfterHours * 3_600_000) {
          issues.push({
            check,
            code: "STALE_TRACKING",
            message:
              "The most recent analytics event is older than the configured freshness limit.",
            severity: "warning",
            evidence: { lastDataAt: new Date(lastDataAt).toISOString() },
          });
        }
        if (stats.pageviews === 0) {
          issues.push({
            check,
            code: "NO_TRAFFIC_IN_LOOKBACK",
            message: "No pageviews were recorded in the health-check lookback window.",
            severity: "warning",
          });
        } else if (
          change !== null &&
          change <= -options.dropThresholdPercent &&
          comparison.pageviews >= options.minimumPageviews
        ) {
          issues.push({
            check,
            code: "TRAFFIC_DROP",
            message: "Pageviews dropped beyond the configured threshold.",
            severity: "warning",
            evidence: { changePercent: change },
          });
        }
        return;
      }

      if (check === "domain") {
        const hostnames = parseMetricNames(
          await client.get(
            `websites/${encodeURIComponent(website.id)}/metrics`,
            {
              ...rangeQuery(period.startAt, period.endAt, options.maxRangeDays),
              type: "hostname",
              limit: 10,
              offset: 0,
            },
            options.signal,
          ),
        );
        const configuredDomain =
          typeof website.domain === "string" ? normalizeDomain(website.domain) : "";
        const observedDomains = hostnames.map(({ name }) => normalizeDomain(name));
        checks.domain = {
          status: "available",
          configuredDomain: configuredDomain || null,
          observedHostnames: hostnames,
        };
        if (!configuredDomain) {
          issues.push({
            check,
            code: "DOMAIN_MISSING",
            message: "The Umami website has no configured domain.",
            severity: "warning",
          });
        } else if (
          observedDomains.length > 0 &&
          !observedDomains.some(
            (domain) => domain === configuredDomain || domain.endsWith(`.${configuredDomain}`),
          )
        ) {
          issues.push({
            check,
            code: "DOMAIN_MISMATCH",
            message: "Recent observed hostnames do not match the configured website domain.",
            severity: "warning",
            evidence: { configuredDomain, observedDomains },
          });
        }
        return;
      }

      if (check === "events") {
        const page = requirePagedResponse(
          await client.get(
            `websites/${encodeURIComponent(website.id)}/events`,
            {
              ...rangeQuery(period.startAt, period.endAt, options.maxRangeDays, {
                filters: { eventType: 2 },
              }),
              page: 1,
              pageSize: 1,
            },
            options.signal,
          ),
        );
        checks.events = { status: "available", count: page.count };
        if (options.expectEvents && page.count === 0) {
          issues.push({
            check,
            code: "EXPECTED_EVENTS_MISSING",
            message: "No custom events were recorded in the health-check lookback window.",
            severity: "warning",
          });
        }
        return;
      }

      if (check === "referral_spam") {
        const assessment = await assessReferralSpam(client, {
          filters: {},
          maxRangeDays: options.maxRangeDays,
          period,
          signal: options.signal,
          websiteId: website.id,
        });
        checks.referral_spam = { status: "available", ...assessment };
        if (assessment.suspiciousReferrers.length > 0) {
          issues.push({
            check,
            code: "SUSPECTED_REFERRAL_SPAM",
            message:
              "One or more referrers match a conservative generated-domain, high-bounce, near-zero-duration spam pattern.",
            severity: "warning",
            evidence: {
              suspiciousReferrers: assessment.suspiciousReferrers,
              heuristic: true,
            },
          });
        }
        return;
      }

      const recorder = await client.get<Record<string, unknown>>(
        `websites/${encodeURIComponent(website.id)}/recorder`,
        undefined,
        options.signal,
      );
      checks.recorder = {
        status: "available",
        enabled: recorder.enabled === true,
        replayEnabled: recorder.replayEnabled === true,
        heatmapEnabled: recorder.heatmapEnabled === true,
        ...(finiteNumber(recorder.sampleRate) === undefined
          ? {}
          : { sampleRate: finiteNumber(recorder.sampleRate) }),
      };
      if ((options.expectReplay || options.expectHeatmap) && recorder.enabled !== true) {
        issues.push({
          check,
          code: "RECORDER_DISABLED",
          message: "Recorder is disabled although a recorder feature is expected.",
          severity: "warning",
        });
      } else {
        if (options.expectReplay && recorder.replayEnabled !== true) {
          issues.push({
            check,
            code: "REPLAY_DISABLED",
            message: "Session replay is disabled but expected.",
            severity: "warning",
          });
        }
        if (options.expectHeatmap && recorder.heatmapEnabled !== true) {
          issues.push({
            check,
            code: "HEATMAP_DISABLED",
            message: "Heatmaps are disabled but expected.",
            severity: "warning",
          });
        }
      }
    } catch (error) {
      const safeError = toSafeError(error);
      checks[check] = { status: "unavailable", error: safeError };
      const unavailableIsWarning = safeError.code === "FORBIDDEN" || check === "referral_spam";
      issues.push({
        check,
        code: safeError.code === "FORBIDDEN" ? "PERMISSION_MISSING" : "CHECK_UNAVAILABLE",
        message: safeError.message,
        severity: unavailableIsWarning ? "warning" : "error",
      });
    }
  });

  return {
    website: websiteSummary(website),
    status: issues.some(({ severity }) => severity === "error")
      ? "error"
      : issues.length > 0
        ? "warning"
        : "healthy",
    checks,
    issues,
  };
}

export const insightsModule: ToolModule = {
  id: "insights",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "resolve_website",
      {
        title: "Resolve an Umami website",
        description:
          "Resolve a website UUID from a UUID, domain, URL, or website name. Ambiguous matches return bounded candidates instead of guessing.",
        inputSchema: {
          query: z.string().trim().min(1).max(500),
          candidateLimit: z.number().int().min(1).max(20).default(10),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ query, candidateLimit }, extra) =>
        runTool(async () => {
          const normalizedQuery = query.trim().toLowerCase();
          if (UUID_PATTERN.test(normalizedQuery)) {
            try {
              const website = await client.getWebsite(normalizedQuery, extra.signal);
              return {
                status: "resolved",
                matchType: "id",
                confidence: "exact",
                website: websiteSummary(website),
              };
            } catch (error) {
              if (!(error instanceof UmamiError) || error.code !== "NOT_FOUND") throw error;
              return { status: "not_found", candidates: [] };
            }
          }

          const domain = normalizeDomain(query);
          const page = websitePage(
            await client.listWebsites(
              { page: 1, pageSize: 100, search: domain || normalizedQuery },
              extra.signal,
            ),
          );
          const candidates = page.data
            .map((website) => ({ website, ...scoreWebsite(website, normalizedQuery, domain) }))
            .filter(({ score }) => score > 0)
            .sort(
              (left, right) =>
                right.score - left.score ||
                String(left.website.name ?? left.website.domain ?? left.website.id).localeCompare(
                  String(right.website.name ?? right.website.domain ?? right.website.id),
                ),
            )
            .slice(0, candidateLimit);
          if (candidates.length === 0) return { status: "not_found", candidates: [] };
          const [best, second] = candidates;
          if (best?.confidence === "exact" && (!second || best.score > second.score)) {
            return {
              status: "resolved",
              matchType: best.matchType,
              confidence: best.confidence,
              website: websiteSummary(best.website),
              candidatesConsidered: page.count,
            };
          }
          return {
            status: "ambiguous",
            candidates: candidates.map(({ website, matchType, confidence, score }) => ({
              website: websiteSummary(website),
              matchType,
              confidence,
              score,
            })),
          };
        }),
    );

    server.registerTool(
      "get_portfolio_overview",
      {
        title: "Get a portfolio analytics overview",
        description:
          "Summarize bounded aggregate traffic across visible websites, including period changes, growth and decline leaders, stale tracking, failures, and suspicious jumps.",
        inputSchema: {
          start: timeSchema,
          end: timeSchema,
          websiteLimit: websiteLimitSchema,
          staleAfterHours: z.number().int().min(1).max(8_760).default(48),
          anomalyThresholdPercent: z.number().min(10).max(10_000).default(100),
          anomalyMinimumPageviews: z.number().int().min(0).max(1_000_000_000).default(100),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          start,
          end,
          websiteLimit,
          staleAfterHours,
          anomalyThresholdPercent,
          anomalyMinimumPageviews,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const period = normalizePeriod(start, end, config.maxRangeDays);
            const page = websitePage(
              await client.listWebsites({ page: 1, pageSize: websiteLimit }, extra.signal),
            );
            const now = Date.now();
            const baselinePeriod = comparisonPeriod(period, "previous");
            const sites = await mapConcurrent(page.data, 4, (website) =>
              portfolioSite(
                client,
                website,
                period,
                baselinePeriod,
                config.maxRangeDays,
                staleAfterHours,
                anomalyThresholdPercent,
                anomalyMinimumPageviews,
                now,
                extra.signal,
              ),
            );
            const available = sites.filter(
              (site): site is Extract<(typeof sites)[number], { status: "available" }> =>
                site.status === "available",
            );
            const unavailable = sites.filter(
              (site): site is Extract<(typeof sites)[number], { status: "unavailable" }> =>
                site.status === "unavailable",
            );
            const current = sumTotals(available.map(({ current: totals }) => totals));
            const comparison = sumTotals(available.map(({ comparison: totals }) => totals));
            const dataStatus =
              available.length === 0
                ? unavailable.length > 0
                  ? ("unknown" as const)
                  : ("empty" as const)
                : current.pageviews === 0 &&
                    current.visitors === 0 &&
                    current.visits === 0 &&
                    comparison.pageviews === 0 &&
                    comparison.visitors === 0 &&
                    comparison.visits === 0
                  ? ("empty" as const)
                  : ("available" as const);
            const ranked = available
              .map((site) => ({
                website: site.website,
                currentPageviews: site.current.pageviews,
                comparisonPageviews: site.comparison.pageviews,
                percent: percentChange(site.current.pageviews, site.comparison.pageviews),
              }))
              .filter((site): site is typeof site & { percent: number } => site.percent !== null);
            return {
              dataStatus,
              generatedAt: new Date(now).toISOString(),
              period: isoPeriod(period),
              comparisonPeriod: isoPeriod(baselinePeriod),
              coverage: {
                visibleWebsites: page.count,
                analyzedWebsites: sites.length,
                successfulWebsites: available.length,
                failedWebsites: unavailable.length,
                websiteLimit,
                websitesTruncated: page.count > sites.length,
              },
              totals: {
                current,
                comparison,
                changes: totalsChanges(current, comparison),
              },
              leaders: {
                growth: ranked
                  .filter(({ percent }) => percent > 0)
                  .sort((a, b) => b.percent - a.percent)
                  .slice(0, 5),
                decline: ranked
                  .filter(({ percent }) => percent < 0)
                  .sort((a, b) => a.percent - b.percent)
                  .slice(0, 5),
              },
              attention: {
                staleOrMissing: available
                  .filter(({ tracking }) => tracking.dataStatus !== "fresh")
                  .map(({ website, tracking }) => ({ website, tracking })),
                anomalies: available
                  .filter(({ anomaly }) => anomaly !== null)
                  .map(({ website, anomaly }) => ({ website, anomaly })),
                failures: unavailable,
              },
              sites,
            };
          },
          { range: { start, end } },
        ),
    );

    server.registerTool(
      "explain_traffic_change",
      {
        title: "Explain a traffic change",
        description:
          "Compare traffic with a previous, year-over-year, or custom period and rank observed changes across pages, referrers, countries, devices, channels, and events. Results describe association, not causation.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          comparisonMode: z.enum(["previous", "year_over_year", "custom"]).default("previous"),
          comparisonStart: timeSchema.optional(),
          comparisonEnd: timeSchema.optional(),
          dimensions: z
            .array(trafficDimensionSchema)
            .min(1)
            .max(6)
            .refine((items) => new Set(items).size === items.length, "dimensions must be unique")
            .optional(),
          limit: z.number().int().min(1).max(20).default(10),
          filters: segmentedFiltersSchema.optional(),
          trafficSegment: trafficSegmentSchema,
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
          comparisonStart,
          comparisonEnd,
          dimensions,
          limit,
          filters,
          trafficSegment,
          timezone,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const current = normalizePeriod(start, end, config.maxRangeDays);
            let comparison: TimePeriod;
            if (comparisonMode === "custom") {
              if (comparisonStart === undefined || comparisonEnd === undefined) {
                throw new UmamiError(
                  "VALIDATION_ERROR",
                  "comparisonStart and comparisonEnd are required for comparisonMode=custom.",
                );
              }
              comparison = normalizePeriod(comparisonStart, comparisonEnd, config.maxRangeDays);
            } else {
              if (comparisonStart !== undefined || comparisonEnd !== undefined) {
                throw new UmamiError(
                  "VALIDATION_ERROR",
                  "comparisonStart and comparisonEnd can only be used with comparisonMode=custom.",
                );
              }
              comparison = comparisonPeriod(current, comparisonMode);
            }
            const website = await client.getWebsite(websiteId, extra.signal);
            const { channel, ...analyticsFilters } = filters ?? {};
            const effectiveDimensions =
              dimensions ??
              (channel
                ? (["channel", "device"] as TrafficDimension[])
                : ([...TRAFFIC_DIMENSIONS] as TrafficDimension[]));
            if (
              channel !== undefined &&
              analyticsFilters.match === "any" &&
              effectiveDimensions.some((dimension) => dimension !== "channel")
            ) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                'Derived channel cross-tabs cannot be combined with filters.match="any" because Umami cannot require candidate predicates outside that OR group.',
              );
            }
            const quality = await trafficQualityComparison(client, {
              websiteId,
              current,
              comparison,
              filters: serializeFilters(analyticsFilters),
              maxRangeDays: config.maxRangeDays,
              signal: extra.signal,
              trafficSegment,
            });
            const traffic = await compareTraffic(client, {
              website: websiteSummary(website),
              current,
              comparison,
              dimensions: effectiveDimensions,
              limit,
              maxRangeDays: config.maxRangeDays,
              filters: analyticsFilters,
              channel: channel as TrafficChannel | undefined,
              excludedReferrers: quality.excludedReferrers,
              signal: extra.signal,
            });
            const suspiciousCount = [quality.current, quality.comparison].reduce(
              (total, assessment) =>
                total +
                (assessment.status === "available" ? assessment.suspiciousReferrers.length : 0),
              0,
            );
            const qualityExplanation =
              suspiciousCount === 0
                ? ""
                : trafficSegment === "human"
                  ? ` The human-traffic preset excluded ${quality.excludedReferrers.length} suspicious referral domain(s) using a conservative heuristic.`
                  : ` ${suspiciousCount} period-level referrer row(s) match a conservative referral-spam pattern; verify the trafficQuality evidence or rerun with trafficSegment=human.`;
            return {
              comparisonMode,
              timezone,
              ...traffic,
              explanation: `${traffic.explanation}${qualityExplanation}`,
              trafficQuality: quality,
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "compare_traffic_series",
      {
        title: "Compare traffic time series",
        description:
          "Return aligned current and comparison traffic buckets to locate the exact day or hour when traffic changed.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          comparisonMode: z.enum(["previous", "year_over_year", "custom"]).default("previous"),
          comparisonStart: timeSchema.optional(),
          comparisonEnd: timeSchema.optional(),
          unit: z.enum(["minute", "hour", "day", "month", "year"]).default("day"),
          filters: filtersSchema.optional(),
          trafficSegment: trafficSegmentSchema,
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
          comparisonStart,
          comparisonEnd,
          unit,
          filters,
          trafficSegment,
          timezone,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const current = normalizePeriod(start, end, config.maxRangeDays);
            let comparison: TimePeriod;
            if (comparisonMode === "custom") {
              if (comparisonStart === undefined || comparisonEnd === undefined) {
                throw new UmamiError(
                  "VALIDATION_ERROR",
                  "comparisonStart and comparisonEnd are required for comparisonMode=custom.",
                );
              }
              comparison = normalizePeriod(comparisonStart, comparisonEnd, config.maxRangeDays);
            } else {
              if (comparisonStart !== undefined || comparisonEnd !== undefined) {
                throw new UmamiError(
                  "VALIDATION_ERROR",
                  "comparisonStart and comparisonEnd can only be used with comparisonMode=custom.",
                );
              }
              comparison = comparisonPeriod(current, comparisonMode);
            }
            await client.assertWebsiteAccessible(websiteId, extra.signal);
            const serializedFilters = serializeFilters(filters);
            const quality = await trafficQualityComparison(client, {
              websiteId,
              current,
              comparison,
              filters: serializedFilters,
              maxRangeDays: config.maxRangeDays,
              signal: extra.signal,
              trafficSegment,
            });
            const effectiveFilters = appendReferrerExclusions(
              serializedFilters,
              quality.excludedReferrers,
            );
            const fetchSeries = async (period: TimePeriod) =>
              parseUpstream(
                pageviewsDataSchema,
                await client.get(
                  `websites/${encodeURIComponent(websiteId)}/pageviews`,
                  seriesRangeQuery(period.startAt, period.endAt, config.maxRangeDays, {
                    serializedFilters: effectiveFilters,
                    timezone,
                    unit,
                    seriesCount: 2,
                  }),
                  extra.signal,
                ),
                "pageview series",
              );
            const [currentSeries, comparisonSeries] = await Promise.all([
              fetchSeries(current),
              fetchSeries(comparison),
            ]);
            const aligned = alignTrafficSeries(
              current,
              currentSeries,
              comparison,
              comparisonSeries,
              unit,
              timezone,
            );
            return {
              dataStatus:
                currentSeries.pageviews.length === 0 &&
                currentSeries.sessions.length === 0 &&
                comparisonSeries.pageviews.length === 0 &&
                comparisonSeries.sessions.length === 0
                  ? ("empty" as const)
                  : ("available" as const),
              comparisonMode,
              unit,
              timezone,
              currentPeriod: isoPeriod(current),
              comparisonPeriod: isoPeriod(comparison),
              current: currentSeries,
              comparison: comparisonSeries,
              buckets: aligned.buckets,
              dataQuality: aligned.dataQuality,
              trafficQuality: quality,
            };
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "analyze_release_impact",
      {
        title: "Analyze release impact",
        description:
          "Compare equal pre- and post-release windows across traffic breakdowns and Core Web Vitals. Returns a compact executive summary by default; request full detail for drill-down evidence. Recent releases use a partial post window and an equally shortened pre window.",
        inputSchema: {
          websiteId: uuidSchema,
          releaseAt: releaseTimestampSchema,
          windowDays: z.number().int().min(1).max(MAX_RELEASE_WINDOW_DAYS).default(7),
          dimensions: z
            .array(trafficDimensionSchema)
            .min(1)
            .max(6)
            .refine((items) => new Set(items).size === items.length, "dimensions must be unique")
            .optional(),
          limit: z.number().int().min(1).max(20).default(10),
          includePerformance: z.boolean().default(true),
          filters: segmentedFiltersSchema.optional(),
          trafficSegment: trafficSegmentSchema,
          timezone: timezoneSchema,
          otherReleases: z.array(otherReleaseSchema).max(20).optional(),
          detailLevel: z.enum(["summary", "full"]).default("summary"),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteId,
          releaseAt,
          windowDays,
          dimensions,
          limit,
          includePerformance,
          filters,
          trafficSegment,
          timezone,
          otherReleases,
          detailLevel,
        },
        extra,
      ) =>
        runTool(
          async () => {
            const releaseTime = parseTimeRange(releaseAt, releaseAt, config.maxRangeDays).startAt;
            const now = Date.now();
            if (releaseTime > now) {
              throw new UmamiError("VALIDATION_ERROR", "releaseAt cannot be in the future.");
            }
            const targetDuration = windowDays * DAY_MS;
            const postEnd = Math.min(releaseTime + targetDuration - 1, now);
            const actualDuration = postEnd - releaseTime;
            if (actualDuration < 3_600_000) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                "At least one hour of post-release data is required.",
              );
            }
            const post: TimePeriod = { startAt: releaseTime, endAt: postEnd };
            const preEnd = releaseTime - 1;
            const pre: TimePeriod = { startAt: preEnd - actualDuration, endAt: preEnd };
            const parsedOtherReleases = (otherReleases ?? []).map((release) => {
              const time = parseTimeRange(
                release.releaseAt,
                release.releaseAt,
                config.maxRangeDays,
              ).startAt;
              if (time > now) {
                throw new UmamiError(
                  "VALIDATION_ERROR",
                  "otherReleases cannot contain a future release.",
                );
              }
              return {
                releaseAt: new Date(time).toISOString(),
                ...(release.id ? { id: release.id } : {}),
                ...(release.description ? { description: release.description } : {}),
                period: time < releaseTime ? ("before" as const) : ("after" as const),
                time,
              };
            });
            const duplicateTargetReleasesIgnored = parsedOtherReleases.filter(
              ({ time }) => time === releaseTime,
            ).length;
            const competingReleases = parsedOtherReleases
              .filter(
                ({ time }) => time !== releaseTime && time >= pre.startAt && time <= post.endAt,
              )
              .map(({ time: _time, ...release }) => release);
            const releaseContextStatus =
              otherReleases === undefined
                ? ("unknown" as const)
                : competingReleases.length > 0
                  ? ("confounded" as const)
                  : ("no_competing_releases_reported" as const);
            const website = await client.getWebsite(websiteId, extra.signal);
            const { channel, ...analyticsFilters } = filters ?? {};
            const requestedDimensions =
              dimensions ??
              (channel
                ? (["channel", "device"] as TrafficDimension[])
                : (["path", "referrer", "device", "channel", "event"] as TrafficDimension[]));
            const effectiveDimensions =
              detailLevel === "full" ? requestedDimensions : ([] as TrafficDimension[]);
            if (
              channel !== undefined &&
              analyticsFilters.match === "any" &&
              effectiveDimensions.some((dimension) => dimension !== "channel")
            ) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                'Derived channel cross-tabs cannot be combined with filters.match="any" because Umami cannot require candidate predicates outside that OR group.',
              );
            }
            const quality = await trafficQualityComparison(client, {
              websiteId,
              current: post,
              comparison: pre,
              filters: serializeFilters(analyticsFilters),
              maxRangeDays: config.maxRangeDays,
              signal: extra.signal,
              trafficSegment,
            });
            const traffic = await compareTraffic(client, {
              website: websiteSummary(website),
              current: post,
              comparison: pre,
              dimensions: effectiveDimensions,
              limit,
              maxRangeDays: config.maxRangeDays,
              filters: analyticsFilters,
              channel: channel as TrafficChannel | undefined,
              excludedReferrers: quality.excludedReferrers,
              signal: extra.signal,
            });
            const performance = !includePerformance
              ? { status: "not_requested" as const }
              : channel
                ? {
                    status: "scope_mismatch" as const,
                    reason:
                      "Umami 3.2 cannot apply an attributed channel scope to Core Web Vitals, so performance evidence was excluded from this verdict.",
                    scope: {
                      requestedChannel: channel,
                      performanceChannel: "all" as const,
                      excludedReferrers: quality.excludedReferrers,
                    },
                  }
                : await comparePerformance(client, {
                    websiteId,
                    current: post,
                    comparison: pre,
                    filters: analyticsFilters,
                    excludedReferrers: quality.excludedReferrers,
                    timezone,
                    signal: extra.signal,
                  });
            const trafficPercent = traffic.changes.pageviews?.percent ?? null;
            const visitorsPercent = traffic.changes.visitors?.percent ?? null;
            const visitsPercent = traffic.changes.visits?.percent ?? null;
            const pageviewsDirection = materialDirection(trafficPercent);
            const visitorsDirection = materialDirection(visitorsPercent);
            const visitsDirection = materialDirection(visitsPercent);
            const audienceDirections = new Set(
              [visitorsDirection, visitsDirection].filter((direction) => direction !== "neutral"),
            );
            const trafficImpact =
              audienceDirections.size === 0
                ? ("neutral" as const)
                : audienceDirections.size > 1
                  ? ("mixed" as const)
                  : audienceDirections.has("positive")
                    ? ("positive" as const)
                    : ("negative" as const);
            const currentPageviewsPerVisit = ratio(
              traffic.current.pageviews,
              traffic.current.visits,
            );
            const comparisonPageviewsPerVisit = ratio(
              traffic.comparison.pageviews,
              traffic.comparison.visits,
            );
            const pageviewsPerVisitPercent =
              currentPageviewsPerVisit === null || comparisonPageviewsPerVisit === null
                ? null
                : percentChange(currentPageviewsPerVisit, comparisonPageviewsPerVisit);
            const depthDirection = materialDirection(pageviewsPerVisitPercent);
            const trafficPattern =
              pageviewsDirection === "negative" &&
              depthDirection === "negative" &&
              trafficImpact !== "negative"
                ? ("reduced_page_depth" as const)
                : pageviewsDirection === "positive" &&
                    depthDirection === "positive" &&
                    trafficImpact !== "positive"
                  ? ("increased_page_depth" as const)
                  : trafficImpact === "positive"
                    ? ("audience_growth" as const)
                    : trafficImpact === "negative"
                      ? ("audience_decline" as const)
                      : trafficImpact === "mixed"
                        ? ("mixed_audience_signals" as const)
                        : ("stable_audience" as const);
            const performanceChanges = "changes" in performance ? performance.changes : undefined;
            const performanceRegressions =
              performance.status === "available" && performanceChanges
                ? Object.entries(performanceChanges)
                    .filter(([, change]) => change.impact === "regressed")
                    .map(([metric]) => metric)
                : [];
            const performanceImprovements =
              performance.status === "available" && performanceChanges
                ? Object.entries(performanceChanges)
                    .filter(([, change]) => change.impact === "improved")
                    .map(([metric]) => metric)
                : [];
            const performanceSampleInsufficient =
              includePerformance &&
              "sampleSufficient" in performance &&
              performance.sampleSufficient === false;
            const performanceEvidenceSufficient =
              !includePerformance ||
              ("sampleSufficient" in performance && performance.sampleSufficient === true);
            const performanceScopeComparable = performance.status !== "scope_mismatch";
            const trafficEvidenceSufficient =
              traffic.current.pageviews >= MIN_RELEASE_TRAFFIC_PAGEVIEWS &&
              traffic.comparison.pageviews >= MIN_RELEASE_TRAFFIC_PAGEVIEWS &&
              traffic.current.visitors >= MIN_RELEASE_AUDIENCE_SAMPLES &&
              traffic.comparison.visitors >= MIN_RELEASE_AUDIENCE_SAMPLES &&
              traffic.current.visits >= MIN_RELEASE_AUDIENCE_SAMPLES &&
              traffic.comparison.visits >= MIN_RELEASE_AUDIENCE_SAMPLES &&
              !traffic.dataQuality.comparisonBaselineZero;
            const trafficImpactForVerdict = trafficEvidenceSufficient
              ? trafficImpact
              : ("neutral" as const);
            const hasPerformanceRegression = performanceRegressions.length > 0;
            const hasPerformanceImprovement = performanceImprovements.length > 0;
            const evidenceVerdict =
              performance.status !== "available" || performanceSampleInsufficient
                ? trafficImpactForVerdict === "neutral"
                  ? "no_clear_change"
                  : "traffic_change_only"
                : hasPerformanceRegression && hasPerformanceImprovement
                  ? "mixed"
                  : hasPerformanceRegression
                    ? trafficImpactForVerdict === "positive"
                      ? "mixed"
                      : "likely_regression"
                    : hasPerformanceImprovement
                      ? trafficImpactForVerdict === "negative"
                        ? "mixed"
                        : "likely_improvement"
                      : trafficImpactForVerdict === "neutral"
                        ? "no_clear_change"
                        : "traffic_change_only";
            const noSufficientEvidence =
              !trafficEvidenceSufficient &&
              (performance.status !== "available" || !performanceEvidenceSufficient);
            const verdict =
              performanceSampleInsufficient || noSufficientEvidence
                ? ("insufficient_data" as const)
                : releaseContextStatus === "confounded" && evidenceVerdict !== "no_clear_change"
                  ? ("confounded" as const)
                  : evidenceVerdict;
            const performanceSampleReadiness =
              "currentSampleCount" in performance &&
              "comparisonSampleCount" in performance &&
              "minimumSampleCount" in performance &&
              typeof performance.currentSampleCount === "number" &&
              typeof performance.comparisonSampleCount === "number" &&
              typeof performance.minimumSampleCount === "number"
                ? (() => {
                    const minimum = performance.minimumSampleCount;
                    const postReleaseSamplesNeeded = Math.max(
                      0,
                      minimum - performance.currentSampleCount,
                    );
                    const baselineSamplesNeeded = Math.max(
                      0,
                      minimum - performance.comparisonSampleCount,
                    );
                    if (postReleaseSamplesNeeded === 0 && baselineSamplesNeeded === 0) {
                      return {
                        status: "sufficient" as const,
                        minimumSamplesPerPeriod: minimum,
                        postReleaseSamples: performance.currentSampleCount,
                        baselineSamples: performance.comparisonSampleCount,
                        postReleaseSamplesNeeded,
                        baselineSamplesNeeded,
                        recheckAt: null,
                        recommendedWindowDays: windowDays,
                      };
                    }
                    const postDurationEstimate =
                      performance.currentSampleCount > 0
                        ? (actualDuration * minimum) / performance.currentSampleCount
                        : null;
                    const baselineDurationEstimate =
                      performance.comparisonSampleCount > 0
                        ? (actualDuration * minimum) / performance.comparisonSampleCount
                        : null;
                    const canEstimate =
                      (postReleaseSamplesNeeded === 0 || performance.currentSampleCount > 0) &&
                      (baselineSamplesNeeded === 0 || performance.comparisonSampleCount > 0);
                    const estimates = canEstimate
                      ? [postDurationEstimate, baselineDurationEstimate].filter(
                          (value): value is number => value !== null && Number.isFinite(value),
                        )
                      : [];
                    const requiredDuration = estimates.length > 0 ? Math.max(...estimates) : null;
                    const recommendedWindowDays =
                      requiredDuration === null ? null : Math.ceil(requiredDuration / DAY_MS);
                    const estimateWithinLimit =
                      requiredDuration !== null &&
                      recommendedWindowDays !== null &&
                      recommendedWindowDays <= MAX_RELEASE_WINDOW_DAYS;
                    const estimatedReadyTime =
                      estimateWithinLimit && requiredDuration !== null
                        ? releaseTime + Math.ceil(requiredDuration)
                        : null;
                    const recheckAt =
                      estimatedReadyTime === null
                        ? null
                        : new Date(Math.max(now, estimatedReadyTime)).toISOString();
                    return {
                      status: recheckAt ? ("waiting" as const) : ("estimate_unavailable" as const),
                      minimumSamplesPerPeriod: minimum,
                      postReleaseSamples: performance.currentSampleCount,
                      baselineSamples: performance.comparisonSampleCount,
                      postReleaseSamplesNeeded,
                      baselineSamplesNeeded,
                      observedPostReleaseSamplesPerDay:
                        Math.round(
                          (performance.currentSampleCount / (actualDuration / DAY_MS)) * 100,
                        ) / 100,
                      observedBaselineSamplesPerDay:
                        Math.round(
                          (performance.comparisonSampleCount / (actualDuration / DAY_MS)) * 100,
                        ) / 100,
                      recheckAt,
                      recommendedWindowDays: estimateWithinLimit ? recommendedWindowDays : null,
                      reason: recheckAt
                        ? recommendedWindowDays !== null && recommendedWindowDays > windowDays
                          ? "Rerun with the recommended longer equal window at or after recheckAt."
                          : "Rerun at or after recheckAt when the current window should contain enough samples."
                        : performance.currentSampleCount === 0 ||
                            performance.comparisonSampleCount === 0
                          ? "A recheck date cannot be estimated from a zero observed sample rate."
                          : "The estimated sample requirement exceeds the maximum 30-day release window.",
                    };
                  })()
                : {
                    status:
                      performance.status === "not_requested"
                        ? ("not_requested" as const)
                        : ("unavailable" as const),
                    recheckAt: null,
                  };
            const trafficSampleReadiness = {
              status: traffic.dataQuality.comparisonBaselineZero
                ? ("baseline_zero" as const)
                : trafficEvidenceSufficient
                  ? ("sufficient" as const)
                  : ("insufficient" as const),
              measure: "pageviews" as const,
              minimumSamplesPerPeriod: MIN_RELEASE_TRAFFIC_PAGEVIEWS,
              minimumVisitorsPerPeriod: MIN_RELEASE_AUDIENCE_SAMPLES,
              minimumVisitsPerPeriod: MIN_RELEASE_AUDIENCE_SAMPLES,
              postReleaseSamples: traffic.current.pageviews,
              baselineSamples: traffic.comparison.pageviews,
              postReleaseSamplesNeeded: Math.max(
                0,
                MIN_RELEASE_TRAFFIC_PAGEVIEWS - traffic.current.pageviews,
              ),
              baselineSamplesNeeded: Math.max(
                0,
                MIN_RELEASE_TRAFFIC_PAGEVIEWS - traffic.comparison.pageviews,
              ),
              postReleaseVisitors: traffic.current.visitors,
              baselineVisitors: traffic.comparison.visitors,
              postReleaseVisitorsNeeded: Math.max(
                0,
                MIN_RELEASE_AUDIENCE_SAMPLES - traffic.current.visitors,
              ),
              baselineVisitorsNeeded: Math.max(
                0,
                MIN_RELEASE_AUDIENCE_SAMPLES - traffic.comparison.visitors,
              ),
              postReleaseVisits: traffic.current.visits,
              baselineVisits: traffic.comparison.visits,
              postReleaseVisitsNeeded: Math.max(
                0,
                MIN_RELEASE_AUDIENCE_SAMPLES - traffic.current.visits,
              ),
              baselineVisitsNeeded: Math.max(
                0,
                MIN_RELEASE_AUDIENCE_SAMPLES - traffic.comparison.visits,
              ),
            };
            const dataStatus =
              traffic.dataStatus === "available" ||
              (performance.status === "available" &&
                "currentSampleCount" in performance &&
                "comparisonSampleCount" in performance &&
                ((typeof performance.currentSampleCount === "number" &&
                  performance.currentSampleCount > 0) ||
                  (typeof performance.comparisonSampleCount === "number" &&
                    performance.comparisonSampleCount > 0)))
                ? ("available" as const)
                : traffic.dataStatus;
            const assessment = {
              verdict,
              evidenceVerdict,
              trafficImpact,
              trafficPattern,
              trafficChangePercent: trafficPercent,
              trafficEvidenceUsed: trafficEvidenceSufficient,
              trafficChanges: {
                pageviews: trafficPercent,
                visitors: visitorsPercent,
                visits: visitsPercent,
                pageviewsPerVisit: pageviewsPerVisitPercent,
              },
              performanceRegressions,
              performanceImprovements,
              performanceScopeComparable,
              confidence:
                trafficEvidenceSufficient &&
                performanceEvidenceSufficient &&
                releaseContextStatus !== "confounded"
                  ? ("medium" as const)
                  : ("low" as const),
              caveat:
                releaseContextStatus === "confounded"
                  ? "Other releases overlap the comparison windows, so the observed change cannot be isolated to the target release."
                  : performanceScopeComparable
                    ? "This is a before/after association. Campaigns, seasonality, outages, and unreported concurrent changes can produce the same pattern."
                    : "This is a traffic-only before/after association for the selected channel. Core Web Vitals were excluded because Umami cannot apply the same channel scope.",
            };
            const releaseContext = {
              status: releaseContextStatus,
              historyProvided: otherReleases !== undefined,
              competingReleases,
              releasesOutsideAnalysisWindow:
                parsedOtherReleases.length -
                competingReleases.length -
                duplicateTargetReleasesIgnored,
              duplicateTargetReleasesIgnored,
            };
            const recommendedChecks = [
              ...(performanceSampleInsufficient
                ? [
                    performanceSampleReadiness.recheckAt
                      ? "Rerun release impact at recheckAt using recommendedWindowDays."
                      : "Collect more Core Web Vital samples or use a longer supported equal window before assigning a performance direction.",
                  ]
                : []),
              ...(trafficSampleReadiness.status === "baseline_zero"
                ? [
                    "Choose a baseline with non-zero traffic; percentage change from zero is undefined.",
                  ]
                : trafficSampleReadiness.status === "insufficient"
                  ? [
                      "Treat the traffic direction as low confidence until both periods reach the pageview threshold.",
                    ]
                  : []),
              ...(postEnd < releaseTime + targetDuration - 1
                ? [
                    "Rerun after the requested post-release window is complete to restore weekday alignment.",
                  ]
                : []),
              ...(releaseContextStatus === "unknown"
                ? [
                    "Provide neighboring deployments in otherReleases before attributing the change to this release.",
                  ]
                : releaseContextStatus === "confounded"
                  ? [
                      "Separate or annotate the overlapping releases before making an attribution claim.",
                    ]
                  : []),
              ...(trafficPattern === "reduced_page_depth"
                ? [
                    "Inspect landing pages, exits, navigation changes, and duplicate/missing pageview tracking; audience volume did not materially decline.",
                  ]
                : trafficPattern === "mixed_audience_signals"
                  ? [
                      "Segment the audience by channel, device, country, and page before summarizing it.",
                    ]
                  : []),
              ...(performanceRegressions.length > 0
                ? [
                    'Use detailLevel="full", then drill into page, device, and browser performance breakdowns for the regressed metrics.',
                  ]
                : []),
            ];
            const executiveSummary = {
              verdict,
              evidenceVerdict,
              confidence: assessment.confidence,
              traffic: {
                impact: trafficImpact,
                pattern: trafficPattern,
                pageviewsChangePercent: trafficPercent,
                visitorsChangePercent: visitorsPercent,
                visitsChangePercent: visitsPercent,
                pageviewsPerVisitChangePercent: pageviewsPerVisitPercent,
                evidenceSufficient: trafficEvidenceSufficient,
              },
              performance: {
                status: performanceSampleInsufficient
                  ? ("insufficient_data" as const)
                  : performance.status,
                regressions: performanceRegressions,
                improvements: performanceImprovements,
              },
              attribution: releaseContextStatus,
              recheckAt: performanceSampleReadiness.recheckAt,
              recommendedChecks,
            };
            const periods = { before: isoPeriod(pre), after: isoPeriod(post) };
            const comparability = {
              equalDuration: true,
              dayOfWeekAligned:
                postEnd === releaseTime + targetDuration - 1 && windowDays % 7 === 0,
              note:
                windowDays % 7 === 0
                  ? "Full windows align weekdays when the post-release window is complete."
                  : "Use a 7, 14, 21, or 28 day window to reduce weekday-mix bias.",
            };
            const sampleReadiness = {
              traffic:
                detailLevel === "summary" && trafficSampleReadiness.status === "sufficient"
                  ? { status: "sufficient" as const }
                  : trafficSampleReadiness,
              performance:
                detailLevel === "summary" && performanceSampleReadiness.status === "sufficient"
                  ? { status: "sufficient" as const }
                  : performanceSampleReadiness,
              recheckAt: performanceSampleReadiness.recheckAt,
            };
            const summary = {
              dataStatus,
              website: websiteSummary(website),
              releaseAt: new Date(releaseTime).toISOString(),
              requestedWindowDays: windowDays,
              partialPostWindow: postEnd < releaseTime + targetDuration - 1,
              detailLevel,
              periods,
              comparability,
              executiveSummary,
              releaseContext,
              sampleReadiness,
            };
            if (detailLevel === "summary") {
              return summary;
            }
            return {
              ...summary,
              assessment,
              traffic,
              trafficQuality: quality,
              performance,
            };
          },
          { websiteId, timezone },
        ),
    );

    server.registerTool(
      "tracking_health_check",
      {
        title: "Check analytics tracking health",
        description:
          "Audit visible websites for stale or missing traffic, traffic drops, domain mismatches, referral-spam patterns, custom-event availability, recorder configuration, and section permission failures. Disabled optional features are warnings only when marked as expected.",
        inputSchema: {
          websiteLimit: websiteLimitSchema,
          lookbackHours: z.number().int().min(1).max(8_760).default(48),
          staleAfterHours: z.number().int().min(1).max(8_760).default(48),
          dropThresholdPercent: z.number().min(1).max(100).default(50),
          minimumPageviews: z.number().int().min(0).max(1_000_000_000).default(100),
          checks: z
            .array(z.enum(["traffic", "domain", "events", "recorder", "referral_spam"]))
            .min(1)
            .max(5)
            .default(["traffic", "domain", "referral_spam", "events", "recorder"]),
          expectEvents: z.boolean().default(false),
          expectReplay: z.boolean().default(false),
          expectHeatmap: z.boolean().default(false),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (
        {
          websiteLimit,
          lookbackHours,
          staleAfterHours,
          dropThresholdPercent,
          minimumPageviews,
          checks,
          expectEvents,
          expectReplay,
          expectHeatmap,
        },
        extra,
      ) => {
        const endAt = Date.now();
        const startAt = endAt - lookbackHours * 3_600_000;
        const effectiveChecks = [...(checks as HealthCheckName[])];
        if (expectEvents && !effectiveChecks.includes("events")) effectiveChecks.push("events");
        if ((expectReplay || expectHeatmap) && !effectiveChecks.includes("recorder")) {
          effectiveChecks.push("recorder");
        }
        return runTool(
          async () => {
            const period = normalizePeriod(startAt, endAt, config.maxRangeDays);
            const page = websitePage(
              await client.listWebsites({ page: 1, pageSize: websiteLimit }, extra.signal),
            );
            const websites = await mapConcurrent(page.data, 4, (website) =>
              healthSite(client, website, period, {
                checks: effectiveChecks,
                dropThresholdPercent,
                expectEvents,
                expectHeatmap,
                expectReplay,
                maxRangeDays: config.maxRangeDays,
                minimumPageviews,
                signal: extra.signal,
                staleAfterHours,
              }),
            );
            const allIssues = websites.flatMap(({ website, issues }) =>
              issues.map((issue) => ({ website, ...issue })),
            );
            const anyAvailableCheck = websites.some(({ checks: siteChecks }) =>
              Object.values(siteChecks).some(
                (check) => isRecord(check) && check.status === "available",
              ),
            );
            return {
              dataStatus:
                websites.length === 0
                  ? ("empty" as const)
                  : anyAvailableCheck
                    ? ("available" as const)
                    : ("unknown" as const),
              generatedAt: new Date(endAt).toISOString(),
              period: isoPeriod(period),
              checkSelection: {
                requested: checks,
                effective: effectiveChecks,
              },
              coverage: {
                visibleWebsites: page.count,
                checkedWebsites: websites.length,
                websiteLimit,
                websitesTruncated: page.count > websites.length,
              },
              summary: {
                healthy: websites.filter(({ status }) => status === "healthy").length,
                warnings: websites.filter(({ status }) => status === "warning").length,
                errors: websites.filter(({ status }) => status === "error").length,
                issues: allIssues.length,
              },
              issues: allIssues,
              websites,
              scopeLimitations: [
                "CMS linkage cannot be checked without a separate CMS integration.",
                "Missing custom events are reported only when expectEvents=true.",
                "Recorder features are reported as issues only when explicitly expected.",
                "Referral-spam findings are conservative heuristics, not a definitive bot classification.",
              ],
            };
          },
          { range: { start: startAt, end: endAt } },
        );
      },
    );
  },
};
