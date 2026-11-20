import { usePhone } from "../../lib/media";
import { DEFAULT_AI_NAME, aiDisplayName } from "@dragon-control/core";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, X } from "lucide-react";
import type { ProjectDetail, Workspace, WorkspaceView } from "@dragon-control/core";
import { api } from "../../data/api";
import {
  putDeskGroup,
  useCloseDeskGroup,
  useDeskGroups,
  type DeskGroup,
  type DeskGroupBody,
} from "../../data/deskGroups";
import { useCave } from "../shell/cave-context";
import { cx } from "../ui";
import { groupWithPanels, keyOf, panelsFrom, type Panel, TOOL_PANELS } from "./layout";

/**
 * Workspace groups. Everything open on the command center at once (its panels, their order and
 * sizes, the conversation beside them, and what was searched, filtered, sorted, or scrolled inside
 * them) is one group, named in the address (`?g=`) and saved on the server while you work.
 *
 * Leaving the command center (any sidebar link) minimizes the group to a pill in the workspace
 * dock, which every page shows; tapping the pill brings every panel back as it was. Restoring one
 * group while another is open minimizes the open one (it is saved first, never replaced).
 * Closing a group is separate and deliberate, and asks first when decisions are unsent.
 * Restoring only shows things: nothing is submitted, approved, or run.
 */

export const GROUP_PARAM = "g";

