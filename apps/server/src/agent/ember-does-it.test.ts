import { describe, expect, it } from "vitest";
import { hearthHelp } from "./help";
import { emberRefusal, methodsAt, planRefusal } from "./hearth-api";
import { HearthSelf } from "./hearth-self";

// Ember's handoff (2026-11-03, "Ember told the owner to do something it could do itself"):
// a help entry with no recorded route is not a "no", removed systems can be brought back by a
// plan, and only things that really are the owner's are marked so.

type Help = { whatYouCanDo: { carryOut: unknown; note?: string } };
const help = (feature: string) => hearthHelp({ feature }) as unknown as Help;

describe("Ember does things instead of handing the owner chores", () => {
  it("removing or bringing back a system is a plan Ember proposes", () => {
    const h = help("add-remove-system");
    expect(h.whatYouCanDo.carryOut).toMatchObject({
      tools: expect.arrayContaining(["propose_job"]),
      what: expect.stringMatching(/\/api\/services\/<id>\/remove[\s\S]*\/restore/),
    });
    expect(planRefusal("POST", "/api/services/overseerr/remove")).toBeUndefined();
    expect(planRefusal("POST", "/api/services/overseerr/restore")).toBeUndefined();
    expect(planRefusal("POST", "/api/watches/w1/restore")).toBeUndefined();
    // Backups and Ember's own permissions stay out of plans.
    expect(planRefusal("POST", "/api/backups/run")).toMatch(/Not even with your approval/);
    expect(planRefusal("POST", "/api/agent/disconnect")).toMatch(/Not even with your approval/);
  });

  it("no recorded route says check first, never 'the owner does it'; owner-only says why", () => {
    for (const id of ["navigation", "integrations", "network"]) {
      const h = help(id);
      expect(h.whatYouCanDo.carryOut).toBe("not recorded here (that is not a no)");
      expect(h.whatYouCanDo.note).toMatch(/check what hearth_api can read and change/);
      expect(h.whatYouCanDo.note).not.toMatch(/Explain only/);
    }
    const owner = help("full-access");
    expect(owner.whatYouCanDo.carryOut).toBe("no: only the owner");
    expect(owner.whatYouCanDo.note).toMatch(/Ember's own permission/);
  });
});

describe("briefs and watches (11-13)", () => {
  it("Ember sets them up when asked, but the channels they go to stay a plan", () => {
    expect(emberRefusal("POST", "/api/briefs")).toBeUndefined();
    expect(emberRefusal("PATCH", "/api/briefs/b1")).toBeUndefined();
    expect(emberRefusal("POST", "/api/briefs/b1/send")).toBeUndefined();
    expect(emberRefusal("PUT", "/api/notifications/channels/webhook")).toBeDefined();
    expect(help("briefs").whatYouCanDo.carryOut).toMatchObject({ tools: ["hearth_api"] });
  });
});

describe("another PC's Hearth, through the link, keeps the same rules", () => {
  it("Ember never reads another PC's vault or sign-in", () => {
    expect(emberRefusal("GET", "/api/on/abc123def0/vault/secrets")).toMatch(/owner's alone/);
    expect(emberRefusal("GET", "/api/on/abc123def0/auth/session")).toMatch(/owner's alone/);
    // Premium codes, grants and keys: never seen or made by Ember (11-13); the status reads.
    expect(emberRefusal("GET", "/api/premium/issuer/codes")).toMatch(/owner's alone/);
    expect(emberRefusal("POST", "/api/premium/issuer/grants")).toMatch(/owner's alone/);
    expect(emberRefusal("POST", "/api/premium/redeem")).toMatch(/owner's alone/);
    expect(planRefusal("POST", "/api/premium/issuer/codes", "{}")).toBeTruthy();
    expect(emberRefusal("GET", "/api/premium")).toBeUndefined();
    // Changes through the link follow the same list as here.
    expect(emberRefusal("POST", "/api/on/abc123def0/projects")).toBeUndefined();
    expect(emberRefusal("POST", "/api/on/abc123def0/settings")).toMatch(/plan the owner approves/);
    expect(planRefusal("POST", "/api/on/abc123def0/vault/secrets", "{}")).toMatch(
      /Not even with your approval/,
    );
    expect(planRefusal("POST", "/api/on/abc123def0/services/x/remove")).toBeUndefined();
  });
});

describe("the Lab Blueprint", () => {
  it("Ember reads it and writes notes; its folder, key, updates and import stay the owner's", () => {
    expect(emberRefusal("GET", "/api/blueprint/preview")).toBeUndefined();
    expect(emberRefusal("PUT", "/api/blueprint/notes")).toBeUndefined();
    for (const p of [
      "/api/blueprint/setup/start",
      "/api/blueprint/setup/confirm",
      "/api/blueprint/update",
      "/api/blueprint/test-key",
      "/api/blueprint/import/open",
      "/api/blueprint/import/apply",
    ])
      expect(planRefusal("POST", p, "{}")).toMatch(/Not even with your approval/);
    expect(planRefusal("DELETE", "/api/blueprint")).toMatch(/Not even with your approval/);
    expect(planRefusal("PUT", "/api/blueprint/notes", '{"notes":"x"}')).toBeUndefined();
  });
});

describe("a plan for a request Hearth has no route for", () => {
  const routes = [
    { method: "GET", url: "/api/home-rows" },
    { method: "PUT", url: "/api/home-rows/:id" },
    { method: "DELETE", url: "/api/home-rows/:id" },
  ];

  it("names the methods a real address takes", () => {
    expect(methodsAt(routes, "/api/home-rows/c5f1c3dd")).toEqual(["DELETE", "PUT"]);
    expect(methodsAt(routes, "/api/home-rows/c5f1c3dd/titles")).toEqual([]);
  });

  it("is refused when proposed, not after the owner approved it (11-15)", async () => {
    const self = new HearthSelf();
    self.bind(
      async () => ({ status: 200, body: {} }),
      (path) => methodsAt(routes, path),
    );
    const step = (method: string) => ({
      kind: "hearth-api-call",
      serviceId: "hearth",
      params: { method, path: "/api/home-rows/c5f1c3dd", body: '{"titles":["103"]}', why: "x" },
    });
    const wrong = await self.plan(step("PATCH") as never);
    expect(wrong.policy).toBe("refuse");
    expect(wrong.policyReason).toBe(
      "Hearth has no PATCH at /api/home-rows/c5f1c3dd. That address takes DELETE, PUT.",
    );
    expect((await self.plan(step("PUT") as never)).policy).toBe("approve-first");
  });
});
