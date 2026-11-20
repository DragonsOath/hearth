import { beforeEach, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakePlex } from "./fake-plex";
import { joinUrl } from "./http";
import { PlexOperations } from "./plex-control";
import { readPlexView } from "./plex-panel";
import type { ServarrGet } from "./servarr-panel";

// The Plex panel's tabs and its steps against the stand-in Plex.

const BASE = "http://plex.test:32400";
const TOKEN = "e2e-unit-plex-token";
const fake = fakePlex();
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const plex = { id: "plex", name: "Plex", localUrl: BASE };
const ops = new PlexOperations(handle, broker, fake.fetch);
const read: ServarrGet = async (path) => {
  const r = await fake.fetch(joinUrl(BASE, path), {
    method: "GET",
    headers: { Accept: "application/json", "X-Plex-Token": TOKEN },
    signal: AbortSignal.timeout(5000),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
};
const run = (params: StepParams) =>
  ops.run({ kind: "app-plex-control", serviceId: "plex", requestedBy: "you", params }, plex);
const act = async (params: StepParams) => run((await ops.plan(plex, params, base)).params!);
const item = (id: string) => readPlexView(read, "item", { id });

describe("the Plex panel's tabs", () => {
  beforeEach(() => fake.reset());

  it("lists a library's titles, searches, filters unwatched and opens a show's seasons", async () => {
    const lib = await readPlexView(read, "library", {});
    expect((lib.sections as { title: string }[]).map((s) => s.title)).toEqual([
      "Movies",
      "TV Shows",
    ]);
    expect((lib.items as { title: string }[]).map((x) => x.title)).toEqual([
      "Ember Lake",
      "Harbor Lights",
      "Quiet Harbor",
    ]);
    const found = await readPlexView(read, "library", { q: "harbor", sort: "title" });
    expect((found.items as { title: string }[]).map((x) => x.title)).toEqual([
      "Harbor Lights",
      "Quiet Harbor",
    ]);
    const unwatched = await readPlexView(read, "library", { filter: "unwatched" });
    expect((unwatched.items as { title: string }[]).map((x) => x.title)).not.toContain(
      "Quiet Harbor",
    );
    const show = await item("200");
    expect(show).toMatchObject({ type: "show", watched: false });
    expect((show.children as { title: string; watched: boolean }[]).map((c) => c.watched)).toEqual([
      true,
      false,
    ]);
    const film = await item("101");
    expect((film.versions as { files: { file: string }[] }[])[0]!.files[0]!.file).toContain(
      "Harbor Lights (2019).mkv",
    );
  });

  it("reads history with who watched, tasks and settings, never a credential or networking change", async () => {
    const history = await readPlexView(read, "history", {});
    expect((history.entries as { who: string; title: string }[])[1]).toMatchObject({
      who: "sam",
      title: "Signal Hill S01E03 Episode 3",
    });
    const tasks = await readPlexView(read, "tasks", {});
    expect((tasks.tasks as { name: string; title: string }[]).map((t) => t.title)).toContain(
      "Generate Intro Markers",
    );
    const settings = (await readPlexView(read, "settings", {})).settings as {
      id: string;
      locked: boolean;
    }[];
    expect(settings.find((s) => s.id === "ManualPortMappingPort")?.locked).toBe(true);
    expect(settings.find((s) => s.id === "TranscoderQuality")?.locked).toBe(false);
    expect(JSON.stringify(settings).includes("e2e-never-shown-token")).toBe(false);
  });

  it("refuses an item id that is not a number", async () => {
    await expect(readPlexView(read, "item", { id: "../prefs" })).rejects.toThrow(/Not a Plex item/);
  });
});

describe("the Plex panel's steps", () => {
  beforeEach(() => fake.reset());

  it("marks a film watched once: the same plan again is stale", async () => {
    const planned = await ops.plan(plex, { op: "watched", ratingKey: "101" }, base);
    expect((await run(planned.params!)).ok).toBe(true);
    expect((await item("101")).watched).toBe(true);
    expect(await run(planned.params!)).toMatchObject({ ok: false, stale: true });
    await expect(ops.plan(plex, { op: "watched", ratingKey: "101" }, base)).rejects.toThrow(
      /already watched/,
    );
  });

  it("puts your star rating on a title, out of 10 as Plex keeps it, read back", async () => {
    const planned = await ops.plan(plex, { op: "rate", ratingKey: "101", stars: "4" }, base);
    expect(planned.change?.settings[0]).toMatchObject({
      before: "not rated",
      after: "4 of 5 stars",
    });
    expect(await run(planned.params!)).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(plex, { op: "rate", ratingKey: "101", stars: "9" }, base),
    ).rejects.toThrow(/1 to 5 stars/);
  });

  it("marks a whole show watched, with a note that every episode is marked", async () => {
    const planned = await ops.plan(plex, { op: "watched", ratingKey: "200" }, base);
    expect(planned.change?.settings.find((s) => s.name === "Note")?.after).toMatch(/Every episode/);
    expect((await run(planned.params!)).ok).toBe(true);
    expect((await item("200")).watched).toBe(true);
    expect((await act({ op: "unwatched", ratingKey: "200" })).ok).toBe(true);
    expect((await item("210")).watched).toBe(false);
  });

  it("edits a title's details, locked in Plex, and refuses a plan whose starting point changed", async () => {
    const planned = await ops.plan(
      plex,
      { op: "edit-item", ratingKey: "103", body: JSON.stringify({ sortTitle: "Lake, Ember" }) },
      base,
    );
    expect(planned.change?.settings[0]).toMatchObject({
      name: "Sort title",
      before: "Ember Lake",
      after: "Lake, Ember",
    });
    // Someone edits the title in Plex before this runs.
    await act({ op: "edit-item", ratingKey: "103", body: JSON.stringify({ sortTitle: "Other" }) });
    expect(await run(planned.params!)).toMatchObject({ ok: false, stale: true });
    const ok = await act({
      op: "edit-item",
      ratingKey: "103",
      body: JSON.stringify({ summary: "A new summary.", year: "2025" }),
    });
    expect(ok.ok, ok.result).toBe(true);
    expect(await item("103")).toMatchObject({ summary: "A new summary.", year: 2025 });
    await expect(
      ops.plan(plex, { op: "edit-item", ratingKey: "103", body: '{"year":"20x"}' }, base),
    ).rejects.toThrow(/four digits/);
  });

  it("changes a setting with read back, and never a networking setting", async () => {
    const done = await act({ op: "set-settings", preferences: '{"TranscoderQuality":2}' });
    expect(done).toMatchObject({ ok: true });
    expect(done.result).toMatch(/Transcoder quality: 2 \(read back\)/);
    await expect(
      ops.plan(plex, { op: "set-settings", preferences: '{"ManualPortMappingPort":1}' }, base),
    ).rejects.toThrow(/networking/);
    await expect(
      ops.plan(plex, { op: "set-settings", preferences: '{"TranscoderQuality":9}' }, base),
    ).rejects.toThrow(/one of/);
  });

  it("runs a maintenance task, empties a library's trash and starts bundle cleaning", async () => {
    expect((await act({ op: "run-task", taskId: "BackupDatabase" })).ok).toBe(true);
    const tasks = await readPlexView(read, "tasks", {});
    expect((tasks.activities as { title: string }[]).map((a) => a.title)).toContain(
      "Backup Database",
    );
    await expect(ops.plan(plex, { op: "run-task", taskId: "Nope" }, base)).rejects.toThrow(
      /no task/,
    );
    expect((await act({ op: "empty-trash", libraryId: "1" })).ok).toBe(true);
    expect((await act({ op: "clean-bundles" })).ok).toBe(true);
  });
});
