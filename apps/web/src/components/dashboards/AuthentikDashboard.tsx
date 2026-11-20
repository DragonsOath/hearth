import { useState } from "react";
import { AppWindow, ExternalLink, KeyRound, Power, RefreshCw, ShieldAlert } from "lucide-react";
import type { AuthentikDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Authentik from Hearth. The Overview answers "is sign-in working, and is anyone trying to get
 * in?": sign-ins and failed sign-ins in the last day (who failed, from where), the apps it protects,
 * and its health: outposts, the worker, failed background tasks (retry one) and certificates near
 * expiry. People lists every account, with turning one off or on as a protected plan. Hearth never
 * shows or reads a password, token or secret; sign-in methods, apps and flows are changed in
 * Authentik.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-9 w-full rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-authentik-control" as const;

function useAuthentik(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "authentik" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useAuthentik>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ak-error">
      <p className="text-amber">{name} could not be read right now.</p>
      {(q.error ?? q.data?.error) && (
        <p className="mt-1 text-muted">{(q.error ?? q.data?.error)?.message}</p>
      )}
      <p className="mt-1 text-[0.8rem] text-faint">
        Add an administrator's API token for Authentik to Secure Vault, for this service. Make one
        in Authentik: Admin interface, Directory, Tokens and App passwords, Create, with intent API.
      </p>
    </div>
  );
}

