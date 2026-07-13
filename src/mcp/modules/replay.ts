import { z } from "zod";
import { describeRecorderDataStatus, recorderDataStatusShape } from "../recorder-status.js";
import { requirePagedResponse } from "../report-utils.js";
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

const replayOutputSchema = {
  data: pagedOutputSchema.data.extend(recorderDataStatusShape).passthrough(),
};

export const replayModule: ToolModule = {
  id: "replay",
  access: "read",
  register(server, { client, config }) {
    server.registerTool(
      "list_replays",
      {
        title: "List session replay metadata",
        description:
          "List Umami 3.2 session replay metadata. Successful responses state whether data is available and why an authorized result is empty. Raw rrweb event payloads are intentionally excluded.",
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
        outputSchema: replayOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      ({ websiteId, start, end, page, pageSize, search, minDuration, filters }, extra) =>
        runTool(async () => {
          client.assertWebsiteAllowed(websiteId);
          const result = requirePagedResponse(
            await client.get(
              `websites/${encodeURIComponent(websiteId)}/replays`,
              {
                ...rangeQuery(start, end, config.maxRangeDays, { filters }),
                page,
                pageSize,
                search,
                minDuration,
              },
              extra.signal,
            ),
          );
          const status = await describeRecorderDataStatus(
            client,
            websiteId,
            "replay",
            result.data.length > 0,
            "no_data_in_range",
            extra.signal,
          );
          return { ...result, ...status };
        }),
    );
  },
};
