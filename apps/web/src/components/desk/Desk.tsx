import { DownloadHealthPanel } from "../downloads/DownloadHealthPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { aiDisplayName } from "@dragon-control/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Maximize2,
  MoveHorizontal,
  Minimize2,
  PanelLeftClose,
  Pin,
  X,
} from "lucide-react";
import type { Workspace } from "@dragon-control/core";
import { cx, Monogram } from "../ui";
import { useDragScroll } from "../../lib/dragScroll";
import { usePcMarks } from "../../data/pcs";
import { PcMark } from "../devices/PcBadge";
import {
  arrange,
  mergeUsage,
  rankByUse,
  readOrder,
  readUsage,
  recordUse,
  writeOrder,
} from "../../lib/lairUsage";
import { ArrangeSystems } from "./ArrangeSystems";
import { useUpdateSettings } from "../../data/api";
import { isPhoneDevice } from "../../lib/media";
import { usePanelToggle } from "./links";
import { useProject } from "../../data/projects";
import { useCaveConversation, useProjectConversation } from "../../data/cave";
import { CavePanel } from "../cave/CavePanel";
import { DragonEmblem } from "../shell/DragonEmblem";
import { useCave } from "../shell/cave-context";
import { ProjectWorkspace } from "../command/ProjectWorkspace";
import { ServiceWorkspace } from "../command/ServiceWorkspace";
import { TodoToolPanel } from "../todo/TodoToolPanel";
import { ToolImage } from "../panels/ToolImage";
import { StorageCenterPanel } from "../storage/StorageCenterPanel";
import { HomeRowsPanel } from "../homeRows/HomeRowsPanel";
import { CuratorPanel } from "../curator/CuratorPanel";
import { MovieNightsPanel } from "../notify/MovieNightsPanel";
import { CruciblePanel } from "../crucible/CruciblePanel";
import { appKindOf } from "../command/Diagnostics";
import { WorkspacePanel } from "../workspace/WorkspacePanel";
import { MinimizedWorkspaces, useAutoOpenWorkspaces } from "../workspace/dock";
import { useWorkspace } from "../../data/workspaces";
import { PanelChromeProvider } from "./chrome";
import { minimizeGroup, PanelScope, useGroupView } from "./groups";
import { LayoutsMenu } from "./LayoutsMenu";
import {
  deskSearch,
  focusFrom,
  keyOf,
  PANEL_MIN_WIDTH,
  panelsFrom,
  slotsFor,
  panelRow,
  clampStart,
  startShowing,
  withPanel,
  type Panel,
  TOOL_PANELS,
} from "./layout";
import { PanelLifecycleProvider } from "../panels/lifecycle";
import { TOUR_PANELS, useTouring } from "../../data/show";

/**
 * The desktop command center: Ember docked on the left, any number of
 * service and project panels beside it. What is open lives in the address;
 * how wide the dock is lives in this browser. Nothing here opens, closes, or
 * moves a panel unless you do it: when there is no room, the least recently
 * used unpinned panel waits in the "also open" strip.
 */

type DockMode = "docked" | "min" | "wide";
interface Dock {
  width: number;
  mode: DockMode;
}
const DOCK_KEY = "dc-desk-dock";
const DOCK_MIN = 320;
const RAIL = 64;

function readDock(): Dock {
  try {
    const d = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "{}") as Partial<Dock>;
    return {
      width: typeof d.width === "number" ? d.width : 380,
      mode: d.mode === "min" || d.mode === "wide" ? d.mode : "docked",
    };
  } catch {
    return { width: 380, mode: "docked" };
  }
}
function saveDock(d: Dock) {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(d));
  } catch {
    // Only the remembered width is lost.
  }
}

/** The element's width, kept current as the window or the sidebar changes. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Drag to resize: reports the horizontal distance moved since the press. */
function Handle({
  label,
  value,
  min,
  max,
  onDrag,
  onDone,
}: {
  label: string;
  /** Current size, announced to assistive technology. */
  value: number;
  min: number;
  max: number;
  onDrag: (dx: number) => void;
  onDone?: () => void;
}) {
  const start = useRef<number | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={(e) => {
        if (start.current !== null) onDrag(e.clientX - start.current);
      }}
      onPointerUp={() => {
        start.current = null;
        onDone?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onDrag(e.key === "ArrowLeft" ? -24 : 24);
          onDone?.();
        }
      }}
      className="group relative w-4 shrink-0 cursor-col-resize touch-none focus:outline-none"
    >
      <span className="absolute inset-y-6 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-gold/40 group-focus-visible:bg-gold/70" />
    </div>
  );
}

