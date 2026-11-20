import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageCircle, Power, UserMinus, UserPlus } from "lucide-react";
import type {
  NextcloudApp,
  NextcloudCheck,
  NextcloudDashboard as Data,
  NextcloudUser,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Nextcloud from Hearth. The Overview answers "is it healthy and is anything at risk?": free space,
 * accounts, who used it lately, background jobs and when they last ran, public links without a
 * password, app updates and Nextcloud's own setup checks, with the sharing and background job
 * settings beside them. Accounts lists every account with its storage, groups and last sign-in,
 * and turns one off or on, sets its quota or changes its groups. Apps lists every app, on or off,
 * with updates. Each change is a plan you approve; making or removing accounts stays in Nextcloud.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-nextcloud-control" as const;
const NEAR_FULL = 0.9;

const size = (bytes: number) => {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};
const usedPart = (u: NextcloudUser) => (u.quotaBytes ? u.usedBytes / u.quotaBytes : undefined);

function useNextcloud(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "nextcloud" ? q.data.data : undefined;
  return { q, d };
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useNextcloud>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="nc-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add an administrator's username and sign-in password to Secure Vault, for this service.
            An app password can only read: Nextcloud asks for the account's own password before a
            change. Two-factor sign-in on that account stops Hearth.
          </p>
        )}
      </div>
    );
  return null;
}

