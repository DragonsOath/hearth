import { PUBLIC_ROUTES } from "@dragon-control/core";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { DEFAULT_AI_NAME, type Autonomy, type AutonomyRule } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { addTimeline } from "../monitor/engine";
import { fingerprint, pendingAction } from "../actions/approval";
import { recordAudit } from "./audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "./errors";
import { getSetting, setSetting, SETTING_DEFAULTS, deleteSetting } from "./settings";

/**
 * Every user-initiated change goes through here: validated against current
 * state, applied atomically, and written to the audit log in the same
 * transaction so a change can never exist without its record.
 */

export async function updateGeneralSettings(
  handle: DbHandle,
  patch: {
    instanceName?: string;
    ownerName?: string;
    aiName?: string;
    theme?: import("@dragon-control/core").ThemeChoice;
    /** The look on phones; null goes back to the same as the desktop. */
    phoneTheme?: import("@dragon-control/core").ThemeChoice | null;
    /** The Lair's systems in your order; null goes back to most used first. */
    lairOrder?: string[] | null;
    /** How often each system was opened in the Lair (merged with what is kept). */
    lairUsage?: Record<string, { s: number; at: number }> | null;
    webUiVia?: "proxy" | "host";
    quietHours?: boolean;
    monitorIntervalSec?: number;
    failureThreshold?: number;
    liveRepairs?: boolean;
    /** Pictures beside messages in conversations. */
    chatPictures?: boolean;
    /** Finished or skipped the welcome (true), or offer it again next time (false). */
    onboardingDone?: boolean;
    /** The welcome's first choice: build a first homelab, or bring an existing one. */
    journey?: "build" | "existing";
    /** The welcome step reached last, so it resumes there. */
    onboardingStep?: string;
  },
): Promise<void> {
  await withTransaction(handle, async () => {
    const { db } = handle;
    if (patch.instanceName !== undefined) {
      const before = (await getSetting(db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
      if (before !== patch.instanceName) {
        await setSetting(db, "instance_name", patch.instanceName);
        await recordAudit(db, {
          actor: "you",
          action: "Renamed this installation",
          target: "settings",
          detail: { from: before, to: patch.instanceName },
        });
      }
    }
    if (patch.theme !== undefined) await setSetting(db, "ui_theme", patch.theme);
    if (patch.phoneTheme === null) await deleteSetting(db, "ui_theme_phone");
    else if (patch.phoneTheme !== undefined)
      await setSetting(db, "ui_theme_phone", patch.phoneTheme);
    if (patch.lairOrder === null) await deleteSetting(db, "lair_order");
    else if (patch.lairOrder !== undefined) await setSetting(db, "lair_order", patch.lairOrder);
    if (patch.lairUsage === null) await deleteSetting(db, "lair_usage");
    else if (patch.lairUsage !== undefined) {
      // Each device sends what it counted; the later count of each system wins.
      const kept = (await getSetting(db, "lair_usage")) ?? {};
      const merged = { ...kept };
      for (const [k, v] of Object.entries(patch.lairUsage))
        if (!merged[k] || v.at >= merged[k].at) merged[k] = v;
      const keys = Object.keys(merged).sort((a, b) => merged[b]!.at - merged[a]!.at);
      await setSetting(
        db,
        "lair_usage",
        Object.fromEntries(keys.slice(0, 500).map((k) => [k, merged[k]!])),
      );
    }
    if (patch.webUiVia !== undefined) await setSetting(db, "web_ui_via", patch.webUiVia);
    if (patch.chatPictures !== undefined) await setSetting(db, "chat_pictures", patch.chatPictures);
    if (patch.onboardingDone === true) {
      await setSetting(db, "onboarding_done_at", new Date().toISOString());
      // Finished or skipped: nothing to resume any more.
      await deleteSetting(db, "onboarding_step");
    }
    if (patch.onboardingDone === false) await deleteSetting(db, "onboarding_done_at");
    if (patch.journey !== undefined) await setSetting(db, "journey", patch.journey);
    if (patch.onboardingStep !== undefined)
      await setSetting(db, "onboarding_step", patch.onboardingStep);
    if (patch.ownerName !== undefined) {
      if (patch.ownerName) await setSetting(db, "owner_name", patch.ownerName);
      else await deleteSetting(db, "owner_name");
    }
    if (patch.aiName !== undefined) {
      // A display name only: nothing else about the assistant changes.
      const before = (await getSetting(db, "ai_name")) || undefined;
      const next = patch.aiName || undefined;
      if (before !== next) {
        if (next) await setSetting(db, "ai_name", next);
        else await deleteSetting(db, "ai_name");
        await recordAudit(db, {
          actor: "you",
          action: next
            ? `Named your AI administrator "${next}"`
            : "Gave your AI administrator back its default name, Ember",
          target: "settings",
          detail: { from: before ?? DEFAULT_AI_NAME, to: next ?? DEFAULT_AI_NAME },
        });
      }
    }
    if (patch.monitorIntervalSec !== undefined) {
      await setSetting(db, "monitor_interval_sec", patch.monitorIntervalSec);
      await recordAudit(db, {
        actor: "you",
        action: `Set checks to run every ${patch.monitorIntervalSec >= 60 ? `${patch.monitorIntervalSec / 60} min` : `${patch.monitorIntervalSec} s`}`,
        target: "monitoring",
      });
    }
    if (patch.failureThreshold !== undefined) {
      await setSetting(db, "failure_threshold", patch.failureThreshold);
      await recordAudit(db, {
        actor: "you",
        action: `Open incidents after ${patch.failureThreshold} failed ${patch.failureThreshold === 1 ? "check" : "checks"} in a row`,
        target: "monitoring",
      });
    }
    if (patch.liveRepairs !== undefined) {
      const before = (await getSetting(db, "live_repairs")) ?? false;
      if (before !== patch.liveRepairs) {
        await setSetting(db, "live_repairs", patch.liveRepairs);
        await recordAudit(db, {
          actor: "you",
          action: patch.liveRepairs
            ? "Turned on automatic repairs for your systems"
            : "Turned off automatic repairs for your systems",
          target: "autonomy",
        });
      }
    }
    if (patch.quietHours !== undefined) {
      await setSetting(db, "quiet_hours", patch.quietHours);
      await recordAudit(db, {
        actor: "you",
        action: patch.quietHours ? "Turned quiet hours on" : "Turned quiet hours off",
        target: "notifications",
      });
    }
  });
}

export async function saveAutonomy(
  handle: DbHandle,
  input: { default: Autonomy; rules: Pick<AutonomyRule, "id" | "level">[] },
): Promise<void> {
  await withTransaction(handle, async () => {
    const { db } = handle;
    const existing = await db.select().from(t.autonomyRules);
    const known = new Map(existing.map((r) => [r.id, r]));
    const unknown = input.rules.filter((r) => !known.has(r.id)).map((r) => r.id);
    if (unknown.length)
      throw new InvalidRequestError(`Unknown autonomy areas: ${unknown.join(", ")}`);

    const changes: Record<string, { from: string; to: string }> = {};
    const before = (await getSetting(db, "autonomy_default")) ?? SETTING_DEFAULTS.autonomy_default;
    if (before !== input.default) {
      await setSetting(db, "autonomy_default", input.default);
      changes.default = { from: before, to: input.default };
    }
    for (const rule of input.rules) {
      const prev = known.get(rule.id)!;
      if (prev.level !== rule.level) {
        await db
          .update(t.autonomyRules)
          .set({ level: rule.level })
          .where(eq(t.autonomyRules.id, rule.id));
        changes[prev.label] = { from: prev.level, to: rule.level };
      }
    }
    if (Object.keys(changes).length) {
      await recordAudit(db, {
        actor: "you",
        action: "Changed autonomy settings",
        target: "autonomy",
        detail: changes,
      });
    }
  });
}

export async function setRouteChannels(
  handle: DbHandle,
  routeId: string,
  channelIds: string[],
): Promise<void> {
  await withTransaction(handle, async () => {
    const { db } = handle;
    const route = await db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, routeId))
      .get();
    if (!route) throw new NotFoundError(`No notification route "${routeId}"`);

    const unique = [...new Set(channelIds)];
    if (unique.length) {
      const channels = await db
        .select()
        .from(t.notificationChannels)
        .where(inArray(t.notificationChannels.id, unique));
      const usable = new Set(channels.filter((c) => c.status === "configured").map((c) => c.id));
      const bad = unique.filter((c) => !usable.has(c));
      if (bad.length) throw new InvalidRequestError(`Channels not set up: ${bad.join(", ")}`);
      // Friends and family see media announcements only, never system or admin messages.
      const pub = channels.filter((c) => c.audience === "public");
      if (pub.length && !PUBLIC_ROUTES.includes(routeId))
        throw new InvalidRequestError(
          `${pub.map((c) => c.name).join(", ")} is for friends and family: only media announcements can go there.`,
        );
    }

    await db
      .update(t.notificationRoutes)
      .set({ channels: unique })
      .where(eq(t.notificationRoutes.id, routeId));
    await recordAudit(db, {
      actor: "you",
      action: `Changed where "${route.event}" is sent`,
      target: "notifications",
      detail: { from: route.channels, to: unique },
    });
  });
}

