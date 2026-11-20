import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import {
  forgetNavidromeSessions,
  navidromeDashboard,
  nd,
  readNavidrome,
  subsonic,
} from "./navidrome";
import { NavidromeOperations } from "./navidrome-control";

/**
 * The same reads and changes as navidrome.test.ts against a real Navidrome: only a throwaway one made
 * for this, with its first user "admin", a few songs, and one song whose file was moved away after
 * a scan (a missing file). It runs only with HEARTH_NAVIDROME_TEST_URL,
 * HEARTH_NAVIDROME_TEST_PASSWORD_FILE and HEARTH_NAVIDROME_TEST_THROWAWAY=yes. It adds a user and
 * removes it again, and forgets the missing file.
 */

const url = process.env.HEARTH_NAVIDROME_TEST_URL ?? "";
const file = process.env.HEARTH_NAVIDROME_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_NAVIDROME_TEST_THROWAWAY === "yes");
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
  `a real, throwaway Navidrome at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const login = { username: "admin", password: run ? readFileSync(file!, "utf8").trim() : "" };
    const service = { id: "real", name: "Navidrome", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
        fn({ value: login.password, username: login.username }),
    } as unknown as CredentialBroker;
    const ops = new NavidromeOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-navidrome-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      const outcome = await ops.run(step(planned.params), service);
      return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
    };

    it("reads the library, scan, users, players and missing files, and who is listening", async () => {
      // Say a song is playing, as a music app does.
      const song = (
        await nd<{ id: string; missing?: boolean }[]>(
          realFetch,
          url,
          login,
          "GET",
          "/api/song?_end=10",
        )
      ).data.find((s) => !s.missing)!;
      await subsonic(realFetch, url, login, "scrobble", { id: song.id, submission: "false" });
      const d = await navidromeDashboard(realFetch, url, login);
      expect(d.version).toMatch(/^\d+\.\d+/);
      expect(d.libraries[0]!.songs).toBeGreaterThan(0);
      expect(d.users.some((u) => u.userName === "admin" && u.admin)).toBe(true);
      expect(d.nowPlaying[0]).toMatchObject({ user: "admin" });
      expect(d.players.length).toBeGreaterThan(0);
      expect(d.missingCount).toBeGreaterThan(0);
      expect(JSON.stringify(d)).not.toContain(login.password);
      const r = await readNavidrome(url, login, realFetch);
      expect(r.issues.map((i) => i.key)).toContain("missing");
    });

    it("scans, forgets the missing file, and toggles and removes a user", async () => {
      expect((await go({ op: "scan" })).outcome.ok).toBe(true);
      const f = await go({ op: "forget-missing" });
      expect(f.outcome).toMatchObject({ ok: true, verified: true });
      await nd(realFetch, url, login, "POST", "/api/user", {
        userName: "hearthtest",
        name: "Hearth test",
        email: "",
        password: "e2e-Test-Pass-77",
        isAdmin: false,
      });
      const id = (await navidromeDashboard(realFetch, url, login)).users.find(
        (u) => u.userName === "hearthtest",
      )!.id;
      const a = await go({ op: "admin-on", userId: id });
      expect(a.outcome).toMatchObject({ ok: true, verified: true });
      expect((await a.undo())?.ok).toBe(true);
      const me = (await navidromeDashboard(realFetch, url, login)).users.find(
        (u) => u.userName === "admin",
      )!.id;
      await expect(go({ op: "admin-off", userId: me })).rejects.toThrow(/stays an administrator/);
      const rm = await go({ op: "remove-user", userId: id });
      expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    });

    it("refuses a wrong password plainly, once", async () => {
      forgetNavidromeSessions();
      await expect(
        navidromeDashboard(realFetch, url, { username: "admin", password: "wrong" }),
      ).rejects.toThrow(/refused the username or password/);
    });
  },
);
