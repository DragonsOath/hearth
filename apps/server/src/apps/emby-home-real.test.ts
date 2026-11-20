import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { EmbyHome, EmbyRow } from "./emby-home";
import { JellyfinOperations, jellyfinCall } from "./jellyfin";
import { readManageView } from "./jellyfin-manage";

/**
 * Home rows for Emby against a real, disposable Emby Server 4.10.2 (a Movies and a Shows library,
 * a second person). Skipped unless HEARTH_EMBY_TEST_URL and HEARTH_EMBY_TEST_KEY_FILE point at
 * such an instance: never run this against one anyone uses. It changes people's home screens.
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
const emby = { id: "emby-test", name: "Emby", localUrl: url ?? "" };
const ops = new JellyfinOperations(
  handle,
  broker,
  fetchImpl,
  (ms) => new Promise((r) => setTimeout(r, ms)),
  { get: async () => undefined, set: async () => undefined },
);
const call = <T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) =>
  jellyfinCall<T>(fetchImpl, url!, key, method, path, body);

interface View {
  kind?: string;
  users: { id: string; name: string; admin: boolean }[];
  userId: string;
  home: EmbyHome;
  libraries: { id: string; name: string; type: string }[];
  collections: { id: string; name: string }[];
  previews: Record<string, { id: string }[]>;
  found?: { id: string; title: string }[];
}
const view = (q: Record<string, string> = {}) =>
  readManageView(call, "home", q) as unknown as Promise<View>;

async function act(params: StepParams) {
  const planned = await ops.plan(emby, params, base);
  const done = await ops.run(
    {
      kind: "app-jellyfin-control",
      serviceId: "emby-test",
      requestedBy: "you",
      params: planned.params,
    },
    emby,
  );
  return { planned, done };
}
const types = (h: EmbyHome) => h.rows.map((r) => r.type);

describe.skipIf(!live)("Emby Home rows against a real test instance", () => {
  // Everyone starts from the same home: My Media, Continue Watching, Latest Media.
  beforeAll(async () => {
    const v = await view();
    const homes: Record<string, EmbyHome> = {};
    for (const u of v.users)
      homes[u.id] = {
        ...v.home,
        rows: [{ type: "userviews" }, { type: "resume" }, { type: "latestmediablock" }],
      };
    await act({ op: "home-screen", homes: JSON.stringify(homes) }).catch(() => undefined);
  });

  it("reads each person's rows with posters, and what rows can be built from", async () => {
    const v = await view();
    expect(v.kind).toBe("emby");
    expect(v.users.length).toBeGreaterThanOrEqual(2);
    expect(types(v.home)).toContain("latestmediablock");
    expect(v.libraries.map((l) => l.type)).toEqual(expect.arrayContaining(["movies", "tvshows"]));
    expect(Object.keys(v.previews).some((k) => k.startsWith("latest:"))).toBe(true);
    const found = await view({ q: "elf" });
    expect(found.found?.[0]?.title).toBe("Elf");
  });

  it("adds a hand-picked row and a filtered row, moves and removes rows, read back, then Undo", async () => {
    const v = await view();
    const me = v.userId;
    const elf = (await view({ q: "elf" })).found![0]!.id;
    const rows: EmbyRow[] = [
      { type: "boxset", name: `Hearth test ${Date.now() % 1000}`, titles: [elf] },
      ...v.home.rows.filter((r) => r.type !== "resumeaudio"),
      {
        type: "items",
        name: "Unwatched movies",
        itemTypes: ["Movie"],
        unwatched: true,
        sortBy: "Random",
      },
    ];
    const latest = rows.find((r) => r.type === "latestmediablock")!;
    latest.excluded = [v.libraries.find((l) => l.type === "tvshows")!.id];
    const want: EmbyHome = { ...v.home, rows, order: [...v.home.order].reverse() };
    const { planned, done } = await act({
      op: "home-screen",
      homes: JSON.stringify({ [me]: want }),
    });
    expect(planned.change?.settings.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/home rows/),
        expect.stringMatching(/new collection/),
      ]),
    );
    expect(done).toMatchObject({ ok: true, verified: true });

    const after = (await view({ id: me })).home;
    expect(types(after)).toEqual(rows.map((r) => r.type));
    expect(after.rows[0]!.parentId).toBeTruthy();
    expect(after.rows.find((r) => r.type === "latestmediablock")!.excluded).toEqual(
      latest.excluded,
    );
    expect(after.rows.at(-1)).toMatchObject({ name: "Unwatched movies", unwatched: true });
    expect(after.order).toEqual(want.order);
    // The new row shows its title on the home screen.
    const shown = await view({ id: me });
    expect(
      Object.values(shown.previews)
        .flat()
        .some((p) => p.id === elf),
    ).toBe(true);

    // Undo: the approved before, put back.
    const undo = await act({ op: "home-screen", homes: String(planned.params?.before) });
    expect(undo.done).toMatchObject({ ok: true, verified: true });
    const back = (await view({ id: me })).home;
    expect(types(back)).toEqual(types(v.home));
    expect(back.order).toEqual(v.home.order);
  });

  it("gives one home screen to two people at once", async () => {
    const v = await view();
    const other = v.users.find((u) => u.id !== v.userId)!;
    const rows: EmbyRow[] = [
      { type: "resume" },
      { type: "boxset", name: "Their row", parentId: v.collections[0]!.id },
      { type: "userviews" },
    ];
    const home = { ...v.home, rows };
    const { done } = await act({
      op: "home-screen",
      homes: JSON.stringify({ [v.userId]: home, [other.id]: home }),
    });
    expect(done).toMatchObject({ ok: true, verified: true });
    for (const id of [v.userId, other.id])
      expect(types((await view({ id })).home)).toEqual(["resume", "boxset", "userviews"]);
  });

  it("removes a row from a home screen never changed (Emby's defaults, not yet saved)", async () => {
    const made = await call<{ Id: string }>("POST", "/Users/New", {
      Name: `hearth-new-${Date.now() % 100000}`,
    });
    const id = made.data.Id;
    try {
      const v = await view({ id });
      expect(types(v.home)).toContain("latestmediablock");
      const rows: EmbyRow[] = [{ type: "resume" }, { type: "userviews" }];
      const { done } = await act({
        op: "home-screen",
        homes: JSON.stringify({ [id]: { ...v.home, rows } }),
      });
      expect(done).toMatchObject({ ok: true, verified: true });
      expect(types((await view({ id })).home)).toEqual(["resume", "userviews"]);
    } finally {
      await call("DELETE", `/Users/${id}`).catch(() => undefined);
    }
  });

  it("refuses rows Emby doesn't have, and says when nothing changes", async () => {
    const v = await view();
    await expect(
      ops.plan(
        emby,
        {
          op: "home-screen",
          homes: JSON.stringify({ [v.userId]: { ...v.home, rows: [{ type: "nope" }] } }),
        },
        base,
      ),
    ).rejects.toThrow(/no home row called nope/);
    await expect(
      ops.plan(emby, { op: "home-screen", homes: JSON.stringify({ [v.userId]: v.home }) }, base),
    ).rejects.toThrow(/Nothing to change/);
  });
});
