import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { aiDisplayName, remoteId, routeToPc } from "@dragon-control/core";
import type {
  ManualSystemInput,
  ActionKind,
  AppReport,
  AppDiagnostics,
  ServiceRuntime,
  ActionRecord,
  AdoptSelection,
  AuditRecord,
  Autonomy,
  AutonomyRule,
  DemoScenario,
  DiscoveryReport,
  FolderListing,
  ItemProperties,
  PhysicalDisk,
  StorageLocation,
  Workspace,
} from "@dragon-control/core";
import { useLiveQuery } from "../components/panels/lifecycle";

/**
 * The web app's only door to the server. Pages use these hooks and never
 * call fetch themselves, so loading, errors, and cache refreshes behave the
 * same everywhere.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the app can show sign-in. */
export const UNAUTHORIZED_EVENT = "dc:unauthorized";

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  // A system on another PC: the call goes to that PC through your Hearth.
  url = routeToPc(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Hearth did not respond. It may be restarting or offline.", 0);
  }
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(payload?.message ?? `The server responded ${res.status}.`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/* ---------- Simulated outage (demo only, browser side) ---------- */

const OUTAGE_KEY = "dc.simulateOutage";
const listeners = new Set<() => void>();

function readOutage(): boolean {
  try {
    return localStorage.getItem(OUTAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOutage(on: boolean) {
  try {
    if (on) localStorage.setItem(OUTAGE_KEY, "1");
    else localStorage.removeItem(OUTAGE_KEY);
  } catch {
    // Without storage the simulation simply can't persist.
  }
  listeners.forEach((l) => l());
}

export function useSimulatedOutage() {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, readOutage);
}

/* ---------- Queries ---------- */

/** What your AI administrator is called (Settings > Ember > Identity). */
export function useAiName(): string {
  return aiDisplayName(useWorkspace().data?.aiName);
}

export function useWorkspace() {
  const outage = useSimulatedOutage();
  return useQuery({
    queryKey: ["workspace", outage],
    queryFn: async () => {
      if (outage) {
        await new Promise((r) => setTimeout(r, 250));
        throw new ApiError("Hearth did not respond. It may be restarting or offline.", 0);
      }
      return withOtherPcs(await api<Workspace>("GET", "/api/workspace"));
    },
    retry: false,
    // Monitoring changes things in the background; keep every screen current,
    // and follow a repair closely while one is running.
    refetchInterval: (query) =>
      query.state.data?.actions.some((a) => a.status === "running") ? 1_500 : 15_000,
  });
}

export function useAudit(limit = 8) {
  return useQuery({
    queryKey: ["audit", limit],
    queryFn: () => api<AuditRecord[]>("GET", `/api/audit?limit=${limit}`),
  });
}

/* ---------- Mutations ---------- */

function useWrite<V, R = unknown>(fn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export const useUpdateSettings = () =>
  useWrite(
    (patch: {
      instanceName?: string;
      ownerName?: string;
      aiName?: string;
      theme?: import("@dragon-control/core").ThemeChoice;
      /** The look on phones; null: the same as the desktop. */
      phoneTheme?: import("@dragon-control/core").ThemeChoice | null;
      /** The Lair's systems in your order, for every device; null: most used first. */
      lairOrder?: string[] | null;
      /** How often each system was opened in the Lair on this device (merged on Hearth). */
      lairUsage?: Record<string, { s: number; at: number }>;
      webUiVia?: "proxy" | "host";
      quietHours?: boolean;
      monitorIntervalSec?: number;
      failureThreshold?: number;
      liveRepairs?: boolean;
      /** Pictures beside messages in conversations. */
      chatPictures?: boolean;
      /** The first-run welcome: finished or skipped (true), or offer it again (false). */
      onboardingDone?: boolean;
      journey?: "build" | "existing";
      /** The welcome step reached last, so it resumes there. */
      onboardingStep?: string;
    }) => api("PATCH", "/api/settings", patch),
  );

/** Watch a service, or mark it paused (off on purpose for now) or retired (replaced or removed). */
/** A container's live state (uptime, ports, CPU, memory), read only, refreshed while open. */
export function useServiceRuntime(serviceId: string) {
  return useLiveQuery({
    queryKey: ["runtime", serviceId],
    queryFn: () =>
      api<ServiceRuntime>("GET", `/api/services/${encodeURIComponent(serviceId)}/runtime`),
    refetchInterval: 15_000,
  });
}

/** Read inside an app now (read only), e.g. right after adding its API key. */
/** The Diagnostics panel: a live read of the app, refreshed every 20 seconds while it is open. */
export function useDiagnostics(serviceId: string) {
  return useLiveQuery({
    queryKey: ["diagnostics", serviceId],
    queryFn: () =>
      api<AppDiagnostics>("GET", `/api/services/${encodeURIComponent(serviceId)}/diagnostics`),
    refetchInterval: 20_000,
  });
}

export const useCheckApp = () =>
  useWrite((serviceId: string) =>
    api<AppReport>("POST", `/api/services/${encodeURIComponent(serviceId)}/app/check`, {}),
  );

export const useServiceLifecycle = () =>
  useWrite((v: { id: string; lifecycle: "active" | "paused" | "retired"; note?: string }) =>
    api("PUT", `/api/services/${encodeURIComponent(v.id)}/lifecycle`, {
      lifecycle: v.lifecycle,
      note: v.note,
    }),
  );

/** Add a system discovery missed; Hearth watches it like any other. */
export const useAddSystem = () =>
  useWrite((input: ManualSystemInput) =>
    api<{ id: string; name: string }>("POST", "/api/services", input),
  );

/** Take a system out of Hearth. The container or app itself is not touched. */
export const useRemoveSystem = () =>
  useWrite((id: string) => api("POST", `/api/services/${encodeURIComponent(id)}/remove`, {}));

/** Bring a removed system back, so Hearth watches it again. */
export const useRestoreSystem = () =>
  useWrite((id: string) => api("POST", `/api/services/${encodeURIComponent(id)}/restore`, {}));

export const useSaveAutonomy = () =>
  useWrite((body: { default: Autonomy; rules: Pick<AutonomyRule, "id" | "level">[] }) =>
    api("PUT", "/api/autonomy", body),
  );

export const useSetRouteChannels = () =>
  useWrite(({ routeId, channels }: { routeId: string; channels: string[] }) =>
    api("PUT", `/api/notifications/routes/${encodeURIComponent(routeId)}`, { channels }),
  );

export const useIncidentDecision = () =>
  useWrite(
    ({
      incidentId,
      decision,
      fingerprint,
    }: {
      incidentId: string;
      decision: "approve" | "decline";
      /** The proposal you were shown: approving anything else is refused. */
      fingerprint?: string;
    }) =>
      api("POST", `/api/incidents/${encodeURIComponent(incidentId)}/decision`, {
        decision,
        fingerprint,
      }),
  );

/** Dismiss an incident: closed, and not raised again while the problem reads the same. */
export function useDismissIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (incidentId: string) =>
      api("POST", `/api/incidents/${encodeURIComponent(incidentId)}/dismiss`),
    onSettled: () => {
      for (const key of ["workspace", "audit", "findings"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/* ---------- Notification channels ---------- */

export const useConfigureChannel = () =>
  useWrite(({ id, values }: { id: string; values: Record<string, string> }) =>
    api("PUT", `/api/notifications/channels/${encodeURIComponent(id)}`, { values }),
  );

export const useRemoveChannel = () =>
  useWrite((id: string) => api("DELETE", `/api/notifications/channels/${encodeURIComponent(id)}`));

/** Another destination of a kind (a second Discord channel, for friends and family, say). */
export const useAddDestination = () =>
  useWrite((v: { kind: string; name: string; audience: "private" | "public" }) =>
    api<{ id: string }>("POST", "/api/notifications/destinations", v),
  );

export const useSetChannelEnabled = () =>
  useWrite(({ id, enabled }: { id: string; enabled: boolean }) =>
    api("PUT", `/api/notifications/channels/${encodeURIComponent(id)}/enabled`, { enabled }),
  );

export const useTestChannel = () =>
  useWrite((id: string) =>
    api<{ ok: boolean; error?: string }>(
      "POST",
      `/api/notifications/channels/${encodeURIComponent(id)}/test`,
      {},
    ),
  );

/* ---------- Monitoring ---------- */

export const useRunChecks = () =>
  useWrite((serviceId?: string) =>
    api<{ checked: number; failing: number; opened: number; resolved: number }>(
      "POST",
      "/api/monitor/run",
      {
        serviceId,
      },
    ),
  );

export type PracticeCondition = "down" | "stuck" | "slow" | "upstream" | "normal";

export const useSimulate = () =>
  useWrite(({ serviceId, condition }: { serviceId: string; condition: PracticeCondition }) =>
    api("POST", "/api/demo/simulate", { serviceId, condition }),
  );

/* ---------- Actions ---------- */

/** Something you ask Hearth to do to a service. Logs come back in `lines`. */
export const useAction = () =>
  useWrite(({ kind, serviceId }: { kind: ActionKind; serviceId: string }) =>
    api<{ action: ActionRecord; lines?: string[] }>("POST", "/api/actions", { kind, serviceId }),
  );

/** A window of a container's logs: since/until are times or "6h"; filter is plain text. */
export interface LogWindow {
  since?: string;
  until?: string;
  filter?: string;
  limit?: number;
}

/** Logs, read when asked for and never cached for later. Without a window: the latest lines. */
export function useLogs(serviceId: string, window?: LogWindow) {
  return useQuery({
    queryKey: ["logs", serviceId, window ?? null],
    queryFn: async () =>
      (
        await api<{ action: ActionRecord; lines?: string[] }>("POST", "/api/actions", {
          kind: "inspect-logs",
          serviceId,
          ...(window ? { logs: window } : {}),
        })
      ).lines ?? [],
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/* ---------- Storage (read only) ---------- */

const pathQuery = (path: string) => (path ? `?path=${encodeURIComponent(path)}` : "");

export function useBrowse(locationId: string, path: string) {
  return useQuery({
    queryKey: ["browse", locationId, path],
    queryFn: () =>
      api<FolderListing>(
        "GET",
        `/api/storage/${encodeURIComponent(locationId)}/browse${pathQuery(path)}`,
      ),
    retry: false,
  });
}

export function useItemProperties(locationId: string, path: string | null) {
  return useQuery({
    queryKey: ["properties", locationId, path],
    queryFn: () =>
      api<ItemProperties>(
        "GET",
        `/api/storage/${encodeURIComponent(locationId)}/properties${pathQuery(path ?? "")}`,
      ),
    enabled: path !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export const useAddLocation = () =>
  useWrite((input: { path: string; label?: string }) =>
    api<StorageLocation>("POST", "/api/storage/locations", input),
  );

export const useRemoveLocation = () =>
  useWrite((id: string) => api("DELETE", `/api/storage/locations/${encodeURIComponent(id)}`));

export const useRefreshDisks = () =>
  useWrite(() => api<PhysicalDisk[]>("POST", "/api/storage/disks/refresh"));

/* ---------- Discovery ---------- */

/** The last scan the server ran, if any (404 just means "none yet"). */
/** Discovery on this Hearth, or on a joined PC (through your Hearth: /api/on/<pc>/...). */
const discoveryApi = (pc?: string) => (pc ? `/api/on/${encodeURIComponent(pc)}` : "/api");

export function useLatestScan(pc?: string) {
  return useQuery({
    queryKey: ["discovery", "latest", pc ?? "here"],
    queryFn: async () =>
      (await api<{ report: DiscoveryReport | null }>("GET", `${discoveryApi(pc)}/discovery/latest`))
        .report,
  });
}

export function useScan(pc?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<DiscoveryReport>("POST", `${discoveryApi(pc)}/discovery/scan`),
    onSuccess: (report) => queryClient.setQueryData(["discovery", "latest", pc ?? "here"], report),
  });
}

/** A machine "Find it for me" found on the home network. */
export interface FoundMachine {
  address: string;
  /** The NAS system, when its own sign-in page answered ("Synology DSM"). */
  nas?: string;
  apps: string[];
}

/** "Find it for me": the NAS and app machines on the home network (read-only, about 20 s). */
export function useFindMachines() {
  return useMutation({
    mutationFn: () =>
      api<{ machines: FoundMachine[] }>("POST", "/api/discovery/find-machines", {}),
  });
}

export function useScanRemote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { address: string; name: string }) =>
      api<DiscoveryReport>("POST", "/api/discovery/scan-remote", input),
    onSuccess: (report) => queryClient.setQueryData(["discovery", "latest", "here"], report),
  });
}

export function useAdopt(pc?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reportId, selections }: { reportId: string; selections: AdoptSelection[] }) =>
      api<{ services: number }>("POST", `${discoveryApi(pc)}/discovery/adopt`, {
        reportId,
        selections,
      }),
    onSettled: () => {
      for (const key of ["workspace", "audit", "discovery"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export type ScenarioChoice = DemoScenario | "unreachable";

export function useSetScenario() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      scenario,
      replaceYourSystems,
    }: {
      scenario: DemoScenario;
      replaceYourSystems?: boolean;
    }) => api("POST", "/api/demo/scenario", { scenario, replaceYourSystems }),
    onSettled: () => {
      for (const key of ["workspace", "audit", "discovery"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  const choose = useCallback(
    (choice: ScenarioChoice, opts: { replaceYourSystems?: boolean } = {}) => {
      if (choice === "unreachable") {
        writeOutage(true);
        return;
      }
      writeOutage(false);
      mutation.mutate({ scenario: choice, replaceYourSystems: opts.replaceYourSystems });
    },
    [mutation],
  );
  return { choose, isPending: mutation.isPending, error: mutation.error };
}

/**
 * Your systems on every PC (docs/design/ONE_ACCOUNT.md): each online PC's machine and systems
 * join this Hearth's, marked with their PC and with ids that send their calls to it. A PC still
 * showing sample data (not discovered yet) is left out.
 */
export async function withOtherPcs(ws: Workspace): Promise<Workspace> {
  let pcs: { id: string; online?: boolean }[];
  try {
    pcs = (await api<{ pcs: { id: string; online?: boolean }[] }>("GET", "/api/pcs")).pcs;
  } catch {
    return ws;
  }
  const online = pcs.filter((p) => p.online);
  if (!online.length) return ws;
  const parts = await Promise.all(
    online.map((p) =>
      api<Workspace>("GET", `/api/on/${p.id}/workspace`).then(
        (w) => [p.id, w] as const,
        () => null,
      ),
    ),
  );
  const out: Workspace = {
    ...ws,
    hosts: [...ws.hosts],
    services: [...ws.services],
    inactiveServices: [...ws.inactiveServices],
    apps: [...ws.apps],
    incidents: [...ws.incidents],
  };
  // A PC that has not adopted anything (still on sample data, or nothing to watch) still shows
  // its own machine: CPU, memory, drives (10-30). No apps needed for that.
  const bare = await Promise.all(
    parts.map((part) =>
      part && part[1].environment !== "real"
        ? api<Workspace["hosts"][number]>("GET", `/api/on/${part[0]}/machine`).then(
            (m) => [part[0], m] as const,
            () => null,
          )
        : null,
    ),
  );
  for (const got of bare) {
    if (!got) continue;
    const [pc, m] = got;
    const id = remoteId(pc, m.id);
    out.hosts.push({
      ...m,
      id,
      connection: "agent" as const,
      pcId: pc,
      health: "healthy",
      lastSeenAt: new Date().toISOString(),
      volumes: (m.volumes ?? []).map((v) => ({ ...v, id: remoteId(pc, v.id), hostId: id })),
    });
  }
  for (const part of parts) {
    if (!part || part[1].environment !== "real") continue;
    const [pc, w] = part;
    const rid = (id: string) => remoteId(pc, id);
    out.hosts.push(
      ...w.hosts.map((h) => ({ ...h, id: rid(h.id), connection: "agent" as const, pcId: pc })),
    );
    const svc = (x: Workspace["services"][number]) => ({
      ...x,
      id: rid(x.id),
      hostId: rid(x.hostId),
      pcId: pc,
    });
    out.services.push(...w.services.map(svc));
    out.inactiveServices.push(...w.inactiveServices.map(svc));
    out.apps.push(...w.apps.map((a) => ({ ...a, serviceId: rid(a.serviceId) })));
    out.incidents.push(
      ...w.incidents.map((i) => ({
        ...i,
        id: rid(i.id),
        ...(i.serviceId ? { serviceId: rid(i.serviceId) } : {}),
        ...(i.hostId ? { hostId: rid(i.hostId) } : {}),
      })),
    );
  }
  return out;
}
