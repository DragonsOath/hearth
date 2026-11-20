import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { SeerrOperations } from "./seerr-ops";

/**
 * Seerr's request and issue changes against a real, disposable Seerr 3.5 wired to the disposable
 * Radarr and Sonarr (checklist 46.10l). Skipped unless HEARTH_SEERR_TEST_URL and
 * HEARTH_SEERR_TEST_KEY_FILE (and HEARTH_RADARR_TEST_URL / _KEY_FILE, for cleanup) point at such
 * instances: never run this against ones anyone uses. It requests one public-domain film and
 * removes the request, the issue it opens, and the film from the test Radarr afterwards.
 */

const url = process.env.HEARTH_SEERR_TEST_URL;
const keyFile = process.env.HEARTH_SEERR_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const radarrUrl = process.env.HEARTH_RADARR_TEST_URL;
const radarrKeyFile = process.env.HEARTH_RADARR_TEST_KEY_FILE;
const radarrKey = radarrKeyFile ? readFileSync(radarrKeyFile, "utf8").trim() : "";
const live = Boolean(url && key && radarrUrl && radarrKey);

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
const seerr = { id: "seerr-test", name: "Seerr", localUrl: url ?? "" };
const ops = new SeerrOperations(handle, broker, (u, init) => fetch(u, init));
/** Nosferatu (1922): public domain. */
const FILM = 653;
/** The Twilight Zone (1959). Only planned here, never requested. */
const SHOW = 6357;

async function api<T = Record<string, unknown>>(
  where: "seerr" | "radarr",
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const r = await fetch(`${where === "seerr" ? url : radarrUrl}${path}`, {
    method,
    headers: {
      "X-Api-Key": where === "seerr" ? key : radarrKey,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, data: (text ? JSON.parse(text) : undefined) as T };
}

const plan = (kind: Parameters<SeerrOperations["plan"]>[0], params: StepParams) =>
  ops.plan(kind, seerr, params, base);
const run = (kind: Parameters<SeerrOperations["plan"]>[0], planned: PlannedStep) =>
  ops.run(
    {
      kind,
      serviceId: "seerr-test",
      requestedBy: "you",
      params: planned.params,
      change: planned.change,
    },
    seerr,
  );

describe.skipIf(!live)("Seerr against a real test instance", () => {
  afterAll(async () => {
    // Remove what this made: the film's requests and issues in Seerr, and the film in Radarr.
    const film = await api<{ mediaInfo?: { id?: number } }>(
      "seerr",
      "GET",
      `/api/v1/movie/${FILM}`,
    );
    const mediaId = film.data?.mediaInfo?.id;
    if (mediaId) await api("seerr", "DELETE", `/api/v1/media/${mediaId}`);
    const movies = await api<{ id: number; tmdbId: number }[]>("radarr", "GET", "/api/v3/movie");
    for (const m of movies.data ?? [])
      if (m.tmdbId === FILM)
        await api("radarr", "DELETE", `/api/v3/movie/${m.id}?deleteFiles=false`);
  });

  it("requests a film once: read back, and a retry of the same plan sends nothing", async () => {
    const planned = await plan("app-seerr-request", { mediaType: "movie", tmdbId: FILM });
    expect(planned.label).toMatch(/Request Nosferatu \(1922\)/);
    const done = await run("app-seerr-request", planned);
    expect(done.ok, done.result).toBe(true);
    const again = await run("app-seerr-request", planned);
    expect(again).toMatchObject({ ok: false, stale: true });
    const requests = await api<{ results: { media?: { tmdbId?: number } }[] }>(
      "seerr",
      "GET",
      "/api/v1/request?take=50&filter=all",
    );
    expect(requests.data.results.filter((r) => r.media?.tmdbId === FILM)).toHaveLength(1);
    await expect(plan("app-seerr-request", { mediaType: "movie", tmdbId: FILM })).rejects.toThrow(
      /already/,
    );
  });

  it("plans a show by season, refusing seasons it does not have", async () => {
    const planned = await plan("app-seerr-request", {
      mediaType: "tv",
      tmdbId: SHOW,
      seasons: "1,2",
    });
    expect(planned.params).toMatchObject({ seasons: "1,2" });
    await expect(
      plan("app-seerr-request", { mediaType: "tv", tmdbId: SHOW, seasons: "40" }),
    ).rejects.toThrow(/no season 40/);
  });

  it("comments on, resolves, reopens and deletes an issue, each read back", async () => {
    const film = await api<{ mediaInfo?: { id?: number } }>(
      "seerr",
      "GET",
      `/api/v1/movie/${FILM}`,
    );
    const made = await api<{ id: number }>("seerr", "POST", "/api/v1/issue", {
      issueType: 3,
      message: "Hearth test: subtitles out of sync",
      mediaId: film.data.mediaInfo!.id,
    });
    expect(made.status, JSON.stringify(made.data)).toBeLessThan(300);
    const issueId = made.data.id;

    const comment = await plan("app-seerr-issue", {
      issueId,
      op: "comment",
      message: "Looking into it.",
    });
    expect(comment.label).toMatch(/Nosferatu \(1922\) \(subtitles\)/);
    expect((await run("app-seerr-issue", comment)).ok).toBe(true);
    // The same comment plan again: the issue has a new comment now, so nothing is posted.
    expect(await run("app-seerr-issue", comment)).toMatchObject({ ok: false, stale: true });

    expect(
      (await run("app-seerr-issue", await plan("app-seerr-issue", { issueId, op: "resolve" }))).ok,
    ).toBe(true);
    await expect(plan("app-seerr-issue", { issueId, op: "resolve" })).rejects.toThrow(
      /already resolved/,
    );
    expect(
      (await run("app-seerr-issue", await plan("app-seerr-issue", { issueId, op: "reopen" }))).ok,
    ).toBe(true);
    const del = await run(
      "app-seerr-issue",
      await plan("app-seerr-issue", { issueId, op: "delete" }),
    );
    expect(del.ok, del.result).toBe(true);
    // Seerr 3.5 answers a deleted issue with 500 "Issue not found."
    const gone = await api<{ message?: string }>("seerr", "GET", `/api/v1/issue/${issueId}`);
    expect(gone.data?.message ?? "").toMatch(/not found/i);
  });
});
