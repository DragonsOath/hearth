import { useState } from "react";
import { Check, ExternalLink, KeyRound, LogOut, Pencil, Route, Trash2 } from "lucide-react";
import type { TailscaleDashboard as Data, TailscaleDevice } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Tailscale from Hearth, read from Tailscale's own API. The Overview answers "can I reach home, and
 * is anything about to lock me out?": devices online, devices waiting for approval, keys running
 * out, exit nodes and subnet routes waiting, updates, and DNS, each with the fix beside it.
 * Devices lists every device with its address, state and key, and approves, renames or removes
 * one. Every change is a protected plan: approving asks you to confirm it is you. Access rules,
 * DNS and keys stay in Tailscale's admin console.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-tailscale-control" as const;
const CONSOLE = "https://login.tailscale.com/admin/machines";
const DAY = 86_400_000;
const KEY_WARN_DAYS = 14;

const daysLeft = (iso?: string) =>
  iso ? Math.floor((Date.parse(iso) - Date.now()) / DAY) : undefined;

function useTailnet(serviceId: string) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "tailscale" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useTailnet>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="tsn-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        <p className="mt-1 text-[0.8rem] text-faint">
          Tailscale keeps your devices in its own service. Make an access token in Tailscale's admin
          console (Settings, Keys, Generate access token) and add it to Secure Vault for this
          service, with the address https://api.tailscale.com. Tokens last up to 90 days.
        </p>
      </div>
    );
  return null;
}

function Console({ children }: { children: React.ReactNode }) {
  return (
    <a
      href={CONSOLE}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}

function Footer({ d, sample }: { d: Data; sample?: boolean }) {
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.domain ? `${d.domain} · ` : ""}read from Tailscale's API every minute · Access rules, DNS
      and keys are set in Tailscale's admin console. <Console>Open Tailscale</Console>
    </p>
  );
}

type Propose = (params: Record<string, string>, title: string) => void;

export function TailscaleDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useTailnet(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Tailscale's panel.");
  if (!d) return <Gate name={name} q={q} />;
  const own = d.devices.filter((x) => !x.external);
  const online = own.filter((x) => x.online);
  const waiting = own.filter((x) => !x.authorized);
  const keys = own
    .filter((x) => x.keyExpires !== undefined && daysLeft(x.keyExpires)! < KEY_WARN_DAYS)
    .sort((a, b) => daysLeft(a.keyExpires)! - daysLeft(b.keyExpires)!);
  const exits = own.filter((x) => x.exitNode.approved);
  const offers = own.filter(
    (x) =>
      (x.exitNode.offered && !x.exitNode.approved) ||
      x.routes.offered.some((r) => !x.routes.approved.includes(r)),
  );
  const updates = own.filter((x) => x.updateAvailable);
  const propose: Propose = (params, title) => void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="tsn-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("devices")}
          data-hearth-target="tab:devices:open"
        >
          <p className={eyebrow}>Online</p>
          <p className="stat-value text-ink tabular" data-testid="tsn-online">
            {online.length} of {own.length}
          </p>
          <p className="text-[0.74rem] text-faint">devices on the tailnet</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Waiting</p>
          <p
            className={cx("stat-value tabular", waiting.length ? "text-amber" : "text-ink")}
            data-testid="tsn-waiting"
          >
            {waiting.length}
          </p>
          <p className="text-[0.74rem] text-faint">to be approved</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Keys</p>
          <p
            className={cx(
              "stat-value tabular",
              keys.some((x) => daysLeft(x.keyExpires)! < 0)
                ? "text-alert"
                : keys.length
                  ? "text-amber"
                  : "text-ok",
            )}
            data-testid="tsn-keys"
          >
            {keys.length}
          </p>
          <p className="text-[0.74rem] text-faint">running out within 2 weeks</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Exit nodes</p>
          <p className="stat-value text-ink tabular" data-testid="tsn-exits">
            {exits.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {exits.length ? exits.map((x) => x.name).join(", ") : "none approved"}
          </p>
        </div>
      </div>

      {(waiting.length > 0 || keys.length > 0 || offers.length > 0) && (
        <div className="space-y-2" data-testid="tsn-attention">
          <p className={eyebrow}>Needs a look</p>
          <ul className="space-y-2 text-[0.84rem]">
            {waiting.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="tsn-waiting-item"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{x.name}</span>
                  <span className="text-amber"> wants to join</span>
                  <span className="text-faint">
                    {" "}
                    · {x.os}, {x.user}
                  </span>
                </span>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose({ op: "authorize", deviceId: x.id }, `Approve ${x.name} on the tailnet`)
                  }
                  data-testid="tsn-approve"
                >
                  <Check strokeWidth={1.5} className="h-3.5 w-3.5" /> Approve
                </button>
              </li>
            ))}
            {keys.map((x) => {
              const left = daysLeft(x.keyExpires)!;
              return (
                <li
                  key={`k${x.id}`}
                  className="flex flex-wrap items-center gap-2"
                  data-testid="tsn-key-item"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{x.name}</span>
                    <span className={left < 0 ? "text-alert" : "text-amber"}>
                      {left < 0
                        ? "'s key has expired: it is off the tailnet until signed in again"
                        : `'s key runs out in ${left} ${left === 1 ? "day" : "days"}`}
                    </span>
                  </span>
                  {left >= 0 && (
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "expiry-off", deviceId: x.id },
                          `Turn off key expiry for ${x.name}`,
                        )
                      }
                      title="For a server or anything that should stay connected"
                    >
                      <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" /> Never expire
                    </button>
                  )}
                </li>
              );
            })}
            {offers.map((x) => (
              <li
                key={`o${x.id}`}
                className="flex flex-wrap items-center gap-2"
                data-testid="tsn-offer-item"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{x.name}</span>
                  <span className="text-muted">
                    {" "}
                    offers{" "}
                    {[
                      x.exitNode.offered && !x.exitNode.approved ? "to be an exit node" : "",
                      x.routes.offered.filter((r) => !x.routes.approved.includes(r)).join(", "),
                    ]
                      .filter(Boolean)
                      .join(" and ")}
                  </span>
                </span>
                {x.exitNode.offered && !x.exitNode.approved && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: "exit-approve", deviceId: x.id },
                        `Approve ${x.name} as an exit node`,
                      )
                    }
                    data-testid="tsn-exit-approve"
                  >
                    <LogOut strokeWidth={1.5} className="h-3.5 w-3.5" /> Approve exit node
                  </button>
                )}
                {x.routes.offered.some((r) => !x.routes.approved.includes(r)) && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: "routes-approve", deviceId: x.id },
                        `Approve ${x.name}'s subnet routes`,
                      )
                    }
                  >
                    <Route strokeWidth={1.5} className="h-3.5 w-3.5" /> Approve routes
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {updates.length > 0 && (
        <p className="text-[0.82rem] text-muted" data-testid="tsn-updates">
          Tailscale has an update for {updates.map((x) => x.name).join(", ")}. Each device updates
          itself (or from its app store); Hearth does not install it.
        </p>
      )}

      <p className="text-[0.82rem] text-muted" data-testid="tsn-dns">
        MagicDNS {d.dns.magicDns === false ? "off" : d.dns.magicDns ? "on" : "unknown"}
        {d.dns.nameservers.length ? ` · nameservers ${d.dns.nameservers.join(", ")}` : ""}
        {d.devices.some((x) => x.external)
          ? ` · ${d.devices.filter((x) => x.external).length} shared in from other tailnets`
          : ""}
      </p>

      <Footer d={d} sample={q.data?.sample} />
    </section>
  );
}

