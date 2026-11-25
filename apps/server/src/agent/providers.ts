import { execFile, spawn } from "node:child_process";
import { familyFilms } from "../apps/fake-plex";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ALLOWED_TOOLS } from "../engine/queue";

/**
 * How Hearth runs an AI agent. The agent gets a task in words and
 * one connection: Hearth's MCP endpoint, with a short-lived key.
 * It has no shell, no files, and no web access of its own.
 */

export interface AgentRun {
  /** Standing instructions (who it is, what it may do, how to answer). */
  system: string;
  /** The task: an incident to look at, or what you just said. */
  prompt: string;
  mcpUrl: string;
  key: string;
  timeoutMs: number;
  /** Limits Hearth sets on the run (the agent may support some or all). */
  limits?: {
    /** "sonnet", "opus", a full model id; absent or "default" leaves it to the agent. */
    model?: string;
    /** At most this many tool round-trips. */
    maxTurns?: number;
    /** Stop the run once it has spent this much. */
    maxUsd?: number;
    /**
     * How hard it thinks before answering (11-14): everyday questions think less so the owner
     * is not left watching "thinking"; absent leaves the agent's own default (real work).
     */
    effort?: "low" | "medium";
  };
  /**
   * Full access (the owner's switch, 10-26): the full Claude Code, every built-in tool, the
   * owner's own settings and add-ons, working in this folder, as well as Hearth's tools.
   */
  full?: { cwd?: string };
  /**
   * Full access off, in a conversation (10-27, "match it"): the War Room's usual tools (a
   * shell and file edits in this folder, edits accepted without asking), plus Hearth's tools.
   */
  standard?: { cwd?: string };
  /**
   * The owner asked only to look ("don't change anything", read on the server from their words):
   * the agent runs read only whatever else is set. Claude Code (and Ollama through it) gets only
   * its reading tools and Hearth's, without the owner's add-ons; Codex runs in its read-only
   * sandbox. Hearth's own tools that plan or change something refuse as well.
   */
  lookOnly?: boolean;
  /**
   * An everyday how-to question (11-13): run light, on the same model. Claude Code (and Ollama
   * through it) gets its reading tools and Hearth's, Hearth's own instructions in place of its
   * coding prompt, and none of the owner's add-ons; Codex runs in its read-only sandbox. When the
   * question needs real work the agent says NEEDS_FULL_MODE and Hearth reruns it in full.
   */
  lean?: boolean;
  /** The owner pressed Stop (11-07): the run ends at once. */
  signal?: AbortSignal;
  /**
   * Each of the agent's own steps as it starts and ends (11-12, the owner: "I need an indicator
   * it's still working"): a command, a file, a web search. Hearth's own tools report themselves.
   */
  onStep?: (step: AgentStep) => void;
}

export type AgentStep =
  { id: string; label: string } | { id: string; done: true; failed?: boolean };

/** A step in plain words: the agent's own description of a command first. */
/** Claude Code's result: the stream's last "result" event, or one JSON object. */
export function resultOf(out: string): Record<string, unknown> {
  const lines = out.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (ev.type === "result" || lines.length === 1) return ev;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return JSON.parse(out) as Record<string, unknown>;
}

export function stepLabel(name: string, input: unknown): string | undefined {
  if (name.startsWith("mcp__dragon-control")) return undefined;
  const i = (input ?? {}) as Record<string, unknown>;
  const said = typeof i.description === "string" ? i.description.trim() : "";
  if (said) return said.charAt(0).toUpperCase() + said.slice(1);
  const file = typeof i.file_path === "string" ? i.file_path.split(/[\\/]/).pop() : "";
  switch (name) {
    case "Bash":
      return "Running a command";
    case "Read":
      return file ? `Reading ${file}` : "Reading a file";
    case "Write":
      return file ? `Writing ${file}` : "Writing a file";
    case "Edit":
      return file ? `Editing ${file}` : "Editing a file";
    case "Glob":
    case "Grep":
      return "Looking through files";
    case "WebSearch":
      return "Searching the web";
    case "WebFetch":
      return "Reading a web page";
    case "Task":
    case "Agent":
      return "Handing part of it to a helper";
    case "TodoWrite":
      return undefined;
    default:
      return name.startsWith("mcp__")
        ? `Using ${name.split("__")[1] ?? "a tool"}`
        : `Using ${name}`;
  }
}

/** One line of Claude Code's stream: the steps in it, reported as they start and end. */
export function streamSteps(ev: Record<string, unknown>, onStep: (s: AgentStep) => void) {
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const b of content as Record<string, unknown>[]) {
    if (ev.type === "assistant" && b.type === "tool_use") {
      const label = stepLabel(String(b.name ?? ""), b.input);
      if (label) onStep({ id: String(b.id ?? ""), label });
    } else if (ev.type === "user" && b.type === "tool_result")
      onStep({ id: String(b.tool_use_id ?? ""), done: true, failed: b.is_error === true });
  }
}

export interface AgentUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** Input re-read from the prompt cache: far cheaper than fresh input. */
  cachedTokens: number;
  turns?: number;
}

export interface AgentReply {
  text: string;
  error?: string;
  durationMs: number;
  costUsd?: number;
  usage?: AgentUsage;
  /** The run stopped because it reached the spending or turn limit. */
  stoppedAtLimit?: boolean;
  /** Why the run ended without an answer, as the provider said it (e.g. "error_max_turns"). */
  stopReason?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** The process was stopped from outside (SIGTERM, exit 143): a restart, not the AI failing. */
  interrupted?: boolean;
}

export interface AgentProvider {
  id: string;
  check(): Promise<{ ok: boolean; detail: string }>;
  run(task: AgentRun): Promise<AgentReply>;
}

/** Built-in Claude Code tools, all switched off: the agent may only use Hearth's tools. */
const NO_BUILT_IN_TOOLS = "";

/**
 * Claude Code's tools that only read, for a look-only answer. ToolSearch only loads tool
 * definitions; without it every one of Hearth's tools is written into the prompt at once, which
 * overflows a local model's context (Ollama answered with nothing, 2026-11-03).
 */
export const LOOK_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
];
/** Never in a look-only answer, even if the owner's settings allow them. */
export const LOOK_DENIED = ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * Hearth's own Claude Code plugin (the homelab companion) is for Claude Code outside Hearth, and
 * for the War Room's memory tools. Ember in the Lair has Hearth's memory tools built in, so there it
 * only repeated what Hearth already gives her, on every run (11-13, the owner: how-to answers at
 * 270k to 440k tokens): its hook added a cached briefing (on the home server, weeks old) to homelab
 * questions, and it saved each of her runs as a "past session". It is off for her runs: the plugin
 * itself, and its hook (pointed at an empty home).
 */
