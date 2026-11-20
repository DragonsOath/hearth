import { describe, expect, it } from "vitest";
import { checkEmbyHome, rowKey, type EmbyHome, type EmbyRow } from "./emby-home";
import { fakeJellyfin } from "./fake-jellyfin";
import { callFor } from "./jellyfin";
import { planManage, readManageView, runManage } from "./jellyfin-manage";

// Home rows for Emby (11-09): Emby's own home rows, read from the stand-in Emby (which answers as
// the real 4.10.2 did), changed in one approved plan, read back, and put back with Undo.

const base = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first" as const,
  policyReason: "",
};
const svc = { name: "Emby" };

interface View {
  kind?: string;
  userId: string;
  users: { id: string; name: string }[];
  home: EmbyHome;
  libraries: { id: string; name: string }[];
  previews: Record<string, { id: string; title: string }[]>;
  collections: { id: string; name: string }[];
  genres: { id: string; name: string }[];
  found?: { id: string; title: string }[];
}

function setup(emby = true) {
  const fake = fakeJellyfin({ emby });
  const call = callFor(fake.fetch, "http://emby.test:8096", "e2e-unit");
  const view = async (q: Record<string, string> = {}) =>
    (await readManageView(call, "home", q)) as unknown as View;
  const save = async (homes: Record<string, unknown>) => {
    const plan = await planManage(
      call,
      svc,
      "home-screen",
      { op: "home-screen", homes: JSON.stringify(homes) },
      base,
    );
    return {
      plan,
      out: await runManage(call, svc, "home-screen", plan.params!, async () => undefined),
    };
  };
  return { view, save };
}
const types = (h: EmbyHome) => h.rows.map((r) => r.type);

describe("Emby home rows", () => {
  it("reads Emby's own rows, with posters per library and what rows can be built from", async () => {
    const v = await setup().view();
    expect(v.kind).toBe("emby");
    expect(types(v.home)).toEqual(["userviews", "resume", "latestmediablock"]);
    expect(v.previews["latest:lib-movies"]?.length).toBeGreaterThan(0);
    expect(v.genres.map((g) => g.name)).toEqual(["Comedy", "Drama"]);
  });

  it("Jellyfin keeps its own editor", async () => {
    const v = await setup(false).view();
    expect(v.kind).toBeUndefined();
  });

  it("a hand-picked row becomes a collection, then a row of it, first; Undo puts it back", async () => {
    const { view, save } = setup();
    const v = await view();
    const anora = (await view({ q: "anora" })).found![0]!.id;
    const rows: EmbyRow[] = [
      { type: "boxset", name: "Award winners", titles: [anora] },
      ...v.home.rows,
      { type: "items", name: "Comedies", itemTypes: ["Movie"], genreIds: ["g-comedy"] },
    ];
    const { plan, out } = await save({ [v.userId]: { ...v.home, rows } });
    expect(plan.change?.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Alex: new collection",
          after: "Award winners (1 title)",
        }),
      ]),
    );
    expect(out).toMatchObject({ ok: true, verified: true });
    const after = await view();
    expect(types(after.home)).toEqual([
      "boxset",
      "userviews",
      "resume",
      "latestmediablock",
      "items",
    ]);
    expect(after.collections.map((c) => c.name)).toEqual(["Award winners"]);
    expect(after.previews[after.home.rows[0]!.id!]?.map((p) => p.id)).toEqual([anora]);

    const undo = await save(JSON.parse(String(plan.params?.before)) as Record<string, unknown>);
    expect(undo.out).toMatchObject({ ok: true, verified: true });
    expect(types((await view()).home)).toEqual(["userviews", "resume", "latestmediablock"]);
  });

  it("removes Emby's own rows, moves them, and leaves a library out of Latest Media", async () => {
    const { view, save } = setup();
    const v = await view();
    const [media, resume, latest] = v.home.rows;
    const rows = [{ ...latest!, excluded: ["lib-shows"] }, media!];
    const { out } = await save({ [v.userId]: { ...v.home, rows } });
    expect(out).toMatchObject({ ok: true, verified: true });
    const after = (await view()).home;
    expect(after.rows.map((r) => r.id)).toEqual([latest!.id, media!.id]);
    expect(after.rows[0]!.excluded).toEqual(["lib-shows"]);
    expect(after.rows.some((r) => r.id === resume!.id)).toBe(false);
  });

  it("one home screen for two people, one of them never changed theirs", async () => {
    const { view, save } = setup();
    const v = await view();
    const other = v.users.find((u) => u.id !== v.userId)!;
    const rows: EmbyRow[] = [{ type: "resume" }, { type: "userviews" }];
    const home = { ...v.home, rows };
    const { out } = await save({ [v.userId]: home, [other.id]: home });
    expect(out).toMatchObject({ ok: true, verified: true });
    for (const id of [v.userId, other.id])
      expect(types((await view({ id })).home)).toEqual(["resume", "userviews"]);
  });

  it("says when nothing changes, and refuses what Emby doesn't have", async () => {
    const { view, save } = setup();
    const v = await view();
    await expect(save({ [v.userId]: v.home })).rejects.toThrow(/Nothing to change/);
    await expect(save({ [v.userId]: { ...v.home, rows: [{ type: "nope" }] } })).rejects.toThrow(
      /no home row called nope/,
    );
  });
});

describe("checking an Emby home screen", () => {
  const libs = ["lib-movies", "lib-shows"];
  it("needs a collection for a collection row and a name for hand-picked titles", () => {
    expect(() => checkEmbyHome({ rows: [{ type: "boxset" }] }, libs, [])).toThrow(
      /which collection/,
    );
    expect(() => checkEmbyHome({ rows: [{ type: "boxset", titles: ["a"] }] }, libs, [])).toThrow(
      /a name/,
    );
    expect(() =>
      checkEmbyHome({ rows: [{ type: "items", itemTypes: ["Book"] }] }, libs, []),
    ).toThrow(/can't hold Book/);
    expect(() =>
      checkEmbyHome({ rows: [{ type: "latestmediablock", excluded: ["lib-x"] }] }, libs, []),
    ).toThrow(/no library lib-x/);
  });

  it("a row's key ignores its id and what its type doesn't use", () => {
    expect(rowKey({ id: "a", type: "resume" })).toBe(rowKey({ type: "resume", genreIds: ["g"] }));
    expect(rowKey({ type: "items", itemTypes: ["Movie"], unwatched: true })).not.toBe(
      rowKey({ type: "items", itemTypes: ["Movie"] }),
    );
  });
});
