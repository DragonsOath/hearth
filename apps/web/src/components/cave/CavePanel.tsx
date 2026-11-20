import { useAiName } from "../../data/api";
import { EmberDecoration } from "../panels/brands";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useOverall } from "../shell/TopBar";
import { NEEDS_YOU_HREF } from "../../lib/attention";
import { PhoneLairButton } from "../shell/LairButton";
import { minimizeGroup } from "../desk/groups";
import {
  Check,
  ChevronRight,
  Image as ImageIcon,
  History,
  Maximize2,
  Menu,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cx, StatusDot } from "../ui";
import {
  useCaveConversation,
  useCaveConversations,
  useConversationSearch,
  useDeleteConversation,
  useRenameConversation,
  useSetConversationLook,
} from "../../data/cave";
import { LookDialog, LookImage } from "./ThreadLooks";
import { threadLook } from "@dragon-control/core";
import { useProjects } from "../../data/projects";
import { ago } from "../../lib/format";
import { DragonEmblem } from "../shell/DragonEmblem";
import { PlanUsage } from "./PlanUsage";
import { AttachedAi } from "./AttachedAi";
import { useCave } from "../shell/cave-context";
import { CaveChat, ModelSwitch, type FocusChip } from "./CaveChat";
import { usePhone } from "../../lib/media";
import { PhoneDock } from "../desk/PhoneDock";

/**
 * The conversations list (11-07: rename and delete them; no one ever-growing "main"): the one
 * Ember continues first, this project's next, then the rest, newest first. A click opens one;
 * right-click (or a long press, or the keyboard's menu key) gives Rename and Delete (11-07: no
 * hidden buttons that open the thread when clicked).
 */
