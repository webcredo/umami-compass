import { UmamiError } from "./api/errors.js";

export type TimeInput = number | string;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

function assertCalendarDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (!match) return;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new UmamiError("VALIDATION_ERROR", "The supplied date or timestamp is invalid.");
  }
}

function parseTimestamp(value: TimeInput, edge: "start" | "end"): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
      throw new UmamiError("VALIDATION_ERROR", "Timestamps must be positive integer milliseconds.");
    }
    return value;
  }

  const trimmed = value.trim();
  assertCalendarDate(trimmed);
  const normalized = DATE_ONLY.test(trimmed)
    ? `${trimmed}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : trimmed;
  if (!DATE_ONLY.test(trimmed) && !HAS_TIMEZONE.test(trimmed)) {
    throw new UmamiError(
      "VALIDATION_ERROR",
      "Date-times must include Z or an explicit UTC offset; date-only values are interpreted in UTC.",
    );
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new UmamiError("VALIDATION_ERROR", "The supplied date or timestamp is invalid.");
  }
  return timestamp;
}

export function parseTimeRange(
  start: TimeInput,
  end: TimeInput,
  maxRangeDays: number,
): { startAt: number; endAt: number } {
  const startAt = parseTimestamp(start, "start");
  const endAt = parseTimestamp(end, "end");
  if (startAt > endAt) {
    throw new UmamiError("VALIDATION_ERROR", "start must be earlier than or equal to end.");
  }
  if (endAt - startAt > maxRangeDays * 86_400_000) {
    throw new UmamiError(
      "VALIDATION_ERROR",
      `The requested range exceeds the configured maximum of ${maxRangeDays} days.`,
    );
  }
  return { startAt, endAt };
}
