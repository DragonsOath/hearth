import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting } from "../store/settings";
import { addTimeline, dismissIncident, raise, settle } from "./engine";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  return handle.db;
}

const at = (m: number) => new Date(Date.UTC(2026, 10, 10, 12, m)).toISOString();
const problem = (m: number, title = "Radarr: Radarr keeps grabbing 2 titles") => ({
  key: "app:radarr",
  at: at(m),
  since: at(m),
  title,
  summary: "Each grab downloads the same thing again.",
  severity: "warning" as const,
  detectedText: "Radarr reported it.",
  confirmText: `Confirmed on ${m + 2} reads in a row.`,
});

describe("incident timeline and dismissing (11-10: 982 lines on one incident)", () => {
  it("keeps one line for repeated checks, and keeps other lines between them", async () => {
    const db = await setup();
    const id = (await raise(db, problem(0)))!;
    for (let m = 5; m <= 60; m += 5) await raise(db, problem(m));
    let lines = await db
      .select()
      .from(t.incidentTimeline)
      .where(eq(t.incidentTimeline.incidentId, id));
    expect(lines.filter((l) => l.kind === "check")).toHaveLength(1);
    expect(lines.find((l) => l.kind === "check")).toMatchObject({
      at: at(60),
      text: "Confirmed on 62 reads in a row.",
    });
    // A diagnosis is its own line, never overwritten by the next reading.
    await addTimeline(db, id, at(61), "check", "Diagnosis: the indexer serves a broken release.");
    await raise(db, problem(65));
    lines = await db.select().from(t.incidentTimeline).where(eq(t.incidentTimeline.incidentId, id));
    expect(lines.map((l) => l.text)).toContain("Diagnosis: the indexer serves a broken release.");
    expect(lines.filter((l) => l.kind === "check")).toHaveLength(3);
  });

  it("a dismissed incident stays closed while it reads the same; it comes back when it changes or after recovering", async () => {
    const db = await setup();
    const id = (await raise(db, problem(0)))!;
    await dismissIncident(db, id, at(1));
    const row = await db.select().from(t.incidents).where(eq(t.incidents.id, id)).get();
    expect(row).toMatchObject({ status: "resolved", handledBy: "you" });
    // The same problem: not opened again.
    expect(await raise(db, problem(5))).toBeUndefined();
    // It changed: raised as usual.
    const changed = await raise(db, problem(10, "Radarr: Radarr keeps grabbing 3 titles"));
    expect(changed).toBeTruthy();
    await dismissIncident(db, changed!, at(11));
    // It recovered: the dismissal is over, so a later return is raised again.
    await settle(db, "app:radarr", at(20), "No problems.", "Recovered.", "Radarr is fine");
    expect((await getSetting(db, "incident_mutes"))?.["app:radarr"]).toBeUndefined();
    expect(await raise(db, problem(30, "Radarr: Radarr keeps grabbing 3 titles"))).toBeTruthy();
  });
});
