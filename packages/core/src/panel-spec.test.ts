import { describe, expect, it } from "vitest";
import {
  keptSpec,
  panelImageAllowed,
  pickField,
  resolvePanel,
  validatePanelSpec,
  type PanelSpec,
} from "./panel-spec";

const zm = (): PanelSpec => ({
  specVersion: 1,
  id: "community.zoneminder.cameras",
  title: "Cameras",
  serviceId: "svc-zm",
  refreshSeconds: 60,
  reads: [
    { id: "monitors", path: "/zm/api/monitors.json" },
    { id: "events", path: "/zm/api/events/index.json?sort=StartTime&direction=desc" },
  ],
  blocks: [
    { kind: "heading", id: "top", text: "Cameras" },
    { kind: "stat", id: "count", read: "monitors", label: "Cameras", field: "monitors.length" },
    {
      kind: "status-list",
      id: "cams",
      read: "monitors",
      items: "monitors",
      name: "Monitor.Name",
      state: "Monitor.Function",
      good: ["Record", "Modect"],
      bad: ["None"],
    },
    {
      kind: "image-grid",
      id: "snaps",
      read: "monitors",
      items: "monitors",
      image: "/zm/cgi-bin/nph-zms?mode=single&monitor={Monitor.Id}",
      caption: "Monitor.Name",
    },
    {
      kind: "table",
      id: "recent",
      read: "events",
      items: "events",
      columns: [
        { label: "Camera", field: "Event.MonitorId" },
        { label: "Length", field: "Event.Length", format: "number" },
      ],
    },
    { kind: "link", id: "open", label: "Open the console", path: "/zm/" },
    {
      kind: "button",
      id: "rec",
      label: "Record on camera 1",
      method: "PUT",
      path: "/zm/api/monitors/1.json",
      body: '{"Monitor":{"Function":"Record"}}',
      why: "Sets camera 1 to record",
    },
  ],
});

const at = (spec: unknown, sid = "svc-zm") => validatePanelSpec(spec, sid).map((i) => i.message);

