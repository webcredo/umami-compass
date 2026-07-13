import { z } from "zod";
import { toSafeError, UmamiError } from "../../api/errors.js";
import type {
  AttributionReportRequest,
  BreakdownField,
  BreakdownReportRequest,
  FunnelReportRequest,
  GoalReportRequest,
  JourneyReportRequest,
  RetentionReportRequest,
  UtmReportRequest,
} from "../../api/types.js";
import { parseTimeRange } from "../../time.js";
import {
  boundedItems,
  boundedPageItems,
  boundTopLevelArrays,
  reportDateRange,
  reportFilters,
  requireRecord,
} from "../report-utils.js";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  appendReferrerExclusions,
  boundedItemsOutputSchema,
  filtersSchema,
  outputSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  recordOutputSchema,
  segmentedFiltersSchema,
  serializeFilters,
  timeSchema,
  timezoneSchema,
  trafficSegmentSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";
import {
  assessReferralSpam,
  runDerivedChannelBreakdown,
  type TrafficChannel,
} from "../traffic-segmentation.js";

const reportTypeSchema = z.enum([
  "attribution",
  "breakdown",
  "funnel",
  "goal",
  "heatmap",
  "journey",
  "performance",
  "retention",
  "revenue",
  "utm",
]);

const breakdownFieldSchema = z.enum([
  "channel",
  "path",
  "referrer",
  "title",
  "query",
  "os",
  "browser",
  "device",
  "country",
  "region",
  "city",
  "tag",
  "hostname",
  "distinctId",
  "language",
  "event",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
]);

const currencySchema = z
  .string()
  .length(3)
  .transform((value) => value.toUpperCase())
  .optional();

const maxItemsSchema = z.number().int().min(1).max(100).default(20);

function commonRequest(
  websiteId: string,
  start: number | string,
  end: number | string,
  maxRangeDays: number,
  filters: Record<string, unknown> | undefined,
) {
  return {
    websiteId,
    dates: reportDateRange(start, end, maxRangeDays),
    filters: reportFilters(filters),
  };
}

