import type { CaveAttachment } from "@dragon-control/core";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { continueConversation, useMainConversation, useProjectConversation } from "../../data/cave";
import { useQueryClient } from "@tanstack/react-query";
import { focusFrom, panelsFrom } from "../desk/layout";
import { useDesk } from "../desk/links";
import { EmberMarkNotice, emberMarkSeen } from "../ember/EmberMark";

/**
 * The command center's Ember state, kept at the shell so moving
 * between the hub, a project, a service, or another page never loses the
 * conversation.
 *
 * Which conversation is shown depends on where you are. On its own (Home,
 * other pages, a service) it is the main conversation unless you picked
 * another. With a project open (`?project=` on Home or the Ask page) it is
 * that project's ongoing conversation unless you switched to the main one or
 * another; the choice is remembered per project for the session, so going
 * from the conversation to the workspace and back keeps the same thread.
 */

interface CaveState {
  /** The conversation shown in the chat panel (undefined: a fresh one starts on the next message). */
  conversationId: string | undefined;
  /** The project in view, if any: new conversations started here belong to it. */
  projectId: string | undefined;
  /** True while the main conversation is the one shown. */
  isMain: boolean;
  /** True while the open project's own conversation is the one shown. */
  isProject: boolean;
  /** False until the conversation to show is known (so nothing starts a stray new one). */
  ready: boolean;
  /** Show another conversation (undefined: start a fresh one on the next message). */
  select: (id: string | undefined) => void;
  /** Back to the main conversation. */
  selectMain: () => void;
  /** Back to the open project's own conversation. */
  selectProject: () => void;
  /**
   * Start a fresh conversation with a Thread Look (its picture and default name), or none: the
   * next message makes it.
   */
  startNew: (look?: string, title?: string) => void;
  /** The name the owner gave the next new conversation, if any (else the look's name). */
  newTitle: string | undefined;
  /** The look the next new conversation gets (until its first message makes it). */
  newLook: string | undefined;
  /** Open a conversation at one of its messages (a search hit): its place in the thread. */
  jump: { id: string; index: number } | undefined;
  jumpTo: (to: { id: string; index: number } | undefined) => void;
  /** The new conversation was made: its look is spent. */
  clearNewLook: () => void;
  expanded: boolean;
  setExpanded: (open: boolean) => void;
  /**
   * Hand a question to the chat and open it. From a button (the default), the first press in this
   * browser explains that it starts Ember and uses the AI plan; `typed` is the owner's own words.
   */
  ask: (text: string, opts?: { typed?: boolean }) => void;
  /** The handed-over question, until the chat has sent it. */
  pending: string | undefined;
  clearPending: () => void;
  /**
   * Something selected inside a service ("Ask Ember about this"): the chat's "this"
   * means it until cleared. Only its identity goes to the server, which reads it fresh.
   */
  item: SelectedItem | undefined;
  selectItem: (item: SelectedItem | undefined) => void;
  /** Captures attached for your next message (stored on Hearth, not yet sent anywhere). */
  attached: CaveAttachment[];
  attach: (a: CaveAttachment) => void;
  detach: (id: string) => void;
  clearAttached: () => void;
}

export interface SelectedItem {
  serviceId: string;
  kind: "torrent" | "plex-session";
  id: string;
  /** For the chip only; the server never takes it on trust. */
  label: string;
}

const Ctx = createContext<CaveState | null>(null);
const KEY = "dc-cave-choice";
const OPEN_KEY = "dc-cave-expanded";

/** Per scope ("home" or "project:<id>"): "main", "project", "new", or a conversation id. */
type Choices = Record<string, string>;

