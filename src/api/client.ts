import type { UmamiCompassConfig } from "../config.js";
import { VERSION } from "../version.js";
import { UmamiError } from "./errors.js";
import type {
  HeatmapReportRequest,
  LoginResponse,
  PagedResponse,
  Query,
  ReadOnlyReportRequest,
  Website,
} from "./types.js";

export type Fetch = typeof globalThis.fetch;

interface RequestOptions {
  body?: unknown;
  method?: "GET" | "POST";
  query?: Query;
  signal?: AbortSignal;
}

interface LoginCredential {
  generation: number;
  token: string;
}

interface RequestHeaders {
  headers: Headers;
  loginGeneration?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendQuery(url: URL, query: Query | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, String(item));
  }
}

function resolveApiPath(baseUrl: URL, path: string): URL {
  if (!path || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw new UmamiError("CONFIGURATION_ERROR", "The Umami API path is invalid.");
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new UmamiError("CONFIGURATION_ERROR", "The Umami API path escaped its fixed origin.");
  }
  return url;
}

function requireWebsitePage(value: unknown): PagedResponse<Website> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    typeof value.count !== "number" ||
    typeof value.page !== "number" ||
    typeof value.pageSize !== "number"
  ) {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned an invalid website list.");
  }
  return value as unknown as PagedResponse<Website>;
}

