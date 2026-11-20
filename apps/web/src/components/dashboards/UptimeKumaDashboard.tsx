import { useState } from "react";
import { ExternalLink, MessageCircle, Pause, Play, Plus, Trash2 } from "lucide-react";
import type { KumaDashboard as Data, KumaMonitor, KumaStatus, Service } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { useNow } from "../home/parts";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Uptime Kuma from Hearth. The Overview answers "is everything up?": what is down, since when and
 * why, certificates running out, recent state changes, maintenance windows and status pages.
 * Monitors lists every monitor by group with its recent checks, response time and uptime, pauses,
 * resumes or removes one, and watches an app Hearth knows about in one step. Each change is a plan
 * you approve. Monitor settings, notifications and status pages are edited in Uptime Kuma itself.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-uptimekuma-control" as const;

const WORD: Record<KumaStatus, string> = {
  up: "Up",
  down: "Down",
  pending: "Pending",
  maintenance: "Maintenance",
  paused: "Paused",
};
const TEXT: Record<KumaStatus, string> = {
  up: "text-ok",
  down: "text-alert",
  pending: "text-amber",
  maintenance: "text-muted",
  paused: "text-faint",
};
const BAR: Record<KumaStatus, string> = {
  up: "bg-ok",
  down: "bg-alert",
  pending: "bg-amber",
  maintenance: "bg-muted",
  paused: "bg-faint",
};

/** "every minute", "every 5 minutes", "every day". */
const every = (s: number) =>
  s % 86_400 === 0
    ? s === 86_400
      ? "every day"
      : `every ${s / 86_400} days`
    : s % 3600 === 0
      ? s === 3600
        ? "every hour"
        : `every ${s / 3600} hours`
      : s % 60 === 0
        ? s === 60
          ? "every minute"
          : `every ${s / 60} minutes`
        : `every ${s} seconds`;

const pct = (n?: number) =>
  n === undefined ? "–" : n >= 1 ? "100%" : `${(Math.floor(n * 10_000) / 100).toFixed(2)}%`;