function WebLink({
  href,
  children,
  testId,
}: {
  href: string | undefined;
  children: React.ReactNode;
  testId?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
      data-testid={testId}
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const web = useWeb(serviceId);
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Nextcloud ${d.version} · ` : ""}
      {d.updateTo ? <span className="text-amber">{d.updateTo} is out · </span> : null}
      live, every 30 s · Hearth signs in as {d.signedInAs}. Accounts are made and removed in
      Nextcloud.{" "}
      <WebLink href={web("/settings/admin/overview")} testId="nc-open-webui">
        Open Nextcloud
      </WebLink>
    </p>
  );
}

const LEVEL_TEXT: Record<NextcloudCheck["level"], string> = {
  error: "text-alert",
  warning: "text-amber",
  info: "text-faint",
};

export function NextcloudDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useNextcloud(serviceId);
  const cave = useCave();
  const act = useApproveHere(serviceId, "Proposed from Nextcloud's panel.");
  const web = useWeb(serviceId);
  if (!d) return <Gate name={name} q={q} />;
  if (d.maintenance)
    return (
      <section className="space-y-3" data-testid="nc-dashboard" aria-label={`${name}: reading`}>
        <div
          className="rounded-xl border border-alert/40 bg-alert/[0.04] p-4 text-[0.88rem]"
          data-testid="nc-maintenance"
        >
          <p className="text-alert">{name} is in maintenance mode.</p>
          <p className="mt-1 text-muted">
            Nobody can use it, and it answers nothing else, until maintenance mode is turned off
            (occ maintenance:mode --off, or the updater finishing).
          </p>
          <button
            type="button"
            className={cx(btn, "mt-2")}
            onClick={() =>
              cave.ask(
                `${name} (Nextcloud) is in maintenance mode. Find out why (an update, a repair, a stuck upgrade) and how to finish it safely.`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
            <EmberMark />
          </button>
        </div>
        <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
      </section>
    );

  const near = d.users.filter((u) => u.enabled && (usedPart(u) ?? 0) >= NEAR_FULL);
  const problems = d.checks.filter((c) => c.level !== "info");
  const notes = d.checks.filter((c) => c.level === "info");
  const jobsLate = d.jobs.health !== "ok";
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);

  return (
    <section
      className="@container space-y-4"
      data-testid="nc-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Free space</p>
          <p
            className={cx(
              "stat-value tabular",
              d.freeGb !== undefined && d.freeGb < 5 ? "text-alert" : "text-ink",
            )}
            data-testid="nc-free"
          >
            {d.freeGb === undefined ? "–" : `${d.freeGb} GB`}
          </p>
          <p className="text-[0.74rem] text-faint">{d.files.toLocaleString()} files</p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("accounts")}
          data-hearth-target="tab:accounts:open"
        >
          <p className={eyebrow}>Accounts</p>
          <p className="stat-value text-ink tabular" data-testid="nc-accounts">
            {d.accounts}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.disabledAccounts ? `${d.disabledAccounts} off · ` : ""}
            {d.active.lastDay} active today
          </p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Background jobs</p>
          <p
            className={cx("stat-value tabular", jobsLate ? "text-amber" : "text-ok")}
            data-testid="nc-jobs"
          >
            {d.jobs.health === "never" ? "Never ran" : jobsLate ? "Late" : "On time"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.jobs.lastRun ? `last ran ${ago(d.jobs.lastRun).toLowerCase()}` : "no run yet"} · by{" "}
            {d.jobs.mode}
          </p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("apps")}
        >
          <p className={eyebrow}>App updates</p>
          <p
            className={cx("stat-value tabular", d.apps.updates.length ? "text-amber" : "text-ink")}
            data-testid="nc-updates"
          >
            {d.apps.updates.length}
          </p>
          <p className="text-[0.74rem] text-faint">of {d.apps.installed} apps</p>
        </button>
      </div>

      {(jobsLate || problems.length > 0 || near.length > 0 || d.shares.linksNoPassword > 0) && (
        <div className="space-y-2" data-testid="nc-attention">
          <p className={eyebrow}>Needs a look</p>
          <ul className="space-y-2 text-[0.84rem]">
            {jobsLate && (
              <li className="flex flex-wrap items-center gap-2" data-testid="nc-jobs-late">
                <span className="min-w-0 flex-1 text-amber">
                  {d.jobs.health === "never"
                    ? "Background jobs have never run."
                    : `Background jobs last ran ${ago(d.jobs.lastRun!).toLowerCase()}.`}{" "}
                  <span className="text-muted">
                    Cleanup, previews, notifications and file scans wait until they run.
                    {d.jobs.mode === "cron"
                      ? " Check that the system's cron calls cron.php every 5 minutes."
                      : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    cave.ask(
                      `${name}'s background jobs ${d.jobs.lastRun ? `last ran ${ago(d.jobs.lastRun).toLowerCase()}` : "have never run"} (${d.jobs.mode} mode). Find out why and set them up to run every 5 minutes.`,
                    )
                  }
                >
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                  <EmberMark />
                </button>
              </li>
            )}
            {d.shares.linksNoPassword > 0 && (
              <li className="flex flex-wrap items-center gap-2" data-testid="nc-open-links">
                <span className="min-w-0 flex-1">
                  <span className="text-amber">
                    {d.shares.linksNoPassword} of {d.shares.links} public links have no password.
                  </span>{" "}
                  <span className="text-muted">Anyone with the address can open them.</span>
                </span>
                {!d.settings.linksNeedPassword && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: "setting", setting: "links-password", value: "on" },
                        `Require a password on public links in ${name}`,
                      )
                    }
                  >
                    Require a password on new links
                  </button>
                )}
              </li>
            )}
            {near.map((u) => (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="nc-near-full"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{u.name}</span>{" "}
                  <span className="text-amber">
                    uses {size(u.usedBytes)} of {u.quota}
                  </span>
                </span>
                <button type="button" className={btn} onClick={() => onGo?.("accounts", u.id)}>
                  Change the quota
                </button>
              </li>
            ))}
            {problems.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-2" data-testid="nc-check">
                <span className="min-w-0 flex-1">
                  <span className={LEVEL_TEXT[c.level]}>{c.name}</span>
                  {c.text && <span className="block text-[0.78rem] text-muted">{c.text}</span>}
                </span>
                {c.link && (
                  <a href={c.link} target="_blank" rel="noreferrer" className={btn}>
                    Nextcloud's guide <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    cave.ask(
                      `${name} (Nextcloud) reports "${c.name}": ${c.text} What does it mean here, and what fixes it?`,
                    )
                  }
                >
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                  <EmberMark />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="space-y-2 rounded-xl border border-line p-3"
        data-hearth-target="nextcloud:settings"
        data-testid="nc-settings"
      >
        <p className={eyebrow}>Sharing and background jobs</p>
        {(
          [
            ["links-password", "Require a password on public links", d.settings.linksNeedPassword],
            ["links-allowed", "Allow public links", d.settings.linksAllowed],
          ] as const
        ).map(([id, label, on]) => (
          <div key={id} className="flex flex-wrap items-center gap-2 text-[0.84rem]">
            <span className="min-w-0 flex-1 text-ink">{label}</span>
            <span className={on ? "text-ok" : "text-faint"}>{on ? "On" : "Off"}</span>
            <button
              type="button"
              className={btn}
              onClick={() =>
                propose(
                  { op: "setting", setting: id, value: on ? "off" : "on" },
                  `${on ? "Turn off" : "Turn on"} "${label}" in ${name}`,
                )
              }
              data-testid={`nc-setting-${id}`}
            >
              {on ? "Turn off" : "Turn on"}
            </button>
          </div>
        ))}
        <label className="flex flex-wrap items-center gap-2 text-[0.84rem]">
          <span className="min-w-0 flex-1 text-ink">Background jobs run by</span>
          <select
            className={input}
            value={d.jobs.mode}
            onChange={(e) =>
              propose(
                { op: "jobs-mode", value: e.target.value },
                `Run ${name}'s background jobs by ${e.target.value}`,
              )
            }
            data-testid="nc-jobs-mode"
          >
            <option value="ajax">AJAX (when a page is open)</option>
            <option value="webcron">Webcron (an outside service)</option>
            <option value="cron">Cron (recommended)</option>
          </select>
        </label>
        <p className="text-[0.74rem] text-faint">
          {d.shares.total} shares · {d.shares.links} public links
          {d.shares.federated ? ` · ${d.shares.federated} to other servers` : ""}.{" "}
          <WebLink href={web("/settings/admin/sharing")}>Every sharing setting</WebLink>
        </p>
      </div>

      <div className="text-[0.8rem] text-muted" data-testid="nc-system">
        <p className={eyebrow}>Server</p>
        <p>
          {[
            d.system.php && `PHP ${d.system.php}`,
            d.system.database &&
              `${d.system.database}${d.system.databaseMb ? `, ${d.system.databaseMb} MB` : ""}`,
            d.system.memoryGb &&
              `${d.system.memoryFreeGb ?? "?"} of ${d.system.memoryGb} GB memory free`,
            d.system.load !== undefined &&
              `load ${d.system.load}${d.system.cpus ? ` on ${d.system.cpus} cores` : ""}`,
            d.system.memcache && `cache ${d.system.memcache}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-faint">
          Active: {d.active.last5min} now, {d.active.lastHour} this hour, {d.active.lastWeek} this
          week, {d.active.lastMonth} this month.
        </p>
      </div>

      {notes.length > 0 && (
        <details className="text-[0.8rem]" data-testid="nc-notes">
          <summary className="cursor-pointer text-muted">
            {notes.length} more {notes.length === 1 ? "note" : "notes"} from Nextcloud's checks
          </summary>
          <ul className="mt-1 space-y-1">
            {notes.map((c) => (
              <li key={c.id}>
                <span className="text-ink">{c.name}</span>
                {c.hearthsOwn && (
                  <span className="text-faint">
                    {" "}
                    (about Hearth's own connection over http, not how people reach Nextcloud)
                  </span>
                )}
                {c.text && <span className="block text-faint">{c.text}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

type Show = "all" | "off" | "admins";

export function NextcloudAccounts({ serviceId, name, sub }: AppViewProps) {
  const { q, d } = useNextcloud(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Nextcloud's panel.");
  const web = useWeb(serviceId);
  const [find, setFind] = useState(sub ?? "");
  const [show, setShow] = useState<Show>("all");
  const [quota, setQuota] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<Record<string, string>>({});
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.users.filter(
    (u) =>
      (show === "all" || (show === "off" ? !u.enabled : u.admin)) &&
      (!needle ||
        u.name.toLowerCase().includes(needle) ||
        u.id.toLowerCase().includes(needle) ||
        (u.email ?? "").toLowerCase().includes(needle) ||
        u.groups.some((g) => g.toLowerCase().includes(needle))),
  );
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-3"
      data-testid="nc-accounts-tab"
      aria-label={`${name}: accounts`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find an account, email or group"
          aria-label="Find an account"
          className={cx(input, "min-h-9 min-w-48 flex-1")}
          data-hearth-target="accounts:find"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {(["all", "off", "admins"] as Show[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              className={cx(btn, show === s && "border-gold/60 text-gold")}
              onClick={() => setShow(s)}
            >
              {s === "all" ? "All" : s === "off" ? "Off" : "Administrators"}
            </button>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line">
        {list.map((u) => {
          const me = u.id === d.signedInAs;
          const part = usedPart(u);
          const others = d.groups.filter((g) => !u.groups.includes(g));
          const pick = group[u.id] ?? others[0] ?? "";
          return (
            <li
              key={u.id}
              className="space-y-2 py-3"
              data-testid="nc-account"
              data-capture-item
              data-capture-label={u.name}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cx("text-[0.9rem]", u.enabled ? "text-ink" : "text-faint")}>
                  {u.name}
                </span>
                <span className="text-[0.74rem] text-faint">
                  {u.id}
                  {u.email ? ` · ${u.email}` : ""}
                  {u.backend !== "Database" ? ` · from ${u.backend}` : ""}
                </span>
                {!u.enabled && <span className="text-[0.74rem] text-amber">off</span>}
                {u.admin && <span className="text-[0.74rem] text-gold">administrator</span>}
                {me && <span className="text-[0.74rem] text-faint">(Hearth signs in as this)</span>}
                <span className="ml-auto text-[0.74rem] text-faint">
                  {u.lastLogin ? `signed in ${ago(u.lastLogin).toLowerCase()}` : "never signed in"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[0.78rem]">
                <span className="text-muted">
                  {u.quota === "none"
                    ? `${size(u.usedBytes)} used, no limit`
                    : `${size(u.usedBytes)} of ${u.quota}`}
                </span>
                {part !== undefined && (
                  <span
                    className="h-1.5 w-24 overflow-hidden rounded-full bg-line"
                    aria-label={`${Math.round(part * 100)}% used`}
                  >
                    <span
                      className={cx(
                        "block h-full",
                        part >= 1 ? "bg-alert" : part >= NEAR_FULL ? "bg-amber" : "bg-ok",
                      )}
                      style={{ width: `${Math.min(100, Math.round(part * 100))}%` }}
                    />
                  </span>
                )}
                <input
                  value={quota[u.id] ?? ""}
                  onChange={(e) => setQuota({ ...quota, [u.id]: e.target.value })}
                  placeholder="5 GB or none"
                  aria-label={`New quota for ${u.name}`}
                  className={cx(input, "w-28")}
                  data-testid="nc-quota-input"
                />
                <button
                  type="button"
                  className={btn}
                  disabled={!quota[u.id]?.trim()}
                  onClick={() =>
                    propose(
                      { op: "user-quota", userId: u.id, value: quota[u.id]!.trim() },
                      `Set ${u.name}'s storage in ${name} to ${quota[u.id]!.trim()}`,
                    )
                  }
                  data-testid="nc-quota-set"
                >
                  Set quota
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[0.78rem]">
                {u.groups.map((g) => (
                  <span
                    key={g}
                    className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-muted"
                  >
                    {g}
                    <button
                      type="button"
                      aria-label={`Take ${u.name} out of ${g}`}
                      className="text-faint hover:text-gold disabled:opacity-40"
                      disabled={me && g === "admin"}
                      onClick={() =>
                        propose(
                          { op: "group-remove", userId: u.id, group: g },
                          `Take ${u.name} out of ${g} in ${name}`,
                        )
                      }
                    >
                      <UserMinus strokeWidth={1.5} className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {others.length > 0 && (
                  <>
                    <select
                      className={input}
                      value={pick}
                      onChange={(e) => setGroup({ ...group, [u.id]: e.target.value })}
                      aria-label={`Group to add ${u.name} to`}
                    >
                      {others.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "group-add", userId: u.id, group: pick },
                          `Add ${u.name} to ${pick} in ${name}`,
                        )
                      }
                      data-testid="nc-group-add"
                    >
                      <UserPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add to group
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={cx(btn, "ml-auto")}
                  disabled={me}
                  title={me ? "Hearth signs in as this account" : undefined}
                  onClick={() =>
                    propose(
                      { op: u.enabled ? "user-disable" : "user-enable", userId: u.id },
                      `${u.enabled ? "Turn off" : "Turn on"} ${u.name} in ${name}`,
                    )
                  }
                  data-testid="nc-account-toggle"
                >
                  <Power strokeWidth={1.5} className="h-3.5 w-3.5" />
                  {u.enabled ? "Turn off" : "Turn on"}
                </button>
              </div>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="py-3 text-[0.84rem] text-faint">No account matches.</li>
        )}
      </ul>
      <p className="text-[0.74rem] text-faint">
        Turning an account off stops it signing in and syncing; its files stay. New accounts,
        passwords and new groups are made in Nextcloud.{" "}
        <WebLink href={web("/settings/users")}>Nextcloud's Accounts page</WebLink>
      </p>
    </section>
  );
}

