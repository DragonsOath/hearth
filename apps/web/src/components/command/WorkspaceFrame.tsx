import { useScrollMemory } from "../desk/groups";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AppKind, CaptureContext } from "@dragon-control/core";
import { CaptureButton } from "../capture/Capture";
import { FeatureHelp } from "../help/FeatureHelp";
import { Check, ChevronDown, X } from "lucide-react";
import { cx } from "../ui";
import { usePanelChrome } from "../desk/chrome";
import { PanelSizeProvider, useMeasuredSize } from "../panels/size";
import { tabTarget } from "../panels/targets";
import { PanelDecoration, brandFor, brandStyle, hearthPanelBrand } from "../panels/brands";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Optional icon beside the label (Storage & Files, Hearth's tools). */
  icon?: ReactNode;
  /** A few words on what it is for, shown under its name in the Hearth menu. */
  hint?: string;
  /**
   * "hearth" for Hearth's own tools about the service (health, logs, notes...): one Hearth menu
   * after the app's own tabs, so the tab row stays the app's. Unset: the app's (or panel's) own
   * section.
   */
  group?: "hearth";
}

/**
 * The right-hand workspace: a header (what it is, its state), tabs, and a
 * close that returns to where you were. Shared by projects and services.
 */
export function WorkspaceFrame<T extends string>({
  label,
  icon,
  title,
  subtitle,
  status,
  tabs,
  tab,
  onTab,
  onClose,
  children,
  testId,
  capture,
  help,
  brand,
  actions,
}: {
  label: string;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  tabs: TabDef<T>[];
  tab: T;
  onTab: (t: T) => void;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  /** What a capture of this panel records about it (feature request 19). */
  capture?: Pick<CaptureContext, "serviceId" | "serviceName" | "panel" | "tab">;
  /** Hearth features on this panel, for its "How this works" (checklist 42.2). */
  help?: string[];
  /**
   * A service panel's look (panels/brands.tsx); `kind` picks the service's own theme when it
   * has one. Without it (Storage & Files, a project) the panel wears Hearth's own look.
   */
  brand?: { kind?: AppKind; name: string; image?: string | null };
  /** The panel's own header controls (Improve this panel on a basic panel), before Hearth's. */
  actions?: ReactNode;
}) {
  const frame = useRef<HTMLElement>(null);
  const theme = brand ? brandFor(brand) : hearthPanelBrand(title);
  const body = useRef<HTMLDivElement>(null);
  // Each tab's scroll position is kept with the workspace group.
  useScrollMemory(body, `tab:${tab}`);
  const chrome = usePanelChrome();
  const pre = chrome?.idPrefix ?? "";
  // The panel's own size decides its navigation (native panels Phase 1).
  const size = useMeasuredSize(frame);
  const [menuOpen, setMenuOpen] = useState(false);
  const hearthTabs = tabs.filter((t) => t.group === "hearth");
  // Hearth's tools get their own menu only beside the app's own tabs; alone, they are the tabs.
  const grouped = hearthTabs.length > 0 && hearthTabs.length < tabs.length;
  const own = grouped ? tabs.filter((t) => t.group !== "hearth") : tabs;
  const hearth = grouped ? hearthTabs : [];
  const current = tabs.find((t) => t.id === tab);
  const hearthCurrent = hearth.find((t) => t.id === tab);
  const vertical = size === "maximized" || size === "compact";
  // In the side and sections menus the Hearth group folds; it opens while one of its tools shows.
  const [hearthOpen, setHearthOpen] = useState(Boolean(hearthCurrent));
  // Opening one of its tools (a link, a saved layout, the keyboard) unfolds it.
  const [shownFor, setShownFor] = useState(hearthCurrent?.id);
  if (hearthCurrent && hearthCurrent.id !== shownFor) {
    setShownFor(hearthCurrent.id);
    setHearthOpen(true);
  }
  const pick = (id: T) => {
    onTab(id);
    setMenuOpen(false);
  };
  // Arrow keys move between the tabs of one list (WAI-ARIA tabs pattern).
  const onKey = (list: TabDef<T>[]) => (e: KeyboardEvent<HTMLDivElement>) => {
    const i = list.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (i + 1) % list.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (i - 1 + list.length) % list.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(list[next]!.id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  const tabButton = (t: TabDef<T>) => (
    <button
      key={t.id}
      type="button"
      role="tab"
      id={`${pre}tab-${t.id}`}
      aria-selected={t.id === tab}
      aria-controls={`${pre}panel-${t.id}`}
      // While a Hearth tool is open, the app's first tab stays reachable from the keyboard, so a
      // tab row that scrolls on a phone always has something to focus.
      tabIndex={t.id === tab || (!own.some((o) => o.id === tab) && t.id === own[0]?.id) ? 0 : -1}
      data-hearth-target={tabTarget(t.id)}
      onClick={() => pick(t.id)}
      className={cx(
        "relative min-h-11 shrink-0 px-3 text-[0.86rem] transition-colors",
        vertical
          ? cx(
              "rounded-lg text-left",
              t.id === tab ? "bg-gold/10 text-gold" : "text-muted hover:text-ink",
            )
          : t.id === tab
            ? "text-gold after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-gold"
            : "text-muted hover:text-ink",
      )}
    >
      {t.icon ? (
        <span className="inline-flex items-center gap-1.5">
          {t.icon}
          {t.label}
        </span>
      ) : (
        t.label
      )}
    </button>
  );
  return (
    <section
      ref={frame}
      aria-label={label}
      data-testid={testId}
      data-focused={chrome?.focused ? "true" : undefined}
      onMouseDownCapture={chrome?.onFocus}
      onFocusCapture={chrome?.onFocus}
      data-brand={theme?.name.toLowerCase()}
      data-painted="true"
      style={brandStyle(theme)}
      className={cx(
        "cc-slide-in flex h-full min-h-0 flex-col rounded-2xl border bg-panel/95 cc-glow",
        // Its own stacking layer: the decoration sits behind the content, inside the frame.
        "relative isolate",
        chrome && !chrome.focused ? "border-gold/20" : "border-gold/35",
      )}
    >
      <PanelDecoration brand={theme} size={size} />
      <header
        onPointerDown={chrome?.onDragStart}
        className={cx(
          // Wraps when narrow: the name keeps a readable width on the first line and the
          // buttons move to a second line, instead of squeezing the name out of sight.
          "flex flex-wrap items-start gap-x-3 gap-y-1",
          chrome?.compact ? "px-4 pt-3 pb-2" : "px-5 pt-4 pb-3",
          chrome?.onDragStart && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
      >
        <span
          className={cx(
            "panel-icon mt-0.5 shrink-0 rounded-full",
            chrome?.compact && "[&>*]:h-9 [&>*]:w-9",
          )}
        >
          {icon}
        </span>
        <div className="min-w-[9rem] flex-1 basis-[9rem]" data-hearth-target="panel:title">
          <h2
            className={cx(
              "truncate font-display leading-tight text-ink",
              chrome?.compact ? "text-[1.3rem]" : "text-[1.6rem]",
            )}
          >
            {title}
          </h2>
          {subtitle && <div className="mt-0.5 text-[0.82rem] text-muted">{subtitle}</div>}
        </div>
        <div className="ml-auto flex shrink-0 items-start">
          {status && !chrome?.compact && <div className="hidden shrink-0 sm:block">{status}</div>}
          {/* A plate behind the buttons so they read on a panel's art (the owner, 2026-11-02). No
              blur: it would trap the capture menu under the tabs. */}
          <div
            data-testid="panel-controls"
            className="flex shrink-0 items-center rounded-xl bg-panel/90 shadow-sm ring-1 ring-line [&_button:not([aria-pressed=true]):not(:hover):not(:disabled)]:text-ink/90"
          >
            {actions}
            {chrome?.controls}
            {help?.length ? <FeatureHelp features={help} compact /> : null}
            <CaptureButton
              target={frame}
              context={capture ?? { panel: title, tab: tabs.find((t) => t.id === tab)?.label }}
            />
            {!chrome?.hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
              >
                <X strokeWidth={1.5} className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </header>
      {size === "compact" && tabs.length > 1 && (
        <div className="shrink-0 border-b border-line px-3 py-2">
          <button
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.86rem] text-ink hover:border-gold/60"
            data-hearth-target="sections"
          >
            {hearthCurrent ? `Hearth: ${hearthCurrent.label}` : (current?.label ?? "Sections")}
            <ChevronDown strokeWidth={1.5} className="h-4 w-4 text-muted" />
          </button>
        </div>
      )}
      <div className={cx("flex min-h-0 flex-1", size === "maximized" ? "flex-row" : "flex-col")}>
        <nav
          aria-label={`${title} navigation`}
          className={cx(
            "flex shrink-0",
            size === "maximized"
              ? "w-48 flex-col overflow-y-auto border-r border-line px-2 py-3"
              : size === "compact"
                ? "flex-col border-b border-line px-3 pb-2"
                : "items-stretch border-b border-line px-3",
            size === "compact" && tabs.length > 1 && !menuOpen && "hidden",
          )}
        >
          <div
            role="tablist"
            aria-label={`${title} sections`}
            aria-orientation={vertical ? "vertical" : "horizontal"}
            onKeyDown={onKey(own)}
            data-size={size}
            className={cx("flex gap-1", vertical ? "flex-col" : "min-w-0 flex-1 overflow-x-auto")}
          >
            {own.map(tabButton)}
          </div>
          {hearth.length > 0 &&
            (vertical ? (
              <div className="mt-3">
                <button
                  type="button"
                  aria-expanded={hearthOpen}
                  aria-controls={hearthOpen ? `${pre}hearth-tools` : undefined}
                  onClick={() => setHearthOpen((o) => !o)}
                  data-hearth-target="menu:hearth"
                  data-hearth-opens={hearth.map((t) => tabTarget(t.id)).join(" ")}
                  className={cx(
                    "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-[0.86rem]",
                    hearthCurrent && !hearthOpen ? "text-gold" : "text-muted hover:text-ink",
                  )}
                >
                  {hearthCurrent && !hearthOpen ? `Hearth: ${hearthCurrent.label}` : "Hearth"}
                  <ChevronDown
                    strokeWidth={1.5}
                    className={cx("h-4 w-4 transition-transform", hearthOpen && "rotate-180")}
                  />
                </button>
                {hearthOpen && (
                  <div
                    id={`${pre}hearth-tools`}
                    role="tablist"
                    aria-label="Hearth tools"
                    aria-orientation="vertical"
                    onKeyDown={onKey(hearth)}
                    className="ml-3 flex flex-col gap-1 border-l border-line pl-2"
                  >
                    {hearth.map(tabButton)}
                  </div>
                )}
              </div>
            ) : (
              <HearthMenu
                id={`${pre}tab-hearth`}
                tools={hearth}
                current={hearthCurrent?.id}
                onPick={pick}
              />
            ))}
        </nav>
        <div
          ref={body}
          role="tabpanel"
          id={`${pre}panel-${tab}`}
          aria-labelledby={hearthCurrent && !vertical ? `${pre}tab-hearth` : `${pre}tab-${tab}`}
          data-size={size}
          className={cx(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            chrome?.compact || size === "compact" ? "p-4" : "p-5",
          )}
        >
          <PanelSizeProvider value={size}>{children}</PanelSizeProvider>
        </div>
      </div>
    </section>
  );
}

/** Captured output in a terminal style. Never a live shell. */
/**
 * Hearth's tools for a service (Health, Logs, Terminal...) as one menu after the app's tabs, so
 * the tab row stays the app's own. Shows which tool is open ("Hearth: Logs"). A menu button
 * (WAI-ARIA): Enter, Space or Down opens it on the open tool; Up and Down move; Escape closes.
 */
function HearthMenu<T extends string>({
  id,
  tools,
  current,
  onPick,
}: {
  id: string;
  tools: TabDef<T>[];
  current: T | undefined;
  onPick: (id: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const active = tools.find((t) => t.id === current);
  const focusItem = (i: number) => items.current[(i + tools.length) % tools.length]?.focus();
  useEffect(() => {
    if (!open) return;
    items.current[
      Math.max(
        0,
        tools.findIndex((t) => t.id === current),
      )
    ]?.focus();
    // A press anywhere else closes it.
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
    // Focus moves only when it opens, not when the open tool changes behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    if (e.key === "Tab") return setOpen(false);
    if (e.key === "ArrowDown") focusItem(i + 1);
    else if (e.key === "ArrowUp") focusItem(i - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(tools.length - 1);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  };
  return (
    <div ref={wrap} className="relative ml-1 flex shrink-0 items-stretch border-l border-line pl-1">
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        data-hearth-target="menu:hearth"
        data-hearth-opens={tools.map((t) => tabTarget(t.id)).join(" ")}
        className={cx(
          "relative inline-flex min-h-11 items-center gap-1 px-3 text-[0.86rem] whitespace-nowrap transition-colors",
          active
            ? "text-gold after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-gold"
            : "text-muted hover:text-ink",
        )}
      >
        {active ? `Hearth: ${active.label}` : "Hearth"}
        <ChevronDown
          strokeWidth={1.5}
          className={cx("h-4 w-4 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          id={`${id}-menu`}
          role="menu"
          aria-label="Hearth tools"
          onKeyDown={onMenuKey}
          className="fade-in absolute top-full right-0 z-30 mt-1.5 max-h-[min(28rem,70vh)] w-72 overflow-y-auto rounded-xl border border-gold/35 bg-panel p-1.5 shadow-xl"
        >
          <p aria-hidden className="eyebrow px-3 pt-1.5 pb-2 text-faint">
            Hearth tools
          </p>
          {tools.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === current}
              aria-label={t.label}
              aria-describedby={t.hint ? `${id}-hint-${t.id}` : undefined}
              tabIndex={-1}
              data-hearth-target={tabTarget(t.id)}
              onClick={() => {
                onPick(t.id);
                close();
              }}
              className={cx(
                "group flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none",
                t.id === current ? "bg-gold/10" : "hover:bg-raised focus-visible:bg-raised",
              )}
            >
              <span
                className={cx(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                  t.id === current
                    ? "border-gold/50 bg-gold/15 text-gold"
                    : "border-line bg-raised text-muted group-hover:text-gold group-focus-visible:text-gold",
                )}
              >
                {t.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    "block text-[0.88rem] leading-tight",
                    t.id === current ? "text-gold" : "text-ink",
                  )}
                >
                  {t.label}
                </span>
                {t.hint && (
                  <span
                    id={`${id}-hint-${t.id}`}
                    className="mt-0.5 block truncate text-[0.76rem] leading-tight text-faint"
                  >
                    {t.hint}
                  </span>
                )}
              </span>
              {t.id === current && (
                <Check strokeWidth={1.75} className="h-4 w-4 shrink-0 text-gold" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TerminalView({
  entries,
  empty,
}: {
  entries: { at: string; source: string; lines: string[] }[];
  empty: string;
}) {
  return (
    <div>
      <p className="mb-3 text-[0.78rem] text-faint">
        Captured output only: what Hearth ran or read, as recorded. There is no live shell here.
      </p>
      <div
        className="overflow-x-auto rounded-xl border border-line bg-black/70 p-4 font-mono text-[0.78rem] leading-relaxed"
        data-testid="terminal"
      >
        {entries.length ? (
          entries.map((e, i) => (
            <div key={i} className="mb-3 last:mb-0">
              <p className="text-gold/80">
                [
                {new Date(e.at).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
                ] {e.source}
              </p>
              {e.lines.map((l, j) => (
                <p
                  key={j}
                  className={cx(
                    "whitespace-pre-wrap",
                    /error|fail|refused|not allowed/i.test(l)
                      ? "text-alert"
                      : /warn/i.test(l)
                        ? "text-amber"
                        : "text-ink/85",
                  )}
                >
                  {l}
                </p>
              ))}
            </div>
          ))
        ) : (
          <p className="text-faint">{empty}</p>
        )}
      </div>
    </div>
  );
}

export function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong p-6 text-center">
      <p className="text-[0.95rem] text-ink">{what} are not available yet</p>
      <p className="mx-auto mt-2 max-w-sm text-[0.84rem] leading-relaxed text-muted">{why}</p>
    </div>
  );
}
