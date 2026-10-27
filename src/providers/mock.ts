import { createHash } from "node:crypto";
import sharp from "sharp";
import type { EditRequest, GenerateRequest, Provider, RawImage } from "./types.js";

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Splits text into lines of at most `max` characters, breaking on spaces. */
function wrap(text: string, max: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > max) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word.slice(0, max);
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, max - 1) + "…";
  }
  return lines;
}

/**
 * Deterministic placeholder images: a gradient keyed on the prompt, with the prompt as text. Edits
 * return the input resized to the requested size with the instruction written across the bottom.
 */
export function createMockProvider(): Provider {
  return {
    name: "mock",
    capabilities: { edit: true, references: false, transparent: true, mask: false, sizes: ["any"] },

    async generate(req: GenerateRequest, signal, progress): Promise<RawImage[]> {
      const images: RawImage[] = [];
      for (let i = 0; i < req.count; i++) {
        signal.throwIfAborted();
        progress(`Rendering placeholder ${i + 1}/${req.count}`);

        const hash = createHash("sha256").update(`${req.prompt}#${i}`).digest();
        const hue1 = hash[0] * 360 / 256;
        const hue2 = (hue1 + 60 + hash[1] / 4) % 360;
        const { width: w, height: h } = req;
        const fontSize = Math.max(12, Math.round(Math.min(w, h) / 14));
        const lines = wrap(req.prompt, Math.max(8, Math.floor(w / (fontSize * 0.6))), 4);
        const top = h / 2 - ((lines.length - 1) * fontSize * 1.25) / 2;
        const bg = req.transparent
          ? `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) * 0.45}" fill="url(#g)"/>`
          : `<rect width="100%" height="100%" fill="url(#g)"/>`;

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue1},70%,55%)"/>
    <stop offset="1" stop-color="hsl(${hue2},70%,35%)"/>
  </linearGradient></defs>
  ${bg}
  <g font-family="sans-serif" font-size="${fontSize}" fill="#fff" text-anchor="middle">
    ${lines.map((l, n) => `<text x="${w / 2}" y="${top + n * fontSize * 1.25}" dominant-baseline="middle">${escapeXml(l)}</text>`).join("\n    ")}
  </g>
  <text x="${w - 8}" y="${h - 8}" font-family="sans-serif" font-size="${Math.max(10, fontSize / 2)}" fill="#fff" fill-opacity="0.7" text-anchor="end">MOCK ${i + 1}</text>
</svg>`;

        const data = await sharp(Buffer.from(svg)).png().toBuffer();
        images.push({ data, mimeType: "image/png", model: "mock-1" });
      }
      return images;
    },

    async edit(req: EditRequest, signal, progress): Promise<RawImage[]> {
      const { width: w, height: h } = req;
      const base = await sharp(req.image).resize(w, h, { fit: "cover" }).png().toBuffer();
      const images: RawImage[] = [];
      for (let i = 0; i < req.count; i++) {
        signal.throwIfAborted();
        progress(`Editing placeholder ${i + 1}/${req.count}`);
        const band = Math.max(24, Math.round(h / 6));
        const fontSize = Math.max(10, Math.round(band / 3));
        const [line] = wrap(`EDIT ${i + 1}: ${req.prompt}`, Math.max(8, Math.floor(w / (fontSize * 0.6))), 1);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect x="0" y="${h - band}" width="${w}" height="${band}" fill="#000" fill-opacity="0.6"/>
  <text x="${w / 2}" y="${h - band / 2}" font-family="sans-serif" font-size="${fontSize}" fill="#fff" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>
</svg>`;
        const data = await sharp(base).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
        images.push({ data, mimeType: "image/png", model: "mock-1" });
      }
      return images;
    },
  };
}