export const reportsModule: ToolModule = {
  id: "reports",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_saved_reports",
      {
        title: "List saved Umami reports",
        description: "List saved report definitions for one website without modifying them.",
        inputSchema: {
          websiteId: uuidSchema,
          type: reportTypeSchema.optional(),
          page: pageSchema,
          pageSize: pageSizeSchema,
        },
        outputSchema: pagedOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, type, page, pageSize }, extra) =>
        runTool(
          () => {
            client.assertWebsiteAllowed(websiteId);
            return client.get(
              `websites/${encodeURIComponent(websiteId)}/reports`,
              { type, page, pageSize },
              extra.signal,
            );
          },
          { websiteId },
        ),
    );

    server.registerTool(
      "get_saved_report",
      {
        title: "Get a saved Umami report",
        description:
          "Get one saved report definition. The website ID is required to enforce the local allowlist and is verified against the response.",
        inputSchema: { websiteId: uuidSchema, reportId: uuidSchema },
        outputSchema: recordOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, reportId }, extra) =>
        runTool(
          async () => {
            await client.assertWebsiteAccessible(websiteId, extra.signal);
            const report = requireRecord(
              await client.get(`reports/${encodeURIComponent(reportId)}`, undefined, extra.signal),
            );
            if (
              typeof report.websiteId !== "string" ||
              report.websiteId.toLowerCase() !== websiteId
            ) {
              throw new UmamiError(
                "FORBIDDEN",
                "The saved report does not belong to that website.",
              );
            }
            return report;
          },
          { websiteId },
        ),
    );

    server.registerTool(
      "list_segments",
      {
        title: "List Umami segments or cohorts",
        description:
          "List reusable website segments or cohorts from Umami's paged response with explicit context limits.",
        inputSchema: {
          websiteId: uuidSchema,
          type: z.enum(["segment", "cohort"]),
          search: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, type, search, limit }, extra) =>
        runTool(
          async () => {
            client.assertWebsiteAllowed(websiteId);
            const result = await client.get(
              `websites/${encodeURIComponent(websiteId)}/segments`,
              { type, search },
              extra.signal,
            );
            return { type, ...boundedPageItems(result, limit) };
          },
          { websiteId },
        ),
    );

    server.registerTool(
      "run_goal_report",
      {
        title: "Run a goal report",
        description: "Calculate an Umami conversion goal for a path or custom event.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          type: z.enum(["path", "event"]),
          value: z.string().min(1).max(500),
          filters: filtersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, type, value, filters }, extra) =>
        runTool(
          () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: GoalReportRequest = {
              websiteId,
              type: "goal",
              parameters: { ...common.dates, type, value },
              filters: common.filters,
            };
            return client.runReport(request, extra.signal);
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "run_funnel_report",
      {
        title: "Run a funnel report",
        description:
          "Calculate a 2–8 step Umami funnel. windowMinutes controls the allowed time between consecutive steps.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          windowMinutes: z.number().int().min(1).max(10_080).default(60),
          steps: z
            .array(
              z.object({
                type: z.enum(["path", "event"]),
                value: z.string().min(1).max(500),
                filters: z
                  .array(
                    z.object({
                      property: z.string().min(1).max(200),
                      operator: z.enum(["eq", "neq", "c", "dnc"]),
                      value: z.string().max(500),
                    }),
                  )
                  .max(10)
                  .optional(),
              }),
            )
            .min(2)
            .max(8),
          filters: filtersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, windowMinutes, steps, filters }, extra) =>
        runTool(
          () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: FunnelReportRequest = {
              websiteId,
              type: "funnel",
              parameters: { ...common.dates, window: windowMinutes, steps },
              filters: common.filters,
            };
            return client.runReport(request, extra.signal);
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "run_journey_report",
      {
        title: "Run a journey report",
        description:
          "Calculate the most common 2–7 step user journeys and return a bounded ranking.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          steps: z.number().int().min(2).max(7),
          startStep: z.string().min(1).max(500).optional(),
          endStep: z.string().min(1).max(500).optional(),
          eventType: z.number().int().positive().optional(),
          limit: maxItemsSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, steps, startStep, endStep, eventType, limit, filters }, extra) =>
        runTool(
          async () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: JourneyReportRequest = {
              websiteId,
              type: "journey",
              parameters: {
                ...common.dates,
                steps,
                ...(startStep ? { startStep } : {}),
                ...(endStep ? { endStep } : {}),
                ...(eventType ? { eventType } : {}),
              },
              filters: common.filters,
            };
            return boundedItems(await client.runReport(request, extra.signal), limit);
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "run_retention_report",
      {
        title: "Run a retention report",
        description: "Calculate daily Umami cohort retention and return a bounded result set.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          timezone: timezoneSchema,
          limit: z.number().int().min(1).max(500).default(100),
          filters: filtersSchema.optional(),
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, timezone, limit, filters }, extra) =>
        runTool(
          async () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: RetentionReportRequest = {
              websiteId,
              type: "retention",
              parameters: { ...common.dates, timezone },
              filters: common.filters,
            };
            return boundedItems(await client.runReport(request, extra.signal), limit);
          },
          { websiteId, range: { start, end }, timezone },
        ),
    );

    server.registerTool(
      "run_utm_report",
      {
        title: "Run a UTM report",
        description:
          "Calculate Umami source, medium, campaign, term and content performance with bounded category arrays.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          limit: maxItemsSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, limit, filters }, extra) =>
        runTool(
          async () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: UtmReportRequest = {
              websiteId,
              type: "utm",
              parameters: common.dates,
              filters: common.filters,
            };
            return boundTopLevelArrays(await client.runReport(request, extra.signal), limit);
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "run_attribution_report",
      {
        title: "Run an attribution report",
        description:
          "Calculate first-click or last-click attribution for a conversion path or event with bounded channel arrays.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          model: z.enum(["first-click", "last-click"]),
          type: z.enum(["path", "event"]),
          step: z.string().min(1).max(500),
          currency: currencySchema,
          limit: maxItemsSchema,
          filters: filtersSchema.optional(),
        },
        outputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, model, type, step, currency, limit, filters }, extra) =>
        runTool(
          async () => {
            const common = commonRequest(websiteId, start, end, config.maxRangeDays, filters);
            const request: AttributionReportRequest = {
              websiteId,
              type: "attribution",
              parameters: {
                ...common.dates,
                model,
                type,
                step,
                ...(currency ? { currency } : {}),
              },
              filters: common.filters,
            };
            return boundTopLevelArrays(await client.runReport(request, extra.signal), limit);
          },
          { websiteId, range: { start, end } },
        ),
    );

    server.registerTool(
      "run_breakdown_report",
      {
        title: "Run a multi-field breakdown",
        description:
          "Cross-tabulate up to three Umami dimensions, including derived channel combinations, and return the highest-ranked bounded rows.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          fields: z
            .array(breakdownFieldSchema)
            .min(1)
            .max(3)
            .refine((items) => new Set(items).size === items.length, "fields must be unique"),
          limit: z.number().int().min(1).max(100).default(20),
          filters: segmentedFiltersSchema.optional(),
          trafficSegment: trafficSegmentSchema,
        },
        outputSchema: boundedItemsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, fields, limit, filters, trafficSegment }, extra) =>
        runTool(
          async () => {
            const period = parseTimeRange(start, end, config.maxRangeDays);
            const { channel, ...analyticsFilters } = filters ?? {};
            if ((channel !== undefined || fields.includes("channel")) && fields.includes("event")) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                "Umami cannot cross-tabulate attributed channels with custom events.",
              );
            }
            if (
              analyticsFilters.match === "any" &&
              ((channel !== undefined && fields.some((field) => field !== "channel")) ||
                (fields.includes("channel") && fields.length > 1))
            ) {
              throw new UmamiError(
                "VALIDATION_ERROR",
                'Derived channel cross-tabs cannot be combined with filters.match="any" because Umami cannot require candidate predicates outside that OR group.',
              );
            }
            let trafficQuality:
              | ({ status: "available" } & Awaited<ReturnType<typeof assessReferralSpam>>)
              | { status: "unavailable"; error: unknown };
            try {
              trafficQuality = {
                status: "available",
                ...(await assessReferralSpam(client, {
                  websiteId,
                  period,
                  filters: serializeFilters(analyticsFilters),
                  maxRangeDays: config.maxRangeDays,
                  signal: extra.signal,
                })),
              };
            } catch (error) {
              if (trafficSegment === "human") throw error;
              trafficQuality = { status: "unavailable", error: toSafeError(error) };
            }
            const excludedReferrers =
              trafficSegment === "human" && trafficQuality.status === "available"
                ? trafficQuality.excludedReferrers
                : [];
            const serializedFilters = appendReferrerExclusions(
              serializeFilters(analyticsFilters),
              excludedReferrers,
            );

            if (channel !== undefined || fields.includes("channel")) {
              const derived = await runDerivedChannelBreakdown(client, {
                websiteId,
                period,
                fields: fields as Array<BreakdownField | "channel">,
                channel: channel as TrafficChannel | undefined,
                filters: serializedFilters,
                limit,
                maxRangeDays: config.maxRangeDays,
                signal: extra.signal,
              });
              return {
                ...boundedItems(derived.rows, limit),
                dataQuality: derived.dataQuality,
                trafficSegment,
                trafficQuality,
                excludedReferrers,
              };
            }

            const common = commonRequest(
              websiteId,
              start,
              end,
              config.maxRangeDays,
              analyticsFilters,
            );
            const request: BreakdownReportRequest = {
              websiteId,
              type: "breakdown",
              parameters: { ...common.dates, fields: fields as BreakdownField[] },
              filters: serializedFilters,
            };
            return {
              ...boundedItems(await client.runReport(request, extra.signal), limit),
              trafficSegment,
              trafficQuality,
              excludedReferrers,
            };
          },
          { websiteId, range: { start, end } },
        ),
    );
  },
};
