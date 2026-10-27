# Image MCP — project plan

An MCP server that lets Claude (Claude Code, Claude Desktop or any MCP client) generate and edit
any image a user asks for: "draw a watercolour fox for my blog header", "make this photo look like
a sunset", "give me 3 logo ideas for a coffee shop", "remove the background from this product
shot". Claude calls one tool, sees a preview of the result, and iterates.

It is a **general-purpose** image tool, not tied to any platform, game engine or asset store. It
started from hand-driving the Codex CLI's image generator for a game launch, which showed how much
of that work (prompt files, waiting blind, finding the output, resizing) a tool can take over.

Name: `codex-openai-image-mcp` (npm). Open source under the MIT licence. Not affiliated with
OpenAI.

---

## 1. Why build it

Doing it by hand with the Codex CLI meant:

- Writing a prompt file, then running `codex exec … -i <ref.png> - < prompt.md`.
- Waiting with no progress shown, then finding where the files landed.
- Resizing the outputs to the size actually needed and keeping track of versions.
- Repeating that for every image while keeping one style across a set.

With an MCP server Claude does all of it in one tool call, shows the result, and can refine it.
Other people get the same thing from one install command.

**Similar projects** (checked 2026-10-27):

- [`codex-imagegen-mcp`](https://github.com/ShalomObongo/codex-imagegen-mcp) (Apache-2.0): Codex
  image generation on a ChatGPT plan, generate and edit, transparency, aspect ratios, local
  background removal, an installer for 25+ clients, and Codex's own prompting skill. The closest
  match and more polished on setup.
- `codex-imagegen`: Codex `image_gen` bridge.
- `imagegen-mcp`: OpenAI Images API only.

**What makes this one worth using:**

1. **No API key needed:** a Codex CLI backend that uses an existing ChatGPT/Codex sign-in, next to
   a normal API-key backend.
2. **Built for an agent loop:** previews Claude can see, progress during slow runs, cancellation,
   sidecar metadata so any result can be reproduced or varied, never overwriting files.
3. **Consistency:** reference images and matching sets, so a series of images shares one style.

---

## 2. Scope

### In scope (v1)

- Generate images from a prompt, any size, optionally with style reference images. **Done.**
- Edit an existing image with an instruction (change, remove, restyle, cut out). **Done.**
- Sets: several related images in one call, sharing a style. **Done.**
- More than one backend, chosen by config.
- Return saved file paths **and** a small preview, so Claude can look at the result. **Done.**

### Out of scope (v1)

- Hosting, a web UI, accounts or billing.
- Video, 3D models or audio.
- Uploading or publishing anywhere. The tool only writes local files.

---

## 3. Architecture

```
Claude ──MCP (stdio)──▶ codex-openai-image-mcp
                          ├─ tools/        generate_image, edit_image, generate_set (+ shared run/save loop)
                          ├─ providers/    interface + backends
                          │    ├─ codex-cli    (shells out to `codex exec`, uses the Codex sign-in)   done
                          │    ├─ mock         (placeholder images, for tests and demos)               done
                          │    └─ openai-api   (Images API, needs OPENAI_API_KEY)                      done
                          └─ files/        output sandbox, read sandbox, naming, sidecars, previews
```

**Stack:** TypeScript, `@modelcontextprotocol/sdk`, stdio transport, `sharp` for image work, `zod`
for input schemas, `vitest` for tests. Publish to npm so it runs with `npx`.

**Provider interface:** every backend implements the same small contract, so adding Gemini,
Stability or a local model later is one file:

```ts
interface Provider {
  name: string;
  capabilities: { edit: boolean; references: boolean; transparent: boolean; sizes: string[] };
  generate(req: GenerateRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
  edit?(req: EditRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
  generateSet?(req: SetRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
}
```

A provider without `generateSet` still supports sets: the tool makes the items one by one and,
when the provider takes references, passes the first image as an extra style reference.

Backends return images at their native size; the tool layer crops to fill and resizes to the size
asked for, and notes it in the result (and notes a missing alpha channel when transparency was
asked for).

### Backend notes

| Backend | Pros | Cons |
| --- | --- | --- |
| **Codex CLI** (done) | Uses an existing Codex/ChatGPT sign-in, no API key, supports references and edits | ~30–60 s per image, needs Codex installed and signed in, CLI flags may change between versions |
| **OpenAI Images API** (done) | Predictable, returns bytes directly, masks for edits, works for anyone with a key | Needs an API key; paid per image |
| **Mock** (done) | Free, instant, deterministic | Not real images |

### How the Codex backend works (verified with codex-cli 0.164.0)

- Runs `codex exec --json --skip-git-repo-check --sandbox read-only --cd <empty temp dir>
  [--image=<file>…] -- -` with the prompt on stdin.
- `--image` takes several values, so the `=` form plus `--` keeps it from swallowing the `-`
  stdin marker.
- Codex's built-in `image_gen` tool always saves to `$CODEX_HOME/generated_images/<thread id>/`.
  The server reads the thread id from the `thread.started` JSON event and collects the PNGs from
  there, so Codex never needs write access and is told not to run commands or touch files.
  (An early trial that asked Codex to copy the file itself was slower and fragile: the user's
  global `AGENTS.md` sent it down a wrong path first.)
- There is no JSON event for `image_gen` itself, so progress comes from Codex's own messages plus a
  heartbeat every 10 s that also reports images as they appear.
- Edits attach the target as Image 1 and any supporting images after it; the prompt says which is
  which and what must stay unchanged. No masks: the built-in tool doesn't take them.
- Sets run in one session (one `image_gen` call per item, in order). Images are matched to items
  by creation order only when the count matches; otherwise they are saved as `unmatched-N`.
- Cancel or timeout kills the whole process group.
- Output sizes are Codex's choice (seen: 1254×1254, 1672×941); the server resizes.

### How the OpenAI backend works (openai SDK 7.45.1, checked 2026-10-27)

- Default model `gpt-image-2.5-sunburst` (quality and editing); `gpt-image-2.5-flare` is the faster
  option, same price. `gpt-image-1` was shut down on 2026-10-23. Set with `IMAGEGEN_OPENAI_MODEL`.
- gpt-image-2 and later take any `WxH` with both sides multiples of 16, ratio 1:3–3:1, at most
  3840x2160 and within pixel limits; older models take 1024x1024, 1536x1024 or 1024x1536. The
  provider rounds to a valid size; the tool layer resizes to the exact request.
- `background: "transparent"` with PNG output (in preview on gpt-image-2, supported on 2.5).
- The generations endpoint takes no images, so generation with references uses the edits
  endpoint (up to 16 input images). Masks must be PNGs with alpha at the image's size; the
  provider resizes them.
- No native set mode: sets use the one-by-one fallback with the first image as an anchor.

Still to do before publishing the Codex backend for others: check OpenAI's terms for scripted use of the Codex
CLI with a ChatGPT plan, and say in the README which plan or quota it uses. Confirm current model
names and parameters against provider docs when adding the API backend; don't hard-code them from
memory.

---

## 4. MCP tools

| Tool | Inputs | Output | Status |
| --- | --- | --- | --- |
| `generate_image` | `prompt`, `size?`, `count?` (1–4), `references?`, `transparent?`, `out_name?` | Saved paths + previews | Done |
| `edit_image` | `image`, `prompt`, `size?` (default: input size), `count?`, `references?`, `transparent?`, `out_name?` (default `<input>-edited`) | Saved paths + previews | Done |
| `generate_set` | `style`, `items[]` (1–8 `{name, prompt}`), `size?`, `transparent?`, `references?`, `folder?` | One file per item, named after it | Done |
| `list_providers` | none | Configured backend and its capabilities | Planned |

Rules for the tools:

- **Previews:** return a downscaled (512 px long edge) copy as MCP image content so Claude can
  judge the result without reading big files. Full-size files are returned only as paths.
- **Progress:** send MCP progress notifications while a backend runs; silence looks like a hang.
- **Cancellation and timeouts:** honour the request's abort signal; timeout 5 minutes per image
  asked for.
- **Errors:** clear, actionable messages ("Codex is not signed in: run `codex login`", "Codex CLI
  not found … set IMAGEGEN_CODEX_BIN", what the model said when it refused).
- **Originals are never changed:** edits always write a new file.

---

## 5. Files and safety

- **Output sandbox:** write only inside the output folder (default `./generated-images` in the
  client's working directory). Absolute paths, `..` and symlinks that lead outside are rejected.
- **Read sandbox:** reference and edit images must be inside the working folder (after following
  symlinks) unless `IMAGEGEN_READ_ROOT` allows more.
- **No overwrites:** an existing name gets `-2`, `-3`, …; variants get `-v1`, `-v2`, …
- **Sidecar metadata:** `<name>.json` next to each image with the prompt, provider, model, size,
  references, source image (for edits) and time.
- **Secrets:** API keys from the environment only; never logged or written to sidecars.
- **Cost guard:** `IMAGEGEN_MAX_PER_CALL` (default 8). Still to add: an optional per-session limit
  so a looping agent can't burn through quota.
- **Honest labelling:** the README says images are AI-generated; users are responsible for how
  they use them and for not imitating real brands or people.

---

## 6. Install and configuration

Claude Code (local build, for development):

```sh
claude mcp add images -e IMAGEGEN_PROVIDER=codex-cli -- node /path/to/codex-openai-image-mcp/dist/index.js
```

After release:

```sh
claude mcp add images -e IMAGEGEN_PROVIDER=codex-cli -- npx -y codex-openai-image-mcp
```

Settings (environment variables):

- `IMAGEGEN_PROVIDER`: `mock` (default) | `codex-cli` | `openai-api`
- `OPENAI_API_KEY`, `IMAGEGEN_OPENAI_MODEL` (default `gpt-image-2.5-sunburst`)
- `IMAGEGEN_OUT_DIR`, `IMAGEGEN_READ_ROOT`, `IMAGEGEN_TIMEOUT_SEC`, `IMAGEGEN_MAX_PER_CALL`,
  `IMAGEGEN_PREVIEW_SIZE`
- `IMAGEGEN_CODEX_BIN` (default `codex`)

Optional extra: ship a Claude Code **skill** with prompting tips (describe style and composition,
use references for consistency, text in images is unreliable, ask for 2–4 variants, say what must
stay the same in an edit).

---

## 7. Milestones

1. **M0 – Spike.** MCP server, `generate_image`, mock provider, output sandbox, tests. **Done.**
2. **M1 – Codex CLI backend.** Real generation with references, progress, cancellation, resizing,
   error messages. **Done**, verified with real runs.
3. **M2 – `edit_image`.** Edits on Codex and mock, read sandbox, originals untouched. **Done**.
4. **M3 – `generate_set`.** Matching sets in one call; Codex runs one session so the images share
   context, then each item is saved under its own name. **Done.**
5. **M4 – OpenAI Images API backend.** For users without Codex; adds mask support for edits.
   **Done**, tested against a fake client only. A live check reached the API (key accepted, account
   without credits) and live testing was then skipped by decision; the README says so.
6. **M5 – Release.** Done so far: name, MIT licence, public README with real examples, CI
   (Linux and macOS, Node 20/22/24), public GitHub repo, npm 0.1.0. 0.1.1 adds `mcpName` and
   `server.json` (`io.github.meet30997/codex-openai-image-mcp`) for the MCP registry listing.
   Nice to have: `list_providers`, per-session cost guard, an installer for more clients.
7. **Later:** more providers (Gemini, Stability, a local model), background removal without a
   model call, upscaling, tileable textures, sprite sheets, a contact sheet to compare variants,
   optional size presets (app icons, social cards, favicons) for people who want them.

---

## 8. Testing

- **Unit:** path sandboxing (`..`, symlinks, absolute paths), read sandbox, naming without
  overwrites, config parsing, prompt building.
- **Provider tests:** the Codex backend runs against a fake `codex` script
  (`test/fixtures/fake-codex.mjs`) that emits the same JSON events and writes images where the
  real one does, covering success, refusal, not signed in, missing binary and cancellation. Real
  backends are run only manually (they cost quota and time).
- **MCP:** in-memory client/server tests call each tool end to end; the MCP Inspector
  (`npm run inspect`) for manual checks.
- **End-to-end:** in Claude Code, ask for an image, then an edit of it, and check files, sizes and
  previews.

---

## 9. Open questions

- Default provider once the API backend exists: whichever is configured, or detect Codex sign-in
  vs `OPENAI_API_KEY` automatically?
- Is the Codex backend safe to recommend publicly, given its terms and changing flags?
- Hosted version later, or local-only forever?
