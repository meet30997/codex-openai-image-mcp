import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { EditRequest, GenerateRequest, ProgressFn, Provider, RawImage, SetRequest } from "./types.js";

export interface CodexOptions {
  bin: string;
  /** Where Codex keeps its state; built-in image_gen saves to `<codexHome>/generated_images/<thread>/`. */
  codexHome: string;
  /** Extra environment for the child process (tests use this). */
  env?: NodeJS.ProcessEnv;
}

export class CodexError extends Error {
  name = "CodexError";
}

function describeShape(width: number, height: number): string {
  if (width === height) return "square (1:1)";
  const ratio = width / height;
  return `${ratio > 1 ? "landscape" : "portrait"}, aspect ratio about ${width}:${height}`;
}

export function buildCodexPrompt(req: GenerateRequest): string {
  const lines = [
    `Use your built-in image_gen tool to generate exactly ${req.count} image(s), one image_gen call per image.`,
    "",
    "Image description:",
    req.prompt,
    "",
    `Shape: ${describeShape(req.width, req.height)}. Final size will be ${req.width}x${req.height} px.`,
  ];
  if (req.transparent) lines.push("Background: fully transparent (keep the alpha channel), no backdrop or shadow plate.");
  if (req.references.length) {
    lines.push(`The ${req.references.length} attached image(s) are style references: match their art style, palette and rendering, but draw the new subject described above.`);
  }
  if (req.count > 1) lines.push("Make the variants meaningfully different from each other while following the description.");
  lines.push(...RULES);
  return lines.join("\n");
}

export function buildCodexSetPrompt(req: SetRequest): string {
  const n = req.items.length;
  const lines = [
    `Use your built-in image_gen tool to make a set of ${n} images that clearly belong together. Make exactly one image_gen call per item, in the order listed.`,
    "",
    "Shared style for every image in the set:",
    req.style,
    "",
    "Items:",
    ...req.items.map((it, i) => `${i + 1}. ${it.name}: ${it.prompt}`),
    "",
    "Keep the art style, palette, rendering, lighting, line weight and framing consistent across all images, so they look like one set; only the subject changes.",
    `Shape: ${describeShape(req.width, req.height)}. Final size will be ${req.width}x${req.height} px.`,
  ];
  if (req.transparent) lines.push("Background: fully transparent (keep the alpha channel), no backdrop or shadow plate.");
  if (req.references.length) {
    lines.push(`The ${req.references.length} attached image(s) are style references for the whole set: match their style, but draw the subjects listed above.`);
  }
  lines.push(...RULES);
  return lines.join("\n");
}

const RULES = [
  "",
  "Rules:",
  "- Do not run shell commands, read or write files, or load skills. Only call image_gen.",
  "- Leave the images where image_gen saves them; do not copy or move them.",
  "- When done, reply with one short line. If you cannot make an image, say why.",
];

export function buildCodexEditPrompt(req: EditRequest): string {
  const lines = [
    `Use your built-in image_gen tool to edit the attached image. Make exactly ${req.count} edited version(s), one image_gen call per version.`,
    "",
    "Image 1 is the edit target.",
  ];
  req.references.forEach((_, i) => {
    lines.push(`Image ${i + 2} is a supporting input: use it as the change below describes (an object to insert, or a style to apply).`);
  });
  lines.push(
    "",
    "Change to make:",
    req.prompt,
    "",
    "Keep everything else in Image 1 the same: subject, identity, pose, composition, framing, colours, lighting, text and style, unless the change requires otherwise.",
    `Shape: ${describeShape(req.width, req.height)}. Final size will be ${req.width}x${req.height} px.`,
  );
  if (req.transparent) lines.push("Background: fully transparent (keep the alpha channel), no backdrop or shadow plate.");
  if (req.count > 1) lines.push("Make the versions meaningfully different interpretations of the change.");
  lines.push(...RULES);
  return lines.join("\n");
}

const PNG = /\.png$/i;

async function listImages(dir: string): Promise<string[]> {
  try {
    const names = (await fs.readdir(dir)).filter((n) => PNG.test(n));
    const withTime = await Promise.all(
      names.map(async (n) => ({ p: path.join(dir, n), t: (await fs.stat(path.join(dir, n))).mtimeMs })),
    );
    return withTime.sort((a, b) => a.t - b.t).map((x) => x.p);
  } catch {
    return [];
  }
}

