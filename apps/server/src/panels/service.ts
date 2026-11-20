import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  PANEL_DONATION_TERMS_VERSION,
  PANEL_LIMITS,
  PANEL_SPEC_VERSION,
  contributionFile,
  contributionProblems,
  keptSpec,
  canImprovePanel,
  panelClassOf,
  fillPanelPath,
  isTemplateRead,
  panelImageAllowed,
  resolvePanel,
  validatePanelSpec,
  type BlockResult,
  type CustomPanelView,
  type PanelContribution,
  type PanelIssue,
  type PanelSpec,
  type PanelSubmissionView,
  type ReadOutcome,
  type SharedPanelFile,
} from "@dragon-control/core";
import type { PanelIntake } from "./intake";
import { ReceiptError, specHash, verifyReceipt, type IntakeKeys } from "./receipt";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { ConflictError, NotFoundError } from "../store/errors";
import { withTransaction } from "../db/tx";
import type { ApiAnswer, ApiRequest } from "../apps/app-api";

/** What the panels service needs from the apps service (its key broker paths). */
export interface PanelApps {
  appApi(
    serviceId: string,
    req: ApiRequest,
    opts: { access: "read" | "change"; purpose: string; by?: "agent" | "you" },
  ): Promise<ApiAnswer & { app: string; service: string }>;
  genericImage(
    serviceId: string,
    path: string,
    opts: { auth?: string; purpose: string },
  ): Promise<{ type: string; bytes: Buffer }>;
}

export interface PanelRun {
  blocks: BlockResult[];
  reads: { id: string; path: string; ok: boolean; reason?: string }[];
  at: string;
  /** A code panel's answers, by read id (its page draws them itself). */
  values?: Record<string, unknown>;
}

export interface CustomPanelState {
  installed?: CustomPanelView;
  draft?: CustomPanelView;
  /** Earlier installs, newest first (Back restores one). */
  previous: CustomPanelView[];
  /** The latest share (Premium's Donate) of the installed panel's exact design, if any. */
  submission?: PanelSubmissionView;
  /** A submission service is set up. */
  canSubmit: boolean;
  /** Panel Builder is Premium (11-14): premium when this Hearth has it. */
  plan: "free" | "premium";
  /** The sharing agreement version current Hearth asks for (Donate). */
  termsVersion: number;
}

type Row = typeof t.customPanels.$inferSelect;

const view = (r: Row): CustomPanelView => ({
  id: r.id,
  serviceId: r.serviceId,
  status: r.status,
  version: r.version,
  spec: r.spec as PanelSpec,
  dropped: (r.dropped as string[]) ?? [],
  ...(r.note ? { note: r.note } : {}),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(r.installedAt ? { installedAt: r.installedAt } : {}),
  origin: r.origin,
});

/** A spec refused, with every reason (Ember fixes them and tries again). */
export class PanelSpecError extends ConflictError {
  constructor(readonly issues: PanelIssue[]) {
    super(
      `The panel spec has ${issues.length} problem${issues.length === 1 ? "" : "s"}: ${issues
        .slice(0, 8)
        .map((i) => `${i.at}: ${i.message}`)
        .join(" ")}`,
    );
  }
}

/**
 * Custom panels: drafts, the owner's Keep and Drop, install, Back to basic and restore, and the
 * panels' live reads. Anything custom is Hearth Premium (Panel Builder, 11-14, the owner): Ember
 * building or refining a panel, loading a panel file, installing, restoring and sharing (Donate).
 * Back to basic stays free, so a Hearth without Premium always has its basic panel back.
 * Only basic panels qualify: the panel-class rule is checked on every call.
 */
export class CustomPanels {
  /** The last run per spec, so a panel open on several screens reads the app once per refresh. */
  private cache = new Map<string, { until: number; run: Promise<PanelRun>; serviceId: string }>();

  /** Forgets an app's kept reads (Hearth just signed in to it: read again now, not in a minute). */
  forget(serviceId: string) {
    for (const [k, v] of this.cache) if (v.serviceId === serviceId) this.cache.delete(k);
  }

