import { describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { joinUrl, type Fetch } from "./http";
import { PlexOperations } from "./plex-control";
import { readPlexView } from "./plex-panel";
import type { ServarrGet } from "./servarr-panel";

/**
 * The Plex panel's Library, History, Tasks and Settings tabs and its changes, against a real,
 * disposable Plex 1.43 (plex-hearth-test: never claimed, no internet, synthetic clips; checklist
 * 46.10o). Skipped unless HEARTH_PLEX_TEST_URL points at such an instance: never run this against
 * one anyone uses. Every change it makes is put back.
 */

const url = process.env.HEARTH_PLEX_TEST_URL;
const live = Boolean(url);
// The test Plex trusts its own network; a token is still sent, as Hearth always does.
const TOKEN = "hearth-test";
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
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
const plex = { id: "plex-test", name: "Test Plex", localUrl: url ?? "" };
const ops = new PlexOperations(handle, broker, f);
const read: ServarrGet = async (path) => {
  const r = await f(joinUrl(url!, path), {
    method: "GET",
    headers: { Accept: "application/json", "X-Plex-Token": TOKEN },
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
};
const act = async (params: StepParams) => {
  const planned = await ops.plan(plex, params, base);
  return ops.run(
    {
      kind: "app-plex-control",
      serviceId: "plex-test",
      requestedBy: "you",
      params: planned.params,
    },
    plex,
  );
};
type Card = { id: string; title: string; type: string; watched: boolean };

describe.skipIf(!live)("Plex panel against a real test instance", () => {
  it("reads both libraries, a show's seasons, history, tasks and settings", async () => {
    const sections = (await readPlexView(read, "library", {})).sections as {
      id: string;
      type: string;
    }[];
    expect(sections.map((s) => s.type).sort()).toEqual(["movie", "show"]);
    const lib = await readPlexView(read, "library", {
      section: sections.find((s) => s.type === "movie")!.id,
      sort: "title",
    });
    expect((lib.items as Card[]).map((x) => x.title)).toContain("Harbor Lights (2019)");
    const tv = await readPlexView(read, "library", {
      section: sections.find((s) => s.type === "show")!.id,
    });
    const show = (tv.items as Card[])[0]!;
    const opened = await readPlexView(read, "item", { id: show.id });
    expect((opened.children as Card[]).map((c) => c.type)).toEqual(["season", "season"]);
    expect(Array.isArray((await readPlexView(read, "history", {})).entries)).toBe(true);
    const tasks = await readPlexView(read, "tasks", {});
    expect((tasks.tasks as { name: string }[]).map((t) => t.name)).toContain("BackupDatabase");
    const settings = (await readPlexView(read, "settings", {})).settings as {
      id: string;
      group: string;
      locked: boolean;
    }[];
    expect(settings.length).toBeGreaterThan(20);
    for (const s of settings.filter((x) => x.group === "network")) expect(s.locked).toBe(true);
  });

  it("marks an episode watched and back, and edits a film's sort title and back", async () => {
    const tv = await readPlexView(read, "library", { section: "2" });
    const show = (tv.items as Card[])[0]!;
    const season = ((await readPlexView(read, "item", { id: show.id })).children as Card[])[0]!;
    const ep = ((await readPlexView(read, "item", { id: season.id })).children as Card[])[0]!;
    const was = ep.watched;
    const on = await act({ op: was ? "unwatched" : "watched", ratingKey: ep.id });
    expect(on.ok, on.result).toBe(true);
    const back = await act({ op: was ? "watched" : "unwatched", ratingKey: ep.id });
    expect(back.ok, back.result).toBe(true);

    const film = (
      (await readPlexView(read, "library", { section: "1", sort: "title" })).items as Card[]
    )[0]!;
    const before = (await readPlexView(read, "item", { id: film.id })).sortTitle as string;
    const edit = await act({
      op: "edit-item",
      ratingKey: film.id,
      body: JSON.stringify({ sortTitle: "Zz Hearth test" }),
    });
    expect(edit.ok, edit.result).toBe(true);
    expect((await readPlexView(read, "item", { id: film.id })).sortTitle).toBe("Zz Hearth test");
    const undo = await act({
      op: "edit-item",
      ratingKey: film.id,
      body: JSON.stringify({ sortTitle: before }),
    });
    expect(undo.ok, undo.result).toBe(true);
  });

  it("changes a server setting and back, runs a task, empties trash, cleans bundles", async () => {
    const settings = (await readPlexView(read, "settings", {})).settings as {
      id: string;
      value: unknown;
    }[];
    const was = Number(settings.find((s) => s.id === "TranscoderQuality")!.value);
    const set = await act({
      op: "set-settings",
      preferences: JSON.stringify({ TranscoderQuality: was === 1 ? 2 : 1 }),
    });
    expect(set.ok, set.result).toBe(true);
    const back = await act({
      op: "set-settings",
      preferences: JSON.stringify({ TranscoderQuality: was }),
    });
    expect(back.ok, back.result).toBe(true);
    await expect(
      ops.plan(
        plex,
        { op: "set-settings", preferences: '{"customConnections":"http://example.invalid"}' },
        base,
      ),
    ).rejects.toThrow(/networking/);
    const task = await act({ op: "run-task", taskId: "CleanOldBundles" });
    expect(task.ok, task.result).toBe(true);
    const trash = await act({ op: "empty-trash", libraryId: "1" });
    expect(trash.ok, trash.result).toBe(true);
    const clean = await act({ op: "clean-bundles" });
    expect(clean.ok, clean.result).toBe(true);
  });
});
