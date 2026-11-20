import { useAiName } from "../../data/api";
import { ToolImage } from "../panels/ToolImage";
import { usePanelView, useScrollMemory } from "../desk/groups";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Minus,
  Pencil,
  Save,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useForgeWaiting } from "./forge";
import { useSwapWorkspace } from "./dock";
import type { WorkspaceChoice, WorkspaceColumn, WorkspaceItem } from "@dragon-control/core";
import { Button, cx } from "../ui";
import { usePanelChrome } from "../desk/chrome";
import { bytes } from "../../lib/format";
import { EditDialog, SaveDialog } from "./dialogs";
import { ITEM_STATUS, ItemBadge, PlanCard } from "./plan";
import { PickBoard } from "./pick";
import { CaptureButton } from "../capture/Capture";
import { PanelDecoration, brandStyle, hearthPanelBrand } from "../panels/brands";
import { useMeasuredSize } from "../panels/size";
import {
  useDiscardWorkspace,
  useEditWorkspace,
  useSaveWorkspace,
  useSaveWorkspaceNote,
  useSavedWorkspaces,
  useSelectInWorkspace,
  useSubmitWorkspace,
  useWorkspace,
  useWorkspaceState,
} from "../../data/workspaces";

/**
 * A workspace Ember opened beside the conversation (feature request 20): its items in a
 * fast scrolling list with your choice per item, search, filter, sort, and Submit. Everything
 * shown comes from validated data and these fixed components; nothing the AI wrote runs here.
 * Your choices are saved as you make them. Minimize keeps it; closing a temporary one asks first
 * and removes only the workspace, never files, services, or plans.
 */

const ROW = 44;
/** Cells pinned to the right edge while the rest of the row scrolls sideways. */
const STICKY = "sticky z-[1] h-full bg-panel pl-1 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.6)]";
const OVERSCAN = 12;
const SAVE_DELAY = 400;

type Filter = "all" | "undecided" | "warnings" | `choice:${string}` | `plan:${string}`;
type Sort = { key: string; dir: 1 | -1 } | undefined;

const toneClass = (tone: WorkspaceChoice["tone"], on: boolean, suggested: boolean) =>
  !on
    ? "border-line text-faint hover:border-line-strong hover:text-ink"
    : cx(
        suggested && "border-dashed",
        tone === "good"
          ? "border-ok/70 bg-ok/15 text-ok"
          : tone === "warn"
            ? "border-warn/70 bg-warn/15 text-warn"
            : "border-gold/60 bg-gold/10 text-gold",
      );

