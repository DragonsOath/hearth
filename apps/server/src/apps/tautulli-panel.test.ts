import { beforeEach, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeTautulli } from "./fake-tautulli";
import { tautulliCmd } from "./tautulli";
import { TautulliControl } from "./tautulli-control";
import { readTautulliView, scrubTautulli, type TautulliRead } from "./tautulli-panel";

// The Tautulli panel's tabs and its steps against the stand-in Tautulli.

const BASE = "http://tautulli.test:8181";
const KEY = "e2e-unit-tautulli-key";
const fake = fakeTautulli();
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const svc = { id: "tt", name: "Tautulli", localUrl: BASE };
const ops = new TautulliControl(handle, broker, fake.fetch);
const read: TautulliRead = (cmd, p) => tautulliCmd(fake.fetch, BASE, KEY, cmd, p);
const view = (v: Parameters<typeof readTautulliView>[1], q: Record<string, string> = {}) =>
  readTautulliView(read, v, q);
const run = (params: StepParams) =>
  ops.run({ kind: "app-tautulli-control", serviceId: "tt", requestedBy: "you", params }, svc);
const act = async (params: StepParams) => run((await ops.plan(svc, params, base)).params!);

describe("the Tautulli panel's tabs", () => {
  beforeEach(() => fake.reset());

  it("reads history by person, kind and title, newest first", async () => {
    const all = await view("history");
    expect(all.total).toBe(5);
    expect((all.entries as { title: string }[])[0]!.title).toBe("Severance - Woe's Hollow");
    const sam = await view("history", { userId: "2" });
    expect((sam.entries as { who: string }[]).every((e) => e.who === "sam")).toBe(true);
    const films = await view("history", { type: "movie", q: "dune" });
    expect(films.entries).toMatchObject([
      { title: "Dune: Part Two", away: true, how: "transcode" },
    ]);
  });

  it("reads people, one person's stats, libraries and plays per day", async () => {
    const users = (await view("users")).users as { id: number; plays: number }[];
    expect(users.find((u) => u.id === 1)?.plays).toBe(2);
    const kim = await view("user", { id: "3" });
    expect(kim).toMatchObject({ name: "kim", keepHistory: false, allowGuest: true });
    const libs = (await view("libraries")).libraries as {
      name: string;
      episodesOrTracks?: number;
    }[];
    expect(libs.find((l) => l.name === "TV Shows")?.episodesOrTracks).toBe(6123);
    // A movie library has no episodes (Tautulli sends null): none are shown.
    expect(libs.find((l) => l.name === "Movies")?.episodesOrTracks).toBeUndefined();
    const g = await view("graphs", { days: "7" });
    expect((g.dates as string[]).length).toBe(7);
    await expect(view("user", { id: "x" })).rejects.toThrow(/Not a Tautulli user/);
  });

  it("hides keys in Tautulli's log", async () => {
    const lines = (await view("logs")).lines as { text: string }[];
    expect(JSON.stringify(lines).includes("0123456789abcdef0123456789abcdef")).toBe(false);
    expect(scrubTautulli("X-Plex-Token=abcDEF123ghiJKL456mno")).not.toContain("abcDEF");
    expect(scrubTautulli("Unable to refresh users list.")).toBe("Unable to refresh users list.");
  });
});

describe("the Tautulli panel's steps", () => {
  beforeEach(() => fake.reset());

  it("renames a person and keeps their other settings (sent every time)", async () => {
    const planned = await ops.plan(
      svc,
      { op: "edit-user", userId: "3", body: JSON.stringify({ friendlyName: "Kim P" }) },
      base,
    );
    expect(planned.change?.settings).toEqual([{ name: "Name", before: "kim", after: "Kim P" }]);
    expect((await run(planned.params!)).ok).toBe(true);
    // keep_history stayed off and guest access on, though the stand-in resets what it is not sent.
    expect(await view("user", { id: "3" })).toMatchObject({
      name: "Kim P",
      keepHistory: false,
      allowGuest: true,
    });
    expect(await run(planned.params!)).toMatchObject({ ok: false, stale: true });
  });

  it("stops recording a library's plays, read back", async () => {
    const done = await act({
      op: "edit-library",
      libraryId: "1",
      body: JSON.stringify({ keepHistory: false }),
    });
    expect(done).toMatchObject({ ok: true });
    const libs = (await view("libraries")).libraries as { id: number; keepHistory: boolean }[];
    expect(libs.find((l) => l.id === 1)?.keepHistory).toBe(false);
  });

  it("deletes play records it can see, never ones it cannot, and says so twice", async () => {
    const planned = await ops.plan(svc, { op: "delete-history", rowIds: "4,2" }, base);
    expect(planned.change?.settings.map((s) => s.name)).toEqual([
      "sam: Dune: Part Two",
      "kim: Quiet Harbor",
      "Note",
    ]);
    expect((await run(planned.params!)).ok).toBe(true);
    expect((await view("history")).total).toBe(3);
    expect(await run(planned.params!)).toMatchObject({ ok: true, stale: true });
    await expect(ops.plan(svc, { op: "delete-history", rowIds: "99" }, base)).rejects.toThrow(
      /no recent play record 99/,
    );
    await expect(ops.plan(svc, { op: "delete-history", rowIds: "a" }, base)).rejects.toThrow(
      /which history rows/,
    );
  });

  it("backs up the database and reads the lists from Plex again", async () => {
    expect((await act({ op: "backup-db" })).ok).toBe(true);
    expect((await act({ op: "refresh-users" })).ok).toBe(true);
    expect((await act({ op: "refresh-libraries" })).ok).toBe(true);
  });
});
