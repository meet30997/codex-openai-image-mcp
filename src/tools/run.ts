import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import type { Config } from "../config.js";
import { makePreview, saveImage, type SidecarMeta } from "../files/save.js";
import type { ProgressFn, Provider, RawImage } from "../providers/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const SIZE = /^(\d{2,4})x(\d{2,4})$/;
const MAX_EDGE = 4096;

export function parseSize(size: string): { width: number; height: number } {
  const m = SIZE.exec(size);
  if (!m) throw new Error(`size must look like "1024x1024", got "${size}"`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16 || width > MAX_EDGE || height > MAX_EDGE) {
    throw new Error(`size must be between 16 and ${MAX_EDGE} px on each side, got "${size}"`);
  }
  return { width, height };
}

/**
 * Backends return their own native sizes (Codex gives e.g. 1254x1254), so crop-to-fill and resize
 * to exactly the requested size. Also reports when a transparent background was asked for but the
 * image has no alpha channel.
 */
async function fitToSize(
  raw: RawImage,
  width: number,
  height: number,
  transparent: boolean,
): Promise<{ image: RawImage; note?: string }> {
  const meta = await sharp(raw.data).metadata();
  const notes: string[] = [];
  let data = raw.data;
  if (meta.width !== width || meta.height !== height) {
    data = await sharp(raw.data).resize(width, height, { fit: "cover", position: "centre" }).png().toBuffer();
    notes.push(`resized from ${meta.width}x${meta.height}`);
  }
  if (transparent && !meta.hasAlpha) notes.push("no transparent background in the output");
  return { image: { ...raw, data }, note: notes.join("; ") || undefined };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Runs a provider call with progress notifications, cancellation and the configured timeout, then
 * resizes, saves (with sidecars) and previews every image it returns.
 */
export async function runAndSave(opts: {
  config: Config;
  provider: Provider;
  extra: ToolExtra;
  /** Verb for the summary line, e.g. "Generated". */
  verb: string;
  count: number;
  outName: string;
  meta: SidecarMeta;
  call: (signal: AbortSignal, progress: ProgressFn) => Promise<RawImage[]>;
}): Promise<CallToolResult> {
  const { config, provider, extra, meta } = opts;

  const progressToken = extra._meta?.progressToken;
  let step = 0;
  const progress = (message: string) => {
    if (progressToken === undefined) return;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++step, message },
      })
      .catch(() => {});
  };

  const timeout = AbortSignal.timeout(config.timeoutSec * 1000);
  const signal = AbortSignal.any([extra.signal, timeout]);

  let images;
  try {
    images = await opts.call(signal, progress);
  } catch (err) {
    if (timeout.aborted) return errorResult(`${provider.name} timed out after ${config.timeoutSec}s (IMAGEGEN_TIMEOUT_SEC).`);
    if (extra.signal.aborted) return errorResult("Cancelled.");
    return errorResult(`${provider.name} failed: ${(err as Error).message}`);
  }

  const content: CallToolResult["content"] = [];
  const lines: string[] = [];
  try {
    for (const [i, raw] of images.entries()) {
      const { image, note } = await fitToSize(raw, meta.width, meta.height, meta.transparent);
      const name = images.length > 1 ? `${opts.outName}-v${i + 1}` : opts.outName;
      const saved = await saveImage(config.outDir, name, image, meta);
      lines.push(`${saved.path} (${saved.width}x${saved.height})${note ? ` - ${note}` : ""}`);
      const preview = await makePreview(image.data, config.previewSize);
      content.push({ type: "image", data: preview.data, mimeType: preview.mimeType });
    }
  } catch (err) {
    const done = lines.length ? `\nSaved before the error:\n${lines.join("\n")}` : "";
    return errorResult(`Could not save image: ${(err as Error).message}${done}`);
  }

  const short = images.length < opts.count ? ` (asked for ${opts.count})` : "";
  content.unshift({
    type: "text",
    text: `${opts.verb} ${images.length} image(s)${short} with ${provider.name}:\n${lines.join("\n")}`,
  });
  return { content };
}
