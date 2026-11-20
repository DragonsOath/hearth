import { describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeRomm } from "./fake-romm";
import {
  readRomm,
  RommOperations,
  rommCover,
  rommDashboard,
  rommGame,
  rommGames,
  type RommCredential,
} from "./romm";

/** RomM's panel and controls, against a stand-in that answers like RomM 5.3. */

const BASE = "http://10.0.0.9:8095";
const admin: RommCredential = { username: "hearth", value: "e2e-romm" };
const viewer: RommCredential = { username: "e2e-viewer", value: "e2e-romm" };
const token: RommCredential = { value: "e2e-token" };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const svc = { id: "romm", name: "RomM", localUrl: BASE };
const opsFor = (cred: RommCredential, romm = fakeRomm()) =>
  new RommOperations(
    handle,
    {
      use: (_s: unknown, fn: (c: RommCredential) => unknown) => fn(cred),
    } as unknown as CredentialBroker,
    romm.fetch,
    5_000,
  );
const act = async (ops: RommOperations, params: StepParams) => {
  const planned = await ops.plan(svc, params, base);
  return {
    planned,
    done: await ops.run(
      { kind: "app-romm-control", serviceId: "romm", requestedBy: "you", params: planned.params },
      svc,
    ),
  };
};

describe("the RomM panel", () => {
  it("reads totals, platforms (most games first), recently added and favourites", async () => {
    const d = await rommDashboard(fakeRomm().fetch, BASE, admin);
    expect(d).toMatchObject({ version: "5.3.1", canScan: true, unidentified: 2 });
    expect(d.totals).toMatchObject({ platforms: 4, games: 8 });
    expect(d.platforms[0]).toMatchObject({ slug: "nes", games: 3 });
    expect(d.recent[0]).toMatchObject({ name: "Silent Ferry", year: 1998, cover: true });
    expect(d.favorites.map((g) => g.name)).toEqual(["Lantern Quest"]);
  });

  it("a viewer or a token can read, not scan; a wrong password says so", async () => {
    expect((await rommDashboard(fakeRomm().fetch, BASE, viewer)).canScan).toBe(false);
    expect((await rommDashboard(fakeRomm().fetch, BASE, token)).canScan).toBe(false);
    await expect(
      rommDashboard(fakeRomm().fetch, BASE, { username: "hearth", value: "wrong" }),
    ).rejects.toThrow("RomM refused the username or password");
    expect(await readRomm(BASE, admin, fakeRomm().fetch)).toMatchObject({
      app: "romm",
      status: "ok",
      facts: expect.arrayContaining([{ label: "Games", value: "8" }]),
    });
  });

  it("finds games by name, platform, genre and favourites, in order", async () => {
    const f = fakeRomm().fetch;
    expect(
      (await rommGames(f, BASE, admin, { search: "lantern" })).items.map((g) => g.name),
    ).toEqual(["Lantern Quest"]);
    const nes = await rommGames(f, BASE, admin, { platformId: 2, order: "name" });
    expect(nes.items.map((g) => g.name)).toEqual(["Copper Comet", "Lantern Quest", "Moss Knight"]);
    expect((await rommGames(f, BASE, admin, { genre: "Racing" })).items[0]?.name).toBe(
      "Harbor Lights",
    );
    expect((await rommGames(f, BASE, admin, { favorites: true })).items[0]?.favorite).toBe(true);
    expect((await rommGames(f, BASE, admin)).genres).toContain("Adventure");
  });

  it("reads one game's page and its cover, and no cover where it has none", async () => {
    const f = fakeRomm().fetch;
    const g = await rommGame(f, BASE, admin, 4);
    expect(g).toMatchObject({
      name: "Lantern Quest",
      platform: "Nintendo Entertainment System",
      genres: ["Adventure", "Role-playing (RPG)"],
      developers: ["Ember Works"],
      favorite: true,
      path: "/rom/4",
      files: [{ name: "Lantern Quest (USA).nes", sizeBytes: 40_976 }],
    });
    expect((await rommCover(f, BASE, token, 4, "small"))?.type).toBe("image/png");
    expect(await rommCover(f, BASE, token, 3, "small")).toBeUndefined();
  });
});

describe("RomM controls", () => {
  it("a quick scan of the NES: one plan, run over the socket, finds the new game", async () => {
    const romm = fakeRomm();
    const ops = opsFor(admin, romm);
    const { planned, done } = await act(ops, { op: "scan", scanType: "quick", platformIds: "2" });
    expect(planned.label).toBe(
      "Scan Nintendo Entertainment System in RomM: find new games and platforms",
    );
    expect(planned.change?.summary).toContain("never deletes");
    expect(done).toMatchObject({ ok: true, result: expect.stringContaining("1 new") });
    expect((await rommGames(romm.fetch, BASE, admin, { search: "ember" })).items[0]?.name).toBe(
      "Ember Valley",
    );
  });

  it("only an administrator's login may scan; an unknown platform or kind is refused", async () => {
    await expect(opsFor(viewer).plan(svc, { op: "scan" }, base)).rejects.toThrow(/administrator/);
    await expect(opsFor(token).plan(svc, { op: "scan" }, base)).rejects.toThrow(/administrator/);
    await expect(opsFor(admin).plan(svc, { op: "scan", platformIds: "99" }, base)).rejects.toThrow(
      /does not have/,
    );
    await expect(opsFor(admin).plan(svc, { op: "scan", scanType: "wipe" }, base)).rejects.toThrow(
      /one of/,
    );
  });

  it("adds a favourite and takes it away again; a retried one changes nothing", async () => {
    const romm = fakeRomm();
    const ops = opsFor(admin, romm);
    const add = await act(ops, { op: "favorite", romId: 7 });
    expect(add.done).toMatchObject({ ok: true, result: expect.stringContaining("RomM confirms") });
    expect((await rommGame(romm.fetch, BASE, admin, 7)).favorite).toBe(true);
    // The same plan run again (a retry): already done, nothing more.
    expect(
      await ops.run(
        {
          kind: "app-romm-control",
          serviceId: "romm",
          requestedBy: "you",
          params: add.planned.params,
        },
        svc,
      ),
    ).toMatchObject({ ok: true, result: expect.stringContaining("already") });
    await expect(ops.plan(svc, { op: "favorite", romId: 7 }, base)).rejects.toThrow(/already/);
    const back = await act(ops, { op: "unfavorite", romId: 7 });
    expect(back.done.ok).toBe(true);
    expect((await rommGame(romm.fetch, BASE, admin, 7)).favorite).toBe(false);
  });
});
