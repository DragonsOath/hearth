import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeNavidrome } from "./fake-navidrome";
import { forgetNavidromeSessions, navidromeDashboard, readNavidrome } from "./navidrome";
import { NavidromeOperations } from "./navidrome-control";

/**
 * Navidrome against the stand-in (answering as a throwaway 0.64.2 did; navidrome-real.test.ts runs
 * the same calls against a real one): what the panel reads with one sign-in, and every change as a
 * plan read back.
 */

const BASE = "http://10.0.0.9:4533";
const LOGIN = { username: "admin", password: "e2e-nd" };
const service = { id: "nd", name: "Navidrome", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeNavidrome();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new NavidromeOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-navidrome-control" as const,
    serviceId: "nd",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  return { fake, go };
}

beforeEach(() => forgetNavidromeSessions());

describe("reading Navidrome", () => {
  it("reads library, scan, listeners, users, players and missing files with one sign-in", async () => {
    const { fake } = setup();
    const d = await navidromeDashboard(fake.fetch, BASE, LOGIN);
    expect(d).toMatchObject({
      version: "0.64.2",
      scan: { scanning: false, files: 1284, folders: 96 },
      libraries: [{ name: "Music Library", songs: 1284, albums: 112, artists: 64, missing: 1 }],
      nowPlaying: [{ user: "sam", title: "Tide", artist: "Quiet Harbor", player: "Sam's phone" }],
      missingCount: 1,
      playlists: 7,
      shares: 2,
    });
    expect(d.users.map((u) => [u.userName, u.admin])).toEqual([
      ["admin", true],
      ["sam", false],
      ["kid", false],
    ]);
    expect(d.users.find((u) => u.userName === "kid")!.lastSeen).toBeUndefined();
    expect(d.players[0]).toMatchObject({ client: "Symfonium", user: "sam" });
    expect(JSON.stringify(d)).not.toContain("SECRET");
    await navidromeDashboard(fake.fetch, BASE, LOGIN);
    expect(fake.signIns()).toBe(1);
  });

  it("warns about missing files and an old scan, and refuses a wrong password plainly", async () => {
    const { fake } = setup();
    const r = await readNavidrome(BASE, LOGIN, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["missing", "scan-stale"]);
    expect(r.facts).toEqual(expect.arrayContaining([{ label: "Listening now", value: "1" }]));
    forgetNavidromeSessions();
    await expect(
      navidromeDashboard(fake.fetch, BASE, { username: "admin", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });
});

describe("changing Navidrome", () => {
  it("scans and forgets missing files, read back", async () => {
    const { go, fake } = setup();
    const s = await go({ op: "scan" });
    expect(s.outcome).toMatchObject({ ok: true, verified: true });
    const f = await go({ op: "forget-missing" });
    expect(f.planned.label).toContain("put a file back first if it only moved");
    expect(f.outcome).toMatchObject({ ok: true, verified: true });
    expect((await navidromeDashboard(fake.fetch, BASE, LOGIN)).missingCount).toBe(0);
    await expect(go({ op: "forget-missing" })).rejects.toThrow(/no missing files/);
  });

  it("makes a user an administrator and back, and never demotes or removes Hearth's own", async () => {
    const { go } = setup();
    const a = await go({ op: "admin-on", userId: "u-sam" });
    expect(a.outcome).toMatchObject({ ok: true, verified: true });
    expect((await a.undo())?.ok).toBe(true);
    await expect(go({ op: "admin-off", userId: "u-admin" })).rejects.toThrow(
      /stays an administrator/,
    );
    await expect(go({ op: "remove-user", userId: "u-admin" })).rejects.toThrow(/not removed/);
    const rm = await go({ op: "remove-user", userId: "u-kid" });
    expect(rm.planned.label).toContain("the music stays");
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
  });
});
