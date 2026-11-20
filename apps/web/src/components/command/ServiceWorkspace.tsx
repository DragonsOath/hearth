import { useAiName } from "../../data/api";
import { GluetunDashboard } from "../dashboards/GluetunDashboard";
import { RecyclarrDashboard } from "../dashboards/RecyclarrDashboard";
import { FlaresolverrDashboard } from "../dashboards/FlaresolverrDashboard";
import { TinyauthDashboard } from "../dashboards/TinyauthDashboard";
import { CaddyDashboard } from "../dashboards/CaddyDashboard";
import {
  AppGlance,
  GenericPanel,
  IntegrationGap,
  RequestFeatureLine,
} from "../dashboards/AppGlance";
import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  canImprovePanel,
  featuresOfApp,
  handBuiltDashboardOf,
  panelClassOf,
  type MemoryEntry,
  type Service,
  type Workspace,
} from "@dragon-control/core";

/** The Hearth features on an app's panel (Wizarr's invitations, Home Assistant's routines). */
function appHelp(service: Service): string[] {
  const app = appKindOf(service);
  return app ? featuresOfApp(app).map((f) => f.id) : [];
}
import { Button, Skeleton, cx } from "../ui";
import { useServiceRuntime } from "../../data/api";
import { useMemoryEntries } from "../../data/memory";
import { ago } from "../../lib/format";
import { ServiceLogo, useOpenTarget } from "./ServiceLogo";
import { autonomyLabels } from "../../pages/Autonomy";
import { Fact, InsideTheApp, LastCheck, Watching } from "../../pages/ServiceDetail";
import { RecentActions, ServiceActions } from "../../pages/ServiceActions";
import { serviceDot } from "../shell/Sidebar";
import { TerminalView, Unavailable, WorkspaceFrame, type TabDef } from "./WorkspaceFrame";
import { Diagnostics, appKindOf } from "./Diagnostics";
import { Suspense } from "react";
import { APP_PANELS } from "../panels/registry";
import { FreePanelMenu } from "../panels/FreePanelMenu";
import { SignInCard } from "../panels/SignInCard";
import { AddonSlot } from "../AddonSlot";
import { AppView } from "../panels/AppView";
import { joinTab, splitTab } from "../panels/targets";
import { HistoryTab, LogsTab, ResourceTrends, RestartTimeline } from "./ServiceTabs";
import { useCave } from "../shell/cave-context";
import {
  FolderOpen,
  HeartPulse,
  History,
  MessageCircle,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal,
  StickyNote,
} from "lucide-react";
import { RemoveSystem } from "../systems/ManageSystems";
import { EmberMark } from "../ember/EmberMark";

/** Overview, Diagnostics, the app's own tabs (from the registry) and Hearth's tabs. */
type Tab = string;
const DIAGNOSTICS_TAB: TabDef<Tab> = { id: "diagnostics", label: "Diagnostics" };
/** Overview and Hearth's own tools; an app tab never reuses one of these ids (registry.test.ts). */
export const TABS: TabDef<Tab>[] = [
  { id: "overview", label: "Overview" },
  {
    id: "health",
    label: "Health",
    group: "hearth",
    icon: <HeartPulse strokeWidth={1.5} className="h-4 w-4" />,
    hint: "Checks, restarts and resource use",
  },
  {
    id: "logs",
    label: "Logs",
    group: "hearth",
    icon: <ScrollText strokeWidth={1.5} className="h-4 w-4" />,
    hint: "Read live, secrets hidden",
  },
  {
    id: "terminal",
    label: "Terminal",
    group: "hearth",
    icon: <SquareTerminal strokeWidth={1.5} className="h-4 w-4" />,
    hint: "What Hearth ran or read here",
  },
  {
    id: "files",
    label: "Files",
    group: "hearth",
    icon: <FolderOpen strokeWidth={1.5} className="h-4 w-4" />,
    hint: "Not set up yet",
  },
  {
    id: "settings",
    label: "Settings",
    group: "hearth",
    icon: <SlidersHorizontal strokeWidth={1.5} className="h-4 w-4" />,
    hint: "Watching, autonomy, remove",
  },
  {
    id: "notes",
    label: "Notes",
    group: "hearth",
    icon: <StickyNote strokeWidth={1.5} className="h-4 w-4" />,
    hint: "Your notes about it",
  },
  {
    id: "history",
    label: "History",
    group: "hearth",
    icon: <History strokeWidth={1.5} className="h-4 w-4" />,
    hint: "What changed, and who did it",
  },
];

