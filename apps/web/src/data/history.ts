import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { ContainerEventView, TimelineEvent } from "@dragon-control/core";
import { useLiveQuery } from "../components/panels/lifecycle";

/** Resource history settings with what it costs (server: monitor/history.ts). */
export interface HistoryEstimate {
  subjects: number;
  containers: number;
  rowsPerDay: number;
  rows: number;
  bytes: number;
  samplesPerHour: number;
}

export interface ResourceHistoryInfo {
  enabled: boolean;
  retentionDays: number;
  sampleMinutes: number;
  retentionChoices: number[];
  estimate: HistoryEstimate;
  estimates: Record<string, HistoryEstimate>;
  stored: { rows: number; oldest?: string; bytes: number };
}

export function useResourceHistory() {
  return useQuery({
    queryKey: ["resource-history"],
    queryFn: () => api<ResourceHistoryInfo>("GET", "/api/history/resources"),
  });
}

export function useSetResourceHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { enabled?: boolean; retentionDays?: number }) =>
      api<{ enabled: boolean; retentionDays: number }>("PUT", "/api/history/resources", patch),
    onSettled: () => {
      for (const key of ["resource-history", "audit"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* ---------- Per service: restarts, resource trends, timeline ---------- */

export function useServiceRestarts(serviceId: string) {
  return useLiveQuery({
    queryKey: ["restarts", serviceId],
    queryFn: () =>
      api<{ events: ContainerEventView[] }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/restarts`,
      ),
    refetchInterval: 60_000,
  });
}

export interface ResourcePoint {
  hour: string;
  samples: number;
  cpuAvgPct?: number;
  cpuMaxPct?: number;
  memoryAvgMb?: number;
  memoryMaxMb?: number;
  memoryLimitMb?: number;
}

export function useServiceResources(serviceId: string, hours: number) {
  return useLiveQuery({
    queryKey: ["service-resources", serviceId, hours],
    queryFn: () =>
      api<{ hours: number; points: ResourcePoint[] }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/history?hours=${hours}`,
      ),
    refetchInterval: 5 * 60_000,
  });
}

export function useServiceTimeline(serviceId: string, days: number) {
  return useLiveQuery({
    queryKey: ["timeline", serviceId, days],
    queryFn: () =>
      api<{ days: number; events: TimelineEvent[] }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/timeline?days=${days}`,
      ),
    refetchInterval: 60_000,
  });
}

export interface RestartHistoryInfo {
  enabled: boolean;
  retentionDays: number;
  sweepMinutes: number;
  retentionChoices: number[];
  keepPerService: number;
  stored: { rows: number; bytes: number; oldest?: string };
}

export function useRestartHistory() {
  return useQuery({
    queryKey: ["restart-history"],
    queryFn: () => api<RestartHistoryInfo>("GET", "/api/history/restarts"),
  });
}

export function useSetRestartHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { enabled?: boolean; retentionDays?: number }) =>
      api<{ enabled: boolean; retentionDays: number }>("PUT", "/api/history/restarts", patch),
    onSettled: () => {
      for (const key of ["restart-history", "audit"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
