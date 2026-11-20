import { useState } from "react";
import { DEFAULT_CREDENTIAL_SCOPE, type CredentialScope } from "@dragon-control/core";
import { KeyRound } from "lucide-react";
import { Button, Panel } from "../ui";
import { useCredentials, useFindKeys } from "../../data/credentials";
import { ApiError } from "../../data/api";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { KeyResults } from "./ServiceCredentials";
import { ScopeChoice } from "./AddCredential";

/**
 * Right after discovery adopts your systems: offers to find the API keys your apps keep in
 * their own settings files and store them in the Secure Vault. Nothing is read until you say
 * yes and confirm it is you; the keys are never shown, returned, or put in a conversation.
 * With nothing to find, it goes straight on.
 */
export function KeysOffer({ onDone }: { onDone: () => void }) {
  const creds = useCredentials();
  const find = useFindKeys();
  const [confirming, setConfirming] = useState(false);
  const [scope, setScope] = useState<CredentialScope>(DEFAULT_CREDENTIAL_SCOPE);
  const list = creds.data ?? [];
  const missing = list.filter((c) => c.state === "missing");
  const findable = missing.filter((c) => c.importSources.length > 0);
  const results = find.data?.results;

  const run = () =>
    find.mutate(scope, {
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });

  if (creds.isPending) {
    return (
      <Panel className="mb-12 p-6 sm:p-8">
        <p className="text-[0.9rem] text-muted">Checking which of your apps have keys to find…</p>
      </Panel>
    );
  }

  const imported = results?.filter((r) => r.imported).length ?? 0;
  return (
    <div data-testid="keys-offer">
      <Panel className="mb-12 p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-gold/40 bg-gold/10 text-gold">
            <KeyRound strokeWidth={1.5} className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-[1.5rem] leading-tight text-ink">
              {results ? "Your keys are in the vault" : "Want me to find your API keys?"}
            </p>
            {!results && (
              <p className="mt-2 max-w-2xl text-[0.88rem] leading-relaxed text-muted">
                {findable.length
                  ? `${findable.length} of your apps keep an API key in their own settings file on this machine (${findable
                      .slice(0, 6)
                      .map((c) => c.serviceName)
                      .join(
                        ", ",
                      )}${findable.length > 6 ? ", and more" : ""}). Hearth can copy them into your Secure Vault so it can read those apps for you. Nobody sees the keys, not even the AI.`
                  : missing.length
                    ? `${missing.length} of your apps need a key, but none keep one in a settings file Hearth can read. You can add them any time in Secure Vault.`
                    : "Every app that needs a key already has one in the vault."}
              </p>
            )}
            {results && (
              <>
                <p className="mt-2 text-[0.88rem] text-muted">
                  {imported} key{imported === 1 ? "" : "s"} stored.{" "}
                  {results.length - imported > 0 &&
                    "The rest can be added by hand in Secure Vault whenever you like. Click an app's name to open where its key is."}
                </p>
                <div data-testid="keys-offer-results">
                  <KeyResults results={results} />
                </div>
              </>
            )}

            {!results && findable.length > 0 && !confirming && (
              <ScopeChoice value={scope} onChange={setScope} name="keys-offer-scope" />
            )}
            {confirming ? (
              <div className="mt-4 max-w-md">
                <ConfirmIdentity
                  reason="Confirm it's you so Hearth can store your apps' keys."
                  onConfirmed={() => {
                    setConfirming(false);
                    run();
                  }}
                />
              </div>
            ) : (
              <div className="mt-5 flex flex-wrap gap-3">
                {!results && findable.length > 0 ? (
                  <>
                    <Button tone="primary" onClick={run} disabled={find.isPending}>
                      {find.isPending ? "Finding and storing…" : "Yes, find my keys"}
                    </Button>
                    <Button tone="outline" onClick={onDone} disabled={find.isPending}>
                      No thanks
                    </Button>
                  </>
                ) : (
                  <Button tone="primary" onClick={onDone}>
                    Continue
                  </Button>
                )}
              </div>
            )}
            {find.error && !confirming && (
              <p role="alert" className="mt-3 text-[0.85rem] text-bad">
                {find.error.message}
              </p>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
