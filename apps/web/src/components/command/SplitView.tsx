import { DownloadHealthPanel } from "../downloads/DownloadHealthPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { aiDisplayName } from "@dragon-control/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { Minimize2 } from "lucide-react";
import { minimizeGroup, PanelScope } from "../desk/groups";
import type { ProjectDetail, Workspace, WorkspaceView } from "@dragon-control/core";
import { cx } from "../ui";
import { useProject } from "../../data/projects";
import {
  deskSearch,
  focusFrom,
  keyOf,
  panelsFrom,
  TOOL_PANELS,
  withPanel,
  type Panel,
} from "../desk/layout";
import { api } from "../../data/api";
import { PHONE_QUERY, useMedia } from "../../lib/media";
import { useFitToScreen } from "../../lib/phone-chat";
import { CHAT, PanelCarousel } from "./PanelCarousel";

/** Below a tablet's width the Lair is a phone's: Ember and the panels take turns, in a ring. */
export { PHONE_QUERY } from "../../lib/media";
import { WorkspacePanel } from "../workspace/WorkspacePanel";
import { MinimizedWorkspaces, useAutoOpenWorkspaces } from "../workspace/dock";
import { useWorkspace } from "../../data/workspaces";
import { CavePanel } from "../cave/CavePanel";
import { useCave } from "../shell/cave-context";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ServiceWorkspace } from "./ServiceWorkspace";
import { TodoToolPanel } from "../todo/TodoToolPanel";
import { HomeRowsPanel } from "../homeRows/HomeRowsPanel";
import { CuratorPanel } from "../curator/CuratorPanel";
import { MovieNightsPanel } from "../notify/MovieNightsPanel";
import { CruciblePanel } from "../crucible/CruciblePanel";
import { StorageCenterPanel } from "../storage/StorageCenterPanel";

/**
 * A project or service on the right, Ember on the left. What is open
 * is in the address (?project= or ?service=, and &tab=), so refresh, back, and
 * shared links all land in the same place. From tablet width up both sides
 * show; on a phone they take turns (`&view=chat`), keeping the same project
 * or service and conversation either way.
 */
