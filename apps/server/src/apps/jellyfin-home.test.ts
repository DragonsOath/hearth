import { describe, expect, it } from "vitest";
import { fakeJellyfin } from "./fake-jellyfin";
import { callFor } from "./jellyfin";
import { checkHome, type JellyfinHome } from "./jellyfin-home";
import { planManage, readManageView, runManage } from "./jellyfin-manage";

// Home rows for Jellyfin (11-08): each person's home sections, library order and Recently Added
// rows, read from the stand-in Jellyfin, changed in one approved plan, and read back.

const base = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first" as const,
  policyReason: "",
};
const svc = { name: "Jellyfin" };

function setup() {
  const fake = fakeJellyfin();
  const call = callFor(fake.fetch, "http://jellyfin.test:8096", "e2e-unit");
  const view = async (id?: string) =>
    (await readManageView(call, "home", id ? { id } : {})) as {
      userId: string;
      users: { id: string; name: string }[];
      home: JellyfinHome;
      libraries: { id: string; name: string }[];
      previews: Record<string, { id: string; title: string }[]>;
      plugin: unknown;
    };
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
  return { call, view, save };
}

describe("Jellyfin home rows", () => {
  it("reads the administrator's home screen with Jellyfin's defaults and posters", async () => {
    const { view } = setup();
    const v = await view();
    expect(v.userId).toBe("u1");
    expect(v.users.map((u) => u.name)).toEqual(["Alex", "sam", "kim"]);
    expect(v.home.sections).toEqual([
      "smalllibrarytiles",
      "resume",
      "resumeaudio",
      "resumebook",
      "livetv",
      "nextup",
      "latestmedia",
    ]);
    expect(v.home.order).toEqual(["lib-movies", "lib-shows"]);
    expect(v.home.latest).toEqual(["lib-movies", "lib-shows"]);
    expect(v.previews.resume?.[0]?.title).toBe("Anora");
    // An episode shows its show's poster.
    expect(v.previews.nextup?.[0]).toEqual({ id: "series-harbor", title: "Harbor Lights" });
    expect(v.previews["latest:lib-movies"]?.length).toBe(2);
    expect(v.plugin).toBeNull();
  });

  it("changes sections, library order and Recently Added in one approved step, read back", async () => {
    const { view, save } = setup();
    const { plan, out } = await save({
      u1: {
        sections: ["resume", "nextup", "latestmedia", "smalllibrarytiles"],
        order: ["lib-shows", "lib-movies"],
        latest: ["lib-shows"],
        media: ["lib-shows", "lib-movies"],
        hideWatched: true,
      },
    });
    expect(plan.label).toBe("Change Alex's home screen in Jellyfin");
    const rows = plan.change!.settings!;
    expect(rows.find((r) => r.name === "Alex: home sections")?.after).toBe(
      "Continue Watching, Next Up, Recently Added, My Media",
    );
    expect(rows.find((r) => r.name === "Alex: library order")).toEqual({
      name: "Alex: library order",
      before: "Movies, Shows",
      after: "Shows, Movies",
    });
    expect(rows.find((r) => r.name === "Alex: Recently Added rows")?.after).toBe("Shows");
    expect(out).toMatchObject({ ok: true, verified: true });
    const v = await view("u1");
    expect(v.home.sections).toEqual(["resume", "nextup", "latestmedia", "smalllibrarytiles"]);
    expect(v.home.order).toEqual(["lib-shows", "lib-movies"]);
    expect(v.home.latest).toEqual(["lib-shows"]);
    // What was there before is kept in the plan, so the panel can put it back.
    const before = JSON.parse(String(plan.params!.before)) as Record<string, JellyfinHome>;
    expect(before.u1!.order).toEqual(["lib-movies", "lib-shows"]);
    const undo = await save({ u1: before.u1 });
    expect(undo.out.ok).toBe(true);
    expect((await view("u1")).home).toEqual(before.u1);
  });

  it("gives several people the same home screen, each with only their own libraries", async () => {
    const { view, save } = setup();
    const { plan, out } = await save({
      u2: { sections: ["nextup", "latestmedia"], order: [], latest: ["lib-movies"] },
      u3: { sections: ["nextup", "latestmedia"], order: [], latest: ["lib-movies"] },
    });
    expect(plan.label).toContain("for 2 people");
    expect(out.ok).toBe(true);
    expect((await view("u3")).home.order).toEqual(["lib-movies"]);
    // kim can't see Shows: naming it for her is refused, not silently added.
    await expect(
      save({ u3: { sections: ["nextup"], order: ["lib-shows"], latest: [] } }),
    ).rejects.toThrow("That person has no library lib-shows.");
  });

  it("refuses what Jellyfin can't show, and a change that changes nothing", async () => {
    const { save } = setup();
    expect(() => checkHome({ sections: ["fanart"] }, [])).toThrow(
      "Jellyfin has no home section called fanart.",
    );
    expect(() => checkHome({ sections: ["resume", "resume"] }, [])).toThrow("once");
    await expect(
      save({
        u1: {
          sections: [
            "smalllibrarytiles",
            "resume",
            "resumeaudio",
            "resumebook",
            "livetv",
            "nextup",
            "latestmedia",
          ],
          order: ["lib-movies", "lib-shows"],
          latest: ["lib-movies", "lib-shows"],
        },
      }),
    ).rejects.toThrow("Nothing to change");
    await expect(save({ nobody: { sections: [] } })).rejects.toThrow("has no one with the id");
  });

  it("warns when Home Screen Sections draws the home screen, reading only its switch", async () => {
    const fake = fakeJellyfin();
    const inner = callFor(fake.fetch, "http://jellyfin.test:8096", "e2e-unit");
    const HSS = "b8298e01-2697-407a-b44d-aa8dc795e850";
    const call: typeof inner = async <T>(
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
    ) => {
      if (path === "/Plugins")
        return {
          ok: true,
          status: 200,
          data: [
            { Id: HSS.replace(/-/g, ""), Name: "Home Screen Sections", Status: "Active" },
          ] as T,
        };
      if (path === `/Plugins/${HSS.replace(/-/g, "")}/Configuration`)
        return {
          ok: true,
          status: 200,
          data: { Enabled: true, JellyseerrApiKey: "secret-key-123" } as T,
        };
      return inner<T>(method, path, body);
    };
    const v = await readManageView(call, "home", {});
    expect(v.plugin).toEqual({ name: "Home Screen Sections", active: true, replacesHome: true });
    expect(JSON.stringify(v)).not.toContain("secret-key-123");
  });
});
