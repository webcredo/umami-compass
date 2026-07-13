import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "umami-compass-package-"));

try {
  const packResult = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
      { cwd: projectRoot, encoding: "utf8" },
    ),
  );
  // npm 10/11 return an array; npm 12 returns an object keyed by package name.
  const packed = Array.isArray(packResult) ? packResult : Object.values(packResult);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball name");

  const consumer = join(temporaryRoot, "consumer");
  await mkdir(consumer);
  execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporaryRoot, filename)],
    { cwd: consumer, stdio: "ignore" },
  );

  const packageJson = JSON.parse(
    await readFile(join(consumer, "node_modules", "umami-compass", "package.json"), "utf8"),
  );
  const cli = join(consumer, "node_modules", "umami-compass", "dist", "cli.js");
  const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
  if (version !== packageJson.version) {
    throw new Error(`packaged CLI version mismatch: ${version} != ${packageJson.version}`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { ...process.env, UMAMI_API_KEY: "package-smoke-test" },
    stderr: "pipe",
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map(({ name }) => name);
    if (tools.length !== 7 || !names.includes("get_pageviews")) {
      throw new Error(`unexpected packaged MCP tool surface: ${names.join(", ")}`);
    }
  } finally {
    await client.close();
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
