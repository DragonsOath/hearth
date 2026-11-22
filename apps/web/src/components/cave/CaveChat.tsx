import { aiDisplayName, CLAUDE_MODELS } from "@dragon-control/core";
import { JumpToLatest } from "../shell/JumpToLatest";
import { ScrollHandle } from "../shell/ScrollHandle";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Anvil,
  ArrowUp,
  AudioLines,
  Ear,
  EarOff,
  Mic,
  Plus,
  Smartphone,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { CaveFocus } from "@dragon-control/core";
import { Skeleton, cx } from "../ui";
import { api, useWorkspace } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { isTouchOnly, usePhone } from "../../lib/media";
import { useAiUsage, useAsk, useCaveConversation, useSetBudget } from "../../data/cave";
import { useClaimShow, useResumeShow, useShowSettings, useShowState } from "../../data/show";
import { isClearStop } from "@dragon-control/core";
import { Message, Notice, remoteQuestion } from "./Thread";
import { ConversationPlans, PlanCards, plansIn, Progress } from "./Progress";
import { Suggestions } from "../desk/Suggestions";
import { useOpenPanels } from "../desk/useOpenPanels";
import { CredentialPrompts } from "../credentials/CredentialPrompts";
import { HandoverPrompt, VisiblePrompt } from "../browser/Handover";
import { TodoPrompts } from "../todos/TodoPrompts";
import { useWritingAssist } from "./useWritingAssist";
import { carryVoiceChat, useVoiceChat } from "./useVoiceChat";
import { AttachedImages } from "../capture/AttachedImages";
import { useCave } from "../shell/cave-context";
import {
  answerAloud,
  setSpeakAnswers,
  speaker,
  useSpeakAnswers,
  useSpeaker,
  useVoice,
} from "../../data/voice";
import { useMic } from "./useMic";
import { AttachButton } from "./AttachButton";
import { fileBlock } from "./attachFile";

/**
 * One Ember conversation: the thread and the message box. The same
 * component serves the Ask page, the hub's expanded chat, and the panel
 * beside a project or service, so there is one history, never copies.
 */

/** Voices with a portrait for conversation mode (apps/web/public/voices). */

export const SUGGESTIONS = [
  "What can Hearth do?",
  "What's happening with my servers?",
  "Did my backups finish?",
  "What changed yesterday, and who approved it?",
  "What happened while I was away?",
];

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, value: string | undefined) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private windows); the draft is a convenience only.
  }
}

export interface FocusChip extends CaveFocus {
  label: string;
}

