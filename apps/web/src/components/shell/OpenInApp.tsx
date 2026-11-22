import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../data/api";
import { inAppWindow } from "../../lib/appWindow";
import { isTouchOnly } from "../../lib/media";
import { BrandMark } from "../ui";

/**
 * Hearth in a browser tab on the PC it is installed on (11-22, the owner: "After logging in on
 * browser the user should be directed to the app on their PC ... there's no way for them to even
 * know a app landed on their pc"). Says so, and opens the app with a hearth:// link the installer
 * registered. "Stay in the browser" keeps the tab for the rest of this browser session.
 */

const KEY = "hearth-stay-in-browser";

function stayed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** The link that opens this page in Hearth's own window. */
export function appLink(loc: { pathname: string; search: string } = window.location) {
  return `hearth://open${loc.pathname}${loc.search}`;
}

export function OpenInApp() {
  const [hidden, setHidden] = useState(() => inAppWindow() || isTouchOnly() || stayed());
  const [opened, setOpened] = useState(false);
  const q = useQuery({
    queryKey: ["app-window"],
    queryFn: () => api<{ app: boolean }>("GET", "/api/app-window"),
    enabled: !hidden,
    staleTime: Infinity,
    retry: false,
  });
  const first = useRef<HTMLAnchorElement>(null);
  const show = !hidden && q.data?.app === true;
  useEffect(() => {
    if (show) first.current?.focus();
  }, [show]);
  if (!show) return null;
  const stay = () => {
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* no storage: hidden for this page only */
    }
    setHidden(true);
  };
  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
      data-testid="open-in-app"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-in-app-title"
        className="w-full max-w-md rounded-2xl border border-gold/40 bg-panel p-6 shadow-2xl"
        onKeyDown={(e) => e.key === "Escape" && stay()}
      >
        <BrandMark className="h-10 w-10" />
        <h2 id="open-in-app-title" className="mt-3 font-display text-[1.35rem] font-bold text-ink">
          Hearth is an app on this PC
        </h2>
        <p className="mt-2 text-[0.92rem] text-muted">
          The installer put Hearth on your desktop and in your app menu. It opens in its own window
          with its own icon, so you don&apos;t need this browser tab.
        </p>
        {opened ? (
          <p
            className="mt-4 rounded-xl border border-line bg-bg/50 p-3 text-[0.88rem] text-ink"
            role="status"
            data-testid="open-in-app-opened"
          >
            If your browser asks, choose <b>Open</b>. Sign in there once and it keeps you signed in.
            Then you can close this tab. Nothing opened? Use the Hearth icon on your desktop or in
            your app menu.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            ref={first}
            href={appLink()}
            onClick={() => setOpened(true)}
            className="inline-flex min-h-11 items-center rounded-lg bg-gold px-4 text-[0.92rem] font-semibold text-bg hover:bg-gold-bright"
            data-testid="open-in-app-open"
          >
            Open the Hearth app
          </a>
          <button
            type="button"
            onClick={stay}
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-[0.92rem] font-semibold text-muted hover:text-ink"
            data-testid="open-in-app-stay"
          >
            Stay in the browser
          </button>
        </div>
      </div>
    </div>
  );
}
