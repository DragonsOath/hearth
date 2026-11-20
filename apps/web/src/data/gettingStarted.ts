import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GettingStarted } from "@dragon-control/core";
import { api } from "./api";

/** Getting started: built by the server from what is really set up (see store/getting-started.ts). */
export function useGettingStarted() {
  return useQuery({
    queryKey: ["getting-started"],
    queryFn: () => api<GettingStarted>("GET", "/api/getting-started"),
    // Steps tick themselves as things get set up elsewhere in the app.
    refetchInterval: 30_000,
  });
}

export function useUpdateGettingStarted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: { dismiss?: string; restore?: string; hidden?: boolean }) =>
      api<void>("PATCH", "/api/getting-started", change),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["getting-started"] }),
  });
}

/** Meet Ember: starts the conversation where the AI introduces itself and checks up on the server. */
export function useMeetCove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ conversationId: string }>("POST", "/api/agent/meet", {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["getting-started"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
