import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Fetch, UmamiClient } from "./api/client.js";
import { toSafeError } from "./api/errors.js";
import type { UmamiCompassConfig } from "./config.js";
import { coreModule } from "./mcp/modules/core.js";
import { eventsModule } from "./mcp/modules/events.js";
import { heatmapsModule } from "./mcp/modules/heatmaps.js";
import { insightsModule } from "./mcp/modules/insights.js";
import { performanceModule } from "./mcp/modules/performance.js";
import { replayModule } from "./mcp/modules/replay.js";
import { reportsModule } from "./mcp/modules/reports.js";
import { revenueModule } from "./mcp/modules/revenue.js";
import { sessionsModule } from "./mcp/modules/sessions.js";
import {
  type AccessPolicy,
  assertModuleAllowed,
  READ_ONLY_POLICY,
  type ToolModule,
} from "./mcp/tool-module.js";
import { getServerInfo } from "./server-info.js";
import { VERSION } from "./version.js";

export const BUILTIN_MODULES: readonly ToolModule[] = [
  coreModule,
  insightsModule,
  eventsModule,
  sessionsModule,
  performanceModule,
  reportsModule,
  revenueModule,
  replayModule,
  heatmapsModule,
];

export interface CreateServerOptions {
  accessPolicy?: AccessPolicy;
  config: UmamiCompassConfig;
  fetch?: Fetch;
  modules?: readonly ToolModule[];
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "umami-compass",
      title: "Umami Compass",
      version: VERSION,
      websiteUrl: "https://github.com/webcredo/umami-compass",
    },
    {
      instructions:
        "Secure, read-only Umami Analytics access. Start with resolve_website when the insights toolset is enabled, otherwise use list_websites. Use bounded time ranges and prefer insight workflows for portfolio, traffic-change, release-impact, and tracking-health decisions. Performance, saved reports, session, revenue, heatmap and replay data may require separate Umami permissions. Minimize sensitive data entering model context. No tool in this release changes Umami state.",
    },
  );
  const client = new UmamiClient(options.config, options.fetch);
  const policy = options.accessPolicy ?? READ_ONLY_POLICY;
  const modules = options.modules ?? BUILTIN_MODULES;

  for (const module of modules) {
    if (!options.config.toolsets.has(module.id)) continue;
    assertModuleAllowed(module, policy);
    module.register(server, { client, config: options.config });
  }

  server.registerResource(
    "websites",
    "umami://websites",
    {
      title: "Visible Umami websites",
      description: "Websites visible under the configured identity and optional allowlist.",
      mimeType: "application/json",
    },
    async (uri, extra) => {
      try {
        const websites = await client.listWebsites({ page: 1, pageSize: 100 }, extra.signal);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(websites),
            },
          ],
        };
      } catch (error) {
        throw new Error(toSafeError(error).message);
      }
    },
  );

  server.registerResource(
    "capabilities",
    "umami://capabilities",
    {
      title: "Umami Compass capabilities",
      description:
        "Sanitized local capability, scope, and safety-limit information without credentials.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(getServerInfo(options.config)),
        },
      ],
    }),
  );

  if (options.config.toolsets.has("core")) {
    server.registerPrompt(
      "analytics_report",
      {
        title: "Analyze an Umami website",
        description: "A safe workflow for producing an evidence-based analytics report.",
        argsSchema: {
          websiteId: z
            .string()
            .uuid()
            .optional()
            .describe("Optional Umami website UUID; list websites first if omitted."),
          objective: z
            .string()
            .max(2_000)
            .optional()
            .describe("The decision or question the report should support."),
        },
      },
      ({ websiteId, objective }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Analyze ${websiteId ? `website ${websiteId}` : "the relevant Umami website"}.`,
                objective
                  ? `Objective: ${objective}.`
                  : "Clarify the reporting objective before querying.",
                "Confirm an explicit time range and timezone.",
                "Use aggregate stats and pageviews first, then only the smallest necessary metric, event, or session breakdown.",
                "State the queried period, filters, evidence, uncertainty, and recommended next actions.",
              ].join(" "),
            },
          },
        ],
      }),
    );
  }

  if (options.config.toolsets.has("insights")) {
    server.registerPrompt(
      "weekly_portfolio_briefing",
      {
        title: "Create a weekly portfolio briefing",
        description:
          "Produce a bounded weekly briefing across visible websites with leaders, declines, anomalies, stale tracking, and next actions.",
        argsSchema: {
          start: z.string().max(100).optional(),
          end: z.string().max(100).optional(),
          audience: z.string().max(500).optional(),
        },
      },
      ({ start, end, audience }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Create a weekly Umami portfolio briefing.",
                start && end
                  ? `Analyze ${start} through ${end}.`
                  : "Use the most recent complete seven-day period and compare it with the preceding seven days.",
                audience ? `Audience: ${audience}.` : "Write for a product and growth audience.",
                "Use get_portfolio_overview first. Investigate only the most material changes with explain_traffic_change. Separate observations from hypotheses, call out missing or stale data, and finish with no more than five prioritized actions.",
              ].join(" "),
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "investigate_traffic_change",
      {
        title: "Investigate a traffic change",
        description:
          "Explain a website traffic increase or decrease with bounded supporting evidence.",
        argsSchema: {
          websiteId: z.string().uuid(),
          start: z.string().min(1).max(100),
          end: z.string().min(1).max(100),
        },
      },
      ({ websiteId, start, end }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Investigate the traffic change for website ${websiteId} from ${start} through ${end}. Use explain_traffic_change with a previous-period comparison. Report the total change first, then the strongest observed page, referrer, country, device, channel, and event evidence. Do not present association as causation. State data gaps and recommended verification steps.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "release_impact_report",
      {
        title: "Analyze a release impact",
        description: "Assess traffic and Web Vitals before and after a deployment.",
        argsSchema: {
          websiteId: z.string().uuid(),
          releaseAt: z.string().min(1).max(100),
          releaseDescription: z.string().max(1_000).optional(),
        },
      },
      ({ websiteId, releaseAt, releaseDescription }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Analyze the impact of the release at ${releaseAt} for website ${websiteId}.${releaseDescription ? ` Release: ${releaseDescription}.` : ""} Use analyze_release_impact with a seven-day window and detailLevel="summary". If other releases are known, pass them through otherReleases; never attribute overlapping changes only to the target release. Lead with insufficient data when the sample threshold is not met. Interpret visitors and visits as audience traffic, and pageviews per visit as browsing depth. Request detailLevel="full" only when drill-down evidence is needed.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "tracking_health_audit",
      {
        title: "Audit Umami tracking health",
        description:
          "Check freshness, domains, events, recorder configuration, and permissions across websites.",
        argsSchema: {
          expectations: z.string().max(1_000).optional(),
        },
      },
      ({ expectations }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Run a read-only tracking health audit across visible Umami websites.${expectations ? ` Expected tracking behavior: ${expectations}.` : ""} Use tracking_health_check. Separate definite failures, warnings, intentionally disabled optional features, and checks that could not run because of permissions. Do not claim CMS linkage was checked unless a separate CMS integration supplied that evidence.`,
            },
          },
        ],
      }),
    );
  }

  if (options.config.toolsets.has("reports")) {
    server.registerPrompt(
      "conversion_audit",
      {
        title: "Audit a conversion path",
        description: "Review a bounded goal or funnel and identify its largest observed drop-off.",
        argsSchema: {
          websiteId: z.string().uuid(),
          conversion: z.string().min(1).max(1_000),
        },
      },
      ({ websiteId, conversion }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Audit this conversion for website ${websiteId}: ${conversion}. Confirm the time range and exact path/event steps, then use the smallest suitable goal or funnel report. Quantify conversion and drop-off, compare with a prior period when possible, identify data limitations, and recommend the next measurement or product action.`,
            },
          },
        ],
      }),
    );
  }

  return server;
}
