import type { UmamiCompassConfig } from "./config.js";
import { VERSION } from "./version.js";

export function getServerInfo(config: UmamiCompassConfig) {
  const insightsEnabled = config.toolsets.has("insights");
  const reportsEnabled = config.toolsets.has("reports");
  return {
    name: "umami-compass",
    version: VERSION,
    access: "read-only",
    upstreamCompatibility: {
      product: "Umami Analytics",
      minimumVersion: "3.2.0",
      runtimeVersionDiscovery: false,
    },
    authType: config.auth.type,
    enabledToolsets: [...config.toolsets],
    scope: {
      websiteAllowlistSize: config.websiteIds?.size ?? null,
      teamAllowlistSize: config.teamIds?.size ?? null,
    },
    limits: {
      maxRangeDays: config.maxRangeDays,
      maxResponseBytes: config.maxResponseBytes,
      requestTimeoutMs: config.requestTimeoutMs,
      channelBreakdownCandidates: 50,
      performanceCrossTabCandidates: 10,
      routePerformanceGroups: 20,
    },
    capabilities: {
      structuredFilterOperators: true,
      emptyReferrerIsolation: true,
      directTrafficIsolation: insightsEnabled || reportsEnabled,
      derivedChannelBreakdowns: insightsEnabled || reportsEnabled,
      referralSpamHeuristics: insightsEnabled || reportsEnabled,
      humanTrafficPreset: insightsEnabled || reportsEnabled,
      humanPerformancePreset: false,
      periodSeriesComparison: insightsEnabled,
      performancePortfolio: insightsEnabled,
      performancePeriodComparison: config.toolsets.has("performance"),
      derivedPerformanceCrossTabs: config.toolsets.has("performance"),
      routeGroupPerformance: config.toolsets.has("performance"),
      performanceMetricSampleCounts: false,
      lcpDecomposition: false,
    },
  };
}
