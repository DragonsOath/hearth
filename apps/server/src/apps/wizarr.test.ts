import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeWizarr } from "./fake-wizarr";
import { readWizarr, wizarrDashboard, WizarrOperations } from "./wizarr";

/** Wizarr's panel and its two changes, against a stand-in that answers like Wizarr 2026.9. */

const BASE = "http://10.0.0.9:5690";
const KEY = "e2e-wizarr-key";
const service = { id: "wizarr", name: "Wizarr", localUrl: BASE };
// The broker hands the key to one call, as it does for real; audits go nowhere here.
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "Wizarr",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

describe("the Wizarr panel", () => {
  it("lists invitations with their links and status, users, servers, and libraries", async () => {
    const w = fakeWizarr();
    const d = await wizarrDashboard(w.fetch, BASE, KEY);
    expect(d.totals).toEqual({ users: 3, invites: 3, pending: 1, expired: 1, expiringSoon: 1 });
    expect(d.invites.find((i) => i.code === "SAM2026")).toMatchObject({
      status: "used",
      usedBy: "sam",
      duration: "30",
    });
    expect(d.invites.find((i) => i.code === "FAMILY7")!.url).toBe("http://wizarr.test/j/FAMILY7");
    expect(d.libraries.map((l) => l.name)).toEqual(["Movies", "TV Shows", "Old Movies"]);
    expect(d.libraries.find((l) => l.name === "Old Movies")!.serverId).toBe(0);
    // Wizarr gives bare /j/CODE links: Hearth adds the address.
    expect(d.invites.every((i) => /^https?:\/\//.test(i.url))).toBe(true);
    const r = await readWizarr(BASE, KEY, w.fetch);
    expect(r.facts).toContainEqual({ label: "Access ending this week", value: "1" });
  });

  it("says plainly when Wizarr refuses the key", async () => {
    await expect(wizarrDashboard(fakeWizarr().fetch, BASE, "wrong")).rejects.toThrow(
      /refused the API key/,
    );
  });
});

describe("Wizarr invitations as plan steps", () => {
  it("plans exactly what the invitation gives, creates it, and reports its link", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker, w.fetch);
    const planned = await ops.plan(
      "app-wizarr-invite",
      service,
      { libraryIds: "1", expiresInDays: 7, durationDays: 30 },
      base,
    );
    expect(planned.label).toBe(
      "Create an invitation in Wizarr (for Plex; libraries: Movies; link works 7 days; access lasts 30 days)",
    );
    const done = await ops.run(
      {
        kind: "app-wizarr-invite",
        serviceId: "wizarr",
        requestedBy: "you",
        params: planned.params,
      },
      service,
    );
    expect(done).toMatchObject({
      ok: true,
      result: expect.stringMatching(/Send this link: http:\/\/wizarr\.test\/j\/NEW4X$/),
    });
    expect((await wizarrDashboard(w.fetch, BASE, KEY)).totals.invites).toBe(4);
  });

  it("refuses odd lengths and missing libraries before anything is sent", async () => {
    const ops = new WizarrOperations(handle, broker, fakeWizarr().fetch);
    await expect(
      ops.plan("app-wizarr-invite", service, { expiresInDays: 3 }, base),
    ).rejects.toThrow(/1, 7, or 30 days/);
    await expect(
      ops.plan("app-wizarr-invite", service, { libraryIds: "42" }, base),
    ).rejects.toThrow(/not in Wizarr/);
  });

  it("deletes an unused invitation and checks it is gone; a used one is left alone", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker, w.fetch);
    await expect(
      ops.plan("app-wizarr-invite-delete", service, { invitationId: 2 }, base),
    ).rejects.toThrow(/already used by sam/);
    const planned = await ops.plan("app-wizarr-invite-delete", service, { invitationId: 3 }, base);
    const done = await ops.run(
      {
        kind: "app-wizarr-invite-delete",
        serviceId: "wizarr",
        requestedBy: "you",
        params: planned.params,
      },
      service,
    );
    expect(done).toMatchObject({
      ok: true,
      result: "Deleted invitation FAMILY7; Wizarr no longer lists it.",
    });
  });
});

