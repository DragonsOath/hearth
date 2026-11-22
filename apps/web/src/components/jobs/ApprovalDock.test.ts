import { describe, expect, it } from "vitest";
import type { Job } from "@dragon-control/core";
import { needsPrompt } from "./ApprovalDock";
import { plansIn } from "../cave/Progress";

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "j1",
    title: "Your homelab: set up Jellyfin",
    requestedBy: "agent",
    status: "awaiting-approval",
    createdAt: "2026-11-22T04:00:00Z",
    approval: { fingerprint: "f", expiresAt: "2026-11-23T04:00:00Z" },
    steps: [],
    ...over,
  }) as Job;

describe("the approval prompt (approvals where you are)", () => {
  it("shows a plan from Ember or Hearth that waits for you and is not on screen", () => {
    expect(needsPrompt(job(), new Set())).toBe(true);
    expect(needsPrompt(job({ requestedBy: "dragon-control" }), new Set())).toBe(true);
  });

  it("leaves alone a plan already on screen, one you started from a panel, or one decided", () => {
    expect(needsPrompt(job(), new Set(["j1"]))).toBe(false);
    expect(needsPrompt(job({ requestedBy: "you" }), new Set())).toBe(false);
    expect(needsPrompt(job({ status: "running" }), new Set())).toBe(false);
    expect(needsPrompt(job({ approval: undefined }), new Set())).toBe(false);
  });
});

describe("plansIn: the plans a chat's turns already draw", () => {
  it("takes every turn's plans, a hidden follow-up's too", () => {
    const drawn = plansIn([
      { activity: [{ id: "a", kind: "job", ref: "job:j1" } as never] },
      { activity: [{ id: "b", kind: "tool", ref: "service:plex" } as never] },
      { activity: [{ id: "c", kind: "job", ref: "job:j2" } as never] },
      {},
    ]);
    expect([...drawn].sort()).toEqual(["j1", "j2"]);
  });
});
