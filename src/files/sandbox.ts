import fs from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  name = "SandboxError";
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolves symlinks for the deepest part of `p` that exists; the rest is appended unchanged. */
async function realpathOfExisting(p: string): Promise<string> {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) return p;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turns a user-supplied relative name (e.g. "badges/gold") into an absolute path inside `root`.
 * Rejects absolute paths, `..` segments and anything that a symlink would take outside `root`.
 */
export async function resolveInSandbox(root: string, name: string): Promise<string> {
  if (name.trim() === "") throw new SandboxError("File name is empty");
  if (name.includes("\0")) throw new SandboxError("File name contains a NUL byte");
  if (path.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new SandboxError(`Absolute paths are not allowed: "${name}". Use a name relative to the output folder.`);
  }
  if (name.split(/[\\/]+/).includes("..")) {
    throw new SandboxError(`".." is not allowed in file names: "${name}"`);
  }

  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, name);
  if (!isInside(absRoot, target) || target === absRoot) {
    throw new SandboxError(`"${name}" is outside the output folder`);
  }

  const realRoot = await realpathOfExisting(absRoot);
  const realTarget = await realpathOfExisting(target);
  if (!isInside(realRoot, realTarget)) {
    throw new SandboxError(`"${name}" resolves through a symlink to outside the output folder`);
  }
  return target;
}

/**
 * Resolves an existing file the user wants read (a reference or edit image). The path may be
 * absolute or relative to `root`, but after following symlinks it must be a regular file inside
 * `root`.
 */
export async function resolveReadable(root: string, p: string): Promise<string> {
  if (p.trim() === "" || p.includes("\0")) throw new SandboxError(`Invalid path: "${p}"`);
  const target = path.resolve(root, p);
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new SandboxError(`File not found: "${p}"`);
  }
  if (!isInside(await realpathOfExisting(path.resolve(root)), real)) {
    throw new SandboxError(`"${p}" is outside the allowed folder (${root}). Set IMAGEGEN_READ_ROOT to allow more.`);
  }
  if (!(await fs.stat(real)).isFile()) throw new SandboxError(`"${p}" is not a file`);
  return real;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns `<base><ext>` or the first free `<base>-2<ext>`, `<base>-3<ext>`, … for which none of
 * `exts` exist yet, so an image and its sidecar always share a stem.
 */
export async function uniqueStem(base: string, exts: string[]): Promise<string> {
  for (let n = 1; ; n++) {
    const stem = n === 1 ? base : `${base}-${n}`;
    const taken = await Promise.all(exts.map((ext) => exists(stem + ext)));
    if (!taken.some(Boolean)) return stem;
  }
}

/** Builds a file-name-safe slug from free text such as a prompt. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return slug || "image";
}
