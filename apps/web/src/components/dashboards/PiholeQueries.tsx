import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Search } from "lucide-react";
import type { PiholeCheck, PiholeQueries as Log } from "@dragon-control/core";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { btn, eyebrow, Footer, Gate, usePihole } from "./PiholeDashboard";
import { EmberMark } from "../ember/EmberMark";

/**
 * Pi-hole's query log and "why is this blocked?", the two things people open Pi-hole for when a
 * site breaks: every recent lookup, newest first, with the device that asked and what Pi-hole did,
 * filtered to blocked or allowed, a domain, or one device; Allow or Block from any line; and for one
 * domain, the rules and lists that decide it. Local DNS: the names Pi-hole answers itself.
 */

type Show = "all" | "blocked" | "allowed";

/** The tab's address ("blocked", "domain/ads.example.com", "client/192.168.1.40"). */
function fromSub(sub?: string | null): { show: Show; domain: string; client: string } {
  const [k, ...rest] = (sub ?? "").split("/");
  const v = rest.join("/");
  return {
    show: k === "blocked" || k === "allowed" ? k : "all",
    domain: k === "domain" ? v : "",
    client: k === "client" ? v : "",
  };
}

const field =
  "min-h-9 min-w-0 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Why one domain is blocked or allowed, with the change that fixes it. */
