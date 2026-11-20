import path from "node:path";
import type {
  BlueprintApp,
  BlueprintFact,
  BlueprintFacts,
  BlueprintMount,
  BlueprintVaultEntry,
} from "@dragon-control/core";
import { sanitizeConfig, type InspectForConfig } from "../actions/container-config";
import { maskSecrets } from "../admin/files";

/**
 * The Lab Blueprint's facts, gathered mechanically (no AI in it): Docker's own description of each
 * container (environment values never read), its compose files with every value that could be a
 * secret hidden, the machine, the networks, Hearth's connections and the vault's index (names
 * only). Every fact says where it came from; what can't be read is listed, never guessed.
 */

export interface AssembleSource {
  containers(): Promise<{ name: string; state: string; inspect: InspectForConfig }[]>;
  networks(): Promise<{ name: string; driver: string; subnet?: string; containers: string[] }[]>;
  host(): Promise<{
    name: string;
    os: string;
    hearthVersion: string;
    mounts: { source: string; target: string; fsType: string }[];
    interfaces: { name: string; address: string }[];
  }>;
  services(): Promise<{ id: string; name: string; localUrl?: string | null; app?: string }[]>;
  vault(): Promise<
    { name: string; kind: string; tier: "automation" | "protected"; serviceId?: string }[]
  >;
  readFile(file: string): Promise<string | undefined>;
  exists(file: string): Promise<boolean>;
  notes(): Promise<string>;
  now(): Date;
}

/** Environment settings that are never secrets, so the blueprint may show their values. */
const SAFE_ENV = new Set(["PUID", "PGID", "TZ", "UMASK", "UMASK_SET", "LANG", "LC_ALL"]);

