import fs from "node:fs/promises";
import path from "node:path";
import OpenAI, { APIError, toFile } from "openai";
import sharp from "sharp";
import type { EditRequest, GenerateRequest, ProgressFn, Provider, RawImage } from "./types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-image-2.5-sunburst";

/** The subset of the OpenAI client this provider uses, so tests can pass a fake. */
export type ImagesClient = Pick<OpenAI["images"], "generate" | "edit">;

export interface OpenAIOptions {
  apiKey?: string;
  model: string;
  /** Overrides the real client (tests). */
  client?: ImagesClient;
}

export class OpenAIImageError extends Error {
  name = "OpenAIImageError";
}

const FIXED_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

// Limits for models that take arbitrary sizes (gpt-image-2 and later), from the SDK docs.
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 3840 * 2160;
const MAX_LONG = 3840;
const MAX_SHORT = 2160;

function supportsFlexibleSize(model: string): boolean {
  return /^gpt-image-[2-9]/.test(model);
}

/**
 * Picks a size the API accepts that is as close as possible to the requested one. The tool layer
 * then resizes the result to exactly what was asked for.
 */
export function apiSize(model: string, width: number, height: number): string {
  if (!supportsFlexibleSize(model)) {
    const want = width / height;
    const best = FIXED_SIZES.reduce((a, b) =>
      Math.abs(Math.log(b.width / b.height / want)) < Math.abs(Math.log(a.width / a.height / want)) ? b : a,
    );
    return `${best.width}x${best.height}`;
  }

  const ratio = Math.min(3, Math.max(1 / 3, width / height));
  let w = width;
  let h = w / ratio;
  const scale = (f: number) => {
    w *= f;
    h *= f;
  };
  if (w * h < MIN_PIXELS) scale(Math.sqrt(MIN_PIXELS / (w * h)));
  if (w * h > MAX_PIXELS) scale(Math.sqrt(MAX_PIXELS / (w * h)));
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long > MAX_LONG) scale(MAX_LONG / long);
  if (short > MAX_SHORT) scale(MAX_SHORT / short);

  // Round to multiples of 16, nudging back inside the pixel range if rounding pushed it out.
  let rw = Math.max(16, Math.round(w / 16) * 16);
  let rh = Math.max(16, Math.round(h / 16) * 16);
  while (rw * rh < MIN_PIXELS) {
    if (rw / rh < ratio) rw += 16;
    else rh += 16;
  }
  while (rw * rh > MAX_PIXELS || Math.max(rw, rh) > MAX_LONG || Math.min(rw, rh) > MAX_SHORT) {
    if (rw / rh > ratio) rw -= 16;
    else rh -= 16;
  }
  return `${rw}x${rh}`;
}

const UPLOAD_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Reads an input image for upload, converting formats the API doesn't take to PNG. */
async function upload(file: string) {
  const ext = path.extname(file).toLowerCase();
  const type = UPLOAD_TYPES[ext];
  if (type) return toFile(await fs.readFile(file), path.basename(file), { type });
  const png = await sharp(file).png().toBuffer();
  return toFile(png, `${path.basename(file, ext)}.png`, { type: "image/png" });
}

/** Masks must be PNGs with alpha and the same size as the image they apply to. */
async function uploadMask(mask: string, image: string) {
  const { width, height } = await sharp(image).metadata();
  const png = await sharp(mask).resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();
  return toFile(png, "mask.png", { type: "image/png" });
}