function requireWebsite(value: unknown): Website {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new UmamiError("INVALID_RESPONSE", "Umami returned invalid website metadata.");
  }
  return value as Website;
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
  invalidMessage: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UmamiError(
      "INVALID_RESPONSE",
      `Umami response exceeded the configured ${maxBytes}-byte limit.`,
    );
  }
  if (!response.body) {
    throw new UmamiError("INVALID_RESPONSE", invalidMessage);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UmamiError(
        "INVALID_RESPONSE",
        `Umami response exceeded the configured ${maxBytes}-byte limit.`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new UmamiError("INVALID_RESPONSE", invalidMessage, { cause: error });
  }
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new UmamiError("ABORTED", "The Umami request was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new UmamiError("ABORTED", "The Umami request was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function statusError(status: number): UmamiError {
  if (status === 401) {
    return new UmamiError("AUTHENTICATION_FAILED", "Umami rejected the configured credentials.", {
      status,
    });
  }
  if (status === 403) {
    return new UmamiError("FORBIDDEN", "Umami denied access to this resource.", { status });
  }
  if (status === 404) {
    return new UmamiError("NOT_FOUND", "The requested Umami resource was not found.", { status });
  }
  if (status === 429) {
    return new UmamiError("RATE_LIMITED", "Umami rate-limited the request. Try again later.", {
      retryable: true,
      status,
    });
  }
  return new UmamiError(
    "UPSTREAM_ERROR",
    status >= 500 ? "Umami is temporarily unavailable." : "Umami rejected the analytics request.",
    { retryable: status >= 500, status },
  );
}

export class UmamiClient {
  readonly #config: UmamiCompassConfig;
  readonly #fetch: Fetch;
  #loginGeneration = 0;
  #loginPromise?: Promise<LoginCredential>;
  #loginToken?: LoginCredential;

  constructor(config: UmamiCompassConfig, fetchImplementation: Fetch = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  isWebsiteAllowed(websiteId: string): boolean {
    return !this.#config.websiteIds || this.#config.websiteIds.has(websiteId.toLowerCase());
  }

  assertWebsiteAllowed(websiteId: string): void {
    if (!this.isWebsiteAllowed(websiteId)) {
      throw new UmamiError(
        "FORBIDDEN",
        "This website is outside the configured UMAMI_WEBSITE_IDS allowlist.",
      );
    }
  }

  async listWebsites(
    query: Query,
    signal?: AbortSignal,
  ): Promise<PagedResponse<Website> | unknown> {
    if (!this.#config.websiteIds) {
      return requireWebsitePage(await this.get<unknown>("websites", query, signal));
    }

    const requestedPage = typeof query.page === "number" ? query.page : 1;
    const requestedPageSize = typeof query.pageSize === "number" ? query.pageSize : 20;
    const upstreamQuery = { ...query, page: 1, pageSize: 100 };
    const firstPage = requireWebsitePage(
      await this.get<unknown>("websites", upstreamQuery, signal),
    );
    const pageCount = Math.ceil(firstPage.count / 100);
    if (pageCount > 25) {
      throw new UmamiError(
        "VALIDATION_ERROR",
        "The account has too many websites to apply the local allowlist safely. Use a more limited Umami identity or a search filter.",
      );
    }

    const websites = [...firstPage.data];
    for (let page = 2; page <= pageCount; page += 1) {
      const nextPage = requireWebsitePage(
        await this.get<unknown>("websites", { ...upstreamQuery, page }, signal),
      );
      websites.push(...nextPage.data);
    }
    const visible = websites.filter(
      (website) =>
        typeof website.id === "string" && this.#config.websiteIds?.has(website.id.toLowerCase()),
    );
    const start = (requestedPage - 1) * requestedPageSize;
    return {
      data: visible.slice(start, start + requestedPageSize),
      count: visible.length,
      page: requestedPage,
      pageSize: requestedPageSize,
    } satisfies PagedResponse<Website>;
  }

  async getWebsite(websiteId: string, signal?: AbortSignal): Promise<Website> {
    const normalizedWebsiteId = websiteId.toLowerCase();
    this.assertWebsiteAllowed(normalizedWebsiteId);
    return requireWebsite(
      await this.get<unknown>(
        `websites/${encodeURIComponent(normalizedWebsiteId)}`,
        undefined,
        signal,
      ),
    );
  }

  async get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.#request<T>(path, { method: "GET", query, signal }, true);
  }

  async getHeatmapReport<T = unknown>(
    request: HeatmapReportRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runReport<T>(request, signal);
  }

  async runReport<T = unknown>(request: ReadOnlyReportRequest, signal?: AbortSignal): Promise<T> {
    const allowedTypes = new Set<ReadOnlyReportRequest["type"]>([
      "attribution",
      "breakdown",
      "funnel",
      "goal",
      "heatmap",
      "journey",
      "performance",
      "retention",
      "utm",
    ]);
    if (!allowedTypes.has(request.type)) {
      throw new UmamiError("CONFIGURATION_ERROR", "Unsupported read-only Umami report type.");
    }
    this.assertWebsiteAllowed(request.websiteId);
    return this.#request<T>(
      `reports/${request.type}`,
      { body: request, method: "POST", signal },
      true,
    );
  }

  async #request<T>(path: string, options: RequestOptions, retryLogin: boolean): Promise<T> {
    const url = resolveApiPath(this.#config.apiUrl, path);
    appendQuery(url, options.query);
    const timeoutSignal = AbortSignal.timeout(this.#config.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    let loginGeneration: number | undefined;
    try {
      const requestHeaders = await this.#headers(options.signal);
      const { headers } = requestHeaders;
      loginGeneration = requestHeaders.loginGeneration;
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
      response = await this.#fetch(url, {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers,
        method: options.method ?? "GET",
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new UmamiError("ABORTED", "The Umami request was cancelled or timed out.", {
          cause: error,
          retryable: !options.signal?.aborted,
        });
      }
      throw new UmamiError("UPSTREAM_ERROR", "Could not connect to the configured Umami API.", {
        cause: error,
        retryable: true,
      });
    }

    if (response.status === 401 && this.#config.auth.type === "login" && retryLogin) {
      if (this.#loginToken?.generation === loginGeneration) this.#loginToken = undefined;
      return this.#request<T>(path, options, false);
    }
    if (!response.ok) throw statusError(response.status);
    if (response.status === 204) return undefined as T;

    return (await readJsonResponse(
      response,
      this.#config.maxResponseBytes,
      "Umami returned an invalid JSON response.",
    )) as T;
  }

  async #headers(signal?: AbortSignal): Promise<RequestHeaders> {
    const headers = new Headers({
      Accept: "application/json",
      "User-Agent": `umami-compass/${VERSION}`,
    });
    if (this.#config.auth.type === "apiKey") {
      headers.set("x-umami-api-key", this.#config.auth.apiKey);
    } else if (this.#config.auth.type === "accessToken") {
      headers.set("Authorization", `Bearer ${this.#config.auth.accessToken}`);
    } else {
      const credential = await this.#login(signal);
      headers.set("Authorization", `Bearer ${credential.token}`);
      return { headers, loginGeneration: credential.generation };
    }
    return { headers };
  }

  async #login(signal?: AbortSignal): Promise<LoginCredential> {
    if (this.#loginToken) return this.#loginToken;
    if (!this.#loginPromise) {
      this.#loginGeneration += 1;
      const generation = this.#loginGeneration;
      const loginPromise = this.#performLogin().then((token) => ({ generation, token }));
      this.#loginPromise = loginPromise;
      void loginPromise.then(
        (credential) => {
          this.#loginToken = credential;
          if (this.#loginPromise === loginPromise) this.#loginPromise = undefined;
        },
        () => {
          if (this.#loginPromise === loginPromise) this.#loginPromise = undefined;
        },
      );
    }
    return waitForSignal(this.#loginPromise, signal);
  }

  async #performLogin(): Promise<string> {
    if (this.#config.auth.type !== "login") {
      throw new UmamiError("CONFIGURATION_ERROR", "Login auth is not configured.");
    }
    const url = resolveApiPath(this.#config.apiUrl, "auth/login");
    const timeoutSignal = AbortSignal.timeout(this.#config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        body: JSON.stringify({
          username: this.#config.auth.username,
          password: this.#config.auth.password,
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": `umami-compass/${VERSION}`,
        },
        method: "POST",
        redirect: "error",
        signal: timeoutSignal,
      });
    } catch (error) {
      throw new UmamiError("AUTHENTICATION_FAILED", "Could not authenticate with Umami.", {
        cause: error,
        retryable: true,
      });
    }
    if (!response.ok) throw statusError(response.status);

    const result = await readJsonResponse(
      response,
      this.#config.maxResponseBytes,
      "Umami returned an invalid login response.",
    );
    if (!isRecord(result) || typeof result.token !== "string" || !result.token) {
      throw new UmamiError("INVALID_RESPONSE", "Umami did not return an access token.");
    }
    return (result as LoginResponse).token;
  }
}
