import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ClipboardCheck,
  FolderOpen,
  GripVertical,
  HardDrive,
  ListTodo,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
} from "lucide-react";
import type { Service, Workspace } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useProjects } from "../../data/projects";
import { useDesk } from "../desk/links";
import { PanelChromeProvider } from "../desk/chrome";
import { PanelScope } from "../desk/groups";
import { ServiceWorkspace } from "../command/ServiceWorkspace";
import { ProjectWorkspace } from "../command/ProjectWorkspace";
import { Monogram, cx } from "../ui";
import { TodoPanel, PlansPanel } from "./panels";
import { StorageCenterPanel } from "../storage/StorageCenterPanel";
import { mobilePrimaryNav, moreNav } from "../nav";
import { CaptureButton } from "../capture/Capture";
import { ToolImage } from "../panels/ToolImage";
import { PanelDecoration, brandStyle, hearthPanelBrand } from "../panels/brands";
import { useMeasuredSize } from "../panels/size";
import {
  windowKey,
  type TalkLayout,
  type TalkPanelKind,
  type TalkWindow,
} from "../../data/talkLayout";

/** The corner kept clear of panels for the little popups (approvals, notices). */
export const POPUP_ZONE = { width: 380, height: 240, margin: 16, bottom: 96 };

/**
 * Conversation mode's workstation: a list of everything that can open on the left,
 * and panels you open from it floating over the screen beside Ember. Each panel moves by its
 * header, resizes from its edges and corner, comes forward when touched, grows to fill the screen
 * for a moment (Expand, Esc puts it back), minimizes to the tray, and closes with X. Nothing
 * opens on its own. Phones show one panel at a time instead of floating windows.
 */

export interface OpenRequest {
  kind: TalkPanelKind;
  id: string;
  tab?: string;
}

const TOOLS: { kind: TalkPanelKind; id: string; label: string; icon: ReactNode }[] = [
  {
    kind: "storage",
    id: "storage",
    label: "Storage",
    icon: <HardDrive strokeWidth={1.5} className="h-4 w-4" />,
  },
  {
    kind: "todo",
    id: "list",
    label: "To-do",
    icon: <ListTodo strokeWidth={1.5} className="h-4 w-4" />,
  },
  {
    kind: "plans",
    id: "list",
    label: "Plans",
    icon: <ClipboardCheck strokeWidth={1.5} className="h-4 w-4" />,
  },
];

const CATEGORY_ORDER = [
  "Media",
  "Downloads",
  "Automation",
  "Home",
  "Files & Photos",
  "Network",
  "System",
];

/** Where a new panel goes: beside Ember (right side first, then left), cascading. */
export function placeNew(
  layout: TalkLayout,
  open: OpenRequest,
  canvas: { w: number; h: number },
): TalkWindow {
  const center = Math.min(620, canvas.w * 0.42);
  const side = (canvas.w - center) / 2;
  const small = open.kind === "todo" || open.kind === "plans";
  const pxW = Math.max(small ? 340 : 430, Math.min(small ? 420 : 520, side - 16));
  const w = Math.min(0.9, pxW / Math.max(canvas.w, 1));
  const h = small ? 0.6 : 1;
  const shown = layout.windows.filter((x) => !x.minimized);
  // The side of Ember with fewer panels (right first), cascading on that side.
  const onRight = shown.filter((x) => x.x + x.w / 2 >= 0.5).length;
  const onLeft = shown.length - onRight;
  const right = onRight <= onLeft;
  const step = (right ? onRight : onLeft) % 4;
  const x = right ? 1 - w - 0.008 - step * 0.02 : 0.008 + step * 0.02;
  let y = 0.01 + step * 0.05;
  // Tall by default (use the space below), down to the bottom on the left and to
  // the pop-up zone on the right (approvals and progress, bottom right).
  const zone = zoneFraction(canvas.h);
  const hh = Math.max(0.25, Math.min(h, 1 - y - (right ? zone : 0.01)));
  y = Math.min(y, 1 - hh);
  const z = Math.max(0, ...layout.windows.map((v) => v.z)) + 1;
  return { ...open, x: Math.max(0, x), y, w, h: hh, z };
}

