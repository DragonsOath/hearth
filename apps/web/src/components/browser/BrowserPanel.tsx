import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Hand,
  KeyRound,
  Lock,
  RotateCw,
  Power,
  ShieldAlert,
} from "lucide-react";
import type { BrowserState } from "@dragon-control/core";
import { WorkspaceFrame } from "../command/WorkspaceFrame";
import { ToolImage } from "../panels/ToolImage";
import { cx } from "../ui";
import { useAiName } from "../../data/api";
import {
  pageSizeFor,
  useBrowserAction,
  useBrowserState,
  useBrowserViewport,
} from "../../data/browser";
import { clockTime } from "../../lib/format";
import { HandoverBar, OwnerSurface, VisibleAsk, VisibleSites } from "./Handover";
import { useShowSettings } from "../../data/show";
import { speaker } from "../../data/voice";

/**
 * Ember's Browser (checklist 45.12): the real browser Hearth runs for Ember, live. The picture is
 * the page's own screencast from Hearth's server; the orange ring is drawn only where Hearth
 * itself sent a click or typing, so nothing here is a simulation. Follow Ember keeps the view on
 * her tab; switch it off to look around another tab while she keeps working.
 */
export function BrowserPanel({ onClose }: { onClose: () => void }) {
  const state = useBrowserState().data;
  const aiName = useAiName();
  return (
    <WorkspaceFrame
      label="Ember's Browser"
      testId="browser-panel"
      icon={<ToolImage id="browser" />}
      title={`${aiName}'s Browser`}
      subtitle={<StatusLine state={state} />}
      tabs={[{ id: "live", label: "Live" }]}
      tab="live"
      onTab={() => undefined}
      onClose={onClose}
      capture={{ panel: "Ember's Browser" }}
    >
      <BrowserView state={state} aiName={aiName} />
    </WorkspaceFrame>
  );
}

function StatusLine({ state }: { state?: BrowserState }) {
  if (!state) return <span>Checking…</span>;
  if (state.status === "unavailable") return <span>{state.reason}</span>;
  if (state.status === "off")
    return <span>Not running. It starts when Ember opens a page, or open one yourself.</span>;
  if (state.status === "starting") return <span>Starting…</span>;
  return (
    <span>
      Live: a browser of its own, apart from yours. Your apps open signed in when you allow it in
      Secure Vault; changes there wait for your approval unless you chose to be asked only before
      serious steps.
      {state.idleClosesAt ? ` Closes itself at ${clockTime(state.idleClosesAt)} if unused.` : ""}
    </span>
  );
}

/**
 * Whether the page shown is one of the owner's apps, and if so whether Hearth signed the browser
 * in to it (through Secure Vault) or why not. Never a value: only the app's name and the reason.
 */
