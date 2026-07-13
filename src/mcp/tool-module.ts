import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UmamiClient } from "../api/client.js";
import type { Toolset, UmamiCompassConfig } from "../config.js";

export type ToolAccess = "read" | "write";

export interface ToolContext {
  client: UmamiClient;
  config: UmamiCompassConfig;
}

export interface ToolModule {
  access: ToolAccess;
  id: Toolset;
  register(server: McpServer, context: ToolContext): void;
}

export interface AccessPolicy {
  allowWriteModules: boolean;
}

export const READ_ONLY_POLICY: AccessPolicy = Object.freeze({ allowWriteModules: false });

export function assertModuleAllowed(module: ToolModule, policy: AccessPolicy): void {
  if (module.access === "write" && !policy.allowWriteModules) {
    throw new Error(
      `Refusing to register write-capable module "${module.id}" without an explicit write policy.`,
    );
  }
}
