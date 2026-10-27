# AGENTS.md

These are instructions for AI coding agents working in this repo. Read them before you change
anything. User-facing docs are in [README.md](README.md), and design notes and the roadmap are in
[PLAN.md](PLAN.md).

## What this is

`codex-openai-image-mcp` is an open-source (MIT) MCP server that lets an MCP client generate
images, edit them, and make sets of images in one shared style. It has two real backends: the
Codex CLI (uses the person's ChatGPT plan) and the OpenAI Images API (needs `OPENAI_API_KEY`).
There is also a `mock` backend for tests.

It is a **general-purpose** image tool. Don't add presets or wording aimed at any one use case,
game or store.

It is published as:

- **npm:** `codex-openai-image-mcp`
- **MCP registry:** `io.github.meet30997/codex-openai-image-mcp`
- **GitHub:** `meet30997/codex-openai-image-mcp`

## Commands

```sh
npm install
npm run build     # tsc -> dist/
npm test          # vitest; offline, no API key or Codex needed
npm run dev       # tsc --watch
npm run inspect   # MCP Inspector against dist/
```

Run `npm run build && npm test` before every commit. CI runs the same steps on Ubuntu and macOS
with Node 20, 22 and 24.

## Layout

```
src/
  index.ts            stdio entry; logs to stderr only (stdout is the MCP channel)
  server.ts           createServer(config): registers the tools; name/version from package.json
  config.ts           loadConfig(env, cwd): every IMAGEGEN_* setting and its default
  providers/
    types.ts          Provider interface, requests, RawImage, capabilities
    mock.ts           deterministic SVG placeholders (tests, trying it out)
    codex.ts          runs `codex exec` and collects images from $CODEX_HOME/generated_images/<thread>/
    openai.ts         openai SDK; apiSize() maps any WxH to a size the model accepts
    index.ts          createProvider(config)
  files/
    sandbox.ts        resolveInSandbox (output), resolveReadable (input), uniqueStem, slugify
    save.ts           saveImage (+ .json sidecar), makePreview
  tools/
    run.ts            shared runner: progress, abort and timeout, resize to the requested size, save, previews
    generate.ts       generate_image
    edit.ts           edit_image
    set.ts            generate_set (one Codex run per set; other backends one item at a time)
test/
  *.test.ts           end-to-end through an in-memory MCP client, plus unit tests
  fixtures/fake-codex.mjs   stands in for the codex binary (modes: ok, none, login, hang)
```

## Conventions

- TypeScript ESM (`NodeNext`). Relative imports end in `.js`. Input schemas use zod 4.
- **Code style.** Keep to the style around you: small functions, few comments, and a comment
  explains why rather than what.
- **Errors for the user.** Tools return them with `errorResult(...)` and `isError: true`, and don't
  throw. Messages should tell the user what to do, e.g. "run `codex login`" or "add credits at …".
- **Never write to stdout** in server code. Use `console.error` for logs.
- **Adding a backend.** Implement `Provider` in `src/providers/` and declare its `capabilities`
  honestly (edit, references, transparent, mask). The tools check these to reject unsupported
  options. Register it in `providers/index.ts` and `ProviderName` in `config.ts`.
- **Adding a tool.** Put it in `src/tools/`, reuse `runAndSave` from `run.ts`, register it in
  `server.ts`, and add an end-to-end test with the mock provider.
- **Docs.** When you add or change a setting or tool input, update the README tables, and update
  `server.json` if the setting matters to users installing the server.

## Safety rules (don't weaken these)

- Output is written only inside `IMAGEGEN_OUT_DIR`. `resolveInSandbox` rejects absolute paths, `..`
  and symlinks that lead outside it.
- Input images must be inside `IMAGEGEN_READ_ROOT` (`resolveReadable`).
- Never overwrite a file. `uniqueStem` adds `-2`, `-3` and so on, and writes use the `wx` flag.
  Never modify the image being edited.
- **Codex runs in a locked-down mode.** It always runs with `--sandbox read-only` and
  `--skip-git-repo-check`, in an empty temporary `--cd` folder, with the prompt on stdin. The
  prompt tells it to only call `image_gen`. Don't ask Codex to write or copy files: the user's
  global `~/.codex/AGENTS.md` may make it run tools that don't exist.
- **Cancelling and timeouts.** Cancelling or timing out kills the Codex process group. The timeout
  is `IMAGEGEN_TIMEOUT_SEC` times the number of images.
- **API keys.** Read them only from the environment. Never log them, put them in sidecars or error
  messages, or commit them. `.env` is gitignored.

## Testing

- Tests must stay offline and free. Use the `mock` provider, `fake-codex.mjs` (selected with
  `IMAGEGEN_CODEX_BIN` or the provider options), or a fake `ImagesClient` for OpenAI.
- Clean up temporary files. Tests that write outside their temporary folder must remove what they
  wrote.
- **Live checks are manual and cost money or plan usage.**
  - Codex: the real Codex backend was checked by hand, taking 30–60 s per image.
  - OpenAI API: has **not** been tested live, by the maintainer's decision. Don't run it unless the
    maintainer asks, and keep the README's note about this until it has been.

## Releasing

Releases need the maintainer's npm and GitHub logins. Agents prepare the release, and the
maintainer runs the publish commands.

1. Bump the version in **three places together**: `package.json` `version`, and both `version`
   fields in `server.json`. Then run `npm install --package-lock-only`.
2. Run `npm run build && npm test`. Check `npm pack --dry-run`: the package should contain
   `dist/`, the README, the licence and `package.json`, and never `.env`.
3. Commit, push `main`, tag `vX.Y.Z` and push the tag. Wait for CI to pass.
4. The maintainer runs `npm publish`. npm uses **staged publishing**: the version may wait for
   approval, and on a first publish a `0.0.0-stage` placeholder appears. Check with
   `npm view codex-openai-image-mcp version`.
5. Only after npm shows the new version, the maintainer runs `mcp-publisher publish`. The registry
   rejects versions that aren't on npm yet.
6. Check that `npx -y codex-openai-image-mcp@latest` starts and lists the tools, and look the
   server up in the registry search:
   `https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.meet30997/codex-openai-image-mcp`.

`mcpName` in `package.json` must equal `name` in `server.json`. The `server.json` description must
be 100 characters or fewer.

## Git

- Work on `main`, one commit per logical change. Write messages in the imperative, e.g.
  "Add …" or "Fix …".
- Don't push, publish or create releases without the maintainer's go-ahead.
