import { NEEDS_YOU_HREF } from "../lib/attention";
import { PhoneDock } from "./desk/PhoneDock";
import { TouchPicker } from "./shell/TouchPicker";
import { useEffect, useRef } from "react";
import { loadAddons } from "../lib/addons";
import { Link, Navigate, NavLink, Outlet, useLocation, useSearchParams } from "react-router";
import { Ellipsis, X } from "lucide-react";
import { useWorkspace } from "../data/api";
import { applyTheme, DEFAULT_THEME } from "../lib/theme";
import { isPhoneDevice } from "../lib/media";
import { cx, StatusDot, BrandMark } from "./ui";
import { mobilePrimaryNav, moreNav } from "./nav";
import { Sidebar } from "./shell/Sidebar";
import { TopBar, useOverall } from "./shell/TopBar";
import { PageHelp } from "./help/FeatureHelp";
import { CaveProvider, useCave } from "./shell/cave-context";
import { AddonSlot } from "./AddonSlot";
import "./show/cursor.css";
import { CaveOverlay } from "./cave/CavePanel";
import { PhoneLairButton, useOpenEmberChat } from "./shell/LairButton";
import { ApprovalDock } from "./jobs/ApprovalDock";
import { PlanNotices } from "./shell/PlanNotices";
import { UpdateNotice } from "./shell/UpdateNotice";
import { OpenInApp } from "./shell/OpenInApp";
import { BuildFinished } from "./plan/BuildFinished";
import { useViewingPcName } from "../lib/viewingPc";
import { useLayoutKeeper } from "../lib/layoutKeeper";
import { SCREEN_ID, ScreenCapture } from "./shell/ScreenCapture";

function MobileTopBar() {
  const overall = useOverall();
  return (
    // While a phone's chat fills the screen it steps aside (11-18, the owner: "the chat doesn't
    // need all that header"); what needs you and the Lair are in the chat's menu then.
    <header
      className="sticky top-0 z-20 border-b border-gold/15 bg-bg/90 backdrop-blur-md md:hidden"
      data-phone-collapse=""
      data-testid="phone-header"
    >
      <div className="flex h-16 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Hearth home">
          <BrandMark className="h-9 w-9" />
          <span className="text-[1.3rem] font-semibold tracking-[-0.01em] text-ink lowercase">
            hearth
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <ScreenCapture />
          <PageHelp compact />
          {overall && (
            <Link
              to={overall.needYou ? NEEDS_YOU_HREF : "/incidents"}
              className="flex items-center gap-2 text-[0.75rem] text-faint"
              data-testid="overall-status-phone"
            >
              <StatusDot health={overall.tone === "ok" ? "healthy" : "attention"} />
              {overall.tone === "ok" ? "Online" : overall.label}
            </Link>
          )}
          <PhoneLairButton />
        </div>
      </div>
      {overall?.sample && (
        <Link
          to="/settings"
          className="flex min-h-9 items-center justify-center gap-2 border-t border-line text-[0.72rem] tracking-[0.14em] text-gold uppercase"
        >
          Sample data{" "}
          <span className="text-faint normal-case tracking-normal">· not your systems</span>
        </Link>
      )}
    </header>
  );
}

function MobileTabBar() {
  const overall = useOverall();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const location = useLocation();
  const moreActive = moreNav.some((n) => location.pathname.startsWith(n.to));
  const openChat = useOpenEmberChat();
  // Ask is Ember's chat in the Lair (11-18); Home is everything else at the root.
  const here = new URLSearchParams(location.search);
  const asking =
    (location.pathname === "/" && here.get("view") === "chat") ||
    location.pathname === "/ask" ||
    location.pathname.startsWith("/ask/");

  useEffect(() => {
    dialogRef.current?.close();
  }, [location.pathname, location.search]);

  return (
    <>
      <nav
        aria-label="Primary"
        data-testid="tab-bar"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-gold/15 bg-bg/95 backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex max-w-lg">
          {mobilePrimaryNav.map((item) => {
            const Icon = item.icon;
            if (item.to === "/ask")
              return (
                <button
                  key={item.to}
                  type="button"
                  onClick={openChat}
                  aria-current={asking ? "page" : undefined}
                  data-testid="tab-ask"
                  className={cx(
                    "relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[0.7rem] tracking-wide",
                    asking ? "text-gold" : "text-faint",
                  )}
                >
                  <Icon strokeWidth={1.25} className="h-[22px] w-[22px]" />
                  {item.label}
                </button>
              );
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cx(
                    "relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[0.7rem] tracking-wide",
                    isActive && !(item.to === "/" && asking) ? "text-gold" : "text-faint",
                  )
                }
              >
                <Icon strokeWidth={1.25} className="h-[22px] w-[22px]" />
                {item.label}
              </NavLink>
            );
          })}
          <button
            type="button"
            onClick={() => dialogRef.current?.showModal()}
            className={cx(
              "relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[0.7rem] tracking-wide",
              moreActive ? "text-gold" : "text-faint",
            )}
          >
            <Ellipsis strokeWidth={1.25} className="h-[22px] w-[22px]" />
            More
            {overall?.needYou ? (
              <span
                className="absolute top-3 right-[calc(50%-18px)] h-1.5 w-1.5 rounded-full bg-amber"
                aria-label={`${overall.needYou} need you`}
              />
            ) : null}
          </button>
        </div>
      </nav>

      <dialog
        ref={dialogRef}
        aria-label="More"
        className="safe-bottom fixed inset-x-0 top-auto bottom-0 m-0 max-h-[80dvh] w-full max-w-none rounded-t-2xl border-t border-gold/30 bg-panel p-0 text-ink backdrop:bg-black/70 md:hidden"
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current.close();
        }}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <p className="eyebrow">More</p>
          <button
            type="button"
            aria-label="Close"
            onClick={() => dialogRef.current?.close()}
            className="flex h-11 w-11 items-center justify-center text-muted"
          >
            <X strokeWidth={1.25} className="h-5 w-5" />
          </button>
        </div>
        <ul className="grid grid-cols-2 px-3 pb-6">
          {moreNav.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cx(
                      "flex min-h-14 items-center gap-3 rounded-lg px-3 text-[0.92rem]",
                      isActive ? "text-gold" : "text-ink",
                    )
                  }
                >
                  <Icon strokeWidth={1.25} className="h-5 w-5 text-gold/80" />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </dialog>
    </>
  );
}