function Cell({ column, value }: { column: WorkspaceColumn; value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-faint">-</span>;
  if (column.kind === "bytes" && typeof value === "number")
    return <span className="tabular-nums">{bytes(value)}</span>;
  if (column.kind === "number" && typeof value === "number")
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  if (column.kind === "badge")
    return (
      <span className="rounded-full border border-line-strong px-2 py-0.5 text-[0.72rem] text-muted">
        {String(value)}
      </span>
    );
  return (
    <span className={cx(column.kind === "path" && "font-mono text-[0.76rem] text-muted")}>
      {String(value)}
    </span>
  );
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** The exact confirmation the owner asked for before a temporary workspace is discarded. */
function ConfirmClose({
  onCancel,
  onConfirm,
  busy,
  error,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  error?: unknown;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby="ws-close-title"
      aria-describedby="ws-close-body"
      onClose={onCancel}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-gold/40 bg-panel p-6 text-ink backdrop:bg-black/70"
    >
      <h2 id="ws-close-title" className="font-display text-[1.35rem] leading-tight">
        Close temporary workspace?
      </h2>
      <div id="ws-close-body" className="mt-3 space-y-2 text-[0.88rem] text-muted">
        <p>
          This panel contains temporary working data. Closing it will discard the list and any
          unsaved selections.
        </p>
        <p>Are you sure you want to close it?</p>
        <p className="text-[0.8rem] text-faint">
          Your files and services are not touched, and an approved plan that is already running
          keeps running; its progress stays in History.
        </p>
      </div>
      {Boolean(error) && (
        <p role="alert" className="mt-3 text-[0.84rem] text-amber">
          Could not close it: {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button autoFocus onClick={() => ref.current?.close()}>
          Cancel
        </Button>
        <Button tone="primary" disabled={busy} onClick={onConfirm}>
          {busy ? "Closing…" : "Close & Discard"}
        </Button>
      </div>
    </dialog>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:text-gold"
    >
      {children}
    </button>
  );
}

export function WorkspacePanel({
  id,
  onClose,
  onMinimize,
}: {
  id: string;
  /** Takes the panel away (after a discard, or closing a saved one's view). */
  onClose: () => void;
  /** Hides the panel; it stays listed to reopen. */
  onMinimize: () => void;
}) {
  const aiName = useAiName();
  const chrome = usePanelChrome();
  const query = useWorkspace(id);
  const select = useSelectInWorkspace(id);
  const submit = useSubmitWorkspace(id);
  const setState = useWorkspaceState();
  const save = useSaveWorkspace(id);
  const saveNote = useSaveWorkspaceNote(id);
  const editFile = useEditWorkspace();
  const savedList = useSavedWorkspaces();
  const folders = [
    ...new Set((savedList.data ?? []).map((w) => w.folder).filter((f): f is string => Boolean(f))),
  ].sort();
  const [editing, setEditing] = useState(false);
  // The other Forge projects still waiting for you, one arrow away (this one included).
  const waiting = useForgeWaiting();
  const swap = useSwapWorkspace();
  const ring = waiting.some((w) => w.id === id)
    ? waiting
    : [...waiting, { id, title: "", conversationId: undefined } as (typeof waiting)[number]];
  const at = ring.findIndex((w) => w.id === id);
  const prev = ring.length > 1 ? ring[(at - 1 + ring.length) % ring.length] : undefined;
  const nextWs = ring.length > 1 ? ring[(at + 1) % ring.length] : undefined;
  const [notice, setNotice] = useState<string | undefined>();
  const discard = useDiscardWorkspace();
  const [pending, setPending] = useState<Record<string, string | null>>({});
  // Kept with the workspace group: leaving the page and coming back finds them as they were.
  const [search, setSearch] = usePanelView("search", "");
  const [filter, setFilter] = usePanelView<Filter>("filter", "all");
  const [sort, setSort] = usePanelView<Sort | undefined>("sort", undefined);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const size = useMeasuredSize(sectionRef);
  const areaRef = useRef<HTMLDivElement>(null);
  // Where the list and the area around it were scrolled, kept with the workspace group.
  useScrollMemory(listRef, "list", query.isSuccess);
  useScrollMemory(areaRef, "area", query.isSuccess);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(Math.round(e!.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [query.isSuccess]);

  const view = query.data;
  const spec = view?.spec;
  const choices = spec?.choices ?? [];

  const flush = async () => {
    clearTimeout(flushTimer.current);
    const changes = pendingRef.current;
    if (!Object.keys(changes).length) return;
    await select.mutateAsync(changes);
    // Only what was sent; anything chosen meanwhile waits for the next save.
    setPending((p) => {
      const next = { ...p };
      for (const [k, v] of Object.entries(changes)) if (next[k] === v) delete next[k];
      return next;
    });
  };
  useEffect(() => () => void flush().catch(() => undefined), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving or reloading the page right after a choice: it is still sent (the page may be gone
  // before the usual short delay is over). Saving a choice never submits anything.
  useEffect(() => {
    const onHide = () => {
      const changes = pendingRef.current;
      if (!Object.keys(changes).length) return;
      void fetch(`/api/workspaces/${encodeURIComponent(id)}/selections`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [id]);

  const choose = (changes: Record<string, string | null>) => {
    setPending((p) => ({ ...p, ...changes }));
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flush().catch(() => undefined), SAVE_DELAY);
  };

  const choiceOf = (item: WorkspaceItem): { value?: string; suggested: boolean } => {
    if (item.id in pending) return { value: pending[item.id] ?? undefined, suggested: false };
    const mine = view?.selections[item.id];
    if (mine) return { value: mine, suggested: false };
    const s = spec?.suggested?.[item.id];
    return { value: s, suggested: Boolean(s) };
  };

  const groupBand = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of spec?.items ?? []) if (i.group && !m.has(i.group)) m.set(i.group, m.size);
    return m;
  }, [spec]);

  const shown = useMemo(() => {
    if (!spec) return [];
    const q = search.trim().toLowerCase();
    let list = spec.items.filter((i) => {
      if (
        q &&
        !`${i.id} ${i.group ?? ""} ${Object.values(i.values).join(" ")}`.toLowerCase().includes(q)
      )
        return false;
      const c = choiceOf(i).value;
      if (filter === "undecided") return !c;
      if (filter === "warnings") return Boolean(i.warning);
      if (filter.startsWith("choice:")) return c === filter.slice(7);
      if (filter.startsWith("plan:"))
        return view?.plans?.[0]?.items[i.id]?.status === filter.slice(5);
      return true;
    });
    if (sort)
      list = [...list].sort((a, b) => sort.dir * compare(a.values[sort.key], b.values[sort.key]));
    return list;
    // choiceOf reads view and pending, both listed.
  }, [spec, view, pending, search, filter, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  if (query.isError && !view) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-4 rounded-2xl border border-gold/20 bg-panel/95 p-6 text-center">
        <p className="text-[0.9rem] text-muted">
          {(query.error as Error).message || "This workspace could not be loaded."}
        </p>
        <Button onClick={onClose}>Close panel</Button>
      </section>
    );
  }
  if (!view || !spec) {
    return (
      <section className="h-full animate-pulse rounded-2xl border border-gold/20 bg-panel/95" />
    );
  }

  const decided = spec.items.filter((i) => choiceOf(i).value).length;
  const total = spec.items.length;
  const counts: Record<string, number> = {};
  for (const i of spec.items) {
    const c = choiceOf(i).value;
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  // The pick layout: what counts is how many are selected, against the target.
  const pick = spec.layout?.kind === "pick" ? spec.layout : undefined;
  const picked = pick ? (counts[pick.choice] ?? 0) : 0;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(shown.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  // The newest plan made from this workspace: its result per item, as its own column.
  const plan = view.plans?.[0];
  const planned = plan ? Object.keys(plan.items).length > 0 : false;
  const template = [
    ...spec.columns.map((c) => (c.kind === "path" ? "minmax(11rem,2fr)" : "minmax(6.5rem,1fr)")),
    ...(planned ? ["5.5rem"] : []),
    ...(choices.length ? [`${choices.length * 5}rem`] : []),
  ].join(" ");
  const minWidth = `${spec.columns.reduce((n, c) => n + (c.kind === "path" ? 11 : 6.5), 0) + (planned ? 5.5 : 0) + choices.length * 5 + 1}rem`;
  // On a narrow panel the list scrolls sideways; your choice (and the plan's result) stay in view.
  const planRight = `${choices.length * 5 + 0.5}rem`;
  const firstText = spec.columns[0]?.key;
  const nameOf = (itemId: string) => {
    const it = spec.items.find((i) => i.id === itemId);
    const v = it && firstText ? it.values[firstText] : undefined;
    return v !== undefined && v !== null && v !== ""
      ? `${String(v)} (${itemId.split("/").pop()})`
      : itemId;
  };
  const temporary = view.kind === "temporary";
  const submittedAt = view.submission?.at;
  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: `All ${total}` },
    ...(choices.length
      ? [{ id: "undecided" as const, label: `Undecided ${total - decided}` }]
      : []),
    ...choices.map((c) => ({
      id: `choice:${c.value}` as Filter,
      label: `${c.label} ${counts[c.value] ?? 0}`,
    })),
    ...(plan && planned
      ? (Object.keys(ITEM_STATUS) as (keyof typeof ITEM_STATUS)[])
          .filter((k) => plan.counts[k])
          .map((k) => ({
            id: `plan:${k}` as Filter,
            label: `Plan: ${ITEM_STATUS[k].label} ${plan.counts[k]}`,
          }))
      : []),
    ...(spec.items.some((i) => i.warning)
      ? [
          {
            id: "warnings" as const,
            label: `Warnings ${spec.items.filter((i) => i.warning).length}`,
          },
        ]
      : []),
  ];

  const minimize = () => {
    void flush().catch(() => undefined);
    setState.mutate({ id, state: "minimized" });
    onMinimize();
  };
  const doSubmit = async () => {
    await flush();
    await submit.mutateAsync();
  };

  return (
    <section
      ref={sectionRef}
      aria-label={`Workspace: ${spec.title}`}
      data-testid="workspace-panel"
      data-focused={chrome?.focused ? "true" : undefined}
      onMouseDownCapture={chrome?.onFocus}
      onFocusCapture={chrome?.onFocus}
      // Hearth's own look when branding is on, like every other panel.
      data-brand="hearth"
      data-painted="true"
      style={brandStyle(hearthPanelBrand(spec.title))}
      className={cx(
        "cc-slide-in relative isolate flex h-full min-h-0 flex-col rounded-2xl border bg-panel/95 cc-glow",
        chrome && !chrome.focused ? "border-gold/20" : "border-gold/35",
      )}
    >
      <PanelDecoration brand={hearthPanelBrand(spec.title)} size={size} />
      <header
        className={cx(
          // A narrow panel: the buttons wrap under the title instead of squeezing it (11-19).
          "flex flex-wrap items-start gap-x-3 gap-y-1",
          chrome?.compact ? "px-4 pt-3 pb-2" : "px-5 pt-4 pb-3",
        )}
      >
        <ToolImage id="forge" className="mt-0.5 h-11 w-11" />
        <div className="min-w-0 flex-1 basis-44">
          <h2
            className={cx(
              "truncate font-display leading-tight text-ink",
              chrome?.compact ? "text-[1.3rem]" : "text-[1.5rem]",
            )}
          >
            {spec.title}
          </h2>
          <p className="mt-0.5 text-[0.78rem] text-muted" data-testid="workspace-kind">
            <span className="text-gold">The Forge</span>
            {temporary
              ? ` · in progress, from ${aiName} · not saved yet`
              : ` · saved in the Forge Library${view.folder ? ` · ${view.folder}` : ""}`}
          </p>
          {prev && nextWs && (
            <div
              className="mt-1 inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/5 text-[0.76rem] text-muted"
              role="group"
              aria-label="Your open Forge projects"
              data-testid="forge-switch"
            >
              <button
                type="button"
                className="flex min-h-8 min-w-8 items-center justify-center rounded-full text-gold hover:bg-gold/15"
                aria-label={`Previous Forge project: ${prev.title}`}
                title={prev.title}
                onClick={() => swap(id, prev)}
                data-testid="forge-prev"
              >
                <ChevronLeft strokeWidth={1.75} className="h-4 w-4" />
              </button>
              <span className="tabular-nums">
                Project {at + 1} of {ring.length}
              </span>
              <button
                type="button"
                className="flex min-h-8 min-w-8 items-center justify-center rounded-full text-gold hover:bg-gold/15"
                aria-label={`Next Forge project: ${nextWs.title}`}
                title={nextWs.title}
                onClick={() => swap(id, nextWs)}
                data-testid="forge-next"
              >
                <ChevronRight strokeWidth={1.75} className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-start">
          {chrome?.controls}
          <CaptureButton target={sectionRef} context={{ panel: spec.title }} />
          <HeaderButton label="Save workspace" onClick={() => setSaving(true)}>
            <Save strokeWidth={1.5} className="h-[1.1rem] w-[1.1rem]" />
          </HeaderButton>
          {!temporary && (
            <HeaderButton label="Edit working file details" onClick={() => setEditing(true)}>
              <Pencil strokeWidth={1.5} className="h-[1.05rem] w-[1.05rem]" />
            </HeaderButton>
          )}
          <HeaderButton label="Minimize workspace" onClick={minimize}>
            <Minus strokeWidth={1.5} className="h-5 w-5" />
          </HeaderButton>
          <HeaderButton
            label={temporary ? "Close and discard workspace" : "Close workspace"}
            onClick={() => {
              if (temporary) setConfirming(true);
              else {
                // A saved sheet stays in the Forge Library; closing only closes its view.
                void flush().catch(() => undefined);
                setState.mutate({ id, state: "closed" });
                onClose();
              }
            }}
          >
            <X strokeWidth={1.5} className="h-5 w-5" />
          </HeaderButton>
        </div>
      </header>

      {notice && (
        <p
          className="mx-5 mb-2 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-[0.8rem] text-ok"
          role="status"
          data-testid="workspace-notice"
        >
          {notice}
        </p>
      )}
      {spec.description && (
        <p className="px-5 pb-2 text-[0.84rem] whitespace-pre-line text-muted">
          {spec.description}
        </p>
      )}

      {/* Plan, filters, and list: on a short screen this area scrolls as a whole. */}
      <div ref={areaRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PlanCard
          view={view}
          nameOf={nameOf}
          replacing={submit.isPending}
          onReplace={() => void doSubmit().catch(() => undefined)}
        />

        {spec.layout?.kind === "pick" ? (
          <PickBoard
            workspaceId={view.id}
            spec={spec}
            choiceOf={choiceOf}
            choose={choose}
            {...(plan ? { plan } : {})}
            narrow={size === "mobile" || size === "compact"}
          />
        ) : (
          <>
            <div className="space-y-2 border-b border-line px-4 pb-3">
              <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-bg px-3 focus-within:border-gold">
                <Search strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
                <span className="sr-only">Search this workspace</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink placeholder:text-faint focus:outline-none"
                />
              </label>
              <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="Show">
                {filters.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={cx(
                      "min-h-8 shrink-0 rounded-full border px-3 text-[0.76rem] tabular-nums",
                      filter === f.id
                        ? "border-gold/60 text-gold"
                        : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {choices.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.76rem] text-faint">
                  <span>{shown.length === total ? "All" : `${shown.length} shown`}:</span>
                  {choices.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      disabled={!shown.length}
                      onClick={() => choose(Object.fromEntries(shown.map((i) => [i.id, c.value])))}
                      className="min-h-8 hover:text-gold disabled:opacity-40"
                    >
                      {c.label} all
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={!shown.length}
                    onClick={() => choose(Object.fromEntries(shown.map((i) => [i.id, null])))}
                    className="min-h-8 hover:text-gold disabled:opacity-40"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            {/* The list scrolls by itself; only the rows in view are drawn. */}
            <div
              ref={listRef}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              // Solid behind the rows: the window may sit on a theme's moving art.
              className="relative min-h-[13rem] flex-1 overflow-auto bg-panel/95"
              data-testid="workspace-list"
            >
              <div
                style={{ minWidth }}
                role="table"
                aria-label={spec.title}
                aria-rowcount={shown.length + 1}
              >
                <div
                  role="row"
                  aria-rowindex={1}
                  className="sticky top-0 z-10 grid items-center gap-2 border-b border-line bg-panel px-4 text-[0.72rem] tracking-wide text-faint uppercase"
                  style={{ gridTemplateColumns: template, height: 34 }}
                >
                  {spec.columns.map((c) => {
                    const on = sort?.key === c.key;
                    return (
                      <span
                        key={c.key}
                        role="columnheader"
                        aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                        className="min-w-0"
                      >
                        <button
                          type="button"
                          aria-label={`Sort by ${c.label}`}
                          onClick={() =>
                            setSort(
                              !on
                                ? { key: c.key, dir: 1 }
                                : sort!.dir === 1
                                  ? { key: c.key, dir: -1 }
                                  : undefined,
                            )
                          }
                          className={cx(
                            "flex w-full min-w-0 items-center gap-1 text-left hover:text-gold",
                            on && "text-gold",
                          )}
                        >
                          <span className="truncate">{c.label}</span>
                          {on &&
                            (sort!.dir === 1 ? (
                              <ArrowUp strokeWidth={1.5} className="h-3 w-3 shrink-0" />
                            ) : (
                              <ArrowDown strokeWidth={1.5} className="h-3 w-3 shrink-0" />
                            ))}
                        </button>
                      </span>
                    );
                  })}
                  {planned && (
                    <span
                      role="columnheader"
                      className={cx("flex items-center", STICKY)}
                      style={{ right: planRight }}
                    >
                      Plan
                    </span>
                  )}
                  {choices.length > 0 && (
                    <span
                      role="columnheader"
                      className={cx("flex items-center", STICKY)}
                      style={{ right: 0 }}
                    >
                      Your choice
                    </span>
                  )}
                </div>
                {shown.length === 0 ? (
                  <p className="px-4 py-8 text-center text-[0.86rem] text-faint">
                    Nothing matches.
                  </p>
                ) : (
                  <div role="rowgroup" style={{ height: shown.length * ROW, position: "relative" }}>
                    {shown.slice(start, end).map((item, n) => {
                      const c = choiceOf(item);
                      const band =
                        item.group !== undefined ? (groupBand.get(item.group) ?? 0) % 2 : 0;
                      return (
                        <div
                          key={item.id}
                          role="row"
                          aria-rowindex={start + n + 2}
                          data-testid="workspace-row"
                          data-capture-item
                          data-capture-label={nameOf(item.id)}
                          data-item={item.id}
                          className={cx(
                            "absolute inset-x-0 grid items-center gap-2 border-b border-line/60 px-4 text-[0.84rem] text-ink",
                            band ? "bg-raised/50" : "",
                            "hover:bg-raised",
                          )}
                          style={{
                            top: (start + n) * ROW,
                            height: ROW,
                            gridTemplateColumns: template,
                          }}
                          title={item.warning ? `${item.id}\n${item.warning}` : item.id}
                        >
                          {spec.columns.map((col, k) => (
                            <span
                              key={col.key}
                              role="cell"
                              className="flex min-w-0 items-center gap-1.5 truncate"
                            >
                              {k === 0 && item.warning && (
                                <TriangleAlert
                                  strokeWidth={1.5}
                                  className="h-3.5 w-3.5 shrink-0 text-amber"
                                  aria-label={item.warning}
                                />
                              )}
                              <span className="truncate">
                                <Cell column={col} value={item.values[col.key]} />
                              </span>
                            </span>
                          ))}
                          {planned && (
                            <span
                              role="cell"
                              className={cx("flex min-w-0 items-center", STICKY)}
                              style={{ right: planRight }}
                            >
                              {plan!.items[item.id] ? (
                                <ItemBadge
                                  status={plan!.items[item.id]!.status}
                                  result={plan!.items[item.id]!.result}
                                />
                              ) : (
                                <span className="text-[0.7rem] text-faint">-</span>
                              )}
                            </span>
                          )}
                          {choices.length > 0 && (
                            <span
                              role="cell"
                              className={cx("flex gap-1", STICKY)}
                              style={{ right: 0 }}
                              aria-label="Your choice"
                            >
                              {choices.map((ch) => {
                                const on = c.value === ch.value;
                                return (
                                  <button
                                    key={ch.value}
                                    type="button"
                                    aria-pressed={on}
                                    title={on && c.suggested ? `Suggested by ${aiName}` : undefined}
                                    onClick={() =>
                                      choose({ [item.id]: on && !c.suggested ? null : ch.value })
                                    }
                                    className={cx(
                                      "min-h-8 flex-1 rounded-md border px-1.5 text-[0.74rem] transition-colors",
                                      toneClass(ch.tone, on, c.suggested),
                                    )}
                                  >
                                    {ch.label}
                                  </button>
                                );
                              })}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {choices.length > 0 && (
        <footer className="border-t border-line bg-panel/95 px-4 py-3 backdrop-blur-sm">
          <div className="mb-2 flex items-center gap-3">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-label="Decided"
              aria-valuemin={0}
              aria-valuemax={pick ? (pick.target ?? total) : total}
              aria-valuenow={pick ? picked : decided}
            >
              <div
                className="h-full rounded-full bg-gold"
                style={{
                  width: `${Math.min(100, pick ? (picked / ((pick.target ?? total) || 1)) * 100 : total ? (decided / total) * 100 : 0)}%`,
                }}
              />
            </div>
            <span
              className="shrink-0 text-[0.76rem] text-muted tabular-nums"
              data-testid="workspace-progress"
            >
              {pick
                ? `${picked}${pick.target ? ` of ${pick.target}` : ""} selected`
                : `${decided} of ${total} decided`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              tone="primary"
              className="ml-auto"
              disabled={submit.isPending || decided === 0}
              onClick={() => void doSubmit().catch(() => undefined)}
            >
              {submit.isPending
                ? "Sending..."
                : (spec.submitLabel ??
                  (pick ? `Send my selection to ${aiName}` : "Submit decisions"))}
            </Button>
          </div>
          <p className="mt-2 text-[0.74rem] text-faint" role="status">
            {submit.isError
              ? (submit.error as Error).message
              : select.isError
                ? `Your last choices were not saved: ${(select.error as Error).message}`
                : submittedAt
                  ? `Sent ${new Date(submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Ember continues from your exact choices; nothing is deleted or changed until you approve a plan.`
                  : `Submitting sends your choices to ${aiName}. It is not approval: changes still need your approval in a plan.`}
          </p>
        </footer>
      )}

      {confirming && (
        <ConfirmClose
          busy={discard.isPending}
          error={discard.error}
          onCancel={() => {
            discard.reset();
            setConfirming(false);
          }}
          onConfirm={() =>
            discard.mutate(id, {
              onSuccess: () => {
                setConfirming(false);
                onClose();
              },
            })
          }
        />
      )}
      {saving && (
        <SaveDialog
          title={spec.title}
          canFile={temporary}
          folders={folders}
          busy={save.isPending || saveNote.isPending}
          error={((save.error ?? saveNote.error) as Error | null)?.message}
          onCancel={() => setSaving(false)}
          onSave={async (target, input) => {
            // Choices still waiting to be saved go first, so what is saved includes them.
            await flush().catch(() => undefined);
            const done = (message: string) => () => {
              setSaving(false);
              setNotice(message);
            };
            if (target === "file")
              save.mutate(input, {
                onSuccess: done("Saved in the Forge Library. Reopen it any time from the Forge."),
              });
            else
              saveNote.mutate(input.title, {
                onSuccess: done("Saved as a note in Memory. This workspace is unchanged."),
              });
          }}
        />
      )}
      {editing && (
        <EditDialog
          title={spec.title}
          description={spec.description}
          folder={view.folder}
          folders={folders}
          busy={editFile.isPending}
          error={(editFile.error as Error | null)?.message}
          onCancel={() => setEditing(false)}
          onSave={(patch) =>
            editFile.mutate({ id, ...patch }, { onSuccess: () => setEditing(false) })
          }
        />
      )}
    </section>
  );
}
