import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BuildAnswers,
  GoalChoice,
  GoalDecisions,
  HomelabBuild,
  HomelabStepId,
  HostScan,
  Job,
  VpnProvider,
} from "@dragon-control/core";
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

/* ---------- Build my plan ---------- */

/** Where building the plan stands: every step, what it needs, and the next one. */
export function useHomelabBuild(enabled = true) {
  return useQuery({
    queryKey: ["plan-build"],
    enabled,
    queryFn: () => api<HomelabBuild>("GET", "/api/plan/build"),
    // While a step waits or runs, the list keeps up on its own.
    refetchInterval: (q) =>
      q.state.data?.steps.some((s) => s.status === "running" || s.status === "awaiting-approval")
        ? 4_000
        : 20_000,
  });
}

/** Makes the next step (or a named one) a plan to approve. */
export function useProposeBuildStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (step?: HomelabStepId) =>
      api<Job>("POST", "/api/plan/build/propose", step ? { step } : {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["plan-build"] }),
  });
}

/** The owner checked a failed step's app and it works: a plan to mark it done (approved). */
export function useConfirmBuildStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (step: HomelabStepId) => api<Job>("POST", "/api/plan/build/confirm", { step }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["plan-build"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

/** The VPN login for downloads: straight into Secure Vault, never shown back. */
export function useSaveBuildVpn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: {
      provider: VpnProvider;
      type: "openvpn" | "wireguard";
      username?: string;
      password?: string;
      privateKey?: string;
      addresses?: string;
    }) => api<{ provider: VpnProvider; type: string }>("PUT", "/api/plan/build/vpn", b),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["plan-build"] }),
  });
}

/** The hand-off: Ember greets the owner and starts building, in a conversation. */
export function useStartBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ conversationId: string }>("POST", "/api/plan/build/start", {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["plan-build"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useTailscaleLink() {
  return useMutation({
    mutationFn: () => api<{ url: string | null }>("POST", "/api/plan/build/tailscale-link", {}),
  });
}
