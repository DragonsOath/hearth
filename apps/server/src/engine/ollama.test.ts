import { describe, expect, it } from "vitest";
import {
  contextOf,
  fakeOllamaFetch,
  hearthCopyName,
  normalizeOllamaUrl,
  ollamaEnv,
  ollamaStatus,
  prepareOllamaModel,
} from "./ollama";
import { OllamaClaude } from "./runners";

describe("Ollama", () => {
  it("makes a typed address into a base URL", () => {
    expect(normalizeOllamaUrl("")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaUrl("10.0.0.5")).toBe("http://10.0.0.5:11434");
    expect(normalizeOllamaUrl("http://ai-box:11434/")).toBe("http://ai-box:11434");
    expect(normalizeOllamaUrl("https://ai.example.com")).toBe("https://ai.example.com");
  });

  it("reads the memory window from Ollama's parameters", () => {
    expect(contextOf("temperature 0.7\nnum_ctx                        32768\n")).toBe(32768);
    expect(contextOf("")).toBeNull();
  });

  it("lists models with whether Hearth can use them", async () => {
    const st = await ollamaStatus({ url: "http://x:11434", model: null }, fakeOllamaFetch());
    expect(st.reachable).toBe(true);
    expect(st.version).toBe("0.40.5");
    const by = Object.fromEntries(st.models.map((m) => [m.name, m]));
    expect(by["coder-ready:14b"]).toMatchObject({ tools: true, contextOk: true, context: 32768 });
    expect(by["qwen3-coder:30b"]).toMatchObject({ tools: true, contextOk: false, context: null });
    expect(by["chat-only:7b"]).toMatchObject({ tools: false });
  });

  it("says plainly when Ollama can't be reached", async () => {
    const st = await ollamaStatus({ url: "http://x:11999", model: null }, fakeOllamaFetch());
    expect(st.reachable).toBe(false);
    expect(st.problem).toContain("can't reach Ollama at http://x:11999");
  });

  it("makes a copy with a bigger memory window, leaving the original alone", async () => {
    const f = fakeOllamaFetch();
    const cfg = { url: "http://x:11434", model: null };
    expect(hearthCopyName("qwen3-coder:30b")).toBe("qwen3-coder-30b-hearth");
    expect(hearthCopyName("llama3.1:latest")).toBe("llama3.1-hearth");
    const name = await prepareOllamaModel(cfg, "qwen3-coder:30b", f);
    const st = await ollamaStatus(cfg, f);
    expect(st.models.find((m) => m.name === name)).toMatchObject({ contextOk: true });
    expect(st.models.find((m) => m.name === "qwen3-coder:30b")).toMatchObject({ contextOk: false });
  });

  it("points Claude Code at Ollama for every model it might ask for", () => {
    const env = ollamaEnv({ url: "http://x:11434", model: "m:1" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://x:11434");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    for (const k of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ])
      expect(env[k]).toBe("m:1");
  });

  it("runs the same Claude Code arguments, with the Ollama model and free", () => {
    const r = new OllamaClaude("claude", () => ({ url: "http://x:11434", model: "m:1" }));
    const o = {
      prompt: "hi",
      cwd: ".",
      model: "opus",
      project: {
        path: ".",
        permissionMode: "bypassPermissions",
        allowedTools: [],
        codexSandbox: "",
        fullAccess: true,
      },
      resume: null,
      attachments: [],
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onLine: () => undefined,
      onStart: () => undefined,
    };
    const argv = r["build"](o);
    expect(argv).toContain("bypassPermissions");
    expect(argv.join(" ")).toContain("--append-system-prompt");
    expect(argv.slice(-2)).toEqual(["--model", "m:1"]);
    expect(argv).not.toContain("opus");
    expect(r["env"]().ANTHROPIC_BASE_URL).toBe("http://x:11434");
    const res = { costUsd: 0.04 } as Parameters<OllamaClaude["finish"]>[0];
    r["finish"](res);
    expect(res.costUsd).toBe(0);
  });
});
