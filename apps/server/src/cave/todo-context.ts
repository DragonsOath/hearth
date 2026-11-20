import {
  TODO_STATUS_LABEL,
  type CaveFocus,
  type CaveIntent,
  type TodoItem,
  type Workspace,
} from "@dragon-control/core";
import type { Todos } from "../todos/service";
import type { TodoCommand } from "./todo-words";

/**
 * What Ember is told about the to-do list for one message: the items
 * raised in this conversation in order (so "the second one" and "that" can be
 * resolved), the open list, and an item in full when it is the subject.
 * Every item carries its stable number (#12) and, for issues, what
 * Hearth sees now.
 */
export async function todoContext(o: {
  todos: Todos;
  ws: Workspace;
  conversationId: string;
  focus?: CaveFocus;
  intent: CaveIntent;
  commands: Set<TodoCommand>;
}): Promise<string> {
  const names = new Map(
    [...o.ws.services, ...o.ws.inactiveServices].map((s) => [s.id, s.name] as const),
  );
  const line = (i: TodoItem) => {
    const systems = i.services.map((s) => names.get(s) ?? s).join(", ");
    return [
      `#${i.number} ${i.category}, ${i.priority}, ${TODO_STATUS_LABEL[i.status].toLowerCase()}${i.savedAt ? "" : " (NOT on the list)"}: ${i.title}`,
      systems ? `systems: ${systems}` : "",
      i.check ? `now: ${i.check.state} (${i.check.detail})` : "",
      i.nextAction ? `next: ${i.nextAction}` : "",
      i.jobs.length ? `plans: ${i.jobs.map((j) => `${j.title} (${j.status})`).join("; ")}` : "",
      `saved ${(i.savedAt ?? i.createdAt).slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join(" | ");
  };
  const parts: string[] = [];

  const here = await o.todos.inConversation(o.conversationId);
  if (here.length) {
    parts.push(
      `To-do items raised or worked on in this conversation, oldest first ("that" usually means the latest; "the second one" means the second here):\n${here
        .map((i, n) => `${n + 1}. ${line(i)}`)
        .join("\n")}`,
    );
  }

  if (o.focus?.kind === "todo") {
    const d = await o.todos.get(o.focus.id).catch(() => undefined);
    if (d) {
      parts.push(
        [
          `The owner has to-do item #${d.number} open: "this" means it. In full:`,
          line(d),
          d.description ? `Description: ${d.description}` : "",
          d.evidence.length
            ? `Evidence when saved: ${d.evidence.map((e) => `${e.label} (${e.kind}${e.at ? `, ${e.at.slice(0, 10)}` : ""})`).join("; ")}`
            : "",
          `History:\n${d.history
            .slice(-15)
            .map((h) => `- ${h.at.slice(0, 16).replace("T", " ")} ${h.actor}: ${h.text}`)
            .join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  // Small talk does not need the list, unless the owner is talking about it.
  if (o.intent !== "chat" || o.commands.size) {
    const shown = new Set(here.map((i) => i.id));
    const active = (await o.todos.active(o.commands.has("show") ? 25 : 8)).filter(
      (i) => !shown.has(i.id),
    );
    const counts = await o.todos.counts();
    const deferred =
      o.commands.has("show") && counts.deferred
        ? (await o.todos.list()).filter((i) => i.status === "deferred" && !shown.has(i.id))
        : [];
    if (active.length || deferred.length || counts.deferred) {
      parts.push(
        [
          `The owner's to-do list: ${counts.open + counts.investigating + counts["waiting-approval"]} still to deal with, ${counts.deferred} deferred, ${counts.resolved} resolved.`,
          ...active.map((i) => `- ${line(i)}`),
          ...(deferred.length
            ? ["Deferred:", ...deferred.slice(0, 15).map((i) => `- ${line(i)}`)]
            : []),
        ].join("\n"),
      );
    } else if (o.commands.has("show")) {
      parts.push("The owner's to-do list is empty.");
    }
  }
  return parts.join("\n\n");
}
