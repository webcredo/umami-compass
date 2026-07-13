import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Fetch, UmamiClient } from "./api/client.js";
import { toSafeError } from "./api/errors.js";
import type { UmamiCompassConfig } from "./config.js";
import { coreModule } from "./mcp/modules/core.js";
import { eventsModule } from "./mcp/modules/events.js";
import { heatmapsModule } from "./mcp/modules/heatmaps.js";
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
import { VERSION } from "./version.js";

export const BUILTIN_MODULES: readonly ToolModule[] = [
  coreModule,
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
        "Secure, read-only Umami Analytics access. Start with list_websites, use bounded time ranges, and request only the dimensions needed for the analysis. Performance, saved reports, session, revenue, heatmap and replay data may require separate Umami permissions. Minimize sensitive data entering model context. No tool in this release changes Umami state.",
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

  return server;
}
