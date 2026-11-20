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

/**
 * Another machine, seen only over the network: the same well-known ports,
 * each asked one read-only GET at that address. Nothing is installed there,
 * so Hearth can check these apps but not restart them.
 */
export async function findAppsAt(input: {
  hostId: string;
  hostName: string;
  address: string;
  probeHttp: (port: number, host?: string) => Promise<boolean>;
}): Promise<DiscoveryFinding[]> {
  const entries = CATALOG.filter((e) => e.nativePort);
  const answers = await Promise.all(
    entries.map((e) => input.probeHttp(e.nativePort!, input.address)),
  );
  return entries
    .filter((_, i) => answers[i])
    .map((entry) => ({
      key: `remote:${input.hostId}:${entry.id}`,
      source: "process" as const,
      sourceName: entry.name,
      state: "running" as const,
      health: "healthy" as const,
      group: "recognised" as const,
      name: entry.name,
      category: entry.category,
      autonomyArea: entry.area,
      recognised: true,
      localUrl: `http://${input.address.includes(":") ? `[${input.address}]` : input.address}:${entry.nativePort}`,
      localOnly: false,
      ports: [String(entry.nativePort)],
      dependsOn: [],
      reason: `Answers on ${input.hostName} at port ${entry.nativePort}. Checked over the network; Hearth cannot restart it there.`,
      selectedByDefault: true,
    }));
}