export function AuthentikDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useAuthentik(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Authentik's panel.");
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) return <Gate name={name} q={q} />;
  const down = d.outposts.filter((o) => !o.healthy);
  const healthy =
    d.workers > 0 &&
    down.length === 0 &&
    d.tasks.failed === 0 &&
    !d.certificates.some((c) => c.days <= 14);
  const web = keyPageHref(service, "/if/admin/");
  return (
    <section
      className="@container space-y-4"
      data-testid="ak-dashboard"
      aria-label={`${name}: sign-in`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div
        className="grid grid-cols-2 gap-3 @md:grid-cols-4"
        data-hearth-target="authentik:sign-ins"
      >
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Sign-ins today</p>
          <p className="stat-value text-ink tabular" data-testid="ak-signins">
            {d.signIns}
          </p>
          <p className="text-[0.74rem] text-faint">{d.activeUsers} active people</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Failed today</p>
          <p
            className={cx("stat-value tabular", d.failedCount >= 10 ? "text-amber" : "text-ink")}
            data-testid="ak-failed"
          >
            {d.failedCount}
          </p>
          <p className="text-[0.74rem] text-faint">wrong password or user</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Apps protected</p>
          <p className="stat-value text-ink tabular" data-testid="ak-apps">
            {d.applications.length}
          </p>
          <p className="text-[0.74rem] text-faint">behind Authentik</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Health</p>
          <p
            className={cx("stat-value text-[1rem]", healthy ? "text-ok" : "text-amber")}
            data-testid="ak-health"
          >
            {healthy ? "All good" : "Needs a look"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.version ? `${d.version}${d.latest && d.outdated ? `, ${d.latest} is out` : ""}` : ""}
          </p>
        </div>
      </div>

      <div data-testid="ak-failed-list">
        <p className={eyebrow}>Failed sign-ins, last day</p>
        {d.failedSignIns.length === 0 ? (
          <p className="text-[0.84rem] text-faint">None.</p>
        ) : (
          <ul className="space-y-0.5 text-[0.82rem]">
            {d.failedSignIns.slice(0, 8).map((f, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <ShieldAlert strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-amber" />
                <span className="text-ink">{f.username}</span>
                {f.ip && <span className="font-mono text-muted">{f.ip}</span>}
                <span className="text-faint">{ago(f.at).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
        {d.failedCount > 0 && (
          <button type="button" className={cx(btn, "mt-1.5")} onClick={() => onGo?.("people")}>
            See people
          </button>
        )}
      </div>

      <div data-testid="ak-app-list">
        <p className={eyebrow}>Apps protected</p>
        {d.applications.length === 0 ? (
          <p className="text-[0.84rem] text-faint">
            No applications yet. Add one in Authentik: Applications.
          </p>
        ) : (
          <ul className="space-y-1 text-[0.84rem]">
            {d.applications.map((a) => (
              <li key={a.slug} className="flex flex-wrap items-baseline gap-x-2">
                <AppWindow strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
                <span className="text-ink">{a.name}</span>
                {a.protects && <span className="text-muted">{a.protects}</span>}
                {a.provider && <span className="text-[0.74rem] text-faint">{a.provider}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-hearth-target="authentik:health" data-testid="ak-health-list" className="space-y-2">
        <p className={eyebrow}>Health</p>
        <ul className="space-y-1 text-[0.82rem]">
          <li className={d.workers ? "text-ok" : "text-alert"}>
            {d.workers
              ? `Worker running (${d.workers})`
              : "No worker running: emails, outposts and clean-ups wait"}
          </li>
          {d.outposts.map((o) => (
            <li
              key={o.id}
              className={o.healthy ? "text-muted" : "text-amber"}
              data-testid="ak-outpost"
            >
              Outpost {o.name} ({o.type}):{" "}
              {o.healthy
                ? "checked in"
                : o.lastSeen
                  ? `last seen ${ago(o.lastSeen).toLowerCase()}`
                  : "never seen"}
              {o.outdated ? ", older than Authentik" : ""}
            </li>
          ))}
          {d.certificates.map((c) => (
            <li key={c.name} className={c.days < 0 ? "text-alert" : "text-amber"}>
              <KeyRound strokeWidth={1.5} className="mr-1 inline h-3.5 w-3.5" />
              Certificate {c.name} {c.days < 0 ? "has expired" : `expires in ${c.days} days`}
            </li>
          ))}
        </ul>
        {d.failedTasks.map((t) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber/30 p-2"
            data-testid="ak-task"
          >
            <span className="text-[0.82rem] text-amber">Failed: {t.description || t.name}</span>
            {t.at && <span className="text-[0.74rem] text-faint">{ago(t.at).toLowerCase()}</span>}
            <button
              type="button"
              className={cx(btn, "ml-auto")}
              onClick={() =>
                void act.propose(
                  KIND,
                  { op: "retry-task", taskId: t.id },
                  `Retry ${t.name} in ${name}`,
                )
              }
              data-testid="ak-retry"
            >
              <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ))}
      </div>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        live, every 30 s. Hearth never shows or reads a password, token or secret.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open Authentik <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}

export function AuthentikPeople({ serviceId, name }: AppViewProps) {
  const { q, d } = useAuthentik(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Authentik's panel.");
  const [find, setFind] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const failedBy = new Map<string, number>();
  for (const f of d.failedSignIns) failedBy.set(f.username, (failedBy.get(f.username) ?? 0) + 1);
  const people = d.users.filter(
    (u) =>
      !needle || u.username.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle),
  );
  return (
    <section
      className="@container space-y-3"
      data-testid="ak-people-tab"
      aria-label={`${name}: people`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find a person"
        aria-label="Find a person"
        className={input}
      />
      <ul className="divide-y divide-line" data-hearth-target="people:list">
        {people.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5"
            data-testid="ak-user"
            data-capture-item
            data-capture-label={u.username}
          >
            <span className="text-[0.9rem] text-ink">{u.name || u.username}</span>
            <span className="text-[0.74rem] text-faint">{u.username}</span>
            {u.admin && <span className="text-[0.74rem] text-gold">administrator</span>}
            {!u.active && <span className="text-[0.74rem] text-amber">off</span>}
            {failedBy.get(u.username) && (
              <span className="text-[0.74rem] text-amber">
                {failedBy.get(u.username)} failed sign-ins today
              </span>
            )}
            <span className="ml-auto text-[0.74rem] text-faint">
              {u.lastLogin ? `signed in ${ago(u.lastLogin).toLowerCase()}` : "never signed in"}
            </span>
            <button
              type="button"
              className={cx(btn, u.active && "hover:border-alert/60 hover:text-alert")}
              onClick={() =>
                void act.propose(
                  KIND,
                  { op: u.active ? "user-off" : "user-on", userId: String(u.id) },
                  `${u.active ? "Turn off" : "Turn on"} ${u.username}'s account`,
                )
              }
              data-testid="ak-user-toggle"
            >
              <Power strokeWidth={1.5} className="h-3.5 w-3.5" />{" "}
              {u.active ? "Turn off" : "Turn on"}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[0.74rem] text-faint">
        Turning an account off stops that person signing in to everything Authentik guards; it can
        be turned on again. Passwords, sign-in methods and groups are changed in Authentik.
      </p>
    </section>
  );
}
