import { useRef, useState, type ReactNode } from "react";
import { ExternalLink, KeyRound, PanelsLeftRight, ShieldCheck } from "lucide-react";
import {
  CREDENTIAL_FAILURE_LABEL,
  CREDENTIAL_SCOPE_LABEL,
  CREDENTIAL_SCOPE_NOTE,
  DEFAULT_CREDENTIAL_SCOPE,
  type CredentialScope,
  type CredentialStatus,
} from "@dragon-control/core";
import { Button, Sheet, cx } from "../ui";
import { ApiError, useWorkspace } from "../../data/api";
import { useCredentials, useImportCredential, useSaveCredential } from "../../data/credentials";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { ago } from "../../lib/format";
import { canOpenBeside, keyPageHref, openBeside } from "../../lib/keyPage";

/**
 * Give Hearth a service's credential without it ever entering a
 * conversation: typed here, sent straight to the Secure Vault, tried at once.
 * Or, when the app's own settings file holds it, imported on your say-so.
 */

const STATE_TEXT: Record<CredentialStatus["state"], { text: string; cls: string }> = {
  missing: { text: "No credential yet", cls: "text-muted" },
  protected: { text: "Protected: Hearth cannot use it on its own", cls: "text-amber" },
  unused: { text: "Stored, not used yet", cls: "text-muted" },
  working: { text: "Works", cls: "text-live" },
  failing: { text: "Last use failed", cls: "text-alert" },
};

export function CredentialStateText({ status }: { status: CredentialStatus }) {
  const kind = status.state === "failing" ? status.secret?.lastFailureKind : undefined;
  // Only a rejected credential is the credential's fault; the rest are shown as such.
  const s = kind
    ? {
        text: CREDENTIAL_FAILURE_LABEL[kind],
        cls: kind === "rejected" ? "text-alert" : "text-amber",
      }
    : STATE_TEXT[status.state];
  return (
    <span className={cx("text-[0.82rem]", s.cls)}>
      {s.text}
      {status.state === "working" && status.secret?.lastOkAt
        ? ` · ${ago(status.secret.lastOkAt).toLowerCase()}`
        : ""}
    </span>
  );
}

/** Where to get this service's key: its key page inside the app, or the app itself. */
export function useKeyPage(status: CredentialStatus): string | undefined {
  const services = useWorkspace().data?.services;
  return keyPageHref(
    services?.find((s) => s.id === status.serviceId),
    status.need?.keyPage,
  );
}

/**
 * The app's name as a link to where its key is: beside Hearth on a wide screen, so the vault
 * form stays in view, or in a new tab.
 */
