import { z } from "zod";
import { UmamiError } from "../api/errors.js";
import type { Query } from "../api/types.js";
import { parseTimeRange, type TimeInput } from "../time.js";

export const uuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
  .describe("Umami UUID");
export const timeSchema = z
  .union([z.number().int().nonnegative(), z.string().min(1)])
  .describe("Unix milliseconds, ISO 8601 with timezone, or YYYY-MM-DD (UTC)");
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "timezone must be UTC or a valid IANA time zone")
  .default("UTC");
export const unitSchema = z.enum(["minute", "hour", "day", "month", "year"]).optional();
export const pageSchema = z.number().int().min(1).max(10_000).default(1);
export const pageSizeSchema = z.number().int().min(1).max(100).default(20);

export const filtersSchema = z
  .object({
    browser: z.string().max(200).optional(),
    city: z.string().max(200).optional(),
    cohort: uuidSchema.optional(),
    country: z.string().max(10).optional(),
    device: z.string().max(200).optional(),
    distinctId: z.string().max(500).optional(),
    eventType: z.number().int().positive().optional(),
    event: z.string().max(500).optional(),
    excludeBounce: z.boolean().optional(),
    hostname: z.string().max(500).optional(),
    language: z.string().max(100).optional(),
    os: z.string().max(200).optional(),
    match: z.enum(["all", "any"]).optional(),
    path: z.string().max(2_000).optional(),
    query: z.string().max(2_000).optional(),
    referrer: z.string().max(2_000).optional(),
    region: z.string().max(200).optional(),
    segment: uuidSchema.optional(),
    tag: z.string().max(500).optional(),
    title: z.string().max(1_000).optional(),
    utmCampaign: z.string().max(500).optional(),
    utmContent: z.string().max(500).optional(),
    utmMedium: z.string().max(500).optional(),
    utmSource: z.string().max(500).optional(),
    utmTerm: z.string().max(500).optional(),
  })
  .strict();

export function rangeQuery(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
  options: { filters?: z.infer<typeof filtersSchema>; timezone?: string; unit?: string } = {},
): Query {
  const range = parseTimeRange(start, end, maxRangeDays);
  const { excludeBounce, ...filters } = options.filters ?? {};
  return {
    ...range,
    ...filters,
    ...(excludeBounce === true ? { excludeBounce: true } : {}),
    timezone: options.timezone,
    unit: options.unit,
  };
}

const UNIT_MILLISECONDS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
} as const;

export function seriesRangeQuery(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
  options: {
    filters?: z.infer<typeof filtersSchema>;
    timezone?: string;
    unit?: keyof typeof UNIT_MILLISECONDS;
    seriesCount?: number;
  } = {},
): Query {
  const query = rangeQuery(start, end, maxRangeDays, options);
  if (options.unit) {
    const bucketCount =
      Math.floor(
        ((query.endAt as number) - (query.startAt as number)) / UNIT_MILLISECONDS[options.unit],
      ) + 1;
    if (bucketCount * (options.seriesCount ?? 1) > 10_000) {
      throw new UmamiError(
        "VALIDATION_ERROR",
        "The requested series could exceed 10,000 points. Use a coarser unit, shorter range, or smaller limit.",
      );
    }
  }
  return query;
}

export function selectSafeSeriesUnit(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
  seriesCount = 1,
): keyof typeof UNIT_MILLISECONDS {
  const { startAt, endAt } = parseTimeRange(start, end, maxRangeDays);
  for (const unit of ["minute", "hour", "day", "month", "year"] as const) {
    const bucketCount = Math.floor((endAt - startAt) / UNIT_MILLISECONDS[unit]) + 1;
    if (bucketCount * seriesCount <= 10_000) return unit;
  }
  throw new UmamiError(
    "VALIDATION_ERROR",
    "The requested event series cannot fit within the 10,000-point safety limit.",
  );
}

const jsonRecordSchema = z.object({}).passthrough();
const seriesPointSchema = z
  .object({
    x: z.union([z.string(), z.number()]),
    y: z.number(),
  })
  .passthrough();

export const resultMetaSchema = z
  .object({
    dataStatus: z.enum(["available", "empty", "unknown"]),
    emptyReason: z.string().optional(),
    websiteId: z.string().uuid().optional(),
    requestedRange: z
      .object({
        start: timeSchema,
        end: timeSchema,
      })
      .optional(),
    timezone: z.string().min(1).max(100).optional(),
    truncated: z.boolean(),
  })
  .passthrough();

export const resultMetaOutputSchema = {
  meta: resultMetaSchema,
};

export const outputSchema = {
  data: z.json().describe("JSON analytics data returned by Umami Compass"),
  ...resultMetaOutputSchema,
};

export const recordOutputSchema = {
  data: jsonRecordSchema,
  ...resultMetaOutputSchema,
};

export const arrayOutputSchema = {
  data: z.array(z.json()),
  ...resultMetaOutputSchema,
};

export const pagedOutputSchema = {
  data: z
    .object({
      data: z.array(z.json()),
      count: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      pageSize: z.number().int().nonnegative(),
    })
    .passthrough(),
  ...resultMetaOutputSchema,
};

export const pageviewsDataSchema = z
  .object({
    pageviews: z.array(seriesPointSchema),
    sessions: z.array(seriesPointSchema),
  })
  .passthrough();

export const pageviewsOutputSchema = {
  data: pageviewsDataSchema,
  ...resultMetaOutputSchema,
};

export const boundedItemsDataSchema = z
  .object({
    items: z.array(z.json()),
    itemLimit: z.number().int().positive(),
    itemsTruncated: z.boolean(),
    totalItems: z.number().int().nonnegative(),
  })
  .passthrough();

export const boundedItemsOutputSchema = {
  data: boundedItemsDataSchema,
  ...resultMetaOutputSchema,
};

export function parseUpstream<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UmamiError("INVALID_RESPONSE", `Umami returned invalid ${label} data.`);
  }
  return parsed.data;
}