  constructor(
    private readonly handle: DbHandle,
    private readonly apps: PanelApps,
    private readonly opts: {
      /** Free or Premium right now (Panel Builder is Premium). */
      plan?: (serviceId: string) => Promise<"free" | "premium">;
      /** Throws the core's "needs Premium" error unless Panel Builder is included. */
      requireBuilder?: (serviceId: string, what: string) => Promise<void>;
      /** The submission service, when one is set up. */
      intake?: PanelIntake;
      /** The submission service's keys this Hearth trusts (its receipts). */
      intakeKeys?: () => IntakeKeys;
      /** This Hearth's licence that includes Panel Builder (the donation service checks it). */
      licence?: () => Promise<string | undefined>;
    } = {},
  ) {}

  private get db() {
    return this.handle.db;
  }

  private async plan(serviceId: string): Promise<"free" | "premium"> {
    return (await this.opts.plan?.(serviceId)) ?? "premium";
  }

  private keys(): IntakeKeys {
    return this.opts.intakeKeys?.() ?? {};
  }

  /** The service, if Panel Builder may work on it; otherwise a plain refusal. */
  private async basic(serviceId: string) {
    const s = (await this.db.select().from(t.services).where(eq(t.services.id, serviceId)))[0];
    if (!s || s.lifecycle !== "active") throw new NotFoundError("Not a system Hearth watches.");
    const like = {
      name: s.name,
      image: s.image ?? undefined,
      container: s.checkTarget?.startsWith("container:") ? s.checkTarget.slice(10) : undefined,
      kind: s.kind,
    };
    if (!canImprovePanel(like))
      throw new ConflictError(
        panelClassOf(like) === "first-party"
          ? `${s.name} is a network or security app: it keeps Hearth's own panel, so a broken custom one can never hide a problem there. Ask for a feature on the request board instead.`
          : `${s.name} is infrastructure Hearth only watches. Panel Builder builds on app panels.`,
      );
    return s;
  }

  private async rows(serviceId: string) {
    return this.db
      .select()
      .from(t.customPanels)
      .where(eq(t.customPanels.serviceId, serviceId))
      .orderBy(desc(t.customPanels.version), desc(t.customPanels.updatedAt));
  }

  /** Panels this install may use for free: installed, earlier, verified shared, contributed. */
  /** The latest submission of exactly this design for this app. */
  private async submissionOf(serviceId: string, spec: PanelSpec) {
    const hash = specHash(spec);
    return (
      await this.db
        .select()
        .from(t.panelSubmissions)
        .where(
          and(eq(t.panelSubmissions.serviceId, serviceId), eq(t.panelSubmissions.specHash, hash)),
        )
        .orderBy(desc(t.panelSubmissions.sentAt))
        .limit(1)
    )[0];
  }

  async state(serviceId: string): Promise<CustomPanelState> {
    const rows = await this.rows(serviceId);
    const installed = rows.find((r) => r.status === "installed");
    const draft = rows.find((r) => r.status === "draft");
    let sub = installed
      ? await this.submissionOf(serviceId, installed.spec as PanelSpec)
      : undefined;
    if (sub && !sub.url) sub = await this.refreshUrl(sub);
    return {
      ...(installed ? { installed: view(installed) } : {}),
      ...(draft ? { draft: view(draft) } : {}),
      previous: rows
        .filter((r) => r.status === "previous")
        .slice(0, 5)
        .map(view),
      ...(sub
        ? {
            submission: {
              version: sub.version,
              sentAt: sub.sentAt,
              id: sub.remoteId ?? sub.id,
              ...(sub.url ? { url: sub.url } : {}),
            },
          }
        : {}),
      canSubmit: Boolean(this.opts.intake) && Object.keys(this.keys()).length > 0,
      plan: await this.plan(serviceId),
      termsVersion: PANEL_DONATION_TERMS_VERSION,
    };
  }

  /** Asks the submission service, at most every few minutes, whether the pull request is filed. */
  private async refreshUrl(sub: typeof t.panelSubmissions.$inferSelect) {
    const intake = this.opts.intake;
    if (!intake || !sub.remoteId) return sub;
    if (sub.urlCheckedAt && Date.now() - Date.parse(sub.urlCheckedAt) < 5 * 60_000) return sub;
    const now = new Date().toISOString();
    const st = await intake.status(sub.remoteId).catch(() => undefined);
    const url = st?.url ?? null;
    await this.db
      .update(t.panelSubmissions)
      .set({ urlCheckedAt: now, ...(url ? { url } : {}) })
      .where(eq(t.panelSubmissions.id, sub.id));
    return { ...sub, urlCheckedAt: now, url: url ?? sub.url };
  }

