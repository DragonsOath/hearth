import { ExternalLink } from "lucide-react";
import type { HomelabBuild, HomelabStep } from "@dragon-control/core";
import { useConfirmBuildStep, useHomelabBuild, useProposeBuildStep } from "../../data/plan";
import { FormError } from "../../pages/auth/AuthFrame";
import { Button } from "../ui";

/**
 * Opens one of the plan's apps in its own window, not another browser tab (11-22: the beginner
 * never left Chrome). From Hearth's app window it is a window of its own; the panel link stays.
 */
export function openApp(url: string, id: string) {
  window.open(url, `hearth-app-${id}`, "popup,width=1280,height=860");
}

/** How to sign in to an app Hearth set up, in the words the owner needs. */
export function signInWords(b: Pick<HomelabBuild, "passwords" | "username">, app: string) {
  return b.passwords === "generate"
    ? `Sign in as ${b.username ?? "your username"}; Hearth made a strong password for it, in Secure Vault as "${app}: your login".`
    : "Sign in with the username and password you saved at the start.";
}

export type NextAction =
  | { kind: "approve"; step: HomelabStep }
  | { kind: "running"; step: HomelabStep }
  | { kind: "confirm"; step: HomelabStep }
  | { kind: "retry"; step: HomelabStep }
  | { kind: "open"; step: HomelabStep; url: string; label: string }
  | { kind: "needs"; step: HomelabStep }
  | { kind: "continue"; step: HomelabStep }
  | { kind: "built"; step?: HomelabStep }
  | { kind: "blocked"; why: string };

/**
 * The one next action of a build, from where it stands (build mode rule 1: every message in a
 * build ends with exactly one). In order: a plan waiting for you, one running, a step that
 * failed (the app answering: you say it works; else try again), something you need to do, the
 * next step to start, and everything built.
 */
export function nextAction(b: HomelabBuild): NextAction {
  const by = (st: HomelabStep["status"]) => b.steps.find((s) => s.status === st);
  const waiting = by("awaiting-approval");
  if (waiting) return { kind: "approve", step: waiting };
  const running = by("running");
  if (running) return { kind: "running", step: running };
  const failed = by("failed");
  if (failed) return { kind: failed.answering ? "confirm" : "retry", step: failed };
  const needs =
    b.steps.find((s) => s.status === "needs-you" && s.id !== "tailscale") ?? by("needs-you");
  if (needs?.need?.kind === "open-app")
    return { kind: "open", step: needs, url: needs.need.url, label: needs.need.label };
  if (needs) return { kind: "needs", step: needs };
  const next = b.steps.find((s) => s.id === b.next);
  if (next) return { kind: "continue", step: next };
  if (b.blocker) return { kind: "blocked", why: b.blocker };
  const app = b.steps.find((s) => s.url && (s.id === "jellyfin" || s.id === "plex"));
  return { kind: "built", ...(app ? { step: app } : {}) };
}

/** The app set up most recently, before where the build is now: its Open button and sign-in. */
function justDone(b: HomelabBuild): HomelabStep | undefined {
  const at = b.steps.findIndex((s) => s.status !== "done");
  const done = (at === -1 ? b.steps : b.steps.slice(0, at)).filter((s) => s.url);
  return done.at(-1);
}

/** A build was started and is not finished: build mode, in every conversation (11-22). */
export function buildUnfinished(b: HomelabBuild | undefined): b is HomelabBuild {
  return Boolean(
    b &&
    b.steps.length &&
    (b.conversationId || b.steps.some((s) => s.jobId || s.status === "done")) &&
    b.steps.some((s) => s.status !== "done"),
  );
}

/**
 * Under Ember's latest message in any chat while a build is unfinished, and first in a new chat:
 * the app just set up (Open it, and how to sign in), and the one next action, from the saved
 * plan (never from what the chat remembers). Whatever Ember said, the next step is always here.
 */
