import { useAiName } from "../../data/api";
import { captureLabel } from "../capture/AttachedImages";
import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router";
import type { CaveAnswerMeta, CaveEvidence, CaveMessage } from "@dragon-control/core";
import { cx } from "../ui";
import { ago } from "../../lib/format";
import { inlineMarks } from "../../lib/inlineMarks";
import { usePanelHref } from "../desk/links";
import { HEARTH_LINK, useFeatureLink, type FeatureLink } from "../help/featureLink";
import { MessagePicture, useChatPictures } from "../shell/MessagePicture";
import { usePhone } from "../../lib/media";
import { PlayMessage } from "../shell/PlayMessage";

/**
 * How Ember messages look, wherever the conversation is shown: the
 * Ask page, the hub's expanded chat, or the panel beside a workspace.
 */

/** Where an evidence item opens in the app, when it has a page. */
export function hrefOf(ref?: string): string | undefined {
  if (!ref) return undefined;
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "service") return `/?service=${encodeURIComponent(id)}`;
  if (kind === "project") return `/?project=${encodeURIComponent(id)}`;
  if (kind === "incident") return `/incidents/${id}`;
  if (kind === "job") return `/jobs/${id}`;
  if (kind === "memory") return "/memory";
  if (kind === "host") return "/systems";
  if (ref === "backups") return "/backups";
  return undefined;
}

const MODE_LABEL: Record<CaveAnswerMeta["mode"], string> = {
  ai: "Answered from live state and records",
  records: "From Hearth's records",
  refusal: "Outside what I look after",
  status: "Status from Hearth",
  remote: "Remote Control, live with the Claude app",
};

/** The answer text: [E1] and [C1] citations become links to their evidence; **bold** and `code` show as such. */
/**
 * Plain answer text with the AI's [Open X](hearth:feature) links as in-app links. A link to
 * anything Hearth cannot open here keeps its words, without the link.
 */
function withHearthLinks(text: string, resolve: (id: string) => FeatureLink | undefined) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(HEARTH_LINK)) {
    out.push(<Fragment key={`t${last}`}>{inlineMarks(text.slice(last, m.index))}</Fragment>);
    const link = resolve(m[2]!);
    out.push(
      link ? (
        <Link
          key={`l${m.index}`}
          to={link.href}
          data-testid="answer-open-link"
          className="text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold"
        >
          {m[1]}
        </Link>
      ) : (
        <Fragment key={`l${m.index}`}>{m[1]}</Fragment>
      ),
    );
    last = m.index + m[0].length;
  }
  out.push(<Fragment key={`t${last}`}>{inlineMarks(text.slice(last))}</Fragment>);
  return out;
}

function AnswerText({ text, evidence }: { text: string; evidence: CaveEvidence[] }) {
  const hrefOf = usePanelHref();
  const featureLink = useFeatureLink();
  // Evidence marks: [E2] from what Hearth gathered first, [C2] from what the AI looked at.
  const parts = text.split(/(\[(?:E|C)\d+\])/g);
  return (
    <p className="text-[0.92rem] leading-relaxed whitespace-pre-wrap text-ink">
      {parts.map((p, i) => {
        const m = /^\[((?:E|C)\d+)\]$/.exec(p);
        if (!m) return <Fragment key={i}>{withHearthLinks(p, featureLink)}</Fragment>;
        const e = evidence.find((x) => x.id === m[1]);
        if (!e) return null;
        const href = hrefOf(e.ref);
        const mark = (
          <sup className="mx-0.5 text-[0.7rem] text-gold">{evidence.indexOf(e) + 1}</sup>
        );
        return href ? (
          <Link key={i} to={href} aria-label={`Evidence: ${e.label}`} className="hover:underline">
            {mark}
          </Link>
        ) : (
          <span key={i} title={e.label}>
            {mark}
          </span>
        );
      })}
    </p>
  );
}

