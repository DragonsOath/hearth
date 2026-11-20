import { Link, useNavigate } from "react-router";
import { Check, X } from "lucide-react";
import type { GettingStartedItem } from "@dragon-control/core";
import { useAiName, useWorkspace } from "../data/api";
import { useGettingStarted, useMeetCove, useUpdateGettingStarted } from "../data/gettingStarted";
import { Button, LinkButton, cx } from "./ui";

/**
 * Getting started: what is left to set up, built by Hearth from what is really there.
 * Each step ticks itself when it is done, links to the page that does it, and can be dismissed.
 * Home shows it until it is finished or hidden; Settings always shows it.
 */

/**
 * "Meet Ember": starts the conversation, then opens it. Meeting needs the AI operator connected,
 * so until it is, this says so and links to Agents instead of offering a button that would fail.
 */
export function MeetButton({
  label,
  tone = "primary",
  className,
  before,
}: {
  label?: string;
  tone?: "primary" | "outline" | "quiet";
  className?: string;
  /** Runs first (the welcome marks itself done, so Home does not send you back to it). */
  before?: () => Promise<void>;
}) {
  const aiName = useAiName();
  const ws = useWorkspace();
  const meet = useMeetCove();
  const navigate = useNavigate();
  if (ws.data && !ws.data.operator.agentId)
    return (
      <div className={className} data-testid="meet-needs-operator">
        <p className="mb-2 text-[0.82rem] text-muted">
          {aiName} needs an AI service connected before it can look at your server.
        </p>
        <LinkButton to="/agent" tone={tone === "primary" ? "primary" : "outline"}>
          Connect your AI
        </LinkButton>
      </div>
    );
  return (
    <div className={className}>
      <Button
        tone={tone}
        disabled={meet.isPending}
        onClick={async () => {
          await before?.();
          meet.mutate(undefined, {
            onSuccess: (r) => navigate(`/ask/${encodeURIComponent(r.conversationId)}`),
          });
        }}
      >
        {meet.isPending ? "Starting…" : (label ?? `Meet ${aiName}`)}
      </Button>
      {meet.error && (
        <p role="alert" className="mt-2 text-[0.82rem] text-bad">
          {meet.error.message}{" "}
          <Link to="/agent" className="text-gold underline underline-offset-4">
            Agents
          </Link>
        </p>
      )}
    </div>
  );
}

function Step({
  item,
  settings,
  busy,
  onDismiss,
  onRestore,
}: {
  item: GettingStartedItem;
  settings: boolean;
  busy: boolean;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  return (
    <li
      className="flex items-start gap-3 py-3"
      data-testid="getting-started-item"
      data-state={item.done ? "done" : item.dismissed ? "dismissed" : "todo"}
    >
      <span
        aria-hidden
        className={cx(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
          item.done ? "border-live bg-live/15 text-live" : "border-line-strong",
        )}
      >
        {item.done && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cx(
            "text-[0.92rem]",
            item.done || item.dismissed ? "text-muted line-through" : "text-ink",
          )}
        >
          {item.kind === "meet" || item.done ? (
            item.title
          ) : (
            <Link to={item.href} className="hover:text-gold">
              {item.title}
            </Link>
          )}
          <span className="sr-only">
            {item.done ? " (done)" : item.dismissed ? " (dismissed)" : ""}
          </span>
        </p>
        <p className="mt-0.5 text-[0.8rem] leading-relaxed break-words text-faint">{item.detail}</p>
        {item.kind === "meet" && !item.done && !item.dismissed && (
          <MeetButton tone="outline" className="mt-2" />
        )}
      </div>
      {!item.done &&
        (item.dismissed ? (
          settings && (
            <Button tone="quiet" disabled={busy} onClick={onRestore}>
              Bring back
            </Button>
          )
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            aria-label={`Dismiss "${item.title}"`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-faint hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ))}
    </li>
  );
}

export function GettingStartedList({ settings = false }: { settings?: boolean }) {
  const list = useGettingStarted();
  const update = useUpdateGettingStarted();
  if (!list.data) return null;
  const l = list.data;
  // Home: only while there is something left and it is not hidden. Settings: always, everything.
  if (!settings && (l.hidden || l.finished)) return null;
  const items = settings ? l.items : l.items.filter((i) => !i.dismissed);
  // In Settings the surrounding section already carries the "Getting started" heading.
  const Frame = settings ? "div" : "section";
  return (
    <Frame
      aria-labelledby={settings ? undefined : "getting-started-title"}
      className={cx(!settings && "mb-8 rounded-2xl border border-line bg-panel p-4 sm:p-6")}
      data-testid="getting-started"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {!settings && (
          <h2 id="getting-started-title" className="eyebrow">
            Getting started
          </h2>
        )}
        <p className="text-[0.82rem] text-muted" data-testid="getting-started-left">
          {l.finished ? "All done." : `${l.remaining} left`}
        </p>
      </div>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <Step
            key={item.id}
            item={item}
            settings={settings}
            busy={update.isPending}
            onDismiss={() => update.mutate({ dismiss: item.id })}
            onRestore={() => update.mutate({ restore: item.id })}
          />
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {!settings && (
          <Button
            tone="quiet"
            disabled={update.isPending}
            onClick={() => update.mutate({ hidden: true })}
          >
            Hide this list
          </Button>
        )}
        {settings && l.hidden && (
          <Button disabled={update.isPending} onClick={() => update.mutate({ hidden: false })}>
            Show it on Home again
          </Button>
        )}
      </div>
    </Frame>
  );
}
