import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APIError } from "openai";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiSize, createOpenAIProvider, type ImagesClient } from "../src/providers/openai.js";
import type { GenerateRequest } from "../src/providers/types.js";

let tmp: string;
let png: Buffer;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-openai-test-")));
  png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#09c" } }).png().toBuffer();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  prompt: "a fox",
  width: 1024,
  height: 1024,
  count: 1,
  transparent: false,
  references: [],
  ...over,
});

type Call = { endpoint: "generate" | "edit"; params: Record<string, any>; options: Record<string, any> };

function fakeClient(result: () => unknown = () => ({ data: [{ b64_json: png.toString("base64") }] })) {
  const calls: Call[] = [];
  const handler = (endpoint: Call["endpoint"]) => async (params: any, options: any) => {
    calls.push({ endpoint, params, options });
    const r = result();
    if (r instanceof Error) throw r;
    return r;
  };
  const client = { generate: handler("generate"), edit: handler("edit") } as unknown as ImagesClient;
  return { client, calls };
}

const signal = () => new AbortController().signal;

describe("apiSize", () => {
  const parse = (s: string) => s.split("x").map(Number) as [number, number];
  const valid = (s: string) => {
    const [w, h] = parse(s);
    return w % 16 === 0 && h % 16 === 0 && w * h >= 655_360 && w * h <= 3840 * 2160 && Math.max(w, h) <= 3840 && Math.min(w, h) <= 2160 && Math.max(w / h, h / w) <= 3;
  };

  it.each([
    [1024, 1024],
    [512, 512],
    [1920, 1080],
    [1080, 1920],
    [4096, 4096],
    [4000, 100],
    [100, 4000],
    [16, 16],
    [1254, 941],
    [3840, 2160],
  ])("gives a valid size close to the aspect ratio for %ix%i", (w, h) => {
    const s = apiSize("gpt-image-2.5-sunburst", w, h);
    expect(valid(s), s).toBe(true);
    const [aw, ah] = parse(s);
    const want = Math.min(3, Math.max(1 / 3, w / h));
    expect(Math.abs(aw / ah - want) / want).toBeLessThan(0.05);
  });

  it("keeps sizes that are already valid", () => {
    expect(apiSize("gpt-image-2", 1024, 1024)).toBe("1024x1024");
    expect(apiSize("gpt-image-2", 1920, 1088)).toBe("1920x1088");
  });

  it("uses the nearest fixed size for older models", () => {
    expect(apiSize("gpt-image-1.5", 1920, 1080)).toBe("1536x1024");
    expect(apiSize("gpt-image-1.5", 500, 900)).toBe("1024x1536");
    expect(apiSize("gpt-image-1-mini", 300, 290)).toBe("1024x1024");
  });
});

describe("openai-api provider", () => {
  it("calls the generations endpoint with model, n, size and png output", async () => {
    const { client, calls } = fakeClient();
    const images = await createOpenAIProvider({ model: "gpt-image-2.5-sunburst", client }).generate(req({ count: 2, width: 1920, height: 1080 }), signal(), () => {});
    expect(images[0].data).toEqual(png);
    expect(images[0].model).toBe("gpt-image-2.5-sunburst");
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe("generate");
    expect(calls[0].params).toMatchObject({ model: "gpt-image-2.5-sunburst", prompt: "a fox", n: 2, size: "1920x1088", output_format: "png" });
    expect(calls[0].params.background).toBeUndefined();
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for a transparent background when wanted", async () => {
    const { client, calls } = fakeClient();
    await createOpenAIProvider({ model: "m", client }).generate(req({ transparent: true }), signal(), () => {});
    expect(calls[0].params.background).toBe("transparent");
  });

  it("routes generation with references through the edits endpoint", async () => {
    const ref = path.join(tmp, "style.webp");
    await sharp(png).webp().toFile(ref);
    const { client, calls } = fakeClient();
    await createOpenAIProvider({ model: "gpt-image-2", client }).generate(req({ references: [ref] }), signal(), () => {});
    expect(calls[0].endpoint).toBe("edit");
    expect(calls[0].params.prompt).toContain("style references");
    expect(calls[0].params.image).toHaveLength(1);
    expect(calls[0].params.image[0].name).toBe("style.webp");
    expect(calls[0].params.image[0].type).toBe("image/webp");
  });

  it("edits with the target first, converts unsupported formats, and fits the mask to the image", async () => {
    const target = path.join(tmp, "photo.png");
    const insert = path.join(tmp, "hat.gif");
    const mask = path.join(tmp, "mask.png");
    await fs.writeFile(target, png);
    await sharp(png).gif().toFile(insert);
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toFile(mask);

    const { client, calls } = fakeClient();
    const provider = createOpenAIProvider({ model: "gpt-image-2", client });
    await provider.edit!({ ...req({ references: [insert] }), image: target, mask, prompt: "add the hat" }, signal(), () => {});

    const { params } = calls[0];
    expect(calls[0].endpoint).toBe("edit");
    expect(params.image.map((f: File) => f.name)).toEqual(["photo.png", "hat.png"]);
    expect(params.image[1].type).toBe("image/png");
    expect(params.prompt).toContain("add the hat");
    expect(params.prompt).toContain("first image is the one to edit");
    const maskMeta = await sharp(Buffer.from(await params.mask.arrayBuffer())).metadata();
    expect([maskMeta.width, maskMeta.height, maskMeta.hasAlpha]).toEqual([64, 48, true]);
  });

  it("explains a missing API key without calling anything", async () => {
    await expect(createOpenAIProvider({ model: "m" }).generate(req(), signal(), () => {})).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });

  it.each([
    [401, { message: "Incorrect API key" }, /OPENAI_API_KEY was rejected/],
    [404, { message: "model not found" }, /IMAGEGEN_OPENAI_MODEL/],
    [429, { message: "Rate limit reached for requests" }, /Rate limit reached/],
    [429, { message: "You have no credits remaining.", code: "insufficient_quota" }, /no credits left/],
    [400, { message: "Your request was rejected by the safety system", code: "moderation_blocked" }, /content policy/],
    [400, { message: "Invalid size" }, /OpenAI API error \(400\).*Invalid size/],
  ])("turns HTTP %i into a clear message", async (status, body, message) => {
    const { client } = fakeClient(() => APIError.generate(status, { error: body }, undefined, new Headers()));
    await expect(createOpenAIProvider({ model: "m", client }).generate(req(), signal(), () => {})).rejects.toThrow(message);
  });

  it("fails clearly when the API returns no images", async () => {
    const { client } = fakeClient(() => ({ data: [] }));
    await expect(createOpenAIProvider({ model: "m", client }).generate(req(), signal(), () => {})).rejects.toThrow(/no images/);
  });
});
