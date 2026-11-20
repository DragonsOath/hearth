import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { nzbgetDashboard, nzbgetHistory, nzbgetJobFiles, readNzbget } from "./nzbget";
import { NzbgetOperations } from "./nzbget-control";

/**
 * NZBGet against a real, throwaway NZBGet (a container made for this, with no news server, so the
 * test NZBs stay queued, and one deleted and marked bad in its history). It changes that NZBGet,
 * so it runs only when HEARTH_NZBGET_TEST_URL, HEARTH_NZBGET_TEST_LOGIN_FILE ("username:password")
 * and HEARTH_NZBGET_TEST_THROWAWAY=yes are set. HEARTH_NZBGET_TEST_NZB names an .nzb it may add (one not already in that NZBGet).
 */

const url = process.env.HEARTH_NZBGET_TEST_URL;
const loginFile = process.env.HEARTH_NZBGET_TEST_LOGIN_FILE;
const throwaway = process.env.HEARTH_NZBGET_TEST_THROWAWAY === "yes";
const [username = "", password = ""] = loginFile
  ? readFileSync(loginFile, "utf8").trim().split(":")
  : [];
const login = { username, password };
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const service = { id: "nz", name: "NZBGet", localUrl: url ?? "" };
const broker = {
  use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
    fn({ value: password, username }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const ops = new NzbgetOperations(handle, broker, f);
const go = async (params: PlannedStep["params"]) => {
  const planned = await ops.plan(service, params, base);
  const outcome = await ops.run(
    { kind: "app-nzbget-control", serviceId: "nz", requestedBy: "you", params: planned.params! },
    service,
  );
  return { planned, outcome };
};

describe.skipIf(!(url && loginFile && throwaway))("NZBGet against a throwaway NZBGet", () => {
  it("reads the queue, history, files, warnings and health, with no password", async () => {
    const d = await nzbgetDashboard(f, url!, login);
    expect(d.version).toMatch(/^\d+/);
    expect(d.queue.map((j) => j.name)).toEqual(expect.arrayContaining(["Hearth.Test.1"]));
    expect(d.categories).toEqual(expect.arrayContaining(["Movies"]));
    const bad = d.history.find((h) => h.name === "Hearth.Test.3")!;
    expect(bad).toMatchObject({ failed: true, why: "marked bad" });
    // No news server is set up in the throwaway: NZBGet's own health check says so.
    expect(d.warnings.join(" ")).toMatch(/servers/i);
    const files = await nzbgetJobFiles(f, url!, login, d.queue[0]!.id);
    expect(files.length).toBe(2);
    expect((await nzbgetHistory(f, url!, login, { failedOnly: true })).items[0]!.name).toBe(
      "Hearth.Test.3",
    );
    const r = await readNzbget(url!, login, f);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify([d, r])).not.toContain(password);
  }, 60_000);

  it("pauses and resumes everything and one download, read back", async () => {
    const d = await nzbgetDashboard(f, url!, login);
    if (d.paused) expect((await go({ op: "resume-all" })).outcome.ok).toBe(true);
    expect((await go({ op: "pause-all" })).outcome).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "resume-all" })).outcome).toMatchObject({ ok: true, verified: true });
    const id = (await nzbgetDashboard(f, url!, login)).queue.find(
      (j) => j.name === "Hearth.Test.2",
    )!.id;
    const now = (await nzbgetDashboard(f, url!, login)).queue.find((j) => j.id === id)!;
    const first = /paused/i.test(now.status) ? "resume" : "pause";
    expect((await go({ op: first, nzoId: id })).outcome).toMatchObject({ ok: true });
    expect((await go({ op: first === "pause" ? "resume" : "pause", nzoId: id })).outcome.ok).toBe(
      true,
    );
  }, 60_000);

  it("sets a speed limit and takes it off, pauses for a while", async () => {
    expect((await go({ op: "speed-limit", value: "2048" })).outcome).toMatchObject({ ok: true });
    expect((await go({ op: "speed-limit", value: "0" })).outcome).toMatchObject({ ok: true });
    expect((await go({ op: "pause-for", value: "15" })).outcome).toMatchObject({ ok: true });
    const d = await nzbgetDashboard(f, url!, login);
    expect(d.pausedMinutes).toBeGreaterThan(10);
    expect((await go({ op: "resume-all" })).outcome.ok).toBe(true);
  }, 60_000);

  it("changes priority, place and category, read back", async () => {
    const d = await nzbgetDashboard(f, url!, login);
    const j = d.queue.find((x) => x.name === "Hearth.Test.1")!;
    const want = j.priority === "High" ? "low" : "high";
    expect((await go({ op: "priority", nzoId: j.id, value: want })).outcome).toMatchObject({
      ok: true,
    });
    const at = d.queue.findIndex((x) => x.id === j.id);
    expect(
      (await go({ op: "move", nzoId: j.id, value: String(at === 0 ? 1 : 0) })).outcome.ok,
    ).toBe(true);
    const cat = j.category === "Movies" ? "Series" : "Movies";
    expect((await go({ op: "category", nzoId: j.id, category: cat })).outcome.ok).toBe(true);
  }, 60_000);

  it("retries the failed one, removes it, and adds an NZB (twice counts once)", async () => {
    const d = await nzbgetDashboard(f, url!, login);
    const bad = d.history.find((h) => h.name === "Hearth.Test.3" && h.failed);
    if (bad) {
      expect((await go({ op: "retry", nzoId: bad.id })).outcome).toMatchObject({ ok: true });
      const back = (await nzbgetDashboard(f, url!, login)).queue.find(
        (j) => j.name === "Hearth.Test.3",
      )!;
      expect((await go({ op: "remove", nzoId: back.id })).outcome.ok).toBe(true);
      const gone = (await nzbgetDashboard(f, url!, login)).history.find(
        (h) => h.name === "Hearth.Test.3",
      )!;
      expect((await go({ op: "remove-history", nzoId: gone.id })).outcome.ok).toBe(true);
    }
    if (process.env.HEARTH_NZBGET_TEST_NZB) {
      const data = readFileSync(process.env.HEARTH_NZBGET_TEST_NZB).toString("base64");
      const add = {
        op: "add",
        files: JSON.stringify([{ name: "Hearth.Extra.nzb", data }]),
        category: "Movies",
        paused: true,
      };
      expect((await go(add)).outcome).toMatchObject({ ok: true, verified: true });
      await expect(go(add)).rejects.toThrow(/already in the queue/);
    }
  }, 60_000);
});
