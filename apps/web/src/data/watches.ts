import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ReleaseWatchSettings,
  Watch,
  WatchHistoryEntry,
} from "@dragon-control/core";
import { api } from "./api";

/** Release watch: movies requested in Seerr, followed until they arrive (watches/engine.ts). */
export function useWatches() {
  return useQuery({
    queryKey: ["watches"],
    queryFn: () =>
      api<{ watches: Watch[]; settings: ReleaseWatchSettings; seerr: number; radarr: number }>(
        "GET",
        "/api/watches",
      ),
    // Checks run on the server's own schedule; the page keeps up without a reload.
    refetchInterval: 60_000,
  });
}

export function useWatch(id: string | undefined) {
  return useQuery({
    queryKey: ["watches", id],
    queryFn: () => api<Watch & { history: WatchHistoryEntry[] }>("GET", `/api/watches/${id}`),
    enabled: Boolean(id),
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["watches"] });
}

export function useCheckWatches() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api<{ added: number; errors: string[] }>("POST", "/api/watches/check", {}),
    onSettled: refresh,
  });
}

export function useWatchAction() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      id,
      action,
      days,
    }: {
      id: string;
      action: "check" | "snooze" | "unsnooze" | "dismiss" | "restore";
      days?: number;
    }) =>
      api<unknown>(
        "POST",
        `/api/watches/${encodeURIComponent(id)}/${action}`,
        days !== undefined ? { days } : {},
      ),
    onSettled: refresh,
  });
}

export function useWatchSettings() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (change: Partial<ReleaseWatchSettings>) =>
      api<ReleaseWatchSettings>("PATCH", "/api/watches/settings", change),
    onSettled: refresh,
  });
}
