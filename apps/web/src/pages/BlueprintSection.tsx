import { useState, type ReactNode } from "react";
import {
  PREMIUM_INFO,
  type BlueprintCloud,
  type BlueprintImportPreview,
  type BlueprintStatus,
  type PremiumFeature,
} from "@dragon-control/core";
import { Button, Section, Tag } from "../components/ui";
import { ApiError } from "../data/api";
import {
  useBlueprint,
  useBlueprintImportApply,
  useBlueprintImportOpen,
  useBlueprintNotes,
  useBlueprintPreview,
  useBlueprintSetupConfirm,
  useBlueprintSetupStart,
  useBlueprintTestKey,
  useBlueprintTurnOff,
  useBlueprintUpdate,
  type BlueprintTargetInput,
} from "../data/blueprint";
import { ago, bytes, dateTime } from "../lib/format";
import { FormError } from "./auth/AuthFrame";
import { ConfirmIdentity } from "./auth/ConfirmIdentity";

const INPUT =
  "min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

/**
 * Runs an owner-only step; when Hearth asks "confirm it's you" first (403), shows that check in
 * place and runs the step again once it passes.
 */
function useOwnerStep() {
  const [retry, setRetry] = useState<() => void>();
  const guard = (run: () => Promise<unknown>) => {
    run().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 403) setRetry(() => () => void guard(run));
    });
  };
  const confirm = retry ? (
    <ConfirmIdentity
      reason="Confirm it's you. The Lab Blueprint's folder, key and imports are yours alone."
      onConfirmed={() => {
        const r = retry;
        setRetry(undefined);
        r();
      }}
    />
  ) : null;
  return { guard, confirm, waiting: Boolean(retry) };
}

/** A 403 is answered by the identity check; any other error is shown. */
function StepError({ error }: { error: Error | null | undefined }) {
  if (error instanceof ApiError && error.status === 403) return null;
  return <FormError error={error} />;
}

