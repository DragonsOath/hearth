import type { DiscoveryFinding, Health } from "@dragon-control/core";
import { CATALOG, identify, type CatalogEntry } from "./catalog";
import type { ContainerInfo, PortBinding } from "./docker";

/**
 * Turns raw containers into reviewable findings. Pure apart from the
 * injected `probeHttp`, so every rule here is unit tested without Docker.
 */

export interface AnalyzeInput {
  containers: ContainerInfo[];
  hostAddress: string;
  /** Read-only check: does something answer HTTP on this port (loopback unless a host is given)? */
  probeHttp: (port: number, host?: string) => Promise<boolean>;
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1";

function health(c: ContainerInfo): Health {
  if (c.state === "stopped") return "offline";
  if (c.state !== "running" || c.healthcheck === "unhealthy") return "attention";
  return "healthy";
}

/**
 * A readable name for a container the catalogue does not know. Compose's
 * generated names ("tasterr-tasterr-1") become the app's name ("Tasterr");
 * names someone chose keep their words ("opnform-ingress" -> "Opnform Ingress").
 */
export function containerName(
  c: Pick<ContainerInfo, "name" | "composeProject" | "composeService">,
): string {
  const { composeProject: project, composeService: service } = c;
  if (project && service) {
    const generated = new RegExp(
      `^${escapeRegExp(project)}[-_]${escapeRegExp(service)}[-_]\\d+$`,
      "i",
    );
    if (generated.test(c.name)) {
      return prettify(
        service.toLowerCase() === project.toLowerCase() ? service : `${project} ${service}`,
      );
    }
  }
  return prettify(c.name);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prettify(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Ports a container is actually reachable on, including those published by its network provider. */
export function effectiveBindings(
  container: ContainerInfo,
  providerOf: (c: ContainerInfo) => ContainerInfo | undefined,
): PortBinding[] {
  // Host networking: the container listens directly on the machine's own ports.
  if (container.networkMode === "host") {
    return container.exposedPorts.map((port) => ({
      privatePort: port,
      publicPort: port,
      ip: "0.0.0.0",
      protocol: "tcp" as const,
    }));
  }
  const provider = providerOf(container);
  if (!provider) return container.bindings.filter((b) => b.protocol === "tcp");
  return provider.bindings.filter(
    (b) => b.protocol === "tcp" && container.exposedPorts.includes(b.privatePort),
  );
}

function urlFor(binding: PortBinding, hostAddress: string) {
  const local = isLoopback(binding.ip);
  const host = local ? "127.0.0.1" : binding.ip === "0.0.0.0" ? hostAddress : binding.ip;
  return { url: `http://${host}:${binding.publicPort}`, localOnly: local };
}

export async function analyzeContainers(input: AnalyzeInput): Promise<DiscoveryFinding[]> {
  const { containers, hostAddress, probeHttp } = input;
  const byId = new Map(containers.map((c) => [c.id, c]));

  const providerOf = (c: ContainerInfo) => {
    const ref = c.networkMode?.startsWith("container:") ? c.networkMode.slice(10) : undefined;
    if (!ref) return undefined;
    return byId.get(ref) ?? containers.find((o) => o.id.startsWith(ref) || o.name === ref);
  };

  // Ports a member container claims belong to it, not to the VPN/provider that publishes them.
  const claimedOnProvider = new Map<string, Set<number>>();
  for (const c of containers) {
    const p = providerOf(c);
    if (!p) continue;
    const set = claimedOnProvider.get(p.id) ?? new Set<number>();
    c.exposedPorts.forEach((port) => set.add(port));
    claimedOnProvider.set(p.id, set);
  }

  const keyOf = (c: ContainerInfo) => `container:${c.name}`;
  const catalogCounts = new Map<string, number>();
  const entries = new Map<string, CatalogEntry | undefined>();
  for (const c of containers) {
    const entry = identify(c.image);
    entries.set(c.id, entry);
    if (entry && c.state === "running")
      catalogCounts.set(entry.id, (catalogCounts.get(entry.id) ?? 0) + 1);
  }

  // Containers are analysed concurrently so slow HTTP probes don't add up.
  return Promise.all(
    containers.map(async (c): Promise<DiscoveryFinding> => {
      const entry = entries.get(c.id);
      const provider = providerOf(c);
      let bindings = effectiveBindings(c, providerOf);
      const claimed = claimedOnProvider.get(c.id);
      if (claimed) bindings = bindings.filter((b) => !claimed.has(b.privatePort));

      let web: ReturnType<typeof urlFor> | undefined;
      if (entry?.webPort) {
        const b = bindings.find((x) => x.privatePort === entry.webPort);
        if (b) web = urlFor(b, hostAddress);
      } else if (!entry && c.state === "running") {
        for (const b of bindings) {
          if (await probeHttp(b.publicPort)) {
            web = urlFor(b, hostAddress);
            break;
          }
        }
      }

      const dependsOn = new Set<string>();
      if (provider) dependsOn.add(keyOf(provider));
      for (const svc of c.composeDependsOn) {
        const dep = containers.find(
          (o) => o.composeProject === c.composeProject && o.composeService === svc && o.id !== c.id,
        );
        if (dep) dependsOn.add(keyOf(dep));
      }

      const running = c.state === "running";
      const group: DiscoveryFinding["group"] = !running
        ? "stopped"
        : entry && !entry.supporting
          ? "recognised"
          : !entry && web
            ? "unrecognised-web"
            : "supporting";

      // Two running copies of one app (e.g. two VPN containers) need distinguishable names.
      const duplicate = entry && (catalogCounts.get(entry.id) ?? 0) > 1;
      // A bare "PostgreSQL" says nothing; "PostgreSQL (immich_postgres)" says whose it is.
      const datastore = entry?.supporting && entry.area === "storage";
      const name = entry
        ? duplicate || !running || datastore
          ? `${entry.name} (${c.name})`
          : entry.name
        : containerName(c);

      const reason = !running
        ? c.state === "stopped"
          ? "Stopped. Probably intentional, so it is not selected."
          : `Currently ${c.state}.`
        : entry
          ? `Recognised from its image, ${c.image.split("@")[0]}.`
          : web
            ? `Not in the catalogue, but it answers on port ${web.url.split(":").pop()}. Give it a name.`
            : "Not in the catalogue and has no web interface; likely supporting another app.";

      return {
        key: keyOf(c),
        source: "container",
        sourceName: c.name,
        image: c.image,
        composeProject: c.composeProject,
        state: c.state,
        health: health(c),
        group,
        name,
        category: entry?.category ?? "System",
        autonomyArea: entry?.area ?? "containers",
        recognised: Boolean(entry),
        localUrl: web?.url,
        localOnly: web?.localOnly ?? false,
        ports: bindings.map((b) => `${isLoopback(b.ip) ? "127.0.0.1:" : ""}${b.publicPort}`),
        dependsOn: [...dependsOn],
        reason,
        selectedByDefault: running,
      };
    }),
  );
}

/**
 * Well-known apps often installed directly on the host (Plex on Windows is
 * the classic case). Only distinctive ports that no container already
 * publishes are checked, with a single read-only HTTP request each.
 */
export async function findNativeApps(input: {
  containers: ContainerInfo[];
  hostAddress: string;
  probeHttp: (port: number, host?: string) => Promise<boolean>;
}): Promise<DiscoveryFinding[]> {
  // Ports containers already account for, including host-network ones, whose
  // ports would otherwise look like an app installed directly on the machine.
  const published = new Set(
    input.containers.flatMap((c) =>
      c.networkMode === "host" ? c.exposedPorts : c.bindings.map((b) => b.publicPort),
    ),
  );
  const found: DiscoveryFinding[] = [];
  for (const entry of CATALOG.filter((e) => e.nativePort)) {
    const port = entry.nativePort!;
    if (published.has(port) || found.some((f) => f.ports.includes(String(port)))) continue;
    if (!(await input.probeHttp(port))) continue;
    // Many apps (Syncthing's GUI, for one) listen on this machine only. Record
    // the address that actually answers, not one that would be refused.
    const onNetwork = await input.probeHttp(port, input.hostAddress);
    found.push({
      key: `process:${entry.id}`,
      source: "process",
      sourceName: entry.name,
      state: "running",
      health: "healthy",
      group: "recognised",
      name: entry.name,
      category: entry.category,
      autonomyArea: entry.area,
      recognised: true,
      localUrl: `http://${onNetwork ? input.hostAddress : "127.0.0.1"}:${port}`,
      localOnly: !onNetwork,
      ports: [onNetwork ? String(port) : `127.0.0.1:${port}`],
      dependsOn: [],
      reason: `Running directly on this machine (answers on port ${port}${onNetwork ? "" : ", this machine only"}).`,
      selectedByDefault: true,
    });
  }
  return found;
}

/** One read-only GET of a front page: enough to tell apps apart when they share a port. */
export interface PageRead {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The start of the page (the first 64 KB is plenty for a title). */
  body: string;
}

/** Other names an app's own page uses (Seerr is Jellyseerr's successor). */
const PAGE_NAMES: Partial<Record<string, string[]>> = {
  jellyseerr: ["Jellyseerr", "Seerr"],
  paperless: ["Paperless-ngx", "Paperless"],
  adguard: ["AdGuard Home", "AdGuard"],
  npm: ["Nginx Proxy Manager"],
  "uptime-kuma": ["Uptime Kuma"],
  vaultwarden: ["Vaultwarden", "Bitwarden"],
  pihole: ["Pi-hole"],
};
/** Names too ordinary to trust anywhere but on the app's own port. */
const ORDINARY = new Set(["homepage", "qui"]);

/** Ports apps are often published on besides their own container port. */
const EXTRA_PORTS: Partial<Record<string, number[]>> = {
  audiobookshelf: [13378],
  nextcloud: [8080],
  pihole: [8053],
};

/** The NAS systems themselves, by their own sign-in page. */
export const NAS_SYSTEMS = [
  { id: "synology", name: "Synology DSM", ports: [5000], sign: /synology|diskstation/i },
  { id: "qnap", name: "QNAP QTS", ports: [8080], sign: /\bqnap\b|\bQTS\b/ },
  { id: "truenas", name: "TrueNAS", ports: [80], sign: /truenas/i },
  { id: "unraid", name: "Unraid", ports: [80], sign: /unraid/i },
  { id: "openmediavault", name: "OpenMediaVault", ports: [80], sign: /openmediavault/i },
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string) =>
  new RegExp(`(^|[^a-z0-9])${escape(name)}($|[^a-z0-9])`, "i").test(text);
const pageTitle = (body: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
const namesOf = (e: CatalogEntry) => PAGE_NAMES[e.id] ?? [e.name];

/**
 * Which app a front page belongs to, or undefined when it can't be told: its own headers first
 * (Plex, Transmission), then its title, then the page itself for the apps that use this port.
 * The longest name wins, so "Jellyseerr" is never read as "Seerr" and the like.
 */
export function identifyPage(
  page: PageRead,
  onThisPort: CatalogEntry[],
  all: CatalogEntry[] = CATALOG,
): CatalogEntry | undefined {
  const byId = (id: string) => all.find((e) => e.id === id);
  if (page.headers["x-plex-protocol"] || /<MediaContainer[\s>]/.test(page.body))
    return byId("plex");
  if (page.headers["x-transmission-session-id"]) return byId("transmission");
  const best = (text: string, entries: CatalogEntry[]) => {
    let hit: { e: CatalogEntry; len: number } | undefined;
    for (const e of entries)
      for (const n of namesOf(e))
        if (named(text, n) && (!hit || n.length > hit.len)) hit = { e, len: n.length };
    return hit?.e;
  };
  const title = pageTitle(page.body);
  if (title) {
    const own = best(title, onThisPort);
    if (own) return own;
    const other = best(
      title,
      all.filter((e) => !e.supporting && !ORDINARY.has(e.id)),
    );
    if (other) return other;
  }
  return best(
    page.body.slice(0, 65_536),
    onThisPort.filter((e) => !ORDINARY.has(e.id) && e.name.length >= 5),
  );
}

/**
 * Another machine, seen only over the network: every app Hearth knows, at its usual ports, each
 * asked one read-only GET at that address and recognised from its own page (many apps share a
 * port, so the port alone can't say which one answered). The NAS itself is recognised the same
 * way, so its own page is watched too. Nothing is installed there, so Hearth can check these
 * apps but not restart them. Without page reads, only the apps with a port of their own are found.
 */
export async function findAppsAt(input: {
  hostId: string;
  hostName: string;
  address: string;
  probeHttp: (port: number, host?: string) => Promise<boolean>;
  readPage?: (port: number, host: string) => Promise<PageRead | null>;
}): Promise<DiscoveryFinding[]> {
  const host = input.address.includes(":") ? `[${input.address}]` : input.address;
  const finding = (
    id: string,
    name: string,
    category: CatalogEntry["category"],
    area: string,
    port: number,
    what: string,
  ): DiscoveryFinding => ({
    key: `remote:${input.hostId}:${id}`,
    source: "process" as const,
    sourceName: name,
    state: "running" as const,
    health: "healthy" as const,
    group: "recognised" as const,
    name,
    category,
    autonomyArea: area,
    recognised: true,
    localUrl: `http://${host}:${port}`,
    localOnly: false,
    ports: [String(port)],
    dependsOn: [],
    reason: `${what} on ${input.hostName} at port ${port}. Checked over the network; Hearth cannot restart it there.`,
    selectedByDefault: true,
  });

  if (!input.readPage) {
    const entries = CATALOG.filter((e) => e.nativePort);
    const answers = await Promise.all(
      entries.map((e) => input.probeHttp(e.nativePort!, input.address)),
    );
    return entries
      .filter((_, i) => answers[i])
      .map((e) => finding(e.id, e.name, e.category, e.area, e.nativePort!, "Answers"));
  }

  const apps = CATALOG.filter((e) => !e.supporting && (e.nativePort ?? e.webPort));
  const portsOf = (e: CatalogEntry) => [
    ...new Set([e.nativePort ?? e.webPort!, ...(EXTRA_PORTS[e.id] ?? [])]),
  ];
  const ports = [
    ...new Set([...apps.flatMap(portsOf), ...NAS_SYSTEMS.flatMap((n) => [...n.ports])]),
  ].sort((a, b) => a - b);
  const pages = await Promise.all(
    ports.map((p) => input.readPage!(p, input.address).catch(() => null)),
  );

  const found: DiscoveryFinding[] = [];
  const seen = new Set<string>();
  ports.forEach((port, i) => {
    const page = pages[i];
    if (!page) return;
    const onThisPort = apps.filter((e) => portsOf(e).includes(port));
    // The title first; the page itself only when the title names no app (Unraid titles its
    // sign-in page with the server's own name).
    const title = pageTitle(page.body);
    const titleIsAnApp =
      !!title && !!identifyPage({ ...page, body: `<title>${title}</title>` }, onThisPort, apps);
    const nas = NAS_SYSTEMS.find(
      (n) =>
        (n.ports as readonly number[]).includes(port) &&
        (n.sign.test(title) || (!titleIsAnApp && n.sign.test(page.body.slice(0, 65_536)))),
    );
    if (nas) {
      if (seen.has(nas.id)) return;
      seen.add(nas.id);
      found.push(
        finding(
          nas.id,
          nas.name,
          "Files & Photos",
          "storage",
          port,
          "Its own sign-in page answers",
        ),
      );
      return;
    }
    const app =
      identifyPage(page, onThisPort, apps) ??
      // Unreadable or unbranded, on a port only one app uses: that app, as before.
      onThisPort.find((e) => e.nativePort === port);
    if (!app || seen.has(app.id)) return;
    seen.add(app.id);
    found.push(finding(app.id, app.name, app.category, app.area, port, "Answers as " + app.name));
  });
  return found;
}
