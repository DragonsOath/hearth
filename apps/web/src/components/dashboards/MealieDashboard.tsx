import { Archive, ExternalLink, Lock, ShieldAlert, Sparkles } from "lucide-react";
import type { MealieDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Mealie from Hearth, a light panel. It answers "is Mealie healthy and backed up?": the version
 * (and a newer one), what it holds, its own setup checks, storage, and backups, with a backup one tap
 * away and the clean-ups one step further. It warns when the first-run administrator account is still
 * there. Each change is a plan you approve; recipes, people and settings are changed in Mealie.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-mealie-control" as const;

/** No backup, or the newest is more than a week old (Mealie's health report warns the same). */
function olderThanAWeek(at?: string): boolean {
  return !at || Date.now() - Date.parse(at) > 7 * 86_400_000;
}

export function MealieDashboard({ serviceId, name }: AppViewProps) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "mealie" ? q.data.data : undefined;
  const act = useApproveHere(serviceId, "Proposed from Mealie's panel.");
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) {
    if (q.isLoading) return <Skeleton className="h-64" />;
    if (q.error)
      return (
        <p className="text-[0.88rem] text-alert">
          Could not read {name}: {q.error.message}
        </p>
      );
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ml-error">
        <p className="text-amber">{name} could not be read right now.</p>
        {q.data?.error && <p className="mt-1 text-muted">{q.data.error.message}</p>}
        <p className="mt-1 text-[0.8rem] text-faint">
          Add an administrator's API token for Mealie to Secure Vault, for this service. Make one in
          Mealie: your profile, API Tokens, Generate.
        </p>
      </div>
    );
  }
  const propose = (op: string, title: string) => void act.propose(KIND, { op }, title);
  const newest = d.backups[0];
  const stale = olderThanAWeek(newest?.at);
  const web = keyPageHref(service, "/");
  const checks: [string, boolean | undefined][] = [
    ["Email", d.checks.emailReady],
    ["Base address", d.checks.baseUrlSet],
    ["LDAP sign-in", d.checks.ldap],
    ["Single sign-on", d.checks.oidc],
  ];
  return (
    <section
      className="@container space-y-4"
      data-testid="ml-dashboard"
      aria-label={`${name}: health`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}

      {d.defaultAdmin && (
        <div
          className="flex gap-2 rounded-xl border border-amber/40 p-3 text-[0.84rem]"
          data-testid="ml-default-admin"
        >
          <ShieldAlert strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <p className="text-amber">
            Mealie still has its first-run administrator (changeme@example.com), whose password is
            published. Change its email and password in Mealie: your profile, Edit.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4" data-hearth-target="mealie:health">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Version</p>
          <p className="stat-value text-ink tabular" data-testid="ml-version">
            {d.version ?? "?"}
          </p>
          <p
            className={cx(
              "text-[0.74rem]",
              d.latest && d.latest !== d.version ? "text-amber" : "text-faint",
            )}
          >
            {d.latest
              ? d.latest === d.version
                ? "up to date"
                : `${d.latest} is out`
              : "newest not known"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Recipes</p>
          <p className="stat-value text-ink tabular" data-testid="ml-recipes">
            {d.recipes.toLocaleString()}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.uncategorized} without a category · {d.untagged} without tags
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>People</p>
          <p className="stat-value text-ink tabular">{d.users}</p>
          <p className="text-[0.74rem] text-faint">
            {d.households} {d.households === 1 ? "household" : "households"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Newest backup</p>
          <p
            className={cx("stat-value text-[1rem]", stale ? "text-amber" : "text-ink")}
            data-testid="ml-backup"
          >
            {newest?.at ? ago(newest.at) : "None"}
          </p>
          <p className="text-[0.74rem] text-faint">{d.backups.length} kept</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem]" data-testid="ml-checks">
        {checks
          .filter(([, v]) => v !== undefined)
          .map(([label, ok]) => (
            <span key={label} className={ok ? "text-ok" : "text-faint"}>
              {label}: {ok ? "ready" : "not set up"}
            </span>
          ))}
        <span className="text-faint">Database: {d.database}</span>
      </div>

      <div data-hearth-target="mealie:backups" data-testid="ml-backups">
        <p className={eyebrow}>Backups</p>
        {d.backups.length === 0 ? (
          <p className="text-[0.84rem] text-faint">No backups yet.</p>
        ) : (
          <ul className="space-y-0.5 text-[0.8rem]">
            {d.backups.slice(0, 5).map((b) => (
              <li key={b.name} className="flex flex-wrap gap-x-2">
                <Archive strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
                <span className="text-ink">{b.at ? ago(b.at) : b.name}</span>
                <span className="text-faint">{b.size}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={cx(btn, "mt-2")}
          onClick={() => propose("backup", `Back up ${name} now`)}
          data-testid="ml-backup-now"
        >
          <Archive strokeWidth={1.5} className="h-3.5 w-3.5" /> Back up now
        </button>
      </div>

      <details data-hearth-target="mealie:maintenance">
        <summary className={cx(eyebrow, "cursor-pointer")}>Storage and clean-up</summary>
        <p className="text-[0.8rem] text-muted">
          Data {d.storage.data} · temporary files {d.storage.temp} · backups {d.storage.backups}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={btn}
            onClick={() => propose("clean-temp", `Clean ${name}'s temporary files`)}
          >
            <Sparkles strokeWidth={1.5} className="h-3.5 w-3.5" /> Clean temporary files
          </button>
          <button
            type="button"
            className={btn}
            disabled={!d.storage.cleanableImages}
            onClick={() => propose("clean-images", `Delete images no recipe uses in ${name}`)}
          >
            Delete {d.storage.cleanableImages} unused images
          </button>
          <button
            type="button"
            className={btn}
            disabled={!d.storage.cleanableDirs}
            onClick={() => propose("clean-folders", `Remove empty recipe folders in ${name}`)}
          >
            Remove {d.storage.cleanableDirs} empty folders
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => propose("unlock", `Unlock locked accounts in ${name}`)}
            data-testid="ml-unlock"
          >
            <Lock strokeWidth={1.5} className="h-3.5 w-3.5" /> Unlock locked accounts
          </button>
        </div>
      </details>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        live, every minute. Recipes, people and settings are changed in Mealie.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open Mealie <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
