import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MemoryEntry,
  WorkspaceState,
  WorkspaceSummary,
  WorkspaceView,
} from "@dragon-control/core";
import { ApiError, api } from "./api";
import { useLiveQuery } from "../components/panels/lifecycle";

/**
 * Interactive workspaces: panels Ember opens beside a conversation. Your choices are
 * saved on the server as you make them, so a refresh or another device picks up where you were.
 */

export function useWorkspaces(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["workspaces", "list", conversationId],
    queryFn: () =>
      api<WorkspaceSummary[]>(
        "GET",
        `/api/workspaces?conversationId=${encodeURIComponent(conversationId!)}`,
      ),
    enabled: Boolean(conversationId),
    refetchInterval: 5_000,
  });
}

/** `live`: re-read every 10 s (the Forge's waiting count follows sheets Ember opens). */
export function useSavedWorkspaces(live = false) {
  return useQuery({
    queryKey: ["workspaces", "saved"],
    queryFn: () => api<WorkspaceSummary[]>("GET", "/api/workspaces?kind=saved"),
    refetchInterval: live ? 10_000 : false,
  });
}

export function useWorkspace(id: string | undefined) {
  return useLiveQuery({
    queryKey: ["workspaces", "one", id],
    queryFn: () => api<WorkspaceView>("GET", `/api/workspaces/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    // Ember may change the list while you talk.
    refetchInterval: 4_000,
    retry: (n, error) => (error as { status?: number }).status !== 404 && n < 2,
  });
}

function useWorkspaceMutation<A>(fn: (arg: A) => Promise<WorkspaceView | void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => {
      if (view) queryClient.setQueryData(["workspaces", "one", view.id], view);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["workspaces", "list"] }),
  });
}

export function useSelectInWorkspace(id: string) {
  return useWorkspaceMutation((changes: Record<string, string | null>) =>
    api<WorkspaceView>("PUT", `/api/workspaces/${encodeURIComponent(id)}/selections`, changes),
  );
}

/** A title from the whole library added to a pick sheet, selected (the Forge's search). */
export function useAddToPick(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: {
      id: string;
      values: Record<string, string | number | null>;
      image?: string;
    }) =>
      api<{ view: WorkspaceView; added: boolean }>(
        "POST",
        `/api/workspaces/${encodeURIComponent(id)}/items`,
        item,
      ),
    onSuccess: (r) => queryClient.setQueryData(["workspaces", "one", r.view.id], r.view),
  });
}

/** The whole library, searched forgivingly (Home rows' catalog of a Plex). */
export interface LibraryTitle {
  ratingKey: string;
  title: string;
  year?: number;
  kind: "movie" | "show";
  genres?: string[];
  rating?: number;
  thumb?: string;
}

export function useSubmitWorkspace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<WorkspaceView>("POST", `/api/workspaces/${encodeURIComponent(id)}/submit`),
    onSuccess: (view) => {
      queryClient.setQueryData(["workspaces", "one", view.id], view);
      // The submission continues the conversation.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useWorkspaceState() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: WorkspaceState }) =>
      api<WorkspaceView>("POST", `/api/workspaces/${encodeURIComponent(id)}/state`, { state }),
    // Shown at once everywhere (the minimized chips), before the server answers.
    onMutate: ({ id, state }) => {
      queryClient.setQueriesData<WorkspaceSummary[]>({ queryKey: ["workspaces", "list"] }, (list) =>
        list?.map((w) => (w.id === id ? { ...w, state } : w)),
      );
    },
    onSuccess: (view) => queryClient.setQueryData(["workspaces", "one", view.id], view),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["workspaces", "list"] }),
  });
}

/** Save as a working file: the whole interactive workspace, kept in Saved work. */
export function useSaveWorkspace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string; folder?: string }) =>
      api<WorkspaceView>("POST", `/api/workspaces/${encodeURIComponent(id)}/save`, input),
    onSuccess: (view) => {
      queryClient.setQueryData(["workspaces", "one", view.id], view);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

/** Save as a note: what it found, as reference in Memory. The workspace is unchanged. */
export function useSaveWorkspaceNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) =>
      api<MemoryEntry>("POST", `/api/workspaces/${encodeURIComponent(id)}/note`, { title }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["memory"] }),
  });
}

/** Your edits: name, description, folder (null takes it out of its folder). */
export function useEditWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      title?: string;
      description?: string;
      folder?: string | null;
    }) => api<WorkspaceView>("PATCH", `/api/workspaces/${encodeURIComponent(id)}`, patch),
    onSuccess: (view) => {
      queryClient.setQueryData(["workspaces", "one", view.id], view);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

/** Every temporary workspace, in any conversation (Saved work lists them separately). */
export function useTemporaryWorkspaces(live = false) {
  return useQuery({
    queryKey: ["workspaces", "temporary"],
    queryFn: () => api<WorkspaceSummary[]>("GET", "/api/workspaces?kind=temporary"),
    refetchInterval: live ? 10_000 : false,
  });
}

/** The deliberate delete of a saved working file (closing one never deletes it). */
export function useDeleteWorkingFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>("DELETE", `/api/workspaces/${encodeURIComponent(id)}?saved=1`),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: ["workspaces", "one", id] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useDiscardWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    // Already gone (discarded elsewhere, or tidied away while this panel still showed it): that is
    // what closing asked for, so the panel closes instead of the button doing nothing.
    mutationFn: async (id: string) => {
      try {
        await api<void>("DELETE", `/api/workspaces/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: ["workspaces", "one", id] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}
