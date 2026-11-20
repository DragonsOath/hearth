import { useEffect, useState } from "react";
import { NearMisses } from "../crucible/NearMisses";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, MessageCircle, RefreshCw, Wrench } from "lucide-react";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { Link } from "react-router";
import {
  PROBLEM_LABEL,
  canRecover,
  type DownloadHealthItem,
  type DownloadHealthOverview,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { useCave } from "../shell/cave-context";
import { usePanelHref } from "../desk/links";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { ToolImage } from "../panels/ToolImage";
import { Monogram, Skeleton, Tag, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";
import { agoWords, lasting } from "../../lib/format";

/**
 * Download Health (the owner's design, 2026-11-07; monitoring phase): stuck and failing downloads
 * across the download clients and the apps that grab, explained in plain words. A shared cause (a
 * VPN, a full disk, a client that does not answer) comes first, because replacing good downloads
 * cannot fix it. It changes nothing: fixes are a later phase, as plans you approve.
 */

type View = DownloadHealthOverview & {
  sample?: boolean;
  history: {
    at: string;
    key: string;
    title: string;
    event: "attention" | "cleared" | "fixed";
    text: string;
  }[];
};
type Tab = "now" | "history";

export function useDownloadHealth() {
  return useQuery({
    queryKey: ["download-health"],
    queryFn: () => api<View>("GET", "/api/download-health"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// Plain words (the owner, 11-13: "for 4 days", not "since 105 h ago").
const ago = (iso?: string) => (iso ? agoWords(iso) : "never");

export function DownloadHealthPanel({
  tab,
  onTab,
  onClose,
}: {
  tab: string | null;
  onTab: (tab: Tab) => void;
  onClose: () => void;
}) {
  const q = useDownloadHealth();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api<View>("POST", "/api/download-health/check"),
    onSuccess: (v) => qc.setQueryData(["download-health"], v),
  });
  const current: Tab = tab === "history" ? "history" : "now";
  const v = q.data;
  const tabs: TabDef<Tab>[] = [
    { id: "now", label: v?.attention ? `Now (${v.attention})` : "Now" },
    { id: "history", label: "History" },
  ];
  return (
    <WorkspaceFrame
      label="Download Health"
      testId="download-health-panel"
      icon={<ToolImage id="downloads" />}
      title="Download Health"
      subtitle={
        <span>
          Stuck and failing downloads, and why. Checked {ago(v?.checkedAt)}.{" "}
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline disabled:opacity-50"
            data-testid="download-health-check"
          >
            <RefreshCw
              className={cx("h-3.5 w-3.5", check.isPending && "animate-spin")}
              aria-hidden
            />
            Check now
          </button>
        </span>
      }
      tabs={tabs}
      tab={current}
      onTab={onTab}
      onClose={onClose}
      capture={{ panel: "Download Health", tab: current }}
    >
      {q.isLoading || !v ? (
        <Skeleton className="h-48" />
      ) : current === "history" ? (
        <History v={v} />
      ) : (
        <Now v={v} />
      )}
    </WorkspaceFrame>
  );
}

function Now({ v }: { v: View }) {
  const attention = v.items.filter((i) => i.state === "attention");
  const watching = v.items.filter((i) => i.state === "watching");
  const down = v.clients.filter((c) => !c.reachable);
  const mood: "cause" | "attention" | "watching" | "clear" = v.causes.length
    ? "cause"
    : attention.length
      ? "attention"
      : watching.length
        ? "watching"
        : "clear";
  const headline = !v.checkedAt
    ? "Not checked yet"
    : mood === "cause"
      ? "Something they share needs fixing first"
      : mood === "attention"
        ? `${attention.length} download${attention.length === 1 ? " needs" : "s need"} you`
        : mood === "watching"
          ? `All right so far: ${watching.length} being watched`
          : "All clear: nothing stuck or failing";
  return (
    <div className="@container space-y-4" data-testid="download-health-now">
      <NearMisses brief />
      {v.sample && (
        <p className="text-[0.76rem] text-faint">Sample data: these are not your downloads.</p>
      )}
      {/* The checkup: Ember with her clipboard, what she found, and when she looked. */}
      <section
        className={cx(
          "flex flex-col items-center gap-4 rounded-2xl border p-4 @md:flex-row",
          mood === "clear"
            ? "border-live/40 bg-live/5"
            : mood === "watching"
              ? "border-gold/40 bg-gold/5"
              : "border-warn/50 bg-warn/5",
        )}
        aria-label="Checkup"
      >
        <ToolImage id="downloads" className="h-28 w-28 shrink-0 drop-shadow-lg" />
        <div className="min-w-0 flex-1 space-y-2 text-center @md:text-left">
          <p className="eyebrow">Checkup</p>
          <h3
            className={cx(
              "font-display text-[1.4rem] leading-tight",
              mood === "clear" ? "text-ink" : mood === "watching" ? "text-gold" : "text-warn",
            )}
            data-testid="download-health-headline"
          >
            {headline}
          </h3>
          <p className="text-[0.8rem] text-muted">
            {v.checkedAt ? `Checked ${ago(v.checkedAt)}, every 5 minutes. ` : ""}
            {v.clients.length === 0
              ? "No download client is connected to Hearth yet."
              : down.length
                ? `${down.map((c) => c.name).join(", ")} ${down.length === 1 ? "isn't" : "aren't"} answering.`
                : `All ${v.clients.length} download client${v.clients.length === 1 ? "" : "s"} answering.`}
          </p>
          <div
            className="flex flex-wrap justify-center gap-2 @md:justify-start"
            data-testid="download-health-overview"
          >
            <Chip n={v.downloading} label="downloading" />
            <Chip
              n={attention.length}
              label="need you"
              tone={attention.length ? "warn" : undefined}
            />
            <Chip
              n={watching.length}
              label="being watched"
              tone={watching.length ? "gold" : undefined}
            />
          </div>
        </div>
      </section>

      {v.causes.map((c) => (
        <div
          key={c.text}
          className="flex gap-3 rounded-xl border border-warn/50 bg-warn/5 p-3 text-[0.86rem] text-ink"
          data-testid="download-health-cause"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p>{c.text}</p>
            {c.count > 0 && (
              <p className="text-[0.76rem] text-faint">
                Its {c.count} download{c.count === 1 ? " is" : "s are"} held back from strikes until
                this is fixed: replacing them wouldn&apos;t help.
              </p>
            )}
            <AskEmber
              question={`Download Health says: ${c.text} Look into it and propose a fix I can approve.`}
            />
          </div>
        </div>
      ))}

      <Clients v={v} />

      {attention.length > 0 && (
        <Section title="Needs you" items={attention} v={v} testId="download-health-attention" />
      )}
      {watching.length > 0 && (
        <Section
          title="Being watched"
          items={watching}
          v={v}
          testId="download-health-watching"
          note={`Needs you after ${v.settings.strikes} checks without progress, over at least ${v.settings.minMinutes} minutes. Any progress clears it.`}
        />
      )}
      {v.checkedAt && !v.items.length && !v.causes.length && (
        <p className="sr-only" data-testid="download-health-ok">
          Nothing is stuck or failing.
        </p>
      )}
      <details className="rounded-xl border border-line px-3 py-2 text-[0.8rem] text-muted">
        <summary className="cursor-pointer py-1 select-none hover:text-gold">How it judges</summary>
        <ul className="list-disc space-y-1 pt-1 pl-5">
          <li>
            Only downloads Sonarr, Radarr, Lidarr or Chaptarr track are judged; anything else in a
            client (your own, or seeding) is left alone.
          </li>
          <li>
            A stalled one gets a strike each check; {v.settings.strikes} strikes over at least{" "}
            {v.settings.minMinutes} minutes and it needs you. Any progress clears its strikes.
          </li>
          <li>
            {v.settings.shared} or more stalling at once in one client points to something they
            share (a VPN, a full disk, the client itself), shown first.
          </li>
          <li>
            <strong className="text-ink">Fix it</strong> (Sonarr and Radarr) removes the stuck
            download, blocklists that one release so it is never grabbed again, and searches for
            another: one plan you approve. At most two replacements per movie or episode, then it
            asks you.
          </li>
        </ul>
      </details>
      <AutoRecovery on={Boolean(v.settings.auto)} />
    </div>
  );
}

function Chip({ n, label, tone }: { n: number; label: string; tone?: "warn" | "gold" }) {
  return (
    <span
      className={cx(
        "inline-flex min-h-9 items-baseline gap-1.5 rounded-full border px-3 py-1.5 text-[0.78rem]",
        tone === "warn"
          ? "border-warn/50 text-warn"
          : tone === "gold"
            ? "border-gold/50 text-gold"
            : "border-line text-muted",
      )}
    >
      <b className="font-display text-[1.05rem] text-ink tabular-nums">{n}</b> {label}
    </span>
  );
}

function AskEmber({
  question,
  label = "Ask Ember to fix it",
}: {
  question: string;
  label?: string;
}) {
  const cave = useCave();
  return (
    <button
      type="button"
      onClick={() => cave.ask(question)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> {label}
      <EmberMark />
    </button>
  );
}

/** Each download client, with its logo: answering or not, and how its downloads are doing. */
function Clients({ v }: { v: View }) {
  const href = usePanelHref();
  const ws = useWorkspace();
  if (!v.clients.length) return null;
  return (
    <section aria-label="Download clients" className="space-y-2">
      <p className="eyebrow">Your download clients</p>
      <ul className="grid gap-2 @md:grid-cols-2">
        {v.clients.map((c) => {
          const svc = ws.data?.services.find((s) => s.id === c.serviceId);
          const mine = v.items.filter((i) => i.clientServiceId === c.serviceId);
          const need = mine.filter((i) => i.state === "attention").length;
          const cause = v.causes.find((x) => x.clientServiceId === c.serviceId);
          const bad = !c.reachable || Boolean(cause) || need > 0;
          return (
            <li key={c.serviceId}>
              <Link
                to={href(`service:${c.serviceId}`) ?? "/"}
                className={cx(
                  "flex min-h-16 items-center gap-3 rounded-xl border p-3 transition-colors hover:border-gold/50",
                  bad ? "border-warn/40" : "border-line",
                )}
                data-testid="download-health-client"
              >
                <Monogram name={c.name} image={svc?.image} className="h-10 w-10 text-[0.8rem]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9rem] text-ink">{c.name}</span>
                  <span className="block text-[0.74rem] text-faint">
                    {!c.reachable
                      ? (c.detail ?? "Not answering")
                      : cause
                        ? "Something shared is wrong"
                        : need
                          ? `${need} need${need === 1 ? "s" : ""} you`
                          : mine.length
                            ? `${mine.length} being watched`
                            : "Nothing stuck"}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cx(
                    "h-2.5 w-2.5 rounded-full",
                    bad ? "bg-warn" : mine.length ? "bg-gold" : "bg-live",
                  )}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Section({
  title,
  items,
  v,
  note,
  testId,
}: {
  title: string;
  items: DownloadHealthItem[];
  v: View;
  note?: string;
  testId: string;
}) {
  const href = usePanelHref();
  const ws = useWorkspace();
  return (
    <section className="space-y-2" data-testid={testId} aria-label={title}>
      <p className="eyebrow">{title}</p>
      {note && <p className="text-[0.74rem] text-faint">{note}</p>}
      <ul className="space-y-2">
        {items.map((i) => {
          const svc = ws.data?.services.find((s) => s.id === (i.appServiceId ?? i.clientServiceId));
          return (
            <li
              key={i.key}
              className={cx(
                "flex gap-3 rounded-xl border p-3",
                i.state === "attention" ? "border-warn/40 bg-warn/5" : "border-line",
              )}
              data-testid="download-health-item"
            >
              <Monogram
                name={i.app ?? i.client}
                image={svc?.image}
                className="h-9 w-9 shrink-0 text-[0.75rem]"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-[0.9rem] text-ink">{i.title}</span>
                  <Tag tone={i.state === "attention" ? "warn" : "neutral"}>
                    {PROBLEM_LABEL[i.problem]}
                  </Tag>
                </div>
                <p className="text-[0.82rem] text-muted">{i.explain}</p>
                {i.state === "watching" && (
                  <span
                    className="flex items-center gap-1"
                    role="img"
                    aria-label={`${i.strikes} of ${v.settings.strikes} checks without progress`}
                  >
                    {Array.from({ length: v.settings.strikes }, (_, n) => (
                      <span
                        key={n}
                        className={cx(
                          "h-1.5 w-6 rounded-full",
                          n < i.strikes ? "bg-gold" : "bg-line",
                        )}
                      />
                    ))}
                    <span className="ml-1 text-[0.72rem] text-faint">
                      {i.strikes} of {v.settings.strikes} checks
                    </span>
                  </span>
                )}
                {i.detail && (
                  <details className="text-[0.74rem] text-faint">
                    <summary className="cursor-pointer select-none hover:text-muted">
                      In {i.app ?? i.client}&apos;s own words
                    </summary>
                    <p className="pt-1 break-words">{i.detail}</p>
                  </details>
                )}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.74rem] text-faint">
                  {i.app && (
                    <Link
                      to={href(`service:${i.appServiceId}`) ?? "/"}
                      className="text-gold underline-offset-2 hover:underline"
                    >
                      {i.app}
                    </Link>
                  )}
                  {i.app !== i.client && (
                    <Link
                      to={href(`service:${i.clientServiceId}`) ?? "/"}
                      className="text-gold underline-offset-2 hover:underline"
                    >
                      {i.client}
                    </Link>
                  )}
                  <span>{i.since ? lasting(i.since) : ""}</span>
                  {canRecover(i) && <FixIt i={i} />}
                  {i.state === "attention" && (
                    <span className={canRecover(i) ? undefined : "ml-auto"}>
                      <AskEmber
                        question={`Download Health: "${i.title}" in ${i.app ?? i.client} (${i.client}) needs me: ${PROBLEM_LABEL[i.problem]}. ${i.explain}${i.detail ? ` In its own words: ${i.detail}` : ""} Find the right fix and propose it as a plan I approve.`}
                      />
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function History({ v }: { v: View }) {
  if (!v.history.length)
    return (
      <p className="text-[0.86rem] text-muted">
        Nothing yet. Every download that needed you, and when it stopped needing you, shows here.
      </p>
    );
  return (
    <ul className="divide-y divide-line" data-testid="download-health-history">
      {v.history.map((h) => (
        <li key={`${h.at}-${h.key}-${h.event}`} className="py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-[0.86rem] text-ink">{h.title}</span>
            <Tag tone={h.event === "attention" ? "warn" : "gold"}>
              {h.event === "attention"
                ? "Needed you"
                : h.event === "fixed"
                  ? "Fixed automatically"
                  : "Recovered"}
            </Tag>
          </div>
          <p className="text-[0.78rem] text-muted">
            {h.text} <span className="text-faint">({ago(h.at)})</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Fix it (11-13, the owner's decisions): one plan, approved here: the download is removed from
 * the app's queue and the client, that one release is blocklisted, and the app searches again.
 */
function FixIt({ i }: { i: DownloadHealthItem }) {
  const qc = useQueryClient();
  const act = useApproveHere(i.fix!.serviceId, "From Download Health.");
  const done = act.job?.status === "succeeded";
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: ["download-health"] });
  }, [done, qc]);
  return (
    <span className="ml-auto">
      <button
        type="button"
        disabled={act.busy}
        onClick={() =>
          void act.propose(
            "app-arr-queue-remove",
            { queueId: i.fix!.queueId, recover: true },
            `Fix the stuck download of ${i.title}`,
            i.fix!.serviceId,
          )
        }
        className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gold/50 px-3 text-[0.8rem] text-gold hover:bg-gold/10 disabled:opacity-50"
        data-testid="download-health-fix"
      >
        <Wrench className="h-3.5 w-3.5" aria-hidden /> Fix it
      </button>
      {act.error && (
        <span className="ml-2 text-[0.74rem] text-bad" data-testid="download-health-fix-error">
          {act.error}
        </span>
      )}
      <ApproveDialog c={act} />
    </span>
  );
}

/** Automatic Recovery: off unless the owner turns it on; then Fix it runs on its own. */
function AutoRecovery({ on }: { on: boolean }) {
  const qc = useQueryClient();
  // Shown at once; put back if the server refuses.
  const [mine, setMine] = useState<boolean>();
  const set = useMutation({
    mutationFn: (auto: boolean) => api("PUT", "/api/download-health/settings", { auto }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["download-health"] }),
    onError: () => setMine(undefined),
  });
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3"
      data-testid="download-health-auto"
    >
      <input
        type="checkbox"
        checked={mine ?? on}
        onChange={(e) => {
          setMine(e.target.checked);
          set.mutate(e.target.checked);
        }}
        className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
      />
      <span className="space-y-0.5">
        <span className="block text-[0.88rem] text-ink">Automatic Recovery</span>
        <span className="block text-[0.78rem] text-muted">
          Fix stuck Sonarr and Radarr downloads without asking: the same as pressing Fix it, then
          the bell tells you what was done. Off, every fix waits for you.
        </span>
      </span>
    </label>
  );
}

/** One line in a download app's panel: how its downloads are doing, with a link to the panel. */
export function DownloadHealthLine({ serviceId }: { serviceId: string }) {
  const q = useDownloadHealth();
  const href = usePanelHref();
  const v = q.data;
  if (!v?.checkedAt) return null;
  const mine = v.items.filter(
    (i) => i.clientServiceId === serviceId || i.appServiceId === serviceId,
  );
  const need = mine.filter((i) => i.state === "attention").length;
  const cause = v.causes.find((c) => c.clientServiceId === serviceId);
  return (
    <Link
      to={href("tool:downloads") ?? "/"}
      className={cx(
        "flex min-h-10 items-center gap-2 rounded-lg border px-3 text-[0.8rem]",
        need || cause ? "border-warn/40 text-warn" : "border-line text-muted hover:text-ink",
      )}
      data-testid="download-health-line"
    >
      {need || cause ? (
        <AlertTriangle className="h-4 w-4" aria-hidden />
      ) : (
        <CheckCircle2 className="h-4 w-4 text-live" aria-hidden />
      )}
      {cause
        ? cause.text.split(":")[0]
        : need
          ? `${need} download${need === 1 ? " needs" : "s need"} you`
          : mine.length
            ? `${mine.length} being watched, none need you`
            : "Download Health: nothing stuck"}
    </Link>
  );
}
