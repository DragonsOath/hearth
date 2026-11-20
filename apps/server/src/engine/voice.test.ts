import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerEngine, sentencesOf, type Engine, type EngineVoice } from "./service";

describe("sentencesOf", () => {
  it("cuts a reply into sentences, so the first plays while the next is made", () => {
    expect(sentencesOf("Your auto-delete works. The torrents look older!  Check again?")).toEqual([
      "Your auto-delete works.",
      "The torrents look older!",
      "Check again?",
    ]);
  });

  it("keeps numbers and short text whole", () => {
    expect(sentencesOf("Version 5.2.4 is fine")).toEqual(["Version 5.2.4 is fine"]);
    expect(sentencesOf("")).toEqual([""]);
  });
});

describe("the War Room's voice", () => {
  const app = (voice?: EngineVoice) => {
    const a = Fastify();
    // Only the voice routes are called here; the engine itself is not needed.
    registerEngine(a, {} as Engine, voice);
    return a;
  };
  const fake: EngineVoice = {
    config: async () => ({ host: "speech.local" }),
    transcribe: async (audio, rate) => ` heard ${audio.length} bytes at ${rate} `,
    speak: async (text) => Buffer.from(`RIFF:${text}`),
  };

  it("says whether the built-in voice holds memory, and frees it on request", async () => {
    let loaded = true;
    const a = app({ ...fake, voiceLoaded: () => loaded, releaseBuiltin: () => (loaded = false) });
    expect((await a.inject({ method: "GET", url: "/api/engine/voice/memory" })).json()).toEqual({
      loaded: true,
    });
    const freed = await a.inject({ method: "POST", url: "/api/engine/voice/memory/release" });
    expect(freed.json()).toEqual({ loaded: false });
    expect(loaded).toBe(false);
    // No built-in voice: nothing loaded, and freeing is harmless.
    const none = app(fake);
    expect((await none.inject({ method: "GET", url: "/api/engine/voice/memory" })).json()).toEqual({
      loaded: false,
    });
  });

  it("hears through Hearth's speech machine", async () => {
    const a = app(fake);
    expect((await a.inject({ method: "GET", url: "/api/engine/voice" })).json()).toEqual({
      stt: true,
    });
    const res = await a.inject({
      method: "POST",
      url: "/api/engine/voice/stt",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(3200),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "heard 3200 bytes at 16000" });
  });

  it("speaks in the chosen voice", async () => {
    const res = await app(fake).inject({
      method: "POST",
      url: "/api/engine/voice/tts",
      payload: { text: "Hello there." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.body).toBe("RIFF:Hello there.");
  });

  it("without a speech machine, says so, and the browser does the talking", async () => {
    const a = app({ ...fake, config: async () => ({}) });
    expect((await a.inject({ method: "GET", url: "/api/engine/voice" })).json()).toEqual({
      stt: false,
    });
    const none = app();
    expect((await none.inject({ method: "GET", url: "/api/engine/voice" })).json()).toEqual({
      stt: false,
    });
    const tts = await none.inject({
      method: "POST",
      url: "/api/engine/voice/tts",
      payload: { text: "Hi." },
    });
    expect(tts.statusCode).toBe(204);
  });
});

describe("your Claude artifacts", () => {
  it("lists the synced copy and serves its files, never anything outside it", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-claude-"));
    const a = Fastify();
    registerEngine(a, { opts: { dataDir: dir } } as unknown as Engine);

    // Nothing synced yet.
    let r = await a.inject({ method: "GET", url: "/api/engine/claude-artifacts" });
    expect(r.json()).toEqual({ synced_at: null, artifacts: [] });

    const root = path.join(dir, "claude-artifacts");
    mkdirSync(path.join(root, "abc"), { recursive: true });
    writeFileSync(path.join(root, "abc", "index.html"), "<h1>Mary</h1>");
    writeFileSync(
      path.join(root, "index.json"),
      JSON.stringify({
        synced_at: "2026-10-23T12:00:00Z",
        artifacts: [{ id: "abc", title: "Mary" }],
      }),
    );
    writeFileSync(path.join(dir, "secret.txt"), "no");

    r = await a.inject({ method: "GET", url: "/api/engine/claude-artifacts" });
    expect(r.json().artifacts[0].title).toBe("Mary");
    r = await a.inject({
      method: "GET",
      url: "/api/engine/claude-artifacts/file?path=abc/index.html",
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("<h1>Mary</h1>");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    r = await a.inject({
      method: "GET",
      url: "/api/engine/claude-artifacts/file?path=../secret.txt",
    });
    expect(r.statusCode).toBe(404);
  });
});
