import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "../src/api/client.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const WEBSITE_ID = "6b2c8c10-908c-4a8e-a924-4049eb3bde8c";
const SECOND_WEBSITE_ID = "7af8e5ad-83f1-4f50-8db6-26d95b32ec19";
const connected: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: Parameters<Fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function websitePage(data: unknown[]) {
  return { data, count: data.length, page: 1, pageSize: 100 };
}

function totals(pageviews: number, comparisonPageviews = pageviews) {
  return {
    pageviews,
    visitors: Math.round(pageviews / 2),
    visits: Math.round(pageviews / 1.5),
    bounces: Math.round(pageviews / 4),
    totaltime: pageviews * 10,
    comparison: {
      pageviews: comparisonPageviews,
      visitors: Math.round(comparisonPageviews / 2),
      visits: Math.round(comparisonPageviews / 1.5),
      bounces: Math.round(comparisonPageviews / 4),
      totaltime: comparisonPageviews * 10,
    },
  };
}

function plainTotals(pageviews: number) {
  return {
    pageviews,
    visitors: Math.round(pageviews / 2),
    visits: Math.round(pageviews / 1.5),
    bounces: Math.round(pageviews / 4),
    totaltime: pageviews * 10,
  };
}

function performanceSummary(lcp: number, count = 500) {
  return {
    summary: {
      lcp: { p50: lcp - 500, p75: lcp, p95: lcp + 500 },
      inp: { p50: 100, p75: 150, p95: 250 },
      cls: { p50: 0.05, p75: 0.08, p95: 0.2 },
      fcp: { p50: 1_000, p75: 1_500, p95: 2_000 },
      ttfb: { p50: 300, p75: 500, p95: 900 },
      count,
    },
    chart: [],
    pages: [],
    pageTitles: [],
    devices: [],
    browsers: [],
  };
}

