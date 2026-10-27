@AGENTS.md

## Claude Code notes

- **Approval.** Ask before any public step: pushing, `npm publish`, `npm deprecate`,
  `mcp-publisher`, or creating repos and releases. In auto mode these may be blocked anyway. If so,
  give the maintainer the exact command to run with `! <command>`.
- **Codex.** To try the real Codex backend, build first and run `dist/index.js` with
  `IMAGEGEN_PROVIDER=codex-cli`. Each image takes 30–60 s and uses the maintainer's ChatGPT plan, so
  ask before making more than one or two images.
- **Scratch files.** Keep scratch output, such as test images and unpacked tarballs, out of the
  repo. `generated-images/` is gitignored, but don't commit images other than the README examples
  in `docs/examples/`.