  /** Check a spec for this app. Throws PanelSpecError with every problem. */
  async check(serviceId: string, spec: unknown): Promise<PanelSpec> {
    await this.basic(serviceId);
    const issues = validatePanelSpec(spec, serviceId);
    if (issues.length) throw new PanelSpecError(issues);
    return spec as PanelSpec;
  }

  /** Run a spec's reads (through the key broker, GET only) and work out every block. */
  run(spec: PanelSpec, by?: "agent" | "you", fresh = false): Promise<PanelRun> {
    const key = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (!fresh && hit && hit.until > now) return hit.run;
    const run = this.runNow(spec, by);
    this.cache.set(key, {
      until: now + spec.refreshSeconds * 1000,
      run,
      serviceId: spec.serviceId,
    });
    // A failed run is not kept: the next look tries again.
    run.catch(() => this.cache.delete(key));
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return run;
  }

  private async runNow(spec: PanelSpec, by?: "agent" | "you"): Promise<PanelRun> {
    const outcomes: Record<string, ReadOutcome> = {};
    const reads = await Promise.all(
      // A template read ("/movie/{id}") is read on demand, when the page asks.
      spec.reads
        .filter((r) => !isTemplateRead(r.path))
        .map(async (r) => {
          try {
            const a = await this.apps.appApi(
              spec.serviceId,
              { method: "GET", path: r.path, ...(spec.auth ? { auth: spec.auth } : {}) },
              {
                access: "read",
                purpose: `custom panel "${spec.title.slice(0, 60)}": read ${r.path.split("?")[0]}`,
                ...(by ? { by } : {}),
              },
            );
            if (!a.ok) {
              outcomes[r.id] = { ok: false, reason: `The app answered ${a.status}.` };
            } else if (JSON.stringify(a.body ?? null).length > PANEL_LIMITS.answerBytes) {
              outcomes[r.id] = { ok: false, reason: "The answer is too large for a panel." };
            } else outcomes[r.id] = { ok: true, data: a.body };
          } catch (e) {
            outcomes[r.id] = { ok: false, reason: e instanceof Error ? e.message : String(e) };
          }
          const o = outcomes[r.id]!;
          return { id: r.id, path: r.path, ok: o.ok, ...(o.ok ? {} : { reason: o.reason }) };
        }),
    );
    return {
      blocks: resolvePanel(spec, outcomes),
      reads,
      at: new Date().toISOString(),
      ...(spec.code !== undefined
        ? {
            values: Object.fromEntries(
              Object.entries(outcomes).flatMap(([k, o]) => (o.ok ? [[k, o.data]] : [])),
            ),
          }
        : {}),
    };
  }

  /**
   * A new draft. From Ember (by "agent"): on Free, only after the owner accepted the contribution
   * agreement for this app. From a file the owner loads (by "you"): a shared panel when it carries
   * a receipt that proves this exact design was accepted; otherwise just a file (no free pass).
   */
  async draft(
    serviceId: string,
    spec: unknown,
    note: string | undefined,
    by: "agent" | "you" = "agent",
    file?: { receipt?: string },
  ): Promise<{ draft: CustomPanelView; run: PanelRun }> {
    const ok = await this.check(serviceId, spec);
    // Anything custom is Premium (11-14, the owner): Ember building one, or a panel file loaded.
    await this.opts.requireBuilder?.(
      serviceId,
      by === "agent" ? "Building a panel with Ember" : "Loading a panel file",
    );
    let origin: Row["origin"] = by === "agent" ? "ember" : "file";
    const now = new Date().toISOString();
    if (file?.receipt) {
      try {
        verifyReceipt(file.receipt, this.keys(), specHash(ok));
        origin = "shared";
        await this.db.insert(t.panelBaselines).values({
          id: randomUUID(),
          serviceId,
          origin: "shared",
          spec: { ...ok, serviceId: "" },
          specHash: specHash(ok),
          receipt: file.receipt,
          createdAt: now,
        });
      } catch (e) {
        if (!(e instanceof ReceiptError)) throw e;
        // Not a verified shared panel: it still loads, as a plain file.
      }
    }
    const run = await this.run(ok, by, true);
    const rows = await this.rows(serviceId);
    const old = rows.find((r) => r.status === "draft");
    // A revised draft keeps what was dropped before, for blocks it still has (Forge memory).
    const dropped = ((old?.dropped as string[]) ?? []).filter((id) =>
      ok.blocks.some((b) => b.id === id),
    );
    const row: Row = {
      id: randomUUID(),
      serviceId,
      status: "draft",
      version: Math.max(0, ...rows.map((r) => r.version)) + (old ? 0 : 1),
      specVersion: PANEL_SPEC_VERSION,
      origin,
      spec: ok,
      dropped,
      note: note?.slice(0, 600) || null,
      createdAt: now,
      updatedAt: now,
      installedAt: null,
    };
    await this.db
      .delete(t.customPanels)
      .where(and(eq(t.customPanels.serviceId, serviceId), eq(t.customPanels.status, "draft")));
    await this.db.insert(t.customPanels).values(row);
    return { draft: view(row), run };
  }

