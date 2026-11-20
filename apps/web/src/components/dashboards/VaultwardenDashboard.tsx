import { useState } from "react";
import {
  DatabaseBackup,
  ExternalLink,
  LogOut,
  MessageCircle,
  Power,
  ShieldOff,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { VaultwardenDashboard as Data, VaultwardenUser } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Vaultwarden from Hearth. The Overview answers "is everyone's vault safe to get into, and only by
 * them?": accounts without two-step sign-in, open sign-ups, https, the version, and its settings
 * for who can get in. Accounts lists everyone with their status, two-step sign-in and last use,
 * and turns an account off or on, signs it out everywhere, turns off two-step sign-in for a lost
 * phone, invites, or deletes. Every change is a protected plan: approving asks you to confirm it
 * is you. Hearth never sees anything inside a vault, and settings are changed in Vaultwarden.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-vaultwarden-control" as const;

function useVault(serviceId: string) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "vaultwarden" ? q.data.data : undefined;
  return { q, d };
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useVault>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="vw-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add Vaultwarden's admin token to Secure Vault, for this service: the plain token you
            sign in to its /admin page with, not its hash.
          </p>
        )}
      </div>
    );
  return null;
}

function WebLink({ href, children }: { href: string | undefined; children: React.ReactNode }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
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
      {d.version ? `Vaultwarden ${d.version}` : "Vaultwarden"}
      {d.webVault ? `, web vault ${d.webVault}` : ""} ·{" "}
      {d.latest ? <span className="text-amber">{d.latest} is out · </span> : null}
      Hearth never sees anything inside a vault.{" "}
      <WebLink href={web("/admin")}>Open Vaultwarden's admin page</WebLink>
    </p>
  );
}

const STATUS_WORD: Record<VaultwardenUser["status"], string> = {
  active: "active",
  invited: "invited, no account yet",
  disabled: "turned off",
};

