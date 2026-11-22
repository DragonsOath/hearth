import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  LockKeyholeOpen,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  CREDENTIAL_SCOPE_LABEL,
  CREDENTIAL_SCOPE_NOTE,
  type Workspace,
} from "@dragon-control/core";
import { WithWorkspace } from "../components/WithWorkspace";
import { Button, EmptyState, PageHeader, Panel, Section, Sheet, Tag, cx } from "../components/ui";
import {
  useAddSecret,
  useLockVault,
  useMarkVerified,
  useRemoveSecret,
  useRevealSecret,
  useUpdateSecret,
  useVault,
  type SecretKind,
  type SecretSummary,
  type SecretTier,
} from "../data/auth";
import { ApiError } from "../data/api";
import { ago, clockTime } from "../lib/format";
import { ConfirmIdentity } from "./auth/ConfirmIdentity";
import { ServiceCredentials } from "../components/credentials/ServiceCredentials";
import { HearthKeyCard, useHearthKeyId } from "../components/devices/HearthKey";
import { useCredentials } from "../data/credentials";
import { FormError, TextField } from "./auth/AuthFrame";

/**
 * Secure Vault: every credential the homelab needs (API keys, logins for
 * routers, proxies, dashboards, and databases, SSH keys, recovery codes),
 * encrypted on this machine. The list stays hidden until you unlock; values
 * are fetched one at a time, only when you ask, and never kept in the browser.
 */

export const kindLabel: Record<SecretKind, string> = {
  "api-key": "API key",
  password: "Password",
  token: "Access token",
  login: "Login",
  "ssh-key": "SSH key",
  database: "Database credential",
  recovery: "Recovery code",
  certificate: "Certificate or key",
  "oauth-app": "App sign-in (client ID and secret)",
  session: "Saved sign-in (Hearth keeps the session)",
  other: "Other",
};

/** What the shown name and the secret are called, by kind (a client ID and its secret, say). */
const fieldNames = (kind: SecretKind) =>
  kind === "oauth-app"
    ? { user: "Client ID", value: "Client secret" }
    : { user: "Username", value: kindLabel[kind] };

const CATEGORY_SUGGESTIONS = [
  "Router",
  "Proxies",
  "Media",
  "Downloads",
  "Infrastructure",
  "Databases",
  "AI providers",
  "Notifications",
  "Recovery",
];

const tierText: Record<SecretTier, { title: string; description: string }> = {
  automation: {
    title: "Automation",
    description:
      "Hearth can use it on its own, at any hour, for routine read-only work such as checking Prowlarr. Encrypted with this machine's own protected key.",
  },
  protected: {
    title: "Protected",
    description:
      "Usable only after you unlock with your passkey or password. For router, proxy, and other administrator logins.",
  },
};

const field =
  "min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

