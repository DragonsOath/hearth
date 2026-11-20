import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_CREDENTIAL_SCOPE,
  type AppReport,
  type CredentialScope,
  type CredentialStatus,
} from "@dragon-control/core";
import { api } from "./api";

/**
 * The credential broker's view, per service (never values), and the ways to
 * give Hearth a credential: typed into the vault form (sent straight
 * to the vault, never into a conversation) or imported from the app's own
 * settings file when you ask.
 */

export function useCredentials() {
  return useQuery({
    queryKey: ["credentials"],
    queryFn: () => api<CredentialStatus[]>("GET", "/api/credentials"),
    staleTime: 15_000,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["credentials", "vault", "workspace", "diagnostics", "audit"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** Saves a credential for a service (new, or a replacement value), then reads the app with it. */
export function useSaveCredential() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: {
      status: CredentialStatus;
      value: string;
      username?: string;
      scope: "read" | "approved-changes";
    }) => {
      const existing = v.status.secret;
      if (existing) {
        await api("PATCH", `/api/vault/secrets/${encodeURIComponent(existing.id)}`, {
          value: v.value,
          scope: v.scope,
          ...(v.username !== undefined ? { username: v.username } : {}),
        });
      } else {
        await api("POST", "/api/vault/secrets", {
          name: `${v.status.serviceName} ${v.status.need.label}`,
          kind: v.status.need.kind,
          tier: "automation",
          serviceId: v.status.serviceId,
          value: v.value,
          scope: v.scope,
          ...(v.username ? { username: v.username } : {}),
        });
      }
      // Try it straight away: the answer says whether it works.
      return api<AppReport>(
        "POST",
        `/api/services/${encodeURIComponent(v.status.serviceId)}/app/check`,
        {},
      );
    },
    onSettled: refresh,
  });
}

export function useCredentialScope() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { secretId: string; scope: "read" | "approved-changes" }) =>
      api("PATCH", `/api/vault/secrets/${encodeURIComponent(v.secretId)}`, { scope: v.scope }),
    onSettled: refresh,
  });
}

export function useImportCredential() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { serviceId: string; source: string; scope?: CredentialScope }) =>
      api<{ name: string }>("POST", `/api/credentials/${encodeURIComponent(v.serviceId)}/import`, {
        source: v.source,
        ...(v.scope ? { scope: v.scope } : {}),
      }),
    onSettled: refresh,
  });
}

/** Find my keys: imports every missing key that an app's own settings file holds (needs a recent confirm). */
export function useFindKeys() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (scope: CredentialScope = DEFAULT_CREDENTIAL_SCOPE) =>
      api<{ results: { serviceId: string; serviceName: string; imported: boolean; note: string }[] }>(
        "POST",
        "/api/credentials/find-keys",
        { scope },
      ),
    onSettled: refresh,
  });
}
