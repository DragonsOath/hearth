import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contributionFile, type PanelSpec } from "@dragon-control/core";
// Hearth's own receipt check: what the service signs must be what Hearth accepts.
import { specHash, verifyReceipt } from "../../../apps/server/src/panels/receipt";
// Hearth's own licences: what Hearth's issuer signs must be what this service accepts.
import { newSigningKey, signLicense } from "../../../apps/server/src/premium/license";
import { fileQueued, rebuild, route, type Env, type KV } from "./intake.ts";

// The panel donation service: only a Hearth with Premium (Panel Builder) may donate, everything is
// rebuilt and checked again, accepting is durable and signed, limits are per licence, per address
// and per day, the same panel is one submission, and pull requests are filed later on the private
// Premium repository with retries (GitHub is a stand-in here).

const ISSUER = newSigningKey();
const LICENCE_KEYS = JSON.stringify({ [ISSUER.keyId]: ISSUER.publicKey });
const licence = (
  over: { id?: string; features?: string[]; start?: string; end?: string } = {},
  key = ISSUER.privatePem,
) =>
  signLicense(
    {
      id: over.id ?? "lic-1",
      install: "install-1",
      features: (over.features ?? ["panel_builder"]) as never,
      kind: "paid",
      start: over.start ?? "2026-01-01T00:00:00Z",
      ...(over.end ? { end: over.end } : {}),
      issued: "2026-01-01T00:00:00Z",
    },
    key,
  );
const LIC = licence();

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
  return {
    RECEIPT_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    RECEIPT_KEY_ID: raw.slice(0, 12),
    trusted: { [raw.slice(0, 12)]: raw },
  };
};

function kv(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async ({ prefix, limit }) => ({
      keys: [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit ?? 1000)
        .map((name) => ({ name })),
    }),
  };
}

const spec = (over: Partial<PanelSpec> = {}): PanelSpec => ({
  specVersion: 1,
  id: "community.zoneminder.cameras",
  title: "Cameras",
  serviceId: "svc-1",
  refreshSeconds: 60,
  reads: [{ id: "monitors", path: "/zm/api/monitors.json" }],
  blocks: [
    { kind: "stat", id: "count", read: "monitors", label: "Cameras", field: "monitors.length" },
  ],
  ...over,
});

const panel = (s: PanelSpec = spec(), image = "zoneminderhq/zoneminder-base:1.36") =>
  contributionFile(s, image, { version: 1, acceptedAt: "2026-11-10T00:00:00Z" });

const setup = (extra: Partial<Env> = {}) => {
  const k = keys();
  const env: Env & { STORE: ReturnType<typeof kv> } = {
    STORE: kv(),
    RECEIPT_KEY: k.RECEIPT_KEY,
    RECEIPT_KEY_ID: k.RECEIPT_KEY_ID,
    GITHUB_TOKEN: "test-token",
    REPO: "DragonsOath/hearth-premium",
    LICENCE_KEYS,
    ...extra,
  } as Env & { STORE: ReturnType<typeof kv> };
  return { env, trusted: k.trusted };
};

/** A donation; it carries this Hearth's licence unless the test says otherwise. */
const post = (body: unknown, ip = "203.0.113.9") =>
  new Request("https://intake.test/v1/panels", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body:
      typeof body === "string"
        ? body
        : JSON.stringify(
            body && typeof body === "object" && !("licence" in body)
              ? { ...body, licence: LIC }
              : body,
          ),
  });

function github(failFirst = 0) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let failures = failFirst;
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    const reply = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" },
      });
    if (failures > 0) {
      failures -= 1;
      return reply(503, {});
    }
    if (url.endsWith("/users/sam-dev")) return reply(200, { id: 4242, login: "sam-dev" });
    if (url.endsWith("/repos/DragonsOath/hearth-premium")) return reply(200, {});
    if (url.endsWith("/git/ref/heads/main")) return reply(200, { object: { sha: "abc123" } });
    if (url.endsWith("/git/refs")) return reply(201, {});
    if (url.includes("/contents/")) return reply(201, {});
    if (url.endsWith("/pulls"))
      return reply(201, {
        number: 77,
        html_url: "https://github.com/DragonsOath/hearth-premium/pull/77",
      });
    if (url.endsWith("/labels")) return reply(200, []);
    return reply(404, {});
  };
  return { f, calls };
}

