import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const WEBSITE_ID = "6b2c8c10-908c-4a8e-a924-4049eb3bde8c";

describe("loadConfig", () => {
  it("defaults API-key auth to Umami Cloud and safe toolsets", () => {
    const config = loadConfig({ UMAMI_API_KEY: "cloud-secret" });

    expect(config.apiUrl.href).toBe("https://api.umami.is/v1/");
    expect(config.auth).toEqual({ type: "apiKey", apiKey: "cloud-secret" });
    expect([...config.toolsets]).toEqual(["core"]);
    expect(config.maxResponseBytes).toBe(10_485_760);
  });

  it("builds a self-hosted API root and login auth", () => {
    const config = loadConfig({
      UMAMI_URL: "https://analytics.example.com/base/",
      UMAMI_USERNAME: "viewer",
      UMAMI_PASSWORD: "secret",
    });

    expect(config.apiUrl.href).toBe("https://analytics.example.com/base/api/");
    expect(config.auth.type).toBe("login");
  });

  it("supports an exact API URL, all toolsets, and a website allowlist", () => {
    const config = loadConfig({
      UMAMI_ACCESS_TOKEN: "token",
      UMAMI_API_URL: "https://analytics.example.com/custom/api",
      UMAMI_TOOLSETS: "all",
      UMAMI_WEBSITE_IDS: WEBSITE_ID,
    });

    expect(config.apiUrl.href).toBe("https://analytics.example.com/custom/api/");
    expect([...config.toolsets]).toEqual([
      "core",
      "events",
      "sessions",
      "performance",
      "reports",
      "revenue",
      "replay",
      "heatmaps",
    ]);
    expect(config.websiteIds).toEqual(new Set([WEBSITE_ID]));
  });

  it("rejects ambiguous authentication", () => {
    expect(() =>
      loadConfig({
        UMAMI_API_KEY: "key",
        UMAMI_ACCESS_TOKEN: "token",
        UMAMI_API_URL: "https://analytics.example.com/api",
      }),
    ).toThrow("Configure exactly one auth mode");
  });

  it("rejects non-loopback plaintext HTTP by default", () => {
    expect(() =>
      loadConfig({
        UMAMI_ACCESS_TOKEN: "token",
        UMAMI_API_URL: "http://analytics.example.com/api",
      }),
    ).toThrow("must use HTTPS");
  });

  it("allows plaintext HTTP on loopback for local development", () => {
    const config = loadConfig({
      UMAMI_ACCESS_TOKEN: "token",
      UMAMI_API_URL: "http://127.0.0.1:3000/api",
    });

    expect(config.apiUrl.href).toBe("http://127.0.0.1:3000/api/");
  });

  it("rejects credentials, query strings, and fragments in the API URL", () => {
    for (const apiUrl of [
      "https://viewer:secret@analytics.example.com/api",
      "https://analytics.example.com/api?tenant=private",
      "https://analytics.example.com/api#fragment",
    ]) {
      expect(() => loadConfig({ UMAMI_ACCESS_TOKEN: "token", UMAMI_API_URL: apiUrl })).toThrow(
        "cannot contain credentials",
      );
    }
  });

  it("caps the website allowlist", () => {
    expect(() =>
      loadConfig({
        UMAMI_API_KEY: "key",
        UMAMI_WEBSITE_IDS: Array.from({ length: 101 }, () => WEBSITE_ID).join(","),
      }),
    ).toThrow("cannot contain more than 100 websites");
  });

  it("normalizes website allowlist UUIDs to lowercase", () => {
    const config = loadConfig({
      UMAMI_API_KEY: "key",
      UMAMI_WEBSITE_IDS: WEBSITE_ID.toUpperCase(),
    });

    expect(config.websiteIds).toEqual(new Set([WEBSITE_ID]));
  });

  it("validates the upstream response byte budget", () => {
    expect(() => loadConfig({ UMAMI_API_KEY: "key", UMAMI_MAX_RESPONSE_BYTES: "102399" })).toThrow(
      "UMAMI_MAX_RESPONSE_BYTES must be an integer between",
    );
  });
});