/**
 * Records your decision on a proposed repair. Approving must name the exact
 * proposal you saw (its fingerprint), before it expires, and only once; the
 * returned action id is the one thing the approval lets run.
 */
export async function decideIncident(
  handle: DbHandle,
  incidentId: string,
  decision: "approve" | "decline",
  approvedFingerprint?: string,
): Promise<{ actionId?: string }> {
  return withTransaction(handle, async () => {
    const { db } = handle;
    const incident = await db
      .select()
      .from(t.incidents)
      .where(eq(t.incidents.id, incidentId))
      .get();
    if (!incident) throw new NotFoundError(`No incident "${incidentId}"`);
    if (incident.status !== "awaiting-approval" || !incident.proposedAction) {
      throw new ConflictError("This incident has no repair waiting for a decision.");
    }

    const at = new Date().toISOString();
    const action = await pendingAction(db, incidentId);
    if (decision === "approve") {
      if (!approvedFingerprint) {
        throw new InvalidRequestError("Approving needs the fingerprint of the proposal you saw.");
      }
      if (incident.proposalExpiresAt && incident.proposalExpiresAt <= at) {
        throw new ConflictError(
          "This proposal has expired, so it can no longer be approved. Nothing was changed.",
        );
      }
      if (approvedFingerprint !== fingerprint(incident, action)) {
        throw new ConflictError(
          "This proposal changed after you saw it. Review the current one before approving.",
        );
      }
      // Used once: the approval is consumed here.
      await db
        .update(t.incidents)
        .set({ status: "approved", proposalExpiresAt: null })
        .where(eq(t.incidents.id, incidentId));
      await db.insert(t.incidentTimeline).values({
        incidentId,
        at,
        kind: "approval",
        text: `You approved the proposed repair: ${incident.proposedAction}`,
      });
    } else {
      await db
        .update(t.incidents)
        .set({ status: "open", handledBy: "pending", proposalExpiresAt: null })
        .where(eq(t.incidents.id, incidentId));
      await db.insert(t.incidentTimeline).values({
        incidentId,
        at,
        kind: "approval",
        text: "You declined the proposed repair. The incident stays open for you.",
      });
    }
    await db.insert(t.events).values({
      id: randomUUID(),
      at,
      tone: "neutral",
      message: `You ${decision === "approve" ? "approved" : "declined"} a repair: ${incident.title}`,
      incidentId,
    });
    await recordAudit(db, {
      actor: "you",
      action: decision === "approve" ? "Approved a repair" : "Declined a repair",
      target: `incident:${incidentId}`,
      detail: {
        proposedAction: incident.proposedAction,
        ...(decision === "approve" ? { fingerprint: approvedFingerprint } : {}),
        ...(action ? { actionId: action.id } : {}),
      },
    });
    return { actionId: decision === "approve" ? action?.id : undefined };
  });
}

