import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "../src/api/client.js";
import { loadConfig } from "../src/config.js";
import type { ToolModule } from "../src/mcp/tool-module.js";
import { createServer } from "../src/server.js";

const WEBSITE_ID = "6b2c8c10-908c-4a8e-a924-4049eb3bde8c";
const connected: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];

afterEach(async () => {
  await Promise.all(
    connected.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

async function connect(fetchMock: Fetch, toolsets = "core,events,sessions") {
  const server = createServer({
    config: loadConfig({ UMAMI_API_KEY: "test-key", UMAMI_TOOLSETS: toolsets }),
    fetch: fetchMock,
  });
  const client = new Client({ name: "umami-compass-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

describe("Umami Compass MCP server", () => {
  it("exposes modular, explicitly read-only tools", async () => {
    const client = await connect(vi.fn<Fetch>());
    const result = await client.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      "list_websites",
      "get_website",
      "get_website_stats",
      "get_pageviews",
      "get_metrics",
      "get_active_visitors",
      "get_website_date_range",
      "list_events",
      "get_event_stats",
      "get_event_series",
      "list_sessions",
      "get_session_stats",
      "get_session",
      "get_session_activity",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(result.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(result.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
  });

  it("keeps every opt-in module read-only and prevents arbitrary upstream targets", async () => {
    const client = await connect(vi.fn<Fetch>(), "all");
    const result = await client.listTools();

    expect(result.tools).toHaveLength(30);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(
      result.tools.some((tool) => /^(create|update|delete|reset|share|save|send)_/.test(tool.name)),
    ).toBe(false);
    for (const tool of result.tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(properties).not.toHaveProperty("url");
      expect(properties).not.toHaveProperty("apiUrl");
      expect(properties).not.toHaveProperty("host");
    }
  });

  it("returns structured content and both Umami 3.2 time series", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      Response.json({
        pageviews: [{ x: "2026-07-01", y: 18 }],
        sessions: [{ x: "2026-07-01", y: 11 }],
      }),
    );
    const client = await connect(fetchMock, "core");

    const result = await client.callTool({
      name: "get_pageviews",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: {
        pageviews: [{ x: "2026-07-01", y: 18 }],
        sessions: [{ x: "2026-07-01", y: 11 }],
      },
    });
  });

  it("fails closed when Umami drifts from the pageview contract", async () => {
    const client = await connect(
      vi.fn<Fetch>().mockResolvedValue(Response.json({ pageviews: [], session: [] })),
      "core",
    );
    const result = await client.callTool({
      name: "get_pageviews",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("invalid pageview series data");
  });

  it("converts validation and upstream failures into safe tool errors", async () => {
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response('{"database":"private detail"}', { status: 500 }));
    const client = await connect(fetchMock, "core");

    const result = await client.callTool({
      name: "get_website_stats",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
      },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain("Umami is temporarily unavailable");
    expect(text).not.toContain("private detail");
    expect(text).not.toContain("test-key");
  });

  it("refuses future write modules unless a write policy is explicitly supplied", () => {
    const futureWriteModule: ToolModule = {
      id: "core",
      access: "write",
      register() {},
    };

    expect(() =>
      createServer({
        config: loadConfig({ UMAMI_API_KEY: "test-key", UMAMI_TOOLSETS: "core" }),
        modules: [futureWriteModule],
      }),
    ).toThrow("Refusing to register write-capable module");
  });

  it("supports bounded Umami 3.2 heatmap results without exposing a mutation tool", async () => {
    const points = Array.from({ length: 4 }, (_, index) => ({ x: index, y: index, count: 1 }));
    const buckets = Array.from({ length: 3 }, (_, index) => ({ depth: index, count: 1 }));
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      Response.json({
        mode: "click",
        pages: ["/", "/pricing"],
        points,
        snapshot: null,
        scroll: { buckets },
      }),
    );
    const client = await connect(fetchMock, "heatmaps");
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(["get_heatmap"]);
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({
      name: "get_heatmap",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        urlPath: "/pricing",
        maxPoints: 2,
        maxBuckets: 2,
        maxPages: 1,
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        accessStatus: "authorized",
        dataStatus: "available",
        points: points.slice(0, 2),
        pointsTruncated: true,
        totalPoints: 4,
        pages: ["/"],
        pagesTruncated: true,
        totalPages: 2,
        scroll: {
          buckets: buckets.slice(0, 2),
          bucketsTruncated: true,
          totalBuckets: 3,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains authorized empty heatmap results", async () => {
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(
        Response.json({
          mode: "click",
          pages: [],
          points: [],
          snapshot: null,
          scroll: { buckets: [], totalSessions: 0 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ enabled: true, replayEnabled: true, heatmapEnabled: true }),
      );
    const client = await connect(fetchMock, "heatmaps");

    const result = await client.callTool({
      name: "get_heatmap",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        accessStatus: "authorized",
        dataStatus: "empty",
        recorderStatus: "enabled",
        emptyReason: "no_data_in_range",
      },
    });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toContain(
      `/websites/${WEBSITE_ID}/recorder`,
    );
  });

  it("explains authorized empty replay results and disabled capture", async () => {
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(Response.json({ data: [], count: 0, page: 1, pageSize: 20 }))
      .mockResolvedValueOnce(
        Response.json({ enabled: true, replayEnabled: false, heatmapEnabled: true }),
      );
    const client = await connect(fetchMock, "replay");

    const result = await client.callTool({
      name: "list_replays",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        data: [],
        count: 0,
        accessStatus: "authorized",
        dataStatus: "empty",
        recorderStatus: "disabled",
        emptyReason: "replay_disabled",
      },
    });
  });

  it("bounds revenue metric arrays even when Umami does not", async () => {
    const metrics = Array.from({ length: 3 }, (_, index) => ({
      name: `region-${index}`,
      value: 100 - index,
    }));
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(Response.json(metrics));
    const client = await connect(fetchMock, "revenue");
    const result = await client.callTool({
      name: "get_revenue_metrics",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        currency: "usd",
        type: "region",
        limit: 2,
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        items: metrics.slice(0, 2),
        itemsTruncated: true,
        totalItems: 3,
      },
    });
  });

  it("returns bounded Core Web Vitals from the typed performance report", async () => {
    const chart = Array.from({ length: 3 }, (_, index) => ({
      t: `2026-07-0${index + 1}`,
      p50: 100 + index,
      p75: 150 + index,
      p95: 200 + index,
    }));
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      Response.json({
        chart,
        summary: { lcp: { p50: 100, p75: 150, p95: 200 }, count: 20 },
        pages: [],
        pageTitles: [],
        devices: [],
        browsers: [],
      }),
    );
    const client = await connect(fetchMock, "performance");
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "get_web_vitals",
      "get_performance_breakdown",
    ]);

    const result = await client.callTool({
      name: "get_web_vitals",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-03",
        metric: "lcp",
        maxPoints: 2,
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        metric: "lcp",
        chart: {
          items: chart.slice(0, 2),
          itemsTruncated: true,
          totalItems: 3,
        },
      },
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(input)).pathname).toBe("/v1/reports/performance");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      websiteId: WEBSITE_ID,
      type: "performance",
      parameters: { metric: "lcp", timezone: "UTC" },
    });
  });

  it("filters invalid performance page rows and ranks numeric p75 values", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      Response.json({
        chart: [],
        summary: { lcp: { p50: 100, p75: 150, p95: 200 }, count: 12 },
        pages: [
          { name: "/missing", p50: null, p75: null, p95: null, count: "1" },
          { name: "/fast", p50: "80", p75: "100", p95: "140", count: "10" },
          { name: "/slow", p50: "180", p75: "250", p95: "400", count: "2" },
        ],
        pageTitles: [],
        devices: [],
        browsers: [],
      }),
    );
    const client = await connect(fetchMock, "performance");

    const result = await client.callTool({
      name: "get_performance_breakdown",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        metric: "lcp",
        dimension: "page",
        limit: 2,
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        invalidItemsExcluded: 1,
        items: [
          { name: "/slow", p50: 180, p75: 250, p95: 400, count: 2 },
          { name: "/fast", p50: 80, p75: 100, p95: 140, count: 10 },
        ],
        itemsTruncated: false,
        totalItems: 2,
      },
    });
  });

  it.each(["segment", "cohort"] as const)("accepts Umami's paged %s response", async (type) => {
    const segments = [
      { id: "1f215ff2-fbee-4ff8-a875-32f47700bbf3", name: "Returning", type },
      { id: "7af8e5ad-83f1-4f50-8db6-26d95b32ec19", name: "Paid", type },
    ];
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValue(Response.json({ data: segments, count: 3, page: 1, pageSize: 10 }));
    const client = await connect(fetchMock, "reports");

    const result = await client.callTool({
      name: "list_segments",
      arguments: { websiteId: WEBSITE_ID, type, limit: 50 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: {
        type,
        items: segments,
        itemLimit: 50,
        itemsTruncated: true,
        totalItems: 3,
      },
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("type")).toBe(type);
  });

  it("runs a typed read-only funnel report with bounded steps", async () => {
    const funnel = [
      { type: "path", value: "/", visitors: 100 },
      { type: "path", value: "/pricing", visitors: 25 },
    ];
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(Response.json(funnel));
    const client = await connect(fetchMock, "reports");

    const result = await client.callTool({
      name: "run_funnel_report",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        windowMinutes: 60,
        steps: [
          { type: "path", value: "/" },
          { type: "path", value: "/pricing" },
        ],
      },
    });

    expect(result.structuredContent).toEqual({ data: funnel });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(input)).pathname).toBe("/v1/reports/funnel");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      websiteId: WEBSITE_ID,
      type: "funnel",
      parameters: { window: 60 },
    });
  });

  it("rejects time-series resolutions that could flood model context", async () => {
    const fetchMock = vi.fn<Fetch>();
    const client = await connect(fetchMock, "core");
    const result = await client.callTool({
      name: "get_pageviews",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-01-01",
        end: "2026-12-31",
        unit: "minute",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("could exceed 10,000 points");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects the finest safe event-series unit when unit is omitted", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(Response.json([]));
    const client = await connect(fetchMock, "events");
    const result = await client.callTool({
      name: "get_event_series",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-01-01",
        end: "2026-12-31",
        limit: 100,
      },
    });

    expect(result.isError).not.toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("unit")).toBe("month");
  });

  it("omits excludeBounce unless it is explicitly true", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(Response.json({ pageviews: 1 }));
    const client = await connect(fetchMock, "core");

    await client.callTool({
      name: "get_website_stats",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        filters: { excludeBounce: false },
      },
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.has("excludeBounce")).toBe(
      false,
    );

    await client.callTool({
      name: "get_website_stats",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        filters: { excludeBounce: true },
      },
    });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("excludeBounce")).toBe(
      "true",
    );
  });

  it("rejects invalid IANA time zones before requesting Umami", async () => {
    const fetchMock = vi.fn<Fetch>();
    const client = await connect(fetchMock, "core");
    const result = await client.callTool({
      name: "get_pageviews",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        timezone: "Mars/Olympus_Mons",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("valid IANA time zone");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds session activity and reports truncation", async () => {
    const activity = Array.from({ length: 3 }, (_, index) => ({ id: index, type: "pageview" }));
    const client = await connect(
      vi.fn<Fetch>().mockResolvedValue(Response.json(activity)),
      "sessions",
    );
    const result = await client.callTool({
      name: "get_session_activity",
      arguments: {
        websiteId: WEBSITE_ID,
        sessionId: "1f215ff2-fbee-4ff8-a875-32f47700bbf3",
        start: "2026-07-01",
        end: "2026-07-02",
        maxItems: 2,
      },
    });

    expect(result.structuredContent).toEqual({
      data: {
        items: activity.slice(0, 2),
        itemLimit: 2,
        itemsTruncated: true,
        totalItems: 3,
      },
    });
  });

  it("normalizes safe analytics numbers without coercing identifiers or arbitrary values", async () => {
    const sessionId = "1f215ff2-fbee-4ff8-a875-32f47700bbf3";
    const client = await connect(
      vi.fn<Fetch>().mockResolvedValue(
        Response.json({
          id: sessionId,
          distinctId: "00042",
          views: "2",
          visits: "1",
          events: "3",
          totaltime: "390",
          count: "9007199254740993",
          value: "002",
        }),
      ),
      "sessions",
    );

    const result = await client.callTool({
      name: "get_session",
      arguments: { websiteId: WEBSITE_ID, sessionId },
    });

    expect(result.structuredContent).toEqual({
      data: {
        id: sessionId,
        distinctId: "00042",
        views: 2,
        visits: 1,
        events: 3,
        totaltime: 390,
        count: "9007199254740993",
        value: "002",
      },
    });
  });

  it("normalizes breakdown aggregate strings", async () => {
    const client = await connect(
      vi.fn<Fetch>().mockResolvedValue(
        Response.json([
          {
            path: "/",
            views: "29602",
            visitors: "12000",
            visits: "14000",
            bounces: "8000",
            totaltime: "900000",
          },
        ]),
      ),
      "reports",
    );

    const result = await client.callTool({
      name: "run_breakdown_report",
      arguments: {
        websiteId: WEBSITE_ID,
        start: "2026-07-01",
        end: "2026-07-02",
        fields: ["path"],
      },
    });

    expect(result.structuredContent).toMatchObject({
      data: {
        items: [
          {
            path: "/",
            views: 29602,
            visitors: 12000,
            visits: 14000,
            bounces: 8000,
            totaltime: 900000,
          },
        ],
      },
    });
  });
});