describe("only Hearth Premium with Panel Builder may donate", () => {
  it.each([
    ["no licence", { licence: undefined }],
    ["not a licence", { licence: "HEARTHL1.abc.def" }],
    ["one without Panel Builder", { licence: licence({ features: ["hearth_interconnectivity"] }) }],
    ["one that ended", { licence: licence({ end: "2026-02-01T00:00:00Z" }) }],
    ["one not started", { licence: licence({ start: "2099-01-01T00:00:00Z" }) }],
    ["one signed by another key", { licence: licence({}, newSigningKey().privatePem) }],
  ])("refuses %s, plainly, storing nothing", async (_n, extra) => {
    const { env } = setup();
    const res = await route(post({ panel: panel(), ...extra }), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^Donating a panel needs Hearth Premium with Panel Builder\./,
    );
    expect([...env.STORE.m.keys()].filter((k) => !k.startsWith("token"))).toEqual([]);
  });

  it("refuses a licence the owner took back", async () => {
    const { env } = setup();
    await env.STORE.put("revoked:lic-1", "1");
    expect((await route(post({ panel: panel() }), env)).status).toBe(403);
  });

  it("limits each licence per day, whatever address it comes from", async () => {
    const { env } = setup({ PER_LICENCE: "2", PER_ADDRESS: "50" });
    const n = (i: number) => panel(spec({ title: `Cams ${"z".repeat(i)}` }));
    expect((await route(post({ panel: n(1) }, "198.51.100.1"), env)).status).toBe(201);
    expect((await route(post({ panel: n(2) }, "198.51.100.2"), env)).status).toBe(201);
    const third = await route(post({ panel: n(3) }, "198.51.100.3"), env);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toMatch(/from one Hearth/);
    const other = licence({ id: "lic-2" });
    expect((await route(post({ panel: n(4), licence: other }), env)).status).toBe(201);
  });

  it.each([
    ["a name with an address", { name: "me@example.com" }],
    ["a long name", { name: "x".repeat(41) }],
    ["a GitHub name with a slash", { github: "evil/../x" }],
  ])("refuses a credit with %s", async (_n, credit) => {
    const { env } = setup();
    expect((await route(post({ panel: panel(), credit }), env)).status).toBe(422);
  });
});

