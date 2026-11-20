import { beforeEach, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeJellyfin } from "./fake-jellyfin";
import { JellyfinOperations, jellyfinCall } from "./jellyfin";
import { readJellyfinView, scrubLog } from "./jellyfin-panel";
import type { ServarrGet } from "./servarr-panel";

// The Jellyfin panel's tabs and its user and device steps against the stand-in Jellyfin.

const BASE = "http://jf.test:8096";
const KEY = "e2e-unit-jellyfin-key";
const fake = fakeJellyfin();
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const jf = { id: "jf", name: "Jellyfin", localUrl: BASE };
const ops = new JellyfinOperations(handle, broker, fake.fetch, async () => undefined, {
  get: async () => undefined,
  set: async () => undefined,
});
const read: ServarrGet = async (path) => {
  if (path.startsWith("/System/Logs/Log")) {
    const r = await fake.fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `MediaBrowser Token="${KEY}"` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: r.ok, status: r.status, data: r.text ? await r.text() : "" };
  }
  return jellyfinCall(fake.fetch, BASE, KEY, "GET", path);
};
type U = {
  id: string;
  name: string;
  disabled: boolean;
  allLibraries: boolean;
  libraries: string[];
};
const users = async () => (await readJellyfinView(read, "users", {})).users as U[];
const run = async (params: StepParams) =>
  ops.run({ kind: "app-jellyfin-control", serviceId: "jf", requestedBy: "you", params }, jf);
const act = async (params: StepParams) => run((await ops.plan(jf, params, base)).params!);

describe("the Jellyfin panel's tabs", () => {
  beforeEach(() => fake.reset());

  it("reads people with their access, devices without Hearth itself, activity and plugins", async () => {
    const u = await users();
    expect(u.map((x) => x.name)).toEqual(["Alex", "sam", "kim"]);
    expect(u.find((x) => x.name === "kim")).toMatchObject({
      allLibraries: false,
      libraries: ["lib-movies"],
    });
    const devices = (await readJellyfinView(read, "devices", {})).devices as { id: string }[];
    expect(devices.map((d) => d.id)).toEqual(["dev-tv", "dev-phone"]);
    const activity = await readJellyfinView(read, "activity", { page: "1" });
    expect(activity.total).toBe(3);
    const plugins = (await readJellyfinView(read, "plugins", {})).installed as { name: string }[];
    expect(plugins[0]!.name).toBe("TMDb");
  });

  it("reads a log with keys hidden, and only a plain log file name", async () => {
    const log = await readJellyfinView(read, "log", { name: "log_20261101.log" });
    const text = (log.lines as string[]).join("\n");
    expect(text).toContain("ffmpeg exited");
    expect(text.includes("0123456789abcdef0123456789abcdef")).toBe(false);
    await expect(readJellyfinView(read, "log", { name: "../secret.log" })).rejects.toThrow(
      /Not a log/,
    );
    await expect(readJellyfinView(read, "log", { name: "config.xml" })).rejects.toThrow(
      /Not a log/,
    );
  });

  it("hides keys, tokens and passwords in any line", () => {
    expect(scrubLog("GET /x?api_key=abc123&y=1")).toBe("GET /x?api_key=[hidden]&y=1");
    expect(scrubLog('Authorization: MediaBrowser Token="sekrit"')).not.toContain("sekrit");
    expect(scrubLog("password: hunter2")).not.toContain("hunter2");
  });
});

describe("the Jellyfin panel's steps", () => {
  beforeEach(() => fake.reset());

  it("disables and enables someone, never an administrator", async () => {
    expect((await act({ op: "disable-user", userId: "u2" })).ok).toBe(true);
    expect((await users()).find((x) => x.id === "u2")!.disabled).toBe(true);
    expect((await act({ op: "enable-user", userId: "u2" })).ok).toBe(true);
    expect((await users()).find((x) => x.id === "u2")!.disabled).toBe(false);
    await expect(ops.plan(jf, { op: "disable-user", userId: "u1" }, base)).rejects.toThrow(
      /administrator/,
    );
    await expect(ops.plan(jf, { op: "remove-user", userId: "u1" }, base)).rejects.toThrow(
      /administrator/,
    );
  });

  it("changes access once: the same plan again finds its starting point gone", async () => {
    const planned = await ops.plan(
      jf,
      { op: "user-access", userId: "u2", libraryIds: "lib-movies", allowDownloads: true },
      base,
    );
    expect((await run(planned.params!)).ok).toBe(true);
    expect((await users()).find((x) => x.id === "u2")).toMatchObject({
      allLibraries: false,
      libraries: ["lib-movies"],
    });
    expect(await run(planned.params!)).toMatchObject({ ok: false, stale: true });
  });

  it("removes someone and signs a device out", async () => {
    expect((await act({ op: "remove-user", userId: "u3" })).ok).toBe(true);
    expect((await users()).map((x) => x.id)).toEqual(["u1", "u2"]);
    expect((await act({ op: "sign-out-device", deviceId: "dev-phone" })).ok).toBe(true);
    const devices = (await readJellyfinView(read, "devices", {})).devices as { id: string }[];
    expect(devices.map((d) => d.id)).toEqual(["dev-tv"]);
  });
});
