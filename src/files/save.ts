import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { RawImage } from "../providers/types.js";
import { resolveInSandbox, uniqueStem } from "./sandbox.js";

export interface SidecarMeta {
  prompt: string;
  provider: string;
  width: number;
  height: number;
  transparent: boolean;
  references: string[];
  /** The input image, for edits. */
  source?: string;
  /** For sets: the shared style and this image's item name. */
  style?: string;
  item?: string;
}

export interface SavedImage {
  path: string;
  sidecarPath: string;
  width: number;
  height: number;
}

/**
 * Writes an image and its `<name>.json` sidecar inside the output folder. `name` is relative to
 * `outDir` and has no extension; an existing file is never overwritten, a `-2`, `-3`, … suffix is
 * added instead.
 */
export async function saveImage(
  outDir: string,
  name: string,
  image: RawImage,
  meta: SidecarMeta,
): Promise<SavedImage> {
  const target = await resolveInSandbox(outDir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Re-check after mkdir in case a directory along the way is a symlink created meanwhile.
  await resolveInSandbox(outDir, name);

  const stem = await uniqueStem(target, [".png", ".json"]);
  const imagePath = `${stem}.png`;
  const sidecarPath = `${stem}.json`;

  const { width = meta.width, height = meta.height } = await sharp(image.data).metadata();
  // "wx" fails if the file appeared since uniqueStem checked, rather than overwriting it.
  await fs.writeFile(imagePath, image.data, { flag: "wx" });
  const sidecar = {
    ...meta,
    width,
    height,
    model: image.model,
    file: path.basename(imagePath),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", { flag: "wx" });

  return { path: imagePath, sidecarPath, width, height };
}

/** Downscales an image so its long edge is at most `maxEdge` px, for returning to the client. */
export async function makePreview(data: Buffer, maxEdge: number): Promise<{ data: string; mimeType: string }> {
  const buf = await sharp(data)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return { data: buf.toString("base64"), mimeType: "image/png" };
}
