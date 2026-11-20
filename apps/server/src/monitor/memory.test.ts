import { describe, expect, it } from "vitest";
import { fakeMemory } from "./fake-memory";
import { readMemory, type MemorySources } from "./memory";
import { MemoryOperations } from "./memory-ops";

// Where the memory goes, what can be stopped, the quick win, and freeing it as an approved step
// (the owner, 2026-11-02).

const svc = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  checkTarget: `container:${name}`,
  lifecycle: "active",
  ...extra,
});

function machine(over: Partial<MemorySources> = {}): MemorySources {
  const GB = 1024 ** 3;
  return {
    platform: "linux",
    self: { pid: 10, user: "owner" },
    mem: async () => ({
      total: 32 * GB,
      available: 20 * GB,
      free: 8 * GB,
      buffcache: 12 * GB,
      swaptotal: 0,
      swapused: 0,
    }),
    processes: async () => [
      { pid: 10, parentPid: 1, name: "node", memRss: 300_000, user: "owner" },
      {
        pid: 11,
        parentPid: 10,
        name: "python",
        command: "kokoro voice",
        memRss: 800_000,
        user: "owner",
      },
      // Inside a container: counted as the container, not again as an app.
      { pid: 20, parentPid: 1, name: "jellyfin", memRss: 1_500_000, user: "owner" },
      { pid: 30, parentPid: 1, name: "firefox", memRss: 1_000_000, user: "owner", started: "x" },
      { pid: 31, parentPid: 30, name: "firefox", memRss: 500_000, user: "owner", started: "y" },
      { pid: 40, parentPid: 1, name: "sshd", memRss: 9_000, user: "root" },
    ],
    containers: async () => [
      { id: "j".repeat(64), name: "jellyfin", image: "jellyfin/jellyfin", memMb: 1600 },
      { id: "t".repeat(64), name: "seerr-test", image: "seerr", memMb: 400 },
      { id: "g".repeat(64), name: "gluetun", image: "qmcgaw/gluetun", memMb: 80 },
    ],
    containerOf: async (pid) => (pid === 20 ? "j".repeat(64) : undefined),
    voiceLoaded: () => true,
    ...over,
  };
}

describe("memory breakdown", () => {
  it("adds up every part, counts container processes once, and groups an app's processes", async () => {
    const b = await readMemory(
      machine(),
      [svc("s1", "jellyfin"), svc("s2", "seerr-test"), svc("s3", "gluetun")],
      "box",
    );
    expect(b.totalMb).toBe(32768);
    expect(b.usedMb).toBe(12288);
    expect(b.cacheMb).toBe(12288);
    expect(b.freeMb).toBe(8192);
    const by = Object.fromEntries(b.items.map((i) => [i.id, i]));
    expect(by["app:firefox"]).toMatchObject({ name: "Firefox", count: 2, mb: 1465 });
    expect(by["app:jellyfin"]).toBeUndefined();
    expect(by["container:jellyfin"]!.mb).toBe(1600);
    expect(by["hearth-voice"]!.mb).toBe(781);
    // Used = the rows that are in use, with "System and other" the rest.
    const used = b.items
      .filter((i) => !["cache", "free"].includes(i.kind))
      .reduce((n, i) => n + i.mb, 0);
    expect(Math.abs(used - b.usedMb)).toBeLessThanOrEqual(2);
  });

  it("says what stays and why, and the quick win is the safe part only", async () => {
    const b = await readMemory(
      machine(),
      [svc("s1", "jellyfin"), svc("s2", "seerr-test"), svc("s3", "gluetun")],
      "box",
    );
    const by = Object.fromEntries(b.items.map((i) => [i.id, i]));
    expect(by["container:gluetun"]!.keep).toMatch(/VPN/);
    expect(by["app:sshd"]!.keep).toMatch(/Networking/);
    expect(by["hearth"]!.keep).toBeTruthy();
    expect(by["app:firefox"]!.stop?.label).toBe("Close Firefox");
    expect(by["container:jellyfin"]!.stop?.step).toEqual({
      kind: "stop-container",
      serviceId: "s1",
    });
    // Hearth's voice and the test copy; never Jellyfin (in use) or the browser (Ember's call).
    expect(b.quickWin.names).toEqual(["Hearth voice", "seerr-test"]);
    expect(b.quickWin.mb).toBe(1181);
  });

  it("does not close another user's apps", async () => {
    const b = await readMemory(
      machine({
        processes: async () => [
          { pid: 10, parentPid: 1, name: "node", memRss: 1000, user: "owner" },
          { pid: 50, parentPid: 1, name: "steam.exe", memRss: 400_000, user: "SOMEPC\\guest" },
          { pid: 51, parentPid: 1, name: "steam.exe", memRss: 100_000, user: "SOMEPC\\guest" },
        ],
      }),
      [],
      "box",
    );
    expect(b.items.find((i) => i.id === "app:steam")).toMatchObject({
      name: "Steam",
      keep: expect.stringMatching(/another user/),
    });
  });
});

describe("free-memory step", () => {
  const ops = () => {
    const fake = fakeMemory();
    const o = new MemoryOperations(
      () => fake.sources(),
      async () => [],
      fake.close,
    );
    o.bind(fake.hooks);
    return o;
  };

  it("closes an app after approval and checks it is gone; a retry changes nothing", async () => {
    const o = ops();
    const b = await o.breakdown();
    const chrome = b.items.find((i) => i.id === "app:google chrome")!;
    const planned = await o.plan({ ...chrome.stop!.step });
    expect(planned.policy).toBe("approve-first");
    expect(planned.label).toMatch(/Close Google Chrome \(frees about 2\.0 GB\)/);
    const step = {
      kind: "free-memory" as const,
      serviceId: "this-host",
      requestedBy: "you" as const,
      params: planned.params,
    };
    expect(await o.run(step)).toMatchObject({ ok: true, result: expect.stringMatching(/closed/) });
    expect((await o.breakdown()).items.some((i) => i.id === "app:google chrome")).toBe(false);
    expect(await o.run(step)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/already closed/),
    });
  });

  it("refuses what stays, and frees the voice", async () => {
    const o = ops();
    const sshd = await o.plan({
      kind: "free-memory",
      serviceId: "this-host",
      params: { what: "app", app: "sshd" },
    });
    expect(sshd.policy).toBe("refuse");
    const voice = await o.plan({
      kind: "free-memory",
      serviceId: "this-host",
      params: { what: "voice" },
    });
    expect(voice.policy).toBe("approve-first");
    expect(
      await o.run({
        kind: "free-memory",
        serviceId: "this-host",
        requestedBy: "you",
        params: { what: "voice" },
      }),
    ).toMatchObject({ ok: true });
    expect((await o.breakdown()).items.some((i) => i.id === "hearth-voice")).toBe(false);
  });
});
