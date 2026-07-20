import type { UmamiCompassConfig } from "../config.js";
import { VERSION } from "../version.js";
import { UmamiError } from "./errors.js";
import type {
  HeatmapReportRequest,
  LoginResponse,
  PagedResponse,
  Query,
  ReadOnlyReportRequest,
  Team,
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

interface DiscoveryBudget {
  websitePages: number;
}

const DISCOVERY_PAGE_SIZE = 100;
const MAX_DISCOVERY_TEAMS = 25;
const MAX_DISCOVERY_WEBSITE_PAGES = 50;

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

function requirePage<T>(
  value: unknown,
  label: string,
  isItem: (item: unknown) => item is T,
): PagedResponse<T> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(isItem) ||
    typeof value.count !== "number" ||
    typeof value.page !== "number" ||
    typeof value.pageSize !== "number" ||
    value.count < 0 ||
    value.page < 1 ||
    value.pageSize < 1
  ) {
    throw new UmamiError("INVALID_RESPONSE", `Umami returned an invalid ${label} list.`);
  }
  return value as unknown as PagedResponse<T>;
}

function requireWebsitePage(value: unknown): PagedResponse<Website> {
  return requirePage(
    value,
    "website",
    (item): item is Website => isRecord(item) && typeof item.id === "string",
  );
}

