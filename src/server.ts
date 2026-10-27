import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createProvider } from "./providers/index.js";
import { registerEditImage } from "./tools/edit.js";
import { registerGenerateImage } from "./tools/generate.js";
import { registerGenerateSet } from "./tools/set.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: pkg.name, version: pkg.version });
  const provider = createProvider(config);
  registerGenerateImage(server, config, provider);
  registerEditImage(server, config, provider);
  registerGenerateSet(server, config, provider);
  return server;
}
