import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { readTransmission, TransmissionLive } from "./transmission";
import { TransmissionOperations } from "./transmission-control";

/**
 * Transmission against a real, throwaway Transmission (a container made for this, with generated
 * test torrents whose tracker address carries a made-up passkey). It changes that Transmission, so
 * it runs only when HEARTH_TRANSMISSION_TEST_URL, HEARTH_TRANSMISSION_TEST_LOGIN_FILE (a file with
 * "username:password") and HEARTH_TRANSMISSION_TEST_THROWAWAY=yes are set, and it refuses one with
 * more than 20 torrents. HEARTH_TRANSMISSION_TEST_TORRENT names a .torrent file it may add.
 */

const url = process.env.HEARTH_TRANSMISSION_TEST_URL;
const loginFile = process.env.HEARTH_TRANSMISSION_TEST_LOGIN_FILE;
const throwaway = process.env.HEARTH_TRANSMISSION_TEST_THROWAWAY === "yes";
const [username = "", password = ""] = loginFile
  ? readFileSync(loginFile, "utf8").trim().split(":")
  : [];
const login = { username, password };
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const service = { id: "tr", name: "Transmission", localUrl: url ?? "" };
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
const ops = new TransmissionOperations(handle, broker, f);
const go = async (params: PlannedStep["params"]) => {
  const planned = await ops.plan(service, params, base);
  const outcome = await ops.run(
    {
      kind: "app-transmission-control",
      serviceId: "tr",
      requestedBy: "you",
      params: planned.params!,
    },
    service,
  );
  return { planned, outcome };
};

describe.skipIf(!(url && loginFile && throwaway))(
  "Transmission against a throwaway Transmission",
  () => {
    const live = new TransmissionLive(f);

    it("reads health, the live dashboard, one torrent in depth, and settings, with no passkey", async () => {
      const d = await live.dashboard("tr", url!, login);
      expect(d.torrents.length).toBeLessThanOrEqual(20);
      expect(d.app).toBe("transmission");
      expect(d.version).toMatch(/^[34]\./);
      const t = d.torrents.find((x) => x.name === "Hearth Test 1")!;
      expect(t.tracker).toBe("tracker.invalid");
      expect(t.category).toBe("tv");
      const detail = await live.detail("tr", url!, login, t.hash, { files: true, peers: true });
      expect(detail.files).toHaveLength(2);
      expect(detail.trackers[0]!.host).toBe("tracker.invalid");
      const s = await live.settings("tr", url!, login);
      expect(s.settings.some((x) => x.key === "seedRatioLimit")).toBe(true);
      expect(s.categories).toContainEqual({ name: "tv" });
      const report = await readTransmission(url!, login, f);
      expect(report.facts[0]!.label).toBe("Down / up");
      // The made-up passkey in the tracker address never comes through.
      expect(JSON.stringify([d, detail, s, report])).not.toContain("SECRETPASSKEY");
    }, 60_000);

    it("refuses a wrong password plainly", async () => {
      const wrong = new TransmissionLive(f);
      await expect(wrong.dashboard("tr2", url!, { username, password: "not-it" })).rejects.toThrow(
        /refused the username or password/,
      );
    });

    it("pauses and resumes, labels, sets file priority, rechecks and reannounces, read back", async () => {
      const d = await live.dashboard("tr", url!, login);
      const t = d.torrents.find((x) => x.name === "Hearth Test 2")!;
      expect((await go({ op: "pause", hash: t.hash })).outcome).toMatchObject({ ok: true });
      expect((await go({ op: "resume", hash: t.hash })).outcome).toMatchObject({ ok: true });
      expect((await go({ op: "label", hash: t.hash, category: "movies" })).outcome).toMatchObject({
        ok: true,
        result: expect.stringContaining("the label movies"),
      });
      expect((await go({ op: "label", hash: t.hash, category: "tv" })).outcome.ok).toBe(true);
      expect(
        (await go({ op: "file-priority", hash: t.hash, fileIndexes: "1", filePriority: 0 }))
          .outcome,
      ).toMatchObject({ ok: true });
      expect(
        (await go({ op: "file-priority", hash: t.hash, fileIndexes: "1", filePriority: 6 }))
          .outcome,
      ).toMatchObject({ ok: true });
      expect((await go({ op: "recheck", hash: t.hash })).outcome.ok).toBe(true);
      expect((await go({ op: "reannounce", hash: t.hash })).outcome.ok).toBe(true);
    }, 60_000);

    it("changes a seeding setting and puts it back", async () => {
      const s = await live.settings("tr", url!, login);
      const was = s.settings.find((x) => x.key === "seedRatioLimit")!.value as number;
      const r = await go({ op: "settings", body: JSON.stringify({ seedRatioLimit: was + 1 }) });
      expect(r.planned.change?.settings[0]).toMatchObject({ name: "Share ratio to stop at" });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect(
        (await go({ op: "settings", body: JSON.stringify({ seedRatioLimit: was }) })).outcome.ok,
      ).toBe(true);
    }, 60_000);

    it.skipIf(!process.env.HEARTH_TRANSMISSION_TEST_TORRENT)(
      "adds a .torrent paused (twice counts once), then removes it keeping its files",
      async () => {
        const data = readFileSync(process.env.HEARTH_TRANSMISSION_TEST_TORRENT!).toString("base64");
        const add = { op: "add", body: data, name: "extra.torrent", paused: true, category: "tv" };
        expect((await go(add)).outcome).toMatchObject({ ok: true });
        expect((await go(add)).outcome).toMatchObject({ ok: true });
        const d = await live.dashboard("tr", url!, login);
        const t = d.torrents.find((x) => x.name === "Hearth Test 3")!;
        expect(t.status).toBe("paused");
        expect((await go({ op: "remove", hash: t.hash })).outcome).toMatchObject({ ok: true });
      },
      60_000,
    );
  },
);
