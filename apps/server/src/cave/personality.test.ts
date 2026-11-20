import { describe, expect, it } from "vitest";
import type { CavePersonality } from "@dragon-control/core";
import { CAVE_RULES, carriedIntent, intentOf, modeText, personalityText } from "./personality";

describe("Ember: reading what the owner wants", () => {
  it("tells casual talk, brainstorming, building, fixing, and questions apart", () => {
    const cases: [string, ReturnType<typeof intentOf>][] = [
      ["hey, how's it going?", "chat"],
      ["thanks!", "chat"],
      ["That would be cool", "brainstorm"],
      ["What if we added a dashboard for the UPS?", "brainstorm"],
      ["I wonder if Immich could do face search across both drives", "brainstorm"],
      ["Let's build it", "build"],
      ["Can you set up a nightly check for the backups?", "build"],
      ["Plex is down and nobody can watch anything", "fix"],
      ["Sonarr won't connect to qBittorrent, urgent", "fix"],
      ["I'm getting notifications about the PublicTracker indexer being down", "fix"],
      ["How much space is left on the media drive?", "question"],
    ];
    for (const [text, want] of cases) expect([text, intentOf(text)]).toEqual([text, want]);
  });

  it("a bare yes carries on the conversation and is its own kind, never an approval", () => {
    expect(intentOf("yes do it")).toBe("affirm");
    expect(intentOf("sounds good")).toBe("affirm");
    expect(carriedIntent(["What if we added a UPS dashboard?"])).toBe("brainstorm");
    expect(carriedIntent(["Prowlarr is broken", "thanks"])).toBe("fix");
    expect(carriedIntent(["hey"])).toBe("chat");
    expect(modeText("affirm")).toMatch(/not approval of any plan/);
  });

  it("look only: the owner's own words, beating fix and build, kept for the task", () => {
    for (const text of [
      "Check my Radarr quality settings, but don't change anything",
      "Figure out why Sonarr is broken. Do not fix it yet",
      "Just look at my Radarr settings and tell me what you find",
      "Read-only please: what is Prowlarr doing?",
      "Look but don't touch the download client",
    ])
      expect([text, intentOf(text)]).toEqual([text, "look"]);
    // "just check" alone is not look only: "just check it and fix it" asks for a fix.
    expect(intentOf("just check Plex and fix it")).toBe("fix");
    expect(intentOf("Let's build a nightly backup check")).toBe("build");
    // A short follow-up and a bare yes stay look only; asking for the change lifts it.
    const earlier = ["Look at Radarr's profiles but don't change anything"];
    expect(intentOf("and the sizes?", earlier)).toBe("look");
    expect(carriedIntent(earlier)).toBe("look");
    expect(intentOf("OK, go ahead and plan it", earlier)).toBe("build");
    expect(intentOf("fix it then", earlier)).toBe("fix");
    expect(modeText("look")).toMatch(/change nothing and propose no plan/);
  });

  it("short follow-ups keep the subject: more brainstorming stays brainstorming", () => {
    expect(intentOf("and with alerts too?", ["What if we added a UPS dashboard?"])).toBe(
      "brainstorm",
    );
  });

  it("the rules never depend on the personality, and the personality carries no permissions", () => {
    const all: CavePersonality[] = [];
    for (const enthusiasm of ["calm", "warm", "lively"] as const)
      for (const humor of ["none", "light", "playful"] as const)
        for (const detail of ["simple", "balanced", "deep"] as const)
          all.push({ enthusiasm, humor, detail });
    for (const p of all) {
      expect(personalityText(p)).not.toMatch(/approv|authori[sz]|permission|password|credential/i);
    }
    expect(CAVE_RULES).toMatch(/never authorization/);
    expect(CAVE_RULES).toMatch(/Never claim to remember/);
    expect(new Set(all.map((p) => personalityText(p))).size).toBe(all.length);
  });
});
