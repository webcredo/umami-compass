import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toSafeError } from "../api/errors.js";
import type { TimeInput } from "../time.js";

const NUMERIC_ANALYTICS_FIELDS = new Set([
  "arpu",
  "average",
  "bounces",
  "chunkCount",
  "count",
  "day",
  "dropoff",
  "dropped",
  "duration",
  "eventCount",
  "events",
  "p50",
  "p75",
  "p95",
  "pageviews",
  "percentage",
  "previous",
  "remaining",
  "returnVisitors",
  "sessions",
  "sum",
  "total_sessions",
  "totaltime",
  "unique_count",
  "visitors",
  "visits",
  "views",
  "y",
  "z",
]);

const NUMERIC_STRING = /^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i;

function numericValue(value: unknown): unknown {
  if (typeof value !== "string" || !NUMERIC_STRING.test(value.trim())) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) return value;
  return number;
}

export function normalizeAnalyticsNumbers(value: unknown, depth = 0): unknown {
  if (depth > 100 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAnalyticsNumbers(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeAnalyticsNumbers(
        NUMERIC_ANALYTICS_FIELDS.has(key) ? numericValue(item) : item,
        depth + 1,
      ),
    ]),
  );
}

export const READ_ONLY_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} satisfies ToolAnnotations;

export const CREATE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export const UPDATE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export const DESTRUCTIVE_ANNOTATIONS = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export type ToolDataStatus = "available" | "empty" | "unknown";

export interface ToolResultMetaInput {
  dataStatus?: ToolDataStatus;
  emptyReason?: string;
  range?: {
    end: TimeInput;
    start: TimeInput;
  };
  timezone?: string;
  websiteId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function analyticsNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !NUMERIC_STRING.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function explicitDataStatus(data: unknown): ToolDataStatus | undefined {
  if (Array.isArray(data)) return data.length === 0 ? "empty" : "available";
  if (!isRecord(data)) return data === null || data === undefined ? "empty" : "available";

  if (
    data.dataStatus === "available" ||
    data.dataStatus === "empty" ||
    data.dataStatus === "unknown"
  ) {
    return data.dataStatus;
  }
  if (data.status === "not_found") return "empty";
  if (isRecord(data.coverage)) {
    const successful = analyticsNumber(data.coverage.successfulWebsites);
    const failed = analyticsNumber(data.coverage.failedWebsites);
    if (successful === 0) return failed !== undefined && failed > 0 ? "unknown" : "empty";
    const covered = data.coverage.checkedWebsites;
    if (covered === 0) return "empty";
  }
  if (Array.isArray(data.data) && typeof data.count === "number") {
    return data.count === 0 ? "empty" : "available";
  }
  if (Array.isArray(data.items) && typeof data.totalItems === "number") {
    return data.totalItems === 0 ? "empty" : "available";
  }
  if (Array.isArray(data.pageviews) && Array.isArray(data.sessions)) {
    return data.pageviews.length === 0 && data.sessions.length === 0 ? "empty" : "available";
  }

  const pageviews = analyticsNumber(data.pageviews);
  const visitors = analyticsNumber(data.visitors);
  const visits = analyticsNumber(data.visits);
  if (pageviews !== undefined && visitors !== undefined && visits !== undefined) {
    return pageviews === 0 && visitors === 0 && visits === 0 ? "empty" : "available";
  }

  const revenueSum = analyticsNumber(data.sum);
  const revenueCount = analyticsNumber(data.count);
  if (revenueSum !== undefined && revenueCount !== undefined && "unique_count" in data) {
    return revenueSum === 0 && revenueCount === 0 ? "empty" : "available";
  }

  if ("startDate" in data && "endDate" in data) {
    return data.startDate == null && data.endDate == null ? "empty" : "available";
  }
  return "available";
}

function hasTruncation(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasTruncation(item, depth + 1));
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase().endsWith("truncated") && item === true) return true;
    if (hasTruncation(item, depth + 1)) return true;
  }
  return false;
}

function resultMeta(data: unknown, input: ToolResultMetaInput) {
  const embedded = isRecord(data) ? data : undefined;
  const dataStatus = input.dataStatus ?? explicitDataStatus(data) ?? "unknown";
  const embeddedEmptyReason =
    typeof embedded?.emptyReason === "string" ? embedded.emptyReason : undefined;
  const emptyReason =
    input.emptyReason ??
    embeddedEmptyReason ??
    (dataStatus === "empty" ? (input.range ? "no_data_in_range" : "no_results") : undefined);

  return {
    dataStatus,
    ...(emptyReason ? { emptyReason } : {}),
    ...(input.websiteId ? { websiteId: input.websiteId } : {}),
    ...(input.range ? { requestedRange: input.range } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    truncated: hasTruncation(data),
  };
}

export async function runTool<T>(
  operation: () => Promise<T>,
  meta: ToolResultMetaInput = {},
): Promise<CallToolResult> {
  try {
    const data = normalizeAnalyticsNumbers(await operation());
    const structuredContent = { data, meta: resultMeta(data, meta) };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: toSafeError(error) }) }],
      isError: true,
    };
  }
}
