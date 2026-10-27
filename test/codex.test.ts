import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexPrompt, createCodexProvider } from "../src/providers/codex.js";
import type { GenerateRequest } from "../src/providers/types.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

let tmp: string;
let codexHome: string;
let src: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-codex-test-")));
  codexHome = path.join(tmp, "codex-home");
  await fs.mkdir(codexHome);
  src = path.join(tmp, "src.png");
  await sharp({ create: { width: 1254, height: 1254, channels: 3, background: "#36c" } }).png().toFile(src);
  await fs.chmod(FAKE, 0o755);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  prompt: "a blue star",
  width: 1024,
  height: 1024,
  count: 1,
  transparent: false,
  references: [],
  ...over,
});

const provider = (mode: string, bin = FAKE) =>
  createCodexProvider({ bin, codexHome, env: { FAKE_CODEX_MODE: mode, FAKE_CODEX_SRC: src } });

const lastCall = async () => JSON.parse(await fs.readFile(path.join(codexHome, "last-call.json"), "utf8"));

describe("codex-cli provider", () => {
  it("collects images from the session's generated_images folder", async () => {
    const messages: string[] = [];
    const images = await provider("ok").generate(req({ count: 2 }), new AbortController().signal, (m) => messages.push(m));
    expect(images).toHaveLength(2);
    expect((await sharp(images[0].data).metadata()).width).toBe(1254);
    expect(messages).toContain("Codex session started");
  });

  it("runs read-only in an empty temp folder and passes references with --image=", async () => {
    const ref = path.join(tmp, "ref one.png");
    await fs.copyFile(src, ref);
    await provider("ok").generate(req({ references: [ref] }), new AbortController().signal, () => {});
    const { args, cwd, prompt } = await lastCall();
    expect(args).toEqual(expect.arrayContaining(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", `--image=${ref}`]));
    expect(args.slice(-2)).toEqual(["--", "-"]);
    expect(cwd).toContain("imagegen-codex-");
    expect(prompt).toContain("a blue star");
    expect(prompt).toContain("style references");
    // The temp folder is removed afterwards.
    await expect(fs.access(cwd)).rejects.toThrow();
  });

  it("edits by attaching the target first, then supporting images", async () => {
    const target = path.join(tmp, "target.png");
    const insert = path.join(tmp, "hat.png");
    await fs.copyFile(src, target);
    await fs.copyFile(src, insert);
    const p = provider("ok");
    const images = await p.edit!({ ...req({ references: [insert] }), image: target, prompt: "put the hat on the dog" }, new AbortController().signal, () => {});
    expect(images).toHaveLength(1);
    const { args, prompt } = await lastCall();
    expect(args.filter((a: string) => a.startsWith("--image="))).toEqual([`--image=${target}`, `--image=${insert}`]);
    expect(prompt).toContain("Image 1 is the edit target");
    expect(prompt).toContain("Image 2 is a supporting input");
    expect(prompt).toContain("put the hat on the dog");
    expect(prompt).toContain("Keep everything else in Image 1 the same");
  });

  it("makes a set in one session and matches images to items in order", async () => {
    const setReq = { style: "flat icons", items: [{ name: "a", prompt: "apple" }, { name: "b", prompt: "boat" }], width: 512, height: 512, transparent: false, references: [] };
    const images = await provider("ok").generateSet!(setReq, new AbortController().signal, () => {});
    expect(images.map((i) => i.item)).toEqual([0, 1]);
    const { prompt } = await lastCall();
    expect(prompt).toContain("set of 2 images");
    expect(prompt).toContain("1. a: apple");
    expect(prompt).toContain("2. b: boat");
    expect(prompt).toContain("flat icons");
  });

  it("leaves set images unmatched when Codex makes fewer than asked", async () => {
    const setReq = { style: "s", items: [{ name: "a", prompt: "x" }, { name: "b", prompt: "y" }], width: 512, height: 512, transparent: false, references: [] };
    const p = createCodexProvider({ bin: FAKE, codexHome, env: { FAKE_CODEX_MODE: "ok", FAKE_CODEX_SRC: src, FAKE_CODEX_COUNT: "1" } });
    const images = await p.generateSet!(setReq, new AbortController().signal, () => {});
    expect(images).toHaveLength(1);
    expect(images[0].item).toBeUndefined();
  });

  it("reports Codex's message when no image was made", async () => {
    await expect(provider("none").generate(req(), new AbortController().signal, () => {})).rejects.toThrow(
      /without generating an image.*I can't help/,
    );
  });

  it("suggests codex login when not signed in", async () => {
    await expect(provider("login").generate(req(), new AbortController().signal, () => {})).rejects.toThrow(/codex login/);
  });

  it("explains a missing binary", async () => {
    await expect(
      provider("ok", path.join(tmp, "no-such-codex")).generate(req(), new AbortController().signal, () => {}),
    ).rejects.toThrow(/IMAGEGEN_CODEX_BIN/);
  });

  it("kills Codex when the request is cancelled", async () => {
    const ac = new AbortController();
    const run = provider("hang").generate(req(), ac.signal, () => {});
    const pidFile = path.join(codexHome, "pid");
    for (let i = 0; i < 100 && !(await fs.access(pidFile).then(() => true, () => false)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    ac.abort();
    await expect(run).rejects.toThrow();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });
});

describe("buildCodexPrompt", () => {
  it("describes count, shape and transparency", () => {
    const p = buildCodexPrompt(req({ count: 3, width: 1920, height: 1080, transparent: true }));
    expect(p).toContain("exactly 3 image(s)");
    expect(p).toContain("landscape");
    expect(p).toContain("transparent");
    expect(p).toContain("Do not run shell commands");
  });
});
