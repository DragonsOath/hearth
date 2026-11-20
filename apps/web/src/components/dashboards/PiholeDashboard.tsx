import { useState } from "react";
import { ExternalLink, MessageCircle, Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { PiholeDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { PasteKey } from "./PasteKey";
import { EmberMark } from "../ember/EmberMark";

/**
 * Pi-hole from Hearth. The Overview answers "is it blocking, and what?": queries and blocked in
 * the last 24 hours, the most blocked domains (each one allowed in one step), the busiest devices,
 * pause and turn back on, and the blocklists' last update with Update now. Lists and domains holds
 * the blocklists (on, off, add, remove) and the domains allowed or blocked by name. Pi-hole is the
 * network's DNS: every change is a protected plan, so approving it asks you to confirm it is you.
 */

export const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
export const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";

const PAUSES: [number, string][] = [
  [300, "5 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [0, "Until I turn it on"],
];

export function usePihole(serviceId: string) {
  const q = useDashboard(serviceId, true, 15_000);
  const d: Data | undefined = q.data?.data?.app === "pihole" ? q.data.data : undefined;
  return { q, d };
}

/** Loading, a missing password, or an error: what to show instead of the panel. */
export function Gate({
  serviceId,
  name,
  q,
}: {
  serviceId: string;
  name: string;
  q: ReturnType<typeof usePihole>["q"];
}) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="Settings, then Web interface / API (switch on Expert), then Configure app password, and copy it (Pi-hole shows it once)"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ph-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  return null;
}

const minutes = (sec: number) =>
  sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.max(1, Math.ceil(sec / 60))} min`;

function Blocking({ d, name, act }: { d: Data; name: string; act: ApproveHere }) {
  const [choosing, setChoosing] = useState(false);
  const on = d.blocking === "enabled";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-3 rounded-xl border p-3",
        on ? "border-ok/40" : "border-amber/50",
      )}
      data-testid="ph-blocking"
      data-state={d.blocking}
    >
      <ShieldCheck className={cx("h-6 w-6", on ? "text-ok" : "text-amber")} strokeWidth={1.5} />
      <div className="min-w-[12rem] flex-1">
        <p className="text-[0.95rem] text-ink">
          {on
            ? "Blocking ads"
            : d.blocking === "failed"
              ? "Blocking could not start"
              : "Ad blocking is paused"}
        </p>
        <p className="text-[0.76rem] text-faint">
          {on
            ? `For every device that uses ${name} for DNS.`
            : d.resumesInSec
              ? `Back on by itself in ${minutes(d.resumesInSec)}.`
              : "Until it is turned back on."}
        </p>
      </div>
      {on ? (
        choosing ? (
          <div className="flex flex-wrap gap-1.5" data-testid="ph-pause-choices">
            {PAUSES.map(([sec, label]) => (
              <button
                key={sec}
                type="button"
                className={btn}
                data-hearth-target={`pihole:pause-${sec}`}
                onClick={() => {
                  setChoosing(false);
                  void act.propose(
                    "app-pihole-control",
                    { op: "pause", seconds: sec },
                    `Pause ad blocking in ${name}`,
                  );
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={btn}
              onClick={() => setChoosing(false)}
              data-hearth-target="pihole:pause-cancel"
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button
            tone="outline"
            data-testid="ph-pause"
            data-hearth-target="pihole:pause"
            data-show-safe
            onClick={() => setChoosing(true)}
          >
            <Pause className="h-4 w-4" /> Pause blocking
          </Button>
        )
      ) : (
        <Button
          tone="primary"
          data-testid="ph-resume"
          data-hearth-target="pihole:resume"
          onClick={() =>
            void act.propose(
              "app-pihole-control",
              { op: "resume" },
              `Turn ad blocking on in ${name}`,
            )
          }
        >
          <Play className="h-4 w-4" /> Turn blocking on
        </Button>
      )}
    </div>
  );
}

/** Queries per hour, allowed and blocked stacked; each bar names its hour and numbers. */
function History({ d }: { d: Data }) {
  const max = Math.max(1, ...d.history.map((h) => h.total));
  if (!d.history.length) return null;
  return (
    <figure data-testid="ph-history">
      <figcaption className="mb-1 flex flex-wrap items-center gap-x-3 text-[0.72rem] text-faint">
        <span className="flex-1 tracking-wide uppercase">Queries per hour</span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-line-strong" /> allowed
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-gold" /> blocked
        </span>
      </figcaption>
      <div
        className="flex h-20 items-end gap-[2px]"
        role="img"
        aria-label={`Queries per hour over the last ${d.history.length} hours: at most ${max}.`}
      >
        {d.history.map((h) => {
          const hour = new Date(h.at).toLocaleTimeString([], { hour: "numeric" });
          return (
            <div
              key={h.at}
              className="group flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${hour}: ${h.total} queries, ${h.blocked} blocked`}
            >
              <div
                className="rounded-t-[4px] bg-line-strong group-hover:opacity-80"
                style={{ height: `${((h.total - h.blocked) / max) * 100}%` }}
              />
              <div
                className="mt-[2px] bg-gold group-hover:opacity-80"
                style={{ height: `${(h.blocked / max) * 100}%` }}
              />
            </div>
          );
        })}
      </div>
    </figure>
  );
}

