import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunk, draftsFromPlan } from "./import-plan";
import { draftsFromNotes, draftsFromSessionLogs, fixMojibake, parseWhen } from "./importer";

const NOTES = `# STATE — Media server

## Project overview
Plex, Jellyfin and the arr stack, moving to Linux.

## Standing conventions
- Never restart Plex during a stream.
- Keep downloads on the scratch disk.

## Open items — not yet resolved
- Decide whether Kavita stays on Windows.
- ~~Fix Sonarr's root folder~~ done.
- Move Caddy to Linux
  once the certificates are copied.

## Infrastructure
Server: 64 GB RAM, the media disk is 18 TB, the scratch disk is an NVMe.

### 2026-10-04 — Moved Jellyfin to Linux
Took an hour. Hardware transcoding needed the render group.

## Wizarr setup (added 2026-08-03)
Invites work through the public address.

### D3 — Keep the firewall closed
Tailscale already covers remote access.

## Session protocol
Read this file first.

### 2026-08-20 13:57 PDT | Codex | TAKEOVER | Romarr reverse proxy
Codex took over the proxy work. The admin password is Hunter2!
`;

function folder() {
  return mkdtempSync(path.join(tmpdir(), "dc-import-"));
}

describe("reading notes into import drafts", () => {
  it("turns each kind of section into the matching memory", () => {
    const dir = folder();
    const file = path.join(dir, "STATE.md");
    writeFileSync(file, `${String.fromCharCode(0xfeff)}${NOTES}`);
    const drafts = draftsFromNotes(file, {
      author: "Claude Code",
      projectMap: { romarr: "Games" },
    });
    const summary = drafts.map((d) =>
      d.payload.kind === "entry"
        ? [d.payload.entry.kind, d.payload.entry.title, d.payload.entry.projectName]
        : d.payload.kind === "project"
          ? ["project", d.payload.project.name, d.payload.project.summary]
          : ["session"],
    );
    expect(summary).toEqual([
      ["project", "Media server", "Plex, Jellyfin and the arr stack, moving to Linux."],
      ["preference", "Never restart Plex during a stream.", "Media server"],
      ["preference", "Keep downloads on the scratch disk.", "Media server"],
      ["thread", "Decide whether Kavita stays on Windows.", "Media server"],
      ["thread", "Fix Sonarr's root folder done.", "Media server"],
      ["thread", "Move Caddy to Linux once the certificates are copied.", "Media server"],
      ["hardware", "Media server: Infrastructure", "Media server"],
      ["journal", "Moved Jellyfin to Linux", "Media server"],
      ["journal", "Wizarr setup", "Media server"],
      ["journal", "Decision: Keep the firewall closed", "Media server"],
      ["journal", "Romarr reverse proxy (takeover)", "Games"],
    ]);
    const byTitle = (t: string) =>
      drafts.find((d) => d.payload.kind === "entry" && d.payload.entry.title === t)!;
    // Struck-through items are history: kept, but closed.
    expect(byTitle("Fix Sonarr's root folder done.").payload).toMatchObject({
      entry: { status: "done" },
    });
    expect(byTitle("Decide whether Kavita stays on Windows.").payload).toMatchObject({
      entry: { status: "open" },
    });
    const jellyfin = byTitle("Moved Jellyfin to Linux");
    expect(jellyfin.payload).toMatchObject({
      entry: { happenedAt: "2026-10-04T12:00:00.000Z", basis: "documented", author: "Claude Code" },
    });
    expect(byTitle("Wizarr setup").payload).toMatchObject({
      entry: { happenedAt: "2026-08-03T12:00:00.000Z" },
    });
    // Ledger entries keep their own time and author.
    expect(byTitle("Romarr reverse proxy (takeover)").payload).toMatchObject({
      entry: { happenedAt: "2026-08-20T20:57:00.000Z", author: "Codex" },
    });
    // Each piece has a stable reference, so re-reading the file refreshes rather than duplicates.
    expect(draftsFromNotes(file).map((d) => d.sourceRef)).toEqual(drafts.map((d) => d.sourceRef));
    expect(new Set(drafts.map((d) => d.sourceRef)).size).toBe(drafts.length);
  });

  it("repairs text mangled between tools and reads times with their zones", () => {
    expect(fixMojibake("Plex â€” done â†’ next")).toBe("Plex — done → next");
    expect(parseWhen("2026-08-20 13:57 PDT")).toBe("2026-08-20T20:57:00.000Z");
    expect(parseWhen("2026-10-04")).toBe("2026-10-04T12:00:00.000Z");
    expect(parseWhen("no date")).toBeUndefined();
  });

  it("reads dated session logs and refuses folders that look like they hold secrets", () => {
    const dir = folder();
    mkdirSync(path.join(dir, "2026-08-03 - Wizarr Setup"));
    writeFileSync(path.join(dir, "2026-08-03 - Wizarr Setup", "log.md"), "Set up invites.");
    mkdirSync(path.join(dir, "2026-08-04 - credentials"));
    writeFileSync(path.join(dir, "2026-08-04 - credentials", "log.md"), "secret things");
    const drafts = draftsFromSessionLogs(dir);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.payload).toMatchObject({
      entry: {
        kind: "journal",
        title: "Session: Wizarr Setup",
        happenedAt: "2026-08-03T12:00:00.000Z",
      },
    });
    expect(() =>
      draftsFromPlan({
        batch: "x",
        sources: [{ type: "notes", path: path.join(dir, "secrets.md") }],
      }),
    ).toThrow(/secrets/);
  });

  it("splits large imports into requests the server accepts", () => {
    const big = (n: number) => ({
      sourceRef: `md:${n}`,
      origin: "/x",
      anchor: "a",
      payload: {
        kind: "entry" as const,
        entry: { kind: "note" as const, title: "t", body: "x".repeat(1000) },
      },
    });
    const parts = chunk(
      Array.from({ length: 30 }, (_, i) => big(i)),
      5000,
      200,
    );
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.flat()).toHaveLength(30);
    expect(chunk(Array.from({ length: 450 }, (_, i) => big(i)))).toHaveLength(3);
  });
});
