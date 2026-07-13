import type { UmamiCompassConfig } from "./config.js";
import { VERSION } from "./version.js";

export function getServerInfo(config: UmamiCompassConfig) {
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
    },
    capabilities: {
      structuredFilterOperators: true,
      directTrafficIsolation: true,
      derivedChannelBreakdowns: true,
      referralSpamHeuristics: true,
      humanTrafficPreset: true,
      periodSeriesComparison: config.toolsets.has("insights"),
    },
  };
}
