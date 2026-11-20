import { BookOpen, ExternalLink, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import type { KomgaDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Komga from Hearth. The Overview answers "is the comics library up to date, and is anyone
 * reading?": series and books, books Komga could not read, who used it today, every library with
 * its scan schedule and a scan one tap away (the slower library tasks one step further), and what
 * was added lately. Books lists the books it could not read, with a way to read one again, and
 * Komga's history. People lists who signed in when, and failed sign-ins. Each change is a plan you
 * approve; users, libraries and reading lists are changed in Komga.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-komga-control" as const;

function useKomga(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "komga" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useKomga>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="km-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add an administrator's API key for Komga to Secure Vault, for this service. Make one in
            Komga: your account (top right), API Keys, Generate API key.
          </p>
        )}
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
      {d.version ? `Komga ${d.version} · ` : ""}live, every 30 s · {d.collections} collections ·{" "}
      {d.readLists} reading lists.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
        >
          Open Komga <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

const dayAgo = () => Date.now() - 86_400_000;

export function KomgaDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useKomga(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Komga's panel.");
  if (!d) return <Gate name={name} q={q} />;
  const today = d.users.filter((u) => u.lastSeen && Date.parse(u.lastSeen) > dayAgo()).length;
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="km-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Books</p>
          <p className="stat-value text-ink tabular" data-testid="km-books">
            {d.books.toLocaleString()}
          </p>
          <p className="text-[0.74rem] text-faint">{d.series.toLocaleString()} series</p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("books")}
          data-hearth-target="tab:books:open"
        >
          <p className={eyebrow}>Unreadable</p>
          <p
            className={cx("stat-value tabular", d.unreadableCount ? "text-amber" : "text-ink")}
            data-testid="km-unreadable"
          >
            {d.unreadableCount}
          </p>
          <p className="text-[0.74rem] text-faint">books it could not open</p>
        </button>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("people")}
          data-hearth-target="tab:people:open"
        >
          <p className={eyebrow}>Readers today</p>
          <p
            className={cx("stat-value tabular", today ? "text-ok" : "text-ink")}
            data-testid="km-today"
          >
            {today}
          </p>
          <p className="text-[0.74rem] text-faint">of {d.users.length} people</p>
        </button>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("people")}
        >
          <p className={eyebrow}>Failed sign-ins</p>
          <p
            className={cx(
              "stat-value tabular",
              d.failedSignIns.length >= 5 ? "text-amber" : "text-ink",
            )}
            data-testid="km-failed"
          >
            {d.failedSignIns.length}
          </p>
          <p className="text-[0.74rem] text-faint">in the last day</p>
        </button>
      </div>

      <div data-hearth-target="komga:libraries" className="space-y-2" data-testid="km-libraries">
        <p className={eyebrow}>Libraries</p>
        <ul className="divide-y divide-line">
          {d.libraries.map((l) => (
            <li
              key={l.id}
              className="space-y-1.5 py-2.5"
              data-testid="km-library"
              data-capture-item
              data-capture-label={l.name}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[0.9rem] text-ink">{l.name}</span>
                <span className="text-[0.78rem] text-muted">
                  {l.series.toLocaleString()} series · {l.books.toLocaleString()} books
                </span>
                <span className="ml-auto text-[0.74rem] text-faint">
                  scans {l.scanEvery === "off" ? "only when asked" : l.scanEvery}
                </span>
              </div>
              <p className="font-mono text-[0.74rem] break-all text-faint">{l.root}</p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose({ op: "scan", libraryId: l.id }, `Scan ${l.name} in ${name}`)
                  }
                  data-testid="km-scan"
                >
                  <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan for new books
                </button>
                <details className="group">
                  <summary className={cx(btn, "cursor-pointer list-none")}>More</summary>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "deep-scan", libraryId: l.id },
                          `Deep scan ${l.name} in ${name}`,
                        )
                      }
                    >
                      Deep scan
                    </button>
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "analyze", libraryId: l.id },
                          `Analyze ${l.name}'s books in ${name}`,
                        )
                      }
                    >
                      Analyze books
                    </button>
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "refresh-metadata", libraryId: l.id },
                          `Refresh ${l.name}'s metadata in ${name}`,
                        )
                      }
                    >
                      Refresh metadata
                    </button>
                    <button
                      type="button"
                      className={cx(btn, "hover:border-alert/60 hover:text-alert")}
                      onClick={() =>
                        propose(
                          { op: "empty-trash", libraryId: l.id },
                          `Empty ${l.name}'s trash in ${name}`,
                        )
                      }
                      data-testid="km-empty-trash"
                    >
                      <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Empty trash
                    </button>
                  </div>
                </details>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-[0.74rem] text-faint">
          A deep scan reads every file again. Emptying the trash makes Komga forget books whose
          files are gone, with their reading progress.
        </p>
      </div>

      <div data-testid="km-latest">
        <p className={eyebrow}>Added lately</p>
        {d.latest.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nothing added yet.</p>
        ) : (
          <ul className="space-y-1 text-[0.84rem]">
            {d.latest.map((b) => (
              <li key={b.id} className="flex flex-wrap items-baseline gap-x-2">
                <BookOpen strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
                <span className="text-ink">{b.name}</span>
                {b.series && <span className="text-muted">{b.series}</span>}
                {b.added && <span className="text-faint">{ago(b.added).toLowerCase()}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function KomgaBooks({ serviceId, name }: AppViewProps) {
  const { q, d } = useKomga(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Komga's panel.");
  if (!d) return <Gate name={name} q={q} />;
  return (
    <section
      className="@container space-y-4"
      data-testid="km-books-tab"
      aria-label={`${name}: books`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div data-hearth-target="books:unreadable">
        <p className={eyebrow}>Could not be read</p>
        {d.unreadable.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Komga can open every book.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.unreadable.map((b) => (
              <li
                key={b.id}
                className="space-y-1 py-2.5"
                data-testid="km-bad-book"
                data-capture-item
                data-capture-label={b.name}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[0.9rem] text-ink">{b.name}</span>
                  {b.series && <span className="text-[0.78rem] text-muted">{b.series}</span>}
                </div>
                <p className="text-[0.78rem] text-amber">{b.why}</p>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    void act.propose(
                      KIND,
                      { op: "analyze-book", bookId: b.id },
                      `Read "${b.name}" again in ${name}`,
                    )
                  }
                  data-testid="km-read-again"
                >
                  <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Read it again
                </button>
              </li>
            ))}
          </ul>
        )}
        {d.unreadableCount > d.unreadable.length && (
          <p className="text-[0.74rem] text-faint">
            Showing {d.unreadable.length} of {d.unreadableCount}.
          </p>
        )}
        <p className="mt-1 text-[0.74rem] text-faint">
          Replace or fix the file first (a damaged archive, or a format Komga does not read), then
          ask Komga to read it again.
        </p>
      </div>
      <div data-testid="km-history">
        <p className={eyebrow}>History</p>
        {d.history.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-[0.82rem]">
            {d.history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{h.text}</span>
                {h.at && <span className="text-faint">{ago(h.at).toLowerCase()}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function KomgaPeople({ serviceId, name }: AppViewProps) {
  const { q, d } = useKomga(serviceId);
  if (!d) return <Gate name={name} q={q} />;
  return (
    <section
      className="@container space-y-4"
      data-testid="km-people-tab"
      aria-label={`${name}: people`}
    >
      <ul className="divide-y divide-line" data-hearth-target="people:list">
        {d.users.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-baseline gap-x-2 py-2.5"
            data-testid="km-user"
          >
            <span className="text-[0.9rem] text-ink">{u.email}</span>
            {u.admin && <span className="text-[0.74rem] text-gold">administrator</span>}
            <span className="ml-auto text-[0.74rem] text-faint">
              {u.lastSeen ? `signed in ${ago(u.lastSeen).toLowerCase()}` : "no recent sign-in"}
            </span>
          </li>
        ))}
      </ul>
      <div data-testid="km-failed-list">
        <p className={eyebrow}>Failed sign-ins, last day</p>
        {d.failedSignIns.length === 0 ? (
          <p className="text-[0.84rem] text-faint">None.</p>
        ) : (
          <ul className="space-y-0.5 text-[0.8rem]">
            {d.failedSignIns.map((f, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <ShieldAlert strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-amber" />
                <span className="text-ink">{f.email}</span>
                {f.ip && <span className="font-mono text-muted">{f.ip}</span>}
                <span className="text-faint">{ago(f.at).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[0.74rem] text-faint">
        Komga keeps each person's reading progress to them, so Hearth shows when they signed in. New
        people, passwords and library access are set in Komga (Server settings, Users).
      </p>
    </section>
  );
}