  /** The owner's Keep and Drop on the draft's blocks. */
  async setDropped(serviceId: string, dropped: string[]): Promise<CustomPanelView> {
    await this.basic(serviceId);
    const d = (await this.state(serviceId)).draft;
    if (!d) throw new NotFoundError("There is no draft panel to change.");
    const ids = new Set(d.spec.blocks.map((b) => b.id));
    const keep = [...new Set(dropped)].filter((id) => ids.has(id));
    if (keep.length === ids.size) throw new ConflictError("Keep at least one block.");
    const now = new Date().toISOString();
    await this.db
      .update(t.customPanels)
      .set({ dropped: keep, updatedAt: now })
      .where(eq(t.customPanels.id, d.id));
    return { ...d, dropped: keep, updatedAt: now };
  }

  async discardDraft(serviceId: string): Promise<void> {
    await this.db
      .delete(t.customPanels)
      .where(and(eq(t.customPanels.serviceId, serviceId), eq(t.customPanels.status, "draft")));
  }

  /** Make a row the installed panel; the one in use becomes previous. */
  private async promote(serviceId: string, id: string, set: Partial<Row> = {}) {
    const now = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.customPanels)
        .set({ status: "previous", updatedAt: now })
        .where(
          and(eq(t.customPanels.serviceId, serviceId), eq(t.customPanels.status, "installed")),
        );
      await this.db
        .update(t.customPanels)
        .set({ ...set, status: "installed", installedAt: now, updatedAt: now })
        .where(eq(t.customPanels.id, id));
    });
    return now;
  }

  /**
   * Install the draft (the owner's approval): the kept blocks only. Refused while a kept block has
   * no working read.
   */
  async install(serviceId: string): Promise<CustomPanelView> {
    await this.basic(serviceId);
    await this.opts.requireBuilder?.(serviceId, "Installing a custom panel");
    const d = (await this.state(serviceId)).draft;
    if (!d) throw new NotFoundError("There is no draft panel to install.");
    const spec = keptSpec(d.spec, d.dropped);
    const issues = validatePanelSpec(spec, serviceId);
    if (issues.length) throw new PanelSpecError(issues);
    const run = await this.run(spec, "you", true);
    // A code panel draws its reads itself: each of its fixed reads must answer.
    const broken = [
      ...run.blocks.filter((b) => b.state !== "real"),
      ...run.reads
        .filter((r) => spec.code !== undefined && !r.ok)
        .map((r) => ({ id: `read ${r.id}`, state: "not-possible", reason: r.reason })),
    ];
    if (broken.length)
      throw new ConflictError(
        `Not installed: ${broken.length} kept block${broken.length === 1 ? " has" : "s have"} no working read (${broken
          .map((b) => `${b.id}: ${b.reason ?? b.state}`)
          .join(
            "; ",
          )}). Drop ${broken.length === 1 ? "it" : "them"}, or ask Ember to fix the read.`,
      );
    const now = await this.promote(serviceId, d.id, { spec, dropped: [] });
    return { ...d, status: "installed", spec, dropped: [], installedAt: now, updatedAt: now };
  }

  /** Back to basic: the custom panel is kept (as previous) and can be restored. */
  async backToBasic(serviceId: string): Promise<void> {
    await this.db
      .update(t.customPanels)
      .set({ status: "previous", updatedAt: new Date().toISOString() })
      .where(and(eq(t.customPanels.serviceId, serviceId), eq(t.customPanels.status, "installed")));
  }

  /** Bring back an earlier install (only installs, never a waiting version). */
  async restore(serviceId: string, id: string): Promise<CustomPanelView> {
    await this.basic(serviceId);
    await this.opts.requireBuilder?.(serviceId, "Bringing back a custom panel");
    const row = (
      await this.db
        .select()
        .from(t.customPanels)
        .where(
          and(
            eq(t.customPanels.id, id),
            eq(t.customPanels.serviceId, serviceId),
            inArray(t.customPanels.status, ["previous"]),
          ),
        )
    )[0];
    if (!row) throw new NotFoundError("That earlier panel is not here.");
    const now = await this.promote(serviceId, id);
    return view({ ...row, status: "installed", installedAt: now, updatedAt: now });
  }

  /** The live blocks of the installed panel or the draft. A waiting version is never read. */
  async data(serviceId: string, which: "installed" | "draft"): Promise<PanelRun> {
    const p = (await this.state(serviceId))[which];
    if (!p) throw new NotFoundError(`There is no ${which === "draft" ? "draft" : "custom"} panel.`);
    // An installed panel follows the class rule too: an app that gained a panel Hearth ships
    // stops being read through its custom one.
    await this.basic(serviceId);
    return this.run(p.spec);
  }

  /** The spec a code panel's page belongs to (its installed panel, or the draft). */
  private async codeSpec(serviceId: string, which: "installed" | "draft") {
    await this.basic(serviceId);
    const p = (await this.state(serviceId))[which];
    if (!p) throw new NotFoundError(`There is no ${which === "draft" ? "draft" : "custom"} panel.`);
    if (p.spec.code === undefined) throw new ConflictError("This panel has no page of its own.");
    return p.spec;
  }

  /** A code panel's read on demand: one of its reads, placeholders filled, GET through the broker. */
  async readOne(
    serviceId: string,
    which: "installed" | "draft",
    readId: string,
    values: Record<string, unknown>,
  ): Promise<unknown> {
    const spec = await this.codeSpec(serviceId, which);
    const r = spec.reads.find((x) => x.id === readId);
    if (!r) throw new NotFoundError(`This panel has no read "${readId.slice(0, 40)}".`);
    let path: string;
    try {
      path = fillPanelPath(r.path, values);
    } catch (e) {
      throw new ConflictError(e instanceof Error ? e.message : String(e));
    }
    const a = await this.apps.appApi(
      serviceId,
      { method: "GET", path, ...(spec.auth ? { auth: spec.auth } : {}) },
      {
        access: "read",
        purpose: `custom panel "${spec.title.slice(0, 60)}": read ${path.split("?")[0]}`,
        by: "you",
      },
    );
    if (!a.ok) throw new ConflictError(`The app answered ${a.status}.`);
    if (JSON.stringify(a.body ?? null).length > PANEL_LIMITS.answerBytes)
      throw new ConflictError("The answer is too large for a panel.");
    return a.body;
  }

  /**
   * A code panel's change, made ready for the owner's approval: one of its actions with the path
   * filled. Nothing is sent here; the web proposes it as a plan with exactly this request.
   */
  async action(
    serviceId: string,
    which: "installed" | "draft",
    actionId: string,
    values: Record<string, unknown>,
    body: unknown,
  ) {
    const spec = await this.codeSpec(serviceId, which);
    const x = spec.actions?.find((a) => a.id === actionId);
    if (!x) throw new NotFoundError(`This panel has no action "${actionId.slice(0, 40)}".`);
    let path: string;
    try {
      path = fillPanelPath(x.path, values);
    } catch (e) {
      throw new ConflictError(e instanceof Error ? e.message : String(e));
    }
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text && text.length > PANEL_LIMITS.body)
      throw new ConflictError("That request is too large.");
    return {
      label: x.label,
      method: x.method,
      path,
      ...(text ? { body: text } : {}),
      why: x.why,
      ...(spec.auth ? { auth: spec.auth } : {}),
    };
  }

  /** A picture for an image block: only paths the installed panel's or draft's image blocks make. */
  async image(serviceId: string, path: string): Promise<{ type: string; bytes: Buffer }> {
    await this.basic(serviceId);
    const s = await this.state(serviceId);
    const spec = [s.installed?.spec, s.draft?.spec].find((x) => x && panelImageAllowed(x, path));
    if (!spec) throw new NotFoundError("Not a picture this panel shows.");
    return this.apps.genericImage(serviceId, path, {
      ...(spec.auth ? { auth: spec.auth } : {}),
      purpose: `custom panel "${spec.title.slice(0, 60)}": picture`,
    });
  }

  /**
   * Save panel file: the installed panel's design, with the receipt that proves it was accepted
   * when this exact design was contributed or loaded as a verified shared panel. A waiting
   * version is never exported, and an unaccepted design carries no receipt.
   */
  async file(serviceId: string): Promise<SharedPanelFile> {
    const s = await this.basic(serviceId);
    const p = (await this.rows(serviceId)).find((r) => r.status === "installed");
    if (!p) throw new NotFoundError("There is no installed custom panel to save.");
    const spec = p.spec as PanelSpec;
    const hash = specHash(spec);
    const sub = await this.submissionOf(serviceId, spec);
    const shared = (
      await this.db
        .select()
        .from(t.panelBaselines)
        .where(and(eq(t.panelBaselines.serviceId, serviceId), eq(t.panelBaselines.specHash, hash)))
    )[0];
    const receipt = sub?.receipt ?? shared?.receipt;
    return { ...contributionFile(spec, s.image), ...(receipt ? { accepted: receipt } : {}) };
  }

  /** The exact file a contribution of the pending (or installed) panel would publish. */
  async preview(serviceId: string): Promise<{
    file: PanelContribution;
    problems: { where: string; problem: string }[];
  }> {
    const s = await this.basic(serviceId);
    const rows = await this.rows(serviceId);
    const p =
      rows.find((r) => r.status === "pending") ?? rows.find((r) => r.status === "installed");
    if (!p) throw new NotFoundError("There is no panel to contribute.");
    const file = contributionFile(p.spec as PanelSpec, s.image);
    return { file, problems: contributionProblems(file) };
  }

  /**
   * Share the installed panel with everyone (Donate, Premium): needs the owner's explicit approval
   * of the exact preview (reviewed) and the sharing agreement (agreed). The service's receipt is
   * kept only when it is genuine and for this design.
   */
  async submit(
    serviceId: string,
    approval: { reviewed: boolean; agreed?: boolean },
    credit: import("./intake").DonationCredit = {},
  ): Promise<PanelSubmissionView> {
    const s = await this.basic(serviceId);
    await this.opts.requireBuilder?.(serviceId, "Sharing a panel");
    const intake = this.opts.intake;
    const keys = this.keys();
    if (!intake || !Object.keys(keys).length)
      throw new ConflictError("There is no submission service set up yet.");
    if (!approval.reviewed)
      throw new ConflictError("Check what will be published, then approve sending it.");
    const target = (await this.rows(serviceId)).find((r) => r.status === "installed");
    if (!target) throw new NotFoundError("There is no panel to share.");
    if (!approval.agreed)
      throw new ConflictError("The sharing agreement has not been accepted for this panel.");
    const terms = { version: PANEL_DONATION_TERMS_VERSION, acceptedAt: new Date().toISOString() };
    const spec = target.spec as PanelSpec;
    const file = contributionFile(spec, s.image, terms);
    const problems = contributionProblems(file);
    if (problems.length)
      throw new ConflictError(
        `Not sent: ${problems
          .slice(0, 5)
          .map((p) => `${p.where} ${p.problem}`)
          .join("; ")}. Ask Ember to change it, then review again.`,
      );
    const licence = await this.opts.licence?.();
    const got = await intake.submit(file, { ...(licence ? { licence } : {}), credit });
    const hash = specHash(spec);
    try {
      verifyReceipt(got.receipt, keys, hash);
    } catch (e) {
      throw new ConflictError(
        `The submission service's answer could not be verified (${e instanceof Error ? e.message : String(e)}). Nothing was kept.`,
      );
    }
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      serviceId,
      specId: spec.id,
      version: target.version,
      receipt: got.receipt,
      url: null,
      termsVersion: terms.version,
      sentAt: now,
      specHash: hash,
      remoteId: got.id,
      urlCheckedAt: null,
    };
    await withTransaction(this.handle, async () => {
      await this.db.insert(t.panelSubmissions).values(row);
      await this.db.insert(t.panelBaselines).values({
        id: randomUUID(),
        serviceId,
        origin: "submitted",
        spec: { ...spec, serviceId: "" },
        specHash: hash,
        receipt: got.receipt,
        createdAt: now,
      });
    });
    return { version: row.version, sentAt: now, id: got.id };
  }
}
