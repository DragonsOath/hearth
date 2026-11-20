import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Workspace groups: everything open on the command center, kept as one restorable group on the
 * server (yours only), so it survives leaving the page, refreshing, and closing the browser.
 */
export interface DeskGroup {
  id: string;
  name: string;
  /** The command center's address for the group, without the group id. */
  search: string;
  conversationId?: string;
  view: Record<string, unknown>;
  /** Decisions made but not yet submitted when last saved. */
  unsent: number;
  createdAt: string;
  updatedAt: string;
}

export type DeskGroupBody = Pick<DeskGroup, "name" | "search" | "view" | "unsent"> & {
  conversationId?: string | null;
};

export function useDeskGroups() {
  return useQuery({
    queryKey: ["desk-groups"],
    queryFn: () => api<DeskGroup[]>("GET", "/api/desk/groups"),
    staleTime: 5_000,
  });
}

/**
 * Saves a group. `keepalive` lets the last save finish while the page is being left or closed.
 * Errors are swallowed by callers that save in the background; the next save tries again.
 */
export async function putDeskGroup(id: string, body: DeskGroupBody, keepalive = false) {
  const res = await fetch(`/api/desk/groups/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `The server responded ${res.status}.`);
  }
  return (await res.json()) as DeskGroup;
}

export function useCloseDeskGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/api/desk/groups/${encodeURIComponent(id)}`),
    onMutate: (id) =>
      qc.setQueryData<DeskGroup[]>(["desk-groups"], (list) => list?.filter((g) => g.id !== id)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["desk-groups"] }),
  });
}
