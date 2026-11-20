import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeBazarr } from "./fake-bazarr";
import { bazarrDashboard, BazarrOperations } from "./bazarr-live";

/** Bazarr's panel and controls, against a stand-in that answers like Bazarr 1.5. */

const BASE = "http://10.0.0.9:6767";
const KEY = "e2e-bazarr-key";
const service = { id: "bazarr", name: "Bazarr", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-bazarr-subtitles" as const,
  serviceId: "bazarr",
  requestedBy: "you" as const,
  params,
});
const ops = () => new BazarrOperations(handle, broker, fakeBazarr().fetch);

describe("the Bazarr panel", () => {
  it("lists what is missing in plain words, and which providers are throttled", async () => {
    const d = await bazarrDashboard(fakeBazarr().fetch, BASE, KEY);
    expect(d.totals).toEqual({ movies: 2, episodes: 1, providers: 2, throttled: 1 });
    expect(d.movies[1]).toEqual({
      radarrId: 12,
      title: "Amelie",
      missing: ["English", "French (forced)"],
    });
    expect(d.episodes[0]?.title).toBe("Severance 2x05: Trojan's Horse");
    expect(d.providers[0]).toEqual({
      name: "opensubtitlescom",
      ok: false,
      why: "TooManyRequests",
      retry: "in 2 hours",
    });
    expect(d.history[0]?.text).toBe("English subtitles downloaded from subdl");
  });
});

describe("Bazarr controls", () => {
  it("searches one movie and says whether it found something", async () => {
    const o = ops();
    const found = await o.plan(service, { op: "search-movie", radarrId: 11 }, base);
    expect(found.label).toBe("Search subtitles for Arrival (English) in Bazarr");
    expect(await o.run(step(found.params), service)).toEqual({
      ok: true,
      result: "Bazarr found subtitles for Arrival.",
    });
    const none = await o.plan(service, { op: "search-movie", radarrId: 12 }, base);
    expect((await o.run(step(none.params), service)).result).toContain(
      "no English, French (forced) subtitles found for Amelie yet",
    );
    await expect(o.plan(service, { op: "search-movie", radarrId: 11 }, base)).rejects.toThrow(
      /not missing/,
    );
  });

  it("searches an episode, resets providers, and starts the full search", async () => {
    const o = ops();
    const ep = await o.plan(service, { op: "search-episode", episodeId: 41 }, base);
    expect(await o.run(step(ep.params), service)).toMatchObject({
      ok: true,
      result: expect.stringContaining("found subtitles"),
    });
    const reset = await o.plan(service, { op: "reset-providers" }, base);
    expect(await o.run(step(reset.params), service)).toMatchObject({ ok: true });
    await expect(o.plan(service, { op: "reset-providers" }, base)).rejects.toThrow(/No provider/);
    const all = await o.plan(service, { op: "search-all" }, base);
    expect(await o.run(step(all.params), service)).toMatchObject({ ok: true });
  });
});
