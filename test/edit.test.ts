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
let original: Buffer;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-test-")));
  original = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c33" } }).png().toBuffer();
  await fs.mkdir(path.join(tmp, "photos"));
  await fs.writeFile(path.join(tmp, "photos", "Beach Day.png"), original);

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
  client.callTool({ name: "edit_image", arguments: args }) as Promise<CallToolResult>;

const out = (...p: string[]) => path.join(tmp, "generated-images", ...p);

describe("edit_image (mock provider)", () => {
  it("is listed", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("edit_image");
  });

  it("keeps the input size by default, names the copy after the input and leaves the original alone", async () => {
    const res = await call({ image: "photos/Beach Day.png", prompt: "make the sky a sunset" });
    expect(res.isError).toBeFalsy();

    const meta = await sharp(out("beach-day-edited.png")).metadata();
    expect([meta.width, meta.height]).toEqual([800, 600]);
    expect(await fs.readFile(path.join(tmp, "photos", "Beach Day.png"))).toEqual(original);

    const sidecar = JSON.parse(await fs.readFile(out("beach-day-edited.json"), "utf8"));
    expect(sidecar).toMatchObject({ prompt: "make the sky a sunset", source: "photos/Beach Day.png", provider: "mock" });
    expect((res.content[0] as { text: string }).text).toMatch(/^Edited 1 image/);
    expect(res.content[1]).toMatchObject({ type: "image" });
  });

  it("accepts an absolute path inside the working folder, a size, variants and out_name", async () => {
    await call({ image: path.join(tmp, "photos", "Beach Day.png"), prompt: "watercolour", size: "512x512", count: 2, out_name: "art/beach" });
    for (const v of ["v1", "v2"]) {
      const meta = await sharp(out("art", `beach-${v}.png`)).metadata();
      expect([meta.width, meta.height]).toEqual([512, 512]);
    }
  });

  it.each([
    ["missing", "photos/nope.png", /not found/],
    ["not an image", "notes.txt", /not an image/],
  ])("rejects an input that is %s", async (_, image, message) => {
    await fs.writeFile(path.join(tmp, "notes.txt"), "hello");
    const res = await call({ image, prompt: "x" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(message);
  });

  it("rejects an input outside the working folder", async () => {
    const outside = `${tmp}-outside.png`;
    await fs.writeFile(outside, original);
    try {
      for (const image of [outside, `../${path.basename(outside)}`]) {
        const res = await call({ image, prompt: "x" });
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toMatch(/outside the allowed folder/);
      }
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("rejects references on a provider without reference support", async () => {
    const res = await call({ image: "photos/Beach Day.png", prompt: "x", references: ["photos/Beach Day.png"] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/does not support reference images/);
  });
});
