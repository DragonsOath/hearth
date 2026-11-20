import { useMemo, useState } from "react";
import { ExternalLink, MessageCircle, Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { AdguardDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * AdGuard Home from Hearth. The Overview answers "is it protecting, and from what?": queries and
 * blocked in the last 24 hours, the most blocked domains (each allowed in one step), the busiest
 * devices, pause and turn back on, the safe browsing, parental control and safe search switches,
 * and the filter lists' state with Update now. Filters holds the filter lists and custom rules,
 * DNS rewrites the names AdGuard answers itself, Blocked services the apps and sites blocked as a
 * whole. AdGuard Home is the network's DNS: every change is a protected plan, so approving it asks
 * you to confirm it is you.
 */

export const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
export const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
export const field =
  "min-h-9 min-w-[9rem] flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";
const KIND = "app-adguard-control" as const;

const PAUSES: [number, string][] = [
  [300, "5 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [0, "Until I turn it on"],
];

export function useAdguard(serviceId: string) {
  const q = useDashboard(serviceId, true, 15_000);
  const d: Data | undefined = q.data?.data?.app === "adguard" ? q.data.data : undefined;
  return { q, d };
}

/** Loading, a missing login, or an error: what to show instead of the panel. */
export function Gate({ name, q }: { name: string; q: ReturnType<typeof useAdguard>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ag-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add the username and password you sign in to AdGuard Home with to Secure Vault, for this
            service.
          </p>
        )}
      </div>
    );
  return null;
}

const minutes = (sec: number) =>
  sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.max(1, Math.ceil(sec / 60))} min`;

function Protection({ d, name, act }: { d: Data; name: string; act: ApproveHere }) {
  const [choosing, setChoosing] = useState(false);
  const on = d.protection.enabled;
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-3 rounded-xl border p-3",
        on ? "border-ok/40" : "border-amber/50",
      )}
      data-testid="ag-protection"
      data-state={on ? "on" : "paused"}
    >
      <ShieldCheck className={cx("h-6 w-6", on ? "text-ok" : "text-amber")} strokeWidth={1.5} />
      <div className="min-w-[12rem] flex-1">
        <p className="text-[0.95rem] text-ink">
          {on ? "Protection is on" : "Protection is paused"}
        </p>
        <p className="text-[0.76rem] text-faint">
          {on
            ? `For every device that uses ${name} for DNS${d.filteringEnabled ? "" : " (filtering is switched off in AdGuard)"}.`
            : d.protection.resumesInSec
              ? `Back on by itself in ${minutes(d.protection.resumesInSec)}.`
              : "Until it is turned back on."}
        </p>
      </div>
      {on ? (
        choosing ? (
          <div className="flex flex-wrap gap-1.5" data-testid="ag-pause-choices">
            {PAUSES.map(([sec, label]) => (
              <button
                key={sec}
                type="button"
                className={btn}
                data-hearth-target={`adguard:pause-${sec}`}
                onClick={() => {
                  setChoosing(false);
                  void act.propose(
                    KIND,
                    { op: "pause", seconds: sec },
                    `Pause protection in ${name}`,
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
              data-hearth-target="adguard:pause-cancel"
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button
            tone="outline"
            data-testid="ag-pause"
            data-hearth-target="adguard:pause"
            data-show-safe
            onClick={() => setChoosing(true)}
          >
            <Pause className="h-4 w-4" /> Pause protection
          </Button>
        )
      ) : (
        <Button
          tone="primary"
          data-testid="ag-resume"
          data-hearth-target="adguard:resume"
          onClick={() => void act.propose(KIND, { op: "resume" }, `Turn protection on in ${name}`)}
        >
          <Play className="h-4 w-4" /> Turn protection on
        </Button>
      )}
    </div>
  );
}

const SWITCHES: [
  keyof Data["safety"],
  "safebrowsing" | "parental" | "safesearch",
  string,
  string,
][] = [
  ["safeBrowsing", "safebrowsing", "Safe browsing", "Blocks sites known for malware and phishing."],
  ["parental", "parental", "Parental control", "Blocks adult sites."],
  ["safeSearch", "safesearch", "Safe search", "Search engines and YouTube in their safe modes."],
];

function Safety({ d, name, act }: { d: Data; name: string; act: ApproveHere }) {
  return (
    <div data-testid="ag-safety">
      <p className={eyebrow}>Safety</p>
      <ul className="divide-y divide-line text-[0.84rem]">
        {SWITCHES.map(([key, setting, label, note]) => (
          <li key={key} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="text-ink">{label}</span>
              <span className="block text-[0.74rem] text-faint">{note}</span>
            </span>
            <label className="inline-flex items-center gap-1.5 text-[0.76rem] text-muted">
              <input
                type="checkbox"
                checked={d.safety[key]}
                aria-label={label}
                data-hearth-target={`safety:${setting}`}
                onChange={() =>
                  void act.propose(
                    KIND,
                    { op: "safety", setting, on: !d.safety[key] },
                    `Switch ${d.safety[key] ? "off" : "on"} ${label.toLowerCase()} in ${name}`,
                  )
                }
                className="h-4 w-4"
              />
              On
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Queries per hour, allowed and blocked stacked; each bar names its hour and numbers. */
function History({ d }: { d: Data }) {
  const max = Math.max(1, ...d.history.map((h) => h.total));
  if (!d.history.length) return null;
  return (
    <figure data-testid="ag-history">
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
  const web = keyPageHref(service, "/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `${name} ${d.version} · ` : ""}
      live, every 15 s · Every change asks you to confirm it is you ({name} is your DNS).{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="ag-open-webui"
        >
          Open AdGuard Home <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

const neverLoaded = (d: Data) => d.filters.filter((f) => f.enabled && !f.updatedAt);

export function AdguardDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useAdguard(serviceId);
  const act = useApproveHere(serviceId, "Proposed from AdGuard Home's panel.");
  const cave = useCave();
  if (!d) return <Gate name={name} q={q} />;
  const failing = neverLoaded(d);
  const allowed = new Set(d.userRules.filter((r) => r.kind === "allow").map((r) => r.domain));
  const lastUpdate = d.filters
    .map((f) => f.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return (
    <section
      className="@container space-y-4"
      data-testid="ag-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      <Protection d={d} name={name} act={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <Tile
          label="Queries"
          value={d.queries.total.toLocaleString()}
          sub={`last 24 hours, ${d.queries.avgMs} ms each`}
          id="ag-queries"
          onOpen={() => onGo?.("queries")}
          target="tab:queries:open"
        />
        <Tile
          label="Blocked"
          value={d.queries.blocked.toLocaleString()}
          sub={`${d.queries.percentBlocked}% of queries`}
          id="ag-blocked"
          onOpen={() => onGo?.("queries", "blocked")}
          target="tab:queries:blocked"
        />
        <Tile
          label="Safety"
          value={(d.queries.safeBrowsing + d.queries.parental).toLocaleString()}
          sub={`dangerous or adult sites blocked, ${d.queries.safeSearch} searches made safe`}
        />
        <Tile
          label="Filter lists"
          value={String(d.filters.filter((f) => f.enabled && !f.allowlist).length)}
          sub={lastUpdate ? `on, updated ${ago(lastUpdate)}` : "on"}
          id="ag-filters"
          onOpen={() => onGo?.("filters")}
          target="tab:filters:open"
        />
      </div>
      <History d={d} />

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <p className={eyebrow}>Most blocked</p>
          {d.topBlocked.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ag-top-blocked">
              {d.topBlocked.map((t) => (
                <li
                  key={t.domain}
                  className="flex flex-wrap items-center gap-2 py-1.5"
                  data-testid="ag-blocked-domain"
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
                          KIND,
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
            and allow it there.
          </p>
        </div>
        <div className="space-y-4">
          <div>
            <p className={eyebrow}>Busiest devices</p>
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ag-top-clients">
              {d.topClients.map((c) => (
                <li key={c.client} className="flex gap-2 py-1.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 break-all text-left text-ink hover:text-gold"
                    title="See this device's lookups in the query log"
                    data-hearth-target={`queries:client:${c.client}`}
                    onClick={() => onGo?.("queries", `search/${c.client}`)}
                  >
                    {c.name ?? c.client}
                  </button>
                  <span className="text-faint tabular">{c.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
          <Safety d={d} name={name} act={act} />
          <div>
            <p className={eyebrow}>Filter lists</p>
            <p className="text-[0.82rem] text-muted">
              Downloaded again{" "}
              {d.updateEveryHours ? `every ${d.updateEveryHours} hours` : "only when you ask"}.
              {failing.length > 0 && (
                <span className="text-amber" data-testid="ag-filters-failing">
                  {" "}
                  {failing.length} never downloaded.{" "}
                  <button
                    type="button"
                    className="text-gold underline-offset-2 hover:underline"
                    onClick={() => onGo?.("filters")}
                    data-hearth-target="tab:filters:open"
                  >
                    See which
                  </button>
                </span>
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                tone="outline"
                data-testid="ag-refresh"
                data-hearth-target="adguard:refresh"
                onClick={() =>
                  void act.propose(KIND, { op: "refresh" }, `Update ${name}'s filter lists`)
                }
              >
                <RefreshCw className="h-4 w-4" /> Update filter lists
              </Button>
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
                onClick={() =>
                  cave.ask(
                    `${name} blocked ${d.queries.percentBlocked}% of ${d.queries.total} queries in the last day with ${d.filters.filter((f) => f.enabled).length} filter lists on. Are my filter lists and safety settings sensible for a home network?`,
                  )
                }
              >
                <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                <EmberMark />
              </button>
            </div>
          </div>
        </div>
      </div>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** Filters: filter lists (blocklists and allowlists) and custom rules. */
