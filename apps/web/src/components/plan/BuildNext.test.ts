import { describe, expect, it } from "vitest";
import type { HomelabBuild, HomelabStep, HomelabStepStatus } from "@dragon-control/core";
import { buildUnfinished, nextAction, signInWords } from "./BuildNext";

/**
 * Build mode rule 1 (11-22): every message in a build ends with exactly one clear next action.
 * Whatever Ember writes, the chat shows this one under her latest message, so it is tested here
 * for every state a build can be in.
 */
const step = (id: string, status: HomelabStepStatus, more: Partial<HomelabStep> = {}) =>
  ({ id, name: id[0]!.toUpperCase() + id.slice(1), what: "", status, ...more }) as HomelabStep;
const build = (steps: HomelabStep[], more: Partial<HomelabBuild> = {}): HomelabBuild =>
  ({ steps, notBuilt: [], appsFolder: "/x", conversationId: "c1", ...more }) as HomelabBuild;

describe("the one next action of a build", () => {
  it("a plan waiting for approval comes first", () => {
    const b = build([step("docker", "done"), step("jellyfin", "awaiting-approval")]);
    expect(nextAction(b)).toMatchObject({ kind: "approve", step: { id: "jellyfin" } });
  });

  it("while a step runs, it says so", () => {
    expect(nextAction(build([step("radarr", "running")]))).toMatchObject({ kind: "running" });
  });

  it("a failed step whose app answers: the owner can say it works (the Radarr retest)", () => {
    const b = build([
      step("jellyfin", "done", { url: "http://h:8096" }),
      step("radarr", "failed", { answering: true, url: "http://h:7878" }),
      step("sonarr", "waiting"),
    ]);
    expect(nextAction(b)).toMatchObject({ kind: "confirm", step: { id: "radarr" } });
  });

  it("a failed step whose app does not answer: try it again", () => {
    expect(nextAction(build([step("radarr", "failed")]))).toMatchObject({ kind: "retry" });
  });

  it("something only the owner can do: that, and for an app, its Open button", () => {
    const plex = step("plex", "needs-you", {
      need: { kind: "open-app", url: "http://h:32400/web", label: "Sign in to Plex" },
    });
    expect(nextAction(build([plex]))).toMatchObject({ kind: "open", label: "Sign in to Plex" });
    const vpn = step("qbittorrent", "needs-you", { need: { kind: "vpn-login" } });
    expect(nextAction(build([vpn]))).toMatchObject({ kind: "needs" });
  });

  it("the next step to start, with Continue", () => {
    const b = build([step("jellyfin", "done"), step("seerr", "ready")], { next: "seerr" });
    expect(nextAction(b)).toMatchObject({ kind: "continue", step: { id: "seerr" } });
  });

  it("all built: open the media server", () => {
    const b = build([step("jellyfin", "done", { url: "http://h:8096" }), step("connect", "done")]);
    expect(nextAction(b)).toMatchObject({ kind: "built", step: { id: "jellyfin" } });
  });

  it("every combination of step states gives exactly one action, never none", () => {
    const states: HomelabStepStatus[] = [
      "waiting",
      "ready",
      "needs-you",
      "awaiting-approval",
      "running",
      "done",
      "failed",
    ];
    for (const a of states)
      for (const c of states) {
        const b = build([step("docker", "done"), step("jellyfin", a), step("radarr", c)], {
          ...(a === "ready" ? { next: "jellyfin" } : c === "ready" ? { next: "radarr" } : {}),
          ...(a === "waiting" && c === "waiting"
            ? { blocker: "Save your account details first." }
            : {}),
        });
        const next = nextAction(b);
        expect(next.kind, `${a} + ${c}`).toBeTruthy();
      }
  });

  it("build mode is on in every chat once a build started and until it is done", () => {
    expect(buildUnfinished(build([step("docker", "ready")], { conversationId: undefined }))).toBe(
      false,
    );
    expect(buildUnfinished(build([step("docker", "done"), step("jellyfin", "ready")]))).toBe(true);
    expect(buildUnfinished(build([step("docker", "done"), step("jellyfin", "done")]))).toBe(false);
  });

  it("says how to sign in, the way the passwords were made", () => {
    expect(signInWords({ passwords: "own" }, "Radarr")).toBe(
      "Sign in with the username and password you saved at the start.",
    );
    expect(signInWords({ passwords: "generate", username: "alex" }, "Radarr")).toContain(
      'in Secure Vault as "Radarr: your login"',
    );
  });
});
