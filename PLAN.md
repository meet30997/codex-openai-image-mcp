# Image MCP — project plan

An MCP server that lets Claude (Claude Code, Claude Desktop or any MCP client) generate and edit
any image a user asks for: "draw a watercolour fox for my blog header", "make this photo look like
a sunset", "give me 3 logo ideas for a coffee shop", "remove the background from this product
shot". Claude calls one tool, sees a preview of the result, and iterates.

It is a **general-purpose** image tool, not tied to any platform, game engine or asset store. It
started from hand-driving the Codex CLI's image generator for a game launch, which showed how much
of that work (prompt files, waiting blind, finding the output, resizing) a tool can take over.

Working name: `imagegen-mcp`.

---

## 1. Why build it

Doing it by hand with the Codex CLI meant:

- Writing a prompt file, then running `codex exec … -i <ref.png> - < prompt.md`.
- Waiting with no progress shown, then finding where the files landed.
- Resizing the outputs to the size actually needed and keeping track of versions.
- Repeating that for every image while keeping one style across a set.

With an MCP server Claude does all of it in one tool call, shows the result, and can refine it.
Other people get the same thing from one install command.

**What makes this one worth using** (several image MCP servers already exist):

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
- Sets: several related images in one call, sharing a style.
- More than one backend, chosen by config.
- Return saved file paths **and** a small preview, so Claude can look at the result. **Done.**

### Out of scope (v1)

- Hosting, a web UI, accounts or billing.
- Video, 3D models or audio.
- Uploading or publishing anywhere. The tool only writes local files.

---

## 3. Architecture

```
Claude ──MCP (stdio)──▶ imagegen-mcp
                          ├─ tools/        generate_image, edit_image (+ shared run/save loop)
                          ├─ providers/    interface + backends
                          │    ├─ codex-cli    (shells out to `codex exec`, uses the Codex sign-in)   done
                          │    ├─ mock         (placeholder images, for tests and demos)               done
                          │    └─ openai-api   (Images API, needs OPENAI_API_KEY)                      next
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
}
```

Backends return images at their native size; the tool layer crops to fill and resizes to the size
asked for, and notes it in the result (and notes a missing alpha channel when transparency was
asked for).

### Backend notes

| Backend | Pros | Cons |
| --- | --- | --- |
| **Codex CLI** (done) | Uses an existing Codex/ChatGPT sign-in, no API key, supports references and edits | ~30–60 s per image, needs Codex installed and signed in, CLI flags may change between versions |
| **OpenAI Images API** (next) | Fast, predictable, returns bytes directly, masks for edits | Needs an API key; paid per image |
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
- Cancel or timeout kills the whole process group.
- Output sizes are Codex's choice (seen: 1254×1254, 1672×941); the server resizes.

Still to do before publishing it for others: check OpenAI's terms for scripted use of the Codex
CLI with a ChatGPT plan, and say in the README which plan or quota it uses. Confirm current model
names and parameters against provider docs when adding the API backend; don't hard-code them from
memory.

---

## 4. MCP tools

| Tool | Inputs | Output | Status |
| --- | --- | --- | --- |
| `generate_image` | `prompt`, `size?`, `count?` (1–4), `references?`, `transparent?`, `out_name?` | Saved paths + previews | Done |
| `edit_image` | `image`, `prompt`, `size?` (default: input size), `count?`, `references?`, `transparent?`, `out_name?` (default `<input>-edited`) | Saved paths + previews | Done |
| `generate_set` | `style` (shared description), `items[]` (`{name, prompt}`), `references?`, `size?` | One image per item, same style | Next |
| `list_providers` | none | Configured backend and its capabilities | Planned |

Rules for the tools:

- **Previews:** return a downscaled (512 px long edge) copy as MCP image content so Claude can
  judge the result without reading big files. Full-size files are returned only as paths.
- **Progress:** send MCP progress notifications while a backend runs; silence looks like a hang.
- **Cancellation and timeouts:** honour the request's abort signal; default timeout 5 minutes.
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
- **Cost guard:** `IMAGEGEN_MAX_PER_CALL` (default 4). Still to add: an optional per-session limit
  so a looping agent can't burn through quota.
- **Honest labelling:** the README says images are AI-generated; users are responsible for how
  they use them and for not imitating real brands or people.

---

## 6. Install and configuration

Claude Code (local build, until it is on npm):

```sh
claude mcp add imagegen -e IMAGEGEN_PROVIDER=codex-cli -- node /path/to/imagegen-mcp/dist/index.js
```

After release:

```sh
claude mcp add imagegen -e IMAGEGEN_PROVIDER=codex-cli -- npx -y imagegen-mcp
```

Settings (environment variables):

- `IMAGEGEN_PROVIDER`: `mock` (default) | `codex-cli` | later `openai-api`
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
   context, then each item is saved under its own name.
5. **M4 – OpenAI Images API backend.** For users without Codex; adds mask support for edits.
6. **M5 – Release.** `list_providers`, per-session cost guard, README with screenshots, npm
   publish, MCP registry listing, a short demo.
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
- Licence: MIT is the usual choice for MCP servers.
- Hosted version later, or local-only forever?
