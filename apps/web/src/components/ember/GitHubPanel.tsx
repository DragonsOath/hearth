import { useCallback, useEffect, useRef, useState } from "react";
import { ember, md, store } from "./engine";

/**
 * The GitHub panel, from EMBER: a small built-in "browser" for GitHub drawn from live data (the gh
 * tool on Hearth's machine). It opens by itself when the agent commits, pushes or opens a pull
 * request, and follows along step by step. Real github.com pages cannot be embedded (GitHub
 * forbids it), so this draws the same data itself.
 */

export interface GhItem {
  id: string;
  project?: string;
  repo?: string;
  pr?: number;
  step: string;
  state: "running" | "done" | "failed";
  label: string;
  branch?: string;
  sha?: string;
  message?: string;
  command: string;
  at: number;
}

type View =
  { kind: "home" } | { kind: "repo"; repo: string } | { kind: "pr"; repo: string; n: number };

const GH_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
    />
  </svg>
);
export const GitHubMark = () => GH_ICON;
const PR_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
    />
  </svg>
);
const STEP_ICON: Record<string, string> = {
  commit: "●",
  push: "↑",
  "pr-create": "⇄",
  "pr-merge": "⤵",
  "pr-view": "◎",
  "pr-review": "✎",
  branch: "⑂",
  pull: "↓",
  clone: "⧉",
  merge: "⤵",
  ci: "⚙",
  "repo-create": "+",
};

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

interface PrRow {
  repo: string;
  number: number;
  title: string;
  updated: string;
  draft?: boolean;
}
interface Overview {
  user: { login: string; name?: string; avatar: string };
  prs: PrRow[];
  review: PrRow[];
  repos: { full: string; private: boolean; language?: string; pushed: string }[];
}
interface RepoPage {
  full: string;
  private: boolean;
  default_branch: string;
  language?: string;
  description?: string;
  pulls: {
    number: number;
    title: string;
    head: string;
    state: string;
    draft?: boolean;
    updated: string;
  }[];
  commits: { sha: string; message: string; author: string; date: string }[];
  branches: string[];
}
interface PrPage {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  author: string;
  head: string;
  base: string;
  commits: { sha: string; message: string; author?: string }[];
  changed: number;
  additions: number;
  deletions: number;
  updated: string;
  review?: string;
  body?: string;
  checks: { name: string; state: string }[];
  files: { name: string; status: string; additions: number; deletions: number; patch?: string }[];
}

const busy = (feed: GhItem[]) =>
  feed.some((i) => i.state === "running" && Date.now() / 1000 - i.at < 600);

function StateBadge({ state, draft }: { state: string; draft?: boolean }) {
  const st = draft && state === "open" ? "draft" : state;
  const label = { open: "Open", merged: "Merged", closed: "Closed", draft: "Draft" }[st] ?? st;
  return (
    <span className={`gh-state gh-st-${st}`}>
      {PR_ICON}
      {label}
    </span>
  );
}

function Diff({ patch }: { patch?: string }) {
  if (!patch) return <div className="gh-none">No text diff (binary or too large).</div>;
  return (
    <pre className="gh-diff">
      {patch.split("\n").map((l, i) => {
        const k = l.startsWith("@@")
          ? "hunk"
          : l.startsWith("+")
            ? "add"
            : l.startsWith("-")
              ? "del"
              : "";
        return (
          <span key={i} className={k}>
            {l || " "}
          </span>
        );
      })}
    </pre>
  );
}

