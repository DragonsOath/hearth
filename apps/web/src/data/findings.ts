import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AnalyzerCoverage,
  DashboardBriefing,
  Finding,
  FindingDetail,
} from "@dragon-control/core";
import { api } from "./api";

/**
 * Findings: what Hearth's analyzers and Ember have found, and the dashboard briefing built
 * from them. The owner's decisions (seen, snooze, dismiss) go through here; resolving is
 * Hearth's recheck.
 */

export function useDashboardBriefing(since: string | undefined) {
  return useQuery({
    queryKey: ["findings", "briefing", since],
    queryFn: () =>
      api<DashboardBriefing>(
        "GET",
        `/api/findings/briefing${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      ),
    refetchInterval: 20_000,
  });
}

export function useFindings(
  status: "active" | "resolved" | "dismissed" | "accepted" | "all" = "active",
) {
  return useQuery({
    queryKey: ["findings", "list", status],
    queryFn: () => api<Finding[]>("GET", `/api/findings?status=${status}`),
    refetchInterval: 20_000,
  });
}

export function useFinding(id: string | undefined) {
  return useQuery({
    queryKey: ["findings", "item", id],
    queryFn: () => api<FindingDetail>("GET", `/api/findings/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

export function useCoverage() {
  return useQuery({
    queryKey: ["findings", "coverage"],
    queryFn: () => api<AnalyzerCoverage[]>("GET", "/api/findings/coverage"),
    refetchInterval: 60_000,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["findings"] });
  };
}

export type FindingAction =
  | { type: "acknowledge" }
  | { type: "snooze"; hours: number }
  | { type: "dismiss"; reason?: string }
  | { type: "reopen" }
  | { type: "accept"; note?: string }
  | { type: "unaccept" };

export function useFindingAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: FindingAction }) => {
      const { type, ...body } = action;
      return api<FindingDetail>(
        "POST",
        `/api/findings/${encodeURIComponent(id)}/${type}`,
        Object.keys(body).length ? body : undefined,
      );
    },
    onSettled: invalidate,
  });
}

/** Marks the finding as being investigated and returns what to say to Ember. */
export function useInvestigate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ finding: FindingDetail; prompt: string }>(
        "POST",
        `/api/findings/${encodeURIComponent(id)}/investigate`,
      ),
    onSettled: invalidate,
  });
}

export function useFindingToTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ todoId: string; number?: number }>(
        "POST",
        `/api/findings/${encodeURIComponent(id)}/todo`,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["findings"] });
      void queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

export function useRefreshFindings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api<{ ran: boolean }>("POST", "/api/findings/refresh"),
    onSettled: invalidate,
  });
}
