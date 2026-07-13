import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "../src/api/client.js";
import { UmamiClient } from "../src/api/client.js";
import { loadConfig } from "../src/config.js";

const WEBSITE_ID = "6b2c8c10-908c-4a8e-a924-4049eb3bde8c";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: Parameters<Fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe("UmamiClient", () => {
  it("uses x-umami-api-key for Cloud and preserves v3.2 pageview data", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      json({
        pageviews: [{ x: "2026-07-01", y: 12 }],
        sessions: [{ x: "2026-07-01", y: 7 }],
      }),
    );
    const client = new UmamiClient(loadConfig({ UMAMI_API_KEY: "cloud-key" }), fetchMock);

    const result = await client.get(`websites/${WEBSITE_ID}/pageviews`, {
      startAt: 1,
      endAt: 2,
    });

    expect(result).toEqual({
      pageviews: [{ x: "2026-07-01", y: 12 }],
      sessions: [{ x: "2026-07-01", y: 7 }],
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(input as Parameters<Fetch>[0]).href).toBe(
      `https://api.umami.is/v1/websites/${WEBSITE_ID}/pageviews?startAt=1&endAt=2`,
    );
    expect(new Headers(init?.headers).get("x-umami-api-key")).toBe("cloud-key");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("uses Bearer auth for an existing access token", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(json({ ok: true }));
    const client = new UmamiClient(
      loadConfig({
        UMAMI_API_URL: "https://analytics.example.com/api",
        UMAMI_ACCESS_TOKEN: "access-token",
      }),
      fetchMock,
    );

    await client.get("websites");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(new Headers(init?.headers).get("x-umami-api-key")).toBeNull();
  });

  it("deduplicates concurrent login and caches the bearer token", async () => {
    let loginCalls = 0;
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/auth/login")) {
        loginCalls += 1;
        return json({ token: "session-token" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
      return json({ ok: true });
    });
    const client = new UmamiClient(
      loadConfig({
        UMAMI_URL: "https://analytics.example.com",
        UMAMI_USERNAME: "viewer",
        UMAMI_PASSWORD: "secret",
      }),
      fetchMock,
    );

    await Promise.all([client.get("websites"), client.get("me")]);
    await client.get("teams");

    expect(loginCalls).toBe(1);
  });

  it("refreshes a login token once after a 401", async () => {
    let loginCalls = 0;
    let dataCalls = 0;
    const fetchMock = vi.fn<Fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/auth/login")) {
        loginCalls += 1;
        return json({ token: `token-${loginCalls}` });
      }
      dataCalls += 1;
      return dataCalls === 1 ? json({ secretDebugBody: "must-not-leak" }, 401) : json({ ok: true });
    });
    const client = new UmamiClient(
      loadConfig({
        UMAMI_URL: "https://analytics.example.com",
        UMAMI_USERNAME: "viewer",
        UMAMI_PASSWORD: "secret",
      }),
      fetchMock,
    );

    await expect(client.get("websites")).resolves.toEqual({ ok: true });
    expect(loginCalls).toBe(2);
    expect(dataCalls).toBe(2);
  });

  it("shares one refreshed credential across concurrent 401 responses", async () => {
    let loginCalls = 0;
    const fetchMock = vi.fn<Fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/auth/login")) {
        loginCalls += 1;
        return json({ token: `token-${loginCalls}` });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer token-1" ? json({}, 401) : json({ ok: true });
    });
    const client = new UmamiClient(
      loadConfig({
        UMAMI_URL: "https://analytics.example.com",
        UMAMI_USERNAME: "viewer",
        UMAMI_PASSWORD: "secret",
      }),
      fetchMock,
    );

    await expect(Promise.all([client.get("websites"), client.get("teams")])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(loginCalls).toBe(2);
  });

  it("rejects an oversized response before parsing JSON", async () => {
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      new Response('{"ok":true}', {
        headers: { "Content-Length": "102401", "Content-Type": "application/json" },
      }),
    );
    const client = new UmamiClient(
      loadConfig({ UMAMI_API_KEY: "key", UMAMI_MAX_RESPONSE_BYTES: "102400" }),
      fetchMock,
    );

    await expect(client.get("websites")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("enforces the response byte budget when Content-Length is absent", async () => {
    const body = JSON.stringify({ value: "x".repeat(102_400) });
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));
    const client = new UmamiClient(
      loadConfig({ UMAMI_API_KEY: "key", UMAMI_MAX_RESPONSE_BYTES: "102400" }),
      fetchMock,
    );

    await expect(client.get("websites")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("enforces the website allowlist before any request", async () => {
    const fetchMock = vi.fn<Fetch>();
    const client = new UmamiClient(
      loadConfig({
        UMAMI_API_KEY: "key",
        UMAMI_WEBSITE_IDS: WEBSITE_ID,
      }),
      fetchMock,
    );

    expect(() => client.assertWebsiteAllowed("7af8e5ad-83f1-4f50-8db6-26d95b32ec19")).toThrow(
      "outside the configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("intersects, searches, and paginates the website allowlist without per-site requests", async () => {
    const secondWebsiteId = "7af8e5ad-83f1-4f50-8db6-26d95b32ec19";
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      json({
        data: [
          { id: WEBSITE_ID, name: "Primary" },
          { id: "8e06460b-d3c1-4192-b721-c643f3600408", name: "Not allowed" },
          { id: secondWebsiteId, name: "Secondary" },
        ],
        count: 3,
        page: 1,
        pageSize: 100,
      }),
    );
    const client = new UmamiClient(
      loadConfig({
        UMAMI_API_KEY: "key",
        UMAMI_WEBSITE_IDS: `${WEBSITE_ID.toUpperCase()},${secondWebsiteId}`,
      }),
      fetchMock,
    );

    await expect(client.listWebsites({ page: 2, pageSize: 1, search: "ary" })).resolves.toEqual({
      data: [{ id: secondWebsiteId, name: "Secondary" }],
      count: 2,
      page: 2,
      pageSize: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestUrl(fetchMock.mock.calls[0]?.[0] as Parameters<Fetch>[0]);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(url.searchParams.get("search")).toBe("ary");
    expect(client.isWebsiteAllowed(WEBSITE_ID.toUpperCase())).toBe(true);
  });

  it("uses a fixed, typed POST only for the read-only Umami 3.2 heatmap report", async () => {
    const fetchMock = vi
      .fn<Fetch>()
      .mockResolvedValue(json({ mode: "click", pages: [], points: [], snapshot: null }));
    const client = new UmamiClient(loadConfig({ UMAMI_API_KEY: "cloud-key" }), fetchMock);

    await client.getHeatmapReport({
      websiteId: WEBSITE_ID,
      type: "heatmap",
      parameters: {
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: "2026-07-02T23:59:59.999Z",
        mode: "click",
        urlPath: "/pricing",
      },
      filters: {},
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(input as Parameters<Fetch>[0]).href).toBe(
      "https://api.umami.is/v1/reports/heatmap",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      websiteId: WEBSITE_ID,
      type: "heatmap",
      parameters: { mode: "click", urlPath: "/pricing" },
    });
  });

  it("rejects absolute and parent API paths before fetch", async () => {
    const fetchMock = vi.fn<Fetch>();
    const client = new UmamiClient(loadConfig({ UMAMI_API_KEY: "cloud-key" }), fetchMock);

    await expect(client.get("https://attacker.example/data")).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(client.get("../admin")).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels promptly while a shared login is still in flight", async () => {
    const fetchMock = vi.fn<Fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ token: "eventual-token" });
    });
    const client = new UmamiClient(
      loadConfig({
        UMAMI_URL: "https://analytics.example.com",
        UMAMI_USERNAME: "viewer",
        UMAMI_PASSWORD: "secret",
      }),
      fetchMock,
    );
    const controller = new AbortController();
    const request = client.get("websites", undefined, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "ABORTED" });
  });
});