export function AppKeyLink({
  status,
  children,
  className,
}: {
  status: CredentialStatus;
  children: ReactNode;
  className?: string;
}) {
  const href = useKeyPage(status);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${status.serviceName} where its ${status.need.label} is`}
      className={cx("hover:text-gold hover:underline", className)}
      onClick={(e) => {
        if (!canOpenBeside()) return;
        e.preventDefault();
        openBeside(href);
      }}
      data-testid="key-page-link"
    >
      {children}
    </a>
  );
}

export function AddCredentialSheet({
  status,
  onClose,
}: {
  status: CredentialStatus;
  onClose: () => void;
}) {
  const save = useSaveCredential();
  const importer = useImportCredential();
  const [value, setValue] = useState("");
  const [username, setUsername] = useState("");
  const [scope, setScope] = useState<"read" | "approved-changes">(
    status.secret?.scope ?? DEFAULT_CREDENTIAL_SCOPE,
  );
  const [confirming, setConfirming] = useState(false);
  const login = status.need.kind === "login";
  const replacing = Boolean(status.secret);
  const result = save.data;
  const source = status.importSources[0];
  // Sample data reads nothing real: say so instead of claiming the credential works.
  const sample = useWorkspace().data?.environment === "demo";
  const keyHref = useKeyPage(status);
  const beside = canOpenBeside();
  // The app's window opened from here: closed again once the key is saved and works.
  const appWindow = useRef<Window | null>(null);

  const runImport = () =>
    importer.mutate(
      { serviceId: status.serviceId, source: source!.id, scope },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 403) setConfirming(true);
        },
      },
    );

  return (
    <Sheet
      label={`${replacing ? "Replace" : "Add"} ${status.serviceName}'s ${status.need.label}`}
      eyebrow="Secure Vault"
      title={`${status.serviceName}'s ${status.need.label}`}
      onClose={onClose}
    >
      <p className="text-[0.88rem] leading-relaxed text-muted">
        {replacing ? "Replace the stored value. " : ""}Find it in{" "}
        {status.need.where.replace(/\.+$/, "")}.
      </p>
      {keyHref && !result && (
        <div className="mt-4" data-testid="key-page">
          <Button
            tone="outline"
            onClick={() => {
              if (beside) appWindow.current = openBeside(keyHref);
              else window.open(keyHref, "_blank", "noopener");
            }}
          >
            {beside ? (
              <PanelsLeftRight strokeWidth={1.5} className="h-4 w-4" />
            ) : (
              <ExternalLink strokeWidth={1.5} className="h-4 w-4" />
            )}
            {beside ? `Open ${status.serviceName} beside this` : `Open ${status.serviceName}`}
          </Button>
          <p className="mt-1.5 text-[0.76rem] text-faint">
            {beside
              ? `${status.serviceName} opens on the left half of your screen. Copy the key there and paste it here.`
              : "Copy the key there, then come back and paste it here."}
          </p>
        </div>
      )}

      {result ? (
        <div className="mt-5 space-y-4" data-testid="credential-result">
          <p
            className={cx(
              "text-[0.92rem]",
              result.status === "needs-key" || result.status === "unreachable"
                ? "text-alert"
                : "text-live",
            )}
          >
            {sample
              ? `Saved. This is sample data, so it was not tried against a real ${status.serviceName}.`
              : result.status === "needs-key"
                ? `Saved, but ${status.serviceName} did not accept it: ${result.detail ?? ""}`
                : result.status === "unreachable"
                  ? `Saved, but ${status.serviceName} could not be reached: ${result.detail ?? ""}`
                  : `Saved and working: Hearth read ${status.serviceName}${result.version ? ` ${result.version}` : ""}.`}
          </p>
          <Button tone="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value || (login && !username.trim() && !replacing)) return;
            save.mutate(
              {
                status,
                value,
                scope,
                ...(login && username.trim() ? { username: username.trim() } : {}),
              },
              {
                onSuccess: (r) => {
                  setValue("");
                  // Done with the app's page: close the window Hearth opened, if the key works.
                  if (sample || (r.status !== "needs-key" && r.status !== "unreachable")) {
                    appWindow.current?.close();
                    appWindow.current = null;
                  }
                },
              },
            );
          }}
        >
          {login && (
            <div>
              <label htmlFor="cred-username" className="mb-1.5 block text-[0.82rem] text-muted">
                Username
              </label>
              <input
                id="cred-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={replacing ? "Leave empty to keep the current one" : undefined}
                className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.92rem] text-ink focus:border-gold/60 focus:outline-none"
              />
            </div>
          )}
          <div>
            <label htmlFor="cred-value" className="mb-1.5 block text-[0.82rem] text-muted">
              {login ? "Password" : status.need.label}
            </label>
            <input
              id="cred-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 font-mono text-[0.92rem] text-ink focus:border-gold/60 focus:outline-none"
            />
          </div>
          <fieldset>
            <legend className="mb-1.5 text-[0.82rem] text-muted">Hearth may use it for</legend>
            {(["read", "approved-changes"] as const).map((s) => (
              <label key={s} className="flex min-h-10 items-center gap-2.5 text-[0.88rem] text-ink">
                <input
                  type="radio"
                  name="cred-scope"
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="accent-[var(--color-gold)]"
                />
                {CREDENTIAL_SCOPE_LABEL[s]}
              </label>
            ))}
            <p className="text-[0.76rem] text-faint">
              Either way, every change still needs your approval of the exact before and after.{" "}
              {CREDENTIAL_SCOPE_NOTE}
            </p>
          </fieldset>
          {save.error && (
            <p role="alert" className="text-[0.84rem] text-bad">
              {save.error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button tone="primary" type="submit" disabled={save.isPending || !value}>
              {save.isPending
                ? "Saving and trying it"
                : replacing
                  ? "Replace and try it"
                  : "Save and try it"}
            </Button>
            <Button tone="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
          <p className="flex items-start gap-2 text-[0.76rem] leading-relaxed text-faint">
            <ShieldCheck strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-gold/70" />
            Sent straight to the Secure Vault and encrypted on this machine. It never enters a
            conversation, and Ember never sees it: Hearth uses it only for {status.serviceName}'s
            own address.
          </p>
        </form>
      )}

      {!replacing && source && !result && (
        <div className="mt-6 rounded-xl border border-gold/30 p-4" data-testid="credential-import">
          <p className="flex items-start gap-2 text-[0.88rem] text-ink">
            <KeyRound strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
            {source.description}
          </p>
          <p className="mt-1 text-[0.78rem] text-muted">
            Hearth can copy it into the vault for you, once you confirm it is you. It reads that one
            value and never shows it.
          </p>
          {confirming ? (
            <div className="mt-3">
              <ConfirmIdentity
                reason={`Confirm it's you to import ${status.serviceName}'s key.`}
                onConfirmed={() => {
                  setConfirming(false);
                  runImport();
                }}
              />
            </div>
          ) : importer.isSuccess ? (
            <p className="mt-3 text-[0.86rem] text-live">
              Imported. Hearth is reading {status.serviceName} with it.
            </p>
          ) : (
            <Button className="mt-3" onClick={runImport} disabled={importer.isPending}>
              {importer.isPending ? "Importing" : "Import it"}
            </Button>
          )}
          {importer.error && !confirming && (
            <p role="alert" className="mt-2 text-[0.8rem] text-bad">
              {importer.error.message}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** A button that opens the form for one service, wherever a credential is needed. */
export function CredentialButton({
  serviceId,
  label,
  className,
}: {
  serviceId: string;
  label?: string;
  className?: string;
}) {
  const creds = useCredentials();
  const [open, setOpen] = useState(false);
  const status = creds.data?.find((c) => c.serviceId === serviceId);
  if (!status) return null;
  return (
    <>
      <Button className={className} tone="primary" onClick={() => setOpen(true)}>
        <KeyRound strokeWidth={1.5} className="h-4 w-4" />
        {label ?? (status.secret ? `Replace ${status.need.label}` : `Add ${status.need.label}`)}
      </Button>
      {open && <AddCredentialSheet status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * What found or imported keys may be used for, chosen before Hearth stores them. Either way,
 * every change still needs your approval of the exact before and after.
 */
export function ScopeChoice({
  value,
  onChange,
  name,
  one = false,
}: {
  value: CredentialScope;
  onChange: (scope: CredentialScope) => void;
  name: string;
  /** Asking about one key rather than all the keys found. */
  one?: boolean;
}) {
  return (
    <fieldset className="mt-4" data-testid="scope-choice">
      <legend className="mb-1 text-[0.82rem] text-muted">
        Hearth may use {one ? "this key" : "these keys"} for
      </legend>
      <div className="flex flex-wrap gap-x-5">
        {(["approved-changes", "read"] as const).map((s) => (
          <label key={s} className="flex min-h-10 items-center gap-2.5 text-[0.88rem] text-ink">
            <input
              type="radio"
              name={name}
              checked={value === s}
              onChange={() => onChange(s)}
              className="accent-[var(--color-gold)]"
            />
            {CREDENTIAL_SCOPE_LABEL[s]}
          </label>
        ))}
      </div>
      <p className="text-[0.76rem] text-faint">
        Either way, every change still needs your approval of the exact before and after. You can
        change this later in Secure Vault.
      </p>
    </fieldset>
  );
}

/** "Open Immich beside this": the app's key page, for boxes that ask for a key in place. */
export function OpenKeyPage({ serviceId }: { serviceId: string }) {
  const status = useCredentials().data?.find((c) => c.serviceId === serviceId);
  const services = useWorkspace().data?.services;
  const href = status
    ? keyPageHref(
        services?.find((s) => s.id === serviceId),
        status.need?.keyPage,
      )
    : undefined;
  if (!status || !href) return null;
  const beside = canOpenBeside();
  return (
    <Button
      tone="outline"
      onClick={() => (beside ? openBeside(href) : window.open(href, "_blank", "noopener"))}
      data-testid="open-key-page"
    >
      {beside ? (
        <PanelsLeftRight strokeWidth={1.5} className="h-4 w-4" />
      ) : (
        <ExternalLink strokeWidth={1.5} className="h-4 w-4" />
      )}
      {beside ? `Open ${status.serviceName} beside this` : `Open ${status.serviceName}`}
    </Button>
  );
}
