import { describe, expect, it } from "vitest";
import { parseTimeRange } from "../src/time.js";

describe("parseTimeRange", () => {
  it("interprets date-only ranges as inclusive UTC days", () => {
    expect(parseTimeRange("2026-07-01", "2026-07-02", 30)).toEqual({
      startAt: Date.parse("2026-07-01T00:00:00.000Z"),
      endAt: Date.parse("2026-07-02T23:59:59.999Z"),
    });
  });

  it("rejects normalized but impossible calendar dates", () => {
    expect(() => parseTimeRange("2026-02-31", "2026-03-02", 10)).toThrow(
      "supplied date or timestamp is invalid",
    );
  });

  it("accepts explicit offsets and integer milliseconds", () => {
    const start = Date.parse("2026-07-01T00:00:00+03:00");
    const end = start + 1_000;
    expect(parseTimeRange("2026-07-01T00:00:00+03:00", end, 1)).toEqual({
      startAt: start,
      endAt: end,
    });
  });

  it("rejects ambiguous local date-times", () => {
    expect(() => parseTimeRange("2026-07-01T12:00:00", "2026-07-01T13:00:00", 1)).toThrow(
      "include Z or an explicit UTC offset",
    );
  });

  it("rejects reversed and oversized ranges", () => {
    expect(() => parseTimeRange(2, 1, 1)).toThrow("start must be earlier");
    expect(() => parseTimeRange("2026-01-01", "2026-02-01", 7)).toThrow(
      "configured maximum of 7 days",
    );
  });

  it("rejects integer timestamps outside the ECMAScript Date range", () => {
    expect(() => parseTimeRange(8_640_000_000_000_001, 8_640_000_000_000_001, 1)).toThrow(
      "positive integer milliseconds",
    );
  });
});
