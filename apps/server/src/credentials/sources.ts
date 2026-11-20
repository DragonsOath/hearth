import type { CredentialScope } from "@dragon-control/core";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { AppKind } from "@dragon-control/core";
import type { ContainerTools } from "../actions/tools";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { ConflictError, NotFoundError } from "../store/errors";
import { appOf } from "../apps/service";

/**
 * Credentials that already exist outside the vault, in an app's own settings
 * file on this machine. Detection only checks that the file is there (by the
 * container's /config mount); it never opens it. Importing reads that one
 * file, takes the one value, and stores it straight in the vault: only when
 * you ask, after confirming it is you, audited without the value. Nothing
 * is ever imported on its own, and the value is never returned or shown.
 */

interface SourceDef {
  file: string;
  what: string;
  parse(text: string): string | undefined;
  /** Where the container mounts its settings folder (default /config). */
  mounts?: string[];
}

const ARR: SourceDef = {
  file: "config.xml",
  what: "API key",
  parse: (text) => /<ApiKey>\s*([A-Za-z0-9]{20,64})\s*<\/ApiKey>/i.exec(text)?.[1],
};

/** Where each app keeps its own key. qBittorrent stores its password hashed: it cannot be imported. */
const SOURCES: Partial<Record<AppKind, SourceDef>> = {
  prowlarr: ARR,
  radarr: ARR,
  sonarr: ARR,
  lidarr: ARR,
  chaptarr: ARR,
  bazarr: {
    file: "config/config.yaml",
    what: "API key",
    // The key under "auth:" (Bazarr's settings file is YAML).
    parse: (text) => {
      // The "apikey:" line inside the "auth:" block (indented under it).
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((l) => /^auth:\s*$/.test(l));
      if (start < 0) return undefined;
      for (const l of lines.slice(start + 1)) {
        if (!/^\s/.test(l)) break;
        const m = /^\s+apikey:\s*['"]?([A-Za-z0-9]{20,64})['"]?\s*$/.exec(l);
        if (m) return m[1];
      }
      return undefined;
    },
  },
  tautulli: {
    file: "config.ini",
    what: "API key",
    parse: (text) => /^\s*api_key\s*=\s*([A-Za-z0-9]{16,64})\s*$/m.exec(text)?.[1],
  },
  seerr: {
    file: "settings.json",
    what: "API key",
    mounts: ["/app/config", "/config"],
    parse: (text) => {
      try {
        const key = (JSON.parse(text) as { main?: { apiKey?: unknown } }).main?.apiKey;
        return typeof key === "string" && /^[A-Za-z0-9+/=_-]{20,128}$/.test(key) ? key : undefined;
      } catch {
        return undefined;
      }
    },
  },
  syncthing: {
    file: "config.xml",
    what: "API key",
    mounts: ["/var/syncthing/config", "/config"],
    parse: (text) => /<apikey>\s*([A-Za-z0-9_-]{16,64})\s*<\/apikey>/i.exec(text)?.[1],
  },
  plex: {
    // Plex's own server token (the one the server signs in to plex.tv with), in its preferences.
    file: "Library/Application Support/Plex Media Server/Preferences.xml",
    what: "token",
    parse: (text) => /\bPlexOnlineToken="([A-Za-z0-9_-]{16,64})"/.exec(text)?.[1],
  },
  sabnzbd: {
    file: "sabnzbd.ini",
    what: "API key",
    parse: (text) => /^\s*api_key\s*=\s*([A-Za-z0-9]{16,64})\s*$/m.exec(text)?.[1],
  },
};

/** The key in an app's settings file text, as an import would read it (for tests). */
export function keyIn(app: AppKind, text: string): string | undefined {
  return SOURCES[app]?.parse(text);
}

/** Where an app keeps its own key (file and settings mount), for checks that never open it. */
export function settingsFileFor(app: AppKind): { file: string; mounts: string[] } | undefined {
  const def = SOURCES[app];
  return def ? { file: def.file, mounts: def.mounts ?? ["/config"] } : undefined;
}

const MAX_FILE = 2 * 1024 * 1024;

type ServiceRow = typeof t.services.$inferSelect;

export class CredentialSources {
  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
    private readonly containers: ContainerTools,
  ) {}

  /** The settings file a service's key lives in, when this machine can read it. */
  private async locate(service: ServiceRow): Promise<{ file: string; def: SourceDef } | undefined> {
    const app = appOf(service);
    const def = app ? SOURCES[app] : undefined;
    const container = service.checkTarget?.startsWith("container:")
      ? service.checkTarget.slice("container:".length)
      : undefined;
    if (!def || !container) return undefined;
    const host = await this.handle.db
      .select()
      .from(t.hosts)
      .where(eq(t.hosts.id, service.hostId))
      .get();
    if (host?.connection !== "this-machine") return undefined;
    const mounts = await this.containers.mounts(container).catch(() => []);
    const config = (def.mounts ?? ["/config"])
      .map((d) => mounts.find((m) => m.destination === d))
      .find(Boolean);
    if (!config) return undefined;
    const file = path.join(config.source, def.file);
    try {
      // The app's own file only: a link could point anywhere on this machine.
      if (!(await lstat(file)).isFile()) return undefined;
      await access(file, constants.R_OK);
      return { file, def };
    } catch {
      return undefined;
    }
  }

  /** Offered imports for a service: descriptions only. */
  async detect(service: ServiceRow): Promise<{ id: string; description: string }[]> {
    const found = await this.locate(service);
    return found
      ? [
          {
            id: "app-settings-file",
            description: `${service.name}'s own settings file on this machine (${found.file}) holds its ${found.def.what}.`,
          },
        ]
      : [];
  }

  /** Imports the key from the app's settings file into the vault. Caller has checked you confirmed it is you. */
  async import(
    serviceId: string,
    sourceId: string,
    /** What Hearth may use it for; the vault's default when left out. */
    scope?: CredentialScope,
  ): Promise<{ secretId: string; name: string }> {
    const service = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    if (!service) throw new NotFoundError("No such service.");
    if (sourceId !== "app-settings-file") throw new NotFoundError("No such source.");
    const found = await this.locate(service);
    if (!found)
      throw new ConflictError(
        `Hearth cannot find ${service.name}'s settings file on this machine.`,
      );
    const info = await stat(found.file);
    if (info.size > MAX_FILE)
      throw new ConflictError("That settings file is larger than expected; nothing was imported.");
    const value = found.def.parse(await readFile(found.file, "utf8"));
    if (!value) {
      throw new ConflictError(
        `No ${found.def.what} was found in ${service.name}'s settings file; nothing was imported.`,
      );
    }
    const name = `${service.name} ${found.def.what}`;
    const secret = await this.vault.add({
      name,
      kind: "api-key",
      tier: "automation",
      serviceId: service.id,
      value,
      ...(scope ? { scope } : {}),
      source: `imported from ${found.file}`,
    });
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Imported ${service.name}'s ${found.def.what} into the vault from its settings file`,
      target: `secret:${secret.id}`,
      detail: { file: found.file },
    });
    return { secretId: secret.id, name };
  }
}
