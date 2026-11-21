import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ClaudeCode,
  Codex,
  HEARTH_GUIDE_PATH,
  HEARTH_MANUAL_PATH,
  hearthGuide,
  SYSTEM_NOTE,
} from "./runners";

// Reaches the runners' protected parts, to see what each AI is given.
type Open = { build(o: unknown): string[]; input(o: unknown): string };
const options = (resume?: string) => ({
  prompt: "Why is memory so high?",
  cwd: ".",
  resume,
  attachments: [],
  project: { permissionMode: "default", allowedTools: [], codexSandbox: "read-only" },
});

describe("Hearth's guide for the AI", () => {
  it("is found and covers Hearth's own answers", () => {
    expect(HEARTH_GUIDE_PATH).toMatch(/HEARTH_FOR_AI\.md$/);
    const guide = hearthGuide();
    expect(guide).toContain("Free up voice memory");
    expect(guide).toContain("Requires your attention");
    // It goes to the AI with every message: kept small (the VPN rule added 11-21).
    expect(guide.length).toBeLessThan(13_000);
    expect(guide).toContain("HEARTH_MANUAL.md");
  });

  it("points to the full manual, which starts with what Hearth can do", () => {
    const manual = readFileSync(HEARTH_MANUAL_PATH!, "utf8");
    expect(manual.indexOf("## 1. What Hearth can do")).toBeGreaterThan(0);
    expect(manual).toContain("Free up voice memory");
    expect(manual).not.toContain("—");
  });

  it("goes to Claude Code as a system prompt file, every message", () => {
    const argv = (new ClaudeCode("claude") as unknown as Open).build(options("abc"));
    const i = argv.indexOf("--append-system-prompt-file");
    expect(i).toBeGreaterThan(-1);
    // The guide and where the full manual is, so the AI reads the section it needs.
    const file = readFileSync(argv[i + 1]!, "utf8");
    expect(file).toContain("Free up voice memory");
    expect(file).toContain(HEARTH_MANUAL_PATH!);
    expect(argv).toContain(SYSTEM_NOTE);
  });

  it("starts a new Codex conversation, and is not repeated when it continues", () => {
    const codex = new Codex("codex") as unknown as Open;
    const first = codex.input(options());
    expect(first).toContain("<hearth-guide>");
    expect(first).toContain("Free up voice memory");
    expect(first.endsWith("Why is memory so high?")).toBe(true);
    expect(codex.input(options("thread-1"))).toBe("Why is memory so high?");
  });
});

describe("Hearth's guide in a Remote Control session", () => {
  it("goes with /rc too, and sends questions about Hearth to hearth_help first", async () => {
    const { remoteGuideArgs } = await import("./remote");
    const args = remoteGuideArgs();
    expect(args[0]).toBe("--append-system-prompt-file");
    const file = readFileSync(args[1]!, "utf8");
    expect(file).toContain("hearth_help");
    expect(file).toContain(HEARTH_MANUAL_PATH!);
    expect(remoteGuideArgs("")).toEqual([]);
  });
});