function Row({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
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

function sheetText(key: { recoveryKey: string; keyId: string }, where: string, cloud: boolean) {
  return [
    "HEARTH LAB BLUEPRINT: RECOVERY SHEET",
    "",
    `Recovery key (key ${key.keyId}):`,
    key.recoveryKey,
    "",
    `Blueprints are saved in: ${where}`,
    `Made: ${new Date().toLocaleString()}`,
    "",
    "To rebuild the lab on a new machine:",
    "1. Install Hearth and sign in.",
    "2. Settings > Backups > Lab Blueprint > Import a blueprint.",
    cloud
      ? "3. Download the newest hearth-blueprint-....age file from the cloud storage above, choose it and type this key."
      : "3. Choose the newest hearth-blueprint-....age file from the folder above and type this key.",
    "4. Ask Ember to plan the rebuild from it.",
    "",
    "Without Hearth, any age tool opens it: age -d -i key.txt hearth-blueprint-....age",
    "",
    "Keep this sheet somewhere safe and away from the server. Anyone with it can read the",
    "blueprint, including the vault entries saved in it.",
  ].join("\n");
}

function saveSheet(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "hearth-recovery-sheet.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The cloud services offered by name; each is S3-compatible or WebDAV underneath. */
const SERVICES = [
  {
    id: "b2",
    label: "Backblaze B2",
    kind: "s3",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    endpointHelp: "The bucket's Endpoint, shown on its page in Backblaze",
    user: "Application key ID",
    secret: "Application key",
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    kind: "s3",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com",
    endpointHelp: "The S3 API address on the bucket's Settings page",
    user: "Access key ID",
    secret: "Secret access key",
  },
  {
    id: "wasabi",
    label: "Wasabi",
    kind: "s3",
    endpoint: "https://s3.us-east-1.wasabisys.com",
    endpointHelp: "The service URL for the bucket's region",
    user: "Access key",
    secret: "Secret key",
  },
  {
    id: "aws",
    label: "Amazon S3",
    kind: "s3",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    endpointHelp: "https://s3.<the bucket's region>.amazonaws.com",
    user: "Access key ID",
    secret: "Secret access key",
  },
  {
    id: "s3",
    label: "Other S3-compatible (MinIO, NAS)",
    kind: "s3",
    endpoint: "https://minio.example.lan:9000",
    endpointHelp: "The S3 address (plain http only inside your home network)",
    user: "Access key",
    secret: "Secret key",
  },
  {
    id: "webdav",
    label: "Nextcloud or WebDAV",
    kind: "webdav",
    endpoint: "https://cloud.example.com/remote.php/dav/files/<you>/Hearth",
    endpointHelp:
      "The folder's WebDAV address (Nextcloud: Files, Settings, WebDAV, then add the folder name)",
    user: "User name",
    secret: "Password (an app password is best)",
  },
] as const;

type ServiceId = (typeof SERVICES)[number]["id"];

function serviceOf(cloud: BlueprintCloud): ServiceId {
  if (cloud.kind === "webdav") return "webdav";
  const host = cloud.endpoint.toLowerCase();
  if (host.includes("backblazeb2.com")) return "b2";
  if (host.includes("r2.cloudflarestorage.com")) return "r2";
  if (host.includes("wasabisys.com")) return "wasabi";
  if (host.includes("amazonaws.com")) return "aws";
  return "s3";
}

function Field({
  id,
  label,
  help,
  ...input
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[0.85rem] text-faint">
        {label}
      </label>
      <input
        id={id}
        type={input.type ?? "text"}
        value={input.value}
        placeholder={input.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => input.onChange(e.target.value)}
        className={`${INPUT}${input.mono === false ? "" : " font-mono"}`}
      />
      {help && <p className="text-[0.78rem] text-faint">{help}</p>}
    </div>
  );
}

/**
 * Setting up (or changing where or the key): a folder or cloud storage, then the key, then the
 * key typed back.
 */
function Setup({
  current,
  currentCloud,
  onDone,
}: {
  current?: string;
  currentCloud?: BlueprintCloud;
  onDone?: () => void;
}) {
  const [mode, setMode] = useState<"folder" | "cloud">(currentCloud ? "cloud" : "folder");
  const [folder, setFolder] = useState(currentCloud ? "" : (current ?? ""));
  const [service, setService] = useState<ServiceId>(currentCloud ? serviceOf(currentCloud) : "b2");
  const [endpoint, setEndpoint] = useState(
    currentCloud ? (currentCloud.kind === "s3" ? currentCloud.endpoint : currentCloud.url) : "",
  );
  const [bucket, setBucket] = useState(currentCloud?.kind === "s3" ? currentCloud.bucket : "");
  const [prefix, setPrefix] = useState(
    currentCloud?.kind === "s3" ? (currentCloud.prefix ?? "") : "hearth-blueprint",
  );
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [typed, setTyped] = useState("");
  const [kept, setKept] = useState(false);
  const start = useBlueprintSetupStart();
  const confirm = useBlueprintSetupConfirm();
  const owner = useOwnerStep();
  const key = start.data;
  const svc = SERVICES.find((x) => x.id === service)!;

  const target = (): BlueprintTargetInput | undefined => {
    if (mode === "folder") return folder.trim() ? { destination: folder.trim() } : undefined;
    if (!endpoint.trim() || !username.trim() || !secret) return undefined;
    if (svc.kind === "webdav")
      return { cloud: { kind: "webdav", url: endpoint.trim() }, username: username.trim(), secret };
    if (!bucket.trim()) return undefined;
    return {
      cloud: {
        kind: "s3",
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
      },
      username: username.trim(),
      secret,
    };
  };

  if (key) {
    const sheet = sheetText(key, key.where, mode === "cloud");
    return (
      <div className="space-y-4" data-testid="blueprint-key">
        <p className="max-w-2xl text-[0.85rem] leading-relaxed text-muted">
          This is the blueprint's recovery key. Hearth keeps only the half that locks; this half,
          which opens it, is shown once and never again. Without it no one, Hearth included, can
          open a blueprint.
        </p>
        <div className="rounded-xl border border-gold/40 p-4">
          <p className="mb-2 text-[0.75rem] tracking-wide text-faint uppercase">
            Recovery key {key.keyId}
          </p>
          <code
            className="block font-mono text-[0.78rem] break-all text-gold"
            data-testid="blueprint-recovery-key"
          >
            {key.recoveryKey}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              tone="quiet"
              onClick={() => void navigator.clipboard?.writeText(key.recoveryKey)}
            >
              Copy
            </Button>
            <Button tone="quiet" onClick={() => saveSheet(sheet)}>
              Save recovery sheet
            </Button>
          </div>
        </div>
        {key.sameDrive && (
          <p className="max-w-2xl text-[0.85rem] text-warn" data-testid="blueprint-same-drive">
            That folder is on the same disk as the operating system. If that disk fails, the
            blueprint goes with it. A second drive, a NAS share or cloud storage is safer.
          </p>
        )}
        {mode === "cloud" && (
          <p className="max-w-2xl text-[0.85rem] text-muted" data-testid="blueprint-cloud-ok">
            {key.where} answered and took a test file. Its login goes into the Secure Vault when you
            finish.
          </p>
        )}
        <label className="flex items-start gap-3 text-[0.85rem] text-ink">
          <input
            type="checkbox"
            checked={kept}
            onChange={(e) => setKept(e.target.checked)}
            className="mt-1"
          />
          I saved the key in my password manager or printed the sheet.
        </label>
        <div className="space-y-2">
          <label htmlFor="blueprint-retype" className="block text-[0.85rem] text-faint">
            Type or paste the key back, so you know the copy you kept is right
          </label>
          <input
            id="blueprint-retype"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            className={`${INPUT} font-mono`}
          />
        </div>
        {owner.confirm}
        <div className="flex flex-wrap gap-2">
          <Button
            tone="primary"
            disabled={!kept || !typed.trim() || confirm.isPending || owner.waiting}
            onClick={() =>
              owner.guard(async () => {
                await confirm.mutateAsync(typed.trim());
                start.reset();
                setTyped("");
                setSecret("");
                onDone?.();
              })
            }
          >
            {confirm.isPending ? "Writing the first blueprint" : "Finish and write the first one"}
          </Button>
          <Button tone="quiet" onClick={() => start.reset()}>
            Back
          </Button>
        </div>
        <StepError error={confirm.error} />
      </div>
    );
  }

  const ready = target();
  return (
    <div className="space-y-4" data-testid="blueprint-setup">
      <fieldset>
        <legend className="mb-2 text-[0.85rem] text-faint">Where to save blueprints</legend>
        <div className="inline-flex rounded-lg border border-line p-1" role="radiogroup">
          {(
            [
              ["folder", "A folder"],
              ["cloud", "Cloud storage"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                start.reset();
              }}
              className={`min-h-10 rounded-md px-4 text-[0.88rem] transition-colors ${
                mode === m ? "bg-gold/15 text-gold" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      {mode === "folder" ? (
        <Field
          id="blueprint-folder"
          label="Folder to save blueprints in"
          help="Best off this machine's system disk: a second drive, a NAS share, or a folder your Dropbox, Google Drive or OneDrive app syncs."
          value={folder}
          placeholder="/mnt/backup-drive/hearth-blueprint"
          onChange={setFolder}
        />
      ) : (
        <div className="space-y-3" data-testid="blueprint-cloud">
          <div className="space-y-1">
            <label htmlFor="blueprint-service" className="block text-[0.85rem] text-faint">
              Cloud service
            </label>
            <select
              id="blueprint-service"
              value={service}
              onChange={(e) => {
                setService(e.target.value as ServiceId);
                setEndpoint("");
              }}
              className={INPUT}
            >
              {SERVICES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="blueprint-endpoint"
            label={svc.kind === "webdav" ? "Folder address" : "Endpoint"}
            help={svc.endpointHelp}
            value={endpoint}
            placeholder={svc.endpoint}
            onChange={setEndpoint}
          />
          {svc.kind === "s3" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="blueprint-bucket"
                label="Bucket"
                help="Create it first; a private bucket"
                value={bucket}
                placeholder="my-lab-backups"
                onChange={setBucket}
              />
              <Field
                id="blueprint-prefix"
                label="Folder in the bucket (optional)"
                value={prefix}
                onChange={setPrefix}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="blueprint-user" label={svc.user} value={username} onChange={setUsername} />
            <Field
              id="blueprint-secret"
              label={svc.secret}
              type="password"
              value={secret}
              onChange={setSecret}
            />
          </div>
          <p className="max-w-2xl text-[0.8rem] leading-relaxed text-faint">
            Blueprints are encrypted with your recovery key before they leave this machine, so the
            service only ever holds locked files. The login is kept in the Secure Vault; give it a
            key that can only reach this bucket or folder if the service allows it.
            {currentCloud ? " Give the login again to keep using it." : ""}
          </p>
        </div>
      )}

      {owner.confirm}
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          disabled={!ready || start.isPending || owner.waiting}
          onClick={() => ready && owner.guard(() => start.mutateAsync(ready))}
        >
          {start.isPending
            ? mode === "cloud"
              ? "Testing the connection"
              : "Checking the folder"
            : current
              ? "Make a new key"
              : "Next: the key"}
        </Button>
        {onDone && (
          <Button tone="quiet" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
      <StepError error={start.error} />
    </div>
  );
}

function TestKey() {
  const [key, setKey] = useState("");
  const test = useBlueprintTestKey();
  const owner = useOwnerStep();
  return (
    <div className="space-y-3" data-testid="blueprint-test-key">
      <p className="max-w-2xl text-[0.85rem] text-muted">
        Opens the newest blueprint with your key, here in memory, to prove the key you kept works.
      </p>
      <input
        value={key}
        aria-label="Recovery key"
        autoComplete="off"
        spellCheck={false}
        placeholder="AGE-SECRET-KEY-1..."
        onChange={(e) => setKey(e.target.value)}
        className={`${INPUT} font-mono`}
      />
      {owner.confirm}
      <Button
        disabled={!key.trim() || test.isPending || owner.waiting}
        onClick={() => owner.guard(() => test.mutateAsync(key.trim()))}
      >
        {test.isPending ? "Opening" : "Test the key"}
      </Button>
      {test.data && (
        <p className="text-[0.85rem] text-gold" role="status">
          It opens. {test.data.file} from {dateTime(test.data.writtenAt)}: {test.data.apps} apps,{" "}
          {test.data.entries} vault entries.
        </p>
      )}
      <StepError error={test.error} />
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((b) => {
    let s = "";
    const u = new Uint8Array(b);
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  });
}

function Import({ status }: { status: BlueprintStatus }) {
  const [file, setFile] = useState<File>();
  const [key, setKey] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [movePremium, setMovePremium] = useState(true);
  const open = useBlueprintImportOpen();
  const apply = useBlueprintImportApply();
  const owner = useOwnerStep();
  const preview: BlueprintImportPreview | undefined = open.data;

  if (apply.data) {
    return (
      <div className="space-y-2" role="status" data-testid="blueprint-imported">
        <p className="text-[0.88rem] text-gold">
          Imported. {apply.data.added.length} vault entries added
          {apply.data.skipped.length
            ? `, ${apply.data.skipped.length} already here and left as they are`
            : ""}
          .
        </p>
        {apply.data.premium?.state === "moved" && (
          <p className="max-w-2xl text-[0.88rem] text-gold" data-testid="blueprint-premium-moved">
            Premium moved to this Hearth. It turns on in a moment: Hearth gets the Premium package
            and reloads itself once nothing is running. The old Hearth no longer has it.
          </p>
        )}
        {apply.data.premium?.state === "already" && (
          <p className="max-w-2xl text-[0.85rem] text-muted">
            Premium was already this Hearth&apos;s.
          </p>
        )}
        {apply.data.premium?.state === "failed" && (
          <p className="max-w-2xl text-[0.85rem] text-bad" role="alert">
            Premium didn&apos;t move: {apply.data.premium.detail} Everything else was imported;
            import the blueprint again to try moving Premium once more.
          </p>
        )}
        <p className="max-w-2xl text-[0.85rem] text-muted">
          Ember can now read the imported blueprint. Ask it to plan the rebuild with you; nothing is
          installed or changed until you approve its plan.
        </p>
      </div>
    );
  }

  if (preview) {
    return (
      <div className="space-y-4" data-testid="blueprint-import-preview">
        <p className="text-[0.88rem] text-ink">
          {preview.host}, written {dateTime(preview.writtenAt)}
          {preview.hearthVersion ? ` by Hearth ${preview.hearthVersion}` : ""}: {preview.apps} apps,{" "}
          {preview.entries.length} vault entries.
        </p>
        {preview.entries.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[0.85rem] text-faint">Vault entries to add here</legend>
            {preview.entries.map((e) => (
              <label key={e.name} className="flex items-center gap-3 text-[0.85rem] text-ink">
                <input
                  type="checkbox"
                  checked={chosen.has(e.name)}
                  onChange={(ev) => {
                    const next = new Set(chosen);
                    if (ev.target.checked) next.add(e.name);
                    else next.delete(e.name);
                    setChosen(next);
                  }}
                />
                <span>{e.name}</span>
                <span className="text-faint">{e.service ?? e.kind}</span>
                {e.tier === "protected" && <Tag>protected</Tag>}
              </label>
            ))}
          </fieldset>
        )}
        {preview.protectedLeftOut.length > 0 && (
          <p className="max-w-2xl text-[0.82rem] text-muted">
            Not in this blueprint (protected, left out of the daily ones):{" "}
            {preview.protectedLeftOut.join(", ")}. Add them again by hand, or import a blueprint
            made with Update now while the vault was unlocked.
          </p>
        )}
        {preview.premium && (
          <label
            className="flex max-w-2xl items-start gap-3 rounded-xl border border-gold/50 p-3 text-[0.85rem] text-ink"
            data-testid="blueprint-move-premium"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={movePremium}
              onChange={(e) => setMovePremium(e.target.checked)}
            />
            <span>
              <span className="font-semibold">Move Premium to this Hearth</span>
              <span className="mt-1 block text-muted">
                This blueprint carries Premium (
                {preview.premium.features
                  .map((f) => PREMIUM_INFO[f as PremiumFeature]?.name ?? f)
                  .join(", ")}
                {preview.premium.end ? `, until ${dateTime(preview.premium.end)}` : ", for good"}).
                Moving it gives this Hearth Premium, and {preview.host} stops having it. To keep
                Premium on both, link the two Hearths instead. Premium can move 3 times a year.
              </span>
            </span>
          </label>
        )}
        {owner.confirm}
        <div className="flex flex-wrap gap-2">
          <Button
            tone="primary"
            disabled={apply.isPending || owner.waiting}
            onClick={() =>
              owner.guard(() =>
                apply.mutateAsync({
                  id: preview.id,
                  names: [...chosen],
                  ...(preview.premium ? { movePremium } : {}),
                }),
              )
            }
          >
            {apply.isPending ? "Importing" : "Import"}
          </Button>
          <Button tone="quiet" onClick={() => open.reset()}>
            Back
          </Button>
        </div>
        <StepError error={apply.error} />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="blueprint-import">
      <p className="max-w-2xl text-[0.85rem] text-muted">
        For a new or rebuilt machine: open a blueprint with its recovery key. You see what it holds
        before anything is added.
        {status.imported
          ? ` Last import: ${status.imported.from}, ${ago(status.imported.at).toLowerCase()}.`
          : ""}
      </p>
      <input
        type="file"
        accept=".age"
        aria-label="Blueprint file"
        onChange={(e) => setFile(e.target.files?.[0])}
        className="block text-[0.85rem] text-muted"
      />
      <input
        value={key}
        aria-label="Recovery key for the import"
        autoComplete="off"
        spellCheck={false}
        placeholder="AGE-SECRET-KEY-1..."
        onChange={(e) => setKey(e.target.value)}
        className={`${INPUT} font-mono`}
      />
      {owner.confirm}
      <Button
        disabled={!file || !key.trim() || open.isPending || owner.waiting}
        onClick={() =>
          owner.guard(async () => {
            const p = await open.mutateAsync({ file: await readBase64(file!), recoveryKey: key });
            setChosen(new Set(p.entries.map((e) => e.name)));
            setKey("");
          })
        }
      >
        {open.isPending ? "Opening" : "Open"}
      </Button>
      <StepError error={open.error} />
    </div>
  );
}

function Notes({ status }: { status: BlueprintStatus }) {
  const [draft, setDraft] = useState<string>();
  const save = useBlueprintNotes();
  const value = draft ?? status.notes;
  return (
    <div className="mt-6 space-y-2">
      <label htmlFor="blueprint-notes" className="block text-[0.85rem] text-faint">
        Notes for the blueprint: anything Hearth can't see (router settings, a port forward, where
        the spare drive lives). Never put passwords here; they belong in the vault.
      </label>
      <textarea
        id="blueprint-notes"
        rows={4}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-lg border border-line bg-panel p-3 text-[0.88rem] text-ink focus:border-gold/60 focus:outline-none"
      />
      <Button
        disabled={draft === undefined || save.isPending}
        onClick={() => save.mutate(value, { onSuccess: () => setDraft(undefined) })}
      >
        {save.isPending ? "Saving" : "Save notes"}
      </Button>
      <FormError error={save.error} />
    </div>
  );
}

type Panel = "test" | "import" | "change" | "preview" | "off" | undefined;

/** Settings > Backups > Lab Blueprint (design: the "Lab Blueprint" doc, 2026-11-11). */
export function BlueprintSection() {
  const { data, error } = useBlueprint();
  const update = useBlueprintUpdate();
  const turnOff = useBlueprintTurnOff();
  const owner = useOwnerStep();
  const [panel, setPanel] = useState<Panel>();
  const preview = useBlueprintPreview(panel === "preview");
  const toggle = (p: Panel) => setPanel(panel === p ? undefined : p);
  const newest = data?.versions[0];

  return (
    <div className="scroll-mt-24">
      <Section
        title="Lab Blueprint"
        id="blueprint"
        action={
          data?.config ? (
            <Button
              onClick={() => owner.guard(() => update.mutateAsync())}
              disabled={update.isPending || owner.waiting}
            >
              {update.isPending ? "Updating" : "Update now"}
            </Button>
          ) : undefined
        }
      >
        <p className="mb-4 max-w-2xl text-[0.82rem] leading-relaxed text-faint">
          A written plan of this whole lab (every app, its settings, drives, networks and the vault)
          so it can be rebuilt on another machine. Once a day Hearth checks the lab and, when
          anything changed, saves a new encrypted version to a folder or cloud storage you choose.
          Only your recovery key opens it. No AI is involved in writing it.
        </p>
        {data && !data.config && (
          <>
            {data.imported && (
              <p className="mb-4 text-[0.85rem] text-muted">
                A blueprint from {data.imported.from} was imported{" "}
                {ago(data.imported.at).toLowerCase()}. Ember can read it.
              </p>
            )}
            <Setup />
            <h3 className="eyebrow mt-8 mb-3">Rebuilding from a blueprint</h3>
            <Import status={data} />
          </>
        )}
        {data?.config && (
          <>
            <div
              role="status"
              className="mb-5 flex flex-wrap items-center gap-3"
              data-testid="blueprint-status"
            >
              <Tag tone={data.lastError || data.stale ? "warn" : "gold"}>
                {data.lastError ? "Last update failed" : data.stale ? "Behind" : "Up to date"}
              </Tag>
              <span className="text-[0.88rem] text-ink">
                {data.lastCheck
                  ? `Checked ${ago(data.lastCheck).toLowerCase()}`
                  : "Not checked yet"}
                {update.data
                  ? update.data.result === "unchanged"
                    ? ". Nothing changed since the last version."
                    : ". New version saved."
                  : ""}
              </span>
            </div>
            {data.lastError && (
              <p className="mb-5 text-[0.85rem] text-warn">{data.lastError.text}</p>
            )}
            {data.sameDrive && (
              <p className="mb-5 max-w-2xl text-[0.85rem] text-warn">
                The folder is on the same disk as the operating system. If that disk fails, the
                blueprint goes with it.
              </p>
            )}
            {owner.confirm}
            <StepError error={update.error} />
            <dl className="divide-y divide-line text-[0.85rem]">
              <Row label="Saved in" value={data.config.destination} mono />
              <Row label="Recovery key" value={data.config.keyId} mono />
              <Row
                label="Newest version"
                value={
                  newest
                    ? `${dateTime(newest.at)} · ${bytes(newest.bytes)}${newest.protectedIncluded ? " · with protected entries" : ""}`
                    : "None yet"
                }
              />
              <Row label="Kept" value={`${data.versions.length} of the last ${data.config.keep}`} />
            </dl>
            <p className="mt-3 max-w-2xl text-[0.8rem] leading-relaxed text-faint">
              Daily versions leave out protected vault entries. Update now, while the vault is
              unlocked, saves a version with them too.
            </p>

            <Notes status={data} />

            <div className="mt-6 flex flex-wrap gap-2">
              <Button tone="quiet" onClick={() => toggle("preview")}>
                {panel === "preview" ? "Hide what it says" : "See what it says"}
              </Button>
              <Button tone="quiet" onClick={() => toggle("test")}>
                Test my key
              </Button>
              <Button tone="quiet" onClick={() => toggle("import")}>
                Import a blueprint
              </Button>
              <Button tone="quiet" onClick={() => toggle("change")}>
                Change where or key
              </Button>
              <Button tone="quiet" onClick={() => toggle("off")}>
                Turn off
              </Button>
            </div>
            <div className="mt-4">
              {panel === "preview" &&
                (preview.data ? (
                  <pre
                    className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-panel p-4 text-[0.78rem] leading-relaxed whitespace-pre-wrap text-ink"
                    data-testid="blueprint-preview"
                  >
                    {preview.data.markdown}
                  </pre>
                ) : (
                  <FormError error={preview.error} />
                ))}
              {panel === "test" && <TestKey />}
              {panel === "import" && <Import status={data} />}
              {panel === "change" && (
                <Setup
                  current={data.config.destination}
                  {...(data.config.cloud ? { currentCloud: data.config.cloud } : {})}
                  onDone={() => setPanel(undefined)}
                />
              )}
              {panel === "off" && (
                <div className="space-y-3">
                  <p className="max-w-2xl text-[0.85rem] text-muted">
                    Hearth stops writing blueprints and forgets where they go and the key
                    {data.config.cloud ? ", and removes the cloud login from the vault" : ""}.
                    Versions already written stay there and still open with your key.
                  </p>
                  <Button
                    onClick={() =>
                      owner.guard(async () => {
                        await turnOff.mutateAsync();
                        setPanel(undefined);
                      })
                    }
                    disabled={turnOff.isPending || owner.waiting}
                  >
                    Turn off the Lab Blueprint
                  </Button>
                  <StepError error={turnOff.error} />
                </div>
              )}
            </div>
          </>
        )}
        <FormError error={error} />
      </Section>
    </div>
  );
}
