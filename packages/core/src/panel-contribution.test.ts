import { describe, expect, it } from "vitest";
import {
  canonicalImage,
  canonicalJson,
  contributionFile,
  contributionProblems,
  panelChange,
  publishedTexts,
  readPanelFile,
  specHashInput,
} from "./panel-contribution";
import type { PanelSpec } from "./panel-spec";

const base = (): PanelSpec => ({
  specVersion: 1,
  id: "community.zoneminder.cameras",
  title: "Cameras",
  serviceId: "svc-zm",
  refreshSeconds: 60,
  reads: [
    { id: "monitors", path: "/zm/api/monitors.json" },
    { id: "events", path: "/zm/api/events/index.json" },
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
      good: ["Record"],
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
  ],
});

describe("the published file", () => {
  it("holds the design only: no service id, no private registry, no tag, no install name", () => {
    const f = contributionFile(base(), "registry.home.lan:5000/zoneminderhq/zoneminder-base:1.36", {
      version: 1,
      acceptedAt: "2026-11-10T00:00:00Z",
    });
    expect(f.spec.serviceId).toBe("");
    expect(f.app).toEqual({ name: "zoneminder", image: "zoneminderhq/zoneminder-base" });
    expect(JSON.stringify(f)).not.toContain("svc-zm");
    expect(JSON.stringify(f)).not.toContain("home.lan");
    expect(f.readme).toMatch(/^Cameras: a custom panel for zoneminder/);
  });

  it("is the same text for the same panel, whatever order its keys were in", () => {
    const a = base();
    const b = JSON.parse(JSON.stringify(a)) as PanelSpec;
    const reversed = Object.fromEntries(Object.entries(b).reverse()) as unknown as PanelSpec;
    expect(specHashInput(reversed)).toBe(specHashInput(a));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("lists every published text with where it is, for the preview", () => {
    const where = publishedTexts(contributionFile(base(), undefined)).map((t) => t.where);
    expect(where).toContain('Read "monitors"');
    expect(where).toContain('Block "recent" (table) columns 2 label');
    expect(where).toContain("Panel title");
  });

  it("drops images it cannot read safely", () => {
    expect(canonicalImage("plexinc/pms-docker:latest")).toBe("plexinc/pms-docker");
    expect(canonicalImage("localhost:5000/me/app")).toBe("me/app");
    expect(canonicalImage("ghcr.io/owner/app@sha256:abcdef")).toBe("owner/app");
    expect(canonicalImage("bad image with spaces")).toBeUndefined();
  });
});

describe("the privacy backstop on everything published", () => {
  const problems = (edit: (s: PanelSpec) => void) => {
    const s = base();
    edit(s);
    return contributionProblems(contributionFile(s, undefined)).map(
      (p) => `${p.where}: ${p.problem}`,
    );
  };
  it("passes a clean panel", () => {
    expect(problems(() => {})).toEqual([]);
  });
  it.each([
    [
      "an IP",
      (s: PanelSpec) => void ((s.blocks[0] as { text: string }).text = "NVR at 192.168.1.20"),
      /IP address/,
    ],
    ["a local name", (s: PanelSpec) => void (s.title = "nvr.lan cameras"), /local network name/],
    ["a domain", (s: PanelSpec) => void (s.title = "cams.smithfamily.net"), /domain name/],
    ["an email", (s: PanelSpec) => void (s.title = "alex@example.com cams"), /email/],
    [
      "a token in a path",
      (s: PanelSpec) => void (s.reads[0]!.path = "/zm/api/monitors.json?token=abc"),
      /key or password in a path/,
    ],
    [
      "a long key",
      (s: PanelSpec) => void (s.title = "k3y9f8a7s6d5f4g3h2j1k0l9z8x7"),
      /key or token/,
    ],
    ["a mention", (s: PanelSpec) => void (s.title = "Cameras @everyone"), /@ or #/],
    [
      "a UUID path",
      (s: PanelSpec) => void (s.reads[0]!.path = "/api/cams/5f0c7a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a"),
      /UUID/,
    ],
    [
      "a long id in a path",
      (s: PanelSpec) => void (s.reads[0]!.path = "/api/users/1234567/feeds"),
      /long number/,
    ],
    ["a phone number", (s: PanelSpec) => void (s.title = "Call 555 123 4567"), /phone/],
    ["a backtick", (s: PanelSpec) => void (s.title = "Cams ``` break"), /backtick/],
  ])("flags %s, naming where it is", (_n, edit, re) => {
    const out = problems(edit);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(" ")).toMatch(re);
  });
});

describe("minor or substantial: the Free plan's rule, decided by Hearth, not Ember", () => {
  it("wording, order, refresh, state colours, fewer blocks and fewer columns are minor", () => {
    const next = base();
    next.title = "My cameras";
    next.refreshSeconds = 30;
    next.blocks.reverse();
    (next.blocks.find((b) => b.id === "cams") as { good: string[] }).good = ["Record", "Modect"];
    next.blocks = next.blocks.filter((b) => b.id !== "count");
    const t = next.blocks.find((b) => b.id === "recent") as {
      columns: { label: string; field: string }[];
    };
    t.columns = [{ label: "Which camera", field: "Event.MonitorId" }];
    expect(panelChange(base(), next)).toEqual({ change: "minor", reasons: [] });
  });

  it("the same panel is the same", () => {
    expect(panelChange(base(), { ...base(), serviceId: "other" }).change).toBe("same");
  });

  it("new reads, new blocks, new columns, buttons and a different key are substantial, with reasons", () => {
    const read = base();
    read.reads.push({ id: "disk", path: "/zm/api/host/getDiskPercent.json" });
    read.blocks.push({
      kind: "stat",
      id: "disk",
      read: "disk",
      label: "Disk",
      field: "usage.Total.space",
    });
    expect(panelChange(base(), read)).toMatchObject({
      change: "substantial",
      reasons: [expect.stringMatching(/block "disk"/)],
    });

    const field = base();
    (field.blocks[1] as { field: string }).field = "pagination.count";
    expect(panelChange(base(), field).change).toBe("substantial");

    const column = base();
    (column.blocks[3] as { columns: { label: string; field: string }[] }).columns.push({
      label: "Cause",
      field: "Event.Cause",
    });
    expect(panelChange(base(), column).reasons.join(" ")).toMatch(/new columns \(Event.Cause\)/);

    const button = base();
    button.blocks.push({
      kind: "button",
      id: "rec",
      label: "Record",
      method: "PUT",
      path: "/zm/api/monitors/1.json",
      why: "Record",
    });
    expect(panelChange(base(), button).change).toBe("substantial");

    const key = { ...base(), auth: "query:token" };
    expect(panelChange(base(), key).reasons).toContain("it sends the app's key differently");
  });
});

describe("loading a panel file", () => {
  it("reads the spec for this app and the receipt it carries; says plainly when it is not one", () => {
    const file = { ...contributionFile(base(), undefined), accepted: "HEARTHR1.x.y" };
    const ok = readPanelFile(JSON.parse(JSON.stringify(file)), "svc-other");
    expect(ok).toMatchObject({ spec: { serviceId: "svc-other" }, receipt: "HEARTHR1.x.y" });
    expect(readPanelFile({ hello: 1 }, "x")).toEqual({ error: "This is not a Hearth panel file." });
    expect(readPanelFile({ ...file, formatVersion: 2 }, "x")).toMatchObject({
      error: expect.stringMatching(/newer Hearth/),
    });
  });
});
