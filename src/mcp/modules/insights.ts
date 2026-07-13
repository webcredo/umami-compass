import { z } from "zod";
import { toSafeError, UmamiError } from "../../api/errors.js";
import type { PagedResponse, Website } from "../../api/types.js";
import { parseTimeRange } from "../../time.js";
import {
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
  filtersSchema,
  outputSchema,
  rangeQuery,
  timeSchema,
  timezoneSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

const trafficDimensionSchema = z.enum(TRAFFIC_DIMENSIONS);
const websiteLimitSchema = z.number().int().min(1).max(50).default(25);
const MIN_RELEASE_TRAFFIC_CHANGE_PERCENT = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releaseTimestampSchema = timeSchema.refine(
  (value) =>
    typeof value === "number" || (/T/i.test(value) && /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())),
  "releaseAt must be Unix milliseconds or an ISO 8601 date-time with an explicit timezone",
);

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

type HealthCheckName = "traffic" | "domain" | "events" | "recorder";

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
      issues.push({
        check,
        code: safeError.code === "FORBIDDEN" ? "PERMISSION_MISSING" : "CHECK_UNAVAILABLE",
        message: safeError.message,
        severity: safeError.code === "FORBIDDEN" ? "warning" : "error",
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
            .default(["path", "referrer", "country", "device", "event"]),
          limit: z.number().int().min(1).max(20).default(10),
          filters: filtersSchema.optional(),
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
            return {
              comparisonMode,
              timezone,
              ...(await compareTraffic(client, {
                website: websiteSummary(website),
                current,
                comparison,
                dimensions: dimensions as TrafficDimension[],
                limit,
                maxRangeDays: config.maxRangeDays,
                filters,
                signal: extra.signal,
              })),
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
          "Compare equal pre- and post-release windows across traffic breakdowns and Core Web Vitals. Recent releases use a partial post window and an equally shortened pre window.",
        inputSchema: {
          websiteId: uuidSchema,
          releaseAt: releaseTimestampSchema,
          windowDays: z.number().int().min(1).max(30).default(7),
          dimensions: z
            .array(trafficDimensionSchema)
            .min(1)
            .max(6)
            .default(["path", "referrer", "device", "event"]),
          limit: z.number().int().min(1).max(20).default(10),
          includePerformance: z.boolean().default(true),
          filters: filtersSchema.optional(),
          timezone: timezoneSchema,
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
          timezone,
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
            const targetDuration = windowDays * 86_400_000;
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
            const website = await client.getWebsite(websiteId, extra.signal);
            const traffic = await compareTraffic(client, {
              website: websiteSummary(website),
              current: post,
              comparison: pre,
              dimensions: dimensions as TrafficDimension[],
              limit,
              maxRangeDays: config.maxRangeDays,
              filters,
              signal: extra.signal,
            });
            const performance = includePerformance
              ? await comparePerformance(client, {
                  websiteId,
                  current: post,
                  comparison: pre,
                  filters,
                  timezone,
                  signal: extra.signal,
                })
              : { status: "not_requested" as const };
            const trafficPercent = traffic.changes.pageviews?.percent ?? null;
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
            const trafficImpact =
              trafficPercent === null ||
              Math.abs(trafficPercent) < MIN_RELEASE_TRAFFIC_CHANGE_PERCENT
                ? "neutral"
                : trafficPercent > 0
                  ? "positive"
                  : "negative";
            const verdict =
              trafficImpact === "negative" && performanceRegressions.length > 0
                ? "likely_regression"
                : trafficImpact === "positive" && performanceImprovements.length > 0
                  ? "likely_improvement"
                  : trafficImpact === "neutral" && performanceRegressions.length === 0
                    ? "no_clear_change"
                    : "mixed";
            const performanceEvidenceSufficient =
              !includePerformance ||
              (performance.status === "available" &&
                "sampleSufficient" in performance &&
                performance.sampleSufficient === true);
            const trafficEvidenceSufficient =
              traffic.current.pageviews >= 500 &&
              traffic.comparison.pageviews >= 500 &&
              !traffic.dataQuality.comparisonBaselineZero;
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
            return {
              dataStatus,
              website: websiteSummary(website),
              releaseAt: new Date(releaseTime).toISOString(),
              requestedWindowDays: windowDays,
              partialPostWindow: postEnd < releaseTime + targetDuration - 1,
              periods: { before: isoPeriod(pre), after: isoPeriod(post) },
              comparability: {
                equalDuration: true,
                dayOfWeekAligned:
                  postEnd === releaseTime + targetDuration - 1 && windowDays % 7 === 0,
                note:
                  windowDays % 7 === 0
                    ? "Full windows align weekdays when the post-release window is complete."
                    : "Use a 7, 14, 21, or 28 day window to reduce weekday-mix bias.",
              },
              assessment: {
                verdict,
                trafficImpact,
                trafficChangePercent: trafficPercent,
                performanceRegressions,
                performanceImprovements,
                confidence:
                  trafficEvidenceSufficient && performanceEvidenceSufficient ? "medium" : "low",
                caveat:
                  "This is a before/after association. Campaigns, seasonality, outages, and other concurrent changes can produce the same pattern.",
              },
              traffic,
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
          "Audit visible websites for stale or missing traffic, traffic drops, domain mismatches, custom-event availability, recorder configuration, and section permission failures. Disabled optional features are warnings only when marked as expected.",
        inputSchema: {
          websiteLimit: websiteLimitSchema,
          lookbackHours: z.number().int().min(1).max(8_760).default(48),
          staleAfterHours: z.number().int().min(1).max(8_760).default(48),
          dropThresholdPercent: z.number().min(1).max(100).default(50),
          minimumPageviews: z.number().int().min(0).max(1_000_000_000).default(100),
          checks: z
            .array(z.enum(["traffic", "domain", "events", "recorder"]))
            .min(1)
            .max(4)
            .default(["traffic", "domain", "events", "recorder"]),
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
              ],
            };
          },
          { range: { start: startAt, end: endAt } },
        );
      },
    );
  },
};