export function AdguardFilters({ serviceId, name }: AppViewProps) {
  const { q, d } = useAdguard(serviceId);
  const act = useApproveHere(serviceId, "Proposed from AdGuard Home's Filters tab.");
  const [domain, setDomain] = useState("");
  const [url, setUrl] = useState("");
  const [listName, setListName] = useState("");
  const [allowlist, setAllowlist] = useState(false);
  if (!d) return <Gate name={name} q={q} />;
  const rules = d.userRules.filter((r) => r.kind !== "comment");
  return (
    <section
      className="@container space-y-5"
      data-testid="ag-filters-tab"
      aria-label={`${name}: filters`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div>
        <p className={eyebrow}>Allow or block a domain</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => e.preventDefault()}
          data-testid="ag-domain-form"
        >
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="ads.example.com"
            aria-label="Domain"
            className={field}
            data-hearth-target="domain:name"
          />
          {(["allow", "block"] as const).map((op) => (
            <Button
              key={op}
              tone="outline"
              disabled={!domain.trim()}
              data-hearth-target={`domain:${op}`}
              onClick={() =>
                void act
                  .propose(
                    KIND,
                    { op, domain: domain.trim() },
                    `${op === "allow" ? "Allow" : "Block"} ${domain.trim()} in ${name}`,
                  )
                  .then(() => setDomain(""))
              }
            >
              {op === "allow" ? "Allow" : "Block"}
            </Button>
          ))}
        </form>
        <p className="mt-1 text-[0.74rem] text-faint">
          Each becomes a custom rule for the domain and every subdomain.
        </p>
      </div>
      <div>
        <p className={eyebrow}>Custom rules</p>
        {rules.length ? (
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="ag-rules">
            {rules.map((r) => (
              <li
                key={r.text}
                className="flex flex-wrap items-center gap-2 py-1.5"
                data-testid="ag-rule"
                data-kind={r.kind}
              >
                <span className="min-w-0 flex-1 break-all text-ink">
                  {r.domain ? (
                    <>
                      {r.kind === "allow" ? "Always allowed: " : "Always blocked: "}
                      {r.domain}
                    </>
                  ) : (
                    <span className="font-mono text-[0.8rem]">{r.text}</span>
                  )}
                </span>
                <button
                  type="button"
                  className={btn}
                  data-hearth-target={`rule:remove:${r.text}`}
                  onClick={() =>
                    void act.propose(
                      KIND,
                      { op: "rule-remove", rule: r.text },
                      `Take a custom rule off ${name}`,
                    )
                  }
                >
                  Take off
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.82rem] text-faint">None.</p>
        )}
        <p className="mt-1 text-[0.74rem] text-faint">
          Rules in AdGuard&apos;s own syntax (patterns, $client and the like) are shown as written;
          write new ones of that kind in AdGuard Home.
        </p>
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <p className={cx(eyebrow, "mb-0 flex-1")}>Filter lists</p>
          <Button
            tone="outline"
            data-hearth-target="adguard:refresh"
            onClick={() =>
              void act.propose(KIND, { op: "refresh" }, `Update ${name}'s filter lists`)
            }
          >
            <RefreshCw className="h-4 w-4" /> Update filter lists
          </Button>
        </div>
        <ul className="divide-y divide-line text-[0.84rem]">
          {d.filters.map((f) => (
            <li
              key={`${f.allowlist}:${f.id}`}
              className="flex flex-wrap items-center gap-2 py-2"
              data-testid="ag-filter"
              data-enabled={f.enabled ? "yes" : "no"}
              data-capture-item
              data-capture-label={f.name}
            >
              <div className="min-w-0 flex-1">
                <p className="break-all text-ink">{f.name}</p>
                <p
                  className={cx(
                    "break-all text-[0.74rem]",
                    f.enabled && !f.updatedAt ? "text-amber" : "text-faint",
                  )}
                >
                  {f.url} · {f.allowlist ? "allowlist" : "blocklist"} · {f.rules.toLocaleString()}{" "}
                  rules · {f.updatedAt ? `updated ${ago(f.updatedAt)}` : "never downloaded"}
                </p>
              </div>
              <label className="inline-flex items-center gap-1.5 text-[0.76rem] text-muted">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  aria-label={`${f.name} on`}
                  data-hearth-target={`filter:toggle:${f.id}`}
                  onChange={() =>
                    void act.propose(
                      KIND,
                      {
                        op: f.enabled ? "filter-disable" : "filter-enable",
                        filterId: f.id,
                        allowlist: f.allowlist,
                      },
                      `Switch ${f.enabled ? "off" : "on"} ${f.name} in ${name}`,
                    )
                  }
                  className="h-4 w-4"
                />
                On
              </label>
              <button
                type="button"
                className={btn}
                data-hearth-target={`filter:remove:${f.id}`}
                onClick={() =>
                  void act.propose(
                    KIND,
                    { op: "filter-remove", filterId: f.id, allowlist: f.allowlist },
                    `Remove ${f.name} from ${name}`,
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => e.preventDefault()}
          data-testid="ag-filter-form"
        >
          <input
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            placeholder="Name"
            aria-label="List name"
            className={field}
            data-hearth-target="filter:name"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.org/filter.txt"
            aria-label="List address"
            className={cx(field, "min-w-[14rem]")}
            data-hearth-target="filter:address"
          />
          <Button
            tone="outline"
            disabled={!url.trim()}
            data-hearth-target="filter:add"
            onClick={() =>
              void act
                .propose(
                  KIND,
                  { op: "filter-add", body: url.trim(), name: listName.trim(), allowlist },
                  `Add a ${allowlist ? "allowlist" : "blocklist"} to ${name}`,
                )
                .then(() => {
                  setUrl("");
                  setListName("");
                })
            }
          >
            Add list
          </Button>
          <label className="inline-flex w-full items-center gap-1.5 text-[0.76rem] text-muted">
            <input
              type="checkbox"
              checked={allowlist}
              onChange={(e) => setAllowlist(e.target.checked)}
              className="h-4 w-4"
              data-hearth-target="filter:allowlist"
            />
            An allowlist (its domains are never blocked)
          </label>
        </form>
        <p className="mt-1 text-[0.74rem] text-faint">
          AdGuard downloads a list when it is added or switched on. How often lists update, and
          per-device settings, stay in AdGuard Home.
        </p>
      </div>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** DNS rewrites: names AdGuard answers itself (plex.home is 192.168.1.10). */
export function AdguardRewrites({ serviceId, name }: AppViewProps) {
  const { q, d } = useAdguard(serviceId);
  const act = useApproveHere(serviceId, "Proposed from AdGuard Home's DNS rewrites tab.");
  const [host, setHost] = useState("");
  const [answer, setAnswer] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  return (
    <section
      className="@container space-y-4"
      data-testid="ag-rewrites"
      aria-label={`${name}: DNS rewrites`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <p className="text-[0.82rem] text-muted">
        Names {name} answers itself, so every device on your network can reach a server by name
        (plex.home) instead of its address. *.home answers for every name under home.
      </p>
      {d.rewrites.length ? (
        <ul className="divide-y divide-line text-[0.84rem]">
          {d.rewrites.map((r) => (
            <li
              key={`${r.domain} ${r.answer}`}
              className="flex flex-wrap items-center gap-2 py-1.5"
              data-testid="ag-rewrite"
            >
              <span className="min-w-0 flex-1 break-words text-ink">
                {r.domain} <span className="text-faint">→ {r.answer}</span>
                {!r.enabled && <span className="text-faint"> (switched off)</span>}
              </span>
              <button
                type="button"
                className={btn}
                data-hearth-target={`rewrite:remove:${r.domain}`}
                onClick={() =>
                  void act.propose(
                    KIND,
                    { op: "rewrite-remove", domain: r.domain, answer: r.answer },
                    `Remove the rewrite ${r.domain} from ${name}`,
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
        className="flex flex-wrap gap-2"
        onSubmit={(e) => e.preventDefault()}
        data-testid="ag-rewrite-form"
      >
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="plex.home"
          aria-label="Name"
          className={field}
          data-hearth-target="rewrite:name"
        />
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="192.168.1.10"
          aria-label="Answer"
          className={field}
          data-hearth-target="rewrite:answer"
        />
        <Button
          tone="outline"
          disabled={!host.trim() || !answer.trim()}
          data-hearth-target="rewrite:add"
          onClick={() =>
            void act
              .propose(
                KIND,
                { op: "rewrite-add", domain: host.trim(), answer: answer.trim() },
                `Add the rewrite ${host.trim()} to ${name}`,
              )
              .then(() => {
                setHost("");
                setAnswer("");
              })
          }
        >
          Add rewrite
        </Button>
      </form>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

const GROUPS: Record<string, string> = {
  social_network: "Social",
  video: "Video",
  streaming: "Streaming",
  gaming: "Games",
  messenger: "Messaging",
  shopping: "Shopping",
  ai: "AI",
  dating: "Dating",
  gambling: "Gambling",
  privacy: "Privacy",
  software: "Software",
  cdn: "Content delivery",
  hosting: "Hosting",
  music: "Music",
};

/** Blocked services: whole apps and sites (TikTok, Roblox) blocked for the network, in one plan. */
export function AdguardServices({ serviceId, name }: AppViewProps) {
  const { q, d } = useAdguard(serviceId);
  const act = useApproveHere(serviceId, "Proposed from AdGuard Home's Blocked services tab.");
  const [draft, setDraft] = useState<string[] | null>(null);
  const [find, setFind] = useState("");
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const s of d?.blockedServices.all ?? []) {
      const g = GROUPS[s.group ?? ""] ?? "Other";
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [d?.blockedServices.all]);
  if (!d) return <Gate name={name} q={q} />;
  const now = d.blockedServices.ids;
  const chosen = draft ?? now;
  const changed = chosen.slice().sort().join() !== now.slice().sort().join();
  const needle = find.trim().toLowerCase();
  return (
    <section
      className="@container space-y-4"
      data-testid="ag-services"
      aria-label={`${name}: blocked services`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <p className="text-[0.82rem] text-muted">
        Block a whole app or site for every device, without hunting for its domains.{" "}
        {now.length ? `${now.length} blocked now.` : "None blocked now."}
      </p>
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find a service"
        aria-label="Find a service"
        className={cx(field, "w-full")}
        data-hearth-target="services:find"
      />
      <div className="grid gap-4 @2xl:grid-cols-2">
        {groups.map(([group, list]) => {
          const shown = list.filter((s) => !needle || s.name.toLowerCase().includes(needle));
          if (!shown.length) return null;
          return (
            <fieldset key={group} className="rounded-xl border border-line p-3">
              <legend className="eyebrow px-1">{group}</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {shown.map((s) => (
                  <label
                    key={s.id}
                    className="inline-flex items-center gap-1.5 text-[0.82rem] text-ink"
                    data-testid="ag-service"
                  >
                    <input
                      type="checkbox"
                      checked={chosen.includes(s.id)}
                      aria-label={s.name}
                      data-hearth-target={`service:${s.id}`}
                      onChange={(e) =>
                        setDraft(
                          e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id),
                        )
                      }
                      className="h-4 w-4"
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/95 p-3">
        <Button
          tone="primary"
          disabled={!changed || act.busy}
          data-testid="ag-services-review"
          data-hearth-target="services:review"
          onClick={() =>
            void act.propose(
              KIND,
              { op: "services", body: JSON.stringify(chosen) },
              `Change blocked services in ${name}`,
            )
          }
        >
          Review the change
        </Button>
        {changed && (
          <Button tone="quiet" onClick={() => setDraft(null)} data-hearth-target="services:reset">
            Undo my edits
          </Button>
        )}
      </div>
      <p className="text-[0.74rem] text-faint">
        A schedule (blocking only at some hours) and per-device choices stay in AdGuard Home.
      </p>
      <Footer d={d} name={name} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
