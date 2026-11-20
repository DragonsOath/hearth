import { useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Hand } from "lucide-react";
import type { BrowserState } from "@dragon-control/core";
import { Button } from "../ui";
import { api, useAiName } from "../../data/api";
import { useBrowserAction, useBrowserInput } from "../../data/browser";
import { usePanelHref } from "../desk/links";

/** Keys sent to the page as keys (the rest of what you type goes as text). */
const KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
]);

/**
 * You have the page (checklist 45.18): what you click on the picture is clicked on the page, and
 * what you type is typed there. Nothing you type is kept or shown to Ember. On a phone, the box
 * below types into the page.
 */
export function OwnerSurface({ tab }: { tab?: string }) {
  const input = useBrowserInput();
  const [typed, setTyped] = useState("");
  const wheel = useRef({ dy: 0, timer: 0 });
  // Where on the picture itself (it is fitted inside the box, so there may be bars around it).
  const at = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const img = e.currentTarget.parentElement?.querySelector("img");
    let { left, top, width, height } = r;
    if (img?.naturalWidth && img.naturalHeight) {
      const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      width = img.naturalWidth * s;
      height = img.naturalHeight * s;
      left = r.left + (r.width - width) / 2;
      top = r.top + (r.height - height) / 2;
    }
    const fx = (e.clientX - left) / width;
    const fy = (e.clientY - top) / height;
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : undefined;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEYS.has(e.key)) {
      e.preventDefault();
      input.mutate({ kind: "key", key: e.key, tab });
    } else if (e.key.length === 1) {
      e.preventDefault();
      input.mutate({ kind: "type", text: e.key, tab });
    }
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    wheel.current.dy += e.deltaY;
    window.clearTimeout(wheel.current.timer);
    wheel.current.timer = window.setTimeout(() => {
      const dy = Math.round(wheel.current.dy);
      wheel.current.dy = 0;
      if (dy) input.mutate({ kind: "scroll", dy, tab });
    }, 120);
  };
  const send = () => {
    if (!typed) return;
    input.mutate({ kind: "type", text: typed, tab }, { onSuccess: () => setTyped("") });
  };
  return (
    <>
      <div
        role="application"
        aria-label="The page: click and type here"
        tabIndex={0}
        data-testid="browser-owner-surface"
        className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-gold"
        onClick={(e) => {
          e.currentTarget.focus();
          const where = at(e);
          if (where) input.mutate({ kind: "click", ...where, tab });
        }}
        onKeyDown={onKey}
        onWheel={onWheel}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text").slice(0, 500);
          if (text) {
            e.preventDefault();
            input.mutate({ kind: "type", text, tab });
          }
        }}
      />
      <form
        className="absolute inset-x-2 bottom-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          autoComplete="off"
          aria-label="Type into the page"
          data-testid="browser-owner-type"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Type into the page"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg/90 px-3 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!typed || input.isPending}
          className="min-h-9 rounded-lg bg-gold px-3 text-[0.82rem] text-bg hover:bg-gold-bright disabled:opacity-40"
        >
          Type
        </button>
        <button
          type="button"
          onClick={() => input.mutate({ kind: "key", key: "Enter", tab })}
          className="min-h-9 rounded-lg px-3 text-[0.82rem] text-ink ring-1 ring-line hover:ring-gold/40"
        >
          Enter
        </button>
      </form>
      {input.error && (
        <p
          role="alert"
          className="absolute inset-x-2 top-2 rounded-lg bg-bg/90 px-2 py-1 text-[0.78rem] text-amber"
        >
          {input.error instanceof Error ? input.error.message : String(input.error)}
        </p>
      )}
    </>
  );
}

/** The line over the page while you have it, with Give it back. */
export function HandoverBar({ state }: { state: BrowserState }) {
  const act = useBrowserAction();
  const aiName = useAiName();
  const h = state.handover;
  if (!h) return null;
  return (
    <div
      data-testid="browser-handover"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-gold/10 px-3 py-2 ring-1 ring-gold/40"
    >
      <Hand className="h-4 w-4 shrink-0 text-gold" aria-hidden />
      <p className="min-w-0 flex-1 text-[0.84rem] text-ink">
        {h.by === "ember" ? (
          <>
            <span className="text-gold">{aiName} needs you: </span>
            {h.reason}. Click and type on the page below, then give it back and {aiName} carries on.
          </>
        ) : (
          <>You have the page. {aiName} waits until you give it back.</>
        )}
      </p>
      <Button
        tone="primary"
        className="min-h-9 px-3.5"
        disabled={act.isPending}
        onClick={() => act.mutate({ action: "give-back" })}
      >
        Give it back
      </Button>
    </div>
  );
}

