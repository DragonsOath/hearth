import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { ServarrGet } from "./servarr-panel";
import { JellyfinOperations, jellyfinCall } from "./jellyfin";
import { readJellyfinView } from "./jellyfin-panel";
import { readManageView } from "./jellyfin-manage";

/**
 * Emby through the Jellyfin panel's code (Emby speaks Jellyfin's API): its People, Devices,
 * Activity and System reads, and its user and device changes, against a real, disposable Emby
 * Server (emby/embyserver 4.10.2, with a Movies library of .strm titles at /media/movies, and empty
 * /media/shows and /media/extra folders). Its Library, Manage, Plugins and Settings tabs too. Skipped unless HEARTH_EMBY_TEST_URL and
 * HEARTH_EMBY_TEST_KEY_FILE point at such an instance: never run this against one anyone uses. It
 * makes its own throwaway user and removes it; it never changes the admin.
 */

const url = process.env.HEARTH_EMBY_TEST_URL;
const keyFile = process.env.HEARTH_EMBY_TEST_KEY_FILE;
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
const jf = { id: "emby-test", name: "Emby", localUrl: url ?? "" };
const ops = new JellyfinOperations(
  handle,
  broker,
  fetchImpl,
  (ms) => new Promise((r) => setTimeout(r, ms)),
  {
    get: async () => undefined,
    set: async () => undefined,
  },
);
const read: ServarrGet = async (path) => {
  if (path.startsWith("/System/Logs/Log")) {
    const r = await fetch(`${url}${path}`, {
      headers: { Authorization: `MediaBrowser Token="${key}"` },
    });
    return { ok: r.ok, status: r.status, data: await r.text() };
  }
  return jellyfinCall(fetchImpl, url!, key, "GET", path);
};
const NAME = `hearth-emby-${Date.now() % 100000}`;
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
      serviceId: "emby-test",
      requestedBy: "you",
      params: planned.params,
    },
    jf,
  );
  return { planned, done };
}

describe.skipIf(!live)("Emby people and devices against a real test instance", () => {
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
    expect(Array.isArray((await readJellyfinView(read, "plugins", {})).installed)).toBe(true);
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
        serviceId: "emby-test",
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
    // Emby numbers its devices: the one the throwaway user signed in on is the newest phone.
    const devices = (await readJellyfinView(read, "devices", {})).devices as {
      id: string;
      name: string;
      user?: string;
    }[];
    const phone = devices.find((d) => d.name === "Throwaway phone" && d.user === NAME)!;
    expect(phone).toBeDefined();
    expect(devices.some((d) => d.name === "Hearth")).toBe(false);
    const out = await act({ op: "sign-out-device", deviceId: phone.id });
    expect(out.done.ok, out.done.result).toBe(true);
  });

  it("scans every library, and runs a scheduled task", async () => {
    const scan = await act({ op: "scan-all" });
    expect(scan.done.ok, scan.done.result).toBe(true);
    const tasks = await admin("GET", "/ScheduledTasks?isHidden=false");
    const list = tasks.data as unknown as { Id: string; Name: string; State: string }[];
    const idle =
      list.find((x) => x.State === "Idle" && /cache|log|clean/i.test(x.Name)) ?? list[0]!;
    const run = await act({ op: "run-task", taskId: idle.Id });
    expect(run.done.ok, run.done.result).toBe(true);
  });

  const call = (method: string, path: string, body?: unknown) =>
    jellyfinCall(fetchImpl, url!, key, method as "GET", path, body);

  it("browses the library, opens a title, marks it watched and edits its details", async () => {
    const lib = (await readManageView(call as never, "library", {})) as {
      items: { id: string; title: string }[];
    };
    expect(lib.items.length).toBeGreaterThan(0);
    const item = lib.items[0]!;
    const one = (await readManageView(call as never, "item", { id: item.id })) as { title: string };
    expect(one.title).toBe(item.title);
    expect((await act({ op: "watched", itemId: item.id })).done.ok).toBe(true);
    expect((await act({ op: "unwatched", itemId: item.id })).done.ok).toBe(true);
    const edit = await act({
      op: "edit-item",
      itemId: item.id,
      body: JSON.stringify({ sortTitle: `${item.title}, the`, year: 1999 }),
    });
    expect(edit.done.ok, edit.done.result).toBe(true);
    const back = await act({
      op: "edit-item",
      itemId: item.id,
      body: JSON.stringify({ sortTitle: item.title }),
    });
    expect(back.done.ok, back.done.result).toBe(true);
    expect((await act({ op: "refresh-item", itemId: item.id })).done.ok).toBe(true);
  });

  it("adds a library, a folder to it, and takes both away again", async () => {
    const lib = `Hearth test ${Date.now() % 100000}`;
    for (const [params, why] of [
      [{ op: "add-library", name: lib, type: "tvshows", path: "/media/shows" }, "add-library"],
      [{ op: "add-folder", library: lib, path: "/media/extra" }, "add-folder"],
      [{ op: "remove-folder", library: lib, path: "/media/extra" }, "remove-folder"],
      [{ op: "remove-library", library: lib }, "remove-library"],
    ] as const) {
      const r = await act(params);
      expect(r.done.ok, `${why}: ${r.done.result}`).toBe(true);
    }
  });

  it("changes a setting and puts it back, with only Emby's own settings offered", async () => {
    const st = (await readManageView(call as never, "settings", {})) as {
      settings: { id: string; value?: unknown }[];
    };
    expect(st.settings.every((x) => x.value !== undefined)).toBe(true);
    const days = st.settings.find((x) => x.id === "LogFileRetentionDays")!;
    const was = Number(days.value);
    const set = await act({
      op: "set-settings",
      settings: JSON.stringify({ LogFileRetentionDays: was + 1 }),
    });
    expect(set.done.ok, set.done.result).toBe(true);
    const put = await act({
      op: "set-settings",
      settings: JSON.stringify({ LogFileRetentionDays: was }),
    });
    expect(put.done.ok, put.done.result).toBe(true);
  });

  it("removes a plugin (it has no on and off), then restarts Emby", async () => {
    const pl = (await readManageView(call as never, "plugins", {})) as {
      installed: { id: string; name: string; version: string; canRemove?: boolean }[];
    };
    const one = pl.installed.find((x) => /bluray|cinema|backup/i.test(x.name))!;
    await expect(
      ops.plan(jf, { op: "plugin-disable", pluginId: one.id, version: one.version }, base),
    ).rejects.toThrow(/cannot turn a plugin off/);
    const gone = await act({ op: "plugin-uninstall", pluginId: one.id, version: one.version });
    expect(gone.done.ok, gone.done.result).toBe(true);
    const restart = await act({ op: "restart" });
    expect(restart.done.ok, restart.done.result).toBe(true);
  }, 200_000);

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
