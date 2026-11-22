import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HomeRow, HomeRowInput } from "@dragon-control/core";
import { api } from "./api";

/** Home Rows (design "Home Rows: design for DC"): the owner's rows and what Plex offers. */

export interface HomeRowHub {
  id: string;
  title: string;
  recommended: boolean;
  home: boolean;
  shared: boolean;
  /** Set when the row is one of Hearth's (the saved row's id). */
  hearth?: string;
}

export interface HomeRowsOptions {
  /** Each library with its folders: one is merged into another when the other reads them all. */
  libraries: {
    id: string;
    title: string;
    type: string;
    folders?: string[];
    /** Plex's Visibility: "0" Home and search, "1" not Home, "2" sidebar only. */
    visibility?: string;
  }[];
  /** Plex's Merge Recently Added Items (null: this Plex has no such setting). */
  merge?: boolean | null;
  /** Recently Released goes by home release, not theaters (11-13). */
  digitalDates?: boolean;
  genres: Record<string, string[]>;
  rows: Record<string, HomeRowHub[]>;
  /** Every collection per library; `row` is its row's id when it is one already. */
  collections: Record<string, { key: string; title: string; count: number; row?: string }[]>;
}

export interface HomeRowPreview {
  titles: { ratingKey: string; title: string; year?: number; sub?: string; thumb?: string }[];
  total: number;
}

const q = (serviceId: string) => `serviceId=${encodeURIComponent(serviceId)}`;

export function useHomeRows(serviceId: string | undefined) {
  return useQuery({
    queryKey: ["home-rows", serviceId],
    queryFn: () => api<HomeRow[]>("GET", `/api/home-rows?${q(serviceId!)}`),
    enabled: Boolean(serviceId),
  });
}

export function useHomeRowOptions(serviceId: string | undefined) {
  return useQuery({
    queryKey: ["home-rows-options", serviceId],
    queryFn: () => api<HomeRowsOptions>("GET", `/api/home-rows/options?${q(serviceId!)}`),
    enabled: Boolean(serviceId),
    retry: false,
  });
}

/** The posters matching the rules as they stand (debounced by the caller). */
export function useHomeRowPreview(input: HomeRowInput | undefined) {
  return useQuery({
    queryKey: ["home-rows-preview", input],
    queryFn: () => api<HomeRowPreview>("POST", "/api/home-rows/preview", input),
    enabled: Boolean(input?.serviceId && input.libraryId && input.name),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Titles in a library by name, to hand-pick for a row. */
export function useHomeRowSearch(serviceId: string, libraryId: string, words: string) {
  const q = words.trim();
  return useQuery({
    queryKey: ["home-rows-search", serviceId, libraryId, q],
    queryFn: () =>
      api<{ titles: HomeRowPreview["titles"] }>(
        "GET",
        `/api/home-rows/search?serviceId=${encodeURIComponent(serviceId)}&libraryId=${encodeURIComponent(libraryId)}&q=${encodeURIComponent(q)}`,
      ),
    enabled: Boolean(serviceId && libraryId && q.length >= 2),
    placeholderData: keepPreviousData,
  });
}

export function useSaveHomeRow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, row }: { id?: string; row: HomeRowInput }) =>
      id
        ? api<HomeRow>("PUT", `/api/home-rows/${encodeURIComponent(id)}`, row)
        : api<HomeRow>("POST", "/api/home-rows", row),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-rows"] }),
  });
}

export function useDeleteHomeRow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/api/home-rows/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-rows"] }),
  });
}

/** Saved home screens (11-06): name one, keep several, switch between them. */
export interface HomeLayout {
  id: string;
  serviceId: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function useHomeLayouts(serviceId: string | undefined) {
  return useQuery({
    queryKey: ["home-layouts", serviceId],
    queryFn: () =>
      api<{ layouts: HomeLayout[]; undoable?: string }>(
        "GET",
        `/api/home-rows/layouts?${q(serviceId!)}`,
      ),
    enabled: Boolean(serviceId),
  });
}

export function useSaveLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { serviceId: string; name: string; id?: string }) =>
      api<HomeLayout>("POST", "/api/home-rows/layouts", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-layouts"] }),
  });
}

export function useRenameLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api("PATCH", `/api/home-rows/layouts/${encodeURIComponent(id)}`, { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-layouts"] }),
  });
}

export function useDeleteLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>("DELETE", `/api/home-rows/layouts/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-layouts"] }),
  });
}


/** A few posters for one row, so the editor looks like Home. */
export function useRowPosters(
  serviceId: string,
  libraryId: string,
  row: string,
  title = "",
  /** Libraries a change not saved yet merges into this one: the row as it will be (11-13). */
  merged: string[] = [],
  /** A full row for the server's Home tab; the editor's few otherwise. */
  count?: number,
) {
  const extra =
    (merged.length ? `&with=${encodeURIComponent(merged.join(","))}` : "") +
    (count ? `&count=${count}` : "");
  return useQuery({
    queryKey: ["home-rows-posters", serviceId, libraryId, row, merged.join(","), count ?? 0],
    queryFn: () =>
      api<HomeRowPreview>(
        "GET",
        `/api/home-rows/posters?${q(serviceId)}&libraryId=${encodeURIComponent(libraryId)}&row=${encodeURIComponent(row)}&title=${encodeURIComponent(title)}${extra}`,
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Continue Watching as Home shows it: every library's in one row, newest library first. */
export function useContinuePosters(serviceId: string, rows: { lib: string; row: string }[]) {
  const qs = useQueries({
    queries: rows.map((r) => ({
      queryKey: ["home-rows-posters", serviceId, r.lib, r.row],
      queryFn: () =>
        api<HomeRowPreview>(
          "GET",
          `/api/home-rows/posters?${q(serviceId)}&libraryId=${encodeURIComponent(r.lib)}&row=${encodeURIComponent(r.row)}&title=${encodeURIComponent("Continue Watching")}`,
        ),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return {
    loading: qs.some((x) => x.isLoading),
    titles: qs.flatMap((x) => x.data?.titles ?? []),
  };
}

/** Plex's Continue Watching across every library, as its Home shows it (11-22). */
export function usePlexContinue(serviceId: string, count = 24) {
  return useQuery({
    queryKey: ["home-rows-continue", serviceId, count],
    queryFn: () =>
      api<HomeRowPreview>(
        "GET",
        `/api/home-rows/continue?${q(serviceId)}&count=${encodeURIComponent(String(count))}`,
      ),
    staleTime: 60_000,
    retry: false,
  });
}

/** Home's library order, as the owner's Plex sidebar has it (Hearth only; Plex is not changed). */
export function useLibraryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { serviceId: string; order: string[] }) =>
      api("PUT", "/api/home-rows/library-order", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home-rows-options"] }),
  });
}

/** Everything read from one server to draw its home screen: what Refresh reads again. */
export function isHomeQuery(key: QueryKey, serviceId: string) {
  const [what, id, , part] = key as unknown[];
  if (id !== serviceId) return false;
  if (
    what === "home-rows" ||
    what === "home-rows-options" ||
    what === "home-rows-posters" ||
    what === "home-layouts"
  )
    return true;
  // Jellyfin and Emby: each person's home screen and what it can show.
  return what === "dashboard" && typeof part === "string" && part.startsWith("home");
}
