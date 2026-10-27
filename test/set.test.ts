import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { GenerateRequest, Provider } from "../src/providers/types.js";
import { createServer } from "../src/server.js";
import { generateSetOneByOne } from "../src/tools/set.js";

let tmp: string;
let client: Client;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-test-")));
  const config = loadConfig({ IMAGEGEN_PROVIDER: "mock" }, tmp);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) =>
  client.callTool({ name: "generate_set", arguments: args }) as Promise<CallToolResult>;
const text = (res: CallToolResult) => (res.content[0] as { text: string }).text;
const out = (...p: string[]) => path.join(tmp, "generated-images", ...p);

const items = [
  { name: "Fire", prompt: "a flame" },
  { name: "Water Drop", prompt: "a water drop" },
  { name: "leaf", prompt: "a green leaf" },
];

describe("generate_set (mock provider)", () => {
  it("saves one file per item, named after the item, with a preview each", async () => {
    const res = await call({ style: "flat sticker, thick white outline", items, size: "512x512", folder: "elements" });
    expect(res.isError).toBeFalsy();
    expect((await fs.readdir(out("elements"))).filter((f) => f.endsWith(".png")).sort()).toEqual([
      "fire.png",
      "leaf.png",
      "water-drop.png",
    ]);
    expect(res.content.filter((c) => c.type === "image")).toHaveLength(3);
    expect(text(res)).toMatch(/^Generated 3 image/);

    const sidecar = JSON.parse(await fs.readFile(out("elements", "water-drop.json"), "utf8"));
    expect(sidecar).toMatchObject({ item: "Water Drop", style: "flat sticker, thick white outline", width: 512 });
    expect(sidecar.prompt).toContain("a water drop");
    expect(sidecar.prompt).toContain("flat sticker");
  });

  it("defaults the folder to a slug of the style", async () => {
    await call({ style: "Pixel Art, 16 colours", items: items.slice(0, 1) });
    expect(await fs.readdir(out("pixel-art-16-colours"))).toContain("fire.png");
  });

  it.each([
    ["duplicate file names", { items: [{ name: "Fire", prompt: "a" }, { name: "fire!", prompt: "b" }] }, /repeated: fire/],
    ["a folder outside the output folder", { items, folder: "../x" }, /not allowed/],
    ["references on a provider without them", { items, references: ["a.png"] }, /does not support reference/],
  ])("rejects %s", async (_, args, message) => {
    const res = await call({ style: "s", ...args });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(message);
  });

  it("rejects more items than IMAGEGEN_MAX_PER_CALL", async () => {
    const config = loadConfig({ IMAGEGEN_MAX_PER_CALL: "2" }, tmp);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(config).connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    const res = (await c.callTool({ name: "generate_set", arguments: { style: "s", items } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/over the limit of 2/);
    await c.close();
  });
});

describe("generateSetOneByOne", () => {
  it("passes the first image as an extra reference for the rest, then cleans it up", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    const calls: GenerateRequest[] = [];
    const seen: boolean[] = [];
    const provider: Provider = {
      name: "fake",
      capabilities: { edit: false, references: true, transparent: false, mask: false, sizes: ["any"] },
      async generate(req) {
        calls.push(req);
        for (const r of req.references) seen.push(await fs.access(r).then(() => true, () => false));
        return [{ data: png, mimeType: "image/png", model: "fake" }];
      },
    };
    const images = await generateSetOneByOne(
      provider,
      { style: "ink", items, width: 8, height: 8, transparent: false, references: ["/refs/style.png"] },
      new AbortController().signal,
      () => {},
    );

    expect(images.map((i) => i.item)).toEqual([0, 1, 2]);
    expect(calls[0].references).toEqual(["/refs/style.png"]);
    expect(calls[1].references).toHaveLength(2);
    expect(calls[1].references[1]).toMatch(/first-item\.png$/);
    expect(calls[2].prompt).toContain("a green leaf");
    expect(calls[2].prompt).toContain("ink");
    await expect(fs.access(calls[1].references[1])).rejects.toThrow();
  });
});
