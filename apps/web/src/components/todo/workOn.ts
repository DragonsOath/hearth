import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  TODO_CATEGORY_LABEL,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  type TodoItem,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { useCave } from "../shell/cave-context";

/** What Ember is handed for a task: who it is (id and number) and what is known about it. */
export function workOnPrompt(t: TodoItem, systems: string[]) {
  return [
    `Let's work on to-do #${t.number} (id ${t.id}): “${t.title}”.`,
    `${TODO_CATEGORY_LABEL[t.category]}, ${TODO_PRIORITY_LABEL[t.priority].toLowerCase()} priority, ${TODO_STATUS_LABEL[t.status].toLowerCase()}.`,
    t.description ? `What it says: ${t.description}` : "",
    t.nextAction ? `Next step noted: ${t.nextAction}` : "",
    systems.length ? `Systems: ${systems.join(", ")}.` : "",
    t.jobs.length
      ? `Plans made for it: ${t.jobs.map((j) => `${j.title} (${j.status})`).join("; ")}.`
      : "",
    "Read it with the to-do tools if you need more. Start by telling me where it stands and what you'd suggest, and ask before doing anything: changes go through plans I approve as usual. Don't mark it done; I tick it off when it's really fixed.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Work on this (11-11, the owner's brief): hands a task to Ember in the Lair's chat. Its own
 * conversation is resumed when it has one (and still exists); otherwise a new conversation
 * starts with the task's context, and is linked to the task once it exists. Nothing is marked
 * done and nothing runs: Ember starts by talking, and changes stay plans the owner approves.
 */
export function useWorkOnTodo(systemName: (id: string) => string) {
  const cave = useCave();
  const qc = useQueryClient();
  const linking = useRef<string | undefined>(undefined);

  // The new conversation exists once Ember answers the first message: link it to the task.
  useEffect(() => {
    const task = linking.current;
    if (!task || !cave.conversationId) return;
    linking.current = undefined;
    void api("PUT", `/api/todos/${task}/conversation`, { conversationId: cave.conversationId })
      .then(() => qc.invalidateQueries({ queryKey: ["todos"] }))
      .catch(() => undefined);
  }, [cave.conversationId, qc]);

  return async (t: TodoItem) => {
    const known = t.conversationId
      ? await api("GET", `/api/agent/conversations/${t.conversationId}`).then(
          () => true,
          () => false,
        )
      : false;
    if (known) {
      cave.select(t.conversationId);
      cave.ask(`Back to to-do #${t.number}, “${t.title}”. Where did we get to, and what's next?`);
      return;
    }
    cave.select(undefined);
    linking.current = t.id;
    cave.ask(workOnPrompt(t, t.services.map(systemName)));
  };
}