/** How much of the workspace's height, from the bottom, the pop-up zone keeps clear. */
export const zoneFraction = (canvasH: number) =>
  (POPUP_ZONE.height + POPUP_ZONE.bottom + 8) / Math.max(canvasH, 1);

/** A panel stretched to the full height of its side (double-click its title bar). */
export function tallest(w: Pick<TalkWindow, "x" | "w">, canvasH: number) {
  const right = w.x + w.w / 2 >= 0.5;
  const y = 0.01;
  return { y, h: Math.max(0.25, 1 - y - (right ? zoneFraction(canvasH) : 0.01)) };
}

/** A broken panel shows its error and a retry; Ember and the other panels carry on. */
class PanelBoundary extends Component<
  { children: ReactNode; name: string },
  { error?: Error; tries: number }
> {
  override state: { error?: Error; tries: number } = { tries: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error)
      return (
        <div key={this.state.tries} className="contents">
          {this.props.children}
        </div>
      );
    return (
      <div role="alert" className="m-4 rounded-xl border border-alert/40 p-4 text-[0.86rem]">
        <p className="text-ink">{this.props.name} could not be shown.</p>
        <p className="mt-1 text-muted">{this.state.error.message}</p>
        <button
          type="button"
          onClick={() => this.setState((s) => ({ error: undefined, tries: s.tries + 1 }))}
          className="mt-3 min-h-10 rounded-lg border border-line-strong px-4 text-ink hover:border-gold/60"
        >
          Try again
        </button>
      </div>
    );
  }
}

function useCanvasSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 1200, h: 800 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function nameOf(
  w: Pick<TalkWindow, "kind" | "id">,
  ws?: Workspace,
  projects?: { id: string; name: string }[],
) {
  if (w.kind === "todo") return "To-do";
  if (w.kind === "plans") return "Plans";
  if (w.kind === "storage") return "Storage";
  if (w.kind === "project") return projects?.find((p) => p.id === w.id)?.name ?? "Project";
  return (
    [...(ws?.services ?? []), ...(ws?.inactiveServices ?? [])].find((s) => s.id === w.id)?.name ??
    "Service"
  );
}

/* ---------- The panel list on the left ---------- */

