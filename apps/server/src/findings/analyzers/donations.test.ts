import { describe, expect, it } from "vitest";
import { donationTokenAnalyzer } from "./donations";

// The donation service's GitHub token, on the owner's issuing Hearth: quiet until 14 days before
// it expires, then in "Needs you" with the steps to replace it.

const run = (status: Parameters<typeof donationTokenAnalyzer>[0], now: string) =>
  donationTokenAnalyzer(status).run({
    handle: undefined as never,
    now: new Date(now),
    environment: "real",
    memo: undefined,
  });

describe("the donation service's token", () => {
  it("is quiet with more than 14 days left, and off where this Hearth doesn't issue", async () => {
    const far = await run(
      async () => ({ tokenExpiresAt: "2026-12-31T00:00:00Z" }),
      "2026-12-01T00:00:00Z",
    );
    expect(far).toMatchObject({ status: "ok", drafts: [] });
    const off = await run(async () => undefined, "2026-12-01T00:00:00Z");
    expect(off).toMatchObject({ status: "off", drafts: [] });
  });

  it("warns 14 days ahead, with plain steps to replace it", async () => {
    const r = await run(
      async () => ({ tokenExpiresAt: "2026-12-15T00:00:00Z" }),
      "2026-12-01T00:00:00Z",
    );
    expect(r.drafts).toHaveLength(1);
    const d = r.drafts[0]!;
    expect(d.title).toBe("The panel donation service's GitHub token expires in 14 days");
    expect(d.severity).toBe("medium");
    expect(d.nextSteps.join(" ")).toMatch(
      /dragonsoath-dev.*hearth-premium only.*wrangler secret put GITHUB_TOKEN/s,
    );
    expect(r.covered("donations:token")).toBe(true);
  });

  it("says plainly once it has expired, and that donations are still kept", async () => {
    const r = await run(
      async () => ({ tokenExpiresAt: "2026-12-01T00:00:00Z" }),
      "2026-12-02T00:00:00Z",
    );
    expect(r.drafts[0]).toMatchObject({
      title: "The panel donation service's GitHub token has expired",
      severity: "high",
    });
    expect(r.drafts[0]!.summary).toMatch(/still received and kept/);
  });
});
