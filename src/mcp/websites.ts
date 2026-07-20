import type { PagedResponse, Website } from "../api/types.js";

export interface WebsiteSummary {
  domain?: string;
  id: string;
  name?: string;
}

export function websiteSummary(website: Website): WebsiteSummary {
  return {
    id: website.id,
    ...(typeof website.name === "string" ? { name: website.name } : {}),
    ...(typeof website.domain === "string" ? { domain: website.domain } : {}),
  };
}

export function sanitizeWebsitePage(page: PagedResponse<Website>): PagedResponse<WebsiteSummary> {
  return {
    ...page,
    data: page.data.map(websiteSummary),
  };
}
