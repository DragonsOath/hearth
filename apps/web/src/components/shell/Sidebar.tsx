import { useState, type ReactNode } from "react";
import { usePcMarks } from "../../data/pcs";
import { PcMark } from "../devices/PcBadge";
import { OwnerAvatar } from "./OwnerAvatar";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";
import { useMedia } from "../../lib/media";
import { attentionIncidents } from "../../lib/format";
import { usePanelHref, usePanelToggle } from "../desk/links";
import { panelsFrom } from "../desk/layout";
import {
  Activity,
  Anvil,
  Archive,
  Bot,
  ChevronDown,
  Clapperboard,
  ClipboardList,
  Container,
  DatabaseBackup,
  FolderKanban,
  HardDrive,
  House,
  ListTodo,
  LockKeyhole,
  LockKeyholeOpen,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PauseCircle,
  ScrollText,
  Search,
  Server,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { Health, Service, Workspace } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useViewingPcName } from "../../lib/viewingPc";
import { useAuthStatus } from "../../data/auth";
import { useTodos } from "../../data/todos";
import { useSavedWorkspaces } from "../../data/workspaces";
import { useOpenWorkspace } from "../workspace/dock";
import { cx, BrandMark } from "../ui";
import { MONITORING_PATHS } from "./MonitoringTabs";

/**
 * The command center's permanent left navigation. Systems opens into the
 * services Hearth discovered (a click opens one beside the
 * conversation); Secure Vault shows whether it is locked. Collapses to an
 * icon rail on desktop.
 */

const RAIL_KEY = "dc-sidebar-rail";

export function serviceDot(s: Pick<Service, "health" | "lifecycle" | "stopped">): {
  className: string;
  label: string;
} {
  if (s.lifecycle === "paused") return { className: "bg-faint", label: "Paused" };
  if (s.stopped) return { className: "bg-faint", label: "Stopped on request" };
  if (s.lifecycle === "retired") return { className: "bg-line-strong", label: "Retired" };
  const map: Record<Health, { className: string; label: string }> = {
    healthy: { className: "bg-live", label: "Healthy" },
    attention: { className: "bg-amber", label: "Needs attention" },
    offline: { className: "bg-alert", label: "Down" },
  };
  return map[s.health];
}

function Item({
  to,
  icon: Icon,
  label,
  rail,
  end,
  badge,
  children,
  open,
  onToggle,
  active: forceActive,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  rail: boolean;
  end?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  active?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center">
        <NavLink
          to={to}
          end={end}
          title={rail ? label : undefined}
          aria-label={rail ? label : undefined}
          className={({ isActive }) =>
            cx(
              "group relative flex min-h-11 flex-1 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors duration-200",
              isActive || forceActive
                ? "bg-gold/10 text-ink before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-full before:bg-gold"
                : "text-muted hover:bg-raised hover:text-ink",
              rail && "justify-center px-0",
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                strokeWidth={1.35}
                className={cx(
                  "h-[19px] w-[19px] shrink-0",
                  isActive || forceActive ? "text-gold" : "text-faint group-hover:text-muted",
                )}
              />
              {!rail && <span className="flex-1 truncate">{label}</span>}
              {!rail && badge}
            </>
          )}
        </NavLink>
        {!rail && onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Close" : "Open"} ${label}`}
            className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-faint hover:text-gold"
          >
            <ChevronDown
              strokeWidth={1.5}
              className={cx("h-4 w-4 transition-transform duration-200", open && "rotate-180")}
            />
          </button>
        )}
      </div>
      {!rail && open && children && (
        <div className="mt-1 mb-2 ml-4 border-l border-line pl-2">{children}</div>
      )}
    </div>
  );
}

function SubLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "flex min-h-9 items-center rounded-md px-3 text-[0.84rem] transition-colors",
          isActive ? "text-gold" : "text-muted hover:text-ink",
        )
      }
    >
      {children}
    </NavLink>
  );
}

