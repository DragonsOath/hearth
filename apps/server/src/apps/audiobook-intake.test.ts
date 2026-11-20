import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IntakeConfig } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import type { CredentialBroker } from "../credentials/broker";
import { openDatabase, runMigrations } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep } from "../jobs/operations";
import { getSetting } from "../store/settings";
import { AudiobookIntake } from "./audiobook-intake";
import { fakeAudiobookshelf } from "./fake-audiobookshelf";

// Audiobook intake (the owner's Audiobook Organizer, inside Hearth) on real folders: a tagged book
// is copied in on its own as <Author>/<Title>, checked, and Audiobookshelf scans; a bare one waits
// and is imported with the names you give; one already in the library is not copied twice; one
// still downloading waits; originals go only after their days, and only imported ones.

const ABS = "http://10.0.0.7:13378";
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: "e2e-abs" }),
} as unknown as CredentialBroker;
const MB = 1024 * 1024;

async function file(p: string, size: number) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(size, 7));
}

async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "hearth-intake-"));
  const intake = path.join(root, "downloads", "Audiobooks");
  const library = path.join(root, "library", "Audio Books");
  await fs.mkdir(intake, { recursive: true });
  await fs.mkdir(path.join(library, "Will Wight"), { recursive: true });
  // Tagged: sure.
  await file(path.join(intake, "Frank.Herbert-Dune.Unabridged", "Dune.m4b"), 2 * MB);
  // No tags, a scene name: unsure.
  await file(path.join(intake, "random_rip_2021", "01.mp3"), MB);
  await file(path.join(intake, "random_rip_2021", "02.mp3"), MB);
  await file(path.join(intake, "random_rip_2021", "cover.jpg"), 1000);
  // Already in the library from the organizer, same files.
  await file(path.join(intake, "Will.Wight.Waybound.Cradle.Book.12", "Waybound.m4b"), MB);
  await file(path.join(library, "Will Wight", "Waybound", "Waybound.m4b"), MB);
  // Still downloading.
  await file(path.join(intake, "Half.Done", "a.mp3.!qB"), MB);

  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Home Server",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-11-07T00:00:00Z",
  });
  await handle.db.insert(t.services).values({
    id: "abs",
    name: "Audiobookshelf",
    category: "media",
    hostId: "h1",
    kind: "container",
    image: "ghcr.io/advplyr/audiobookshelf",
    localUrl: ABS,
    checkTarget: "container:audiobookshelf",
    health: "healthy",
    autonomyArea: "media",
  });
  const abs = fakeAudiobookshelf();
  let clock = Date.now() + 20 * 60_000;
  const tags: Record<string, Record<string, string>> = {
    "Dune.m4b": { album_artist: "Frank Herbert", album: "Dune" },
    "Waybound.m4b": { album_artist: "Will Wight", album: "Waybound" },
  };
  const intakeSvc = new AudiobookIntake(handle, broker, abs.fetch, {
    probe: async (f) => tags[path.basename(f)] ?? {},
    // Audiobookshelf's /audiobooks is this library folder.
    mounts: async () => [{ source: library, destination: "/audiobooks" }],
    now: () => clock,
  });
  const service = { id: "abs", name: "Audiobookshelf", localUrl: ABS };
  const run = async (params: Record<string, unknown>) => {
    const planned = await intakeSvc.plan(service, params as PlannedStep["params"], base);
    return {
      planned,
      out: await intakeSvc.run(
        {
          kind: "app-audiobookshelf-control",
          serviceId: "abs",
          requestedBy: "you",
          params: planned.params,
          job: { id: "job-9", seq: 0 },
        },
        service,
      ),
    };
  };
  return {
    root,
    intake,
    library,
    abs,
    intakeSvc,
    service,
    run,
    jobs: async () => (await getSetting(handle.db, "audiobook_intake_jobs"))!.abs!,
    advance: (ms: number) => (clock += ms),
  };
}

describe("audiobook intake", () => {
  it("proposes the library from Audiobookshelf, imports what it is sure of, and waits for the rest", async () => {
    const s = await setup();
    const view = await s.intakeSvc.view(s.service);
    expect(view.proposal?.libraries).toEqual([
      { id: "lib-books", name: "Audiobooks", folder: s.library },
    ]);

    const config: IntakeConfig = {
      ...view.proposal!,
      intake: [{ folder: s.intake, label: "Usenet audiobooks", removeAfterDays: 3 }],
    };
    const { planned, out } = await s.run({ op: "intake-setup", config: JSON.stringify(config) });
    expect(planned.change?.summary).toBe("Import finished audiobooks into Audiobookshelf");
    expect(JSON.stringify(planned.change)).toContain("as <Author>/<Title>");
    expect(out.ok).toBe(true);

    await s.intakeSvc.tick();
    const jobs = await s.jobs();
    const by = (name: string) => jobs.find((j) => j.name === name)!;
    expect(by("Frank.Herbert-Dune.Unabridged").status).toBe("imported");
    expect(await fs.stat(path.join(s.library, "Frank Herbert", "Dune", "Dune.m4b"))).toBeTruthy();
    // No hidden staging folder is left behind.
    expect(
      (await fs.readdir(path.join(s.library, "Frank Herbert"))).filter((n) => n.startsWith(".")),
    ).toEqual([]);
    expect(s.abs.scans()).toContain("lib-books");
    expect(by("Will.Wight.Waybound.Cradle.Book.12")).toMatchObject({
      status: "imported",
      message: "Already in your library.",
    });
    expect(by("random_rip_2021").status).toBe("review");
    expect(jobs.find((j) => j.name === "Half.Done")).toBeUndefined();

    // You say who and what it is.
    const rip = by("random_rip_2021");
    const imported = await s.run({
      op: "intake-import",
      job: rip.id,
      books: JSON.stringify([{ author: "Andy Weir", title: "Project Hail Mary" }]),
    });
    expect(imported.planned.change?.settings?.[0]?.after).toBe(
      path.join(s.library, "Andy Weir", "Project Hail Mary"),
    );
    expect(imported.out.ok).toBe(true);
    expect(
      (await fs.readdir(path.join(s.library, "Andy Weir", "Project Hail Mary"))).sort(),
    ).toEqual(["01.mp3", "02.mp3", "cover.jpg"]);

    // Originals stay until their days are up, then only imported ones go.
    await s.intakeSvc.tick();
    expect(await fs.stat(path.join(s.intake, "Frank.Herbert-Dune.Unabridged"))).toBeTruthy();
    s.advance(4 * 86_400_000);
    await s.intakeSvc.tick();
    await expect(fs.stat(path.join(s.intake, "Frank.Herbert-Dune.Unabridged"))).rejects.toThrow();
    expect(await fs.stat(path.join(s.intake, "Half.Done"))).toBeTruthy();
    // The library copy is untouched.
    expect(await fs.stat(path.join(s.library, "Frank Herbert", "Dune", "Dune.m4b"))).toBeTruthy();
    await fs.rm(s.root, { recursive: true, force: true });
  });

  it("refuses a setup where a download folder is inside the library", async () => {
    const s = await setup();
    await expect(
      s.intakeSvc.plan(
        s.service,
        {
          op: "intake-setup",
          config: JSON.stringify({
            intake: [{ folder: path.join(s.library, "incoming"), removeAfterDays: 0 }],
            libraries: [{ id: "lib-books", name: "Audiobooks", folder: s.library }],
            library: "lib-books",
            threshold: 0.8,
          }),
        },
        base,
      ),
    ).rejects.toThrow(/inside each other/);
    await fs.rm(s.root, { recursive: true, force: true });
  });
});