function SignInBadge({ state, url }: { state?: BrowserState; url?: string }) {
  let origin: string | undefined;
  try {
    origin = url ? new URL(url).origin : undefined;
  } catch {
    origin = undefined;
  }
  const s = origin ? state?.signedIn?.find((x) => x.origin === origin) : undefined;
  if (!s) return null;
  const on = s.state === "signed-in";
  return (
    <p
      data-testid="browser-signin"
      className={cx(
        "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.78rem] ring-1",
        on ? "text-ink ring-gold/30" : "text-muted ring-line",
      )}
    >
      {on ? (
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" aria-hidden />
      ) : (
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      <span>
        {on && /^No sign-in needed/.test(s.how)
          ? `${s.service} opened without a sign-in.`
          : on
            ? `Signed in to ${s.service} through Secure Vault (${s.how.charAt(0).toLowerCase()}${s.how.slice(1)}).`
            : `Not signed in to ${s.service}. `}
        {!on && <span className="text-muted">{s.how}</span>}
      </span>
    </p>
  );
}

function BrowserView({ state, aiName }: { state?: BrowserState; aiName: string }) {
  const act = useBrowserAction();
  const [following, setFollowing] = useState(true);
  const [chosen, setChosen] = useState<string | undefined>();
  const [address, setAddress] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const tabs = state?.tabs ?? [];
  const ember = tabs.find((t) => t.ember) ?? tabs[0];
  const viewed =
    (!following && chosen ? tabs.find((t) => t.id === chosen) : undefined) ?? ember ?? undefined;
  const live = state?.status === "live" && viewed;
  const pointer =
    state?.pointer &&
    viewed &&
    state.pointer.tab === viewed.id &&
    now - Date.parse(state.pointer.at) < 4000
      ? state.pointer
      : undefined;
  const blocked =
    state?.blocked && now - Date.parse(state.blocked.at) < 60_000 ? state.blocked : undefined;
  // Show & Tell: Ember's caption for the step, shown under the page and read aloud when asked.
  const show = useShowSettings().data;
  const caption =
    state?.caption && now - Date.parse(state.caption.at) < 60_000 ? state.caption : undefined;
  const [opened] = useState(() => Date.now() - 2000);
  const spoken = useRef(opened);
  useEffect(() => {
    if (!caption || !show?.speak || show.mode === "off") return;
    const at = Date.parse(caption.at);
    if (at <= spoken.current) return;
    spoken.current = at;
    // After the line being read, never over it (Show & Tell's own lines included).
    void speaker.queue(caption.text);
  }, [caption, show?.speak, show?.mode]);

  // The free space under the toolbar: the page takes its shape (a moment after it settles), and
  // the picture is drawn as large as fits, so the panel has no empty space around it.
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setRoom({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sizer = useBrowserViewport();
  const vw = state?.viewport.width ?? 1280;
  const vh = state?.viewport.height ?? 800;
  const isLive = state?.status === "live";
  useEffect(() => {
    if (!room || !isLive) return;
    const want = pageSizeFor(room.width, room.height);
    if (!want || (Math.abs(want.width - vw) < 8 && Math.abs(want.height - vh) < 8)) return;
    const t = window.setTimeout(() => sizer.mutate(want), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.width, room?.height, vw, vh, isLive]);
  const scale = room ? Math.min(room.width / vw, room.height / vh) : 0;
  // A live page keeps its own shape (it is resized to the panel, so it fills it); with nothing
  // live the screen takes all the room (11-11: the idle box left the panel's lower part empty).
  const frame = !live
    ? { width: "100%", height: "100%" }
    : room && scale > 0
      ? { width: Math.floor(vw * scale), height: Math.floor(vh * scale) }
      : { width: "100%", aspectRatio: `${vw} / ${vh}` };

  const go = (e: FormEvent) => {
    e.preventDefault();
    const url = (address ?? viewed?.url ?? "").trim();
    if (!url) return;
    act.mutate({ action: "open", url }, { onSuccess: () => setAddress(undefined) });
  };
  const btn =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted ring-1 ring-line hover:text-ink disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="browser-view">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-label="Back"
          data-hearth-target="browser:back"
          disabled={!live || act.isPending}
          onClick={() => act.mutate({ action: "back", tab: viewed?.id })}
          className={btn}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          data-hearth-target="browser:forward"
          disabled={!live || act.isPending}
          onClick={() => act.mutate({ action: "forward", tab: viewed?.id })}
          className={btn}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          data-hearth-target="browser:reload"
          disabled={!live || act.isPending}
          onClick={() => act.mutate({ action: "reload", tab: viewed?.id })}
          className={btn}
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <form onSubmit={go} className="flex min-w-[12rem] flex-1 gap-1.5">
          <input
            type="text"
            inputMode="url"
            aria-label="Address"
            data-hearth-target="browser:address"
            value={address ?? viewed?.url ?? ""}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => !address?.trim() && setAddress(undefined)}
            placeholder="Open a website: example.com"
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none"
          />
          <button
            type="submit"
            data-hearth-target="browser:go"
            disabled={act.isPending || !(address ?? viewed?.url ?? "").trim()}
            className="min-h-9 rounded-lg bg-gold px-3 text-[0.82rem] text-bg hover:bg-gold-bright disabled:opacity-40"
          >
            Go
          </button>
        </form>
        <button
          type="button"
          role="switch"
          aria-checked={following}
          data-hearth-target="browser:follow"
          onClick={() => setFollowing(!following)}
          className={cx(
            "min-h-9 rounded-lg px-2.5 text-[0.78rem] ring-1",
            following ? "text-gold ring-gold/40" : "text-muted ring-line hover:text-ink",
          )}
        >
          {following ? `Following ${aiName}` : `Follow ${aiName}`}
        </button>
        {state?.status === "live" && !state.handover && (
          <button
            type="button"
            data-hearth-target="browser:take-over"
            title={`Use the page yourself; ${aiName} waits until you give it back`}
            onClick={() => act.mutate({ action: "take-over" })}
            className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[0.78rem] text-muted ring-1 ring-line hover:text-ink"
          >
            <Hand className="h-3.5 w-3.5" aria-hidden />
            Take over
          </button>
        )}
        {state?.status === "live" && (
          <button
            type="button"
            aria-label="Close the browser"
            title="Close the browser (its profile is deleted)"
            data-hearth-target="browser:close"
            onClick={() => act.mutate({ action: "close" })}
            className={btn}
          >
            <Power className="h-4 w-4" />
          </button>
        )}
      </div>

      <SignInBadge state={state} url={viewed?.url} />
      {state?.window === "visible" && state.status === "live" && (
        <p className="text-[0.78rem] text-muted" data-testid="browser-visible-window">
          <span className="text-gold">Visible window</span> on this machine&apos;s screen. You can
          use it there too; it closes like the background one.
        </p>
      )}
      {state?.visibleAsk && <VisibleAsk state={state} />}
      {state?.handover && <HandoverBar state={state} />}

      {tabs.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Pages">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === viewed?.id}
              data-hearth-target={`browser:tab:${t.id.slice(0, 8)}`}
              onClick={() => {
                setChosen(t.id);
                setFollowing(t.ember);
              }}
              className={cx(
                "flex min-h-8 max-w-[14rem] shrink-0 items-center gap-1.5 truncate rounded-full px-3 text-[0.76rem] ring-1",
                t.id === viewed?.id ? "text-ink ring-gold/50" : "text-muted ring-line",
              )}
            >
              {t.ember && <span className="text-gold">{aiName}</span>}
              <span className="truncate">{t.title || t.url}</span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={area}
        className="flex min-h-[12rem] flex-1 items-start justify-center overflow-hidden"
        data-testid="browser-area"
      >
        <div
          className="relative shrink-0 overflow-hidden rounded-xl bg-bg ring-1 ring-line"
          style={frame}
          data-testid="browser-screen"
        >
          {live ? (
            <>
              <img
                key={viewed.id}
                src={`/api/browser/stream?tab=${encodeURIComponent(viewed.id)}`}
                alt={`Live: ${viewed.title || viewed.url}`}
                data-testid="browser-live"
                className="absolute inset-0 h-full w-full object-contain"
                draggable={false}
              />
              {pointer && (
                <span
                  key={pointer.at}
                  aria-hidden
                  data-testid="browser-pointer"
                  data-kind={pointer.kind}
                  className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-gold shadow-[0_0_12px_rgba(249,115,22,0.8)] motion-safe:animate-[ping_0.9s_ease-out_1]"
                  style={{
                    left: `${(pointer.x / state.viewport.width) * 100}%`,
                    top: `${(pointer.y / state.viewport.height) * 100}%`,
                  }}
                />
              )}
              {state.handover && <OwnerSurface tab={viewed.id} />}
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-[0.84rem] text-muted">
              <Globe className="h-8 w-8 text-faint" strokeWidth={1.4} />
              {state?.status === "unavailable"
                ? state.reason
                : `When ${aiName} uses the web, you watch it here, live.`}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-[1.5rem] space-y-1 text-[0.8rem]" aria-live="polite">
        {caption && show?.mode !== "off" && (
          <p className="text-[0.86rem] text-ink" data-testid="browser-caption">
            <span className="text-gold">{aiName}: </span>
            {caption.text}
          </p>
        )}
        {state?.last && (
          <p className="text-muted" data-testid="browser-last">
            <span className="text-faint">
              {state.last.by === "ember" ? aiName : "You"} · {clockTime(state.last.at)} ·{" "}
            </span>
            {state.last.label}
          </p>
        )}
        {blocked && (
          <p className="flex items-start gap-1.5 text-amber" data-testid="browser-blocked">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Not opened: {blocked.why}
          </p>
        )}
        {act.error && (
          <p className="text-amber" role="alert">
            {act.error instanceof Error ? act.error.message : String(act.error)}
          </p>
        )}
        {state && <VisibleSites state={state} />}
        {!following && ember && viewed?.id !== ember.id && (
          <button
            type="button"
            onClick={() => setFollowing(true)}
            className="text-gold hover:underline"
          >
            Back to {aiName}&apos;s page
          </button>
        )}
      </div>
    </div>
  );
}
