import { useState } from "react";
import {
  CREDENTIAL_SCOPE_LABEL,
  CREDENTIAL_SCOPE_NOTE,
  DEFAULT_CREDENTIAL_SCOPE,
  type CredentialScope,
  type CredentialStatus,
} from "@dragon-control/core";
import { Button, Section } from "../ui";
import { useCredentialScope, useCredentials, useFindKeys } from "../../data/credentials";
import { ApiError } from "../../data/api";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { ago } from "../../lib/format";
import { AddCredentialSheet, AppKeyLink, CredentialStateText, ScopeChoice } from "./AddCredential";

/**
 * The vault from the services' side: which ones Hearth can work with,
 * whether their credential works, when it last did, and what it may be used
 * for. Never values. Problems first.
 */
export function ServiceCredentials() {
  const creds = useCredentials();
  const scope = useCredentialScope();
  const [editing, setEditing] = useState<CredentialStatus | null>(null);
  if (!creds.data?.length) return null;
  const rank: Record<CredentialStatus["state"], number> = {
    failing: 0,
    missing: 1,
    protected: 2,
    unused: 3,
    working: 4,
  };
  const list = [...creds.data].sort((a, b) => rank[a.state] - rank[b.state]);
  const findable = list.filter((c) => c.state === "missing" && c.importSources.length > 0).length;
  return (
    <Section title="What Hearth can use">
      <FindKeys findable={findable} missing={list.filter((c) => c.state === "missing").length} />
      <ul className="divide-y divide-line" data-testid="service-credentials">
        {list.map((c) => (
          <li key={c.serviceId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[0.95rem] text-ink">
                <AppKeyLink status={c}>{c.serviceName}</AppKeyLink>{" "}
                <span className="text-[0.78rem] text-faint">· {c.need.label}</span>
              </p>
              <p>
                <CredentialStateText status={c} />
              </p>
              {c.state === "failing" && c.secret?.lastFailure && (
                <p className="mt-0.5 text-[0.78rem] text-muted">{c.secret.lastFailure}</p>
              )}
              {c.secret && (
                <p className="mt-0.5 text-[0.74rem] text-faint">
                  {c.secret.lastUsedAt
                    ? `Last used ${ago(c.secret.lastUsedAt).toLowerCase()}. `
                    : ""}
                  {c.secret.source && c.secret.source !== "you" ? `${c.secret.source}.` : ""}
                </p>
              )}
              {c.state === "missing" && c.importSources.length > 0 && (
                <p className="mt-0.5 text-[0.78rem] text-gold/90">
                  Found in {c.serviceName}'s settings file; can be imported.
                </p>
              )}
            </div>
            {c.secret && c.state !== "protected" && (
              <label className="flex items-center gap-2 text-[0.78rem] text-muted">
                <span className="sr-only">What {c.serviceName}'s credential may be used for</span>
                <select
                  value={c.secret.scope}
                  disabled={scope.isPending}
                  onChange={(e) =>
                    scope.mutate({
                      secretId: c.secret!.id,
                      scope: e.target.value as "read" | "approved-changes",
                    })
                  }
                  className="min-h-9 rounded-lg border border-line bg-bg px-2 text-[0.8rem] text-ink"
                >
                  {(["read", "approved-changes"] as const).map((s) => (
                    <option key={s} value={s}>
                      {CREDENTIAL_SCOPE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              className="min-h-9 px-4"
              tone={c.secret ? "outline" : "primary"}
              onClick={() => setEditing(c)}
            >
              {c.secret ? "Replace" : "Add"}
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[0.78rem] text-faint">
        Hearth picks the right credential by itself whenever it reads these services or carries out
        a change you approved. It only ever sends a credential to its own service's address.{" "}
        {CREDENTIAL_SCOPE_NOTE}
      </p>
      {editing && <AddCredentialSheet status={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

/**
 * Find my keys: one button imports every key that an app keeps in its own
 * settings file on this machine, straight into the vault. It needs a fresh "it's you"; the
 * keys are never shown, returned, or put in a conversation.
 */
function FindKeys({ findable, missing }: { findable: number; missing: number }) {
  const find = useFindKeys();
  const [confirming, setConfirming] = useState(false);
  const [scope, setScope] = useState<CredentialScope>(DEFAULT_CREDENTIAL_SCOPE);
  const run = () =>
    find.mutate(scope, {
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });
  const results = find.data?.results;
  if (!missing && !results) return null;
  return (
    <div className="mb-5 rounded-xl border border-gold/30 p-4" data-testid="find-keys">
      <p className="text-[0.92rem] text-ink">Find my keys</p>
      <p className="mt-1 text-[0.8rem] leading-relaxed text-muted">
        {findable
          ? `${findable} of the ${missing} apps without a key keep one in their own settings file on this machine. Hearth can copy them all into the vault at once, without showing them to anyone, including Ember.`
          : `${missing} apps still need a key, and none of them keep one in a settings file Hearth can read. Add those by hand with Add.`}
      </p>
      {confirming ? (
        <div className="mt-3">
          <ConfirmIdentity
            reason="Confirm it's you to import your apps' keys."
            onConfirmed={() => {
              setConfirming(false);
              run();
            }}
          />
        </div>
      ) : (
        findable > 0 && (
          <>
            <ScopeChoice value={scope} onChange={setScope} name="find-keys-scope" />
            <Button className="mt-3" onClick={run} disabled={find.isPending}>
              {find.isPending
                ? "Finding and importing…"
                : `Import ${findable} key${findable === 1 ? "" : "s"}`}
            </Button>
          </>
        )
      )}
      {find.error && !confirming && (
        <p role="alert" className="mt-2 text-[0.8rem] text-bad">
          {find.error.message}
        </p>
      )}
      {results && <KeyResults results={results} />}
    </div>
  );
}

/** What Find my keys did, per app; the name of an app still without a key opens where it is. */
export function KeyResults({
  results,
}: {
  results: { serviceId: string; serviceName: string; imported: boolean; note: string }[];
}) {
  const creds = useCredentials();
  return (
    <ul className="mt-3 space-y-1 text-[0.8rem]" data-testid="find-keys-results">
      {results.map((r) => {
        const status = creds.data?.find((c) => c.serviceId === r.serviceId);
        return (
          <li key={r.serviceId} className={r.imported ? "text-live" : "text-muted"}>
            {status && !r.imported ? (
              <AppKeyLink status={status} className="text-ink underline decoration-line-strong">
                {r.serviceName}
              </AppKeyLink>
            ) : (
              r.serviceName
            )}
            : {r.note}
          </li>
        );
      })}
    </ul>
  );
}
