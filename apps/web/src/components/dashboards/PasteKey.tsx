import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../data/api";
import { Button } from "../ui";
import { DEFAULT_CREDENTIAL_SCOPE, type CredentialScope } from "@dragon-control/core";
import { OpenKeyPage, ScopeChoice } from "../credentials/AddCredential";

/**
 * For apps that keep their API keys in their own database (Jellyfin, Immich, Kavita,
 * Audiobookshelf): Hearth cannot take a key from their files, so the owner creates one in the app
 * and pastes it here once. It goes straight into Secure Vault, for diagnostics only or also for
 * changes the owner approves, as they choose; Ember never sees it.
 */
export function PasteKey({
  serviceId,
  name,
  where,
  message,
  testId = "needs-key",
}: {
  serviceId: string;
  name: string;
  /** Where in the app the key is made ("Dashboard, then API Keys, then +"). */
  where: string;
  message?: string;
  testId?: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState<CredentialScope>(DEFAULT_CREDENTIAL_SCOPE);
  const qc = useQueryClient();
  return (
    <div
      className="space-y-3 rounded-xl border border-amber/40 p-4 text-[0.86rem]"
      data-testid={testId}
    >
      <p className="text-amber">Hearth is not connected to {name} yet.</p>
      <p className="text-muted">
        {name} keeps its API keys in its own database, so Hearth cannot take one from its files. In{" "}
        {name}, open {where}, create a key named Hearth, and paste it here. It goes straight into
        Secure Vault; Ember never sees it.
      </p>
      {message && <p className="text-[0.8rem] text-faint">{message}</p>}
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
          data-testid="paste-key"
        />
        <Button
          tone="primary"
          type="submit"
          disabled={saving || !value.trim()}
          data-testid="paste-key-save"
        >
          {saving ? "Saving…" : "Connect"}
        </Button>
      </form>
      {error && <p className="text-alert">{error}</p>}
    </div>
  );
}
