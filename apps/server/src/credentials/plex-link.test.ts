import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { listAudit } from "../store/audit";
import type { CredentialBroker } from "./broker";
import { PlexLink } from "./plex-link";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function db() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  return handle;
}

function setup(opts: { approved?: boolean; serverAccepts?: boolean } = {}) {
  const stored: { value: string; scope?: string; kind: string }[] = [];
  const broker = {
    storeGenerated: async (x: { value: string; scope?: string; kind: string }) => {
      stored.push(x);
      return { id: "s1" };
    },
  } as unknown as CredentialBroker;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (url.startsWith("https://plex.tv/api/v2/pins?"))
      return json({
        id: 42,
        code: "ABCD",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    if (url === "https://plex.tv/api/v2/pins/42")
      return json({ authToken: opts.approved ? "plex-token-from-plextv" : null });
    if (url.endsWith("/library/sections"))
      return json({}, opts.serverAccepts === false ? 401 : 200);
    return json({}, 404);
  };
  return { broker, stored, calls, fetchImpl };
}

describe("Link Plex", () => {
  it("stores the approved token through the broker, after testing it on this server; never returns it", async () => {
    const handle = await db();
    const s = setup({ approved: true });
    const link = new PlexLink(
      handle,
      s.broker,
      async () => ({ name: "Plex", localUrl: "http://10.0.0.5:32400" }),
      s.fetchImpl,
    );
    const started = await link.start("plex");
    expect(started).toMatchObject({ pinId: 42, code: "ABCD" });
    expect(started.authUrl).toMatch(
      /^https:\/\/app\.plex\.tv\/auth#\?clientID=dragon-control-.*&code=ABCD/,
    );
    const done = await link.check("plex", 42);
    expect(done).toEqual({ state: "linked" });
    expect(JSON.stringify(done)).not.toContain("plex-token-from-plextv");
    expect(s.stored).toEqual([
      expect.objectContaining({
        value: "plex-token-from-plextv",
        scope: "approved-changes",
        kind: "api-key",
      }),
    ]);
    expect(s.calls.find((c) => c.url.endsWith("/library/sections"))?.headers["X-Plex-Token"]).toBe(
      "plex-token-from-plextv",
    );
    expect((await listAudit(handle.db, 5)).map((a) => a.action)).toContain(
      "Started linking Plex for Plex (approval on plex.tv)",
    );
    // The same client identity is reused, and a finished code cannot be checked again.
    await expect(link.check("plex", 42)).rejects.toThrow(/No Plex link in progress/);
  });

  it("waits until approved, only checks codes it started, and keeps nothing this server refuses", async () => {
    const handle = await db();
    const waiting = setup({ approved: false });
    const link = new PlexLink(
      handle,
      waiting.broker,
      async () => ({ name: "Plex", localUrl: "http://10.0.0.5:32400" }),
      waiting.fetchImpl,
    );
    await link.start("plex");
    expect(await link.check("plex", 42)).toEqual({ state: "waiting" });
    await expect(link.check("plex", 7)).rejects.toThrow(/No Plex link in progress/);
    await expect(link.check("other", 42)).rejects.toThrow(/No Plex link in progress/);

    const refused = setup({ approved: true, serverAccepts: false });
    const link2 = new PlexLink(
      handle,
      refused.broker,
      async () => ({ name: "Plex", localUrl: "http://10.0.0.5:32400" }),
      refused.fetchImpl,
    );
    await link2.start("plex");
    const r = await link2.check("plex", 42);
    expect(r.state).toBe("expired");
    expect(r.message).toMatch(/did not accept the token .*Nothing was stored/);
    expect(refused.stored).toEqual([]);
  });
});
