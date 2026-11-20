import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pcIcon } from "@dragon-control/core";
import { api } from "./api";
import type { HearthAddress } from "./devices";

/** A PC in your Hearth (or your Hearth itself, id "hub"). */
export interface PcInfo {
  id: string;
  name: string;
  os: string;
  version: string;
  /** "preset:<id>" or "image:<ext>:<stamp>"; null until you pick one. */
  icon: string | null;
  color: string | null;
  online?: boolean;
  joinedAt?: string;
  lastSeenAt?: string | null;
  canUninstall?: boolean;
}

export interface PcList {
  hub: PcInfo;
  pcs: PcInfo[];
  /** Set when this PC belongs to another Hearth. */
  joinedTo: { name: string; url: string; online: boolean; pcId?: string } | null;
}

export function usePcs(opts: { watch?: boolean } = {}) {
  return useQuery({
    queryKey: ["pcs"],
    queryFn: () => api<PcList>("GET", "/api/pcs"),
    ...(opts.watch ? { refetchInterval: 3000 } : {}),
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["pcs"] });
}

export function useUpdatePc() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; name?: string; icon?: string; color?: string }) =>
      api("PATCH", `/api/pcs/${v.id}`, {
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.icon ? { icon: v.icon } : {}),
        ...(v.color ? { color: v.color } : {}),
      }),
    onSettled: refresh,
  });
}

export function useUploadPcIcon() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; type: string; data: string; color: string }) =>
      api("PUT", `/api/pcs/${v.id}/icon`, { type: v.type, data: v.data, color: v.color }),
    onSettled: refresh,
  });
}

export function useRemovePc() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/pcs/${id}`),
    onSettled: refresh,
  });
}

export function useUninstallPc() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: {
      id: string;
      confirmName: string;
      deleteData: boolean;
      leaveWaiting?: boolean;
    }) =>
      api<{ ok: boolean; message: string; needsChoice?: "leave-waiting" }>(
        "POST",
        `/api/pcs/${v.id}/uninstall`,
        {
          confirmName: v.confirmName,
          deleteData: v.deleteData,
          ...(v.leaveWaiting ? { leaveWaiting: true } : {}),
        },
      ),
    onSettled: refresh,
  });
}

export interface JoinLinks {
  code: string;
  expiresAt: string;
  localOnly: boolean;
  links: (HearthAddress & { joinLink: string; commands: { linux: string; windows: string } })[];
}

/** Link another Hearth: a join link and the one command per system (needs a fresh "it's you"). */
export function useJoinLinks() {
  return useMutation({ mutationFn: () => api<JoinLinks>("POST", "/api/pcs/codes", {}) });
}

/** Where a PC's icon picture is, and its name's color. */
export function pcLook(pc: Pick<PcInfo, "id" | "icon" | "color">): {
  src: string | null;
  color: string;
} {
  const preset = pc.icon?.startsWith("preset:") ? pcIcon(pc.icon.slice(7)) : undefined;
  if (preset) return { src: `/pc-icons/${preset.id}.webp`, color: pc.color ?? preset.color };
  if (pc.icon?.startsWith("image:"))
    return {
      src: `/api/pcs/${pc.id}/icon?v=${encodeURIComponent(pc.icon.split(":")[2] ?? "")}`,
      color: pc.color ?? "#ff9124",
    };
  return { src: null, color: pc.color ?? "var(--color-muted)" };
}

/**
 * How to mark a system's PC: given a system's PC id (none: this Hearth), its look. Only once
 * your Hearth has other PCs; with one PC there is nothing to tell apart.
 */
export function usePcMarks(): (pcId?: string) => (ReturnType<typeof pcLook> & { name: string }) | null {
  const q = usePcs();
  const data = q.data;
  if (!data || !data.pcs.length) return () => null;
  return (pcId) => {
    const pc = pcId ? data.pcs.find((p) => p.id === pcId) : data.hub;
    return pc ? { ...pcLook(pc), name: pc.name } : null;
  };
}
