/* eslint-disable @typescript-eslint/no-require-imports, no-control-regex */
// Browser tests only: a stand-in for Claude Code's Remote Control that shows a session address and
// answers what is typed into it, through its transcript as the real one does.
const fs = require("node:fs"),
  path = require("node:path");
const args = process.argv.slice(2);
const sid = args.includes("--session-id")
  ? args[args.indexOf("--session-id") + 1]
  : args[args.indexOf("--resume") + 1];
const file = path.join(
  process.env.FAKE_RC_TRANSCRIPTS,
  process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
  sid + ".jsonl",
);
fs.mkdirSync(path.dirname(file), { recursive: true });
process.stdout.write("Remote Control active: https://claude.ai/code/session_E2E1\r\n");
let buf = "";
// Keys as typed: a terminal on Linux would turn Enter into a newline otherwise.
if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (!buf.includes("\r")) return;
  const text = buf
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\r/g, "")
    .trim();
  buf = "";
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "assistant",
      uuid: "a" + Date.now(),
      message: { content: [{ type: "text", text: "From the live session: " + text }] },
    }) + "\n",
  );
});
