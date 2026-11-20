import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import {
  forgetNextcloudChecks,
  nextcloudApps,
  nextcloudDashboard,
  ocs,
  readNextcloud,
} from "./nextcloud";
import { NextcloudOperations, runNextcloud } from "./nextcloud-control";

/**
 * The same reads and changes as nextcloud.test.ts against a real Nextcloud: only a throwaway one
 * made for this, with its administrator "admin", a second account "alice" and a group "family".
 * It runs only with HEARTH_NEXTCLOUD_TEST_URL, HEARTH_NEXTCLOUD_TEST_PASSWORD_FILE and
 * HEARTH_NEXTCLOUD_TEST_THROWAWAY=yes, and puts back everything it changes.
 */

const url = process.env.HEARTH_NEXTCLOUD_TEST_URL ?? "";
const file = process.env.HEARTH_NEXTCLOUD_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_NEXTCLOUD_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Nextcloud at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const login = { username: "admin", password: run ? readFileSync(file!, "utf8").trim() : "" };
    const service = { id: "real", name: "Nextcloud", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
        fn({ value: login.password, username: login.username }),
    } as unknown as CredentialBroker;
    const ops = new NextcloudOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-nextcloud-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      const outcome = await ops.run(step(planned.params), service);
      return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
    };

    it("reads storage, accounts, jobs, apps and setup checks, and never the password", async () => {
      forgetNextcloudChecks();
      const d = await nextcloudDashboard(realFetch, url, login);
      expect(d.version).toMatch(/^\d+\.\d+/);
      expect(d.maintenance).toBe(false);
      expect(d.signedInAs).toBe("admin");
      expect(d.accounts).toBeGreaterThanOrEqual(2);
      expect(d.freeGb).toBeGreaterThan(0);
      expect(d.users.map((u) => u.id)).toEqual(expect.arrayContaining(["admin", "alice"]));
      expect(d.users.find((u) => u.id === "admin")).toMatchObject({ admin: true, enabled: true });
      expect(d.groups).toEqual(expect.arrayContaining(["admin", "family"]));
      expect(d.apps.installed).toBeGreaterThan(10);
      expect(["ajax", "webcron", "cron"]).toContain(d.jobs.mode);
      expect(d.system.php).toMatch(/^\d/);
      expect(d.checks.length).toBeGreaterThan(0);
      // Hearth's own plain http request is not counted against Nextcloud.
      expect(d.checks.find((c) => c.id === "HttpsUrlGeneration")).toMatchObject({
        level: "info",
        hearthsOwn: true,
      });
      expect(JSON.stringify(d)).not.toContain(login.password);
      const r = await readNextcloud(url, login, realFetch);
      expect(r.facts.map((f) => f.label)).toContain("Accounts");
      expect(r.issues.some((i) => i.key === "check:HttpsUrlGeneration")).toBe(false);
    });

    it("lists the apps with their names", async () => {
      const apps = await nextcloudApps(realFetch, url, login);
      expect(apps.find((a) => a.id === "files")).toMatchObject({ enabled: true, name: "Files" });
      expect(apps.some((a) => !a.enabled)).toBe(true);
    });

    it("turns an account off and on, read back, and never Hearth's own or the last admin", async () => {
      const off = await go({ op: "user-disable", userId: "alice" }).catch(async () => {
        // A run before left it off: turn it on first.
        await go({ op: "user-enable", userId: "alice" });
        return go({ op: "user-disable", userId: "alice" });
      });
      expect(off.outcome).toMatchObject({ ok: true, verified: true });
      expect((await off.undo())?.ok).toBe(true);
      await expect(go({ op: "user-disable", userId: "admin" })).rejects.toThrow(/lock Hearth out/);
      await expect(go({ op: "group-remove", userId: "admin", group: "admin" })).rejects.toThrow(
        /stays an administrator/,
      );
    });

    it("sets a quota and puts the old one back", async () => {
      const before = (await nextcloudDashboard(realFetch, url, login)).users.find(
        (u) => u.id === "alice",
      )!;
      const want = before.quotaBytes === 3 * 1024 ** 3 ? "2 GB" : "3 GB";
      const r = await go({ op: "user-quota", userId: "alice", value: want });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect(r.outcome.result).toContain(want);
      expect((await r.undo())?.ok).toBe(true);
      const after = (await nextcloudDashboard(realFetch, url, login)).users.find(
        (u) => u.id === "alice",
      )!;
      expect(after.quotaBytes).toBe(before.quotaBytes);
    });

    it("adds an account to a group and takes it out on undo", async () => {
      const inIt = (await nextcloudDashboard(realFetch, url, login)).users
        .find((u) => u.id === "alice")!
        .groups.includes("family");
      const r = await go({
        op: inIt ? "group-remove" : "group-add",
        userId: "alice",
        group: "family",
      });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect((await r.undo())?.ok).toBe(true);
      await expect(go({ op: "group-add", userId: "alice", group: "nope" })).rejects.toThrow(
        /no group "nope"/,
      );
    });

    it("turns an app off and on, and never one Hearth reads through", async () => {
      const r = await go({
        op: "app-enable",
        appId: "admin_audit",
        appName: "Auditing / Logging",
      }).catch(() => go({ op: "app-disable", appId: "admin_audit" }));
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect((await r.undo())?.ok).toBe(true);
      await expect(go({ op: "app-disable", appId: "serverinfo" })).rejects.toThrow(/stays on/);
    });

    it("changes how background jobs run and a sharing setting, and puts them back", async () => {
      const d = await nextcloudDashboard(realFetch, url, login);
      const r = await go({ op: "jobs-mode", value: d.jobs.mode === "cron" ? "ajax" : "cron" });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect((await r.undo())?.ok).toBe(true);
      expect((await nextcloudDashboard(realFetch, url, login)).jobs.mode).toBe(d.jobs.mode);
      const s = await go({
        op: "setting",
        setting: "links-password",
        value: d.settings.linksNeedPassword ? "off" : "on",
      });
      expect(s.outcome).toMatchObject({ ok: true, verified: true });
      expect((await s.undo())?.ok).toBe(true);
      expect((await nextcloudDashboard(realFetch, url, login)).settings).toEqual(d.settings);
    });

    it("reads with an app password and says plainly that changes need the account's own", async () => {
      const made = await ocs<{ apppassword?: string }>(
        realFetch,
        url,
        login,
        "GET",
        "/ocs/v2.php/core/getapppassword",
      );
      const app = { username: "admin", password: String(made?.apppassword) };
      expect((await nextcloudDashboard(realFetch, url, app)).users.length).toBeGreaterThan(1);
      await expect(
        runNextcloud(realFetch, url, app, {
          op: "user-quota",
          userId: "alice",
          value: "4294967296",
        }),
      ).rejects.toThrow(/account's sign-in password/);
      await expect(
        nextcloudDashboard(realFetch, url, { username: "admin", password: "wrong" }),
      ).rejects.toThrow(/refused the username or password/);
    });
  },
);