describe("accepting a contribution", () => {
  it("rebuilds the file, signs a receipt Hearth accepts for exactly this panel, and queues it", async () => {
    const { env, trusted } = setup();
    const sent = {
      ...panel(),
      readme: "anything the install wrote",
      app: { name: "Home cams", image: "registry.home.lan/zm:1" },
    };
    const res = await route(post({ panel: sent }), env);
    expect(res.status).toBe(201);
    const out = (await res.json()) as { receipt: string; id: string };
    const p = verifyReceipt(out.receipt, trusted, specHash(panel().spec));
    expect(p.id).toBe(out.id);
    const stored = JSON.parse(env.STORE.m.get(`sub:${out.id}`)!) as {
      file: { readme: string; app: { name: string; image?: string } };
      status: string;
    };
    // The install's own words and names are not what is published.
    expect(stored.file.readme).toMatch(/^Cameras: a custom panel for zoneminder/);
    expect(stored.file.app).toEqual({ name: "zoneminder", image: "zm" });
    expect(stored.status).toBe("queued");
    // Nothing about the sender is kept: no address, no install id.
    expect([...env.STORE.m.entries()].join(" ")).not.toContain("203.0.113.9");
  });

  it("the same panel twice is one submission with the same receipt", async () => {
    const { env } = setup();
    const a = (await (await route(post({ panel: panel() }), env)).json()) as { receipt: string };
    const b = await route(post({ panel: panel() }, "198.51.100.1"), env);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { receipt: string }).receipt).toBe(a.receipt);
    expect([...env.STORE.m.keys()].filter((k) => k.startsWith("queue:"))).toHaveLength(1);
  });

  it("limits each network address and the whole service per day, without trusting install ids", async () => {
    const { env } = setup({ PER_ADDRESS: "2", DAILY_TOTAL: "3" });
    const n = (i: number) => panel(spec({ title: `Cams ${"x".repeat(i)}` }));
    expect((await route(post({ panel: n(1), installId: "a" }), env)).status).toBe(201);
    expect((await route(post({ panel: n(2), installId: "b" }), env)).status).toBe(201);
    // A new install id from the same address does not reset the limit.
    expect((await route(post({ panel: n(3), installId: "c" }), env)).status).toBe(429);
    expect((await route(post({ panel: n(4) }, "198.51.100.7"), env)).status).toBe(201);
    expect((await route(post({ panel: n(5) }, "198.51.100.8"), env)).status).toBe(429);
  });

  it.each([
    ["not JSON", "not json", 400],
    ["too large", "x".repeat(70_000), 413],
    ["not a panel file", { panel: { format: "zip" } }, 422],
    ["no agreement", { panel: { ...panel(), terms: undefined } }, 422],
    [
      "an install's app named",
      { panel: { ...panel(), spec: { ...panel().spec, serviceId: "svc-1" } } },
      422,
    ],
    ["failing Hearth's checks", { panel: panel(spec({ refreshSeconds: 1 })) }, 422],
    [
      "an unknown block (code)",
      {
        panel: {
          ...panel(),
          spec: { ...panel().spec, blocks: [{ kind: "script", id: "x", src: "evil" }] },
        },
      },
      422,
    ],
    ["an address", { panel: panel(spec({ title: "NVR 192.168.1.20" })) }, 422],
    [
      "a token in a path",
      {
        panel: panel(
          spec({ reads: [{ id: "monitors", path: "/zm/api/monitors.json?token=abc" }] }),
        ),
      },
      422,
    ],
    ["a mention", { panel: panel(spec({ title: "@everyone cams" })) }, 422],
  ])("refuses %s", async (_n, body, code) => {
    const { env } = setup();
    expect((await route(post(body), env)).status).toBe(code);
    expect([...env.STORE.m.keys()].filter((k) => k.startsWith("sub:"))).toHaveLength(0);
  });
});

