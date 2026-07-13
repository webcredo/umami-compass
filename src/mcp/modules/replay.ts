import { z } from "zod";
import { READ_ONLY_ANNOTATIONS, runTool } from "../result.js";
import {
  filtersSchema,
  pagedOutputSchema,
  pageSchema,
  pageSizeSchema,
  rangeQuery,
  timeSchema,
  uuidSchema,
} from "../schemas.js";
import type { ToolModule } from "../tool-module.js";

export const replayModule: ToolModule = {
  id: "replay",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_replays",
      {
        title: "List session replay metadata",
        description:
          "List Umami 3.2 session replay metadata. Raw rrweb event payloads are intentionally excluded to limit sensitive and oversized model context.",
        inputSchema: {
          websiteId: uuidSchema,
          start: timeSchema,
          end: timeSchema,
          page: pageSchema,
          pageSize: pageSizeSchema,
          search: z.string().max(500).optional(),
          minDuration: z
            .number()
            .int()
            .min(0)
            .max(86_400)
            .optional()
            .describe("Minimum replay duration in seconds"),
          filters: filtersSchema.optional(),
        },
        outputSchema: pagedOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, page, pageSize, search, minDuration, filters }, extra) =>
        runTool(() => {
          client.assertWebsiteAllowed(websiteId);
          return client.get(
            `websites/${encodeURIComponent(websiteId)}/replays`,
            {
              ...rangeQuery(start, end, config.maxRangeDays, { filters }),
              page,
              pageSize,
              search,
              minDuration,
            },
            extra.signal,
          );
        }),
    );
  },
};
