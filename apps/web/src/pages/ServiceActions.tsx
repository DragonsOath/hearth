import { useState } from "react";
import { MessageCircle } from "lucide-react";
import type { ActionRecord, Service, Workspace } from "@dragon-control/core";
import { Button, Section, Sheet, Tag } from "../components/ui";
import { useAction, useAiName, useLogs, useRunChecks } from "../data/api";
import { useCave } from "../components/shell/cave-context";
import { ago } from "../lib/format";
import { EmberMark } from "../components/ember/EmberMark";

/**
 * What you can do to a service yourself. Checks, tests, and logs only look;
 * a restart, start, or stop changes something, so it asks you to confirm, is
 * recorded, and is verified afterwards.
 */

function canRestart(service: Service, ws: Workspace): boolean {
  if (service.kind !== "container") return false;
  if (ws.environment === "demo") return true;
  return ws.hosts.find((h) => h.id === service.hostId)?.connection === "this-machine";
}

/**
 * Down or degraded without anyone meaning it to be: the AI can look into it. Paused, retired,
 * or stopped on purpose is not a problem, so it gets no button.
 */
export function troubleOf(service: Service): "down" | "degraded" | undefined {
  if (service.lifecycle || service.stopped) return undefined;
  if (service.lastCheck?.detail?.includes("stopped on purpose")) return undefined;
  if (service.health === "offline") return "down";
  if (service.health === "attention") return "degraded";
  return undefined;
}

function RestartSheet({
  service,
  ws,
  onClose,
}: {
  service: Service;
  ws: Workspace;
  onClose: () => void;
}) {
  const action = useAction();
  const open = ws.incidents.find((i) => i.serviceId === service.id && i.status !== "resolved");
  return (
    <Sheet
      label={`Restart ${service.name}`}
      eyebrow="Restart"
      title={`Restart ${service.name}?`}
      onClose={onClose}
    >
      <p className="text-[0.9rem] leading-relaxed text-muted">
        {service.name} will be unavailable for a few seconds while it starts again. Hearth then runs
        its own health check to confirm it is back.
      </p>
      {ws.environment === "real" && (
        <p className="mt-3 text-[0.9rem] leading-relaxed text-ink">
          This is one of your own systems, not sample data.
        </p>
      )}
      {open && (
        <p className="mt-3 text-[0.9rem] leading-relaxed text-muted">
          If it works, this also resolves the open incident: {open.title}.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          tone="primary"
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { kind: "restart-container", serviceId: service.id },
              { onSuccess: onClose },
            )
          }
        >
          {action.isPending ? "Starting the restart" : `Restart ${service.name}`}
        </Button>
        <Button tone="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {action.error && (
        <p role="alert" className="mt-4 text-[0.85rem] text-bad">
          {action.error.message}
        </p>
      )}
    </Sheet>
  );
}