export const NO_COMPANION_SETTINGS = JSON.stringify({
  enabledPlugins: { "dragon-control@dragon-control": false },
});
export const NO_COMPANION = {
  DC_COMPANION_HOME: path.join(tmpdir(), "hearth-ember-no-companion"),
};

/**
 * Claude Code's arguments. The prompt is written to its standard input and Hearth's instructions
 * are a file (`systemFile`), never command-line text: Windows refuses a command line over 32,767
 * characters, which a long conversation with the guide and the homelab snapshot passes
 * ("spawn ENAMETOOLONG", found in the real-AI Show & Tell check, 2026-11-03).
 */
export function claudeCodeArgs(
  systemFile: string,
  mcpConfigPath: string,
  limits: AgentRun["limits"] = {},
  full = false,
  standard = false,
  look = false,
  lean = false,
): string[] {
  const extra: string[] = [];
  if (limits.model && limits.model !== "default") extra.push("--model", limits.model);
  if (limits.maxTurns) extra.push("--max-turns", String(limits.maxTurns));
  if (limits.maxUsd) extra.push("--max-budget-usd", limits.maxUsd.toFixed(2));
  if (limits.effort) extra.push("--effort", limits.effort);
  // Look only (the owner said "don't change anything"): reading tools and Hearth's, nothing that
  // runs commands or writes files, and none of the owner's add-ons (an add-on can send or click).
  // Claude Code enforces this list itself; Full access does not widen it.
  if (look)
    return [
      ...extra,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      LOOK_TOOLS.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--allowedTools",
      [...LOOK_TOOLS, "mcp__dragon-control"].join(","),
      "--disallowedTools",
      LOOK_DENIED.join(","),
      "--append-system-prompt-file",
      systemFile,
      "--no-session-persistence",
      "--setting-sources",
      "",
    ];
  // Lean (an everyday how-to question, 11-13): its reading tools and Hearth's, Hearth's own
  // instructions in place of Claude Code's coding prompt, none of the owner's add-ons. Most of a
  // how-to answer's tokens were Claude Code's own prompt and add-ons, not the question.
  if (lean)
    return [
      ...extra,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      LOOK_TOOLS.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--allowedTools",
      [...LOOK_TOOLS, "mcp__dragon-control"].join(","),
      "--disallowedTools",
      LOOK_DENIED.join(","),
      "--system-prompt-file",
      systemFile,
      "--no-session-persistence",
      "--setting-sources",
      "",
    ];
  // Full access: the whole Claude Code (its tools, prompt, the owner's settings and add-ons),
  // with Hearth's tools added and Hearth's instructions on top. No permission prompts: it is
  // told to ask the owner in its reply before anything risky.
  if (full)
    return [
      ...extra,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      NO_COMPANION_SETTINGS,
      "--append-system-prompt-file",
      systemFile,
      "--no-session-persistence",
    ];
  // Full access off: what the War Room does with it off. Its usual tools, edits accepted, the
  // owner's settings and add-ons, Hearth's tools added.
  if (standard)
    return [
      ...extra,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "acceptEdits",
      "--settings",
      NO_COMPANION_SETTINGS,
      "--allowedTools",
      [...DEFAULT_ALLOWED_TOOLS, "mcp__dragon-control"].join(","),
      "--append-system-prompt-file",
      systemFile,
      "--no-session-persistence",
    ];
  return [
    ...extra,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    NO_BUILT_IN_TOOLS,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--allowedTools",
    "mcp__dragon-control",
    // The operator's own instructions replace Claude Code's coding-assistant prompt.
    "--system-prompt-file",
    systemFile,
    "--no-session-persistence",
    // Skip the machine owner's personal settings (hooks, plugins); login still works.
    // (--bare would also skip the login.)
    "--setting-sources",
    "",
  ];
}

/**
 * A predictable stand-in used by the browser tests (DC_FAKE_AGENT=1): it
 * really connects to the MCP endpoint and reads the overview, then answers
 * in one sentence, so the whole path is exercised without using Claude.
 */
