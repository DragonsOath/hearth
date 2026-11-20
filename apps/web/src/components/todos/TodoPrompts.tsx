import { Link } from "react-router";
import { Lightbulb, ListTodo } from "lucide-react";
import { TODO_STATUS_LABEL, type CaveMessage } from "@dragon-control/core";
import { Button } from "../ui";
import { useSaveSuggestion, useTodos, useUpdateTodo } from "../../data/todos";

/**
 * Under an answer: what Ember noticed along the way (suggestions,
 * not on your list) with Add, Later, and Ignore, and items it saved or
 * worked on, linked to the list. Saying it in the conversation works too.
 */
export function TodoPrompts({ answer }: { answer: CaveMessage }) {
  const ids = (answer.evidence ?? [])
    .map((e) => e.ref)
    .filter((r): r is string => Boolean(r?.startsWith("todo:")))
    .map((r) => r.slice("todo:".length));
  const todos = useTodos({ suggestions: true });
  const save = useSaveSuggestion();
  const update = useUpdateTodo();
  if (!ids.length || !todos.data) return null;
  const items = [...new Set(ids)]
    .map((id) => todos.data.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (!items.length) return null;
  const busy = save.isPending || update.isPending;
  return (
    <li className="max-w-[96%] pl-11" data-testid="cave-todos">
      <div className="rounded-xl border border-line px-4 py-2.5">
        {items.map((t) =>
          t.status === "suggested" ? (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1.5">
              <Lightbulb strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
              <p className="min-w-0 flex-1 text-[0.86rem] text-ink">
                <span className="text-faint">Noticed #{t.number}: </span>
                {t.title}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-9 px-3.5"
                  tone="primary"
                  disabled={busy}
                  onClick={() => save.mutate({ id: t.id })}
                  aria-label={`Add #${t.number} to the to-do list`}
                >
                  Add to list
                </Button>
                <Button
                  className="min-h-9 px-3.5"
                  disabled={busy}
                  onClick={() => save.mutate({ id: t.id, deferred: true })}
                  aria-label={`Save #${t.number} for later`}
                >
                  Later
                </Button>
                <Button
                  className="min-h-9 px-3.5"
                  tone="quiet"
                  disabled={busy}
                  onClick={() => update.mutate({ id: t.id, status: "dismissed" })}
                  aria-label={`Ignore #${t.number}`}
                >
                  Ignore
                </Button>
              </div>
            </div>
          ) : (
            <div key={t.id} className="flex items-center gap-3 py-1.5">
              <ListTodo strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
              <p className="min-w-0 flex-1 text-[0.86rem] text-ink">
                {t.savedAt ? (
                  <Link
                    to={`/todo?item=${encodeURIComponent(t.id)}`}
                    className="underline decoration-line-strong underline-offset-4 hover:decoration-gold"
                  >
                    #{t.number} {t.title}
                  </Link>
                ) : (
                  <>
                    #{t.number} {t.title}
                  </>
                )}
                <span className="text-faint">
                  {" "}
                  · {t.savedAt ? TODO_STATUS_LABEL[t.status] : "Ignored"}
                </span>
              </p>
            </div>
          ),
        )}
      </div>
    </li>
  );
}
