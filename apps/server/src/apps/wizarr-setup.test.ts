import { describe, expect, it } from "vitest";
import { WIZARR_DESIGNS, restyleStep } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepRun } from "../jobs/operations";
import { FAKE_WIZARR_ADMIN, fakeWizarr } from "./fake-wizarr";
import { WizarrOperations } from "./wizarr";
import {
  decodeHtml,
  parseForm,
  parseStepLists,
  readCookies,
  readWizarrSettings,
  readWizarrWizard,
  WizarrAdmin,
  WizarrPasskeyError,
} from "./wizarr-admin";

/** Wizarr's Settings tab (General and Wizard): its admin pages, driven with the vault's admin sign-in. */

const BASE = "http://10.0.0.9:5690";
const service = { id: "wizarr", name: "Wizarr", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "Wizarr",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
// The broker hands the login (or the API key) to one call, as it does for real.
const broker = (login = FAKE_WIZARR_ADMIN) =>
  ({
    use: (input: { login?: true }, fn: (c: { value: string; username?: string }) => unknown) =>
      fn(
        input.login
          ? { value: login.password, username: login.username }
          : { value: "e2e-wizarr-key" },
      ),
  }) as unknown as CredentialBroker;

const admin = (w = fakeWizarr(), login = FAKE_WIZARR_ADMIN) =>
  new WizarrAdmin(w.fetch, BASE, login);

async function planAndRun(
  ops: WizarrOperations,
  params: Record<string, string | number | boolean>,
) {
  const planned = await ops.plan("app-wizarr-setup", service, params, base);
  const step: StepRun = {
    kind: "app-wizarr-setup",
    serviceId: "wizarr",
    requestedBy: "you",
    ...(planned.params ? { params: planned.params } : {}),
    ...(planned.change ? { change: planned.change } : {}),
  };
  return { planned, outcome: await ops.run(step, service) };
}

describe("reading Wizarr's admin pages", () => {
  it("decodes what Jinja and WTForms write, and reads a form's fields", () => {
    expect(decodeHtml("You&#39;re in &amp; &lt;b&gt; &#x2014;")).toBe("You're in & <b> —");
    const f = parseForm(
      '<input id="csrf_token" name="csrf_token" type="hidden" value="t1"><input checked name="a" type="checkbox" value="y"><input name="b" type="checkbox"><textarea name="markdown">\r\n# Hi &amp; bye</textarea><select name="s"><option value="x">X</option><option selected value="y">Y</option></select>',
    );
    expect(f.values).toMatchObject({ csrf_token: "t1", markdown: "# Hi & bye" });
    expect(f.checks).toEqual({ a: true, b: false });
    expect(f.selects.s).toEqual({
      value: "y",
      choices: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    });
    expect(
      parseStepLists(
        '<ol data-server="plex" data-category="pre_invite"><li data-id="4">A</li><li data-id="2">B</li></ol><ol data-server="plex" data-category="post_invite"><li class="empty-state-item">None</li></ol>',
      ),
    ).toEqual([
      { server: "plex", category: "pre_invite", ids: [4, 2] },
      { server: "plex", category: "post_invite", ids: [] },
    ]);
  });

  it("keeps cookies from Set-Cookie, even with a date in it", () => {
    const jar = new Map<string, string>();
    readCookies(
      "session=abc; Expires=Wed, 05 Nov 2036 10:00:00 GMT; HttpOnly; Path=/, remember_token=r1; Path=/",
      jar,
    );
    expect([...jar]).toEqual([
      ["session", "abc"],
      ["remember_token", "r1"],
    ]);
  });

  it("signs in and reads every step with its text, and the General settings", async () => {
    const a = admin();
    const wizard = await readWizarrWizard(a);
    expect(wizard.servers.map((s) => s.server)).toEqual(["plex"]);
    expect(wizard.servers[0]!.steps.map((s) => [s.category, s.position, s.title])).toEqual([
      ["pre_invite", 0, "Welcome"],
      ["post_invite", 0, "Get the app"],
      ["post_invite", 1, "You're in: Plex"],
    ]);
    expect(wizard.servers[0]!.steps[2]!.markdown).toBe(
      "# You're in\n\nEnjoy & ask if anything is missing.",
    );
    expect(wizard.servers[0]!.steps[1]!.requireInteraction).toBe(true);
    expect(await readWizarrSettings(a)).toMatchObject({
      displayName: "Family Media",
      protectWizard: true,
      expiryAction: "delete",
      posters: { value: "" },
    });
  });

  it("says plainly when the sign-in is wrong, or the admin uses a passkey", async () => {
    await expect(
      readWizarrWizard(admin(fakeWizarr(), { username: "admin", password: "nope" })),
    ).rejects.toThrow(/refused the admin sign-in/);
    await expect(
      readWizarrWizard(admin(fakeWizarr(), { ...FAKE_WIZARR_ADMIN, username: "passkey" })),
    ).rejects.toBeInstanceOf(WizarrPasskeyError);
  });

  it("signs in again when Wizarr ended the session", async () => {
    const w = fakeWizarr();
    const jar = new Map([["session", "expired"]]);
    const a = new WizarrAdmin(w.fetch, BASE, FAKE_WIZARR_ADMIN, jar);
    expect((await readWizarrWizard(a)).servers).toHaveLength(1);
    expect(jar.get("session")).toBe("fake-admin");
  });
});

describe("changing Wizarr's setup as plans", () => {
  it("adds a step at the end of its list and reads it back", async () => {
    const ops = new WizarrOperations(handle, broker(), fakeWizarr().fetch);
    const { planned, outcome } = await planAndRun(ops, {
      op: "step-add",
      server: "plex",
      category: "post_invite",
      title: "Requests",
      body: "# Ask for movies\n\nUse Seerr.",
      requireInteraction: false,
    });
    expect(planned.change?.settings[0]).toMatchObject({
      name: "Plex, After they accept",
      after: "added at the end: Requests",
    });
    expect(outcome).toMatchObject({ ok: true, verified: true });
  });

  it("edits a step, and leaves it alone if Wizarr changed it after planning", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker(), w.fetch);
    const planned = await ops.plan(
      "app-wizarr-setup",
      service,
      { op: "step-edit", stepId: 3, title: "You're in", body: "# Welcome aboard" },
      base,
    );
    expect(planned.change?.settings.map((s) => s.name)).toEqual(["Title", "Text"]);
    const run = (p = planned) =>
      ops.run(
        { kind: "app-wizarr-setup", serviceId: "wizarr", requestedBy: "you", params: p.params! },
        service,
      );
    // Someone edits it in Wizarr first: the approved plan no longer matches.
    await planAndRun(ops, { op: "step-edit", stepId: 3, body: "# Changed elsewhere" });
    expect(await run()).toMatchObject({ ok: false, stale: true });
    const again = await ops.plan(
      "app-wizarr-setup",
      service,
      { op: "step-edit", stepId: 3, title: "You're in", body: "# Welcome aboard" },
      base,
    );
    expect(await run(again)).toMatchObject({ ok: true, verified: true });
    const step = (await readWizarrWizard(admin(w))).servers[0]!.steps.find((s) => s.id === 3);
    expect(step).toMatchObject({ title: "You're in", markdown: "# Welcome aboard" });
  });

  it("shows a design step's new colors on the approval, not its styling (11-04)", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker(), w.fetch);
    const html = WIZARR_DESIGNS[0]!.servers.plex!.steps[1]!.html;
    await planAndRun(ops, { op: "step-edit", stepId: 3, body: html });
    const planned = await ops.plan(
      "app-wizarr-setup",
      service,
      { op: "step-edit", stepId: 3, body: restyleStep(html, "ocean") },
      base,
    );
    expect(planned.change?.settings).toEqual([
      { name: "Colors", before: "Original", after: "Ocean" },
    ]);
    const words = await ops.plan(
      "app-wizarr-setup",
      service,
      { op: "step-edit", stepId: 3, body: restyleStep(html, "ocean", { headline: "Hi there" }) },
      base,
    );
    expect(words.change?.settings.map((s) => s.name)).toEqual(["Colors", "Text"]);
  });

  it("moves a step within its list and into the other one", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker(), w.fetch);
    expect((await planAndRun(ops, { op: "step-move", stepId: 3, index: 0 })).outcome).toMatchObject(
      {
        ok: true,
      },
    );
    const moved = await planAndRun(ops, {
      op: "step-move",
      stepId: 2,
      category: "pre_invite",
      index: 1,
    });
    expect(moved.planned.change?.settings[0]).toMatchObject({
      before: "After they accept, step 2",
      after: "Before they accept, step 2",
    });
    expect(moved.outcome).toMatchObject({ ok: true });
    const steps = (await readWizarrWizard(admin(w))).servers[0]!.steps;
    expect(steps.map((s) => [s.category, s.id])).toEqual([
      ["pre_invite", 1],
      ["pre_invite", 2],
      ["post_invite", 3],
    ]);
    await expect(
      ops.plan("app-wizarr-setup", service, { op: "step-move", stepId: 2, index: 1 }, base),
    ).rejects.toThrow(/already there/);
  });

  it("deletes a step and checks it is gone", async () => {
    const ops = new WizarrOperations(handle, broker(), fakeWizarr().fetch);
    const { outcome } = await planAndRun(ops, { op: "step-delete", stepId: 1 });
    expect(outcome).toMatchObject({ ok: true, verified: true });
  });

  it("saves General settings, keeping the fields it did not change", async () => {
    const w = fakeWizarr();
    const ops = new WizarrOperations(handle, broker(), w.fetch);
    const { planned, outcome } = await planAndRun(ops, {
      op: "settings",
      protectWizard: false,
      expiryAction: "disable",
    });
    expect(planned.change?.settings.map((s) => s.after)).toEqual(["off", "Disable them"]);
    expect(outcome).toMatchObject({ ok: true, verified: true });
    expect(await readWizarrSettings(admin(w))).toMatchObject({
      displayName: "Family Media",
      protectWizard: false,
      expiryAction: "disable",
    });
    await expect(
      ops.plan("app-wizarr-setup", service, { op: "settings", expiryAction: "disable" }, base),
    ).rejects.toThrow(/Nothing would change/);
  });

  it("cleans expired users and checks none are left", async () => {
    const ops = new WizarrOperations(handle, broker(), fakeWizarr().fetch);
    const { planned, outcome } = await planAndRun(ops, { op: "clean-expired" });
    expect(planned.change?.summary).toBe("Delete everyone whose access has ended");
    expect(outcome).toMatchObject({ ok: true });
  });
});
