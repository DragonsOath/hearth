import { describe, expect, it } from "vitest";
import { ACTIONS, decideAction, isCoreNetworking, type PolicyInput } from "./policy";

const restart = ACTIONS["restart-container"];
const base: PolicyInput = {
  action: restart,
  requestedBy: "dragon-control",
  level: "auto",
  area: "Media servers",
  live: false,
  liveRepairs: false,
  sandbox: false,
};
const decide = (over: Partial<PolicyInput>) => decideAction({ ...base, ...over }).outcome;

describe("decideAction", () => {
  it("lets you act on your own systems at any level", () => {
    for (const level of ["monitor", "diagnose", "ask", "auto"] as const) {
      expect(decide({ requestedBy: "you", level, live: true })).toBe("allow");
    }
  });

  it("allows looking at any level, except reading logs under Monitor", () => {
    for (const level of ["monitor", "diagnose", "ask", "auto"] as const) {
      expect(decide({ action: ACTIONS["run-check"], level })).toBe("allow");
      expect(decide({ action: ACTIONS["test-endpoint"], level })).toBe("allow");
    }
    expect(decide({ action: ACTIONS["inspect-logs"], level: "monitor" })).toBe("refuse");
    expect(decide({ action: ACTIONS["inspect-logs"], level: "diagnose" })).toBe("allow");
  });

  it("maps each autonomy level to refuse, ask, or act", () => {
    expect(decide({ level: "monitor" })).toBe("refuse");
    expect(decide({ level: "diagnose" })).toBe("refuse");
    expect(decide({ level: "ask" })).toBe("approve-first");
    expect(decide({ level: "auto" })).toBe("allow");
  });

  it("refuses changes to a do-not-touch service, even approved ones, but still lets you and looking", () => {
    const dnt = { doNotTouch: "paused on purpose" };
    expect(decide({ ...dnt })).toBe("refuse");
    expect(decide({ ...dnt, approved: true, live: true, liveRepairs: true })).toBe("refuse");
    expect(decide({ ...dnt, requestedBy: "agent", sandbox: true })).toBe("refuse");
    expect(decide({ ...dnt, requestedBy: "you" })).toBe("allow");
    expect(decide({ ...dnt, action: ACTIONS["run-check"] })).toBe("allow");
    expect(decideAction({ ...base, ...dnt }).reason).toContain("paused on purpose");
    expect(decideAction({ ...base, doNotTouch: "" }).reason).toBe(
      "You put this on your do-not-touch list, so only you change it.",
    );
  });

  it("holds automatic repairs on real systems until you switch them on", () => {
    expect(decide({ live: true })).toBe("approve-first");
    expect(decide({ live: true, liveRepairs: true })).toBe("allow");
    // Disposable test containers are the exception.
    expect(decide({ live: true, sandbox: true })).toBe("allow");
  });

  it("honours your approval, but not where the area no longer allows changes", () => {
    expect(decide({ level: "ask", approved: true })).toBe("allow");
    expect(decide({ live: true, approved: true })).toBe("allow");
    expect(decide({ level: "diagnose", approved: true })).toBe("refuse");
    expect(decide({ level: "monitor", approved: true })).toBe("refuse");
  });

  it("never automates a guardrail action", () => {
    const risky = { ...restart, guardrail: true };
    expect(decide({ action: risky, liveRepairs: true, live: true })).toBe("approve-first");
    expect(decide({ action: risky, sandbox: true })).toBe("approve-first");
    expect(decide({ action: risky, approved: true })).toBe("allow");
  });

  it("never automates start or stop, whatever the settings", () => {
    for (const kind of ["start-container", "stop-container"] as const) {
      const action = ACTIONS[kind];
      expect(action).toMatchObject({ changes: true, guardrail: true });
      expect(decide({ action, liveRepairs: true, live: true, sandbox: true })).toBe(
        "approve-first",
      );
      expect(decide({ action, requestedBy: "agent", level: "diagnose" })).toBe("refuse");
    }
  });

  it("recognises containers that carry other things", () => {
    expect(isCoreNetworking("vpn", "qmcgaw/gluetun:latest")).toBe(true);
    expect(isCoreNetworking("caddy")).toBe(true);
    expect(isCoreNetworking("sonarr", "lscr.io/linuxserver/sonarr")).toBe(false);
  });

  it("explains itself in plain words", () => {
    expect(decideAction({ ...base, level: "diagnose" }).reason).toBe(
      "Media servers is set to Diagnose, so Hearth does not change anything there.",
    );
    expect(decideAction({ ...base, live: true }).reason).toMatch(/switched off/);
  });
});
