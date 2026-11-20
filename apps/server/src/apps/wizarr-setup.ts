import { createHash } from "node:crypto";
import type {
  StepParams,
  WizarrSettings,
  WizarrStep,
  WizarrStepCategory,
  WizarrWizard,
} from "@dragon-control/core";
import { isDesignStep, stepChange } from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { wizarrDashboard } from "./wizarr";
import {
  cleanExpiredUsers,
  createStep,
  deleteStep,
  editStep,
  orderSteps,
  readWizarrSettings,
  readWizarrWizard,
  saveSettings,
  WIZARR_STEP_SERVERS,
  WizarrAdmin,
} from "./wizarr-admin";

/**
 * Changing Wizarr's setup (Settings, Wizard and General) as plans you approve: add, edit, delete or
 * move an invite step, save General settings, or clean expired users. Each is planned from what
 * Wizarr shows now, refused if that changed before it runs, and read back afterwards.
 */

export const SETUP_OPS = [
  "step-add",
  "step-edit",
  "step-delete",
  "step-move",
  "settings",
  "clean-expired",
] as const;
export type SetupOp = (typeof SETUP_OPS)[number];

const CATEGORY_NAME: Record<WizarrStepCategory, string> = {
  pre_invite: "Before they accept",
  post_invite: "After they accept",
};
const SERVER_NAME: Record<string, string> = {
  plex: "Plex",
  jellyfin: "Jellyfin",
  emby: "Emby",
  audiobookshelf: "Audiobookshelf",
  romm: "RomM",
  komga: "Komga",
  kavita: "Kavita",
};
export const serverName = (s: string) => SERVER_NAME[s] ?? s;
const MARKDOWN_MAX = 50_000;

/** A short fingerprint of a step as it was planned, so a step changed meanwhile is left alone. */
export const stepPrint = (s: Pick<WizarrStep, "title" | "markdown" | "requireInteraction">) =>
  createHash("sha256")
    .update(JSON.stringify([s.title, s.markdown, s.requireInteraction]))
    .digest("hex")
    .slice(0, 16);

const short = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const allSteps = (w: WizarrWizard) => w.servers.flatMap((s) => s.steps);
const listOf = (w: WizarrWizard, server: string, category: WizarrStepCategory) =>
  allSteps(w)
    .filter((s) => s.server === server && s.category === category)
    .sort((a, b) => a.position - b.position);

/**
 * Admin sessions per Wizarr (cookies only, never the password), so panel reads do not sign in
 * every time: Wizarr allows ten sign-ins a minute.
 */
export class WizarrAdminSessions {
  private readonly jars = new Map<string, { jar: Map<string, string>; at: number }>();
  constructor(
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (admin: WizarrAdmin) => Promise<T>,
    by?: "agent" | "you",
  ): Promise<T> {
    return this.broker.use(
      {
        serviceId: service.id,
        purpose,
        access,
        destination: service.localUrl,
        login: true,
        ...(by ? { onBehalfOf: by } : {}),
      },
      async ({ value, username }) => {
        const key = `${service.id}|${service.localUrl}|${username ?? ""}`;
        const held = this.jars.get(key);
        // A session older than half an hour is dropped: Wizarr may have ended it anyway.
        const jar =
          held && Date.now() - held.at < 30 * 60_000 ? held.jar : new Map<string, string>();
        const admin = new WizarrAdmin(
          this.fetchImpl,
          service.localUrl,
          { username: username ?? "", password: value },
          jar,
        );
        try {
          const out = await fn(admin);
          this.jars.set(key, { jar, at: held?.jar === jar ? held.at : Date.now() });
          return out;
        } catch (error) {
          this.jars.delete(key);
          throw error;
        }
      },
    );
  }
}

const bool = (v: unknown) => v === true || v === "true" || v === "yes" || v === 1;

