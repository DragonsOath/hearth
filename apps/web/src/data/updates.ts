import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { usePcs, type PcInfo } from "./pcs";

/** Hearth updates (apps/server/src/updates/service.ts): is a newer Hearth out, and Update now. */
export interface UpdateState {
  current: string | null;
  latest: { version: string; notes: string; url: string } | null;
  available: boolean;
  checkedAt: string | null;
  problem: string | null;
  canUpdate: boolean;
  cannot: string | null;
  commands: { linux: string; windows: string };
  updating: boolean;
  /** Work an update would stop right now (it restarts Hearth). */
  busy?: string[];
  /** Hearth checks for updates on its own (off: only when Check now is pressed). */
  auto?: boolean;
}

/** Update now's answer; refused with what is running unless "update anyway". */
export interface InstallResult {
  ok: boolean;
  message: string;
  busy?: string[];
}

export function useUpdates() {
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => api<UpdateState>("GET", "/api/updates"),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}

export function useCheckUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UpdateState>("POST", "/api/updates/check", {}),
    onSuccess: (s) => qc.setQueryData(["updates"], s),
  });
}

/** Check for updates on or off (Settings, About). */
export function useUpdateAuto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api<UpdateState>("POST", "/api/updates/auto", { on }),
    onSuccess: (s) => qc.setQueryData(["updates"], s),
  });
}

/** 1 when a is newer than b, -1 when older, 0 when the same (numbers only, "v" ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Your other PCs (the ones that joined this Hearth) and which of them are behind the newest
 * Hearth. Each PC runs its own copy, so updating this one does not update them.
 */
export function useOtherPcs(s: UpdateState | undefined) {
  const pcs = usePcs().data?.pcs ?? [];
  const newest = s?.latest?.version ?? s?.current ?? null;
  const behind = (pc: PcInfo) =>
    Boolean(newest && pc.version && compareVersions(newest, pc.version) > 0);
  return { pcs, behind: pcs.filter(behind), isBehind: behind };
}

/** Update now on one of your other PCs (over its link; it restarts on its own). */
export function useInstallPcUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, anyway }: { id: string; anyway?: boolean }) =>
      api<InstallResult>("POST", `/api/on/${id}/updates/install`, anyway ? { anyway } : {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["pcs"] }),
  });
}

/** Update now: your other PCs that are behind first (they restart on their own), then this one. */
export function useInstallUpdate() {
  return useMutation({
    mutationFn: async ({ others = [], anyway }: { others?: PcInfo[]; anyway?: boolean }) => {
      const body = anyway ? { anyway } : {};
      // A PC that is in the middle of work says so and keeps running; update it when it is done.
      await Promise.all(
        others
          .filter((pc) => pc.online)
          .map((pc) =>
            api("POST", `/api/on/${pc.id}/updates/install`, body).catch(() => undefined),
          ),
      );
      return api<InstallResult>("POST", "/api/updates/install", body);
    },
  });
}

/** After Update now: waits for Hearth to come back on a new version, then reloads the page. */
export async function waitForNewVersion(from: string | null, signal: AbortSignal) {
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < 15 * 60_000) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        const v = ((await res.json()) as { version?: string }).version ?? null;
        if (v && v !== from) {
          window.location.reload();
          return;
        }
      }
    } catch {
      // Restarting: try again in a moment.
    }
  }
}
