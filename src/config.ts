import path from "node:path";
import { DEFAULT_OPENAI_MODEL } from "./providers/openai.js";

export type ProviderName = "mock" | "codex-cli" | "openai-api";

export interface Config {
  provider: ProviderName;
  /** Absolute path of the output sandbox. Created on first write. */
  outDir: string;
  /** Reference and edit images may only be read from inside this folder. */
  readRoot: string;
  timeoutSec: number;
  maxPerCall: number;
  /** Long edge of preview images returned to the client, in px. */
  previewSize: number;
  codexBin: string;
  openaiApiKey?: string;
  openaiModel: string;
}

const PROVIDERS: readonly ProviderName[] = ["mock", "codex-cli", "openai-api"];

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const provider = (env.IMAGEGEN_PROVIDER ?? "mock") as ProviderName;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`IMAGEGEN_PROVIDER must be one of ${PROVIDERS.join(", ")}, got "${provider}"`);
  }
  return {
    provider,
    outDir: path.resolve(cwd, env.IMAGEGEN_OUT_DIR ?? "generated-images"),
    readRoot: path.resolve(cwd, env.IMAGEGEN_READ_ROOT ?? "."),
    timeoutSec: positiveInt("IMAGEGEN_TIMEOUT_SEC", env.IMAGEGEN_TIMEOUT_SEC, 300),
    maxPerCall: positiveInt("IMAGEGEN_MAX_PER_CALL", env.IMAGEGEN_MAX_PER_CALL, 8),
    previewSize: positiveInt("IMAGEGEN_PREVIEW_SIZE", env.IMAGEGEN_PREVIEW_SIZE, 512),
    codexBin: env.IMAGEGEN_CODEX_BIN || "codex",
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.IMAGEGEN_OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  };
}
