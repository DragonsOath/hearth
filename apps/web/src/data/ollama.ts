import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Ollama (10-27): free models on your own hardware, run through the same Claude Code as the
 * War Room and the Lair use, with the same tools and access. Hearth keeps one address and model
 * for both rooms.
 */
export interface OllamaModel {
  name: string;
  sizeGb: number;
  tools: boolean;
  context: number | null;
  contextOk: boolean;
}

export interface OllamaStatus {
  url: string;
  model: string | null;
  reachable: boolean;
  version: string | null;
  models: OllamaModel[];
  problem: string | null;
}

const KEY = ["ollama"];

/** What Ollama at this address has (the saved address when none is given). */
export function useOllama(url?: string) {
  return useQuery({
    queryKey: [...KEY, url ?? ""],
    queryFn: () =>
      api<OllamaStatus>(
        "GET",
        `/api/engine/ollama${url ? `?url=${encodeURIComponent(url)}` : ""}`,
      ),
    retry: false,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    // The War Room's tabs and the Lair's AI list show whether Ollama is ready.
    void qc.invalidateQueries({ queryKey: ["workspace"] });
  };
}

export function useSaveOllama() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: { url: string; model: string | null }) =>
      api<OllamaStatus>("PUT", "/api/engine/ollama", body),
    onSuccess: refresh,
  });
}

/** Makes a copy of a model with a big enough memory window for Hearth, and uses it. */
export function usePrepareOllama() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (model: string) =>
      api<OllamaStatus>("POST", "/api/engine/ollama/prepare", { model }),
    onSuccess: refresh,
  });
}
