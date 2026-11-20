import { describe, expect, it } from "vitest";
import type { JurisdictionEntry } from "@dragon-control/core";
import { intentsOf, windowOf } from "./context";
import { jurisdictionText, scopeCheck } from "./jurisdiction";
import { trimLogs } from "../agent/tools";

const entry = (e: Partial<JurisdictionEntry>): JurisdictionEntry => ({
  id: e.name ?? "x",
  kind: "topic",
  name: "x",
  access: "out",
  createdAt: "2026-10-08T00:00:00Z",
  ...e,
});

const entries = [
  entry({ name: "Gig Tracker", note: "an independent app project" }),
  entry({ name: "client websites", note: "business work" }),
  entry({
    kind: "machine",
    name: "ai-box",
    access: "in",
    note: "only Sunshine and the transcode folder",
  }),
];
const vocabulary = ["Homeserver", "Plex", "Seerr", "Home Vault"];

describe("what Ember looks after", () => {
  it("takes homelab requests, including machines that are only listed, not watched", () => {
    for (const q of [
      "Why is Plex buffering for remote users?",
      "Install a new Docker service on Homeserver",
      "What's using all the memory on ai-box?",
      "Did my backups finish?",
      "Improve Hearth's mobile interface",
    ]) {
      expect(scopeCheck(q, entries, vocabulary).verdict, q).toBe("in");
    }
  });

  it("declines what is listed as out of scope before any AI is asked", () => {
    const v = scopeCheck("Work on my Gig Tracker application", entries, vocabulary);
    expect(v).toMatchObject({ verdict: "out", matched: { name: "Gig Tracker" } });
    expect(v.reason).toMatch(/Gig Tracker is outside.*independent app project/);
    expect(scopeCheck("Build one of my client websites", entries, vocabulary).verdict).toBe("out");
  });

  it("leaves mixed or unclear requests to the AI, with the rules, and trusts follow-ups", () => {
    // Hosting Gig Tracker on the home server may be homelab work; developing it is not.
    expect(
      scopeCheck("Is the Gig Tracker container on Homeserver healthy?", entries, vocabulary)
        .verdict,
    ).toBe("unsure");
    expect(scopeCheck("What's the capital of France?", entries, vocabulary).verdict).toBe("unsure");
    expect(scopeCheck("and the other one?", entries, vocabulary, { followUp: true }).verdict).toBe(
      "in",
    );
    // A follow-up still cannot smuggle in something excluded.
    expect(
      scopeCheck("now the Gig Tracker login page", entries, vocabulary, { followUp: true }).verdict,
    ).toBe("out");
  });

  it("tells the AI its jurisdiction in plain words", () => {
    const text = jurisdictionText(entries);
    expect(text).toContain("- ai-box: only Sunshine and the transcode folder");
    expect(text).toContain("- Gig Tracker: an independent app project");
    // Ember answers anything; nothing is declined as off-topic.
    expect(text).not.toContain("OUT OF SCOPE");
    expect(text).not.toMatch(/general assistant tasks/);
    expect(text).toContain("Never decline a question as off-topic.");
  });
});

describe("gathering what a question needs", () => {
  const now = new Date(2026, 9, 8, 9, 30);

  it("reads what is being asked", () => {
    expect([...intentsOf("Why did Jellyfin go down last night?")]).toEqual(
      expect.arrayContaining(["why"]),
    );
    expect([...intentsOf("Did my backups finish?")]).toContain("backups");
    expect([...intentsOf("What did you change yesterday, and who approved it?")]).toContain(
      "changes",
    );
    expect([...intentsOf("What did the agents accomplish while I was away?")]).toContain("agents");
  });

  it("reads the time it is about", () => {
    expect(windowOf("Why did Jellyfin go down last night?", now).since).toEqual(
      new Date(2026, 9, 7, 18, 0),
    );
    expect(windowOf("what changed yesterday", now).since).toEqual(new Date(2026, 9, 7));
    expect(windowOf("anything today?", now).since).toEqual(new Date(2026, 9, 8));
    expect(windowOf("what happened while I was away", now, "2026-10-05T10:00:00.000Z").label).toBe(
      "since you were last here",
    );
    expect(windowOf("how are things", now).label).toBe("in the last three days");
  });

  it("keeps the part of a log that matters", () => {
    const lines = [
      ...Array.from({ length: 150 }, (_, i) => `[INFO] request ${i} ok`),
      "[WARN] slow disk",
      ...Array.from({ length: 40 }, (_, i) => `[INFO] more ${i}`),
      "[ERROR] database is locked",
    ];
    const kept = trimLogs(lines);
    expect(kept.length).toBeLessThan(30);
    expect(kept[0]).toMatch(/192 lines; showing/);
    expect(kept).toContain("[WARN] slow disk");
    expect(kept.at(-1)).toBe("[ERROR] database is locked");
    // A warning repeated a thousand times is not kept a thousand times.
    expect(trimLogs(Array.from({ length: 1000 }, () => "[WARN] retrying")).length).toBeLessThan(40);
  });
});
