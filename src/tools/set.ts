import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { resolveInSandbox, resolveReadable, slugify } from "../files/sandbox.js";
import type { ProgressFn, Provider, RawImage, SetRequest } from "../providers/types.js";
import { errorResult, parseSize, runAndSave } from "./run.js";

export function setItemPrompt(style: string, prompt: string): string {
  return `${prompt}\n\nStyle (shared by every image in this set): ${style}`;
}

/**
 * For providers without a native set mode: makes the items one by one. When the provider takes
 * references, the first image is passed as an extra reference for the rest, to keep the set
 * consistent.
 */
export async function generateSetOneByOne(
  provider: Provider,
  req: SetRequest,
  signal: AbortSignal,
  progress: ProgressFn,
): Promise<RawImage[]> {
  const images: RawImage[] = [];
  let anchorDir: string | undefined;
  const references = [...req.references];
  try {
    for (const [i, item] of req.items.entries()) {
      signal.throwIfAborted();
      progress(`Item ${i + 1}/${req.items.length}: ${item.name}`);
      const [image] = await provider.generate(
        { prompt: setItemPrompt(req.style, item.prompt), width: req.width, height: req.height, count: 1, transparent: req.transparent, references: [...references] },
        signal,
        progress,
      );
      if (!image) continue;
      images.push({ ...image, item: i });
      if (i === 0 && provider.capabilities.references && req.items.length > 1) {
        anchorDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-set-"));
        const anchor = path.join(anchorDir, "first-item.png");
        await fs.writeFile(anchor, image.data);
        references.push(anchor);
      }
    }
  } finally {
    if (anchorDir) await fs.rm(anchorDir, { recursive: true, force: true });
  }
  return images;
}

export function registerGenerateSet(server: McpServer, config: Config, provider: Provider): void {
  server.registerTool(
    "generate_set",
    {
      title: "Generate matching set",
      description:
        "Generate several different images that share one style, e.g. a set of icons, stickers, " +
        "badges, character portraits or story illustrations. Each item gets its own file, named after " +
        "the item, in one folder. Returns paths and previews.",
      inputSchema: {
        style: z
          .string()
          .min(1)
          .describe("The look every image shares: medium, palette, rendering, lighting, framing, background."),
        items: z
          .array(
            z.object({
              name: z.string().min(1).describe('Short name, used as the file name, e.g. "fire".'),
              prompt: z.string().min(1).describe("What this image shows."),
            }),
          )
          .min(1)
          .max(8)
          .describe("The images to make, one per item."),
        size: z.string().default("1024x1024").describe('Width x height in px for every image, e.g. "1024x1024".'),
        transparent: z.boolean().default(false).describe("Ask for transparent backgrounds."),
        references: z
          .array(z.string())
          .max(4)
          .default([])
          .describe("Existing images whose style the whole set should match (inside the working folder)."),
        folder: z
          .string()
          .optional()
          .describe("Folder for the set, relative to the output folder. Defaults to a slug of the style."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ style, items, size, transparent, references, folder }, extra): Promise<CallToolResult> => {
      let dims: { width: number; height: number };
      const refPaths: string[] = [];
      const dir = folder ?? slugify(style, 30);
      const fileNames = items.map((it) => slugify(it.name));
      try {
        dims = parseSize(size);
        if (items.length > config.maxPerCall) {
          throw new Error(`${items.length} items is over the limit of ${config.maxPerCall} images per call (IMAGEGEN_MAX_PER_CALL).`);
        }
        const dupes = fileNames.filter((n, i) => fileNames.indexOf(n) !== i);
        if (dupes.length) throw new Error(`Item names must be distinct as file names; repeated: ${[...new Set(dupes)].join(", ")}`);
        await resolveInSandbox(config.outDir, path.join(dir, fileNames[0]));
        if (references.length && !provider.capabilities.references) {
          throw new Error(`The ${provider.name} provider does not support reference images.`);
        }
        for (const r of references) refPaths.push(await resolveReadable(config.readRoot, r));
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const req: SetRequest = { style, items, ...dims, transparent, references: refPaths };
      let unmatched = 0;
      return runAndSave({
        config,
        provider,
        extra,
        verb: "Generated",
        count: items.length,
        output: (_i, _total, image) => {
          const base = { provider: provider.name, ...dims, transparent, references, style };
          if (image.item === undefined) {
            unmatched++;
            return {
              name: path.join(dir, `unmatched-${unmatched}`),
              meta: { ...base, prompt: style },
              note: "could not tell which item this is",
            };
          }
          const item = items[image.item];
          return {
            name: path.join(dir, fileNames[image.item]),
            meta: { ...base, prompt: setItemPrompt(style, item.prompt), item: item.name },
            note: item.name,
          };
        },
        call: (signal, progress) =>
          provider.generateSet
            ? provider.generateSet(req, signal, progress)
            : generateSetOneByOne(provider, req, signal, progress),
      });
    },
  );
}