function PanelName({ panel, ws }: { panel: Panel; ws: Workspace }) {
  const project = useProject(panel.kind === "project" ? panel.id : undefined);
  const workspace = useWorkspace(panel.kind === "workspace" ? panel.id : undefined);
  if (panel.kind === "project") return <>{project.data?.name ?? "Project"}</>;
  if (panel.kind === "workspace") return <>{workspace.data?.spec.title ?? "Workspace"}</>;
  if (panel.kind === "tool")
    return <>{TOOL_PANELS[panel.id as keyof typeof TOOL_PANELS] ?? panel.id}</>;
  const s = [...ws.services, ...ws.inactiveServices].find((x) => x.id === panel.id);
  return <>{s?.name ?? panel.id}</>;
}

/** An open project's own conversation, one click away in the dock. */
function ProjectChatChip({ projectId }: { projectId: string }) {
  const cave = useCave();
  const project = useProject(projectId);
  const convo = useProjectConversation(projectId);
  const id = convo.data?.id;
  const active = Boolean(id) && cave.conversationId === id;
  return (
    <button
      type="button"
      disabled={!id}
      aria-pressed={active}
      aria-label={`${project.data?.name ?? "Project"} conversation`}
      onClick={() => id && cave.select(id)}
      className={cx(
        "min-h-8 max-w-[12rem] truncate rounded-full border px-3 text-[0.76rem]",
        active ? "border-gold/60 text-gold" : "border-line text-muted hover:text-ink",
      )}
    >
      {project.data?.name ?? "Project"}
    </button>
  );
}

