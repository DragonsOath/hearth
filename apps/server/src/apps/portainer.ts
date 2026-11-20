import type {
  AppReport,
  PortainerContainer,
  PortainerDashboard,
  PortainerStack,
} from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Portainer, through its own API (/api) with an access token from the vault (X-API-Key). Checked
 * against a throwaway portainer/portainer-ce container (2.45.3) managing a Docker host.
 *
 * Containers are read live through Portainer's Docker proxy: its environment snapshots lag by
 * minutes. Some of Portainer's answers carry secrets (a stack's environment variables, users'
 * password hashes, registry logins), so Hearth reads only the fields it shows and never passes
 * Portainer's objects through. The token never leaves this file.
 */

export class PortainerError extends Error {}

type Method = "GET" | "POST" | "PUT";

export class PortainerClient {
  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly fetchImpl: Fetch,
  ) {}

  async call<T>(method: Method, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(joinUrl(this.base, `/api${path}`), {
        method,
        headers: {
          Accept: "application/json",
          "X-API-Key": this.key,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Portainer did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401)
      throw new AppKeyError("Portainer refused the access token. Check it in the vault.");
    if (res.status === 403)
      throw new PortainerError(
        "That Portainer user may not do that here: use an administrator's access token.",
      );
    if (res.status === 204 || res.status === 304) return undefined as T;
    const text = (await res.text?.()) ?? "";
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const m = json as { message?: string; details?: string } | undefined;
      throw new PortainerError(
        `Portainer said: ${(m?.details ?? m?.message ?? text.trim().slice(0, 200)) || res.status}`,
      );
    }
    return json as T;
  }
}

interface RawEndpoint {
  Id: number;
  Name: string;
  Type: number;
  Status: number;
  Snapshots?: { ImageCount?: number; TotalCPU?: number; TotalMemory?: number }[];
}

interface RawContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
}

interface RawStack {
  Id: number;
  Name: string;
  EndpointId: number;
  Status: number;
  Type: number;
  GitConfig?: unknown;
  UpdateDate?: number;
  UpdatedBy?: string;
  CreationDate?: number;
  CreatedBy?: string;
}

/** Docker environments Hearth can read containers from (not Kubernetes, not async Edge). */
const KIND: Record<number, PortainerDashboard["environments"][number]["kind"]> = {
  1: "docker",
  2: "agent",
  4: "edge",
  5: "kubernetes",
  6: "kubernetes",
  7: "kubernetes",
};

const STATES = new Set(["running", "exited", "paused", "restarting", "created", "dead"]);

export const toContainer = (c: RawContainer, environmentId: number): PortainerContainer => {
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1];
  return {
    id: c.Id.slice(0, 12),
    name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
    image: c.Image.startsWith("sha256:") ? c.Image.slice(7, 19) : c.Image,
    state: (STATES.has(c.State) ? c.State : "unknown") as PortainerContainer["state"],
    status: c.Status,
    ...(health
      ? { health: health === "health: starting" ? "starting" : (health as "healthy" | "unhealthy") }
      : {}),
    ...(c.Labels?.["com.docker.compose.project"]
      ? { stack: c.Labels["com.docker.compose.project"] }
      : {}),
    environmentId,
  };
};

/** Containers of a Docker environment, live, or none when it is not reachable. */
export async function containersOf(
  c: PortainerClient,
  environmentId: number,
): Promise<PortainerContainer[]> {
  const raw = await c.call<RawContainer[]>(
    "GET",
    `/endpoints/${environmentId}/docker/containers/json?all=1`,
  );
  return raw.map((x) => toContainer(x, environmentId));
}

