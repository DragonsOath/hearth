import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { ServarrGet } from "./servarr-panel";
import { JellyfinOperations, jellyfinCall } from "./jellyfin";
import { readJellyfinView } from "./jellyfin-panel";

/**
 * The Jellyfin panel's People, Devices, Activity and System tabs, and its user and device changes,
 * against a real, disposable Jellyfin 12.2 (checklist 46.10n; the jellyfin-test that serves the
 * test Wizarr). Skipped unless HEARTH_JELLYFIN_TEST_URL and HEARTH_JELLYFIN_TEST_KEY_FILE point at
 * such an instance: never run this against one anyone uses. It makes its own throwaway user and
 * removes it; it never changes the test admin.
 */

const url = process.env.HEARTH_JELLYFIN_TEST_URL;
const keyFile = process.env.HEARTH_JELLYFIN_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const live = Boolean(url && key);

const f = (u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init);
const fetchImpl = f as unknown as ConstructorParameters<typeof JellyfinOperations>[2];
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const jf = { id: "jf-test", name: "Jellyfin", localUrl: url ?? "" };
const ops = new JellyfinOperations(handle, broker, fetchImpl, async () => undefined, {
  get: async () => undefined,
  set: async () => undefined,
});
const read: ServarrGet = async (path) => {
  if (path.startsWith("/System/Logs/Log")) {
    const r = await fetch(`${url}${path}`, {
      headers: { Authorization: `MediaBrowser Token="${key}"` },
    });
    return { ok: r.ok, status: r.status, data: await r.text() };
  }
  return jellyfinCall(fetchImpl, url!, key, "GET", path);
};
const NAME = `hearth-jf-${Date.now() % 100000}`;
const DEVICE = `hearth-throwaway-${Date.now() % 100000}`;

async function admin(method: string, path: string, body?: unknown) {
  const r = await jellyfinCall<Record<string, unknown>>(
    fetchImpl,
    url!,
    key,
    method as "GET",
    path,
    body,
  );
  return r;
}
async function act(params: StepParams) {
  const planned = await ops.plan(jf, params, base);
  const done = await ops.run(
    {
      kind: "app-jellyfin-control",
      serviceId: "jf-test",
      requestedBy: "you",
      params: planned.params,
    },
    jf,
  );
  return { planned, done };
}

describe.skipIf(!live)("Jellyfin people and devices against a real test instance", () => {
  let userId = "";
  afterAll(async () => {
    if (userId) await admin("DELETE", `/Users/${userId}`).catch(() => undefined);
  });

  it("reads users, devices, activity, logs and plugins, with keys hidden", async () => {
    const users = await readJellyfinView(read, "users", {});
    expect((users.users as { admin: boolean }[]).some((u) => u.admin)).toBe(true);
    expect((users.libraries as unknown[]).length).toBeGreaterThan(0);
    const activity = await readJellyfinView(read, "activity", {});
    expect(Array.isArray(activity.entries)).toBe(true);
    const logs = await readJellyfinView(read, "logs", {});
    const files = logs.files as { name: string }[];
    expect(files.length).toBeGreaterThan(0);
    const log = await readJellyfinView(read, "log", { name: files[0]!.name });
    expect((log.lines as string[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(log).includes(key)).toBe(false);
    await expect(readJellyfinView(read, "log", { name: "../../etc/passwd" })).rejects.toThrow(
      /Not a log/,
    );
    expect(Array.isArray((await readJellyfinView(read, "plugins", {})).plugins)).toBe(true);
  });

  it("disables and enables a throwaway user, limits its access, and removes it", async () => {
    const made = await admin("POST", "/Users/New", { Name: NAME });
    expect(made.ok).toBe(true);
    userId = String(made.data.Id);
    const off = await act({ op: "disable-user", userId });
    expect(off.done.ok, off.done.result).toBe(true);
    const on = await act({ op: "enable-user", userId });
    expect(on.done.ok, on.done.result).toBe(true);

    const libs = (await readJellyfinView(read, "users", {})).libraries as {
      id: string;
      name: string;
    }[];
    const one = libs[0]!;
    const access = await act({
      op: "user-access",
      userId,
      libraryIds: one.id,
      allowDownloads: true,
    });
    expect(access.done.ok, access.done.result).toBe(true);
    const u = (
      (await readJellyfinView(read, "users", {})).users as {
        id: string;
        allLibraries: boolean;
        libraries: string[];
        downloads: boolean;
      }[]
    ).find((x) => x.id === userId)!;
    expect(u).toMatchObject({ allLibraries: false, libraries: [one.id], downloads: true });
    // The same access plan again: the access it was planned from is gone, so nothing changes.
    const again = await ops.run(
      {
        kind: "app-jellyfin-control",
        serviceId: "jf-test",
        requestedBy: "you",
        params: access.planned.params,
      },
      jf,
    );
    expect(again).toMatchObject({ ok: false, stale: true });
    const back = await act({ op: "user-access", userId, libraryIds: "all", allowDownloads: false });
    expect(back.done.ok, back.done.result).toBe(true);
  });

  it("signs out a device the throwaway user signed in on", async () => {
    const auth = await fetch(`${url}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `MediaBrowser Client="Hearth test", Device="Throwaway phone", DeviceId="${DEVICE}", Version="1"`,
      },
      body: JSON.stringify({ Username: NAME, Pw: "" }),
    });
    expect(auth.ok).toBe(true);
    const devices = (await readJellyfinView(read, "devices", {})).devices as { id: string }[];
    expect(devices.some((d) => d.id === DEVICE)).toBe(true);
    const out = await act({ op: "sign-out-device", deviceId: DEVICE });
    expect(out.done.ok, out.done.result).toBe(true);
  });

  it("never disables or removes an administrator, and removes the throwaway user", async () => {
    const users = (await readJellyfinView(read, "users", {})).users as {
      id: string;
      admin: boolean;
    }[];
    const adminUser = users.find((x) => x.admin)!;
    await expect(ops.plan(jf, { op: "disable-user", userId: adminUser.id }, base)).rejects.toThrow(
      /administrator/,
    );
    await expect(ops.plan(jf, { op: "remove-user", userId: adminUser.id }, base)).rejects.toThrow(
      /administrator/,
    );
    const gone = await act({ op: "remove-user", userId });
    expect(gone.planned.change?.settings.map((s) => s.name)).toContain("Note");
    expect(gone.done.ok, gone.done.result).toBe(true);
    userId = "";
  });
});
