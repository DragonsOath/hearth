import { and, eq } from "drizzle-orm";
import {
  SERVICE_CATEGORIES,
  type DiscoveryReport,
  type ManualSystemInput,
  type ServiceCategory,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { slug } from "../discovery/scan";
import { recordAudit } from "./audit";
import { ConflictError, InvalidRequestError } from "./errors";

/**
 * Systems you add by hand, for when discovery missed something. They are
 * watched like any other system, and a later scan never removes them.
 */

/** Which autonomy rule governs a system you add, from the category you chose. */
const AREA_BY_CATEGORY: Partial<Record<ServiceCategory, string>> = {
  Media: "media",
  Automation: "automation",
  Network: "network",
  "Files & Photos": "storage",
};

/** Docker's own rule for container names. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * A web address as people type it ("192.168.1.20:8080", "http://nas.local/app")
 * turned into one Hearth can check, or a plain reason it cannot.
 */
export function normalizeWebAddress(raw: string): string {
  const text = raw.trim();
  if (!text) throw new InvalidRequestError("Enter its web address, like http://192.168.1.20:8080.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidRequestError(
      "That does not look like a web address. Try one like http://192.168.1.20:8080.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidRequestError("The web address must start with http:// or https://.");
  }
  if (!url.hostname || url.username || url.password) {
    throw new InvalidRequestError(
      "Enter the address without a username or password, like http://192.168.1.20:8080.",
    );
  }
  // Keep exactly what was typed (minus a trailing slash), so it reads the way you wrote it.
  return withScheme.replace(/\/+$/, "");
}

export async function addManualService(
  handle: DbHandle,
  input: ManualSystemInput,
): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name) throw new InvalidRequestError("Give it a name.");
  if (!SERVICE_CATEGORIES.includes(input.category)) {
    throw new InvalidRequestError("Choose a category.");
  }

  return withTransaction(handle, async () => {
    const { db } = handle;
    const hosts = await db.select().from(t.hosts);
    const host = input.hostId
      ? hosts.find((h) => h.id === input.hostId)
      : (hosts.find((h) => h.connection === "this-machine") ?? hosts[0]);
    if (!host) {
      throw new InvalidRequestError(
        input.hostId
          ? "That machine is not in Hearth."
          : "Hearth does not know any machine yet. Use Discover this machine first.",
      );
    }
    const existing = await db.select().from(t.services);

    let checkTarget: string | null = null;
    let localUrl: string | null = null;
    if (input.kind === "container") {
      const container = input.address.trim();
      if (!CONTAINER_NAME.test(container)) {
        throw new InvalidRequestError(
          "Enter the container's name exactly as Docker shows it, like tasterr or immich_server.",
        );
      }
      if (host.connection !== "this-machine") {
        throw new InvalidRequestError(
          `Hearth can only watch containers on the machine it runs on. Add it as an app with a web address instead.`,
        );
      }
      checkTarget = `container:${container}`;
    } else if (input.kind === "web" || input.address.trim()) {
      localUrl = normalizeWebAddress(input.address);
    }

    const same = existing.find((s) =>
      checkTarget
        ? s.hostId === host.id && s.checkTarget === checkTarget
        : localUrl !== null && s.localUrl?.replace(/\/+$/, "") === localUrl,
    );
    if (same?.lifecycle === "removed") {
      throw new ConflictError(
        `You removed ${same.name} from Hearth earlier. Bring it back from Settings > Systems, under Removed systems.`,
      );
    }
    if (same) {
      throw new ConflictError(
        checkTarget
          ? `Hearth already watches that container as ${same.name}.`
          : `Hearth already watches that address as ${same.name}.`,
      );
    }

    // A readable id that never takes over another system's.
    const taken = new Set(existing.map((s) => s.id));
    const base = /[a-z0-9]/i.test(name) ? slug(name) : "system";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    // Web apps and others are checked by their address; the target only has to be unique.
    checkTarget ??= `manual:${id}`;

    const kind =
      input.kind === "container"
        ? ("container" as const)
        : input.kind === "web"
          ? ("web" as const)
          : ("process" as const);
    await db.insert(t.services).values({
      id,
      name,
      category: input.category,
      hostId: host.id,
      kind,
      localUrl,
      // Monitoring decides from the first check on; nothing is known to be wrong yet.
      health: "healthy",
      autonomyArea: AREA_BY_CATEGORY[input.category] ?? "containers",
      checkTarget,
      origin: "manual",
      sort: existing.length,
    });
    await recordAudit(db, {
      actor: "you",
      action: `Added ${name} to Hearth`,
      target: `service:${id}`,
      detail: {
        kind: input.kind,
        category: input.category,
        host: host.id,
        ...(input.kind === "container" ? { container: input.address.trim() } : {}),
        ...(localUrl ? { address: localUrl } : {}),
      },
    });
    return { id, name };
  });
}

/**
 * Marks the findings you removed from Hearth, so a scan shows them as
 * yours to bring back (in Settings) and never ticks or adds them.
 */
export async function markRemovedFindings(
  handle: DbHandle,
  report: DiscoveryReport,
): Promise<DiscoveryReport> {
  const removed = await handle.db
    .select({ name: t.services.name, checkTarget: t.services.checkTarget })
    .from(t.services)
    .where(and(eq(t.services.hostId, report.host.id), eq(t.services.lifecycle, "removed")));
  if (!removed.length) return report;
  const byTarget = new Map(removed.map((r) => [r.checkTarget, r.name]));
  return {
    ...report,
    findings: report.findings.map((f) =>
      byTarget.has(f.key)
        ? {
            ...f,
            removed: true,
            selectedByDefault: false,
            reason: `You removed ${byTarget.get(f.key)} from Hearth, so it stays out. To watch it again, bring it back in Settings > Systems, under Removed systems.`,
          }
        : f,
    ),
  };
}
