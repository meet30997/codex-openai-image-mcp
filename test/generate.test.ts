import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

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
  client.callTool({ name: "generate_image", arguments: args }) as Promise<CallToolResult>;

describe("generate_image (mock provider)", () => {
  it("is listed", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("generate_image");
  });

  it("saves a PNG and sidecar and returns a downscaled preview", async () => {
    const res = await call({ prompt: "A red rocket icon", size: "1024x768", out_name: "icons/rocket" });
    expect(res.isError).toBeFalsy();

    const png = path.join(tmp, "generated-images", "icons", "rocket.png");
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 768]);

    const sidecar = JSON.parse(await fs.readFile(png.replace(/\.png$/, ".json"), "utf8"));
    expect(sidecar).toMatchObject({ prompt: "A red rocket icon", provider: "mock", width: 1024, height: 768 });

    const [text, image] = res.content;
    expect(text).toMatchObject({ type: "text" });
    expect((text as { text: string }).text).toContain(png);
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    const preview = await sharp(Buffer.from((image as { data: string }).data, "base64")).metadata();
    expect([preview.width, preview.height]).toEqual([512, 384]);
  });

  it("never overwrites and numbers variants", async () => {
    await call({ prompt: "badge", out_name: "badge" });
    await call({ prompt: "badge", out_name: "badge", count: 2 });
    const files = (await fs.readdir(path.join(tmp, "generated-images"))).sort();
    expect(files).toEqual(["badge-v1.json", "badge-v1.png", "badge-v2.json", "badge-v2.png", "badge.json", "badge.png"]);

    await call({ prompt: "badge", out_name: "badge" });
    expect(await fs.readdir(path.join(tmp, "generated-images"))).toContain("badge-2.png");
  });

  it("defaults the file name to a slug of the prompt", async () => {
    await call({ prompt: "Gold Trophy, shiny!" });
    expect(await fs.readdir(path.join(tmp, "generated-images"))).toContain("gold-trophy-shiny.png");
  });

  it("returns a tool error for paths outside the output folder", async () => {
    const res = await call({ prompt: "x", out_name: "../escape" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not allowed/);
    await expect(fs.access(path.join(tmp, "escape.png"))).rejects.toThrow();
  });

  it("returns a tool error for a bad size", async () => {
    const res = await call({ prompt: "x", size: "huge" });
    expect(res.isError).toBe(true);
  });
});
