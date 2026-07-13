import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toSafeError } from "../api/errors.js";

export const READ_ONLY_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} satisfies ToolAnnotations;

export const CREATE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export const UPDATE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export const DESTRUCTIVE_ANNOTATIONS = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export async function runTool<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    const data = await operation();
    const structuredContent = { data };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: toSafeError(error) }) }],
      isError: true,
    };
  }
}
