import { describe, expect, it } from "vitest";
import type { HomelabBuild } from "@dragon-control/core";
import { CAVE_SYSTEM, buildModeText, buildWhere } from "./service";

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

  it("every message ends with the next app or what blocks it, from the saved plan", () => {
    const where = ["- Done: Docker, Jellyfin.", "- Next: Sonarr."].join("\n");
    const text = CAVE_SYSTEM({ ...base, buildMode: true, buildWhere: where });
    expect(text).toContain('ends with "Ready to continue with <the next app>?"');
    expect(text).toContain("what blocks it and the one way past it");
    expect(text).toContain("In a new conversation, start with where the build left off.");
    expect(text).toContain("trust this, not what the conversation remembers");
    expect(text).toContain(where);
  });

  it("where the build is: done, stuck with the way past, and next", () => {
    const st = {
      steps: [
        { id: "docker", name: "Docker", what: "", status: "done" },
        { id: "jellyfin", name: "Jellyfin", what: "", status: "done" },
        {
          id: "radarr",
          name: "Radarr",
          what: "",
          status: "failed",
          detail: "radarr did not keep the sign-in it was given.",
          answering: true,
        },
        { id: "sonarr", name: "Sonarr", what: "", status: "waiting" },
      ],
      next: "radarr",
      notBuilt: [],
      appsFolder: "/x",
    } as unknown as HomelabBuild;
    const w = buildWhere(st);
    expect(w).toContain("- Done: Docker, Jellyfin.");
    expect(w).toContain("- Stuck: Radarr failed: radarr did not keep the sign-in it was given.");
    expect(w).toContain("homelab_build action confirm");
    expect(w).toContain("- Next: Radarr.");
  });

  it("names the AI the owner chose", () => {
    expect(buildModeText("Kaladin")).toContain("with you (Kaladin)");
  });
});
