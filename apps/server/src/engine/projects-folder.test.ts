import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { Projects } from "./projects";
import { EngineStore } from "./store";

// The engine's tables, as the homelab test reads them.
const SCHEMA = [
  ...readFileSync(path.join(SERVER_ROOT, "drizzle/0054_engine.sql"), "utf8").split(
    "--> statement-breakpoint",
  ),
  ...readFileSync(path.join(SERVER_ROOT, "drizzle/0062_project_color.sql"), "utf8")
    .split("--> statement-breakpoint")
    .filter((x) => x.includes("`engine_")),
].join("\n");

/** The Projects folder (Settings, PCs and devices; 11-24): changed, and moved with its projects. */
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const store = new EngineStore(db);
  const dir = mkdtempSync(path.join(tmpdir(), "hearth-folder-"));
  const projects = new Projects(store, path.join(dir, "old"));
  return { store, projects, dir };
}

describe("the Projects folder", () => {
  it("new projects go to the new folder; existing ones stay unless moved", () => {
    const { store, projects, dir } = setup();
    const a = projects.create("Garden Planner", "x");
    const out = projects.changeFolder(path.join(dir, "new"), false);
    expect(out.moved).toEqual([]);
    expect(store.setting("projects_folder", "")).toBe(path.join(dir, "new"));
    expect(existsSync(a.path)).toBe(true);
    expect(projects.get(a.slug).path).toBe(a.path);
    const b = projects.create("Recipe Box", "x");
    expect(path.dirname(b.path)).toBe(path.join(dir, "new"));
  });

  it("moves every project with it, each project's path updated", () => {
    const { projects, dir } = setup();
    const a = projects.create("Garden Planner", "x");
    writeFileSync(path.join(a.path, "notes.md"), "kept");
    const out = projects.changeFolder(path.join(dir, "moved"), true);
    expect(out.moved).toEqual(["Garden Planner"]);
    const now = projects.get(a.slug).path;
    expect(now).toBe(path.join(dir, "moved", path.basename(a.path)));
    expect(existsSync(path.join(now, "notes.md"))).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect(projects.get("sandbox").path).toBe(path.join(dir, "moved", "sandbox"));
  });

  it("refuses a relative path, a folder inside the current one, and a name clash", () => {
    const { projects, dir } = setup();
    const a = projects.create("Garden Planner", "x");
    expect(() => projects.changeFolder("projects", false)).toThrow(/whole path/);
    expect(() => projects.changeFolder(path.join(dir, "old", "inner"), false)).toThrow(/inside/);
    mkdirSync(path.join(dir, "busy", path.basename(a.path)), { recursive: true });
    expect(() => projects.changeFolder(path.join(dir, "busy"), true)).toThrow(/nothing was moved/);
    expect(existsSync(a.path)).toBe(true);
  });
});