type Show = "all" | "offline" | "waiting" | "routes";

function DeviceActions({ x, propose }: { x: TailscaleDevice; propose: Propose }) {
  const [renaming, setRenaming] = useState(false);
  const [to, setTo] = useState(x.name);
  if (x.external)
    return (
      <p className="text-[0.74rem] text-faint">Shared in from another tailnet: change it there.</p>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        className={btn}
        onClick={() =>
          propose(
            { op: x.authorized ? "deauthorize" : "authorize", deviceId: x.id },
            `${x.authorized ? "Take away" : "Approve"} ${x.name}'s access`,
          )
        }
        data-testid="tsn-auth-toggle"
      >
        <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
        {x.authorized ? "Take access away" : "Approve"}
      </button>
      <button
        type="button"
        className={btn}
        onClick={() =>
          propose(
            { op: x.keyExpiryDisabled ? "expiry-on" : "expiry-off", deviceId: x.id },
            `Turn key expiry ${x.keyExpiryDisabled ? "on" : "off"} for ${x.name}`,
          )
        }
      >
        <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" />
        {x.keyExpiryDisabled ? "Let the key expire" : "Never expire"}
      </button>
      {x.exitNode.offered && (
        <button
          type="button"
          className={btn}
          onClick={() =>
            propose(
              { op: x.exitNode.approved ? "exit-withdraw" : "exit-approve", deviceId: x.id },
              `${x.exitNode.approved ? "Stop" : "Approve"} ${x.name} as an exit node`,
            )
          }
        >
          <LogOut strokeWidth={1.5} className="h-3.5 w-3.5" />
          {x.exitNode.approved ? "Stop exit node" : "Approve exit node"}
        </button>
      )}
      {x.routes.offered.length > 0 && (
        <button
          type="button"
          className={btn}
          onClick={() => {
            const all = x.routes.offered.every((r) => x.routes.approved.includes(r));
            propose(
              { op: all ? "routes-withdraw" : "routes-approve", deviceId: x.id },
              `${all ? "Withdraw" : "Approve"} ${x.name}'s subnet routes`,
            );
          }}
        >
          <Route strokeWidth={1.5} className="h-3.5 w-3.5" />
          {x.routes.offered.every((r) => x.routes.approved.includes(r))
            ? "Withdraw routes"
            : "Approve routes"}
        </button>
      )}
      {renaming ? (
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            propose(
              { op: "rename", deviceId: x.id, value: to.trim() },
              `Rename ${x.name} to ${to.trim()}`,
            );
            setRenaming(false);
          }}
        >
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label={`New name for ${x.name}`}
            className={cx(input, "w-32")}
          />
          <button type="submit" className={btn}>
            Rename
          </button>
        </form>
      ) : (
        <button type="button" className={btn} onClick={() => setRenaming(true)}>
          <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename
        </button>
      )}
      <button
        type="button"
        className={cx(btn, "ml-auto hover:border-alert/60 hover:text-alert")}
        onClick={() =>
          propose({ op: "remove", deviceId: x.id }, `Remove ${x.name} from the tailnet`)
        }
      >
        <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
      </button>
    </div>
  );
}

