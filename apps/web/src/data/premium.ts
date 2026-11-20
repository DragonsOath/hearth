import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PremiumGrantScope, PremiumStatus } from "@dragon-control/core";
import { api } from "./api";

/** Hearth Premium (docs/design/PREMIUM.md): what this installation has, and the owner's grants. */

export function usePremium() {
  return useQuery({
    queryKey: ["premium"],
    queryFn: () => api<PremiumStatus>("GET", "/api/premium"),
    staleTime: 30_000,
  });
}

const refresh = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ["premium"] });
  void qc.invalidateQueries({ queryKey: ["premium-issuer"] });
  void qc.invalidateQueries({ queryKey: ["show-settings"] });
};

/** A licence key someone sent: checked by Hearth before anything counts. */
export function useAddLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api<PremiumStatus>("POST", "/api/premium/license", { key }),
    onSuccess: (s) => {
      qc.setQueryData(["premium"], s);
      refresh(qc);
    },
  });
}

export function useRedeem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api<PremiumStatus>("POST", "/api/premium/redeem", { code }),
    onSuccess: (s) => {
      qc.setQueryData(["premium"], s);
      refresh(qc);
    },
  });
}

export interface IssuerGrant {
  id: string;
  recipient: string;
  audience: string;
  note: string | null;
  scope: PremiumGrantScope[];
  kind: string;
  startsAt: string;
  endsAt: string | null;
  installId: string | null;
  codeId: string | null;
  status: string;
  state: "active" | "expired" | "scheduled" | "revoked";
  createdAt: string;
}
export interface IssuerCode {
  id: string;
  hint: string;
  campaign: string | null;
  audience: string;
  note: string | null;
  scope: PremiumGrantScope[];
  durationDays: number | null;
  expiresAt: string | null;
  maxUses: number;
  uses: number;
  remaining: number;
  active: boolean;
  state: "active" | "off" | "expired" | "used up";
  createdAt: string;
}
export interface IssuerView {
  active: boolean;
  publicKey?: string;
  keyId?: string;
  /** It had a signing key, but the vault no longer has it: restore the saved copy. */
  keyMissing?: boolean;
  grants: IssuerGrant[];
  codes: IssuerCode[];
}

export function useIssuer(enabled: boolean) {
  return useQuery({
    queryKey: ["premium-issuer"],
    queryFn: () => api<IssuerView>("GET", "/api/premium/issuer"),
    enabled,
  });
}

export function useIssuerAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { url: string; body?: unknown }) =>
      api<unknown>("POST", `/api/premium/issuer${a.url}`, a.body ?? {}),
    onSuccess: () => refresh(qc),
  });
}