function truncate(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function hintFor(stderr: string): string {
  if (/not logged in|login|unauthori[sz]ed|401/i.test(stderr)) return "Codex is not signed in: run `codex login`.";
  if (/usage limit|rate limit|quota|429/i.test(stderr)) return "Codex usage limit reached; try again later.";
  return "";
}

/**
 * Generates images by running `codex exec` with its built-in image_gen tool. Codex runs in an empty
 * temporary folder with a read-only sandbox; the server picks the images up from Codex's own
 * generated_images folder for the session.
 */
export function createCodexProvider(opts: CodexOptions): Provider {
  return {
    name: "codex-cli",
    capabilities: { edit: true, references: true, transparent: true, mask: false, sizes: ["any"] },

    generate(req, signal, progress) {
      return runCodex(opts, { prompt: buildCodexPrompt(req), images: req.references, count: req.count }, signal, progress);
    },

    async generateSet(req, signal, progress) {
      const job = { prompt: buildCodexSetPrompt(req), images: req.references, count: req.items.length };
      const images = await runCodex(opts, job, signal, progress);
      // Images come back in creation order; that only matches the items if none were skipped.
      return images.length === req.items.length ? images.map((img, i) => ({ ...img, item: i })) : images;
    },

    edit(req, signal, progress) {
      const job = { prompt: buildCodexEditPrompt(req), images: [req.image, ...req.references], count: req.count };
      return runCodex(opts, job, signal, progress);
    },
  };
}

interface CodexJob {
  prompt: string;
  /** Attached with --image, in order; prompts refer to them as Image 1, Image 2, … */
  images: string[];
  count: number;
}

async function runCodex(opts: CodexOptions, job: CodexJob, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]> {
  signal.throwIfAborted();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagegen-codex-"));
  try {
    return await runCodexIn(workDir, opts, job, signal, progress);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function runCodexIn(
  workDir: string,
  opts: CodexOptions,
  req: CodexJob,
  signal: AbortSignal,
  progress: ProgressFn,
): Promise<RawImage[]> {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--cd", workDir,
    // --image takes several values, so use the = form and end options with -- before the stdin marker.
    ...req.images.map((r) => `--image=${r}`),
    "--",
    "-",
  ];

  const child = spawn(opts.bin, args, {
    cwd: workDir,
    env: { ...process.env, ...opts.env, CODEX_HOME: opts.codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 3000).unref();
  };
  signal.addEventListener("abort", kill, { once: true });

  let threadId: string | undefined;
  let lastMessage = "";
  let stderr = "";
  let found = 0;
  const started = Date.now();

  const imagesDir = () => (threadId ? path.join(opts.codexHome, "generated_images", threadId) : undefined);

  // Codex emits no event for image_gen itself, so watch the session folder and send a heartbeat.
  const timer = setInterval(async () => {
    const dir = imagesDir();
    const n = dir ? (await listImages(dir)).length : 0;
    if (n > found) {
      found = n;
      progress(`Image ${Math.min(n, req.count)}/${req.count} ready`);
    } else {
      progress(`Codex is working (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  }, 10_000);

  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code) => resolve({ code }));
  });

  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8000);
  });

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "thread.started" && ev.thread_id) {
      threadId = ev.thread_id;
      progress("Codex session started");
    } else if (ev.type === "turn.started") {
      progress(`Generating ${req.count} image(s) with Codex (usually under a minute each)`);
    } else if (ev.item?.type === "agent_message" && ev.item.text) {
      lastMessage = ev.item.text;
      progress(`Codex: ${truncate(ev.item.text)}`);
    }
  });

  child.stdin.on("error", () => {}); // the process may exit before reading stdin
  child.stdin.end(req.prompt);

  let result;
  try {
    result = await exit;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", kill);
  }
  signal.throwIfAborted();

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexError(`Codex CLI not found ("${opts.bin}"). Install it or set IMAGEGEN_CODEX_BIN.`);
    }
    throw result.error;
  }

  const dir = imagesDir();
  const files = dir ? (await listImages(dir)).slice(0, req.count) : [];
  if (files.length === 0) {
    const hint = hintFor(stderr);
    const detail = lastMessage ? `Codex said: ${truncate(lastMessage, 400)}` : stderr ? `Codex stderr: ${truncate(stderr.slice(-400), 400)}` : "";
    throw new CodexError(
      [`Codex finished (exit code ${result.code}) without generating an image.`, hint, detail].filter(Boolean).join(" "),
    );
  }

  return Promise.all(
    files.map(async (f) => ({ data: await fs.readFile(f), mimeType: "image/png" as const, model: "codex-image_gen" })),
  );
}
