import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link2, MessageCircle, Trash2, UserPlus } from "lucide-react";
import { ChangeCard, CopyLink, useConfirmedChange } from "./ConfirmedChange";
import type { WizarrDashboard as Data, WizarrInvite } from "@dragon-control/core";
import { api } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { useCave } from "../shell/cave-context";
import { DEFAULT_CREDENTIAL_SCOPE, type CredentialScope } from "@dragon-control/core";
import { OpenKeyPage, ScopeChoice } from "../credentials/AddCredential";
import { Button, Skeleton, cx } from "../ui";
import type { AppViewProps } from "../panels/registry";
import { WizarrPage } from "./wizarr/shared";
import { EmberMark } from "../ember/EmberMark";

/**
 * Wizarr's Overview: how many people have access and whose ends soon (each opens People),
 * invitations with their links, and the everyday task, making an invitation (or deleting one
 * nobody used). Each change is a plan: you see exactly what it does and confirm it here, Hearth
 * makes it in Wizarr and reads it back, and a new invitation's link is ready to copy or share.
 * People and Servers are their own tabs.
 */

const day = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

function NewInvite({
  d,
  c,
  serviceId,
}: {
  d: Data;
  c: ReturnType<typeof useConfirmedChange>;
  serviceId: string;
}) {
  const servers = d.servers.filter((s) => s.verified);
  const [server, setServer] = useState(servers[0]?.id);
  const [libs, setLibs] = useState<number[]>([]);
  const [expires, setExpires] = useState(7);
  const [access, setAccess] = useState(0);
  const [downloads, setDownloads] = useState(false);
  const [liveTv, setLiveTv] = useState(false);
  const [uploads, setUploads] = useState(false);
  // Only libraries Wizarr links to this server: it ignores any other in an invitation's limit.
  const libraries = d.libraries.filter((l) => l.serverId === server && l.enabled);
  const unlinked = d.libraries.some((l) => l.serverId === 0);
  const plex = servers.find((s) => s.id === server)?.type === "plex";
  if (!servers.length)
    return (
      <p className="text-[0.84rem] text-muted">
        Wizarr has no connected media server to invite people to.
      </p>
    );
  const sel = "min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-bg/50 p-3"
      aria-label="New invitation"
      onSubmit={(e) => {
        e.preventDefault();
        void c.propose(
          "app-wizarr-invite",
          {
            serverIds: String(server),
            libraryIds: libs.join(","),
            expiresInDays: expires,
            durationDays: access,
            allowDownloads: downloads,
            allowLiveTv: liveTv,
            allowMobileUploads: plex && uploads,
          },
          "New Wizarr invitation",
        );
      }}
    >
      <p className="flex items-center gap-2 text-ink">
        <UserPlus strokeWidth={1.5} className="h-4 w-4 text-gold" /> New invitation
      </p>
      <div className="flex flex-wrap gap-3">
        {servers.length > 1 && (
          <label className="text-[0.78rem] text-faint">
            Server
            <select
              className={cx(sel, "mt-1 block")}
              value={server}
              onChange={(e) => setServer(Number(e.target.value))}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-[0.78rem] text-faint">
          Link works for
          <select
            className={cx(sel, "mt-1 block")}
            value={expires}
            onChange={(e) => setExpires(Number(e.target.value))}
            data-testid="wizarr-expires"
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never expires</option>
          </select>
        </label>
        <label className="text-[0.78rem] text-faint">
          Their access lasts
          <select
            className={cx(sel, "mt-1 block")}
            value={access}
            onChange={(e) => setAccess(Number(e.target.value))}
            data-testid="wizarr-access"
          >
            <option value={0}>No end</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        </label>
      </div>
      {libraries.length > 0 && (
        <fieldset className="text-[0.8rem]">
          <legend className="mb-1 text-faint">Libraries (none ticked = all)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {libraries.map((l) => (
              <label key={l.id} className="inline-flex min-h-9 items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={libs.includes(l.id)}
                  onChange={(e) =>
                    setLibs((v) => (e.target.checked ? [...v, l.id] : v.filter((x) => x !== l.id)))
                  }
                />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {libraries.length === 0 && unlinked && (
        <p className="text-[0.78rem] text-amber" data-testid="wizarr-libraries-unlinked">
          Wizarr has not linked its libraries to this server, so invitations give every library.{" "}
          <WizarrPage serviceId={serviceId} path="/settings/">
            Scan them in Wizarr
          </WizarrPage>
        </p>
      )}
      <div className="flex flex-wrap gap-x-4">
        {(
          [
            ["Allow downloads", downloads, setDownloads, true],
            ["Allow live TV", liveTv, setLiveTv, true],
            ["Allow mobile uploads", uploads, setUploads, plex],
          ] as const
        )
          .filter(([, , , shown]) => shown)
          .map(([label, value, set]) => (
            <label
              key={label}
              className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-ink"
            >
              <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          ))}
      </div>
      <div>
        <Button
          tone="primary"
          type="submit"
          disabled={c.busy}
          data-testid="wizarr-create"
          data-hearth-target="invites:create"
        >
          Create invitation
        </Button>
      </div>
    </form>
  );
}

function InviteRow({ i, c }: { i: WizarrInvite; c: ReturnType<typeof useConfirmedChange> }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line p-3"
      data-testid="wizarr-invite"
      data-hearth-target={`invite:${i.id}`}
      data-status={i.status}
      data-capture-item
      data-capture-label={`Invitation ${i.code}`}
    >
      <Link2 strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[0.86rem] text-ink">{i.code}</p>
        <p className="text-[0.76rem] text-faint">
          {i.status === "used"
            ? `Used by ${i.usedBy ?? "someone"}${i.usedAt ? ` on ${day(i.usedAt)}` : ""}`
            : i.status === "expired"
              ? `Expired ${day(i.expires)}`
              : i.expires
                ? `Works until ${day(i.expires)}`
                : "Never expires"}
          {` · access ${i.duration === "unlimited" ? "with no end" : `${i.duration} days`}`}
          {i.servers.length ? ` · ${i.servers.join(", ")}` : ""}
        </p>
      </div>
      <span
        className={cx(
          "fit-pill rounded-full border px-2 py-0.5 text-[0.72rem]",
          i.status === "pending"
            ? "border-gold/50 text-gold"
            : i.status === "used"
              ? "border-live/40 text-live"
              : "border-line-strong text-muted",
        )}
      >
        {i.status === "pending" ? "Waiting" : i.status === "used" ? "Used" : "Expired"}
      </span>
      {i.status === "pending" && i.url && <CopyLink url={i.url} />}
      {i.status !== "used" && (
        <button
          type="button"
          disabled={c.busy}
          onClick={() =>
            void c.propose(
              "app-wizarr-invite-delete",
              { invitationId: i.id },
              `Delete invitation ${i.code}`,
            )
          }
          aria-label={`Delete invitation ${i.code}`}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-muted hover:border-alert/60 hover:text-alert disabled:opacity-50"
          data-testid="wizarr-delete"
          data-hearth-target="invite:delete"
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete
        </button>
      )}
    </li>
  );
}

/** Wizarr keeps its keys scrambled: one is made in Wizarr and pasted here, straight into the vault. */
function AddKey({
  serviceId,
  name,
  message,
}: {
  serviceId: string;
  name: string;
  message: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState<CredentialScope>(DEFAULT_CREDENTIAL_SCOPE);
  const qc = useQueryClient();
  const cave = useCave();
  return (
    <div
      className="space-y-3 rounded-xl border border-amber/40 p-4 text-[0.86rem]"
      data-testid="wizarr-needs-key"
    >
      <p className="text-amber">Hearth is not connected to {name} yet.</p>
      <p className="text-muted">
        {name} keeps its API keys scrambled, so Hearth cannot take one from its files. In {name},
        open Settings, then API Keys, create one named Hearth, and paste it here. It goes straight
        into Secure Vault; Ember never sees it.
      </p>
      <OpenKeyPage serviceId={serviceId} />
      <ScopeChoice value={scope} onChange={setScope} name={`scope-${serviceId}`} one />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setSaving(true);
          setError(undefined);
          api("POST", "/api/vault/secrets", {
            name: `${name} API key`,
            kind: "api-key",
            tier: "automation",
            serviceId,
            value: value.trim(),
            scope,
          })
            .then(() => {
              setValue("");
              return qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setSaving(false));
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${name} API key`}
          placeholder="Paste the API key"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-ink"
          data-testid="wizarr-key"
        />
        <Button
          tone="primary"
          type="submit"
          disabled={saving || !value.trim()}
          data-testid="wizarr-key-save"
        >
          Connect
        </Button>
      </form>
      {error && <p className="text-amber">{error}</p>}
      {!/key/i.test(message) && <p className="text-[0.8rem] text-faint">{message}</p>}
      <Button tone="quiet" onClick={() => cave.ask(`Help me connect ${name} to Hearth.`)}>
        <MessageCircle strokeWidth={1.5} className="h-4 w-4" /> Ask Ember
        <EmberMark />
      </Button>
    </div>
  );
}

export function WizarrDashboard({ serviceId, name, onGo }: AppViewProps) {
  const q = useDashboard(serviceId, true, 30_000);
  const c = useConfirmedChange(serviceId);
  const d: Data | undefined = q.data?.data?.app === "wizarr" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <AddKey serviceId={serviceId} name={name} message={q.data.error.message} />
    ) : (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="wizarr-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  return (
    <section
      className="@container space-y-4"
      data-testid="wizarr-dashboard"
      aria-label={`${name} invitations and users`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["People with access", d.totals.users, "users", "people", null],
            ["Invitations waiting", d.totals.pending, "not used yet", null, null],
            ["Access ending", d.totals.expiringSoon, "within a week", "people", "ending"],
            ["Expired invitations", d.totals.expired, "never used", null, null],
          ] as const
        ).map(([label, value, sub, tab, place]) => {
          const Tile = tab && onGo ? "button" : "div";
          return (
            <Tile
              key={label}
              {...(Tile === "button"
                ? {
                    type: "button" as const,
                    onClick: () => onGo?.(tab!, place),
                    "data-hearth-target": `overview:${place ?? tab}`,
                  }
                : {})}
              className={cx(
                "stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left",
                Tile === "button" && "hover:border-gold/50",
              )}
            >
              <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
              <p
                className={cx(
                  "stat-value text-ink tabular",
                  label === "Access ending" && value > 0 && "text-amber",
                )}
              >
                {value}
              </p>
              <p className="text-[0.74rem] text-faint">{sub}</p>
            </Tile>
          );
        })}
      </div>
      <NewInvite d={d} c={c} serviceId={serviceId} />
      <ChangeCard c={c} />
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-[0.9rem] text-ink">Invitations ({d.invites.length})</h3>
        {q.data?.sample && <span className="text-[0.74rem] text-faint">Sample data</span>}
      </div>
      {d.links === "local" && (
        <p className="text-[0.78rem] text-amber" data-testid="wizarr-local-links">
          These links use {name}&apos;s local address, which friends outside your network cannot
          open. Give {name} its public address in Hearth (the service&apos;s settings) and the links
          use it.
        </p>
      )}
      {d.invites.length ? (
        <ul className="space-y-2">
          {d.invites.map((i) => (
            <InviteRow key={i.id} i={i} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">No invitations yet.</p>
      )}
    </section>
  );
}