/** Plans one setup change from what Wizarr shows now. */
export async function planSetup(
  admin: WizarrAdmin,
  service: { name: string },
  params: StepParams | undefined,
  base: PlannedStep,
): Promise<PlannedStep> {
  const op = String(params?.op ?? "") as SetupOp;
  if (!SETUP_OPS.includes(op)) throw new Error(`Say what to do: ${SETUP_OPS.join(", ")}.`);
  const done = (
    summary: string,
    out: StepParams,
    settings: { name: string; before: string; after: string }[],
  ) => ({
    ...base,
    label: `${summary} in ${service.name}`,
    serviceName: service.name,
    params: { op, ...out },
    change: { summary, settings },
  });

  if (op === "settings" || op === "clean-expired") {
    const now = await readWizarrSettings(admin);
    if (op === "clean-expired")
      return done(
        now.expiryAction === "disable"
          ? "Disable everyone whose access has ended"
          : "Delete everyone whose access has ended",
        { expiryAction: now.expiryAction },
        [
          {
            name: "People whose access has ended",
            before: "still listed",
            after:
              now.expiryAction === "disable"
                ? "disabled (where the media server supports it; deleted otherwise)"
                : "deleted from Wizarr and the media server",
          },
        ],
      );
    const out: StepParams = {};
    const settings: { name: string; before: string; after: string }[] = [];
    if (params?.displayName !== undefined) {
      const name = String(params.displayName).trim();
      if (!name || name.length > 100) throw new Error("The display name is 1 to 100 characters.");
      if (name !== now.displayName) {
        out.displayName = name;
        settings.push({ name: "Display name", before: now.displayName, after: name });
      }
    }
    if (params?.protectWizard !== undefined && bool(params.protectWizard) !== now.protectWizard) {
      out.protectWizard = bool(params.protectWizard);
      settings.push({
        name: "Only invited people can open the guide",
        before: now.protectWizard ? "on" : "off",
        after: out.protectWizard ? "on" : "off",
      });
    }
    if (params?.expiryAction !== undefined) {
      const v = String(params.expiryAction);
      if (v !== "delete" && v !== "disable")
        throw new Error("When access ends, Wizarr can delete or disable the person.");
      if (v !== now.expiryAction) {
        out.expiryAction = v;
        settings.push({
          name: "When someone's access ends",
          before: now.expiryAction === "disable" ? "Disable them" : "Delete them",
          after: v === "disable" ? "Disable them" : "Delete them",
        });
      }
    }
    if (params?.posters !== undefined) {
      if (!now.posters) throw new Error("This Wizarr has no join page posters setting.");
      const v = String(params.posters);
      const choice = now.posters.choices.find((c) => c.value === v);
      if (!choice) throw new Error("That is not one of Wizarr's poster choices.");
      if (v !== now.posters.value) {
        out.posters = v;
        settings.push({
          name: "Join page posters",
          before: now.posters.choices.find((c) => c.value === now.posters!.value)?.label ?? "",
          after: choice.label,
        });
      }
    }
    if (!settings.length)
      throw new Error("Nothing would change: Wizarr already has these settings.");
    return done("Change Wizarr's General settings", out, settings);
  }

  const wizard = await readWizarrWizard(admin);
  if (op === "step-add") {
    const server = String(params?.server ?? "");
    if (!(WIZARR_STEP_SERVERS as readonly string[]).includes(server))
      throw new Error(`The step is for one of: ${WIZARR_STEP_SERVERS.join(", ")}.`);
    const category = String(params?.category ?? "post_invite") as WizarrStepCategory;
    if (category !== "pre_invite" && category !== "post_invite")
      throw new Error("A step shows before they accept (pre_invite) or after (post_invite).");
    const title = String(params?.title ?? "")
      .trim()
      .slice(0, 200);
    const markdown = String(params?.body ?? "");
    if (!markdown.trim()) throw new Error("Write what the step says.");
    if (markdown.length > MARKDOWN_MAX) throw new Error("A step is at most 50,000 characters.");
    return done(
      `Add a ${serverName(server)} step: ${short(title || "Untitled")}`,
      {
        server,
        category,
        title,
        body: markdown,
        requireInteraction: bool(params?.requireInteraction),
      },
      [
        {
          name: `${serverName(server)}, ${CATEGORY_NAME[category]}`,
          before: "not there",
          after: `added at the end: ${short(title || "Untitled")}`,
        },
      ],
    );
  }

  const id = Number(params?.stepId);
  const step = allSteps(wizard).find((s) => s.id === id);
  if (!step) throw new Error(`Wizarr has no invite step #${params?.stepId ?? "?"}.`);
  const where = `${serverName(step.server)}, ${CATEGORY_NAME[step.category]}`;
  const name = short(step.title || "Untitled");

  if (op === "step-delete")
    return done(
      `Delete the ${serverName(step.server)} step ${name}`,
      { stepId: id, before: stepPrint(step) },
      [{ name: `${where}: ${name}`, before: short(step.markdown, 120), after: "deleted" }],
    );

  if (op === "step-edit") {
    const title =
      params?.title === undefined ? step.title : String(params.title).trim().slice(0, 200);
    const markdown = params?.body === undefined ? step.markdown : String(params.body);
    const require =
      params?.requireInteraction === undefined
        ? step.requireInteraction
        : bool(params.requireInteraction);
    if (!markdown.trim()) throw new Error("A step cannot be empty.");
    if (markdown.length > MARKDOWN_MAX) throw new Error("A step is at most 50,000 characters.");
    const settings: { name: string; before: string; after: string }[] = [];
    if (title !== step.title) settings.push({ name: "Title", before: step.title, after: title });
    if (markdown !== step.markdown) {
      // A design step recolored: say which colors, not the start of its styling (11-04).
      const change = isDesignStep(step.markdown)
        ? stepChange(step.markdown, markdown)
        : { text: true };
      if (change.colors)
        settings.push({ name: "Colors", before: change.colors[0], after: change.colors[1] });
      if (change.text)
        settings.push({
          name: "Text",
          before: short(step.markdown, 120),
          after: short(markdown, 120),
        });
    }
    if (require !== step.requireInteraction)
      settings.push({
        name: "They must click something before Next",
        before: step.requireInteraction ? "yes" : "no",
        after: require ? "yes" : "no",
      });
    if (!settings.length) throw new Error("Nothing would change: the step already says this.");
    return done(
      `Edit the ${serverName(step.server)} step ${name}`,
      { stepId: id, title, body: markdown, requireInteraction: require, before: stepPrint(step) },
      settings,
    );
  }

  // step-move: to a place in its own list, or into the other list.
  const category = String(params?.category ?? step.category) as WizarrStepCategory;
  if (category !== "pre_invite" && category !== "post_invite")
    throw new Error("A step shows before they accept (pre_invite) or after (post_invite).");
  const target = listOf(wizard, step.server, category).filter((s) => s.id !== id);
  const index = Math.max(0, Math.min(target.length, Math.trunc(Number(params?.index ?? 0))));
  const order = [
    ...target.slice(0, index).map((s) => s.id),
    id,
    ...target.slice(index).map((s) => s.id),
  ];
  const nowAt = listOf(wizard, step.server, step.category).findIndex((s) => s.id === id);
  if (category === step.category && nowAt === index)
    throw new Error("Nothing would change: the step is already there.");
  return done(
    `Move the ${serverName(step.server)} step ${name}`,
    { stepId: id, category, order: order.join(","), server: step.server },
    [
      {
        name: name,
        before: `${CATEGORY_NAME[step.category]}, step ${nowAt + 1}`,
        after: `${CATEGORY_NAME[category]}, step ${index + 1}`,
      },
    ],
  );
}