export type Lifecycle = "active" | "paused" | "retired";

/**
 * Whether a service is watched. Paused: off on purpose for now. Retired:
 * replaced or removed, kept for history. Either way it is no longer checked,
 * its open incident is closed as your decision, and a repair waiting for
 * approval is withdrawn. "active" watches it again from a clean slate.
 * A system removed from Hearth is brought back from Settings instead.
 */
export async function setServiceLifecycle(
  handle: DbHandle,
  id: string,
  lifecycle: Lifecycle,
  note?: string,
): Promise<{ name: string; changed: boolean }> {
  return changeLifecycle(handle, id, lifecycle, note, (service) => {
    if (service.lifecycle === "removed") {
      throw new ConflictError(
        `${service.name} was removed from Hearth. Bring it back from Settings first.`,
      );
    }
    return lifecycle === "active"
      ? `Watching ${service.name} again`
      : `Marked ${service.name} as ${lifecycle}`;
  });
}

/**
 * Takes a system out of Hearth: it is no longer watched, repaired, or
 * shown anywhere, and a scan never adds it back. Nothing on the machine
 * changes; the container or app keeps running exactly as it was. Its history
 * stays in the audit log.
 */
export async function removeService(
  handle: DbHandle,
  id: string,
): Promise<{ name: string; changed: boolean }> {
  return changeLifecycle(
    handle,
    id,
    "removed",
    undefined,
    (service) => `Removed ${service.name} from Hearth`,
  );
}

/** Brings a removed system back: Hearth watches it again from a clean slate. */
export async function restoreService(
  handle: DbHandle,
  id: string,
): Promise<{ name: string; changed: boolean }> {
  return changeLifecycle(handle, id, "active", undefined, (service) => {
    if (service.lifecycle !== "removed") {
      throw new ConflictError(`${service.name} is not removed, so there is nothing to bring back.`);
    }
    return `Brought ${service.name} back to Hearth`;
  });
}