async function connect(fetchMock: Fetch) {
  const server = createServer({
    config: loadConfig({ UMAMI_API_KEY: "test-key", UMAMI_TOOLSETS: "insights" }),
    fetch: fetchMock,
  });
  const client = new Client({ name: "umami-compass-insights-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    connected.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("Umami Compass insights", () => {
  it("exposes seven bounded read-only insight workflows", async () => {
    const client = await connect(vi.fn<Fetch>());
    const result = await client.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      "resolve_website",
      "get_portfolio_overview",
      "analyze_performance_portfolio",
      "explain_traffic_change",
      "compare_traffic_series",
      "analyze_release_impact",
      "tracking_health_check",
    ]);
    expect(result.tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
    expect(result.tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
  });

  it("resolves a URL to an exact website without guessing", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        expect(url.searchParams.get("search")).toBe("coupon.guru");
        return json(
          websitePage([{ id: WEBSITE_ID, name: "Coupon Guru", domain: "www.coupon.guru" }]),
        );
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "resolve_website",
      arguments: { query: "https://coupon.guru/deals" },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        status: "resolved",
        matchType: "domain",
        confidence: "exact",
        website: { id: WEBSITE_ID, domain: "www.coupon.guru" },
      },
      meta: { dataStatus: "available", truncated: false },
    });
  });

  it("returns a singleton fuzzy website match as a candidate instead of guessing", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(
          websitePage([{ id: WEBSITE_ID, name: "Main Shop", domain: "coupons.example" }]),
        );
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "resolve_website",
      arguments: { query: "shop" },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        status: "ambiguous",
        candidates: [{ website: { id: WEBSITE_ID }, confidence: "fuzzy", matchType: "name" }],
      },
      meta: { dataStatus: "available" },
    });
  });

  it("analyzes portfolio Web Vitals with coverage, confidence and bounded drill-down", async () => {
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(websitePage([{ id: WEBSITE_ID, name: "Store", domain: "store.example" }]));
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        const current = Date.parse(body.parameters.startDate) >= Date.parse("2026-07-01");
        const lcp = current ? 3_000 : 2_000;
        return json({
          ...performanceSummary(lcp, current ? 2_600 : 2_400),
          pages: [
            { name: "/casino/example", p50: lcp - 500, p75: lcp, p95: lcp + 500, count: 500 },
          ],
          devices: [{ name: "Desktop", p50: lcp - 500, p75: lcp, p95: lcp + 500, count: 600 }],
        });
      }
      if (url.pathname.endsWith("/stats")) {
        const current = Number(url.searchParams.get("startAt")) >= Date.parse("2026-07-01");
        return json(plainTotals(current ? 3_000 : 2_800));
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_performance_portfolio",
      arguments: {
        start: "2026-07-01",
        end: "2026-07-07",
        metrics: ["lcp", "ttfb"],
        detailMetric: "lcp",
        detailSiteLimit: 1,
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const data = (result.structuredContent as { data?: unknown } | undefined)?.data as {
      coverage: { failedWebsites: number; successfulWebsites: number };
      dataStatus: string;
      details: Array<{
        devices: { dataStatus: string };
        metric: string;
        pages: { dataStatus: string };
        website: { id: string };
      }>;
      leaders: { regressions: Array<{ impact: string; metric: string; website: { id: string } }> };
      sites: Array<{
        comparison: { confidence: string };
        coverage: {
          currentPageviews: number;
          currentPerformanceEventsPerPageviewPercent: number;
        };
        website: { id: string };
      }>;
    };
    expect(data.dataStatus).toBe("available");
    expect(data.coverage).toMatchObject({ successfulWebsites: 1, failedWebsites: 0 });
    expect(data.leaders.regressions[0]).toMatchObject({
      website: { id: WEBSITE_ID },
      metric: "lcp",
      impact: "regressed",
    });
    expect(data.details[0]).toMatchObject({
      website: { id: WEBSITE_ID },
      metric: "lcp",
      pages: { dataStatus: "available" },
      devices: { dataStatus: "available" },
    });
    expect(data.sites[0]).toMatchObject({
      website: { id: WEBSITE_ID },
      coverage: { currentPageviews: 3_000 },
      comparison: { confidence: "high" },
    });
    expect(data.sites[0]?.coverage.currentPerformanceEventsPerPageviewPercent).toBeCloseTo(
      86.67,
      1,
    );
  });

  it("builds a portfolio overview with leaders, stale tracking, and anomalies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(
          websitePage([
            { id: WEBSITE_ID, name: "Growing", domain: "growing.example" },
            { id: SECOND_WEBSITE_ID, name: "Falling", domain: "falling.example" },
          ]),
        );
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      const isCurrent =
        Number(url.searchParams.get("startAt")) >= Date.parse("2026-07-06T00:00:00.000Z");
      if (url.pathname.endsWith(`/${WEBSITE_ID}/stats`)) {
        return json(plainTotals(isCurrent ? 100 : 50));
      }
      if (url.pathname.endsWith(`/${SECOND_WEBSITE_ID}/stats`)) {
        return json(plainTotals(isCurrent ? 20 : 40));
      }
      if (url.pathname.endsWith(`/${WEBSITE_ID}/daterange`)) {
        return json({ startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-07-13T11:00:00.000Z" });
      }
      if (url.pathname.endsWith(`/${SECOND_WEBSITE_ID}/daterange`)) {
        return json({ startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-07-01T00:00:00.000Z" });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "get_portfolio_overview",
      arguments: {
        start: "2026-07-06",
        end: "2026-07-12",
        anomalyThresholdPercent: 75,
        anomalyMinimumPageviews: 50,
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        coverage: { visibleWebsites: 2, successfulWebsites: 2, failedWebsites: 0 },
        totals: { current: { pageviews: 120 }, comparison: { pageviews: 90 } },
        leaders: {
          growth: [{ website: { id: WEBSITE_ID }, percent: 100 }],
          decline: [{ website: { id: SECOND_WEBSITE_ID }, percent: -50 }],
        },
        attention: {
          staleOrMissing: [{ website: { id: SECOND_WEBSITE_ID } }],
          anomalies: [{ website: { id: WEBSITE_ID }, anomaly: { direction: "spike" } }],
        },
      },
      meta: {
        dataStatus: "available",
        requestedRange: { start: "2026-07-06", end: "2026-07-12" },
      },
    });
  });

  it("isolates a per-site portfolio permission failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(
          websitePage([
            { id: WEBSITE_ID, name: "Allowed", domain: "allowed.example" },
            { id: SECOND_WEBSITE_ID, name: "Restricted", domain: "restricted.example" },
          ]),
        );
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      const isCurrent =
        Number(url.searchParams.get("startAt")) >= Date.parse("2026-07-06T00:00:00.000Z");
      if (url.pathname.endsWith(`/${WEBSITE_ID}/stats`)) {
        return json(plainTotals(isCurrent ? 50 : 40));
      }
      if (url.pathname.endsWith(`/${SECOND_WEBSITE_ID}/stats`)) return json({}, 403);
      if (url.pathname.endsWith("/daterange")) {
        return json({
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-07-13T11:00:00.000Z",
        });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "get_portfolio_overview",
      arguments: { start: "2026-07-06", end: "2026-07-12" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        coverage: { successfulWebsites: 1, failedWebsites: 1 },
        attention: {
          failures: [
            {
              website: { id: SECOND_WEBSITE_ID },
              error: { code: "FORBIDDEN", status: 403 },
            },
          ],
        },
      },
    });
  });

  it("marks a fully unavailable portfolio as unknown instead of available", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(
          websitePage([
            { id: WEBSITE_ID, name: "One", domain: "one.example" },
            { id: SECOND_WEBSITE_ID, name: "Two", domain: "two.example" },
          ]),
        );
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/stats")) return json({}, 403);
      if (url.pathname.endsWith("/daterange")) return json({ startDate: null, endDate: null });
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "get_portfolio_overview",
      arguments: { start: "2026-07-06", end: "2026-07-12" },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        dataStatus: "unknown",
        coverage: { successfulWebsites: 0, failedWebsites: 2 },
      },
      meta: { dataStatus: "unknown" },
    });
  });

  it("marks a zero-traffic portfolio with an explicit baseline as empty", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(websitePage([{ id: WEBSITE_ID, name: "Empty", domain: "empty.example" }]));
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/stats")) return json(plainTotals(0));
      if (url.pathname.endsWith("/daterange")) {
        return json({ startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-07-12T00:00:00.000Z" });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "get_portfolio_overview",
      arguments: { start: "2026-07-06", end: "2026-07-12" },
    });

    expect(result.structuredContent).toMatchObject({
      data: { dataStatus: "empty", totals: { current: { pageviews: 0 } } },
      meta: { dataStatus: "empty", emptyReason: "no_data_in_range" },
    });
  });

  it("explains traffic changes with visitor-based breakdown evidence", async () => {
    const currentStart = Date.parse("2026-07-01T00:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
      if (url.pathname.endsWith("/stats")) return json(totals(isCurrent ? 100 : 80));
      if (url.pathname.endsWith("/metrics")) {
        return json(
          isCurrent
            ? [
                { x: "/pricing", y: 30 },
                { x: "/", y: 50 },
              ]
            : [
                { x: "/pricing", y: 10 },
                { x: "/", y: 60 },
              ],
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["path"],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        direction: "increase",
        breakdownMeasure: "visitors",
        changes: { pageviews: { absolute: 20, percent: 25 } },
        leadingObservedChanges: [{ dimension: "path", name: "/pricing", delta: 20, percent: 200 }],
        dataQuality: { unavailableDimensions: [] },
      },
      meta: { websiteId: WEBSITE_ID, dataStatus: "available", timezone: "UTC" },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("not proof of causation");
  });

  it("omits top-N rows whose missing-period value is unknown", async () => {
    const currentStart = Date.parse("2026-07-01T00:00:00.000Z");
    const currentRows = Array.from({ length: 20 }, (_, index) => ({
      x: `/shared-${index}`,
      y: 100 - index,
    }));
    const comparisonRows = [{ x: "/outside-current-top", y: 150 }, ...currentRows.slice(0, 19)];
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
      if (url.pathname.endsWith("/stats")) return json(plainTotals(isCurrent ? 100 : 80));
      if (url.pathname.endsWith("/metrics")) {
        expect(url.searchParams.get("limit")).toBe("20");
        return json(isCurrent ? currentRows : comparisonRows);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["path"],
        limit: 1,
      },
    });
    const text = JSON.stringify(result.structuredContent);

    expect(text).not.toContain("outside-current-top");
    expect(result.structuredContent).toMatchObject({
      data: {
        dataQuality: {
          truncatedDimensions: ["path"],
          omittedUncertainRows: 2,
        },
      },
      meta: { dataStatus: "available", truncated: true },
    });
  });

  it("marks an all-zero traffic comparison as empty", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) return json(plainTotals(0));
      if (url.pathname.endsWith("/metrics")) return json([]);
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["path"],
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: { dataStatus: "empty", direction: "flat" },
      meta: { dataStatus: "empty", emptyReason: "no_data_in_range" },
    });
  });

  it("flags referral-spam evidence directly in a traffic explanation", async () => {
    const currentStart = Date.parse("2026-07-01T00:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/metrics/expanded")) {
        expect(url.searchParams.get("type")).toBe("referrer");
        return json([
          {
            name: "xpwesthmfqphh.com",
            pageviews: 100,
            visitors: 100,
            visits: 100,
            bounces: 98,
            totaltime: 0,
          },
        ]);
      }
      const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
      if (url.pathname.endsWith("/stats")) return json(plainTotals(isCurrent ? 100 : 80));
      if (url.pathname.endsWith("/metrics")) {
        return json([{ x: "/", y: isCurrent ? 50 : 40 }]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["path"],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        trafficQuality: {
          trafficSegment: "all",
          exclusionApplied: false,
          current: {
            status: "available",
            suspiciousReferrers: [{ name: "xpwesthmfqphh.com", confidence: "high" }],
          },
        },
      },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("referral-spam pattern");
  });

  it("filters explain_traffic_change to one attributed channel", async () => {
    const currentStart = Date.parse("2026-07-01T00:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
      if (url.pathname.endsWith("/metrics/expanded")) {
        if (url.searchParams.get("type") === "referrer") return json([]);
        const mobile = url.searchParams.get("device") === "eq.mobile";
        return json([
          {
            name: "direct",
            pageviews: mobile ? (isCurrent ? 40 : 15) : isCurrent ? 70 : 50,
            visitors: mobile ? (isCurrent ? 30 : 10) : isCurrent ? 50 : 40,
            visits: mobile ? (isCurrent ? 35 : 12) : isCurrent ? 60 : 45,
            bounces: 5,
            totaltime: 200,
          },
        ]);
      }
      if (url.pathname.endsWith("/metrics")) {
        expect(url.searchParams.get("type")).toBe("device");
        return json([{ x: "mobile", y: isCurrent ? 30 : 10 }]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["channel", "device"],
        filters: { channel: "direct" },
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        channel: "direct",
        current: { pageviews: 70, visitors: 50 },
        comparison: { pageviews: 50, visitors: 40 },
        breakdowns: [
          { dimension: "channel", rows: [{ name: "direct", delta: 10 }] },
          {
            dimension: "device",
            rows: [{ name: "mobile", current: 30, comparison: 10, delta: 20 }],
            dataQuality: { fanoutRequests: 2 },
          },
        ],
      },
    });
  });

  it.each([
    ["explain_traffic_change", { start: "2026-07-01", end: "2026-07-02", dimensions: ["device"] }],
    [
      "analyze_release_impact",
      {
        releaseAt: "2026-07-01T00:00:00.000Z",
        windowDays: 7,
        dimensions: ["device"],
        detailLevel: "full",
      },
    ],
  ])("rejects %s channel fan-out inside match=any", async (name, arguments_) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name,
      arguments: {
        websiteId: WEBSITE_ID,
        ...arguments_,
        filters: { channel: "direct", match: "any", path: "/landing" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("cannot require candidate predicates");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fills sparse daily series before aligning relative buckets", async () => {
    const currentStart = Date.parse("2026-07-01T00:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/metrics/expanded")) return json([]);
      if (url.pathname.endsWith("/pageviews")) {
        const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
        return json({
          pageviews: isCurrent
            ? [
                { x: "2026-07-01", y: 100 },
                { x: "2026-07-03", y: 10 },
              ]
            : [
                { x: "2026-06-28", y: 90 },
                { x: "2026-06-29", y: 80 },
                { x: "2026-06-30", y: 70 },
              ],
          sessions: isCurrent
            ? [
                { x: "2026-07-01", y: 70 },
                { x: "2026-07-03", y: 8 },
              ]
            : [
                { x: "2026-06-28", y: 65 },
                { x: "2026-06-30", y: 60 },
              ],
        });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "compare_traffic_series",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-03",
        unit: "day",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        buckets: [
          {
            index: 0,
            current: { x: "2026-07-01", pageviews: 100, sessions: 70 },
            comparison: { x: "2026-06-28", pageviews: 90, sessions: 65 },
            pageviewChange: { absolute: 10 },
          },
          {
            index: 1,
            current: { x: "2026-07-02", pageviews: 0, sessions: 0 },
            comparison: { x: "2026-06-29", pageviews: 80, sessions: 0 },
            pageviewChange: { absolute: -80, percent: -100 },
          },
          {
            index: 2,
            current: { x: "2026-07-03", pageviews: 10, sessions: 8 },
            comparison: { x: "2026-06-30", pageviews: 70, sessions: 60 },
            pageviewChange: { absolute: -60 },
          },
        ],
        dataQuality: {
          sparseBucketsFilled: true,
          currentBucketCount: 3,
          comparisonBucketCount: 3,
          equalBucketCount: true,
        },
      },
      meta: { dataStatus: "available", timezone: "UTC" },
    });
  });

  it("does not invent a nonexistent hourly bucket during DST spring-forward", async () => {
    const currentStart = Date.parse("2026-03-08T05:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/metrics/expanded")) return json([]);
      if (url.pathname.endsWith("/pageviews")) {
        const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
        return json({
          pageviews: (isCurrent ? ["00", "01", "03", "04"] : ["00", "01", "02", "03"]).map(
            (hour, index) => ({
              x: `${isCurrent ? "2026-03-08" : "2026-03-01"} ${hour}:00:00`,
              y: 100 + index,
            }),
          ),
          sessions: [],
        });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "compare_traffic_series",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-08T08:59:59.999Z",
        comparisonMode: "custom",
        comparisonStart: "2026-03-01T05:00:00.000Z",
        comparisonEnd: "2026-03-01T08:59:59.999Z",
        unit: "hour",
        timezone: "America/New_York",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        buckets: [
          { current: { x: "2026-03-08 00" }, comparison: { x: "2026-03-01 00" } },
          { current: { x: "2026-03-08 01" }, comparison: { x: "2026-03-01 01" } },
          { current: { x: "2026-03-08 03" }, comparison: { x: "2026-03-01 02" } },
          { current: { x: "2026-03-08 04" }, comparison: { x: "2026-03-01 03" } },
        ],
        dataQuality: {
          sparseBucketsFilled: true,
          currentBucketCount: 4,
          comparisonBucketCount: 4,
          equalBucketCount: true,
        },
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("2026-03-08 02");
  });

  it("omits shifted deltas when DST fall-back produces unequal local bucket counts", async () => {
    const currentStart = Date.parse("2026-11-01T04:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/metrics/expanded")) return json([]);
      if (url.pathname.endsWith("/pageviews")) {
        const isCurrent = Number(url.searchParams.get("startAt")) >= currentStart;
        const pageviews = Array.from({ length: 24 }, (_, hour) => ({
          x: `${isCurrent ? "2026-11-01" : "2026-10-25"} ${String(hour).padStart(2, "0")}:00:00`,
          y: 100 + hour,
        }));
        if (!isCurrent) pageviews.push({ x: "2026-10-26 00:00:00", y: 124 });
        return json({ pageviews, sessions: [] });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "compare_traffic_series",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-11-01T04:00:00.000Z",
        end: "2026-11-02T04:59:59.999Z",
        comparisonMode: "custom",
        comparisonStart: "2026-10-25T04:00:00.000Z",
        comparisonEnd: "2026-10-26T04:59:59.999Z",
        unit: "hour",
        timezone: "America/New_York",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        buckets: [],
        dataQuality: {
          currentBucketCount: 24,
          comparisonBucketCount: 25,
          equalBucketCount: false,
          alignedChangesAvailable: false,
          alignmentIssue: expect.stringContaining("aligned deltas are omitted"),
        },
      },
    });
  });

  it("fails closed when sparse-series human exclusions would join match=any", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/metrics/expanded")) {
        return json([
          {
            name: "xpwesthmfqphh.com",
            pageviews: 10,
            visitors: 10,
            visits: 10,
            bounces: 10,
            totaltime: 0,
          },
        ]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "compare_traffic_series",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-03",
        filters: { match: "any", path: "/landing" },
        trafficSegment: "human",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("mandatory spam exclusions");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed expanded channel rows", async () => {
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/metrics/expanded")) {
        if (url.searchParams.get("type") === "referrer") return json([]);
        return json([
          {
            name: "direct",
            pageviews: 10,
            visitors: 8,
            visits: 9,
            bounces: 1,
          },
        ]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "explain_traffic_change",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        dimensions: ["channel"],
        filters: { channel: "direct" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("invalid expanded metric data");
  });

  it("compares equal release windows and reports mixed traffic and performance evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(totals(Number(url.searchParams.get("startAt")) >= releaseTime ? 1_200 : 1_000));
      }
      if (url.pathname.endsWith("/metrics")) {
        return json(
          Number(url.searchParams.get("startAt")) >= releaseTime
            ? [{ x: "/checkout", y: 600 }]
            : [{ x: "/checkout", y: 500 }],
        );
      }
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        return json(
          performanceSummary(Date.parse(body.parameters.startDate) >= releaseTime ? 3_000 : 2_000),
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        detailLevel: "full",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        partialPostWindow: false,
        comparability: { equalDuration: true, dayOfWeekAligned: true },
        assessment: {
          verdict: "mixed",
          trafficImpact: "positive",
          performanceRegressions: ["lcp"],
        },
        performance: {
          status: "available",
          changes: { lcp: { impact: "regressed", currentP75: 3_000 } },
        },
      },
      meta: { websiteId: WEBSITE_ID, timezone: "UTC" },
    });
  });

  it("excludes unscoped Web Vitals from a channel-specific release verdict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/metrics/expanded")) {
        if (url.searchParams.get("type") === "referrer") return json([]);
        const current = Number(url.searchParams.get("startAt")) >= releaseTime;
        return json([
          {
            name: "direct",
            pageviews: current ? 800 : 600,
            visitors: current ? 600 : 450,
            visits: current ? 700 : 500,
            bounces: 100,
            totaltime: 10_000,
          },
        ]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["channel"],
        filters: { channel: "direct" },
        detailLevel: "full",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        traffic: {
          scope: { channel: "direct" },
          current: { pageviews: 800 },
          comparison: { pageviews: 600 },
        },
        assessment: {
          verdict: "traffic_change_only",
          performanceRegressions: [],
          performanceImprovements: [],
          performanceScopeComparable: false,
          confidence: "low",
        },
        performance: {
          status: "scope_mismatch",
          scope: { requestedChannel: "direct", performanceChannel: "all" },
        },
      },
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).pathname.endsWith("/reports/performance"),
      ),
    ).toBe(false);
  });

  it("does not pretend referral exclusions can be applied to performance events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/metrics/expanded")) {
        return json([
          {
            name: "xpwesthmfqphh.com",
            pageviews: 100,
            visitors: 100,
            visits: 100,
            bounces: 98,
            totaltime: 0,
          },
        ]);
      }
      if (url.pathname.endsWith("/stats")) {
        expect(url.searchParams.get("domain1")).toBe("neq.xpwesthmfqphh.com");
        return json(
          plainTotals(Number(url.searchParams.get("startAt")) >= releaseTime ? 800 : 600),
        );
      }
      if (url.pathname.endsWith("/metrics")) {
        expect(url.searchParams.get("domain1")).toBe("neq.xpwesthmfqphh.com");
        return json([]);
      }
      if (url.pathname.endsWith("/reports/performance")) {
        throw new Error("Performance must not be queried with an unsupported referrer scope.");
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        trafficSegment: "human",
        detailLevel: "full",
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        traffic: {
          scope: {
            channel: "all",
            excludedReferrers: ["xpwesthmfqphh.com"],
          },
        },
        performance: {
          status: "scope_mismatch",
          scope: {
            channel: "all",
            excludedReferrers: ["xpwesthmfqphh.com"],
          },
        },
      },
    });
  });

  it("does not turn a 1 ms Web Vital change and traffic noise into a regression", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(plainTotals(Number(url.searchParams.get("startAt")) >= releaseTime ? 95 : 100));
      }
      if (url.pathname.endsWith("/metrics")) return json([]);
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        return json(
          performanceSummary(Date.parse(body.parameters.startDate) >= releaseTime ? 2_001 : 2_000),
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        detailLevel: "full",
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        assessment: {
          verdict: "no_clear_change",
          trafficImpact: "neutral",
          performanceRegressions: [],
          confidence: "low",
        },
        performance: {
          sampleSufficient: true,
          changes: { lcp: { impact: "unchanged", material: false, absolute: 1 } },
        },
      },
    });
  });

  it("keeps performance evidence inconclusive when sample counts are too small", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(
          plainTotals(Number(url.searchParams.get("startAt")) >= releaseTime ? 400 : 600),
        );
      }
      if (url.pathname.endsWith("/metrics")) return json([]);
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        return json(
          performanceSummary(
            Date.parse(body.parameters.startDate) >= releaseTime ? 4_000 : 2_000,
            10,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        detailLevel: "full",
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        executiveSummary: {
          verdict: "insufficient_data",
          evidenceVerdict: "no_clear_change",
          performance: { status: "insufficient_data" },
        },
        assessment: {
          verdict: "insufficient_data",
          performanceRegressions: [],
          confidence: "low",
        },
        sampleReadiness: {
          performance: {
            postReleaseSamplesNeeded: 90,
            baselineSamplesNeeded: 90,
            recheckAt: null,
            recommendedWindowDays: null,
          },
        },
        performance: {
          sampleSufficient: false,
          changes: { lcp: { impact: "inconclusive", material: false } },
        },
      },
    });
  });

  it("treats a pageview drop with stable audience counts as reduced browsing depth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(
          Number(url.searchParams.get("startAt")) >= releaseTime
            ? {
                pageviews: 711,
                visitors: 106,
                visits: 106,
                bounces: 30,
                totaltime: 10_000,
              }
            : {
                pageviews: 1_000,
                visitors: 100,
                visits: 100,
                bounces: 30,
                totaltime: 10_000,
              },
        );
      }
      if (url.pathname.endsWith("/metrics")) return json([]);
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        includePerformance: false,
        otherReleases: [],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        detailLevel: "summary",
        periods: {
          before: {
            start: "2026-06-24T00:00:00.000Z",
            end: "2026-06-30T23:59:59.999Z",
          },
          after: {
            start: "2026-07-01T00:00:00.000Z",
            end: "2026-07-07T23:59:59.999Z",
          },
        },
        comparability: { equalDuration: true, dayOfWeekAligned: true },
        executiveSummary: {
          verdict: "no_clear_change",
          traffic: {
            impact: "neutral",
            pattern: "reduced_page_depth",
            pageviewsChangePercent: -28.9,
            visitorsChangePercent: 6,
            visitsChangePercent: 6,
            pageviewsPerVisitChangePercent: -32.92,
          },
          attribution: "no_competing_releases_reported",
          recommendedChecks: expect.arrayContaining([
            "Inspect landing pages, exits, navigation changes, and duplicate/missing pageview tracking; audience volume did not materially decline.",
          ]),
        },
        sampleReadiness: {
          traffic: { status: "sufficient" },
          performance: { status: "not_requested" },
        },
      },
    });
    expect((result.structuredContent as { data: Record<string, unknown> }).data).not.toHaveProperty(
      "traffic",
    );
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith("/metrics")),
    ).toBe(false);
  });

  it("marks an observed release change as confounded when another deployment overlaps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(
          plainTotals(Number(url.searchParams.get("startAt")) >= releaseTime ? 800 : 600),
        );
      }
      if (url.pathname.endsWith("/metrics")) return json([]);
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        includePerformance: false,
        otherReleases: [
          { releaseAt, id: "target-duplicate" },
          { releaseAt: "2026-07-03T00:00:00.000Z", id: "#1002" },
          { releaseAt: "2026-06-01T00:00:00.000Z", id: "outside" },
        ],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        executiveSummary: {
          verdict: "confounded",
          evidenceVerdict: "traffic_change_only",
          attribution: "confounded",
        },
        releaseContext: {
          status: "confounded",
          competingReleases: [{ releaseAt: "2026-07-03T00:00:00.000Z", id: "#1002" }],
          releasesOutsideAnalysisWindow: 1,
          duplicateTargetReleasesIgnored: 1,
        },
      },
    });
  });

  it("estimates a recheck date for a partial window with a viable sample rate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-02T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) return json(plainTotals(600));
      if (url.pathname.endsWith("/metrics")) return json([]);
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        return json(
          performanceSummary(
            Date.parse(body.parameters.startDate) >= releaseTime ? 4_000 : 2_000,
            50,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        otherReleases: [],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        partialPostWindow: true,
        executiveSummary: {
          verdict: "insufficient_data",
          recheckAt: "2026-07-04T00:00:00.000Z",
        },
        sampleReadiness: {
          performance: {
            status: "waiting",
            postReleaseSamplesNeeded: 50,
            baselineSamplesNeeded: 50,
            recheckAt: "2026-07-04T00:00:00.000Z",
            recommendedWindowDays: 3,
          },
          recheckAt: "2026-07-04T00:00:00.000Z",
        },
      },
    });
  });

  it("does not invent a recheck date when the post-release sample rate is zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-02T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) return json(plainTotals(600));
      if (url.pathname.endsWith("/metrics")) return json([]);
      if (url.pathname.endsWith("/reports/performance")) {
        const body = JSON.parse(String(init?.body)) as { parameters: { startDate: string } };
        return json(
          performanceSummary(
            Date.parse(body.parameters.startDate) >= releaseTime ? 4_000 : 2_000,
            0,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        otherReleases: [],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        executiveSummary: { verdict: "insufficient_data", recheckAt: null },
        sampleReadiness: {
          performance: {
            status: "estimate_unavailable",
            postReleaseSamplesNeeded: 100,
            baselineSamplesNeeded: 100,
            recheckAt: null,
            reason: "A recheck date cannot be estimated from a zero observed sample rate.",
          },
        },
      },
    });
  });

  it("returns insufficient data when traffic has a zero comparison baseline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const releaseAt = "2026-07-01T00:00:00.000Z";
    const releaseTime = Date.parse(releaseAt);
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith(`/websites/${WEBSITE_ID}`)) {
        return json({ id: WEBSITE_ID, name: "Store", domain: "store.example" });
      }
      if (url.pathname.endsWith("/stats")) {
        return json(plainTotals(Number(url.searchParams.get("startAt")) >= releaseTime ? 600 : 0));
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "analyze_release_impact",
      arguments: {
        websiteId: WEBSITE_ID,
        releaseAt,
        windowDays: 7,
        dimensions: ["path"],
        includePerformance: false,
        otherReleases: [],
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        executiveSummary: {
          verdict: "insufficient_data",
          traffic: {
            impact: "neutral",
            evidenceSufficient: false,
            pageviewsChangePercent: null,
          },
          recommendedChecks: expect.arrayContaining([
            "Choose a baseline with non-zero traffic; percentage change from zero is undefined.",
          ]),
        },
        sampleReadiness: {
          traffic: {
            status: "baseline_zero",
            postReleaseSamples: 600,
            baselineSamples: 0,
            baselineSamplesNeeded: 500,
          },
        },
      },
    });
  });

  it("reports expected tracking failures without treating optional features as silently healthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(websitePage([{ id: WEBSITE_ID, name: "Store", domain: "store.example" }]));
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/stats")) {
        const currentStart = Date.now() - 48 * 3_600_000;
        return json(plainTotals(Number(url.searchParams.get("startAt")) >= currentStart ? 0 : 200));
      }
      if (url.pathname.endsWith("/daterange")) {
        return json({ startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-07-01T00:00:00.000Z" });
      }
      if (url.pathname.endsWith("/metrics")) return json([{ x: "wrong.example", y: 10 }]);
      if (url.pathname.endsWith("/events")) return json(websitePage([]));
      if (url.pathname.endsWith("/recorder")) return json({ enabled: false });
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "tracking_health_check",
      arguments: { expectEvents: true, expectReplay: true, expectHeatmap: true },
    });
    const text = JSON.stringify(result.structuredContent);

    expect(result.structuredContent).toMatchObject({
      data: {
        summary: { healthy: 0, warnings: 1, errors: 0 },
        websites: [{ website: { id: WEBSITE_ID }, status: "warning" }],
      },
      meta: { dataStatus: "available" },
    });
    for (const code of [
      "STALE_TRACKING",
      "NO_TRAFFIC_IN_LOOKBACK",
      "DOMAIN_MISMATCH",
      "EXPECTED_EVENTS_MISSING",
      "RECORDER_DISABLED",
    ]) {
      expect(text).toContain(code);
    }
  });

  it("runs expectation-required checks even when the requested check list omits them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(websitePage([{ id: WEBSITE_ID, name: "Store", domain: "store.example" }]));
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/stats")) return json(plainTotals(200));
      if (url.pathname.endsWith("/daterange")) {
        return json({ startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-07-13T11:00:00.000Z" });
      }
      if (url.pathname.endsWith("/recorder")) {
        return json({ enabled: false, replayEnabled: false, heatmapEnabled: false });
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "tracking_health_check",
      arguments: { checks: ["traffic"], expectReplay: true },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        checkSelection: {
          requested: ["traffic"],
          effective: ["traffic", "recorder"],
        },
        summary: { healthy: 0, warnings: 1 },
        issues: [{ code: "RECORDER_DISABLED", check: "recorder" }],
      },
      meta: { dataStatus: "available" },
    });
  });

  it("reports conservative referral-spam evidence as a health warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T12:00:00.000Z");
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/websites")) {
        return json(websitePage([{ id: WEBSITE_ID, name: "Store", domain: "store.example" }]));
      }
      if (url.pathname.endsWith("/teams")) return json(websitePage([]));
      if (url.pathname.endsWith("/metrics/expanded")) {
        return json([
          {
            name: "a.xpwesthmfqphh.com",
            pageviews: 12,
            visitors: 12,
            visits: 12,
            bounces: 12,
            totaltime: 0,
          },
        ]);
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    });
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "tracking_health_check",
      arguments: { checks: ["referral_spam"] },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        summary: { warnings: 1, errors: 0 },
        issues: [
          {
            code: "SUSPECTED_REFERRAL_SPAM",
            check: "referral_spam",
            evidence: { suspiciousReferrers: [{ name: "a.xpwesthmfqphh.com" }] },
          },
        ],
      },
    });
  });
});
