import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { authentikDashboard, readAuthentik } from "./authentik";
import { AuthentikOperations } from "./authentik-control";
import type { Fetch } from "./http";

/**
 * The same reads and changes as authentik.test.ts against a real Authentik: only a throwaway one
 * made for this, with a protected application, a second account "sam", and failed sign-ins made
 * through its own login flow. It runs only with HEARTH_AUTHENTIK_TEST_URL,
 * HEARTH_AUTHENTIK_TEST_KEY_FILE and HEARTH_AUTHENTIK_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_AUTHENTIK_TEST_URL ?? "";
const file = process.env.HEARTH_AUTHENTIK_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_AUTHENTIK_TEST_THROWAWAY === "yes");
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
  `a real, throwaway Authentik at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const token = run ? readFileSync(file!, "utf8").trim() : "";
    const service = { id: "real", name: "Authentik", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: token }),
    } as unknown as CredentialBroker;
    const ops = new AuthentikOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-authentik-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });

    it("reads sign-ins, failed sign-ins, people, apps, outposts, tasks and version, and no secret", async () => {
      const d = await authentikDashboard(realFetch, url, token);
      expect(d.version).toMatch(/^20\d\d\.\d+/);
      expect(d.failedCount).toBeGreaterThan(0);
      expect(d.failedSignIns[0]).toMatchObject({ username: "akadmin" });
      expect(d.users.map((u) => u.username)).toEqual(expect.arrayContaining(["akadmin", "sam"]));
      expect(d.users.some((u) => u.username.startsWith("ak-outpost-"))).toBe(false);
      expect(d.applications.find((a) => a.slug === "paperless")).toMatchObject({
        protects: "paperless.example.com",
        provider: "Proxy Provider",
      });
      expect(d.outposts.length).toBeGreaterThan(0);
      expect(d.workers).toBeGreaterThan(0);
      const text = JSON.stringify(d);
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/password|wrong-\d/i);
      expect((await readAuthentik(url, token, realFetch)).facts[1]).toMatchObject({
        label: "Failed today",
      });
      await expect(authentikDashboard(realFetch, url, "wrong-token")).rejects.toThrow(
        /refused the API token/,
      );
    });

    it("turns sam's account off and back on by undo, read back; never the token's own account", async () => {
      const d = await authentikDashboard(realFetch, url, token);
      const sam = d.users.find((u) => u.username === "sam")!;
      const planned = await ops.plan(service, { op: "user-off", userId: sam.id }, base);
      expect(planned.params).toMatchObject({ protected: "yes" });
      const off = await ops.run(step(planned.params), service);
      expect(off).toMatchObject({ ok: true, verified: true });
      expect(
        (await authentikDashboard(realFetch, url, token)).users.find((u) => u.id === sam.id)!
          .active,
      ).toBe(false);
      expect(await ops.undo(step(planned.params), service)).toMatchObject({
        ok: true,
        verified: true,
      });
      expect(
        (await authentikDashboard(realFetch, url, token)).users.find((u) => u.id === sam.id)!
          .active,
      ).toBe(true);
      const admin = d.users.find((u) => u.username === "akadmin")!;
      await expect(ops.plan(service, { op: "user-off", userId: admin.id }, base)).rejects.toThrow(
        /Hearth's token belongs to/,
      );
    });
  },
);
