import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** Saved desktop layouts: which panels were open and how the conversation dock sat. */
export interface DeskLayout {
  id: string;
  name: string;
  panels: string;
  dock?: { width?: number; mode?: "docked" | "min" | "wide" };
  updatedAt: string;
}

export function useDeskLayouts() {
  return useQuery({
    queryKey: ["desk-layouts"],
    queryFn: () => api<DeskLayout[]>("GET", "/api/desk/layouts"),
  });
}

export function useSaveDeskLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; panels: string; dock?: DeskLayout["dock"] }) =>
      api<DeskLayout>("POST", "/api/desk/layouts", body),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["desk-layouts"] }),
  });
}

export function useDeleteDeskLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/desk/layouts/${encodeURIComponent(id)}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["desk-layouts"] }),
  });
}
