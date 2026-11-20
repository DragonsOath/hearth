import { useState } from "react";
import { ArrowRight, ExternalLink, Lock, Pencil, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import type { Blocker } from "@dragon-control/core";
import { BlockerCard } from "../blockers/BlockerCard";
import { useLiveQuery } from "../panels/lifecycle";
import { EmberMark } from "../ember/EmberMark";

/**
 * Caddy from Hearth: every reverse proxy, the local address it sends visitors to (and which of
 * your services that is), and two live checks for each: the app answers locally, and the site
 * works through Caddy with a valid certificate. Caddy is protected, so adding, changing, or removing
 * a site from the form is a protected plan (exact Caddyfile edits) you confirm is you; Caddy checks
 * it, the file is backed up, and it is put back if the site does not come up. Passwords, which need
 * a hash, stay Ember's work.
 */

interface Site {
  hosts: string[];
  upstreams: string[];
  services: string[];
  signIn: "none" | "password" | "sign-in service";
  signInVia?: string;
  fixed?: boolean;
  files?: boolean;
  certExpires?: string;
  localUp: boolean | null;
  works: boolean;
  why?: string;
}
interface Panel {
  container: string;
  /** How the sites were read: Caddy's own API from this machine, or inside its container. */
  readVia?: "caddy-api" | "container";
  /** Whether the add and edit form can work, or what stands in its way. */
  manage?: { ok: true; path: string } | { ok: false; blocker: Blocker };
  sites: Site[];
  certificates: number;
  errors: { at?: string; text: string }[];
  checkedAt: string;
}

const dot = (ok: boolean | null, label: string, testId: string) => (
  <span
    className={cx(
      "fit-pill inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.7rem]",
      ok === null
        ? "border-line-strong text-faint"
        : ok
          ? "border-live/40 text-live"
          : "border-alert/50 text-alert",
    )}
    data-testid={testId}
  >
    <span
      aria-hidden
      className={cx(
        "h-1.5 w-1.5 rounded-full",
        ok === null ? "bg-faint" : ok ? "bg-live" : "bg-alert",
      )}
    />
    {label}
  </span>
);

const DAY = 86_400_000;

export function CaddyDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useLiveQuery({
    queryKey: ["dashboard", serviceId, "caddy"],
    queryFn: () =>
      api<{ data?: Panel; error?: { message: string; blocker?: Blocker } }>(
        "GET",
        `/api/services/${serviceId}/caddy`,
      ),
    refetchInterval: 120_000,
  });
  const cave = useCave();
  const [find, setFind] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ site: "", local: "", signIn: "none" });
  const [editing, setEditing] = useState<string>();
  const [edit, setEdit] = useState({ local: "", signIn: "none" });
  const [formError, setFormError] = useState<string>();
  const c = useConfirmedChange(serviceId);
  // The server turns the change into exact Caddyfile edits; the plan is the usual protected one.
  const propose = async (
    body: { op: "add" | "change" | "remove"; site: string; upstream?: string; signIn?: string },
    title: string,
  ) => {
    setFormError(undefined);
    try {
      const r = await api<{ data?: { path: string; edits: string }; error?: { message: string } }>(
        "POST",
        `/api/services/${serviceId}/caddy/site`,
        body,
      );
      if (!r.data) throw new Error(r.error?.message ?? "Hearth could not plan that.");
      await c.propose("config-edit", { path: r.data.path, edits: r.data.edits }, title);
      return true;
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const d = q.data?.data;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || q.data?.error) {
    const blocker = q.data?.error?.blocker;
    return (
      <div className="space-y-3">
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
          data-testid="caddy-error"
        >
          <p className="text-amber">
            {blocker?.kind === "service-down"
              ? `${name} is not running.`
              : `${name}'s sites could not be read right now.`}
          </p>
          <p className="mt-1 text-muted">{q.data?.error?.message ?? q.error?.message}</p>
        </div>
        {blocker && (
          <BlockerCard blocker={blocker} serviceName={name} onResolved={() => void q.refetch()} />
        )}
      </div>
    );
  }
  if (!d) return null;
  const blocked = d.manage && !d.manage.ok ? d.manage.blocker : undefined;
  const now = Date.parse(d.checkedAt);
  const broken = d.sites.filter((s) => !s.works || s.localUp === false);
  const expiring = d.sites.filter(
    (s) => s.certExpires && Date.parse(s.certExpires) - now < 14 * DAY,
  );
  const f = find.trim().toLowerCase();
  const shown = d.sites
    .filter(
      (s) =>
        !f || [...s.hosts, ...s.upstreams, ...s.services].some((x) => x.toLowerCase().includes(f)),
    )
    .sort(
      (a, b) => Number(a.works && a.localUp !== false) - Number(b.works && b.localUp !== false),
    );
  return (
    <section
      className="@container space-y-4"
      data-testid="caddy-dashboard"
      aria-label={`${name}: reverse proxies`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "Sites",
              `${d.sites.length}`,
              `${d.sites.filter((s) => s.signIn !== "none").length} behind a sign-in`,
            ],
            ["Working", `${d.sites.length - broken.length}`, "answer through Caddy"],
            ["Not working", `${broken.length}`, broken.length ? "see the top of the list" : "none"],
            [
              "Certificates",
              `${d.certificates}`,
              expiring.length ? `${expiring.length} expire within 14 days` : "none expiring soon",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Not working" && broken.length > 0 && "text-alert",
                label === "Certificates" && expiring.length > 0 && "text-amber",
              )}
              data-testid={
                label === "Not working"
                  ? "caddy-broken"
                  : label === "Sites"
                    ? "caddy-sites"
                    : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          aria-label="Find a site, address, or service"
          placeholder="Find a site, address, or service"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
        />
        <Button
          tone="outline"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          data-testid="caddy-recheck"
        >
          <RefreshCw className="h-4 w-4" /> {q.isFetching ? "Checking…" : "Check again"}
        </Button>
        <Button
          tone="primary"
          onClick={() => setAdding((v) => !v)}
          disabled={Boolean(blocked)}
          title={blocked ? blocked.title : undefined}
          data-testid="caddy-add"
        >
          <Plus className="h-4 w-4" /> Add a site
        </Button>
      </div>

      {blocked && (
        <div className="space-y-2" data-testid="caddy-manage-blocked">
          <p className="text-[0.8rem] text-faint">
            Showing {name}&apos;s sites read only. Adding or changing them needs this first:
          </p>
          <BlockerCard blocker={blocked} serviceName={name} onResolved={() => void q.refetch()} />
        </div>
      )}

      {adding && !blocked && (
        <form
          className="grid gap-2 rounded-xl border border-gold/40 bg-gold/5 p-3 @md:grid-cols-[1fr_1fr_auto_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            const site = form.site.trim();
            const local = form.local.trim();
            if (!site || !local) return;
            if (form.signIn === "password") {
              setAdding(false);
              cave.ask(
                `Add a reverse proxy in ${name}: ${site} should go to ${local}, behind a password. Plan it as a protected change to the Caddyfile (match how the existing sites are written), check it with Caddy before applying, and tell me if DNS for the name needs anything.`,
              );
              return;
            }
            void propose(
              {
                op: "add",
                site,
                upstream: local,
                signIn: form.signIn === "service" ? "sign-in service" : "none",
              },
              `Add ${site} to ${name}`,
            ).then((ok) => ok && setAdding(false));
          }}
        >
          <input
            value={form.site}
            onChange={(e) => setForm({ ...form, site: e.target.value })}
            aria-label="Site name"
            placeholder="Site address"
            className="min-h-10 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
          />
          <input
            value={form.local}
            onChange={(e) => setForm({ ...form, local: e.target.value })}
            aria-label="Local address"
            placeholder="Upstream address"
            className="min-h-10 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
          />
          <select
            value={form.signIn}
            onChange={(e) => setForm({ ...form, signIn: e.target.value })}
            aria-label="Sign-in"
            className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          >
            <option value="none">No sign-in</option>
            <option value="service">Sign-in service</option>
            <option value="password">Password</option>
          </select>
          <Button tone="primary" type="submit" disabled={c.busy} data-testid="caddy-add-ask">
            {form.signIn === "password" ? "Ask Ember to add it" : "Plan it"}
          </Button>
          <p className="text-[0.76rem] text-faint @md:col-span-4">
            Caddy is protected: you confirm it is you, Caddy checks the change first, the file is
            backed up, and it is put back if the site does not come up. A password needs a hash, so
            Ember sets those up.
          </p>
        </form>
      )}

      {formError && (
        <p className="text-[0.84rem] text-amber" data-testid="caddy-form-error">
          {formError}
        </p>
      )}
      <ChangeCard c={c} />

      <ul className="divide-y divide-line" data-testid="caddy-list">
        {shown.map((s) => {
          const exp = s.certExpires ? Date.parse(s.certExpires) - now : undefined;
          return (
            <li
              key={s.hosts.join(",")}
              className="space-y-1.5 py-2.5"
              data-testid="caddy-site"
              data-capture-item
              data-capture-label={s.hosts[0]}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={`https://${s.hosts[0]}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 text-[0.9rem] break-all text-ink hover:text-gold"
                >
                  {s.hosts[0]} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <span className="text-[0.84rem] break-all text-muted" data-testid="caddy-local">
                  {s.files && !s.upstreams.length
                    ? "serves files from this machine"
                    : s.fixed && !s.upstreams.length
                      ? "answers by itself (redirect)"
                      : s.upstreams.join(", ") || "nowhere"}
                  {s.services.length ? (
                    <span className="text-faint"> · {s.services.join(", ")}</span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {dot(
                  s.localUp,
                  s.localUp === null
                    ? "No local app"
                    : s.localUp
                      ? "App answers"
                      : "App not answering",
                  "caddy-local-state",
                )}
                {dot(
                  s.works,
                  s.works ? "Works through Caddy" : "Not working through Caddy",
                  "caddy-works",
                )}
                {s.signIn !== "none" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-[0.7rem] text-muted">
                    <Lock className="h-3 w-3" aria-hidden />{" "}
                    {s.signIn === "password" ? "Password" : "Sign-in service"}
                  </span>
                )}
                {exp !== undefined && (
                  <span
                    className={cx(
                      "inline-flex items-center gap-1 text-[0.72rem]",
                      exp < 14 * DAY ? "text-amber" : "text-faint",
                    )}
                  >
                    <ShieldCheck className="h-3 w-3" aria-hidden /> certificate{" "}
                    {exp < 0 ? "expired" : `good for ${Math.round(exp / DAY)} days`}
                  </span>
                )}
                <button
                  type="button"
                  className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[0.74rem] text-muted hover:text-gold disabled:opacity-40 disabled:hover:text-muted"
                  data-testid="caddy-edit"
                  disabled={Boolean(blocked)}
                  title={blocked ? blocked.title : undefined}
                  aria-expanded={editing === s.hosts[0]}
                  onClick={() => {
                    setFormError(undefined);
                    if (editing === s.hosts[0]) return setEditing(undefined);
                    setEditing(s.hosts[0]);
                    setEdit({
                      local: s.upstreams[0] ?? "",
                      signIn: s.signIn === "sign-in service" ? "service" : "none",
                    });
                  }}
                >
                  <Pencil className="h-3 w-3" aria-hidden /> Edit
                </button>
              </div>
              {editing === s.hosts[0] && !blocked && (
                <form
                  className="grid gap-2 rounded-xl border border-gold/40 bg-gold/5 p-3 @md:grid-cols-[1fr_auto_auto_auto]"
                  data-testid="caddy-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const host = s.hosts[0]!;
                    const local = edit.local.trim();
                    void propose(
                      {
                        op: "change",
                        site: host,
                        ...(local && local !== s.upstreams[0] ? { upstream: local } : {}),
                        ...(s.signIn === "password"
                          ? {}
                          : { signIn: edit.signIn === "service" ? "sign-in service" : "none" }),
                      },
                      `Change ${host} in ${name}`,
                    ).then((ok) => ok && setEditing(undefined));
                  }}
                >
                  <input
                    value={edit.local}
                    onChange={(e) => setEdit({ ...edit, local: e.target.value })}
                    aria-label="Local address"
                    placeholder="Upstream address"
                    disabled={!s.upstreams.length}
                    className="min-h-10 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink disabled:opacity-50"
                  />
                  <select
                    value={edit.signIn}
                    onChange={(e) => setEdit({ ...edit, signIn: e.target.value })}
                    aria-label="Sign-in"
                    disabled={s.signIn === "password"}
                    className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink disabled:opacity-50"
                  >
                    <option value="none">No sign-in</option>
                    <option value="service">Sign-in service</option>
                  </select>
                  <Button
                    tone="primary"
                    type="submit"
                    disabled={c.busy}
                    data-testid="caddy-edit-plan"
                  >
                    Plan the change
                  </Button>
                  <Button
                    tone="outline"
                    type="button"
                    disabled={c.busy}
                    data-testid="caddy-remove"
                    onClick={() =>
                      void propose(
                        { op: "remove", site: s.hosts[0]! },
                        `Remove ${s.hosts[0]} from ${name}`,
                      ).then((ok) => ok && setEditing(undefined))
                    }
                  >
                    Remove site
                  </Button>
                  <p className="text-[0.76rem] text-faint @md:col-span-4">
                    {s.signIn === "password"
                      ? "This site uses a password, which Ember handles: "
                      : "For passwords or anything else: "}
                    <button
                      type="button"
                      className="text-gold underline-offset-2 hover:underline"
                      onClick={() =>
                        cave.ask(
                          `I want to change the ${name} site ${s.hosts[0]} (now going to ${s.upstreams.join(", ") || "nowhere"}${s.signIn !== "none" ? `, ${s.signIn}` : ""}). Ask me what to change, then plan it as a protected change to the Caddyfile.`,
                        )
                      }
                    >
                      ask Ember
                      <EmberMark />
                    </button>
                  </p>
                </form>
              )}
              {s.why && !s.works && <p className="text-[0.78rem] text-alert">{s.why}</p>}
            </li>
          );
        })}
      </ul>

      {d.errors.length > 0 && (
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
            Errors in the last day
          </p>
          <ul className="space-y-1 text-[0.8rem]">
            {d.errors.map((e, i) => (
              <li key={i} className="break-words text-amber">
                {e.text}
                {e.at ? <span className="text-faint"> · {ago(e.at)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[0.74rem] text-faint">
        {d.container} ·{" "}
        {d.readVia === "container" ? "read inside its container" : "read from its own API"} ·{" "}
        {blocked ? "read only for now" : "every change asks you first"} · checked {ago(d.checkedAt)}
      </p>
    </section>
  );
}