describe("someone's access as plan steps", () => {
  const setup = () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker, w.fetch);
    const plan = (params: Record<string, string | number>) =>
      ops.plan("app-wizarr-user", service, params, base);
    const run = (planned: PlannedStep) =>
      ops.run(
        {
          kind: "app-wizarr-user",
          serviceId: "wizarr",
          requestedBy: "you",
          params: planned.params,
          change: planned.change,
        },
        service,
      );
    return { w, plan, run };
  };

  it("reads Wizarr's times without a zone as UTC", async () => {
    const d = await wizarrDashboard(fakeWizarr().fetch, BASE, KEY);
    const sam = d.users.find((u) => u.username === "sam")!;
    expect(sam.expires).toMatch(/Z$/);
    const days = (Date.parse(sam.expires!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(3.9);
    expect(days).toBeLessThan(4.1);
  });

  it("extends access once, reads it back, and a retry of the same plan does nothing", async () => {
    const { plan, run } = setup();
    const planned = await plan({ userId: 1, op: "extend", durationDays: 30 });
    expect(planned.change?.summary).toBe("Extend sam on Plex's access by 30 days");
    const done = await run(planned);
    expect(done.ok).toBe(true);
    expect(done.result).toMatch(/read back/);
    const again = await run(planned);
    expect(again).toMatchObject({ ok: false, stale: true });
    expect(again.result).toMatch(/changed since this was planned/);
  });

  it("sets an end date and clears it, each read back", async () => {
    const { plan, run } = setup();
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const dated = await run(await plan({ userId: 2, op: "end-date", endDate: future }));
    expect(dated).toMatchObject({ ok: true });
    expect(dated.result).toContain(future);
    const cleared = await run(await plan({ userId: 2, op: "no-end" }));
    expect(cleared).toMatchObject({
      ok: true,
      result: "alex's access has no end date now (read back).",
    });
    await expect(plan({ userId: 3, op: "no-end" })).rejects.toThrow(/already has no end date/);
    await expect(plan({ userId: 3, op: "end-date", endDate: "2020-01-01" })).rejects.toThrow(
      /in the future/,
    );
  });

  it("disabling says what Wizarr answered, not that it was checked, and warns about admin accounts", async () => {
    const { plan, run } = setup();
    const planned = await plan({ userId: 3, op: "disable" });
    expect(planned.change?.settings.map((s) => s.name)).toContain("Check first");
    const done = await run(planned);
    expect(done.ok).toBe(true);
    expect(done.result).toMatch(/could not read it back/);
  });

  it("removes someone, says their server account goes too, and a retry finds them gone", async () => {
    const { plan, run } = setup();
    const planned = await plan({ userId: 2, op: "remove" });
    expect(JSON.stringify(planned.change)).toMatch(/account deleted on Plex/);
    expect(await run(planned)).toMatchObject({
      ok: true,
      result: "Removed alex; Wizarr no longer lists them.",
    });
    expect(await run(planned)).toMatchObject({ ok: true, stale: true });
    await expect(plan({ userId: 2, op: "enable" })).rejects.toThrow(/no user #2/);
    await expect(plan({ userId: 1, op: "reset-password" })).rejects.toThrow(/Say what to do/);
  });

  it("limits an invitation to a linked library, and refuses one Wizarr would ignore", async () => {
    const { w } = setup();
    const ops = new WizarrOperations(handle, broker, w.fetch);
    const planned = await ops.plan("app-wizarr-invite", service, { libraryIds: "2" }, base);
    expect(planned.label).toContain("libraries: TV Shows");
    await expect(ops.plan("app-wizarr-invite", service, { libraryIds: "9" }, base)).rejects.toThrow(
      /has not linked Old Movies to a server/,
    );
  });
});
