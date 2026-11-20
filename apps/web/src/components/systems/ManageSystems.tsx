import { useId, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import {
  SERVICE_CATEGORIES,
  type ManualSystemKind,
  type RemovedService,
  type Service,
  type ServiceCategory,
  type Workspace,
} from "@dragon-control/core";
import { useAddSystem, useAiName, useRemoveSystem, useRestoreSystem } from "../../data/api";
import { ago } from "../../lib/format";
import { Button, Rows, cx } from "../ui";
import { Modal } from "../workspace/dialogs";

/**
 * Adding and removing systems by hand. Removing only changes what
 * Hearth watches: the container or app itself is never stopped, deleted, or
 * changed, and a removed system can always be brought back from Settings.
 */

/** Closes the dialog a button sits in (Escape and the backdrop close it natively). */
const close = (e: MouseEvent<HTMLButtonElement>) => e.currentTarget.closest("dialog")?.close();

const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

/** "Remove from Hearth" on a system's page and panel, behind a plain confirmation. */
export function RemoveSystem({ service, onRemoved }: { service: Service; onRemoved?: () => void }) {
  const remove = useRemoveSystem();
  const aiName = useAiName();
  const [asking, setAsking] = useState(false);
  const bodyId = useId();
  return (
    <div data-testid="remove-system">
      <p className="text-[0.82rem] leading-relaxed text-muted">
        Stopped using it? Remove it so Hearth stops watching it. The app itself is not touched.
      </p>
      <Button className="mt-3" onClick={() => setAsking(true)}>
        Remove from Hearth
      </Button>
      {asking && (
        <Modal
          title={`Remove ${service.name} from Hearth?`}
          role="alertdialog"
          describedBy={bodyId}
          onCancel={() => {
            setAsking(false);
            remove.reset();
          }}
        >
          <div id={bodyId} className="mt-3 space-y-2 text-[0.88rem] leading-relaxed text-muted">
            <p>
              Hearth will stop watching {service.name} and hide it from your lists, the sidebar,
              panels, and what {aiName} sees.
            </p>
            <p>
              {service.name} itself is not stopped, deleted, or changed. It keeps running exactly as
              it is now.
            </p>
            <p className="text-[0.8rem] text-faint">
              Its history stays in the audit log, and a new scan will not add it back. You can bring
              it back any time from Settings, Systems tab, under Removed systems.
            </p>
          </div>
          {remove.error && (
            <p role="alert" className="mt-3 text-[0.85rem] text-bad">
              {remove.error.message}
            </p>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button autoFocus onClick={close}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(service.id, {
                  onSuccess: () => {
                    setAsking(false);
                    onRemoved?.();
                  },
                })
              }
            >
              {remove.isPending ? "Removing" : `Remove ${service.name}`}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const KINDS: { value: ManualSystemKind; label: string; hint: string }[] = [
  { value: "container", label: "A container", hint: "Runs in Docker on this machine." },
  { value: "web", label: "An app with a web address", hint: "Anything you open in a browser." },
  { value: "other", label: "Something else", hint: "Listed, and checked if it has an address." },
];

const ADDRESS: Record<ManualSystemKind, { label: string; placeholder: string; hint: string }> = {
  container: {
    label: "Container name",
    placeholder: "Container name",
    hint: "Exactly as Docker shows it.",
  },
  web: {
    label: "Web address",
    placeholder: "Web address",
    hint: "Hearth checks that it answers.",
  },
  other: {
    label: "Web address (optional)",
    placeholder: "Web address",
    hint: "With an address, Hearth checks that it answers. Without one, it is only listed.",
  },
};

/** "Add a system" on the Systems page: for anything discovery missed. */
export function AddSystem({ ws }: { ws: Workspace }) {
  // Opened straight away from a link that asks for it (Link another Hearth's free option).
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("add") === "system",
  );
  if (ws.hosts.length === 0) return null;
  return (
    <>
      <Button tone="primary" onClick={() => setOpen(true)}>
        Add a system
      </Button>
      {open && <AddSystemDialog ws={ws} onDone={() => setOpen(false)} />}
    </>
  );
}

function AddSystemDialog({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const add = useAddSystem();
  const navigate = useNavigate();
  const ids = { name: useId(), address: useId(), category: useId(), host: useId(), kind: useId() };
  const thisMachine = ws.hosts.find((h) => h.connection === "this-machine") ?? ws.hosts[0]!;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ManualSystemKind>("container");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState<ServiceCategory>("Media");
  const [hostId, setHostId] = useState(thisMachine.id);
  const field = ADDRESS[kind];

  return (
    <Modal
      title="Add a system"
      onCancel={() => {
        add.reset();
        onDone();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { name, kind, address, category, hostId },
            {
              onSuccess: (added) => {
                onDone();
                navigate(`/services/${encodeURIComponent(added.id)}`);
              },
            },
          );
        }}
      >
        <p className="mt-2 text-[0.85rem] leading-relaxed text-muted">
          For anything discovery missed. Hearth watches it like any other system.
        </p>

        <div className="mt-4">
          <label htmlFor={ids.name} className="block text-[0.8rem] text-muted">
            Name
          </label>
          <input
            id={ids.name}
            value={name}
            required
            maxLength={60}
            placeholder="System Name"
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>

        <fieldset className="mt-4">
          <legend className="text-[0.8rem] text-muted">What kind is it?</legend>
          <div className="mt-1 space-y-1">
            {KINDS.map((k) => (
              <label
                key={k.value}
                className={cx(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2",
                  kind === k.value ? "border-gold/60" : "border-line",
                )}
              >
                <input
                  type="radio"
                  name={ids.kind}
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                  className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
                />
                <span>
                  <span className="block text-[0.88rem] text-ink">{k.label}</span>
                  <span className="block text-[0.76rem] text-faint">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <label htmlFor={ids.address} className="block text-[0.8rem] text-muted">
            {field.label}
          </label>
          <input
            id={ids.address}
            value={address}
            required={kind !== "other"}
            maxLength={300}
            autoCapitalize="off"
            spellCheck={false}
            placeholder={field.placeholder}
            onChange={(e) => setAddress(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-[0.74rem] text-faint">{field.hint}</p>
        </div>

        <div className="mt-4">
          <label htmlFor={ids.category} className="block text-[0.8rem] text-muted">
            Category
          </label>
          <select
            id={ids.category}
            value={category}
            onChange={(e) => setCategory(e.target.value as ServiceCategory)}
            className={inputClass}
          >
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {ws.hosts.length > 1 && (
          <div className="mt-4">
            <label htmlFor={ids.host} className="block text-[0.8rem] text-muted">
              Which machine is it on?
            </label>
            <select
              id={ids.host}
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              className={inputClass}
            >
              {ws.hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {add.error && (
          <p role="alert" className="mt-4 text-[0.85rem] text-bad">
            {add.error.message}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" tone="primary" disabled={add.isPending}>
            {add.isPending ? "Adding" : "Add system"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Settings > Removed systems: everything you took out of Hearth, ready to bring back. */
export function RemovedSystems({ ws }: { ws: Workspace }) {
  const restore = useRestoreSystem();
  const hostNames = new Map(ws.hosts.map((h) => [h.id, h.name]));
  if (ws.removedServices.length === 0) {
    return (
      <p className="max-w-lg text-[0.88rem] leading-relaxed text-muted">
        Nothing removed. Systems you remove from Hearth show up here, so you can bring them back.
      </p>
    );
  }
  return (
    <>
      <p className="mb-3 max-w-lg text-[0.88rem] leading-relaxed text-muted">
        Hearth does not watch these or show them anywhere else, and a scan does not add them back.
        Bringing one back watches it again.
      </p>
      <Rows>
        {ws.removedServices.map((s) => (
          <RemovedRow
            key={s.id}
            service={s}
            hostName={hostNames.get(s.hostId)}
            busy={restore.isPending && restore.variables === s.id}
            onRestore={() => restore.mutate(s.id)}
          />
        ))}
      </Rows>
      {restore.error && (
        <p role="alert" className="mt-3 text-[0.85rem] text-bad">
          {restore.error.message}
        </p>
      )}
    </>
  );
}

function RemovedRow({
  service,
  hostName,
  busy,
  onRestore,
}: {
  service: RemovedService;
  hostName?: string;
  busy: boolean;
  onRestore: () => void;
}) {
  const where = [service.address, hostName].filter(Boolean).join(" · ");
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4"
      data-testid="removed-system"
      aria-label={service.name}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.95rem] text-ink">{service.name}</p>
        <p className="truncate text-[0.8rem] text-faint">
          {service.removedAt ? `Removed ${ago(service.removedAt).toLowerCase()}` : "Removed"}
          {where ? ` · ${where}` : ""}
        </p>
      </div>
      <Button disabled={busy} onClick={onRestore}>
        {busy ? "Bringing back" : `Bring back ${service.name}`}
      </Button>
    </li>
  );
}
