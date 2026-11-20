import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeNextcloud } from "./fake-nextcloud";
import {
  form,
  forgetNextcloudChecks,
  nextcloudApps,
  nextcloudDashboard,
  readNextcloud,
  toUser,
} from "./nextcloud";
import { NextcloudOperations, parseQuota, runNextcloud } from "./nextcloud-control";

/**
 * Nextcloud against the stand-in (answering as a throwaway 35.0.2 did; nextcloud-real.test.ts runs
 * the same calls against a real one): what the panel reads, Hearth's own http request not counted
 * against Nextcloud, and every change as a plan read back and undone.
 */

const BASE = "http://10.0.0.9:11000";
const LOGIN = { username: "admin", password: "e2e-SECRET" };
const service = { id: "nc", name: "Nextcloud", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup(password = LOGIN.password) {
  const nc = fakeNextcloud();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: password, username: "admin" }),
  } as unknown as CredentialBroker;
  const ops = new NextcloudOperations(handle, broker, nc.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-nextcloud-control" as const,
    serviceId: "nc",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  return { nc, ops, go };
}

beforeEach(() => forgetNextcloudChecks());

describe("reading Nextcloud", () => {
  it("reads storage, accounts, jobs, apps and shares, and no password", async () => {
    const { nc } = setup();
    const d = await nextcloudDashboard(nc.fetch, BASE, LOGIN);
    expect(d).toMatchObject({
      app: "nextcloud",
      version: "35.0.2",
      maintenance: false,
      signedInAs: "admin",
      freeGb: 412,
      files: 48210,
      accounts: 3,
      disabledAccounts: 1,
      shares: { links: 5, linksNoPassword: 3 },
      system: {
        php: "8.5.12",
        database: "mysql 11.4.5",
        databaseMb: 700,
        memcache: "APCu",
        cpus: 4,
      },
      jobs: { mode: "ajax", health: "late" },
      apps: { installed: 5, updates: [{ id: "calendar", version: "6.1.0" }] },
      settings: { linksNeedPassword: false, linksAllowed: true },
    });
    expect(d.users.map((u) => [u.id, u.enabled, u.admin, u.quota])).toEqual([
      ["admin", true, true, "none"],
      ["guest", false, false, "1 GB"],
      ["sam", true, false, "10 GB"],
    ]);
    expect(d.users.find((u) => u.id === "guest")!.lastLogin).toBeUndefined();
    expect(d.groups).toEqual(["admin", "family"]);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  it("lists setup checks worst first, and Hearth's own http request only as information", async () => {
    const { nc } = setup();
    const d = await nextcloudDashboard(nc.fetch, BASE, LOGIN);
    expect(d.checks.map((c) => [c.id, c.level])).toEqual([
      ["CronInfo", "error"],
      ["MaintenanceWindowStart", "warning"],
      ["HttpsUrlGeneration", "info"],
      ["TwoFactorConfiguration", "info"],
    ]);
    expect(d.checks.find((c) => c.id === "HttpsUrlGeneration")!.hearthsOwn).toBe(true);
    // Over https the same check is Nextcloud's own problem.
    forgetNextcloudChecks();
    const https = await nextcloudDashboard(nc.fetch, "https://10.0.0.9:11000", LOGIN);
    expect(https.checks.find((c) => c.id === "HttpsUrlGeneration")!.level).toBe("error");
  });

  it("reports late background jobs and setup errors, and refuses a wrong password plainly", async () => {
    const { nc } = setup();
    const r = await readNextcloud(BASE, LOGIN, nc.fetch);
    expect(r.status).toBe("attention");
    expect(r.issues.map((i) => i.key)).toEqual(["jobs", "check:CronInfo"]);
    expect(r.issues[0]!.text).toMatch(/last ran 2 hours ago \(ajax mode\)/);
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { label: "Accounts", value: "3" },
        { label: "App updates", value: "1" },
        { label: "Links without a password", value: "3" },
      ]),
    );
    await expect(
      nextcloudDashboard(nc.fetch, BASE, { username: "admin", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });

  it("says when Nextcloud is in maintenance mode", async () => {
    const { nc } = setup();
    nc.maintenance(true);
    const r = await readNextcloud(BASE, LOGIN, nc.fetch);
    expect(r.status).toBe("failing");
    expect(r.issues[0]!.text).toMatch(/maintenance mode/);
  });

  it("lists apps with names, on first, and the update waiting", async () => {
    const { nc } = setup();
    const apps = await nextcloudApps(nc.fetch, BASE, LOGIN);
    expect(apps.map((a) => [a.id, a.enabled])).toEqual([
      ["calendar", true],
      ["files", true],
      ["serverinfo", true],
      ["photos", true],
      ["admin_audit", false],
    ]);
    expect(apps[0]).toMatchObject({ name: "Calendar", update: "6.1.0" });
  });

  it("turns sizes and forms into Nextcloud's words", () => {
    expect(parseQuota("5 GB")).toBe(5 * 1024 ** 3);
    expect(parseQuota("500mb")).toBe(500 * 1024 ** 2);
    expect(parseQuota("none")).toBe("none");
    expect(() => parseQuota("lots")).toThrow(/as a size/);
    expect(form({ groupid: "family", groups: ["a", "b"] })).toBe(
      "groupid=family&groups%5B%5D=a&groups%5B%5D=b",
    );
    expect(toUser({ id: "x", quota: { quota: -3, used: 5 } })).toMatchObject({
      name: "x",
      quota: "none",
      usedBytes: 5,
    });
  });
});

describe("changing Nextcloud", () => {
  it("turns an account off and back on, read back", async () => {
    const { go } = setup();
    const r = await go({ op: "user-disable", userId: "sam" });
    expect(r.planned.label).toBe(
      "Turn off the account Sam in Nextcloud (they cannot sign in or sync; their files stay)",
    );
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await r.undo())?.result).toBe("Sam can sign in again.");
    await expect(go({ op: "user-enable", userId: "sam" })).rejects.toThrow(/already on/);
  });

  it("never turns off Hearth's own account or takes it out of admin", async () => {
    const { go } = setup();
    await expect(go({ op: "user-disable", userId: "admin" })).rejects.toThrow(/lock Hearth out/);
    await expect(go({ op: "group-remove", userId: "admin", group: "admin" })).rejects.toThrow(
      /stays an administrator/,
    );
    await expect(go({ op: "user-disable", userId: "nobody" })).rejects.toThrow(/no account nobody/);
  });

  it("sets a quota, warns when they already use more, and puts the old one back", async () => {
    const { go, nc } = setup();
    const r = await go({ op: "user-quota", userId: "sam", value: "5 GB" });
    expect(r.planned.label).toBe(
      "Set Sam's storage in Nextcloud to 5 GB (they already use 9.6 GB, so they cannot add files)",
    );
    expect(r.outcome).toMatchObject({ ok: true, result: "Sam's storage is 5 GB." });
    await r.undo();
    const sam = (await nextcloudDashboard(nc.fetch, BASE, LOGIN)).users.find((u) => u.id === "sam");
    expect(sam!.quota).toBe("10 GB");
    expect((await go({ op: "user-quota", userId: "sam", value: "none" })).outcome.ok).toBe(true);
    await expect(go({ op: "user-quota", userId: "sam", value: "none" })).rejects.toThrow(
      /already has no limit/,
    );
  });

  it("adds to a group and takes out again, only existing groups", async () => {
    const { go } = setup();
    const r = await go({ op: "group-add", userId: "sam", group: "admin" });
    expect(r.planned.label).toBe("Add Sam to admin in Nextcloud: they become an administrator");
    expect(r.outcome.ok).toBe(true);
    expect((await r.undo())?.ok).toBe(true);
    await expect(go({ op: "group-add", userId: "sam", group: "nope" })).rejects.toThrow(
      /no group "nope"/,
    );
  });

  it("turns apps on and off, never one Hearth reads through", async () => {
    const { go } = setup();
    const r = await go({ op: "app-enable", appId: "admin_audit", appName: "Auditing / Logging" });
    expect(r.outcome).toMatchObject({ ok: true, result: "Auditing / Logging is on." });
    expect((await r.undo())?.ok).toBe(true);
    await expect(go({ op: "app-disable", appId: "serverinfo" })).rejects.toThrow(/stays on/);
    await expect(go({ op: "app-disable", appId: "admin_audit" })).rejects.toThrow(/already off/);
    await expect(go({ op: "app-disable", appId: "../x" })).rejects.toThrow(/app's id/);
  });

  it("changes how background jobs run and the sharing settings, and puts them back", async () => {
    const { go, nc } = setup();
    const j = await go({ op: "jobs-mode", value: "cron" });
    expect(j.planned.label).toContain("they stop until something calls cron.php");
    expect(j.outcome.ok).toBe(true);
    await j.undo();
    expect((await nextcloudDashboard(nc.fetch, BASE, LOGIN)).jobs.mode).toBe("ajax");
    const s = await go({ op: "setting", setting: "links-password", value: "on" });
    expect(s.outcome).toMatchObject({ ok: true, verified: true });
    expect((await nextcloudDashboard(nc.fetch, BASE, LOGIN)).settings.linksNeedPassword).toBe(true);
    await s.undo();
    const off = await go({ op: "setting", setting: "links-allowed", value: "off" });
    expect(off.planned.label).toContain("every existing public link stops working");
    await expect(go({ op: "setting", setting: "nope", value: "on" })).rejects.toThrow(/Choose/);
  });

  it("explains that an app password cannot change anything", async () => {
    const { nc } = setup("e2e-app-0123456789");
    const app = { username: "admin", password: "e2e-app-0123456789" };
    expect((await nextcloudDashboard(nc.fetch, BASE, app)).users).toHaveLength(3);
    await expect(
      runNextcloud(nc.fetch, BASE, app, { op: "user-disable", userId: "sam", name: "Sam" }),
    ).rejects.toThrow(/account's sign-in password/);
  });

  it("refuses a change that went stale before it ran", async () => {
    const { nc } = setup();
    const out = await runNextcloud(nc.fetch, BASE, LOGIN, {
      op: "user-quota",
      userId: "sam",
      value: String(2 * 1024 ** 3),
      before: String(3 * 1024 ** 3),
    });
    expect(out).toMatchObject({ ok: false, stale: true });
    nc.maintenance(true);
    expect(
      (await runNextcloud(nc.fetch, BASE, LOGIN, { op: "user-enable", userId: "guest" })).stale,
    ).toBe(true);
  });
});