function Evidence({ items }: { items: CaveEvidence[] }) {
  const hrefOf = usePanelHref();
  if (!items.length) return null;
  const groups: [string, CaveEvidence[]][] = [
    ["Checked live", items.filter((e) => e.kind === "live")],
    ["From records", items.filter((e) => e.kind === "record")],
    ["Remembered", items.filter((e) => e.kind === "memory")],
    ["Unreviewed notes (not approved; leads only)", items.filter((e) => e.kind === "unreviewed")],
  ];
  return (
    <details className="group mt-3" data-testid="evidence">
      <summary className="flex min-h-11 cursor-pointer list-none items-center text-[0.8rem] text-muted hover:text-gold">
        Evidence · {items.length}
      </summary>
      <div className="space-y-3 pb-1">
        {groups
          .filter(([, list]) => list.length)
          .map(([title, list]) => (
            <div key={title}>
              <p className="mb-1 text-[0.72rem] tracking-[0.12em] text-faint uppercase">{title}</p>
              <ul className="space-y-1">
                {list.map((e) => {
                  const href = hrefOf(e.ref);
                  const n = items.indexOf(e) + 1;
                  const body = (
                    <>
                      <span className="text-gold">{n}</span> {e.label}
                      {e.at ? (
                        <span className="text-faint"> · {ago(e.at).toLowerCase()}</span>
                      ) : null}
                    </>
                  );
                  return (
                    <li key={`${e.id}-${n}`} className="text-[0.82rem] leading-relaxed text-muted">
                      {href ? (
                        <Link to={href} className="hover:text-gold">
                          {body}
                        </Link>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
      </div>
    </details>
  );
}

/**
 * A question Claude Code asks in a Remote Control session (/rc), such as its one-time Full access
 * warning: Hearth writes it as a note ("Claude Code is asking: ..."). Shown as a card with a
 * button per answer (11-08: /rc "isn't working"; the question was one faint line).
 */
export function remoteQuestion(text: string) {
  if (!text.startsWith("Claude Code is asking: ")) return undefined;
  const lines = text.split("\n");
  const title = lines[0]!.slice("Claude Code is asking: ".length);
  const details: string[] = [];
  const options: { key: string; label: string }[] = [];
  let question = "";
  for (const line of lines.slice(1)) {
    const opt = /^(\d+)\. (.+)$/.exec(line);
    if (line.startsWith("> ")) details.push(line.slice(2));
    else if (opt) options.push({ key: opt[1]!, label: opt[2]! });
    else if (!options.length && !question) question = line;
  }
  return options.length ? { title, details, question, options } : undefined;
}

function RemoteQuestion({
  q,
  onAnswer,
}: {
  q: NonNullable<ReturnType<typeof remoteQuestion>>;
  onAnswer?: (key: string) => void;
}) {
  return (
    <li
      className="mx-auto w-full max-w-xl rounded-xl border border-gold/50 bg-gold/5 p-3 text-[0.86rem]"
      data-testid="rc-question"
    >
      <p className="text-[0.7rem] tracking-[0.12em] text-gold uppercase">Remote Control</p>
      <p className="mt-1 font-semibold text-ink">{q.title}</p>
      {q.details.map((d, i) => (
        <p key={i} className="mt-1 text-muted">
          {d}
        </p>
      ))}
      {q.question && <p className="mt-2 text-ink">{q.question}</p>}
      {onAnswer ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {q.options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => onAnswer(o.key)}
              className="min-h-10 rounded-lg border border-gold/60 px-3 text-[0.84rem] text-gold hover:bg-gold/15"
              data-testid="rc-answer"
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-faint">Answered.</p>
      )}
    </li>
  );
}

export function Message({
  m,
  onAnswer,
  index,
}: {
  m: CaveMessage;
  /** Answers a Remote Control question (only the one still waiting gets this). */
  onAnswer?: (key: string) => void;
  /** Its place in the thread: a search hit opens the thread here (data-msg-index). */
  index?: number;
}) {
  const aiName = useAiName();
  // A phone (11-18, the owner): the pictures' columns cost the words too much room.
  const phone = usePhone();
  const pictures = useChatPictures() && !phone;
  if (m.role === "you") {
    return (
      <li
        className="ml-auto flex max-w-[92%] items-start gap-2.5"
        data-testid="your-message"
        data-msg-index={index}
      >
        <div className="min-w-0 flex-1">
          <div className="lair-you rounded-2xl rounded-br-md border px-4 py-3 text-[0.92rem] leading-relaxed whitespace-pre-wrap">
            <span className="sr-only">You: </span>
            {m.text}
          </div>
          {m.attachments?.length ? (
            <div className="mt-1.5 flex flex-wrap justify-end gap-1.5" data-testid="message-images">
              {m.attachments.map((a) => (
                <a
                  key={a.id}
                  href={`/api/attachments/${encodeURIComponent(a.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg border border-gold/30"
                >
                  <img
                    src={`/api/attachments/${encodeURIComponent(a.id)}`}
                    alt={`Attached capture: ${captureLabel(a)}`}
                    className="h-20 max-w-[12rem] object-cover object-top"
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          ) : null}
          <p className="mt-1 flex items-center justify-end gap-x-1 text-[0.72rem] text-faint">
            <CopyAnswer text={m.text} label="Copy your message" />
            <span className="tabular">{clock(m.at)}</span>
          </p>
        </div>
        {pictures && <MessagePicture who="you" />}
      </li>
    );
  }
  // Hearth's own instruction to the AI (an automatic follow-up): never shown, only Ember's reply.
  if (m.hidden) return null;
  if (m.role === "note") {
    const q = remoteQuestion(m.text);
    if (q) return <RemoteQuestion q={q} onAnswer={onAnswer} />;
    return (
      <li
        className="text-center text-[0.82rem] whitespace-pre-line text-faint"
        data-msg-index={index}
      >
        {m.text}
      </li>
    );
  }
  const meta = m.meta;
  const evidence = m.evidence ?? [];
  return (
    <li
      className={cx("flex gap-3", phone ? "max-w-full" : "max-w-[96%]")}
      data-testid="answer"
      data-msg-index={index}
    >
      {pictures && <MessagePicture who="ai" className="mt-6" />}
      <div className="min-w-0 flex-1">
        <p
          className={cx(
            "mb-1.5 text-[0.7rem] tracking-[0.12em] uppercase",
            meta?.mode === "refusal"
              ? "text-faint"
              : meta?.mode === "records"
                ? "text-muted"
                : "text-gold",
          )}
        >
          <span className="sr-only">{aiName}: </span>
          {meta ? MODE_LABEL[meta.mode] : aiName}
        </p>
        <div className="lair-ember rounded-2xl rounded-tl-md border px-4 py-3">
          <AnswerText text={m.text} evidence={evidence} />
          {meta?.link && /^https:\/\//.test(meta.link.url) && (
            <a
              href={meta.link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/60 bg-gold/10 px-3 text-[0.86rem] text-gold hover:bg-gold/20"
              data-testid="answer-link"
            >
              {meta.link.label}
              <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
          <Evidence items={evidence} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[0.72rem] text-faint">
          <CopyAnswer text={m.text} />
          <PlayMessage text={m.text} messageKey={`lair:${m.at}`} />
          <span className="tabular">{clock(m.at)}</span>
          {meta?.error ? ` · The AI: ${meta.error}.` : ""}
          {/* The model and how much it read, never a price: answers on a plan aren't charged
              per use, and a price here reads as a bill (10-26). */}
          {meta?.model || meta?.tokens
            ? ` · ${[
                meta.model?.replace(/^claude-/, ""),
                meta.tokens ? `${(meta.tokens / 1000).toFixed(1)}k tokens` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}`
            : ""}
        </p>
      </div>
    </li>
  );
}

/** Copies a message as plain text: an answer's evidence marks ([E2]) are left out. */
export function CopyAnswer({ text, label = "Copy this answer" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const plain = text.replace(/\s*\[(?:E|C)\d+\]/g, "").trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plain);
    } catch {
      // Older or locked-down browsers: copy through a hidden text box.
      const box = document.createElement("textarea");
      box.value = plain;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      box.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : label}
      className="-ml-1.5 inline-flex min-h-8 items-center gap-1 rounded px-1.5 text-faint transition-colors duration-200 hover:text-gold"
    >
      {copied ? (
        <Check strokeWidth={1.75} className="h-3.5 w-3.5 text-live" />
      ) : (
        <Copy strokeWidth={1.5} className="h-3.5 w-3.5" />
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function clock(at: string) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function Notice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warn";
}) {
  return (
    <p
      role="status"
      className={cx(
        "mb-3 rounded-lg border px-4 py-2.5 text-[0.82rem] leading-relaxed",
        tone === "warn" ? "border-warn/40 text-warn" : "border-line text-muted",
      )}
    >
      {children}
    </p>
  );
}
