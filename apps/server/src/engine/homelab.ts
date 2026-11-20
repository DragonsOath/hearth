import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as tables from "../db/schema";
import { getSetting } from "../store/settings";
import { CATALOG, identify, type CatalogEntry } from "../discovery/catalog";

/**
 * Homelab know-how for the Lair (10-30). Hearth used to make a "Homelab" project in the War
 * Room with a brief for the agent; the Lair is the homelab zone now, so that project is no longer
 * made (an existing one stays, archived, so its conversation can still be read). The Lair gets the
 * brief's knowledge (how a homelab fits together, where to look, common jobs) and the live
 * snapshot of the machines, never its house rules as extra limits: the Lair has its own approvals
 * and Full access. The owner's own additions to the old brief move to Settings > Ember > Homelab rules.
 */

export const HOMELAB_SLUG = "homelab";
export const HOMELAB_NAME = "Homelab";

export const HOMELAB_DESCRIPTION = `This homelab: the self-hosted apps, containers, drives, and machines on this computer and the others Hearth watches. Fix, maintain, upgrade, add to, and explain it.

## What this project is
The systems are the project. Work here is running the homelab: finding out why something broke and fixing it, keeping apps updated and healthy, adding new apps that fit in with the rest, tidying storage, and explaining how things work. This folder is your notebook for it: keep notes, scripts, and config backups here. There is usually no app to build in it.

## Where to look first
- \`.hearth/homelab.md\`: a live snapshot from Hearth, refreshed every few minutes: this machine, its apps with their addresses and health, the drives, and the other machines. Start there instead of guessing.
- Hearth's memory tools (briefing, recall, remember), when they are available: what was set up, fixed, and decided before, and how the owner likes things done.
- The real system: running containers, compose files, app logs, and each app's own settings and API. The snapshot and memory can be out of date; check the real thing before changing it.

## How a homelab usually fits together
Not every homelab has all of this. Check what is actually here.
- Requests: Seerr (Overseerr or Jellyseerr) sends requests to Sonarr (shows), Radarr (movies), Lidarr (music), or Readarr (books).
- Indexers: Prowlarr (or Jackett, with FlareSolverr) supplies the *arr apps with search sources.
- Downloads: SABnzbd or NZBGet for Usenet; qBittorrent, Transmission, or Deluge for torrents, often routed through a VPN container such as Gluetun.
- Imports: the *arr apps move or hardlink finished downloads into the library folders. Folder paths that differ between containers, and file permissions (PUID, PGID, owner), are the most common reasons an import gets stuck.
- Playback: Plex, Jellyfin, or Emby read the library. Tautulli watches activity, Bazarr fetches subtitles, Kometa builds collections.
- Getting in: a reverse proxy (Caddy, Nginx Proxy Manager, Traefik, SWAG), a tunnel or VPN (Tailscale, WireGuard, Cloudflare Tunnel), a login layer (Authelia, Authentik, Tinyauth), and DNS or ad blocking (Pi-hole, AdGuard Home).
- Everything else: Home Assistant, Immich, Nextcloud, Paperless-ngx, Vaultwarden, Uptime Kuma, backups, and container managers like Portainer or Dockge.

## Common jobs
- Something will not download, import, or show up: follow the chain from the request, to the *arr queue and history, to the download client, to the import (paths, permissions, free space), to the library folder, to the media server's library scan.
- A container will not start or keeps restarting: read its logs first, then its compose file (ports, volumes, environment, PUID and PGID), then free space and permissions.
- Updates: check the current version and the release notes for breaking changes, back up the app's config, update one app at a time, and confirm it came back healthy.
- Adding an app: copy the conventions already used here (where compose files live, networks, PUID and PGID, time zone, folder layout, how the proxy is set up) and say what you will add before adding it.
- Explaining: many owners are learning as they go. Say what you found and why it matters in plain words, without jargon.

## House rules
- Look before you change anything: read the real config and state first.
- Before changing a running service, say what you will change and why. Keep each change small and easy to undo, and copy any config file you edit into this project's \`backups/\` folder with the date first.
- Media, photos, and documents cannot be replaced. Never delete, move, rename, or change the permissions of them, or run anything that could, unless the owner asked for exactly that in this conversation.
- Never format, partition, wipe, or remount drives, or change RAID or the mount table, unless the owner asks for it directly.
- Networking, VPN, reverse proxy, firewall, DNS, and remote access are how the owner reaches everything. A mistake there can lock them out, so explain first and always keep a way back.
- Never show, paste, or save passwords, API keys, or tokens, in replies, files, or memory. When a command needs one, read it into a variable without printing it.
- Stopping, restarting, or updating Hearth ends this conversation. When the owner asks for it, say so first, then do it.
- Prefer each app's own settings or API over editing its database files.
- Do things for the owner instead of handing them steps. A change Hearth can plan (Hearth's own settings and systems, an app through its panel or API) is proposed as a plan right away: its Approve button is the confirmation, so do not ask in chat whether to propose it. Only Hearth's sign-in, the vault, your own permissions and Hearth updates are the owner's alone.
- With Full access off, shell commands that change things (docker, sudo, systemctl, deleting) ask the owner in the War Room first; if one is refused, skip it, finish the rest, and say what was skipped. With Full access on, they run.

## When you finish
- Check that it worked (status, logs, the app's own page) and say what you checked.
- Save fixes, decisions, and unfinished work to Hearth's memory when the tools are available, and add a line to \`NOTES.md\` in this folder.
- Reply briefly in plain words: what was wrong, what you changed, how you checked it, and anything the owner needs to do.`;

