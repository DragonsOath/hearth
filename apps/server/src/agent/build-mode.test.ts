import { describe, expect, it } from "vitest";
import { CAVE_SYSTEM, buildModeText } from "./service";

/**
 * Build mode (11-22): in the build's conversation every message ends with one next action, stays
 * on the build, and gives one way forward. The rules go into the instructions every AI agent gets
 * (Claude Code, Codex, Ollama: one system prompt), for every turn until the plan is built.
 */
const base = {
  instance: "Hearth",
  owner: undefined,
  sample: false,
  voice: false,
  jurisdiction: "",
  personality: undefined,
  persona: undefined,
  lookPersona: undefined,
  intent: "question",
  style: [],
} as unknown as Parameters<typeof CAVE_SYSTEM>[0];

describe("build mode", () => {
  it("every turn of an unfinished build gets the rules, not only the first", () => {
    const later = CAVE_SYSTEM({ ...base, buildMode: true });
    expect(later).toContain("Build mode:");
    expect(later).toContain("End with exactly one clear next action");
    expect(later).toContain("Back to your build: next is");
    expect(later).toContain("give one recommended way forward");
    expect(later).toContain("homelab_build action confirm");
    expect(later).toContain("Sign in with the username and password you saved at the start.");
    expect(later).toContain("never ask for one");
    // The first message of the build too.
    expect(CAVE_SYSTEM({ ...base, build: true })).toContain("Build mode:");
  });

  it("other conversations do not get them", () => {
    expect(CAVE_SYSTEM({ ...base })).not.toContain("Build mode:");
  });

  it("names the AI the owner chose", () => {
    expect(buildModeText("Kaladin")).toContain("with you (Kaladin)");
  });
});