/**
 * Under the conversation that is waiting: Ember asked you to do something in her browser (a
 * CAPTCHA, a password, a sign-in). Open it, do it there, then give it back.
 */
export function HandoverPrompt({ conversationId }: { conversationId?: string }) {
  const aiName = useAiName();
  const href = usePanelHref();
  const act = useBrowserAction();
  const state = useQuery({
    queryKey: ["browser"],
    queryFn: () => api<BrowserState>("GET", "/api/browser/state"),
    refetchInterval: 3000,
    enabled: Boolean(conversationId),
  }).data;
  const h = state?.handover;
  if (!h || h.by !== "ember" || !conversationId || h.conversationId !== conversationId) return null;
  return (
    <li className="max-w-[96%] pl-11" data-testid="cave-browser-handover">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-gold/40 px-4 py-2.5">
        <p className="flex basis-full items-start gap-2 text-[0.86rem] text-ink">
          <Hand strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
          <span>
            {aiName} needs you in the browser: {h.reason}.
          </span>
        </p>
        <Link
          to={href("tool:browser") ?? "/?panels=tool:browser"}
          className="text-[0.84rem] text-gold hover:underline"
        >
          Open {aiName}&apos;s Browser
        </Link>
        <Button
          className="min-h-9 px-3.5"
          disabled={act.isPending}
          onClick={() => act.mutate({ action: "give-back" })}
        >
          Give it back
        </Button>
      </div>
    </li>
  );
}

/**
 * Ember asks to open a site in a visible browser window on this machine (checklist 45.19): the
 * site refuses Hearth's background browser. Open it once, always for that site, or not.
 */
export function VisibleAsk({ state, inChat }: { state: BrowserState; inChat?: boolean }) {
  const aiName = useAiName();
  const act = useBrowserAction();
  const ask = state.visibleAsk;
  if (!ask) return null;
  return (
    <div
      data-testid={inChat ? "cave-browser-visible-ask" : "browser-visible-ask"}
      className={
        inChat
          ? "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-gold/40 px-4 py-2.5"
          : "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-gold/10 px-3 py-2 ring-1 ring-gold/40"
      }
    >
      <p className="flex basis-full items-start gap-2 text-[0.86rem] text-ink">
        <AppWindow strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
        <span>
          <span className="text-gold">{ask.host}</span> refuses {aiName}&apos;s background browser.
          Open it in a visible browser window on this machine instead? Sign-ins and checks still
          come to you.
        </span>
      </p>
      <Button
        tone="primary"
        className="min-h-9 px-3.5"
        disabled={act.isPending}
        onClick={() => act.mutate({ action: "visible-yes" })}
      >
        Open it
      </Button>
      <Button
        className="min-h-9 px-3.5"
        disabled={act.isPending}
        onClick={() => act.mutate({ action: "visible-always" })}
      >
        Always for {ask.host}
      </Button>
      <Button
        className="min-h-9 px-3.5"
        disabled={act.isPending}
        onClick={() => act.mutate({ action: "visible-no" })}
      >
        No
      </Button>
    </div>
  );
}

/** Under the conversation that is waiting for your answer about a visible window. */
export function VisiblePrompt({ conversationId }: { conversationId?: string }) {
  const state = useQuery({
    queryKey: ["browser"],
    queryFn: () => api<BrowserState>("GET", "/api/browser/state"),
    refetchInterval: 3000,
    enabled: Boolean(conversationId),
  }).data;
  const ask = state?.visibleAsk;
  if (!state || !ask || !conversationId || ask.conversationId !== conversationId) return null;
  return (
    <li className="max-w-[96%] pl-11">
      <VisibleAsk state={state} inChat />
    </li>
  );
}

/** The sites you always allow in a visible window, each with Forget. */
export function VisibleSites({ state }: { state: BrowserState }) {
  const act = useBrowserAction();
  if (!state.visibleSites?.length) return null;
  return (
    <details className="text-[0.78rem] text-muted" data-testid="browser-visible-sites">
      <summary className="cursor-pointer hover:text-ink">
        Always allowed in a visible window ({state.visibleSites.length})
      </summary>
      <ul className="mt-1 space-y-1">
        {state.visibleSites.map((h) => (
          <li key={h} className="flex items-center gap-2">
            <span className="text-ink">{h}</span>
            <button
              type="button"
              className="text-gold hover:underline"
              onClick={() => act.mutate({ action: "forget-site", host: h })}
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
