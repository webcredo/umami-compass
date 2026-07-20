import { z } from "zod";
import { UmamiError } from "../api/errors.js";
import type { Query, QueryValue } from "../api/types.js";
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

export const filterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "regex",
  "not_regex",
  "is_empty",
  "is_not_empty",
]);

const MAX_FILTER_CONDITIONS_PER_FIELD = 10;
const MAX_FILTER_VALUES_PER_CONDITION = 20;
const MAX_TOTAL_FILTER_CONDITIONS = 30;
const MAX_TOTAL_FILTER_VALUES = 100;
const MAX_SERIALIZED_FILTER_BYTES = 16_384;

const filterConditionSchema = (maximum: number) =>
  z
    .object({
      operator: filterOperatorSchema,
      value: z
        .union([
          z.string().max(maximum),
          z.array(z.string().max(maximum)).min(1).max(MAX_FILTER_VALUES_PER_CONDITION),
        ])
        .optional(),
    })
    .strict()
    .superRefine(({ operator, value }, context) => {
      const emptyOperator = operator === "is_empty" || operator === "is_not_empty";
      if (emptyOperator && value !== undefined) {
        context.addIssue({
          code: "custom",
          message: `${operator} does not accept a value`,
          path: ["value"],
        });
      } else if (!emptyOperator && value === undefined) {
        context.addIssue({
          code: "custom",
          message: `${operator} requires a value`,
          path: ["value"],
        });
      }
      if (Array.isArray(value) && !["equals", "not_equals"].includes(operator)) {
        context.addIssue({
          code: "custom",
          message: `${operator} accepts one string value`,
          path: ["value"],
        });
      }
      if (
        (operator === "equals" || operator === "not_equals") &&
        (Array.isArray(value) ? value : value === undefined ? [] : [value]).some((item) =>
          item.includes(","),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "equals values cannot contain commas; pass separate values in the array",
          path: ["value"],
        });
      }
    });

const textFilterSchema = (maximum: number) =>
  z.union([
    z.string().max(maximum),
    filterConditionSchema(maximum),
    z.array(filterConditionSchema(maximum)).min(1).max(MAX_FILTER_CONDITIONS_PER_FIELD),
  ]);

const filterFields = {
  browser: textFilterSchema(200).optional(),
  city: textFilterSchema(200).optional(),
  cohort: uuidSchema.optional(),
  country: textFilterSchema(10).optional(),
  device: textFilterSchema(200).optional(),
  distinctId: textFilterSchema(500).optional(),
  eventType: z.number().int().positive().optional(),
  event: textFilterSchema(500).optional(),
  excludeBounce: z.boolean().optional(),
  hostname: textFilterSchema(500).optional(),
  language: textFilterSchema(100).optional(),
  os: textFilterSchema(200).optional(),
  match: z.enum(["all", "any"]).optional(),
  path: textFilterSchema(2_000).optional(),
  query: textFilterSchema(2_000).optional(),
  referrer: textFilterSchema(2_000).optional(),
  region: textFilterSchema(200).optional(),
  segment: uuidSchema.optional(),
  tag: textFilterSchema(500).optional(),
  title: textFilterSchema(1_000).optional(),
  utmCampaign: textFilterSchema(500).optional(),
  utmContent: textFilterSchema(500).optional(),
  utmMedium: textFilterSchema(500).optional(),
  utmSource: textFilterSchema(500).optional(),
  utmTerm: textFilterSchema(500).optional(),
};

function validateFilterBudget(filters: Record<string, unknown>, context: z.RefinementCtx) {
  let conditionCount = 0;
  let valueCount = 0;
  for (const value of Object.values(filters)) {
    const conditions = Array.isArray(value) ? value : [value];
    for (const condition of conditions) {
      if (!isFilterCondition(condition)) continue;
      conditionCount += 1;
      valueCount += Array.isArray(condition.value) ? condition.value.length : 1;
    }
  }
  if (conditionCount > MAX_TOTAL_FILTER_CONDITIONS) {
    context.addIssue({
      code: "custom",
      message: `filters cannot contain more than ${MAX_TOTAL_FILTER_CONDITIONS} structured conditions`,
    });
  }
  if (valueCount > MAX_TOTAL_FILTER_VALUES) {
    context.addIssue({
      code: "custom",
      message: `filters cannot contain more than ${MAX_TOTAL_FILTER_VALUES} structured values`,
    });
  }

  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(serializeFilters(filters))) {
    if (value !== undefined) params.append(name, String(value));
  }
  if (new TextEncoder().encode(params.toString()).length > MAX_SERIALIZED_FILTER_BYTES) {
    context.addIssue({
      code: "custom",
      message: `serialized filters cannot exceed ${MAX_SERIALIZED_FILTER_BYTES} bytes`,
    });
  }
}

export const filtersSchema = z.object(filterFields).strict().superRefine(validateFilterBudget);