export function Desk({ ws }: { ws: Workspace }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const cave = useCave();
  const aiName = aiDisplayName(ws.aiName);
  // A system you removed from Hearth does not keep a panel open.
  const removed = new Set(ws.removedServices.map((s) => s.id));
  const panels = panelsFrom(params).filter((p) => !(p.kind === "service" && removed.has(p.id)));
  const focus = focusFrom(params, panels);
  const [recent, setRecent] = useState<string[]>([]);
  const order = focus ? [focus, ...recent.filter((k) => k !== focus)] : recent;
  const [dock, setDockState] = useGroupView<Dock>("desk:dock", readDock());
  const [dragDock, setDragDock] = useState<number | null>(null);
  const [weights, setWeights] = useGroupView<Record<string, number>>("desk:weights", {});
  // One panel temporarily filling the panel area (kept with the workspace group, so minimizing
  // and restoring the whole workspace keeps it). The others stay open underneath, untouched.
  const [expandedKey, setExpanded] = useGroupView<string | null>("desk:expanded", null);
  const [dragging, setDragging] = useState<{ key: string; base: Record<string, number> } | null>(
    null,
  );
  const [clearedFor, setClearedFor] = useState<string | undefined>();
  const areaRef = useRef<HTMLDivElement>(null);
  const width = useWidth(areaRef);
  const convo = useCaveConversation(cave.conversationId);

  const setDock = (d: Dock) => {
    setDockState(d);
    saveDock(d);
  };
  const maxDock = Math.max(DOCK_MIN, Math.round(width * 0.55));
  const dockWidth =
    dock.mode === "min"
      ? RAIL
      : dock.mode === "wide"
        ? width
        : Math.min(
            maxDock,
            // A tablet held upright (11-15): the chat narrows so one panel still fits beside it.
            Math.max(280, width - PANEL_MIN_WIDTH - 16),
            Math.max(DOCK_MIN, dragDock ?? dock.width),
          );
  // While Ember shows you something: at most three panels beside the chat (data/show.ts).
  const touring = useTouring();
  const slots =
    dock.mode === "wide"
      ? 0
      : touring
        ? Math.min(TOUR_PANELS, slotsFor(width, dockWidth))
        : slotsFor(width, dockWidth);
  // The panels slide (11-16, the owner): a window of `slots` along the row; a panel opened while
  // the row is full joins the queue at the end instead of squeezing the others, and the arrows
  // (or its name below) bring it in. Ember's chat never moves.
  // Pinned panels always stay; the others slide in the room left beside them.
  const pinnedShown = panels.filter((p) => p.pinned).slice(0, Math.max(slots, 1));
  const row = panelRow(panels).filter((p) => !p.pinned);
  const room = Math.max(0, Math.max(slots, 1) - pinnedShown.length);
  const [startWanted, setStart] = useGroupView<number>("desk:start", 0);
  const start = clampStart(startWanted, row.length, room);
  const rowKeys = row.map(keyOf).join("|");
  const seen = useRef<Set<string>>(new Set(row.map(keyOf)));
  useEffect(() => {
    // A panel brought forward that was already open slides into view; a new one waits.
    const known = seen.current;
    seen.current = new Set(row.map(keyOf));
    if (!focus || !known.has(focus)) return;
    const i = row.findIndex((p) => keyOf(p) === focus);
    if (i >= 0) {
      const next = startShowing(i, start, room);
      if (next !== start) setStart(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the focus or the row changes
  }, [focus, rowKeys, room]);
  const shownKeys = new Set([...pinnedShown, ...row.slice(start, start + room)].map(keyOf));
  const visible = dock.mode === "wide" ? [] : panels.filter((p) => shownKeys.has(keyOf(p)));
  const waiting = panels.filter((p) => !visible.includes(p));
  // Equal shares (11-16, the owner): whenever the panels on screen change (one opened, closed or
  // slid in), they split the room equally again; a width you drag yourself lasts until then.
  const visibleKeys = visible.map(keyOf).join("|");
  const lastVisible = useRef(visibleKeys);
  useEffect(() => {
    if (lastVisible.current === visibleKeys) return;
    lastVisible.current = visibleKeys;
    if (Object.keys(weights).length) setWeights({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the panels shown change
  }, [visibleKeys]);
  const before = dock.mode === "wide" ? 0 : start;
  const after = dock.mode === "wide" ? 0 : Math.max(0, row.length - start - room);
  const expanded =
    expandedKey && visible.length > 1 && visible.some((p) => keyOf(p) === expandedKey)
      ? expandedKey
      : null;
  // Escape puts the panels back, unless a dialog or menu is open (it closes that first).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("dialog[open], [role=dialog], [role=alertdialog]")) return;
      setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, setExpanded]);

  const commit = (next: Panel[], nextFocus?: string, replace = false) => {
    const s = deskSearch(params, next, nextFocus);
    setParams(new URLSearchParams(s.startsWith("?") ? s.slice(1) : s), { replace });
  };
  const touch = (key: string) => {
    setRecent((r) => [key, ...r.filter((k) => k !== key)].slice(0, 24));
    const i = row.findIndex((p) => keyOf(p) === key);
    if (i >= 0) setStart(startShowing(i, start, room));
    if (key !== focus) commit(panels, key, true);
  };
  const close = (key: string) => {
    if (key === expandedKey) setExpanded(null);
    const next = panels.filter((p) => keyOf(p) !== key);
    const nextFocus = order.find((k) => k !== key && next.some((p) => keyOf(p) === k));
    setRecent((r) => r.filter((k) => k !== key));
    commit(next, nextFocus);
  };
  const update = (key: string, change: Partial<Panel>) =>
    commit(
      panels.map((p) => (keyOf(p) === key ? { ...p, ...change } : p)),
      focus,
      true,
    );
  const move = (key: string, dir: -1 | 1) => {
    // Swap with the neighbouring visible panel, so the move is always visible.
    const vi = visible.findIndex((p) => keyOf(p) === key);
    const other = visible[vi + dir];
    if (!other) return;
    const next = [...panels];
    const a = next.findIndex((p) => keyOf(p) === key);
    const b = next.findIndex((p) => keyOf(p) === keyOf(other));
    [next[a], next[b]] = [next[b]!, next[a]!];
    commit(next, focus, true);
  };
  // Workspaces Ember opens in this conversation appear beside it (the newest focused).
  const latest = useRef({ panels, params });
  useEffect(() => {
    latest.current = { panels, params };
  });
  const openWorkspaces = useCallback(
    (ids: string[], quiet = false) => {
      let next = latest.current.panels;
      for (const id of ids) next = withPanel(next, { kind: "workspace", id });
      const s = deskSearch(
        latest.current.params,
        next,
        quiet && latest.current.panels.length
          ? focusFrom(latest.current.params, latest.current.panels)
          : `workspace:${ids.at(-1)}`,
      );
      setParams(new URLSearchParams(s.startsWith("?") ? s.slice(1) : s));
    },
    [setParams],
  );
  useAutoOpenWorkspaces(cave.conversationId, panels, openWorkspaces);

  const closeUnpinned = () => {
    const next = panels.filter((p) => p.pinned);
    commit(next, next.at(-1) ? keyOf(next.at(-1)!) : undefined);
  };

  // "This" in the conversation means the panel you last used, until you clear it.
  const focused = panels.find((p) => keyOf(p) === focus);
  const focusedService =
    focused?.kind === "service"
      ? [...ws.services, ...ws.inactiveServices].find((s) => s.id === focused.id)
      : undefined;
  const focusedProject = useProject(focused?.kind === "project" ? focused.id : undefined);
  // Something selected inside an open service panel comes first ("this torrent").
  const selected =
    cave.item && panels.some((p) => p.kind === "service" && p.id === cave.item!.serviceId)
      ? cave.item
      : undefined;
  const selectedService = selected
    ? [...ws.services, ...ws.inactiveServices].find((s) => s.id === selected.serviceId)
    : undefined;
  const chip = selected
    ? {
        kind: "service" as const,
        id: selected.serviceId,
        item: { kind: selected.kind, id: selected.id },
        label: `${selected.label}${selectedService ? ` (${selectedService.name})` : ""}`,
      }
    : !focused || clearedFor === focus
      ? undefined
      : focused.kind === "service" && focusedService
        ? { kind: "service" as const, id: focusedService.id, label: focusedService.name }
        : focused.kind === "project" && focusedProject.data
          ? { kind: "project" as const, id: focused.id, label: focusedProject.data.name }
          : undefined;
  const openProjects = panels.filter((p) => p.kind === "project");

  const panelArea = width - dockWidth - (dock.mode === "docked" ? 16 : 0);
  const totalWeight = visible.reduce((n, p) => n + (weights[keyOf(p)] ?? 1), 0) || 1;

  return (
    <div
      ref={areaRef}
      className="flex h-[calc(100dvh-7.5rem)] min-h-[32rem] w-full md:h-full md:min-h-[24rem]"
      data-testid="desk"
      data-slots={slots}
    >
      {/* The conversation dock */}
      {dock.mode === "min" ? (
        <div
          className="flex w-16 shrink-0 flex-col items-center gap-3 rounded-2xl border border-gold/35 bg-panel/95 py-4"
          data-testid="desk-dock-rail"
        >
          <button
            type="button"
            onClick={() => setDock({ ...dock, mode: "docked" })}
            aria-label={`Show ${aiName}`}
            className="relative rounded-full"
          >
            <DragonEmblem className="h-10 w-10" />
            {convo.data?.status === "working" && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-gold motion-reduce:animate-none"
                aria-label="Working on an answer"
              />
            )}
          </button>
          <span className="text-[0.66rem] tracking-[0.12em] text-faint uppercase [writing-mode:vertical-rl]">
            {aiName}
          </span>
        </div>
      ) : (
        <div
          className="flex shrink-0 flex-col"
          style={{ width: dockWidth }}
          data-testid="desk-dock"
        >
          <div className="mb-2 flex items-center gap-1.5">
            <div
              className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto"
              role="group"
              aria-label="Which conversation"
            >
              <button
                type="button"
                aria-pressed={cave.isMain}
                onClick={() => cave.selectMain()}
                className={cx(
                  "min-h-8 shrink-0 rounded-full border px-3 text-[0.76rem]",
                  cave.isMain
                    ? "border-gold/60 text-gold"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                Current conversation
              </button>
              {openProjects.map((p) => (
                <ProjectChatChip key={p.id} projectId={p.id} />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDock({ ...dock, mode: dock.mode === "wide" ? "docked" : "wide" })}
              aria-label={dock.mode === "wide" ? "Show the panels again" : `Widen ${aiName}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
            >
              {dock.mode === "wide" ? (
                <Minimize2 strokeWidth={1.5} className="h-4 w-4" />
              ) : (
                <MoveHorizontal strokeWidth={1.5} className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setDock({ ...dock, mode: "min" })}
              aria-label={`Minimize ${aiName}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
            >
              <PanelLeftClose strokeWidth={1.5} className="h-4 w-4" />
            </button>
          </div>
          <CavePanel
            className="min-h-0 flex-1"
            focus={chip}
            onClearFocus={() => (selected ? cave.selectItem(undefined) : setClearedFor(focus))}
          />
        </div>
      )}
      {dock.mode === "docked" && panels.length > 0 && (
        <Handle
          label={`Resize ${aiName}`}
          value={dockWidth}
          min={DOCK_MIN}
          max={maxDock}
          onDrag={(dx) => setDragDock(dock.width + dx)}
          onDone={() => {
            if (dragDock !== null) setDock({ ...dock, width: dockWidth });
            setDragDock(null);
          }}
        />
      )}
      {dock.mode === "min" && <div className="w-4 shrink-0" />}

      {/* The panels */}
      {dock.mode !== "wide" && (
        <div className="flex min-w-0 flex-1 flex-col">
          <LairSystems ws={ws} open={panels.map(keyOf)} />
          <div className="mb-2 flex min-h-8 items-center gap-2" data-testid="desk-strip">
            <LayoutGrid strokeWidth={1.35} className="h-4 w-4 shrink-0 text-gold" />
            {/* The Lair: Ember beside your systems' panels, where it builds lists,
                workflows, and plans with you. */}
            <p
              className="shrink-0 text-[0.76rem] font-medium tracking-[0.14em] uppercase"
              style={{ color: "var(--color-accent)" }}
              data-testid="lair-name"
            >
              The Lair
            </p>
            <p className="shrink-0 text-[0.76rem] text-faint">
              · {panels.length} open{waiting.length ? `, ${visible.length} shown` : ""}
            </p>
            <div
              className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto"
              role="group"
              aria-label="Also open"
            >
              {waiting.map((p) => (
                <span
                  key={keyOf(p)}
                  className="flex min-h-8 shrink-0 items-center rounded-full border border-line pl-3 text-[0.76rem] text-muted"
                >
                  <button
                    type="button"
                    onClick={() => touch(keyOf(p))}
                    className="hover:text-gold"
                    title="Show this panel"
                  >
                    {p.pinned && (
                      <Pin className="mr-1 inline h-3 w-3 text-gold" strokeWidth={1.5} />
                    )}
                    <PanelName panel={p} ws={ws} />
                  </button>
                  <button
                    type="button"
                    onClick={() => close(keyOf(p))}
                    aria-label="Close panel"
                    className="flex h-8 w-7 items-center justify-center text-faint hover:text-gold"
                  >
                    <X strokeWidth={1.5} className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <MinimizedWorkspaces
              conversationId={cave.conversationId}
              onOpen={(id) => openWorkspaces([id])}
            />
            <button
              type="button"
              onClick={() => minimizeGroup(navigate)}
              title="Keep this Lair as it is (everything stays open) and go back to Home"
              className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[0.76rem] text-muted hover:border-gold/50 hover:text-gold"
            >
              <Minimize2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Minimize all
            </button>
            {panels.some((p) => !p.pinned) && panels.length > 1 && (
              <button
                type="button"
                onClick={closeUnpinned}
                className="min-h-8 shrink-0 rounded-full px-2 text-[0.76rem] text-faint hover:text-gold"
              >
                Close unpinned
              </button>
            )}
            <LayoutsMenu
              panels={panels}
              dock={dock}
              onOpen={(next, d) => {
                if (d) setDock({ width: d.width ?? dock.width, mode: d.mode ?? "docked" });
                commit(next, next.at(-1) ? keyOf(next.at(-1)!) : undefined);
              }}
            />
            {(before > 0 || after > 0) && (
              <div
                className="flex shrink-0 items-center gap-1"
                role="group"
                aria-label="Slide the panels"
                data-testid="panel-slide"
              >
                <button
                  type="button"
                  onClick={() => setStart(start - 1)}
                  disabled={before === 0}
                  aria-label={`Slide the panels back (${before} before)`}
                  title="Slide the panels back"
                  className="relative flex h-8 w-8 items-center justify-center rounded-full border border-line text-muted hover:border-gold/50 hover:text-gold disabled:opacity-35"
                  data-testid="panel-slide-back"
                >
                  <ChevronLeft strokeWidth={1.75} className="h-4 w-4" />
                </button>
                <span className="min-w-12 text-center text-[0.72rem] text-faint tabular-nums">
                  {before + 1}-{Math.min(row.length, before + room)} of {row.length}
                </span>
                <button
                  type="button"
                  onClick={() => setStart(start + 1)}
                  disabled={after === 0}
                  aria-label={`Slide the panels on (${after} waiting)`}
                  title="Slide the panels on"
                  className={cx(
                    "relative flex h-8 w-8 items-center justify-center rounded-full border text-muted hover:text-gold disabled:opacity-35",
                    after > 0 ? "border-gold/60 text-gold" : "border-line",
                  )}
                  data-testid="panel-slide-on"
                >
                  <ChevronRight strokeWidth={1.75} className="h-4 w-4" />
                  {after > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[0.62rem] font-semibold text-bg">
                      {after}
                    </span>
                  )}
                </button>
              </div>
            )}
          </div>
          <div className="relative flex min-h-0 flex-1" data-expanded={expanded ?? undefined}>
            {visible.length === 0 && <LairStart aiName={aiName} />}
            {visible.map((p, i) => {
              const key = keyOf(p);
              const share = (weights[key] ?? 1) / totalWeight;
              const isExpanded = expanded === key;
              const covered = Boolean(expanded) && !isExpanded;
              const controls = (
                <div className="flex shrink-0 items-center">
                  {visible.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded(isExpanded ? null : key);
                        if (!isExpanded) touch(key);
                      }}
                      aria-label={isExpanded ? "Restore panels" : "Expand panel"}
                      aria-pressed={isExpanded}
                      title={
                        isExpanded
                          ? "Put the panels back as they were (Esc)"
                          : `Show this panel in the whole space beside ${aiName} for now`
                      }
                      className={cx(
                        "flex h-9 w-9 items-center justify-center rounded-lg hover:text-gold",
                        isExpanded ? "text-gold" : "text-faint",
                      )}
                    >
                      {isExpanded ? (
                        <Minimize2 strokeWidth={1.5} className="h-4 w-4" />
                      ) : (
                        <Maximize2 strokeWidth={1.5} className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  {visible.length > 1 && !expanded && (
                    <>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => move(key, -1)}
                        aria-label="Move panel left"
                        className="flex h-9 w-8 items-center justify-center rounded-lg text-faint hover:text-gold disabled:opacity-30"
                      >
                        <ChevronLeft strokeWidth={1.5} className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={i === visible.length - 1}
                        onClick={() => move(key, 1)}
                        aria-label="Move panel right"
                        className="flex h-9 w-8 items-center justify-center rounded-lg text-faint hover:text-gold disabled:opacity-30"
                      >
                        <ChevronRight strokeWidth={1.5} className="h-4 w-4" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => update(key, { pinned: !p.pinned })}
                    aria-label={p.pinned ? "Unpin panel" : "Pin panel"}
                    aria-pressed={Boolean(p.pinned)}
                    className={cx(
                      "flex h-9 w-9 items-center justify-center rounded-lg hover:text-gold",
                      p.pinned ? "text-gold" : "text-faint",
                    )}
                  >
                    {p.pinned ? (
                      <Pin strokeWidth={1.5} className="h-4 w-4 fill-gold/40" />
                    ) : (
                      <Pin strokeWidth={1.25} className="h-4 w-4" />
                    )}
                  </button>
                </div>
              );
              return (
                <div
                  key={key}
                  // Covered panels keep their place, size, and scroll; they are only hidden.
                  className={cx("flex min-w-0", covered && "invisible")}
                  inert={covered}
                  aria-hidden={covered || undefined}
                  style={{ flex: `${share} 1 0`, minWidth: 320 }}
                >
                  {i > 0 && expanded && <div className="w-4 shrink-0" aria-hidden />}
                  {i > 0 && !expanded && (
                    <Handle
                      label="Resize panels"
                      value={share * 100}
                      min={0}
                      max={100}
                      onDrag={(dx) => {
                        const base = dragging?.key === key ? dragging.base : weights;
                        if (dragging?.key !== key) setDragging({ key, base: weights });
                        const prev = keyOf(visible[i - 1]!);
                        const unit = panelArea / totalWeight || 1;
                        const delta = dx / unit;
                        const a = Math.max(0.35, (base[prev] ?? 1) + delta);
                        const b = Math.max(0.35, (base[key] ?? 1) - delta);
                        setWeights({ ...base, [prev]: a, [key]: b });
                      }}
                      onDone={() => setDragging(null)}
                    />
                  )}
                  <div
                    className={cx(
                      "flex min-h-0 min-w-0 flex-1 flex-col",
                      // Over the whole panel area; its own slot stays reserved underneath.
                      isExpanded && "absolute inset-0 z-10",
                    )}
                    data-testid="desk-panel"
                    data-panel={key}
                    data-expanded={isExpanded || undefined}
                  >
                    <PanelScope panel={p}>
                      <PanelLifecycleProvider
                        value={{ panel: key, visibility: covered ? "covered" : "visible" }}
                      >
                        <PanelChromeProvider
                          value={{
                            idPrefix: `${p.kind}-${p.id}-`,
                            controls,
                            compact: visible.length > 1 && !isExpanded,
                            focused: key === focus,
                            onFocus: () => touch(key),
                          }}
                        >
                          {p.kind === "tool" && p.id === "browser" ? (
                            <BrowserPanel onClose={() => close(key)} />
                          ) : p.kind === "tool" && p.id === "curator" ? (
                            <CuratorPanel onClose={() => close(key)} />
                          ) : p.kind === "tool" && p.id === "movie-nights" ? (
                            <MovieNightsPanel onClose={() => close(key)} />
                          ) : p.kind === "tool" && p.id === "crucible" ? (
                            <CruciblePanel onClose={() => close(key)} />
                          ) : p.kind === "tool" && p.id === "home-rows" ? (
                            <HomeRowsPanel
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          ) : p.kind === "tool" && p.id === "downloads" ? (
                            <DownloadHealthPanel
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          ) : p.kind === "tool" && p.id === "todo" ? (
                            <TodoToolPanel
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          ) : p.kind === "tool" ? (
                            <StorageCenterPanel
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          ) : p.kind === "workspace" ? (
                            <WorkspacePanel
                              id={p.id}
                              onClose={() => close(key)}
                              onMinimize={() => close(key)}
                            />
                          ) : p.kind === "project" ? (
                            <ProjectWorkspace
                              id={p.id}
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          ) : (
                            <ServiceWorkspace
                              ws={ws}
                              id={p.id}
                              tab={p.tab ?? null}
                              onTab={(t) => update(key, { tab: t })}
                              onClose={() => close(key)}
                            />
                          )}
                        </PanelChromeProvider>
                      </PanelLifecycleProvider>
                    </PanelScope>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every system along the top of the Lair: each one is an on/off switch. On opens its panel and
 * brings it to the front; off closes it. Open ones are lit. The ones you open most sit at the
 * front; the order is set when the Lair opens so chips never jump while you are clicking.
 * Arrange opens a box where you drag the systems into your own order (kept in this browser);
 * Done puts it on the bar, Most used first goes back to the automatic order.
 */
export function LairSystems({
  ws,
  open,
  wrap = false,
  onPick,
  hrefOf,
}: {
  ws: Workspace;
  open: string[];
  /** A phone (11-15): the systems wrap onto more lines instead of a row running off the side. */
  wrap?: boolean;
  onPick?: () => void;
  /** Where a bubble goes, when not the desktop's on/off switch (a phone adds to its ring). */
  hrefOf?: (key: string) => string;
}) {
  const toggle = usePanelToggle();
  const navigate = useNavigate();
  const strip = useDragScroll<HTMLDivElement>();
  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null);
  const pcMark = usePcMarks();
  // The order and the counts are kept on Hearth, so your phone and desktop show the systems the
  // same way (11-16, the owner: "the panels on mobile should be in the same order as the ones on
  // the desktop"). This browser's own copy is only the fallback.
  const saveSettings = useUpdateSettings().mutate;
  const [usage] = useState(() => mergeUsage(readUsage(), ws.lairUsage));
  const [localOrder] = useState(readOrder);
  // What you just chose here shows at once, before Hearth's copy comes back.
  const [chosen, setChosen] = useState<{ order: string[] | undefined }>();
  const order = chosen ? chosen.order : (ws.lairOrder ?? localOrder);
  const setOrder = (next: string[] | undefined) => {
    setChosen({ order: next });
    writeOrder(next);
    saveSettings({ lairOrder: next ?? null });
  };
  // Before this, the order lived only in each browser: the desktop's own (where the owner
  // arranged it) is carried over to Hearth once; a phone's never replaces it.
  const carried = useRef(false);
  useEffect(() => {
    if (carried.current || ws.lairOrder || !localOrder?.length || isPhoneDevice()) return;
    carried.current = true;
    saveSettings({ lairOrder: localOrder });
  }, [ws.lairOrder, localOrder, saveSettings]);
  const [arranging, setArranging] = useState(false);
  // Count each panel as it opens, however it was opened (here, the sidebar, or Ember), here and
  // on Hearth.
  const seen = useRef<Set<string> | null>(null);
  const openKey = open.join("|");
  useEffect(() => {
    const now = openKey ? openKey.split("|") : [];
    if (seen.current) {
      const added = now.filter((k) => !seen.current!.has(k));
      if (added.length) {
        recordUse(added);
        saveSettings({ lairUsage: readUsage() });
      }
    }
    seen.current = new Set(now);
  }, [openKey, saveSettings]);
  const items = [
    {
      key: "tool:storage",
      name: "Storage & Files",
      image: undefined as string | undefined,
      pcId: undefined as string | undefined,
    },
    {
      key: "tool:todo",
      name: "To-do",
      image: undefined as string | undefined,
      pcId: undefined as string | undefined,
    },
    {
      key: "tool:browser",
      name: "Ember's Browser",
      image: undefined as string | undefined,
      pcId: undefined as string | undefined,
    },
    // Download Health, once there is a download client to watch.
    ...(ws.services.some((s) => ["qbittorrent", "sabnzbd"].includes(appKindOf(s) ?? ""))
      ? [
          {
            key: "tool:downloads",
            name: "Download Health",
            image: undefined as string | undefined,
            pcId: undefined as string | undefined,
          },
        ]
      : []),
    // Home rows, once there is a Plex to design for.
    ...(ws.services.some((s) => appKindOf(s) === "plex")
      ? [
          {
            key: "tool:home-rows",
            name: "Home rows",
            image: undefined as string | undefined,
            pcId: undefined as string | undefined,
          },
        ]
      : []),
    // Movie nights, once there is a media server to pick the movie from.
    ...(ws.services.some((s) => ["plex", "jellyfin", "emby"].includes(appKindOf(s) ?? ""))
      ? [
          {
            key: "tool:movie-nights",
            name: "Movie nights",
            image: undefined as string | undefined,
            pcId: undefined as string | undefined,
          },
        ]
      : []),
    // The Crucible (quality and size), once there is Radarr or Sonarr.
    ...(ws.services.some((s) => ["radarr", "sonarr"].includes(appKindOf(s) ?? ""))
      ? [
          {
            key: "tool:crucible",
            name: "The Crucible",
            image: undefined as string | undefined,
            pcId: undefined as string | undefined,
          },
        ]
      : []),
    // Curator, once there is Seerr, Lidarr or Chaptarr to check suggestions against.
    ...(ws.services.some((s) => ["seerr", "lidarr", "chaptarr"].includes(appKindOf(s) ?? ""))
      ? [
          {
            key: "tool:curator",
            name: "Curator",
            image: undefined as string | undefined,
            pcId: undefined as string | undefined,
          },
        ]
      : []),
    ...ws.services.map((s) => ({
      key: `service:${s.id}`,
      name: s.name,
      image: s.image,
      pcId: s.pcId,
    })),
  ];
  const entries = arrange(items, order, usage);
  const toolOf = (key: string) =>
    key === "tool:storage"
      ? "storage"
      : key === "tool:todo"
        ? "todo"
        : key === "tool:browser"
          ? "browser"
          : key === "tool:home-rows"
            ? "home-rows"
            : key === "tool:downloads"
              ? "downloads"
              : key === "tool:curator"
                ? "curator"
                : key === "tool:movie-nights"
                  ? "movie-nights"
                  : key === "tool:crucible"
                    ? "crucible"
                    : undefined;
  if (!ws.services.length) return null;
  const chip = (e: (typeof entries)[number]) => {
    const t = toggle(e.key);
    const lit = t.open || open.includes(e.key);
    const tool = toolOf(e.key);
    return (
      <button
        type="button"
        key={e.key}
        onClick={() => {
          navigate(hrefOf ? hrefOf(e.key) : t.href);
          onPick?.();
        }}
        aria-label={e.name}
        aria-pressed={lit}
        title={t.open ? `Close ${e.name}'s panel` : `Open ${e.name} here`}
        data-testid={tool ? `lair-${tool}` : undefined}
        className={cx(
          "flex min-h-9 shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[0.8rem] transition-colors",
          lit
            ? "border-gold bg-gold/15 text-gold"
            : "border-line text-muted hover:border-gold/50 hover:text-ink",
        )}
      >
        {tool ? (
          <ToolImage id={tool} className="h-7 w-7" />
        ) : (
          <Monogram name={e.name} image={e.image} className="h-7 w-7 text-[0.7rem]" />
        )}
        {e.name}
        {!tool && <PcMark mark={pcMark(e.pcId)} size={16} />}
      </button>
    );
  };
  const tools = entries.filter((e) => toolOf(e.key));
  return (
    <div className="mb-2 space-y-1.5">
      {/* Ember's own panels on a row of their own, above your systems (11-07). */}
      {tools.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={`${aiDisplayName(ws.aiName)}'s panels`}
          data-testid="lair-tools"
        >
          {tools.map(chip)}
        </div>
      )}
      <div className={cx("flex gap-1.5", wrap ? "flex-col items-start" : "items-start")}>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => setArranging(true)}
            aria-haspopup="dialog"
            title="Arrange these systems"
            className="flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[0.78rem] text-muted transition-colors hover:border-gold/50 hover:text-ink"
            data-testid="lair-arrange"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Arrange
          </button>
          {arranging && (
            <ArrangeSystems
              entries={entries.map((e) => {
                const tool = toolOf(e.key);
                return {
                  key: e.key,
                  name: e.name,
                  icon: tool ? (
                    <ToolImage id={tool} className="h-6 w-6" />
                  ) : (
                    <Monogram name={e.name} image={e.image} className="h-6 w-6 text-[0.65rem]" />
                  ),
                };
              })}
              automatic={rankByUse(items, usage).map((e) => e.key)}
              onCancel={() => setArranging(false)}
              onDone={(next) => {
                setOrder(next);
                setArranging(false);
              }}
            />
          )}
        </div>
        {wrap ? (
          <div
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
            role="group"
            aria-label="Systems in the Lair"
            data-testid="lair-systems"
          >
            {entries.filter((e) => !toolOf(e.key)).map(chip)}
          </div>
        ) : (
          <>
            <StripArrow el={stripEl} dir={-1} />
            <div
              ref={(n) => {
                strip(n);
                setStripEl(n);
              }}
              className="flex min-w-0 flex-1 cursor-grab gap-1.5 overflow-x-auto pb-1 select-none data-[dragging]:cursor-grabbing"
              role="group"
              aria-label="Systems in the Lair"
              data-testid="lair-systems"
            >
              {entries.filter((e) => !toolOf(e.key)).map(chip)}
            </div>
            <StripArrow el={stripEl} dir={1} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A step left or right along the systems row, shown only when there is more that way (11-07:
 * the sideways row was too hard to get along with the wheel alone).
 */
function StripArrow({ el, dir }: { el: HTMLDivElement | null; dir: 1 | -1 }) {
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = () =>
      setMore(dir < 0 ? el.scrollLeft > 2 : el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [el, dir]);
  return (
    <button
      type="button"
      onClick={() => el?.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: "smooth" })}
      disabled={!more}
      aria-label={dir < 0 ? "Earlier systems" : "More systems"}
      className={cx(
        "grid h-9 w-8 shrink-0 place-items-center rounded-full border border-line text-muted transition-opacity hover:border-gold/50 hover:text-ink",
        !more && "pointer-events-none opacity-0",
      )}
      data-testid={dir < 0 ? "lair-systems-left" : "lair-systems-right"}
    >
      {dir < 0 ? (
        <ChevronLeft strokeWidth={1.75} className="h-4 w-4" />
      ) : (
        <ChevronRight strokeWidth={1.75} className="h-4 w-4" />
      )}
    </button>
  );
}

/** A fresh Lair with nothing open yet. */
function LairStart({ aiName }: { aiName: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong p-6 text-center"
      data-testid="lair-start"
    >
      <h2 className="font-display text-[1.6rem] text-ink">Open something beside {aiName}</h2>
      <p className="mt-1 max-w-md text-[0.88rem] text-muted">
        Turn on a system above (or in the sidebar) to work on it here, or ask {aiName} on the left
        and it will open what it needs.
      </p>
    </div>
  );
}