function LiveSteps({ feed, repo }: { feed: GhItem[]; repo?: string }) {
  const steps = feed.filter((i) => !repo || !i.repo || i.repo === repo).slice(-8);
  if (!steps.length) return null;
  return (
    <div className="gh-live">
      <div className="gh-live-h">
        <span className={`gh-pulse ${busy(feed) ? "on" : ""}`} />
        EMBER on GitHub
      </div>
      {steps.map((i) => (
        <div key={i.id} className={`gh-step s-${i.state}`}>
          <span className="gh-step-i">{STEP_ICON[i.step] ?? "•"}</span>
          <div>
            <b>{i.label}</b>
            {i.branch && (
              <>
                {" "}
                <span className="gh-branch">{i.branch}</span>
              </>
            )}
            {i.sha && (
              <>
                {" "}
                <code>{i.sha}</code>
              </>
            )}
            <small>{i.message || i.command.slice(0, 120)}</small>
          </div>
          <span className="gh-step-s">
            {i.state === "running" ? (
              <span className="gh-spin" />
            ) : i.state === "failed" ? (
              "✕"
            ) : (
              "✓"
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function useGitHub(project: string) {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<GhItem[]>([]);
  const [auto, setAuto] = useState(store.get("ember.gh.auto") !== "0");
  const [hist, setHist] = useState<{ list: View[]; at: number }>({ list: [], at: -1 });
  const [toast, setToast] = useState<GhItem | null>(null);
  const view = hist.list[hist.at];

  const go = useCallback((v: View) => {
    setHist((h) => {
      const list = h.list.slice(0, h.at + 1).concat([v]);
      return { list, at: list.length - 1 };
    });
  }, []);

  useEffect(() => {
    ember<{ items?: GhItem[] }>("github/feed")
      .then((r) => setFeed(r.items ?? []))
      .catch(() => undefined);
  }, []);

  // Opening for the first time: this project's repo, or your GitHub.
  useEffect(() => {
    if (!open || hist.at >= 0) return;
    ember<{ repo?: string }>(`github/project?project=${encodeURIComponent(project)}`)
      .then((r) => go(r.repo ? { kind: "repo", repo: r.repo } : { kind: "home" }))
      .catch(() => go({ kind: "home" }));
  }, [open, hist.at, project, go]);

  const onFeed = useCallback(
    (item: GhItem) => {
      setFeed((f) => {
        const k = f.findIndex((i) => i.id === item.id);
        return k >= 0 ? f.map((i, j) => (j === k ? item : i)) : f.concat([item]).slice(-40);
      });
      if (item.project !== project) return;
      // Follow along: open the panel and go to the pull request or repo being worked on.
      if (auto) setOpen(true);
      setHist((h) => {
        const cur = h.list[h.at];
        let next: View | null = null;
        if (
          item.pr &&
          item.repo &&
          !(cur?.kind === "pr" && cur.repo === item.repo && cur.n === item.pr)
        )
          next = { kind: "pr", repo: item.repo, n: item.pr };
        else if (item.repo && (!cur || cur.kind === "home"))
          next = { kind: "repo", repo: item.repo };
        if (!next) return h;
        const list = h.list.slice(0, h.at + 1).concat([next]);
        return { list, at: list.length - 1 };
      });
      setToast(item);
    },
    [auto, project],
  );

  return {
    open,
    setOpen,
    feed,
    live: busy(feed),
    auto,
    setAuto: (v: boolean) => {
      setAuto(v);
      store.set("ember.gh.auto", v ? "1" : "0");
    },
    view,
    hist,
    setHist,
    go,
    toast,
    setToast,
    onFeed,
  };
}

export function GitHubPanel({ gh }: { gh: ReturnType<typeof useGitHub> }) {
  const [page, setPage] = useState<
    | { kind: "home"; data: Overview }
    | { kind: "repo"; data: RepoPage }
    | { kind: "pr"; data: PrPage }
    | { kind: "error"; message: string }
    | null
  >(null);
  // Which page finished loading: until the one in view does, the address bar shows progress.
  const [doneKey, setDoneKey] = useState("");
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);
  const fresh = useRef(false);
  const { view, open, feed } = gh;

  useEffect(() => {
    if (!open || !view) return;
    let live = true;
    let timer: number | undefined;
    const key = `${JSON.stringify(view)}:${nonce}`;
    const f = fresh.current ? "&fresh=1" : "";
    fresh.current = false;
    const load = async () => {
      try {
        if (view.kind === "home") {
          const data = await ember<Overview>(`github/overview?x=1${f}`);
          if (live) setPage({ kind: "home", data });
        } else if (view.kind === "repo") {
          const data = await ember<RepoPage>(
            `github/repo?repo=${encodeURIComponent(view.repo)}${f}`,
          );
          if (live) setPage({ kind: "repo", data });
        } else {
          const data = await ember<PrPage>(
            `github/pr?repo=${encodeURIComponent(view.repo)}&n=${view.n}${f}`,
          );
          if (!live) return;
          setPage({ kind: "pr", data });
          // Files you opened or closed stay that way when the page refreshes itself.
          setShut((was) =>
            Object.fromEntries(data.files.map((x, i) => [x.name, was[x.name] ?? i > 2])),
          );
          // While checks run (or the agent is still on this PR), keep the page live.
          if (
            data.checks.some((c) =>
              ["pending", "queued", "in_progress", "expected", "waiting"].includes(c.state),
            ) ||
            busy(feed)
          )
            timer = window.setTimeout(() => setNonce((n) => n + 1), 6000);
        }
      } catch (e) {
        if (live) setPage({ kind: "error", message: (e as Error).message });
      } finally {
        if (live) setDoneKey(key);
      }
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, nonce]);

  useEffect(() => {
    if (!gh.toast) return;
    const t = window.setTimeout(() => gh.setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [gh.toast, gh]);

  const loading = Boolean(open && view && doneKey !== `${JSON.stringify(view)}:${nonce}`);
  const url =
    view?.kind === "pr"
      ? `github.com/${view.repo}/pull/${view.n}`
      : view?.kind === "repo"
        ? `github.com/${view.repo}`
        : "github.com";
  const go = (v: View) => (e: React.MouseEvent) => {
    e.preventDefault();
    gh.go(v);
  };
  const prRow = (p: PrRow) => (
    <a
      key={`${p.repo}#${p.number}`}
      className="gh-row"
      href="#"
      onClick={go({ kind: "pr", repo: p.repo, n: p.number })}
    >
      <span className="gh-ico gh-open-c">{PR_ICON}</span>
      <span className="gh-row-main">
        <b>{p.title}</b>
        <small>
          {p.repo} #{p.number} · updated {ago(p.updated)}
          {p.draft ? " · draft" : ""}
        </small>
      </span>
    </a>
  );

  return (
    <aside className="gh-panel" aria-label="GitHub" aria-hidden={!open} data-testid="ember-github">
      <div className="gh-chrome">
        <div className="gh-nav">
          <button
            type="button"
            className="gh-nb"
            title="Back"
            aria-label="Back"
            disabled={gh.hist.at <= 0}
            onClick={() => gh.setHist((h) => ({ ...h, at: Math.max(0, h.at - 1) }))}
          >
            ‹
          </button>
          <button
            type="button"
            className="gh-nb"
            title="Forward"
            aria-label="Forward"
            disabled={gh.hist.at >= gh.hist.list.length - 1}
            onClick={() => gh.setHist((h) => ({ ...h, at: Math.min(h.list.length - 1, h.at + 1) }))}
          >
            ›
          </button>
          <button
            type="button"
            className="gh-nb"
            title="Reload"
            aria-label="Reload"
            onClick={() => {
              fresh.current = true;
              setNonce((n) => n + 1);
            }}
          >
            ↻
          </button>
          <button
            type="button"
            className="gh-nb"
            title="Your GitHub"
            aria-label="Your GitHub"
            onClick={() => gh.go({ kind: "home" })}
          >
            ⌂
          </button>
        </div>
        <div className="gh-addr">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
            />
          </svg>
          <span>{url}</span>
          {loading && <span className="gh-loading" />}
        </div>
        <a
          className="gh-nb"
          href={`https://${url}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on github.com"
          aria-label="Open on github.com"
        >
          ↗
        </a>
        <button
          type="button"
          className="gh-nb"
          title="Close (Esc)"
          aria-label="Close GitHub"
          onClick={() => gh.setOpen(false)}
        >
          ✕
        </button>
      </div>
      <label className="gh-autol">
        <input type="checkbox" checked={gh.auto} onChange={(e) => gh.setAuto(e.target.checked)} />{" "}
        Open by itself when EMBER works on GitHub
      </label>
      <div className="gh-page">
        {page?.kind === "error" && (
          <div className="gh-empty">
            <b>Couldn&apos;t load this page</b>
            <span>{page.message}</span>
          </div>
        )}
        {page?.kind === "home" && (
          <>
            <div className="gh-hero">
              <img src={page.data.user.avatar} alt="" />
              <div>
                <b>{page.data.user.name || page.data.user.login}</b>
                <small>@{page.data.user.login}</small>
              </div>
            </div>
            <h3>
              Your open pull requests <span className="gh-count">{page.data.prs.length}</span>
            </h3>
            {page.data.prs.length ? (
              page.data.prs.map(prRow)
            ) : (
              <div className="gh-none">No open pull requests.</div>
            )}
            {page.data.review.length > 0 && (
              <>
                <h3>
                  Waiting for your review{" "}
                  <span className="gh-count">{page.data.review.length}</span>
                </h3>
                {page.data.review.map(prRow)}
              </>
            )}
            <h3>Recent repositories</h3>
            {page.data.repos.map((r) => (
              <a
                key={r.full}
                className="gh-row"
                href="#"
                onClick={go({ kind: "repo", repo: r.full })}
              >
                <span className="gh-ico">{GH_ICON}</span>
                <span className="gh-row-main">
                  <b>{r.full}</b>
                  <small>
                    {r.private ? "Private · " : ""}
                    {r.language ?? ""}
                    {r.language ? " · " : ""}pushed {ago(r.pushed)}
                  </small>
                </span>
              </a>
            ))}
          </>
        )}
        {page?.kind === "repo" && (
          <>
            <div className="gh-title">
              <span className="gh-ico">{GH_ICON}</span>
              <div>
                <b>{page.data.full}</b>
                <small>
                  {page.data.private ? "Private" : "Public"} · {page.data.default_branch}
                  {page.data.language ? ` · ${page.data.language}` : ""}
                </small>
              </div>
            </div>
            {page.data.description && <p className="gh-desc">{page.data.description}</p>}
            <LiveSteps feed={feed} repo={page.data.full} />
            <h3>Pull requests</h3>
            {page.data.pulls.length ? (
              page.data.pulls.map((p) => (
                <a
                  key={p.number}
                  className="gh-row"
                  href="#"
                  onClick={go({ kind: "pr", repo: page.data.full, n: p.number })}
                >
                  <span
                    className={`gh-ico gh-${p.draft && p.state === "open" ? "draft" : p.state}-c`}
                  >
                    {PR_ICON}
                  </span>
                  <span className="gh-row-main">
                    <b>{p.title}</b>
                    <small>
                      #{p.number} · {p.head} · {p.state} · {ago(p.updated)}
                    </small>
                  </span>
                </a>
              ))
            ) : (
              <div className="gh-none">No pull requests yet.</div>
            )}
            <h3>Latest commits on {page.data.default_branch}</h3>
            <div className="gh-commits">
              {page.data.commits.map((c) => (
                <div key={c.sha} className="gh-commit">
                  <code>{c.sha}</code>
                  <span>{c.message}</span>
                  <small>
                    {c.author} · {ago(c.date)}
                  </small>
                </div>
              ))}
            </div>
            <h3>
              Branches <span className="gh-count">{page.data.branches.length}</span>
            </h3>
            <div className="gh-branches">
              {page.data.branches.map((b) => (
                <span key={b} className="gh-branch">
                  {b}
                </span>
              ))}
            </div>
          </>
        )}
        {page?.kind === "pr" &&
          (() => {
            const p = page.data;
            const ck = p.checks;
            const okN = ck.filter((c) =>
              ["success", "neutral", "skipped"].includes(c.state),
            ).length;
            const bad = ck.filter((c) =>
              ["failure", "error", "cancelled", "timed_out", "action_required"].includes(c.state),
            ).length;
            const running = ck.length - okN - bad;
            const sum = !ck.length
              ? "No checks"
              : bad
                ? `${bad} failing`
                : running
                  ? `${running} running`
                  : "All checks passed";
            return (
              <>
                <div className="gh-prhead">
                  <h2>
                    {p.title} <span className="gh-num">#{p.number}</span>
                  </h2>
                  <div className="gh-prmeta">
                    <StateBadge state={p.state} draft={p.draft} />
                    <span>
                      <b>{p.author}</b> wants to merge <span className="gh-branch">{p.head}</span>{" "}
                      into <span className="gh-branch">{p.base}</span>
                    </span>
                  </div>
                </div>
                <div className="gh-stats">
                  <span>
                    <b>{p.commits.length}</b> commits
                  </span>
                  <span>
                    <b>{p.changed}</b> files
                  </span>
                  <span className="gh-add">+{p.additions}</span>
                  <span className="gh-del">−{p.deletions}</span>
                  <span>{ago(p.updated)}</span>
                </div>
                <LiveSteps feed={feed} repo={view?.kind === "pr" ? view.repo : undefined} />
                <div
                  className={`gh-checks ${bad ? "bad" : running ? "run" : ck.length ? "ok" : ""}`}
                >
                  <div className="gh-checks-h">
                    <span className="gh-dot" />
                    <b>{sum}</b>
                    {p.review && <small>{p.review.replace(/_/g, " ").toLowerCase()}</small>}
                  </div>
                  {ck.map((c) => (
                    <div key={c.name} className={`gh-check s-${c.state}`}>
                      <span className="gh-dot" />
                      {c.name}
                      <small>{c.state.replace(/_/g, " ")}</small>
                    </div>
                  ))}
                </div>
                {p.body && (
                  // md() escapes the text first; only its own few tags become HTML.
                  <div
                    className="gh-body md"
                    dangerouslySetInnerHTML={{ __html: md(p.body.slice(0, 6000)) }}
                  />
                )}
                <h3>Commits</h3>
                <div className="gh-commits">
                  {p.commits.map((c) => (
                    <div key={c.sha} className="gh-commit">
                      <code>{c.sha}</code>
                      <span>{c.message}</span>
                      <small>{c.author ?? ""}</small>
                    </div>
                  ))}
                </div>
                <h3>
                  Files changed <span className="gh-count">{p.files.length}</span>
                </h3>
                {p.files.map((f) => (
                  <div key={f.name} className={`gh-file ${shut[f.name] ? "shut" : ""}`}>
                    <div
                      className="gh-file-h"
                      role="button"
                      tabIndex={0}
                      onClick={() => setShut((s) => ({ ...s, [f.name]: !s[f.name] }))}
                      onKeyDown={(e) =>
                        e.key === "Enter" && setShut((s) => ({ ...s, [f.name]: !s[f.name] }))
                      }
                    >
                      <span className={`gh-fs gh-fs-${f.status}`}>
                        {(f.status[0] ?? "?").toUpperCase()}
                      </span>
                      <code>{f.name}</code>
                      <span className="gh-add">+{f.additions}</span>
                      <span className="gh-del">−{f.deletions}</span>
                      <span className="gh-chev">▾</span>
                    </div>
                    <Diff patch={f.patch} />
                  </div>
                ))}
              </>
            );
          })()}
      </div>
      {gh.toast && (
        <div className="gh-toast" role="status" aria-live="polite">
          <span className="gh-step-i">{STEP_ICON[gh.toast.step] ?? "•"}</span>
          {gh.toast.state === "running"
            ? `${gh.toast.label}…`
            : gh.toast.label + (gh.toast.state === "failed" ? " failed" : " ✓")}
        </div>
      )}
    </aside>
  );
}
