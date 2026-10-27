# imagegen-mcp

An MCP server that lets Claude generate images and save them as local files. See
[PLAN.md](PLAN.md) for the roadmap. Done so far: the `generate_image`, `edit_image` and
`generate_set` tools, with two backends:

- **`openai-api`**: the OpenAI Images API with your `OPENAI_API_KEY` (paid per image). Default
  model `gpt-image-2.5-sunburst`. Supports references, transparency and edit masks.
- **`codex-cli`**: real images through the Codex CLI's built-in `image_gen` tool, using your
  ChatGPT/Codex sign-in (no API key). Roughly 30–60 s per image.
- **`mock`** (default): instant placeholder images, for tests and demos.

## Develop

```sh
npm install
npm run build      # compiles to dist/
npm test           # vitest: path sandbox + end-to-end tool calls over in-memory MCP
npm run inspect    # MCP Inspector against dist/index.js
```

## Add to Claude Code

```sh
npm run build
claude mcp add imagegen -e IMAGEGEN_PROVIDER=codex-cli -- node /Users/meet/Developer/image-mcp/dist/index.js
```

Or with an OpenAI API key:

```sh
claude mcp add imagegen -e IMAGEGEN_PROVIDER=openai-api -e OPENAI_API_KEY=sk-... -- node /Users/meet/Developer/image-mcp/dist/index.js
```

Leave out `IMAGEGEN_PROVIDER` to use the mock provider.

Then ask Claude things like *"make a watercolour fox for my blog header, 1536x1024"* or
*"edit photo.png so it's a sunset"* or *"make 5 matching sticker icons: coffee, cactus, moon,
cloud, cat"*.
Images are written to `./generated-images` in the directory Claude Code was started from.

## Tool: `generate_image`

| Input | Default | Notes |
| --- | --- | --- |
| `prompt` | required | |
| `size` | `1024x1024` | `WxH`, 16–4096 px per side |
| `count` | `1` | 1–4; files get `-v1`, `-v2`, … |
| `transparent` | `false` | The result says if the output came back without alpha |
| `references` | `[]` | Up to 4 style reference images, inside the working folder (not `mock`) |
| `out_name` | slug of prompt | Relative to the output folder, e.g. `badges/gold`; no `..`, absolute paths or escaping symlinks |

Images are cropped to fill and resized to exactly `size`. Returns the saved paths plus a preview (long edge 512 px) as image content. Each image gets a
`<name>.json` sidecar with the prompt and settings. Existing files are never overwritten;
`-2`, `-3`, … is added instead.

## Tool: `edit_image`

| Input | Default | Notes |
| --- | --- | --- |
| `image` | required | Image to change, inside the working folder. Never modified |
| `prompt` | required | The change, e.g. "remove the person on the left", "make it watercolour" |
| `size` | input image's size | `WxH` |
| `mask` | none | PNG whose transparent areas mark where to edit; resized to the image (`openai-api` only) |
| `count` | `1` | 1–4 variants |
| `transparent` | `false` | e.g. for cutouts |
| `references` | `[]` | Up to 3 supporting images: something to insert, or a style to apply (not `mock`) |
| `out_name` | `<input name>-edited` | Same rules as `generate_image` |

The sidecar records the source image as well as the prompt.

## Tool: `generate_set`

Several different images that share one style (icons, stickers, badges, character portraits,
story illustrations).

| Input | Default | Notes |
| --- | --- | --- |
| `style` | required | What every image shares: medium, palette, rendering, background |
| `items` | required | 1–8 `{ name, prompt }`; each is saved as `<folder>/<slug of name>.png` |
| `size` | `1024x1024` | Same for every image |
| `transparent` | `false` | |
| `references` | `[]` | Up to 4 images whose style the whole set matches |
| `folder` | slug of `style` | Relative to the output folder |

With `codex-cli` the whole set is made in one Codex session, so the images share context. Images
are matched to items in the order they were made; if Codex makes fewer than asked, the extras are
saved as `unmatched-N.png` rather than guessing. Other backends make the items one by one and use
the first image as an extra style reference for the rest.

## Settings (environment variables)

| Variable | Default |
| --- | --- |
| `IMAGEGEN_PROVIDER` | `mock`, `codex-cli` or `openai-api` |
| `OPENAI_API_KEY` | required for `openai-api` |
| `IMAGEGEN_OPENAI_MODEL` | `gpt-image-2.5-sunburst` (`gpt-image-2.5-flare` is faster) |
| `IMAGEGEN_OUT_DIR` | `generated-images` (relative to the working directory) |
| `IMAGEGEN_READ_ROOT` | the working directory; reference images must be inside it |
| `IMAGEGEN_CODEX_BIN` | `codex` |
| `IMAGEGEN_TIMEOUT_SEC` | `300`, per image asked for |
| `IMAGEGEN_MAX_PER_CALL` | `8` |
| `IMAGEGEN_PREVIEW_SIZE` | `512` |

## How the OpenAI backend works

- Sizes are rounded to what the API accepts (multiples of 16, ratio within 1:3–3:1, pixel limits;
  older models get the nearest of 1024x1024, 1536x1024, 1024x1536), then resized to your size.
- Generation with references goes through the edits endpoint, since the generations endpoint takes
  no images.
- Sets are made one item at a time, with the first image as an extra style reference.
- The key is read from the environment only and never logged or written to sidecars.

## How the Codex backend works

For each call the server runs

```sh
codex exec --json --skip-git-repo-check --sandbox read-only --cd <empty temp dir> [--image=<ref>...] -- -
```

with a prompt on stdin that tells Codex to call `image_gen` N times and do nothing else. Codex
saves the images in `$CODEX_HOME/generated_images/<thread id>/`; the server reads the thread id
from the JSON events, collects the PNGs from there, resizes them and saves them in the output
folder. For edits, the input is attached as Image 1 and supporting images after it. Codex never
gets write access, and never sees your project files beyond the references
you pass. Cancelling the MCP request or hitting the timeout kills the Codex process.

Each call uses your ChatGPT plan's Codex usage. Check OpenAI's terms on scripted use of the Codex
CLI before relying on it for anything beyond personal use.
