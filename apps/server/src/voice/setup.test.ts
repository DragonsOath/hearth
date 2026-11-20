import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadVoices, startCommand, startSpeech, type Runner, type SetupDeps } from "./setup";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A speech folder with a two-file manifest, and the bytes each file should have. */
function fixture() {
  const speechDir = mkdtempSync(path.join(tmpdir(), "dc-speech-"));
  const good = { "a.onnx": Buffer.from("voice a"), "a.onnx.json": Buffer.from("{}") };
  writeFileSync(
    path.join(speechDir, "voices.json"),
    JSON.stringify({
      repo: "owner/repo",
      release: "voices-v1",
      voices: [{ id: "a", label: "A", voice: "a" }],
      files: Object.entries(good).map(([name, b]) => ({ name, bytes: b.length, sha256: sha(b) })),
    }),
  );
  return { speechDir, good, dir: mkdtempSync(path.join(tmpdir(), "dc-voices-")) };
}

const noRun: Runner = async () => ({ code: 1, out: "not available" });

describe("setting up the voices", () => {
  it("downloads each voice, checks it, and keeps what is already right", async () => {
    const { speechDir, good, dir } = fixture();
    const fetched: string[] = [];
    const deps: SetupDeps = {
      speechDir,
      run: noRun,
      fetch: (async (url: string) => {
        fetched.push(url);
        const name = url.split("/").pop()! as keyof typeof good;
        return new Response(good[name]);
      }) as unknown as typeof fetch,
    };
    const said: string[] = [];
    expect(await downloadVoices(deps, dir, { say: (l) => said.push(l) })).toBe(true);
    expect(fetched).toEqual([
      "https://github.com/owner/repo/releases/download/voices-v1/a.onnx",
      "https://github.com/owner/repo/releases/download/voices-v1/a.onnx.json",
    ]);
    expect(said).toEqual(["a.onnx: downloaded and checked", "a.onnx.json: downloaded and checked"]);

    // Run again: nothing is fetched twice.
    fetched.length = 0;
    expect(await downloadVoices(deps, dir, { say: () => {} })).toBe(true);
    expect(fetched).toEqual([]);
  });

  it("refuses a file whose checksum does not match, and leaves nothing half-written", async () => {
    const { speechDir, dir } = fixture();
    const said: string[] = [];
    const deps: SetupDeps = {
      speechDir,
      run: noRun,
      fetch: (async () => new Response("tampered")) as unknown as typeof fetch,
    };
    expect(await downloadVoices(deps, dir, { say: (l) => said.push(l) })).toBe(false);
    expect(said[0]).toBe("a.onnx: downloaded, but its checksum does not match, so it was deleted.");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("uses the GitHub CLI when the release cannot be fetched directly (a private repository)", async () => {
    const { speechDir, good, dir } = fixture();
    const calls: string[][] = [];
    const deps: SetupDeps = {
      speechDir,
      fetch: (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        const name = args[args.indexOf("-p") + 1] as keyof typeof good;
        writeFileSync(args[args.indexOf("-O") + 1]!, good[name]);
        return { code: 0, out: "" };
      },
    };
    expect(await downloadVoices(deps, dir, { say: () => {} })).toBe(true);
    expect(calls[0]!.slice(0, 7)).toEqual([
      "gh",
      "release",
      "download",
      "voices-v1",
      "-R",
      "owner/repo",
      "-p",
    ]);
    expect(existsSync(path.join(dir, "a.onnx"))).toBe(true);
  });

  it("says plainly when a voice cannot be downloaded at all", async () => {
    const { speechDir, dir } = fixture();
    const said: string[] = [];
    const deps: SetupDeps = {
      speechDir,
      run: noRun,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    };
    expect(await downloadVoices(deps, dir, { say: (l) => said.push(l) })).toBe(false);
    expect(said[0]).toMatch(/could not be downloaded.*github.com/);
  });

  it("dry runs change nothing and show what would happen", async () => {
    const { speechDir, dir } = fixture();
    const said: string[] = [];
    const deps: SetupDeps = {
      speechDir,
      run: async () => {
        throw new Error("a dry run must not run anything");
      },
      fetch: (async () => {
        throw new Error("a dry run must not download");
      }) as unknown as typeof fetch,
    };
    expect(await downloadVoices(deps, dir, { dryRun: true, say: (l) => said.push(l) })).toBe(true);
    expect(await startSpeech(deps, dir, { dryRun: true, say: (l) => said.push(l) })).toBe(true);
    expect(said.join("\n")).toMatch(/Would download 2 files/);
    expect(said.join("\n")).toMatch(
      /Would run: DC_VOICES_DIR=.* docker compose -p dragon-control-speech/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("starts the speech programs only once every voice is there, on the GPU when asked", async () => {
    const { speechDir, good, dir } = fixture();
    const said: string[] = [];
    const runs: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const deps: SetupDeps = {
      speechDir,
      fetch: fetch,
      run: async (_cmd, args, opts) => {
        runs.push({ args, env: opts?.env });
        return { code: 0, out: "" };
      },
    };
    expect(await startSpeech(deps, dir, { say: (l) => said.push(l) })).toBe(false);
    expect(said[0]).toMatch(/run pnpm voices download first/);
    expect(runs).toEqual([]);

    for (const [name, b] of Object.entries(good)) writeFileSync(path.join(dir, name), b);
    expect(await startSpeech(deps, dir, { gpu: true, say: () => {} })).toBe(true);
    expect(runs[0]!.args).toEqual(startCommand(speechDir, true));
    expect(runs[0]!.args).toContain(path.join(speechDir, "compose.gpu.yml"));
    expect(runs[0]!.env).toEqual({ DC_VOICES_DIR: dir });
  });
});
