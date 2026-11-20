import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { Workspaces } from "./service";

// The Forge's pick sheets (11-07): a title found in the whole library joins the sheet,
// selected, and stays there like any item Ember loaded.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
async function workspaces() {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return new Workspaces(handle);
}

const sheet = {
  title: "Christmas Favorites",
  columns: [
    { key: "title", label: "Movie" },
    { key: "year", label: "Year", kind: "number" },
  ],
  choices: [
    { value: "include", label: "Include", acts: true },
    { value: "skip", label: "Skip" },
  ],
  items: [{ id: "100", values: { title: "Elf", year: 2003 } }],
  suggested: { "100": "include" },
  imageService: "plex",
  layout: { kind: "pick", choice: "include", other: "skip" },
};

describe("adding from the library to a pick sheet", () => {
  it("adds a library title, selected; reads back; a second add does not duplicate", async () => {
    const w = await workspaces();
    const made = await w.create({ spec: sheet });
    const r = await w.addPicked(made.id, {
      id: "4242",
      values: { title: "Out Cold", year: 2001, unknown: "dropped" },
      image: "/library/metadata/4242/thumb/1",
    });
    expect(r.added).toBe(true);
    const back = await w.get(made.id);
    expect(back.spec.items.map((i) => i.id)).toEqual(["100", "4242"]);
    expect(back.spec.items[1]).toMatchObject({
      values: { title: "Out Cold", year: 2001 },
      image: "/library/metadata/4242/thumb/1",
    });
    expect(back.selections["4242"]).toBe("include");
    const again = await w.addPicked(made.id, { id: "4242", values: { title: "Out Cold" } });
    expect(again.added).toBe(false);
    expect((await w.get(made.id)).spec.items).toHaveLength(2);
  });

  it("refuses a sheet that isn't a pick sheet", async () => {
    const w = await workspaces();
    const { layout: _layout, ...table } = sheet;
    const made = await w.create({ spec: table });
    await expect(w.addPicked(made.id, { id: "1", values: { title: "X" } })).rejects.toThrow(
      /pick sheet/,
    );
  });
});