const NL = "\n";

/** One section of the brief ("## Common jobs" and what follows, up to the next heading). */
function briefSection(title: string): string {
  const part = HOMELAB_DESCRIPTION.split(NL + "## ").find((x) => x.startsWith(title));
  return part ? `## ${part.trim()}` : "";
}

/**
 * What the Lair knows about homelabs in general: the brief's knowledge, without its house rules.
 * Where to look first is written for the Lair (its notebook folder holds the snapshot).
 */
export const HOMELAB_KNOWHOW = [
  `## Where to look first
- The live snapshot of the machines below (refreshed every few minutes by Hearth): this machine, its apps with their addresses and health, the drives, and the other machines. Start there instead of guessing.
- Hearth's memory and tools: what was set up, fixed, and decided before, and how the owner likes things done.
- The real system: running containers, compose files, app logs, and each app's own settings and API. The snapshot and memory can be out of date; check the real thing before changing it.`,
  briefSection("How a homelab usually fits together"),
  briefSection("Common jobs"),
]
  .filter(Boolean)
  .join(NL + NL);

/** Lines Hearth itself wrote into the old Homelab brief, in any version (they were never the owner's). */
const OUR_LINES = new Set(
  [
    ...HOMELAB_DESCRIPTION.split(NL),
    "- Do not stop, reconfigure, or update Hearth from here: it runs this conversation.",
    "- Commands that change things (docker, sudo, systemctl, deleting) ask the owner in the War Room first. If one is refused, skip it, finish the rest, and say what was skipped.",
  ].map((l) => l.trim()),
);

/**
 * What the owner added to the old Homelab project's brief, word for word: every line Hearth did
 * not write. Empty when they never changed it. These become their own rules for Ember.
 */
export function ownerHomelabRules(description: string): string {
  return description
    .split(NL)
    .filter((l) => l.trim() && !OUR_LINES.has(l.trim()))
    .join(NL)
    .trim();
}

/** The catalog entry a service is, from its image, its native process, or its name. */
export function serviceApp(s: {
  name: string;
  image: string | null;
  checkTarget: string | null;
}): CatalogEntry | undefined {
  const byImage = s.image ? identify(s.image) : undefined;
  if (byImage) return byImage;
  const target = s.checkTarget?.startsWith("process:") ? s.checkTarget.slice(8) : undefined;
  const lower = s.name.trim().toLowerCase();
  return CATALOG.find((c) => c.id === target || c.name.toLowerCase() === lower);
}

interface Snapshot {
  /** Homelab apps found on this machine (none means it is not a homelab, yet). */
  apps: string[];
  /** The live snapshot written into the project for the agent. */
  markdown: string;
}