export function ConversationsPanel({
  onPick,
  onOpen,
  activeId,
  className,
  startPicking = false,
}: {
  /** Opened by a New conversation button: the Thread Looks picker shows at once. */
  startPicking?: boolean;
  onPick?: () => void;
  /** Where a conversation opens instead of the Lair's chat (the Ask page's own address). */
  onOpen?: (id: string | undefined) => void;
  /** The conversation shown, when it is not the Lair's. */
  activeId?: string;
  className?: string;
}) {
  const phone = usePhone();
  const cave = useCave();
  const list = useCaveConversations();
  const projects = useProjects({ all: true });
  const rename = useRenameConversation();
  const del = useDeleteConversation();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string }>();
  const [deleting, setDeleting] = useState<string>();
  // The Thread Looks picker: for a new conversation, or to change one thread's picture.
  const [picking, setPicking] = useState<
    "new" | { id: string; look?: string; title: string } | undefined
  >(startPicking ? "new" : undefined);
  const setLook = useSetConversationLook();
  // Searching the words of every conversation too, not only the names (11-17).
  const found = useConversationSearch(q);
  const searching = q.trim().length >= 2;
  const navRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{
    id: string;
    title: string;
    look?: string;
    working: boolean;
    x: number;
    y: number;
  }>();
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const items = (list.data ?? []).filter(
    (c) => !q || c.title.toLowerCase().includes(q.toLowerCase()),
  );
  const main = items.filter((c) => c.main);
  const here = items.filter((c) => !c.main && cave.projectId && c.projectId === cave.projectId);
  const rest = items.filter((c) => !c.main && !here.includes(c));
  const err = rename.error ?? del.error ?? setLook.error;
  return (
    <nav
      ref={navRef}
      aria-label="Conversations"
      className={cx("relative flex min-h-0 flex-col", className)}
    >
      <button
        type="button"
        onClick={() => setPicking((p) => (p === "new" ? undefined : "new"))}
        aria-expanded={picking === "new"}
        className="mb-3 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gold/40 bg-gold/10 text-[0.86rem] font-semibold text-gold hover:bg-gold/20"
        data-testid="conversation-new"
      >
        <Plus strokeWidth={1.75} className="h-4 w-4" /> New conversation
      </button>
      {picking && (
        <LookDialog
          title={picking === "new" ? "New conversation" : "Change its picture"}
          noneLabel={picking === "new" ? "No image" : "No picture"}
          current={picking === "new" ? undefined : (picking.look ?? null)}
          currentTitle={picking === "new" ? undefined : picking.title}
          onCancel={() => setPicking(undefined)}
          onDone={(look, name) => {
            if (picking === "new") {
              cave.startNew(look, name);
              onOpen?.(undefined);
              onPick?.();
            } else {
              if ((look ?? null) !== (picking.look ?? null))
                setLook.mutate({ id: picking.id, look: look ?? null });
              if (name && name !== picking.title) rename.mutate({ id: picking.id, title: name });
            }
            setPicking(undefined);
          }}
        />
      )}
      <label className="mb-3 flex min-h-10 items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 text-faint focus-within:border-gold/50">
        <Search strokeWidth={1.5} className="h-3.5 w-3.5" />
        <span className="sr-only">Search conversations</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Where did we talk about…"
          className="min-w-0 flex-1 bg-transparent text-[0.84rem] text-ink placeholder:text-faint focus:outline-none"
        />
      </label>
      {err && (
        <p className="mb-2 text-[0.78rem] text-amber" role="alert">
          {err.message}
        </p>
      )}
      {searching && (
        <ul
          className="min-h-0 flex-1 space-y-1 overflow-y-auto"
          aria-label="Conversations that mention it"
          data-testid="conversation-search-results"
        >
          {found.isLoading && <li className="px-3 py-2 text-[0.82rem] text-faint">Searching…</li>}
          {found.data?.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => {
                  if (h.match) cave.jumpTo({ id: h.id, index: h.match.index });
                  cave.select(h.id);
                  onOpen?.(h.id);
                  onPick?.();
                }}
                className="flex w-full items-start gap-2 rounded-lg border border-transparent px-3 py-2 text-left hover:border-line hover:bg-raised"
                data-testid="conversation-hit"
              >
                <LookImage look={h.look} className="mt-0.5 h-7 w-7" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 text-[0.88rem] text-ink">{h.title}</span>
                  <span className="block text-[0.72rem] text-faint">
                    {[
                      h.projectId ? (names.get(h.projectId) ?? "Project") : undefined,
                      ago(h.match?.at ?? h.updatedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {h.match && (
                    <span
                      className="mt-0.5 line-clamp-2 block text-[0.78rem] text-muted"
                      data-testid="conversation-hit-line"
                    >
                      {h.match.role === "you" ? "You: " : ""}
                      {h.match.text}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {found.isSuccess && !found.data.length && (
            <li className="px-3 py-2 text-[0.82rem] text-faint">
              No conversation mentions “{q.trim()}”.
            </li>
          )}
          {found.isError && (
            <li className="px-3 py-2 text-[0.82rem] text-amber" role="alert">
              {found.error.message}
            </li>
          )}
        </ul>
      )}
      <ul className={cx("min-h-0 flex-1 space-y-1 overflow-y-auto", searching && "hidden")}>
        {[...main, ...here, ...rest].map((c) => {
          const active = c.id === (onOpen ? activeId : cave.conversationId);
          const sub = [
            c.main ? "Ember continues this one" : undefined,
            c.projectId ? (names.get(c.projectId) ?? "Project") : undefined,
            ago(c.updatedAt),
            c.status === "working" ? "answering" : undefined,
          ]
            .filter(Boolean)
            .join(" · ");
          if (editing?.id === c.id)
            return (
              <li key={c.id}>
                <form
                  className="flex items-center gap-1.5 rounded-lg border border-gold/50 bg-gold/5 p-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename.mutate(editing, { onSuccess: () => setEditing(undefined) });
                  }}
                >
                  <input
                    value={editing.title}
                    onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(undefined);
                    }}
                    maxLength={80}
                    aria-label="Conversation name"
                    autoFocus
                    className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-[0.85rem] text-ink focus:border-gold focus:outline-none"
                    data-testid="conversation-name"
                  />
                  <button
                    type="submit"
                    disabled={!editing.title.trim() || rename.isPending}
                    className="grid h-9 w-9 place-items-center rounded-md text-gold hover:bg-gold/15 disabled:opacity-40"
                    aria-label="Save the name"
                  >
                    <Check strokeWidth={1.75} className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(undefined)}
                    className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-line"
                    aria-label="Cancel"
                  >
                    <X strokeWidth={1.75} className="h-4 w-4" />
                  </button>
                </form>
              </li>
            );
          if (deleting === c.id)
            return (
              <li key={c.id}>
                <div
                  className="space-y-2 rounded-lg border border-bad/50 bg-bad/10 p-2.5"
                  role="group"
                  aria-label={`Delete ${c.title}?`}
                >
                  <p className="text-[0.82rem] text-ink">
                    Delete “<span className="font-semibold">{c.title}</span>” and all its messages?
                    This can&apos;t be undone.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={del.isPending}
                      onClick={() =>
                        del.mutate(c.id, {
                          onSuccess: () => {
                            setDeleting(undefined);
                            if (active) {
                              cave.select(undefined);
                              onOpen?.(undefined);
                            }
                          },
                        })
                      }
                      className="min-h-9 rounded-md bg-bad px-3 text-[0.8rem] font-semibold text-bg"
                      data-testid="conversation-delete-confirm"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(undefined)}
                      className="min-h-9 rounded-md border border-line-strong px-3 text-[0.8rem] text-muted hover:text-ink"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              </li>
            );
          return (
            <li key={c.id} className="group relative" data-testid="conversation">
              <button
                type="button"
                onClick={() => {
                  if (c.main) cave.selectMain();
                  else cave.select(c.id);
                  onOpen?.(c.id);
                  onPick?.();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  // The keyboard's menu key reports 0,0: open it at the row instead.
                  // Placed inside the list (not over the page), so a pop-up it sits in stays open.
                  const box = navRef.current!.getBoundingClientRect();
                  const x = Math.min((e.clientX || r.left + 24) - box.left, box.width - 168);
                  const y = (e.clientY || r.top + r.height / 2) - box.top;
                  setMenu({
                    id: c.id,
                    title: c.title,
                    look: c.look,
                    working: c.status === "working",
                    x,
                    y,
                  });
                }}
                className={cx(
                  "flex min-h-14 w-full flex-col justify-center rounded-lg border py-2 px-3 text-left transition-colors",
                  active
                    ? "border-gold/50 bg-gold/10"
                    : "border-transparent hover:border-line hover:bg-raised",
                )}
                aria-current={active ? "true" : undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <LookImage look={c.look} className="h-7 w-7" />
                  <span className="min-w-0">
                    <span className="line-clamp-1 text-[0.88rem] text-ink">{c.title}</span>
                    <span className="block text-[0.74rem] text-faint">{sub}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {!items.length && (
          <li className="px-3 py-2 text-[0.82rem] text-faint">No conversations yet.</li>
        )}
      </ul>
      {items.length > 0 && (
        <p className="mt-2 text-[0.72rem] text-faint">
          {phone ? "Press and hold" : "Right-click"} a conversation to rename it, change its picture
          or delete it.
        </p>
      )}
      {menu && (
        <div
          role="menu"
          aria-label={`${menu.title}: options`}
          className="absolute z-50 min-w-40 rounded-lg border border-line-strong bg-raised p-1 shadow-xl"
          style={{ left: Math.max(0, menu.x), top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="conversation-menu"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setEditing({ id: menu.id, title: menu.title });
              setMenu(undefined);
            }}
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[0.85rem] text-ink hover:bg-line"
            data-testid="conversation-rename"
          >
            <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setPicking({ id: menu.id, look: menu.look, title: menu.title });
              setMenu(undefined);
              navRef.current?.scrollIntoView({ block: "nearest" });
            }}
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[0.85rem] text-ink hover:bg-line"
            data-testid="conversation-look"
          >
            <ImageIcon strokeWidth={1.5} className="h-3.5 w-3.5" /> Change picture
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menu.working}
            title={menu.working ? "Ember is still answering in this one" : undefined}
            onClick={() => {
              setDeleting(menu.id);
              setMenu(undefined);
            }}
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[0.85rem] text-bad hover:bg-bad/15 disabled:opacity-40"
            data-testid="conversation-delete"
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete…
          </button>
        </div>
      )}
    </nav>
  );
}

