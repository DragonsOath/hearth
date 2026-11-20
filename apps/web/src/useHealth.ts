import { useQuery } from "@tanstack/react-query";
import type { HealthReport } from "@dragon-control/core";

export type HealthState =
  | { kind: "loading" }
  | { kind: "ready"; report: HealthReport }
  | { kind: "unreachable"; message: string };

async function fetchHealth(): Promise<HealthReport> {
  const res = await fetch("/api/health", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return (await res.json()) as HealthReport;
}

export function useHealth(pollMs = 10_000) {
  const query = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: pollMs,
    retry: 1,
  });

  // Prefer fresh data; fall back to an error only once nothing usable is cached.
  const state: HealthState = query.data
    ? { kind: "ready", report: query.data }
    : query.error
      ? { kind: "unreachable", message: query.error.message }
      : { kind: "loading" };

  return { state, refresh: () => void query.refetch() };
}