const gb = (tb: number) => (tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(tb * 1024)} GB`);

/** What Hearth knows about this machine and the rest of the homelab, for the agent. */
export async function homelabSnapshot(
  handle: DbHandle,
  now: () => Date = () => new Date(),
  /** The account's other PCs, one Markdown line each (engine.accountPcs). */
  accountPcs: string[] = [],
): Promise<Snapshot> {
  // Only your real systems: sample data (a fresh install shows it until you scan) is made up, so
  // it never makes a Homelab project or reaches the agent as if it were this machine (10-27).
  if ((await getSetting(handle.db, "environment")) !== "real") return { apps: [], markdown: "" };
  const hosts = await handle.db.select().from(tables.hosts).orderBy(tables.hosts.sort);
  const services = (await handle.db.select().from(tables.services)).filter(
    (s) => s.lifecycle === "active" || s.lifecycle === "paused",
  );
  const here = hosts.find((h) => h.connection === "this-machine");
  if (!here) return { apps: [], markdown: "" };
  const mine = services.filter((s) => s.hostId === here.id);
  const apps = mine
    .map((s) => ({ s, app: serviceApp(s) }))
    .filter((x) => x.app && !x.app.supporting)
    .map((x) => x.app!.name);
  const volumes = await handle.db
    .select()
    .from(tables.volumes)
    .where(eq(tables.volumes.hostId, here.id))
    .orderBy(tables.volumes.sort);

  const appLine = (s: (typeof services)[number]) => {
    const where = [
      s.kind === "container" && s.checkTarget?.startsWith("container:")
        ? `container \`${s.checkTarget.slice(10)}\``
        : s.kind === "process"
          ? "installed program"
          : s.kind,
      s.image ? `image \`${s.image}\`` : "",
      s.version ? `version ${s.version}` : "",
      s.localUrl ? `local ${s.localUrl}` : "",
      s.publicUrl ? `public ${s.publicUrl}` : "",
    ].filter(Boolean);
    const state = s.lifecycle === "paused" ? "paused" : s.health;
    return `- **${s.name}** (${s.category}, ${state}): ${where.join(", ")}`;
  };

  const lines = [
    "# Homelab snapshot",
    "",
    `Written by Hearth at ${now().toISOString().slice(0, 16).replace("T", " ")} UTC (refreshed every few minutes). ` +
      "It is what Hearth's monitoring shows; check the real system before changing anything.",
    "",
    `## This machine: ${here.name}`,
    "",
    `- ${here.os}, ${here.cpuCores} cores (${here.cpuModel}), address ${here.address}`,
    `- Docker: ${here.docker ? "yes" : "not found"}. Health: ${here.health}.`,
    `- Shell: ${/windows/i.test(here.os) ? "Windows (PowerShell; Docker Desktop if Docker is used)" : "Linux or macOS (bash)"}.`,
    "",
    "### Apps on this machine",
    "",
    ...(mine.length ? mine.map(appLine) : ["_none added to Hearth yet_"]),
    "",
    "### Drives",
    "",
    ...(volumes.length
      ? volumes.map(
          (v) =>
            `- \`${v.mount}\` ${v.label} (${v.kind}): ${gb(v.totalTb - v.usedTb)} free of ${gb(v.totalTb)}` +
            (v.smart === "warning" ? ", **drive health warning**" : ""),
        )
      : ["_none listed_"]),
  ];
  const others = hosts.filter((h) => h.id !== here.id);
  if (others.length) {
    lines.push("", "## Other machines Hearth watches", "");
    for (const h of others) {
      const theirs = services.filter((s) => s.hostId === h.id).map((s) => s.name);
      lines.push(
        `- **${h.name}** (${h.os}, ${h.address}, ${h.health})` +
          (theirs.length ? `: ${theirs.join(", ")}` : ""),
      );
    }
  }
  if (accountPcs?.length)
    lines.push("", "## Your other PCs (same Hearth account)", "", ...accountPcs);
  return { apps, markdown: lines.join("\n") + "\n" };
}

/**
 * One check: refreshes the live snapshot of the homelab for the Lair (and for the old Homelab
 * project, when one is kept). It no longer makes a War Room project.
 */
export async function homelabTick(
  handle: DbHandle,
  projects: { homelabNotes: string; writeLairSnapshot?(): void },
  accountPcs?: () => Promise<string[]>,
): Promise<void> {
  const others = accountPcs ? await accountPcs().catch(() => []) : [];
  const snap = await homelabSnapshot(handle, undefined, others);
  projects.homelabNotes = snap.markdown;
  projects.writeLairSnapshot?.();
}
