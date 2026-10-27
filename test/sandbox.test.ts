import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInSandbox, SandboxError, slugify, uniqueStem } from "../src/files/sandbox.js";

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-test-")));
  root = path.join(tmp, "out");
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveInSandbox", () => {
  it("resolves plain and nested names inside the root", async () => {
    expect(await resolveInSandbox(root, "icon")).toBe(path.join(root, "icon"));
    expect(await resolveInSandbox(root, "badges/gold")).toBe(path.join(root, "badges", "gold"));
  });

  it("works when the root does not exist yet", async () => {
    const fresh = path.join(tmp, "not-yet");
    expect(await resolveInSandbox(fresh, "a/b")).toBe(path.join(fresh, "a", "b"));
  });

  it.each(["../escape", "a/../../escape", "a/..", "..", "a\\..\\..\\escape"])("rejects .. in %s", async (name) => {
    await expect(resolveInSandbox(root, name)).rejects.toThrow(SandboxError);
  });

  it.each(["/etc/passwd", "C:\\Windows\\x", "\\\\server\\share\\x"])("rejects absolute path %s", async (name) => {
    await expect(resolveInSandbox(root, name)).rejects.toThrow(SandboxError);
  });

  it.each(["", "   ", ".", "./", "a\0b"])("rejects empty or invalid name %j", async (name) => {
    await expect(resolveInSandbox(root, name)).rejects.toThrow(SandboxError);
  });

  it("allows names that merely start with dots", async () => {
    expect(await resolveInSandbox(root, "..hidden")).toBe(path.join(root, "..hidden"));
  });

  it("rejects a symlinked directory that points outside", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "link"));
    await expect(resolveInSandbox(root, "link/file")).rejects.toThrow(/symlink/);
  });

  it("rejects a symlinked file that points outside", async () => {
    await fs.writeFile(path.join(tmp, "secret.png"), "x");
    await fs.symlink(path.join(tmp, "secret.png"), path.join(root, "evil.png"));
    await expect(resolveInSandbox(root, "evil.png")).rejects.toThrow(/symlink/);
  });

  it("allows a symlink that stays inside the root", async () => {
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "alias"));
    expect(await resolveInSandbox(root, "alias/file")).toBe(path.join(root, "alias", "file"));
  });

  it("allows the root itself to be a symlink", async () => {
    const linkedRoot = path.join(tmp, "linked-root");
    await fs.symlink(root, linkedRoot);
    expect(await resolveInSandbox(linkedRoot, "x")).toBe(path.join(linkedRoot, "x"));
  });
});

describe("uniqueStem", () => {
  it("adds -2, -3 when the image or its sidecar exists", async () => {
    const base = path.join(root, "icon");
    expect(await uniqueStem(base, [".png", ".json"])).toBe(base);
    await fs.writeFile(`${base}.png`, "");
    expect(await uniqueStem(base, [".png", ".json"])).toBe(`${base}-2`);
    await fs.writeFile(`${base}-2.json`, "");
    expect(await uniqueStem(base, [".png", ".json"])).toBe(`${base}-3`);
  });
});

describe("slugify", () => {
  it("makes safe file names", () => {
    expect(slugify("A Rocket Ship, neon style!")).toBe("a-rocket-ship-neon-style");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("🚀🚀")).toBe("image");
    expect(slugify("word ".repeat(20)).length).toBeLessThanOrEqual(40);
  });
});
