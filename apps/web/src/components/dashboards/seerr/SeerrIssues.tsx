import { useState } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { useSeerrView, type IssueRow, type IssueView } from "./data";

/**
 * Seerr's Issues: problems people reported (video, audio, subtitles), open first, and one issue
 * with its conversation: comment, resolve, reopen or delete, each a plan you approve.
 */

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

function Issue({ serviceId, id, onBack }: { serviceId: string; id: number; onBack: () => void }) {
  const q = useSeerrView<IssueView>(serviceId, "issue", { id });
  const act = useApproveHere(serviceId, "From Seerr's Issues tab.");
  const [text, setText] = useState("");
  const i = q.data;
  const op = (o: string, extra: Record<string, string> = {}) =>
    void act.propose(
      "app-seerr-issue",
      { issueId: id, op: o, ...extra },
      `${o} issue: ${i?.title ?? id}`,
    );
  return (
    <div className="space-y-3" data-testid="seerr-issue">
      <ApproveDialog c={act} />
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-9 items-center gap-1.5 text-[0.8rem] text-muted hover:text-ink"
        data-hearth-target="issue:back"
      >
        <ArrowLeft strokeWidth={1.5} className="h-4 w-4" /> All issues
      </button>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : !i ? (
        <p className="text-[0.84rem] text-amber">This issue could not be read; it may be gone.</p>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.95rem] text-ink">{i.title}</h3>
            <span className="text-[0.76rem] text-faint">
              {i.type} · reported by {i.by} {when(i.createdAt)}
            </span>
            <span
              className={cx(
                "fit-pill ml-auto rounded-full border px-2 py-0.5 text-[0.72rem]",
                i.open ? "border-amber/50 text-amber" : "border-live/40 text-live",
              )}
            >
              {i.open ? "Open" : "Resolved"}
            </span>
          </header>
          <ol className="space-y-2" data-testid="seerr-comments">
            {i.comments.map((c) => (
              <li key={c.id} className="rounded-xl border border-line p-2.5 text-[0.84rem]">
                <p className="text-[0.74rem] text-faint">
                  {c.by} {when(c.at)}
                </p>
                <p className="whitespace-pre-wrap text-ink">{c.message}</p>
              </li>
            ))}
          </ol>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) op("comment", { message: text.trim() });
            }}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={200}
              rows={2}
              placeholder="Reply to whoever reported it"
              aria-label="Comment"
              className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-[0.86rem] text-ink"
              data-hearth-target="issue:comment-text"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                type="submit"
                disabled={act.busy || !text.trim()}
                data-hearth-target="issue:comment"
              >
                <MessageSquare strokeWidth={1.5} className="h-4 w-4" /> Comment
              </Button>
              {i.open ? (
                <Button
                  tone="outline"
                  disabled={act.busy}
                  onClick={() => op("resolve")}
                  data-hearth-target="issue:resolve"
                >
                  Resolve
                </Button>
              ) : (
                <Button
                  tone="outline"
                  disabled={act.busy}
                  onClick={() => op("reopen")}
                  data-hearth-target="issue:reopen"
                >
                  Reopen
                </Button>
              )}
              <Button
                tone="outline"
                disabled={act.busy}
                onClick={() => op("delete")}
                data-hearth-target="issue:delete"
              >
                Delete
              </Button>
            </div>
          </form>
          {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
        </>
      )}
    </div>
  );
}

export function SeerrIssues({ serviceId, name, sub, onSub }: AppViewProps) {
  const id = sub && /^\d+$/.test(sub) ? Number(sub) : undefined;
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const q = useSeerrView<{ issues: IssueRow[]; total: number }>(
    serviceId,
    "issues",
    { status },
    !id,
  );
  if (id) return <Issue serviceId={serviceId} id={id} onBack={() => onSub?.(null)} />;
  return (
    <section className="space-y-3" aria-label={`${name} issues`}>
      <div role="tablist" aria-label="Show" className="flex gap-2">
        {(["open", "resolved", "all"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            type="button"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={cx(
              "min-h-9 rounded-full border px-3 text-[0.8rem] capitalize",
              status === s ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted",
            )}
            data-hearth-target={`issues:${s}`}
          >
            {s}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <p className="text-[0.84rem] text-amber">Could not read the issues: {q.error.message}</p>
      ) : !q.data?.issues.length ? (
        <p className="text-[0.84rem] text-muted">
          {status === "open" ? "No open issues. Nobody has reported a problem." : "None."}
        </p>
      ) : (
        <ul className="divide-y divide-line" data-testid="seerr-issues">
          {q.data.issues.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => onSub?.(String(i.id))}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left text-[0.86rem] hover:bg-raised/40"
                data-testid="seerr-issue-row"
                data-hearth-target={`issue:${i.id}:open`}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{i.title}</span>
                  <span className="block text-[0.76rem] text-faint">
                    {[
                      i.type,
                      i.where,
                      `by ${i.by}`,
                      `${i.comments} comment${i.comments === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className={cx("text-[0.76rem]", i.open ? "text-amber" : "text-live")}>
                  {i.open ? "Open" : "Resolved"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
