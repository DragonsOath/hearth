import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as tables from "../db/schema";
import {
  HOMELAB_DESCRIPTION,
  HOMELAB_KNOWHOW,
  homelabSnapshot,
  homelabTick,
  ownerHomelabRules,
  serviceApp,
} from "./homelab";
import { Projects } from "./projects";
import { EngineStore } from "./store";
import { setSetting } from "../store/settings";

// The engine's tables, and the later changes to them (other tables in those files are skipped).
const SCHEMA = [
  ...readFileSync(path.join(SERVER_ROOT, "drizzle/0054_engine.sql"), "utf8").split(
    "--> statement-breakpoint",
  ),
  ...readFileSync(path.join(SERVER_ROOT, "drizzle/0062_project_color.sql"), "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => s.includes("`engine_")),
].join("\n");

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup(os = "Ubuntu 24.04", environment: "real" | "demo" = "real") {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  await setSetting(handle.db, "environment", environment);
  const host = (id: string, name: string, connection: "this-machine" | "agent", sort: number) => ({
    id,
    name,
    role: "server",
    os,
    address: "192.168.1.10",
    cpuModel: "Ryzen 7",
    cpuCores: 8,
    cpuUsagePct: 5,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 10,
    connection,
    docker: true,
    health: "healthy" as const,
    lastSeenAt: "2026-10-25T00:00:00Z",
    sort,
  });
  await handle.db
    .insert(tables.hosts)
    .values([host("here", "media-box", "this-machine", 0), host("nas", "nas", "agent", 1)]);
  const engineDb = new DatabaseSync(":memory:");
  engineDb.exec(SCHEMA);
  const dir = mkdtempSync(path.join(tmpdir(), "hearth-homelab-"));
  const projects = new Projects(new EngineStore(engineDb), path.join(dir, "projects"));
  return { handle, projects, engineDb };
}

const service = (
  id: string,
  name: string,
  hostId: string,
  extra: Partial<typeof tables.services.$inferInsert> = {},
) => ({
  id,
  name,
  category: "Media",
  hostId,
  kind: "container" as const,
  health: "healthy" as const,
  autonomyArea: "media",
  checkTarget: `container:${id}`,
  ...extra,
});

describe("the homelab snapshot, for the Lair", () => {
  it("never comes from sample data", async () => {
    const demo = await setup("Windows 11 Pro", "demo");
    await demo.handle.db
      .insert(tables.services)
      .values(service("sonarr", "Sonarr", "here", { image: "lscr.io/linuxserver/sonarr:latest" }));
    await homelabTick(demo.handle, demo.projects);
    expect(demo.projects.homelabNotes).toBe("");
  });

  it("tells the agent about the account's other PCs, so it never mixes them up", async () => {
    const { handle, projects } = await setup();
    await homelabTick(handle, projects, async () => [
      "- **Office PC** (Windows 11, Hearth 1.0.0, online): joined this account.",
    ]);
    expect(projects.homelabNotes).toContain("## Your other PCs (same Hearth account)");
    expect(projects.homelabNotes).toContain("**Office PC**");
    // A PC list that fails to load leaves the rest of the snapshot alone.
    await homelabTick(handle, projects, () => Promise.reject(new Error("offline")));
    expect(projects.homelabNotes).toContain("## This machine: media-box");
    expect(projects.homelabNotes).not.toContain("Your other PCs");
  });

  it("no longer makes a War Room project; the snapshot goes in the Lair's folder", async () => {
    const { handle, projects } = await setup();
    await handle.db.insert(tables.services).values([
      service("sonarr", "Sonarr", "here", {
        image: "lscr.io/linuxserver/sonarr:latest",
        localUrl: "http://localhost:8989",
      }),
      service("plex-nas", "Plex", "nas", { image: "plexinc/pms-docker" }),
    ]);
    await homelabTick(handle, projects);
    expect(projects.has("homelab")).toBe(false);
    expect(projects.list().map((p) => p.slug)).toEqual(["sandbox"]);
    const folder = projects.lairFolder();
    expect(path.basename(folder)).toBe(".lair");
    const snap = readFileSync(path.join(folder, ".hearth/homelab.md"), "utf8");
    expect(snap).toContain("## This machine: media-box");
    expect(snap).toContain("**Sonarr** (Media, healthy): container `sonarr`");
    expect(snap).toContain("local http://localhost:8989");
    expect(snap).toContain("Linux or macOS (bash)");
    expect(snap).toContain("**nas** (Ubuntu 24.04, 192.168.1.10, healthy): Plex");
  });

  it("keeps an earlier Hearth's Homelab project, archived, as the Lair's folder", async () => {
    const { handle, projects, engineDb } = await setup();
    projects.create("Garden", "Beds.");
    projects.create("Homelab · Homeserver", HOMELAB_DESCRIPTION, "hearth-homelab");
    engineDb.exec(
      "INSERT INTO engine_settings(key, value) VALUES ('homelab_project_slug', '\"hearth-homelab\"')",
    );
    expect(projects.hearthsHomelab()).toBe("hearth-homelab");
    expect(projects.get("hearth-homelab")).toMatchObject({ homelab: true, archived: true });
    expect(projects.get("garden").archived).toBeUndefined();
    // Last in the list, after the owner's own projects.
    expect(projects.list().map((p) => p.slug)).toEqual(["sandbox", "garden", "hearth-homelab"]);
    await handle.db
      .insert(tables.services)
      .values(service("jf", "Jellyfin", "here", { image: "jellyfin/jellyfin" }));
    await homelabTick(handle, projects);
    const folder = projects.get("hearth-homelab").path;
    expect(projects.lairFolder()).toBe(folder);
    expect(readFileSync(path.join(folder, ".hearth/homelab.md"), "utf8")).toContain("Jellyfin");
  });

  it("tells the owner's own homelab project from Hearth's", async () => {
    const mine = await setup();
    mine.projects.create("Homelab", "Mine, my words.");
    expect(mine.projects.hearthsHomelab()).toBeUndefined();
    expect(mine.projects.get("homelab").archived).toBeUndefined();

    // Made by an earlier Hearth that kept no note of it: known by its brief.
    const old = await setup();
    old.projects.create("Homelab", HOMELAB_DESCRIPTION);
    expect(old.projects.hearthsHomelab()).toBe("homelab");
    expect(old.projects.get("homelab").archived).toBe(true);
  });

  it("knows Windows, and apps installed without Docker", async () => {
    const { handle } = await setup("Windows 11 Pro");
    await handle.db.insert(tables.services).values(
      service("plex", "Plex Media Server", "here", {
        kind: "process",
        checkTarget: "process:plex",
      }),
    );
    const snap = await homelabSnapshot(handle);
    expect(snap.apps).toEqual(["Plex"]);
    expect(snap.markdown).toContain("Windows (PowerShell");
    expect(snap.markdown).toContain("installed program");
  });

  it("recognises apps by image, native program, or name", () => {
    const base = { name: "x", image: null, checkTarget: null };
    expect(serviceApp({ ...base, image: "ghcr.io/hotio/radarr:release" })?.id).toBe("radarr");
    expect(serviceApp({ ...base, checkTarget: "process:jellyfin" })?.id).toBe("jellyfin");
    expect(serviceApp({ ...base, name: "Overseerr" })?.id).toBe("overseerr");
    expect(serviceApp({ ...base, name: "My notes app" })).toBeUndefined();
  });
});

describe("project descriptions", () => {
  it("reach the agent when edited", async () => {
    const { projects } = await setup();
    const p = projects.create("Garden", "Plan the beds.");
    projects.syncContext(p.slug);
    expect(readFileSync(path.join(p.path, "CLAUDE.md"), "utf8")).toContain("Plan the beds.");
    projects.edit(p.slug, { description: "Fence and gate, not beds." });
    projects.syncContext(p.slug);
    const claude = readFileSync(path.join(p.path, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Fence and gate, not beds.");
    expect(claude).not.toContain("Plan the beds.");
    expect(readFileSync(path.join(p.path, "AGENTS.md"), "utf8")).toContain(
      "Fence and gate, not beds.",
    );
  });
});

describe("the Lair's homelab know-how", () => {
  it("carries the brief's knowledge and none of its house rules", () => {
    expect(HOMELAB_KNOWHOW).toContain("## How a homelab usually fits together");
    expect(HOMELAB_KNOWHOW).toContain("## Common jobs");
    expect(HOMELAB_KNOWHOW).toContain("## Where to look first");
    expect(HOMELAB_KNOWHOW).not.toContain("## House rules");
    expect(HOMELAB_KNOWHOW).not.toMatch(/Never delete|Never format/);
    expect(HOMELAB_KNOWHOW).not.toMatch(/—/);
  });

  it("finds the owner's own additions to the old brief, word for word", () => {
    expect(ownerHomelabRules(HOMELAB_DESCRIPTION)).toBe("");
    const edited = [
      HOMELAB_DESCRIPTION.replace(
        "- Stopping, restarting, or updating Hearth ends this conversation. When the owner asks for it, say so first, then do it.",
        "- Do not stop, reconfigure, or update Hearth from here: it runs this conversation.",
      ),
      "",
      "## My rules",
      "- Never touch the Proton VPN app on Homeserver.",
      "  - Ask before restarting Plex during movie night.",
    ].join("\n");
    expect(ownerHomelabRules(edited)).toBe(
      [
        "## My rules",
        "- Never touch the Proton VPN app on Homeserver.",
        "  - Ask before restarting Plex during movie night.",
      ].join("\n"),
    );
  });
});