function SystemsList({ ws }: { ws: Workspace }) {
  const pcMark = usePcMarks();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const open = pathname === "/" ? params.get("service") : null;
  const toggle = usePanelToggle();
  const openPanels = pathname === "/" ? panelsFrom(params) : [];
  const all = [...ws.services, ...ws.inactiveServices].sort((a, b) => a.name.localeCompare(b.name));
  // Problems first, then by name; the full list is one click away.
  const rank = (s: Service) =>
    s.lifecycle || s.stopped ? 3 : s.health === "offline" ? 0 : s.health === "attention" ? 1 : 2;
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const matching = q
    ? sorted.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    : sorted;
  const shown = q || more ? matching : matching.slice(0, 10);
  return (
    <div data-testid="systems-list">
      {all.length > 8 && (
        <label className="mb-1 flex min-h-9 items-center gap-2 rounded-md border border-line px-2.5 text-faint focus-within:border-gold/50">
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" />
          <span className="sr-only">Filter services</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter services"
            className="min-w-0 flex-1 bg-transparent text-[0.82rem] text-ink placeholder:text-faint focus:outline-none"
          />
        </label>
      )}
      <ul className="max-h-[46vh] overflow-y-auto pr-1">
        {shown.map((s) => {
          const dot = serviceDot(s);
          const active =
            open === s.id || openPanels.some((p) => p.kind === "service" && p.id === s.id);
          return (
            <li key={s.id}>
              <Link
                to={toggle(`service:${s.id}`).href}
                aria-current={active ? "page" : undefined}
                title={
                  toggle(`service:${s.id}`).open ? `Close ${s.name}'s panel` : `Open ${s.name}`
                }
                className={cx(
                  "flex min-h-9 items-center gap-2.5 rounded-md px-3 text-[0.84rem] transition-colors",
                  active ? "bg-gold/10 text-gold" : "text-muted hover:text-ink",
                )}
              >
                {s.lifecycle === "paused" ? (
                  <PauseCircle
                    strokeWidth={1.5}
                    className="h-3.5 w-3.5 shrink-0 text-faint"
                    aria-label="Paused"
                  />
                ) : s.lifecycle === "retired" ? (
                  <Archive
                    strokeWidth={1.5}
                    className="h-3.5 w-3.5 shrink-0 text-faint"
                    aria-label="Retired"
                  />
                ) : (
                  <span
                    className={cx("h-2 w-2 shrink-0 rounded-full", dot.className)}
                    aria-label={dot.label}
                  />
                )}
                <span className="flex-1 truncate">{s.name}</span>
                <PcMark mark={pcMark(s.pcId)} size={14} />
              </Link>
            </li>
          );
        })}
        {!shown.length && (
          <li className="px-3 py-2 text-[0.8rem] text-faint">No services match.</li>
        )}
        {!q && !more && matching.length > 10 && (
          <li>
            <button
              type="button"
              onClick={() => setMore(true)}
              className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 text-[0.84rem] text-faint hover:text-gold"
            >
              <span aria-hidden="true">···</span> {matching.length - 10} more services
            </button>
          </li>
        )}
      </ul>
      <div className="mt-1 flex gap-1">
        <SubLink to="/services">All services</SubLink>
        <SubLink to="/systems">Machines</SubLink>
      </div>
    </div>
  );
}