function Shell() {
  const { pathname, hash } = useLocation();
  const [params] = useSearchParams();
  const cave = useCave();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (hash) return;
    // Desktop scrolls inside the content area; phones scroll the page.
    window.scrollTo(0, 0);
    mainRef.current?.scrollTo(0, 0);
  }, [pathname, hash]);

  const hubName = useWorkspace().data?.instanceName;
  // A linked PC's window names that PC; your main PC's window names your Hearth.
  const instanceName = useViewingPcName() ?? hubName;
  useEffect(() => {
    document.title =
      instanceName && instanceName !== "Home" ? `${instanceName} · Hearth` : "Hearth";
  }, [instanceName]);

  // The command center uses the full width; other pages keep a readable column.
  const commandCenter = pathname === "/";
  const split =
    commandCenter && (params.has("project") || params.has("service") || params.has("panels"));

  return (
    // Desktop: the app fits the window (sidebar and top bar stay, the content area scrolls,
    // the desk fills exactly what is left). Phones keep natural page scrolling.
    <div
      id={SCREEN_ID}
      className="cc-backdrop flex min-h-screen md:h-dvh md:min-h-0 md:overflow-hidden"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col md:min-h-0">
        <TopBar />
        <MobileTopBar />
        <PhoneDock />
        <main
          id="main"
          ref={mainRef}
          className={cx(
            "w-full flex-1 md:min-h-0 md:overflow-y-auto",
            split && "md:overflow-hidden",
          )}
        >
          <div
            key={commandCenter ? "/" : pathname}
            className={cx(
              commandCenter ? "fade-in-flat" : "fade-in",
              commandCenter
                ? "h-full px-4 pt-5 pb-28 sm:px-6 md:pb-5 lg:px-7 lg:pt-6"
                : "mx-auto w-full max-w-[1080px] px-5 pt-10 pb-32 sm:px-10 md:pb-20 lg:px-14 lg:pt-12",
            )}
          >
            <Outlet />
          </div>
        </main>
      </div>
      <MobileTabBar />
      {/* Drop-downs on a touch screen open Hearth's own picker, not the phone's (11-15). */}
      <TouchPicker />
      {/* Show & Tell (Premium package): points at what Ember is looking at, when on. */}
      <AddonSlot name="app.presenter" fallback={null} />
      {/* Beside a workspace the chat is docked, so it is not also floated over it. */}
      {cave.expanded && !split && pathname !== "/ask" && !pathname.startsWith("/ask/") && (
        <CaveOverlay />
      )}
    </div>
  );
}

/**
 * Your theme (Settings > Themes), the same on every device you sign in from; a phone uses the
 * phones' own look when you set one (11-16).
 */
export function useSavedTheme() {
  const ws = useWorkspace();
  const theme = ws.data
    ? ((isPhoneDevice() ? ws.data.phoneTheme : undefined) ?? ws.data.theme ?? DEFAULT_THEME)
    : undefined;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
}

export function AppShell() {
  useSavedTheme();
  const ws = useWorkspace();
  // This browser's layout, kept on this Hearth so another Hearth can copy it.
  useLayoutKeeper(Boolean(ws.data) && !ws.data?.onboardingNeeded);
  // Add-ons' screens (the Premium package), once signed in; none installed is normal.
  useEffect(() => {
    if (ws.data) void loadAddons();
  }, [ws.data]);
  // A newly claimed installation starts with the welcome; it never appears for an owner who has
  // finished or skipped it, or who had already set things up (the server decides).
  if (ws.data?.onboardingNeeded) return <Navigate to="/welcome" replace />;
  return (
    <CaveProvider>
      <Shell />
      <PlanNotices />
      <ApprovalDock />
      <UpdateNotice />
      <OpenInApp />
      <BuildFinished />
    </CaveProvider>
  );
}