function requireTeamPage(value: unknown): PagedResponse<Team> {
  return requirePage(
    value,
    "team",
    (item): item is Team => isRecord(item) && typeof item.id === "string",
  );
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
  #teamWebsiteIdsPromise?: Promise<ReadonlySet<string>>;

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

  async assertWebsiteAccessible(websiteId: string, signal?: AbortSignal): Promise<void> {
    this.assertWebsiteAllowed(websiteId);
    await this.#assertTeamWebsiteAllowed(websiteId, signal);
  }

  async listWebsites(query: Query, signal?: AbortSignal): Promise<PagedResponse<Website>> {
    const requestedPage = typeof query.page === "number" ? query.page : 1;
    const requestedPageSize = typeof query.pageSize === "number" ? query.pageSize : 20;
    const search = typeof query.search === "string" ? query.search : undefined;
    const visible = await this.#discoverWebsites(search, signal);
    const start = (requestedPage - 1) * requestedPageSize;
    return {
      data: visible.slice(start, start + requestedPageSize),
      count: visible.length,
      page: requestedPage,
      pageSize: requestedPageSize,
    } satisfies PagedResponse<Website>;
  }

  async #discoverWebsites(search: string | undefined, signal?: AbortSignal): Promise<Website[]> {
    const budget: DiscoveryBudget = { websitePages: 0 };
    const websites = this.#config.teamIds
      ? []
      : await this.#listAllWebsitePages(
          "websites",
          {
            includeTeams: true,
            page: 1,
            pageSize: DISCOVERY_PAGE_SIZE,
            search,
          },
          budget,
          signal,
        );

    let teams: Team[];
    if (this.#config.teamIds) {
      teams = [...this.#config.teamIds].map((id) => ({ id }));
    } else {
      const teamPage = requireTeamPage(
        await this.get<unknown>("teams", { page: 1, pageSize: DISCOVERY_PAGE_SIZE }, signal),
      );
      if (teamPage.count > MAX_DISCOVERY_TEAMS) {
        throw new UmamiError(
          "VALIDATION_ERROR",
          `The account belongs to more than ${MAX_DISCOVERY_TEAMS} teams, so website discovery was stopped safely. Use UMAMI_TEAM_IDS, UMAMI_WEBSITE_IDS, or a more limited Umami identity.`,
        );
      }
      if (teamPage.data.length < teamPage.count) {
        throw new UmamiError("INVALID_RESPONSE", "Umami returned an incomplete team list.");
      }
      teams = teamPage.data;
    }

    for (const team of teams) {
      const teamWebsites = await this.#listAllWebsitePages(
        `teams/${encodeURIComponent(team.id)}/websites`,
        { page: 1, pageSize: DISCOVERY_PAGE_SIZE, search },
        budget,
        signal,
      );
      websites.push(
        ...teamWebsites.map((website) => ({
          ...website,
          teamId: website.teamId ?? team.id,
        })),
      );
    }

    const unique = new Map<string, Website>();
    for (const website of websites) {
      const key = website.id.toLowerCase();
      if (!unique.has(key)) unique.set(key, website);
    }
    return [...unique.values()].filter((website) => {
      const websiteAllowed =
        !this.#config.websiteIds || this.#config.websiteIds.has(website.id.toLowerCase());
      const teamAllowed =
        !this.#config.teamIds ||
        (website.teamId != null && this.#config.teamIds.has(website.teamId.toLowerCase()));
      return websiteAllowed && teamAllowed;
    });
  }

  async #listAllWebsitePages(
    path: string,
    query: Query,
    budget: DiscoveryBudget,
    signal?: AbortSignal,
  ): Promise<Website[]> {
    this.#reserveDiscoveryPages(budget, 1);
    const firstPage = requireWebsitePage(await this.get<unknown>(path, query, signal));
    const pageCount = Math.max(1, Math.ceil(firstPage.count / firstPage.pageSize));
    this.#reserveDiscoveryPages(budget, pageCount - 1);

    const websites = [...firstPage.data];
    for (let page = 2; page <= pageCount; page += 1) {
      const nextPage = requireWebsitePage(
        await this.get<unknown>(path, { ...query, page }, signal),
      );
      websites.push(...nextPage.data);
    }
    return websites;
  }

  #reserveDiscoveryPages(budget: DiscoveryBudget, pages: number): void {
    if (budget.websitePages + pages > MAX_DISCOVERY_WEBSITE_PAGES) {
      throw new UmamiError(
        "VALIDATION_ERROR",
        `Website discovery would require more than ${MAX_DISCOVERY_WEBSITE_PAGES} upstream pages. Use search, UMAMI_WEBSITE_IDS, or a more limited Umami identity.`,
      );
    }
    budget.websitePages += pages;
  }

  async getWebsite(websiteId: string, signal?: AbortSignal): Promise<Website> {
    const normalizedWebsiteId = websiteId.toLowerCase();
    await this.assertWebsiteAccessible(normalizedWebsiteId, signal);
    return requireWebsite(
      await this.#request<unknown>(
        `websites/${encodeURIComponent(normalizedWebsiteId)}`,
        { method: "GET", signal },
        true,
      ),
    );
  }

  async get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    const websiteMatch = /^websites\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
    if (websiteMatch?.[1]) {
      await this.assertWebsiteAccessible(websiteMatch[1], signal);
    }
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
    await this.assertWebsiteAccessible(request.websiteId, signal);
    return this.#request<T>(
      `reports/${request.type}`,
      { body: request, method: "POST", signal },
      true,
    );
  }

  async #assertTeamWebsiteAllowed(websiteId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#config.teamIds) return;
    const normalizedWebsiteId = websiteId.toLowerCase();
    let discovery = this.#teamWebsiteIdsPromise;
    if (!discovery) {
      discovery = this.#discoverWebsites(undefined, signal).then(
        (websites) => new Set(websites.map((website) => website.id.toLowerCase())),
      );
      this.#teamWebsiteIdsPromise = discovery;
    }
    let allowedIds: ReadonlySet<string>;
    try {
      allowedIds = await discovery;
    } catch (error) {
      if (this.#teamWebsiteIdsPromise === discovery) this.#teamWebsiteIdsPromise = undefined;
      throw error;
    }
    if (!allowedIds.has(normalizedWebsiteId)) {
      throw new UmamiError(
        "FORBIDDEN",
        "This website is outside the configured UMAMI_TEAM_IDS allowlist.",
      );
    }
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