/** The latest Forge sheets, one click from reopening; the rest are in the Forge Library. */
function SavedList() {
  const files = useSavedWorkspaces();
  const open = useOpenWorkspace();
  const list = (files.data ?? []).slice(0, 6);
  return (
    <div data-testid="sidebar-saved">
      {list.length > 0 && (
        <ul>
          {list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => open(w)}
                title={w.folder ? `${w.folder} / ${w.title}` : w.title}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-[0.84rem] text-muted transition-colors hover:text-ink"
              >
                <ClipboardList strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="flex-1 truncate">{w.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        <SubLink to="/forge">Library</SubLink>
        <SubLink to="/forge?tab=temporary">Open now</SubLink>
        <SubLink to="/forge?tab=notes">Notes</SubLink>
      </div>
    </div>
  );
}

function VaultState() {
  const auth = useAuthStatus();
  const until = auth.data?.vaultUnlockedUntil;
  // The server only reports a time while the vault is unlocked for this session.
  const unlocked = Boolean(until);
  return (
    <Link
      to="/vault"
      className="flex min-h-9 items-center gap-2.5 rounded-md px-3 text-[0.84rem] text-muted hover:text-ink"
      data-testid="sidebar-vault-state"
    >
      {unlocked ? (
        <LockKeyholeOpen strokeWidth={1.5} className="h-3.5 w-3.5 text-gold" />
      ) : (
        <LockKeyhole strokeWidth={1.5} className="h-3.5 w-3.5 text-faint" />
      )}
      {unlocked
        ? `Unlocked until ${new Date(until!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "Locked · unlock"}
    </Link>
  );
}

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** How many saved items still need dealing with, and whether Ember noticed something new. */
function TodoBadge() {
  const todos = useTodos({ suggestions: true });
  const list = todos.data ?? [];
  const active = list.filter(
    (t) => t.status === "open" || t.status === "investigating" || t.status === "waiting-approval",
  ).length;
  const noticed = list.filter((t) => t.status === "suggested").length;
  if (!active && !noticed) return null;
  return (
    <span
      className="rounded-full bg-gold/12 px-2 text-[0.72rem] text-gold tabular"
      aria-label={`${active} to deal with${noticed ? `, ${noticed} noticed` : ""}`}
    >
      {active}
      {noticed ? "+" : ""}
    </span>
  );
}

export function Sidebar() {
  const { data: ws } = useWorkspace();
  const viewing = useViewingPcName();
  const panelHref = usePanelHref();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  // Storage & Files is a panel: lit while it is the panel in front.
  const storageOpen =
    pathname === "/" &&
    (params.get("focus") === "tool:storage" || params.get("panels") === "tool:storage");
  const [railChoice, setRail] = useState(() => read(RAIL_KEY) === "1");
  // On a tablet the sidebar is always the icon rail, leaving room for the split screen.
  const wide = useMedia("(min-width: 1024px)");
  const rail = railChoice || !wide;
  const [open, setOpen] = useState<Record<string, boolean>>({
    systems: true,
    vault: true,
  });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  // On Monitoring, which opens Incidents: only the incidents that need you. The top bar counts
  // everything (findings and plans too) and opens Home's list of it.
  const attention = ws ? attentionIncidents(ws).length : 0;
  const serviceOpen = pathname === "/" && params.has("service");

  return (
    <aside
      className={cx(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-gold/15 bg-bg/80 py-5 transition-[width] duration-200 md:flex",
        rail ? "w-[76px] px-2" : "w-[264px] px-3",
      )}
      aria-label="Sidebar"
    >
      <Link
        to="/"
        className={cx("mb-6 flex items-center gap-3 px-2", rail && "justify-center px-0")}
        aria-label="Hearth home"
      >
        <BrandMark className="h-10 w-10" />
        {!rail && (
          <span className="min-w-0">
            <span className="block text-[1.45rem] leading-none font-semibold tracking-[-0.01em] whitespace-nowrap text-ink lowercase">
              hearth
            </span>
            <span className="mt-1 block text-[0.72rem] tracking-[0.08em] text-faint">
              {viewing ??
                (ws?.instanceName && ws.instanceName !== "Home"
                  ? ws.instanceName
                  : "Your digital home")}
            </span>
          </span>
        )}
      </Link>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <Item
          to="/"
          end
          icon={House}
          label="Home"
          rail={rail}
          active={pathname === "/" && !serviceOpen}
        />
        <Item
          to="/projects"
          icon={FolderKanban}
          label="Projects"
          rail={rail}
          open={open.projects}
          onToggle={() => toggle("projects")}
        >
          <SubLink to="/projects">All projects</SubLink>
          <SubLink to="/jobs">Jobs</SubLink>
        </Item>
        <Item to="/todo" icon={ListTodo} label="To-do" rail={rail} badge={<TodoBadge />} />
        <Item to="/releases" icon={Clapperboard} label="Releases" rail={rail} />
        <Item
          to="/forge"
          icon={Anvil}
          label="The Forge"
          rail={rail}
          open={open.saved}
          onToggle={() => toggle("saved")}
        >
          <SavedList />
        </Item>
        <Item to="/agent" icon={Bot} label="Agents" rail={rail} />
        <Item
          to="/services"
          icon={Server}
          label="Systems"
          rail={rail}
          open={open.systems}
          onToggle={() => toggle("systems")}
          active={serviceOpen}
        >
          {ws && <SystemsList ws={ws} />}
        </Item>
        <Item
          to={panelHref("tool:storage") ?? "/storage"}
          icon={HardDrive}
          label="Storage"
          rail={rail}
          active={storageOpen}
        />
        <Item
          to="/vault"
          icon={LockKeyhole}
          label="Secure Vault"
          rail={rail}
          open={open.vault}
          onToggle={() => toggle("vault")}
        >
          <VaultState />
        </Item>
        <Item to="/docker" icon={Container} label="Docker" rail={rail} />
        <Item to="/backups" icon={DatabaseBackup} label="Backups" rail={rail} />
        <Item to="/network" icon={Network} label="Network" rail={rail} />
        <Item
          to="/incidents"
          icon={Activity}
          label="Monitoring"
          rail={rail}
          // Findings, Incidents, Autonomy and Notifications are its tabs (11-13).
          active={MONITORING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))}
          badge={
            attention ? (
              <span
                className="rounded-full bg-amber/15 px-2 text-[0.72rem] text-amber tabular"
                aria-label={`${attention} need you`}
              >
                {attention}
              </span>
            ) : undefined
          }
        />
        <Item
          to="/logs"
          icon={ScrollText}
          label="Logs"
          rail={rail}
          open={open.logs}
          onToggle={() => toggle("logs")}
        >
          <SubLink to="/logs">Changes and activity</SubLink>
          <SubLink to="/memory">Memory</SubLink>
          <SubLink to="/integrations">Integrations</SubLink>
        </Item>
        <div className="mt-auto pt-3">
          <Item to="/settings" icon={Settings2} label="Settings" rail={rail} />
        </div>
      </nav>

      <div
        className={cx("mt-3 flex items-center gap-2 border-t border-line pt-3", rail && "flex-col")}
      >
        {!rail && (
          <Link
            to="/settings#security"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-raised"
          >
            <OwnerAvatar className="h-9 w-9 font-display text-[1.05rem]" />
            <span className="min-w-0">
              <span className="block truncate text-[0.88rem] text-ink">
                {ws?.ownerName ?? "You"}
              </span>
              <span className="block text-[0.74rem] text-faint">Owner</span>
            </span>
          </Link>
        )}
        {wide && (
          <button
            type="button"
            onClick={() => {
              setRail(!rail);
              try {
                localStorage.setItem(RAIL_KEY, rail ? "0" : "1");
              } catch {
                // Only the remembered width is lost.
              }
            }}
            aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-faint hover:text-gold"
          >
            {rail ? (
              <PanelLeftOpen strokeWidth={1.35} className="h-5 w-5" />
            ) : (
              <PanelLeftClose strokeWidth={1.35} className="h-5 w-5" />
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