describe("custom panel specs: what the validator allows", () => {
  it("a good spec passes", () => {
    expect(validatePanelSpec(zm(), "svc-zm")).toEqual([]);
  });

  it("refuses another app's address, Hearth's own API by host, and paths the broker would refuse", () => {
    for (const path of [
      "http://other:8080/api",
      "//other/api",
      "/api/../../etc/passwd",
      "/a@evil/b",
      "api/no-slash",
      "/has space",
    ]) {
      const s = zm();
      s.reads[0]!.path = path;
      expect(at(s).join(" "), path).toMatch(/path/);
    }
  });

  it("refuses a spec for another app", () => {
    expect(at(zm(), "svc-plex").join(" ")).toMatch(/only its own app/);
  });

  it("refuses markup in a label, refresh under 15 s, 13 reads and an unknown block", () => {
    const html = zm();
    (html.blocks[0] as { text: string }).text = "<img src=x onerror=alert(1)>";
    expect(at(html).join(" ")).toMatch(/plain words/);

    const fast = zm();
    fast.refreshSeconds = 5;
    expect(at(fast).join(" ")).toMatch(/refreshSeconds/);

    const many = zm();
    many.reads = Array.from({ length: 13 }, (_, i) => ({ id: `r${i}`, path: `/r/${i}` }));
    many.blocks = [{ kind: "heading", id: "h", text: "x" }];
    expect(at(many).join(" ")).toMatch(/At most 12 reads/);

    const odd = zm() as unknown as { blocks: unknown[] };
    odd.blocks.push({ kind: "iframe", id: "x", src: "https://evil" });
    expect(at(odd).join(" ")).toMatch(/not a block Hearth has/);
  });

  it("refuses unknown fields, code in field paths, and a button that only reads", () => {
    const extra = zm() as unknown as Record<string, unknown>;
    extra.script = "alert(1)";
    expect(at(extra).join(" ")).toMatch(/Unknown field "script"/);

    const code = zm();
    (code.blocks[1] as { field: string }).field = "constructor.prototype";
    expect(at(code).join(" ")).toMatch(/field path/);

    const get = zm();
    (get.blocks[6] as { method: string }).method = "GET";
    expect(at(get).join(" ")).toMatch(/proposes a change/);
  });

  it("a block naming a read that does not exist is refused", () => {
    const s = zm();
    (s.blocks[1] as { read: string }).read = "nope";
    expect(at(s).join(" ")).toMatch(/one of this panel's reads/);
  });
});

describe("drawing a panel from its reads", () => {
  const monitors = {
    monitors: [
      { Monitor: { Id: "1", Name: "Front door", Function: "Record" } },
      { Monitor: { Id: "2", Name: "Garage", Function: "None" } },
    ],
  };

  it("works out each block, and a failing read marks only its blocks not possible", () => {
    const out = resolvePanel(zm(), {
      monitors: { ok: true, data: monitors },
      events: { ok: false, reason: "The app answered 401." },
    });
    const by = Object.fromEntries(out.map((b) => [b.id, b]));
    expect(by.count?.view).toEqual({ kind: "stat", label: "Cameras", value: 2 });
    expect(by.cams?.view).toMatchObject({
      rows: [
        { name: "Front door", state: "Record", tone: "good" },
        { name: "Garage", state: "None", tone: "bad" },
      ],
    });
    expect(by.snaps?.view).toMatchObject({
      images: [
        { path: "/zm/cgi-bin/nph-zms?mode=single&monitor=1", caption: "Front door" },
        { path: "/zm/cgi-bin/nph-zms?mode=single&monitor=2", caption: "Garage" },
      ],
    });
    expect(by.recent).toMatchObject({ state: "not-possible", reason: "The app answered 401." });
    expect(by.open?.state).toBe("real");
  });

  it("a block that no longer fits says needs an update while the rest still draw", () => {
    const s = zm() as unknown as { blocks: Record<string, unknown>[] };
    s.blocks.push({ kind: "retired-widget", id: "old" });
    const out = resolvePanel(s as unknown as PanelSpec, { monitors: { ok: true, data: monitors } });
    expect(out.find((b) => b.id === "old")?.state).toBe("needs-update");
    expect(out.find((b) => b.id === "count")?.state).toBe("real");
  });

  it("a list that is not a list says so instead of inventing rows", () => {
    const out = resolvePanel(zm(), { monitors: { ok: true, data: { monitors: "x" } } });
    expect(out.find((b) => b.id === "cams")).toMatchObject({ state: "not-possible" });
  });

  it("field paths read own properties only", () => {
    expect(pickField({ a: { b: [1, 2] } }, "a.b.length")).toBe(2);
    expect(pickField({ a: { b: [1, 2] } }, "a.b.1")).toBe(2);
    expect(pickField({}, "toString")).toBeUndefined();
    expect(pickField({ a: 1 }, "__proto__")).toBeUndefined();
  });

  it("the image proxy only serves paths the panel's image blocks make", () => {
    expect(panelImageAllowed(zm(), "/zm/cgi-bin/nph-zms?mode=single&monitor=1")).toBe(true);
    expect(panelImageAllowed(zm(), "/zm/api/host/getConfig.json")).toBe(false);
    expect(panelImageAllowed(zm(), "/zm/cgi-bin/nph-zms?mode=single&monitor=1/../x")).toBe(false);
  });

  it("installing keeps only the kept blocks", () => {
    expect(keptSpec(zm(), ["snaps", "rec"]).blocks.map((b) => b.id)).toEqual([
      "top",
      "count",
      "cams",
      "recent",
      "open",
    ]);
    // A read no kept block uses is not installed.
    const onlyStats = keptSpec(zm(), ["recent", "rec"]);
    expect(onlyStats.reads.map((r) => r.id)).toEqual(["monitors"]);
  });
});

describe("a wrong field path is never drawn as real", () => {
  it("a number missing from the answer, or a list whose items lack the field, says not possible", () => {
    const s = zm();
    (s.blocks[1] as { field: string }).field = "monitor.count";
    (s.blocks[2] as { name: string }).name = "Name";
    const out = resolvePanel(s, {
      monitors: { ok: true, data: { monitors: [{ Monitor: { Name: "Front door" } }] } },
    });
    expect(out.find((b) => b.id === "count")).toMatchObject({
      state: "not-possible",
      reason: expect.stringMatching(/monitor\.count/),
    });
    expect(out.find((b) => b.id === "cams")).toMatchObject({
      state: "not-possible",
      reason: expect.stringMatching(/"Name"/),
    });
    // An empty list is the app having nothing, which is real.
    const empty = resolvePanel(zm(), { monitors: { ok: true, data: { monitors: [] } } });
    expect(empty.find((b) => b.id === "cams")?.state).toBe("real");
  });
});

describe("posters on a table of movies and shows (the owner, 11-14)", () => {
  const spec = (): PanelSpec => ({
    specVersion: 1,
    id: "community.tasterr.picks",
    title: "Tasterr picks",
    refreshSeconds: 300,
    serviceId: "svc-zm",
    reads: [{ id: "recs", path: "/api/v1/recommendations" }],
    blocks: [
      {
        kind: "table",
        id: "recs",
        read: "recs",
        items: "results",
        poster: "poster_path",
        columns: [
          { label: "Title", field: "title" },
          { label: "Year", field: "year", format: "number" },
        ],
      },
    ],
  });

  it("is allowed, and only a poster file name is shown", () => {
    expect(at(spec())).toEqual([]);
    expect(at({ ...spec(), blocks: [{ ...spec().blocks[0], poster: "a;b()" }] })).not.toEqual([]);
    const [b] = resolvePanel(spec(), {
      recs: {
        ok: true,
        data: {
          results: [
            { title: "Runner", year: 2026, poster_path: "/abc123.jpg" },
            { title: "Ick", year: 2025, poster_path: "https://evil.example/x.jpg" },
            { title: "Alice", year: 2009 },
          ],
        },
      },
    });
    expect(b?.view).toMatchObject({ posters: ["/abc123.jpg", null, null] });
  });
});
