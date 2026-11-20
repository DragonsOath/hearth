import { useState } from "react";
import { KEY_SCOPES, SCOPE_TEXT, type KeyScope } from "@dragon-control/core";
import { Button, Section, Sheet, Tag } from "../../components/ui";
import { useCreateKey, useKeys, useRevokeKey } from "../../data/agent";
import { ago } from "../../lib/format";
import { FormError, TextField } from "./AuthFrame";

const scopeLabel: Record<KeyScope, string> = {
  read: "Read",
  converse: "Talk to the operator",
  approve: "Approve repairs",
  act: "Act",
  memory: "Homelab memory",
  work: "Long work",
};

function CreateKeySheet({ onClose }: { onClose: () => void }) {
  const create = useCreateKey();
  const [name, setName] = useState("Home Assistant");
  const [scopes, setScopes] = useState<KeyScope[]>(["read", "converse"]);
  const [copied, setCopied] = useState(false);
  const toggle = (s: KeyScope) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  if (create.data) {
    return (
      <Sheet
        label="Your new access key"
        eyebrow="Access key"
        title={create.data.summary.name}
        onClose={onClose}
      >
        <p className="mb-4 text-[0.88rem] leading-relaxed text-muted">
          Copy it now: it is shown once and never again. Paste it where the other software asks for
          a token. If it ever leaks, revoke it here.
        </p>
        <p
          data-testid="new-key"
          data-sensitive
          className="mb-4 rounded-xl border border-gold/40 bg-bg px-4 py-4 font-mono text-[0.85rem] break-all text-gold"
        >
          {create.data.key}
        </p>
        <div className="flex gap-3">
          <Button
            tone="primary"
            onClick={() =>
              void navigator.clipboard?.writeText(create.data.key).then(() => setCopied(true))
            }
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button tone="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet label="New access key" eyebrow="Access key" title="New access key" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, scopes });
        }}
      >
        <TextField
          id="key-name"
          label="What it is for"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
        />
        <fieldset className="mb-6">
          <legend className="mb-3 text-[0.85rem] text-muted">What it may do</legend>
          <div className="space-y-2">
            {KEY_SCOPES.map((s) => (
              <label
                key={s}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-[0.88rem] hover:border-line-strong"
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggle(s)}
                  className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
                />
                <span>
                  <span className="block text-ink">{scopeLabel[s]}</span>
                  <span className="block text-[0.78rem] text-faint">{SCOPE_TEXT[s]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-[0.78rem] leading-relaxed text-faint">
            No key can change settings, security, autonomy, or open the vault. For Belle, Read and
            Talk to the operator are enough.
          </p>
        </fieldset>
        <Button
          tone="primary"
          type="submit"
          className="w-full"
          disabled={create.isPending || !scopes.length}
        >
          Create key
        </Button>
        <FormError error={create.error} />
      </form>
    </Sheet>
  );
}

export function AccessKeysSection() {
  const keys = useKeys();
  const revoke = useRevokeKey();
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Access keys"
      action={<Button onClick={() => setCreating(true)}>New key</Button>}
    >
      <p className="mb-3 text-[0.82rem] leading-relaxed text-faint">
        For other software that talks to Hearth, such as Home Assistant. Each key can do only what
        you allow.
      </p>
      {keys.data && keys.data.length === 0 && (
        <p className="py-2 text-[0.9rem] text-muted">No keys yet.</p>
      )}
      <ul className="divide-y divide-line" data-testid="access-keys">
        {keys.data?.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-[0.92rem] text-ink">{k.name}</p>
              <p className="text-[0.78rem] text-faint">
                <span className="font-mono">{k.prefix}…</span> · created{" "}
                {ago(k.createdAt).toLowerCase()}
                {k.lastUsedAt ? ` · used ${ago(k.lastUsedAt).toLowerCase()}` : " · not used yet"}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {k.scopes.map((s) => (
                <Tag key={s}>{scopeLabel[s]}</Tag>
              ))}
            </div>
            <Button tone="quiet" onClick={() => revoke.mutate(k.id)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <FormError error={keys.error ?? revoke.error} />
      {creating && <CreateKeySheet onClose={() => setCreating(false)} />}
    </Section>
  );
}