function Tile({
  label,
  value,
  sub,
  id,
  onOpen,
  target,
}: {
  label: string;
  value: string;
  sub: string;
  id?: string;
  /** Opens the query log at what this number counts. */
  onOpen?: () => void;
  target?: string;
}) {
  const Box = onOpen ? "button" : "div";
  return (
    <Box
      {...(onOpen
        ? { type: "button" as const, onClick: onOpen, "data-hearth-target": target }
        : {})}
      className={cx(
        "stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left",
        onOpen && "hover:border-gold/50",
      )}
    >
      <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
      <p className="stat-value text-ink tabular" data-testid={id}>
        {value}
      </p>
      <p className="text-[0.74rem] text-faint">{sub}</p>
    </Box>
  );
}

export function Footer({
  d,
  name,
  sample,
  serviceId,
}: {
  d: Data;
  name: string;
  sample?: boolean;
  serviceId: string;
}) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const web = keyPageHref(service, "/admin/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `${name} ${d.version} · ` : ""}
      {d.update ? <span className="text-amber">{d.update} </span> : null}
      live, every 15 s · Every change asks you to confirm it is you (Pi-hole is your DNS).{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="ph-open-webui"
        >
          Open Pi-hole <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

export function PiholeDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = usePihole(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Pi-hole's panel.");
  const cave = useCave();
  const gate = <Gate serviceId={serviceId} name={name} q={q} />;
  if (!d) return gate;
  const failing = d.lists.filter(
    (l) =>
      l.enabled &&
      (l.status === "unreachable" || l.status === "unreachable, using the copy it had"),
  );
  const allowed = new Set(d.allowed.map((a) => a.domain));
  return (
    <section
      className="@container space-y-4"
      data-testid="ph-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      <Blocking d={d} name={name} act={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <Tile
          label="Queries"
          value={d.queries.total.toLocaleString()}
          sub="last 24 hours"
          id="ph-queries"
          onOpen={() => onGo?.("queries")}
          target="tab:queries:open"
        />
        <Tile
          label="Blocked"
          value={d.queries.blocked.toLocaleString()}
          sub={`${d.queries.percentBlocked}% of queries`}
          id="ph-blocked"
          onOpen={() => onGo?.("queries", "blocked")}
          target="tab:queries:blocked"
        />
        <Tile
          label="Devices"
          value={String(d.clients.active)}
          sub={`active, of ${d.clients.total} seen`}
        />
        <Tile
          label="On blocklists"
          value={d.gravity.domains.toLocaleString()}
          sub={d.gravity.updatedAt ? `domains, updated ${ago(d.gravity.updatedAt)}` : "domains"}
          id="ph-gravity"
        />
      </div>
      <History d={d} />

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <p className={eyebrow}>Most blocked</p>
          {d.topBlocked.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ph-top-blocked">
              {d.topBlocked.map((t) => (
                <li
                  key={t.domain}
                  className="flex flex-wrap items-center gap-2 py-1.5"
                  data-testid="ph-blocked-domain"
                  data-capture-item
                  data-capture-label={t.domain}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 break-all text-left text-ink hover:text-gold"
                    title="See its lookups in the query log"
                    data-hearth-target={`queries:domain:${t.domain}`}
                    onClick={() => onGo?.("queries", `domain/${t.domain}`)}
                  >
                    {t.domain}
                  </button>
                  <span className="text-faint tabular">{t.count.toLocaleString()}</span>
                  {allowed.has(t.domain) ? (
                    <span className="text-[0.74rem] text-faint">allowed</span>
                  ) : (
                    <button
                      type="button"
                      className={btn}
                      data-hearth-target={`domain:allow:${t.domain}`}
                      onClick={() =>
                        void act.propose(
                          "app-pihole-control",
                          { op: "allow", domain: t.domain },
                          `Allow ${t.domain} in ${name}`,
                        )
                      }
                    >
                      Allow
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.82rem] text-faint">Nothing blocked in the last 24 hours.</p>
          )}
          <p className="mt-1 text-[0.74rem] text-faint">
            Something broke on a site? Find what it looked up in the{" "}
            <button
              type="button"
              className="text-gold underline-offset-2 hover:underline"
              onClick={() => onGo?.("queries", "blocked")}
              data-hearth-target="tab:queries:blocked"
            >
              query log
            </button>{" "}
            and allow it there. Domains you allowed or blocked are in{" "}
            <button
              type="button"
              className="text-gold underline-offset-2 hover:underline"
              onClick={() => onGo?.("lists")}
              data-hearth-target="tab:lists:open"
            >
              Lists and domains
            </button>
            .
          </p>
        </div>
        <div className="space-y-4">
          <div>
            <p className={eyebrow}>Busiest devices</p>
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ph-top-clients">
              {d.topClients.map((c) => (
                <li key={c.ip} className="flex gap-2 py-1.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 break-all text-left text-ink hover:text-gold"
                    title="See this device's lookups in the query log"
                    data-hearth-target={`queries:client:${c.ip}`}
                    onClick={() => onGo?.("queries", `client/${c.ip}`)}
                  >
                    {c.name}
                    {c.name !== c.ip && <span className="text-faint"> · {c.ip}</span>}
                  </button>
                  <span className="text-faint tabular">{c.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className={eyebrow}>Blocklists</p>
            <p className="text-[0.82rem] text-muted">
              {d.lists.filter((l) => l.enabled && l.type === "block").length} on,{" "}
              {d.gravity.updatedAt ? `updated ${ago(d.gravity.updatedAt)}` : "never updated"}.
              {failing.length > 0 && (
                <span className="text-amber" data-testid="ph-lists-failing">
                  {" "}
                  {failing.length} could not be downloaded.{" "}
                  <button
                    type="button"
                    className="text-gold underline-offset-2 hover:underline"
                    onClick={() => onGo?.("lists")}
                    data-hearth-target="tab:lists:open"
                  >
                    See which
                  </button>
                </span>
              )}
            </p>
            <Button
              tone="outline"
              className="mt-2"
              data-testid="ph-gravity-update"
              data-hearth-target="pihole:gravity"
              onClick={() =>
                void act.propose(
                  "app-pihole-control",
                  { op: "gravity" },
                  `Update ${name}'s blocklists`,
                )
              }
            >
              <RefreshCw className="h-4 w-4" /> Update blocklists
            </Button>
          </div>
          {d.messages.length > 0 && (
            <div data-testid="ph-messages">
              <p className={eyebrow}>{name} says</p>
              <ul className="space-y-1.5 text-[0.8rem]">
                {d.messages.slice(0, 5).map((m) => (
                  <li key={m.id} className="break-words text-muted">
                    {m.text} <span className="text-faint">· {ago(m.at)}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
                onClick={() =>
                  cave.ask(
                    `${name} shows these warnings: ${d.messages
                      .slice(0, 5)
                      .map((m) => m.text)
                      .join("; ")}. What do they mean, and how do I fix them?`,
                  )
                }
              >
                <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                <EmberMark />
              </button>
            </div>
          )}
        </div>
      </div>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** One domain on the allowed or blocked list. */
function DomainRow({
  domain,
  comment,
  match,
  list,
  name,
  act,
}: {
  domain: string;
  comment?: string;
  match: "exact" | "regex";
  list: "allow" | "deny";
  name: string;
  act: ApproveHere;
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-2 py-1.5"
      data-testid="ph-domain"
      data-list={list}
      data-match={match}
    >
      <span className="min-w-0 flex-1 break-all text-ink">
        {match === "regex" && (
          <span className="mr-1.5 rounded border border-line px-1 text-[0.7rem] text-faint">
            pattern
          </span>
        )}
        <span className={match === "regex" ? "font-mono text-[0.8rem]" : undefined}>{domain}</span>
        {comment && <span className="text-faint"> · {comment}</span>}
      </span>
      <button
        type="button"
        className={btn}
        data-hearth-target={`domain:remove:${domain}`}
        onClick={() =>
          void act.propose(
            "app-pihole-control",
            { op: "domain-remove", domain, list, ...(match === "regex" ? { match } : {}) },
            `Take ${domain} off ${name}'s ${list === "allow" ? "allowed" : "blocked"} list`,
          )
        }
      >
        Take off
      </button>
    </li>
  );
}

export function PiholeLists({ serviceId, name }: AppViewProps) {
  const { q, d } = usePihole(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Pi-hole's Lists and domains tab.");
  const [domain, setDomain] = useState("");
  const [pattern, setPattern] = useState(false);
  const [address, setAddress] = useState("");
  const gate = <Gate serviceId={serviceId} name={name} q={q} />;
  if (!d) return gate;
  const field =
    "min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";
  return (
    <section
      className="@container space-y-5"
      data-testid="ph-lists"
      aria-label={`${name}: lists and domains`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div>
        <p className={eyebrow}>Allow or block a domain, or a pattern</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => e.preventDefault()}
          data-testid="ph-domain-form"
        >
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={pattern ? "(\\.|^)doubleclick\\.net$" : "ads.example.com"}
            aria-label={pattern ? "Pattern" : "Domain"}
            className={field}
            data-hearth-target="domain:name"
          />
          {(["allow", "deny"] as const).map((op) => (
            <Button
              key={op}
              tone="outline"
              disabled={!domain.trim()}
              data-hearth-target={`domain:${op}`}
              onClick={() =>
                void act
                  .propose(
                    "app-pihole-control",
                    { op, domain: domain.trim(), ...(pattern ? { match: "regex" } : {}) },
                    `${op === "allow" ? "Allow" : "Block"} ${pattern ? "a pattern" : domain.trim()} in ${name}`,
                  )
                  .then(() => setDomain(""))
              }
            >
              {op === "allow" ? "Allow" : "Block"}
            </Button>
          ))}
          <label className="inline-flex w-full items-center gap-1.5 text-[0.76rem] text-muted">
            <input
              type="checkbox"
              checked={pattern}
              onChange={(e) => setPattern(e.target.checked)}
              className="h-4 w-4"
              data-hearth-target="domain:pattern"
            />
            A pattern (regular expression) that matches many names, like every subdomain
          </label>
        </form>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2">
        {(
          [
            ["Always allowed", "allow", d.allowed],
            ["Always blocked", "deny", d.denied],
          ] as const
        ).map(([title, list, items]) => (
          <div key={list}>
            <p className={eyebrow}>{title}</p>
            {items.length ? (
              <ul className="divide-y divide-line text-[0.84rem]">
                {items.map((x) => (
                  <DomainRow
                    key={`${x.match}:${x.domain}`}
                    domain={x.domain}
                    match={x.match}
                    {...(x.comment ? { comment: x.comment } : {})}
                    list={list}
                    name={name}
                    act={act}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-[0.82rem] text-faint">None.</p>
            )}
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <p className={cx(eyebrow, "mb-0 flex-1")}>Blocklists and allowlists</p>
          <Button
            tone="outline"
            data-hearth-target="pihole:gravity"
            onClick={() =>
              void act.propose(
                "app-pihole-control",
                { op: "gravity" },
                `Update ${name}'s blocklists`,
              )
            }
          >
            <RefreshCw className="h-4 w-4" /> Update blocklists
          </Button>
        </div>
        <ul className="divide-y divide-line text-[0.84rem]">
          {d.lists.map((l) => {
            const bad =
              l.status === "unreachable" || l.status === "unreachable, using the copy it had";
            return (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-2 py-2"
                data-testid="ph-list"
                data-enabled={l.enabled ? "yes" : "no"}
                data-capture-item
                data-capture-label={l.comment ?? l.address}
              >
                <div className="min-w-0 flex-1">
                  <p className="break-all text-ink">{l.comment ?? l.address}</p>
                  <p
                    className={cx("text-[0.74rem]", bad && l.enabled ? "text-amber" : "text-faint")}
                  >
                    {l.comment ? `${l.address} · ` : ""}
                    {l.type === "allow" ? "allowlist" : "blocklist"} · {l.domains.toLocaleString()}{" "}
                    domains · {l.status}
                    {l.updatedAt ? `, ${ago(l.updatedAt)}` : ""}
                  </p>
                </div>
                <label className="inline-flex items-center gap-1.5 text-[0.76rem] text-muted">
                  <input
                    type="checkbox"
                    checked={l.enabled}
                    aria-label={`${l.comment ?? l.address} on`}
                    data-hearth-target={`list:toggle:${l.id}`}
                    onChange={() =>
                      void act.propose(
                        "app-pihole-control",
                        { op: l.enabled ? "list-disable" : "list-enable", listId: l.id },
                        `Switch ${l.enabled ? "off" : "on"} a list in ${name}`,
                      )
                    }
                    className="h-4 w-4"
                  />
                  On
                </label>
                <button
                  type="button"
                  className={btn}
                  data-hearth-target={`list:remove:${l.id}`}
                  onClick={() =>
                    void act.propose(
                      "app-pihole-control",
                      { op: "list-remove", listId: l.id },
                      `Remove a list from ${name}`,
                    )
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => e.preventDefault()}
          data-testid="ph-list-form"
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://example.org/blocklist.txt"
            aria-label="List address"
            className={field}
            data-hearth-target="list:address"
          />
          <Button
            tone="outline"
            disabled={!address.trim()}
            data-hearth-target="list:add"
            onClick={() =>
              void act
                .propose(
                  "app-pihole-control",
                  { op: "list-add", body: address.trim(), listType: "block" },
                  `Add a blocklist to ${name}`,
                )
                .then(() => setAddress(""))
            }
          >
            Add blocklist
          </Button>
        </form>
        <p className="mt-1 text-[0.74rem] text-faint">
          A new list is used from the next blocklist update. Group assignments, regex filters, DNS
          and DHCP settings stay in Pi-hole.
        </p>
      </div>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