/** A label that says plainly where a value comes from. */
function Source({ live, at }: { live: boolean; at?: string }) {
  return (
    <span
      className={cx(
        "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
        live ? "border-live/40 text-live" : "border-line-strong text-muted",
      )}
    >
      {live ? "Live" : "Recorded"}
      {at ? ` · ${ago(at).toLowerCase()}` : ""}
    </span>
  );
}

function stateLabel(s: Service) {
  if (s.lifecycle === "paused")
    return { text: "Paused on purpose", cls: "border-line-strong text-muted" };
  if (s.lifecycle === "retired") return { text: "Retired", cls: "border-line-strong text-muted" };
  if (s.stopped) return { text: "Stopped on request", cls: "border-line-strong text-muted" };
  if (s.lastCheck?.detail?.includes("stopped on purpose"))
    return { text: "Stopped on purpose", cls: "border-line-strong text-muted" };
  if (s.health === "healthy") return { text: "Running", cls: "border-live/40 text-live" };
  if (s.health === "attention") return { text: "Degraded", cls: "border-amber/40 text-amber" };
  return { text: "Down", cls: "border-alert/40 text-alert" };
}

function Overview({
  service,
  ws,
  sub,
  onSub,
  onGo,
}: {
  service: Service;
  ws: Workspace;
  /** Where inside Overview (an app dashboard's section), from the address. */
  sub?: string | null;
  onSub?: (sub: string | null) => void;
  onGo?: (tab: string, sub?: string | null) => void;
}) {
  const host = ws.hosts.find((h) => h.id === service.hostId);
  const href = useOpenTarget(service)?.href;
  const container = service.container;
  const app = appKindOf(service);
  // The app's everyday dashboard (from the panel registry), loaded only when Overview is open.
  const Live = app ? APP_PANELS[app]?.overview : undefined;
  // One rule (core panel-class.ts) says which kind of panel this is; the web and the server share it.
  const dash = handBuiltDashboardOf(service);
  const cls = panelClassOf(service);
  // Hearth's own view: a hand-built dashboard, the app's live panel, or (for an app Hearth has no
  // panel for) the basic one, which Premium's Panel Builder can replace with a custom panel.
  const own =
    dash === "gluetun" ? (
      <GluetunDashboard serviceId={service.id} name={service.name} />
    ) : dash === "caddy" ? (
      <CaddyDashboard serviceId={service.id} name={service.name} />
    ) : dash === "flaresolverr" ? (
      <FlaresolverrDashboard serviceId={service.id} name={service.name} />
    ) : dash === "tinyauth" ? (
      <TinyauthDashboard serviceId={service.id} name={service.name} />
    ) : dash === "recyclarr" ? (
      <RecyclarrDashboard serviceId={service.id} name={service.name} />
    ) : Live ? (
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <Live serviceId={service.id} name={service.name} sub={sub} onSub={onSub} onGo={onGo} />
      </Suspense>
    ) : app ? (
      <AppGlance service={service} kind={app} />
    ) : cls === "watch-only" ? (
      <IntegrationGap service={service} />
    ) : (
      // Custom panels are Premium (Panel Builder, in the Premium package); without it, the basic panel.
      <AddonSlot
        name="panel.body"
        props={{ service, basic: <GenericPanel service={service} /> }}
        fallback={
          <div className="space-y-5">
            <SignInCard service={service} />
            <GenericPanel service={service} />
          </div>
        }
      />
    );
  // Hearth's own app panels can be improved too (11-19): Premium's custom panel goes over it, with
  // Hearth's panel one click away. Network and security apps keep theirs (canImprovePanel).
  const shown =
    cls === "first-party" && canImprovePanel(service) ? (
      <AddonSlot
        name="panel.body"
        props={{ service, basic: own, firstParty: true }}
        fallback={own}
      />
    ) : (
      own
    );
  const details = (
    <>
      <h3 className="eyebrow">Container</h3>
      <div className="rounded-xl border border-line bg-bg/50 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <ServiceLogo service={service} className="h-12 w-12 text-[1.15rem]" />
          <div className="min-w-0 flex-1">
            <p className="text-[1.05rem] text-ink">{service.name}</p>
            <p className="text-[0.82rem] text-muted">Version {service.version ?? "not reported"}</p>
          </div>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong px-3 text-[0.84rem] text-ink hover:border-gold hover:text-gold"
            >
              <ExternalLink strokeWidth={1.5} className="h-4 w-4" /> Open web UI
            </a>
          )}
        </div>
        <div className="mt-4">
          <ServiceActions service={service} ws={ws} inline />
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="eyebrow">Details</h3>
          <Source live={false} at={ws.discoveredAt} />
        </div>
        <dl className="divide-y divide-line">
          <Fact label="Host" value={host?.name ?? "Unknown"} />
          <Fact
            label="Container"
            value={
              container ?? (service.kind === "process" ? "A program, not a container" : "Not known")
            }
            mono
          />
          {service.image && <Fact label="Image" value={service.image} mono />}
          <Fact label="Address" value={service.localUrl ?? "None known"} mono />
          <Fact label="Category" value={service.category} />
          <Fact label="Autonomy" value={autonomyLabels[service.autonomy].title} />
          <Fact
            label="Availability, 30 days"
            value={
              service.uptimePct === undefined ? "Measuring" : `${service.uptimePct.toFixed(1)}%`
            }
            mono
          />
        </dl>
      </div>
      <Runtime service={service} />
      <RecentActions service={service} ws={ws} />
    </>
  );
  // An app without a panel of Hearth's own (a basic panel): the app itself first (11-14), with
  // Hearth's view and the container's details one tap away. Hand-built panels stay as they are.
  // Databases, caches and the VPN (watch-only) have no page to show: they keep the plain view.
  if (!dash && !Live && service.kind !== "process" && cls !== "watch-only")
    return (
      <div className="@container">
        <AppView
          // Each app keeps its own choice of view.
          key={service.id}
          service={service}
          ws={ws}
          hearth={
            <div className="space-y-7">
              {shown}
              {cls === "first-party" && <RequestFeatureLine service={service} />}
            </div>
          }
          details={details}
        />
      </div>
    );
  return (
    <div className="@container space-y-7">
      {shown}
      {/* A hand-built panel offers Request a feature (How requests work, 11-10). */}
      {cls === "first-party" && <RequestFeatureLine service={service} />}
      <div className="space-y-7 border-t border-line pt-6">{details}</div>
    </div>
  );
}

