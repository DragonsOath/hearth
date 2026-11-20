import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoSource } from "./demo-source";
import { clearSizeCache, fsSource } from "./fs-source";
import { toSegments } from "./source";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  clearSizeCache();
});

/** root/{Season 10/, Season 2/{ep.mkv}, notes.txt}, plus a sibling "outside" folder. */
function makeTree() {
  const base = mkdtempSync(path.join(tmpdir(), "dc-storage-"));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "watched");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "Season 10"), { recursive: true });
  mkdirSync(path.join(root, "Season 2"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "Season 2", "ep.mkv"), Buffer.alloc(3000));
  writeFileSync(path.join(root, "notes.txt"), "hello");
  writeFileSync(path.join(outside, "secret.txt"), "do not show");
  return { root, outside };
}

describe("toSegments", () => {
  it("accepts normal relative paths in either separator style", () => {
    expect(toSegments("a/b\\c")).toEqual(["a", "b", "c"]);
    expect(toSegments("")).toEqual([]);
    expect(toSegments(undefined)).toEqual([]);
  });

  it("refuses anything that could leave the watched folder", () => {
    for (const bad of ["..", "a/../../b", "C:\\Windows", "file.txt:hidden", "a\0b"]) {
      expect(() => toSegments(bad), bad).toThrow();
    }
  });
});

describe("fsSource", () => {
  it("lists folders first in natural order, with sizes and item counts", async () => {
    const { root } = makeTree();
    const { entries, total } = await fsSource(root).list([], 100);
    expect(total).toBe(3);
    expect(entries.map((e) => e.name)).toEqual(["Season 2", "Season 10", "notes.txt"]);
    // Folder sizes are part of the listing, so a big movie stands out at a glance.
    expect(entries[0]).toMatchObject({
      kind: "folder",
      itemCount: 1,
      path: "Season 2",
      sizeBytes: 3000,
    });
    expect(entries[1]).toMatchObject({ name: "Season 10", sizeBytes: 0 });
    expect(entries[2]).toMatchObject({ kind: "file", sizeBytes: 5 });
  });

  it("totals a folder at any depth, like Properties", async () => {
    const { root } = makeTree();
    const props = await fsSource(root).properties([]);
    expect(props).toMatchObject({
      kind: "folder",
      files: 2,
      folders: 2,
      sizeBytes: 3005,
      complete: true,
    });
    const file = await fsSource(root).properties(["Season 2", "ep.mkv"]);
    expect(file).toMatchObject({ kind: "file", extension: "mkv", sizeBytes: 3000 });
    expect(file.modifiedAt).toBeTruthy();
  });

  it("stops counting huge folders at the budget and says so", async () => {
    const { root } = makeTree();
    const props = await fsSource(root, { properties: { maxEntries: 1, maxMs: 10_000 } }).properties(
      [],
    );
    expect(props.complete).toBe(false);
    // Listing sizes beyond the budget are left unknown rather than guessed.
    const { entries } = await fsSource(root, { listing: { maxEntries: 0, maxMs: 10_000 } }).list(
      [],
      10,
    );
    expect(entries.find((e) => e.name === "Season 2")?.sizeBytes).toBeUndefined();
  });

  it("refuses to follow a link that points outside the watched folder", async () => {
    const { root, outside } = makeTree();
    // A junction needs no special rights on Windows; elsewhere use a symlink.
    symlinkSync(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const source = fsSource(root);
    await expect(source.list(["escape"], 100)).rejects.toThrow(/outside the watched folder/);
    await expect(source.properties(["escape", "secret.txt"])).rejects.toThrow(
      /outside the watched folder/,
    );
    // Neither the folder's total nor the link's listed size counts what is behind it.
    expect((await source.properties([])).files).toBe(2);
    const { entries } = await source.list([], 10);
    expect(entries.find((e) => e.name === "escape")?.sizeBytes).toBeUndefined();
  });

  it("explains missing items", async () => {
    const { root } = makeTree();
    await expect(fsSource(root).list(["nope"], 10)).rejects.toThrow(/no longer exists/);
  });
});

describe("demoSource", () => {
  it("serves a believable, stable library", async () => {
    const movies = demoSource("movies", "/mnt/tank/movies");
    const { entries } = await movies.list([], 1000);
    expect(entries.length).toBeGreaterThan(30);
    expect(entries.every((e) => e.kind === "folder")).toBe(true);
    const first = entries[0]!;
    const inside = await movies.list([first.name], 10);
    expect(inside.entries.some((e) => e.name.endsWith(".mkv"))).toBe(true);
    const props = await movies.properties([]);
    expect(props.files).toBeGreaterThan(60);
    expect(props.sizeBytes).toBeGreaterThan(1e11);
    expect(await movies.properties([])).toEqual(props); // deterministic
  });
});
