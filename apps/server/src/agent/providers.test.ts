import { describe, expect, it } from "vitest";
import {
  claudeCodeArgs,
  codexSteps,
  resultOf,
  streamSteps,
  type AgentStep,
  codexProvider,
  ollamaProvider,
  parseCodexRun,
  type OllamaBrain,
} from "./providers";

const brain = (over: Partial<OllamaBrain> = {}): OllamaBrain => ({
  env: () => ({ ANTHROPIC_BASE_URL: "http://ai-box:11434" }),
  model: () => "coder:14b",
  check: async () => ({ ok: true, detail: "Ollama 0.40.5 with coder:14b." }),
  ...over,
});

describe("Ollama in the Lair", () => {
  it("is its own AI service, checked through Claude Code first", async () => {
    const missing = ollamaProvider(brain(), "no-such-claude-program");
    expect(missing.id).toBe("ollama");
    expect((await missing.check()).detail).toContain("runs through Claude Code");
    // Claude Code there (Node stands in: it answers --version), then Ollama's own check.
    const there = ollamaProvider(brain(), process.execPath);
    expect(await there.check()).toEqual({ ok: true, detail: "Ollama 0.40.5 with coder:14b." });
  });

  it("says plainly when Ollama has no model yet, without starting anything", async () => {
    const p = ollamaProvider(brain({ env: () => null, model: () => null }), process.execPath);
    const r = await p.run({ system: "", prompt: "hi", mcpUrl: "", key: "", timeoutMs: 1000 });
    expect(r.error).toContain("Settings, Ember, Ollama");
    expect(r.durationMs).toBe(0);
  });
});

describe("Codex in the Lair", () => {
  it("reads its answer, usage, and failures from codex exec --json", () => {
    const ok = parseCodexRun(
      [
        '{"type":"thread.started","thread_id":"t"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"SERVICES=12"}}',
        '{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":400,"output_tokens":20}}',
      ].join("\n"),
    );
    expect(ok).toEqual({
      text: "SERVICES=12",
      usage: { inputTokens: 500, outputTokens: 20, cachedTokens: 400 },
    });
    expect(parseCodexRun('{"type":"turn.failed","error":{"message":"usage limit"}}')).toEqual({
      text: "",
      error: "usage limit",
    });
  });

  it("runs with Full access off too, as in the War Room (here Codex is not installed)", async () => {
    const r = await codexProvider("no-such-codex").run({
      system: "",
      prompt: "hi",
      mcpUrl: "",
      key: "",
      timeoutMs: 1000,
      standard: {},
    });
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain("Full access");
  });

  it("Full access off in the Lair: the War Room's usual tools plus Hearth's, edits accepted", () => {
    const args = claudeCodeArgs("C:/tmp/system.md", "C:/tmp/mcp.json", {}, false, true);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Bash");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__dragon-control");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("C:/tmp/system.md");
  });
});

describe("look only: Claude Code runs read only", () => {
  it("gets only reading tools and Hearth's, none of the owner's add-ons, whatever Full access says", () => {
    const args = claudeCodeArgs("C:/tmp/system.md", "C:/tmp/mcp.json", {}, true, false, true);
    expect(args[args.indexOf("--tools") + 1]).toBe(
      "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,ToolSearch",
    );
    expect(args[args.indexOf("--disallowedTools") + 1]).toMatch(/^Bash,PowerShell,Edit,Write/);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("acceptEdits");
  });
});

describe("effort: everyday questions think less (11-14)", () => {
  it("passes the thinking level when Hearth sets one, and nothing otherwise", () => {
    const lean = claudeCodeArgs(
      "/tmp/s.md",
      "/tmp/m.json",
      { effort: "low" },
      true,
      false,
      false,
      true,
    );
    expect(lean[lean.indexOf("--effort") + 1]).toBe("low");
    const full = claudeCodeArgs("/tmp/s.md", "/tmp/m.json", { effort: "medium" }, true);
    expect(full[full.indexOf("--effort") + 1]).toBe("medium");
    expect(claudeCodeArgs("/tmp/s.md", "/tmp/m.json", {}, true)).not.toContain("--effort");
  });
});

describe("lean: an everyday how-to runs light (11-13)", () => {
  it("gets reading tools and Hearth's, Hearth's instructions in place of Claude Code's prompt, no add-ons", () => {
    const args = claudeCodeArgs(
      "C:/tmp/system.md",
      "C:/tmp/mcp.json",
      { model: "opus" },
      true,
      false,
      false,
      true,
    );
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--tools") + 1]).toMatch(/^Read,Glob,Grep/);
    expect(args[args.indexOf("--disallowedTools") + 1]).toMatch(/^Bash,PowerShell,Edit,Write/);
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("C:/tmp/system.md");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("bypassPermissions");
  });
});

// Live steps (11-12, the owner: "I need an indicator it's still working"): each of the agent's
// own steps shows while it runs and is ticked off when it ends; Hearth's tools report themselves.
describe("the agent's live steps", () => {
  it("reads Claude Code's stream: steps in plain words, then the result", () => {
    const steps: AgentStep[] = [];
    const lines = [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Checking the songs." },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "python3 search.py", description: "search YouTube Music" },
            },
            { type: "tool_use", id: "t2", name: "mcp__dragon-control__hearth_api", input: {} },
            {
              type: "tool_use",
              id: "t3",
              name: "Write",
              input: { file_path: "/tmp/w/forge.json" },
            },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true }] },
      },
      { type: "result", subtype: "success", result: "Done.", total_cost_usd: 0.5 },
    ];
    for (const l of lines) streamSteps(l, (s) => steps.push(s));
    expect(steps).toEqual([
      { id: "t1", label: "Search YouTube Music" },
      { id: "t3", label: "Writing forge.json" },
      { id: "t1", done: true, failed: false },
      { id: "t3", done: true, failed: true },
    ]);
    const out = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(resultOf(out)).toMatchObject({ result: "Done.", total_cost_usd: 0.5 });
    // A single JSON object, as older versions print, still reads.
    expect(resultOf(JSON.stringify({ result: "Old" }))).toMatchObject({ result: "Old" });
  });

  it("reads Codex's stream: commands and searches, not Hearth's own tools", () => {
    const steps: AgentStep[] = [];
    const evs = [
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
      {
        type: "item.started",
        item: { id: "c2", type: "mcp_tool_call", server: "dragon-control", tool: "hearth_api" },
      },
      { type: "item.completed", item: { id: "c1", type: "command_execution", exit_code: 0 } },
      { type: "item.started", item: { id: "c3", type: "web_search" } },
      { type: "item.completed", item: { id: "c3", type: "web_search", status: "failed" } },
    ];
    for (const e of evs) codexSteps(e, (s) => steps.push(s));
    expect(steps).toEqual([
      { id: "c1", label: "Running a command" },
      { id: "c1", done: true, failed: false },
      { id: "c3", label: "Searching the web" },
      { id: "c3", done: true, failed: true },
    ]);
  });

  it("runs Claude Code with its stream, so steps arrive as they happen", () => {
    const args = claudeCodeArgs("/tmp/system.md", "/tmp/mcp.json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
  });
});
