import { describe, expect, it } from "vitest";
import type { ImportPayload } from "@dragon-control/core";
import { triageDrafts, type TriageContext, type TriageDraft } from "./triage";

const system: TriageContext["system"] = {
  real: true,
  hosts: [{ id: "atlas", name: "Atlas", os: "Ubuntu 24.04", lastSeenAt: "2026-10-08T10:00:00Z" }],
  services: [
    { name: "Plex (plex)", hostId: "atlas", localUrl: "http://10.0.0.5:32400" },
    { name: "Sonarr", hostId: "atlas", localUrl: "http://10.0.0.5:8989" },
    { name: "Gluetun VPN (gluetun)", hostId: "atlas" },
  ],
};
const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  system,
  entries: [],
  sessions: [],
  projectNames: [],
  ...over,
});

let n = 0;
function entry(
  e: Partial<Extract<ImportPayload, { kind: "entry" }>["entry"]>,
  note = "section",
): TriageDraft {
  return {
    id: `d${++n}`,
    note,
    payload: {
      kind: "entry",
      entry: {
        kind: "note",
        title: "Untitled",
        projectName: "Media",
        happenedAt: "2026-08-01T12:00:00Z",
        ...e,
      },
    },
  };
}

const run = (drafts: TriageDraft[], c = ctx()) => {
  const t = triageDrafts(drafts, c);
  return (d: TriageDraft) => t.get(d.id)!;
};

describe("sorting imported drafts for review", () => {
  it("trusts dated history, even when it describes an older setup", () => {
    const old = entry(
      {
        kind: "journal",
        title: "Plex updated",
        body: "Updated Plex Media Server on Windows from C:\\Program Files\\Plex.",
      },
      "dated section",
    );
    const t = run([old])(old);
    expect(t.tier).toBe("confident");
    expect(t.supersede).toBeUndefined();
    expect(t.reasons.map((r) => r.text).join(" ")).toMatch(
      /setup at the time.*Plex on Windows.*Atlas/,
    );
  });

  it("marks current-sounding notes that conflict with what it sees as history", () => {
    const note = entry(
      {
        title: "Sonarr",
        body: "Config: M:\\Docker\\config\\sonarr\\config.xml.\nRuns on Docker Desktop with the rest of the stack.",
      },
      "reference document",
    );
    const port = entry({
      title: "Plex notes",
      body: "Plex answers on localhost:32401 for the TV.",
    });
    const get = run([note, port]);
    expect(get(note)).toMatchObject({ tier: "review" });
    expect(get(note).supersede).toMatch(/Sonarr on Windows.*Atlas \(Ubuntu 24\.04\)/);
    expect(get(port).supersede).toMatch(/port 32401.*32400/);
  });

  it("does not treat a sentence about a move as a claim about now", () => {
    const moved = entry(
      { title: "Plex", body: "Plex was moved off Windows to Atlas last month." },
      "reference document",
    );
    const t = run([moved])(moved);
    expect(t.supersede).toBeUndefined();
    expect(t.tier).toBe("confident");
    expect(t.reasons[0]!.kind).toBe("verified");
  });

  it("flags open threads that mention the old setup without closing them", () => {
    const thread = entry({
      kind: "thread",
      status: "open",
      title: "Season 1 missing",
      body: "D:\\Shows\\Example is missing Season 1 in Sonarr.",
    });
    const t = run([thread])(thread);
    expect(t.tier).toBe("review");
    expect(t.supersede).toBeUndefined();
    expect(t.reasons.some((r) => r.kind === "conflict")).toBe(true);
  });

  it("recognises helpers by the start of their name, and documents about removed apps", () => {
    const vpn = entry(
      { title: "Gluetun — VPN Tunnels", body: "Two tunnels." },
      "reference document",
    );
    const gone = entry(
      { title: "Homarr — REMOVED 2026-09-11", body: "Was a dashboard." },
      "reference document",
    );
    const unknown = entry(
      { title: "Caddy — Reverse Proxy", body: "Fronts every hostname." },
      "reference document",
    );
    const get = run([vpn, gone, unknown]);
    expect(get(vpn).reasons[0]!.text).toMatch(/Gluetun VPN on Atlas/);
    expect(get(gone)).toMatchObject({ tier: "confident" });
    expect(get(gone).supersede).toMatch(/removed/);
    expect(get(unknown)).toMatchObject({ tier: "review", reasons: [{ kind: "unverified" }] });
  });

  it("finds duplicates of other drafts and of existing memories, keeping the fuller copy", () => {
    const short = entry({
      kind: "journal",
      title: "Blocknews redemption received",
      body: "750 GB block.",
    });
    const full = entry({
      kind: "journal",
      title: "Blocknews 750 GB redemption received (progress)",
      body: "The 750 GB Blocknews block arrived by email and was added to SABnzbd as a backup server.",
    });
    const sameSubjectOtherEvent = entry({
      kind: "journal",
      title: "Blocknews 750 GB redemption received (takeover)",
      body: "Codex took over.",
    });
    const known = entry({ kind: "journal", title: "Moved Plex to Atlas", body: "Done." });
    const get = run(
      [short, full, sameSubjectOtherEvent, known],
      ctx({
        entries: [
          {
            id: "m1",
            title: "Moved Plex to Atlas",
            body: "Done.",
            happenedAt: "2026-08-01T12:00:00Z",
          },
        ],
      }),
    );
    expect(get(short)).toMatchObject({ tier: "skip", duplicateOf: { type: "draft", id: full.id } });
    expect(get(full).tier).toBe("confident");
    expect(get(sameSubjectOtherEvent).tier).toBe("confident");
    expect(get(known)).toMatchObject({ tier: "skip", duplicateOf: { type: "entry", id: "m1" } });
  });

  it("sets aside material that is not about the homelab, and judges sessions by what you said", () => {
    const off = entry({
      kind: "journal",
      projectName: undefined,
      title: "Session: Resume rewrite",
      body: "Rewrote the resume summary.\nTightened three bullet points for the job.",
    });
    const session = (share: number): TriageDraft => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        seq: i + 1,
        role: "you" as const,
        text: i < share * 10 ? "Sonarr is stuck again" : "what should I cook tonight",
      }));
      return {
        id: `s${share}`,
        note: "session",
        payload: {
          kind: "session",
          session: { client: "claude-code", title: "x", sessionRef: `r${share}`, messages },
        },
      };
    };
    const [a, b, c] = [session(0.5), session(0.2), session(0.1)];
    const saved = { ...session(0.9), id: "s-saved" };
    const get = run(
      [off, a, b, c, saved],
      ctx({ sessions: [{ id: "t1", sessionRef: "r0.9", title: "Already here" }] }),
    );
    expect(get(off)).toMatchObject({ tier: "skip", reasons: [{ kind: "unrelated" }] });
    expect([get(a).tier, get(b).tier, get(c).tier]).toEqual(["confident", "review", "skip"]);
    expect(get(saved)).toMatchObject({
      tier: "skip",
      duplicateOf: { type: "transcript", id: "t1" },
    });
  });

  it("compares nothing with sample data", () => {
    const note = entry(
      { title: "Sonarr", body: "Runs on Docker Desktop on Windows." },
      "reference document",
    );
    const t = run([note], ctx({ system: { ...system, real: false } }))(note);
    expect(t.supersede).toBeUndefined();
    expect(t.reasons[0]!.kind).toBe("unverified");
  });
});
