import { useState } from "react";
import { GAP_LABEL, type Capability, type HostOperation } from "@dragon-control/core";
import { Button, Segmented, Tag } from "../components/ui";
import {
  useAdminScopes,
  useCapabilities,
  useDetectCapabilities,
  useDismissCapability,
  useElevation,
  useSetHostScope,
} from "../data/admin";
import { FormError } from "./auth/AuthFrame";
import { ConfirmIdentity } from "./auth/ConfirmIdentity";
import { ApiError } from "../data/api";

/**
 * Settings > Ember > Administration (feature request 21): whether the Ember may administer
 * the machine Hearth runs on, and the tools it has or found missing. Only you change this;
 * the Ember can read it, never switch it on.
 */

type Level = "off" | "investigate" | "propose";

const LEVELS: { value: Level; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The Ember cannot look at this machine's files or system." },
  {
    value: "investigate",
    label: "Investigate",
    hint: "Read only, automatic: files and folders, disk use, services, logs, timers, containers, Compose, network state. Secrets masked; secret files never shown.",
  },
  {
    value: "propose",
    label: "Investigate and propose changes",
    hint: "Also plans changes: configuration edits and restores, Compose image updates, new apps, removing containers, protected systems. Every change still waits for your approval.",
  },
];

const TIERS: [string, string][] = [
  ["Investigate", "Automatic and read only, inside this machine."],
  ["Routine", "Automatic only under a policy you define. None is enabled."],
  ["Consequential", "A plan you approve: exact targets, backup, verification, undo."],
  [
    "Protected",
    "Caddy, VPN and Gluetun, Tailscale, firewall, SSH, /etc, Docker and Compose networking, Hearth itself: readable for diagnosis; a change is a plan you approve and confirm it's you. Changes Hearth's own account cannot make are carried out by the elevated executor.",
  ],
  [
    "Out of scope",
    "Anything outside what you authorized: Ember says exactly what widening it would take, and you decide.",
  ],
  [
    "Never",
    "A shell or raw root access, secret content, editing these rules or the executor's scope, deleting backups, permanent deletion without its own approval, creating credentials.",
  ],
];

