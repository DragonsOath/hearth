import { useState } from "react";
import { ExternalLink, MessageCircle, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import type {
  PortainerContainer,
  PortainerDashboard as Data,
  PortainerStack,
} from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { PasteKey } from "./PasteKey";
import { EmberMark } from "../ember/EmberMark";

/**
 * Portainer from Hearth. The Overview answers "is everything running?": each environment with its
 * containers running, stopped and unhealthy, and the unhealthy ones by name with a restart in one
 * step. Stacks and containers lists every stack with its containers, and starts, stops or updates
 * a stack, or starts, stops or restarts a container, each a plan you approve (protected when it
 * runs networking). Deleting, editing Compose files or variables, registries and users stay in
 * Portainer.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-portainer-control" as const;
/** Hearth itself: it is restarted, never stopped, from here. */
const SELF = /^(hearth|dragon-?control)([-_]|$)/i;

function usePortainer(serviceId: string) {
  const q = useDashboard(serviceId, true, 20_000);
  const d: Data | undefined = q.data?.data?.app === "portainer" ? q.data.data : undefined;
  return { q, d };
}

function Gate({
  serviceId,
  name,
  q,
}: {
  serviceId: string;
  name: string;
  q: ReturnType<typeof usePortainer>["q"];
}) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="your user menu (top right), then My account, then Access tokens, then Add access token (an administrator's), and copy it (Portainer shows it once)"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="pt-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  return null;
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const web = keyPageHref(service, "/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Portainer ${d.version} · ` : ""}live, every 20 s ·{" "}
      {d.updatesKnown
        ? "Image updates from Portainer."
        : "Image updates: Hearth's Updates page checks your containers' images (Portainer's own check is in its Business edition)."}{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="pt-open-webui"
        >
          Open Portainer <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

const stateColor = (x: PortainerContainer) =>
  x.health === "unhealthy" ? "text-amber" : x.state === "running" ? "text-ok" : "text-faint";

function ContainerRow({ x, name, act }: { x: PortainerContainer; name: string; act: ApproveHere }) {
  const go = (op: string, verb: string) =>
    void act.propose(
      KIND,
      { op, environmentId: x.environmentId, container: x.name },
      `${verb} ${x.name} through ${name}`,
    );
  return (
    <li
      className="flex flex-wrap items-center gap-2 py-1.5"
      data-testid="pt-container"
      data-state={x.state}
      data-capture-item
      data-capture-label={x.name}
    >
      <span className="min-w-0 flex-1 text-[0.84rem]">
        <span className="break-all text-ink">{x.name}</span>
        <span className="block text-[0.74rem] text-faint">
          <span className={stateColor(x)}>{x.status}</span> · {x.image}
          {x.update === "outdated" && (
            <span className="text-amber"> · a newer image is waiting</span>
          )}
        </span>
      </span>
      {x.state === "running" ? (
        <>
          <button
            type="button"
            className={btn}
            onClick={() => go("container-restart", "Restart")}
            data-hearth-target={`container:${x.name}:restart`}
          >
            <RotateCw className="h-3.5 w-3.5" /> Restart
          </button>
          {!SELF.test(x.name) && (
            <button
              type="button"
              className={btn}
              onClick={() => go("container-stop", "Stop")}
              data-hearth-target={`container:${x.name}:stop`}
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className={btn}
          onClick={() => go("container-start", "Start")}
          data-hearth-target={`container:${x.name}:start`}
        >
          <Play className="h-3.5 w-3.5" /> Start
        </button>
      )}
    </li>
  );
}

export function PortainerDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = usePortainer(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Portainer's panel.");
  const cave = useCave();
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const sick = d.containers.filter((x) => x.health === "unhealthy");
  const waiting = d.containers.filter((x) => x.update === "outdated");
  return (
    <section
      className="@container space-y-4"
      data-testid="pt-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid gap-3 @2xl:grid-cols-2">
        {d.environments.map((e) => (
          <button
            key={e.id}
            type="button"
            className={cx(
              "rounded-xl border p-3 text-left hover:border-gold/50",
              e.online ? "border-line" : "border-amber/50",
            )}
            onClick={() => onGo?.("stacks", String(e.id))}
            data-testid="pt-environment"
            data-hearth-target="tab:stacks:open"
          >
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="flex-1 text-[0.95rem] text-ink">{e.name}</span>
              <span className={cx("text-[0.76rem]", e.online ? "text-ok" : "text-amber")}>
                {e.online ? e.kind : `${e.kind}, not reachable`}
              </span>
            </p>
            <p className="mt-1 text-[0.82rem] text-muted tabular">
              {e.running} running · {e.stopped} stopped
              {e.unhealthy ? (
                <span className="text-amber"> · {e.unhealthy} unhealthy</span>
              ) : null}{" "}
              · {e.stacks} stacks
            </p>
            {(e.images !== undefined || e.cpus) && (
              <p className="text-[0.74rem] text-faint">
                {e.images !== undefined ? `${e.images} images` : ""}
                {e.cpus ? ` · ${e.cpus} CPUs` : ""}
                {e.memoryBytes ? ` · ${Math.round(e.memoryBytes / 1024 ** 3)} GiB memory` : ""}
              </p>
            )}
          </button>
        ))}
      </div>
      {sick.length > 0 && (
        <div className="rounded-xl border border-amber/40 p-3" data-testid="pt-unhealthy">
          <p className={eyebrow}>Unhealthy</p>
          <ul className="divide-y divide-line">
            {sick.map((x) => (
              <ContainerRow key={`${x.environmentId}:${x.id}`} x={x} name={name} act={act} />
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `In ${name}, these containers are unhealthy: ${sick.map((x) => `${x.name} (${x.image}, ${x.status})`).join("; ")}. Why, and what should I do?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
            <EmberMark />
          </button>
        </div>
      )}
      {waiting.length > 0 && (
        <p className="text-[0.82rem] text-amber" data-testid="pt-updates">
          A newer image is waiting for {waiting.map((x) => x.name).join(", ")}: update their stacks
          in Stacks and containers.
        </p>
      )}
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

function StackBlock({
  s,
  d,
  name,
  act,
}: {
  s: PortainerStack;
  d: Data;
  name: string;
  act: ApproveHere;
}) {
  const parts = d.containers.filter(
    (x) => x.environmentId === s.environmentId && x.stack === s.name,
  );
  const go = (op: string, verb: string) =>
    void act.propose(
      KIND,
      { op, environmentId: s.environmentId, stackId: s.id },
      `${verb} the stack ${s.name} in ${name}`,
    );
  return (
    <li
      className="py-2"
      data-testid="pt-stack"
      data-running={s.running ? "yes" : "no"}
      data-capture-item
      data-capture-label={s.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[0.9rem] text-ink">{s.name}</p>
          <p className="text-[0.74rem] text-faint">
            <span
              className={s.running && s.containersRunning < s.containers ? "text-amber" : undefined}
            >
              {s.running ? `${s.containersRunning} of ${s.containers} running` : "stopped"}
            </span>
            {s.fromGit ? " · from Git" : " · from a file"}
            {s.updatedAt
              ? ` · updated ${ago(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ""}`
              : ""}
          </p>
        </div>
        {s.running ? (
          <>
            <button
              type="button"
              className={btn}
              onClick={() => go("stack-update", "Update")}
              data-hearth-target={`stack:${s.id}:update`}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Update
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => go("stack-stop", "Stop")}
              data-hearth-target={`stack:${s.id}:stop`}
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            className={btn}
            onClick={() => go("stack-start", "Start")}
            data-hearth-target={`stack:${s.id}:start`}
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
        )}
      </div>
      {parts.length > 0 && (
        <ul className="mt-1 divide-y divide-line border-l border-line pl-3">
          {parts.map((x) => (
            <ContainerRow key={x.id} x={x} name={name} act={act} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PortainerStacks({ serviceId, name, sub }: AppViewProps) {
  const { q, d } = usePortainer(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Portainer's Stacks and containers tab.");
  const [env, setEnv] = useState(sub && /^\d+$/.test(sub) ? Number(sub) : 0);
  const [find, setFind] = useState("");
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const inEnv = <T extends { environmentId: number }>(x: T) => !env || x.environmentId === env;
  const stacks = d.stacks
    .filter(inEnv)
    .filter(
      (s) =>
        !needle ||
        s.name.toLowerCase().includes(needle) ||
        d.containers.some((x) => x.stack === s.name && x.name.includes(needle)),
    );
  const loose = d.containers
    .filter(inEnv)
    .filter(
      (x) =>
        !x.stack ||
        !d.stacks.some((s) => s.name === x.stack && s.environmentId === x.environmentId),
    )
    .filter(
      (x) =>
        !needle || x.name.toLowerCase().includes(needle) || x.image.toLowerCase().includes(needle),
    );
  return (
    <section
      className="@container space-y-3"
      data-testid="pt-stacks"
      aria-label={`${name}: stacks and containers`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {d.environments.length > 1 && (
          <select
            value={env}
            onChange={(e) => setEnv(Number(e.target.value))}
            aria-label="Environment"
            className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            data-hearth-target="stacks:environment"
          >
            <option value={0}>Every environment</option>
            {d.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a stack or container"
          aria-label="Find a stack or container"
          className="min-h-9 min-w-[12rem] flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          data-hearth-target="stacks:find"
        />
      </div>
      <p className={eyebrow}>Stacks</p>
      <ul className="divide-y divide-line">
        {stacks.map((s) => (
          <StackBlock key={s.id} s={s} d={d} name={name} act={act} />
        ))}
      </ul>
      {!stacks.length && <p className="text-[0.82rem] text-faint">No stacks match.</p>}
      {loose.length > 0 && (
        <>
          <p className={eyebrow}>Other containers</p>
          <ul className="divide-y divide-line">
            {loose.map((x) => (
              <ContainerRow key={`${x.environmentId}:${x.id}`} x={x} name={name} act={act} />
            ))}
          </ul>
        </>
      )}
      <p className="text-[0.74rem] text-faint">
        Update pulls a stack&apos;s images and deploys it again with its own file and variables. A
        stack or container that runs networking asks you to confirm it is you; Hearth never stops
        itself.
      </p>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