function useKuma(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "uptimekuma" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useKuma>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="uk-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add the username and password you sign in to Uptime Kuma with to Secure Vault, for this
            service. Hearth cannot sign in while two-factor sign-in is on for that user.
          </p>
        )}
      </div>
    );
  return null;
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const web = useWeb(serviceId)("/dashboard");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Uptime Kuma ${d.version} · ` : ""}
      {d.latestVersion ? <span className="text-amber">{d.latestVersion} is out · </span> : null}
      live, every 30 s · Monitor settings, notifications and status pages are edited in Uptime Kuma.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="uk-open-webui"
        >
          Open Uptime Kuma <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

/** Its latest checks as small bars, oldest first, as Uptime Kuma draws them. */
function Beats({ m }: { m: KumaMonitor }) {
  if (!m.beats.length) return null;
  return (
    <span
      className="flex h-4 w-full items-end gap-px overflow-hidden @md:w-auto"
      aria-label={`Latest ${m.beats.length} checks: ${m.beats.filter((b) => b.status === "down").length} down`}
      data-testid="uk-beats"
    >
      {m.beats.map((b, i) => (
        <span
          key={i}
          title={`${WORD[b.status]} · ${new Date(b.at).toLocaleString()}${b.pingMs !== undefined ? ` · ${b.pingMs} ms` : ""}`}
          className={cx("h-full w-[3px] rounded-[1px]", BAR[b.status])}
        />
      ))}
    </span>
  );
}

const checks = (d: Data) => d.monitors.filter((m) => m.type !== "group");

export function UptimeKumaDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useKuma(serviceId);
  const cave = useCave();
  // Redrawn every 15 s, so "down since" stays current between reads.
  useNow();
  const act = useApproveHere(serviceId, "Proposed from Uptime Kuma's panel.");
  const web = useWeb(serviceId);
  if (!d) return <Gate name={name} q={q} />;
  const all = checks(d);
  const count = (s: KumaStatus) => all.filter((m) => m.status === s).length;
  const down = all.filter((m) => m.status === "down");
  const certs = all
    .filter((m) => m.certDaysLeft !== undefined && (m.certDaysLeft < 14 || m.certValid === false))
    .sort((a, b) => a.certDaysLeft! - b.certDaysLeft!);
  const silent = all.filter((m) => m.status !== "paused" && m.alerts === 0);
  const pings = all.filter((m) => m.avgPingMs !== undefined);
  const avg = pings.length
    ? Math.round(pings.reduce((n, m) => n + m.avgPingMs!, 0) / pings.length)
    : undefined;
  return (
    <section
      className="@container space-y-4"
      data-testid="uk-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("monitors")}
          data-hearth-target="tab:monitors:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Up</p>
          <p className="stat-value text-ok tabular" data-testid="uk-up">
            {count("up")}
          </p>
          <p className="text-[0.74rem] text-faint">of {all.length} monitors</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Down</p>
          <p
            className={cx("stat-value tabular", down.length ? "text-alert" : "text-ink")}
            data-testid="uk-down"
          >
            {down.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {count("pending") ? `${count("pending")} pending · ` : ""}
            {count("paused")} paused
            {count("maintenance") ? ` · ${count("maintenance")} in maintenance` : ""}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Response</p>
          <p className="stat-value text-ink tabular" data-testid="uk-avg">
            {avg === undefined ? "–" : `${avg} ms`}
          </p>
          <p className="text-[0.74rem] text-faint">average over 24 hours</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Certificates</p>
          <p
            className={cx("stat-value tabular", certs.length ? "text-amber" : "text-ink")}
            data-testid="uk-certs"
          >
            {certs.length}
          </p>
          <p className="text-[0.74rem] text-faint">running out within 2 weeks</p>
        </div>
      </div>

      {down.length > 0 && (
        <div
          className="space-y-2 rounded-xl border border-alert/40 bg-alert/[0.04] p-3"
          data-testid="uk-problems"
        >
          <p className={eyebrow}>Down now</p>
          <ul className="space-y-2 text-[0.84rem]">
            {down.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="uk-down-item"
                data-capture-item
                data-capture-label={m.name}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{m.name}</span>
                  <span className="text-alert">
                    {m.since ? ` · down since ${ago(m.since).toLowerCase()}` : " · down"}
                  </span>
                  {m.message && (
                    <span className="block font-mono text-[0.74rem] break-all text-alert">
                      {m.message}
                    </span>
                  )}
                  {m.target && (
                    <span className="block text-[0.74rem] break-all text-faint">{m.target}</span>
                  )}
                </span>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    cave.ask(
                      `Uptime Kuma (${name}) sees ${m.name} down${m.target ? ` at ${m.target}` : ""}: "${m.message ?? "no message"}". Find out why and what fixes it.`,
                    )
                  }
                  data-hearth-target={`monitor:${m.id}:ask`}
                >
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
                  <EmberMark />
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    void act.propose(
                      KIND,
                      { op: "pause", monitorId: m.id },
                      `Pause ${m.name} in ${name}`,
                    )
                  }
                  data-hearth-target={`monitor:${m.id}:pause`}
                >
                  <Pause className="h-3.5 w-3.5" /> Pause
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {certs.length > 0 && (
        <div data-testid="uk-cert-list">
          <p className={eyebrow}>Certificates</p>
          <ul className="space-y-1 text-[0.84rem]">
            {certs.map((m) => (
              <li key={m.id} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{m.name}</span>
                <span className={m.certDaysLeft! < 0 || !m.certValid ? "text-alert" : "text-amber"}>
                  {m.certValid === false
                    ? "certificate is not valid"
                    : m.certDaysLeft! <= 0
                      ? "certificate has expired"
                      : `certificate runs out in ${m.certDaysLeft} ${m.certDaysLeft === 1 ? "day" : "days"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.events.length > 0 && (
        <div>
          <p className={eyebrow}>Recent changes</p>
          <ul className="divide-y divide-line text-[0.82rem]" data-testid="uk-events">
            {d.events.slice(0, 8).map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2 py-1" data-testid="uk-event">
                <span className={cx("w-12 shrink-0", TEXT[e.status])}>{WORD[e.status]}</span>
                <span className="text-ink">{e.monitor}</span>
                <span className="text-faint">{ago(e.at)}</span>
                {e.message && e.status !== "up" && (
                  <span className="w-full truncate font-mono text-[0.74rem] text-faint">
                    {e.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {silent.length > 0 && (
        <p className="text-[0.8rem] text-amber" data-testid="uk-silent">
          {silent.length === 1 ? `${silent[0]!.name} sends` : `${silent.length} monitors send`} no
          alerts when down: pick a notification for {silent.length === 1 ? "it" : "them"} in Uptime
          Kuma.
        </p>
      )}

      {(d.maintenance.length > 0 || d.statusPages.length > 0) && (
        <div className="grid gap-4 @md:grid-cols-2">
          {d.maintenance.length > 0 && (
            <div>
              <p className={eyebrow}>Maintenance</p>
              <ul className="space-y-1.5 text-[0.84rem]" data-testid="uk-maintenance">
                {d.maintenance.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{w.title}</span>
                      <span className="text-[0.76rem] text-faint">
                        {" "}
                        · {w.active ? w.status.replace(/-/g, " ") : "paused"}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        void act.propose(
                          KIND,
                          {
                            op: w.active ? "maintenance-pause" : "maintenance-resume",
                            maintenanceId: w.id,
                          },
                          `${w.active ? "Pause" : "Resume"} the maintenance window ${w.title} in ${name}`,
                        )
                      }
                      data-hearth-target={`maintenance:${w.id}:${w.active ? "pause" : "resume"}`}
                    >
                      {w.active ? (
                        <>
                          <Pause className="h-3.5 w-3.5" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" /> Resume
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.statusPages.length > 0 && (
            <div>
              <p className={eyebrow}>Status pages</p>
              <ul className="space-y-1 text-[0.84rem]" data-testid="uk-status-pages">
                {d.statusPages.map((p) => {
                  const href = web(`/status/${p.slug}`);
                  return (
                    <li key={p.slug}>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-ink hover:text-gold"
                        >
                          {p.title} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-ink">{p.title}</span>
                      )}
                      {!p.published && <span className="text-faint"> · not published</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

function MonitorRow({ m, name, act }: { m: KumaMonitor; name: string; act: ApproveHere }) {
  const [confirm, setConfirm] = useState(false);
  const go = (op: string, verb: string) =>
    void act.propose(KIND, { op, monitorId: m.id }, `${verb} ${m.name} in ${name}`);
  return (
    <li
      className="space-y-1 py-2"
      data-testid="uk-monitor"
      data-status={m.status}
      data-capture-item
      data-capture-label={m.name}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cx("shrink-0 text-[0.76rem] @md:w-20", TEXT[m.status])}>
          {WORD[m.status]}
        </span>
        <span className="min-w-0 flex-1 text-[0.84rem]">
          <span className="text-ink">{m.name}</span>
          {m.target && (
            <span className="block text-[0.74rem] break-all text-faint">{m.target}</span>
          )}
        </span>
        <Beats m={m} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-0 text-[0.74rem] text-faint @md:pl-22">
        {m.pingMs !== undefined && <span>{m.pingMs} ms now</span>}
        {m.avgPingMs !== undefined && <span>{Math.round(m.avgPingMs)} ms average</span>}
        <span>
          {pct(m.uptime24h)} today · {pct(m.uptime30d)} over 30 days
        </span>
        {m.certDaysLeft !== undefined && (
          <span className={m.certDaysLeft < 14 ? "text-amber" : undefined}>
            certificate {m.certDaysLeft} days
          </span>
        )}
        <span>checks {every(m.intervalSeconds)}</span>
        {m.alerts === 0 && m.status !== "paused" && <span className="text-amber">no alerts</span>}
        {m.tags.length > 0 && <span>{m.tags.join(", ")}</span>}
        <span className="ml-auto flex gap-1.5">
          {m.status === "paused" ? (
            <button
              type="button"
              className={btn}
              onClick={() => go("resume", "Resume")}
              data-hearth-target={`monitor:${m.id}:resume`}
            >
              <Play className="h-3.5 w-3.5" /> Resume
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              onClick={() => go("pause", "Pause")}
              data-hearth-target={`monitor:${m.id}:pause`}
            >
              <Pause className="h-3.5 w-3.5" /> Pause
            </button>
          )}
          {confirm ? (
            <button
              type="button"
              className={cx(btn, "border-alert/60 text-alert")}
              onClick={() => {
                setConfirm(false);
                go("remove", "Remove");
              }}
              data-hearth-target={`monitor:${m.id}:remove-confirm`}
            >
              Remove it and its history?
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              aria-label={`Remove ${m.name}`}
              onClick={() => setConfirm(true)}
              data-hearth-target={`monitor:${m.id}:remove`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      {m.status !== "up" && m.status !== "paused" && m.message && (
        <p className="font-mono text-[0.74rem] break-all text-alert @md:pl-22">{m.message}</p>
      )}
    </li>
  );
}

/** host:port of an address, to tell whether a monitor already checks an app. */
const hostPort = (url?: string) => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Apps Hearth knows with a web address that no monitor checks yet. */
function unwatched(d: Data, services: Service[], self: string): Service[] {
  const watched = new Set(d.monitors.map((m) => hostPort(m.target)).filter(Boolean));
  const names = new Set(d.monitors.map((m) => m.name.toLowerCase()));
  return services.filter(
    (s) =>
      s.id !== self &&
      /^https?:\/\//.test(s.localUrl ?? "") &&
      !watched.has(hostPort(s.localUrl)) &&
      !names.has(s.name.toLowerCase()),
  );
}

function AddMonitor({
  name,
  act,
  d,
  serviceId,
}: {
  name: string;
  act: ApproveHere;
  d: Data;
  serviceId: string;
}) {
  const services = useWorkspace().data?.services ?? [];
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [every, setEvery] = useState("60");
  const [more, setMore] = useState(false);
  const add = (n: string, u: string, interval = 60) =>
    void act.propose(KIND, { op: "add", name: n, url: u, interval }, `Watch ${n} with ${name}`);
  const all = unwatched(d, services, serviceId).sort((a, b) => a.name.localeCompare(b.name));
  const missing = more ? all : all.slice(0, 12);
  return (
    <div className="space-y-3 rounded-xl border border-line p-3" data-testid="uk-add">
      {missing.length > 0 && (
        <div>
          <p className={eyebrow}>Your apps it does not watch</p>
          <ul className="flex flex-wrap gap-1.5" data-testid="uk-unwatched">
            {missing.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={btn}
                  title={s.localUrl}
                  onClick={() => add(s.name, s.localUrl!)}
                  data-hearth-target={`watch:${s.id}`}
                >
                  <Plus className="h-3.5 w-3.5" /> {s.name}
                </button>
              </li>
            ))}
            {all.length > missing.length && (
              <li>
                <button type="button" className={btn} onClick={() => setMore(true)}>
                  Show all {all.length}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim() || !url.trim()) return;
          add(label.trim(), url.trim(), Number(every));
          setLabel("");
          setUrl("");
        }}
      >
        <label className="min-w-32 flex-1 text-[0.74rem] text-faint">
          Name
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-0.5 min-h-9 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            data-hearth-target="add:name"
          />
        </label>
        <label className="min-w-48 flex-[2] text-[0.74rem] text-faint">
          Website address
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            inputMode="url"
            className="mt-0.5 min-h-9 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            data-hearth-target="add:url"
          />
        </label>
        <label className="text-[0.74rem] text-faint">
          Check every
          <select
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            className="mt-0.5 block min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          >
            <option value="30">30 seconds</option>
            <option value="60">minute</option>
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="3600">hour</option>
          </select>
        </label>
        <button
          type="submit"
          className={cx(btn, "min-h-9")}
          disabled={!label.trim() || !url.trim()}
          data-hearth-target="add:submit"
        >
          <Plus className="h-3.5 w-3.5" /> Add monitor
        </button>
      </form>
    </div>
  );
}

type Show = "all" | "down" | "paused";

export function UptimeKumaMonitors({ serviceId, name }: AppViewProps) {
  const { q, d } = useKuma(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Uptime Kuma's Monitors tab.");
  const [find, setFind] = useState("");
  const [show, setShow] = useState<Show>("all");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const fits = (m: KumaMonitor) =>
    m.type !== "group" &&
    (show === "all" ||
      (show === "down" ? m.status === "down" || m.status === "pending" : m.status === "paused")) &&
    (!needle ||
      m.name.toLowerCase().includes(needle) ||
      (m.target ?? "").toLowerCase().includes(needle) ||
      (m.group ?? "").toLowerCase().includes(needle));
  const list = d.monitors.filter(fits);
  const groups = [...new Set(list.map((m) => m.group ?? ""))];
  const groupOf = new Map(d.monitors.filter((m) => m.type === "group").map((g) => [g.name, g]));
  return (
    <section
      className="@container space-y-3"
      data-testid="uk-monitors"
      aria-label={`${name}: monitors`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a monitor, address or group"
          aria-label="Find a monitor"
          className="min-h-9 min-w-48 flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          data-hearth-target="monitors:find"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {(["all", "down", "paused"] as Show[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              className={cx(btn, show === s && "border-gold/60 text-gold")}
              onClick={() => setShow(s)}
            >
              {s === "all" ? "All" : s === "down" ? "Down" : "Paused"}
            </button>
          ))}
        </div>
      </div>
      {groups.map((g) => {
        const head = g ? groupOf.get(g.split(" / ").at(-1)!) : undefined;
        return (
          <div key={g || "-"}>
            {g && (
              <p className={cx(eyebrow, "flex items-center gap-2")} data-testid="uk-group">
                {g}
                {head && (
                  <span className={cx("normal-case", TEXT[head.status])}>{WORD[head.status]}</span>
                )}
              </p>
            )}
            <ul className="divide-y divide-line">
              {list
                .filter((m) => (m.group ?? "") === g)
                .map((m) => (
                  <MonitorRow key={m.id} m={m} name={name} act={act} />
                ))}
            </ul>
          </div>
        );
      })}
      {!list.length && <p className="text-[0.82rem] text-faint">No monitors match.</p>}
      <AddMonitor name={name} act={act} d={d} serviceId={serviceId} />
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