export function HostAdministration() {
  const q = useAdminScopes();
  const set = useSetHostScope();
  // Switching on needs a fresh "it's you" (the server asks); the choice waits here meanwhile.
  const [pending, setPending] = useState<Level>();
  const data = q.data;
  if (q.isLoading) return <p className="text-[0.85rem] text-faint">Loading…</p>;
  if (!data?.host)
    return (
      <p className="max-w-2xl text-[0.88rem] text-muted" data-testid="host-admin">
        Hearth does not know the machine it runs on yet, so there is nothing to administer.
      </p>
    );
  const host = data.host;
  const scope = data.scopes.find((s) => s.hostId === host.id);
  const level: Level = !scope
    ? "off"
    : scope.operations.includes("propose")
      ? "propose"
      : "investigate";
  const choose = (v: Level) => {
    if (v === level) return;
    const operations: HostOperation[] | null =
      v === "off" ? null : v === "investigate" ? ["investigate"] : ["investigate", "propose"];
    set.mutate(
      { hostId: host.id, operations, current: scope?.id },
      {
        onSuccess: () => setPending(undefined),
        onError: (e) => setPending(e instanceof ApiError && e.status === 403 ? v : undefined),
      },
    );
  };
  return (
    <div className="mb-10" data-testid="host-admin">
      <p className="mb-4 max-w-2xl text-[0.88rem] leading-relaxed text-muted">
        Let Ember administer <span className="text-ink">{host.name}</span>, the machine Hearth runs
        on. It uses Hearth&apos;s own account (no root, no shell) and only fixed, read-only
        diagnostics; changes are always plans you approve. You can switch it off at any time.
      </p>
      <Segmented<Level>
        label={`Administer ${host.name}`}
        value={level}
        onChange={choose}
        options={LEVELS}
      />
      <p className="mt-2 max-w-2xl text-[0.78rem] text-faint" data-testid="host-admin-hint">
        {LEVELS.find((l) => l.value === level)?.hint}
      </p>
      {pending ? (
        <div className="mt-3 max-w-2xl" data-testid="host-admin-confirm">
          <ConfirmIdentity
            reason={set.error?.message ?? "Confirm it's you."}
            onConfirmed={() => choose(pending)}
          />
        </div>
      ) : (
        <FormError error={set.error} />
      )}
      <dl className="mt-6 grid max-w-3xl gap-x-6 gap-y-2 text-[0.84rem] sm:grid-cols-[9rem_1fr]">
        {TIERS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink">{k}</dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
        <dt className="text-ink">Backups</dt>
        <dd className="break-all text-muted">{data.backupRoot}</dd>
        <dt className="text-ink">Host documents</dt>
        <dd className="break-all text-muted">{data.docsRoot ?? "None found"}</dd>
      </dl>
      <ElevatedExecutor />
    </div>
  );
}

/** The root-owned executor: whether it is set up, and exactly what it may do. Read only here. */
function ElevatedExecutor() {
  const q = useElevation();
  const e = q.data;
  if (!e) return null;
  const s = e.status;
  return (
    <section className="mt-8 max-w-3xl" data-testid="elevated-executor">
      <h3 className="mb-2 flex items-center gap-2 text-[0.8rem] tracking-wide text-faint uppercase">
        Elevated executor
        <Tag tone={e.available ? "gold" : "neutral"}>{e.available ? "Ready" : "Not set up"}</Tag>
      </h3>
      <p className="text-[0.86rem] leading-relaxed text-muted">{e.summary}</p>
      {s && (
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[0.82rem] sm:grid-cols-[9rem_1fr]">
          <dt className="text-ink">Folders</dt>
          <dd className="break-all text-muted">{s.roots.join(", ") || "None"}</dd>
          <dt className="text-ink">Operations</dt>
          <dd className="text-muted">{s.operations.join(", ")}</dd>
          <dt className="text-ink">Units</dt>
          <dd className="text-muted">{s.units.join(", ") || "None"}</dd>
          <dt className="text-ink">Its own log</dt>
          <dd className="break-all text-muted">{s.auditLog}</dd>
        </dl>
      )}
      <p className="mt-2 text-[0.76rem] text-faint">
        Only you change its scope, on the machine itself (deploy/linux/install-elevation.sh). It
        acts only on steps of plans you approved, once each.
      </p>
    </section>
  );
}

const STATUS_TONE: Record<Capability["status"], "neutral" | "gold" | "warn"> = {
  available: "gold",
  installed: "gold",
  missing: "warn",
  requested: "warn",
  disabled: "neutral",
  removed: "neutral",
};

export function ToolsCapabilities() {
  const q = useCapabilities();
  const detect = useDetectCapabilities();
  const dismiss = useDismissCapability();
  const all = (q.data ?? []).filter((c) => c.status !== "removed");
  const gaps = all.filter((c) => c.gap && c.status !== "available" && c.status !== "installed");
  const rest = all.filter((c) => !gaps.includes(c));
  return (
    <div className="mb-10" data-testid="capabilities">
      <p className="mb-4 max-w-2xl text-[0.88rem] leading-relaxed text-muted">
        What the Ember has to work with on this machine, and what it found missing while working
        (with the task it was doing, so it can pick that up again). Installing anything is a
        separate, approved operation that is not built yet.
      </p>
      <Button onClick={() => detect.mutate()} disabled={detect.isPending}>
        {detect.isPending ? "Looking…" : "Look for tools on this machine"}
      </Button>
      <FormError error={detect.error} />
      {gaps.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-[0.8rem] tracking-wide text-faint uppercase">
            Missing while working
          </h3>
          <ul className="divide-y divide-line border-y border-line" data-testid="capability-gaps">
            {gaps.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-3 py-3">
                <Tag tone="warn">{c.gap ? GAP_LABEL[c.gap] : "Missing"}</Tag>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.95rem] text-ink">{c.name}</span>
                  {c.task && (
                    <span className="block text-[0.8rem] text-muted">While: {c.task}</span>
                  )}
                  {c.purpose && (
                    <span className="block text-[0.8rem] text-faint">For: {c.purpose}</span>
                  )}
                </span>
                <Button tone="quiet" onClick={() => dismiss.mutate(c.id)}>
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {rest.length > 0 && (
        <ul
          className="mt-6 divide-y divide-line border-y border-line"
          data-testid="capability-list"
        >
          {rest.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-3 py-2.5">
              <Tag tone={STATUS_TONE[c.status]}>
                {c.status === "available"
                  ? "Available"
                  : c.status === "missing"
                    ? "Not installed"
                    : c.status}
              </Tag>
              <span className="min-w-0 flex-1">
                <span className="text-[0.92rem] text-ink">{c.name}</span>
                {c.purpose && <span className="text-[0.8rem] text-faint"> · {c.purpose}</span>}
                {c.location && (
                  <span className="block break-all text-[0.74rem] text-faint">{c.location}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
