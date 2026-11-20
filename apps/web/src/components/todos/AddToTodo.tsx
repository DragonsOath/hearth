import { Link } from "react-router";
import { ListPlus } from "lucide-react";
import { useAddTodo, useTodos, type TodoDraft } from "../../data/todos";
import { cx } from "../ui";

/** Whether an item with this title is already on the list (and not finished). */
function onList(
  todos: { id: string; title: string; status: string; number: number }[] | undefined,
  title: string,
) {
  const t = title.trim().toLowerCase();
  return todos?.find(
    (x) =>
      x.title.trim().toLowerCase() === t &&
      x.status !== "resolved" &&
      x.status !== "dismissed" &&
      x.status !== "suggested",
  );
}

/**
 * "Add to to-do" on something that needs the owner (Home's "Requires your attention"; the owner,
 * 10-26). Saving it is only a reminder: it never approves or runs anything. Once saved, it links
 * to the item instead, so it is not added twice.
 */
export function AddToTodo({ draft, className }: { draft: TodoDraft; className?: string }) {
  const todos = useTodos();
  const add = useAddTodo();
  const title = draft.title.slice(0, 160);
  const saved = onList(todos.data, title);
  if (saved)
    return (
      <Link
        to={`/todo?item=${saved.id}`}
        className={cx("text-[0.8rem] text-ok hover:underline", className)}
        data-testid="add-to-todo-done"
      >
        On your to-do list (#{saved.number})
      </Link>
    );
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        disabled={add.isPending}
        onClick={() => add.mutate({ ...draft, title })}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[0.8rem] text-muted transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-60"
        data-testid="add-to-todo"
      >
        <ListPlus strokeWidth={1.5} className="h-4 w-4" aria-hidden />
        {add.isPending ? "Adding…" : "Add to to-do"}
      </button>
      {add.isError && (
        <span role="alert" className="text-[0.78rem] text-bad">
          Couldn&apos;t add it. Try again.
        </span>
      )}
    </span>
  );
}