/** Runs one approved setup change, then reads Wizarr back. */
export async function runSetup(
  admin: WizarrAdmin,
  ctx: {
    handle: DbHandle;
    broker: CredentialBroker;
    fetchImpl: Fetch;
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null };
  },
  step: StepRun,
): Promise<StepOutcome> {
  const p = step.params ?? {};
  const op = String(p.op) as SetupOp;
  const audit = (verified: boolean) =>
    recordAudit(ctx.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? "Changed Wizarr's setup"} in ${ctx.service.name}`,
      target: `service:${ctx.service.id}`,
      detail: { op, verified },
    });
  const finish = async (verified: boolean, yes: string, no: string): Promise<StepOutcome> => {
    await audit(verified);
    return { ok: verified, verified, result: verified ? yes : no };
  };

  if (op === "settings") {
    const change: Parameters<typeof saveSettings>[1] = {
      ...(p.displayName !== undefined ? { displayName: String(p.displayName) } : {}),
      ...(p.protectWizard !== undefined ? { protectWizard: bool(p.protectWizard) } : {}),
      ...(p.expiryAction !== undefined
        ? { expiryAction: String(p.expiryAction) as WizarrSettings["expiryAction"] }
        : {}),
      ...(p.posters !== undefined ? { posters: String(p.posters) } : {}),
    };
    await saveSettings(admin, change);
    const after = await readWizarrSettings(admin);
    const ok =
      (change.displayName === undefined || after.displayName === change.displayName) &&
      (change.protectWizard === undefined || after.protectWizard === change.protectWizard) &&
      (change.expiryAction === undefined || after.expiryAction === change.expiryAction) &&
      (change.posters === undefined || after.posters?.value === change.posters);
    return finish(
      ok,
      "Saved Wizarr's General settings (read back).",
      "Wizarr answered, but its General settings do not read back as approved.",
    );
  }

  if (op === "clean-expired") {
    const now = await readWizarrSettings(admin);
    if (now.expiryAction !== String(p.expiryAction ?? now.expiryAction))
      return {
        ok: false,
        stale: true,
        result: `Wizarr now ${now.expiryAction === "disable" ? "disables" : "deletes"} people whose access ended, not what was approved; nothing was done.`,
      };
    await cleanExpiredUsers(admin);
    // Read people back with the API key: nobody whose access ended may still be listed as active.
    const users = await ctx.broker.use(
      {
        serviceId: ctx.service.id,
        purpose: "read Wizarr's people after cleaning expired users",
        access: "read",
        destination: ctx.service.localUrl,
      },
      ({ value }) =>
        wizarrDashboard(
          ctx.fetchImpl,
          ctx.service.localUrl,
          value,
          Date.now(),
          ctx.service.publicUrl,
        ),
    );
    const left = users.users.filter((u) => u.expires && Date.parse(u.expires) < Date.now());
    const ok = now.expiryAction === "disable" || left.length === 0;
    return finish(
      ok,
      now.expiryAction === "disable"
        ? "Wizarr disabled everyone whose access had ended (where the media server supports it). Wizarr does not show who is disabled, so that part could not be read back."
        : "Wizarr deleted everyone whose access had ended; none are listed now.",
      `Wizarr still lists ${left.length} ${left.length === 1 ? "person" : "people"} whose access ended.`,
    );
  }

  const before = await readWizarrWizard(admin);
  if (op === "step-add") {
    const input = {
      server: String(p.server),
      category: String(p.category) as WizarrStepCategory,
      title: String(p.title ?? ""),
      markdown: String(p.body ?? ""),
      requireInteraction: bool(p.requireInteraction),
    };
    const had = new Set(allSteps(before).map((s) => s.id));
    await createStep(admin, input);
    const after = await readWizarrWizard(admin);
    const made = listOf(after, input.server, input.category).find((s) => !had.has(s.id));
    const ok =
      Boolean(made) &&
      made!.title === input.title &&
      made!.markdown.trim() === input.markdown.trim() &&
      made!.requireInteraction === input.requireInteraction;
    return finish(
      ok,
      `Added the step "${input.title || "Untitled"}" for ${serverName(input.server)} (read back).`,
      made
        ? "Wizarr made the step, but it does not read back as approved."
        : "Wizarr answered, but the new step is not in its list.",
    );
  }

  const id = Number(p.stepId);
  const step0 = allSteps(before).find((s) => s.id === id);
  if (!step0)
    return op === "step-delete"
      ? { ok: true, stale: true, result: "The step is already gone." }
      : { ok: false, stale: true, result: "Wizarr no longer has that step; nothing was changed." };
  if ((op === "step-edit" || op === "step-delete") && stepPrint(step0) !== String(p.before))
    return {
      ok: false,
      stale: true,
      result: "The step was changed in Wizarr since this was planned; nothing was changed.",
    };

  if (op === "step-delete") {
    await deleteStep(admin, id);
    const gone = !allSteps(await readWizarrWizard(admin)).some((s) => s.id === id);
    return finish(
      gone,
      `Deleted the step "${step0.title || "Untitled"}"; Wizarr no longer lists it.`,
      "Wizarr still lists the step.",
    );
  }

  if (op === "step-edit") {
    const input = {
      server: step0.server,
      category: step0.category,
      title: String(p.title ?? ""),
      markdown: String(p.body ?? ""),
      requireInteraction: bool(p.requireInteraction),
    };
    await editStep(admin, id, input);
    const got = allSteps(await readWizarrWizard(admin)).find((s) => s.id === id);
    const ok =
      Boolean(got) &&
      got!.title === input.title &&
      got!.markdown.trim() === input.markdown.trim() &&
      got!.requireInteraction === input.requireInteraction;
    return finish(
      ok,
      `Saved the step "${input.title || "Untitled"}" (read back).`,
      "Wizarr answered, but the step does not read back as approved.",
    );
  }

  // step-move: the target list must still hold the same steps it did when planned.
  const category = String(p.category) as WizarrStepCategory;
  const order = String(p.order ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const others = listOf(before, step0.server, category)
    .map((s) => s.id)
    .filter((x) => x !== id);
  const planned = order.filter((x) => x !== id);
  if (others.length !== planned.length || others.some((x) => !planned.includes(x)))
    return {
      ok: false,
      stale: true,
      result: "That list of steps changed in Wizarr since this was planned; nothing was moved.",
    };
  await orderSteps(admin, step0.server, category, order);
  const now = listOf(await readWizarrWizard(admin), step0.server, category).map((s) => s.id);
  const ok = now.join(",") === order.join(",");
  return finish(
    ok,
    `Moved the step "${step0.title || "Untitled"}" (read back).`,
    "Wizarr answered, but the steps are not in the approved order.",
  );
}
