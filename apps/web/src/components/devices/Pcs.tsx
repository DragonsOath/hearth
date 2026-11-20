import { Link } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Monitor, Plus } from "lucide-react";
import { PC_ICONS } from "@dragon-control/core";
import { Button, Panel, Section, cx } from "../ui";
import { ApiError, api } from "../../data/api";
import { useQuery } from "@tanstack/react-query";
import {
  pcLook,
  usePcs,
  useRemovePc,
  useUninstallPc,
  useUpdatePc,
  useUploadPcIcon,
  type PcInfo,
} from "../../data/pcs";
import { ago } from "../../lib/format";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { LinkPc } from "../../pages/auth/LinkPc";
import { AddonSlot, PremiumCard } from "../AddonSlot";
import { PcBadge } from "./PcBadge";

/** The PCs in your Hearth: your Hearth itself first, then every PC that joined it. */
export function PcsSection() {
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const q = usePcs({ watch: adding });
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PcInfo | null>(null);
  const [uninstalling, setUninstalling] = useState<PcInfo | null>(null);
  const data = q.data;
  if (!data) return null;
  if (data.joinedTo) {
    return (
      <Section title="PCs">
        <p className="text-[0.9rem] text-muted">
          This PC belongs to the Hearth on{" "}
          <a className="text-gold underline" href={data.joinedTo.url}>
            {data.joinedTo.name}
          </a>
          . Its PCs and devices are managed there.
        </p>
      </Section>
    );
  }
  const all: (PcInfo & { hub?: boolean })[] = [
    { ...data.hub, online: true, hub: true },
    ...data.pcs,
  ];
  const edit = all.find((p) => p.id === editing);
  return (
    <Section
      title="PCs"
      action={
        !adding && !joining ? (
          <div className="flex flex-wrap gap-2">
            {data.pcs.length === 0 && (
              <Button tone="quiet" onClick={() => setJoining(true)} data-testid="join-another">
                Join another Hearth
              </Button>
            )}
            <Button tone="outline" onClick={() => setAdding(true)}>
              <Plus strokeWidth={1.6} className="mr-1 inline h-4 w-4" /> Link another Hearth
            </Button>
          </div>
        ) : undefined
      }
    >
      {joining && <JoinAnother onClose={() => setJoining(false)} />}
      {!data.hub.icon && editing !== "hub" && (
        <Panel className="mb-4 flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-[0.88rem] text-muted">
            Give this PC an icon and a name, so you can tell at a glance which PC each project is
            on.
          </p>
          <Button tone="primary" onClick={() => setEditing("hub")}>
            Choose an icon
          </Button>
        </Panel>
      )}
      {adding && (
        // Hearth Connected (Premium package); without it, what it is and what stays free.
        <AddonSlot
          name="devices.addPc"
          props={{
            known: data.pcs.map((p) => p.id),
            pcs: data.pcs,
            onClose: () => setAdding(false),
            onJoined: (id: string) => {
              setAdding(false);
              setEditing(id);
            },
          }}
          fallback={<AddPcLocked onClose={() => setAdding(false)} />}
        />
      )}
      {edit && (
        <PcEditor
          pc={edit}
          others={all.filter((p) => p.id !== edit.id)}
          title={
            edit.hub
              ? "This PC: its icon and name"
              : edit.icon
                ? `${edit.name}: its icon and name`
                : `${edit.name} joined. Choose its icon and name`
          }
          onDone={() => setEditing(null)}
        />
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="pc-list">
        {all.map((pc) => {
          const look = pcLook(pc);
          return (
            <li key={pc.id}>
              <Panel className="flex h-full flex-col items-center p-4 text-center">
                <span
                  className="grid aspect-square w-full max-w-[9.5rem] place-items-center rounded-2xl bg-black/40"
                  style={{ opacity: pc.online ? 1 : 0.5 }}
                >
                  {look.src ? (
                    <img
                      src={look.src}
                      alt=""
                      className="h-[86%] w-[86%] rounded-full object-cover"
                      style={{ filter: `drop-shadow(0 0 10px ${look.color}55)` }}
                    />
                  ) : (
                    <Monitor strokeWidth={1.2} className="h-1/2 w-1/2 text-faint" />
                  )}
                </span>
                <p
                  className="mt-3 w-full truncate text-[1.15rem] font-semibold"
                  style={{ color: look.color }}
                  data-testid="pc-name-label"
                >
                  {pc.name}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-[0.85rem] text-muted">
                  <span
                    className={cx(
                      "inline-block h-2.5 w-2.5 rounded-full",
                      pc.online ? "bg-live" : "bg-faint",
                    )}
                    aria-hidden
                  />
                  {pc.online ? "Online" : "Offline"}
                </p>
                <p className="mt-1 text-[0.74rem] text-faint">
                  {pc.hub
                    ? "Your Hearth"
                    : !pc.online && pc.lastSeenAt
                      ? `Last seen ${ago(pc.lastSeenAt).toLowerCase()}`
                      : pc.os || ""}
                  {pc.version ? ` · Hearth ${pc.version}` : ""}
                </p>
                <div className="mt-auto flex flex-wrap justify-center gap-x-3 pt-3 text-[0.78rem]">
                  <button
                    type="button"
                    className="text-muted hover:text-gold"
                    onClick={() => setEditing(pc.id)}
                  >
                    Icon and name
                  </button>
                  {!pc.hub && (
                    <button
                      type="button"
                      className="text-muted hover:text-gold"
                      onClick={() => setRemoving(pc)}
                    >
                      Remove
                    </button>
                  )}
                  {pc.canUninstall && (
                    <button
                      type="button"
                      className="text-muted hover:text-gold"
                      onClick={() => setUninstalling(pc)}
                    >
                      Uninstall
                    </button>
                  )}
                </div>
              </Panel>
            </li>
          );
        })}
      </ul>
      {removing && <RemovePc pc={removing} onDone={() => setRemoving(null)} />}
      {uninstalling && (
        <UninstallPc
          pc={uninstalling}
          isHub={uninstalling.id === "hub"}
          others={data.pcs.length}
          onDone={() => setUninstalling(null)}
        />
      )}
    </Section>
  );
}

/** A command on its own, with a copy button. */
export function CommandBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line-strong bg-black/60 p-3">
      <code
        className="min-w-0 flex-1 font-mono text-[0.78rem] break-all text-ink select-all"
        data-testid="command"
      >
        {text}
      </code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
        aria-label="Copy the command"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:text-gold"
      >
        {copied ? <Check className="h-4 w-4 text-live" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** Choose a PC's icon (the set, or your own picture with a color) and its name. */
export function PcEditor({
  pc,
  others,
  title,
  onDone,
  bare = false,
}: {
  pc: PcInfo;
  /** The other PCs: an icon one of them uses is not free. */
  others: PcInfo[];
  title: string;
  onDone: () => void;
  /** In first-run setup: no frame, and each choice is saved as it is made (no Save button). */
  bare?: boolean;
}) {
  const takenBy = new Map(
    others.filter((o) => o.icon?.startsWith("preset:")).map((o) => [o.icon!.slice(7), o.name]),
  );
  const firstFree = PC_ICONS.find((i) => !takenBy.has(i.id))?.id ?? null;
  const update = useUpdatePc();
  const upload = useUploadPcIcon();
  const current = pc.icon?.startsWith("preset:") ? pc.icon.slice(7) : null;
  const [name, setName] = useState(pc.name);
  const [icon, setIcon] = useState<string | null>(current ?? (pc.icon ? null : firstFree));
  const [picture, setPicture] = useState<{ type: string; data: string; url: string } | null>(null);
  const [color, setColor] = useState(pc.color ?? "#ff9124");
  const preview = useMemo(
    () =>
      picture
        ? { id: pc.id, name, icon: null, color }
        : icon
          ? { id: pc.id, name, icon: `preset:${icon}`, color: null }
          : { id: pc.id, name, icon: pc.icon, color: pc.color },
    [picture, icon, name, color, pc],
  );
  const save = async () => {
    if (picture)
      await upload.mutateAsync({ id: pc.id, type: picture.type, data: picture.data, color });
    await update.mutateAsync({
      id: pc.id,
      name: name.trim() || pc.name,
      ...(icon && !picture ? { icon } : {}),
    });
    onDone();
  };
  const busy = update.isPending || upload.isPending;
  // Setup: a PC without an icon gets the first free one at once, so its marks show everywhere.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (bare && !pc.icon && firstFree && !autoPicked.current) {
      autoPicked.current = true;
      update.mutate({ id: pc.id, icon: firstFree });
    }
  }, [bare, pc.icon, pc.id, firstFree, update]);
  const body = (
    <div data-testid="pc-editor">
      <p className="text-[0.95rem] text-ink">{title}</p>
      <div className="mt-4 flex flex-wrap items-start gap-6">
        <div className="flex w-36 flex-col items-center">
          {picture ? (
            <span className="inline-flex flex-col items-center gap-1">
              <img src={picture.url} alt="" className="h-24 w-24 rounded-full object-cover" />
              <span className="text-[0.95rem] font-medium" style={{ color }}>
                {name || pc.name}
              </span>
            </span>
          ) : (
            <PcBadge pc={preview} size={96} />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <label className="block text-[0.85rem] text-muted">
            What's this PC called?
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (bare && name.trim() && name.trim() !== pc.name)
                  update.mutate({ id: pc.id, name: name.trim() });
              }}
              maxLength={60}
              className="mt-1 block min-h-11 w-full max-w-sm rounded-lg border border-line-strong bg-bg px-3 text-ink focus:border-gold/60 focus:outline-none"
              data-testid="pc-name"
            />
          </label>
          <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-2">
            {PC_ICONS.map((i) => {
              const on = !picture && icon === i.id;
              const usedBy = takenBy.get(i.id);
              return (
                <button
                  key={i.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={usedBy ? `${i.label} (used by ${usedBy})` : i.label}
                  title={usedBy ? `Used by ${usedBy}` : i.label}
                  disabled={Boolean(usedBy)}
                  onClick={() => {
                    setPicture(null);
                    setIcon(i.id);
                    if (bare) update.mutate({ id: pc.id, icon: i.id });
                  }}
                  className={cx(
                    "rounded-full p-0.5 transition-transform",
                    usedBy ? "cursor-not-allowed opacity-30 grayscale" : "hover:scale-105",
                  )}
                  style={on ? { boxShadow: `0 0 0 2px ${i.color}` } : undefined}
                >
                  <img src={`/pc-icons/${i.id}.webp`} alt="" className="h-14 w-14 rounded-full" />
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[0.82rem] text-muted">
            <label className="cursor-pointer rounded-full border border-line px-3 py-1.5 hover:text-ink">
              Use my own picture
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const r = new FileReader();
                  r.onload = () => {
                    const url = String(r.result);
                    setPicture({ type: f.type, data: url.split(",")[1] ?? "", url });
                    setIcon(null);
                    if (bare)
                      upload.mutate({
                        id: pc.id,
                        type: f.type,
                        data: url.split(",")[1] ?? "",
                        color,
                      });
                  };
                  r.readAsDataURL(f);
                }}
              />
            </label>
            {picture && (
              <label className="flex items-center gap-2">
                Name color
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  aria-label="The color its name is shown in"
                />
              </label>
            )}
          </div>
          {bare ? (
            <p className="text-[0.8rem] text-faint" aria-live="polite">
              {busy
                ? "Saving…"
                : "Saved as you choose. You can change it any time in PCs and devices."}
            </p>
          ) : (
            <div className="flex gap-2">
              <Button tone="primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button tone="quiet" onClick={onDone} disabled={busy}>
                Cancel
              </Button>
            </div>
          )}
          {(update.error || upload.error) && (
            <p role="alert" className="text-[0.85rem] text-bad">
              {(update.error ?? upload.error)!.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
  return bare ? body : <Panel className="mb-5 p-5">{body}</Panel>;
}

/** Remove a PC from your Hearth: it forgets this Hearth; Hearth stays installed there. */
function RemovePc({ pc, onDone }: { pc: PcInfo; onDone: () => void }) {
  const remove = useRemovePc();
  const [confirming, setConfirming] = useState(false);
  const run = () =>
    remove.mutate(pc.id, {
      onSuccess: onDone,
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });
  return (
    <Dialog title={`Remove ${pc.name}?`} onClose={onDone}>
      <p>
        {pc.name} leaves this Hearth: its projects and systems stop showing here, and it goes back
        to its own setup page. Hearth stays installed there with its files; use Uninstall to remove
        it completely.
      </p>
      {confirming ? (
        <ConfirmIdentity
          reason={`Confirm it's you to remove ${pc.name}.`}
          onConfirmed={() => {
            setConfirming(false);
            run();
          }}
        />
      ) : (
        <div className="flex justify-end gap-2">
          <Button tone="quiet" onClick={onDone}>
            Keep it
          </Button>
          <Button tone="primary" onClick={run} disabled={remove.isPending}>
            Remove {pc.name}
          </Button>
        </div>
      )}
      {remove.error && !confirming && <p className="text-bad">{remove.error.message}</p>}
    </Dialog>
  );
}

/** Uninstall Hearth from a PC, from any device: type its name to confirm. */
function UninstallPc({
  pc,
  isHub,
  others,
  onDone,
}: {
  pc: PcInfo;
  isHub: boolean;
  others: number;
  onDone: () => void;
}) {
  const uninstall = useUninstallPc();
  const [typed, setTyped] = useState("");
  const [deleteData, setDeleteData] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [leaveWaiting, setLeaveWaiting] = useState(false);
  // The Crucible's clean exit, said up front (your Hearth only).
  const exit = useQuery({
    queryKey: ["crucible-exit"],
    queryFn: () =>
      api<{ waiting: { service: string; titles: string[] }[]; seerrs: string[] }>(
        "GET",
        "/api/crucible/exit",
      ),
    enabled: isHub,
  });
  const waitingCount = (exit.data?.waiting ?? []).reduce((n, w) => n + w.titles.length, 0);
  const run = () =>
    uninstall.mutate(
      { id: pc.id, confirmName: typed, deleteData, leaveWaiting },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 403 && /Confirm it/.test(e.message))
            setConfirming(true);
        },
      },
    );
  const result = uninstall.data;
  const choose = result?.needsChoice === "leave-waiting";
  return (
    <Dialog title={`Uninstall Hearth from ${pc.name}?`} onClose={onDone}>
      {result && !choose ? (
        <>
          <p className={result.ok ? "text-live" : "text-warn"}>{result.message}</p>
          <div className="flex justify-end">
            <Button tone="primary" onClick={onDone}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          {isHub ? (
            <p className="text-warn">
              This is your Hearth itself.{" "}
              {others
                ? `Every PC that joined it (${others}) is let go first and goes back to its own setup page, and every device is signed out. `
                : "Every device signed in to it is signed out. "}
              Back up first if you might want anything from it.
            </p>
          ) : (
            <p>
              Hearth stops on {pc.name}, stops starting with it, and leaves this Hearth. Its
              projects' files stay where they are.
            </p>
          )}
          {isHub && (exit.data?.seerrs.length || waitingCount > 0) ? (
            <p data-testid="uninstall-crucible">
              First, the Crucible hands requests back:{" "}
              {exit.data?.seerrs.length
                ? `${exit.data.seerrs.join(", ")} searches by itself again with the profile it used before. `
                : ""}
              {waitingCount
                ? `${waitingCount} ${waitingCount === 1 ? "request" : "requests"} waiting for the Crucible ${waitingCount === 1 ? "gets its" : "get their"} profile and ${waitingCount === 1 ? "is" : "are"} searched.`
                : ""}
            </p>
          ) : null}
          {choose && (
            <div className="space-y-2" data-testid="uninstall-crucible-problem">
              <p className="text-warn">{result.message}</p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={leaveWaiting}
                  onChange={(e) => setLeaveWaiting(e.target.checked)}
                  className="mt-1"
                />
                <span>Remove Hearth anyway and leave those requests waiting.</span>
              </label>
            </div>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(e) => setDeleteData(e.target.checked)}
              className="mt-1"
            />
            <span>
              Also delete Hearth's own folder there (its settings, vault and backups). This can't be
              undone.
            </span>
          </label>
          <label className="block">
            Type <span className="text-ink">{pc.name}</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-ink"
              data-testid="uninstall-confirm"
            />
          </label>
          {confirming ? (
            <ConfirmIdentity
              reason={`Confirm it's you to uninstall Hearth from ${pc.name}.`}
              onConfirmed={() => {
                setConfirming(false);
                run();
              }}
            />
          ) : (
            <div className="flex justify-end gap-2">
              <Button tone="quiet" onClick={onDone}>
                Keep it
              </Button>
              <Button
                tone="primary"
                onClick={run}
                disabled={
                  uninstall.isPending || typed.trim().toLowerCase() !== pc.name.toLowerCase()
                }
              >
                {uninstall.isPending ? "Uninstalling…" : "Uninstall"}
              </Button>
            </div>
          )}
          {uninstall.error && !confirming && <p className="text-bad">{uninstall.error.message}</p>}
        </>
      )}
    </Dialog>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md space-y-4 rounded-2xl border border-gold/40 bg-panel p-5 text-[0.88rem] leading-relaxed text-muted"
      >
        <p className="flex items-center gap-2 text-[1rem] text-ink">
          <Monitor className="h-4 w-4 text-gold" strokeWidth={1.6} />
          {title}
        </p>
        {children}
      </div>
    </div>
  );
}

/**
 * A PC set up on its own first joins the Hearth you already have (Settings, PCs and devices):
 * confirm it is you, then the same steps as a new PC's setup. Everything on this PC stays.
 */
function JoinAnother({ onClose }: { onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Panel className="mb-5 p-5">
      <div data-testid="join-another-panel" className="max-w-md">
        <p className="text-[0.95rem] text-ink">Join another Hearth</p>
        <p className="mt-1 mb-4 text-[0.82rem] leading-relaxed text-muted">
          This PC becomes one of that Hearth&apos;s PCs, used from there. Everything on it stays:
          its projects, the systems it found, its memory and its keys. A backup is made first.
        </p>
        {confirmed ? (
          <LinkPc setupCode="" signedIn onBack={onClose} />
        ) : (
          <>
            <ConfirmIdentity
              reason="Confirm it's you to join another Hearth."
              onConfirmed={() => setConfirmed(true)}
            />
            <Button tone="quiet" className="mt-3" onClick={onClose}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Link another Hearth without the Premium package: what Hearth Connected is, and what's free. */
function AddPcLocked({ onClose }: { onClose: () => void }) {
  return (
    <Panel className="mb-5 p-5">
      <div data-testid="add-pc">
        <p className="text-[0.95rem] text-ink">Link another Hearth</p>
        <div className="mt-4 max-w-2xl space-y-3" data-testid="add-pc-locked">
          <PremiumCard feature="hearth_interconnectivity" />
          <p className="text-[0.85rem] leading-relaxed text-ink" data-testid="add-pc-free">
            Just want to watch another machine, its apps, Docker or a NAS? That&apos;s free:{" "}
            <Link to="/services?add=system" className="text-gold underline">
              Add a system
            </Link>
            .
          </p>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}
