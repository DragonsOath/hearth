import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { wizarrDashboard, WizarrOperations } from "./wizarr";

/**
 * The Wizarr panel's people and invitation changes against a real, disposable Wizarr with its own
 * test Jellyfin (checklist 46.10h). Skipped unless HEARTH_WIZARR_TEST_URL, HEARTH_WIZARR_TEST_KEY_FILE,
 * HEARTH_JELLYFIN_TEST_URL and HEARTH_JELLYFIN_TEST_KEY_FILE point at such a pair: never run this
 * against one anyone uses. It makes its own throwaway Jellyfin user and removes it again; it never
 * touches any other user (the test Jellyfin's admin is listed by Wizarr too).
 */

const url = process.env.HEARTH_WIZARR_TEST_URL;
const keyFile = process.env.HEARTH_WIZARR_TEST_KEY_FILE;
const jfUrl = process.env.HEARTH_JELLYFIN_TEST_URL;
const jfKeyFile = process.env.HEARTH_JELLYFIN_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const jfKey = jfKeyFile ? readFileSync(jfKeyFile, "utf8").trim() : "";
const live = Boolean(url && key && jfUrl && jfKey);

const fetchImpl: Fetch = (u, init) => fetch(u, init);
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
const wizarr = { id: "wizarr-test", name: "Wizarr", localUrl: url ?? "" };
const ops = new WizarrOperations(handle, broker, fetchImpl);
const NAME = `hearth-throwaway-${Date.now() % 100000}`;

async function jellyfin(method: string, path: string, body?: unknown) {
  const r = await fetch(`${jfUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `MediaBrowser Token="${jfKey}"` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Jellyfin ${method} ${path} ${r.status}`);
  const text = await r.text();
  return text ? (JSON.parse(text) as unknown) : null;
}
const jfUser = async () =>
  ((await jellyfin("GET", "/Users")) as { Name: string; Policy: { IsDisabled: boolean } }[]).find(
    (u) => u.Name === NAME,
  );

async function change(params: StepParams) {
  const planned = await ops.plan("app-wizarr-user", wizarr, params, base);
  const outcome = await ops.run(
    {
      kind: "app-wizarr-user",
      serviceId: "wizarr-test",
      requestedBy: "you",
      params: planned.params,
      change: planned.change,
    },
    wizarr,
  );
  return { planned, outcome };
}
const me = async () =>
  (await wizarrDashboard(fetchImpl, wizarr.localUrl, key)).users.find((u) => u.username === NAME);

describe.skipIf(!live)("Wizarr against a real test instance", () => {
  let created: number[] = [];
  afterAll(async () => {
    // Leave nothing behind: the throwaway user and any invitation this made.
    const u = await jfUser().catch(() => undefined);
    if (u) {
      const all = (await jellyfin("GET", "/Users")) as { Name: string; Id: string }[];
      const id = all.find((x) => x.Name === NAME)?.Id;
      if (id) await jellyfin("DELETE", `/Users/${id}`);
    }
    for (const id of created)
      await fetch(`${url}/api/invitations/${id}`, {
        method: "DELETE",
        headers: { "X-API-Key": key },
      });
  });

  it("reads users, servers and libraries as Wizarr 2.2 answers them", async () => {
    const d = await wizarrDashboard(fetchImpl, wizarr.localUrl, key);
    expect(d.servers.length).toBeGreaterThan(0);
    expect(d.servers[0]).toMatchObject({ verified: true });
    expect(d.libraries.length).toBeGreaterThan(0);
    for (const u of d.users) if (u.created) expect(u.created).toMatch(/Z$/);
  });

  it("disables, enables, extends, dates, clears and removes a throwaway user", async () => {
    await jellyfin("POST", "/Users/New", { Name: NAME });
    // Wizarr lists a server's users when it is asked; give it a moment.
    let user = await me();
    for (let i = 0; !user && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      user = await me();
    }
    expect(user, "Wizarr lists the new Jellyfin user").toBeTruthy();
    const userId = user!.id;

    const off = await change({ userId, op: "disable" });
    expect(off.outcome.ok).toBe(true);
    expect((await jfUser())?.Policy.IsDisabled).toBe(true);
    const on = await change({ userId, op: "enable" });
    expect(on.outcome.ok).toBe(true);
    expect((await jfUser())?.Policy.IsDisabled).toBe(false);

    const ext = await change({ userId, op: "extend", durationDays: 10 });
    expect(ext.outcome).toMatchObject({ ok: true });
    const after = Date.parse((await me())!.expires!);
    expect(Math.round((after - Date.now()) / 86_400_000)).toBe(10);
    // The same approved plan run again (a retry) must not extend a second time.
    const retry = await ops.run(
      {
        kind: "app-wizarr-user",
        serviceId: "wizarr-test",
        requestedBy: "you",
        params: ext.planned.params,
      },
      wizarr,
    );
    expect(retry).toMatchObject({ ok: false, stale: true });
    expect(Date.parse((await me())!.expires!)).toBe(after);

    const day = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const dated = await change({ userId, op: "end-date", endDate: day });
    expect(dated.outcome).toMatchObject({ ok: true });
    const cleared = await change({ userId, op: "no-end" });
    expect(cleared.outcome).toMatchObject({ ok: true });
    expect((await me())!.expires).toBeUndefined();

    const gone = await change({ userId, op: "remove" });
    expect(gone.outcome).toMatchObject({ ok: true });
    expect(await me()).toBeUndefined();
    expect(await jfUser()).toBeUndefined();
  });

  it("creates an invitation for a library linked to the server, gives a full link, then deletes it", async () => {
    const d = await wizarrDashboard(fetchImpl, wizarr.localUrl, key);
    const lib = d.libraries.find((l) => l.serverId === d.servers[0]!.id)!;
    const planned = await ops.plan(
      "app-wizarr-invite",
      wizarr,
      { serverIds: String(d.servers[0]!.id), libraryIds: String(lib.id), expiresInDays: 1 },
      base,
    );
    expect(planned.label).toContain(lib.name);
    const made = await ops.run(
      {
        kind: "app-wizarr-invite",
        serviceId: "wizarr-test",
        requestedBy: "you",
        params: planned.params,
      },
      wizarr,
    );
    expect(made.ok, made.result).toBe(true);
    const invite = (await wizarrDashboard(fetchImpl, wizarr.localUrl, key)).invites.find(
      (i) => !d.invites.some((x) => x.id === i.id),
    );
    expect(invite?.url.startsWith(`${url}/j/`)).toBe(true);
    expect(made.result).toMatch(/could not be read back/);
    expect(invite).toBeTruthy();
    created.push(invite!.id);
    const del = await ops.plan(
      "app-wizarr-invite-delete",
      wizarr,
      { invitationId: invite!.id },
      base,
    );
    const done = await ops.run(
      {
        kind: "app-wizarr-invite-delete",
        serviceId: "wizarr-test",
        requestedBy: "you",
        params: del.params,
      },
      wizarr,
    );
    expect(done.ok).toBe(true);
    created = created.filter((id) => id !== invite!.id);
  });
});