describe("filing pull requests (the scheduled job)", () => {
  it("adds only the panel file on a donation branch of the Premium repo, labelled skin, and reports the link", async () => {
    const { env } = setup();
    const { id } = (await (await route(post({ panel: panel() }), env)).json()) as { id: string };
    const gh = github();
    expect(await fileQueued(env, gh.f)).toEqual({ filed: 1, failed: 0 });
    const put = gh.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toMatch(/\/contents\/donations\/zoneminder\/cameras\.json$/);
    const file = JSON.parse(Buffer.from(String(put.body!.content), "base64").toString("utf8")) as {
      accepted?: string;
      credit?: unknown;
      spec: { serviceId: string };
    };
    expect(file.accepted).toMatch(/^HEARTHR1\./);
    expect(file.spec.serviceId).toBe("");
    expect(file.credit).toBeUndefined();
    expect(String(put.body!.message)).not.toContain("Co-authored-by");
    const pr = gh.calls.find((c) => c.url.endsWith("/pulls"))!;
    expect(pr.body!.title).toBe("[Donated panel] zoneminder: Cameras");
    expect(String(pr.body!.head)).toMatch(/^donation\/zoneminder-cameras-/);
    expect(String(pr.body!.body)).toContain("no credit asked");
    expect(String(pr.body!.body)).toContain("core-default");
    const labels = gh.calls.find((c) => c.url.endsWith("/labels"))!;
    expect(labels.body).toEqual({ labels: ["donation", "skin"] });
    // Only these calls, on this repository (and nothing about the licence or the sender).
    expect(
      gh.calls.every((c) =>
        c.url.startsWith("https://api.github.com/repos/DragonsOath/hearth-premium"),
      ),
    ).toBe(true);
    expect(JSON.stringify(gh.calls)).not.toContain(LIC.slice(0, 40));
    const st = (await (
      await route(new Request(`https://intake.test/v1/panels/${id}`), env)
    ).json()) as {
      status: string;
      url?: string;
    };
    expect(st).toEqual({
      status: "filed",
      url: "https://github.com/DragonsOath/hearth-premium/pull/77",
    });
  });

  it("credits the donor: their name in the file, and their GitHub account as co-author", async () => {
    const { env } = setup();
    await route(post({ panel: panel(), credit: { name: "Sam", github: "@sam-dev" } }), env);
    const gh = github();
    await fileQueued(env, gh.f);
    const put = gh.calls.find((c) => c.method === "PUT")!;
    const file = JSON.parse(Buffer.from(String(put.body!.content), "base64").toString("utf8")) as {
      credit?: unknown;
    };
    expect(file.credit).toEqual({ name: "Sam", github: "sam-dev" });
    expect(String(put.body!.message)).toContain(
      "Co-authored-by: sam-dev <4242+sam-dev@users.noreply.github.com>",
    );
    const pr = gh.calls.find((c) => c.url.endsWith("/pulls"))!;
    // In code formatting, so the pull request never notifies anyone.
    expect(String(pr.body!.body)).toContain("Donated by: `@sam-dev` (co-author of the commit)");
  });

  it("an unknown GitHub name: credited by name, no co-author, and the PR says so", async () => {
    const { env } = setup();
    await route(post({ panel: panel(), credit: { github: "nobody-here" } }), env);
    const gh = github();
    await fileQueued(env, gh.f);
    expect(String(gh.calls.find((c) => c.method === "PUT")!.body!.message)).not.toContain(
      "Co-authored-by",
    );
    expect(String(gh.calls.find((c) => c.url.endsWith("/pulls"))!.body!.body)).toContain(
      "wasn't found",
    );
  });

  it("keeps the token's expiry from GitHub's answers, even with nothing to file, for Hearth's warning", async () => {
    const { env } = setup();
    const before = (await (
      await route(new Request("https://intake.test/v1/status"), env)
    ).json()) as {
      tokenExpiresAt?: string;
    };
    expect(before.tokenExpiresAt).toBeUndefined();
    await fileQueued(env, github().f);
    expect(
      await (await route(new Request("https://intake.test/v1/status"), env)).json(),
    ).toMatchObject({
      tokenExpiresAt: "2026-12-01T00:00:00.000Z",
      tokenWorks: true,
    });
  });

  it("GitHub down: the submission stays accepted and queued, and files on a later run", async () => {
    const { env } = setup();
    const { id } = (await (await route(post({ panel: panel() }), env)).json()) as { id: string };
    expect(await fileQueued(env, github(99).f)).toEqual({ filed: 0, failed: 1 });
    let st = (await (
      await route(new Request(`https://intake.test/v1/panels/${id}`), env)
    ).json()) as { status: string };
    expect(st.status).toBe("queued");
    expect(await fileQueued(env, github().f)).toEqual({ filed: 1, failed: 0 });
    st = (await (await route(new Request(`https://intake.test/v1/panels/${id}`), env)).json()) as {
      status: string;
    };
    expect(st.status).toBe("filed");
  });

  it("files at most a few per run (a spam flood cannot flood the repository)", async () => {
    const { env } = setup({ PER_ADDRESS: "50" });
    for (let i = 0; i < 6; i++)
      await route(post({ panel: panel(spec({ title: `Cams ${"y".repeat(i + 1)}` })) }), env);
    expect((await fileQueued(env, github().f)).filed).toBe(3);
  });

  it("after many failed tries a submission is held for a maintainer, never lost", async () => {
    const { env } = setup();
    const { id } = (await (await route(post({ panel: panel() }), env)).json()) as { id: string };
    for (let i = 0; i < 10; i++) await fileQueued(env, github(99).f);
    const st = (await (
      await route(new Request(`https://intake.test/v1/panels/${id}`), env)
    ).json()) as { status: string };
    expect(st.status).toBe("held");
    expect(env.STORE.m.get(`sub:${id}`)).toBeTruthy();
  });

  it("rebuild ignores fields it does not publish", () => {
    const r = rebuild({
      panel: { ...panel(), extra: "<script>", app: { name: "x", image: "a b" } },
    });
    expect("file" in r && Object.keys(r.file).sort()).toEqual([
      "app",
      "format",
      "formatVersion",
      "readme",
      "spec",
      "terms",
    ]);
  });
});