export function SplitView({ ws }: { ws: Workspace }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const cave = useCave();
  // The same open panels as the desktop desk; here the focused one is shown.
  const panels = panelsFrom(params);
  const focusKey = focusFrom(params, panels);
  const current = panels.find((p) => keyOf(p) === focusKey) ?? panels.at(-1);
  const projectId = current?.kind === "project" ? current.id : undefined;
  const serviceId = current?.kind === "service" ? current.id : undefined;
  const workspaceId = current?.kind === "workspace" ? current.id : undefined;
  const toolId = current?.kind === "tool" ? current.id : undefined;
  const workspace = useWorkspace(workspaceId);
  const tab = current?.tab ?? null;
  const project = useProject(projectId);
  const side = params.get("view") === "chat" ? "chat" : "workspace";
  // "This" means whatever is open, until you clear it for that one thing.
  const target = projectId ? `project:${projectId}` : `service:${serviceId}`;
  const [clearedFor, setClearedFor] = useState<string | undefined>();
  const focusOff = clearedFor === target;

  const service = serviceId
    ? [...ws.services, ...ws.inactiveServices].find((s) => s.id === serviceId)
    : undefined;
  const selected = cave.item && cave.item.serviceId === serviceId ? cave.item : undefined;
  const focus = selected
    ? {
        kind: "service" as const,
        id: selected.serviceId,
        item: { kind: selected.kind, id: selected.id },
        label: `${selected.label}${service ? ` (${service.name})` : ""}`,
      }
    : focusOff
      ? undefined
      : projectId && project.data
        ? { kind: "project" as const, id: projectId, label: project.data.name }
        : service
          ? { kind: "service" as const, id: service.id, label: service.name }
          : undefined;

  // "Ask Ember about this" on a phone or tablet: show the conversation.
  const askedAbout = selected?.id;
  // Once per "Ask": after that the tabs are yours again (setParams changes every render).
  const switchedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!askedAbout || switchedFor.current === askedAbout) return;
    switchedFor.current = askedAbout;
    setParams(
      (prev) => {
        if (prev.get("view") === "chat") return prev;
        const s = new URLSearchParams(prev);
        s.set("view", "chat");
        return s;
      },
      { replace: true },
    );
    // Once the conversation is showing, straight into its message box. Not cancelled when
    // this effect runs again (the address just changed); focusing a gone box does nothing.
    setTimeout(
      () => document.querySelector<HTMLTextAreaElement>('textarea[id$="-input"]')?.focus(),
      60,
    );
  }, [askedAbout, setParams]);

  const go = (next: Panel[], focus: string | undefined, view: string | null) => {
    const s = new URLSearchParams(deskSearch(params, next, focus).replace(/^\?/, ""));
    if (view) s.set("view", view);
    else s.delete("view");
    setParams(s);
  };
  const updateTab = (panel: Panel, tab: string) =>
    go(
      panels.map((p) => (keyOf(p) === keyOf(panel) ? { ...p, tab } : p)),
      keyOf(panel),
      params.get("view"),
    );
  const update = (patch: { tab: string }) => current && updateTab(current, patch.tab);
  // Closing a panel shows its neighbour (the next one, or the one before the last).
  const closePanel = (panel: Panel) => {
    const at = panels.findIndex((p) => keyOf(p) === keyOf(panel));
    const rest = panels.filter((p) => keyOf(p) !== keyOf(panel));
    const next = rest[at] ?? rest[at - 1];
    go(rest, next ? keyOf(next) : undefined, null);
  };
  const close = () => current && closePanel(current);
  // A workspace Ember opens joins the panels; on a phone the chat stays in view.
  const latest = useRef({ panels, params });
  useEffect(() => {
    latest.current = { panels, params };
  });
  const openWorkspaces = useCallback(
    (ids: string[], quiet = false) => {
      let next = latest.current.panels;
      for (const id of ids) next = withPanel(next, { kind: "workspace", id });
      const s = new URLSearchParams(
        deskSearch(
          latest.current.params,
          next,
          quiet && latest.current.panels.length
            ? focusFrom(latest.current.params, latest.current.panels)
            : `workspace:${ids.at(-1)}`,
        ).replace(/^\?/, ""),
      );
      setParams(s);
    },
    [setParams],
  );
  useAutoOpenWorkspaces(cave.conversationId, panels, openWorkspaces);

  const setSide = (s: "workspace" | "chat") => {
    const next = new URLSearchParams(params);
    if (s === "chat") next.set("view", "chat");
    else next.delete("view");
    setParams(next);
  };

  // The phone's ring of Ember and the open panels (PanelCarousel), with each one's name.
  const phone = useMedia(PHONE_QUERY, false);
  const projectNames = useQueries({
    queries: panels
      .filter((p) => p.kind === "project")
      .map((p) => ({
        queryKey: ["projects", "detail", p.id],
        queryFn: () => api<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(p.id)}`),
        enabled: phone,
        staleTime: 30_000,
      })),
  });
  const reviewNames = useQueries({
    queries: panels
      .filter((p) => p.kind === "workspace")
      .map((p) => ({
        queryKey: ["workspaces", "one", p.id],
        queryFn: () => api<WorkspaceView>("GET", `/api/workspaces/${encodeURIComponent(p.id)}`),
        enabled: phone,
        staleTime: 30_000,
      })),
  });
  const nameOf = (p: Panel): string => {
    if (p.kind === "service")
      return [...ws.services, ...ws.inactiveServices].find((s) => s.id === p.id)?.name ?? "System";
    if (p.kind === "tool") return TOOL_PANELS[p.id as keyof typeof TOOL_PANELS] ?? "Tool";
    if (p.kind === "project")
      return projectNames.find((q) => q.data?.id === p.id)?.data?.name ?? "Project";
    return reviewNames.find((q) => q.data?.id === p.id)?.data?.spec.title ?? "Review";
  };

  /** One open panel's body, the same on a phone and a tablet. */
  const body = (p: Panel) => (
    <PanelScope panel={p}>
      {p.kind === "tool" && p.id === "browser" ? (
        <BrowserPanel onClose={() => closePanel(p)} />
      ) : p.kind === "tool" && p.id === "curator" ? (
        <CuratorPanel onClose={() => closePanel(p)} />
      ) : p.kind === "tool" && p.id === "movie-nights" ? (
        <MovieNightsPanel onClose={() => closePanel(p)} />
      ) : p.kind === "tool" && p.id === "crucible" ? (
        <CruciblePanel onClose={() => closePanel(p)} />
      ) : p.kind === "tool" && p.id === "home-rows" ? (
        <HomeRowsPanel
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      ) : p.kind === "tool" && p.id === "downloads" ? (
        <DownloadHealthPanel
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      ) : p.kind === "tool" && p.id === "todo" ? (
        <TodoToolPanel
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      ) : p.kind === "tool" ? (
        <StorageCenterPanel
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      ) : p.kind === "workspace" ? (
        // On a phone the panel gets the screen's height, so its list scrolls inside it.
        <div className="h-[calc(100dvh-12rem)] min-h-[22rem] md:h-full">
          <WorkspacePanel
            id={p.id}
            onClose={() => closePanel(p)}
            onMinimize={() => closePanel(p)}
          />
        </div>
      ) : p.kind === "project" ? (
        <ProjectWorkspace
          id={p.id}
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      ) : (
        <ServiceWorkspace
          ws={ws}
          id={p.id}
          tab={p.tab ?? null}
          onTab={(t) => updateTab(p, t)}
          onClose={() => closePanel(p)}
        />
      )}
    </PanelScope>
  );

  const minimize = (
    <button
      type="button"
      onClick={() => minimizeGroup(navigate)}
      aria-label="Minimize all"
      title="Keep this Lair as it is (everything stays open) and go back to Home"
      className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-gold"
    >
      <Minimize2 strokeWidth={1.5} className="h-4 w-4" />
      <span className="hidden sm:inline">Minimize all</span>
    </button>
  );

  const conversation = (
    <>
      {projectId && (
        <div className="mb-2 flex gap-1 text-[0.8rem]" role="group" aria-label="Which conversation">
          <button
            type="button"
            onClick={() => cave.selectProject()}
            aria-pressed={cave.isProject}
            className={cx(
              "min-h-9 rounded-full border px-3",
              cave.isProject ? "border-gold/60 text-gold" : "border-line text-muted hover:text-ink",
            )}
          >
            This project's conversation
          </button>
          <button
            type="button"
            onClick={() => cave.selectMain()}
            aria-pressed={cave.isMain}
            className={cx(
              "min-h-9 rounded-full border px-3",
              cave.isMain ? "border-gold/60 text-gold" : "border-line text-muted hover:text-ink",
            )}
          >
            Current conversation
          </button>
        </div>
      )}
      <CavePanel
        className={cx("flex-1 md:min-h-0", phone ? "min-h-0" : "min-h-[60dvh]")}
        focus={focus}
        onClearFocus={() => (selected ? cave.selectItem(undefined) : setClearedFor(target))}
        projectId={projectId}
      />
    </>
  );

  // A phone (11-16): with the chat in front it fits the screen, so the header stays and the
  // thread scrolls by itself; panels scroll with the page as before.
  const phoneBox = useRef<HTMLDivElement>(null);
  useFitToScreen(phoneBox, phone && (side === "chat" || !current));

  if (phone) {
    // Ember first, then the panels in the address's order; the one showing is the focused panel,
    // or Ember with &view=chat. Moving round the ring changes only those, as the tabs did.
    const items = [
      { key: CHAT, label: aiDisplayName(ws.aiName) },
      ...panels.map((p) => ({ key: keyOf(p), label: nameOf(p) })),
    ];
    const active = side === "chat" || !current ? CHAT : keyOf(current);
    const show = (key: string) => {
      const next = new URLSearchParams(params);
      if (key === CHAT) next.set("view", "chat");
      else {
        next.set("focus", key);
        next.delete("view");
      }
      setParams(next, { replace: true });
    };
    return (
      <div ref={phoneBox} className="flex h-full flex-col">
        <MinimizedWorkspaces
          conversationId={cave.conversationId}
          onOpen={(id) => openWorkspaces([id])}
        />
        <PanelCarousel
          items={items}
          active={active}
          onGo={(key) => show(key)}
          chat={conversation}
          renderPanel={(key) => {
            const p = panels.find((x) => keyOf(x) === key);
            return p ? body(p) : null;
          }}
          trailing={minimize}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 gap-2 md:hidden" role="tablist" aria-label="Show">
          {(["workspace", "chat"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
              className={cx(
                "min-h-10 flex-1 rounded-lg border text-[0.86rem]",
                side === s ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted",
              )}
            >
              {s === "workspace"
                ? (project.data?.name ?? service?.name ?? workspace.data?.spec.title ?? "Workspace")
                : aiDisplayName(ws.aiName)}
            </button>
          ))}
        </div>
        <div className="hidden flex-1 md:block" />
        <button
          type="button"
          onClick={() => minimizeGroup(navigate)}
          aria-label="Minimize all"
          title="Keep this Lair as it is (everything stays open) and go back to Home"
          className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-gold"
        >
          <Minimize2 strokeWidth={1.5} className="h-4 w-4" />
          <span className="hidden sm:inline">Minimize all</span>
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 md:h-[calc(100dvh-7.5rem)] md:grid-cols-[minmax(290px,0.9fr)_minmax(0,1.1fr)] md:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(340px,0.82fr)_minmax(0,1.18fr)] lg:gap-5">
        <div className={cx("min-h-0 flex-col", side === "chat" ? "flex" : "hidden", "md:flex")}>
          {projectId && (
            <div
              className="mb-2 flex gap-1 text-[0.8rem]"
              role="group"
              aria-label="Which conversation"
            >
              <button
                type="button"
                onClick={() => cave.selectProject()}
                aria-pressed={cave.isProject}
                className={cx(
                  "min-h-9 rounded-full border px-3",
                  cave.isProject
                    ? "border-gold/60 text-gold"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                This project's conversation
              </button>
              <button
                type="button"
                onClick={() => cave.selectMain()}
                aria-pressed={cave.isMain}
                className={cx(
                  "min-h-9 rounded-full border px-3",
                  cave.isMain
                    ? "border-gold/60 text-gold"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                Current conversation
              </button>
            </div>
          )}
          <CavePanel
            className="min-h-[60dvh] flex-1 md:min-h-0"
            focus={focus}
            onClearFocus={() => (selected ? cave.selectItem(undefined) : setClearedFor(target))}
            projectId={projectId}
          />
        </div>
        <div
          className={cx("min-h-0 flex-col", side === "workspace" ? "flex" : "hidden", "md:flex")}
        >
          <MinimizedWorkspaces
            conversationId={cave.conversationId}
            onOpen={(id) => openWorkspaces([id])}
          />
          {current && (
            <PanelScope panel={current}>
              {toolId ? (
                <StorageCenterPanel tab={tab} onTab={(t) => update({ tab: t })} onClose={close} />
              ) : workspaceId ? (
                // On a phone the panel gets the screen's height, so its list scrolls inside it.
                <div className="h-[calc(100dvh-12rem)] min-h-[22rem] md:h-full">
                  <WorkspacePanel id={workspaceId} onClose={close} onMinimize={close} />
                </div>
              ) : projectId ? (
                <ProjectWorkspace
                  id={projectId}
                  tab={tab}
                  onTab={(t) => update({ tab: t })}
                  onClose={close}
                />
              ) : serviceId ? (
                <ServiceWorkspace
                  ws={ws}
                  id={serviceId}
                  tab={tab}
                  onTab={(t) => update({ tab: t })}
                  onClose={close}
                />
              ) : null}
            </PanelScope>
          )}
        </div>
      </div>
    </div>
  );
}