/** Start or stop: what it does, what else it affects, then one confirmed request. */
function PowerSheet({
  service,
  ws,
  kind,
  onClose,
}: {
  service: Service;
  ws: Workspace;
  kind: "start-container" | "stop-container";
  onClose: () => void;
}) {
  const action = useAction();
  const starting = kind === "start-container";
  const verb = starting ? "Start" : "Stop";
  const byId = new Map([...ws.services, ...ws.inactiveServices].map((s) => [s.id, s]));
  // Stopping: what relies on it. Starting: what it relies on that is not running.
  const affected = starting
    ? service.dependsOn
        .map((id) => byId.get(id))
        .filter((s): s is Service => !!s && (!!s.stopped || s.health === "offline"))
    : ws.services.filter((s) => s.dependsOn.includes(service.id) && !s.stopped);
  return (
    <Sheet
      label={`${verb} ${service.name}`}
      eyebrow={verb}
      title={`${verb} ${service.name}?`}
      onClose={onClose}
    >
      <p className="text-[0.9rem] leading-relaxed text-muted">
        {starting
          ? `Hearth starts the ${service.name} container, then runs its own health check to confirm it works. From then on it is watched normally again.`
          : `Hearth stops the ${service.name} container and confirms Docker reports it stopped. It stays off: it is not checked, and nothing restarts it automatically, until it is started again.`}
      </p>
      {ws.environment === "real" && (
        <p className="mt-3 text-[0.9rem] leading-relaxed text-ink">
          This is one of your own systems, not sample data.
        </p>
      )}
      {affected.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-amber/40 bg-amber/5 p-4"
          data-testid="power-affected"
        >
          <p className="text-[0.88rem] leading-relaxed text-ink">
            {starting
              ? `${service.name} depends on ${affected.map((s) => s.name).join(", ")}, which ${affected.length === 1 ? "is" : "are"} not running. Start ${affected.length === 1 ? "it" : "them"} first, or this will not work.`
              : `${affected.map((s) => s.name).join(", ")} ${affected.length === 1 ? "depends" : "depend"} on ${service.name} and will stop working while it is off.`}
          </p>
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          tone="primary"
          disabled={action.isPending}
          onClick={() => action.mutate({ kind, serviceId: service.id }, { onSuccess: onClose })}
        >
          {action.isPending ? `Asking Docker` : `${verb} ${service.name}`}
        </Button>
        <Button tone="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {action.error && (
        <p role="alert" className="mt-4 text-[0.85rem] text-bad">
          {action.error.message}
        </p>
      )}
    </Sheet>
  );
}

function LogsSheet({ service, onClose }: { service: Service; onClose: () => void }) {
  const logs = useLogs(service.id);
  const lines = logs.data;
  return (
    <Sheet
      label={`Recent logs for ${service.name}`}
      eyebrow="Recent logs"
      title={service.name}
      onClose={onClose}
      wide
    >
      <p className="mb-4 text-[0.8rem] leading-relaxed text-faint">
        The last lines {service.name} wrote, newest at the bottom. Anything that looks like a
        password, key, or token is hidden. Nothing is stored.
      </p>
      {logs.isFetching && (
        <p className="py-2 text-[0.88rem] text-muted" aria-busy="true">
          Reading logs.
        </p>
      )}
      {logs.error && (
        <p role="alert" className="py-6 text-[0.88rem] text-bad">
          {logs.error.message}
        </p>
      )}
      {lines && lines.length === 0 && (
        <p className="py-6 text-[0.88rem] text-muted">
          {service.name} has not written anything yet.
        </p>
      )}
      {lines && lines.length > 0 && (
        <pre
          data-testid="log-lines"
          tabIndex={0}
          aria-label="Log lines"
          className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg p-4 font-mono text-[0.72rem] leading-relaxed break-all whitespace-pre-wrap text-muted"
        >
          {lines.join("\n")}
        </pre>
      )}
      <div className="mt-4">
        <Button tone="quiet" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
          Read again
        </Button>
      </div>
    </Sheet>
  );
}