/** Saves of one group reach the server in the order they were made (a late save never revives a closed group). */
const chains = new Map<string, Promise<void>>();
function inOrder(id: string, send: () => Promise<unknown>) {
  const next = (chains.get(id) ?? Promise.resolve())
    .then(send, send)
    // Keep only the order, not the server's answer.
    .then(
      () => undefined,
      () => undefined,
    );
  chains.set(id, next);
  // Once the last queued save is done, forget the group: every open and close of the desk makes
  // a new group, and keeping each finished chain held memory for the whole page load.
  void next.then(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
}

/** Set by "Minimize all", so leaving for Home keeps the group instead of closing it. */
const minimizing = { current: false };

/** Keeps everything open as one workspace (a pill) and goes to Home. */
export function minimizeGroup(navigate: (to: string) => void) {
  minimizing.current = true;
  navigate("/");
}

/** View state per group, kept here for this page load and saved with the group. */
const views = new Map<string, Record<string, unknown>>();

interface GroupContextValue {
  groupId?: string;
  changed: () => void;
}
const GroupContext = createContext<GroupContextValue>({ changed: () => undefined });
const PanelContext = createContext<string>("desk");

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The command center's address without the group id (what a group restores to). */
function searchOf(params: URLSearchParams): string {
  const s = new URLSearchParams(params);
  s.delete(GROUP_PARAM);
  return s.toString();
}

/** A value kept with the open group (sizes, dock), restored with it. */
export function useGroupView<T>(name: string, initial: T): [T, (value: T) => void] {
  const { groupId, changed } = useContext(GroupContext);
  const [value, setValue] = useState<T>(() => {
    const saved = groupId ? views.get(groupId)?.[name] : undefined;
    return saved === undefined ? initial : (saved as T);
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      if (!groupId) return;
      views.set(groupId, { ...views.get(groupId), [name]: v });
      changed();
    },
    [groupId, name, changed],
  );
  return [value, set];
}

/** A value kept for one panel of the open group (search, filter, sort), restored with it. */
export function usePanelView<T>(name: string, initial: T): [T, (value: T) => void] {
  const panel = useContext(PanelContext);
  return useGroupView(`${panel}:${name}`, initial);
}

/**
 * Remembers where a scrolling area was and puts it back when the group is restored. Content that
 * loads later (a list from the server) is waited for, briefly.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, name: string, ready = true) {
  const panel = useContext(PanelContext);
  const { groupId, changed } = useContext(GroupContext);
  const key = `${panel}:scroll:${name}`;
  useEffect(() => {
    const el = ref.current;
    if (!el || !groupId || !ready) return;
    const saved = Number(views.get(groupId)?.[key] ?? 0);
    let frame = 0;
    let tries = 0;
    const restore = () => {
      if (el.scrollHeight - el.clientHeight >= saved || tries > 60) {
        el.scrollTop = saved;
        return;
      }
      tries += 1;
      frame = requestAnimationFrame(restore);
    };
    if (saved > 0) restore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        views.set(groupId, { ...views.get(groupId), [key]: Math.round(el.scrollTop) });
        changed();
      }, 250);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref, groupId, key, changed, ready]);
}

/** Everything inside belongs to one panel of the group (its view state is kept apart). */
export function PanelScope({ panel, children }: { panel: Panel; children: ReactNode }) {
  return <PanelContext.Provider value={keyOf(panel)}>{children}</PanelContext.Provider>;
}

function serviceName(ws: Workspace, id: string) {
  return [...ws.services, ...ws.inactiveServices].find((s) => s.id === id)?.name ?? id;
}

/** Decisions made in a review but not submitted (or changed since the submission). */
function unsentIn(view: WorkspaceView | undefined): number {
  if (!view) return 0;
  if (!view.submission) return Object.keys(view.selections).length;
  return view.revised?.changed.length ?? 0;
}

/** "Ember · Duplicate Movies Batch 2 · Chaptarr", shortened when there are many. */
export function groupName(names: string[], aiName = DEFAULT_AI_NAME): string {
  const shown = names.slice(0, 2);
  const more = names.length - shown.length;
  return [aiName, ...shown].join(" · ") + (more > 0 ? ` +${more}` : "");
}

/**
 * The open group: makes sure the arrangement has a group id, saves it while you work (and right
 * away when you leave it, switch to another group, or close the tab), and provides its view state.
 */
export function GroupScope({ ws, children }: { ws: Workspace; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const cave = useCave();
  const qc = useQueryClient();
  const groups = useDeskGroups();
  const id = params.get(GROUP_PARAM) ?? undefined;
  const search = searchOf(params);
  const panels = useMemo(() => panelsFrom(new URLSearchParams(search)), [search]);

  // An arrangement without a group (a panel link, or opened from another page) joins the saved
  // group that already has exactly these panels, so opening the same link again does not leave
  // another copy in the dock each time. Only an arrangement no group has becomes a new group.
  // The saved groups are waited for first, or the check would always find nothing.
  const existing = id || groups.isLoading ? undefined : groupWithPanels(groups.data ?? [], panels);
  useEffect(() => {
    if (id || groups.isLoading) return;
    const s = new URLSearchParams(params);
    s.set(GROUP_PARAM, existing?.id ?? newId());
    setParams(s, { replace: true });
  }, [id, groups.isLoading, existing?.id, params, setParams]);

  // After a refresh the saved view state comes from the server before the panels draw.
  const known = id ? views.has(id) : false;
  const saved = id ? groups.data?.find((g) => g.id === id) : undefined;
  if (id && !known && saved) views.set(id, saved.view);
  const ready = Boolean(id) && (known || Boolean(saved) || !groups.isLoading);

  const workspaceIds = panels.filter((p) => p.kind === "workspace").map((p) => p.id);
  const projectIds = panels.filter((p) => p.kind === "project").map((p) => p.id);
  const workspaceViews = useQueries({
    queries: workspaceIds.map((wid) => ({
      queryKey: ["workspaces", "one", wid],
      queryFn: () => api<WorkspaceView>("GET", `/api/workspaces/${encodeURIComponent(wid)}`),
      staleTime: 4_000,
    })),
  });
  const projects = useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ["projects", "detail", pid],
      queryFn: () => api<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(pid)}`),
      staleTime: 15_000,
    })),
  });
  const names = panels.map((p) => {
    if (p.kind === "workspace")
      return workspaceViews[workspaceIds.indexOf(p.id)]?.data?.spec.title ?? "Review";
    if (p.kind === "project") return projects[projectIds.indexOf(p.id)]?.data?.name ?? "Project";
    if (p.kind === "tool") return TOOL_PANELS[p.id as keyof typeof TOOL_PANELS] ?? p.id;
    return serviceName(ws, p.id);
  });
  // Reviews first: they are what the group is usually about.
  const ordered = [
    ...names.filter((_, i) => panels[i]!.kind === "workspace"),
    ...names.filter((_, i) => panels[i]!.kind !== "workspace"),
  ];
  const unsent = workspaceViews.reduce((n, q) => n + unsentIn(q.data), 0);
  const name = groupName(ordered, aiDisplayName(ws.aiName));
  const conversationId = cave.conversationId ?? null;

  // The latest state of this group, for saves that happen after the address has moved on.
  const snapshot = useRef<{ id?: string; body: () => DeskGroupBody; empty: boolean }>({
    body: () => ({ name, search, view: {}, unsent: 0 }),
    empty: true,
  });
  useEffect(() => {
    snapshot.current = {
      id,
      empty: panels.length === 0,
      body: () => ({
        name,
        search,
        conversationId,
        view: (id && views.get(id)) || {},
        unsent,
      }),
    };
  });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useCallback(
    (keepalive = false, closedAll = false) => {
      const snap = snapshot.current;
      if (!snap.id) return;
      const gid = snap.id;
      if (snap.empty || closedAll) {
        qc.setQueryData<DeskGroup[]>(["desk-groups"], (list) => list?.filter((g) => g.id !== gid));
        inOrder(gid, () =>
          fetch(`/api/desk/groups/${encodeURIComponent(gid)}`, { method: "DELETE", keepalive }),
        );
        // A closed group's view state (scroll, filters) is not needed any more.
        views.delete(gid);
        return;
      }
      const body = snap.body();
      // Shown in the dock at once; the server copy follows.
      qc.setQueryData<DeskGroup[]>(["desk-groups"], (list) => {
        const now = new Date().toISOString();
        const others = (list ?? []).filter((g) => g.id !== gid);
        const prev = list?.find((g) => g.id === gid);
        return [
          {
            id: gid,
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
            ...body,
            conversationId: body.conversationId ?? undefined,
          },
          ...others,
        ];
      });
      inOrder(gid, () => putDeskGroup(gid, body, keepalive));
    },
    [qc],
  );
  const changed = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(), 700);
  }, [save]);

  // Saved when what is open, its name, or its conversation changes.
  const signature = JSON.stringify([name, search, conversationId, unsent]);
  useEffect(() => {
    if (id && ready) changed();
  }, [id, ready, signature, changed]);

  // Leaving this group (another page, another group, closing the tab): saved right away.
  useEffect(() => {
    if (!id) return;
    const onHide = () => save(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      clearTimeout(timer.current);
      // Its last panel closed (still on the command center, not minimized): the group is
      // finished, so it is removed instead of becoming a pill.
      const now = new URLSearchParams(window.location.search);
      const closedAll =
        !minimizing.current && window.location.pathname === "/" && panelsFrom(now).length === 0;
      minimizing.current = false;
      save(true, closedAll);
    };
  }, [id, save]);

  const value = useMemo(() => ({ groupId: id, changed }), [id, changed]);
  if (!ready) return <div className="h-full animate-pulse rounded-2xl bg-panel/40" />;
  // Another group restored here starts fresh from its own saved state.
  return (
    <GroupContext.Provider value={value}>
      <Fragment key={id}>{children}</Fragment>
    </GroupContext.Provider>
  );
}

/** Brings a group back exactly as it was saved. */
export function useRestoreGroup() {
  const navigate = useNavigate();
  const cave = useCave();
  return (g: DeskGroup) => {
    views.set(g.id, g.view ?? {});
    if (g.conversationId && g.conversationId !== cave.conversationId) cave.select(g.conversationId);
    const s = new URLSearchParams(g.search);
    s.set(GROUP_PARAM, g.id);
    navigate(`/?${s.toString()}`);
  };
}

function panelCount(g: DeskGroup) {
  return panelsFrom(new URLSearchParams(g.search)).length;
}

/**
 * The workspace dock: one pill per minimized group, on every page. The group open on the
 * command center right now is not shown (it is on screen).
 */
export function WorkspaceDock({
  panelsButton,
  panelsList,
}: {
  /** A phone (11-15): the panels drop-down sits in the same row as Saved workspaces. */
  panelsButton?: ReactNode;
  panelsList?: ReactNode;
} = {}) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const groups = useDeskGroups();
  const restore = useRestoreGroup();
  const close = useCloseDeskGroup();
  const [asking, setAsking] = useState<DeskGroup | undefined>();
  const current = pathname === "/" ? params.get(GROUP_PARAM) : null;
  const list = (groups.data ?? []).filter((g) => g.id !== current && panelCount(g) > 0);
  // A phone (11-13, the owner: "no scrolling side to side"): one button, and the saved
  // workspaces open as a list down the screen instead of a strip running off the side.
  const phone = usePhone();
  // Left open or closed, as this browser last had it.
  const [listOpen, setListOpenState] = useState(() => {
    try {
      return localStorage.getItem("hearth-dock-open") === "1";
    } catch {
      return false;
    }
  });
  const setListOpen = (f: (o: boolean) => boolean) =>
    setListOpenState((o) => {
      const next = f(o);
      try {
        localStorage.setItem("hearth-dock-open", next ? "1" : "0");
      } catch {
        // Private windows: it just isn't remembered.
      }
      return next;
    });
  if (!list.length && !panelsButton) return null;
  const strip = !phone;
  return (
    <div
      className={cx(
        "max-w-full min-w-0 px-4 pt-2 sm:px-6 lg:px-7",
        strip ? "flex items-center gap-2 overflow-x-auto" : "block",
      )}
      data-testid="workspace-dock"
      data-phone-collapse=""
    >
      {phone && (
        <div className="flex flex-wrap items-center gap-2">
          {list.length > 0 && (
            <button
              type="button"
              onClick={() => setListOpen((o) => !o)}
              aria-expanded={listOpen}
              className="flex min-h-9 items-center gap-2 rounded-full border border-gold/40 px-3 text-[0.8rem] text-gold"
              data-testid="workspace-dock-toggle"
            >
              <LayoutGrid strokeWidth={1.35} className="h-4 w-4" aria-hidden />
              Saved workspaces · {list.length}
            </button>
          )}
          {panelsButton}
        </div>
      )}
      {phone && panelsList}
      {strip && (
        <LayoutGrid strokeWidth={1.35} className="h-4 w-4 shrink-0 text-faint" aria-hidden />
      )}
      <div
        className={cx(
          "min-w-0 gap-1.5",
          strip ? "flex" : listOpen && list.length ? "mt-2 flex flex-col" : "hidden",
        )}
        role="group"
        aria-label="Your workspaces"
      >
        {list.map((g) => (
          <span
            key={g.id}
            className={cx(
              "flex min-h-9 shrink-0 items-center rounded-full border border-gold/40 bg-panel/90 pl-3 text-[0.78rem] text-gold",
              strip ? "max-w-[min(18rem,calc(100vw-5.5rem))]" : "w-full justify-between",
            )}
            data-testid="workspace-pill"
          >
            <button
              type="button"
              onClick={() => restore(g)}
              aria-label={`Bring back ${g.name} (${panelCount(g)} panels)`}
              className="flex min-w-0 items-center gap-1.5 hover:text-gold-bright"
            >
              <span className="truncate">{g.name}</span>
              <span
                className="shrink-0 text-faint tabular-nums"
                aria-label={`${panelCount(g)} panels`}
              >
                {panelCount(g)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => (g.unsent > 0 ? setAsking(g) : close.mutate(g.id))}
              aria-label={`Close ${g.name}`}
              className="flex h-9 w-8 shrink-0 items-center justify-center text-faint hover:text-gold"
            >
              <X strokeWidth={1.5} className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
      {asking && (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="close-group-title"
          className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-gold/40 bg-panel p-5 shadow-xl md:bottom-8"
        >
          <p id="close-group-title" className="text-[0.95rem] text-ink">
            Close “{asking.name}”?
          </p>
          <p className="mt-2 text-[0.85rem] leading-relaxed text-muted">
            It has {asking.unsent} decision{asking.unsent === 1 ? "" : "s"} you have not submitted.
            Your choices stay saved with the review (in its conversation and the Forge Library);
            closing only removes this arrangement of panels.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setAsking(undefined)}
              className="min-h-10 rounded-lg border border-line-strong px-4 text-[0.85rem] text-ink hover:border-gold"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={() => {
                close.mutate(asking.id);
                setAsking(undefined);
              }}
              className={cx(
                "min-h-10 rounded-lg bg-gold px-4 text-[0.85rem] text-bg hover:bg-gold-bright",
              )}
            >
              Close workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
