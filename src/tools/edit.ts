import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import type { Config } from "../config.js";
import { resolveReadable, slugify } from "../files/sandbox.js";
import type { Provider } from "../providers/types.js";
import { errorResult, parseSize, runAndSave, variantNames } from "./run.js";

export function registerEditImage(server: McpServer, config: Config, provider: Provider): void {
  server.registerTool(
    "edit_image",
    {
      title: "Edit image",
      description:
        "Change an existing image with a text instruction (e.g. 'make the sky a sunset', 'remove the " +
        "person on the left', 'turn it into a watercolour', 'remove the background'). The original is " +
        "never modified; edited copies are saved in the output folder with a .json sidecar, and their " +
        "paths are returned with small previews.",
      inputSchema: {
        image: z.string().min(1).describe("Path of the image to edit (inside the working folder)."),
        prompt: z
          .string()
          .min(1)
          .describe("The change to make. Say what should change and, if it matters, what must stay the same."),
        size: z
          .string()
          .optional()
          .describe('Output size as width x height in px, e.g. "1024x1024". Defaults to the size of the input image.'),
        mask: z
          .string()
          .optional()
          .describe("Optional PNG whose transparent areas mark where to edit (openai-api only). Resized to the image if needed."),
        count: z.number().int().min(1).max(4).default(1).describe("Number of edited variants (1-4)."),
        transparent: z.boolean().default(false).describe("Ask for a transparent background, e.g. for a cutout."),
        references: z
          .array(z.string())
          .max(3)
          .default([])
          .describe("Extra images the edit uses: an object to insert, or a style to apply (inside the working folder)."),
        out_name: z
          .string()
          .optional()
          .describe('File name without extension, relative to the output folder. Defaults to "<input name>-edited".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ image, prompt, size, mask, count, transparent, references, out_name }, extra): Promise<CallToolResult> => {
      const edit = provider.edit;
      if (!edit || !provider.capabilities.edit) {
        return errorResult(`The ${provider.name} provider does not support editing images.`);
      }

      let source: string;
      let maskPath: string | undefined;
      let dims: { width: number; height: number };
      const refPaths: string[] = [];
      try {
        source = await resolveReadable(config.readRoot, image);
        if (size) {
          dims = parseSize(size);
        } else {
          const meta = await sharp(source).metadata().catch(() => {
            throw new Error(`"${image}" is not an image sharp can read`);
          });
          if (!meta.width || !meta.height) throw new Error(`Could not read the size of "${image}"`);
          dims = { width: meta.width, height: meta.height };
        }
        if (references.length && !provider.capabilities.references) {
          throw new Error(`The ${provider.name} provider does not support reference images.`);
        }
        for (const r of references) refPaths.push(await resolveReadable(config.readRoot, r));
        if (mask) {
          if (!provider.capabilities.mask) throw new Error(`The ${provider.name} provider does not support masks; describe the area in the prompt instead.`);
          maskPath = await resolveReadable(config.readRoot, mask);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
      if (count > config.maxPerCall) {
        return errorResult(`count ${count} is over the limit of ${config.maxPerCall} images per call (IMAGEGEN_MAX_PER_CALL).`);
      }

      const stem = slugify(path.basename(source, path.extname(source)));
      return runAndSave({
        config,
        provider,
        extra,
        verb: "Edited",
        count,
        output: variantNames(out_name ?? `${stem}-edited`, { prompt, provider: provider.name, ...dims, transparent, references, source: image, mask }),
        call: (signal, progress) =>
          edit.call(provider, { image: source, mask: maskPath, prompt, ...dims, count, transparent, references: refPaths }, signal, progress),
      });
    },
  );
}
