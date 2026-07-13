import { UmamiError } from "./api/errors.js";

export const TOOLSETS = [
  "core",
  "insights",
  "events",
  "sessions",
  "performance",
  "reports",
  "revenue",
  "replay",
  "heatmaps",
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export type UmamiAuth =
  | { type: "apiKey"; apiKey: string }
  | { type: "accessToken"; accessToken: string }
  | { type: "login"; username: string; password: string };

export interface UmamiCompassConfig {
  apiUrl: URL;
  auth: UmamiAuth;
  allowInsecureHttp: boolean;
  maxRangeDays: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  toolsets: ReadonlySet<Toolset>;
  teamIds?: ReadonlySet<string>;
  websiteIds?: ReadonlySet<string>;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined, key: string): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UmamiError("CONFIGURATION_ERROR", `${key} must be either true or false.`);
}

function parseInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      `${key} must be an integer between ${range.min} and ${range.max}.`,
    );
  }
  return parsed;
}

function parseApiUrl(env: NodeJS.ProcessEnv, hasApiKey: boolean): URL {
  const exactApiUrl = optional(env, "UMAMI_API_URL");
  const instanceUrl = optional(env, "UMAMI_URL");

  if (exactApiUrl && instanceUrl) {
    throw new UmamiError("CONFIGURATION_ERROR", "Set either UMAMI_API_URL or UMAMI_URL, not both.");
  }

  const value = exactApiUrl ?? instanceUrl ?? (hasApiKey ? "https://api.umami.is/v1" : undefined);
  if (!value) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      "Set UMAMI_URL for self-hosted Umami or UMAMI_API_URL for an exact API root.",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new UmamiError("CONFIGURATION_ERROR", "The configured Umami URL is invalid.", {
      cause: error,
    });
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      "The configured Umami URL cannot contain credentials, a query string, or a fragment.",
    );
  }

  if (!exactApiUrl && instanceUrl) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api`;
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function assertSafeProtocol(url: URL, allowInsecureHttp: boolean): void {
  if (url.protocol === "https:") return;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && (loopback || allowInsecureHttp)) return;
  throw new UmamiError(
    "CONFIGURATION_ERROR",
    "Umami must use HTTPS. Plain HTTP is allowed only for loopback addresses unless UMAMI_ALLOW_INSECURE_HTTP=true.",
  );
}

function parseAuth(env: NodeJS.ProcessEnv): UmamiAuth {
  const apiKey = optional(env, "UMAMI_API_KEY");
  const accessToken = optional(env, "UMAMI_ACCESS_TOKEN");
  const username = optional(env, "UMAMI_USERNAME");
  const password = optional(env, "UMAMI_PASSWORD");
  const loginConfigured = username !== undefined || password !== undefined;

  const modes =
    Number(apiKey !== undefined) + Number(accessToken !== undefined) + Number(loginConfigured);
  if (modes !== 1) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      "Configure exactly one auth mode: UMAMI_API_KEY, UMAMI_ACCESS_TOKEN, or UMAMI_USERNAME with UMAMI_PASSWORD.",
    );
  }
  if (apiKey) return { type: "apiKey", apiKey };
  if (accessToken) return { type: "accessToken", accessToken };
  if (!username || !password) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      "UMAMI_USERNAME and UMAMI_PASSWORD must be set together.",
    );
  }
  return { type: "login", username, password };
}

function parseToolsets(value: string | undefined): ReadonlySet<Toolset> {
  if (!value) return new Set<Toolset>(["core", "insights"]);
  const names = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (names.includes("all")) {
    if (names.length !== 1) {
      throw new UmamiError(
        "CONFIGURATION_ERROR",
        "UMAMI_TOOLSETS=all cannot be combined with other values.",
      );
    }
    return new Set(TOOLSETS);
  }
  const invalid = names.filter((name) => !TOOLSETS.includes(name as Toolset));
  if (names.length === 0 || invalid.length > 0) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      `UMAMI_TOOLSETS must contain: ${TOOLSETS.join(", ")}, or all.`,
    );
  }
  return new Set(names as Toolset[]);
}

function parseUuidAllowlist(
  value: string | undefined,
  key: "UMAMI_TEAM_IDS" | "UMAMI_WEBSITE_IDS",
  maximum: number,
): ReadonlySet<string> | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  if (ids.length > maximum) {
    throw new UmamiError("CONFIGURATION_ERROR", `${key} cannot contain more than ${maximum} IDs.`);
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (ids.some((id) => !uuid.test(id))) {
    throw new UmamiError("CONFIGURATION_ERROR", `${key} must be a comma-separated list of UUIDs.`);
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UmamiCompassConfig {
  const auth = parseAuth(env);
  const allowInsecureHttp = parseBoolean(
    optional(env, "UMAMI_ALLOW_INSECURE_HTTP"),
    "UMAMI_ALLOW_INSECURE_HTTP",
  );
  const apiUrl = parseApiUrl(env, auth.type === "apiKey");
  assertSafeProtocol(apiUrl, allowInsecureHttp);

  return {
    apiUrl,
    auth,
    allowInsecureHttp,
    maxRangeDays: parseInteger(optional(env, "UMAMI_MAX_RANGE_DAYS"), "UMAMI_MAX_RANGE_DAYS", 366, {
      min: 1,
      max: 3_650,
    }),
    maxResponseBytes: parseInteger(
      optional(env, "UMAMI_MAX_RESPONSE_BYTES"),
      "UMAMI_MAX_RESPONSE_BYTES",
      10_485_760,
      { min: 102_400, max: 52_428_800 },
    ),
    requestTimeoutMs: parseInteger(
      optional(env, "UMAMI_REQUEST_TIMEOUT_MS"),
      "UMAMI_REQUEST_TIMEOUT_MS",
      30_000,
      { min: 1_000, max: 120_000 },
    ),
    toolsets: parseToolsets(optional(env, "UMAMI_TOOLSETS")),
    teamIds: parseUuidAllowlist(optional(env, "UMAMI_TEAM_IDS"), "UMAMI_TEAM_IDS", 25),
    websiteIds: parseUuidAllowlist(optional(env, "UMAMI_WEBSITE_IDS"), "UMAMI_WEBSITE_IDS", 100),
  };
}
