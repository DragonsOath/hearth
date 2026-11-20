import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TodoCategory,
  TodoDetail,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "@dragon-control/core";
import { api } from "./api";

/**
 * Issues & ideas: the to-do list you keep with Ember, and what it
 * noticed but you have not saved (suggestions).
 */

export function useTodos(opts: { suggestions?: boolean } = {}) {
  return useQuery({
    queryKey: ["todos", opts.suggestions ? "with-suggestions" : "list"],
    queryFn: () => api<TodoItem[]>("GET", `/api/todos${opts.suggestions ? "?suggestions=1" : ""}`),
    refetchInterval: 20_000,
  });
}

export function useTodo(id: string | undefined) {
  return useQuery({
    queryKey: ["todos", "item", id],
    queryFn: () => api<TodoDetail>("GET", `/api/todos/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["todos"] });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  };
}

export interface TodoDraft {
  category: TodoCategory;
  title: string;
  description?: string;
  priority?: TodoPriority;
  services?: string[];
  projectId?: string;
  nextAction?: string;
  status?: "open" | "deferred";
}

export function useAddTodo() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: TodoDraft) => api<TodoItem>("POST", "/api/todos", body),
    onSettled: invalidate,
  });
}

export function useUpdateTodo() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      status?: Exclude<TodoStatus, "suggested">;
      priority?: TodoPriority;
      category?: TodoCategory;
      title?: string;
      description?: string;
      nextAction?: string;
      projectId?: string | null;
      services?: string[];
      note?: string;
    }) => api<TodoDetail>("PATCH", `/api/todos/${encodeURIComponent(id)}`, patch),
    onSettled: invalidate,
  });
}

/** A suggestion goes onto the list (or straight to later). */
export function useSaveSuggestion() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, deferred }: { id: string; deferred?: boolean }) =>
      api<TodoItem>("POST", `/api/todos/${encodeURIComponent(id)}/save`, { deferred }),
    onSettled: invalidate,
  });
}

/** Where "Work on it" goes: back into the conversation it came from, about it. */
export function workOnHref(item: Pick<TodoItem, "id" | "number" | "conversationId">): string {
  const q = encodeURIComponent(`Let's work on #${item.number} now.`);
  return `/ask${item.conversationId ? `/${item.conversationId}` : ""}?todo=${encodeURIComponent(item.id)}&q=${q}`;
}
