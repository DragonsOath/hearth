import { describe, expect, it } from "vitest";
import {
  CONFIDENT_SCORE,
  FEATURES,
  featureAvailability,
  featureById,
  featureOfRef,
  featureOpen,
  featuresOfApp,
  featuresOnPage,
  featuresOnStorage,
  findFeatures,
  manualSection,
  manualTags,
} from "./features";

describe("Hearth's feature list", () => {
  it("has one entry per id, each complete for its status", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FEATURES) {
      expect(f.id, f.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(f.aliases.length, f.id).toBeGreaterThan(0);
      for (const a of f.aliases) expect(a, f.id).toBe(a.toLowerCase());
      // Anything not fully working says what is missing.
      if (f.status !== "working") expect(f.statusNote, f.id).toBeTruthy();
      if (f.status === "planned") {
        // Nothing planned is presented as usable: no page, buttons, or abilities.
        expect(f.where.route, f.id).toBeUndefined();
        expect(f.labels, f.id).toEqual([]);
        expect(f.ember, f.id).toBeUndefined();
      } else {
        // Built means proven by a test, not just that a page or button exists.
        expect(f.evidence.length, f.id).toBeGreaterThan(0);
      }
      for (const a of [f.ember?.prepare, f.ember?.execute])
        if (a) expect(a.tools.length, f.id).toBeGreaterThan(0);
    }
  });
});

/**
 * Real questions, in the owner's words (10-29), and the feature each one is about. The
 * first deterministic half of checklist 42.4: retrieval, not the AI's answer.
 */
const QUESTIONS: [string, string][] = [
  ["How do I invite my friends to a watch party?", "movie-nights"],
  ["How do I invite friends to a movie night?", "movie-nights"],
  ["How do I connect my Discord?", "notifications"],
  ["How do I create a movie announcement?", "media-announcements"],
  ["How do I add another computer?", "pcs-and-devices"],
  ["What does Full Access mean?", "full-access"],
  ["How do I connect Plex?", "media-server-panels"],
  ["How do I invite someone to my media server?", "wizarr"],
  ["How do I set up a RAID array?", "raid"],
  ["What's the difference between a finding and an incident?", "findings"],
  ["Can Hearth manage my Home Assistant automations?", "home-assistant"],
  ["How do I change Ember's voice?", "voice"],
  ["What can Hearth actually do for me?", "capabilities"],
  ["What can Hearth do?", "capabilities"],
  ["Where do I put my API key?", "vault"],
  ["Why is memory so high?", "memory-usage"],
  ["How do I reset ram", "memory-usage"],
  ["How do I print a list of my movies?", "collection-pdf"],
  ["Can I use a free AI on my own computer?", "ai-choice"],
  ["How do I get Hearth on my phone?", "pcs-and-devices"],
  ["How do I stop Hearth fixing things on its own?", "autonomy"],
  ["Where is my download?", "arr-panels"],
  ["How do I update Hearth?", "updates"],
  ["Can Hearth send notifications to Slack?", "more-notification-kinds"],
  ["Is my drive dying?", "drive-health"],
  // The real-AI check (10-29): questions a local model got wrong when these matched poorly.
  ["How do I get Discord to tell my family when I add a movie?", "media-announcements"],
  ["Where can I see which of my hard drives are failing?", "drive-health"],
  ["Can Hearth automatically install and configure my entire homelab?", "build-homelab"],
  ["How do I invite my friends to watch a movie together?", "movie-nights"],
  ["Can you open the setting that controls Ember's voice?", "voice"],
];

describe("finding the feature a question is about", () => {
  it.each(QUESTIONS)("%s -> %s", (question, id) => {
    const [best] = findFeatures(question);
    expect(best?.feature.id).toBe(id);
    expect(best!.score).toBeGreaterThanOrEqual(CONFIDENT_SCORE);
  });

  it("is not sure about questions no feature answers, instead of guessing", () => {
    for (const q of [
      "Can Hearth mow my lawn?",
      "Why isn't this button working?",
      "Can you show me where that setting is?",
    ]) {
      const best = findFeatures(q)[0];
      expect(best?.score ?? 0, q).toBeLessThan(CONFIDENT_SCORE);
    }
  });
});

