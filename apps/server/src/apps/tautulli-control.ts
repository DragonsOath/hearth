import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { tautulliCmd } from "./tautulli";
import { historyRow, type RawHistory } from "./tautulli-panel";

/**
 * Tautulli changes from Hearth (the panel and Ember plan the same steps), app-tautulli-control:
 * - edit-user: a person's name in Tautulli, whether their plays are recorded, guest access.
 * - edit-library: whether a library's plays are recorded.
 * - delete-history: remove play records from Tautulli (Plex's own watched state is not touched).
 * - backup-db: a backup of Tautulli's database, now.
 * - refresh-users, refresh-libraries: read the lists from Plex again.
 * Edits send every value (Tautulli 2.17 and older reset any it is not sent), record what they
 * start from and are refused as stale if it changed; edits and deletions are read back.
 */

export const TAUTULLI_OPS = [
  "edit-user",
  "edit-library",
  "delete-history",
  "backup-db",
  "refresh-users",
  "refresh-libraries",
] as const;
type Op = (typeof TAUTULLI_OPS)[number];

interface RawUser {
  user_id?: number;
  friendly_name?: string;
  username?: string;
  keep_history?: number;
  allow_guest?: number;
}
interface RawLibrary {
  section_id?: number;
  section_name?: string;
  keep_history?: number;
}

const onOff = (b: boolean) => (b ? "on" : "off");
const MAX_ROWS = 50;
/** How far back a history deletion looks for the rows it names. */
const HISTORY_WINDOW = 2_000;

