import { Link } from "react-router";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { TodoPanel, isActiveTodo } from "../talk/panels";
import { ToolImage } from "../panels/ToolImage";
import { useTodos } from "../../data/todos";
import { useAiName, useWorkspace } from "../../data/api";
import { useWorkOnTodo } from "./workOn";

type Tab = "active" | "done";

/**
 * The to-do list as a panel in the Lair, beside Ember and the systems (the owner, 2026-11-02): tick
 * things off, add one, change a priority, without leaving the Lair. The full page stays at /todo.
 */
export function TodoToolPanel({
  tab,
  onTab,
  onClose,
}: {
  tab: string | null;
  onTab: (tab: Tab) => void;
  onClose: () => void;
}) {
  const todos = useTodos();
  const ai = useAiName();
  const ws = useWorkspace().data;
  const workOn = useWorkOnTodo(
    (id) =>
      [...(ws?.services ?? []), ...(ws?.inactiveServices ?? [])].find((s) => s.id === id)?.name ??
      id,
  );
  const current: Tab = tab === "done" ? "done" : "active";
  const open = (todos.data ?? []).filter((t) => t.savedAt && isActiveTodo(t)).length;
  const tabs: TabDef<Tab>[] = [
    { id: "active", label: `To deal with (${open})` },
    { id: "done", label: "Done" },
  ];
  return (
    <WorkspaceFrame
      label="To-do"
      testId="todo-panel"
      icon={<ToolImage id="todo" />}
      title="To-do"
      subtitle={
        <span>
          What needs doing in your homelab.{" "}
          <Link to="/todo" className="text-gold underline-offset-2 hover:underline">
            The whole list
          </Link>
        </span>
      }
      tabs={tabs}
      tab={current}
      onTab={onTab}
      onClose={onClose}
      capture={{ panel: "To-do", tab: current }}
    >
      <TodoPanel view={current} aiName={ai} onWork={(t) => void workOn(t)} />
    </WorkspaceFrame>
  );
}