export function NextcloudApps({ serviceId, name }: AppViewProps) {
  const { q: dq, d } = useNextcloud(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Nextcloud's panel.");
  const web = useWeb(serviceId);
  const [find, setFind] = useState("");
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "nextcloud-apps"],
    queryFn: () =>
      api<NextcloudApp[]>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/nextcloud/apps`,
      ),
    staleTime: 30_000,
  });
  if (!d) return <Gate name={name} q={dq} />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read the apps: {(q.error as Error).message}
      </p>
    );
  const needle = find.trim().toLowerCase();
  const apps = (q.data ?? []).filter(
    (a) => !needle || a.name.toLowerCase().includes(needle) || a.id.includes(needle),
  );
  const updates = (q.data ?? []).filter((a) => a.update);
  return (
    <section
      className="@container space-y-3"
      data-testid="nc-apps-tab"
      aria-label={`${name}: apps`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      {updates.length > 0 && (
        <p className="text-[0.84rem] text-amber" data-testid="nc-app-updates">
          {updates.length === 1 ? "1 app has" : `${updates.length} apps have`} an update:{" "}
          {updates.map((a) => `${a.name} ${a.update}`).join(", ")}.{" "}
          <WebLink href={web("/settings/apps/updates")}>Update in Nextcloud</WebLink>
        </p>
      )}
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find an app"
        aria-label="Find an app"
        className={cx(input, "min-h-9 w-full")}
        data-hearth-target="apps:find"
      />
      <ul className="divide-y divide-line">
        {apps.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-center gap-2 py-2 text-[0.84rem]"
            data-testid="nc-app"
            data-capture-item
            data-capture-label={a.name}
          >
            <span className="min-w-0 flex-1">
              <span className={a.enabled ? "text-ink" : "text-faint"}>{a.name}</span>
              <span className="text-[0.74rem] text-faint">
                {" "}
                {a.id}
                {a.version ? ` · ${a.version}` : ""}
              </span>
              {a.update && <span className="text-[0.74rem] text-amber"> · {a.update} is out</span>}
              {a.summary && (
                <span className="block truncate text-[0.74rem] text-faint">{a.summary}</span>
              )}
            </span>
            <span className={cx("text-[0.74rem]", a.enabled ? "text-ok" : "text-faint")}>
              {a.enabled ? "On" : "Off"}
            </span>
            <button
              type="button"
              className={btn}
              disabled={a.enabled && ["serverinfo", "provisioning_api", "settings"].includes(a.id)}
              title={
                a.enabled && a.id === "serverinfo" ? "Hearth reads Nextcloud through it" : undefined
              }
              onClick={() =>
                void act.propose(
                  KIND,
                  { op: a.enabled ? "app-disable" : "app-enable", appId: a.id, appName: a.name },
                  `${a.enabled ? "Turn off" : "Turn on"} ${a.name} in ${name}`,
                )
              }
              data-testid="nc-app-toggle"
            >
              {a.enabled ? "Turn off" : "Turn on"}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[0.74rem] text-faint">
        Installing new apps and updating them happen in Nextcloud's app store.{" "}
        <WebLink href={web("/settings/apps")}>Nextcloud's Apps page</WebLink>
      </p>
    </section>
  );
}
