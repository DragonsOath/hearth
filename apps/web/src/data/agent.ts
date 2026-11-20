import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentCheck,
  AgentConnectionTest,
  AgentSetupInfo,
  ClaudeAuthStatus,
  ClaudeSignInResult,
  ClaudeSignInStart,
  KeyScope,
  KeySummary,
} from "@dragon-control/core";
import { api } from "./api";

/** The AI operator, conversations with it, and access keys for other software. */

export interface ConversationSummary {
  id: string;
  source: "app" | "voice" | "api";
  title: string;
  status: "idle" | "working";
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: { role: "you" | "agent" | "note"; text: string; at: string }[];
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

export function useConnectAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api("POST", `/api/agent/providers/${encodeURIComponent(id)}/connect`, {}),
    onSettled: () => invalidate("workspace", "audit"),
  });
}

/** Setup: which account on this machine must be signed in to the AI program. No secrets. */
export function useAgentSetupInfo() {
  return useQuery({
    queryKey: ["agent-setup"],
    queryFn: () => api<AgentSetupInfo>("GET", "/api/agent/setup"),
    staleTime: 60_000,
  });
}

/** Is the AI program installed? Free: it only asks the program for its version. */
export function useCheckAgent() {
  return useMutation({
    mutationFn: (id: string) =>
      api<AgentCheck>("POST", `/api/agent/providers/${encodeURIComponent(id)}/check`, {}),
  });
}

/** A real connection test (installed, signed in, able to use Hearth's tools). Uses a small request. */
export function useTestAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api<AgentConnectionTest>("POST", `/api/agent/providers/${encodeURIComponent(id)}/test`, {}),
    onSettled: () => invalidate("ai-usage"),
  });
}

/** Claude Code's sign-in for the account Hearth runs as. No secrets. */
export function useClaudeStatus(enabled = true) {
  return useQuery({
    queryKey: ["claude-status"],
    queryFn: () => api<ClaudeAuthStatus>("GET", "/api/agent/claude/status"),
    enabled,
  });
}

/** Starts signing Claude Code in from here: returns Anthropic's own sign-in link. */
export function useStartClaudeSignIn() {
  return useMutation({
    mutationFn: (opts: { console?: boolean }) =>
      api<ClaudeSignInStart>("POST", "/api/agent/claude/sign-in", opts),
  });
}

/** Passes the one-time code from Anthropic's page to the waiting sign-in. */
export function useFinishClaudeSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; code: string }) =>
      api<ClaudeSignInResult>(
        "POST",
        `/api/agent/claude/sign-in/${encodeURIComponent(v.id)}/code`,
        { code: v.code },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["claude-status"] }),
  });
}

export function useCancelClaudeSignIn() {
  return useMutation({
    mutationFn: (id: string) =>
      api("DELETE", `/api/agent/claude/sign-in/${encodeURIComponent(id)}`),
  });
}

export function useClaudeSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<ClaudeAuthStatus>("POST", "/api/agent/claude/sign-out", {}),
    onSuccess: (s) => queryClient.setQueryData(["claude-status"], s),
  });
}

export function useDisconnectAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api("POST", "/api/agent/disconnect", {}),
    onSettled: () => invalidate("workspace", "audit"),
  });
}

export function useAgentEscalation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (escalate: boolean) => api("PATCH", "/api/agent/settings", { escalate }),
    onSettled: () => invalidate("workspace", "audit"),
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<ConversationSummary[]>("GET", "/api/agent/conversations"),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversations", id],
    queryFn: () => api<Conversation>("GET", `/api/agent/conversations/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    // A reply may arrive after the request stopped waiting.
    refetchInterval: (q) => (q.state.data?.status === "working" ? 3000 : false),
  });
}

export function useSay() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { text: string; conversationId?: string }) =>
      api<{ conversationId: string; status: "answered" | "working"; reply?: string }>(
        "POST",
        "/api/agent/conversations",
        body,
      ),
    onSettled: () => invalidate("conversations", "workspace"),
  });
}

export function useKeys() {
  return useQuery({ queryKey: ["keys"], queryFn: () => api<KeySummary[]>("GET", "/api/keys") });
}

export function useCreateKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { name: string; scopes: KeyScope[] }) =>
      api<{ key: string; summary: KeySummary }>("POST", "/api/keys", body),
    onSettled: () => invalidate("keys", "audit"),
  });
}

export function useRevokeKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/keys/${encodeURIComponent(id)}`),
    onSettled: () => invalidate("keys", "audit"),
  });
}
