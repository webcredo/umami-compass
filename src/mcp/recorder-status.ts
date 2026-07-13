import { z } from "zod";
import type { UmamiClient } from "../api/client.js";

export const recorderDataStatusShape = {
  accessStatus: z.literal("authorized"),
  dataStatus: z.enum(["available", "empty"]),
  recorderStatus: z.enum(["enabled", "disabled", "unknown"]).optional(),
  emptyReason: z
    .enum([
      "recorder_disabled",
      "replay_disabled",
      "heatmap_disabled",
      "no_data_in_range",
      "no_data_for_page",
    ])
    .optional(),
};

type RecorderFeature = "replay" | "heatmap";
type EmptyReason =
  | "recorder_disabled"
  | "replay_disabled"
  | "heatmap_disabled"
  | "no_data_in_range"
  | "no_data_for_page";

export interface RecorderDataStatus {
  accessStatus: "authorized";
  dataStatus: "available" | "empty";
  recorderStatus?: "enabled" | "disabled" | "unknown";
  emptyReason?: EmptyReason;
}

export async function describeRecorderDataStatus(
  client: UmamiClient,
  websiteId: string,
  feature: RecorderFeature,
  hasData: boolean,
  noDataReason: "no_data_in_range" | "no_data_for_page",
  signal?: AbortSignal,
): Promise<RecorderDataStatus> {
  if (hasData) return { accessStatus: "authorized", dataStatus: "available" };

  try {
    const recorder = await client.get<Record<string, unknown>>(
      `websites/${encodeURIComponent(websiteId)}/recorder`,
      undefined,
      signal,
    );
    if (recorder.enabled !== true) {
      return {
        accessStatus: "authorized",
        dataStatus: "empty",
        recorderStatus: "disabled",
        emptyReason: "recorder_disabled",
      };
    }
    const featureEnabled =
      feature === "replay" ? recorder.replayEnabled === true : recorder.heatmapEnabled === true;
    if (!featureEnabled) {
      return {
        accessStatus: "authorized",
        dataStatus: "empty",
        recorderStatus: "disabled",
        emptyReason: feature === "replay" ? "replay_disabled" : "heatmap_disabled",
      };
    }
    return {
      accessStatus: "authorized",
      dataStatus: "empty",
      recorderStatus: "enabled",
      emptyReason: noDataReason,
    };
  } catch {
    return {
      accessStatus: "authorized",
      dataStatus: "empty",
      recorderStatus: "unknown",
      emptyReason: noDataReason,
    };
  }
}
