import { ASK_LEVEL_TEXT, type AskLevel } from "../../data/fullAccess";
import type { ProjectColor } from "@dragon-control/core";
import { EditProjectDialog, type EditTarget } from "../command/EditProject";
import { ProjectColorPicker } from "../command/ProjectColorPicker";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { JumpToLatest } from "../shell/JumpToLatest";
import { Link, NavLink, useNavigate } from "react-router";
import {
  Castle,
  Pin,
  FolderOpen,
  House,
  LayoutGrid,
  Menu,
  AudioLines,
  Ear,
  EarOff,
  MemoryStick,
  MessageSquare,
  OctagonX,
  Pause,
  Play,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { mobilePrimaryNav, moreNav } from "../nav";
import { useOpenLair } from "../shell/LairButton";
import { useProjects } from "../../data/projects";
import { api } from "../../data/api";
import { useCaveConversation, useMainConversation, useProjectConversation } from "../../data/cave";
import { useQueryClient } from "@tanstack/react-query";
import { MessagePicture, useChatPictures } from "../shell/MessagePicture";
import { PlayMessage } from "../shell/PlayMessage";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./ember-room.css";
import "./ember-room.extra.css";
import "./toolbar-looks.css";
import "./chat-look.css";
import { useTalkLayout } from "../../data/talkLayout";
import { useDesk } from "../desk/links";
import { useFeatureLink } from "../help/featureLink";
import { Rail, Windows, openIn, type OpenRequest } from "../talk/Workstation";
import { windowKey } from "../../data/talkLayout";
import {
  ACTIVE,
  cleanMeta,
  ember,
  emberFetch,
  emberSocketUrl,
  md,
  newer,
  previewBase,
  store,
  type EmberConfig,
  type EmberMessage,
  type EmberQueue,
  type EmberRemote,
  type EmberSkill,
  type EmberState,
  type EmberTask,
  type EmberUsage,
  type LogEntry,
  type ProjectFile,
  type Tile,
} from "./engine";
import { Orb, orbLabel, type OrbState } from "./sphere";
import { EmberVoice } from "./voice";
import { EmberTerminal, type TerminalHandle } from "./Terminal";
import { Dictation, canDictate, hearOnce, joinDictation } from "./dictation";
import { useDragScroll } from "../../lib/dragScroll";
import { GitHubMark, GitHubPanel, useGitHub, type GhItem } from "./GitHubPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import {
  CopyButton,
  FilesList,
  QueueList,
  queueSummary,
  Skills,
  TaskDetail,
  Tiles,
  UsagePanel,
} from "./parts";

/**
 * The War Room: EMBER's control center inside Hearth. The agent here is the real Claude Code or
 * Codex (switch at the top), working in project folders on Hearth's machine, with your homelab
 * memory loaded through Hearth's add-on. Hearth adds its own panels (services, storage, projects,
 * to-do, plans), opened from "Panels" and floating over the room.
 */

type Item =
  | { id: number; k: "intro"; name: string; desc: string }
  | { id: number; k: "you"; text: string }
  | { id: number; k: "ember"; text: string; meta: string }
  | { id: number; k: "sys"; text: string }
  | { id: number; k: "ask"; m: EmberMessage; answered?: string }
  /** A task waiting for your OK: shown in the conversation by itself, answered right there. */
  | { id: number; k: "approve"; taskId: number }
  | {
      id: number;
      k: "live";
      taskId: number;
      engine: string;
      steps: { t: string; err: boolean }[];
      text: string;
      running: boolean;
    };

interface RequestReply {
  reply?: string;
  speak?: string;
  route?: string;
  reason?: string;
  task?: EmberTask;
}

interface Att {
  key: number;
  name: string;
  path: string | null;
  preview: string | null;
}

interface AskMeta {
  kind?: string;
  answered?: string;
  title?: string;
  question?: string;
  details?: string[];
  options?: { key: string; label: string }[];
}

const parseMeta = (m: EmberMessage): AskMeta => {
  try {
    return JSON.parse(m.meta || "{}") as AskMeta;
  } catch {
    return {};
  }
};