describe("whether a feature is set up here", () => {
  const nights = featureById("movie-nights")!;

  it("tells being built apart from being set up on this installation", () => {
    expect(nights.status).toBe("working");
    expect(featureAvailability(nights, { apps: [], facts: {} })).toEqual({
      state: "needs-setup",
      missing: ["a media server (Plex or Jellyfin) Hearth watches"],
    });
    const ready = { apps: ["plex" as const], facts: { "movie-night-destination": true } };
    expect(featureAvailability(nights, ready).state).toBe("ready");
    const noDiscord = { apps: ["jellyfin" as const], facts: { "movie-night-destination": false } };
    expect(featureAvailability(nights, noDiscord).missing).toEqual([
      'a Discord bot destination, or any destination ticked for "New in your library" under Media announcements',
    ]);
  });

  it("says unknown when it cannot tell, and never calls a planned feature available", () => {
    expect(featureAvailability(nights).state).toBe("unknown");
    expect(featureAvailability(nights, { apps: ["plex"], facts: {} }).state).toBe("unknown");
    expect(
      featureAvailability(featureById("openai-compatible")!, { apps: [], facts: {} }).state,
    ).toBe("not-built");
  });
});

describe("the manual's tagged sections", () => {
  const manual = [
    "## 1. One",
    "<!-- feature: alpha -->",
    "### Alpha",
    "Alpha text.",
    "- <!-- not a tag --> item",
    "<!-- feature: beta gamma -->",
    "- **Beta**: first line",
    "  continued.",
    "- **Next**: not beta.",
    "### After",
    "<!-- feature: alpha -->",
    "  - **Alpha again**: nested",
    "",
    "Inline `<!-- feature: delta -->` is an example, not a tag.",
  ].join("\n");

  it("takes a heading's section, or a list item with its indented lines", () => {
    expect(manualSection(manual, "beta")).toBe("- **Beta**: first line\n  continued.");
    expect(manualSection(manual, "gamma")).toBe(manualSection(manual, "beta"));
    expect(manualSection(manual, "alpha")).toBe(
      [
        "### Alpha",
        "Alpha text.",
        "- <!-- not a tag --> item",
        "- **Beta**: first line",
        "  continued.",
        "- **Next**: not beta.",
        "",
        "- **Alpha again**: nested",
      ].join("\n"),
    );
    expect(manualSection(manual, "missing")).toBeUndefined();
  });

  it("lists only whole-line tags", () => {
    expect(manualTags(manual)).toEqual(["alpha", "beta", "gamma", "alpha"]);
  });
});

describe("opening a feature for the owner (42.2)", () => {
  it("opens Hearth's own pages, sections, panels and app panels, and nothing unavailable", () => {
    expect(featureOpen(featureById("media-announcements")!)).toEqual({
      page: "/notifications#media-announcements",
    });
    expect(featureOpen(featureById("movie-nights")!)).toEqual({ panel: "movie-nights" });
    expect(featureOpen(featureById("raid")!)).toEqual({ panel: "storage", tab: "volumes" });
    expect(featureOpen(featureById("wizarr")!)).toEqual({ app: ["wizarr"] });
    expect(featureOpen(featureById("voice")!)).toEqual({ page: "/settings#cave" });
    // Not built yet: nowhere to go.
    expect(featureOpen(featureById("openai-compatible")!)).toBeUndefined();
    // Every page link is inside Hearth.
    for (const f of FEATURES) {
      const o = featureOpen(f);
      if (o && "page" in o) expect(o.page, f.id).toMatch(/^\/(?!\/)/);
    }
  });

  it("reads feature references, and only those", () => {
    expect(featureOfRef("feature:raid")?.id).toBe("raid");
    expect(featureOfRef("feature:nope")).toBeUndefined();
    expect(featureOfRef("service:raid")).toBeUndefined();
  });

  it("finds the features of a page, a Settings tab, the Storage panel's tab and an app", () => {
    const notifications = featuresOnPage("/notifications").map((f) => f.id);
    expect(notifications).toEqual(expect.arrayContaining(["notifications", "media-announcements"]));
    // Movie nights have their own panel (11-12), no longer a Notifications section.
    expect(notifications).not.toContain("movie-nights");
    expect(notifications).not.toContain("more-notification-kinds");
    const cave = featuresOnPage("/settings", "#cave").map((f) => f.id);
    expect(cave).toContain("voice");
    expect(cave).not.toContain("security");
    expect(featuresOnPage("/settings").map((f) => f.id)).toContain("settings-general");
    const raidTab = featuresOnStorage("volumes").map((f) => f.id);
    expect(raidTab).toEqual(["storage", "raid"]);
    expect(featuresOfApp("homeassistant").map((f) => f.id)).toEqual([
      "home-assistant",
      "speaker-names",
      "music-playlist",
      "calendar-sign-in-again",
      "home-dashboard",
    ]);
  });
});
