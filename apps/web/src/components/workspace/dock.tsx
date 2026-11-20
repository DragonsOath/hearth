import { useEffect, useRef } from "react";
import { usePhone } from "../../lib/media";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { WorkspaceSummary } from "@dragon-control/core";
import { usePanelHref } from "../desk/links";
import { useCave } from "../shell/cave-context";
import { ClipboardList } from "lucide-react";
import { useWorkspaces, useWorkspaceState } from "../../data/workspaces";
import { deskSearch, keyOf, panelsFrom, type Panel } from "../desk/layout";
import { GROUP_PARAM } from "../desk/groups";
import { useDeskGroups } from "../../data/deskGroups";

/**
 * Workspaces Ember opened in the conversation you are in show up beside it on their own,
 * on any device (their open or minimized state is kept on the server). Each is opened once here;
 * after that the panel is yours to minimize, move, or close.
 */
/** Shared by every screen (desk, split view, Home) for this page load. */
const OPENED = { current: new Set<string>() };

export function useAutoOpenWorkspaces(
  conversationId: string | undefined,
  panels: Panel[],
  /** `quiet`: sheets left open from before, which join without taking focus. */
  open: (ids: string[], quiet: boolean) => void,
) {
  const list = useWorkspaces(conversationId);
  const groups = useDeskGroups();
  const [params] = useSearchParams();
  const current = params.get(GROUP_PARAM);
  // A review already kept in a minimized workspace group is there, one tap away: not opened twice.
  const grouped = (groups.data ?? [])
    .filter((g) => g.id !== current)
    .flatMap((g) => panelsFrom(new URLSearchParams(g.search)))
    .filter((p) => p.kind === "workspace")
    .map((p) => p.id)
    .join(",");

  const openKeys = panels.map(keyOf).join(",");
  // The first list read for each conversation holds sheets left open before (on loading the
  // page, or on switching to that conversation): they join the panels without taking focus, so
  // the panel you opened stays in front (on a phone, the only one showing). A sheet Ember makes
  // after that comes to the front, as it always has.
  const read = useRef(new Set<string>());
  const phone = usePhone();
  useEffect(() => {
    if (groups.isLoading || !list.data) return;
    const seenKey = conversationId ?? "";
    const quiet = !read.current.has(seenKey);
    read.current.add(seenKey);
    const showing = new Set(openKeys.split(","));
    for (const id of grouped.split(",")) if (id) showing.add(`workspace:${id}`);
    // Already on screen counts as opened: minimizing it later must not bring it straight back.
    for (const k of showing) if (k.startsWith("workspace:")) OPENED.current.add(k.slice(10));
    const want = (list.data ?? [])
      .filter((w) => w.state === "open" && !showing.has(`workspace:${w.id}`))
      .map((w) => w.id)
      .filter((id) => !OPENED.current.has(id));
    if (!want.length) return;
    for (const id of want) OPENED.current.add(id);
    // On a phone only one panel shows at a time, so an old sheet would take the screen from Home
    // or the panel you opened: it waits in the Forge button instead (its count says so).
    if (quiet && phone) return;
    open(want, quiet);
  }, [list.data, openKeys, open, grouped, groups.isLoading, phone, conversationId]);
}

/** Minimized workspaces of this conversation, one tap to bring back. */
export function MinimizedWorkspaces({
  conversationId,
  onOpen,
}: {
  conversationId: string | undefined;
  onOpen: (id: string) => void;
}) {
  const list = useWorkspaces(conversationId);
  const setState = useWorkspaceState();
  const minimized = (list.data ?? []).filter((w) => w.state === "minimized");
  if (!minimized.length) return null;
  return (
    <div className="flex shrink-0 gap-1.5" role="group" aria-label="Minimized workspaces">
      {minimized.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => {
            setState.mutate({ id: w.id, state: "open" });
            onOpen(w.id);
          }}
          title={`Show ${w.title}`}
          className="flex min-h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-full border border-gold/40 px-3 text-[0.76rem] text-gold hover:border-gold"
        >
          <ClipboardList strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{w.title}</span>
          <span className="shrink-0 text-faint tabular-nums">
            {w.decided}/{w.items}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Switches a Forge sheet to another one in the same place (11-11, the owner: "an arrow that
 * switches to the next Forge project, like swiping"), beside that project's own conversation.
 * Where the sheet isn't one of the Lair's panels, the other one simply opens.
 */
export function useSwapWorkspace() {
  const cave = useCave();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const setState = useWorkspaceState();
  const open = useOpenWorkspace();
  return (from: string, to: Pick<WorkspaceSummary, "id" | "conversationId">) => {
    const current = pathname === "/" ? panelsFrom(params) : [];
    const isWs = (p: Panel, id: string) => p.kind === "workspace" && p.id === id;
    if (!current.some((p) => isWs(p, from))) return open(to);
    setState.mutate({ id: to.id, state: "open" });
    if (to.conversationId) cave.select(to.conversationId);
    // Already open elsewhere: this one steps aside and that one comes to the front.
    const next = current.some((p) => isWs(p, to.id))
      ? current.filter((p) => !isWs(p, from))
      : current.map((p) => (isWs(p, from) ? { kind: p.kind, id: to.id } : p));
    navigate(`/${deskSearch(params, next, `workspace:${to.id}`)}`);
  };
}

/** Opens a workspace beside its own conversation, so the collaboration picks up where it was. */
export function useOpenWorkspace() {
  const cave = useCave();
  const navigate = useNavigate();
  const href = usePanelHref();
  const setState = useWorkspaceState();
  return (w: Pick<WorkspaceSummary, "id" | "conversationId">) => {
    setState.mutate({ id: w.id, state: "open" });
    if (w.conversationId) cave.select(w.conversationId);
    navigate(href(`workspace:${w.id}`)!);
  };
}
