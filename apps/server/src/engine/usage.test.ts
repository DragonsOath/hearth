import { describe, expect, it } from "vitest";
import { claudeReading, codexReading, Usage } from "./usage";
import type { EngineStore } from "./store";

const memStore = () => {
  const m = new Map<string, unknown>();
  return {
    setting: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f),
    setSetting: (k: string, v: unknown) => m.set(k, v),
  } as unknown as EngineStore;
};

describe("usage", () => {
  it("reads Claude Code's rate-limit report", () => {
    const r = claudeReading(
      {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.03, resetsAt: 1792815000 },
          seven_day: { utilization: 0.32, resetsAt: 1793041200 },
        },
      },
      100,
    );
    expect(r?.windows).toEqual([
      { id: "five_hour", label: "5-hour", used_pct: 3, resets_at: 1792815000 },
      { id: "seven_day", label: "Weekly", used_pct: 32, resets_at: 1793041200 },
    ]);
    expect(claudeReading({})).toBeNull();
  });

  it("reads Codex's limits", () => {
    const r = codexReading({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 5 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 6 },
      },
    });
    expect(r?.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
    expect(r?.plan).toBe("plus");
  });

  it("shows what is left, live after a run, and pushes it to the War Room", () => {
    const sent: Record<string, unknown>[] = [];
    const u = new Usage(
      memStore(),
      {
        "claude-code": { label: "Claude Code", binary: "/bin/claude" },
        codex: { label: "Codex", binary: null },
      },
      (ev) => sent.push(ev),
    );
    expect(u.snapshot().engines[0]!.status).toBe("unavailable");
    const later = Date.now() / 1000 + 3600;
    u.onClaudeReport({ unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: later } } });
    const c = u.snapshot().engines[0]!;
    expect(c.status).toBe("live");
    expect(c.windows[0]).toMatchObject({ remaining_pct: 5, level: "critical" });
    expect(u.snapshot().engines[1]!.status).toBe("not_installed");
    expect(sent[0]!.type).toBe("usage");
  });

  it("an older saved report shows as stale", () => {
    const s = memStore();
    s.setSetting("rate_limit", { unifiedWindows: { seven_day: { utilization: 0.5 } } });
    const u = new Usage(s, { "claude-code": { label: "Claude Code", binary: "/c" } }, () => {});
    expect(u.snapshot().engines[0]!.status).toBe("stale");
  });
});
