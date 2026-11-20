import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as t from "../../db/schema";
import type { ContainerTools } from "../../actions/tools";
import { appOf } from "../../apps/service";
import { settingsFileFor } from "../../credentials/sources";
import type { FindingDraft } from "../store";
import { HOUR, plural, type Analyzer } from "./types";

/**
 * Security posture, from file metadata only (never contents): app settings files that hold an
 * API key, and backup copies of them, that every account on this machine can read. Grouped
 * into one finding, since the fix is one decision. Hearth cannot change file permissions
 * itself; the finding says so.
 */

const WORLD_READABLE = 0o004;

export function securityAnalyzer(containers: ContainerTools): Analyzer {
  return {
    id: "security.credential-files",
    source: "security",
    label: "Security posture",
    intervalMs: 6 * HOUR,
    async run({ handle, environment }) {
      if (environment !== "real" || process.platform === "win32") {
        return {
          status: "off",
          note: "Checks file permissions on a Linux machine Hearth runs on.",
          drafts: [],
          covered: () => false,
        };
      }
      const db = handle.db;
      const host = (await db.select().from(t.hosts)).find((h) => h.connection === "this-machine");
      const services = (
        await db.select().from(t.services).where(eq(t.services.lifecycle, "active"))
      ).filter((s) => s.hostId === host?.id && s.checkTarget?.startsWith("container:"));
      const exposed: { service: string; file: string; backups: string[] }[] = [];
      let checked = 0;
      let unknown = 0;
      for (const s of services) {
        const app = appOf(s);
        const def = app ? settingsFileFor(app) : undefined;
        if (!def) continue;
        const mounts = await containers
          .mounts(s.checkTarget!.slice("container:".length))
          .catch(() => []);
        const source = def.mounts
          .map((d) => mounts.find((m) => m.destination === d))
          .find(Boolean)?.source;
        if (!source) continue;
        const file = path.join(source, def.file);
        try {
          const info = await stat(file);
          checked++;
          const backups: string[] = [];
          const dir = path.dirname(file);
          const base = path.basename(file);
          for (const name of await readdir(dir).catch(() => [] as string[])) {
            if (name === base || !name.startsWith(base) || !/\.(bak|old|orig|backup)/i.test(name))
              continue;
            const b = await stat(path.join(dir, name)).catch(() => undefined);
            if (b?.isFile() && b.mode & WORLD_READABLE) backups.push(path.join(dir, name));
          }
          if (info.mode & WORLD_READABLE || backups.length)
            exposed.push({ service: s.name, file, backups });
        } catch {
          // Hearth cannot even see it: not readable by everyone, as far as it can tell.
          unknown++;
        }
      }
      const drafts: FindingDraft[] = [];
      if (exposed.length) {
        const backupCount = exposed.reduce((n, e) => n + e.backups.length, 0);
        drafts.push({
          key: "security:world-readable-keys",
          kind: "recommendation",
          nature: "risk",
          // Which files: accepting these does not hide a newly exposed one.
          signature: exposed
            .flatMap((e) => [e.file, ...e.backups])
            .sort()
            .join("|"),
          severity: "medium",
          title: `${plural(exposed.length, "app keeps its", "apps keep their")} API key in a file every account can read`,
          summary: `${exposed.map((e) => e.service).join(", ")}: the settings file holding the key is readable by every account on this machine${backupCount ? `, and so ${backupCount === 1 ? "is 1 backup copy" : `are ${backupCount} backup copies`} of them` : ""}.`,
          why: "Only you and the apps need these keys. If any other account on this machine is compromised, it could read them and control those apps.",
          nextSteps: [
            "Restrict the files so only their owner (and Hearth, read-only) can read them. Check first which account each app runs as.",
            "Hearth cannot change file permissions itself; this is a change you make or approve.",
          ],
          evidence: exposed
            .slice(0, 12)
            .flatMap((e) => [
              { label: e.service, value: e.file },
              ...e.backups
                .slice(0, 2)
                .map((b) => ({ label: `${e.service} (backup copy)`, value: b })),
            ]),
          resources: exposed.slice(0, 12).map((e) => ({ kind: "path" as const, name: e.file })),
          ...(host ? { hostId: host.id } : {}),
        });
      }
      return {
        status: unknown && !checked ? "partial" : "ok",
        note: `Checked ${plural(checked, "settings file")} holding API keys${unknown ? `; ${unknown} not visible to Hearth` : ""}.`,
        drafts,
        covered: (key) => key.startsWith("security:"),
      };
    },
  };
}
