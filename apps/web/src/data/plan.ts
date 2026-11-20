import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BuildAnswers, GoalChoice, GoalDecisions, HostScan } from "@dragon-control/core";
import { api } from "./api";

/** A saved "Help me build" plan: the answers, the look at the machine, choices, removals. */
export interface SavedPlan {
  answers: BuildAnswers;
  scan?: HostScan;
  chosen: Record<string, string>;
  removed: string[];
  decisions?: GoalDecisions;
  confirmed: boolean;
  savedAt: string;
}

/** The saved plan, and the look at this machine if the owner has allowed one. */
export function usePlan() {
  return useQuery({
    queryKey: ["plan"],
    queryFn: () => api<{ saved: SavedPlan | null; scan: HostScan | null }>("GET", "/api/plan"),
  });
}

/** "Yes, look at this computer": a read-only scan, run only when asked. */
export function useScanComputer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<HostScan>("POST", "/api/plan/scan", {}),
    onSuccess: (scan) =>
      qc.setQueryData(["plan"], (old: { saved: SavedPlan | null } | undefined) => ({
        saved: old?.saved ?? null,
        scan,
      })),
  });
}

/** Start over: forget the plan and the look at the machine. */
export function useStartOver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("DELETE", "/api/plan"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["getting-started"] });
    },
  });
}

/** Saves as they go (so they can stop and come back), and once more when they finish. */
export function useSavePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: {
      answers: BuildAnswers;
      chosen: Record<string, string>;
      removed: string[];
      decisions?: Record<string, GoalChoice>;
      confirmed?: boolean;
    }) => api<SavedPlan>("PUT", "/api/plan", plan),
    onSuccess: (saved) =>
      qc.setQueryData(["plan"], (old: { scan: HostScan | null } | undefined) => ({
        saved,
        scan: saved.scan ?? old?.scan ?? null,
      })),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["getting-started"] }),
  });
}

/** The account details the plan's apps will get (the password itself is never returned). */
export interface PlanAccounts {
  email: string;
  username: string;
  passwords: "generate" | "own";
  savedAt?: string;
}

export function usePlanAccounts() {
  return useQuery({
    queryKey: ["plan-accounts"],
    queryFn: () => api<PlanAccounts | null>("GET", "/api/plan/accounts"),
  });
}

export function useSavePlanAccounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: PlanAccounts & { password?: string }) =>
      api<PlanAccounts>("PUT", "/api/plan/accounts", a),
    onSuccess: (a) => qc.setQueryData(["plan-accounts"], a),
  });
}