function SecretSheet({
  ws,
  existing,
  onClose,
}: {
  ws: Workspace;
  existing?: SecretSummary;
  onClose: (linked?: string) => void;
}) {
  const add = useAddSecret();
  const qc = useQueryClient();
  const update = useUpdateSecret();
  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState(existing?.category ?? "");
  const [kind, setKind] = useState<SecretKind>(existing?.kind ?? "api-key");
  const [tier, setTier] = useState<SecretTier>(existing?.tier ?? "automation");
  const [serviceId, setServiceId] = useState(existing?.serviceId ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
  const [value, setValue] = useState("");
  const pending = add.isPending || update.isPending;
  const details = {
    category: category || null,
    username: username || null,
    endpoint: endpoint || null,
    notes: notes || null,
    tags: tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
  return (
    <Sheet
      label={existing ? "Edit credential" : "Add a credential"}
      eyebrow="Secure Vault"
      title={existing ? existing.name : "Add a credential"}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (existing) {
            update.mutate(
              {
                id: existing.id,
                name,
                serviceId: serviceId || null,
                ...(value ? { value } : {}),
                ...details,
              },
              { onSuccess: () => onClose() },
            );
          } else {
            add.mutate(
              { name, kind, tier, value, serviceId: serviceId || undefined, ...details },
              {
                onSuccess: (r) => {
                  // A key Hearth linked (or an app it added) shows in Systems straight away.
                  if (r.linked) void qc.invalidateQueries({ queryKey: ["workspace"] });
                  onClose(
                    r.linked
                      ? r.linked.added
                        ? `Saved, and ${r.linked.name} was added to Hearth with this key. Its panel is ready.`
                        : `Saved and linked to ${r.linked.name}.`
                      : undefined,
                  );
                },
              },
            );
          }
        }}
      >
        <TextField
          id="secret-name"
          label="Name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
        />
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <label className="block text-[0.85rem] text-muted">
            Category
            <input
              list="vault-categories"
              value={category}
              maxLength={60}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Category"
              className={cx(field, "mt-2")}
            />
            <datalist id="vault-categories">
              {CATEGORY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          {!existing && (
            <label className="block text-[0.85rem] text-muted">
              Kind
              <select
                id="secret-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as SecretKind)}
                className={cx(field, "mt-2")}
              >
                {Object.entries(kindLabel)
                  .filter(([k]) => k !== "session")
                  .map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="block text-[0.85rem] text-muted">
            Belongs to
            <select
              id="secret-service"
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className={cx(field, "mt-2")}
            >
              <option value="">{existing ? "No particular service" : "Find it for me"}</option>
              {[...ws.services, ...ws.inactiveServices].map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[0.85rem] text-muted">
            {kind === "oauth-app" ? "Client ID" : "Username (optional)"}
            <input
              value={username}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
              className={cx(field, "mt-2")}
            />
          </label>
          {!existing && !serviceId && (
            <p
              className="-mt-2 text-[0.78rem] text-faint sm:col-span-2"
              data-testid="secret-link-hint"
            >
              Hearth links the key to its app from the name (like &quot;Emby API key&quot;) or the
              address below. If Hearth doesn&apos;t know the app yet, the address adds it.
            </p>
          )}
          <label className="block text-[0.85rem] text-muted sm:col-span-2">
            Where it is used (optional)
            <input
              value={endpoint}
              maxLength={300}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="Address or host name"
              className={cx(field, "mt-2")}
            />
          </label>
        </div>
        {!existing && (
          <fieldset className="mb-5">
            <legend className="mb-2 text-[0.85rem] text-muted">How it can be used</legend>
            <div role="radiogroup" className="grid gap-2">
              {(["automation", "protected"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tier === t}
                  onClick={() => setTier(t)}
                  className={cx(
                    "rounded-xl border p-4 text-left transition-colors",
                    tier === t
                      ? "border-gold/60 bg-gold/[0.06]"
                      : "border-line hover:border-line-strong",
                  )}
                >
                  <span
                    className={cx("block text-[0.95rem]", tier === t ? "text-gold" : "text-ink")}
                  >
                    {tierText[t].title}
                  </span>
                  <span className="mt-1 block text-[0.8rem] leading-relaxed text-muted">
                    {tierText[t].description}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <TextField
          id="secret-value"
          // Named after what is being saved, so a password has a box that says Password.
          label={
            existing
              ? `New ${kindLabel[kind].toLowerCase()} (leave empty to keep it)`
              : kindLabel[kind]
          }
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // Not the browser's saved Hearth password: it fills a plain "off" anyway (11-22).
          autoComplete="new-password"
          hint="Encrypted the moment it reaches Hearth. It never leaves this machine, and AI agents never see it."
          required={!existing}
        />
        <label className="mb-5 block text-[0.85rem] text-muted">
          Notes (never the secret itself)
          <textarea
            value={notes}
            maxLength={2000}
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
            className={cx(field, "mt-2 py-2")}
          />
        </label>
        <label className="mb-6 block text-[0.85rem] text-muted">
          Tags, separated by commas (optional)
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className={cx(field, "mt-2")}
          />
        </label>
        <Button tone="primary" type="submit" className="w-full" disabled={pending}>
          {pending ? "Encrypting" : existing ? "Save" : "Add to the vault"}
        </Button>
        <FormError error={add.error ?? update.error} />
      </form>
    </Sheet>
  );
}

/**
 * "Sign in Ember's Browser" (checklist 45.14): Hearth may use this web login, server side, to
 * open the app signed in in Ember's Browser. The browser only gets the app's session; the
 * password never reaches a page or the AI. Off unless you switch it on (the vault open).
 */
function BrowserSignInSwitch({
  secret,
  serviceName,
}: {
  secret: SecretSummary;
  serviceName: string;
}) {
  const update = useUpdateSecret();
  const on = Boolean(secret.browserSignIn);
  return (
    <div className="mt-3 rounded-xl border border-line px-3 py-2.5">
      <label className="flex items-start gap-3 text-[0.84rem]">
        <input
          type="checkbox"
          role="switch"
          aria-label="Sign in Ember's Browser"
          data-testid="secret-browser-signin"
          className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
          checked={on}
          disabled={update.isPending || secret.tier !== "automation"}
          onChange={(e) => update.mutate({ id: secret.id, browserSignIn: e.target.checked })}
        />
        <span>
          <span className="text-ink">Sign in Ember&apos;s Browser</span>
          <span className="block text-[0.78rem] text-muted">
            {secret.tier !== "automation"
              ? "Only an automation credential can do this (Hearth must be able to use it on its own)."
              : `Hearth signs in to ${serviceName} with this login itself and gives Ember's browser only the session, so she can work in ${serviceName}'s own web page. The password never reaches the page or the AI. Changes there wait for your approval unless you chose to be asked only before serious steps.`}
          </span>
        </span>
      </label>
      {update.error && (
        <p className="mt-1 text-[0.78rem] text-amber" role="alert">
          {update.error instanceof Error ? update.error.message : String(update.error)}
        </p>
      )}
    </div>
  );
}

/** A revealed value disappears again on its own: it is never kept around. */
const SHOW_FOR_MS = 30_000;

function SecretCard({
  secret,
  ws,
  onEdit,
}: {
  secret: SecretSummary;
  ws: Workspace;
  onEdit: () => void;
}) {
  const reveal = useRevealSecret();
  const remove = useRemoveSecret();
  const verified = useMarkVerified();
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [userCopied, setUserCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [after, setAfter] = useState<"show" | "copy">("show");
  const service = [...ws.services, ...ws.inactiveServices].find((s) => s.id === secret.serviceId);
  const needsYou =
    reveal.error instanceof ApiError && reveal.error.status === 403
      ? secret.tier === "protected"
        ? "Unlock with your passkey or password to see this one."
        : "Confirm it is you to see this credential."
      : undefined;
  const removeNeedsYou = remove.error instanceof ApiError && remove.error.status === 403;

  useEffect(() => {
    if (shown === null) return;
    const t = setTimeout(() => setShown(null), SHOW_FOR_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const fetchValue = (then: "show" | "copy") => {
    setAfter(then);
    reveal.mutate(secret.id, {
      onSuccess: (r) => {
        if (then === "copy") {
          void navigator.clipboard?.writeText(r.value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        } else setShown(r.value);
      },
    });
  };

  return (
    <li className="rounded-xl border border-line bg-panel/80 p-4" data-testid="secret-row">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
          <KeyRound strokeWidth={1.4} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.95rem] break-words text-ink">{secret.name}</p>
          <p className="mt-0.5 text-[0.76rem] text-faint">
            {kindLabel[secret.kind]}
            {service ? (
              <>
                {" · "}
                <Link
                  to={`/?service=${encodeURIComponent(service.id)}`}
                  className="hover:text-gold"
                >
                  {service.name}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      </div>
      {/* The badges on a row of their own, so a long name never runs under them. */}
      <div className="mt-2 flex flex-wrap gap-1.5 pl-13">
        <span className="flex flex-wrap gap-1.5">
          <Tag tone={secret.tier === "protected" ? "gold" : "neutral"}>
            {tierText[secret.tier].title}
          </Tag>
          {secret.scope && (
            <span title={CREDENTIAL_SCOPE_NOTE} data-testid="secret-scope">
              <Tag tone={secret.scope === "approved-changes" ? "warn" : "neutral"}>
                {CREDENTIAL_SCOPE_LABEL[secret.scope]}
              </Tag>
            </span>
          )}
        </span>
      </div>
      {(secret.kind === "login" || secret.kind === "password") && secret.username && service && (
        <BrowserSignInSwitch secret={secret} serviceName={service.name} />
      )}
      <dl className="mt-3 grid gap-1.5 text-[0.82rem]">
        {secret.username && (
          <div className="flex items-center gap-2">
            <dt className="w-24 shrink-0 text-faint">{fieldNames(secret.kind).user}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{secret.username}</span>
              <button
                type="button"
                aria-label={`Copy the username of ${secret.name}`}
                title="Copy the username"
                data-testid="copy-username"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint hover:text-gold"
                onClick={() =>
                  void navigator.clipboard?.writeText(secret.username ?? "").then(() => {
                    setUserCopied(true);
                    setTimeout(() => setUserCopied(false), 2000);
                  })
                }
              >
                {userCopied ? (
                  <Check strokeWidth={1.5} className="h-4 w-4 text-live" />
                ) : (
                  <Copy strokeWidth={1.5} className="h-4 w-4" />
                )}
              </button>
            </dd>
          </div>
        )}
        <div className="flex items-center gap-2">
          <dt className="w-24 shrink-0 text-faint">{fieldNames(secret.kind).value}</dt>
          <dd
            className="min-w-0 flex-1 font-mono break-all text-ink"
            data-testid={shown !== null ? "secret-value" : undefined}
            data-sensitive
          >
            {shown ?? "••••••••••••"}
          </dd>
        </div>
        {secret.endpoint && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Used at</dt>
            <dd className="min-w-0 flex-1 font-mono break-all text-muted">{secret.endpoint}</dd>
          </div>
        )}
      </dl>
      {secret.notes && (
        <p className="mt-2 text-[0.8rem] leading-relaxed whitespace-pre-wrap text-muted">
          {secret.notes}
        </p>
      )}
      {secret.tags.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1">
          {secret.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-faint"
            >
              {t}
            </span>
          ))}
        </p>
      )}
      <p className="mt-2 text-[0.72rem] text-faint">
        Updated {ago(secret.updatedAt).toLowerCase()}
        {secret.verifiedAt
          ? ` · worked ${ago(secret.verifiedAt).toLowerCase()}`
          : " · not confirmed yet"}
        {secret.lastUsedAt ? ` · used ${ago(secret.lastUsedAt).toLowerCase()}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {shown === null ? (
          <Button tone="quiet" onClick={() => fetchValue("show")} disabled={reveal.isPending}>
            <Eye strokeWidth={1.5} className="h-4 w-4" /> Show
          </Button>
        ) : (
          <Button tone="quiet" onClick={() => setShown(null)}>
            <EyeOff strokeWidth={1.5} className="h-4 w-4" /> Hide
          </Button>
        )}
        <Button
          tone="quiet"
          onClick={() =>
            shown !== null ? void navigator.clipboard?.writeText(shown) : fetchValue("copy")
          }
          disabled={reveal.isPending}
        >
          <Copy strokeWidth={1.5} className="h-4 w-4" /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          tone="quiet"
          onClick={() => verified.mutate(secret.id)}
          disabled={verified.isPending}
        >
          <ShieldCheck strokeWidth={1.5} className="h-4 w-4" /> It works
        </Button>
        <Button tone="quiet" onClick={onEdit}>
          Edit
        </Button>
        {confirmRemove ? (
          <Button
            tone="quiet"
            onClick={() => remove.mutate(secret.id)}
            disabled={remove.isPending}
            className="text-bad hover:text-bad"
          >
            Remove for good
          </Button>
        ) : (
          <Button tone="quiet" onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        )}
      </div>
      {(needsYou || removeNeedsYou) && (
        <div className="mt-3">
          <ConfirmIdentity
            reason={needsYou ?? "Confirm it is you to remove this credential."}
            onConfirmed={() => {
              if (needsYou) fetchValue(after);
              else remove.mutate(secret.id);
            }}
          />
        </div>
      )}
      {reveal.error && !needsYou && <FormError error={reveal.error} />}
    </li>
  );
}

/** Even locked: how many services Hearth cannot use yet (no names of credentials). */
function NeedAttention() {
  const creds = useCredentials();
  const n = (creds.data ?? []).filter((c) => c.state !== "working" && c.state !== "unused").length;
  if (!n) return null;
  return (
    <p className="mt-3 text-[0.86rem] text-amber" data-testid="vault-attention">
      {n} {n === 1 ? "service needs" : "services need"} a credential before Hearth can work with{" "}
      {n === 1 ? "it" : "them"}.
    </p>
  );
}

function Locked({ count }: { count: number }) {
  return (
    <div
      className="mx-auto max-w-xl rounded-xl border border-line bg-panel p-8 text-center"
      data-testid="vault-locked"
    >
      <span className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full border border-gold/50 text-gold cc-glow">
        <LockKeyhole strokeWidth={1.25} className="h-9 w-9" />
      </span>
      <h2 className="font-display text-[2rem] text-ink">Secure Vault is locked</h2>
      <p className="mx-auto mt-3 max-w-md text-[0.9rem] leading-relaxed text-muted">
        {count === 0
          ? "Nothing is stored yet."
          : `${count} ${count === 1 ? "credential is" : "credentials are"} stored, encrypted.`}{" "}
        Unlock with your passkey (your device's PIN, fingerprint, or face) or your password. It
        locks again by itself after five minutes.
      </p>
      <NeedAttention />
      <div className="mt-6 text-left">
        <ConfirmIdentity
          reason="Unlock Secure Vault for five minutes."
          onConfirmed={() => undefined}
        />
      </div>
    </div>
  );
}

function VaultContent({ ws }: { ws: Workspace }) {
  const vault = useVault();
  const lock = useLockVault();
  const [editing, setEditing] = useState<SecretSummary | "new" | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const data = vault.data;
  // The Hearth API key has its own place at the top, not in the list.
  const hearthKeyId = useHearthKeyId().data?.id;
  const secrets = (data?.secrets ?? []).filter((x) => x.id !== hearthKeyId);
  const categories = [...new Set(secrets.map((s) => s.category ?? "Uncategorised"))].sort();
  const shown = secrets.filter(
    (s) =>
      (!category || (s.category ?? "Uncategorised") === category) &&
      (!q ||
        [s.name, s.username, s.endpoint, s.category, ...s.tags]
          .filter(Boolean)
          .some((x) => x!.toLowerCase().includes(q.toLowerCase()))),
  );
  const grouped = categories
    .map((c) => [c, shown.filter((s) => (s.category ?? "Uncategorised") === c)] as const)
    .filter(([, list]) => list.length);

  return (
    <>
      <PageHeader
        eyebrow="Secure Vault"
        title="Credentials"
        subtitle="API keys, logins for your router, proxies, dashboards, and databases, SSH keys, and recovery codes, encrypted on this machine. AI agents never see a value: Hearth uses a credential for them, only for work it is allowed to do."
        actions={
          data && !data.locked ? (
            <Button tone="primary" onClick={() => setEditing("new")}>
              Add a credential
            </Button>
          ) : undefined
        }
      />
      {vault.error && <FormError error={vault.error} />}
      {linked && (
        <p
          role="status"
          className="mb-6 rounded-xl border border-live/40 bg-live/10 px-4 py-3 text-[0.88rem] text-ink"
          data-testid="vault-linked"
        >
          {linked}
        </p>
      )}
      {data?.locked ? (
        <Locked count={data.count ?? 0} />
      ) : data ? (
        <>
          <Panel className="mb-8 flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex items-center gap-3">
              <LockKeyholeOpen strokeWidth={1.25} className="h-5 w-5 text-gold" />
              <p className="text-[0.9rem] text-ink" data-testid="vault-state">
                {data.unlockedUntil
                  ? `Unlocked until ${clockTime(data.unlockedUntil)}. Protected credentials can be shown.`
                  : "Open because you just confirmed it is you. Unlock to show protected credentials."}
              </p>
            </div>
            <Button onClick={() => lock.mutate()} disabled={lock.isPending}>
              Lock now
            </Button>
          </Panel>
          <HearthKeyCard />
          <ServiceCredentials />
          {secrets.length === 0 ? (
            <EmptyState title="Nothing here yet">
              Add the credentials your homelab uses: service API keys such as Prowlarr's, your
              router's administrator login, proxy logins, and recovery codes.
            </EmptyState>
          ) : (
            <>
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <label className="flex min-h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-panel px-3 text-faint focus-within:border-gold/60 sm:flex-none">
                  <Search strokeWidth={1.5} className="h-4 w-4" />
                  <span className="sr-only">Search credentials</span>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search credentials"
                    className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink placeholder:text-faint focus:outline-none"
                  />
                </label>
                {[null, ...categories].map((c) => (
                  <button
                    key={c ?? "all"}
                    type="button"
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                    className={cx(
                      "min-h-10 rounded-full border px-3.5 text-[0.82rem]",
                      category === c
                        ? "border-gold text-gold"
                        : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {c ?? `All · ${secrets.length}`}
                  </button>
                ))}
              </div>
              {grouped.map(([c, list]) => (
                <Section key={c} title={`${c} · ${list.length}`}>
                  <ul className="grid gap-3 md:grid-cols-2">
                    {list.map((s) => (
                      <SecretCard key={s.id} secret={s} ws={ws} onEdit={() => setEditing(s)} />
                    ))}
                  </ul>
                </Section>
              ))}
            </>
          )}
        </>
      ) : null}

      <Section title="How it is protected">
        <div className="grid gap-4 sm:grid-cols-2">
          {(["automation", "protected"] as const).map((t) => (
            <Panel key={t} className="p-6">
              <p className="mb-2 font-display text-[1.35rem] text-ink">{tierText[t].title}</p>
              <p className="text-[0.85rem] leading-relaxed text-muted">{tierText[t].description}</p>
            </Panel>
          ))}
        </div>
        <p className="mt-4 text-[0.82rem] leading-relaxed text-faint">
          Why a passkey instead of a short PIN: a few digits typed into a web page could be guessed.
          A passkey uses your device's PIN, fingerprint, or face to unlock a real cryptographic key,
          so you get the same quick unlock with far stronger protection. Values are fetched one at a
          time when you ask, hidden again after 30 seconds, and never stored in the browser.
        </p>
      </Section>

      {editing && (
        <SecretSheet
          ws={ws}
          existing={editing === "new" ? undefined : editing}
          onClose={(linked) => {
            setEditing(null);
            setLinked(linked ?? null);
          }}
        />
      )}
    </>
  );
}

export function VaultPage() {
  return <WithWorkspace>{(ws) => <VaultContent ws={ws} />}</WithWorkspace>;
}