function describeError(err: unknown, model: string): Error {
  if (!(err instanceof APIError) || err.status === undefined) return err as Error;
  const msg = err.message.replace(/^\d{3}\s+/, "");
  if (err.status === 401) return new OpenAIImageError(`OPENAI_API_KEY was rejected (401): ${msg}`);
  if (err.status === 403) return new OpenAIImageError(`Access denied (403). Your organization may need verification to use ${model}: ${msg}`);
  if (err.status === 404) return new OpenAIImageError(`Model "${model}" not found (404). Check IMAGEGEN_OPENAI_MODEL: ${msg}`);
  if (err.code === "insufficient_quota" || /no credits|insufficient.quota/i.test(msg)) {
    return new OpenAIImageError(`Your OpenAI account has no credits left; add credits at https://platform.openai.com/settings/organization/billing/ (${msg})`);
  }
  if (err.status === 429) return new OpenAIImageError(`Rate limit reached (429): ${msg}`);
  if (err.code === "moderation_blocked" || /safety|moderation|content policy/i.test(msg)) {
    return new OpenAIImageError(`The request was refused by OpenAI's content policy: ${msg}`);
  }
  return new OpenAIImageError(`OpenAI API error (${err.status}): ${msg}`);
}

/** Generates and edits images through the OpenAI Images API (needs OPENAI_API_KEY). */
export function createOpenAIProvider(opts: OpenAIOptions): Provider {
  let client = opts.client;
  const images = (): ImagesClient => {
    if (client) return client;
    if (!opts.apiKey) throw new OpenAIImageError("OPENAI_API_KEY is not set. Add it to the MCP server's environment.");
    client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 2 }).images;
    return client;
  };
  const { model } = opts;

  async function run(
    what: string,
    count: number,
    signal: AbortSignal,
    progress: ProgressFn,
    request: (c: ImagesClient) => Promise<OpenAI.ImagesResponse>,
  ): Promise<RawImage[]> {
    signal.throwIfAborted();
    const c = images();
    const started = Date.now();
    progress(`${what} ${count} image(s) with ${model}`);
    const timer = setInterval(() => progress(`Waiting for OpenAI (${Math.round((Date.now() - started) / 1000)}s)`), 10_000);
    let res: OpenAI.ImagesResponse;
    try {
      res = await request(c);
    } catch (err) {
      signal.throwIfAborted();
      throw describeError(err, model);
    } finally {
      clearInterval(timer);
    }
    const out = (res.data ?? []).filter((d) => d.b64_json);
    if (out.length === 0) throw new OpenAIImageError("OpenAI returned no images.");
    return out.map((d) => ({ data: Buffer.from(d.b64_json!, "base64"), mimeType: "image/png" as const, model }));
  }

  const common = (req: GenerateRequest) => ({
    model,
    n: req.count,
    size: apiSize(model, req.width, req.height),
    output_format: "png" as const,
    ...(req.transparent ? { background: "transparent" as const } : {}),
  });

  return {
    name: "openai-api",
    capabilities: { edit: true, references: true, transparent: true, mask: true, sizes: ["any"] },

    generate(req, signal, progress) {
      if (req.references.length === 0) {
        return run("Generating", req.count, signal, progress, (c) =>
          c.generate({ ...common(req), prompt: req.prompt }, { signal }),
        );
      }
      // The generations endpoint takes no images, so reference-guided generation uses edits.
      const prompt =
        `${req.prompt}\n\nThe attached image(s) are style references only: match their art style, ` +
        "palette and rendering, but create a new image of the subject described above.";
      return run("Generating", req.count, signal, progress, async (c) =>
        c.edit({ ...common(req), prompt, image: await Promise.all(req.references.map(upload)) }, { signal }),
      );
    },

    edit(req: EditRequest, signal, progress) {
      let prompt = req.prompt;
      if (req.references.length) {
        prompt += `\n\nThe first image is the one to edit. The other ${req.references.length} image(s) are supporting inputs for the change.`;
      }
      return run("Editing", req.count, signal, progress, async (c) =>
        c.edit(
          {
            ...common(req),
            prompt,
            image: await Promise.all([req.image, ...req.references].map(upload)),
            ...(req.mask ? { mask: await uploadMask(req.mask, req.image) } : {}),
          },
          { signal },
        ),
      );
    },
  };
}
