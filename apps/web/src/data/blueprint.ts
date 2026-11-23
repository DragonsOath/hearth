import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BlueprintImportResult,
  BlueprintCloud,
  BlueprintImportPreview,
  BlueprintStatus,
} from "@dragon-control/core";
import { api } from "./api";

/** The Lab Blueprint (Settings > Backups): status, its readable text, and the owner's steps. */
export function useBlueprint() {
  return useQuery({
    queryKey: ["blueprint"],
    queryFn: () => api<BlueprintStatus>("GET", "/api/blueprint"),
  });
}

export function useBlueprintPreview(enabled: boolean) {
  return useQuery({
    queryKey: ["blueprint", "preview"],
    queryFn: () => api<{ markdown: string }>("GET", "/api/blueprint/preview"),
    enabled,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["blueprint"] });
}

/** Where versions go: a folder's path, or cloud storage with its login (sent once, kept in the vault). */
export type BlueprintTargetInput =
  | { destination: string }
  | { cloud: BlueprintCloud; username: string; secret: string };

export function useBlueprintSetupStart() {
  return useMutation({
    mutationFn: (target: BlueprintTargetInput) =>
      api<{ recoveryKey: string; keyId: string; where: string; sameDrive?: boolean }>(
        "POST",
        "/api/blueprint/setup/start",
        target,
      ),
  });
}

export function useBlueprintSetupConfirm() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (recoveryKey: string) =>
      api<BlueprintStatus>("POST", "/api/blueprint/setup/confirm", { recoveryKey }),
    onSuccess: refresh,
  });
}

export function useBlueprintUpdate() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () =>
      api<{ result: "written" | "unchanged"; status: BlueprintStatus }>(
        "POST",
        "/api/blueprint/update",
        {},
      ),
    onSuccess: refresh,
  });
}

export function useBlueprintTestKey() {
  return useMutation({
    mutationFn: (recoveryKey: string) =>
      api<{ ok: true; file: string; writtenAt: string; apps: number; entries: number }>(
        "POST",
        "/api/blueprint/test-key",
        { recoveryKey },
      ),
  });
}

export function useBlueprintNotes() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (notes: string) => api<BlueprintStatus>("PUT", "/api/blueprint/notes", { notes }),
    onSuccess: refresh,
  });
}

export function useBlueprintTurnOff() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api<void>("DELETE", "/api/blueprint"),
    onSuccess: refresh,
  });
}

export function useBlueprintImportOpen() {
  return useMutation({
    mutationFn: (v: { file: string; recoveryKey: string }) =>
      api<BlueprintImportPreview>("POST", "/api/blueprint/import/open", v),
  });
}

export function useBlueprintImportApply() {
  const refresh = useRefresh();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; names: string[]; movePremium?: boolean }) =>
      api<BlueprintImportResult>("POST", "/api/blueprint/import/apply", v),
    onSuccess: (r) => {
      refresh();
      // Premium moved here: its setup (package, reload, Welcome) shows on every page.
      if (r.premium?.state === "moved") void qc.invalidateQueries({ queryKey: ["premium"] });
    },
  });
}