/**
 * The main Ember chat in a frame: used expanded over the dashboard
 * and docked beside a project or service.
 */
export function CavePanel({
  focus,
  onClearFocus,
  onMinimize,
  projectId,
  className,
  autoFocus,
}: {
  focus?: FocusChip;
  onClearFocus?: () => void;
  onMinimize?: () => void;
  /** New conversations started here belong to this project. */
  projectId?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const aiName = useAiName();
  const cave = useCave();
  const [params] = useSearchParams();
  const [list, setList] = useState(false);
  const [menu, setMenu] = useState(false);
  const phone = usePhone();
  const conversationId = cave.conversationId;
  const convo = useCaveConversation(conversationId);
  // Full screen keeps what is open, so the way back leads to the same workspace.
  const context =
    (cave.projectId ?? params.get("project"))
      ? `?project=${encodeURIComponent((cave.projectId ?? params.get("project"))!)}`
      : params.get("service")
        ? `?service=${encodeURIComponent(params.get("service")!)}`
        : "";

  return (
    // Which AI answers, switchable right above Ember's panel (11-07: above the box, so the
    // painted frame never hides it).
    <div className={cx("flex min-h-0 flex-col gap-2", className)}>
      {!phone && <AttachedAi />}
      <section
        aria-label="Ember"
        data-ember-frame=""
        className="relative isolate flex min-h-0 flex-1 flex-col rounded-2xl border border-gold/40 bg-panel cc-glow"
      >
        <EmberDecoration />
        {phone && menu && (
          <PhoneChatMenu
            aiName={aiName}
            fullScreen={`${conversationId ? `/ask/${conversationId}` : "/ask"}${context}`}
            onClose={() => setMenu(false)}
          />
        )}
        <header
          className={cx(
            "flex items-center border-b border-line",
            phone ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3",
          )}
        >
          {phone && (
            <button
              type="button"
              onClick={() => setMenu(true)}
              aria-label="Menu: conversations, which AI, panels"
              aria-expanded={menu}
              className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink/90 hover:text-gold"
              data-testid="chat-menu"
            >
              <Menu strokeWidth={1.75} className="h-6 w-6" />
            </button>
          )}
          <DragonEmblem className={cx("ember-avatar shrink-0", phone ? "h-8 w-8" : "h-10 w-10")} />
          {/* A plate behind the words so they read over the painted frame (11-07). */}
          <div
            className={cx(
              "min-w-0 flex-1 rounded-xl bg-panel/90 shadow-sm ring-1 ring-line",
              phone ? "px-2.5 py-1" : "px-3 py-2",
            )}
            data-testid="ember-title-plate"
          >
            <p
              className={cx(
                "font-display leading-none tracking-[0.04em] text-gold uppercase",
                phone ? "text-[1rem]" : "text-[1.25rem]",
              )}
            >
              {aiName}
            </p>
            <p
              className={cx(
                "flex min-w-0 items-center gap-1.5 text-muted",
                phone ? "text-[0.74rem]" : "mt-1 text-[0.8rem]",
              )}
              data-testid="ember-thread-name"
            >
              {/* The thread's picture (Thread Looks), beside its name: never in place of Ember. */}
              <LookImage
                look={conversationId ? convo.data?.look : cave.newLook}
                className={phone ? "h-4 w-4" : "h-5 w-5"}
              />
              <span className="truncate">
                {cave.isProject
                  ? "This project's conversation"
                  : conversationId
                    ? (convo.data?.title ?? "Conversation")
                    : (cave.newTitle ?? threadLook(cave.newLook)?.name ?? "New conversation")}
              </span>
            </p>
            {!phone && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <PlanUsage />
              </div>
            )}
          </div>
          {/* A plate behind the buttons so they read on the painted frame (the owner, 2026-11-02). */}
          {(!phone || onMinimize) && (
            <div
              data-testid="ember-controls"
              className="flex shrink-0 items-center self-start rounded-xl bg-panel/90 shadow-sm ring-1 ring-line [&>*:not([aria-expanded=true]):not(:hover)]:text-ink/90"
            >
              {!phone && (
                <button
                  type="button"
                  onClick={() => setList(!list)}
                  aria-label="Conversations"
                  aria-expanded={list}
                  className={cx(
                    "flex h-10 w-10 items-center justify-center rounded-lg hover:text-gold",
                    list ? "text-gold" : "text-muted",
                  )}
                >
                  <History strokeWidth={1.35} className="h-[18px] w-[18px]" />
                </button>
              )}
              {!phone && (
                <Link
                  to={`${conversationId ? `/ask/${conversationId}` : "/ask"}${context}`}
                  aria-label="Open full screen"
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
                >
                  <Maximize2 strokeWidth={1.35} className="h-[17px] w-[17px]" />
                </Link>
              )}
              {onMinimize && (
                <button
                  type="button"
                  onClick={onMinimize}
                  aria-label={`Minimize ${aiName}`}
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
                >
                  <Minus strokeWidth={1.5} className="h-5 w-5" />
                </button>
              )}
            </div>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          {list && (
            <ConversationsPanel
              // A phone (11-15, the owner): the list takes the whole chat area instead of
              // squeezing the conversation into a sliver beside it; picking one closes it.
              className={cx(
                "border-line p-3",
                phone ? "min-w-0 flex-1 overflow-y-auto" : "w-60 shrink-0 border-r",
              )}
              onPick={() => setList(false)}
            />
          )}
          {cave.ready ? (
            <CaveChat
              key={conversationId ?? "new"}
              // Kept mounted under a phone's list, so a half-typed message and the answer stay.
              className={cx(
                "min-w-0 flex-1",
                phone ? "px-2.5 pt-2 pb-2" : "p-4",
                phone && list && "hidden",
              )}
              conversationId={conversationId}
              onConversation={(id) => cave.select(id)}
              projectId={projectId ?? cave.projectId}
              focus={focus}
              onClearFocus={onClearFocus}
              draftKey={`dc-cave-draft-${conversationId ?? "new"}`}
              initial={cave.pending}
              onInitialSent={cave.clearPending}
              autoFocus={autoFocus}
              modelInMenu={phone}
            />
          ) : (
            <p className="p-4 text-[0.86rem] text-faint">Opening the conversation…</p>
          )}
        </div>
      </section>
    </div>
  );
}

/** The expanded chat over the page, anywhere in the app. Escape minimizes it. */
export function CaveOverlay() {
  const cave = useCave();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Escape minimizes only while you are in the conversation, so it never fights another
    // dialog or a form on the page behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panel.current?.contains(document.activeElement))
        cave.setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cave]);
  return (
    // Floats over every page and follows you as you move around Hearth (10-29): the page
    // behind stays usable (no backdrop, clicks pass through), and only Minimize closes it.
    <div
      className="pointer-events-none fixed inset-x-0 top-0 bottom-0 z-40 flex items-stretch justify-end p-0 md:top-16 md:p-5"
      data-testid="cave-overlay"
    >
      <div ref={panel} className="pointer-events-auto flex w-full md:w-auto">
        <CavePanel
          className="cc-grow relative w-full rounded-none md:max-h-[min(780px,calc(100dvh-7rem))] md:w-[min(600px,72vw)] md:rounded-2xl lg:w-[min(640px,52vw)]"
          onMinimize={() => cave.setExpanded(false)}
          autoFocus
        />
      </div>
    </div>
  );
}