export class TautulliControl {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (call: <R>(cmd: string, p?: Record<string, string | number>) => Promise<R>) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) =>
        fn(<R>(cmd: string, p: Record<string, string | number> = {}) =>
          tautulliCmd<R>(this.fetchImpl, service.localUrl, value, cmd, p),
        ),
    );
  }

  private static body(params: StepParams | undefined) {
    try {
      return JSON.parse(String(params?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      throw new Error("body must be JSON.");
    }
  }

  private static rowIds(params: StepParams | undefined): number[] {
    const raw = String(params?.rowIds ?? TautulliControl.body(params).rowIds ?? "");
    const ids = [
      ...new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number),
      ),
    ];
    if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0))
      throw new Error("Say which history rows (their ids, comma separated).");
    if (ids.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} rows at a time.`);
    return ids;
  }

  private static async rows(
    call: <R>(cmd: string, p?: Record<string, string | number>) => Promise<R>,
    ids: number[],
  ) {
    const h = await call<{ data?: RawHistory[] }>("get_history", {
      start: 0,
      length: HISTORY_WINDOW,
      order_column: "date",
      order_dir: "desc",
    });
    return (h.data ?? []).map(historyRow).filter((r) => ids.includes(r.id));
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!TAUTULLI_OPS.includes(op)) throw new Error(`Say what to do: ${TAUTULLI_OPS.join(", ")}.`);
    const out = (
      label: string,
      p: Record<string, string>,
      settings: { name: string; before: string; after: string }[],
      note?: string,
    ): PlannedStep => ({
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...p },
      change: {
        summary: label,
        settings: [...settings, ...(note ? [{ name: "Note", before: "", after: note }] : [])],
      },
    });
    if (op === "backup-db")
      return out(`Back up Tautulli's database in ${service.name}`, {}, [
        { name: "Database", before: "as it is", after: "a new backup in Tautulli's backup folder" },
      ]);
    if (op === "refresh-users" || op === "refresh-libraries") {
      const what = op === "refresh-users" ? "people" : "libraries";
      return out(`Read the ${what} from Plex again in ${service.name}`, {}, [
        { name: `Tautulli's ${what}`, before: "as it is", after: "read from Plex again" },
      ]);
    }
    return this.use(service, `read Tautulli to plan ${op}`, "read", async (call) => {
      if (op === "edit-user") {
        const id = String(params?.userId ?? "");
        if (!/^\d+$/.test(id)) throw new Error("Say which person (their Tautulli user id).");
        const u = await call<RawUser>("get_user", { user_id: id });
        if (u.user_id === undefined) throw new Error("Tautulli does not know that person.");
        const b = TautulliControl.body(params);
        const now = {
          name: u.friendly_name || u.username || "",
          keep: u.keep_history !== 0,
          guest: u.allow_guest === 1,
        };
        const next = {
          name:
            b.friendlyName !== undefined ? String(b.friendlyName).trim().slice(0, 80) : now.name,
          keep: b.keepHistory !== undefined ? Boolean(b.keepHistory) : now.keep,
          guest: b.allowGuest !== undefined ? Boolean(b.allowGuest) : now.guest,
        };
        if (!next.name) throw new Error("A name cannot be empty.");
        const settings = [
          next.name !== now.name && { name: "Name", before: now.name, after: next.name },
          next.keep !== now.keep && {
            name: "Record their plays",
            before: onOff(now.keep),
            after: onOff(next.keep),
          },
          next.guest !== now.guest && {
            name: "Guest access to Tautulli",
            before: onOff(now.guest),
            after: onOff(next.guest),
          },
        ].filter(Boolean) as { name: string; before: string; after: string }[];
        if (!settings.length) throw new Error("Nothing would change.");
        return out(
          `Change ${now.name || "this person"} in ${service.name}`,
          {
            userId: id,
            name: now.name,
            body: JSON.stringify({
              friendlyName: next.name,
              keepHistory: next.keep,
              allowGuest: next.guest,
            }),
            from: JSON.stringify(now),
          },
          settings,
          !next.keep && now.keep
            ? "Their plays stop being recorded from now on; what is recorded stays."
            : next.guest && !now.guest
              ? "They can sign in to Tautulli as a guest and see their own history."
              : undefined,
        );
      }
      if (op === "edit-library") {
        const id = String(params?.libraryId ?? "");
        if (!/^\d+$/.test(id)) throw new Error("Say which library (its section id).");
        const l = await call<RawLibrary>("get_library", { section_id: id });
        if (l.section_id === undefined) throw new Error("Tautulli does not know that library.");
        const b = TautulliControl.body(params);
        const now = l.keep_history !== 0;
        const next = b.keepHistory !== undefined ? Boolean(b.keepHistory) : now;
        if (next === now) throw new Error("Nothing would change.");
        const name = l.section_name ?? `Library ${id}`;
        return out(
          `${next ? "Record" : "Stop recording"} plays from ${name} in ${service.name}`,
          { libraryId: id, name, body: JSON.stringify({ keepHistory: next }), from: onOff(now) },
          [{ name: `${name}: record plays`, before: onOff(now), after: onOff(next) }],
        );
      }
      // delete-history
      const ids = TautulliControl.rowIds(params);
      const found = await TautulliControl.rows(call, ids);
      const missing = ids.filter((i) => !found.some((r) => r.id === i));
      if (missing.length)
        throw new Error(
          `Tautulli has no recent play record ${missing.join(", ")} (only the latest ${HISTORY_WINDOW} are looked at).`,
        );
      const label =
        found.length === 1
          ? `Delete ${found[0]!.who}'s play of ${found[0]!.title} from ${service.name}`
          : `Delete ${found.length} play records from ${service.name}`;
      return out(
        label,
        { rowIds: ids.join(",") },
        found.slice(0, 10).map((r) => ({
          name: `${r.who}: ${r.title}`,
          before: r.at ? `played ${r.at.slice(0, 10)}` : "recorded",
          after: "deleted",
        })),
        "Cannot be undone. Plex's own watched state is not changed.",
      );
    });
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const outcome = await this.use(
      service,
      `${op} in Tautulli`,
      "change",
      async (call): Promise<StepOutcome> => {
        if (op === "backup-db") {
          const ok = await call<boolean>("backup_db");
          return ok
            ? { ok: true, result: "Tautulli made a backup of its database." }
            : { ok: false, result: "Tautulli did not make the backup." };
        }
        if (op === "refresh-users" || op === "refresh-libraries") {
          const what = op === "refresh-users" ? "people" : "libraries";
          const ok = await call<boolean>(
            op === "refresh-users" ? "refresh_users_list" : "refresh_libraries_list",
          );
          return ok
            ? { ok: true, result: `Tautulli read its ${what} from Plex again.` }
            : {
                ok: false,
                result: `Tautulli could not read its ${what} from Plex (its log says why).`,
              };
        }
        if (op === "edit-user") {
          const id = String(p.userId);
          const u = await call<RawUser>("get_user", { user_id: id });
          const now = {
            name: u.friendly_name || u.username || "",
            keep: u.keep_history !== 0,
            guest: u.allow_guest === 1,
          };
          if (JSON.stringify(now) !== String(p.from))
            return {
              ok: false,
              stale: true,
              result: `${now.name || "That person"} changed since this was planned. Nothing was changed; plan it again.`,
            };
          const b = JSON.parse(String(p.body)) as {
            friendlyName: string;
            keepHistory: boolean;
            allowGuest: boolean;
          };
          await call("edit_user", {
            user_id: id,
            // Tautulli ignores a name equal to the username; an empty one goes back to it.
            friendly_name: b.friendlyName === (u.username ?? "") ? "" : b.friendlyName,
            keep_history: b.keepHistory ? 1 : 0,
            allow_guest: b.allowGuest ? 1 : 0,
          });
          const after = await call<RawUser>("get_user", { user_id: id });
          const ok =
            (after.friendly_name || after.username) === b.friendlyName &&
            (after.keep_history !== 0) === b.keepHistory &&
            (after.allow_guest === 1) === b.allowGuest;
          return ok
            ? { ok: true, result: `${b.friendlyName} is changed in Tautulli (read back).` }
            : { ok: false, result: "Tautulli accepted, but does not read back the same." };
        }
        if (op === "edit-library") {
          const id = String(p.libraryId);
          const l = await call<RawLibrary>("get_library", { section_id: id });
          if (onOff(l.keep_history !== 0) !== String(p.from))
            return {
              ok: false,
              stale: true,
              result: `${String(p.name)} changed since this was planned. Nothing was changed.`,
            };
          const keep = (JSON.parse(String(p.body)) as { keepHistory: boolean }).keepHistory;
          await call("edit_library", { section_id: id, keep_history: keep ? 1 : 0 });
          const after = await call<RawLibrary>("get_library", { section_id: id });
          return (after.keep_history !== 0) === keep
            ? {
                ok: true,
                result: `${String(p.name)}: plays are ${keep ? "" : "not "}recorded (read back).`,
              }
            : { ok: false, result: "Tautulli accepted, but does not read back the same." };
        }
        // delete-history
        const ids = TautulliControl.rowIds(p);
        const there = await TautulliControl.rows(call, ids);
        if (!there.length)
          return { ok: true, stale: true, result: "Those play records were already gone." };
        await call("delete_history", { row_ids: there.map((r) => r.id).join(",") });
        const left = await TautulliControl.rows(call, ids);
        return left.length
          ? {
              ok: false,
              result: `Tautulli still lists ${left.length} of them after deleting.`,
            }
          : {
              ok: true,
              result: `Deleted ${there.length} play ${there.length === 1 ? "record" : "records"} from Tautulli (read back).`,
            };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