// Performance events in Umami 3.2 persist the page identity and environment
// dimensions below on both supported database backends. Other general filters
// either target fields that are absent from performance events or are parsed by
// Umami without being applied by the performance report (notably
// excludeBounce). Keep this schema deliberately narrower than filtersSchema so
// a requested scope can never be weakened silently.
const performanceFilterFields = {
  browser: filterFields.browser,
  city: filterFields.city,
  cohort: filterFields.cohort,
  country: filterFields.country,
  device: filterFields.device,
  language: filterFields.language,
  match: filterFields.match,
  os: filterFields.os,
  path: filterFields.path,
  region: filterFields.region,
  title: filterFields.title,
};

export const performanceFiltersSchema = z
  .object(performanceFilterFields)
  .strict()
  .superRefine(validateFilterBudget);

const { path: _routePath, ...routePerformanceFilterFields } = performanceFilterFields;
export const routePerformanceFiltersSchema = z
  .object(routePerformanceFilterFields)
  .strict()
  .superRefine(validateFilterBudget);

export const TRAFFIC_CHANNELS = [
  "direct",
  "paidAds",
  "referral",
  "affiliate",
  "sms",
  "llm",
  "organicSearch",
  "paidSearch",
  "organicSocial",
  "paidSocial",
  "email",
  "organicShopping",
  "paidShopping",
  "organicVideo",
  "paidVideo",
] as const;

export const trafficChannelSchema = z.enum(TRAFFIC_CHANNELS);

export const segmentedFiltersSchema = z
  .object({ ...filterFields, channel: trafficChannelSchema.optional() })
  .strict()
  .superRefine(validateFilterBudget);

export const trafficSegmentSchema = z.enum(["all", "human"]).default("all");

type FilterCondition = {
  operator: z.infer<typeof filterOperatorSchema>;
  value?: string | string[];
};

const UPSTREAM_OPERATORS: Record<FilterCondition["operator"], string> = {
  equals: "eq",
  not_equals: "neq",
  contains: "c",
  not_contains: "dnc",
  regex: "re",
  not_regex: "nre",
  is_empty: "eq",
  is_not_empty: "neq",
};

function isFilterCondition(value: unknown): value is FilterCondition {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && "operator" in value
  );
}

function encodeFilterCondition(condition: FilterCondition): string {
  const value =
    condition.operator === "is_empty" || condition.operator === "is_not_empty"
      ? ""
      : Array.isArray(condition.value)
        ? condition.value.join(",")
        : condition.value;
  return `${UPSTREAM_OPERATORS[condition.operator]}.${value ?? ""}`;
}

export function serializeFilters(filters: Record<string, unknown> | undefined): Query {
  const serialized: Record<string, QueryValue> = {};
  for (const [name, value] of Object.entries(filters ?? {})) {
    if (value === undefined) continue;
    const conditions = isFilterCondition(value)
      ? [value]
      : Array.isArray(value) && value.every(isFilterCondition)
        ? value
        : undefined;
    if (!conditions) {
      if (name === "referrer" && value === "") {
        serialized.domain1 = "eq.";
        continue;
      }
      serialized[name] = value as QueryValue;
      continue;
    }

    // Umami's public `referrer` filter always removes internal/direct rows. Its
    // equivalent `domain` column has neutral equality semantics, and a numeric
    // suffix makes it survive the upstream route's dynamic-filter parser.
    const upstreamName = name === "referrer" ? "domain" : name;
    conditions.forEach((condition, index) => {
      const suffix = name === "referrer" ? index + 1 : index;
      const key = suffix === 0 ? upstreamName : `${upstreamName}${suffix}`;
      serialized[key] = encodeFilterCondition(condition);
    });
  }
  return serialized;
}

export function appendReferrerExclusions(filters: Query, domains: readonly string[]): Query {
  const values = [...new Set(domains.map((domain) => domain.trim()).filter(Boolean))].filter(
    (domain) => !domain.includes(","),
  );
  if (values.length === 0) return filters;
  if (filters.match === "any") {
    throw new UmamiError(
      "VALIDATION_ERROR",
      'trafficSegment="human" cannot be combined with filters.match="any" because Umami cannot apply mandatory spam exclusions outside that OR group.',
    );
  }
  let suffix = 1;
  while (`domain${suffix}` in filters) suffix += 1;
  return { ...filters, [`domain${suffix}`]: `neq.${values.join(",")}` };
}

export function rangeQuery(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
  options: {
    filters?: z.infer<typeof filtersSchema>;
    serializedFilters?: Query;
    timezone?: string;
    unit?: string;
  } = {},
): Query {
  const range = parseTimeRange(start, end, maxRangeDays);
  const { excludeBounce, ...filters } =
    options.serializedFilters ?? serializeFilters(options.filters);
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
    serializedFilters?: Query;
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