export function ServiceActions({
  service,
  ws,
  inline,
}: {
  service: Service;
  ws: Workspace;
  /** A row of buttons (the workspace) instead of a column (the side panel). */
  inline?: boolean;
}) {
  const run = useRunChecks();
  const test = useAction();
  const [sheet, setSheet] = useState<
    "restart" | "logs" | "start-container" | "stop-container" | null
  >(null);
  const busy = (kind: ActionRecord["kind"]) =>
    ws.actions.some((a) => a.serviceId === service.id && a.kind === kind && a.status === "running");
  const restarting = busy("restart-container");
  const powering = busy("start-container") || busy("stop-container");
  const controllable = canRestart(service, ws);
  const error = run.error ?? test.error;
  const cave = useCave();
  const aiName = useAiName();
  const trouble = troubleOf(service);

  return (
    <>
      <div className={inline ? "flex flex-wrap gap-2" : "mt-5 flex flex-col gap-2"}>
        {trouble && (
          <button
            type="button"
            data-testid="service-ask-trouble"
            onClick={() =>
              cave.ask(
                trouble === "down"
                  ? `${service.name} is down. Find out why (its check, logs, restarts, and what it depends on), tell me what you found, and fix it if you can.`
                  : `${service.name} is having trouble. Find out what is wrong (its check, logs, restarts, and what it depends on), tell me what you found, and fix it if you can.`,
              )
            }
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gold/60 bg-gold/10 px-3 text-[0.84rem] text-gold hover:bg-gold/20"
          >
            <MessageCircle strokeWidth={1.5} className="h-4 w-4" /> Ask {aiName} why it is {trouble}
            <EmberMark />
          </button>
        )}
        <Button onClick={() => run.mutate(service.id)} disabled={run.isPending}>
          {run.isPending ? "Checking" : "Run health check"}
        </Button>
        {service.localUrl && (
          <Button
            onClick={() => test.mutate({ kind: "test-endpoint", serviceId: service.id })}
            disabled={test.isPending}
          >
            {test.isPending ? "Testing" : "Test web address"}
          </Button>
        )}
        {controllable && !service.stopped && (
          <Button onClick={() => setSheet("restart")} disabled={restarting || powering}>
            {restarting ? "Restarting and checking" : "Restart"}
          </Button>
        )}
        {controllable && service.stopped && !service.lifecycle && (
          <Button onClick={() => setSheet("start-container")} disabled={powering}>
            {powering ? "Starting and checking" : "Start"}
          </Button>
        )}
        {controllable && !service.stopped && !service.lifecycle && !service.coreNetworking && (
          <Button onClick={() => setSheet("stop-container")} disabled={restarting || powering}>
            {powering ? "Stopping" : "Stop"}
          </Button>
        )}
        {service.kind === "container" && (
          <Button onClick={() => setSheet("logs")}>View recent logs</Button>
        )}
      </div>
      <div aria-live="polite">
        {test.data && (
          <p className="mt-3 text-[0.8rem] leading-relaxed text-muted" data-testid="test-result">
            {test.data.action.result}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[0.8rem] text-bad">
          {error.message}
        </p>
      )}
      <p className="mt-4 text-[0.78rem] leading-relaxed text-faint">
        Checks, tests, and logs only look. A restart, start, or stop is recorded and verified
        afterwards. Automatic repairs follow your autonomy settings; start and stop are never
        automatic.
        {controllable &&
          service.coreNetworking &&
          " Hearth never stops this one: other services rely on it."}
      </p>
      {sheet === "restart" && (
        <RestartSheet service={service} ws={ws} onClose={() => setSheet(null)} />
      )}
      {(sheet === "start-container" || sheet === "stop-container") && (
        <PowerSheet service={service} ws={ws} kind={sheet} onClose={() => setSheet(null)} />
      )}
      {sheet === "logs" && <LogsSheet service={service} onClose={() => setSheet(null)} />}
    </>
  );
}

const statusTag: Record<
  ActionRecord["status"],
  { label: string; tone: "neutral" | "gold" | "warn" }
> = {
  requested: { label: "Awaiting approval", tone: "gold" },
  refused: { label: "Not carried out", tone: "neutral" },
  running: { label: "Running", tone: "gold" },
  succeeded: { label: "Done", tone: "neutral" },
  failed: { label: "Did not work", tone: "warn" },
};

const byLabel: Record<ActionRecord["requestedBy"], string> = {
  you: "You",
  "dragon-control": "Hearth",
  agent: "AI agent",
};

export function RecentActions({ service, ws }: { service: Service; ws: Workspace }) {
  // Reading logs is not worth a line in the history.
  const actions = ws.actions
    .filter((a) => a.serviceId === service.id && a.kind !== "inspect-logs")
    .slice(0, 6);
  if (actions.length === 0) return null;
  return (
    <Section title="Recent actions">
      <ul className="divide-y divide-line" data-testid="recent-actions">
        {actions.map((a) => (
          <li key={a.id} className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[0.9rem] text-ink">{a.label}</p>
              <Tag tone={statusTag[a.status].tone}>{statusTag[a.status].label}</Tag>
            </div>
            {a.result && (
              <p className="mt-1 text-[0.82rem] leading-relaxed text-muted">{a.result}</p>
            )}
            <p className="mt-1 text-[0.75rem] text-faint">
              {byLabel[a.requestedBy]} · {ago(a.requestedAt)}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