let nextId = 1;
const id = () => nextId++;
/** A project's description in menus and tabs: its first line (the Homelab brief runs pages). */
const summary = (desc: string | undefined) => {
  const first = (desc ?? "").trim().split("\n")[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}...` : first;
};

/* ---------- conversation pieces ---------- */

/** A message with its writer's picture beside it (yours on the right, the AI's on the left),
 *  unless pictures are turned off in Settings. */
function WithPicture({ who, children }: { who: "you" | "ai"; children: ReactNode }) {
  const pictures = useChatPictures();
  if (!pictures) return <>{children}</>;
  return (
    <div className={`msg-row ${who === "you" ? "you" : "ember"}`}>
      {who === "ai" && <MessagePicture who="ai" className="msg-pic" />}
      {children}
      {who === "you" && <MessagePicture who="you" className="msg-pic" />}
    </div>
  );
}

function Msg({
  item,
  engineLabel,
  onStop,
  onAnswer,
  taskOf,
  onAct,
}: {
  item: Item;
  engineLabel: (e: string) => string;
  onStop: (taskId: number) => void;
  onAnswer: (item: Extract<Item, { k: "ask" }>, key: string, label: string) => void;
  taskOf: (taskId: number) => EmberTask | undefined;
  onAct: (taskId: number, act: string) => void;
}) {
  const featureLink = useFeatureLink();
  const hearth = (id: string) => featureLink(id)?.href;
  switch (item.k) {
    case "approve": {
      const t = taskOf(item.taskId);
      if (!t) return null;
      const waiting = t.state === "awaiting_approval";
      const cancelled = t.state === "cancelled";
      const request = t.prompt.length > 400 ? t.prompt.slice(0, 399) + "…" : t.prompt;
      return (
        <div className="msg perm" data-testid={`ember-approve-${t.id}`}>
          <div className="perm-head">
            <span className="perm-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M12 8v5M12 16h.01"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <div>
              <b>Task #{t.id} needs your OK</b>
              <small>
                {engineLabel(t.engine)} · {t.project}
              </small>
            </div>
          </div>
          <pre className="perm-body">{request}</pre>
          <div className="perm-q">
            {t.approval_reason
              ? `Held because of ${t.approval_reason}. Run it?`
              : "Held until you approve it. Run it?"}
          </div>
          {waiting ? (
            <div className="perm-acts">
              <button type="button" className="perm-btn yes" onClick={() => onAct(t.id, "approve")}>
                <kbd>1</kbd>
                <span>Approve and run</span>
              </button>
              <button type="button" className="perm-btn no" onClick={() => onAct(t.id, "cancel")}>
                <kbd>2</kbd>
                <span>No, cancel it</span>
              </button>
            </div>
          ) : (
            <div className={`perm-done ${cancelled ? "denied" : ""}`}>
              {cancelled
                ? "✕ Cancelled"
                : `✓ Approved${t.approved_by ? ` by ${t.approved_by}` : ""}`}
            </div>
          )}
        </div>
      );
    }
    case "intro":
      return (
        <div className="proj-intro">
          <b>{item.name}</b>
          <span>{summary(item.desc)}</span>
        </div>
      );
    case "you":
      return (
        <WithPicture who="you">
          <div className="msg you">
            <div className="txt">{item.text}</div>
            <CopyButton text={() => item.text} />
          </div>
        </WithPicture>
      );
    case "ember":
      return (
        <WithPicture who="ai">
          <div className="msg ember">
            <div className="who">{cleanMeta(item.meta) || "EMBER"}</div>
            {/* md() escapes the text first; only its own few tags become HTML. */}
            <div className="txt md" dangerouslySetInnerHTML={{ __html: md(item.text, hearth) }} />
            <PlayMessage text={item.text} messageKey={`room:${item.id}`} look="room" />
            <CopyButton text={() => item.text} />
          </div>
        </WithPicture>
      );
    case "sys": {
      const first = item.text.split("\n")[0] ?? "";
      return (
        <div className="msg sys" title={first !== item.text ? item.text : undefined}>
          <span className="txt">{first.length > 140 ? first.slice(0, 139) + "…" : first}</span>
        </div>
      );
    }
    case "live":
      return (
        <WithPicture who="ai">
          <div className="msg ember live" data-testid="ember-live">
            <div className="who">{engineLabel(item.engine)}</div>
            <div className="steps">
              {item.steps.map((s, i) => (
                <div key={i} className={s.err ? "err" : undefined}>
                  {(s.err ? "✖ " : "▸ ") + s.t}
                </div>
              ))}
            </div>
            <div className="txt md" dangerouslySetInnerHTML={{ __html: md(item.text, hearth) }} />
            <div className="working">
              <i />
              <span>
                {item.running
                  ? "working…"
                  : taskOf(item.taskId)?.state === "awaiting_approval"
                    ? "waiting for your approval (above, or in the queue)"
                    : "waiting its turn…"}
              </span>
              <button type="button" onClick={() => onStop(item.taskId)}>
                stop
              </button>
            </div>
          </div>
        </WithPicture>
      );
    case "ask": {
      const meta = parseMeta(item.m);
      const answered = item.answered ?? meta.answered;
      if (meta.kind === "rc" || meta.kind === "allow_tools") {
        const done = (text: string) => {
          const no = /^no\b/i.test(text);
          return (
            <div className={`perm-done ${no ? "denied" : ""}`}>{(no ? "✕ " : "✓ ") + text}</div>
          );
        };
        return (
          <div className="msg perm">
            <div className="perm-head">
              <span className="perm-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M12 8v5M12 16h.01"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <div>
                <b>Claude needs your OK</b>
                <small>{meta.title ?? ""}</small>
              </div>
            </div>
            {meta.details?.length ? (
              <pre className="perm-body">{meta.details.join("\n")}</pre>
            ) : null}
            <div className="perm-q">{meta.question || "Do you want to proceed?"}</div>
            {answered ? (
              done(answered)
            ) : (
              <div className="perm-acts">
                {(meta.options ?? []).map((o, i) => (
                  <button
                    key={o.key}
                    type="button"
                    className={`perm-btn ${i === 0 ? "yes" : /^no\b/i.test(o.label) ? "no" : "alt"}`}
                    onClick={() => onAnswer(item, o.key, o.label)}
                  >
                    <kbd>{/^\d$/.test(o.key) ? o.key : String(i + 1)}</kbd>
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      }
      return (
        <div className="msg ask">
          <span className="txt">{item.m.text}</span>
          {answered ? (
            <div className="answered">Answered: {answered}</div>
          ) : (
            <div className="ask-acts">
              <button
                type="button"
                className="btn primary"
                onClick={() => onAnswer(item, "allow", "Allowed")}
              >
                Allow &amp; run again
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onAnswer(item, "dismiss", "Not now")}
              >
                Not now
              </button>
            </div>
          )}
        </div>
      );
    }
  }
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);
const CLIP =
  "M16.5 6.5v10.6a4.5 4.5 0 0 1-9 0V5.5a3 3 0 0 1 6 0v10.4a1.5 1.5 0 0 1-3 0V6.5H9v9.4a3 3 0 0 0 6 0V5.5a4.5 4.5 0 0 0-9 0v11.6a6 6 0 0 0 12 0V6.5h-1.5z";

/* ---------- the room ---------- */

/** A PC's icon at the start of a tab, so it is clear which PC a project is on. */
function TabPc({ look }: { look: PcTabLook }) {
  return look.src ? (
    <img
      className="ptab-pc"
      src={look.src}
      alt={`On ${look.name}`}
      title={`On ${look.name}`}
      style={{ filter: `drop-shadow(0 0 3px ${look.color})` }}
    />
  ) : (
    <span className="ptab-pc dot" style={{ background: look.color }} title={`On ${look.name}`} />
  );
}

/** How a PC looks on a tab: its icon, and its name in the icon's color. */
export interface PcTabLook {
  name: string;
  src: string | null;
  color: string;
}

/** A tab open on another PC (the War Room switches to that PC when it is picked). */
export interface OtherTab {
  pc: string | null;
  slug: string;
  name: string;
  look: PcTabLook;
  offline?: boolean;
}

/** Projects on the other PCs, for the Open menu. */
export interface Elsewhere {
  pc: string | null;
  look: PcTabLook;
  projects: { slug: string; name: string; description: string; color?: ProjectColor }[];
}

/** Tabs remembered per PC: this Hearth's under the plain keys, a PC's with its id after. */
export const tabKey = (pc: string | null, what: "tabs" | "project" | "tabnames") =>
  `ember.${what}${pc ? `.${pc}` : ""}`;

export function EmberRoom({
  pc = null,
  here,
  others = [],
  elsewhere = [],
  onMenu,
  machines = [],
  onOpenOther,
  onCloseOther,
  onTabs,
}: {
  /** The PC this War Room is on (null: this Hearth). */
  pc?: string | null;
  /** This PC's look on its tabs (none while there is just one PC). */
  here?: PcTabLook;
  others?: OtherTab[];
  /** Projects on the other PCs (the Open menu lists them with their PC). */
  elsewhere?: Elsewhere[];
  /** The Open menu opened (the other PCs' project lists are refreshed). */
  onMenu?: () => void;
  /** Every PC, for "Which PC should this live on?" */
  machines?: { pc: string | null; look: PcTabLook; online: boolean }[];
  onOpenOther?: (pc: string | null, slug: string) => void;
  onCloseOther?: (pc: string | null, slug: string) => void;
  /** This PC's open tabs changed (so the tabs from every PC stay in step). */
  onTabs?: () => void;
} = {}) {
  const navigate = useNavigate();
  const desk = useDesk();
  const [cfg, setCfg] = useState<EmberConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<number, EmberTask>>({});
  const [queue, setQueue] = useState<EmberQueue | null>(null);
  const [skills, setSkills] = useState<EmberSkill[]>([]);
  const [usage, setUsage] = useState<EmberUsage | null>(null);
  const [remote, setRemote] = useState<EmberRemote[]>([]);
  const [health, setHealthState] = useState<Record<string, boolean | undefined>>({});
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [engine, setEngine] = useState(store.get("ember.engine") ?? "claude-code");
  const [project, setProject] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [view, setViewState] = useState<"chat" | "term">(
    store.get("ember.view2") === "term" ? "term" : "chat",
  );
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(0);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [filesPreview, setFilesPreview] = useState<string | null>(null);
  const [mtab, setMtab] = useState(store.get("ember.tab") ?? "chat");
  // The Lair tab (10-30): the Lair's own conversation here, always first and never closed.
  // "main" is its main thread, a project id a Lair project's thread; null: a War Room project.
  // Lair project tabs are remembered once for every PC: the Lair is one, whichever PC is open.
  const [lair, setLairState] = useState<string | null>(() => store.get("ember.lair") || null);
  const [lairTabs, setLairTabs] = useState<string[]>(() => {
    try {
      return JSON.parse(store.get("ember.lairTabs") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const lairProjects = useProjects();
  const lairNames = new Map((lairProjects.data ?? []).map((p) => [p.id, p.name]));
  const setLair = useCallback((key: string | null) => {
    setLairState(key);
    store.set("ember.lair", key ?? "");
    if (key && key !== "main")
      setLairTabs((tabs) => {
        const next = tabs.includes(key) ? tabs : [...tabs, key];
        store.set("ember.lairTabs", JSON.stringify(next));
        return next;
      });
  }, []);
  const closeLairTab = (key: string) => {
    setLairTabs((tabs) => {
      const next = tabs.filter((k) => k !== key);
      store.set("ember.lairTabs", JSON.stringify(next));
      return next;
    });
    if (lair === key) setLair("main");
  };
  // Another PC's tab: the War Room moves there, on that project (not the Lair tab).
  const openOther = (otherPc: string | null, slug: string) => {
    setLair(null);
    onOpenOther?.(otherPc, slug);
  };
  const [speakOn, setSpeakOn] = useState(true);
  const [voiceId, setVoiceId] = useState<string>("");
  // Voice chat (10-26): talk back and forth. Replies are spoken, and `handsfree` (the ear)
  // is whether it is listening right now; the ear can be turned off without leaving voice chat.
  const [voiceChat, setVoiceChat] = useState(false);
  const [handsfree, setHandsfree] = useState(false);
  const [micLive, setMicLive] = useState(false);
  const [atts, setAtts] = useState<{ msg: Att[]; task: Att[] }>({ msg: [], task: [] });
  const [text, setText] = useState("");
  const [agent, setAgent] = useState("claude");
  const [model, setModel] = useState("");
  const askLevel: AskLevel = queue?.ask_level ?? (queue?.full_access ? "free" : "strict");
  const [approveFirst, setApproveFirst] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [taskText, setTaskText] = useState("");
  const [pmenu, setPmenu] = useState(false);
  const [newProj, setNewProj] = useState(false);
  const [npName, setNpName] = useState("");
  const [npDesc, setNpDesc] = useState("");
  const [npColor, setNpColor] = useState<ProjectColor | undefined>(undefined);
  const [npErr, setNpErr] = useState("");
  // New projects live on this PC unless you choose another.
  const [npPc, setNpPc] = useState<string | null>(pc);
  const [modal, setModal] = useState<{ title: string; body: string } | null>(null);
  const [optsOpen, setOptsOpen] = useState(false);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [art, setArt] = useState<{ open: boolean; start: ProjectFile | null }>({
    open: false,
    start: null,
  });
  const [shot, setShot] = useState<{ url: string; blob: Blob; msg: string } | null>(null);
  const [dropHint, setDropHint] = useState(false);
  const [orbText, setOrbText] = useState("IDLE");
  const [clock, setClock] = useState("--:--");
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openLair = useOpenLair();
  const [expanded, setExpanded] = useState<string | null>(null);
  const { layout, update } = useTalkLayout("ember-room");
  const gh = useGitHub(project);

  // Refs for the socket and voice callbacks, which outlive any one render.
  const r = useRef({
    lair,
    tasks,
    project,
    health,
    busy,
    speakOn,
    voiceId,
    handsfree,
    voiceChat,
    cfg,
    sel,
    view,
    engine,
  });
  // The latest values, for callbacks that outlive a render (the socket, the microphone).
  useLayoutEffect(() => {
    r.current = {
      lair,
      tasks,
      project,
      health,
      busy,
      speakOn,
      voiceId,
      handsfree,
      voiceChat,
      cfg,
      sel,
      view,
      engine,
    };
  });
  // The Lair tab (10-30): the War Room's own chat (orb, bubbles, message bar, voice), with
  // the Lair's conversation in it. What you send goes to the Lair's Ember, the same thread as the
  // Lair page.
  const qc = useQueryClient();
  const lairMain = useMainConversation();
  const lairProject = useProjectConversation(lair && lair !== "main" ? lair : undefined);
  const lairId = lair === "main" ? lairMain.data?.id : lair ? lairProject.data?.id : undefined;
  const lairConvo = useCaveConversation(lairId);
  const lairMessages = useMemo(
    () => (lair ? (lairConvo.data?.messages ?? []) : []),
    [lair, lairConvo.data],
  );
  const lairWorking = Boolean(lair && lairConvo.data?.status === "working");
  const [lairPending, setLairPending] = useState<string | null>(null);
  const lairAwait = useRef<{ source: "typed" | "voice"; count: number } | null>(null);
  // For send(), which outlives a render: the conversation and how long it is now.
  const lairLive = useRef({ id: lairId, count: 0, qc });
  useLayoutEffect(() => {
    lairLive.current = { id: lairId, count: lairMessages.length, qc };
  });
  // Something said in the Lair page shows here too.
  useEffect(() => {
    if (!lairId) return;
    const t = window.setInterval(
      () => void qc.invalidateQueries({ queryKey: ["conversations", lairId] }),
      10_000,
    );
    return () => window.clearInterval(t);
  }, [lairId, qc]);
  const lairItems: Item[] = useMemo(() => {
    if (!lair) return [];
    const out: Item[] = [
      {
        id: 900_000,
        k: "intro",
        name:
          lair === "main"
            ? "The Lair"
            : ((lairProjects.data ?? []).find((p) => p.id === lair)?.name ?? "Lair project"),
        desc:
          lair === "main"
            ? "The Lair's main conversation with Ember. Same thread as the Lair: what you say here shows there too."
            : "This Lair project's own conversation with Ember.",
      },
    ];
    lairMessages.forEach((m, i) => {
      const id = 900_001 + i;
      if (m.role === "you") out.push({ id, k: "you", text: m.text });
      else if (m.role === "agent")
        out.push({ id, k: "ember", text: m.text, meta: "EMBER · THE LAIR" });
      else out.push({ id, k: "sys", text: m.text });
    });
    if (lairPending && !lairMessages.some((m) => m.role === "you" && m.text === lairPending))
      out.push({ id: 899_999, k: "you", text: lairPending });
    if (lairWorking || lairPending) {
      const asked = [...lairMessages].reverse().find((m) => m.role === "you");
      out.push({
        id: 899_998,
        k: "live",
        taskId: -1,
        engine: "lair",
        steps: (asked?.activity ?? []).map((a) => ({ t: a.label, err: a.status === "failed" })),
        text: "",
        running: true,
      });
    }
    return out;
  }, [lair, lairMessages, lairPending, lairWorking, lairProjects.data]);
  const voice = useMemo(() => new EmberVoice(), []);
  const orb = useRef<Orb | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const convo = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pfileInput = useRef<HTMLInputElement>(null);
  const attTarget = useRef<"msg" | "task">("msg");
  const termRef = useRef<TerminalHandle>(null);
  const speakGen = useRef(0);
  const voiceWarned = useRef(0);
  const awaitReply = useRef(false);
  const hfQuiet = useRef(0);
  const logAfter = useRef(0);
  const shell = useRef<HTMLDivElement>(null);
  const ptabs = useRef<HTMLElement>(null);
  const tabStrip = useDragScroll<HTMLDivElement>();
  const footer = useRef<HTMLElement>(null);
  const top = useRef<HTMLElement>(null);
  const segs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [glider, setGlider] = useState<{ width: number; x: number }>({ width: 0, x: 0 });

  const engineLabel = useCallback((n: string) => cfg?.engines[n]?.label ?? n, [cfg]);
  const projects = cfg?.projects ?? {};
  // Right-click a tab: edit that project's name and description (on whichever PC it lives).
  const [editProj, setEditProj] = useState<{
    pc: string | null;
    slug: string;
    name: string;
    description: string;
    color?: ProjectColor | undefined;
  } | null>(null);
  const [editErr, setEditErr] = useState("");
  // Right-click a tab: a small menu (edit, delete), and deleting asks once more.
  type ProjTarget = NonNullable<typeof editProj>;
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; t: ProjTarget } | null>(null);
  const [editLair, setEditLair] = useState<EditTarget | null>(null);
  const [delProj, setDelProj] = useState<(ProjTarget & { where: string }) | null>(null);
  const [delErr, setDelErr] = useState("");
  const [deleting, setDeleting] = useState(false);
  // Remember the open tabs' names, so the tabs from every PC show even while on another PC.
  const tabsChanged = useRef(onTabs);
  useLayoutEffect(() => {
    tabsChanged.current = onTabs;
  });
  const tabNames = JSON.stringify(openTabs.map((k) => [k, cfg?.projects[k]?.name ?? k]));
  useEffect(() => {
    if (!cfg) return;
    store.set(tabKey(pc, "tabnames"), JSON.stringify(Object.fromEntries(JSON.parse(tabNames))));
    tabsChanged.current?.();
  }, [tabNames, cfg, pc]);
  const P = projects[project];

  /* ---------- small helpers ---------- */

  const scrollEnd = useCallback((force = true) => {
    requestAnimationFrame(() => {
      const c = convo.current;
      if (!c) return;
      if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 140) c.scrollTop = 1e9;
    });
  }, []);

  const say = useCallback(
    (k: "you" | "ember" | "sys", t: string, meta = "") => {
      setItems((list) => {
        const item: Item =
          k === "ember" ? { id: id(), k, text: t, meta } : { id: id(), k, text: t };
        return [...list, item].slice(-120);
      });
      scrollEnd();
    },
    [scrollEnd],
  );

  const setHealth = useCallback((k: string, ok: boolean | undefined) => {
    setHealthState((h) => (h[k] === ok ? h : { ...h, [k]: ok }));
  }, []);

  const refreshOrb = useCallback(() => {
    const o = orb.current;
    if (!o) return;
    let s: OrbState = "idle";
    let label: string | null = null;
    const running = Object.values(r.current.tasks).find((t) => t.state === "running");
    if (voice.recording) s = "listening";
    else if (voice.playing) s = "speaking";
    else if (r.current.busy > 0) s = "thinking";
    else if (running) {
      s = "working";
      label = `WORKING · TASK ${running.id}`;
    } else if (r.current.health.bridge === false) {
      s = "error";
      label = "OFFLINE";
    }
    o.set(s);
    setOrbText(label ?? orbLabel(s));
  }, [voice]);

  useEffect(refreshOrb, [tasks, busy, health, refreshOrb]);

  // The task panel follows the newest task: one just added here (chat, queue, voice, a skill)
  // shows by itself, without clicking it in the queue.
  const selectRef = useRef<(taskId: number) => void>(() => {});
  const shown = useRef(new Set<number>());
  const upsertTask = useCallback((t: EmberTask) => {
    const isNew =
      !r.current.tasks[t.id] &&
      !shown.current.has(t.id) &&
      t.project === r.current.project &&
      ACTIVE.includes(t.state);
    setTasks((all) => (newer(t, all[t.id]) ? { ...all, [t.id]: t } : all));
    if (isNew) {
      shown.current.add(t.id);
      if (r.current.sel !== t.id) selectRef.current(t.id);
    }
    // A task in this project waiting for your OK asks for it in the conversation, by itself:
    // no digging through the queue to find out it is held.
    if (t.state === "awaiting_approval" && t.project === r.current.project) {
      setItems((list) =>
        list.some((i) => i.k === "approve" && i.taskId === t.id)
          ? list
          : [...list, { id: id(), k: "approve", taskId: t.id }],
      );
    }
  }, []);

  /* ---------- live replies ---------- */

  const liveBubble = useCallback(
    (t: EmberTask) => {
      if (t.project !== r.current.project) return;
      setItems((list) =>
        list.some((i) => i.k === "live" && i.taskId === t.id)
          ? list
          : [
              ...list,
              {
                id: id(),
                k: "live",
                taskId: t.id,
                engine: t.engine,
                steps: [],
                text: "",
                running: t.state === "running",
              },
            ],
      );
      scrollEnd();
    },
    [scrollEnd],
  );

  const liveLog = useCallback(
    (e: LogEntry) => {
      const t = r.current.tasks[e.task_id];
      if (!t?.conversation || t.project !== r.current.project) return;
      setItems((list) => {
        const has = list.some((i) => i.k === "live" && i.taskId === t.id);
        const base: Item[] = has
          ? list
          : [
              ...list,
              {
                id: id(),
                k: "live",
                taskId: t.id,
                engine: t.engine,
                steps: [],
                text: "",
                running: true,
              },
            ];
        return base.map((i) => {
          if (i.k !== "live" || i.taskId !== t.id) return i;
          if (e.kind === "text") return { ...i, running: true, text: e.text };
          if (e.kind === "tool" || e.kind === "error")
            return {
              ...i,
              running: true,
              steps: [...i.steps, { t: e.text, err: e.kind === "error" }].slice(-6),
            };
          return { ...i, running: true };
        });
      });
      scrollEnd(false);
    },
    [scrollEnd],
  );

  const finishLive = useCallback((taskId: number) => {
    setItems((list) => list.filter((i) => !(i.k === "live" && i.taskId === taskId)));
  }, []);

  /* ---------- voice out ---------- */

  const voiceProblem = useCallback(
    (why: string) => {
      // Once a minute at most, so a dead voice doesn't flood the chat.
      if (Date.now() - voiceWarned.current < 60000) return;
      voiceWarned.current = Date.now();
      say("sys", `Couldn't speak that reply: ${why}.`);
    },
    [say],
  );

  const stopSpeaking = useCallback(() => {
    speakGen.current++;
    voice.stopPlayback();
    try {
      speechSynthesis.cancel();
    } catch {
      /* no browser voice */
    }
  }, [voice]);

  const speakBrowser = (t: string) =>
    new Promise<void>((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(t);
        const vs = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
        u.voice =
          vs.find(
            (v) => /natural|online/i.test(v.name) && /ava|aria|jenny|emma|female/i.test(v.name),
          ) ??
          vs.find((v) => /natural|online/i.test(v.name)) ??
          vs.find((v) => /zira|female|samantha/i.test(v.name)) ??
          vs[0] ??
          null;
        u.rate = 1.15;
        u.onend = u.onerror = () => resolve();
        speechSynthesis.speak(u);
      } catch {
        resolve();
      }
    });

  /** Speaks a reply a sentence at a time (the next is made while this one plays). */
  const speak = useCallback(
    async (t?: string | null) => {
      if (!(r.current.speakOn || r.current.voiceChat) || !t) return true;
      if (r.current.handsfree && voice.recording) {
        voice.abort();
        setMicLive(false);
        awaitReply.current = true;
      }
      const gen = ++speakGen.current;
      let parts = [t];
      try {
        parts = (await ember<{ sentences?: string[] }>("voice/sentences", { body: { text: t } }))
          .sentences ?? [t];
      } catch {
        /* one piece */
      }
      const make = (s: string) =>
        emberFetch("voice/tts", { body: { text: s, voice: r.current.voiceId || undefined } })
          .then(async (res) => {
            setHealth("piper", res.ok);
            if (!res.ok)
              voiceProblem(
                ((await res.json().catch(() => ({}))) as { error?: string; message?: string })
                  .error ?? `the voice server answered ${res.status}`,
              );
            return res.ok && res.status !== 204 ? res.blob() : null;
          })
          .catch((e: Error) => {
            voiceProblem(e.message);
            return null;
          });
      const AHEAD = 3;
      const made: (Promise<Blob | null> | undefined)[] = [];
      const fill = (from: number) => {
        for (let j = from; j < Math.min(parts.length, from + AHEAD); j++)
          made[j] ??= make(parts[j] ?? "");
      };
      for (let i = 0; i < parts.length; i++) {
        fill(i);
        const blob = await made[i];
        if (gen !== speakGen.current || !(r.current.speakOn || r.current.voiceChat)) break;
        fill(i + 1);
        if (!blob) {
          orb.current?.set("speaking");
          await speakBrowser(parts[i] ?? "");
          if (gen !== speakGen.current) break;
          continue;
        }
        const p = voice.play(blob, (l) => {
          if (orb.current) orb.current.level = l;
        });
        refreshOrb();
        try {
          await Promise.race([
            p,
            new Promise((_, no) => setTimeout(() => no(new Error("playback didn't start")), 60000)),
          ]);
        } catch (e) {
          voiceProblem(
            voice.state === "suspended"
              ? "the browser is holding sound until you click or press a key on this page"
              : (e as Error).message,
          );
        }
        if (gen !== speakGen.current) break;
      }
      refreshOrb();
      return gen === speakGen.current;
    },
    [voice, refreshOrb, setHealth, voiceProblem],
  );

  /* ---------- sending ---------- */

  const select = useCallback(async (taskId: number) => {
    setSel(taskId);
    setLog([]);
    logAfter.current = 0;
    try {
      const d = await ember<{ task: EmberTask; log: LogEntry[] }>(`tasks/${taskId}`);
      setTasks((all) => (newer(d.task, all[taskId]) ? { ...all, [taskId]: d.task } : all));
      setLog(d.log);
      logAfter.current = d.log.at(-1)?.id ?? 0;
    } catch {
      /* gone */
    }
  }, []);

  useLayoutEffect(() => {
    selectRef.current = (taskId) => void select(taskId);
  }, [select]);

  const takeAtts = useCallback((where: "msg" | "task") => {
    let paths: string[] = [];
    setAtts((a) => {
      paths = a[where].map((x) => x.path).filter((p): p is string => Boolean(p));
      return { ...a, [where]: [] };
    });
    return paths;
  }, []);

  const listenRef = useRef<() => void>(() => undefined);
  const listenAfterReply = useCallback(() => {
    awaitReply.current = false;
    if (!r.current.handsfree) return;
    setTimeout(() => {
      if (r.current.handsfree && !voice.recording && !voice.playing) listenRef.current();
    }, 500);
  }, [voice]);

  // The mic button: dictation. Words appear in the message box as you speak; you send it.
  const dictation = useMemo(() => new Dictation(), []);
  const [dictating, setDictating] = useState(false);
  // Dictating with Hearth's own speech to text (no browser recognition): your words arrive when
  // you stop, so Send while it listens means "stop, then send it all".
  const filling = useRef(false);
  const sendAfterFill = useRef(false);

  const send = useCallback(
    async (raw: string, source: "typed" | "voice" = "typed") => {
      // Sending turns the dictation mic off (10-26); voice chat keeps listening.
      if (source === "typed") {
        if (dictation.on) dictation.abort();
        if (filling.current && voice.recording) {
          sendAfterFill.current = true;
          voice.stop();
          return;
        }
      }
      let t = raw.trim();
      if (r.current.lair) {
        if (!t) return;
        if (atts.msg.length) {
          say("sys", "Attachments go with War Room projects. In the Lair tab, attach in the Lair.");
          return;
        }
        setText("");
        setLairPending(t);
        const live = lairLive.current;
        lairAwait.current = { source, count: live.count };
        try {
          await api("POST", "/api/agent/conversations", {
            text: t,
            ...(live.id ? { conversationId: live.id } : {}),
            ...(r.current.lair !== "main" ? { projectId: r.current.lair } : {}),
            ...(source === "voice" ? { spoken: true } : {}),
            wait: 3,
          });
        } catch (e) {
          lairAwait.current = null;
          setLairPending(null);
          say("sys", "Error: " + (e as Error).message);
        }
        await live.qc.invalidateQueries({ queryKey: ["conversations"] });
        return;
      }
      if (!t && atts.msg.length) t = "Look at the attached file(s) and tell me what you see.";
      if (!t) return;
      if (atts.msg.some((a) => !a.path)) {
        say("sys", "Wait for the attachment to finish uploading.");
        return;
      }
      const attachments = atts.msg.map((a) => a.path).filter((p): p is string => Boolean(p));
      setAtts((a) => ({ ...a, msg: [] }));
      say("you", t);
      setText("");
      setBusy((b) => b + 1);
      let res: RequestReply | null = null;
      try {
        const got = await ember<RequestReply>("request", {
          body: {
            text: t,
            source,
            agent,
            project: r.current.project,
            engine: r.current.engine,
            model,
            require_approval: approveFirst,
            attachments,
          },
        });
        res = got;
        if (got.reply) {
          if (got.task?.conversation) say("sys", got.reply);
          else say("ember", got.reply, `${got.route ?? ""} · ${got.reason ?? ""}`);
        }
        if (got.task) {
          upsertTask(got.task);
          if (got.task.conversation) liveBubble(got.task);
          else void select(got.task.id);
        }
      } catch (e) {
        say("sys", "Error: " + (e as Error).message);
        orb.current?.set("error");
        setTimeout(refreshOrb, 2500);
      } finally {
        setBusy((b) => b - 1);
      }
      const replyLater = Boolean(res && (res.task?.conversation || res.route === "remote"));
      if (res) await speak(res.speak);
      if (r.current.handsfree && source === "voice") {
        if (replyLater) awaitReply.current = true;
        else listenAfterReply();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      dictation,
      voice,
      atts,
      agent,
      model,
      approveFirst,
      say,
      upsertTask,
      liveBubble,
      speak,
      refreshOrb,
      listenAfterReply,
    ],
  );

  // The Lair tab: when the answer to what you sent arrives, it is spoken like any War Room reply,
  // and in voice chat the mic opens again after it.
  useEffect(() => {
    const w = lairAwait.current;
    if (!w || lairWorking) return;
    const last = lairMessages.at(-1);
    if (lairMessages.length <= w.count + 1 || last?.role !== "agent") return;
    lairAwait.current = null;
    setLairPending(null);
    void speak(last.text).then(() => {
      if (w.source === "voice" && r.current.handsfree) listenAfterReply();
    });
  }, [lairMessages, lairWorking, speak, listenAfterReply]);

  /* ---------- voice in ---------- */

  // Whether this Hearth has a speech machine (Settings, Ember, Voice); asked once per PC.
  const serverStt = useRef(false);
  const [serverVoice, setServerVoice] = useState(false);
  const hearing = useRef<(() => void) | null>(null);
  useEffect(() => {
    void ember<{ stt?: boolean }>("voice")
      .then((v) => {
        serverStt.current = Boolean(v.stt);
        setServerVoice(Boolean(v.stt));
        if (v.stt) {
          setHealth("whisper", true);
          setHealth("piper", true);
        }
      })
      .catch(() => undefined);
  }, [setHealth]);

  // "send": talking to EMBER (hands-free), what you said is sent. "fill": dictation without the
  // browser's own recognition, what you said goes into the message box for you to send.
  const listen = useCallback(
    async (mode: "send" | "fill" = "send") => {
      if (voice.recording) return voice.stop();
      if (hearing.current) return hearing.current();
      stopSpeaking();
      // No speech machine set up: the browser's own recognition hears you instead.
      if (mode === "send" && r.current.view !== "term" && !serverStt.current && canDictate()) {
        const h = hearOnce();
        hearing.current = h.stop;
        setMicLive(true);
        orb.current?.set("listening");
        const got = await h.done;
        hearing.current = null;
        setMicLive(false);
        refreshOrb();
        if (got.problem) return say("sys", got.problem);
        if (got.unsupported) {
          serverStt.current = true;
          return void listenRef.current();
        }
        if (got.text) {
          hfQuiet.current = 0;
          return void send(got.text, "voice");
        }
        if (r.current.handsfree && ++hfQuiet.current < 4) return void listenRef.current();
        if (r.current.handsfree) {
          setHandsfree(false);
          say(
            "sys",
            "Listening paused: I didn't hear anything for a while. Tap the ear to talk again.",
          );
        } else say("sys", "Didn't hear anything.");
        return;
      }
      try {
        filling.current = mode === "fill";
        await voice.start(
          async (pcm) => {
            setMicLive(false);
            refreshOrb();
            const andSend = sendAfterFill.current && mode === "fill";
            sendAfterFill.current = false;
            filling.current = false;
            // Send was pressed while dictating: what is in the box, plus what was just said.
            const sendBox = (heard?: string) => {
              const box = textBox.current?.value ?? "";
              void send(heard ? joinDictation(box, heard) : box);
            };
            if (!pcm.length && andSend) return sendBox();
            if (!pcm.length) {
              // Hands-free: a quiet moment means listen again; it turns off after about 30 s of silence.
              if (r.current.handsfree && ++hfQuiet.current < 4) {
                void listenRef.current();
                return;
              }
              if (r.current.handsfree) {
                setHandsfree(false);
                say(
                  "sys",
                  "Listening paused: I didn't hear anything for a while. Tap the ear to talk again.",
                );
              } else say("sys", "Didn't hear anything.");
              return;
            }
            hfQuiet.current = 0;
            orb.current?.set("thinking");
            setOrbText("TRANSCRIBING");
            try {
              const res = await ember<{ text?: string }>("voice/stt", {
                body: new Blob([pcm.buffer as ArrayBuffer]),
                headers: { "Content-Type": "application/octet-stream" },
              });
              setHealth("whisper", true);
              if (res.text && r.current.view === "term") termRef.current?.type(res.text);
              else if (andSend) sendBox(res.text);
              else if (res.text && mode === "fill") {
                setText((t) => joinDictation(t, res.text!));
                refreshOrb();
                textBox.current?.focus();
              } else if (res.text) void send(res.text, "voice");
              else {
                say("sys", "Couldn't make that out.");
                refreshOrb();
              }
            } catch (e) {
              setHealth("whisper", false);
              say("sys", "Speech to text failed: " + (e as Error).message);
              refreshOrb();
            }
          },
          (l) => {
            if (orb.current) orb.current.level = l;
          },
        );
        setMicLive(true);
        refreshOrb();
      } catch (e) {
        filling.current = false;
        say("sys", "Microphone unavailable: " + (e as Error).message);
      }
    },
    [voice, stopSpeaking, refreshOrb, say, setHealth, send],
  );
  useLayoutEffect(() => {
    listenRef.current = () => void listen();
  }, [listen]);

  // The built-in voice's memory: shown while its helper is loaded, with a button to free it now
  // (it frees itself after 10 idle minutes too; 10-26).
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  useEffect(() => {
    let on = true;
    const look = () =>
      ember<{ loaded?: boolean }>("voice/memory")
        .then((m) => on && setVoiceLoaded(Boolean(m.loaded)))
        .catch(() => undefined);
    void look();
    const t = window.setInterval(() => void look(), 15_000);
    return () => {
      on = false;
      window.clearInterval(t);
    };
  }, []);
  const freeVoice = useCallback(() => {
    stopSpeaking();
    void ember<{ loaded?: boolean }>("voice/memory/release", { body: {} })
      .then((m) => {
        setVoiceLoaded(Boolean(m.loaded));
        say("sys", "Voice memory freed. The voice starts again the next time you use it.");
      })
      .catch((e: unknown) => say("sys", "Couldn't free voice memory: " + (e as Error).message));
  }, [stopSpeaking, say]);

  /** Voice chat on or off: on, it listens and speaks every reply; off, both stop. */
  const setVoiceChatOn = useCallback(
    (on: boolean) => {
      hfQuiet.current = 0;
      awaitReply.current = false;
      setVoiceChat(on);
      r.current.voiceChat = on;
      setHandsfree(on);
      r.current.handsfree = on;
      if (on) {
        if (!voice.recording) void listen();
      } else {
        voice.abort();
        setMicLive(false);
        stopSpeaking();
        refreshOrb();
      }
    },
    [voice, listen, stopSpeaking, refreshOrb],
  );
  /** The ear: whether it is listening, without leaving voice chat (replies are still spoken). */
  const setHearing = useCallback(
    (on: boolean) => {
      hfQuiet.current = 0;
      setHandsfree(on);
      r.current.handsfree = on;
      if (on) {
        if (!voice.recording && !voice.playing) void listen();
      } else {
        awaitReply.current = false;
        voice.abort();
        hearing.current?.();
        setMicLive(false);
        refreshOrb();
      }
    },
    [voice, listen, refreshOrb],
  );
  // From the Lair's voice chat button (/war-room?voice=1): voice chat starts here.
  const voiceAsked = useRef(false);
  useEffect(() => {
    if (voiceAsked.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("voice") !== "1") return;
    voiceAsked.current = true;
    params.delete("voice");
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
    );
    // After this render (and only once, so no cleanup cancels it on a remount).
    window.setTimeout(() => setVoiceChatOn(true), 0);
  }, [setVoiceChatOn]);

  const dictate = useCallback(() => {
    if (r.current.view === "term") return void listen("send");
    if (dictation.on) return dictation.stop();
    if (voice.recording) return voice.stop();
    stopSpeaking();
    setDictating(true);
    dictation.start(
      textBox.current?.value ?? "",
      (t) => {
        setText(t);
        const box = textBox.current;
        if (box) {
          box.style.height = "auto";
          box.style.height = `${Math.min(box.scrollHeight + 2, 160)}px`;
        }
      },
      (problem, unsupported) => {
        setDictating(false);
        if (unsupported) void listen("fill");
        else if (problem) say("sys", problem);
        textBox.current?.focus();
      },
    );
  }, [dictation, listen, voice, stopSpeaking, say]);

  /* ---------- tasks ---------- */

  const act = useCallback(
    async (taskId: number, a: string) => {
      try {
        upsertTask(await ember<EmberTask>(`tasks/${taskId}/${a}`, { body: {} }));
      } catch (e) {
        say("sys", (e as Error).message);
      }
    },
    [upsertTask, say],
  );

  /* ---------- projects ---------- */

  const loadFiles = useCallback(async (slug: string) => {
    try {
      const f = await ember<ProjectFile[]>(`projects/${encodeURIComponent(slug)}/files`);
      if (slug !== r.current.project) return;
      setFiles(f);
      if (f.some((x) => x.kind === "image")) {
        const key = await ember<{ base: string }>(`projects/${encodeURIComponent(slug)}/preview`, {
          body: {},
        });
        if (slug === r.current.project) setFilesPreview(previewBase(key.base));
      }
    } catch {
      /* kept as is */
    }
  }, []);

  const loadConversation = useCallback(
    async (slug: string, conf: EmberConfig | null, all: Record<number, EmberTask>) => {
      const msgs = await ember<EmberMessage[]>(
        `projects/${encodeURIComponent(slug)}/messages?limit=150`,
      ).catch(() => [] as EmberMessage[]);
      if (slug !== r.current.project) return;
      const p = conf?.projects[slug];
      const list: Item[] = [
        { id: id(), k: "intro", name: p?.name ?? slug, desc: p?.description ?? "" },
      ];
      for (const m of msgs) {
        if (m.role === "ask") list.push({ id: id(), k: "ask", m });
        else if (m.role === "ember")
          list.push({ id: id(), k: "ember", text: m.text, meta: m.meta ?? "" });
        else if (m.role === "you") list.push({ id: id(), k: "you", text: m.text });
        else list.push({ id: id(), k: "sys", text: m.text });
      }
      for (const t of Object.values(all))
        if (t.conversation && t.project === slug && ACTIVE.includes(t.state))
          list.push({
            id: id(),
            k: "live",
            taskId: t.id,
            engine: t.engine,
            steps: [],
            text: "",
            running: t.state === "running",
          });
      setItems(list);
      scrollEnd();
    },
    [scrollEnd],
  );

  const switchProject = useCallback(
    (slug: string, conf: EmberConfig | null = r.current.cfg, keepLair = false) => {
      if (!conf?.projects[slug]) return;
      if (!keepLair) setLair(null);
      r.current.project = slug;
      setProject(slug);
      setOpenTabs((tabs) => {
        const next = tabs.includes(slug) ? tabs : [...tabs, slug];
        store.set(tabKey(pc, "tabs"), JSON.stringify(next));
        return next;
      });
      store.set(tabKey(pc, "project"), slug);
      setSel(null);
      setLog([]);
      setFiles(null);
      setFilesPreview(null);
      void loadFiles(slug);
      void loadConversation(slug, conf, r.current.tasks);
    },
    [loadFiles, loadConversation, pc, setLair],
  );

  /** A project deleted here (by you, or from another device): its tab and conversation go. */
  const forgetProject = (slug: string) => {
    setOpenTabs((tabs) => {
      const left = tabs.filter((k) => k !== slug);
      const next = left.length ? left : ["sandbox"];
      store.set(tabKey(pc, "tabs"), JSON.stringify(next));
      return next;
    });
    const c = r.current.cfg;
    if (c?.projects[slug]) {
      const rest = { ...c.projects };
      delete rest[slug];
      const next = { ...c, projects: rest };
      r.current.cfg = next;
      setCfg(next);
    }
    if (r.current.project === slug) switchProject("sandbox");
  };

  const closeTab = (slug: string) => {
    setOpenTabs((tabs) => {
      const next = tabs.filter((k) => k !== slug);
      store.set(tabKey(pc, "tabs"), JSON.stringify(next));
      if (slug === project && next[0]) switchProject(next[0]);
      return next;
    });
  };

  /* ---------- boot and the live connection ---------- */

  const resync = useCallback(async () => {
    const st = await ember<EmberState>("state");
    setRemote(st.remote ?? []);
    setTasks(Object.fromEntries(st.tasks.map((t) => [t.id, t])));
    setQueue(st.queue);
    setSkills(st.skills);
    setCfg((c) => (c ? { ...c, projects: st.config.projects } : st.config));
  }, []);

  const loadTiles = useCallback(async () => {
    try {
      const t = await ember<Tile[]>("tiles");
      setTiles(t);
      for (const x of t) {
        if (x.type === "tcp" && /whisper/i.test(x.label)) setHealth("whisper", x.ok ?? undefined);
        if (x.type === "tcp" && /piper/i.test(x.label)) setHealth("piper", x.ok ?? undefined);
      }
    } catch {
      /* next time */
    }
  }, [setHealth]);

  type Ev = {
    type: string;
    version?: string;
    queue?: EmberQueue;
    status?: EmberQueue;
    usage?: EmberUsage;
    project?: string;
    projects?: (EmberConfig["projects"][string] & { slug: string })[];
    message?: EmberMessage;
    remote?: EmberRemote[];
    item?: GhItem;
    id?: number;
    answered?: string;
    task?: EmberTask;
    entry?: LogEntry;
    state?: string;
  };
  const onEvent = useRef<(ev: Ev) => void>(() => undefined);
  useLayoutEffect(() => {
    onEvent.current = (ev: Ev) => {
      const cur = r.current;
      switch (ev.type) {
        case "hello":
          if (ev.queue) setQueue(ev.queue);
          if (ev.usage) setUsage(ev.usage);
          void resync();
          break;
        case "usage":
          if (ev.usage) setUsage(ev.usage);
          break;
        case "files":
          if (ev.project === cur.project) void loadFiles(cur.project);
          break;
        case "projects":
          if (ev.projects)
            setCfg((c) =>
              c
                ? {
                    ...c,
                    projects: {
                      ...c.projects,
                      ...Object.fromEntries(ev.projects!.map((p) => [p.slug, p])),
                    },
                  }
                : c,
            );
          break;
        case "message": {
          const m = ev.message;
          if (!m || m.project !== cur.project) return;
          if (m.role === "ember" && m.task_id) {
            finishLive(m.task_id);
            say("ember", m.text, m.meta ?? "");
            void speak(m.text).then((done) => done && awaitReply.current && listenAfterReply());
          } else if (m.role === "ember") {
            say("ember", m.text, m.meta ?? "");
            if (!/Remote Control$/.test(m.meta ?? ""))
              void speak(m.text).then((done) => done && awaitReply.current && listenAfterReply());
          } else if (m.role === "you" && m.meta === "Claude app") say("you", "📱 " + m.text);
          else if (m.role === "ask") {
            setItems((l) => [...l, { id: id(), k: "ask", m }]);
            scrollEnd();
          } else if (m.role === "sys") {
            say("sys", m.text);
            if (awaitReply.current && m.task_id) listenAfterReply();
          }
          break;
        }
        case "remote":
          if (ev.remote) setRemote(ev.remote);
          break;
        case "project_deleted":
          if (ev.project) forgetProject(ev.project);
          break;
        case "github":
          if (ev.item) gh.onFeed(ev.item);
          break;
        case "ask_answered":
          setItems((l) =>
            l.map((i) => (i.k === "ask" && i.m.id === ev.id ? { ...i, answered: ev.answered } : i)),
          );
          break;
        case "cleared":
          setTasks((all) =>
            Object.fromEntries(Object.entries(all).filter(([, t]) => ACTIVE.includes(t.state))),
          );
          break;
        case "task":
          if (ev.task) upsertTask(ev.task);
          break;
        case "log":
          if (ev.entry) {
            liveLog(ev.entry);
            if (ev.entry.task_id === cur.sel && ev.entry.id > logAfter.current) {
              logAfter.current = ev.entry.id;
              setLog((l) => [...l, ev.entry!]);
            }
          }
          break;
        case "queue":
          if (ev.status) setQueue(ev.status);
          window.setTimeout(() => void loadTiles(), 300);
          break;
        case "activity":
          if (ev.state === "thinking" && !voice.recording) orb.current?.set("thinking");
          else refreshOrb();
          break;
        case "task_done": {
          const t = ev.task;
          if (!t) return;
          upsertTask(t);
          if (t.project === cur.project) window.setTimeout(() => void loadFiles(cur.project), 800);
          const first = (t.result || t.error || "").split(/(?<=[.!?])\s/)[0]?.slice(0, 220) ?? "";
          if (t.conversation && t.state !== "succeeded") finishLive(t.id);
          if (t.project !== cur.project)
            say(
              "sys",
              `${cur.cfg?.projects[t.project]?.name ?? t.project}: ${t.conversation ? "the agent replied" : `task #${t.id} ${t.state}`}.`,
            );
          if (!t.conversation)
            void speak(`Task ${t.id} ${t.state === "succeeded" ? "finished" : t.state}. ${first}`);
          if (cur.sel === t.id) void select(t.id);
          break;
        }
      }
    };
  });

  // Boot: EMBER's state, your open tabs, then the live connection.
  useEffect(() => {
    let live = true;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let tilesTimer: number | undefined;
    const connect = () => {
      ws = new WebSocket(emberSocketUrl("ws"));
      ws.onopen = () => setHealth("bridge", true);
      ws.onclose = () => {
        setHealth("bridge", false);
        if (live) retry = window.setTimeout(connect, 2000);
      };
      ws.onmessage = (m: MessageEvent<string>) => {
        try {
          onEvent.current(JSON.parse(m.data) as Ev);
        } catch {
          /* a message we don't know */
        }
      };
    };
    (async () => {
      try {
        const st = await ember<EmberState>("state");
        if (!live) return;
        setCfg(st.config);
        setTasks(Object.fromEntries(st.tasks.map((t) => [t.id, t])));
        setQueue(st.queue);
        setSkills(st.skills);
        setRemote(st.remote ?? []);
        if (st.usage) setUsage(st.usage);
        const savedEngine = store.get("ember.engine");
        setEngine(savedEngine && st.config.engines[savedEngine] ? savedEngine : "claude-code");
        setAgent(
          ["claude", "quick", "auto"].includes(st.config.routing.default ?? "")
            ? st.config.routing.default!
            : "claude",
        );
        const choices = st.config.voice.choices ?? [];
        const saved = store.get("ember.voice3");
        setVoiceId(
          saved && choices.some((c) => c.id === saved) ? saved : (st.config.voice.tts_voice ?? ""),
        );
        const sp = store.get("ember.speak");
        setSpeakOn(sp === null ? st.config.voice.speak_replies !== false : sp === "1");
        setHealth("claude", st.config.engines["claude-code"]?.enabled);
        let tabs: string[] = [];
        try {
          tabs = (JSON.parse(store.get(tabKey(pc, "tabs")) ?? "[]") as string[]).filter(
            (k) => st.config.projects[k],
          );
        } catch {
          tabs = [];
        }
        const first = Object.keys(st.config.projects)[0] ?? "";
        // From Home's project cards (/war-room?project=slug): that project opens, in a tab.
        const params = new URLSearchParams(window.location.search);
        const asked = params.get("project");
        const askedNew = params.get("new") === "1";
        const askedLair = params.get("lair");
        if (askedLair) setLair(askedLair === "1" ? "main" : askedLair);
        else if (asked) setLair(null);
        if (asked || askedNew || askedLair || params.has("pc")) {
          params.delete("project");
          params.delete("new");
          params.delete("lair");
          params.delete("pc");
          const rest = params.toString();
          window.history.replaceState(
            window.history.state,
            "",
            window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
          );
        }
        const want = asked && st.config.projects[asked] ? asked : store.get(tabKey(pc, "project"));
        const slug = want && st.config.projects[want] ? want : first;
        if (asked && st.config.projects[asked] && !tabs.includes(asked)) tabs = [...tabs, asked];
        if (askedNew) setNewProj(true);
        if (!tabs.length) tabs = [slug];
        // The old Homelab project is archived: its tab goes (the Lair tab is the homelab zone).
        tabs = tabs.filter((k) => !st.config.projects[k]?.archived);
        setOpenTabs(tabs);
        r.current.tasks = Object.fromEntries(st.tasks.map((t) => [t.id, t]));
        r.current.cfg = st.config;
        switchProject(slug, st.config, true);
        const running = st.tasks.find((t) => t.state === "running");
        if (running) void select(running.id);
        connect();
        void loadTiles();
        tilesTimer = window.setInterval(() => void loadTiles(), 5000);
      } catch (e) {
        if (live) setBootError((e as Error).message);
      }
    })();
    return () => {
      live = false;
      window.clearTimeout(retry);
      window.clearInterval(tilesTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      voice.abort();
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The orb.
  useEffect(() => {
    if (!canvas.current) return;
    const o = new Orb(canvas.current);
    orb.current = o;
    refreshOrb();
    return () => o.destroy();
  }, [refreshOrb]);
  useEffect(
    () =>
      orb.current?.setLook(engine === "codex" ? "codex" : engine === "ollama" ? "ollama" : "ember"),
    [engine],
  );

  // The clock.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    tick();
    const i = window.setInterval(tick, 1000);
    return () => window.clearInterval(i);
  }, []);

  // Keyboard: Ctrl+Space dictates, Esc stops speech, the mic, and closes GitHub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        dictate();
      }
      if (e.key === "Escape") {
        stopSpeaking();
        if (voice.recording) voice.stop();
        if (dictation.on) dictation.stop();
        refreshOrb();
        if (gh.open && !newProj && !modal) gh.setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const unlock = () => voice.unlock();
    document.addEventListener("pointerdown", unlock, { capture: true, passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", unlock, { capture: true });
    };
  }, [dictate, dictation, stopSpeaking, voice, refreshOrb, gh, newProj, modal]);

  // The engine toggle's glider follows the chosen engine.
  useLayoutEffect(() => {
    const b = segs.current[engine];
    if (b) setGlider({ width: b.offsetWidth, x: b.offsetLeft - 4 });
  }, [engine, cfg]);

  // Docked panels (GitHub, Artifacts) sit exactly between the project bar and the command bar.
  useLayoutEffect(() => {
    const place = () => {
      const s = shell.current?.style;
      if (!s) return;
      if (top.current) s.setProperty("--header-h", `${top.current.offsetHeight}px`);
      if (ptabs.current)
        s.setProperty(
          "--gh-top",
          `${Math.round(ptabs.current.getBoundingClientRect().bottom + 8)}px`,
        );
      if (footer.current)
        s.setProperty(
          "--gh-bottom",
          `${Math.round(window.innerHeight - footer.current.getBoundingClientRect().top + 8)}px`,
        );
      if (ptabs.current) s.setProperty("--ptabs-h", `${ptabs.current.offsetHeight}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    [top.current, ptabs.current, footer.current].forEach((el) => el && ro.observe(el));
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [cfg]);

  /* ---------- attachments ---------- */

  const addFiles = useCallback(
    async (list: File[], where: "msg" | "task") => {
      for (const f of list) {
        if (f.size > 25 * 1024 * 1024) {
          say("sys", `${f.name} is over 25 MB.`);
          continue;
        }
        const a: Att = {
          key: id(),
          name: f.name || "pasted-image.png",
          path: null,
          preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
        };
        setAtts((x) => ({ ...x, [where]: [...x[where], a] }));
        try {
          const res = await ember<{ path: string; name: string }>(
            `attachments?project=${encodeURIComponent(r.current.project)}`,
            {
              body: f,
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Filename": encodeURIComponent(a.name),
              },
            },
          );
          setAtts((x) => ({
            ...x,
            [where]: x[where].map((y) =>
              y.key === a.key ? { ...y, path: res.path, name: res.name } : y,
            ),
          }));
        } catch (e) {
          setAtts((x) => ({ ...x, [where]: x[where].filter((y) => y.key !== a.key) }));
          say("sys", `Upload failed for ${a.name}: ${(e as Error).message}`);
        }
      }
    },
    [say],
  );

  const addProjectFiles = useCallback(
    async (list: File[]) => {
      for (const f of list) {
        if (f.size > 25 * 1024 * 1024) {
          say("sys", `${f.name} is over 25 MB.`);
          continue;
        }
        try {
          await ember(`projects/${encodeURIComponent(r.current.project)}/upload`, {
            body: f,
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Filename": encodeURIComponent(f.name || "photo.png"),
            },
          });
        } catch (e) {
          say("sys", `Couldn't add ${f.name}: ${(e as Error).message}`);
        }
      }
      void loadFiles(r.current.project);
    },
    [say, loadFiles],
  );

  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (isFiles(e)) {
        depth++;
        setDropHint(true);
      }
    };
    const leave = () => {
      if (--depth <= 0) {
        depth = 0;
        setDropHint(false);
      }
    };
    const over = (e: DragEvent) => {
      if (isFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const fl = [...(e.dataTransfer?.files ?? [])];
      if (!fl.length) return;
      e.preventDefault();
      depth = 0;
      setDropHint(false);
      const target = e.target as HTMLElement | null;
      if (target?.closest(".files-panel")) void addProjectFiles(fl);
      else void addFiles(fl, addOpen && target?.closest(".queue-panel") ? "task" : "msg");
    };
    const paste = (e: ClipboardEvent) => {
      const fl = [...(e.clipboardData?.files ?? [])];
      if (!fl.length) return;
      e.preventDefault();
      void addFiles(
        fl,
        (document.activeElement as HTMLElement | null)?.id === "task-text" ? "task" : "msg",
      );
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
      document.removeEventListener("paste", paste);
    };
  }, [addFiles, addProjectFiles, addOpen]);

  /* ---------- screenshot ---------- */

  const capture = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      say("sys", "This browser can't capture the screen. Use Chrome or Edge on a desktop.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser", frameRate: 5 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        monitorTypeSurfaces: "exclude",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      const n = (e as Error).name;
      if (n !== "NotAllowedError" && n !== "AbortError")
        say("sys", "Screen capture failed: " + (e as Error).message);
      return;
    }
    setShot(null);
    try {
      const video = Object.assign(document.createElement("video"), {
        muted: true,
        playsInline: true,
        srcObject: stream,
      });
      await video.play();
      await new Promise((res) => setTimeout(res, 400)); // let the share prompt leave the frame
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      if (blob)
        setShot({
          blob,
          url: URL.createObjectURL(blob),
          msg: `${Math.round(blob.size / 1024)} KB PNG`,
        });
    } finally {
      stream.getTracks().forEach((tr) => tr.stop());
    }
  };
  const shotName = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `war-room-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
  };

  /* ---------- engine ---------- */

  const chooseEngine = (name: string) => {
    const e = cfg?.engines[name];
    if (!e) return;
    setEngine(name);
    store.set("ember.engine", name);
    setModel("");
    if (!e.enabled) {
      setEngineNote(
        `${e.label} can't run tasks yet. ${e.note ?? ""} You're seeing its theme and usage.`,
      );
      // Ollama's note carries its setup link, so it stays until another tab is chosen.
      if (name !== "ollama") window.setTimeout(() => setEngineNote(null), 6000);
    } else setEngineNote(null);
    say(
      "sys",
      e.enabled
        ? `Tasks will run with ${e.label}.`
        : `${e.label} view. ${e.label} can't run tasks until it's enabled.`,
    );
  };

  const setView = (v: "chat" | "term") => {
    setViewState(v);
    store.set("ember.view2", v);
  };

  /* ---------- Hearth's panels ---------- */

  const openPanel = (o: OpenRequest) => {
    const el = shell.current?.querySelector("[data-testid=talk-canvas]");
    const size = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1200, h: 800 };
    const k = windowKey(o);
    const isOpen = layout.windows.some((w) => windowKey(w) === k && !w.minimized);
    if (isOpen)
      update((l) => ({ ...l, windows: l.windows.filter((w) => windowKey(w) !== k) }), {
        now: true,
      });
    else update((l) => openIn(l, o, size, desk), { now: true });
  };

  /* ---------- render ---------- */

  const e = cfg?.engines[engine];
  const projTasks = Object.values(tasks).filter((t) => t.project === project);
  const activeCount = (slug: string) =>
    Object.values(tasks).filter((t) => t.project === slug && ACTIVE.includes(t.state)).length;
  const usageFor = (usage?.engines ?? []).filter((u) => u.engine === engine);
  const worst = (usage?.engines ?? [])
    .flatMap((u) => (u.status === "live" ? u.windows : []))
    .map((w) => w.level);
  const rc = remote.find((x) => x.project === project);
  const qCounts = queue?.counts ?? {};
  const qBusy = (qCounts.running ?? 0) + (qCounts.queued ?? 0) + (qCounts.awaiting_approval ?? 0);
  const capHit = Boolean(queue?.paused && /daily cap/.test(queue.pause_reason ?? ""));
  const nearCap = Boolean(queue && !queue.paused && queue.tasks_today >= queue.daily_cap);
  const choices = cfg?.voice.choices ?? [];
  const groups = [...new Set(choices.map((c) => c.group || "Voices"))];
  const pill = (k: string, label: string, title: string) => {
    const ok = health[k];
    return (
      <span
        className={`pill ${ok === true ? "ok" : ok === false ? "bad" : ""}`}
        title={`${title}: ${ok === true ? "online" : ok === false ? "offline" : "unknown"}`}
      >
        <i />
        <b>{label}</b>
      </span>
    );
  };
  const selTask = sel != null ? tasks[sel] : undefined;
  const queueAct = async (what: string) => {
    try {
      setQueue(await ember<EmberQueue>(`queue/${what}`, { body: {} }));
    } catch (err) {
      say("sys", (err as Error).message);
    }
  };
  const answerAsk = async (item: Extract<Item, { k: "ask" }>, key: string, label: string) => {
    try {
      const res = await ember<{ note?: string; task?: EmberTask }>(`asks/${item.m.id}/${key}`, {
        body: {},
      });
      setItems((l) =>
        l.map((i) =>
          i.id === item.id && i.k === "ask" ? { ...i, answered: res.note ?? label } : i,
        ),
      );
      if (res.task) {
        upsertTask(res.task);
        if (res.task.conversation) liveBubble(res.task);
      }
    } catch (err) {
      say("sys", (err as Error).message);
    }
  };
  const runSkill = async (s: EmberSkill) => {
    let input = "";
    if (s.input) {
      const v = window.prompt(s.input);
      if (v === null) return;
      input = v;
    }
    say("you", `▸ ${s.name}${input ? ": " + input : ""}`);
    setBusy((b) => b + 1);
    try {
      const res = await ember<{ reply: string; route: string; speak?: string; task?: EmberTask }>(
        `skills/${s.id}/run`,
        {
          body: { input, project, engine },
        },
      );
      say("ember", res.reply, `skill · ${res.route}`);
      if (res.task) {
        upsertTask(res.task);
        void select(res.task.id);
      }
      void speak(res.speak);
    } catch (err) {
      say("sys", (err as Error).message);
    } finally {
      setBusy((b) => b - 1);
    }
  };
  const addTask = async (ev: FormEvent) => {
    ev.preventDefault();
    const t = taskText.trim();
    if (!t) return;
    if (atts.task.some((a) => !a.path)) {
      say("sys", "Wait for the attachment to finish uploading.");
      return;
    }
    try {
      const task = await ember<EmberTask>("tasks", {
        body: {
          prompt: t,
          project,
          engine,
          model: model || undefined,
          require_approval: approveFirst,
          attachments: takeAtts("task"),
          source: "queue-panel",
        },
      });
      upsertTask(task);
      void select(task.id);
      setTaskText("");
      setAddOpen(false);
      say(
        "sys",
        `Task #${task.id} added${task.state === "awaiting_approval" ? ", waiting for your approval" : ""}.`,
      );
    } catch (err) {
      say("sys", "Couldn't add the task: " + (err as Error).message);
    }
  };
  const chips = (where: "msg" | "task") =>
    atts[where].map((a) => (
      <span key={a.key} className="chip-att">
        {a.preview ? <img src={a.preview} alt="" /> : <span className="ic">📄</span>}
        <span title={a.name}>{a.name}</span>
        {!a.path && <span className="busy">uploading…</span>}
        <button
          type="button"
          aria-label={`Remove ${a.name}`}
          onClick={() =>
            setAtts((x) => ({ ...x, [where]: x[where].filter((y) => y.key !== a.key) }))
          }
        >
          ✕
        </button>
      </span>
    ));

  if (bootError)
    return (
      <div className="ember-shell" ref={shell}>
        <div className="er">
          <div className="overlay">
            <div className="login-card">
              <div className="brand big">EMBER</div>
              <p>The War Room couldn&apos;t reach EMBER: {bootError}</p>
              <button type="button" className="btn primary" onClick={() => location.reload()}>
                Try again
              </button>{" "}
              <button type="button" className="btn" onClick={() => navigate("/")}>
                Back to Hearth
              </button>
            </div>
          </div>
        </div>
      </div>
    );

  const center: ReactNode = (
    <>
      <div className="er er-fill">
        <main className="grid">
          <nav className="mtabs" role="tablist" aria-label="Sections">
            {(["chat", "queue", "usage", "systems"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={mtab === t}
                onClick={() => {
                  setMtab(t);
                  store.set("ember.tab", t);
                }}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
                {t === "queue" && <span className="badge-n">{qBusy ? String(qBusy) : ""}</span>}
                {t === "usage" && (
                  <span
                    className={`badge-dot ${worst.includes("critical") ? "critical" : worst.includes("low") ? "low" : ""}`}
                  />
                )}
              </button>
            ))}
          </nav>

          <section className="col left">
            <div className="panel usage-panel" data-m="usage">
              <h2 title="Numbers come only from what the engine reports">
                <span>{engineLabel(engine)} usage</span>
              </h2>
              <div className="usage" aria-live="polite">
                <UsagePanel
                  engines={usageFor}
                  onRefresh={async (eng) => {
                    // No "are you sure?" popup: the button already says it makes one tiny call,
                    // and a browser that blocks popups made the click silently do nothing.
                    try {
                      setUsage(await ember<EmberUsage>("usage/refresh", { body: { engine: eng } }));
                    } catch (err) {
                      say("sys", "Usage check failed: " + (err as Error).message);
                    }
                  }}
                />
              </div>
            </div>
            <div className="panel" data-m="systems">
              <h2>Systems</h2>
              <div className="tiles">
                <Tiles tiles={tiles} />
              </div>
            </div>
            <div className="panel grow skills-panel" data-m="systems">
              <h2>
                Skills <span className="hint">from vault/Skills</span>
              </h2>
              <div className="skills">
                <Skills skills={skills} onRun={(s) => void runSkill(s)} />
              </div>
            </div>
          </section>

          <section className="col center">
            <div className="sphere-wrap">
              <canvas id="sphere" ref={canvas} aria-label="EMBER activity orb" role="img" />
              <div className="sphere-state" aria-live="polite" data-testid="ember-orb-state">
                {orbText}
              </div>
            </div>
            <div
              className="convo"
              ref={convo}
              data-m="chat"
              aria-live="polite"
              data-testid="ember-convo"
            >
              {(lair ? lairItems : items).map((i) => (
                <Msg
                  key={i.id}
                  item={i}
                  engineLabel={(x) => (x === "lair" ? "EMBER · THE LAIR" : engineLabel(x))}
                  onStop={(taskId) => taskId > 0 && void act(taskId, "cancel")}
                  onAnswer={(it, key, label) => void answerAsk(it, key, label)}
                  taskOf={(taskId) => tasks[taskId]}
                  onAct={(taskId, a) => void act(taskId, a)}
                />
              ))}
              {/* Held tasks the conversation has no card for yet (after a reload, say). */}
              {!lair &&
                Object.values(tasks)
                  .filter(
                    (t) =>
                      t.state === "awaiting_approval" &&
                      t.project === project &&
                      !items.some((i) => i.k === "approve" && i.taskId === t.id),
                  )
                  .map((t) => (
                    <Msg
                      key={`held-${t.id}`}
                      item={{ id: -t.id, k: "approve", taskId: t.id }}
                      engineLabel={engineLabel}
                      onStop={(taskId) => void act(taskId, "cancel")}
                      onAnswer={(it, key, label) => void answerAsk(it, key, label)}
                      taskOf={(taskId) => tasks[taskId]}
                      onAct={(taskId, a) => void act(taskId, a)}
                    />
                  ))}
              <JumpToLatest target={convo} />
            </div>
            {cfg?.capabilities?.terminal === false ? (
              <div className="term-wrap" data-m="chat" data-testid="ember-terminal">
                <div className="term-head">
                  <span>{e?.label ?? "Claude Code"}</span>
                  <span className="hint">{P?.path ?? ""}</span>
                </div>
                <div className="term-ended">
                  <p>
                    The live terminal arrives in the engine&apos;s next stage. Use Chat for now.
                  </p>
                </div>
              </div>
            ) : (
              <EmberTerminal
                ref={termRef}
                project={project}
                engine={engine}
                engineLabel={e?.label ?? "Claude Code"}
                where={P?.path ?? ""}
                active={view === "term" && Boolean(project)}
              />
            )}
          </section>

          <section className="col right">
            <div
              className="panel files-panel"
              data-m="queue"
              onDragOver={(ev) => {
                ev.preventDefault();
                ev.currentTarget.classList.add("drag");
              }}
              onDragLeave={(ev) => ev.currentTarget.classList.remove("drag")}
              onDrop={(ev) => ev.currentTarget.classList.remove("drag")}
            >
              <h2>
                Project files{" "}
                <button
                  type="button"
                  className="btn small"
                  onClick={() => pfileInput.current?.click()}
                >
                  + Add files
                </button>
              </h2>
              <div className="pfiles">
                <FilesList
                  files={files}
                  previewBase={filesPreview}
                  onOpen={(f) => {
                    gh.setOpen(false);
                    setArt({ open: true, start: f });
                  }}
                  onMore={() => {
                    gh.setOpen(false);
                    setArt({ open: true, start: null });
                  }}
                />
              </div>
              <input
                type="file"
                ref={pfileInput}
                multiple
                hidden
                onChange={(ev) => {
                  void addProjectFiles([...(ev.target.files ?? [])]);
                  ev.target.value = "";
                }}
              />
            </div>
            <div className="panel grow queue-panel" data-m="queue">
              <h2>
                Task queue <span className="hint">{queueSummary(queue)}</span>
              </h2>
              <div className="q-tools">
                <button
                  type="button"
                  className="btn primary"
                  id="btn-add-task"
                  aria-expanded={addOpen}
                  onClick={() => setAddOpen((o) => !o)}
                >
                  + Add task
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Remove finished tasks from this list (their reports stay in the vault)"
                  onClick={async () => {
                    const res = await ember<EmberQueue & { cleared?: number }>("queue/clear", {
                      body: {},
                    });
                    setTasks((all) =>
                      Object.fromEntries(
                        Object.entries(all).filter(([, t]) => ACTIVE.includes(t.state)),
                      ),
                    );
                    setQueue(res);
                    say(
                      "sys",
                      res.cleared
                        ? `Cleared ${res.cleared} finished task${res.cleared === 1 ? "" : "s"} (reports stay in the vault).`
                        : "Nothing to clear.",
                    );
                  }}
                >
                  Clear finished
                </button>
              </div>
              {addOpen && (
                <form className="add-task" autoComplete="off" onSubmit={(ev) => void addTask(ev)}>
                  <label htmlFor="task-text" className="add-label">
                    What should <b>{engineLabel(engine)}</b> do?
                  </label>
                  <textarea
                    id="task-text"
                    rows={3}
                    value={taskText}
                    autoFocus
                    onChange={(ev) => setTaskText(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
                        ev.preventDefault();
                        ev.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Describe the task"
                  />
                  <div className="att-chips">{chips("task")}</div>
                  <div className="add-row">
                    <button
                      type="button"
                      className="btn icon"
                      title="Attach files or photos"
                      aria-label="Attach files or photos to the task"
                      onClick={() => {
                        attTarget.current = "task";
                        fileInput.current?.click();
                      }}
                    >
                      <Icon d={CLIP} />
                    </button>
                    <span className="hint">
                      {e?.enabled
                        ? `runs in ${project}`
                        : `${e?.label ?? "This engine"} isn't enabled`}
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => {
                        setAddOpen(false);
                        setAtts((x) => ({ ...x, task: [] }));
                      }}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn primary">
                      Add to queue
                    </button>
                  </div>
                  <p className="hint add-hint">
                    Ctrl+Enter adds it. Tasks run one at a time, in order. You can paste or drop
                    photos here.
                  </p>
                </form>
              )}
              <div className="q-ctl">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void queueAct(queue?.paused ? "resume" : "pause")}
                >
                  {queue?.paused ? "Resume queue" : "Pause queue"}
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    if (window.confirm("Kill switch: pause the queue and stop the running task?"))
                      void queueAct("kill");
                  }}
                >
                  Kill switch
                </button>
              </div>
              {(queue?.paused || nearCap) && (
                <div className="banner">
                  {capHit || nearCap ? (
                    <>
                      Today&apos;s limit of {queue?.daily_cap} task starts is{" "}
                      {capHit
                        ? "reached, so the queue is paused"
                        : "used up; the next task will pause the queue"}
                      .
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => void queueAct("more")}
                      >
                        Allow 20 more today
                      </button>
                    </>
                  ) : (
                    <>
                      Queue paused: {queue?.pause_reason || "by you"}. New tasks wait until you
                      resume.
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => void queueAct("resume")}
                      >
                        Resume
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="queue">
                <QueueList
                  tasks={projTasks}
                  sel={sel}
                  engineLabel={engineLabel}
                  emptyEngine={engineLabel(engine)}
                  onSelect={(tid) => void select(tid)}
                  onAct={(tid, a) => void act(tid, a)}
                />
              </div>
            </div>
            <div className="panel detail grow" data-m="queue" data-testid="ember-task-detail">
              <h2>
                {selTask ? (
                  <>
                    Task #{selTask.id}{" "}
                    <span className={`chip s-${selTask.state}`}>
                      {selTask.state.replace("_", " ")}
                    </span>
                  </>
                ) : (
                  "Task detail"
                )}
              </h2>
              <div className="detail-body">
                {selTask ? (
                  <TaskDetail
                    task={selTask}
                    log={log}
                    engineLabel={engineLabel}
                    onAct={(a) => void act(selTask.id, a)}
                    onReport={async (path) => {
                      const res = await emberFetch(`vault/note?path=${encodeURIComponent(path)}`);
                      setModal({ title: path, body: await res.text() });
                    }}
                  />
                ) : (
                  <p className="muted">Select a task to see its live progress and result.</p>
                )}
              </div>
            </div>
          </section>
        </main>
      </div>
      {panelsOpen && (
        <div className="hearth-rail" data-testid="ember-panels">
          <Rail
            open
            onToggle={() => setPanelsOpen(false)}
            onOpen={openPanel}
            isOpen={(o) =>
              layout.windows.some((w) => windowKey(w) === windowKey(o) && !w.minimized)
            }
            switches
            onNavigate={(to) => navigate(to)}
          />
        </div>
      )}
    </>
  );

  return (
    <div
      ref={shell}
      className={[
        "ember-shell",
        engine === "codex" ? "theme-codex" : engine === "ollama" ? "theme-ollama" : "",
        view === "term" && !lair ? "view-term" : "",
        lair ? "lair-on" : "",
        gh.open || art.open ? "gh-open" : "",
        `m-tab-${mtab}`,
      ].join(" ")}
      data-testid="ember-room"
    >
      <div className="er">
        <header className="top" ref={top}>
          <div className="top-left">
            <div className="hearth-nav">
              <button
                type="button"
                className={`btn small nav-btn tb tb-menu ${menuOpen ? "on" : ""}`}
                aria-label="Menu"
                aria-expanded={menuOpen}
                title="Hearth's menu: every page"
                onClick={() => setMenuOpen((o) => !o)}
                data-testid="ember-menu-button"
              >
                <Menu strokeWidth={1.8} aria-hidden />
              </button>
              <button
                type="button"
                className="btn small nav-btn tb tb-home"
                aria-label="Back to Hearth"
                title="Home"
                onClick={() => navigate("/")}
              >
                <House strokeWidth={1.8} aria-hidden />
                <span>Home</span>
              </button>
              {desk && (
                <button
                  type="button"
                  className="btn small nav-btn tb tb-lair"
                  aria-label="Open the Lair"
                  title="The Lair: your systems' panels beside Ember"
                  onClick={openLair}
                  data-testid="ember-lair-button"
                >
                  <Castle strokeWidth={1.8} aria-hidden />
                  <span>Lair</span>
                </button>
              )}
            </div>
            <div className="brand">
              EMBER<span className="sub">war room · {cfg?.machine ?? "…"}</span>
            </div>
            <div className="pills">
              {pill("bridge", "Live", "Live connection to this PC's engine")}
              {pill("claude", "Claude Code", "Claude Code on this PC")}
              {/* Hearing and Voice only when a speech machine is set up (Settings, Ember, Voice);
                  without one, the browser hears and speaks, and there is nothing to watch. */}
              {serverVoice && pill("whisper", "Hearing", "Speech to text (Settings, Ember, Voice)")}
              {serverVoice && pill("piper", "Voice", "Spoken replies (Settings, Ember, Voice)")}
              <span
                className={`pill ${queue?.paused ? "warn" : qCounts.running ? "busy" : queue ? "ok" : ""}`}
                title={
                  queue?.paused ? "Queue paused" : `Queue ${qCounts.running ? "running" : "ready"}`
                }
              >
                <i />
                <b>
                  {queue?.paused
                    ? "Queue paused"
                    : `Queue ${qCounts.running ? "running" : "ready"}`}
                </b>
              </span>
              {rc && (
                <a
                  className={`pill rc ${rc.url ? "ok" : ""}`}
                  href={rc.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={
                    rc.url
                      ? "Remote Control is on: open this conversation in Claude. Type /rc again to turn it off."
                      : "Remote Control is connecting…"
                  }
                >
                  <i />
                  <b>Remote</b>
                </a>
              )}
            </div>
          </div>

          <div className="engine-wrap">
            <div className="engine" role="radiogroup" aria-label="Task engine">
              <span
                className="glider"
                aria-hidden="true"
                style={{ width: glider.width, transform: `translateX(${glider.x}px)` }}
              />
              {(["claude-code", "codex", "ollama"] as const)
                .filter((n) => cfg?.engines[n])
                .map((n) => {
                  const en = cfg!.engines[n]!;
                  return (
                    <button
                      key={n}
                      ref={(el) => {
                        segs.current[n] = el;
                      }}
                      type="button"
                      className="seg"
                      role="radio"
                      data-engine={n}
                      data-off={en.enabled ? "false" : "true"}
                      aria-checked={engine === n}
                      tabIndex={engine === n ? 0 : -1}
                      title={en.note}
                      onClick={() => chooseEngine(n)}
                    >
                      {n === "claude-code" ? (
                        <Icon d="M12 2l2.4 6.9L21 9.6l-5.3 4.2L17.6 21 12 17.1 6.4 21l1.9-7.2L3 9.6l6.6-.7z" />
                      ) : n === "ollama" ? (
                        <Icon d="M6 7h12v10H6zM9 3v4M15 3v4M9 17v4M15 17v4M2 10h4M2 14h4M18 10h4M18 14h4" />
                      ) : (
                        <Icon d="M8.6 6.6L3.2 12l5.4 5.4 1.4-1.4-4-4 4-4zm6.8 0L14 8l4 4-4 4 1.4 1.4 5.4-5.4z" />
                      )}
                      <span className="nm">{en.label}</span>
                      <small className="st">
                        {n === "ollama"
                          ? en.enabled
                            ? "free"
                            : en.installed
                              ? "set up"
                              : "needs claude"
                          : en.enabled
                            ? en.version
                              ? "v" + (en.version.split("-")[0] ?? en.version)
                              : "ready"
                            : en.installed
                              ? "not enabled"
                              : "not installed"}
                      </small>
                    </button>
                  );
                })}
            </div>
            {engineNote && (
              <div className="engine-note" role="status" aria-live="polite">
                {engineNote}
                {engine === "ollama" && !cfg?.engines.ollama?.enabled && (
                  <>
                    {" "}
                    <Link
                      to="/settings#ollama"
                      className="underline underline-offset-2"
                      data-testid="ollama-setup-link"
                    >
                      Set up Ollama
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="top-right">
            <button
              type="button"
              className="btn small js-pause tb tb-pause"
              onClick={() => void queueAct(queue?.paused ? "resume" : "pause")}
            >
              {queue?.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {queue?.paused ? "Resume queue" : "Pause queue"}
            </button>
            <button
              type="button"
              className="btn small danger js-kill tb tb-kill"
              title="Pause the queue and stop the running task"
              onClick={() => {
                if (window.confirm("Kill switch: pause the queue and stop the running task?"))
                  void queueAct("kill");
              }}
            >
              <OctagonX aria-hidden />
              Kill switch
            </button>
            <button
              type="button"
              className="btn icon cam"
              title="Capture the War Room: copy or save the image"
              aria-label="Capture a screenshot of the War Room"
              onClick={() => void capture()}
            >
              <Icon d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 4.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
            </button>
            <div className="clock">{clock}</div>
          </div>
        </header>

        <nav className="ptabs" ref={ptabs} aria-label="Projects">
          <div className="ptab-list" role="tablist" ref={tabStrip}>
            <button
              type="button"
              className="ptab ptab-lair"
              role="tab"
              aria-selected={lair === "main"}
              title="The Lair: the same conversation as the Lair, with Ember and your homelab. Always here."
              onClick={() => setLair("main")}
              data-testid="ember-tab-lair"
            >
              <Castle aria-hidden className="lair-icon" />
              The Lair
              <Pin aria-label="Always here" className="lair-pin" />
            </button>
            {lairTabs.map((k) => (
              <button
                key={`lair-${k}`}
                type="button"
                className="ptab ptab-lair"
                role="tab"
                aria-selected={lair === k}
                title="A Lair project: Ember in the Lair works on it"
                onClick={() => setLair(k)}
                // A Lair project's tab edits like a War Room one (right-click, Edit project).
                onContextMenu={(ev) => {
                  const p = lairProjects.data?.find((x) => x.id === k);
                  if (!p) return;
                  ev.preventDefault();
                  setEditLair({
                    kind: "lair",
                    id: p.id,
                    name: p.name,
                    description: p.summary ?? "",
                    color: p.color,
                  });
                }}
                data-testid={`ember-tab-lair-${k}`}
              >
                <Castle aria-hidden className="lair-icon" />
                {lairNames.get(k) ?? "Lair project"}
                <span
                  className="x"
                  role="button"
                  aria-label={`Close tab ${lairNames.get(k) ?? "Lair project"}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    closeLairTab(k);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
            {openTabs
              .filter((k) => projects[k] && !projects[k]?.archived)
              .map((k) => (
                <button
                  key={k}
                  type="button"
                  className="ptab"
                  role="tab"
                  aria-selected={!lair && k === project}
                  title={summary(projects[k]?.description ?? "")}
                  onClick={() => switchProject(k)}
                  onContextMenu={(ev) => {
                    if (k === "sandbox") return;
                    ev.preventDefault();
                    setTabMenu({
                      x: ev.clientX,
                      y: ev.clientY,
                      t: {
                        pc,
                        slug: k,
                        name: projects[k]?.name ?? k,
                        description: projects[k]?.description ?? "",
                        color: projects[k]?.color,
                      },
                    });
                  }}
                  data-testid={`ember-tab-${k}`}
                >
                  {here && <TabPc look={here} />}
                  {projects[k]?.name ?? k}
                  {activeCount(k) > 0 && (
                    <span className="n" title="active tasks">
                      {activeCount(k)}
                    </span>
                  )}
                  {openTabs.length > 1 && (
                    <span
                      className="x"
                      role="button"
                      aria-label={`Close tab ${projects[k]?.name ?? k}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        closeTab(k);
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
              ))}
            {others.map((o) => (
              <button
                key={`${o.pc ?? "hub"}/${o.slug}`}
                type="button"
                className={`ptab ${o.offline ? "offline" : ""}`}
                role="tab"
                aria-selected={false}
                title={o.offline ? `${o.look.name} is offline` : `On ${o.look.name}`}
                onClick={() => openOther(o.pc, o.slug)}
                onContextMenu={(ev) => {
                  if (o.slug === "sandbox" || o.offline) return;
                  ev.preventDefault();
                  const known = elsewhere
                    .find((e) => e.pc === o.pc)
                    ?.projects.find((p) => p.slug === o.slug);
                  setTabMenu({
                    x: ev.clientX,
                    y: ev.clientY,
                    t: {
                      pc: o.pc,
                      slug: o.slug,
                      name: known?.name ?? o.name,
                      description: known?.description ?? "",
                      color: known?.color,
                    },
                  });
                }}
                data-testid={`ember-tab-${o.pc ?? "hub"}-${o.slug}`}
              >
                <TabPc look={o.look} />
                {o.name}
                <span
                  className="x"
                  role="button"
                  aria-label={`Close tab ${o.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onCloseOther?.(o.pc, o.slug);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
          <div className="ptab-tools">
            <button
              type="button"
              className={`btn small panels-btn tb tb-panels ${panelsOpen ? "on" : ""}`}
              aria-pressed={panelsOpen}
              title="Hearth's panels: services, storage, projects, to-do, plans"
              onClick={() => setPanelsOpen((o) => !o)}
              data-testid="ember-panels-button"
            >
              <LayoutGrid aria-hidden />
              Panels
            </button>
            <div className="viewseg tb-view" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                aria-selected={view === "term"}
                title="The real Claude Code / Codex, live in this project's folder"
                onClick={() => setView("term")}
              >
                <SquareTerminal aria-hidden />
                Terminal
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "chat"}
                title="Chat view with voice and the task queue"
                onClick={() => setView("chat")}
              >
                <MessageSquare aria-hidden />
                Chat
              </button>
            </div>
            <button
              type="button"
              className="btn small tb tb-open"
              aria-haspopup="true"
              aria-expanded={pmenu}
              onClick={() => {
                if (!pmenu) onMenu?.();
                setPmenu((o) => !o);
              }}
            >
              <FolderOpen aria-hidden />
              Open ▾
            </button>
            <button
              type="button"
              className="btn small primary tb tb-new"
              onClick={() => {
                setNewProj(true);
                setNpErr("");
              }}
            >
              <Plus aria-hidden />
              New project
            </button>
            <button
              type="button"
              className={`btn small gh-btn tb tb-gh ${gh.live ? "live" : ""}`}
              aria-pressed={gh.open}
              title="GitHub: your repos and PRs, and what EMBER is doing on GitHub"
              onClick={() => {
                setArt((a) => ({ ...a, open: false }));
                gh.setOpen(!gh.open);
              }}
            >
              <GitHubMark />
              GitHub
              <i className="gh-live-dot" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn small art-link tb tb-art"
              aria-pressed={art.open}
              title="Artifacts: what the agent made, and your Claude artifacts"
              onClick={() => {
                gh.setOpen(false);
                setArt((a) => ({ open: !a.open, start: null }));
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 3.5h7M16.5 13v7"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                />
              </svg>
              Artifacts
            </button>
          </div>
          {pmenu && (
            <div className="pmenu" role="menu">
              {(lairProjects.data ?? []).length > 0 && (
                <div className="pmenu-pc" data-testid="pmenu-lair">
                  <p className="pmenu-pc-head">
                    <Castle aria-hidden className="lair-icon" /> In the Lair
                  </p>
                  {(lairProjects.data ?? []).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPmenu(false);
                        setLair(p.id);
                      }}
                    >
                      <b>
                        {p.name}
                        {lairTabs.includes(p.id) ? " · open" : ""}
                      </b>
                      <small>{p.summary || "A Lair project"}</small>
                    </button>
                  ))}
                </div>
              )}
              {Object.values(projects)
                .sort(
                  (a, b) =>
                    Number(Boolean(a.archived)) - Number(Boolean(b.archived)) ||
                    (b.last ?? "").localeCompare(a.last ?? ""),
                )
                .map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPmenu(false);
                      switchProject(p.slug);
                    }}
                  >
                    <b>
                      {p.name}
                      {p.archived
                        ? " · archived"
                        : openTabs.includes(p.slug) && !lair
                          ? " · open"
                          : ""}
                    </b>
                    <small>{summary(p.description) || p.path}</small>
                  </button>
                ))}
              {elsewhere
                .filter((e) => e.projects.length)
                .map((e) => (
                  <div key={e.pc ?? "hub"} className="pmenu-pc" data-testid="pmenu-elsewhere">
                    <p className="pmenu-pc-head">
                      <TabPc look={e.look} /> On {e.look.name}
                    </p>
                    {e.projects.map((p) => (
                      <button
                        key={p.slug}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setPmenu(false);
                          openOther(e.pc, p.slug);
                        }}
                      >
                        <b>
                          <TabPc look={e.look} />
                          {p.name}
                          {others.some((o) => o.pc === e.pc && o.slug === p.slug) ? " · open" : ""}
                        </b>
                        <small>{summary(p.description) || `On ${e.look.name}`}</small>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </nav>
      </div>

      {menuOpen && (
        <>
          <div className="hearth-menu-scrim" onClick={() => setMenuOpen(false)} aria-hidden />
          <nav className="hearth-menu" aria-label="Hearth menu" data-testid="ember-menu">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <p className="eyebrow">Hearth</p>
              <button
                type="button"
                aria-label="Close the menu"
                onClick={() => setMenuOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
              >
                <X strokeWidth={1.5} className="h-5 w-5" />
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {desk && (
                <li>
                  <button
                    type="button"
                    onClick={openLair}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.92rem] text-ink hover:bg-raised"
                  >
                    <Castle strokeWidth={1.5} className="h-5 w-5 text-gold/80" />
                    The Lair
                  </button>
                </li>
              )}
              {[...mobilePrimaryNav, ...moreNav]
                .filter((n, i, all) => all.findIndex((m) => m.to === n.to) === i)
                .map((n) => (
                  <li key={n.to}>
                    <NavLink
                      to={n.to}
                      end={n.to === "/"}
                      className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-[0.92rem] text-ink hover:bg-raised"
                    >
                      <n.icon strokeWidth={1.5} className="h-5 w-5 text-gold/80" />
                      {n.label}
                    </NavLink>
                  </li>
                ))}
            </ul>
          </nav>
        </>
      )}

      <div className="er-canvas">
        <Windows
          layout={layout}
          update={update}
          expanded={expanded}
          setExpanded={setExpanded}
          center={center}
        />
      </div>

      <div className="er">
        <footer className={`cmd ${optsOpen ? "opts-open" : ""}`} ref={footer}>
          <div className="cmd-opts">
            <select
              value={agent}
              onChange={(ev) => setAgent(ev.target.value)}
              title="How the request is handled"
              aria-label="Request type"
            >
              <option value="claude">Chat with the agent</option>
              <option value="quick">
                Quick answer{cfg?.routing.quick_model ? ` (${cfg.routing.quick_model})` : ""}
              </option>
              <option value="auto">Auto route</option>
            </select>
            <select
              value={model}
              onChange={(ev) => setModel(ev.target.value)}
              title="Model for tasks (separate from the engine)"
              aria-label="Model"
            >
              <option value="">
                {P?.engine === engine && P.model
                  ? `project model (${P.model})`
                  : `${e?.label ?? "Engine"} default`}
              </option>
              {(e?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {(m[0] ?? "").toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
            {/* Only when there is a voice to choose: the Standard voice is just one, so none. */}
            {choices.length > 1 && (
              <select
                value={voiceId}
                title="Voice that speaks replies (plays a preview)"
                aria-label="Voice"
                onChange={(ev) => {
                  const v = ev.target.value;
                  setVoiceId(v);
                  store.set("ember.voice3", v);
                  r.current.voiceId = v;
                  const label =
                    choices.find((c) => c.id === v)?.label.split(" (")[0] ?? "this voice";
                  const was = r.current.speakOn;
                  r.current.speakOn = true;
                  void speak(`Hi, this is ${label}. I'll use this voice from now on.`).finally(
                    () => {
                      r.current.speakOn = was;
                    },
                  );
                }}
              >
                {groups.map((g) => (
                  <optgroup key={g} label={g === "Piper" ? "Piper (robotic)" : g}>
                    {choices
                      .filter((c) => (c.group || "Voices") === g)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          🔊 {c.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
            {voiceLoaded && !voiceChat && (
              <button
                type="button"
                className="btn icon"
                title="Free up voice memory now, without waiting for Hearth's 10-minute idle shutdown."
                aria-label="Free up voice memory"
                data-testid="ember-free-voice"
                onClick={freeVoice}
              >
                <MemoryStick strokeWidth={1.9} className="stroke-icon" />
              </button>
            )}
            <label
              className={`chk full ${askLevel === "free" ? "on" : ""}`}
              title="What Claude Code, Codex, or Ollama asks you before it acts. It can do everything either way; this only chooses when it stops to ask."
            >
              asks{" "}
              <select
                value={askLevel}
                data-testid="ember-ask-level"
                aria-label="What it asks before acting"
                onChange={(ev) => {
                  const level = ev.target.value as AskLevel;
                  void ember<EmberQueue>(`queue/ask-${level}`, { body: {} })
                    .then((q) => {
                      setQueue(q);
                      say(
                        "sys",
                        `Now it ${ASK_LEVEL_TEXT[level].short}. ${ASK_LEVEL_TEXT[level].hint}`,
                      );
                    })
                    .catch((e: unknown) =>
                      say("sys", "Couldn't change what it asks: " + (e as Error).message),
                    );
                }}
              >
                <option value="strict">before every change</option>
                <option value="moderate">before risky steps</option>
                <option value="free">only before serious steps</option>
              </select>
            </label>
            <label className="chk" title="Hold the task until you approve it">
              <input
                type="checkbox"
                checked={approveFirst}
                onChange={(ev) => setApproveFirst(ev.target.checked)}
              />{" "}
              approve first
            </label>
          </div>
          <div className="att-chips msg-atts">{chips("msg")}</div>
          <div className="cmd-main">
            <button
              type="button"
              className="btn icon"
              title="Attach files or photos (or paste / drop them)"
              aria-label="Attach files or photos"
              onClick={() => {
                attTarget.current = "msg";
                fileInput.current?.click();
              }}
            >
              <Icon d={CLIP} />
            </button>
            <textarea
              id="text"
              ref={textBox}
              rows={1}
              // Grammarly's marks sit on a layer above the box and were left behind when dictated
              // words replaced the text (pink lines until Send, 10-26), and its button covered
              // Send. Hearth corrects dictation itself (writing assistance), so it stays out here.
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              value={text}
              placeholder={
                e && !e.enabled
                  ? `${e.label} not enabled: tasks held, questions work`
                  : "Ask EMBER or give it a task…"
              }
              aria-label="Message"
              autoComplete="off"
              spellCheck
              enterKeyHint="send"
              data-testid="ember-input"
              onChange={(ev) => {
                setText(ev.target.value);
                const t = ev.target;
                t.style.height = "auto";
                t.style.height = `${Math.min(t.scrollHeight + 2, 160)}px`;
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) {
                  ev.preventDefault();
                  void send(text);
                  if (textBox.current) textBox.current.style.height = "auto";
                }
              }}
            />
            <button
              type="button"
              id="btn-mic"
              className={`btn icon ${micLive || dictating ? "live" : ""}`}
              title={
                dictating
                  ? "Listening: your words are typed in. Click to stop."
                  : "Dictate: say it and it is typed in; you send it (Ctrl+Space)"
              }
              aria-label="Dictate"
              aria-pressed={dictating}
              data-testid="ember-dictate"
              onClick={dictate}
            >
              <Icon d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12z" />
            </button>
            <button
              type="button"
              className={`btn icon ${voiceChat ? "on" : ""}`}
              title={
                voiceChat
                  ? "Voice chat on: just talk; replies are spoken. Click to end it."
                  : "Voice chat: just talk back and forth with EMBER"
              }
              aria-label={voiceChat ? "End voice chat" : "Start voice chat"}
              aria-pressed={voiceChat}
              data-testid="ember-voice-chat"
              onClick={() => setVoiceChatOn(!voiceChat)}
            >
              <AudioLines strokeWidth={1.9} className="stroke-icon" />
            </button>
            {voiceChat && (
              <button
                type="button"
                className={`btn icon ${handsfree ? "on" : ""}`}
                title={
                  handsfree
                    ? "Listening: it hears you whenever it's your turn. Click so it can't hear you."
                    : "Not listening: it can't hear you, and still speaks its replies. Click to let it hear you."
                }
                aria-label={handsfree ? "Stop it hearing you" : "Let it hear you"}
                aria-pressed={handsfree}
                data-testid="ember-ear"
                onClick={() => setHearing(!handsfree)}
              >
                {handsfree ? (
                  <Ear strokeWidth={1.9} className="stroke-icon" />
                ) : (
                  <EarOff strokeWidth={1.9} className="stroke-icon" />
                )}
              </button>
            )}
            <button
              type="button"
              className={`btn icon ${speakOn ? "on" : ""}`}
              title="Speak replies"
              aria-label="Speak replies"
              aria-pressed={speakOn}
              onClick={() => {
                const on = !speakOn;
                setSpeakOn(on);
                r.current.speakOn = on;
                store.set("ember.speak", on ? "1" : "0");
                if (!on) stopSpeaking();
              }}
            >
              <Icon d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
            </button>
            <button
              type="button"
              id="btn-opts"
              className={`btn icon ${optsOpen ? "on" : ""}`}
              title="Request options"
              aria-label="Request options"
              aria-expanded={optsOpen}
              onClick={() => setOptsOpen((o) => !o)}
            >
              <Icon d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
            </button>
            <button
              type="button"
              id="btn-send"
              className="btn primary"
              onClick={() => void send(text)}
              data-testid="ember-send"
            >
              Send
            </button>
          </div>
        </footer>

        <input
          type="file"
          ref={fileInput}
          multiple
          hidden
          onChange={(ev) => {
            void addFiles([...(ev.target.files ?? [])], attTarget.current);
            ev.target.value = "";
          }}
        />
        {dropHint && <div className="drop-hint">Drop files to attach</div>}

        {shot && (
          <div className="shot" role="dialog" aria-label="Screenshot of the War Room">
            <div className="shot-head">
              <b>Screenshot</b>
              <button
                type="button"
                className="btn small"
                aria-label="Close screenshot"
                onClick={() => setShot(null)}
              >
                ✕
              </button>
            </div>
            <img src={shot.url} alt="Screenshot of the War Room" />
            <div className="shot-acts">
              <button
                type="button"
                className="btn small primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.write([
                      new ClipboardItem({ "image/png": shot.blob }),
                    ]);
                    setShot({ ...shot, msg: "Image copied. Paste it anywhere." });
                  } catch (err) {
                    setShot({
                      ...shot,
                      msg: `This browser wouldn't copy the image (${(err as Error).name}). Use Save PNG instead.`,
                    });
                  }
                }}
              >
                Copy image
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const a = Object.assign(document.createElement("a"), {
                    href: shot.url,
                    download: shotName(),
                  });
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setShot({ ...shot, msg: `Saved as ${a.download} (your Downloads folder).` });
                }}
              >
                Save PNG
              </button>
              <button
                type="button"
                className="btn small"
                title="Attach this screenshot to your next message"
                onClick={() => {
                  void addFiles(
                    [new File([shot.blob], shotName(), { type: "image/png" })],
                    addOpen ? "task" : "msg",
                  );
                  setShot({ ...shot, msg: "Attached. Type your message and send." });
                }}
              >
                Attach
              </button>
              <button
                type="button"
                className="btn small"
                title="Take another"
                onClick={() => void capture()}
              >
                Retake
              </button>
            </div>
            <p className="shot-msg" role="status" aria-live="polite">
              {shot.msg}
            </p>
          </div>
        )}

        <GitHubPanel gh={gh} />
        <ArtifactsPanel
          key={art.start ? `file:${art.start.path}` : "list"}
          open={art.open}
          project={project}
          projectName={P?.name ?? project}
          start={art.start}
          onClose={() => setArt({ open: false, start: null })}
        />

        {tabMenu && (
          <div
            className="tabmenu-shade"
            onClick={() => setTabMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setTabMenu(null);
            }}
          >
            <div
              className="pmenu tabmenu"
              role="menu"
              data-testid="tab-menu"
              style={{
                left: Math.min(tabMenu.x, window.innerWidth - 240),
                top: Math.min(tabMenu.y, window.innerHeight - 120),
              }}
              onClick={(ev) => ev.stopPropagation()}
              onKeyDown={(ev) => {
                if (ev.key === "Escape") setTabMenu(null);
              }}
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setEditErr("");
                  setEditProj(tabMenu.t);
                  setTabMenu(null);
                }}
              >
                <b>Edit name, description and color</b>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  const t = tabMenu.t;
                  const here = t.pc === pc;
                  const look = elsewhere.find((e) => e.pc === t.pc)?.look;
                  setDelErr("");
                  setDelProj({
                    ...t,
                    where: here
                      ? (cfg?.projects[t.slug]?.path ?? "")
                      : `on ${look?.name ?? "the other PC"}`,
                  });
                  setTabMenu(null);
                }}
              >
                <b>Delete project</b>
              </button>
            </div>
          </div>
        )}

        {delProj && (
          <div className="overlay">
            <div
              className="modal-card np-card"
              role="alertdialog"
              aria-labelledby="del-proj-title"
              data-testid="delete-project"
            >
              <div className="modal-head">
                <b id="del-proj-title">Delete {delProj.name}?</b>
              </div>
              <p>
                This deletes the project&apos;s folder and every file in it, and its whole
                conversation with the agents. It can&apos;t be undone.
              </p>
              {delProj.where && (
                <p className="hint">
                  {delProj.where.startsWith("on ") ? (
                    `The project is ${delProj.where}.`
                  ) : (
                    <>
                      Folder: <code>{delProj.where}</code>
                    </>
                  )}
                </p>
              )}
              {delErr && <p className="err">{delErr}</p>}
              <div className="np-acts">
                <button
                  type="button"
                  className="btn small"
                  autoFocus
                  onClick={() => setDelProj(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={deleting}
                  onClick={async () => {
                    setDeleting(true);
                    setDelErr("");
                    try {
                      await ember(`projects/${encodeURIComponent(delProj.slug)}`, {
                        method: "DELETE",
                        ...(delProj.pc !== pc ? { on: delProj.pc } : {}),
                      });
                      if (delProj.pc === pc) forgetProject(delProj.slug);
                      else onCloseOther?.(delProj.pc, delProj.slug);
                      setDelProj(null);
                    } catch (err) {
                      setDelErr((err as Error).message);
                    } finally {
                      setDeleting(false);
                    }
                  }}
                >
                  {deleting ? "Deleting..." : "Delete for good"}
                </button>
              </div>
            </div>
          </div>
        )}

        {editLair && <EditProjectDialog target={editLair} onClose={() => setEditLair(null)} />}
        {editProj && (
          <div className="overlay">
            <form
              className="modal-card np-card"
              autoComplete="off"
              data-testid="edit-project"
              onSubmit={async (ev) => {
                ev.preventDefault();
                try {
                  const p = await ember<EmberConfig["projects"][string] & { slug: string }>(
                    `projects/${encodeURIComponent(editProj.slug)}`,
                    {
                      method: "PATCH",
                      body: {
                        name: editProj.name,
                        description: editProj.description,
                        color: editProj.color ?? null,
                      },
                      ...(editProj.pc !== pc ? { on: editProj.pc } : {}),
                    },
                  );
                  if (editProj.pc === pc)
                    setCfg((c) => (c ? { ...c, projects: { ...c.projects, [p.slug]: p } } : c));
                  else {
                    // Its tab name here, on another PC's tab.
                    const names = JSON.parse(
                      store.get(tabKey(editProj.pc, "tabnames")) ?? "{}",
                    ) as Record<string, string>;
                    store.set(
                      tabKey(editProj.pc, "tabnames"),
                      JSON.stringify({ ...names, [p.slug]: p.name }),
                    );
                    onTabs?.();
                  }
                  setEditProj(null);
                } catch (err) {
                  setEditErr((err as Error).message);
                }
              }}
            >
              <div className="modal-head">
                <b>Edit project</b>
                <button type="button" className="btn small" onClick={() => setEditProj(null)}>
                  Close
                </button>
              </div>
              <label className="np-l" htmlFor="ep-name">
                Project Name
              </label>
              <input
                id="ep-name"
                value={editProj.name}
                maxLength={80}
                onChange={(ev) => setEditProj({ ...editProj, name: ev.target.value })}
                autoFocus
              />
              <label className="np-l" htmlFor="ep-desc">
                Project Description{" "}
                <span className="hint">Agents read this before every task.</span>
              </label>
              <textarea
                id="ep-desc"
                rows={editProj.description.length > 400 ? 14 : 4}
                value={editProj.description}
                maxLength={8000}
                onChange={(ev) => setEditProj({ ...editProj, description: ev.target.value })}
              />
              <span className="np-l">Color on Home</span>
              <ProjectColorPicker
                value={editProj.color}
                onChange={(color) => setEditProj({ ...editProj, color })}
              />
              {editErr && <p className="err">{editErr}</p>}
              <div className="np-acts">
                <button type="submit" className="btn primary">
                  Save
                </button>
              </div>
            </form>
          </div>
        )}
        {newProj && (
          <div className="overlay">
            <form
              className="modal-card np-card"
              autoComplete="off"
              onSubmit={async (ev) => {
                ev.preventDefault();
                try {
                  const p = await ember<EmberConfig["projects"][string] & { slug: string }>(
                    "projects",
                    {
                      body: { name: npName, description: npDesc, color: npColor },
                      on: npPc,
                    },
                  );
                  if (npPc !== pc) {
                    // It lives on another PC: open it there.
                    setNewProj(false);
                    setNpName("");
                    setNpDesc("");
                    setNpColor(undefined);
                    onOpenOther?.(npPc, p.slug);
                    return;
                  }
                  const next = cfg ? { ...cfg, projects: { ...cfg.projects, [p.slug]: p } } : cfg;
                  setCfg(next);
                  r.current.cfg = next;
                  setNewProj(false);
                  setNpName("");
                  setNpDesc("");
                  setNpColor(undefined);
                  switchProject(p.slug, next);
                } catch (err) {
                  setNpErr((err as Error).message);
                }
              }}
            >
              <div className="modal-head">
                <b>New project</b>
                <button type="button" className="btn small" onClick={() => setNewProj(false)}>
                  Close
                </button>
              </div>
              <label className="np-l" htmlFor="np-name">
                Project Name
              </label>
              <input
                id="np-name"
                maxLength={60}
                autoFocus
                value={npName}
                onChange={(ev) => setNpName(ev.target.value)}
              />
              <label className="np-l" htmlFor="np-desc">
                Project Description{" "}
                <span className="hint">Agents read this before every task.</span>
              </label>
              <textarea
                id="np-desc"
                rows={4}
                value={npDesc}
                onChange={(ev) => setNpDesc(ev.target.value)}
              />
              <span className="np-l">Color on Home</span>
              <ProjectColorPicker value={npColor} onChange={setNpColor} />
              {machines.length > 1 && (
                <>
                  <span className="np-l">Which PC should this live on?</span>
                  <div className="np-pcs" role="radiogroup" aria-label="Which PC">
                    {machines.map((m) => (
                      <button
                        key={m.pc ?? "hub"}
                        type="button"
                        role="radio"
                        aria-checked={npPc === m.pc}
                        disabled={!m.online}
                        className={`np-pc ${npPc === m.pc ? "on" : ""}`}
                        onClick={() => setNpPc(m.pc)}
                        title={m.online ? m.look.name : `${m.look.name} is offline`}
                      >
                        {m.look.src && <img src={m.look.src} alt="" />}
                        <span style={{ color: m.look.color }}>{m.look.name}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="hint">
                A new folder with its own git history is created in that PC&apos;s Hearth Projects
                folder.
              </p>
              <p className="err">{npErr}</p>
              <div className="np-acts">
                <button type="submit" className="btn primary">
                  Create project
                </button>
              </div>
            </form>
          </div>
        )}

        {modal && (
          <div className="overlay" onClick={() => setModal(null)}>
            <div className="modal-card" onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-head">
                <b>{modal.title}</b>
                <button type="button" className="btn small" onClick={() => setModal(null)}>
                  Close
                </button>
              </div>
              <pre>{modal.body}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