/** A value that only points at something defined elsewhere (${VAR}, a file). */
const REFERENCE = /^["']?\$\{?[A-Za-z_]/;

/** Long random-looking strings (keys, tokens, hashes) anywhere in a line. */
const TOKEN =
  /(?<![A-Za-z0-9/._:@-])(?=[A-Za-z0-9+_=-]*[0-9])(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{24,}(?![A-Za-z0-9/._:@-])/g;

/**
 * A compose file as the blueprint may show it: every environment value hidden except the few that
 * are never secrets, secret-looking keys hidden, and long random-looking strings hidden. It errs on
 * the side of hiding; the vault scan before encrypting is the last check on top.
 */
export function maskCompose(text: string): string {
  const env = text
    .split("\n")
    .map((line) => {
      // - KEY=value, - "KEY=value", KEY=value (env lists and .env-style lines)
      const list = /^(\s*-?\s*["']?)([A-Z][A-Z0-9_]*)=(.*?)(["']?\s*)$/.exec(line);
      if (list) {
        const [, pre, key, value, post] = list;
        if (!value!.trim() || SAFE_ENV.has(key!) || REFERENCE.test(value!)) return line;
        return `${pre}${key}=<hidden>${post}`;
      }
      // KEY: value (an environment map; only names in capitals, as environment names are)
      const map = /^(\s*)([A-Z][A-Z0-9_]*)(\s*:\s*)(.+)$/.exec(line);
      if (map) {
        const [, pre, key, sep, value] = map;
        if (SAFE_ENV.has(key!) || REFERENCE.test(value!.trim())) return line;
        return `${pre}${key}${sep}<hidden>`;
      }
      return line;
    })
    .join("\n");
  return maskSecrets(env, "yaml")
    .replace(TOKEN, "<hidden>")
    .replace(/<masked>|\[hidden\]/g, "<hidden>");
}

/** Every vault value that appears in the text (only names come back, never the value). */
export function scanForSecrets(text: string, secrets: { name: string; value: string }[]): string[] {
  return secrets
    .filter((s) => s.value.trim().length >= 6 && text.includes(s.value.trim()))
    .map((s) => s.name);
}

const MEDIA =
  /\b(movies?|tv|shows?|series|music|books?|audiobooks?|comics|photos?|pictures|media|downloads?|torrents?|usenet|library)\b/i;

function holds(source: string, destination: string): BlueprintMount["holds"] {
  if (MEDIA.test(destination) || MEDIA.test(path.basename(source))) return "media or downloads";
  if (
    /^\/(var\/run|run|dev|sys|proc|etc)\b|docker\.sock|\.(conf|ya?ml|json|toml|env)$/i.test(source)
  )
    return "a file or folder from the machine";
  return "settings and data";
}

/** Where an app keeps its own backups, from its image (checked on disk when the folder maps here). */
const OWN_BACKUPS: { match: RegExp; inside: string; how: string }[] = [
  {
    match: /sonarr|radarr|lidarr|readarr|prowlarr|whisparr|chaptarr/i,
    inside: "/config/Backups",
    how: "The app's own scheduled backup (System, Backup). Restore it from there, or through its API as a plan.",
  },
  {
    match: /plex/i,
    inside: "/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases",
    how: "Plex's own database backups (Settings, Scheduled Tasks). Restore by putting a dated copy back in place of the database.",
  },
  {
    match: /home-?assistant/i,
    inside: "/config/backups",
    how: "Home Assistant's own backups (Settings, System, Backups). Restore from there.",
  },
  {
    match: /bazarr/i,
    inside: "/config/backup",
    how: "Bazarr's own backups (System, Backups).",
  },
];

/** Groups in install order; an app also goes after anything it depends on. */
const TIERS: RegExp[] = [
  /gluetun|wireguard|openvpn|vpn|tailscale/i,
  /postgres|mariadb|mysql|redis|valkey|mongo/i,
  /caddy|traefik|nginx|proxy-manager|authelia|authentik|tinyauth/i,
  /qbittorrent|sabnzbd|nzbget|transmission|deluge|prowlarr|jackett|flaresolverr/i,
  /sonarr|radarr|lidarr|readarr|chaptarr|bazarr|whisparr|recyclarr/i,
  /plex|jellyfin|emby|audiobookshelf|kavita|komga|navidrome|immich/i,
];

export function installOrder(apps: BlueprintApp[]): string[][] {
  const tier = new Map<string, number>();
  for (const a of apps) {
    const t = TIERS.findIndex((re) => re.test(a.image) || re.test(a.name));
    tier.set(a.name, t < 0 ? TIERS.length : t);
  }
  // Anything an app depends on comes in an earlier group (a few passes settle chains).
  for (let pass = 0; pass < 4; pass++)
    for (const a of apps)
      for (const d of a.dependsOn)
        if (tier.has(d) && tier.get(d)! >= tier.get(a.name)!) tier.set(a.name, tier.get(d)! + 1);
  const groups: string[][] = [];
  for (const [name, t] of tier) (groups[t] ??= []).push(name);
  return groups.filter(Boolean).map((g) => g.sort((x, y) => x.localeCompare(y)));
}

function dependsOn(
  inspect: InspectForConfig,
  byService: Map<string, string>,
  byId: Map<string, string>,
) {
  const out = new Set<string>();
  const label = inspect.Config?.Labels?.["com.docker.compose.depends_on"];
  for (const part of (label ?? "").split(",")) {
    const svc = part.split(":")[0]?.trim();
    if (svc && byService.has(svc)) out.add(byService.get(svc)!);
  }
  const mode = inspect.HostConfig?.NetworkMode ?? "";
  const m = /^(container|service):(.+)$/.exec(mode);
  if (m) {
    const other = byId.get(m[2]!) ?? byService.get(m[2]!) ?? byId.get(m[2]!.slice(0, 12));
    if (other) out.add(other);
  }
  return [...out].sort();
}

export async function assemble(src: AssembleSource): Promise<BlueprintFacts> {
  const gaps: string[] = [];
  const when = src.now().toISOString();
  const host = await src.host();
  const hostFacts: BlueprintFact[] = [
    { label: "Machine", value: host.name, source: "the operating system", verified: true },
    { label: "Operating system", value: host.os, source: "the operating system", verified: true },
    { label: "Hearth", value: host.hearthVersion, source: "Hearth itself", verified: true },
    ...host.mounts.map((m) => ({
      label: `Drive at ${m.target}`,
      value: `${m.source} (${m.fsType})`,
      source: "the machine's mount table",
      verified: true,
    })),
    ...host.interfaces.map((i) => ({
      label: `Network ${i.name}`,
      value: i.address,
      source: "the operating system",
      verified: true,
    })),
  ];

  let containers: Awaited<ReturnType<AssembleSource["containers"]>> = [];
  try {
    containers = await src.containers();
  } catch (e) {
    gaps.push(`Docker could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const services = await src.services().catch(() => []);
  const vaultIndex = await src.vault().catch(() => {
    gaps.push("The vault's index could not be read.");
    return [];
  });
  const serviceName = new Map(services.map((s) => [s.id, s.name]));

  const byService = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const c of containers) {
    const svc = c.inspect.Config?.Labels?.["com.docker.compose.service"];
    if (svc) byService.set(svc, c.name);
    const id = (c.inspect as { Id?: string }).Id;
    if (id) {
      byId.set(id, c.name);
      byId.set(id.slice(0, 12), c.name);
    }
    byId.set(c.name, c.name);
  }

  const composeFiles = new Map<string, string>();
  const apps: BlueprintApp[] = [];
  for (const c of containers) {
    const cfg = sanitizeConfig(c.inspect);
    const labels = c.inspect.Config?.Labels ?? {};
    const files = (labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const f of files) {
      if (composeFiles.has(f)) continue;
      const text = await src.readFile(f).catch(() => undefined);
      if (text === undefined) gaps.push(`${f} (${c.name}'s compose file) could not be read.`);
      else composeFiles.set(f, maskCompose(text));
    }
    const hearth = services.find(
      (s) => s.name.toLowerCase() === c.name.toLowerCase() || s.id === c.name,
    );
    const mounts: BlueprintMount[] = cfg.mounts.map((m) => ({
      source: m.source,
      destination: m.destination,
      holds: holds(m.source, m.destination),
      readOnly: m.readOnly,
    }));
    let ownBackup: BlueprintFact | undefined;
    const known = OWN_BACKUPS.find((b) => b.match.test(cfg.image) || b.match.test(c.name));
    if (known) {
      const top = known.inside.split("/").slice(0, 2).join("/");
      const mount = cfg.mounts.find((m) => m.destination === top);
      const onHost = mount
        ? path.posix.join(mount.source, known.inside.slice(top.length))
        : undefined;
      const there = onHost ? await src.exists(onHost).catch(() => false) : false;
      ownBackup = {
        label: "Its own backups",
        value: `${onHost ?? known.inside}. ${known.how}`,
        source: onHost ? "the folder on this machine" : "where this app keeps them",
        verified: there,
        ...(there
          ? {}
          : {
              why: onHost
                ? "No backup folder there yet: its own backups may be off."
                : `Its ${top} folder isn't mapped to this machine.`,
            }),
      };
    }
    apps.push({
      name: c.name,
      image: cfg.image,
      ...(labels["org.opencontainers.image.version"]
        ? { version: labels["org.opencontainers.image.version"] }
        : {}),
      state: c.state,
      ...(cfg.composeProject ? { composeProject: cfg.composeProject } : {}),
      ...(cfg.composeService ? { composeService: cfg.composeService } : {}),
      composeFiles: files,
      ports: cfg.ports,
      mounts,
      networks: cfg.networks,
      ...(cfg.networkMode ? { networkMode: cfg.networkMode } : {}),
      restartPolicy: cfg.restartPolicy,
      dependsOn: dependsOn(c.inspect, byService, byId).filter((d) => d !== c.name),
      hiddenSettings: cfg.environmentNames.filter((n) => !SAFE_ENV.has(n)),
      vault: vaultIndex
        .filter((v) => v.serviceId && hearth && v.serviceId === hearth.id)
        .map((v) => v.name),
      ...(ownBackup ? { ownBackup } : {}),
      ...(hearth ? { hearthName: hearth.name } : {}),
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));

  const networks = await src.networks().catch(() => {
    gaps.push("Docker's networks could not be read.");
    return [];
  });
  const vault: BlueprintVaultEntry[] = vaultIndex.map((v) => ({
    name: v.name,
    kind: v.kind,
    tier: v.tier,
    ...(v.serviceId && serviceName.get(v.serviceId)
      ? { service: serviceName.get(v.serviceId)! }
      : {}),
  }));
  const facts: BlueprintFacts = {
    format: "hearth-blueprint/1",
    writtenAt: when,
    host: hostFacts,
    apps,
    networks: networks
      .filter((n) => !["bridge", "host", "none"].includes(n.name))
      .map((n) => ({
        name: n.name,
        driver: n.driver,
        ...(n.subnet ? { subnet: n.subnet } : {}),
        apps: [...n.containers].sort(),
      })),
    connections: services.map((s) => ({
      name: s.name,
      ...(s.app ? { app: s.app } : {}),
      ...(s.localUrl ? { address: s.localUrl } : {}),
    })),
    vault,
    installOrder: installOrder(apps),
    notes: (await src.notes().catch(() => "")).trim(),
    compose: Object.fromEntries(composeFiles),
    gaps,
  };
  return facts;
}

const fact = (f: BlueprintFact) =>
  `- **${f.label}:** ${f.value} _(${f.verified ? `verified: ${f.source}` : `unverified: ${f.why ?? f.source}`})_`;

/** The blueprint as a stranger reads it: a fresh Ember on a new machine, with nothing else. */
export function writeMarkdown(facts: BlueprintFacts): string {
  const compose = facts.compose;
  const name = facts.host.find((h) => h.label === "Machine")?.value ?? "this machine";
  const L: string[] = [
    `# Lab blueprint: ${name}`,
    "",
    `Written ${facts.writtenAt} by Hearth, from what it read on the machine. Each fact says where it came from; **unverified** means it could not be confirmed, with why.`,
    "",
    "No secret is written here. Where a password, key or token is needed, this names the vault entry that holds it; entries listed under Credential gaps are not in the vault and must be found again. App data (watch history, users, libraries) is not in this blueprint: each app's own backups are named under that app.",
    "",
    "## The machine",
    "",
    ...facts.host.map(fact),
    "",
    "## Install order (derived)",
    "",
    "Derived from what each app is and what it depends on: bring each group up before the next.",
    "",
    ...facts.installOrder.map((g, i) => `${i + 1}. ${g.join(", ")}`),
    "",
    "## Apps",
  ];
  for (const a of facts.apps) {
    L.push(
      "",
      `### ${a.name}${a.hearthName && a.hearthName !== a.name ? ` (Hearth: ${a.hearthName})` : ""}`,
      "",
      `- **Image:** ${a.image}${a.version ? ` (version ${a.version})` : ""}, ${a.state} _(verified: Docker)_`,
    );
    if (a.composeFiles.length)
      L.push(
        `- **Compose:** project ${a.composeProject ?? "?"}, service ${a.composeService ?? "?"}, file ${a.composeFiles.join(", ")} _(verified: Docker's labels)_`,
      );
    if (a.ports.length) L.push(`- **Ports:** ${a.ports.join(", ")} _(verified: Docker)_`);
    for (const m of a.mounts)
      L.push(
        `- **Folder:** ${m.source} → ${m.destination}, holds ${m.holds}${m.readOnly ? ", read only" : ""} _(verified: Docker)_`,
      );
    if (a.networkMode && !["bridge", "default"].includes(a.networkMode))
      L.push(`- **Network mode:** ${a.networkMode} _(verified: Docker)_`);
    if (a.networks.length) L.push(`- **Networks:** ${a.networks.join(", ")} _(verified: Docker)_`);
    if (a.dependsOn.length)
      L.push(`- **Needs first:** ${a.dependsOn.join(", ")} _(verified: Docker)_`);
    L.push(`- **Restart:** ${a.restartPolicy} _(verified: Docker)_`);
    if (a.vault.length)
      L.push(`- **Vault entries:** ${a.vault.join(", ")} _(verified: the vault's index)_`);
    if (a.hiddenSettings.length)
      L.push(
        `- **Settings left out (may be secrets):** ${a.hiddenSettings.join(", ")} _(verified: Docker, names only)_`,
      );
    if (a.ownBackup) L.push(fact(a.ownBackup));
  }
  if (facts.networks.length) {
    L.push("", "## Networks", "");
    for (const n of facts.networks)
      L.push(
        `- **${n.name}:** ${n.driver}${n.subnet ? `, ${n.subnet}` : ""}; ${n.apps.join(", ") || "no apps"} _(verified: Docker)_`,
      );
  }
  if (facts.connections.length) {
    L.push("", "## Hearth's connections", "");
    for (const c of facts.connections)
      L.push(`- **${c.name}**${c.app ? ` (${c.app})` : ""}${c.address ? `: ${c.address}` : ""}`);
  }
  L.push("", "## Vault entries (names only)", "");
  if (!facts.vault.length) L.push("None.");
  for (const v of facts.vault)
    L.push(
      `- **${v.name}**: ${v.kind}${v.service ? `, for ${v.service}` : ""}${v.tier === "protected" ? ", protected" : ""}`,
    );
  const gaps = facts.apps.filter((a) => a.hiddenSettings.length && !a.vault.length);
  L.push("", "## Credential gaps", "");
  L.push(
    gaps.length
      ? "These apps have settings left out of this blueprint and no vault entry linked: their values are not in the vault and must be found again (from the app, or its own backup)."
      : "Every app with settings left out has a vault entry linked.",
  );
  for (const a of gaps) L.push(`- **${a.name}:** ${a.hiddenSettings.join(", ")}`);
  if (Object.keys(compose).length) {
    L.push("", "## Compose files (values hidden)", "");
    for (const [file, text] of Object.entries(compose))
      L.push(`### ${file}`, "", "```yaml", text.trimEnd(), "```", "");
  }
  L.push("", "## Notes", "", facts.notes || "None yet.");
  if (facts.gaps.length) {
    L.push("", "## What could not be read", "");
    for (const g of facts.gaps) L.push(`- ${g}`);
  }
  return `${L.join("\n").trimEnd()}\n`;
}
