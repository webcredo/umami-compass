export type QueryPrimitive = boolean | number | string;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export interface PagedResponse<T = unknown> {
  count: number;
  data: T[];
  page: number;
  pageSize: number;
}

export interface Website {
  createdAt?: string;
  deletedAt?: string | null;
  domain?: string;
  id: string;
  name?: string;
  resetAt?: string | null;
  teamId?: string | null;
  updatedAt?: string;
  userId?: string | null;
  [key: string]: unknown;
}

export interface Team {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface LoginResponse {
  token: string;
  [key: string]: unknown;
}

interface ReportRequest<TType extends string, TParameters> {
  filters: Record<string, unknown>;
  parameters: TParameters;
  type: TType;
  websiteId: string;
}

export type HeatmapReportRequest = ReportRequest<
  "heatmap",
  {
    endDate: string;
    mode: "click" | "scroll";
    startDate: string;
    urlPath?: string;
  }
>;

export type PerformanceMetric = "cls" | "fcp" | "inp" | "lcp" | "ttfb";

export type PerformanceReportRequest = ReportRequest<
  "performance",
  {
    endDate: string;
    metric?: PerformanceMetric;
    startDate: string;
    timezone?: string;
    unit?: "day" | "hour" | "minute" | "month" | "year";
  }
>;

export type GoalReportRequest = ReportRequest<
  "goal",
  { endDate: string; startDate: string; type: string; value: string }
>;

export interface FunnelStepFilter {
  operator: "c" | "dnc" | "eq" | "neq";
  property: string;
  value: string;
}

export interface FunnelStep {
  filters?: FunnelStepFilter[];
  type: "event" | "path";
  value: string;
}

export type FunnelReportRequest = ReportRequest<
  "funnel",
  { endDate: string; startDate: string; steps: FunnelStep[]; window: number }
>;

export type JourneyReportRequest = ReportRequest<
  "journey",
  {
    endDate: string;
    endStep?: string;
    eventType?: number;
    startDate: string;
    startStep?: string;
    steps: number;
  }
>;

export type RetentionReportRequest = ReportRequest<
  "retention",
  { endDate: string; startDate: string; timezone?: string }
>;

export type UtmReportRequest = ReportRequest<"utm", { endDate: string; startDate: string }>;

export type AttributionReportRequest = ReportRequest<
  "attribution",
  {
    currency?: string;
    endDate: string;
    model: "first-click" | "last-click";
    startDate: string;
    step: string;
    type: "event" | "path";
  }
>;

export type BreakdownField =
  | "browser"
  | "city"
  | "country"
  | "device"
  | "distinctId"
  | "event"
  | "hostname"
  | "language"
  | "os"
  | "path"
  | "query"
  | "referrer"
  | "region"
  | "tag"
  | "title"
  | "utmCampaign"
  | "utmContent"
  | "utmMedium"
  | "utmSource"
  | "utmTerm";

export type BreakdownReportRequest = ReportRequest<
  "breakdown",
  { endDate: string; fields: BreakdownField[]; startDate: string }
>;

export type ReadOnlyReportRequest =
  | AttributionReportRequest
  | BreakdownReportRequest
  | FunnelReportRequest
  | GoalReportRequest
  | HeatmapReportRequest
  | JourneyReportRequest
  | PerformanceReportRequest
  | RetentionReportRequest
  | UtmReportRequest;
