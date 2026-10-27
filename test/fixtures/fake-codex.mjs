#!/usr/bin/env node
// Stand-in for `codex exec --json` used by the tests. Behaviour is chosen with FAKE_CODEX_MODE:
//   ok     write N copies of FAKE_CODEX_SRC into $CODEX_HOME/generated_images/<thread>/, where N
//          comes from the prompt, or FAKE_CODEX_COUNT if set
//   none   write nothing and reply with a refusal message
//   login  print a sign-in error and exit 1
//   hang   never finish (for cancellation tests)
import fs from "node:fs";
import path from "node:path";

const home = process.env.CODEX_HOME;
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(path.join(home, "last-call.json"), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }));

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const thread = `thread-${process.pid}`;

if (mode === "login") {
  process.stderr.write("Error: Not logged in. Run codex login.\n");
  process.exit(1);
}

emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });

if (mode === "hang") {
  fs.writeFileSync(path.join(home, "pid"), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (mode === "ok") {
    const count = Number(process.env.FAKE_CODEX_COUNT ?? /(?:exactly|set of) (\d+) image/.exec(prompt)?.[1] ?? 1);
    const dir = path.join(home, "generated_images", thread);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) fs.copyFileSync(process.env.FAKE_CODEX_SRC, path.join(dir, `exec-${i}.png`));
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Done." } });
  } else {
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I can't help with that request." } });
  }
  emit({ type: "turn.completed", usage: {} });
}
