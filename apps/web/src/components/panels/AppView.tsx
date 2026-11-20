import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink } from "lucide-react";
import {
  embedAddress,
  type EmbedVerdict,
  type Service,
  type Workspace,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { ServiceActions } from "../../pages/ServiceActions";
import { cx } from "../ui";

/**
 * A basic panel shows the app itself (11-14, the owner via Flint: "shows absolutely nothing of
 * relevance"): the app's own page, embedded, with Hearth's controls in a thin strip above it.
 *
 * - The app's own headers decide whether it may be shown inside Hearth; Hearth reads them and
 *   never changes them. An app that refuses gets a big Open button instead.
 * - Sign-in is the app's own, in the browser. Hearth never puts a key or password into the page.
 * - The page runs with nothing extra (no camera, microphone or location), can't navigate Hearth,
 *   and isn't told Hearth's address.
 * - "Hearth view" (a custom panel, or Hearth's basic one) is one tap away and remembered.
 * - On a phone, the Open button by default: a whole app squeezed into a panel is too cramped.
 */

type View = "app" | "hearth";

/**
 * Asks an app's panel to show Hearth's view (detail: the service id). Panel Builder sends it when
 * Improve opens the Forge and when Ember's preview changes (11-18), so the preview is never hidden
 * behind the app's own page.
 */
export const HEARTH_VIEW_EVENT = "hearth-view";
const viewKey = (id: string) => `hearth-app-view:${id}`;
const readView = (id: string): View | undefined => {
  try {
    const v = window.localStorage.getItem(viewKey(id));
    return v === "app" || v === "hearth" ? v : undefined;
  } catch {
    return undefined;
  }
};
const narrow = () => {
  try {
    return window.matchMedia("(max-width: 640px)").matches;
  } catch {
    return false;
  }
};

export function AppView({
  service,
  ws,
  hearth,
  details,
}: {
  service: Service;
  ws: Workspace;
  /** Hearth's own view: the custom panel when installed, else Hearth's basic panel. */
  hearth: ReactNode;
  /** The container, details and what's running now, behind Details. */
  details: ReactNode;
}) {
  const url =
    typeof window === "undefined" ? undefined : embedAddress(service, window.location.protocol);
  const from = typeof window === "undefined" ? "" : window.location.origin;
  const check = useQuery({
    queryKey: ["embed", service.id, url, from],
    enabled: Boolean(url),
    queryFn: () =>
      api<EmbedVerdict>(
        "GET",
        `/api/services/${encodeURIComponent(service.id)}/embed?url=${encodeURIComponent(url!)}&from=${encodeURIComponent(from)}`,
      ),
    staleTime: 3_600_000,
    retry: false,
  });
  const [view, setView] = useState<View>(() => readView(service.id) ?? "app");
  const [showDetails, setShowDetails] = useState(false);
  const [phoneAnyway, setPhoneAnyway] = useState(false);
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(viewKey(service.id), v);
    } catch {
      // Private window: the choice lasts until the panel closes.
    }
  };
  useEffect(() => {
    const show = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== service.id) return;
      setView("hearth");
      try {
        window.localStorage.setItem(viewKey(service.id), "hearth");
      } catch {
        // Private window: the choice lasts until the panel closes.
      }
    };
    window.addEventListener(HEARTH_VIEW_EVENT, show);
    return () => window.removeEventListener(HEARTH_VIEW_EVENT, show);
  }, [service.id]);
  // A custom panel (applied) or its Forge preview is the panel (11-18, the owner: "after I hit
  // apply the hearth view should go away ... this stupid header needs to be gone"): just it, with
  // the app's page and the container one quiet line below. Without Premium the route is absent.
  const custom = useQuery({
    queryKey: ["custom-panel", service.id],
    queryFn: () =>
      api<{ installed?: unknown; draft?: unknown; plan?: string }>(
        "GET",
        `/api/services/${encodeURIComponent(service.id)}/custom-panel`,
      ),
    retry: false,
    staleTime: 5_000,
  });
  const ownPanel =
    custom.data?.plan !== "free" && Boolean(custom.data?.installed || custom.data?.draft);
  const can = check.data?.ok === true;
  const showFrame = view === "app" && can && (!narrow() || phoneAnyway);
  const tab = (v: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => choose(v)}
      className={cx(
        "min-h-9 rounded-lg px-3 text-[0.8rem] font-semibold",
        view === v ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
      )}
      data-testid={`app-view-${v}`}
    >
      {label}
    </button>
  );

  if (ownPanel)
    return (
      <div className="space-y-3" data-testid="app-view" data-own-panel>
        {hearth}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[0.78rem] text-muted">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-gold"
              data-testid="app-view-new-tab"
            >
              <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden /> Open{" "}
              {service.name}
            </a>
          )}
          <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(!showDetails)}
            className="inline-flex items-center gap-1 hover:text-ink"
            data-testid="app-view-details"
          >
            Container details
            <ChevronDown
              strokeWidth={1.5}
              className={cx("h-3.5 w-3.5 transition-transform", showDetails && "rotate-180")}
              aria-hidden
            />
          </button>
        </div>
        {showDetails && (
          <div
            className="space-y-7 rounded-xl border border-line bg-panel/95 p-4"
            data-testid="app-view-details-body"
          >
            <ServiceActions service={service} ws={ws} inline />
            {details}
          </div>
        )}
      </div>
    );

  return (
    <div className="space-y-3" data-testid="app-view">
      {/* Hearth's controls, kept small: the app is what the panel is for. */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/95 p-2"
        data-testid="app-view-strip"
      >
        <div role="tablist" aria-label="Show" className="flex rounded-lg border border-line p-0.5">
          {tab("app", service.name)}
          {tab("hearth", "Hearth view")}
        </div>
        <div className="flex-1" />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.8rem] text-ink hover:border-gold hover:text-gold"
            data-testid="app-view-new-tab"
          >
            <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden /> Open in a new tab
          </a>
        )}
        <button
          type="button"
          aria-expanded={showDetails}
          onClick={() => setShowDetails(!showDetails)}
          className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[0.8rem] text-muted hover:text-ink"
          data-testid="app-view-details"
        >
          Details
          <ChevronDown
            strokeWidth={1.5}
            className={cx("h-3.5 w-3.5 transition-transform", showDetails && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>

      {showDetails && (
        <div
          className="space-y-7 rounded-xl border border-line bg-panel/95 p-4"
          data-testid="app-view-details-body"
        >
          {/* Start, stop, restart and checks: with the container, not crowding the app. */}
          <ServiceActions service={service} ws={ws} inline />
          {details}
        </div>
      )}

      {view === "hearth" ? (
        hearth
      ) : !url ? (
        <div className="space-y-3">
          <p className="text-[0.86rem] text-muted">
            Hearth doesn&apos;t know {service.name}&apos;s address, so it can&apos;t show it here.
          </p>
          {hearth}
        </div>
      ) : check.isPending ? (
        <div className="h-[60vh] min-h-[22rem] animate-pulse rounded-xl border border-line bg-raised/40" />
      ) : showFrame ? (
        <iframe
          src={url}
          title={service.name}
          // No camera, microphone, location or the like; no top-level navigation of Hearth.
          allow=""
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
          referrerPolicy="no-referrer"
          className="h-[calc(100dvh-16rem)] min-h-[24rem] w-full rounded-xl border border-line bg-white"
          data-testid="app-view-frame"
        />
      ) : (
        <div className="space-y-5">
          <div
            className="flex flex-col items-center gap-3 rounded-xl border border-line bg-panel/95 px-4 py-10 text-center"
            data-testid="app-view-open"
          >
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-gold px-6 text-[1rem] font-bold text-[#1a0d05]"
              data-testid="app-view-open-button"
            >
              <ExternalLink strokeWidth={1.8} className="h-5 w-5" aria-hidden /> Open {service.name}
            </a>
            <p className="max-w-md text-[0.8rem] text-muted" data-testid="app-view-why">
              {can
                ? "On a phone it opens in its own tab, where it has room."
                : `It can't be shown inside Hearth: ${(check.data?.reason ?? "Hearth couldn't check it.").replace(/^The app/, service.name)}`}
            </p>
            {can && (
              <button
                type="button"
                onClick={() => setPhoneAnyway(true)}
                className="min-h-9 text-[0.8rem] text-gold underline-offset-2 hover:underline"
              >
                Show it here anyway
              </button>
            )}
          </div>
          {/* What Hearth itself knows about it, under the button. */}
          {!can && hearth}
        </div>
      )}
    </div>
  );
}
