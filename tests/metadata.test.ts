import { access, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

describe("release metadata", () => {
  it("keeps package, runtime, and MCP Registry identity in sync", async () => {
    const packageJson = await readJson("../package.json");
    const serverJson = await readJson("../server.json");

    expect(packageJson.version).toBe(VERSION);
    expect(serverJson.version).toBe(VERSION);
    expect(serverJson.name).toBe(packageJson.mcpName);
    expect((serverJson.packages as Array<Record<string, unknown>>)[0]?.identifier).toBe(
      packageJson.name,
    );
    expect((serverJson.packages as Array<Record<string, unknown>>)[0]?.version).toBe(VERSION);
  });

  it("keeps local Markdown links resolvable", async () => {
    const missing: string[] = [];
    for (const markdownFile of await markdownFiles(repositoryRoot)) {
      const markdown = await readFile(markdownFile, "utf8");
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]?.replace(/^<|>$/g, "");
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
        const localPath = decodeURIComponent(target.split("#", 1)[0] ?? "");
        try {
          await access(resolve(dirname(markdownFile), localPath));
        } catch {
          missing.push(`${markdownFile}: ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