function Why({
  serviceId,
  name,
  domain,
  onAllow,
  onBlock,
}: {
  serviceId: string;
  name: string;
  domain: string;
  onAllow: () => void;
  onBlock: () => void;
}) {
  const cave = useCave();
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "pihole-check", domain],
    queryFn: () =>
      api<PiholeCheck>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/pihole/check?domain=${encodeURIComponent(domain)}`,
      ),
    staleTime: 10_000,
  });
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error || !q.data)
    return <p className="text-[0.82rem] text-amber">{q.error?.message ?? "No answer."}</p>;
  const c = q.data;
  const blocked = c.verdict.startsWith("Blocked");
  return (
    <div
      className={cx(
        "space-y-2 rounded-xl border p-3 text-[0.84rem]",
        blocked ? "border-gold/50" : "border-line",
      )}
      data-testid="ph-why"
    >
      <p className="text-ink">
        <span className="break-all">{c.domain}</span>: {c.verdict}
      </p>
      {c.rules.length > 0 && (
        <ul className="text-[0.78rem] text-muted">
          {c.rules.map((r) => (
            <li key={`${r.list}:${r.domain}`} className="break-all">
              {r.list === "allow" ? "Always allowed" : "Always blocked"}
              {r.match === "regex" ? " by the pattern " : ": "}
              <span className={r.match === "regex" ? "font-mono" : undefined}>{r.domain}</span>
              {!r.enabled && " (switched off)"}
            </li>
          ))}
        </ul>
      )}
      {c.lists.length > 0 && (
        <ul className="text-[0.78rem] text-muted">
          {c.lists.map((l) => (
            <li key={l.id} className="break-all">
              On the {l.type === "block" ? "blocklist" : "allowlist"} {l.address}
              {!l.enabled && " (switched off)"}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <Button tone="outline" onClick={onAllow} data-hearth-target="why:allow">
            Allow {c.domain}
          </Button>
        ) : (
          <Button tone="outline" onClick={onBlock} data-hearth-target="why:block">
            Block {c.domain}
          </Button>
        )}
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
          onClick={() =>
            cave.ask(
              `In ${name}, ${c.domain}: ${c.verdict} What is this domain for, and is it safe to ${blocked ? "allow" : "block"}?`,
            )
          }
        >
          <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
          <EmberMark />
        </button>
      </div>
    </div>
  );
}

/** Opened at an address from the Overview (a domain or a device), the log starts filtered to it. */
export function PiholeQueries(props: AppViewProps) {
  return <QueryLog key={props.sub ?? ""} {...props} />;
}

function QueryLog({ serviceId, name, sub }: AppViewProps) {
  const { q: board, d } = usePihole(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Pi-hole's query log.");
  const start = fromSub(sub);
  const [show, setShow] = useState<Show>(start.show);
  const [domain, setDomain] = useState(start.domain);
  const [typed, setTyped] = useState(start.domain);
  const [client, setClient] = useState(start.client);
  const [more, setMore] = useState(0);
  const [why, setWhy] = useState(start.domain);
  // The search box filters as you type, a moment after you stop.
  useEffect(() => {
    const t = setTimeout(() => {
      setDomain(typed.trim());
      setMore(0);
    }, 400);
    return () => clearTimeout(t);
  }, [typed]);
  const params = new URLSearchParams({ show, domain, client, start: String(more) });
  const log = useQuery({
    queryKey: ["dashboard", serviceId, "pihole-queries", show, domain, client, more],
    queryFn: () =>
      api<Log>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/pihole/queries?${params}`,
      ),
    // Live while you are at the newest lines.
    refetchInterval: more === 0 ? 10_000 : false,
    placeholderData: (prev) => prev,
  });
  if (!d) return <Gate serviceId={serviceId} name={name} q={board} />;
  const allowed = new Set(d.allowed.filter((r) => r.match === "exact").map((r) => r.domain));
  const denied = new Set(d.denied.filter((r) => r.match === "exact").map((r) => r.domain));
  const allow = (x: string) =>
    void act.propose("app-pihole-control", { op: "allow", domain: x }, `Allow ${x} in ${name}`);
  const block = (x: string) =>
    void act.propose("app-pihole-control", { op: "deny", domain: x }, `Block ${x} in ${name}`);
  const filterTo = (next: Partial<{ show: Show; client: string }>) => {
    const s = next.show ?? show;
    const c = next.client ?? client;
    setShow(s);
    setClient(c);
    setMore(0);
  };
  const isDomain = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(typed.trim());
  return (
    <section
      className="@container space-y-4"
      data-testid="ph-queries-tab"
      aria-label={`${name}: query log`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group">
          {(["all", "blocked", "allowed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              data-hearth-target={`queries:show-${s}`}
              onClick={() => filterTo({ show: s })}
              className={cx(
                "min-h-8 rounded-md px-2.5 text-[0.78rem]",
                show === s ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
              )}
            >
              {s === "all" ? "All" : s === "blocked" ? "Blocked" : "Allowed"}
            </button>
          ))}
        </div>
        <label className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2 h-4 w-4 text-faint" />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Find a domain"
            aria-label="Find a domain"
            className={cx(field, "w-full pl-8")}
            data-hearth-target="queries:domain"
          />
        </label>
        <select
          value={client}
          onChange={(e) => filterTo({ client: e.target.value })}
          aria-label="Device"
          className={field}
          data-hearth-target="queries:client"
        >
          <option value="">Every device</option>
          {(log.data?.clients ?? []).map((c) => (
            <option key={c.ip} value={c.ip}>
              {c.name ? `${c.name} (${c.ip})` : c.ip}
            </option>
          ))}
        </select>
        {isDomain && why !== typed.trim().toLowerCase() && (
          <Button
            tone="outline"
            data-hearth-target="queries:why"
            onClick={() => setWhy(typed.trim().toLowerCase())}
          >
            Why is it blocked or allowed?
          </Button>
        )}
      </div>
      {why && (
        <Why
          serviceId={serviceId}
          name={name}
          domain={why}
          onAllow={() => allow(why)}
          onBlock={() => block(why)}
        />
      )}
      {log.isLoading ? (
        <Skeleton className="h-64" />
      ) : log.error || !log.data ? (
        <p className="text-[0.86rem] text-amber">
          Could not read {name}&apos;s query log: {log.error?.message ?? "no answer"}
        </p>
      ) : (
        <div>
          <p className={eyebrow}>
            {log.data.matching.toLocaleString()} {log.data.matching === 1 ? "lookup" : "lookups"}
            {show !== "all" ? `, ${show}` : ""}, newest first
          </p>
          {log.data.queries.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ph-query-list">
              {log.data.queries.map((x) => (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5"
                  data-testid="ph-query"
                  data-verdict={x.verdict}
                  data-capture-item
                  data-capture-label={x.domain}
                >
                  <span className="w-[5.5rem] shrink-0 text-[0.76rem] text-faint tabular">
                    {time(x.at)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="break-all text-left text-ink hover:text-gold"
                      title="Why is it blocked or allowed?"
                      onClick={() => setWhy(x.domain)}
                      data-hearth-target={`queries:why:${x.domain}`}
                    >
                      {x.domain}
                    </button>
                    <span className="block text-[0.74rem]">
                      <span className={x.verdict === "blocked" ? "text-gold" : "text-faint"}>
                        {x.why}
                      </span>
                      <span className="text-faint">
                        {" "}
                        · {x.client.name ?? x.client.ip} · {x.type}
                        {x.ms !== undefined ? ` · ${x.ms} ms` : ""}
                      </span>
                    </span>
                  </span>
                  {x.verdict === "blocked" && !allowed.has(x.domain) ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => allow(x.domain)}
                      data-hearth-target={`domain:allow:${x.domain}`}
                    >
                      Allow
                    </button>
                  ) : x.verdict === "allowed" && !denied.has(x.domain) ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => block(x.domain)}
                      data-hearth-target={`domain:deny:${x.domain}`}
                    >
                      Block
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.82rem] text-faint">No lookups match.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {more > 0 && (
              <Button tone="quiet" onClick={() => setMore(Math.max(0, more - 100))}>
                Newer
              </Button>
            )}
            {more + log.data.queries.length < log.data.matching && (
              <Button
                tone="quiet"
                onClick={() => setMore(more + 100)}
                data-hearth-target="queries:older"
              >
                Older
              </Button>
            )}
          </div>
          <p className="mt-1 text-[0.74rem] text-faint">
            Pi-hole keeps about the last day of lookups in memory; older ones are in its long-term
            data.
          </p>
        </div>
      )}
      <Footer d={d} name={name} sample={board.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** Local DNS: names Pi-hole answers itself (plex.home is 192.168.1.10), and aliases. */
export function PiholeDns({ serviceId, name }: AppViewProps) {
  const { q, d } = usePihole(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Pi-hole's Local DNS tab.");
  const [host, setHost] = useState("");
  const [ip, setIp] = useState("");
  const [alias, setAlias] = useState("");
  const [target, setTarget] = useState("");
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const { records, aliases } = d.localDns;
  return (
    <section
      className="@container space-y-5"
      data-testid="ph-dns"
      aria-label={`${name}: local DNS`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <p className="text-[0.82rem] text-muted">
        Names {name} answers itself, so every device on your network can reach a server by name
        (plex.home) instead of its address. Pi-hole restarts its DNS for a second after each change.
      </p>
      <div className="grid gap-5 @2xl:grid-cols-2">
        <div>
          <p className={eyebrow}>Local names</p>
          {records.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ph-dns-records">
              {records.map((r) => (
                <li
                  key={`${r.name} ${r.ip}`}
                  className="flex flex-wrap items-center gap-2 py-1.5"
                  data-testid="ph-dns-record"
                >
                  <span className="min-w-0 flex-1 break-all text-ink">
                    {r.name} <span className="text-faint">→ {r.ip}</span>
                  </span>
                  <button
                    type="button"
                    className={btn}
                    data-hearth-target={`dns:remove:${r.name}`}
                    onClick={() =>
                      void act.propose(
                        "app-pihole-control",
                        { op: "dns-remove", domain: r.name, ip: r.ip },
                        `Remove the local name ${r.name} from ${name}`,
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.82rem] text-faint">None yet.</p>
          )}
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => e.preventDefault()}
            data-testid="ph-dns-form"
          >
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="plex.home"
              aria-label="Name"
              className={cx(field, "min-w-[9rem] flex-1")}
              data-hearth-target="dns:name"
            />
            <input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.10"
              aria-label="Address"
              className={cx(field, "min-w-[9rem] flex-1")}
              data-hearth-target="dns:ip"
            />
            <Button
              tone="outline"
              disabled={!host.trim() || !ip.trim()}
              data-hearth-target="dns:add"
              onClick={() =>
                void act
                  .propose(
                    "app-pihole-control",
                    { op: "dns-add", domain: host.trim(), ip: ip.trim() },
                    `Add the local name ${host.trim()} to ${name}`,
                  )
                  .then(() => {
                    setHost("");
                    setIp("");
                  })
              }
            >
              Add name
            </Button>
          </form>
        </div>
        <div>
          <p className={eyebrow}>Aliases (CNAME)</p>
          {aliases.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ph-dns-aliases">
              {aliases.map((a) => (
                <li
                  key={`${a.name},${a.target}`}
                  className="flex flex-wrap items-center gap-2 py-1.5"
                  data-testid="ph-dns-alias"
                >
                  <span className="min-w-0 flex-1 break-words text-ink">
                    {a.name} <span className="text-faint">is another name for {a.target}</span>
                  </span>
                  <button
                    type="button"
                    className={btn}
                    data-hearth-target={`alias:remove:${a.name}`}
                    onClick={() =>
                      void act.propose(
                        "app-pihole-control",
                        { op: "alias-remove", domain: a.name, target: a.target },
                        `Remove the alias ${a.name} from ${name}`,
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.82rem] text-faint">None yet.</p>
          )}
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => e.preventDefault()}
            data-testid="ph-alias-form"
          >
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="movies.home"
              aria-label="Alias"
              className={cx(field, "min-w-[9rem] flex-1")}
              data-hearth-target="alias:name"
            />
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="plex.home"
              aria-label="Points to"
              className={cx(field, "min-w-[9rem] flex-1")}
              data-hearth-target="alias:target"
            />
            <Button
              tone="outline"
              disabled={!alias.trim() || !target.trim()}
              data-hearth-target="alias:add"
              onClick={() =>
                void act
                  .propose(
                    "app-pihole-control",
                    { op: "alias-add", domain: alias.trim(), target: target.trim() },
                    `Add the alias ${alias.trim()} to ${name}`,
                  )
                  .then(() => {
                    setAlias("");
                    setTarget("");
                  })
              }
            >
              Add alias
            </Button>
          </form>
        </div>
      </div>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
