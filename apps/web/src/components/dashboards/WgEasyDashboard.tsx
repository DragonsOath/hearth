import { useState } from "react";
import { CalendarClock, ExternalLink, Pencil, Plus, Power, RotateCw, Trash2 } from "lucide-react";
import type { WgEasyDashboard as Data, WgPeer } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * wg-easy from Hearth. The Overview answers "who is connected to home right now, and is anything
 * off?": clients connected, their last handshake, where they connect from and how much they move,
 * clients past their end date, and how clients reach the server. Clients lists every client and
 * turns one on or off, renames it, gives it an end date, removes it or adds a new one. Every change
 * is a protected plan: approving asks you to confirm it is you. A client's configuration and QR
 * code hold its private key, so they are only ever shown in wg-easy itself.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-wgeasy-control" as const;

/** 3.1 GB, 482 MB. */
const bytes = (n: number) =>
  n >= 1e9
    ? `${Math.round(n / 1e8) / 10} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.round(n / 1e3)} KB`;
const past = (iso?: string) => Boolean(iso && Date.parse(iso) < Date.now());

function useWg(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "wgeasy" ? q.data.data : undefined;
  return { q, d };
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useWg>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="wg-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add the username and password you sign in to wg-easy with to Secure Vault, for this
            service. Hearth reads wg-easy 15 or later, and cannot sign in while two-factor sign-in
            is on for that account.
          </p>
        )}
      </div>
    );
  return null;
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const web = useWeb(serviceId)("/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `wg-easy ${d.version} · ` : ""}
      {d.latest ? <span className="text-amber">{d.latest} is out · </span> : null}
      live, every 30 s · A client's configuration and QR code hold its private key, so they stay in
      wg-easy.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
        >
          Open wg-easy <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

type Propose = (params: Record<string, string | number>, title: string) => void;

export function WgEasyDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useWg(serviceId);
  const act = useApproveHere(serviceId, "Proposed from wg-easy's panel.");
  if (!d) return <Gate name={name} q={q} />;
  const on = d.peers.filter((p) => p.enabled);
  const now = d.peers.filter((p) => p.connected);
  const overdue = on.filter((p) => past(p.expiresAt));
  const down = d.peers.reduce((n, p) => n + p.sentBytes, 0);
  const up = d.peers.reduce((n, p) => n + p.receivedBytes, 0);
  const everything = d.allowedIps.includes("0.0.0.0/0");
  const propose: Propose = (params, title) => void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="wg-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("clients")}
          data-hearth-target="tab:clients:open"
        >
          <p className={eyebrow}>Connected</p>
          <p
            className={cx("stat-value tabular", now.length ? "text-ok" : "text-ink")}
            data-testid="wg-connected"
          >
            {now.length} of {on.length}
          </p>
          <p className="text-[0.74rem] text-faint">clients right now</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Clients</p>
          <p className="stat-value text-ink tabular" data-testid="wg-clients">
            {d.peers.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.peers.length - on.length ? `${d.peers.length - on.length} turned off` : "all on"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Traffic</p>
          <p className="stat-value text-ink tabular" data-testid="wg-traffic">
            {bytes(down)}
          </p>
          <p className="text-[0.74rem] text-faint">to clients · {bytes(up)} from them</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Clients connect to</p>
          <p className="stat-value text-[1rem] break-all text-ink" data-testid="wg-host">
            {d.host ? `${d.host}:${d.port ?? ""}` : "–"}
          </p>
          <p className="text-[0.74rem] text-faint">{d.subnet ?? ""}</p>
        </div>
      </div>

      {overdue.length > 0 && (
        <div className="space-y-2" data-testid="wg-attention">
          <p className={eyebrow}>Needs a look</p>
          <ul className="space-y-2 text-[0.84rem]">
            {overdue.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{p.name}</span>
                  <span className="text-amber">
                    {" "}
                    passed its end date ({p.expiresAt!.slice(0, 10)}) but is still on
                  </span>
                </span>
                <button
                  type="button"
                  className={btn}
                  onClick={() => propose({ op: "disable", clientId: p.id }, `Turn off ${p.name}`)}
                >
                  <Power strokeWidth={1.5} className="h-3.5 w-3.5" /> Turn off
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="wg-now">
        <p className={eyebrow}>Connected now</p>
        {now.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nobody is connected right now.</p>
        ) : (
          <ul className="divide-y divide-line text-[0.84rem]">
            {now.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-x-2 py-1.5">
                <span className="text-ink">{p.name}</span>
                <span className="text-faint">
                  {p.address}
                  {p.from ? ` · from ${p.from}` : ""} · ↓ {bytes(p.sentBytes)} ↑{" "}
                  {bytes(p.receivedBytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[0.82rem] text-muted" data-testid="wg-settings">
        New clients send{" "}
        {everything ? "all their internet traffic" : `only ${d.allowedIps.join(", ")}`} through the
        tunnel{d.dns.length ? `, and ask ${d.dns.join(", ")} for names` : ""}.
      </p>

      <div data-hearth-target="wgeasy:restart">
        <button
          type="button"
          className={btn}
          onClick={() => propose({ op: "restart" }, `Restart WireGuard in ${name}`)}
          data-testid="wg-restart"
        >
          <RotateCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Restart WireGuard
        </button>
      </div>

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

type Show = "all" | "connected" | "off";

function ClientRow({ p, propose, name }: { p: WgPeer; propose: Propose; name: string }) {
  const [edit, setEdit] = useState<"" | "rename" | "date">("");
  const [value, setValue] = useState("");
  return (
    <li
      className="space-y-1.5 py-3"
      data-testid="wg-client"
      data-capture-item
      data-capture-label={p.name}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          className={cx(
            "h-2 w-2 shrink-0 self-center rounded-full",
            p.connected ? "bg-ok" : "bg-faint",
          )}
          aria-hidden
        />
        <span className={cx("text-[0.9rem]", p.enabled ? "text-ink" : "text-faint")}>{p.name}</span>
        <span className="font-mono text-[0.74rem] text-muted">{p.address}</span>
        {!p.enabled && <span className="text-[0.74rem] text-amber">off</span>}
        <span className="ml-auto text-[0.74rem] text-faint">
          {p.connected
            ? "connected"
            : p.lastHandshake
              ? `last seen ${ago(p.lastHandshake).toLowerCase()}`
              : "never connected"}
        </span>
      </div>
      <p className="text-[0.74rem] text-faint">
        ↓ {bytes(p.sentBytes)} ↑ {bytes(p.receivedBytes)}
        {p.from ? ` · from ${p.from}` : ""}
        {p.expiresAt ? (
          <span className={past(p.expiresAt) ? "text-amber" : ""}>
            {" "}
            · {past(p.expiresAt) ? "ended" : "ends"} {p.expiresAt.slice(0, 10)}
          </span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={btn}
          onClick={() =>
            propose(
              { op: p.enabled ? "disable" : "enable", clientId: p.id },
              `${p.enabled ? "Turn off" : "Turn on"} ${p.name} in ${name}`,
            )
          }
          data-testid="wg-toggle"
        >
          <Power strokeWidth={1.5} className="h-3.5 w-3.5" />
          {p.enabled ? "Turn off" : "Turn on"}
        </button>
        {edit ? (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              propose(
                {
                  op: edit === "rename" ? "rename" : "expiry",
                  clientId: p.id,
                  value: value.trim() || "none",
                },
                edit === "rename" ? `Rename ${p.name}` : `Set ${p.name}'s end date`,
              );
              setEdit("");
            }}
          >
            <input
              type={edit === "date" ? "date" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={edit === "rename" ? `New name for ${p.name}` : `End date for ${p.name}`}
              className={cx(input, "w-36")}
            />
            <button type="submit" className={btn}>
              {edit === "rename" ? "Rename" : value ? "Set date" : "No end date"}
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setValue(p.name);
                setEdit("rename");
              }}
            >
              <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setValue(p.expiresAt?.slice(0, 10) ?? "");
                setEdit("date");
              }}
            >
              <CalendarClock strokeWidth={1.5} className="h-3.5 w-3.5" /> End date
            </button>
          </>
        )}
        <button
          type="button"
          className={cx(btn, "ml-auto hover:border-alert/60 hover:text-alert")}
          onClick={() => propose({ op: "remove", clientId: p.id }, `Remove ${p.name} from ${name}`)}
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
        </button>
      </div>
    </li>
  );
}

export function WgEasyClients({ serviceId, name }: AppViewProps) {
  const { q, d } = useWg(serviceId);
  const act = useApproveHere(serviceId, "Proposed from wg-easy's panel.");
  const [find, setFind] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [newName, setNewName] = useState("");
  const [until, setUntil] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.peers.filter(
    (p) =>
      (show === "all" || (show === "connected" ? p.connected : !p.enabled)) &&
      (!needle || p.name.toLowerCase().includes(needle) || p.address.includes(needle)),
  );
  const propose: Propose = (params, title) => void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-3"
      data-testid="wg-clients-tab"
      aria-label={`${name}: clients`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a client or address"
          aria-label="Find a client"
          className={cx(input, "min-h-9 min-w-48 flex-1")}
          data-hearth-target="clients:find"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["connected", "Connected"],
              ["off", "Off"],
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
        {list.map((p) => (
          <ClientRow key={p.id} p={p} propose={propose} name={name} />
        ))}
        {list.length === 0 && (
          <li className="py-3 text-[0.84rem] text-faint">No client matches.</li>
        )}
      </ul>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          propose(
            { op: "add", name: newName.trim(), value: until },
            `Add ${newName.trim()} to ${name}`,
          );
          setNewName("");
          setUntil("");
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New client's name"
          aria-label="New client's name"
          className={cx(input, "min-w-40 flex-1")}
          data-hearth-target="clients:add"
        />
        <input
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          aria-label="End date (optional)"
          className={input}
        />
        <button type="submit" className={btn} disabled={!newName.trim()} data-testid="wg-add">
          <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add client
        </button>
      </form>
      <p className="text-[0.74rem] text-faint">
        Every change here asks you to confirm it is you. After adding a client, scan its QR code in
        wg-easy on the device: it holds the client's private key, so Hearth never shows it. Removing
        a client makes its configuration stop working for good.
      </p>
    </section>
  );
}
