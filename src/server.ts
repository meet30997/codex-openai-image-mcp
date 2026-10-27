import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createProvider } from "./providers/index.js";
import { registerEditImage } from "./tools/edit.js";
import { registerGenerateImage } from "./tools/generate.js";

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "imagegen-mcp", version: "0.0.1" });
  const provider = createProvider(config);
  registerGenerateImage(server, config, provider);
  registerEditImage(server, config, provider);
  return server;
}
