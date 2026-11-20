import { describe, expect, it } from "vitest";
import { StagedChanges } from "./staged";

// Held changes from Ember's browser (checklist 45.14): an approval covers one exact request;
// sending is not verifying; nothing expired, replaced or changed-since is ever sent.

type Handler = (method: string, url: string, body?: string, headers?: Headers) => Response;

function app(handler: Handler) {
  const calls: { method: string; url: string; body?: string; cookie?: string | null }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: String(url),
      body: init?.body as string,
      cookie: headers.get("cookie"),
    });
    return handler(method, String(url), init?.body as string | undefined, headers);
  }) as typeof fetch;
  return { f, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const base = {
  serviceId: "radarr",
  serviceName: "Radarr",
  origin: "http://radarr.test",
  url: "http://radarr.test/api/v3/config/ui/1",
  headers: { "content-type": "application/json" },
};

describe("held changes from Ember's browser", () => {
  it("shows only what changes, hides secrets, and expires", async () => {
    let now = 1_000_000;
    const a = app(() => json({ id: 1, firstDayOfWeek: 0, apiKey: "secret-value-123" }));
    const s = new StagedChanges({
      fetch: a.f,
      now: () => now,
      secrets: async () => ["secret-value-123"],
    });
    const h = await s.stage({
      ...base,
      method: "PUT",
      body: JSON.stringify({ id: 1, firstDayOfWeek: 1, apiKey: "secret-value-456" }),
    });
    expect(h.changes).toEqual([
      { name: "First Day Of Week", before: "0", after: "1" },
      { name: "Api Key", before: "(hidden)", after: "(hidden)" },
    ]);
    expect(JSON.stringify(h)).not.toMatch(/secret-value/);
    const { hash } = s.get(h.id)!;
    now += 31 * 60_000;
    expect(await s.execute(h.id, hash)).toMatchObject({ ok: false, stale: true });
    expect(a.writes()).toEqual([]);
  });

  it("sends exactly once, only the approved one, and refuses when the app changed since", async () => {
    let state = { id: 1, firstDayOfWeek: 0, theme: "auto" };
    const a = app((method, _url, body) => {
      if (method === "PUT") state = { ...state, ...JSON.parse(body!) };
      return json(state);
    });
    const s = new StagedChanges({ fetch: a.f });
    const h = await s.stage({
      ...base,
      method: "PUT",
      body: JSON.stringify({ ...state, firstDayOfWeek: 1 }),
    });
    // Not the approved one (another body): refused, nothing sent.
    expect(await s.execute(h.id, "not-the-hash")).toMatchObject({ ok: false });
    expect(a.writes()).toEqual([]);
    const { hash } = s.get(h.id)!;
    expect(await s.execute(h.id, hash)).toMatchObject({ ok: true, verified: true });
    expect(a.writes()).toHaveLength(1);
    // Once sent it is gone: the approval cannot send it again.
    expect(await s.execute(h.id, hash)).toMatchObject({ ok: false, stale: true });
    expect(a.writes()).toHaveLength(1);

    // Changed in the app after it was held: not sent.
    const h2 = await s.stage({
      ...base,
      method: "PUT",
      body: JSON.stringify({ ...state, theme: "dark" }),
    });
    state = { ...state, theme: "light" };
    const r = await s.execute(h2.id, s.get(h2.id)!.hash);
    expect(r).toMatchObject({ ok: false, stale: true });
    expect(r.result).toMatch(/changed since this was held/);
    expect(a.writes()).toHaveLength(1);
  });

  it("sent is not verified: a refusal, a read-back that differs, and no read-back are all said plainly", async () => {
    // The app refuses.
    const refusing = app((m) =>
      m === "PUT" ? json({ error: "bad" }, 400) : json({ id: 1, x: 0 }),
    );
    let s = new StagedChanges({ fetch: refusing.f });
    let h = await s.stage({ ...base, method: "PUT", body: JSON.stringify({ id: 1, x: 1 }) });
    let r = await s.execute(h.id, s.get(h.id)!.hash);
    expect(r).toMatchObject({ ok: false });
    expect(r.result).toMatch(/refused the change \(400/);

    // Accepted, but it reads back differently: not verified, not ok.
    const ignoring = app(() => json({ id: 1, x: 0 }));
    s = new StagedChanges({ fetch: ignoring.f });
    h = await s.stage({ ...base, method: "PUT", body: JSON.stringify({ id: 1, x: 1 }) });
    r = await s.execute(h.id, s.get(h.id)!.hash);
    expect(r).toMatchObject({ ok: false });
    expect(r.result).toMatch(/does not read back as approved/);

    // A create the app answers without an id: sent, accepted, not verified.
    const noId = app(() => json({ done: true }));
    s = new StagedChanges({ fetch: noId.f });
    h = await s.stage({
      ...base,
      url: "http://radarr.test/api/v3/tag",
      method: "POST",
      body: JSON.stringify({ label: "x" }),
    });
    r = await s.execute(h.id, s.get(h.id)!.hash);
    expect(r).toMatchObject({ ok: true, verified: false });
  });

  it("signs in again when the page's session ended, never sending a password", async () => {
    let state = { id: 1, x: 0 };
    const a = app((method, _url, body, headers) => {
      if (headers?.get("cookie") !== "Auth=fresh") return json({}, 401);
      if (method === "PUT") state = { ...state, ...JSON.parse(body!) };
      return json(state);
    });
    const s = new StagedChanges({
      fetch: a.f,
      signIn: async () => ({ cookies: [{ name: "Auth", value: "fresh" }], how: "form" }),
    });
    const h = await s.stage({
      ...base,
      method: "PUT",
      body: JSON.stringify({ id: 1, x: 1 }),
      cookie: "Auth=old",
    });
    const r = await s.execute(h.id, s.get(h.id)!.hash);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(state.x).toBe(1);
  });
});