/**
 * A phone's chat menu (11-16, the owner: "put all that header stuff in the hamburger"): a drawer
 * from the left, as in the Claude app, with the conversations, which AI answers, the panels and
 * saved workspaces, and full screen. Escape or the backdrop closes it.
 */
/**
 * The phone header's part, in the chat's menu while the chat fills the screen (11-18, the
 * owner: "everything lives in the menu bars"): what needs you, the Lair, and Minimize all.
 */
function PhoneMenuStatus({ onClose }: { onClose: () => void }) {
  const overall = useOverall();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const lair = params.has("panels");
  return (
    <section aria-label="Hearth" className="space-y-2" data-testid="chat-menu-status">
      {overall && (
        <Link
          to={overall.needYou ? NEEDS_YOU_HREF : "/incidents"}
          onClick={onClose}
          className="flex min-h-11 items-center gap-2.5 rounded-lg border border-line px-3 text-[0.86rem] text-ink hover:border-gold/50"
          data-testid="overall-status-menu"
        >
          <StatusDot health={overall.tone === "ok" ? "healthy" : "attention"} />
          <span className="flex-1">
            {overall.tone === "ok" ? "All systems online" : overall.label}
          </span>
          <ChevronRight strokeWidth={1.5} className="h-4 w-4 text-faint" aria-hidden />
        </Link>
      )}
      <div className="flex items-center gap-2">
        <PhoneLairButton />
        {lair && (
          <button
            type="button"
            onClick={() => {
              onClose();
              minimizeGroup(navigate);
            }}
            title="Keep this Lair as it is (everything stays open) and go back to Home"
            className="flex h-10 items-center gap-1.5 rounded-full border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-gold"
            data-testid="chat-menu-minimize"
          >
            <Minimize2 strokeWidth={1.5} className="h-4 w-4" aria-hidden />
            Minimize all
          </button>
        )}
      </div>
    </section>
  );
}