function uptime(since: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return d
    ? `${d} ${d === 1 ? "day" : "days"}, ${h} h`
    : h
      ? `${h} h ${mins % 60} min`
      : `${mins} min`;
}

/** Read live from Docker each time the workspace is open; never estimated. */
function Runtime({ service }: { service: Service }) {
  const rt = useServiceRuntime(service.id);
  const r = rt.data;
  return (
    <div data-testid="service-runtime">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="eyebrow">Right now</h3>
        {r?.available && <Source live at={r.at} />}
      </div>
      {rt.isLoading ? (
        <Skeleton className="h-24" />
      ) : !r?.available ? (
        <p className="py-2 text-[0.86rem] text-muted">
          Not available: {r?.reason ?? "it could not be read."}
        </p>
      ) : (
        <dl className="divide-y divide-line">
          <Fact label="Container" value={r.running ? "Running" : "Not running"} />
          <Fact label="Uptime" value={r.startedAt ? uptime(r.startedAt) : "Not running"} mono />
          <Fact
            label="Ports"
            value={r.ports?.length ? r.ports.join(", ") : "None published"}
            mono
          />
          <Fact
            label="CPU"
            value={r.cpuPct === undefined ? "Not available" : `${r.cpuPct}%`}
            mono
          />
          <Fact
            label="Memory"
            value={
              r.memoryMb === undefined
                ? "Not available"
                : `${r.memoryMb} MB${r.memoryLimitMb ? ` of ${(r.memoryLimitMb / 1024).toFixed(1)} GB` : ""}`
            }
            mono
          />
          {r.restartCount !== undefined && (
            <Fact label="Restarts by Docker" value={String(r.restartCount)} mono />
          )}
        </dl>
      )}
    </div>
  );
}

