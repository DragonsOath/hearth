import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { DelugeLive, readDeluge } from "./deluge";
import { DelugeOperations } from "./deluge-control";
import type { Fetch } from "./http";

/**
 * Deluge against a real, throwaway Deluge 2.x (a container made for this, with generated test
 * torrents). It changes that Deluge, so it runs only when HEARTH_DELUGE_TEST_URL,
 * HEARTH_DELUGE_TEST_PASSWORD_FILE and HEARTH_DELUGE_TEST_THROWAWAY=yes are set, and it refuses a
 * Deluge with more than 20 torrents. HEARTH_DELUGE_TEST_TORRENT names a .torrent file it may add.
 */

const url = process.env.HEARTH_DELUGE_TEST_URL;
const pwFile = process.env.HEARTH_DELUGE_TEST_PASSWORD_FILE;
const throwaway = process.env.HEARTH_DELUGE_TEST_THROWAWAY === "yes";
const password = pwFile ? readFileSync(pwFile, "utf8").trim() : "";
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const service = { id: "dl", name: "Deluge", localUrl: url ?? "" };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: password }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const ops = new DelugeOperations(handle, broker, f);
const go = async (params: PlannedStep["params"]) => {
  const planned = await ops.plan(service, params, base);
  const outcome = await ops.run(
    { kind: "app-deluge-control", serviceId: "dl", requestedBy: "you", params: planned.params! },
    service,
  );
  return { planned, outcome };
};

describe.skipIf(!(url && password && throwaway))("Deluge against a throwaway Deluge", () => {
  it("reads health, the live dashboard, one torrent in depth, and settings", async () => {
    const live = new DelugeLive(f);
    const d = await live.dashboard("dl", url!, password);
    expect(d.torrents.length).toBeLessThanOrEqual(20);
    console.log(
      JSON.stringify({
        version: d.version,
        labels: d.labelsEnabled,
        torrents: d.torrents.map((t) => [t.name, t.status, t.progressPct, t.category, t.tracker]),
      }),
    );
    expect(d.app).toBe("deluge");
    expect(d.version).toMatch(/^2\./);
    const t = d.torrents[0]!;
    const detail = await live.detail("dl", url!, password, t.hash, { files: true, peers: true });
    expect(detail.files?.length).toBeGreaterThan(0);
    // Tracker hosts only: never the announce address with its passkey.
    expect(JSON.stringify(detail.trackers)).not.toMatch(/passkey|SECRET/);
    const settings = await live.settings("dl", url!, password);
    expect(settings.settings.map((x) => x.key)).toContain("max_download_speed");
    // Never the proxy (it holds a password).
    expect(JSON.stringify(settings)).not.toMatch(/proxy|"password"/);
    const report = await readDeluge(url!, password, f);
    expect(report.app).toBe("deluge");
    await expect(readDeluge(url!, "wrong-password", f)).rejects.toThrow(
      /refused the Web UI password/,
    );
  });

  it("pauses, resumes, labels, sets file priorities and settings, each read back", async () => {
    const live = new DelugeLive(f);
    const d = await live.dashboard("dl", url!, password);
    const t = d.torrents.find((x) => x.status !== "seeding") ?? d.torrents[0]!;
    if (!d.labelsEnabled)
      expect((await go({ op: "labels-on" })).outcome).toMatchObject({ ok: true });
    const settingsNow = await live.settings("dl", url!, password);
    if (!settingsNow.categories.some((c) => c.name === "hearth-test"))
      expect((await go({ op: "label-create", category: "hearth-test" })).outcome).toMatchObject({
        ok: true,
      });
    expect((await go({ op: "pause", hash: t.hash })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "resume", hash: t.hash })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(
      (await go({ op: "label", hash: t.hash, category: "hearth-test" })).outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "label", hash: t.hash, category: "" })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(
      (await go({ op: "file-priority", hash: t.hash, fileIndexes: "0", filePriority: 6 })).outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect(
      (await go({ op: "file-priority", hash: t.hash, fileIndexes: "0", filePriority: 1 })).outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "recheck", hash: t.hash })).outcome).toMatchObject({ ok: true });
    expect((await go({ op: "reannounce", hash: t.hash })).outcome).toMatchObject({ ok: true });
    const was = (await live.settings("dl", url!, password)).settings.find(
      (x) => x.key === "max_active_downloading",
    )!.value as number;
    expect(
      (await go({ op: "settings", body: JSON.stringify({ max_active_downloading: was + 1 }) }))
        .outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect(
      (await go({ op: "settings", body: JSON.stringify({ max_active_downloading: was }) })).outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "label-delete", category: "hearth-test" })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
  }, 60_000);

  it("adds a .torrent file, then removes it keeping its files", async () => {
    const file = process.env.HEARTH_DELUGE_TEST_TORRENT;
    if (!file) return;
    const body = readFileSync(file).toString("base64");
    const added = await go({
      op: "add",
      files: JSON.stringify([{ name: "added.torrent", data: body }]),
      paused: true,
    });
    expect(added.outcome, added.outcome.result).toMatchObject({ ok: true, verified: true });
    const d = await new DelugeLive(f).dashboard("dl2", url!, password);
    const t = d.torrents.find((x) => x.name.startsWith("Added."));
    expect(t?.state).toBe("Paused");
    expect((await go({ op: "remove", hash: t!.hash })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
  }, 60_000);
});