export function CaveChat({
  conversationId,
  onConversation,
  projectId,
  focus,
  onClearFocus,
  draftKey = "dc-ask-draft",
  initial,
  onInitialSent,
  inputLabel,
  placeholder,
  empty,
  className,
  threadClassName,
  autoFocus,
  modelInMenu,
}: {
  conversationId?: string;
  /** A new conversation was made by the first message. */
  onConversation?: (id: string) => void;
  /** A new conversation belongs to this project. */
  projectId?: string;
  /** What is open on screen; sent with each message until cleared. */
  focus?: FocusChip;
  onClearFocus?: () => void;
  draftKey?: string;
  /** A question to send at once (handed over from the hub or the search bar). */
  initial?: string;
  onInitialSent?: () => void;
  inputLabel?: string;
  placeholder?: string;
  /** Shown before the first message. */
  empty?: ReactNode;
  className?: string;
  threadClassName?: string;
  autoFocus?: boolean;
  /** The model picker is in the chat's menu (a phone's Ember panel), not under the box. */
  modelInMenu?: boolean;
}) {
  const convo = useCaveConversation(conversationId);
  const cave = useCave();
  const ask = useAsk();
  // Show & Tell beside the chat (11-13): a paused walkthrough says so with Resume, and when
  // another window shows the answer, it says which, with Show here instead.
  const showOn = (useShowSettings().data?.mode ?? "off") !== "off";
  const show = useShowState(showOn).data;
  const resumeShow = useResumeShow();
  const claimShow = useClaimShow();
  const usage = useAiUsage();
  const ws = useWorkspace();
  const aiName = aiDisplayName(ws.data?.aiName);
  const label = inputLabel ?? `Ask ${aiName}`;
  const [draft, setDraft] = useState(() => read(draftKey) ?? "");
  const [failed, setFailed] = useState<string | null>(null);
  const threadRef = useRef<HTMLOListElement>(null);
  const phone = usePhone();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentInitial = useRef(false);

  // Voice: the microphone fills the box (you review, then send); answers to spoken
  // questions are read aloud, and every answer when "speak answers" is on.
  const voice = useVoice();
  const voiceReady = Boolean(voice.data?.configured);
  const speakAll = useSpeakAnswers();
  const speaking = useSpeaker();
  const spoken = useRef(false);
  // What was in the box before speaking; your words are added after it as you talk.
  const before = useRef("");
  const joined = (text: string) =>
    before.current.trim() ? `${before.current.trimEnd()} ${text}` : text;
  // Send pressed while the mic listens: the mic turns off, and what you said is sent with it.
  const sendWhenHeard = useRef(false);
  const sendRef = useRef<(text: string) => boolean>(() => false);
  const mic = useMic((text) => {
    spoken.current = true;
    if (sendWhenHeard.current) {
      sendWhenHeard.current = false;
      if (sendRef.current(joined(text))) return;
    }
    setDraft(joined(text));
    inputRef.current?.focus();
  });
  const startMic = () => {
    before.current = draft;
    void mic.start();
  };

  const messages = conversationId ? (convo.data?.messages ?? []) : [];
  // Panels Ember opens for you (open_panel), with or without Show & Tell.
  useOpenPanels(convo.data?.id ?? conversationId, convo.data?.messages);
  const working = ask.isPending || convo.data?.status === "working";
  const connected = ws.data?.agents.some((a) => a.status === "connected");
  // The message being answered: its steps stay open while the answer is worked on.
  // A turn starts with your question, or with Hearth's hidden follow-up (after a plan ends): its
  // progress and plans show either way (11-22).
  const asks = (m: (typeof messages)[number] | undefined) =>
    Boolean(m && (m.role === "you" || m.hidden));
  const lastAsked = messages.map((m) => asks(m)).lastIndexOf(true);
  const drawn = plansIn(messages);
  // The Remote Control question still waiting (nothing said or answered after it): its buttons work.
  const lastQuestion = messages.findLastIndex(
    (m) => m.role === "note" && Boolean(remoteQuestion(m.text)),
  );
  const waitingQuestion =
    lastQuestion >= 0 &&
    !messages
      .slice(lastQuestion + 1)
      .some((m) => m.role !== "note" || /^(Answered:|Remote Control (is off|ended))/.test(m.text))
      ? lastQuestion
      : -1;
  const stepCount = messages[lastAsked]?.activity?.length ?? 0;

  // One send at a time: a second Enter before the first request is under way is ignored
  // (state updates land a render later, so a ref is the reliable guard).
  const sending = useRef(false);
  const [waitNote, setWaitNote] = useState(false);
  // Stop (11-07): ends what Ember is working on. A message sent meanwhile adds to the request
  // (11-12): the answer under way ends quietly, and the next one answers both together.
  const qc = useQueryClient();
  // A new message may come with a new plan (any tool, any agent): read the plans again at once,
  // so its card shows with the answer instead of on the next check.
  useEffect(() => {
    if (messages.length) void qc.invalidateQueries({ queryKey: ["jobs"] });
  }, [messages.length, qc]);
  const [stopping, setStopping] = useState(false);
  const urgent = useRef<string | null>(null);
  const followUp = useRef(false);
  const stopNow = async (more = false) => {
    if (!conversationId || stopping) return;
    setStopping(true);
    try {
      await api(
        "POST",
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/stop`,
        more ? { followUp: true } : {},
      );
    } finally {
      await qc.invalidateQueries({ queryKey: ["conversations", conversationId] });
      setStopping(false);
    }
  };
  const assist = useWritingAssist({
    inputRef,
    setDraft,
    vocabulary: [
      ...(ws.data?.hosts.map((h) => h.name) ?? []),
      ...[...(ws.data?.services ?? []), ...(ws.data?.inactiveServices ?? [])].flatMap((s) =>
        s.name.split(/[\s()]+/),
      ),
    ],
  });
  // The box grows with what is typed (a Shift+Enter line is visible), up to its limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // A phone: up to 40% of the screen, so the whole sentence shows as you type (11-16).
    const most = phone ? Math.max(160, Math.round(window.innerHeight * 0.4)) : 160;
    el.style.height = `${Math.min(el.scrollHeight, most)}px`;
  }, [draft, phone]);
  const send = (text: string): boolean => {
    // Sending turns the mic off (10-26). Your words arrive when it stops, then they are sent.
    if (mic.state === "listening" || mic.state === "transcribing") {
      sendWhenHeard.current = true;
      if (mic.state === "listening")
        void mic.stop().then(() => {
          // Nothing was heard (too short, or silent): send what is in the box, if anything.
          if (!sendWhenHeard.current) return;
          sendWhenHeard.current = false;
          sendRef.current(inputRef.current?.value ?? "");
        });
      return true;
    }
    if (mic.state === "starting") mic.cancel();
    return deliver(text);
  };
  /** Sends the message (the mic is already off). */
  const deliver = (text: string): boolean => {
    const words = text.trim();
    if (!words || sending.current) return false;
    if (working) {
      // A clear stop ("stop", "cancel") stops it (11-13: only a clear stop stops; a question is
      // more to the same request).
      if (isClearStop(words)) {
        setDraft("");
        write(draftKey, undefined);
        void stopNow(false);
        return true;
      }
      // More to the same request: the answer under way ends quietly; this one goes as soon as it
      // has, and is answered together with it.
      urgent.current = words;
      followUp.current = true;
      setWaitNote(true);
      void stopNow(true);
      return true;
    }
    sending.current = true;
    setWaitNote(false);
    setFailed(null);
    // Sent: the saved copy goes now, not when the answer comes, so leaving the page meanwhile
    // (or Show & Tell taking you somewhere) never brings the message back into the box. A
    // failure puts it back below.
    write(draftKey, undefined);
    ask.mutate(
      {
        text: words,
        conversationId,
        lastVisit: read("dc-home-visited"),
        projectId: conversationId ? undefined : projectId,
        // A new thread started with a Thread Look gets its picture and name (11-17).
        ...(!conversationId && cave.newLook ? { look: cave.newLook } : {}),
        // And the name the owner gave it in the pop-up (11-18).
        ...(!conversationId && cave.newTitle ? { title: cave.newTitle } : {}),
        focus: focus
          ? { kind: focus.kind, id: focus.id, ...(focus.item ? { item: focus.item } : {}) }
          : undefined,
        ...(cave.attached.length ? { attachments: cave.attached.map((a) => a.id) } : {}),
        ...(spoken.current ? { spoken: true } : {}),
        ...(followUp.current ? { followUp: true } : {}),
      },
      {
        onSuccess: (r) => {
          // The chat box speaks only when its speaker is on; it carries "answer aloud" over to
          // the new conversation's page.
          if (speakAll || talkOn.current) answerAloud.add(r.conversationId);
          spoken.current = false;
          followUp.current = false;
          // The "About:" chip wasn't what this was about: it goes, so it stops tagging along.
          if (r.focusDropped) onClearFocus?.();
          setDraft("");
          cave.clearAttached();
          assist.reset();
          write(draftKey, undefined);
          if (r.conversationId !== conversationId) {
            if (cave.newLook || cave.newTitle) cave.clearNewLook();
            if (talkOn.current) carryVoiceChat();
            onConversation?.(r.conversationId);
          }
        },
        // The words stay in the box: nothing typed is lost to a dropped connection.
        onError: (e) => {
          setDraft(words);
          setFailed(e.message);
        },
        onSettled: () => {
          sending.current = false;
        },
      },
    );
    return true;
  };
  useEffect(() => {
    sendRef.current = deliver;
  });
  // The urgent message, once the answer under way has stopped.
  useEffect(() => {
    if (working || !urgent.current) return;
    const words = urgent.current;
    urgent.current = null;
    sendRef.current(words);
  }, [working]);

  // Voice chat right here, in this thread (10-30): you talk, Ember answers aloud, and it
  // listens again when it is your turn. The ear stops it hearing you; replies are still spoken.
  const talk = useVoiceChat({
    serverHearing: Boolean(voice.data?.stt.ok),
    working,
    onHeard: (text) => {
      spoken.current = true;
      return sendRef.current(text);
    },
  });
  const talkOn = useRef(false);
  useEffect(() => {
    talkOn.current = talk.on;
  });
  const startTalk = () => {
    if (talk.on) return talk.stop();
    mic.cancel();
    talk.start();
  };
  // Shown when the mic is pressed before voice is set up.
  const [voiceNote, setVoiceNote] = useState(false);
  const voiceKnown = Boolean(voice.data);

  useEffect(() => {
    if (initial && !sentInitial.current) {
      sentInitial.current = true;
      send(initial);
      onInitialSent?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    write(draftKey, draft || undefined);
  }, [draft, draftKey]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Read new answers aloud: the answer to a spoken question, or every answer when switched on.
  // History already on screen is never read out.
  const heard = useRef<number | null>(null);
  useEffect(() => {
    heard.current = null;
  }, [conversationId]);
  useEffect(() => {
    const list = convo.data?.messages ?? [];
    if (!conversationId || convo.isPending) return;
    if (heard.current === null) {
      heard.current = list.length;
      // A spoken question that started this conversation: its answer may already be here.
      const last = list.at(-1);
      if (answerAloud.has(conversationId) && last?.role === "agent" && voiceReady) {
        answerAloud.delete(conversationId);
        void speaker.say(last.text);
      }
      return;
    }
    if (list.length <= heard.current) return;
    const fresh = list.slice(heard.current);
    heard.current = list.length;
    const answer = [...fresh].reverse().find((m) => m.role === "agent");
    if (answer && voiceReady && (speakAll || answerAloud.has(conversationId))) {
      answerAloud.delete(conversationId);
      // After Show & Tell's last line, not over it.
      void speaker.queue(answer.text);
    }
  }, [convo.data, conversationId, convo.isPending, voiceReady, speakAll]);

  // Keep the newest exchange in view, inside this panel only.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, working, stepCount]);

  // A search hit (11-17, "where did we talk about this?"): the thread opens at the message that
  // matched, marked for a moment, instead of at the newest one.
  const jump = cave.jump;
  const jumpTo = cave.jumpTo;
  useEffect(() => {
    if (!jump || jump.id !== conversationId || messages.length <= jump.index) return;
    const timer = window.setTimeout(() => {
      const el = threadRef.current?.querySelector<HTMLElement>(`[data-msg-index="${jump.index}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("search-hit");
        window.setTimeout(() => el.classList.remove("search-hit"), 2400);
      }
      jumpTo(undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [jump, jumpTo, conversationId, messages.length]);

  // Coming back to the chat (11-16, the owner): it opens at the newest message every time. A
  // hidden thread (another panel in front, the conversations list) forgets where it was, so when
  // it shows again it goes to the bottom; and while you are at the bottom, it stays there as the
  // space around it changes (the rows above folding away, the keyboard).
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    let shown = el.clientHeight > 0;
    let atBottom = true;
    const onScroll = () => {
      atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    const sized = new ResizeObserver(() => {
      const now = el.clientHeight > 0;
      if (now && (!shown || atBottom)) el.scrollTop = el.scrollHeight;
      shown = now;
    });
    sized.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sized.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);
  // A phone (11-16, the owner): one + holds what sat on the bar (attach, the Forge, reading
  // answers aloud, voice chat), as the Claude app does.
  const [plus, setPlus] = useState(false);
  // A touch screen: a scroll handle you can hold and drag through the conversation.
  const grabbable = phone || isTouchOnly();

  const state = usage.data?.state;
  return (
    <div className={cx("flex min-h-0 flex-col font-cave", className)}>
      {ws.data && !connected && (
        <Notice>
          No AI is connected, so answers come straight from Hearth's records.{" "}
          <Link to="/agent" className="text-gold underline underline-offset-4">
            Connect one
          </Link>
        </Notice>
      )}
      {state === "reached" && (
        <Notice tone="warn">
          Today's AI budget is used up, so answers come from records until midnight.
        </Notice>
      )}
      {state === "warning" && (
        <Notice tone="warn">
          Most of today's AI budget is used ({Math.round((usage.data?.usedShare ?? 0) * 100)}%).
        </Notice>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ol
          ref={threadRef}
          className={cx(
            "min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto pb-4 [overflow-wrap:anywhere]",
            grabbable ? (phone ? "pr-5" : "pr-6") : "pr-1",
            threadClassName,
          )}
          aria-live="polite"
          data-testid="cave-thread"
        >
          {conversationId && convo.isPending && <Skeleton className="h-24" />}
          {!messages.length && !working && (
            <li>
              {empty ?? (
                <>
                  <p className="mb-4 max-w-md text-[0.9rem] leading-relaxed text-muted">
                    I look after your homelab: its machines, services, storage, backups, and the
                    projects that run it. I answer from what Hearth sees and remembers, and I say
                    which is which.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => send(s)}
                        className="min-h-11 rounded-full border border-line px-4 text-left text-[0.84rem] text-ink transition-colors duration-200 hover:border-gold/50 hover:text-gold"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </li>
          )}
          {messages.map((m, i) => (
            <Fragment key={i}>
              <Message
                index={i}
                m={m}
                onAnswer={i === waitingQuestion ? (key) => void send(key) : undefined}
              />
              {asks(m) && m.activity?.length ? (
                <Progress
                  activity={m.activity}
                  live={working && i === lastAsked}
                  plans={messages[i + 1]?.role !== "agent"}
                />
              ) : null}
              {m.role === "agent" && asks(messages[i - 1]) && messages[i - 1]!.activity && (
                <PlanCards activity={messages[i - 1]!.activity!} />
              )}
              {m.role === "agent" && <TodoPrompts answer={m} />}
              {m.role === "agent" && (
                <CredentialPrompts
                  answer={m}
                  asked={messages
                    .slice(0, i)
                    .reverse()
                    .find((x) => x.role === "you")}
                />
              )}
              {m.role === "agent" && (
                <Suggestions
                  answer={m}
                  asked={messages
                    .slice(0, i)
                    .reverse()
                    .find((x) => x.role === "you")}
                />
              )}
            </Fragment>
          ))}
          {conversationId && <ConversationPlans conversationId={conversationId} drawn={drawn} />}
          {ask.isPending &&
            ask.variables &&
            !messages.some((m) => m.text === ask.variables!.text) && (
              <li className="lair-you ml-auto max-w-[88%] rounded-2xl rounded-br-md border px-4 py-3 text-[0.92rem]">
                {ask.variables.text}
              </li>
            )}
          {working && !messages[lastAsked]?.activity?.length && (
            <li
              className="flex items-center gap-3 text-[0.86rem] text-muted"
              aria-busy="true"
              data-testid="working"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-gold motion-reduce:animate-none" />
              <span>
                Looking into it…
                <span className="block text-[0.76rem] text-faint">
                  You can close this; the answer will be here.
                </span>
              </span>
            </li>
          )}
          <HandoverPrompt conversationId={convo.data?.id ?? conversationId} />
          <VisiblePrompt conversationId={convo.data?.id ?? conversationId} />
          <JumpToLatest target={threadRef} as="li" />
        </ol>
        {grabbable && <ScrollHandle target={threadRef} />}
      </div>

      <form
        className="mt-2 shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        {failed && (
          <p role="alert" className="mb-2 text-[0.8rem] text-bad">
            Not sent: {failed}. Your message is still here; try again when you are connected.
          </p>
        )}
        <AttachedImages />
        {voiceNote && !voiceReady && (
          <div
            role="status"
            className="mb-2 flex items-start gap-3 rounded-lg border border-line-strong bg-bg/60 px-3 py-2 text-[0.82rem] text-ink"
            data-testid="voice-not-set-up"
          >
            <p className="flex-1 leading-snug">
              Voice isn&apos;t set up yet. {aiName} can talk and listen once a speech machine is
              connected; your AI agent can set it up for you.{" "}
              <Link to="/settings#cave" className="text-gold underline underline-offset-2">
                Set up voice
              </Link>
            </p>
            <button
              type="button"
              onClick={() => setVoiceNote(false)}
              aria-label="Close"
              className="-m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-faint hover:text-ink"
            >
              <X strokeWidth={1.75} className="h-4 w-4" />
            </button>
          </div>
        )}
        {mic.state === "listening" && (
          <div
            role="status"
            className="mb-2 flex items-center gap-3 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-[0.82rem] text-ink"
            data-testid="cave-listening"
          >
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad/60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-bad" />
            </span>
            <span className="min-w-0 flex-1">
              Listening, your words appear when you tap Done {Math.floor(mic.seconds / 60)}:
              {String(mic.seconds % 60).padStart(2, "0")}
              <span
                className="mt-1 block h-1 overflow-hidden rounded-full bg-line"
                aria-hidden="true"
              >
                <span
                  className="block h-full bg-gold transition-[width] duration-100"
                  style={{ width: `${Math.round(mic.level * 100)}%` }}
                />
              </span>
            </span>
            <button
              type="button"
              onClick={() => void mic.stop()}
              className="min-h-9 rounded-md bg-gold px-3 text-[0.8rem] font-medium text-bg hover:bg-gold-bright"
            >
              Done
            </button>
            <button
              type="button"
              onClick={() => {
                mic.cancel();
                setDraft(before.current);
              }}
              className="min-h-9 rounded-md px-2 text-[0.8rem] text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
        {mic.state === "transcribing" && (
          <p
            role="status"
            className="mb-2 text-[0.8rem] text-muted"
            data-testid="cave-transcribing"
          >
            Finishing your words…
          </p>
        )}
        {mic.error && (
          <p role="alert" className="mb-2 flex items-start gap-2 text-[0.8rem] text-bad">
            <span className="flex-1">{mic.error}</span>
            <button
              type="button"
              onClick={mic.clearError}
              aria-label="Dismiss"
              className="flex h-7 w-7 shrink-0 items-center justify-center text-faint hover:text-ink"
            >
              <X strokeWidth={1.5} className="h-3.5 w-3.5" />
            </button>
          </p>
        )}
        {speaking.status !== "idle" && (
          <p
            role="status"
            className="mb-2 flex items-center gap-2 text-[0.8rem] text-muted"
            data-testid="cave-speaking"
          >
            <Volume2 strokeWidth={1.5} className="h-4 w-4 text-gold" />
            <span className="flex-1">
              {speaking.status === "loading" ? "Getting the voice ready…" : `${aiName} is speaking`}
            </span>
            <button
              type="button"
              onClick={() => speaker.stop()}
              className="flex min-h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-gold hover:border-gold/60"
            >
              <Square strokeWidth={1.75} className="h-3 w-3" /> Stop
            </button>
          </p>
        )}
        {speaking.error && speaking.status === "idle" && (
          <p role="alert" className="mb-2 text-[0.8rem] text-bad" data-testid="cave-speak-error">
            Could not speak the answer: {speaking.error}
          </p>
        )}
        {convo.data?.remote && (
          // One line (11-20, the owner: on a phone the four-line notice covered much of the typing
          // space). The how-to is in its tooltip and in Ember's own message in the chat, which also
          // says how to turn it off.
          <p
            role="status"
            className="mb-2 flex items-center gap-2 rounded-lg border border-gold/40 bg-raised px-2.5 py-1 text-[0.8rem] text-ink"
            data-testid="cave-remote"
            title={`In the Claude app, open Code and pick ${convo.data.remote.title}. Type /rc to turn it off.`}
          >
            <Smartphone strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
            <b className="min-w-0 shrink truncate font-medium">
              Remote Control {convo.data.remote.connecting ? "is connecting" : "is on"}
            </b>
            <span className="min-w-0 flex-1 truncate text-muted" data-testid="cave-remote-title">
              {convo.data.remote.title}
            </span>
            {convo.data.remote.url && (
              <a
                href={convo.data.remote.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Claude"
                className="shrink-0 text-gold underline-offset-2 hover:underline"
              >
                <span className="sm:hidden">Open</span>
                <span className="hidden sm:inline">Open in Claude</span>
              </a>
            )}
          </p>
        )}
        {talk.on && (
          <div
            role="status"
            className="mb-2 flex items-start gap-2.5 px-1 text-[0.8rem] leading-snug text-muted"
            data-testid="talk-status"
            data-phase={talk.phase}
          >
            <span
              aria-hidden="true"
              className={cx(
                "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                talk.phase === "paused" ? "bg-faint" : "bg-tint-teal",
                (talk.phase === "listening" || talk.phase === "hearing") &&
                  "shadow-[0_0_8px_var(--color-tint-teal)]",
              )}
              style={
                talk.phase === "hearing"
                  ? { scale: (1 + Math.min(talk.level, 1) * 0.8).toFixed(3) }
                  : undefined
              }
            />
            <span className="min-w-0 flex-1">
              <b className="font-medium text-ink">Voice chat on.</b>{" "}
              {talk.phase === "listening" || talk.phase === "hearing"
                ? `Listening. Just talk; tap the ear so ${aiName} can't hear you.`
                : talk.phase === "waiting"
                  ? `${aiName} is working on it. The mic stays off until it's your turn.`
                  : talk.phase === "speaking"
                    ? `${aiName} is speaking. The mic opens when it finishes.`
                    : `Not listening: ${aiName} can't hear you, and still speaks its replies. Tap the ear to talk.`}
              {talk.note && <span className="mt-1 block text-bad">{talk.note}</span>}
            </span>
          </div>
        )}
        {showOn && show?.paused && (
          <p
            className="mb-2 flex flex-wrap items-center gap-2 text-[0.78rem] text-muted"
            data-testid="show-paused"
          >
            <span className="rounded-full border border-amber/50 px-2.5 py-1 text-amber">
              Following paused
            </span>
            <button
              type="button"
              onClick={() => resumeShow.mutate()}
              disabled={resumeShow.isPending}
              className="min-h-9 rounded-full border border-gold/50 px-3 text-gold hover:bg-gold/10"
              data-testid="show-resume"
            >
              Resume
            </button>
          </p>
        )}
        {showOn && show?.showing && !show.showing.here && (
          <p
            className="mb-2 flex flex-wrap items-center gap-2 text-[0.78rem] text-muted"
            data-testid="show-elsewhere"
          >
            <span>Showing on {show.showing.label}.</span>
            <button
              type="button"
              onClick={() => claimShow.mutate()}
              disabled={claimShow.isPending}
              className="min-h-9 rounded-full border border-gold/50 px-3 text-gold hover:bg-gold/10"
              data-testid="show-here"
            >
              Show here instead
            </button>
          </p>
        )}
        {focus && (
          <p
            className="mb-2 flex items-center gap-2 text-[0.76rem] text-muted"
            data-testid="cave-focus"
          >
            <span className="rounded-full border border-gold/40 px-2.5 py-1 text-gold">
              About: {focus.label}
            </span>
            {onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                aria-label={`Stop asking about ${focus.label}`}
                className="flex h-8 w-8 items-center justify-center rounded-full text-faint hover:text-gold"
              >
                <X strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            )}
          </p>
        )}
        {phone && plus && (
          <div
            id={`${draftKey}-plus`}
            role="group"
            aria-label="Add to your message"
            className="mb-2 rounded-xl border border-line-strong bg-raised p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            data-testid="chat-plus-menu"
          >
            <AttachButton
              label="Attach a photo or file"
              onText={(f) => setDraft((d) => `${d}${fileBlock(f)}`)}
              onError={setFailed}
              onPicked={() => setPlus(false)}
            />
            <button
              type="button"
              onClick={() => {
                const words = draft.trim();
                setPlus(false);
                if (
                  send(
                    words
                      ? `${words}\n\n(Open this in the Forge.)`
                      : "Open what we're working on in the Forge so I can go through it.",
                  )
                )
                  setDraft("");
              }}
              disabled={working}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.92rem] text-ink hover:bg-gold/10 disabled:opacity-40"
              data-testid="forge-button"
            >
              <Anvil strokeWidth={1.5} className="h-5 w-5 text-gold" />
              Open it in the Forge
            </button>
            {voiceReady && !talk.on && (
              <button
                type="button"
                onClick={() => setSpeakAnswers(!speakAll)}
                aria-pressed={speakAll}
                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.92rem] text-ink hover:bg-gold/10"
              >
                {speakAll ? (
                  <Volume2 strokeWidth={1.5} className="h-5 w-5 text-gold" />
                ) : (
                  <VolumeX strokeWidth={1.5} className="h-5 w-5 text-faint" />
                )}
                Read answers aloud: {speakAll ? "on" : "off"}
              </button>
            )}
            {voiceReady && !talk.on && (
              <button
                type="button"
                onClick={() => {
                  setPlus(false);
                  startTalk();
                }}
                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.92rem] text-ink hover:bg-gold/10"
                data-testid="talk-start"
              >
                <AudioLines strokeWidth={1.75} className="h-5 w-5 text-gold" />
                Voice chat with {aiName}
              </button>
            )}
          </div>
        )}
        <div
          className={cx(
            "@container flex items-end gap-2 border border-line-strong bg-bg/80 p-1.5 focus-within:border-gold/60",
            phone
              ? "flex-nowrap rounded-2xl"
              : "flex-wrap justify-end rounded-xl @[20rem]:flex-nowrap @[20rem]:justify-start",
          )}
        >
          {phone && (
            <button
              type="button"
              onClick={() => setPlus(!plus)}
              aria-expanded={plus}
              aria-controls={`${draftKey}-plus`}
              aria-label="Attach, the Forge and voice"
              title="Attach, the Forge and voice"
              className={cx(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors duration-200",
                plus ? "border-gold bg-gold/15 text-gold" : "border-line-strong text-muted",
              )}
              data-testid="chat-plus"
            >
              <Plus
                strokeWidth={1.75}
                className={cx("h-5 w-5 transition-transform", plus && "rotate-45")}
              />
            </button>
          )}
          <label htmlFor={`${draftKey}-input`} className="sr-only">
            {label}
          </label>
          <textarea
            ref={inputRef}
            id={`${draftKey}-input`}
            rows={1}
            // Grammarly's marks sit on a layer above the box and were left behind when dictated
            // words replaced the text (pink lines until Send, 10-26), and its button covered
            // Send. Hearth corrects dictation itself (writing assistance), so it stays out here.
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            value={draft}
            maxLength={20000}
            // Let the phone's own keyboard capitalize and correct as it normally does.
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            onChange={(e) => {
              setDraft(e.target.value);
              if (waitNote) setWaitNote(false);
              assist.onInput(e.target.value, e.nativeEvent);
            }}
            {...assist.composition}
            onKeyDown={(e) => {
              // A keyboard: Enter sends, Shift+Enter is a new line. A phone's on-screen
              // keyboard (a touchscreen and no mouse or trackpad): Enter is a new line, the button sends.
              // A browser that reports no pointer at all (a remote desktop) is a keyboard.
              // Never while a word is still being composed (phone keyboards, IMEs).
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              if (isTouchOnly()) return;
              e.preventDefault();
              send(draft);
            }}
            placeholder={placeholder ?? `Ask ${aiName}…`}
            className={cx(
              "min-h-11 flex-1 resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-[0.95rem] leading-snug text-ink placeholder:text-faint focus:outline-none",
              phone ? "min-w-0 basis-auto" : "max-h-40 basis-full @[20rem]:basis-auto",
            )}
          />
          {!phone && (
            <AttachButton
              onText={(f) => setDraft((d) => `${d}${fileBlock(f)}`)}
              onError={setFailed}
            />
          )}
          {!phone && (
            <button
              type="button"
              onClick={() => {
                // With words in the box: send them, asked for in the Forge. Empty: this conversation.
                const words = draft.trim();
                if (
                  send(
                    words
                      ? `${words}\n\n(Open this in the Forge.)`
                      : "Open what we're working on in the Forge so I can go through it.",
                  )
                )
                  setDraft("");
              }}
              disabled={working}
              aria-label={`Open it in the Forge: ${aiName} lays it out beside the chat for you to go through`}
              title="Open it in the Forge"
              // Only when the box has room: a narrow chat beside a sheet keeps its typing space.
              className="hidden h-11 w-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors duration-200 hover:text-gold disabled:opacity-40 @[20rem]:flex"
              data-testid="forge-button"
            >
              <Anvil strokeWidth={1.5} className="h-5 w-5" />
            </button>
          )}
          {!voiceReady && voiceKnown && (
            <button
              type="button"
              onClick={() => setVoiceNote(!voiceNote)}
              aria-expanded={voiceNote}
              aria-label={`Speak to ${aiName}: voice isn't set up yet`}
              title="Voice isn't set up yet"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-faint transition-colors duration-200 hover:text-ink"
              data-testid="mic-not-set-up"
            >
              <Mic strokeWidth={1.75} className="h-5 w-5" />
            </button>
          )}
          {voiceReady && (
            <>
              {!talk.on && !phone && (
                <button
                  type="button"
                  onClick={() => setSpeakAnswers(!speakAll)}
                  aria-pressed={speakAll}
                  aria-label={speakAll ? "Stop reading answers aloud" : "Read every answer aloud"}
                  title={speakAll ? "Answers are read aloud" : "Answers are not read aloud"}
                  className={cx(
                    "flex h-11 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
                    speakAll ? "text-gold" : "text-faint hover:text-ink",
                  )}
                >
                  {speakAll ? (
                    <Volume2 strokeWidth={1.5} className="h-5 w-5" />
                  ) : (
                    <VolumeX strokeWidth={1.5} className="h-5 w-5" />
                  )}
                </button>
              )}
              {(!phone || talk.on) && (
                <button
                  type="button"
                  onClick={startTalk}
                  aria-pressed={talk.on}
                  aria-label={talk.on ? "End voice chat" : `Voice chat with ${aiName}`}
                  title={
                    talk.on
                      ? "Voice chat on: just talk, replies are spoken. Click to end it."
                      : `Voice chat: just talk back and forth with ${aiName}, right here`
                  }
                  className={cx(
                    "flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-gold transition-colors duration-200 hover:text-gold-bright",
                    talk.on && "bg-gold/20",
                  )}
                  data-testid="talk-start"
                >
                  <AudioLines strokeWidth={1.75} className="h-5 w-5" />
                </button>
              )}
              {talk.on && (
                <button
                  type="button"
                  onClick={() => talk.setHearing(!talk.hearing)}
                  aria-pressed={talk.hearing}
                  aria-label={
                    talk.hearing ? `Stop ${aiName} hearing you` : `Let ${aiName} hear you`
                  }
                  title={
                    talk.hearing
                      ? "Listening: it hears you whenever it's your turn. Click so it can't hear you."
                      : "Not listening: it can't hear you, and still speaks its replies. Click to let it hear you."
                  }
                  className={cx(
                    "flex h-11 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
                    talk.hearing ? "bg-tint-teal/20 text-tint-teal" : "text-faint hover:text-ink",
                  )}
                  data-testid="talk-ear"
                >
                  {talk.hearing ? (
                    <Ear strokeWidth={1.75} className="h-5 w-5" />
                  ) : (
                    <EarOff strokeWidth={1.75} className="h-5 w-5" />
                  )}
                </button>
              )}
              {!talk.on && (
                <button
                  type="button"
                  onClick={() => (mic.state === "listening" ? void mic.stop() : startMic())}
                  disabled={mic.state === "starting" || mic.state === "transcribing"}
                  aria-pressed={mic.state === "listening"}
                  aria-label={mic.state === "listening" ? "Stop listening" : `Speak to ${aiName}`}
                  className={cx(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition-colors duration-200 disabled:opacity-40",
                    mic.state === "listening"
                      ? "border-bad bg-bad/15 text-bad"
                      : "border-line-strong text-gold hover:border-gold/60",
                  )}
                >
                  <Mic
                    strokeWidth={1.75}
                    className={cx(
                      "mic-buzz h-5 w-5 transition-transform duration-75",
                      mic.state === "listening" &&
                        mic.level > 0.06 &&
                        "animate-[mic-buzz_0.18s_linear_infinite]",
                    )}
                    style={
                      mic.state === "listening"
                        ? { scale: (1 + Math.min(mic.level, 1) * 0.35).toFixed(3) }
                        : undefined
                    }
                  />
                </button>
              )}
            </>
          )}
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim() && mic.state !== "listening"}
            title={working ? "Stop what I'm doing and send this instead" : undefined}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gold text-bg transition-colors duration-200 hover:bg-gold-bright disabled:opacity-40"
          >
            <ArrowUp strokeWidth={1.75} className="h-5 w-5" />
          </button>
          {working && conversationId && (
            <button
              type="button"
              onClick={() => void stopNow()}
              disabled={stopping}
              aria-label={`Stop ${aiName}`}
              title={`Stop what ${aiName} is doing`}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-bad/60 px-3 text-[0.82rem] font-semibold text-bad transition-colors hover:bg-bad/15 disabled:opacity-50"
              data-testid="cave-stop"
            >
              <Square strokeWidth={2} className="h-3.5 w-3.5 fill-current" />
              {stopping ? "Stopping" : "Stop"}
            </button>
          )}
        </div>
        {/* A phone: in the chat menu, so the conversation keeps the room (11-18). */}
        {connected && !modelInMenu && <ModelSwitch />}
        {waitNote && working && (
          <p role="status" className="mt-1.5 text-[0.76rem] text-muted" data-testid="cave-wait">
            Stopping what I was doing; your message goes next.
          </p>
        )}
        {assist.applied && !(waitNote && working) && (
          <p
            className="mt-1.5 flex flex-wrap items-center gap-x-2 rounded-lg border border-line-strong bg-raised px-2.5 py-1 text-[0.84rem] font-medium text-ink shadow-md"
            data-testid="cave-corrections"
          >
            <span>
              <span className="text-muted">Fixed</span>{" "}
              {assist.applied.changes
                .slice(0, 3)
                .map((c) => `${c.from} → ${c.to}`)
                .join(", ")}
              {assist.applied.changes.length > 3
                ? ` and ${assist.applied.changes.length - 3} more`
                : ""}
            </span>
            <button
              type="button"
              onClick={assist.undo}
              className="min-h-8 rounded-md border border-gold/70 bg-gold/15 px-2 font-semibold text-gold hover:bg-gold/25"
            >
              Undo
            </button>
          </p>
        )}
        {assist.grammar.length > 0 && !(waitNote && working) && (
          <ul
            className="mt-1.5 flex flex-col gap-1 rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 shadow-md"
            data-testid="cave-grammar"
            aria-label="Grammar suggestions"
          >
            {assist.grammar.slice(0, 3).map((g) => (
              <li
                key={`${g.start}-${g.original}-${g.message}`}
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.84rem] font-medium text-ink"
              >
                <span title={g.message}>
                  <span className="text-ink line-through decoration-bad/70">{g.original}</span>{" "}
                  <span className="text-muted">→</span>
                </span>
                {g.replacements.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => assist.applyGrammar(g, r)}
                    aria-label={`Change "${g.original}" to "${r || "nothing"}": ${g.message}`}
                    className="min-h-8 rounded-md border border-gold bg-gold px-2 font-semibold text-bg hover:brightness-110"
                  >
                    {r || "remove"}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => assist.dismissGrammar(g)}
                  aria-label={`Keep "${g.original}"`}
                  className="min-h-8 rounded-md border border-line-strong px-2 text-ink hover:bg-bg/60"
                >
                  Keep
                </button>
              </li>
            ))}
            {assist.grammar.length > 3 && (
              <li className="text-[0.78rem] text-muted">
                {assist.grammar.length - 3} more after these
              </li>
            )}
          </ul>
        )}
        {assist.grammarState === "failed" && (
          <p
            role="status"
            className="mt-1.5 text-[0.78rem] text-muted"
            data-testid="cave-grammar-failed"
          >
            Enhanced grammar help could not load on this device; Basic fixes still work.
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * Which Claude model answers here (the same setting as Settings, Ember, Model for questions), so
 * switching to Fable for something delicate, or Haiku for something quick, is one tap.
 */
export function ModelSwitch() {
  const usage = useAiUsage();
  const set = useSetBudget();
  const current = usage.data?.budget.questionModel;
  if (!current) return null;
  const known = CLAUDE_MODELS.some((m) => m.value === current);
  return (
    <div className="mt-1 flex justify-end">
      <label className="flex items-center gap-1.5 text-[0.76rem] text-faint">
        Model
        <select
          value={current}
          disabled={set.isPending}
          onChange={(e) => set.mutate({ questionModel: e.target.value })}
          title="Which Claude model answers (also in Settings, Ember)"
          className="min-h-9 rounded-md border border-line bg-bg px-1.5 text-[0.78rem] text-muted hover:text-ink focus:border-gold/60 focus:outline-none disabled:opacity-50"
          data-testid="cave-model"
        >
          {CLAUDE_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.short}
            </option>
          ))}
          {!known && <option value={current}>{current}</option>}
        </select>
      </label>
    </div>
  );
}