function Health({ service, ws }: { service: Service; ws: Workspace }) {
  const aiName = useAiName();
  const report = ws.apps.find((r) => r.serviceId === service.id);
  const incidents = ws.incidents.filter((i) => i.serviceId === service.id);
  const cave = useCave();
  return (
    <div className="space-y-7">
      <button
        type="button"
        onClick={() =>
          cave.ask(
            `Check ${service.name}'s health now (its check, logs, restarts, and resource use), tell me if anything needs attention, and fix it if it does.`,
          )
        }
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gold/50 px-3 text-[0.84rem] text-gold hover:bg-gold/10"
        data-testid="health-ask"
      >
        <MessageCircle strokeWidth={1.5} className="h-4 w-4" /> Ask {aiName} to check it now
        <EmberMark />
      </button>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="eyebrow">Hearth's own check</h3>
          {service.lastCheck && <Source live at={service.lastCheck.at} />}
        </div>
        {service.lifecycle ? (
          <p className="text-[0.88rem] text-muted">
            Not checked: {service.lifecycle} on purpose
            {service.lifecycleNote ? ` (${service.lifecycleNote})` : ""}.
          </p>
        ) : service.stopped ? (
          <p className="text-[0.88rem] text-muted" data-testid="stopped-note">
            Not checked: stopped on request {ago(service.stopped.at).toLowerCase()}. Hearth will not
            restart it; it is watched again once it is started.
          </p>
        ) : (
          <LastCheck service={service} />
        )}
      </div>
      {report && <InsideTheApp report={report} name={service.name} />}
      <RestartTimeline service={service} />
      <ResourceTrends service={service} />
      <div>
        <h3 className="eyebrow mb-2">Incidents</h3>
        {incidents.length ? (
          <ul className="divide-y divide-line">
            {incidents.map((i) => (
              <li key={i.id}>
                <Link
                  to={`/incidents/${i.id}`}
                  className="flex min-h-11 items-center gap-3 py-2 text-[0.88rem] text-ink hover:text-gold"
                >
                  <span
                    className={cx(
                      "h-2 w-2 rounded-full",
                      i.status === "resolved" ? "bg-live" : "bg-amber",
                    )}
                  />
                  <span className="flex-1">{i.title}</span>
                  <span className="text-[0.76rem] text-faint">{ago(i.openedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">No incidents on record.</p>
        )}
      </div>
    </div>
  );
}

function Notes({ service }: { service: Service }) {
  const entries = useMemoryEntries({});
  const mine = (entries.data ?? []).filter(
    (e: MemoryEntry) =>
      e.links?.some((l) => l.ref === `service:${service.id}`) ||
      e.title.toLowerCase().includes(service.name.replace(/\s*\(.*\)$/, "").toLowerCase()),
  );
  if (entries.isLoading) return <Skeleton className="h-40" />;
  return mine.length ? (
    <ul className="space-y-4">
      {mine.slice(0, 30).map((e) => (
        <li key={e.id} className="border-l-2 border-gold/30 pl-3">
          <p className="text-[0.9rem] text-ink">{e.title}</p>
          {e.body && (
            <p className="mt-1 line-clamp-3 text-[0.84rem] leading-relaxed text-muted">{e.body}</p>
          )}
          <p className="mt-1 text-[0.74rem] text-faint">
            {e.kind} · {e.basis} · {ago(e.happenedAt ?? e.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-[0.86rem] text-muted">
      Nothing in the homelab memory mentions {service.name} yet.
    </p>
  );
}

export function ServiceWorkspace({
  ws,
  id,
  tab,
  onTab,
  onClose,
}: {
  ws: Workspace;
  id: string;
  tab: string | null;
  onTab: (t: string) => void;
  onClose: () => void;
}) {
  const service = [...ws.services, ...ws.inactiveServices].find((s) => s.id === id);
  // Apps Hearth understands get a Diagnostics tab, right after Overview, then their own deeper
  // tabs from the panel registry, then Hearth's tabs about the service.
  const app = service ? appKindOf(service) : undefined;
  const appTabs = (app && APP_PANELS[app]?.tabs) || [];
  const tabs: TabDef<Tab>[] = app
    ? [
        TABS[0]!,
        DIAGNOSTICS_TAB,
        ...appTabs.map((t) => ({ id: t.id, label: t.label })),
        ...TABS.slice(1),
      ]
    : TABS;
  // The address may say where inside a tab ("library/movie/42"); old addresses ("logs") still work.
  const where = splitTab(tab);
  const start = (app && APP_PANELS[app]?.start) || "overview";
  const current = (
    tabs.some((t) => t.id === where.tab)
      ? where.tab
      : tabs.some((t) => t.id === start)
        ? start
        : "overview"
  ) as Tab;
  const appTab = appTabs.find((t) => t.id === current);
  if (!service) {
    return (
      <div className="rounded-2xl border border-line p-6">
        <p className="text-ink">This service is not in Hearth's records.</p>
        <Button className="mt-4" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  const host = ws.hosts.find((h) => h.id === service.hostId);
  const state = stateLabel(service);
  const dot = serviceDot(service);
  const terminal = ws.actions
    .filter((a) => a.serviceId === service.id && a.result)
    .map((a) => ({
      at: a.completedAt ?? a.requestedAt,
      source: `${a.label} (${a.requestedBy === "you" ? "you" : a.requestedBy === "agent" ? "the AI" : "Hearth"})`,
      lines: [`$ ${a.label}`, a.result!],
    }));
  return (
    <WorkspaceFrame
      label={`Service: ${service.name}`}
      testId="service-workspace"
      help={appHelp(service)}
      icon={<ServiceLogo service={service} className="h-11 w-11 text-[1.05rem]" />}
      title={service.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cx(
              "fit-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.76rem]",
              state.cls,
            )}
            data-testid="service-state"
          >
            <span className={cx("h-1.5 w-1.5 rounded-full", dot.className)} />
            {state.text}
          </span>
          <span>
            {service.category} · {host?.name ?? "Unknown host"}
          </span>
        </span>
      }
      tabs={tabs}
      tab={current}
      onTab={onTab}
      onClose={onClose}
      brand={{ ...(app ? { kind: app } : {}), name: service.name, image: service.image }}
      actions={
        canImprovePanel(service) ? (
          <AddonSlot
            name="panel.improve"
            props={{ service }}
            fallback={<FreePanelMenu service={service} />}
          />
        ) : undefined
      }
      capture={{
        serviceId: service.id,
        serviceName: service.name,
        panel: service.name,
        tab: tabs.find((t) => t.id === current)?.label,
      }}
    >
      {current === "overview" && (
        <Overview
          service={service}
          ws={ws}
          sub={where.sub}
          onSub={(s) => onTab(joinTab("overview", s))}
          onGo={(t, sub) => onTab(joinTab(t, sub ?? null))}
        />
      )}
      {appTab && (
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <appTab.view
            serviceId={service.id}
            name={service.name}
            sub={where.sub}
            onSub={(sub) => onTab(joinTab(appTab.id, sub))}
            onGo={(t, sub) => onTab(joinTab(t, sub ?? null))}
          />
        </Suspense>
      )}
      {current === "diagnostics" && app && <Diagnostics service={service} kind={app} />}
      {current === "health" && <Health service={service} ws={ws} />}
      {current === "logs" && <LogsTab service={service} />}
      {current === "terminal" && (
        <TerminalView entries={terminal} empty="Nothing has run on this service yet." />
      )}
      {current === "files" && (
        <Unavailable
          what="Service files"
          why="Browsing a service's files needs a reviewed, read-only path set up for it. Watched folders are on the Storage page."
        />
      )}
      {current === "settings" && (
        <div className="space-y-6">
          <div>
            <h3 className="eyebrow mb-3">Watching</h3>
            <Watching service={service} />
          </div>
          <div>
            <h3 className="eyebrow mb-3">Remove</h3>
            <RemoveSystem service={service} onRemoved={onClose} />
          </div>
          <p className="text-[0.86rem] text-muted">
            What Hearth may do here follows {autonomyLabels[service.autonomy].title.toLowerCase()}{" "}
            for its area.{" "}
            <Link to="/autonomy" className="text-gold underline underline-offset-4">
              Autonomy
            </Link>
          </p>
        </div>
      )}
      {current === "notes" && <Notes service={service} />}
      {current === "history" && <HistoryTab service={service} />}
    </WorkspaceFrame>
  );
}
