#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol, so all logging goes to stderr.
try {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`codex-openai-image-mcp ready (provider: ${config.provider}, output: ${config.outDir})`);
  if (config.provider === "openai-api" && !config.openaiApiKey) {
    console.error("codex-openai-image-mcp: OPENAI_API_KEY is not set; image calls will fail until it is.");
  }
} catch (err) {
  console.error(`codex-openai-image-mcp failed to start: ${(err as Error).message}`);
  process.exit(1);
}