function session(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function setSession(key: string, value: string | undefined) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Unavailable storage only loses the remembered choice, never messages.
  }
}
function readChoices(): Choices {
  try {
    const parsed: unknown = JSON.parse(session(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Choices) : {};
  } catch {
    return {};
  }
}

export function CaveProvider({ children }: { children: ReactNode }) {
  const [attached, setAttached] = useState<CaveAttachment[]>([]);
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const desk = useDesk();
  // One panel at a time (tablet, phone): the conversation follows the project shown. On the
  // desktop desk several panels are open, so it follows the first project opened and never
  // switches just because another panel opened; the dock offers every open project's.
  const panels = pathname === "/" ? panelsFrom(params) : [];
  const shown = panels.find((p) => `${p.kind}:${p.id}` === focusFrom(params, panels));
  const projectId =
    pathname === "/ask" || pathname.startsWith("/ask/")
      ? (params.get("project") ?? undefined)
      : pathname !== "/"
        ? undefined
        : desk
          ? panels.find((p) => p.kind === "project")?.id
          : shown?.kind === "project"
            ? shown.id
            : undefined;
  const scope = projectId ? `project:${projectId}` : "home";

  const main = useMainConversation();
  const qc = useQueryClient();
  const projectConvo = useProjectConversation(projectId);
  const [choices, setChoices] = useState<Choices>(readChoices);
  const [expanded, setOpen] = useState(() => session(OPEN_KEY) === "1");
  const [pending, setPending] = useState<string | undefined>();
  const [item, selectItem] = useState<SelectedItem | undefined>();
  const [newLook, setNewLook] = useState<string | undefined>();
  const [newTitle, setNewTitle] = useState<string | undefined>();
  const [jump, jumpTo] = useState<{ id: string; index: number } | undefined>();

  const choose = useCallback(
    (value: string | undefined) => {
      setChoices((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[scope];
        else next[scope] = value;
        setSession(KEY, JSON.stringify(next));
        return next;
      });
    },
    [scope],
  );
  const setExpanded = useCallback((open: boolean) => {
    setOpen(open);
    setSession(OPEN_KEY, open ? "1" : undefined);
  }, []);
  const send = useCallback(
    (text: string) => {
      setPending(text);
      setExpanded(true);
    },
    [setExpanded],
  );
  // A button's first press: say it starts Ember (and uses the plan) before it does (11-12).
  const [notice, setNotice] = useState<string>();
  const ask = useCallback(
    (text: string, opts?: { typed?: boolean }) => {
      if (opts?.typed || emberMarkSeen()) send(text);
      else setNotice(text);
    },
    [send],
  );

  const value = useMemo<CaveState>(() => {
    const choice = choices[scope] ?? (projectId ? "project" : "main");
    const mainId = main.data?.id;
    const projectConversationId = projectConvo.data?.id;
    const conversationId =
      choice === "new"
        ? undefined
        : choice === "main"
          ? mainId
          : choice === "project"
            ? projectConversationId
            : choice;
    return {
      conversationId,
      projectId,
      isMain: conversationId !== undefined && conversationId === mainId,
      isProject:
        Boolean(projectId) &&
        conversationId !== undefined &&
        conversationId === projectConversationId,
      ready:
        conversationId !== undefined ||
        choice === "new" ||
        (choice === "main" && main.isFetched) ||
        (choice === "project" && projectConvo.isFetched),
      select: (id) => {
        // A plain fresh one has no look; startNew gives one.
        if (id === undefined) {
          setNewLook(undefined);
          setNewTitle(undefined);
        }
        // Outside a project, the conversation you open is the one Ember continues from now on
        // (11-07: one ever-growing "main" slows Ember down; start fresh any time).
        if (id && !projectId && id !== mainId && id !== projectConversationId)
          void continueConversation(id)
            .then(() => qc.invalidateQueries({ queryKey: ["conversations"] }))
            .catch(() => undefined);
        choose(
          id === undefined
            ? "new"
            : id === mainId
              ? "main"
              : id === projectConversationId
                ? "project"
                : id,
        );
      },
      selectMain: () => choose("main"),
      selectProject: () => choose(projectId ? undefined : "main"),
      startNew: (look, title) => {
        setNewLook(look);
        setNewTitle(title);
        choose("new");
      },
      newLook,
      newTitle,
      jump,
      jumpTo,
      clearNewLook: () => {
        setNewLook(undefined);
        setNewTitle(undefined);
      },
      expanded,
      setExpanded,
      ask,
      pending,
      clearPending: () => setPending(undefined),
      item,
      selectItem,
      attached,
      attach: (a: CaveAttachment) => {
        setAttached((list) => [...list.filter((x) => x.id !== a.id), a].slice(-4));
        setExpanded(true);
      },
      detach: (id: string) => setAttached((list) => list.filter((x) => x.id !== id)),
      clearAttached: () => setAttached([]),
    };
  }, [
    attached,
    choices,
    newLook,
    newTitle,
    jump,
    scope,
    projectId,
    main.data?.id,
    main.isFetched,
    projectConvo.data?.id,
    projectConvo.isFetched,
    choose,
    qc,
    expanded,
    setExpanded,
    ask,
    pending,
    item,
  ]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {notice !== undefined && (
        <EmberMarkNotice
          onRun={() => {
            send(notice);
            setNotice(undefined);
          }}
          onClose={() => setNotice(undefined)}
        />
      )}
    </Ctx.Provider>
  );
}

/** The chat, where there is one (the standalone home screen has none). */
export function useCaveMaybe(): CaveState | null {
  return useContext(Ctx);
}

export function useCave(): CaveState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCave outside CaveProvider");
  return v;
}
