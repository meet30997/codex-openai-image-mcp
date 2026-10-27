import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import { createCodexProvider } from "./codex.js";
import { createMockProvider } from "./mock.js";
import { createOpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export function createProvider(config: Config): Provider {
  switch (config.provider) {
    case "mock":
      return createMockProvider();
    case "codex-cli":
      return createCodexProvider({
        bin: config.codexBin,
        codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      });
    case "openai-api":
      return createOpenAIProvider({ apiKey: config.openaiApiKey, model: config.openaiModel });
  }
}
