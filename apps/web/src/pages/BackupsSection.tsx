import { useState } from "react";
import { Button, Section, Tag } from "../components/ui";
import { ApiError } from "../data/api";
import { useBackupKeys, useBackups, useRunBackup } from "../data/memory";
import { ago, bytes } from "../lib/format";
import { FormError } from "./auth/AuthFrame";
import { ConfirmIdentity } from "./auth/ConfirmIdentity";

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd
        className={
          mono
            ? "font-mono text-[0.78rem] break-all text-ink sm:text-right"
            : "text-ink sm:text-right"
        }
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The keys that open off-machine backups and background secrets, shown
 * only after confirming it is you, for your password manager. They are
 * never written to notes, memory, or saved sessions.
 */
function KeysToKeep() {
  const keys = useBackupKeys();
  const [open, setOpen] = useState(false);
  const needsConfirm = keys.error instanceof ApiError && keys.error.status === 403;
  if (!open) {
    return (
      <Button tone="quiet" onClick={() => setOpen(true)}>
        Keys to keep safe
      </Button>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-gold/30 p-5" data-testid="keys-to-keep">
      <p className="mb-4 max-w-2xl text-[0.85rem] leading-relaxed text-muted">
        Store these in your password manager, not in notes. The backup key opens the encrypted
        copies on your other machine; the secrets key opens saved webhook addresses and API keys
        after a restore. Without them, a restored backup is missing those.
      </p>
      {keys.data ? (
        <dl className="divide-y divide-line text-[0.85rem]">
          {[
            ["Backup key", keys.data.backupKey],
            ...(keys.data.vaultKey ? [["Secrets key", keys.data.vaultKey]] : []),
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-2 py-3">
              <dt className="text-faint">{label}</dt>
              <dd className="flex flex-wrap items-center gap-3">
                <code className="font-mono text-[0.78rem] break-all text-gold">{value}</code>
                <Button tone="quiet" onClick={() => void navigator.clipboard?.writeText(value!)}>
                  Copy
                </Button>
              </dd>
            </div>
          ))}
        </dl>
      ) : needsConfirm ? (
        <ConfirmIdentity
          reason="Confirm it is you to see the keys."
          onConfirmed={() => keys.mutate()}
        />
      ) : (
        <Button onClick={() => keys.mutate()} disabled={keys.isPending}>
          Show the keys
        </Button>
      )}
      {!needsConfirm && <FormError error={keys.error} />}
      <div className="mt-4">
        <Button
          tone="quiet"
          onClick={() => {
            keys.reset();
            setOpen(false);
          }}
        >
          Hide
        </Button>
      </div>
    </div>
  );
}

/** Settings > Backups: local backups, the off-machine copy, and the keys to keep safe. */
export function BackupsSection() {
  const { data, error } = useBackups();
  const run = useRunBackup();
  const last = data?.recent[0];
  const off = data?.offsite;
  return (
    <div id="backups" className="scroll-mt-24">
      <Section
        title="Backups"
        action={
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Backing up" : "Back up now"}
          </Button>
        }
      >
        <p className="mb-4 max-w-2xl text-[0.82rem] leading-relaxed text-faint">
          Once a day after 3 in the morning, everything (memory, history, settings, and the
          encrypted vault) is copied, opened again to check it is whole, and written out as readable
          files too. Problems reach you as notifications.
        </p>
        {data && (
          <>
            <div
              role="status"
              className="mb-5 flex flex-wrap items-center gap-3"
              data-testid="backup-status"
            >
              {last ? (
                <>
                  <Tag tone={last.ok ? "gold" : "warn"}>
                    {last.ok ? "Backed up" : "Last backup failed"}
                  </Tag>
                  <span className="text-[0.88rem] text-ink">
                    {ago(last.at)}
                    {last.ok && last.bytes ? ` · ${bytes(last.bytes)}` : ""}
                  </span>
                </>
              ) : (
                <span className="text-[0.88rem] text-muted">
                  No backup yet. The first one runs within a few minutes.
                </span>
              )}
            </div>
            {last && !last.ok && <p className="mb-5 text-[0.85rem] text-warn">{last.detail}</p>}
            <dl className="divide-y divide-line text-[0.85rem]">
              <Row label="Kept here" value={`${data.files.length} of the last ${data.keep} days`} />
              <Row label="Saved in" value={data.dir} mono />
              <Row label="Readable copy" value={data.exportDir} mono />
            </dl>

            <h3 className="eyebrow mt-8 mb-3">Off this machine</h3>
            {off ? (
              <div data-testid="offsite-status">
                <div role="status" className="mb-3 flex flex-wrap items-center gap-3">
                  <Tag tone={off.stale ? "warn" : off.lastVerified ? "gold" : "neutral"}>
                    {off.stale
                      ? "Behind"
                      : off.lastVerified
                        ? "Up to date"
                        : "Waiting for the first copy"}
                  </Tag>
                  <span className="text-[0.88rem] text-ink">
                    {off.lastVerified
                      ? `${off.name} confirmed a copy ${ago(off.lastVerified.receivedAt).toLowerCase()}`
                      : `${off.name} has not fetched a copy yet`}
                  </span>
                </div>
                {off.lastError && (
                  <p className="mb-3 text-[0.85rem] text-warn">{off.lastError.detail}</p>
                )}
                <dl className="divide-y divide-line text-[0.85rem]">
                  <Row label="Encrypted and waiting" value={`${off.pending.length}`} />
                  {off.lastVerified && (
                    <Row
                      label="Stored at"
                      value={`${off.name}: ${off.lastVerified.destination}`}
                      mono
                    />
                  )}
                </dl>
                <p className="mt-3 max-w-2xl text-[0.8rem] leading-relaxed text-faint">
                  Each backup is encrypted here, then {off.name} fetches it and checks its
                  fingerprint. This machine cannot change or delete those copies. If {off.name} is
                  off, it catches up on its own when it is back.
                </p>
              </div>
            ) : (
              <p className="text-[0.85rem] text-muted">
                Not set up. Backups exist only on this machine, so a failed disk would take them
                too.
              </p>
            )}
            <div className="mt-6">
              <KeysToKeep />
            </div>
          </>
        )}
        <FormError error={error ?? run.error} />
      </Section>
    </div>
  );
}
