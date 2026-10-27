import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { resolveReadable, slugify } from "../files/sandbox.js";
import type { Provider } from "../providers/types.js";
import { errorResult, parseSize, runAndSave } from "./run.js";

export function registerGenerateImage(server: McpServer, config: Config, provider: Provider): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate one or more images from a text prompt. Saves full-size PNGs (plus a .json sidecar " +
        "with the prompt and settings) in the output folder and returns their paths with small previews.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Be specific about subject, style, composition and colours."),
        size: z.string().default("1024x1024").describe('Width x height in px, e.g. "1024x1024" or "1536x1024".'),
        count: z.number().int().min(1).max(4).default(1).describe("Number of variants to generate (1-4)."),
        transparent: z.boolean().default(false).describe("Ask for a transparent background."),
        references: z
          .array(z.string())
          .max(4)
          .default([])
          .describe("Paths of existing images to match the style of (inside the working folder)."),
        out_name: z
          .string()
          .optional()
          .describe('File name without extension, relative to the output folder, e.g. "icons/rocket". Defaults to a slug of the prompt.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, size, count, transparent, references, out_name }, extra): Promise<CallToolResult> => {
      let dims: { width: number; height: number };
      const refPaths: string[] = [];
      try {
        dims = parseSize(size);
        if (references.length && !provider.capabilities.references) {
          throw new Error(`The ${provider.name} provider does not support reference images.`);
        }
        for (const r of references) refPaths.push(await resolveReadable(config.readRoot, r));
      } catch (err) {
        return errorResult((err as Error).message);
      }
      if (count > config.maxPerCall) {
        return errorResult(`count ${count} is over the limit of ${config.maxPerCall} images per call (IMAGEGEN_MAX_PER_CALL).`);
      }

      return runAndSave({
        config,
        provider,
        extra,
        verb: "Generated",
        count,
        outName: out_name ?? slugify(prompt),
        meta: { prompt, provider: provider.name, ...dims, transparent, references },
        call: (signal, progress) =>
          provider.generate({ prompt, ...dims, count, transparent, references: refPaths }, signal, progress),
      });
    },
  );
}
