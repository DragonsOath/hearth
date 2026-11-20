import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { PlexOperations } from "./plex-control";

/** Plex's library scans, against a stand-in that answers like Plex Media Server. */

const BASE = "http://10.0.0.9:32400";
const TOKEN = "e2e-plex-token";
const service = { id: "plex", name: "Plex", localUrl: BASE };
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
const step = (params: PlannedStep["params"]) => ({
  kind: "app-plex-control" as const,
  serviceId: "plex",
  requestedBy: "you" as const,
  params,
});

function fakePlex(refuse: string[] = []) {
  const scanned: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const ok = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body, text: async () => "" }) as never;
    if (init.headers["X-Plex-Token"] !== TOKEN) return ok({}, 401);
    const p = new URL(url).pathname;
    if (p === "/library/sections")
      return ok({
        MediaContainer: {
          Directory: [
            { key: "1", title: "Movies" },
            { key: "2", title: "TV Shows" },
          ],
        },
      });
    const m = /^\/library\/sections\/(\d+)\/refresh$/.exec(p);
    if (m) {
      if (refuse.includes(m[1]!)) return ok({}, 500);
      scanned.push(m[1]!);
      return ok({});
    }
    return ok({}, 404);
  };
  return { fetch, scanned };
}

describe("Plex library scans", () => {
  it("scans every library, the way Scan Library Files does in Plex", async () => {
    const plex = fakePlex();
    const o = new PlexOperations(handle, broker, plex.fetch);
    const s = await o.plan(service, { op: "scan-all" }, base);
    expect(s.label).toBe("Scan all 2 libraries in Plex for new and changed files");
    expect(await o.run(step(s.params), service)).toEqual({
      ok: true,
      result: "Plex is scanning Movies, TV Shows; new files show up as it finds them.",
    });
    expect(plex.scanned).toEqual(["1", "2"]);
  });

  it("scans one library, and says plainly when Plex refuses part of it", async () => {
    const plex = fakePlex(["2"]);
    const o = new PlexOperations(handle, broker, plex.fetch);
    const one = await o.plan(service, { op: "scan-library", libraryId: "1" }, base);
    expect(one.label).toBe("Scan the Movies library in Plex");
    expect((await o.run(step(one.params), service)).ok).toBe(true);
    const all = await o.plan(service, { op: "scan-all" }, base);
    expect(await o.run(step(all.params), service)).toEqual({
      ok: false,
      result:
        "Plex is scanning Movies; new files show up as it finds them. It refused TV Shows (500).",
    });
    await expect(o.plan(service, { op: "scan-library", libraryId: "9" }, base)).rejects.toThrow(
      "Plex does not have that library.",
    );
  });
});
