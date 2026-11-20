import { useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { Button, Panel, Sheet, cx } from "../ui";
import { CommandBox } from "../devices/Pcs";
import {
  useCheckUpdates,
  useInstallPcUpdate,
  useInstallUpdate,
  useOtherPcs,
  useUpdates,
  waitForNewVersion,
  type UpdateState,
} from "../../data/updates";
import { ago } from "../../lib/format";

const isWindows = () => /Windows/i.test(navigator.userAgent);

/** What's new, Update now, and the command to run by hand: one place, used everywhere. */
export function UpdateDetails({ s }: { s: UpdateState }) {
  const install = useInstallUpdate();
  const check = useCheckUpdates();
  const others = useOtherPcs(s);
  const [waiting, setWaiting] = useState(false);
  const from = s.current;
  useEffect(() => {
    if (!waiting) return;
    const stop = new AbortController();
    void waitForNewVersion(from, stop.signal);
    return () => stop.abort();
  }, [waiting, from]);
  const updating = waiting || s.updating;
  return (
    <div className="space-y-4" data-testid="update-details">
      <p className="text-[0.9rem] text-muted">
        This Hearth is {s.current ? `version ${s.current}` : "an older version"}.
        {s.available && s.latest
          ? ` Version ${s.latest.version} is out.`
          : s.latest
            ? " It is the newest."
            : ""}
      </p>
      {s.available && s.latest?.notes && (
        <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-sans text-[0.85rem] whitespace-pre-wrap text-ink">
          {s.latest.notes}
        </pre>
      )}
      {s.available &&
        (updating ? (
          <p className="text-[0.9rem] text-gold" role="status" data-testid="update-running">
            Updating. Hearth downloads the new version and restarts; this page reloads by itself
            when it is back (a minute or two, longer on Windows).
          </p>
        ) : s.canUpdate ? (
          <Button
            tone="primary"
            disabled={install.isPending}
            onClick={() =>
              install.mutate(
                { others: others.behind, anyway: Boolean(install.data?.busy?.length) },
                { onSuccess: (r) => r.ok && setWaiting(true) },
              )
            }
            data-testid="update-now"
          >
            <ArrowUpCircle strokeWidth={1.6} className="h-4 w-4" />
            {install.data?.busy?.length
              ? "Update anyway"
              : others.behind.length
                ? "Update all my PCs"
                : "Update now"}
          </Button>
        ) : (
          <p className="text-[0.85rem] text-muted">{s.cannot}</p>
        ))}
      {install.data && !install.data.ok && (
        <p
          role="alert"
          className={`text-[0.85rem] ${install.data.busy?.length ? "text-amber" : "text-bad"}`}
          data-testid="update-busy"
        >
          {install.data.message}
        </p>
      )}
      {s.available && !updating && !install.data && Boolean(s.busy?.length) && (
        <p className="text-[0.85rem] text-amber">
          Updating restarts Hearth, which would stop {s.busy!.join(" and ")}. You can wait until it
          is done.
        </p>
      )}
      {s.available && (
        <div>
          <p className="mb-1.5 text-[0.8rem] text-muted">
            Or run this on that PC ({isWindows() ? "PowerShell" : "a terminal"}). Your data and
            settings are kept.
          </p>
          <CommandBox text={isWindows() ? s.commands.windows : s.commands.linux} />
        </div>
      )}
      {others.pcs.length > 0 && <OtherPcs s={s} />}
      {s.problem && <p className="text-[0.85rem] text-amber">{s.problem}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          tone="outline"
          disabled={check.isPending}
          onClick={() => check.mutate()}
          data-testid="update-check"
        >
          <RefreshCw
            strokeWidth={1.6}
            className={cx("h-4 w-4", check.isPending && "animate-spin")}
            aria-hidden="true"
          />
          {check.isPending ? "Checking…" : "Check for updates"}
        </Button>
        {s.checkedAt && (
          <span className="text-[0.8rem] text-faint">
            Checked {ago(s.checkedAt).toLowerCase()}.
          </span>
        )}
      </div>
    </div>
  );
}

/** Each of your other PCs, its version, and Update for any that are behind. */
function OtherPcs({ s }: { s: UpdateState }) {
  const { pcs, isBehind } = useOtherPcs(s);
  const update = useInstallPcUpdate();
  const [started, setStarted] = useState<Record<string, boolean>>({});
  return (
    <div data-testid="other-pcs-versions">
      <p className="mb-1.5 text-[0.8rem] text-muted">
        Your other PCs each run their own copy of Hearth:
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {pcs.map((pc) => (
          <li
            key={pc.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[0.88rem]"
            data-testid="pc-version"
          >
            <span className="text-ink">
              {pc.name}
              <span className="text-faint">
                {" "}
                · {pc.version ? `version ${pc.version}` : "version unknown"}
                {!pc.online ? " · offline" : ""}
              </span>
            </span>
            {started[pc.id] ? (
              <span className="text-[0.82rem] text-gold" role="status">
                Updating; it restarts by itself in a few minutes.
              </span>
            ) : isBehind(pc) ? (
              pc.online ? (
                <Button
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      {
                        id: pc.id,
                        anyway:
                          update.variables?.id === pc.id && Boolean(update.data?.busy?.length),
                      },
                      {
                        onSuccess: (r) => r.ok && setStarted((x) => ({ ...x, [pc.id]: true })),
                      },
                    )
                  }
                  data-testid="pc-update-now"
                >
                  <ArrowUpCircle strokeWidth={1.6} className="h-4 w-4" />
                  {update.variables?.id === pc.id && update.data?.busy?.length
                    ? "Update anyway"
                    : "Update"}
                </Button>
              ) : (
                <span className="text-[0.82rem] text-amber">Behind; update it when it is on.</span>
              )
            ) : (
              <span className="text-[0.82rem] text-ok">Up to date</span>
            )}
          </li>
        ))}
      </ul>
      {update.data && !update.data.ok && (
        <p
          role="alert"
          className={`mt-1 text-[0.85rem] ${update.data.busy?.length ? "text-amber" : "text-bad"}`}
        >
          {update.data.message}
        </p>
      )}
    </div>
  );
}

/** The top bar's "Update" button, while a newer Hearth is out here or on another of your PCs. */
export function UpdateButton() {
  const q = useUpdates();
  const [open, setOpen] = useState(false);
  const s = q.data;
  const others = useOtherPcs(s);
  if (!s?.latest || (!s.available && !others.behind.length)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-9 items-center gap-2 rounded-full border border-gold/60 bg-gold/15 px-3.5 text-[0.82rem] font-medium text-gold hover:bg-gold/25"
        title={
          s.available ? `Hearth ${s.latest.version} is out` : "One of your PCs needs an update"
        }
        data-testid="update-button"
      >
        <ArrowUpCircle strokeWidth={1.6} className="h-4 w-4" />
        {s.available
          ? "Update"
          : others.behind.length === 1
            ? `Update ${others.behind[0]!.name}`
            : `Update ${others.behind.length} PCs`}
      </button>
      {open && (
        <Sheet
          label="Update Hearth"
          eyebrow="Hearth updates"
          title={s.available ? `Hearth ${s.latest.version} is out` : "One of your PCs is behind"}
          onClose={() => setOpen(false)}
        >
          <div className="mt-4">
            <UpdateDetails s={s} />
          </div>
        </Sheet>
      )}
    </>
  );
}

/** The same notice as a card, at the top of the page the bell opens. */
export function UpdateCard({ className }: { className?: string }) {
  const s = useUpdates().data;
  const others = useOtherPcs(s);
  if (!s?.latest || (!s.available && !others.behind.length)) return null;
  return (
    <div data-testid="update-card">
      <Panel className={cx("mb-8 border-gold/40 p-5", className)}>
        <p className="mb-3 flex items-center gap-2 font-display text-[1.3rem] text-ink">
          <ArrowUpCircle strokeWidth={1.6} className="h-5 w-5 text-gold" />
          {s.available ? `Hearth ${s.latest.version} is out` : "One of your PCs is behind"}
        </p>
        <UpdateDetails s={s} />
      </Panel>
    </div>
  );
}

/** One more thing for the bell's count while an update is waiting. */
export function useUpdateCount(): number {
  const s = useUpdates().data;
  const others = useOtherPcs(s);
  return s?.available || others.behind.length ? 1 : 0;
}