async function changeLifecycle(
  handle: DbHandle,
  id: string,
  lifecycle: Lifecycle | "removed",
  note: string | undefined,
  /** Checks the change is allowed and names it for the audit log. */
  describe: (service: typeof t.services.$inferSelect) => string,
): Promise<{ name: string; changed: boolean }> {
  return withTransaction(handle, async () => {
    const { db } = handle;
    const service = await db.select().from(t.services).where(eq(t.services.id, id)).get();
    if (!service) throw new NotFoundError("No such service.");
    const action = describe(service);
    const text = lifecycle === "removed" ? null : note?.trim() || null;
    if (service.lifecycle === lifecycle && (service.lifecycleNote ?? null) === text) {
      return { name: service.name, changed: false };
    }
    const at = new Date().toISOString();
    await db
      .update(t.services)
      .set({
        lifecycle,
        lifecycleNote: lifecycle === "active" ? null : text,
        lifecycleAt: lifecycle === "active" ? null : at,
        // A removed system is not held as "stopped on request" either: it is simply not ours.
        ...(lifecycle === "removed" ? { stoppedAt: null, stoppedBy: null } : {}),
      })
      .where(eq(t.services.id, id));
    // A fresh start either way: no stale failure count carried over.
    await db.delete(t.checkState).where(eq(t.checkState.serviceId, id));

    if (lifecycle !== "active") {
      const decision =
        lifecycle === "removed"
          ? `You removed ${service.name} from Hearth. It is no longer watched; the app itself was not changed.`
          : `You marked ${service.name} as ${lifecycle}${text ? `: ${text}` : ""}. It is no longer watched.`;
      const open = await db
        .select()
        .from(t.incidents)
        .where(and(eq(t.incidents.serviceId, id), ne(t.incidents.status, "resolved")));
      for (const incident of open) {
        await addTimeline(db, incident.id, at, "resolved", decision);
        await db
          .update(t.incidents)
          .set({
            status: "resolved",
            resolvedAt: at,
            handledBy: "you",
            resolution: decision,
            proposedAction: null,
          })
          .where(eq(t.incidents.id, incident.id));
        await db
          .update(t.actions)
          .set({ status: "refused", result: `No longer needed: ${decision}`, completedAt: at })
          .where(and(eq(t.actions.incidentId, incident.id), eq(t.actions.status, "requested")));
      }
    }
    await recordAudit(db, {
      actor: "you",
      action,
      target: `service:${id}`,
      detail: { from: service.lifecycle, to: lifecycle, ...(text ? { note: text } : {}) },
    });
    return { name: service.name, changed: true };
  });
}

/**
 * Saves the homelab rules as a whole. Each do-not-touch entry must name a service Hearth
 * knows; the change is audited with what was added and removed, so the list's history is clear.
 */
export async function saveHomelabRules(
  handle: DbHandle,
  rules: {
    doNotTouch: { serviceId: string; reason: string }[];
    reservations: import("@dragon-control/core").Reservation[];
    /** The owner's own rules for Ember; left as they are when not sent. */
    notes?: string;
  },
): Promise<void> {
  await withTransaction(handle, async () => {
    const { db } = handle;
    const ids = [...new Set(rules.doNotTouch.map((d) => d.serviceId))];
    const known = ids.length
      ? await db
          .select({ id: t.services.id, name: t.services.name })
          .from(t.services)
          .where(inArray(t.services.id, ids))
      : [];
    const names = new Map(known.map((k) => [k.id, k.name]));
    const missing = ids.find((id) => !names.has(id));
    if (missing) throw new NotFoundError(`No service "${missing}".`);
    const before = (await getSetting(db, "do_not_touch")) ?? [];
    const at = new Date().toISOString();
    const list = ids.map((id) => {
      const entry = rules.doNotTouch.find((d) => d.serviceId === id)!;
      return {
        serviceId: id,
        reason: entry.reason.trim(),
        addedAt: before.find((b) => b.serviceId === id)?.addedAt ?? at,
      };
    });
    await setSetting(db, "do_not_touch", list);
    await setSetting(db, "reservations", rules.reservations);
    const notesBefore = (await getSetting(db, "lair_rules")) ?? "";
    const notes = rules.notes === undefined ? notesBefore : rules.notes.trim();
    if (notes !== notesBefore) await setSetting(db, "lair_rules", notes);
    const added = list.filter((d) => !before.some((b) => b.serviceId === d.serviceId));
    const removed = before.filter((b) => !list.some((d) => d.serviceId === b.serviceId));
    await recordAudit(db, {
      actor: "you",
      action: "Updated your homelab rules",
      target: "settings",
      detail: {
        doNotTouchAdded: added.map((d) => names.get(d.serviceId)),
        doNotTouchRemoved: removed.map((d) => names.get(d.serviceId) ?? d.serviceId),
        reservations: rules.reservations.length,
        ...(notes !== notesBefore ? { ownRulesChanged: true } : {}),
      },
    });
  });
}
