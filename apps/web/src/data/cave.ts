import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiBudget,
  AiUsageReport,
  CaveAnswerMeta,
  CaveFocus,
  CaveMessage,
  CavePersonality,
  JurisdictionEntry,
  JurisdictionKind,
} from "@dragon-control/core";
import { api } from "./api";

/** Ember: conversations, its jurisdiction, and what the AI costs. */

export interface CaveConversationSummary {
  id: string;
  source: "app" | "voice" | "api";
  title: string;
  status: "idle" | "working";
  updatedAt: string;
  projectId?: string;
  /** Its Thread Look (THREAD_LOOKS): the small Ember picture on the thread. */
  look?: string;
  /** The main conversation the hub on Home continues. */
  main?: boolean;
  /** Remote Control (/rc) is on: the conversation is live in the Claude app too. */
  remote?: { title: string; url?: string; connecting: boolean };
}

export interface CaveConversation extends CaveConversationSummary {
  messages: CaveMessage[];
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

export function useCaveConversations(projectId?: string) {
  return useQuery({
    queryKey: ["conversations", "list", projectId ?? "all"],
    queryFn: () =>
      api<CaveConversationSummary[]>(
        "GET",
        `/api/agent/conversations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),
  });
}

/** The main conversation (made on first use), so the hub always continues the same one. */
export function useMainConversation() {
  return useQuery({
    queryKey: ["conversations", "main"],
    queryFn: () => api<CaveConversation>("GET", "/api/agent/conversations/main"),
    staleTime: 60_000,
  });
}

export function useCaveConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversations", id],
    queryFn: () =>
      api<CaveConversation>("GET", `/api/agent/conversations/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    // The answer keeps coming on the server even if this page was closed; check back for it.
    // While it works, steps appear as they happen.
    // Remote Control on: what is said in the Claude app shows up here as it happens.
    refetchInterval: (q) =>
      q.state.data?.status === "working" ? 1200 : q.state.data?.remote ? 1500 : false,
  });
}

/** A project's ongoing conversation (made on first use), separate from the main one. */
export function useProjectConversation(projectId: string | undefined) {
  return useQuery({
    queryKey: ["conversations", "project", projectId],
    queryFn: () =>
      api<CaveConversation>("GET", `/api/projects/${encodeURIComponent(projectId!)}/conversation`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function useAsk() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: {
      text: string;
      conversationId?: string;
      lastVisit?: string;
      projectId?: string;
      focus?: CaveFocus;
      attachments?: string[];
      /** Spoken (from the microphone): the answer is read aloud. */
      spoken?: boolean;
      /** Sent while the previous answer was under way: more to the same request. */
      followUp?: boolean;
      /** A new conversation's Thread Look. */
      look?: string;
      /** A new conversation's name, given when it was started. */
      title?: string;
    }) =>
      api<{
        conversationId: string;
        status: "answered" | "working";
        reply?: string;
        meta?: CaveAnswerMeta;
        /** The "About:" chip wasn't what the message was about: the page drops it. */
        focusDropped?: boolean;
      }>(
        "POST",
        "/api/agent/conversations",
        // Short wait: the page shows "looking into it" and polls, so a slow
        // answer never holds the request open on a phone connection.
        { ...body, wait: 3 },
      ),
    onSettled: () => invalidate("conversations", "workspace", "ai-usage"),
  });
}

export function useJurisdiction() {
  return useQuery({
    queryKey: ["jurisdiction"],
    queryFn: () => api<JurisdictionEntry[]>("GET", "/api/jurisdiction"),
  });
}

export function useAddJurisdiction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: {
      kind: JurisdictionKind;
      name: string;
      value?: string;
      access: "in" | "out";
      note?: string;
    }) => api<JurisdictionEntry>("POST", "/api/jurisdiction", body),
    onSettled: () => invalidate("jurisdiction", "audit"),
  });
}

export function useRemoveJurisdiction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/jurisdiction/${encodeURIComponent(id)}`),
    onSettled: () => invalidate("jurisdiction", "audit"),
  });
}

export function useAiUsage() {
  return useQuery({
    queryKey: ["ai-usage"],
    queryFn: () => api<AiUsageReport>("GET", "/api/ai/usage"),
  });
}

export function useSetBudget() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      patch: Partial<Omit<AiBudget, "dailyUsd" | "dailyTokens" | "dailyRuns">> & {
        dailyRuns?: number | null;
      },
    ) => api<AiBudget>("PATCH", "/api/ai/budget", patch),
    onSettled: () => invalidate("ai-usage", "audit"),
  });
}

/** How Ember talks. The rules it follows never depend on this. */
export function usePersonality() {
  return useQuery({
    queryKey: ["cave-personality"],
    queryFn: () => api<CavePersonality>("GET", "/api/agent/personality"),
  });
}

export function useSetPersonality() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (p: CavePersonality) => api<CavePersonality>("PUT", "/api/agent/personality", p),
    onSettled: () => invalidate("cave-personality", "audit"),
  });
}

/** Your name for a conversation. */
export function useRenameConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api("PATCH", `/api/agent/conversations/${encodeURIComponent(id)}`, { title }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** A thread's picture (Thread Looks): another look, or null for none. */
export function useSetConversationLook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, look }: { id: string; look: string | null }) =>
      api("PATCH", `/api/agent/conversations/${encodeURIComponent(id)}`, { look }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** A conversation the search found, with the line that matched and its place in the thread. */
export interface ConversationHit {
  id: string;
  title: string;
  look?: string;
  updatedAt: string;
  projectId?: string;
  match?: { text: string; role: string; at: string; index: number };
}

/** "Where did we talk about this?": every conversation's words, searched on this Hearth. */
export function useConversationSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ["conversations", "search", term],
    queryFn: () =>
      api<ConversationHit[]>(
        "GET",
        `/api/agent/conversations/search?q=${encodeURIComponent(term)}`,
      ),
    enabled: term.length >= 2,
    staleTime: 15_000,
  });
}

/** Deletes a conversation and its messages for good. */
export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/agent/conversations/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** Ember continues this conversation from now on (the Lair's current one). */
export async function continueConversation(id: string) {
  await api("PUT", "/api/agent/conversations/main", { conversationId: id });
}