export function BuildNext({ fresh = false }: { fresh?: boolean }) {
  const build = useHomelabBuild();
  const propose = useProposeBuildStep();
  const confirm = useConfirmBuildStep();
  const b = build.data;
  if (!buildUnfinished(b)) return null;
  const a = nextAction(b);
  const ready = justDone(b);
  const showReady = ready && a.kind !== "built" && !(a.kind === "open" && a.step.id === ready.id);
  return (
    <li className="max-w-[96%] space-y-2 pl-11" data-testid="build-next-action" data-kind={a.kind}>
      {showReady && ready.url && (
        <div className="flex flex-wrap items-center gap-2 text-[0.84rem] text-muted">
          <span className="text-ink">{ready.name} is ready.</span>
          <Button
            tone="outline"
            onClick={() => openApp(ready.url!, ready.id)}
            data-testid="build-open-app"
          >
            <ExternalLink strokeWidth={1.75} className="h-4 w-4" aria-hidden /> Open {ready.name}
          </Button>
          <span>{signInWords(b, ready.name)}</span>
        </div>
      )}
      <div className="rounded-xl border border-gold/40 bg-gold/5 px-3 py-2.5" role="status">
        <p className="text-[0.72rem] tracking-[0.12em] text-gold uppercase">
          {fresh ? "Your build, where it left off" : "Next"}
        </p>
        {fresh && (
          <p className="mb-1 text-[0.84rem] text-muted" data-testid="build-where">
            Done:{" "}
            {b.steps
              .filter((s) => s.status === "done")
              .map((s) => s.name)
              .join(", ") || "nothing yet"}
            .
          </p>
        )}
        {a.kind === "approve" && (
          <p className="text-[0.9rem] text-ink">
            Approve {a.step.name}: its card is right above. Nothing happens until you do.
          </p>
        )}
        {a.kind === "running" && (
          <p className="text-[0.9rem] text-ink">
            {a.step.name} is being set up now. The next step follows here when it is done.
          </p>
        )}
        {a.kind === "confirm" && (
          <div className="space-y-2">
            <p className="text-[0.9rem] text-ink">
              {a.step.name} runs and answers, but Hearth&apos;s own check did not pass. Open it and
              sign in: if it works for you, say so and the build carries on.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate(a.step.id)}
                data-testid="build-confirm"
              >
                I checked it myself, it works: continue
              </Button>
              {a.step.url && (
                <Button tone="quiet" onClick={() => openApp(a.step.url!, a.step.id)}>
                  Open {a.step.name}
                </Button>
              )}
            </div>
          </div>
        )}
        {a.kind === "retry" && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.9rem] text-ink">{a.step.name} did not finish.</p>
            <Button
              tone="primary"
              disabled={propose.isPending}
              onClick={() => propose.mutate(a.step.id)}
              data-testid="build-retry"
            >
              Try {a.step.name} again
            </Button>
          </div>
        )}
        {a.kind === "open" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              tone="primary"
              onClick={() => openApp(a.url, a.step.id)}
              data-testid="build-open-app"
            >
              <ExternalLink strokeWidth={1.75} className="h-4 w-4" aria-hidden /> {a.label}
            </Button>
            <span className="text-[0.84rem] text-muted">Then come back here.</span>
          </div>
        )}
        {a.kind === "needs" && (
          <p className="text-[0.9rem] text-ink">
            {a.step.name}: {a.step.detail ?? "it needs you first"}{" "}
            <a href="/plan" className="text-gold underline underline-offset-2">
              Do it on the plan page
            </a>
          </p>
        )}
        {a.kind === "continue" && (
          <p className="mb-2 text-[0.9rem] text-ink">Ready to continue with {a.step.name}?</p>
        )}
        {a.kind === "continue" && (
          <Button
            tone="primary"
            disabled={propose.isPending}
            onClick={() => propose.mutate(a.step.id)}
            data-testid="build-continue"
          >
            {propose.isPending ? "Making the plan…" : `Continue: set up ${a.step.name}`}
          </Button>
        )}
        {a.kind === "blocked" && <p className="text-[0.9rem] text-ink">{a.why}</p>}
        {a.kind === "built" && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.9rem] text-live">Your homelab is built.</p>
            {a.step?.url && (
              <Button tone="primary" onClick={() => openApp(a.step!.url!, a.step!.id)}>
                Open {a.step.name}
              </Button>
            )}
          </div>
        )}
        <FormError error={propose.error ?? confirm.error} />
      </div>
    </li>
  );
}
