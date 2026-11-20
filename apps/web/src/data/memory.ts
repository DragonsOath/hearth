import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BackupRecord,
  BackupStatus,
  CompanionBriefing,
  ImportDraft,
  ImportPayload,
  ImportSummary,
  MemoryBasis,
  MemoryEntry,
  MemoryKind,
  MemoryProject,
  MemoryRevision,
  MemorySearchHit,
  Transcript,
  TranscriptMessage,
} from "@dragon-control/core";
import { api } from "./api";

/** The homelab memory and its backups. */

export interface EntryInput {
  kind: MemoryKind;
  title: string;
  body?: string;
  projectId?: string | null;
  status?: "open" | "done" | null;
  happenedAt?: string;
  basis?: MemoryBasis;
  machine?: string | null;
  superseded?: { at: string; reason: string } | null;
}

function useInvalidateMemory() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["memory"] });
  };
}

export function useMemoryEntries(filter: {
  kind?: MemoryKind;
  projectId?: string;
  status?: "open" | "done";
  view?: "active" | "deleted";
}) {
  const params = new URLSearchParams(
    Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])),
  );
  return useQuery({
    queryKey: ["memory", "entries", filter],
    queryFn: () => api<MemoryEntry[]>("GET", `/api/memory/entries?${params}`),
  });
}

export function useMemoryEntry(id: string | undefined) {
  return useQuery({
    queryKey: ["memory", "entry", id],
    queryFn: () =>
      api<{ entry: MemoryEntry; history: MemoryRevision[] }>(
        "GET",
        `/api/memory/entries/${encodeURIComponent(id!)}`,
      ),
    enabled: Boolean(id),
  });
}

export function useMemorySearch(q: string) {
  const text = q.trim();
  return useQuery({
    queryKey: ["memory", "search", text],
    queryFn: () =>
      api<MemorySearchHit[]>("GET", `/api/memory/search?q=${encodeURIComponent(text)}`),
    enabled: text.length > 0,
    placeholderData: (prev) => prev,
  });
}

export function useMemoryProjects() {
  return useQuery({
    queryKey: ["memory", "projects"],
    queryFn: () => api<MemoryProject[]>("GET", "/api/memory/projects"),
  });
}

export function useTranscripts() {
  return useQuery({
    queryKey: ["memory", "transcripts"],
    queryFn: () => api<Transcript[]>("GET", "/api/memory/transcripts"),
  });
}

export function useTranscript(id: string | undefined) {
  return useQuery({
    queryKey: ["memory", "transcript", id],
    queryFn: () =>
      api<{ transcript: Transcript; messages: TranscriptMessage[] }>(
        "GET",
        `/api/memory/transcripts/${encodeURIComponent(id!)}`,
      ),
    enabled: Boolean(id),
  });
}

export function useSaveEntry() {
  const invalidate = useInvalidateMemory();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<EntryInput> }) =>
      id
        ? api<MemoryEntry>("PATCH", `/api/memory/entries/${encodeURIComponent(id)}`, input)
        : api<MemoryEntry>("POST", "/api/memory/entries", input),
    onSuccess: invalidate,
  });
}

export function useEntryAction() {
  const invalidate = useInvalidateMemory();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "delete" | "restore" | "forever" }) => {
      const url = `/api/memory/entries/${encodeURIComponent(id)}`;
      return action === "restore"
        ? api("POST", `${url}/restore`, {})
        : api("DELETE", action === "forever" ? `${url}/forever` : url);
    },
    onSuccess: invalidate,
  });
}

export function useSaveProject() {
  const invalidate = useInvalidateMemory();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id?: string;
      input: { name?: string; summary?: string; status?: MemoryProject["status"] };
    }) =>
      id
        ? api<MemoryProject>("PATCH", `/api/memory/projects/${encodeURIComponent(id)}`, input)
        : api<MemoryProject>("POST", "/api/memory/projects", input),
    onSuccess: invalidate,
  });
}

export function useBackups() {
  return useQuery({
    queryKey: ["backups"],
    queryFn: () => api<BackupStatus>("GET", "/api/backups"),
  });
}

export function useRunBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<BackupRecord>("POST", "/api/backups/run", {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });
}

/** The keys to keep in your password manager. Needs a recent identity check. */
export function useBackupKeys() {
  return useMutation({
    mutationFn: () =>
      api<{ backupKey: string; vaultKey?: string }>("POST", "/api/backups/keys", {}),
  });
}

/** The briefing a companion reads; Home shows its opening points. */
export function useBriefing(since: string | undefined) {
  return useQuery({
    queryKey: ["memory", "briefing", since],
    queryFn: () =>
      api<CompanionBriefing>(
        "GET",
        `/api/companion/briefing${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      ),
  });
}

/* ---------- Import review ---------- */

export type ImportEdits = Partial<Extract<ImportPayload, { kind: "entry" }>["entry"]>;

export function useImportSummary() {
  return useQuery({
    queryKey: ["memory", "imports", "summary"],
    queryFn: () => api<ImportSummary>("GET", "/api/memory/imports/summary"),
  });
}

export function useImportDrafts(status: ImportDraft["status"]) {
  return useQuery({
    queryKey: ["memory", "imports", "list", status],
    queryFn: () => api<ImportDraft[]>("GET", `/api/memory/imports?status=${status}`),
  });
}

export function useImportDraft(id: string | undefined) {
  return useQuery({
    queryKey: ["memory", "imports", "draft", id],
    queryFn: () => api<ImportDraft>("GET", `/api/memory/imports/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useImportDecision() {
  const invalidate = useInvalidateMemory();
  return useMutation({
    mutationFn: (
      d:
        | { action: "accept"; id: string; edits?: ImportEdits; asCurrent?: boolean }
        | { action: "reject" | "reopen"; id: string }
        | { action: "decide"; ids: string[]; decision: "accept" | "reject" },
    ) =>
      d.action === "decide"
        ? api<unknown>("POST", "/api/memory/imports/decide", {
            ids: d.ids,
            decision: d.decision,
          })
        : api<unknown>(
            "POST",
            `/api/memory/imports/${encodeURIComponent(d.id)}/${d.action}`,
            d.action === "accept" ? { edits: d.edits, asCurrent: d.asCurrent } : {},
          ),
    onSuccess: invalidate,
  });
}