/** The panel's live read: environments, stacks and containers. */
export async function portainerDashboard(c: PortainerClient): Promise<PortainerDashboard> {
  const [status, endpoints, stacks] = await Promise.all([
    c.call<{ Version?: string }>("GET", "/system/status"),
    c.call<RawEndpoint[]>("GET", "/endpoints"),
    c.call<RawStack[]>("GET", "/stacks").catch(() => [] as RawStack[]),
  ]);
  const docker = endpoints.filter((e) => (e.Type === 1 || e.Type === 2) && e.Status === 1);
  const lists = await Promise.all(
    docker.map((e) => containersOf(c, e.Id).catch(() => [] as PortainerContainer[])),
  );
  let containers = lists.flat();
  // Image updates, where Portainer reports them (its Business edition; Community answers 404).
  let updatesKnown = false;
  const first = containers.find((x) => x.state === "running");
  if (first) {
    const probe = await c
      .call<{ Status?: string }>(
        "GET",
        `/docker/${first.environmentId}/containers/${first.id}/image_status`,
      )
      .catch(() => undefined);
    if (probe?.Status) {
      updatesKnown = true;
      const statuses = await Promise.all(
        containers.map((x) =>
          c
            .call<{ Status?: string }>(
              "GET",
              `/docker/${x.environmentId}/containers/${x.id}/image_status`,
            )
            .then((r) => r?.Status)
            .catch(() => undefined),
        ),
      );
      containers = containers.map((x, i) =>
        statuses[i] === "outdated" || statuses[i] === "updated"
          ? { ...x, update: statuses[i] as "outdated" | "updated" }
          : x,
      );
    }
  }
  const stackList: PortainerStack[] = stacks.map((s) => {
    const mine = containers.filter((x) => x.environmentId === s.EndpointId && x.stack === s.Name);
    const when = s.UpdateDate || s.CreationDate;
    return {
      id: s.Id,
      name: s.Name,
      environmentId: s.EndpointId,
      running: s.Status === 1,
      fromGit: Boolean(s.GitConfig),
      ...(when ? { updatedAt: new Date(when * 1000).toISOString() } : {}),
      ...(s.UpdatedBy || s.CreatedBy ? { updatedBy: (s.UpdatedBy || s.CreatedBy)! } : {}),
      containers: mine.length,
      containersRunning: mine.filter((x) => x.state === "running").length,
    };
  });
  return {
    app: "portainer",
    ...(status.Version ? { version: status.Version } : {}),
    environments: endpoints.map((e) => {
      const mine = containers.filter((x) => x.environmentId === e.Id);
      const snap = e.Snapshots?.[0];
      return {
        id: e.Id,
        name: e.Name,
        kind: KIND[e.Type] ?? "other",
        online: e.Status === 1,
        running: mine.filter((x) => x.state === "running").length,
        stopped: mine.filter((x) => x.state !== "running").length,
        unhealthy: mine.filter((x) => x.health === "unhealthy").length,
        stacks: stackList.filter((s) => s.environmentId === e.Id).length,
        ...(snap?.ImageCount !== undefined ? { images: snap.ImageCount } : {}),
        ...(snap?.TotalCPU ? { cpus: snap.TotalCPU } : {}),
        ...(snap?.TotalMemory ? { memoryBytes: snap.TotalMemory } : {}),
      };
    }),
    stacks: stackList.sort((a, b) => a.name.localeCompare(b.name)),
    containers: containers.sort((a, b) => a.name.localeCompare(b.name)),
    updatesKnown,
  };
}

/** The health check: environments offline, unhealthy containers, stacks with stopped parts. */
export async function readPortainer(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await portainerDashboard(new PortainerClient(base, key, fetchImpl));
  const issues: AppReport["issues"] = [];
  const offline = d.environments.filter((e) => !e.online);
  if (offline.length)
    issues.push({
      level: "warning",
      key: "environments-offline",
      text: `${offline.map((e) => e.name).join(", ")} ${offline.length === 1 ? "is" : "are"} not reachable from Portainer.`,
    });
  const sick = d.containers.filter((x) => x.health === "unhealthy");
  if (sick.length)
    issues.push({
      level: "warning",
      key: "containers-unhealthy",
      text: `${sick.map((x) => x.name).join(", ")} ${sick.length === 1 ? "is" : "are"} unhealthy.`,
    });
  const partial = d.stacks.filter(
    (s) => s.running && s.containers && s.containersRunning < s.containers,
  );
  if (partial.length)
    issues.push({
      level: "warning",
      key: "stacks-partly-down",
      text: `${partial.map((s) => s.name).join(", ")} ${partial.length === 1 ? "has" : "have"} stopped containers.`,
    });
  return {
    app: "portainer",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Environments",
        value: `${d.environments.filter((e) => e.online).length} of ${d.environments.length} reachable`,
      },
      {
        label: "Containers running",
        value: `${d.containers.filter((x) => x.state === "running").length} of ${d.containers.length}`,
      },
      { label: "Stacks", value: String(d.stacks.length) },
    ],
  };
}
