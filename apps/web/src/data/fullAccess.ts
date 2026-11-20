import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * What the AI asks before acting (11-06). The agent is never held back: the War Room and the
 * Lair run the full Claude Code, Codex, or Ollama. The owner only chooses what it stops to ask
 * about first: every change (strict), risky steps (moderate), or only serious ones (free).
 */
export type AskLevel = "strict" | "moderate" | "free";

export const ASK_LEVEL_TEXT: Record<AskLevel, { label: string; short: string; hint: string }> = {
  strict: {
    label: "Ask before every change",
    short: "asks before every change",
    hint: "It reads and looks around freely, and stops to ask you before it changes anything: a file, a setting, a container, an app.",
  },
  moderate: {
    label: "Ask before risky steps",
    short: "asks before risky steps",
    hint: "Routine, easily undone work goes ahead. Restarts, app settings, installs, deleting data, networking, and sudo wait for your yes.",
  },
  free: {
    label: "Ask only before serious steps",
    short: "asks only before serious steps",
    hint: "It works on its own, so it can finish a job while you're away. It stops only before what could be devastating or can't be put back: deleting data, wiping drives, networking, sudo.",
  },
};

export function useAskLevel() {
  return useQuery({
    queryKey: ["full-access"],
    queryFn: () =>
      api<{ full: boolean; level?: AskLevel }>("GET", "/api/engine/access").then(
        (r) => r.level ?? (r.full ? "free" : "strict"),
      ),
    retry: false,
  });
}

export function useSetAskLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (level: AskLevel) =>
      api<{ ask_level?: AskLevel }>("POST", `/api/engine/queue/ask-${level}`, {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["full-access"] }),
  });
}