export function VaultwardenDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useVault(serviceId);
  const cave = useCave();
  const act = useApproveHere(serviceId, "Proposed from Vaultwarden's panel.");
  const web = useWeb(serviceId);
  if (!d) return <Gate name={name} q={q} />;
  const active = d.users.filter((u) => u.status === "active");
  const no2fa = active.filter((u) => !u.twoFactor);
  const invited = d.users.filter((u) => u.status === "invited");
  const s = d.settings;
  const attention: { key: string; text: string; ask: string }[] = [
    ...(s.signupsAllowed && !s.signupDomains
      ? [
          {
            key: "signups",
            text: "Sign-ups are open: anyone who can reach Vaultwarden can make an account.",
            ask: `${name} (Vaultwarden) has sign-ups open to anyone. How do I close them and invite people instead?`,
          },
        ]
      : []),
    ...(d.address && !d.https
      ? [
          {
            key: "https",
            text: `It says it is reached at ${d.address}, without https: the web vault and most apps need https.`,
            ask: `${name} (Vaultwarden) is set up at ${d.address} without https. How do I put it behind https with my reverse proxy?`,
          },
        ]
      : []),
    ...(s.showPasswordHint
      ? [
          {
            key: "hints",
            text: "Password hints are shown on the sign-in page to anyone who asks.",
            ask: `${name} (Vaultwarden) shows password hints on its sign-in page. Why is that risky and how do I turn it off?`,
          },
        ]
      : []),
    ...d.checks.map((c) => ({
      key: c.key,
      text: c.text,
      ask: `${name} (Vaultwarden) diagnostics say: ${c.text} What should I do?`,
    })),
  ];
  const settings: [string, boolean, string?][] = [
    [
      "Anyone can sign up",
      s.signupsAllowed,
      s.signupDomains ? `only ${s.signupDomains}` : undefined,
    ],
    ["Sign-ups must verify their email", s.signupsVerify],
    ["People can invite others", s.invitationsAllowed],
    ["Email is set up", s.emailConfigured],
    ["Emergency access", s.emergencyAccess],
    ["Sends (sharing a note or file by link)", s.sends],
    ["Password hints", s.passwordHints],
    ["Web vault", s.webVault],
  ];
  return (
    <section
      className="@container space-y-4"
      data-testid="vw-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("accounts")}
          data-hearth-target="tab:accounts:open"
        >
          <p className={eyebrow}>Accounts</p>
          <p className="stat-value text-ink tabular" data-testid="vw-accounts">
            {active.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {invited.length ? `${invited.length} invited` : "active"}
            {d.orgs.length ? ` · ${d.orgs.length} organizations` : ""}
          </p>
        </button>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("accounts", "no-2fa")}
        >
          <p className={eyebrow}>Two-step sign-in</p>
          <p
            className={cx("stat-value tabular", no2fa.length ? "text-amber" : "text-ok")}
            data-testid="vw-2fa"
          >
            {active.length - no2fa.length} of {active.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {no2fa.length ? `${no2fa.length} without it` : "everyone has it on"}
          </p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Sign-ups</p>
          <p
            className={cx(
              "stat-value",
              s.signupsAllowed && !s.signupDomains ? "text-amber" : "text-ok",
            )}
            data-testid="vw-signups"
          >
            {s.signupsAllowed ? (s.signupDomains ? "Some" : "Open") : "Closed"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {s.signupsAllowed ? "people can make accounts" : "by invitation only"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Version</p>
          <p
            className={cx("stat-value tabular", d.latest ? "text-amber" : "text-ink")}
            data-testid="vw-version"
          >
            {d.version ?? "–"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.latest ? `${d.latest} is out` : (d.database ?? "")}
          </p>
        </div>
      </div>

      {attention.length > 0 && (
        <div className="space-y-2" data-testid="vw-attention">
          <p className={eyebrow}>Needs a look</p>
          <ul className="space-y-2 text-[0.84rem]">
            {attention.map((a) => (
              <li
                key={a.key}
                className="flex flex-wrap items-center gap-2"
                data-testid="vw-attention-item"
              >
                <span className="min-w-0 flex-1 text-amber">{a.text}</span>
                <button type="button" className={btn} onClick={() => cave.ask(a.ask)}>
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                  <EmberMark />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {no2fa.length > 0 && (
        <p className="text-[0.82rem] text-muted" data-testid="vw-no-2fa">
          Without two-step sign-in: {no2fa.map((u) => u.name).join(", ")}. Their master password
          alone opens their vault; they turn it on in the web vault, Settings, Security.
        </p>
      )}

      <div data-testid="vw-settings">
        <p className={eyebrow}>Who can get in</p>
        <ul className="grid gap-x-6 gap-y-1 text-[0.82rem] @md:grid-cols-2">
          {settings.map(([label, on, note]) => (
            <li key={label} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-muted">{label}</span>
              <span className={on ? "text-ink" : "text-faint"}>{on ? (note ?? "On") : "Off"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[0.74rem] text-faint">
          Vaultwarden's settings hold its secrets, so they are changed on its own admin page.{" "}
          <WebLink href={web("/admin")}>Settings in Vaultwarden</WebLink>
        </p>
      </div>

      {d.orgs.length > 0 && (
        <p className="text-[0.82rem] text-muted" data-testid="vw-orgs">
          Organizations: {d.orgs.map((o) => `${o.name} (${o.members})`).join(", ")}
        </p>
      )}

      <div data-hearth-target="vaultwarden:backup">
        <button
          type="button"
          className={btn}
          onClick={() => void act.propose(KIND, { op: "backup" }, `Back up ${name}'s database`)}
          data-testid="vw-backup"
        >
          <DatabaseBackup strokeWidth={1.5} className="h-3.5 w-3.5" /> Back up the database now
        </button>
      </div>

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

type Show = "all" | "no-2fa" | "invited" | "off";

export function VaultwardenAccounts({ serviceId, name, sub }: AppViewProps) {
  const { q, d } = useVault(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Vaultwarden's panel.");
  const [find, setFind] = useState("");
  const [show, setShow] = useState<Show>(sub === "no-2fa" ? "no-2fa" : "all");
  const [email, setEmail] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.users.filter(
    (u) =>
      (show === "all" ||
        (show === "no-2fa"
          ? u.status === "active" && !u.twoFactor
          : show === "invited"
            ? u.status === "invited"
            : u.status === "disabled")) &&
      (!needle ||
        u.email.includes(needle) ||
        u.name.toLowerCase().includes(needle) ||
        u.orgs.some((o) => o.toLowerCase().includes(needle))),
  );
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-3"
      data-testid="vw-accounts-tab"
      aria-label={`${name}: accounts`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find an account or organization"
          aria-label="Find an account"
          className={cx(input, "min-h-9 min-w-48 flex-1")}
          data-hearth-target="accounts:find"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["no-2fa", "No two-step"],
              ["invited", "Invited"],
              ["off", "Off"],
            ] as [Show, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={show === v}
              className={cx(btn, show === v && "border-gold/60 text-gold")}
              onClick={() => setShow(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line">
        {list.map((u) => (
          <li
            key={u.id}
            className="space-y-1.5 py-3"
            data-testid="vw-account"
            data-capture-item
            data-capture-label={u.email}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={cx("text-[0.9rem]", u.status === "active" ? "text-ink" : "text-faint")}
              >
                {u.name}
              </span>
              <span className="text-[0.74rem] text-faint">{u.email}</span>
              <span
                className={cx(
                  "text-[0.74rem]",
                  u.status === "disabled"
                    ? "text-amber"
                    : u.status === "invited"
                      ? "text-muted"
                      : "text-faint",
                )}
              >
                {STATUS_WORD[u.status]}
              </span>
              {u.status === "active" && (
                <span className={cx("text-[0.74rem]", u.twoFactor ? "text-ok" : "text-amber")}>
                  {u.twoFactor ? "two-step on" : "no two-step"}
                </span>
              )}
              <span className="ml-auto text-[0.74rem] text-faint">
                {u.lastActive
                  ? `active ${ago(u.lastActive).toLowerCase()}`
                  : u.status === "invited"
                    ? ""
                    : "never active"}
              </span>
            </div>
            {u.orgs.length > 0 && (
              <p className="text-[0.74rem] text-faint">In {u.orgs.join(", ")}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {u.status === "invited" ? (
                <>
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose({ op: "resend", userId: u.id }, `Send ${u.email}'s invitation again`)
                    }
                  >
                    Send again
                  </button>
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose({ op: "delete", userId: u.id }, `Withdraw ${u.email}'s invitation`)
                    }
                  >
                    Withdraw
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: u.status === "disabled" ? "enable" : "disable", userId: u.id },
                        `${u.status === "disabled" ? "Turn on" : "Turn off"} ${u.email} in ${name}`,
                      )
                    }
                    data-testid="vw-toggle"
                  >
                    <Power strokeWidth={1.5} className="h-3.5 w-3.5" />
                    {u.status === "disabled" ? "Turn on" : "Turn off"}
                  </button>
                  {u.status === "active" && (
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose({ op: "deauth", userId: u.id }, `Sign ${u.email} out everywhere`)
                      }
                    >
                      <LogOut strokeWidth={1.5} className="h-3.5 w-3.5" /> Sign out everywhere
                    </button>
                  )}
                  {u.twoFactor && (
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "remove-2fa", userId: u.id },
                          `Turn off two-step sign-in for ${u.email}`,
                        )
                      }
                      title="For a lost phone or security key"
                      data-testid="vw-remove-2fa"
                    >
                      <ShieldOff strokeWidth={1.5} className="h-3.5 w-3.5" /> Lost their phone
                    </button>
                  )}
                  <button
                    type="button"
                    className={cx(btn, "ml-auto hover:border-alert/60 hover:text-alert")}
                    onClick={() =>
                      propose(
                        { op: "delete", userId: u.id },
                        `Delete ${u.email} and their vault from ${name}`,
                      )
                    }
                  >
                    <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
        {list.length === 0 && (
          <li className="py-3 text-[0.84rem] text-faint">No account matches.</li>
        )}
      </ul>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          propose({ op: "invite", email: email.trim() }, `Invite ${email.trim()} to ${name}`);
          setEmail("");
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email to invite"
          aria-label="Email to invite"
          className={cx(input, "min-w-48 flex-1")}
          data-hearth-target="accounts:invite"
        />
        <button type="submit" className={btn} disabled={!email.trim()} data-testid="vw-invite">
          <UserPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Invite
        </button>
      </form>
      <p className="text-[0.74rem] text-faint">
        Every change here asks you to confirm it is you. Turning an account off keeps its vault;
        deleting removes the vault for good.
        {d.settings.emailConfigured
          ? ""
          : " Email is not set up, so invited people sign up at its address themselves."}
      </p>
    </section>
  );
}