export function TailscaleDevices({ serviceId, name }: AppViewProps) {
  const { q, d } = useTailnet(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Tailscale's panel.");
  const [find, setFind] = useState("");
  const [show, setShow] = useState<Show>("all");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.devices.filter(
    (x) =>
      (show === "all" ||
        (show === "offline"
          ? !x.online
          : show === "waiting"
            ? !x.authorized
            : x.exitNode.offered || x.routes.offered.length > 0)) &&
      (!needle ||
        [x.name, x.hostname, x.os, x.user, ...x.tags, ...x.addresses].some((v) =>
          v.toLowerCase().includes(needle),
        )),
  );
  const propose: Propose = (params, title) => void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-3"
      data-testid="tsn-devices-tab"
      aria-label={`${name}: devices`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a device, address, user or tag"
          aria-label="Find a device"
          className={cx(input, "min-h-9 min-w-48 flex-1")}
          data-hearth-target="devices:find"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["offline", "Offline"],
              ["waiting", "Waiting"],
              ["routes", "Exit nodes and routes"],
            ] as [Show, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={show === v}
              className={cx(btn, show === v && "border-gold/60 text-gold")}
              onClick={() => setShow(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line">
        {list.map((x) => {
          const left = daysLeft(x.keyExpires);
          return (
            <li
              key={x.id}
              className="space-y-1.5 py-3"
              data-testid="tsn-device"
              data-capture-item
              data-capture-label={x.name}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={cx(
                    "h-2 w-2 shrink-0 self-center rounded-full",
                    x.online ? "bg-ok" : "bg-faint",
                  )}
                  aria-hidden
                />
                <span className="text-[0.9rem] text-ink">{x.name}</span>
                <span className="font-mono text-[0.74rem] text-muted">{x.addresses[0]}</span>
                <span className="text-[0.74rem] text-faint">
                  {x.os} · {x.tags.length ? x.tags.join(", ") : x.user}
                </span>
                {!x.authorized && (
                  <span className="text-[0.74rem] text-amber">waiting for approval</span>
                )}
                {x.external && <span className="text-[0.74rem] text-faint">shared in</span>}
                <span className="ml-auto text-[0.74rem] text-faint">
                  {x.online
                    ? "online"
                    : x.lastSeen
                      ? `last seen ${ago(x.lastSeen).toLowerCase()}`
                      : "offline"}
                </span>
              </div>
              <p className="text-[0.74rem] text-faint">
                {x.keyExpiryDisabled ? (
                  "key never expires"
                ) : left === undefined ? (
                  ""
                ) : left < 0 ? (
                  <span className="text-alert">key expired</span>
                ) : (
                  <span className={left < KEY_WARN_DAYS ? "text-amber" : ""}>
                    key runs out in {left} days
                  </span>
                )}
                {x.clientVersion ? ` · Tailscale ${x.clientVersion}` : ""}
                {x.updateAvailable ? <span className="text-amber"> (update available)</span> : null}
                {x.exitNode.offered
                  ? ` · exit node ${x.exitNode.approved ? "approved" : "offered"}`
                  : ""}
                {x.routes.offered.length
                  ? ` · routes ${x.routes.offered.map((r) => `${r}${x.routes.approved.includes(r) ? "" : " (offered)"}`).join(", ")}`
                  : ""}
                {x.ssh ? " · Tailscale SSH" : ""}
              </p>
              <DeviceActions x={x} propose={propose} />
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="py-3 text-[0.84rem] text-faint">No device matches.</li>
        )}
      </ul>
      <p className="text-[0.74rem] text-faint">
        Every change here asks you to confirm it is you. Removing a device makes it sign in and be
        approved again to come back. Access rules (ACLs) live in Tailscale's admin console.{" "}
        <Console>Open Tailscale</Console>
      </p>
    </section>
  );
}
