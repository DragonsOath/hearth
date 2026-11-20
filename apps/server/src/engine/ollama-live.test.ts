import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findBinary, OllamaClaude } from "./runners";

/**
 * Against a real Ollama (skipped unless DC_OLLAMA_LIVE_URL and DC_OLLAMA_LIVE_MODEL are set):
 * the War Room's Ollama runner really runs Claude Code on that model, with no Claude account,
 * and the model really calls Claude Code's tools. Where it writes is up to the model (small models
 * sometimes guess a path), so this checks the wiring, not the model's judgment.
 */
const url = process.env.DC_OLLAMA_LIVE_URL;
const model = process.env.DC_OLLAMA_LIVE_MODEL;
const claude = findBinary("claude");

describe.skipIf(!url || !model || !claude)("Ollama, live", () => {
  it(
    "runs Claude Code on the Ollama model, which calls its tools, at no cost",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "hearth-ollama-live-"));
      const runner = new OllamaClaude(claude!, () => ({ url: url!, model: model! }));
      const lines: string[] = [];
      const res = await runner.run({
        prompt: `Create the file ${path.join(cwd, "hello.txt").split(path.sep).join("/")} containing exactly the word hi, using your Write tool. Then reply: done.`,
        cwd,
        model: null,
        project: {
          path: cwd,
          permissionMode: "bypassPermissions",
          allowedTools: [],
          codexSandbox: "",
          fullAccess: true,
        },
        resume: null,
        attachments: [],
        timeoutMs: 15 * 60_000,
        signal: new AbortController().signal,
        onLine: (k, t) => lines.push(`${k}: ${t}`),
        onStart: () => undefined,
      });
      console.log(lines.join("\n"));
      expect(res.errorKind, res.error ?? "").toBeNull();
      expect(res.costUsd).toBe(0);
      expect(lines.some((l) => l.includes(`model ${model}`))).toBe(true);
      expect(lines.some((l) => l.startsWith("tool: Write"))).toBe(true);
    },
    16 * 60_000,
  );
});
