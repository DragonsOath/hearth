import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, MessageCircle, ShieldAlert } from "lucide-react";
import type { Blocker } from "@dragon-control/core";
import { ApiError } from "../../data/api";
import { useAdminScopes, useSetHostScope } from "../../data/admin";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { PasteKey } from "../dashboards/PasteKey";
import { useCave } from "../shell/cave-context";
import { Button, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * A known, actionable blocker, resolved where it happened (docs/design/BLOCKERS.md): host
 * administration switched on right here (said plainly to be host-wide, behind a fresh "it's you"
 * and an explicit confirmation), a key pasted right here, or for what Hearth must not change by
 * itself (file permissions, its elevated executor) the exact gap and Ember for the next step.
 * Nothing here goes around an approval; once resolved, the panel reads again by itself.
 */
export function BlockerCard({
  blocker,
  serviceName,
  onResolved,
  className,
}: {
  blocker: Blocker;
  /** The app the panel is about, for wording ("not only Caddy"). */
  serviceName?: string;
  onResolved?: () => void;
  className?: string;
}) {
  if (blocker.kind === "host-admin")
    return (
      <HostAdmin
        blocker={blocker}
        serviceName={serviceName}
        onResolved={onResolved}
        className={className}
      />
    );
  if (blocker.kind === "app-key" && blocker.serviceId)
    return (
      <div className={className}>
        <PasteKey
          serviceId={blocker.serviceId}
          name={serviceName ?? "this app"}
          where={blocker.where ?? "its settings"}
          message={blocker.title}
        />
      </div>
    );
  return <Explained blocker={blocker} serviceName={serviceName} className={className} />;
}

function HostAdmin({
  blocker,
  serviceName,
  onResolved,
  className,
}: {
  blocker: Blocker;
  serviceName?: string;
  onResolved?: () => void;
  className?: string;
}) {
  const scopes = useAdminScopes();
  const set = useSetHostScope();
  const qc = useQueryClient();
  const [understood, setUnderstood] = useState(false);
  const [needsIdentity, setNeedsIdentity] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const host = blocker.host;
  if (!host) return <Explained blocker={blocker} serviceName={serviceName} className={className} />;
  const ops = blocker.operations ?? ["investigate"];
  const propose = ops.includes("propose");
  const current = scopes.data?.scopes.find((s) => s.hostId === host.id);
  const allow = () => {
    setError(undefined);
    set.mutate(
      { hostId: host.id, operations: ops, ...(current ? { current: current.id } : {}) },
      {
        onSuccess: () => {
          setNeedsIdentity(undefined);
          setDone(true);
          // Every panel reads again with the new permission; nothing to refresh by hand.
          void qc.invalidateQueries({ queryKey: ["dashboard"] });
          onResolved?.();
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 403) setNeedsIdentity(e.message);
          else setError(e instanceof Error ? e.message : String(e));
        },
      },
    );
  };
  return (
    <div
      className={cx("space-y-3 rounded-xl border border-amber/40 p-4 text-[0.86rem]", className)}
      data-testid="blocker-host-admin"
    >
      <p className="flex items-start gap-2 text-amber">
        <ShieldAlert strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {blocker.title}
      </p>
      <p className="text-muted">{blocker.detail}</p>
      {done ? (
        <p className="text-live" data-testid="blocker-resolved">
          Allowed on {host.name}. Reading again…
        </p>
      ) : needsIdentity ? (
        <ConfirmIdentity reason={needsIdentity} onConfirmed={allow} />
      ) : (
        <>
          <label className="flex items-start gap-2 text-ink">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-1 h-4 w-4 accent-gold"
              data-testid="blocker-understood"
            />
            <span>
              I understand this applies to all of {host.name}
              {serviceName ? `, not only ${serviceName}` : ""}, and that I can switch it off any
              time.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              disabled={!understood || set.isPending || scopes.isLoading}
              onClick={allow}
              data-testid="blocker-allow"
            >
              {set.isPending
                ? "Allowing…"
                : propose
                  ? `Allow Ember to look and propose changes on ${host.name}`
                  : `Allow Ember to look at ${host.name}`}
            </Button>
          </div>
          <p className="text-[0.76rem] text-faint">
            You will be asked to confirm it is you. Every change still waits for your approval.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const NEXT_STEP: Record<string, string> = {
  "file-access":
    "plan the narrowest permission that would let Hearth's account do this (one file, read or write as needed), or using the elevated executor, and explain the choice. Change nothing until I approve it.",
  capability:
    "tell me what is missing and the narrowest way to set it up. Change nothing until I approve it.",
  "missing-config": "find out where its configuration actually is and tell me. Change nothing.",
  "service-down":
    "find out why it is not running and what you would do about it. Ask before acting.",
};

function Explained({
  blocker,
  serviceName,
  className,
}: {
  blocker: Blocker;
  serviceName?: string;
  className?: string;
}) {
  const cave = useCave();
  return (
    <div
      className={cx("space-y-2 rounded-xl border border-amber/40 p-4 text-[0.86rem]", className)}
      data-testid={`blocker-${blocker.kind}`}
    >
      <p className="flex items-start gap-2 text-amber">
        <KeyRound strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {blocker.title}
      </p>
      <p className="text-muted">{blocker.detail}</p>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
        onClick={() =>
          cave.ask(
            `${serviceName ? `${serviceName}: ` : ""}${blocker.title}${blocker.path ? ` (file ${blocker.path}, account ${blocker.account ?? "Hearth's"})` : ""} Please ${NEXT_STEP[blocker.kind] ?? "tell me the next step. Change nothing until I approve it."}`,
          )
        }
        data-testid="blocker-ask"
      >
        <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember for the next step
        <EmberMark />
      </button>
    </div>
  );
}
