import { useState } from "react";
import { Lock, LockOpen, ShieldCheck } from "lucide-react";
import type { Blocker } from "@dragon-control/core";
import { api, useWorkspace } from "../../../data/api";
import { Button, Skeleton, cx } from "../../ui";
import { useLiveQuery } from "../../panels/lifecycle";
import { ChangeCard, useConfirmedChange } from "../ConfirmedChange";
import { TinyauthUsersCard } from "./TinyauthUsers";

/**
 * The useful half of Tinyauth's panel (checklist 46.15): what it does in plain words, which of your
 * sites it guards (read from Caddy, which sends each visitor to it first), and putting another site
 * behind it, with the very same protected Caddy change the Caddy panel makes (exact Caddyfile
 * edits, checked by Caddy, backed up, confirmed by you, put back if the site does not come up).
 * Users and passwords: TinyauthUsersCard.
 */

interface CaddySite {
  hosts: string[];
  upstreams: string[];
  signIn: "none" | "password" | "sign-in service";
  signInVia?: string;
  fixed?: boolean;
  files?: boolean;
}
interface CaddyPanel {
  sites: CaddySite[];
  manage?: { ok: true; path: string } | { ok: false; blocker: Blocker };
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

/** Caddy, among your services (the same test the service panel uses). */
function useCaddy() {
  const services = useWorkspace().data?.services ?? [];
  return services.find(
    (s) =>
      /(^|\/)caddy(:|$)/i.test(s.image ?? "") ||
      /^caddy$/i.test(s.container ?? "") ||
      /^caddy$/i.test(s.name),
  );
}

export function TinyauthGuide({ serviceId, name }: { serviceId: string; name: string }) {
  return (
    <div className="space-y-4">
      <details className="rounded-xl border border-line p-3" data-testid="ta-guide">
        <summary className="cursor-pointer text-[0.88rem] text-ink">
          What {name} does, and how to use it
        </summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[0.84rem] text-muted">
          <li>
            It is the sign-in page in front of your sites. When someone opens a site that is behind
            it, Caddy first asks {name} "is this person signed in?". If yes, they go straight in; if
            not, they see the sign-in page.
          </li>
          <li>
            You sign in once with a username and password (and a code from an authenticator app, if
            you set one up). It remembers you with a cookie for a while, so you are not asked again
            on every site.
          </li>
          <li>
            Which sites are behind it is decided in Caddy, not in {name}: below you can see them,
            and put another one behind it.
          </li>
          <li>
            Apps that open a site directly (a phone app, Plex or Jellyfin players, another server
            calling its API) cannot fill in a sign-in page, so a site they use is usually left out.
          </li>
        </ul>
      </details>
      <ProtectedSites name={name} />
      <TinyauthUsersCard serviceId={serviceId} name={name} />
    </div>
  );
}

/** The sites behind a sign-in service, and the ones that could be. */
function ProtectedSites({ name }: { name: string }) {
  const caddy = useCaddy();
  const q = useLiveQuery({
    queryKey: ["dashboard", caddy?.id ?? "-", "caddy"],
    queryFn: () =>
      api<{ data?: CaddyPanel; error?: { message: string } }>(
        "GET",
        `/api/services/${caddy!.id}/caddy`,
      ),
    enabled: Boolean(caddy),
    refetchInterval: 120_000,
  });
  if (!caddy)
    return (
      <p className="text-[0.82rem] text-muted" data-testid="ta-no-caddy">
        Hearth does not know your Caddy, which decides which sites are behind {name}.
      </p>
    );
  if (q.isLoading) return <Skeleton className="h-24" />;
  const d = q.data?.data;
  if (!d)
    return (
      <p className="text-[0.82rem] text-amber" data-testid="ta-caddy-error">
        Caddy could not be read, so the sites behind {name} are not shown:{" "}
        {q.data?.error?.message ?? q.error?.message ?? "no answer"}. Open the Caddy panel for more.
      </p>
    );
  const guards = new Set(d.sites.map((s) => s.signInVia).filter(Boolean) as string[]);
  const behind = d.sites.filter((s) => s.signIn === "sign-in service");
  // A site that is the sign-in service itself, a redirect, or files is not a candidate.
  const open = d.sites.filter(
    (s) =>
      s.signIn === "none" &&
      !s.fixed &&
      !s.files &&
      s.upstreams.length > 0 &&
      !s.upstreams.some((u) => guards.has(u)),
  );
  const canChange = d.manage?.ok === true;
  return (
    <div className="grid gap-4 @lg:grid-cols-2" data-testid="ta-sites">
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
          <ShieldCheck strokeWidth={1.5} className="h-3.5 w-3.5" /> Behind {name} · {behind.length}
        </p>
        {behind.length ? (
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="ta-behind">
            {behind.map((s) => (
              <li key={s.hosts[0]} className="flex items-center gap-2 py-1.5">
                <Lock strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-live" aria-hidden />
                <span className="min-w-0 flex-1 break-all text-ink">{s.hosts.join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">No site is behind a sign-in service yet.</p>
        )}
      </div>
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
          <LockOpen strokeWidth={1.5} className="h-3.5 w-3.5" /> Open to anyone with the address ·{" "}
          {open.length}
        </p>
        {open.length ? (
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="ta-open">
            {open.map((s) => (
              <OpenSite
                key={s.hosts[0]}
                caddyId={caddy.id}
                site={s}
                canChange={canChange}
                name={name}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">Every site with an app is behind a sign-in.</p>
        )}
        {!canChange && open.length > 0 && (
          <p className="mt-1 text-[0.76rem] text-faint">
            Putting a site behind {name} needs the Caddy panel's file access first (open the Caddy
            panel to allow it).
          </p>
        )}
      </div>
    </div>
  );
}

/** One open site, and putting it behind the sign-in: the Caddy panel's own protected change. */
function OpenSite({
  caddyId,
  site,
  canChange,
  name,
}: {
  caddyId: string;
  site: CaddySite;
  canChange: boolean;
  name: string;
}) {
  const c = useConfirmedChange(caddyId);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const host = site.hosts[0]!;
  const protect = async () => {
    setError(undefined);
    try {
      const r = await api<{ data?: { path: string; edits: string }; error?: { message: string } }>(
        "POST",
        `/api/services/${caddyId}/caddy/site`,
        { op: "change", site: host, upstream: site.upstreams[0], signIn: "sign-in service" },
      );
      if (!r.data) throw new Error(r.error?.message ?? "Hearth could not plan that.");
      await c.propose(
        "config-edit",
        { path: r.data.path, edits: r.data.edits },
        `Put ${host} behind ${name}`,
      );
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li className="space-y-2 py-1.5" data-testid="ta-open-site">
      <div className="flex flex-wrap items-center gap-2">
        <LockOpen strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
        <span className="min-w-0 flex-1 break-all text-ink">{site.hosts.join(", ")}</span>
        {canChange && (
          <button
            type="button"
            className={btn}
            disabled={c.busy}
            data-hearth-target="tinyauth:protect"
            onClick={() => setAsking((v) => !v)}
          >
            <Lock strokeWidth={1.5} className="h-3.5 w-3.5" /> Protect it
          </button>
        )}
      </div>
      {asking && (
        <div className={cx("space-y-2 rounded-lg border border-gold/40 p-2.5 text-[0.8rem]")}>
          <p className="text-muted">
            Anyone opening {host} will see the {name} sign-in page first. Phone apps, players and
            other servers that open it directly may stop working. You confirm the exact Caddy change
            next; it is put back if the site does not come up.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => void protect()} data-testid="ta-protect-plan">
              Plan it
            </Button>
            <Button tone="quiet" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[0.8rem] text-amber">
          {error}
        </p>
      )}
      <ChangeCard c={c} />
    </li>
  );
}
