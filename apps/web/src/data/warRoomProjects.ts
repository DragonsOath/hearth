import { useQueries } from "@tanstack/react-query";
import type { ProjectColor } from "@dragon-control/core";
import { api } from "./api";
import { pcLook, usePcs } from "./pcs";
import { useEmberLink } from "../pages/WarRoom";

/** Which PC something lives on, and how that PC looks (its icon and color). */
export interface PcBadge {
  /** null: this Hearth (the hub). */
  pc: string | null;
  name: string;
  src: string | null;
  color: string;
}

/** A War Room project, as Home lists it. */
export interface WarRoomProject {
  slug: string;
  name: string;
  description: string;
  /** Made in Hearth (false for the built-in Sandbox). */
  created: boolean;
  homelab?: boolean;
  /** The old Homelab project, kept only to read its conversation. */
  archived?: boolean;
  messages: number;
  active: number;
  last: string | null;
  /** Its color on Home, when the owner chose one. */
  color?: ProjectColor;
  /** The PC it lives on. */
  where: PcBadge;
}

type Row = Omit<WarRoomProject, "where">;

/**
 * The War Room's projects on every PC in your Hearth, for Home's "Active projects" (10-30):
 * the most recently used first, each with the PC it lives on. The built-in Sandbox and the old
 * Homelab project are left out. A PC that is offline is skipped until it is back.
 */
export function useWarRoomProjects() {
  const link = useEmberLink();
  const on = Boolean(link.data?.configured && link.data.reachable);
  const pcs = usePcs();
  const hub = pcs.data?.hub;
  const machines: PcBadge[] = [
    {
      pc: null,
      name: hub?.name ?? "This PC",
      ...(hub ? pcLook(hub) : { src: null, color: "var(--color-muted)" }),
    },
    ...(pcs.data?.pcs ?? [])
      .filter((p) => p.online)
      .map((p) => ({ pc: p.id, name: p.name, ...pcLook(p) })),
  ];
  const lists = useQueries({
    queries: machines.map((m) => ({
      queryKey: ["war-room-projects", m.pc ?? "hub"],
      queryFn: () =>
        api<Row[]>("GET", m.pc ? `/api/on/${m.pc}/engine/projects` : "/api/engine/projects"),
      enabled: on && (m.pc === null || pcs.isSuccess),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const data = machines
    .flatMap((m, i) => (lists[i]?.data ?? []).map((p) => ({ ...p, where: m })))
    .filter((p) => p.created && !p.archived)
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""));
  return { data, isLoading: lists.some((l) => l.isLoading) };
}

/** Where a War Room project opens: the War Room on its PC, with that project open. */
export const warRoomProjectHref = (slug: string, pc: string | null = null) =>
  `/war-room?project=${encodeURIComponent(slug)}&pc=${encodeURIComponent(pc ?? "hub")}`;