export function scriptedProvider(
  id: "claude-code" | "ollama" | "codex" = "claude-code",
): AgentProvider {
  return {
    id,
    async check() {
      return {
        ok: true,
        detail: `${{ ollama: "Ollama", codex: "Codex", "claude-code": "Claude Code" }[id]} (test stand-in) on this machine.`,
      };
    },
    async run(task) {
      const started = Date.now();
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "dragon-control-test-agent", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(task.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${task.key}` } },
        }),
      );
      try {
        // Meet Ember (e2e): an introduction, a read-only check-up shown as steps, and three
        // recommendations that are saved only when the owner's own next message asks.
        // Recommend (e2e): a list with one to request, one already owned, one already asked for,
        // and one the catalogue doesn't know (the sample Seerr's titles).
        if (task.system.startsWith("You are Ember, recommending titles in Hearth"))
          return {
            text: JSON.stringify([
              { title: "Harbor Lights", year: 2019, why: "A quiet coastal story (test agent)." },
              { title: "Ember Lake", why: "Already on your shelf (test agent)." },
              {
                title: "The Long Road",
                why: "Already on its way (test agent).",
                // Think outside the box: a nearby pick, marked.
                ...(task.prompt.includes("Think outside the box") ? { adjacent: true } : {}),
              },
              { title: "A Film Nobody Made", year: 2001, why: "Invented (test agent)." },
            ]),
            durationMs: Date.now() - started,
          };
        const now = task.prompt.slice(task.prompt.lastIndexOf("Owner, now:"));
        // The Forge pick layout (e2e): choose a set of N from M sample films.
        // "... on plex <id>": a sheet of that Plex's titles (Curator's section shows on it).
        const pickAsk =
          /^Owner, now: pick a test collection of (\d+) from (\d+)(?: on plex (\S+))?\s*$/i.exec(
            now,
          );
        if (pickAsk) {
          const n = Number(pickAsk[1]);
          const m = Number(pickAsk[2]);
          const films = Array.from({ length: m }, (_, i) => ({
            id: String(500 + i),
            values: {
              title: `Sample Film ${i + 1}`,
              year: 1970 + i,
              critics: 99 - i,
              why: i < n ? "A strong pick (test agent)" : "",
            },
          }));
          await client.callTool({
            name: "workspace_create",
            arguments: {
              title: "Test collection",
              description: `My ${n} picks are Selected; the rest are Alternatives.`,
              columns: [
                { key: "title", label: "Movie" },
                { key: "year", label: "Year", kind: "number" },
                { key: "critics", label: "Critics", kind: "number" },
                { key: "why", label: "Why" },
              ],
              choices: [
                { value: "include", label: "Include", tone: "good", acts: true },
                { value: "skip", label: "Skip" },
              ],
              items: films,
              suggested: Object.fromEntries(
                films.map((f, i) => [f.id, i < n ? "include" : "skip"]),
              ),
              layout: {
                kind: "pick",
                choice: "include",
                other: "skip",
                target: n,
                details: ["year", "critics", "why"],
              },
              ...(pickAsk[3] ? { imageService: pickAsk[3] } : {}),
            },
          });
          return {
            text: "Your collection is in the Forge. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        const name =
          /^You are ([^,]+), the AI administrator/.exec(task.system ?? "")?.[1] ?? "Ember";
        const tool = async (toolName: string, args: Record<string, unknown> = {}) =>
          (
            (await client.callTool({ name: toolName, arguments: args })).content as {
              text?: string;
            }[]
          )[0]?.text ?? "";
        // The setup connection test: read the overview through the tools, report the count.
        if (task.prompt.startsWith("Hearth connection test.")) {
          const overview = JSON.parse(await tool("get_overview")) as { servicesTotal: number };
          return {
            text: `SERVICES=${overview.servicesTotal}`,
            durationMs: Date.now() - started,
            costUsd: 0,
          };
        }
        // Opening a panel on request (e2e), with Show & Tell off: open_panel, by the app's name.
        const opening = /^Owner, now: open (?:up )?(?:the )?(.+?)(?: panel)?\s*$/i.exec(now);
        if (opening) {
          const list = JSON.parse(await tool("list_services")) as unknown;
          const rows = (
            Array.isArray(list) ? list : ((list as { services?: unknown[] }).services ?? [])
          ) as { id: string; name: string }[];
          const hit = rows.find((r) => r.name.toLowerCase() === opening[1]!.toLowerCase());
          if (hit) await tool("open_panel", { serviceId: hit.id });
          return {
            text: hit
              ? `${hit.name} is open beside the chat. (test agent)`
              : "No such app. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        // How answers look (e2e): bold, code, and a citation of something the AI looked at.
        if (now.includes("show me how answers look")) {
          const list = await tool("list_services");
          const id = /"id":\s*"([^"]+)"/.exec(list)?.[1];
          if (id) await tool("get_service", { serviceId: id });
          return {
            text: "Here is **bold**, `code`, and something I looked at [C1]. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        if (now.includes("please introduce yourself and check up on my server")) {
          for (const check of [
            "get_overview",
            "list_services",
            "storage_overview",
            "vault_status",
            "app_health",
            "backup_status",
          ])
            await tool(check);
          return {
            text: [
              `Hello, I am ${name}, the AI administrator inside Hearth for your homelab. I watch your systems, explain problems in plain words, and propose fixes. I never change anything without you approving the exact plan, and I never see a secret: keys stay in Secure Vault. (test agent)`,
              "Set up and healthy:",
              "- Your systems are being watched, and the latest checks passed.",
              "Missing or broken:",
              "- Notifications are not set up yet.",
              "My top three next steps:",
              "1. Set up notifications",
              "2. Keep a backup copy on another drive",
              "3. Add the missing app keys in Secure Vault",
              'If you want these on your to-do list, say "add them to my list".',
            ].join("\n"),
            durationMs: Date.now() - started,
          };
        }
        if (
          /(add them to my list|no thanks)/i.test(now) &&
          /My top three next steps/.test(task.prompt)
        ) {
          // Tries to save either way: the server decides from the owner's own words.
          const results: string[] = [];
          for (const title of [
            "Set up notifications",
            "Keep a backup copy on another drive",
            "Add the missing app keys in Secure Vault",
          ])
            results.push(
              await tool("save_todo", {
                title,
                category: "task",
                description: `Recommended when meeting ${name}.`,
              }),
            );
          return {
            text: `${results.join(" ")} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Contextual screenshots (e2e): look at the attached capture and say what arrived.
        const capture = /attachment ([0-9a-f-]{36}):/.exec(
          task.prompt.slice(task.prompt.lastIndexOf("Owner, now:") - 2000),
        );
        if (capture && task.prompt.includes("with view_attachment before answering")) {
          const seen = await client.callTool({
            name: "view_attachment",
            arguments: { id: capture[1] },
          });
          const parts = seen.content as {
            type: string;
            text?: string;
            mimeType?: string;
            data?: string;
          }[];
          const img = parts.find((p) => p.type === "image");
          return {
            text: img
              ? `I received the image (${img.mimeType}, ${Math.round(((img.data?.length ?? 0) * 3) / 4)} bytes): ${parts.find((p) => p.type === "text")?.text ?? ""} (test agent)`
              : `No image arrived: ${parts.map((p) => p.text).join(" ")} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Approvals where you are (e2e, 11-22): a plan proposed in the chat, card and all.
        // Stopping and starting a container always wait for the owner's approval, whatever the
        // settings, and it ends running as before.
        if (/plan a quick check of my services/i.test(now)) {
          const list = JSON.parse(await tool("list_services")) as { id: string; name: string }[];
          const target = list.find((x) => x.name === "Jellyfin") ?? list[0];
          if (!target)
            return { text: "There is nothing to check yet. (test agent)", durationMs: 0 };
          const plan = await tool("propose_job", {
            title: `Refresh ${target.name}`,
            reason: "You asked for a quick check.",
            steps: [
              { kind: "stop-container", serviceId: target.id },
              { kind: "start-container", serviceId: target.id },
            ],
          });
          return {
            text: plan.includes('"jobId"')
              ? "I've planned stopping and starting it again. Its approval card is just below. (test agent)"
              : `${plan} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // The first administrative workflow (e2e): asked to turn on episode renaming, it reads
        // Sonarr's naming settings, then proposes the one change as a plan for approval.
        if (/turn on episode renaming/i.test(now || task.prompt)) {
          const list = JSON.parse(await tool("list_services")) as { id: string; name: string }[];
          const sonarr = list.find((x) => x.name === "Sonarr");
          if (!sonarr)
            return {
              text: "There is no Sonarr here. (test agent)",
              durationMs: Date.now() - started,
            };
          const naming = await tool("arr", { serviceId: sonarr.id, view: "naming" });
          const off = /"setting":\s*"renameEpisodes"[^}]*"value":\s*false/.test(naming);
          if (!off)
            return {
              text: `Sonarr already renames episodes. (test agent)`,
              durationMs: Date.now() - started,
            };
          const plan = await tool("propose_job", {
            title: "Turn on episode renaming in Sonarr",
            reason: "New episodes get tidy, consistent names.",
            steps: [
              {
                kind: "app-arr-set-naming",
                serviceId: sonarr.id,
                params: { setting: "renameEpisodes", value: true },
              },
            ],
          });
          return {
            text: plan.includes('"jobId"')
              ? "Renaming is off in Sonarr right now. I've planned turning it on for your approval: it applies to episodes imported from now on. (test agent)"
              : `${plan} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Interactive workspaces (e2e): reading back a submission, and a long review list.
        // Only the newest request counts: the prompt also carries earlier messages (another
        // test's request in the same conversation must not be answered again).
        const lower = task.prompt.toLowerCase();
        const newest = lower.lastIndexOf("owner, now:");
        const fresh = (i: number) => (i >= newest ? i : -1);
        const latestSubmit = [...task.prompt.matchAll(/\(workspace ([0-9a-f-]{36})\)/g)].at(-1);
        const submitted = latestSubmit && latestSubmit.index >= newest ? latestSubmit : undefined;
        const asked = fresh(lower.lastIndexOf("make a test review list"));
        const cleanup = fresh(lower.lastIndexOf("make a test cleanup list"));
        if (submitted && submitted.index > Math.max(asked, cleanup)) {
          const read = await client.callTool({
            name: "workspace_read",
            arguments: { id: submitted[1] },
          });
          const body = (read.content as { text?: string }[])[0]?.text ?? "{}";
          let counts: Record<string, number> | undefined;
          let parsed: {
            title?: string;
            submitted?: { counts?: Record<string, number>; decisions?: Record<string, string> };
          };
          try {
            parsed = JSON.parse(body) as typeof parsed;
            counts = parsed.submitted?.counts;
          } catch {
            return { text: `${body} (test agent)`, durationMs: Date.now() - started };
          }
          // Stage 2: the cleanup list becomes a plan for the items chosen to discard.
          if (parsed.title === "Episode cleanup") {
            const services = await client.callTool({ name: "list_services", arguments: {} });
            const list = JSON.parse((services.content as { text?: string }[])[0]?.text ?? "[]") as {
              id: string;
              name: string;
            }[];
            const sonarr = list.find((x) => x.name === "Sonarr");
            const discard = Object.entries(parsed.submitted?.decisions ?? {})
              .filter(([, c]) => c === "discard")
              .map(([id]) => id);
            const plan = await client.callTool({
              name: "propose_workspace_plan",
              arguments: {
                workspaceId: submitted[1],
                title: `Delete ${discard.length} episode files`,
                reason: "The files you chose to discard.",
                steps: discard.map((item) => ({
                  item,
                  kind: "app-sonarr-delete-file",
                  serviceId: sonarr?.id ?? "sonarr",
                  params: { episodeFileId: 100 + Number(/S02E0(\d)/.exec(item)?.[1] ?? 0) },
                })),
              },
            });
            const answer = (plan.content as { text?: string }[])[0]?.text ?? "";
            return {
              text: answer.includes('"jobId"')
                ? `Planned ${discard.length} items for your approval. (test agent)`
                : `${answer} (test agent)`,
              durationMs: Date.now() - started,
            };
          }
          if (parsed.title === "Fun for the Whole Family") {
            const list = JSON.parse(await tool("list_services")) as unknown;
            const rows = (
              Array.isArray(list) ? list : ((list as { services?: unknown[] }).services ?? [])
            ) as { id: string; name: string }[];
            const plex = rows.find((r) => /plex/i.test(r.name));
            const titles = Object.entries(parsed.submitted?.decisions ?? {})
              .filter(([, c]) => c === "in")
              .map(([id]) => id)
              .sort();
            const name = "Fun for the Whole Family";
            const plan = await tool("propose_job", {
              title: `Add the row “${name}” to Plex Home`,
              reason: `The ${titles.length} movies you picked, as one row at the top of Home.`,
              impact: `“${name}” shows first on your Plex Home, with the ${titles.length} movies you chose.`,
              show: { where: "feature:home-rows", target: `row:${name.toLowerCase()}` },
              steps: [
                {
                  kind: "app-plex-control",
                  serviceId: plex?.id ?? "plex",
                  params: {
                    op: "home-row-apply",
                    row: JSON.stringify({
                      name,
                      libraryId: "1",
                      libraryName: "Movies",
                      rules: { titles },
                      placement: { home: true },
                      after: "",
                    }),
                  },
                },
              ],
            });
            return {
              text: plan.includes('"jobId"')
                ? `Here's the plan: “${name}”, ${titles.length} movies, first on your Plex Home. Approve it and I'll build it. (test agent)`
                : `${plan} (test agent)`,
              durationMs: Date.now() - started,
            };
          }
          return {
            text: `Read your decisions: keep ${counts?.keep ?? 0}, discard ${counts?.discard ?? 0}. (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        if (cleanup > asked) {
          const file = (n: number, q: string, gb: number) => {
            const path = `/tv/Ghosts (US)/Season 2/Ghosts.S02E0${n}.${q}.mkv`;
            return {
              id: path,
              values: { episode: `S02E0${n}`, file: path, size: Math.round(gb * 1024 ** 3) },
            };
          };
          await client.callTool({
            name: "workspace_create",
            arguments: {
              title: "Episode cleanup",
              columns: [
                { key: "episode", label: "Episode" },
                { key: "file", label: "File", kind: "path" },
                { key: "size", label: "Size", kind: "bytes" },
              ],
              choices: [
                { value: "keep", label: "Keep", tone: "good" },
                { value: "discard", label: "Discard", tone: "warn", acts: true },
              ],
              items: [
                file(1, "1080p", 1.5),
                file(2, "1080p", 1.4),
                file(3, "720p", 0.7),
                file(4, "720p", 0.8),
              ],
            },
          });
          return {
            text: "The episode files are in the panel beside the chat. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        // The Forge, on sample data (demo and video footage): duplicate movies with picks.
        const forge = fresh(lower.lastIndexOf("in the forge"));
        if (forge > Math.max(asked, cleanup)) {
          const films: [string, string, string, number, string, number, string][] = [
            [
              "Blade Runner (1982)",
              "Final Cut",
              "2160p",
              58,
              "Theatrical",
              9,
              "Keep the 4K Final Cut",
            ],
            ["Alien (1979)", "Director's Cut", "1080p", 14, "DVD rip", 1.4, "Keep the 1080p"],
            ["Heat (1995)", "Remux", "2160p", 71, "Web-DL", 6, "Keep the remux"],
            ["Arrival (2016)", "Blu-ray", "1080p", 12, "Web-DL 720p", 3, "Keep the Blu-ray"],
            [
              "The Thing (1982)",
              "Remux",
              "1080p",
              29,
              "Remux copy",
              29,
              "Same file twice: drop one",
            ],
            ["Dune (2021)", "HDR", "2160p", 46, "SDR", 18, "Keep HDR"],
            ["Jaws (1975)", "Blu-ray", "1080p", 11, "Web-DL", 5, "Keep the Blu-ray"],
            ["Sicario (2015)", "Blu-ray", "1080p", 13, "Web-DL", 4, "Keep the Blu-ray"],
            ["Drive (2011)", "Web-DL", "1080p", 6, "Blu-ray", 10, "Keep the Blu-ray"],
            ["Up (2009)", "Blu-ray", "1080p", 9, "DVD rip", 1.1, "Keep the Blu-ray"],
            ["Se7en (1995)", "Remux", "2160p", 62, "Blu-ray", 15, "Your call: both are good"],
            [
              "Interstellar (2014)",
              "IMAX",
              "2160p",
              66,
              "Extras disc",
              4,
              "Talk first: one is extras",
            ],
          ];
          const items = films.flatMap(([title, a, res, gbA, b, gbB, plan], n) => {
            const row = (copy: string, gb: number, r: string, pick: string) => ({
              id: `/media/movies/${title}/${copy}.mkv`,
              group: title,
              values: { title, copy, res: r, size: Math.round(gb * 1024 ** 3), plan },
              pick,
            });
            const out = [row(a, gbA, res, n >= 10 ? "talk" : "keep")];
            if (b)
              out.push(
                row(
                  b,
                  gbB,
                  /720p/.test(b)
                    ? "720p"
                    : /DVD/.test(b)
                      ? "480p"
                      : res === "2160p" && b !== "HDR"
                        ? "1080p"
                        : res,
                  n >= 10 ? "talk" : "discard",
                ),
              );
            return out;
          });
          await client.callTool({
            name: "workspace_create",
            arguments: {
              title: "Duplicate movies in Plex",
              description:
                "24 copies of 12 films. My pick is chosen on each: the better copy stays, the other goes. Nothing is deleted until you approve a plan.",
              columns: [
                { key: "title", label: "Movie" },
                { key: "copy", label: "Copy" },
                { key: "res", label: "Resolution", kind: "badge" },
                { key: "size", label: "Size", kind: "bytes" },
                { key: "plan", label: "What I'd do" },
              ],
              choices: [
                { value: "keep", label: "Keep", tone: "good" },
                { value: "discard", label: "Discard", tone: "warn", acts: true },
                { value: "talk", label: "Talk first" },
              ],
              items: items.map(({ pick: _p, ...i }) => i),
              suggested: Object.fromEntries(items.map((i) => [i.id, i.pick])),
            },
          });
          return {
            text: "I found 12 films with two copies each and laid them out in the Forge, with my pick on every one. Change any you like, then send me your choices.",
            durationMs: Date.now() - started,
          };
        }
        if (asked >= 0) {
          await client.callTool({
            name: "workspace_create",
            arguments: {
              title: "Duplicate Media Review",
              columns: [
                { key: "title", label: "Title" },
                { key: "file", label: "File", kind: "path" },
                { key: "res", label: "Resolution", kind: "badge" },
                { key: "size", label: "Size", kind: "bytes" },
              ],
              choices: [
                { value: "keep", label: "Keep", tone: "good" },
                { value: "discard", label: "Discard", tone: "warn" },
              ],
              items: Array.from({ length: 120 }, (_, i) => ({
                id: `/media/movies/Movie ${Math.floor(i / 2) + 1}/copy-${i % 2 ? "720p" : "1080p"}.mkv`,
                group: `Movie ${Math.floor(i / 2) + 1}`,
                values: {
                  title: `Movie ${Math.floor(i / 2) + 1}`,
                  file: `copy-${i % 2 ? "720p" : "1080p"}.mkv`,
                  res: i % 2 ? "720p" : "1080p",
                  size: (i % 2 ? 2 : 8) * 1024 ** 3,
                },
              })),
            },
          });
          return {
            text: "The duplicates are in the panel beside the chat. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        // The owner gave Ember's Browser back (e2e, 45.18): she reads the page and carries on.
        if (
          task.prompt
            .slice(task.prompt.lastIndexOf("Hearth, now"))
            .includes("The owner finished in Ember's Browser")
        ) {
          const read = JSON.parse(await tool("browser", { action: "read" })) as { text: string };
          return {
            text: `Carried on: the page says "${read.text.replace(/\s+/g, " ").trim().slice(0, 80)}". (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // The owner answered the visible-window ask (e2e, 45.19): she carries on either way.
        const answered = task.prompt.slice(task.prompt.lastIndexOf("Hearth, now"));
        if (
          /The owner (allowed opening|said no to opening) \S+ in a visible browser window/.test(
            answered,
          )
        ) {
          if (answered.includes("allowed opening")) {
            const read = JSON.parse(await tool("browser", { action: "read" })) as { text: string };
            return {
              text: `Carried on in the visible window: "${read.text.replace(/\s+/g, " ").trim().slice(0, 60)}". (test agent)`,
              durationMs: Date.now() - started,
            };
          }
          return {
            text: "You said no, so here is the link for your own browser instead. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        // A site refuses the background browser (e2e, 45.19): she asks for a visible window.
        const refusedAt = /^Owner, now: browse (\S+) and it refuses\s*$/i.exec(now);
        if (refusedAt) {
          const opened = JSON.parse(
            await tool("browser", { action: "open", url: refusedAt[1] }),
          ) as { refused?: number; page: { url: string } };
          if (!opened.refused)
            return { text: "It did not refuse. (test agent)", durationMs: Date.now() - started };
          const asked = JSON.parse(
            await tool("browser", {
              action: "ask_visible",
              url: opened.page.url,
              reason: "it refuses the background browser",
            }),
          ) as { asked?: boolean; visible?: boolean };
          return {
            text: asked.asked
              ? "That site refuses automated browsers outright, so I asked to open it in a visible window. I carry on when you answer. (test agent)"
              : "That site refuses automated browsers outright: here is the link for your own browser. (test agent)",
            durationMs: Date.now() - started,
          };
        }
        // Ember's Browser hand-over (e2e, 45.18): stuck on a check only a person should pass, she
        // hands the page over; once it is given back, she reads it and carries on.
        const stuck = /^Owner, now: browse (\S+) and ask me\s*$/i.exec(now);
        if (stuck) {
          await tool("browser", { action: "open", url: stuck[1] });
          const asked = JSON.parse(
            await tool("browser", { action: "ask_owner", reason: "solve the check" }),
          ) as { handedOver?: boolean };
          return {
            text: `${asked.handedOver ? "Over to you: solve the check in my browser, then press Give it back." : "Could not hand it over."} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Ember's Browser (e2e): open a page, read it, click a link by its name, read again.
        const browse = /^Owner, now: browse (\S+)(?: and click (.+?))?\s*$/i.exec(now);
        if (browse) {
          const [, url, name] = browse;
          const opened = JSON.parse(await tool("browser", { action: "open", url })) as {
            page?: { title: string };
            watched?: boolean;
          };
          // Show & Tell: a caption on the step the owner should follow, as a real model is told.
          const read = JSON.parse(
            await tool("browser", {
              action: "read",
              ...(task.prompt.includes("Show & Tell is on")
                ? { caption: "This page lists the classics." }
                : {}),
            }),
          ) as {
            controls: { ref: string; name: string }[];
          };
          let after = "";
          if (name) {
            const c = read.controls.find((x) => x.name === name);
            if (c) {
              const clicked = JSON.parse(
                await tool("browser", { action: "click", ref: c.ref }),
              ) as {
                page: { title: string };
              };
              await tool("browser", { action: "read" });
              after = ` Clicked "${name}": now on "${clicked.page.title}".`;
            } else after = ` No "${name}" on the page.`;
          }
          return {
            text: `Browsed "${opened.page?.title ?? "?"}" (watched: ${String(opened.watched)}).${after} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Show & Tell with an approval (e2e): highlight a Radarr profile's cutoff, then propose
        // changing it; the screen keeps it open beside the approval card.
        const planShown =
          /^Owner, now: show and plan radarr (\S+) profile (\d+) cutoff (\d+)\s*$/i.exec(now);
        if (planShown && task.prompt.includes("Show & Tell is on")) {
          const [, serviceId, profile, cutoff] = planShown;
          const radarr = { id: serviceId! };
          await tool("get_service", { serviceId: radarr.id });
          const shown = JSON.parse(
            await tool("show", {
              where: `service:${radarr.id}`,
              tab: `config/profiles/${profile}`,
              target: `profile:${profile}:cutoff`,
              caption: "Upgrades stop at this quality.",
            }),
          ) as { onScreen: boolean; reason?: string };
          const plan = await tool("propose_job", {
            title: `Lower the cutoff of quality profile ${profile}`,
            reason: "Upgrades past this quality are rarely worth the space.",
            impact: "Movies in this profile stop upgrading at the new cutoff.",
            steps: [
              {
                kind: "app-arr-edit",
                serviceId: radarr.id,
                params: {
                  resource: "qualityprofile",
                  id: Number(profile),
                  changes: JSON.stringify({ cutoff: Number(cutoff) }),
                },
              },
            ],
          });
          return {
            text: `${shown.onScreen ? "I've highlighted the cutoff on your screen." : `Not shown (${shown.reason}).`} ${plan.includes('"awaiting-approval"') ? "The change waits for your approval." : plan} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // A Home row from a request, with Show & Tell (the website's clip, 11-19), as a real model
        // is told to (features.ts home-rows): show Home, read the library, a Forge pick with
        // posters; on submission one home-row-apply step (below, with the workspace answers).
        if (
          /^Owner, now: make me a (?:plex )?(?:home )?row\b/i.test(now) &&
          /famil/i.test(now) &&
          task.prompt.includes("Show & Tell is on")
        ) {
          const list = JSON.parse(await tool("list_services")) as unknown;
          const rows = (
            Array.isArray(list) ? list : ((list as { services?: unknown[] }).services ?? [])
          ) as { id: string; name: string }[];
          const plex = rows.find((r) => /plex/i.test(r.name));
          if (!plex)
            return { text: "No Plex here. (test agent)", durationMs: Date.now() - started };
          await tool("show", {
            where: "feature:home-rows",
            target: "your-home",
            caption: "Your Plex home screen as it is now. The new row goes at the top.",
          });
          // The family library (fake-plex.ts familyFilms): its order is the stand-in's ratingKeys.
          const films = familyFilms();
          const items = films.map((f, i) => ({
            id: String(301 + i),
            values: { title: f.title, year: f.year, why: f.why },
            image: `/library/metadata/${301 + i}/thumb/1`,
          }));
          const picks = films.filter((f) => f.pick).length;
          await tool("workspace_create", {
            title: "Fun for the Whole Family",
            description: `A Plex home row of animated movies: silly for the kids, with jokes the grown-ups catch. ${picks} picks from your library, and why each works for both. Add or take out any, then build it.`,
            columns: [
              { key: "title", label: "Movie" },
              { key: "year", label: "Year", kind: "number" },
              { key: "why", label: "Why it works" },
            ],
            choices: [
              { value: "in", label: "In the row", tone: "good", acts: true },
              { value: "out", label: "Not this time" },
            ],
            items,
            suggested: Object.fromEntries(
              items.map((x, i) => [x.id, films[i]?.pick ? "in" : "out"]),
            ),
            submitLabel: "Build the row",
            layout: { kind: "pick", choice: "in", other: "out", details: ["why"] },
            imageService: plex.id,
          });
          return {
            text: `I found ${picks} animated movies in your library that kids love and grown-ups actually enjoy, and laid them out beside the chat with why each one works. Add or take out any you like, then press Build the row. (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // Show & Tell (e2e, checklist 45): "show me <place> [tab|-] [target]" opens the place,
        // reads what can be pointed at, then points at the target, as a real model is told to.
        const showMe =
          /^Owner, now: show me (\S+)(?: (\S+))?(?: (.+?))?(?: and (click|type (.+)))?\s*$/i.exec(
            now,
          );
        if (showMe && task.prompt.includes("Show & Tell is on")) {
          const [, where, tabArg, target, doing, typed] = showMe;
          const action = doing?.startsWith("type") ? "type" : doing ? "click" : undefined;
          const tab = tabArg && tabArg !== "-" ? tabArg : undefined;
          const first = JSON.parse(
            await tool("show", {
              where,
              ...(tab ? { tab } : {}),
              caption: "Here is where to look.",
            }),
          ) as { onScreen: boolean; targets?: { name: string }[]; reason?: string };
          let pointed:
            | {
                onScreen: boolean;
                reason?: string;
                did?: string;
                refused?: string;
                targets?: { name: string }[];
              }
            | undefined;
          if (target && first.onScreen)
            pointed = JSON.parse(
              await tool("show", {
                where,
                ...(tab ? { tab } : {}),
                target,
                caption: "This is the part that matters.",
                ...(action ? { action } : {}),
                ...(typed ? { text: typed } : {}),
              }),
            ) as typeof pointed;
          const listed = first.targets?.some((x) => x.name === target) ? "listed" : "not listed";
          // What the cursor's click or typing brought onto the screen.
          const before = new Set((first.targets ?? []).map((x) => x.name));
          const fresh = (pointed?.targets ?? []).filter((x) => !before.has(x.name)).length;
          const did = pointed?.did
            ? ` I ${pointed.did} it; ${fresh} new things on screen.`
            : pointed?.refused
              ? ` Refused: ${pointed.refused}`
              : "";
          return {
            text: pointed
              ? `Pointed: ${pointed.onScreen ? "on screen" : `not shown (${pointed.reason})`}; the target was ${listed}.${did} (test agent)`
              : `Opened: ${first.onScreen ? "on screen" : `not shown (${first.reason})`}. (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        // A question about Hearth itself (e2e, checklist 42): follow the hint to hearth_help, then
        // answer with its path and the Open link it gives.
        // Only for how-to questions, so other tests keep the default answer below.
        const hinted = /^Owner, now: (how do i|where|can you open)/i.test(now)
          ? /call hearth_help with feature "([a-z0-9-]+)"/.exec(task.prompt)?.[1]
          : undefined;
        if (hinted) {
          const help = JSON.parse(await tool("hearth_help", { feature: hinted })) as {
            feature: { name: string };
            where: { path: string };
            whatYouCanDo: { openItForThem: string };
          };
          const link = /\[Open [^\]]+\]\(hearth:[a-z0-9-]+\)/.exec(
            help.whatYouCanDo.openItForThem,
          )?.[0];
          return {
            text: `${help.feature.name} is in ${help.where.path}.${link ? ` ${link}` : ""} (test agent)`,
            durationMs: Date.now() - started,
          };
        }
        const result = await client.callTool({ name: "get_overview", arguments: {} });
        const body = (result.content as { text?: string }[])[0]?.text ?? "{}";
        const overview = JSON.parse(body) as { notHealthy: unknown[]; openIncidents: unknown[] };
        const text =
          overview.notHealthy.length || overview.openIncidents.length
            ? `I see ${overview.openIncidents.length} open incident(s). (test agent)`
            : "Nothing is wrong right now. Everything is healthy. (test agent)";
        return { text, durationMs: Date.now() - started };
      } finally {
        await client.close();
      }
    },
  };
}

/**
 * Ollama in the Lair: the same Claude Code, the same arguments and tools, with a free model on the
 * owner's hardware as its brain. Whatever Claude Code may do here, Ollama may do too.
 */
export interface OllamaBrain {
  /** Environment that points Claude Code at Ollama; null when Ollama isn't set up. */
  env(): Record<string, string> | null;
  model(): string | null;
  /** Is Ollama reachable with that model? (Settings shows why not.) */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export function ollamaProvider(
  brain: OllamaBrain,
  command = process.env.DC_CLAUDE_PATH || "claude",
): AgentProvider {
  const base = claudeCodeProvider(command, brain);
  return {
    id: "ollama",
    async check() {
      const claude = await base.check();
      if (!claude.ok)
        return {
          ok: false,
          detail: "Ollama runs through Claude Code, which is not installed on this machine.",
        };
      return brain.check();
    },
    run: base.run,
  };
}

export function claudeCodeProvider(
  command = process.env.DC_CLAUDE_PATH || "claude",
  ollama?: OllamaBrain,
): AgentProvider {
  const label = ollama ? "Ollama" : "Claude Code";
  return {
    id: ollama ? "ollama" : "claude-code",
    check() {
      return new Promise((resolve) => {
        execFile(command, ["--version"], { timeout: 15_000, windowsHide: true }, (error, stdout) =>
          resolve(
            error
              ? {
                  ok: false,
                  detail: "Claude Code is not installed on this machine, or not on its PATH.",
                }
              : { ok: true, detail: `Claude Code ${stdout.trim().split(" ")[0]} on this machine.` },
          ),
        );
      });
    },
    async run(task) {
      const started = Date.now();
      const env = ollama?.env();
      const model = ollama?.model();
      if (ollama && (!env || !model))
        return {
          text: "",
          error:
            "Ollama isn't set up yet: choose its address and model in Settings, Ember, Ollama.",
          durationMs: 0,
        };
      // Ollama: always its own model (a Claude model name means nothing there).
      // A local model has no thinking levels: --effort is left out for it.
      const limits = ollama
        ? { ...task.limits, model: model!, maxUsd: undefined, effort: undefined }
        : task.limits;
      // An empty working folder: even if a tool slipped through, there is nothing here to read.
      const dir = mkdtempSync(path.join(tmpdir(), "dc-agent-"));
      const config = path.join(dir, "mcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            "dragon-control": {
              type: "http",
              url: task.mcpUrl,
              headers: { Authorization: `Bearer ${task.key}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      try {
        const out = await new Promise<string>((resolve, reject) => {
          const systemFile = path.join(dir, "system.md");
          writeFileSync(systemFile, task.system, { mode: 0o600 });
          const child = spawn(
            command,
            claudeCodeArgs(
              systemFile,
              config,
              limits,
              Boolean(task.full),
              Boolean(task.standard),
              Boolean(task.lookOnly),
              Boolean(task.lean),
            ),
            {
              cwd: task.full?.cwd ?? task.standard?.cwd ?? dir,
              // Hearth's own companion plugin stays off for Ember (NO_COMPANION).
              env: { ...process.env, ...(env ?? {}), ...NO_COMPANION },
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          // The prompt, through standard input (no length limit there).
          child.stdin.on("error", () => undefined);
          child.stdin.end(task.prompt);
          let stdout = "";
          let stderr = "";
          // One event per line: steps are reported as they happen, the last is the result.
          let pending = "";
          child.stdout.on("data", (c: Buffer) => {
            const text = c.toString("utf8");
            stdout += text;
            if (!task.onStep) return;
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                streamSteps(JSON.parse(line) as Record<string, unknown>, task.onStep);
              } catch {
                // Not an event line: the result is read at the end.
              }
            }
          });
          child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
          const timer = setTimeout(() => {
            child.kill();
            reject(
              new Error(`${label} did not finish within ${Math.round(task.timeoutMs / 1000)}s.`),
            );
          }, task.timeoutMs);
          const stop = () => {
            clearTimeout(timer);
            child.kill();
            reject(new Error("Stopped by you."));
          };
          if (task.signal?.aborted) stop();
          task.signal?.addEventListener("abort", stop, { once: true });
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (code === 0 || stdout.trim().startsWith("{")) resolve(stdout);
            else
              reject(
                Object.assign(
                  new Error(
                    stderr.trim().split("\n").at(-1) || `${label} exited with ${code ?? signal}.`,
                  ),
                  { exitCode: code, signal },
                ),
              );
          });
        });
        const parsed = resultOf(out) as {
          result?: string;
          is_error?: boolean;
          subtype?: string;
          total_cost_usd?: number;
          num_turns?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
        };
        const u = parsed.usage ?? {};
        const usage: AgentUsage = {
          model: Object.keys(parsed.modelUsage ?? {})[0],
          // Fresh input includes what was written to the cache; reads from it are counted apart.
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: u.cache_read_input_tokens ?? 0,
          turns: parsed.num_turns,
        };
        const stoppedAtLimit = /max_turns|budget/i.test(parsed.subtype ?? "");
        if (parsed.is_error || stoppedAtLimit) {
          const which = /turns/i.test(parsed.subtype ?? "")
            ? `it used all ${task.limits?.maxTurns ?? "the"} steps allowed for one question`
            : /budget/i.test(parsed.subtype ?? "")
              ? `it reached the $${(task.limits?.maxUsd ?? 0).toFixed(2)} limit for one question`
              : "it reached the limit set for one run";
          return {
            text: stoppedAtLimit ? (parsed.result ?? "").trim() : "",
            error: stoppedAtLimit
              ? which
              : (parsed.result ?? "Claude Code reported an error.").trim(),
            durationMs: Date.now() - started,
            costUsd: ollama ? 0 : parsed.total_cost_usd,
            usage,
            stoppedAtLimit,
            stopReason: parsed.subtype ?? "error",
          };
        }
        return {
          text: (parsed.result ?? "").trim(),
          error: undefined,
          durationMs: Date.now() - started,
          costUsd: parsed.total_cost_usd,
          usage,
        };
      } catch (error) {
        const e = error as { exitCode?: number | null; signal?: string | null };
        const interrupted = e.exitCode === 143 || e.signal === "SIGTERM";
        return {
          text: "",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
          stopReason: interrupted
            ? "terminated (SIGTERM)"
            : /did not finish within/.test(String(error))
              ? "timeout"
              : `exit ${e.exitCode ?? e.signal ?? "?"}`,
          exitCode: e.exitCode,
          signal: e.signal,
          interrupted,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The text of a Codex run (`codex exec --json`): its last message, usage, or why it failed. */
/** One line of Codex's stream: its commands, searches and file changes as steps. */
export function codexSteps(ev: Record<string, unknown>, onStep: (s: AgentStep) => void) {
  const item = (ev.item ?? {}) as Record<string, unknown>;
  const id = String(item.id ?? "");
  if (!id) return;
  const label =
    item.type === "command_execution"
      ? "Running a command"
      : item.type === "web_search"
        ? "Searching the web"
        : item.type === "file_change"
          ? "Changing files"
          : item.type === "mcp_tool_call" && item.server !== "dragon-control"
            ? `Using ${String(item.tool ?? "a tool")}`
            : undefined;
  if (!label) return;
  if (ev.type === "item.started") onStep({ id, label });
  else if (ev.type === "item.completed")
    onStep({ id, done: true, failed: item.status === "failed" || Number(item.exit_code) > 0 });
}

export function parseCodexRun(stdout: string): {
  text: string;
  error?: string;
  usage?: AgentUsage;
} {
  let text = "";
  let error: string | undefined;
  let usage: AgentUsage | undefined;
  for (const line of stdout.split("\n")) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = (ev.item ?? {}) as Record<string, unknown>;
    if (ev.type === "item.completed" && item.type === "agent_message")
      text = String(item.text ?? "").trim() || text;
    else if (ev.type === "turn.completed") {
      const u = (ev.usage ?? {}) as Record<string, number>;
      usage = {
        inputTokens: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cached_input_tokens ?? 0,
      };
    } else if (ev.type === "turn.failed")
      error = String((ev.error as { message?: string })?.message ?? "Codex's turn failed.");
    else if (ev.type === "error") error = String(ev.message ?? "Codex reported an error.");
  }
  return { text, ...(error ? { error } : {}), ...(usage ? { usage } : {}) };
}

/**
 * Codex in the Lair (agent parity, 10-27). Codex's own shell can't be switched off, so it
 * can't be limited to Hearth's tools the way Claude Code is: it answers here only while Full
 * access is on (the agent service checks), working in the Homelab project's folder with Hearth's
 * tools added as its "dragon-control" server, through a short-lived key.
 */
export function codexProvider(command = "codex"): AgentProvider {
  return {
    id: "codex",
    check() {
      return new Promise((resolve) => {
        execFile(command, ["--version"], { timeout: 15_000, windowsHide: true }, (error, stdout) =>
          resolve(
            error
              ? { ok: false, detail: "Codex is not installed on this machine, or not on its PATH." }
              : { ok: true, detail: `${stdout.trim() || "Codex"} on this machine.` },
          ),
        );
      });
    },
    async run(task) {
      const started = Date.now();
      // Codex always has its own shell, as in the War Room; it works in the owner's folder.
      const where = task.full ?? task.standard ?? {};
      const dir = where.cwd ?? mkdtempSync(path.join(tmpdir(), "dc-codex-"));
      const args = [
        // Its own live web search, as in the War Room: a source when a site refuses Ember's Browser.
        "--search",
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-C",
        dir,
        "-s",
        // Look only: Codex's own read-only sandbox (no writes, no commands that change things).
        task.lookOnly || task.lean ? "read-only" : "danger-full-access",
        // The same thinking level as Claude Code gets for the question (agent parity).
        ...(task.limits?.effort ? ["-c", `model_reasoning_effort="${task.limits.effort}"`] : []),
        "-c",
        `mcp_servers.dragon-control.url=${JSON.stringify(task.mcpUrl)}`,
        "-c",
        'mcp_servers.dragon-control.bearer_token_env_var="HEARTH_AGENT_KEY"',
        "-",
      ];
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn(command, args, {
            cwd: dir,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, HEARTH_AGENT_KEY: task.key },
            shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
          });
          let out = "";
          let err = "";
          let pending = "";
          child.stdout.on("data", (c: Buffer) => {
            const text = c.toString("utf8");
            out += text;
            if (!task.onStep) return;
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              try {
                codexSteps(JSON.parse(line) as Record<string, unknown>, task.onStep);
              } catch {
                // Not an event line.
              }
            }
          });
          child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Codex did not finish within ${Math.round(task.timeoutMs / 1000)}s.`));
          }, task.timeoutMs);
          const stop = () => {
            clearTimeout(timer);
            child.kill();
            reject(new Error("Stopped by you."));
          };
          if (task.signal?.aborted) stop();
          task.signal?.addEventListener("abort", stop, { once: true });
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (out.trim()) resolve(out);
            else reject(new Error(err.trim().split("\n").at(-1) || `Codex exited with ${code}.`));
          });
          // Codex has no system prompt option: Hearth's instructions lead the message.
          child.stdin.end(`${task.system}\n\n${task.prompt}`);
        });
        const r = parseCodexRun(stdout);
        return {
          text: r.text,
          ...(r.error && !r.text ? { error: r.error } : {}),
          durationMs: Date.now() - started,
          ...(r.usage ? { usage: r.usage } : {}),
        };
      } catch (error) {
        return {
          text: "",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        };
      } finally {
        if (!where.cwd) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
