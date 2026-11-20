import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { conversations } from "../db/schema";
import { ForgeAwaiting } from "./awaiting";
import { Workspaces } from "./service";

// The Forge (11-07): a title requested from a pick sheet joins it, selected, once Plex has it,
// and Ember hears about it in the sheet's conversation.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const sheet = {
  title: "Christmas Favorites",
  columns: [
    { key: "title", label: "Movie" },
    { key: "year", label: "Year", kind: "number" },
    { key: "why", label: "Why" },
  ],
  choices: [
    { value: "include", label: "Include", acts: true },
    { value: "skip", label: "Skip" },
  ],
  items: [{ id: "100", values: { title: "Elf", year: 2003, why: "A classic" } }],
  imageService: "plex",
  layout: { kind: "pick", choice: "include", other: "skip" },
};

async function setup(
  inPlex: { ratingKey: string; title: string; year?: number }[],
  rows: { id: string; name: string; titles: string[] }[] = [],
) {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  const w = new Workspaces(handle);
  const at = "2026-11-07T12:00:00Z";
  await handle.db.insert(conversations).values({
    id: "c-1",
    source: "app",
    title: "Christmas Favorites",
    status: "idle",
    createdAt: at,
    updatedAt: at,
  });
  const said: { text: string; conversationId: string }[] = [];
  let now = Date.parse("2026-11-07T12:00:00Z");
  const a = new ForgeAwaiting(
    handle.db,
    w,
    async () => ({ titles: inPlex }),
    async (text, conversationId) => said.push({ text, conversationId }),
    () => now,
    async (name) => rows.find((r) => r.name === name),
  );
  return { w, a, said, later: (ms: number) => (now += ms) };
}

describe("titles requested from a Forge sheet", () => {
  it("waits until Plex has it, then adds it selected and tells Ember", async () => {
    const inPlex: { ratingKey: string; title: string; year?: number }[] = [];
    const { w, a, said } = await setup(inPlex);
    const made = await w.create({ spec: sheet, conversationId: "c-1" });
    await a.add(made.id, { tmdbId: 9, mediaType: "movie", title: "The Holdovers", year: 2023 });
    expect(await a.tick()).toEqual([]);
    expect(await a.list(made.id)).toHaveLength(1);

    // A different film with a similar name is not it.
    inPlex.push({ ratingKey: "55", title: "The Holdovers 2", year: 2023 });
    expect(await a.tick()).toEqual([]);

    inPlex.push({ ratingKey: "77", title: "The Holdovers", year: 2023 });
    expect(await a.tick()).toEqual(["The Holdovers (2023)"]);
    const back = await w.get(made.id);
    expect(back.spec.items.map((i) => i.id)).toEqual(["100", "77"]);
    expect(back.spec.items[1]!.values).toMatchObject({
      title: "The Holdovers",
      year: 2023,
      why: "You requested it from this list",
    });
    expect(back.selections["77"]).toBe("include");
    expect(await a.list()).toEqual([]);
    expect(said).toEqual([
      expect.objectContaining({
        conversationId: "c-1",
        text: expect.stringMatching(/The Holdovers \(2023\).*now in Plex/),
      }),
    ]);
  });

  it("names the Home row built from the sheet, and the one step that adds it there", async () => {
    const inPlex = [{ ratingKey: "77", title: "The Holdovers", year: 2023 }];
    const { w, a, said } = await setup(inPlex, [
      { id: "row-1", name: "Christmas Favorites", titles: ["100"] },
    ]);
    const made = await w.create({ spec: sheet, conversationId: "c-1" });
    await a.add(made.id, { tmdbId: 9, mediaType: "movie", title: "The Holdovers", year: 2023 });
    expect(await a.tick()).toEqual(["The Holdovers (2023)"]);
    expect(said[0]!.text).toContain('The Home row "Christmas Favorites" was built from this sheet');
    expect(said[0]!.text).toContain("home-row-apply step with rowId row-1 and addTitle 77");
  });

  it("gives up after three weeks, and refuses a sheet that isn't a Plex pick sheet", async () => {
    const { w, a, later } = await setup([]);
    const made = await w.create({ spec: sheet });
    await a.add(made.id, { tmdbId: 9, mediaType: "movie", title: "Gone Girl", year: 2014 });
    later(22 * 86_400_000);
    await a.tick();
    expect(await a.list()).toEqual([]);
    const { imageService: _i, ...plain } = sheet;
    const other = await w.create({ spec: plain });
    await expect(a.add(other.id, { tmdbId: 1, mediaType: "movie", title: "X" })).rejects.toThrow(
      /pick sheet of Plex/,
    );
  });
});
