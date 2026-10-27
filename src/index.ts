#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol, so all logging goes to stderr.
try {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`imagegen-mcp ready (provider: ${config.provider}, output: ${config.outDir})`);
} catch (err) {
  console.error(`imagegen-mcp failed to start: ${(err as Error).message}`);
  process.exit(1);
}
