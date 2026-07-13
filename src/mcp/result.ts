import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toSafeError } from "../api/errors.js";

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

export async function runTool<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    const data = normalizeAnalyticsNumbers(await operation());
    const structuredContent = { data };
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
