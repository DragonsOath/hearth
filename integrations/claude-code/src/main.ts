import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Companion } from "./client";
import { runImport } from "./import-plan";
import { briefingText } from "./format";
import { onPrompt, onTurnEnd, syncSession } from "./sessions";
import { serve } from "./server";

/**
 * companion.mjs                  the MCP server Claude Code starts (tools)
 * companion.mjs hook prompt      UserPromptSubmit: homelab mode + briefing
 * companion.mjs hook stop        Stop: save the session so far, send queued saves
 * companion.mjs hook end         SessionEnd: the same, and mark the session ended
 * companion.mjs briefing         print the briefing (for checking by hand)
 * companion.mjs sync             send queued saves now
 * companion.mjs import <plan.json> [--dry-run] [--out drafts.json]
 *                                read notes and past sessions into drafts for
 *                                review in Hearth (see docs/IMPORT.md)
 */

function readStdin(): Record<string, unknown> {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function hook(event: string) {
  const input = readStdin() as { session_id?: string; prompt?: string; transcript_path?: string };
  if (!input.session_id) return;
  const c = new Companion();
  const session = { ...input, session_id: input.session_id };
  if (event === "prompt") {
    const context = await onPrompt(c, session);
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        }),
      );
    }
  } else if (event === "stop" || event === "end") {
    await onTurnEnd(c, session, event === "end");
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!command || command === "serve") return serve();
  if (command === "hook") {
    // A hook must never break the session: any failure is swallowed.
    await hook(arg ?? "").catch(() => undefined);
    return;
  }
  const c = new Companion();
  if (command === "briefing") {
    console.log(briefingText(await c.briefing(), c.url));
    return;
  }
  if (command === "sync") {
    console.log(JSON.stringify(await c.flush((id) => syncSession(c, id))));
    return;
  }
  if (command === "import") {
    if (!arg)
      throw new Error("Usage: companion.mjs import <plan.json> [--dry-run] [--out drafts.json]");
    const flags = process.argv.slice(4);
    const outAt = flags.indexOf("--out");
    await runImport(path.resolve(arg), {
      dryRun: flags.includes("--dry-run"),
      out: outAt >= 0 ? flags[outAt + 1] : undefined,
      companion: c,
      write: (file, text) => writeFileSync(file, text),
      log: (line) => console.log(line),
    });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
