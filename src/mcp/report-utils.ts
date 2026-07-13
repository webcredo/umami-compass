import { UmamiError } from "../api/errors.js";
import type { TimeInput } from "../time.js";
import { parseTimeRange } from "../time.js";

export function reportDateRange(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
): { endDate: string; startDate: string } {
  const { startAt, endAt } = parseTimeRange(start, end, maxRangeDays);
  return {
    startDate: new Date(startAt).toISOString(),
    endDate: new Date(endAt).toISOString(),
  };
}

export function reportFilters(
  filters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { excludeBounce, ...rest } = filters ?? {};
  return {
    ...rest,
    ...(excludeBounce === true ? { excludeBounce: "true" } : {}),
  };
}

export function boundedItems(
  value: unknown,
  limit: number,
): {
  itemLimit: number;
  items: unknown[];
  itemsTruncated: boolean;
  totalItems: number;
} {
  if (!Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned an unexpected report response.");
  }
  return {
    items: value.slice(0, limit),
    itemLimit: limit,
    itemsTruncated: value.length > limit,
    totalItems: value.length,
  };
}

export function boundTopLevelArrays(value: unknown, limit: number): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Array.isArray(value) ? boundedItems(value, limit) : value;
  }

  const result = { ...(value as Record<string, unknown>) };
  const arrays: Record<string, { returnedItems: number; totalItems: number; truncated: boolean }> =
    {};
  for (const [key, item] of Object.entries(result)) {
    if (!Array.isArray(item)) continue;
    result[key] = item.slice(0, limit);
    arrays[key] = {
      returnedItems: Math.min(item.length, limit),
      totalItems: item.length,
      truncated: item.length > limit,
    };
  }
  return {
    ...result,
    umamiCompass: {
      arrayLimit: limit,
      arrays,
    },
  };
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned an unexpected report response.");
  }
  return value as Record<string, unknown>;
}
