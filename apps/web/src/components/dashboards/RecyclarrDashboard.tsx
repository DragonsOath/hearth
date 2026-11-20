import { useState } from "react";
import type { Blocker } from "@dragon-control/core";
import { BlockerCard } from "../blockers/BlockerCard";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, RefreshCw, Search } from "lucide-react";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Recyclarr from Hearth: when it last synced and what it set in Radarr and Sonarr (from its own
 * log), what a sync now would change (Recyclarr's own preview, which changes nothing), and
 * running a sync, as a plan confirmed here.
 */

interface Setting {
  instance: string;
  setting: string;
  from: string;
  to: string;
}
interface Panel {
  container: string;
  lastRun: { at: string; set: Setting[]; errors: string[]; warnings: string[] } | null;
  preview?: {
    ok: boolean;
    at: string;
    changes: Setting[];
    unchanged: number;
    errors: string[];
    warnings: string[];
  };
}

function Settings({ rows, testId }: { rows: Setting[]; testId: string }) {
  return (
    <ul className="divide-y divide-line text-[0.84rem]" data-testid={testId}>
      {rows.map((r, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
          <span className="text-ink">{r.instance}</span>
          <span className="text-muted">{r.setting}:</span>
          <span className="text-faint line-through">{r.from}</span>
          <span className="text-gold">{r.to}</span>
        </li>
      ))}
    </ul>
  );
}

export function RecyclarrDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const [preview, setPreview] = useState(false);
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "recyclarr", preview],
    queryFn: () =>
      api<{ data?: Panel; error?: { message: string; blocker?: Blocker } }>(
        "GET",
        `/api/services/${serviceId}/recyclarr${preview ? "?preview=1" : ""}`,
      ),
  });
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const d = q.data?.data;
  if (q.isLoading && !preview) return <Skeleton className="h-48" />;
  if (q.error || q.data?.error) {
    const blocker = q.data?.error?.blocker;
    return (
      <div className="space-y-3">
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
          data-testid="recyclarr-error"
        >
          <p className="text-amber">{name} could not be read right now.</p>
          <p className="mt-1 text-muted">{q.data?.error?.message ?? q.error?.message}</p>
        </div>
        {blocker && (
          <BlockerCard blocker={blocker} serviceName={name} onResolved={() => void q.refetch()} />
        )}
      </div>
    );
  }
  const last = d?.lastRun;
  const p = d?.preview;
  return (
    <section
      className="@container space-y-4"
      data-testid="recyclarr-dashboard"
      aria-label={`${name}: quality profiles`}
    >
      <div className="rounded-xl border border-line bg-bg/50 p-4">
        <p className="text-[0.72rem] tracking-wide text-faint uppercase">Last sync</p>
        {last ? (
          <>
            <p className="mt-1 text-[1.05rem] text-ink" data-testid="recyclarr-last">
              {ago(last.at)}
              {last.errors.length ? (
                <span className="text-alert"> · {last.errors.length} errors</span>
              ) : (
                <span className="text-live"> · no errors</span>
              )}
            </p>
            {last.set.length > 0 ? (
              <div className="mt-2">
                <p className="text-[0.78rem] text-muted">What it set</p>
                <Settings rows={last.set} testId="recyclarr-set" />
              </div>
            ) : (
              <p className="mt-1 text-[0.82rem] text-muted">It found nothing to change.</p>
            )}
            {last.errors.map((e, i) => (
              <p key={i} className="mt-1 text-[0.8rem] break-words text-alert">
                {e}
              </p>
            ))}
            {last.warnings.length > 0 && (
              <p className="mt-1 text-[0.78rem] break-words text-amber">
                {last.warnings.join(" · ")}
              </p>
            )}
          </>
        ) : (
          <p className="mt-1 text-[0.86rem] text-muted">{name} has not run a sync yet (no log).</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          tone="outline"
          disabled={q.isFetching}
          onClick={() => (preview ? void q.refetch() : setPreview(true))}
          data-testid="recyclarr-preview"
        >
          <Search className="h-4 w-4" />{" "}
          {q.isFetching && preview ? "Checking…" : "Check what a sync would change"}
        </Button>
        <Button
          tone="primary"
          onClick={() => void c.propose("app-recyclarr-sync", {}, `Sync ${name} now`)}
          data-testid="recyclarr-sync"
        >
          <RefreshCw className="h-4 w-4" /> Sync now
        </Button>
        {last?.errors.length ? (
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gold/40 px-3 text-[0.8rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `Recyclarr's last sync had errors: ${last.errors.join("; ")}. What do they mean, and how do I fix its configuration?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
            <EmberMark />
          </button>
        ) : null}
      </div>
      <ChangeCard c={c} />

      {p && (
        <div
          className="rounded-xl border border-gold/40 bg-gold/5 p-4"
          data-testid="recyclarr-preview-result"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">A sync now would</p>
          {p.ok ? (
            p.changes.length ? (
              <Settings rows={p.changes} testId="recyclarr-changes" />
            ) : (
              <p className="mt-1 text-[0.86rem] text-live">
                Change nothing: Radarr and Sonarr already match ({p.unchanged} settings checked).
              </p>
            )
          ) : (
            <p className="mt-1 text-[0.86rem] break-words text-alert">
              Fail: {p.errors.join("; ")}
            </p>
          )}
          <p className="mt-2 text-[0.74rem] text-faint">
            Recyclarr's own preview, {ago(p.at)}. Nothing was changed.
          </p>
        </div>
      )}
      <p className="text-[0.74rem] text-faint">
        {d?.container ?? name} · from Recyclarr's own logs
      </p>
    </section>
  );
}
