import { aiDisplayName } from "@dragon-control/core";
import { useDashboardBriefing } from "../../data/findings";
import { NEEDS_YOU_HREF, attentionItems } from "../../lib/attention";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { usePanelHref } from "../desk/links";
import { Bell, ChevronRight, Search } from "lucide-react";
import { useWorkspace } from "../../data/api";
import { cx } from "../ui";
import { pageTitle } from "@dragon-control/core";
import { useCave } from "./cave-context";
import { WarRoomButton } from "./WarRoomButton";
import { ForgeChip } from "../workspace/forge";
import { LairButton } from "./LairButton";
import { PageHelp } from "../help/FeatureHelp";
import { UpdateButton, useUpdateCount } from "../updates/UpdateNotice";
import { ScreenCapture } from "./ScreenCapture";

/** Overall state in one line: healthy, or how many things need you. */
export function useOverall() {
  const { data: ws } = useWorkspace();
  const { data: briefing } = useDashboardBriefing(undefined);
  if (!ws) return undefined;
  const open = ws.incidents.filter((i) => i.status !== "resolved");
  const needYou = attentionItems(ws, briefing).count;
  const down = ws.services.filter((s) => s.health === "offline" && !s.stopped).length;
  return {
    needYou,
    down,
    label: down
      ? `${down} ${down === 1 ? "service" : "services"} down`
      : needYou
        ? `${needYou} ${needYou === 1 ? "thing needs" : "things need"} you`
        : open.length
          ? "Handling a problem"
          : "All systems online",
    tone: down ? ("bad" as const) : needYou || open.length ? ("warn" as const) : ("ok" as const),
    sample: ws.demoScenario != null,
  };
}

/**
 * Desktop top bar: where you are, one box to find a service or ask
 * Ember (Ctrl+K), the overall state, and what needs you.
 */
export function TopBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: ws } = useWorkspace();
  const aiName = aiDisplayName(ws?.aiName);
  const cave = useCave();
  const overall = useOverall();
  // The bell: what needs you, and a new Hearth waiting to be installed.
  const bellCount = (overall?.needYou ?? 0) + useUpdateCount();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const title = pageTitle(pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const services = ws ? [...ws.services, ...ws.inactiveServices] : [];
  const matches = q.trim()
    ? services.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6)
    : [];

  const panelHref = usePanelHref();
  return (
    <header className="sticky top-0 z-30 hidden h-16 items-center gap-3 border-b border-gold/15 bg-bg/85 px-4 backdrop-blur-md md:flex lg:gap-5 lg:px-6">
      <p className="flex shrink-0 items-center gap-2 text-[0.95rem] text-ink">
        <span className="font-display text-[1.2rem] text-gold">{title}</span>
      </p>
      <form
        role="search"
        className="relative max-w-xl flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          const text = q.trim();
          if (!text) return;
          const exact = services.find((s) => s.name.toLowerCase() === text.toLowerCase());
          if (exact) navigate(panelHref(`service:${exact.id}`)!);
          else cave.ask(text, { typed: true });
          setQ("");
          inputRef.current?.blur();
        }}
      >
        <label className="flex min-h-10 items-center gap-2.5 rounded-lg border border-line-strong bg-panel/80 px-3 text-faint focus-within:border-gold/60">
          <Search strokeWidth={1.5} className="h-4 w-4" />
          <span className="sr-only">Find a service, or start a question</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search services, or ask ${aiName}…`}
            className="min-w-0 flex-1 bg-transparent text-[0.88rem] text-ink placeholder:text-faint focus:outline-none"
          />
          <kbd className="hidden rounded border border-line px-1.5 text-[0.7rem] text-faint lg:inline">
            Ctrl K
          </kbd>
        </label>
        {matches.length > 0 && (
          <ul className="absolute inset-x-0 top-12 z-40 overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl">
            {matches.map((s) => (
              <li key={s.id}>
                <Link
                  to={panelHref(`service:${s.id}`)!}
                  onClick={() => setQ("")}
                  className="flex min-h-10 items-center justify-between px-3 text-[0.86rem] text-ink hover:bg-raised"
                >
                  {s.name}
                  <ChevronRight strokeWidth={1.5} className="h-4 w-4 text-faint" />
                </Link>
              </li>
            ))}
            <li className="border-t border-line px-3 py-2 text-[0.76rem] text-faint">
              Press Enter to ask {aiName} instead.
            </li>
          </ul>
        )}
      </form>
      <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap lg:gap-3">
        <ScreenCapture />
        {overall?.sample && (
          <Link
            to="/settings"
            title="You are looking at sample data, not your own systems."
            className="inline-flex min-h-8 items-center rounded-full border border-gold/40 px-3 text-[0.7rem] tracking-[0.14em] text-gold uppercase"
          >
            Sample<span className="ml-[0.4em] hidden lg:inline">data</span>
          </Link>
        )}
        {overall && (
          <Link
            to={overall.needYou ? NEEDS_YOU_HREF : "/incidents"}
            data-testid="overall-status"
            className={cx(
              "inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-[0.82rem]",
              overall.tone === "ok"
                ? "border-live/40 text-live"
                : overall.tone === "warn"
                  ? "border-amber/40 text-amber"
                  : "border-alert/40 text-alert",
            )}
          >
            <span
              className={cx(
                "h-2 w-2 rounded-full",
                overall.tone === "ok"
                  ? "bg-live"
                  : overall.tone === "warn"
                    ? "bg-amber"
                    : "bg-alert",
              )}
            />
            {overall.label}
          </Link>
        )}
        <UpdateButton />
        <ForgeChip />
        <WarRoomButton />
        <LairButton />
        <PageHelp compact />
        <Link
          to={overall?.needYou ? NEEDS_YOU_HREF : "/incidents"}
          aria-label={bellCount ? `${bellCount} need you` : "Nothing needs you"}
          data-testid="bell"
          className="relative flex h-10 w-10 items-center justify-center rounded-full text-muted hover:text-gold"
        >
          <Bell strokeWidth={1.35} className="h-5 w-5" />
          {bellCount ? (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber px-1 text-[0.65rem] font-semibold text-bg tabular">
              {bellCount}
            </span>
          ) : null}
        </Link>
      </div>
    </header>
  );
}
