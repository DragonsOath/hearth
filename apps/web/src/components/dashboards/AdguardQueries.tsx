import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Search } from "lucide-react";
import type { AdguardCheck, AdguardQueries as Log } from "@dragon-control/core";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { btn, eyebrow, field, Footer, Gate, useAdguard } from "./AdguardDashboard";
import { EmberMark } from "../ember/EmberMark";

/**
 * AdGuard Home's query log and "why is this blocked?", the two things people open it for when a
 * site breaks: every recent lookup, newest first, with the device that asked and what AdGuard did
 * (and which rule and list did it), filtered to blocked or allowed and a domain or device; Allow
 * or Block from any line; and for one domain, AdGuard's own answer on why.
 */

type Show = "all" | "blocked" | "allowed";
const KIND = "app-adguard-control" as const;

/** The tab's address ("blocked", "domain/ads.example.com", "search/192.168.1.40"). */
function fromSub(sub?: string | null): { show: Show; search: string; why: string } {
  const [k, ...rest] = (sub ?? "").split("/");
  const v = rest.join("/");
  return {
    show: k === "blocked" || k === "allowed" ? k : "all",
    search: k === "domain" || k === "search" ? v : "",
    why: k === "domain" ? v : "",
  };
}

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

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
    queryKey: ["dashboard", serviceId, "adguard-check", domain],
    queryFn: () =>
      api<AdguardCheck>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/adguard/check?domain=${encodeURIComponent(domain)}`,
      ),
    staleTime: 10_000,
  });
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error || !q.data)
    return <p className="text-[0.82rem] text-amber">{q.error?.message ?? "No answer."}</p>;
  const c = q.data;
  const blocked = c.verdict === "blocked";
  return (
    <div
      className={cx(
        "space-y-2 rounded-xl border p-3 text-[0.84rem]",
        blocked ? "border-gold/50" : "border-line",
      )}
      data-testid="ag-why"
    >
      <p className="text-ink">
        <span className="break-all">{c.domain}</span>: {c.why}
      </p>
      {c.rules.length > 0 && (
        <ul className="text-[0.78rem] text-muted">
          {c.rules.map((r) => (
            <li key={`${r.list}:${r.text}`} className="break-all">
              <span className="font-mono">{r.text}</span> in {r.list}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          c.service ? (
            <p className="text-[0.78rem] text-faint">
              It is blocked as part of a service: change that in Blocked services.
            </p>
          ) : (
            <Button tone="outline" onClick={onAllow} data-hearth-target="why:allow">
              Allow {c.domain}
            </Button>
          )
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
              `In ${name}, ${c.domain}: ${c.why} What is this domain for, and is it safe to ${blocked ? "allow" : "block"}?`,
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
export function AdguardQueries(props: AppViewProps) {
  return <QueryLog key={props.sub ?? ""} {...props} />;
}

function QueryLog({ serviceId, name, sub }: AppViewProps) {
  const { q: board, d } = useAdguard(serviceId);
  const act = useApproveHere(serviceId, "Proposed from AdGuard Home's query log.");
  const start = fromSub(sub);
  const [show, setShow] = useState<Show>(start.show);
  const [typed, setTyped] = useState(start.search);
  const [search, setSearch] = useState(start.search);
  const [pages, setPages] = useState<string[]>([]);
  const [why, setWhy] = useState(start.why);
  // The search box filters as you type, a moment after you stop.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(typed.trim());
      setPages([]);
    }, 400);
    return () => clearTimeout(t);
  }, [typed]);
  const older = pages.at(-1) ?? "";
  const params = new URLSearchParams({ show, search, older });
  const log = useQuery({
    queryKey: ["dashboard", serviceId, "adguard-queries", show, search, older],
    queryFn: () =>
      api<Log>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/adguard/queries?${params}`,
      ),
    refetchInterval: older ? false : 10_000,
    placeholderData: (prev) => prev,
  });
  if (!d) return <Gate name={name} q={board} />;
  const rules = new Set(d.userRules.map((r) => r.text));
  const allow = (x: string) =>
    void act.propose(KIND, { op: "allow", domain: x }, `Allow ${x} in ${name}`);
  const block = (x: string) =>
    void act.propose(KIND, { op: "block", domain: x }, `Block ${x} in ${name}`);
  const isDomain =
    /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(typed.trim()) && !/^[\d.]+$/.test(typed.trim());
  return (
    <section
      className="@container space-y-4"
      data-testid="ag-queries-tab"
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
              onClick={() => {
                setShow(s);
                setPages([]);
              }}
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
            placeholder="Find a domain or device"
            aria-label="Find a domain or device"
            className={cx(field, "w-full pl-8")}
            data-hearth-target="queries:search"
          />
        </label>
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
            {show === "all"
              ? "Lookups"
              : show === "blocked"
                ? "Blocked lookups"
                : "Allowed lookups"}
            , newest first
          </p>
          {log.data.queries.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ag-query-list">
              {log.data.queries.map((x, i) => (
                <li
                  key={`${x.at}:${x.domain}:${i}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5"
                  data-testid="ag-query"
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
                        {x.list && x.verdict === "blocked" && !x.why.includes("custom")
                          ? ` (${x.list})`
                          : ""}
                      </span>
                      <span className="text-faint">
                        {" "}
                        · {x.clientName ?? x.client} · {x.type}
                        {x.ms !== undefined ? ` · ${x.ms} ms` : ""}
                      </span>
                    </span>
                  </span>
                  {x.verdict === "blocked" &&
                  !x.why.startsWith("blocked service") &&
                  !rules.has(`@@||${x.domain}^`) ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => allow(x.domain)}
                      data-hearth-target={`domain:allow:${x.domain}`}
                    >
                      Allow
                    </button>
                  ) : x.verdict === "allowed" && !rules.has(`||${x.domain}^`) ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => block(x.domain)}
                      data-hearth-target={`domain:block:${x.domain}`}
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
            {pages.length > 0 && (
              <Button tone="quiet" onClick={() => setPages(pages.slice(0, -1))}>
                Newer
              </Button>
            )}
            {log.data.older && (
              <Button
                tone="quiet"
                onClick={() => setPages([...pages, log.data!.older!])}
                data-hearth-target="queries:older"
              >
                Older
              </Button>
            )}
          </div>
        </div>
      )}
      <Footer d={d} name={name} sample={board.data?.sample} serviceId={serviceId} />
    </section>
  );
}
