import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Capability, HostOperation, HostScope } from "@dragon-control/core";
import { api } from "./api";

/** Host administration (feature request 21): yours to switch on and off, per machine. */

export interface AdminScopes {
  scopes: HostScope[];
  host: { id: string; name: string } | null;
  backupRoot: string;
  docsRoot: string | null;
}

export function useAdminScopes() {
  return useQuery({
    queryKey: ["admin-scopes"],
    queryFn: () => api<AdminScopes>("GET", "/api/admin/scopes"),
  });
}

export function useSetHostScope() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      hostId: string;
      operations: HostOperation[] | null;
      current?: string;
    }) => {
      if (body.operations === null) {
        if (body.current) await api<void>("DELETE", `/api/admin/scopes/${body.current}`);
        return null;
      }
      return api<HostScope>("POST", "/api/admin/scopes", {
        hostId: body.hostId,
        operations: body.operations,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-scopes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** The elevated executor's state and scope (never anything it was asked to do). */
export interface ElevationState {
  available: boolean;
  summary: string;
  status?: {
    operations: string[];
    roots: string[];
    units: string[];
    backupRoot: string;
    auditLog: string;
    problems: string[];
  };
}

export function useElevation() {
  return useQuery({
    queryKey: ["admin-elevation"],
    queryFn: () => api<ElevationState>("GET", "/api/admin/elevation"),
  });
}

export function useCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api<Capability[]>("GET", "/api/admin/capabilities"),
  });
}

export function useDetectCapabilities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<Capability[]>("POST", "/api/admin/capabilities/detect"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  });
}

export function useDismissCapability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("POST", `/api/admin/capabilities/${id}/dismiss`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  });
}
