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

  it("documents the auto-updating stable launcher without legacy npx forms", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain('"args": ["--yes", "--prefer-online", "umami-compass@latest"]');
    expect(readme).toContain("npx --yes --prefer-online umami-compass@latest");
    expect(readme).not.toContain('"args": ["-y", "umami-compass"]');
    expect(readme).not.toMatch(/npx -y umami-compass(?:\s|`|$)/);
  });

  it("keeps all public release channels in the protected release workflow", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("npm publish --provenance");
    expect(workflow).toContain('MCP_PUBLISHER_PATH}" login github-oidc');
    expect(workflow).toContain('MCP_PUBLISHER_PATH}" publish');
    expect(workflow).toContain("gh release create");
  });
});
