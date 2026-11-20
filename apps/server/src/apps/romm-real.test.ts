import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { RommOperations, rommCover, rommDashboard, rommGame, rommGames } from "./romm";

/**
 * RomM against a real, disposable RomM 5.3 on an internal network with invented games and no
 * metadata providers (checklist 46.12): never one anyone uses. Skipped unless
 * HEARTH_ROMM_TEST_URL, HEARTH_ROMM_TEST_PASSWORD_FILE (its test administrator, hearth-admin) and
 * HEARTH_ROMM_TEST_TOKEN_FILE (a read-only API token) are set. Favourites it changes it puts back.
 */

const url = process.env.HEARTH_ROMM_TEST_URL ?? "";
const pwFile = process.env.HEARTH_ROMM_TEST_PASSWORD_FILE;
const tokenFile = process.env.HEARTH_ROMM_TEST_TOKEN_FILE;
const password = pwFile ? readFileSync(pwFile, "utf8").trim() : "";
const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
const live = Boolean(url && password && token);

const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const admin = { username: "hearth-admin", value: password };
const reader = { value: token };
const broker = {
  use: (_s: unknown, fn: (c: { value: string; username?: string }) => unknown) => fn(admin),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const svc = { id: "romm-test", name: "RomM", localUrl: url };
const ops = new RommOperations(handle, broker, f, 90_000);
const act = async (params: StepParams) => {
  const planned = await ops.plan(svc, params, base);
  const done = await ops.run(
    { kind: "app-romm-control", serviceId: svc.id, requestedBy: "you", params: planned.params },
    svc,
  );
  return { planned, done };
};

describe.skipIf(!live)("RomM against a real test instance", { timeout: 60_000 }, () => {
  it("reads the library with the administrator's login, and with a read-only token", async () => {
    const d = await rommDashboard(f, url, admin);
    expect(d.version).toMatch(/^5\./);
    expect(d.totals.games).toBeGreaterThanOrEqual(8);
    expect(d.platforms.map((p) => p.slug)).toEqual(
      expect.arrayContaining(["nes", "snes", "gba", "psx"]),
    );
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.canScan).toBe(true);
    const r = await rommDashboard(f, url, reader);
    expect(r.totals.games).toBe(d.totals.games);
    expect(r.canScan).toBe(false);
  });

  it("finds games by name, platform and order, and reads one game and its cover", async () => {
    const all = await rommGames(f, url, admin, { order: "name" });
    expect(all.total).toBeGreaterThanOrEqual(8);
    const names = all.items.map((g) => g.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const found = await rommGames(f, url, admin, { search: "lantern" });
    expect(found.items.map((g) => g.name)).toContain("Lantern Quest");
    const nes = (await rommDashboard(f, url, admin)).platforms.find((p) => p.slug === "nes")!;
    const onNes = await rommGames(f, url, admin, { platformId: nes.id });
    expect(onNes.items.every((g) => g.platformSlug === "nes")).toBe(true);
    const lantern = found.items.find((g) => g.name === "Lantern Quest")!;
    const g = await rommGame(f, url, admin, lantern.id);
    expect(g.files[0]?.name).toBe("Lantern Quest (USA).nes");
    expect(g.regions).toContain("USA");
    expect(g.cover).toBe(true);
    const cover = await rommCover(f, url, reader, lantern.id, "small");
    expect(cover?.type).toMatch(/^image\//);
    expect(cover!.bytes.byteLength).toBeGreaterThan(100);
  });

  it("adds a favourite and takes it away again, each read back", async () => {
    const { items } = await rommGames(f, url, admin, { search: "harbor" });
    const id = items[0]!.id;
    const add = await act({ op: "favorite", romId: id });
    expect(add.done.ok, add.done.result).toBe(true);
    expect((await rommGame(f, url, admin, id)).favorite).toBe(true);
    expect((await rommGames(f, url, admin, { favorites: true })).items.map((g) => g.id)).toContain(
      id,
    );
    const back = await act({ op: "unfavorite", romId: id });
    expect(back.done.ok, back.done.result).toBe(true);
    expect((await rommGame(f, url, admin, id)).favorite).toBe(false);
  }, 60_000);

  it("runs a quick scan of one platform over RomM's socket, and a token cannot scan", async () => {
    const nes = (await rommDashboard(f, url, admin)).platforms.find((p) => p.slug === "nes")!;
    const { planned, done } = await act({
      op: "scan",
      scanType: "quick",
      platformIds: String(nes.id),
    });
    expect(planned.label).toContain("Nintendo Entertainment System");
    expect(done.ok, done.result).toBe(true);
    expect(done.result).toMatch(/finished the scan|scanning/);
    const tokenOps = new RommOperations(
      handle,
      {
        use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn(reader),
      } as unknown as CredentialBroker,
      f,
    );
    await expect(tokenOps.plan(svc, { op: "scan" }, base)).rejects.toThrow(/administrator/);
  }, 150_000);
});