export function Rail({
  open,
  onToggle,
  onOpen,
  isOpen,
  switches = false,
  onNavigate,
}: {
  open: boolean;
  onToggle: () => void;
  onOpen: (o: OpenRequest) => void;
  isOpen: (o: OpenRequest) => boolean;
  /** Each item turns its panel on and off (desktop): lit while it shows, a press closes it. */
  switches?: boolean;
  /** The full menu (Settings, Logs, Monitoring...): leaves the War Room for that page. */
  onNavigate?: (to: string) => void;
}) {
  const ws = useWorkspace();
  const projects = useProjects();
  const [q, setQ] = useState("");
  // The rail shows panels you can switch on and off; "back" swaps it for the full menu.
  const [menu, setMenu] = useState(false);
  const pages = [...mobilePrimaryNav, ...moreNav].filter(
    (n, i, all) => all.findIndex((m) => m.to === n.to) === i,
  );
  const services = useMemo(
    () => [...(ws.data?.services ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [ws.data],
  );
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const groups = CATEGORY_ORDER.map((c) => ({
    category: c,
    items: services.filter((s) => s.category === c && match(s.name)),
  })).filter((g) => g.items.length);
  const projectList = (projects.data ?? []).filter((p) => match(p.name));
  const item = (o: OpenRequest, label: string, icon: ReactNode) => (
    <li key={`${o.kind}:${o.id}`}>
      <button
        type="button"
        onClick={() => onOpen(o)}
        title={switches && isOpen(o) ? `Close ${label}` : label}
        aria-label={`${switches && isOpen(o) ? "Close" : "Open"} ${label}`}
        aria-pressed={switches ? isOpen(o) : undefined}
        data-testid={`rail-${o.kind}-${o.id}`}
        className={cx(
          "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[0.86rem] transition-colors",
          isOpen(o) ? "bg-gold/10 text-gold" : "text-muted hover:bg-raised hover:text-ink",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
        {open && <span className="min-w-0 flex-1 truncate">{label}</span>}
      </button>
    </li>
  );
  return (
    <nav
      aria-label="Open a panel"
      data-testid="talk-rail"
      className={cx(
        "relative z-[3] flex shrink-0 flex-col border-r border-line bg-panel/80 backdrop-blur",
        open ? "w-60" : "w-14",
      )}
    >
      <div className="flex items-center gap-1 px-2 pt-2">
        {onNavigate && (
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            aria-label={menu ? "Back to the panels" : "Full menu"}
            aria-pressed={menu}
            title={menu ? "Back to the panels" : "Full menu: Settings, Logs, Monitoring, and more"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
            data-testid="talk-rail-menu"
          >
            {menu ? (
              <ListTodo strokeWidth={1.5} className="h-5 w-5" />
            ) : (
              <ArrowLeft strokeWidth={1.5} className="h-5 w-5" />
            )}
          </button>
        )}
        {open && (
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Find a service or tool</span>
            <Search
              strokeWidth={1.5}
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-faint"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find…"
              className="min-h-10 w-full rounded-lg border border-line bg-bg pr-2 pl-8 text-[0.86rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
            />
          </label>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? "Fold the panel list away" : "Show the panel list"}
          aria-expanded={open}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
        >
          {open ? (
            <PanelLeftClose strokeWidth={1.5} className="h-5 w-5" />
          ) : (
            <PanelLeftOpen strokeWidth={1.5} className="h-5 w-5" />
          )}
        </button>
      </div>
      {menu && onNavigate && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="talk-rail-pages">
          <p className={cx("eyebrow mt-3 mb-1 px-2", !open && "sr-only")}>Go to</p>
          <ul>
            {pages.map((n) => (
              <li key={n.to}>
                <button
                  type="button"
                  onClick={() => onNavigate(n.to)}
                  title={n.label}
                  aria-label={`Go to ${n.label}`}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[0.86rem] text-muted transition-colors hover:bg-raised hover:text-ink"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <n.icon strokeWidth={1.5} className="h-4 w-4" />
                  </span>
                  {open && <span className="min-w-0 flex-1 truncate">{n.label}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        className={cx("min-h-0 flex-1 overflow-y-auto px-2 pb-3", menu && onNavigate && "hidden")}
      >
        <p className={cx("eyebrow mt-3 mb-1 px-2", !open && "sr-only")}>Tools</p>
        <ul>{TOOLS.filter((t) => match(t.label)).map((t) => item(t, t.label, t.icon))}</ul>
        {projectList.length > 0 && (
          <>
            <p className={cx("eyebrow mt-4 mb-1 px-2", !open && "sr-only")}>Projects</p>
            <ul>
              {projectList.map((p) =>
                item(
                  { kind: "project", id: p.id },
                  p.name,
                  <FolderOpen strokeWidth={1.5} className="h-4 w-4" />,
                ),
              )}
            </ul>
          </>
        )}
        {groups.map((g) => (
          <div key={g.category}>
            <p className={cx("eyebrow mt-4 mb-1 px-2", !open && "sr-only")}>{g.category}</p>
            <ul>
              {g.items.map((s: Service) =>
                item(
                  { kind: "service", id: s.id },
                  s.name,
                  <Monogram name={s.name} image={s.image} className="h-7 w-7 text-[0.7rem]" />,
                ),
              )}
            </ul>
          </div>
        ))}
        {q && !groups.length && !projectList.length && open && (
          <p className="px-2 pt-3 text-[0.8rem] text-faint">Nothing called that.</p>
        )}
      </div>
    </nav>
  );
}

/* ---------- One panel's content ---------- */

function PanelBody({
  w,
  ws,
  onTab,
  onClose,
  controls,
  focused,
  onFocus,
  onDragStart,
}: {
  w: TalkWindow;
  ws?: Workspace;
  onTab: (t: string) => void;
  onClose: () => void;
  controls: ReactNode;
  focused: boolean;
  onFocus: () => void;
  onDragStart?: (e: PointerEvent<HTMLElement>) => void;
}) {
  const frame = useRef<HTMLElement>(null);
  const size = useMeasuredSize(frame);
  const chrome = {
    idPrefix: `talk-${w.kind}-${w.id}-`,
    controls,
    compact: true,
    focused,
    onFocus,
    ...(onDragStart ? { onDragStart } : {}),
    hideClose: true,
  };
  if (w.kind === "storage") {
    return (
      <PanelScope panel={{ kind: "tool", id: "storage" }}>
        <PanelChromeProvider value={chrome}>
          <StorageCenterPanel tab={w.tab ?? null} onTab={onTab} onClose={onClose} />
        </PanelChromeProvider>
      </PanelScope>
    );
  }
  if (w.kind === "service" || w.kind === "project") {
    return (
      <PanelScope panel={{ kind: w.kind, id: w.id }}>
        <PanelChromeProvider value={chrome}>
          {w.kind === "service" ? (
            ws ? (
              <ServiceWorkspace
                ws={ws}
                id={w.id}
                tab={w.tab ?? null}
                onTab={onTab}
                onClose={onClose}
              />
            ) : (
              <p className="p-6 text-muted">Loading…</p>
            )
          ) : (
            <ProjectWorkspace id={w.id} tab={w.tab ?? null} onTab={onTab} onClose={onClose} />
          )}
        </PanelChromeProvider>
      </PanelScope>
    );
  }
  return (
    <section
      ref={frame}
      aria-label={w.kind === "todo" ? "To-do" : "Plans"}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
      // Hearth's own look when branding is on, like every other panel.
      data-brand="hearth"
      data-painted="true"
      style={brandStyle(hearthPanelBrand(w.kind === "todo" ? "To-do" : "Plans"))}
      className={cx(
        "relative isolate flex h-full min-h-0 flex-col rounded-2xl border bg-panel/95 cc-glow",
        focused ? "border-gold/35" : "border-gold/20",
      )}
    >
      <PanelDecoration
        brand={hearthPanelBrand(w.kind === "todo" ? "To-do" : "Plans")}
        size={size}
      />
      <header
        onPointerDown={onDragStart}
        className={cx(
          "flex items-center gap-3 px-4 pt-3 pb-2",
          onDragStart && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
      >
        {w.kind === "todo" ? (
          <ToolImage id="todo" className="h-10 w-10" />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line-strong text-gold">
            <ClipboardCheck strokeWidth={1.5} className="h-4 w-4" />
          </span>
        )}
        <h2 className="min-w-0 flex-1 truncate font-display text-[1.3rem] text-ink">
          {w.kind === "todo" ? "To-do" : "Plans"}
        </h2>
        {controls}
        <CaptureButton target={frame} context={{ panel: w.kind === "todo" ? "To-do" : "Plans" }} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {w.kind === "todo" ? <TodoPanel /> : <PlansPanel />}
      </div>
    </section>
  );
}

/* ---------- Window chrome ---------- */

const NOT_A_HANDLE = "button, a, input, select, textarea, [role=tab], [contenteditable]";

function Controls({
  name,
  expanded,
  onExpand,
  onMinimize,
  onClose,
  onKeyMove,
}: {
  name: string;
  expanded: boolean;
  onExpand?: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onKeyMove?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const btn =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold";
  return (
    <div className="flex shrink-0 items-center">
      {onKeyMove && (
        <button
          type="button"
          onKeyDown={onKeyMove}
          aria-label={`Move ${name}: arrow keys move it, Shift with arrows resizes it`}
          title="Drag the title bar to move it; double-click it for full height. Keyboard: arrows move, Shift with arrows resizes"
          className={cx(btn, "cursor-grab")}
        >
          <GripVertical strokeWidth={1.5} className="h-4 w-4" />
        </button>
      )}
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          aria-label={expanded ? `Put ${name} back` : `Expand ${name} for now`}
          className={btn}
          data-testid="talk-expand"
        >
          {expanded ? (
            <Minimize2 strokeWidth={1.5} className="h-4 w-4" />
          ) : (
            <Maximize2 strokeWidth={1.5} className="h-4 w-4" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={onMinimize}
        aria-label={`Minimize ${name}`}
        className={btn}
        data-testid="talk-minimize"
      >
        <Minus strokeWidth={1.5} className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${name}`}
        className={btn}
        data-testid="talk-close"
      >
        <X strokeWidth={1.5} className="h-5 w-5" />
      </button>
    </div>
  );
}

function FloatingWindow({
  w,
  ws,
  name,
  canvas,
  top,
  expanded,
  onChange,
  onRaise,
  onClose,
  onExpand,
}: {
  w: TalkWindow;
  ws?: Workspace;
  name: string;
  canvas: { w: number; h: number };
  top: boolean;
  expanded: boolean;
  onChange: (patch: Partial<TalkWindow>) => void;
  onRaise: () => void;
  onClose: () => void;
  onExpand: () => void;
}) {
  const drag = useRef<{ mode: string; x: number; y: number; start: TalkWindow } | null>(null);
  const [live, setLive] = useState<Partial<TalkWindow> | null>(null);
  const shown = { ...w, ...live };
  const MIN_W = 300 / Math.max(canvas.w, 1);
  const MIN_H = 220 / Math.max(canvas.h, 1);

  const begin = (mode: string, e: PointerEvent<HTMLElement>) => {
    if (expanded || e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest(NOT_A_HANDLE)) return;
    e.preventDefault();
    onRaise();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: w };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / canvas.w;
    const dy = (e.clientY - d.y) / canvas.h;
    const s = d.start;
    if (d.mode === "move") {
      setLive({
        x: Math.min(1 - s.w, Math.max(0, s.x + dx)),
        y: Math.min(1 - s.h, Math.max(0, s.y + dy)),
      });
    } else {
      const next: Partial<TalkWindow> = {};
      if (d.mode.includes("e")) next.w = Math.min(1 - s.x, Math.max(MIN_W, s.w + dx));
      if (d.mode.includes("s")) next.h = Math.min(1 - s.y, Math.max(MIN_H, s.h + dy));
      if (d.mode.includes("w")) {
        const nx = Math.min(s.x + s.w - MIN_W, Math.max(0, s.x + dx));
        next.x = nx;
        next.w = s.w + (s.x - nx);
      }
      setLive(next);
    }
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live) onChange(live);
    setLive(null);
  };
  // Keyboard: arrows move, Shift+arrows resize (2% of the workspace per press).
  const keyMove = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = 0.02;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (!dir) return;
    e.preventDefault();
    if (e.shiftKey)
      onChange({
        w: Math.min(1 - w.x, Math.max(MIN_W, w.w + dir[0]! * step)),
        h: Math.min(1 - w.y, Math.max(MIN_H, w.h + dir[1]! * step)),
      });
    else
      onChange({
        x: Math.min(1 - w.w, Math.max(0, w.x + dir[0]! * step)),
        y: Math.min(1 - w.h, Math.max(0, w.y + dir[1]! * step)),
      });
  };

  const style = expanded
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex: 500 }
    : {
        left: `${shown.x * 100}%`,
        top: `${shown.y * 100}%`,
        width: `${shown.w * 100}%`,
        height: `${shown.h * 100}%`,
        zIndex: 10 + w.z,
      };
  const controls = (
    <Controls
      name={name}
      expanded={expanded}
      onExpand={onExpand}
      onMinimize={() => onChange({ minimized: true })}
      onClose={onClose}
      onKeyMove={expanded ? undefined : keyMove}
    />
  );
  const edge = (mode: string, cls: string) => (
    <div
      aria-hidden="true"
      onPointerDown={(e) => begin(mode, e)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={cx("absolute touch-none", cls)}
    />
  );
  return (
    <div
      className="absolute flex flex-col shadow-2xl shadow-black/60"
      style={style}
      data-testid="talk-window"
      data-window={windowKey(w)}
      data-top={top || undefined}
      data-capture-item
      data-capture-label={name}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        // Double-click the title bar: full height on this side, or back to a smaller size.
        const t = e.target as HTMLElement;
        if (expanded || !t.closest("header") || t.closest(NOT_A_HANDLE)) return;
        const full = tallest(w, canvas.h);
        onChange(Math.abs(w.h - full.h) < 0.02 && w.y <= 0.02 ? { h: 0.6 } : full);
      }}
    >
      <PanelBoundary name={name}>
        <PanelBody
          w={w}
          ws={ws}
          onTab={(t) => onChange({ tab: t })}
          onClose={onClose}
          controls={controls}
          focused={top}
          onFocus={onRaise}
          {...(expanded ? {} : { onDragStart: (e: PointerEvent<HTMLElement>) => begin("move", e) })}
        />
      </PanelBoundary>
      {!expanded && (
        <>
          {edge("e", "top-3 right-[-4px] bottom-3 w-2 cursor-ew-resize")}
          {edge("w", "top-3 left-[-4px] bottom-3 w-2 cursor-ew-resize")}
          {edge("s", "right-3 bottom-[-4px] left-3 h-2 cursor-ns-resize")}
          {edge("se", "right-[-4px] bottom-[-4px] h-4 w-4 cursor-nwse-resize")}
          {edge("sw", "bottom-[-4px] left-[-4px] h-4 w-4 cursor-nesw-resize")}
        </>
      )}
    </div>
  );
}

/* ---------- The layer of windows, the tray, and phones ---------- */

export function Windows({
  layout,
  update,
  expanded,
  setExpanded,
  center,
}: {
  layout: TalkLayout;
  update: (fn: (l: TalkLayout) => TalkLayout, opts?: { now?: boolean }) => void;
  expanded: string | null;
  setExpanded: (k: string | null) => void;
  /** Ember's column, under the windows. */
  center: ReactNode;
}) {
  const desk = useDesk();
  const ws = useWorkspace();
  const projects = useProjects();
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvas = useCanvasSize(canvasRef);
  const visible = layout.windows.filter((w) => !w.minimized);
  const minimized = layout.windows.filter((w) => w.minimized);
  const topZ = Math.max(0, ...visible.map((w) => w.z));
  const name = (w: TalkWindow) => nameOf(w, ws.data, projects.data);
  // Services or projects that no longer exist are kept (not silently dropped) and say so.
  const patch = (k: string, p: Partial<TalkWindow>, now = false) =>
    update(
      (l) => ({ ...l, windows: l.windows.map((w) => (windowKey(w) === k ? { ...w, ...p } : w)) }),
      { now },
    );
  const raise = (k: string) => {
    const w = layout.windows.find((x) => windowKey(x) === k);
    if (w && w.z !== topZ) patch(k, { z: topZ + 1 });
  };
  const close = (k: string) => {
    if (expanded === k) setExpanded(null);
    update((l) => ({ ...l, windows: l.windows.filter((w) => windowKey(w) !== k) }), { now: true });
  };

  if (!desk) {
    // Phones and tablets: Ember, and one panel at a time over it, with a switcher.
    const showing =
      layout.windows.find((w) => windowKey(w) === layout.mobile && !w.minimized) ?? undefined;
    return (
      <div ref={canvasRef} className="relative flex min-h-0 flex-1 flex-col">
        {center}
        {layout.windows.length > 0 && (
          <div
            className="relative z-[20] flex gap-2 overflow-x-auto border-t border-line bg-panel/90 px-3 py-2"
            data-testid="talk-switcher"
          >
            {layout.windows.map((w) => {
              const k = windowKey(w);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() =>
                    update((l) => ({
                      ...l,
                      mobile: l.mobile === k && !w.minimized ? undefined : k,
                      windows: l.windows.map((x) =>
                        windowKey(x) === k ? { ...x, minimized: false } : x,
                      ),
                    }))
                  }
                  className={cx(
                    "min-h-10 shrink-0 rounded-full border px-4 text-[0.84rem]",
                    showing && windowKey(showing) === k
                      ? "border-gold/60 text-gold"
                      : "border-line text-muted",
                  )}
                >
                  {name(w)}
                </button>
              );
            })}
          </div>
        )}
        {showing && (
          <div
            className="absolute inset-0 z-[30] flex flex-col bg-bg p-2"
            data-testid="talk-window"
            data-window={windowKey(showing)}
          >
            <PanelBoundary name={name(showing)}>
              <PanelBody
                w={showing}
                ws={ws.data}
                onTab={(t) => patch(windowKey(showing), { tab: t })}
                onClose={() => close(windowKey(showing))}
                controls={
                  <Controls
                    name={name(showing)}
                    expanded={false}
                    onMinimize={() => update((l) => ({ ...l, mobile: undefined }))}
                    onClose={() => close(windowKey(showing))}
                  />
                }
                focused
                onFocus={() => undefined}
              />
            </PanelBoundary>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={canvasRef} className="relative min-h-0 flex-1" data-testid="talk-canvas">
      {center}
      {visible.map((w) => {
        const k = windowKey(w);
        return (
          <FloatingWindow
            key={k}
            w={w}
            ws={ws.data}
            name={name(w)}
            canvas={canvas}
            top={w.z === topZ}
            expanded={expanded === k}
            onChange={(p) => patch(k, p, p.minimized === true)}
            onRaise={() => raise(k)}
            onClose={() => close(k)}
            onExpand={() => setExpanded(expanded === k ? null : k)}
          />
        );
      })}
      {minimized.length > 0 && (
        <div
          className="absolute bottom-2 left-2 z-[600] flex max-w-[45%] flex-wrap gap-2"
          data-testid="talk-tray"
        >
          {minimized.map((w) => (
            <button
              key={windowKey(w)}
              type="button"
              onClick={() => patch(windowKey(w), { minimized: false, z: topZ + 1 }, true)}
              aria-label={`Restore ${name(w)}`}
              className="min-h-10 rounded-full border border-gold/40 bg-panel px-4 text-[0.82rem] text-ink shadow-lg hover:border-gold"
            >
              {name(w)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Opens a panel, or brings it forward if it is already open (no duplicates). */
export function openIn(
  l: TalkLayout,
  o: OpenRequest,
  canvas: { w: number; h: number },
  desk: boolean,
): TalkLayout {
  const k = windowKey(o);
  const existing = l.windows.find((w) => windowKey(w) === k);
  const topZ = Math.max(0, ...l.windows.map((w) => w.z));
  if (existing)
    return {
      ...l,
      mobile: k,
      windows: l.windows.map((w) =>
        windowKey(w) === k
          ? { ...w, minimized: false, z: topZ + 1, ...(o.tab ? { tab: o.tab } : {}) }
          : w,
      ),
    };
  return { ...l, ...(desk ? {} : { mobile: k }), windows: [...l.windows, placeNew(l, o, canvas)] };
}
