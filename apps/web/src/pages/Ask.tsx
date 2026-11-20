import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, History, Plus } from "lucide-react";
import { Button, Sheet } from "../components/ui";
import { CaveChat } from "../components/cave/CaveChat";
import { useCave } from "../components/shell/cave-context";
import { useWorkspace } from "../data/api";
import { useCaveConversation } from "../data/cave";
import { LookImage } from "../components/cave/ThreadLooks";
import { threadLook } from "@dragon-control/core";
import { ConversationsPanel } from "../components/cave/CavePanel";
import { useProject } from "../data/projects";
import { useTodo } from "../data/todos";

/**
 * Ask Ember, full screen: the same conversation the hub and the
 * workspace panel show, with every earlier conversation a tap away. Built for
 * a phone first; an answer keeps coming on the server if the page closes.
 */
export function AskPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const convo = useCaveConversation(id);
  // Earlier conversations, or New conversation (its Thread Looks picker open).
  const [history, setHistory] = useState<false | "list" | "new">(false);
  const initial = params.get("q") ?? undefined;
  const cave = useCave();
  // Opened from a project or service: keep talking about it, with the way back to it.
  const projectId = params.get("project") ?? undefined;
  const serviceId = projectId ? undefined : (params.get("service") ?? undefined);
  // Opened from the to-do list: about that item, in the conversation it came from.
  const todoId = projectId || serviceId ? undefined : (params.get("todo") ?? undefined);
  const todo = useTodo(todoId);
  const project = useProject(projectId);
  const ws = useWorkspace();
  const service = serviceId
    ? [...(ws.data?.services ?? []), ...(ws.data?.inactiveServices ?? [])].find(
        (s) => s.id === serviceId,
      )
    : undefined;
  const context = projectId
    ? { kind: "project" as const, id: projectId, label: project.data?.name }
    : service
      ? { kind: "service" as const, id: service.id, label: service.name }
      : todo.data
        ? {
            kind: "todo" as const,
            id: todo.data.id,
            label: `#${todo.data.number} ${todo.data.title}`,
          }
        : undefined;
  const keep = projectId
    ? `?project=${encodeURIComponent(projectId)}`
    : serviceId
      ? `?service=${encodeURIComponent(serviceId)}`
      : todoId
        ? `?todo=${encodeURIComponent(todoId)}`
        : "";
  const back = projectId
    ? `/?project=${encodeURIComponent(projectId)}&view=chat`
    : serviceId
      ? `/?service=${encodeURIComponent(serviceId)}&view=chat`
      : todoId
        ? `/todo?item=${encodeURIComponent(todoId)}`
        : undefined;

  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[28rem] flex-col md:h-[calc(100dvh-9rem)]">
      {back && context?.label && (
        <Link
          to={back}
          onClick={(e) => {
            // Came from the workspace: go back to exactly that arrangement (all its panels).
            const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
            if (idx > 0) {
              e.preventDefault();
              void navigate(-1);
            }
          }}
          className="mb-3 flex min-h-10 w-fit items-center gap-2 text-[0.84rem] text-muted hover:text-gold"
          data-testid="ask-back"
        >
          <ArrowLeft strokeWidth={1.5} className="h-4 w-4" /> Back to {context.label}
        </Link>
      )}
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Ember</p>
          <h1 className="font-display text-[2rem] leading-tight text-ink sm:text-[2.4rem]">
            {convo.data?.title && id ? (
              <span className="flex min-w-0 items-center gap-3" data-testid="ember-thread-name">
                <LookImage look={convo.data.look} className="h-10 w-10" />
                <span className="line-clamp-1">{convo.data.title}</span>
              </span>
            ) : threadLook(cave.newLook) || cave.newTitle ? (
              <span className="flex min-w-0 items-center gap-3" data-testid="ember-thread-name">
                <LookImage look={cave.newLook} className="h-10 w-10" />
                <span className="line-clamp-1">
                  {cave.newTitle ?? threadLook(cave.newLook)!.name}
                </span>
              </span>
            ) : (
              "Ask about your homelab"
            )}
          </h1>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            tone="quiet"
            aria-label="Earlier conversations"
            onClick={() => setHistory("list")}
          >
            <History strokeWidth={1.25} className="h-5 w-5" />
          </Button>
          {id && (
            <Button tone="quiet" aria-label="New conversation" onClick={() => setHistory("new")}>
              <Plus strokeWidth={1.25} className="h-5 w-5" />
            </Button>
          )}
        </div>
      </header>

      <CaveChat
        key={id ?? "new"}
        className="flex-1"
        conversationId={id}
        onConversation={(next) => {
          // The workspace's panel shows this conversation too when you go back.
          if (projectId) cave.select(next);
          navigate(`/ask/${next}${keep}`, { replace: Boolean(id) });
        }}
        projectId={projectId}
        focus={
          context?.label ? { kind: context.kind, id: context.id, label: context.label } : undefined
        }
        initial={initial}
        onInitialSent={() => setParams(todoId ? { todo: todoId } : {}, { replace: true })}
        placeholder={id ? "Ask a follow-up" : "Ask a question"}
      />

      {history && (
        <Sheet
          label="Earlier conversations"
          eyebrow="Ember"
          title="Earlier conversations"
          onClose={() => setHistory(false)}
        >
          <ConversationsPanel
            className="max-h-[70vh]"
            startPicking={history === "new"}
            activeId={id}
            onOpen={(to) => navigate(to ? `/ask/${to}${keep}` : `/ask${keep}`)}
            onPick={() => setHistory(false)}
          />
        </Sheet>
      )}
    </div>
  );
}