function PhoneChatMenu({
  aiName,
  fullScreen,
  onClose,
}: {
  aiName: string;
  fullScreen: string;
  onClose: () => void;
}) {
  // Going somewhere from it (a panel, a saved workspace) closes it.
  const { key } = useLocation();
  const opened = useRef(key);
  useEffect(() => {
    if (key !== opened.current) onClose();
  }, [key, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // On the page itself, so nothing on the page (the tab bar, a panel) paints over it.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex" data-testid="chat-menu-drawer" data-chat-menu="">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${aiName} menu`}
        className="flex h-full w-[86%] max-w-sm flex-col overflow-y-auto border-r border-gold/30 bg-panel pb-6 shadow-[8px_0_32px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <DragonEmblem className="ember-avatar h-8 w-8 shrink-0" />
          <p className="flex-1 font-display text-[1rem] tracking-[0.04em] text-gold uppercase">
            {aiName}
          </p>
          <Link
            to={fullScreen}
            onClick={onClose}
            aria-label="Open full screen"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
          >
            <Maximize2 strokeWidth={1.35} className="h-[17px] w-[17px]" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the menu"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
          >
            <X strokeWidth={1.5} className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 px-3 pt-3">
          <PhoneMenuStatus onClose={onClose} />
          <section aria-label="Which AI answers">
            <AttachedAi />
            <ModelSwitch />
          </section>
          <section aria-label="Panels and saved workspaces" className="-mx-4">
            <PhoneDock />
          </section>
          <section aria-label="Conversations">
            <ConversationsPanel onPick={onClose} />
          </section>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close the menu"
        onClick={onClose}
        className="flex-1 bg-black/60"
        tabIndex={-1}
      />
    </div>,
    document.body,
  );
}
