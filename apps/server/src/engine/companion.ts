import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Hearth's memory tools (briefing, recall, remember, ...) reach Claude Code through the Hearth
 * add-on installed in Claude Code: a small program, the companion, that serves them. Codex can run
 * the same program, so when Claude Code has it, Hearth gives it to Codex too (agent parity).
 */

/** The companion program of the Hearth add-on installed in Claude Code, or null. */
export function findCompanion(claudeHome = path.join(homedir(), ".claude")): string | null {
  try {
    const file = path.join(claudeHome, "plugins", "installed_plugins.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    const plugins = data.plugins ?? (data as Record<string, { installPath?: string }[]>);
    for (const [name, installs] of Object.entries(plugins)) {
      if (!name.startsWith("dragon-control@") || !Array.isArray(installs)) continue;
      for (const i of installs) {
        const p = i.installPath && path.join(i.installPath, "companion", "companion.mjs");
        if (p && existsSync(p)) return p;
      }
    }
  } catch {
    // No add-on installed: no memory tools, the same as for Claude Code.
  }
  return null;
}

/** Codex settings that add the companion as Codex's "dragon-control" tool server. */
export function codexCompanionArgs(companion: string | null, node = process.execPath): string[] {
  if (!companion) return [];
  return [
    "-c",
    `mcp_servers.dragon-control.command=${JSON.stringify(node)}`,
    "-c",
    `mcp_servers.dragon-control.args=${JSON.stringify([companion, "serve"])}`,
  ];
}

/** What Codex is told about them (Claude Code learns it from the add-on's own instructions). */
export const COMPANION_NOTE =
  "Hearth's shared homelab memory is available as the dragon-control tools (briefing, recall, remember, update_memory, read_session). Before homelab work, read the briefing; use recall for past decisions and fixes; save decisions, fixes, wins and open work with remember as they happen. Never save secrets.";
