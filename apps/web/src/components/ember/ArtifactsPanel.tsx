import { useEffect, useState } from "react";
import { ember, emberFetch, md, previewBase, type ProjectFile } from "./engine";

/**
 * Artifacts: what the agent made in this project, and copies of your claude.ai artifacts that
 * EMBER keeps. Previews come from EMBER's sandboxed preview addresses (a page shown there can't
 * reach Hearth or EMBER), the raw text through EMBER's file route.
 */

interface ClaudeArtifact {
  id: string;
  title: string;
  url?: string;
  updated?: string;
  note?: string;
  entry?: string;
  size?: number;
}

type Item =
  | { src: "project"; project: string; path: string; kind: string; size: number; title: string }
  | { src: "claude"; path: string; kind: string; size: number; title: string; url?: string };

const kindOf = (name: string) => {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  return ["html", "htm"].includes(e)
    ? "html"
    : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)
      ? "image"
      : e === "md"
        ? "markdown"
        : "text";
};
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const KIND: Record<string, string> = {
  html: "Page",
  image: "Image",
  markdown: "Document",
  text: "Text",
  pdf: "PDF",
  audio: "Audio",
  video: "Video",
  type: "Claude",
};
const HIDE = /^(\.ember\/|CLAUDE\.md$|AGENTS\.md$|\.gitignore$|\.git\/|node_modules\/)/;

export function ArtifactsPanel({
  open,
  project,
  projectName,
  start,
  onClose,
}: {
  open: boolean;
  project: string;
  projectName: string;
  /** A file to show first (from the project files list). */
  start?: ProjectFile | null;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<"project" | "claude">("project");
  // What was loaded, and for which list: a different list shows "Loading…" until it arrives.
  const [loaded, setLoaded] = useState<{
    key: string;
    items: Item[] | null;
    note: string;
    err: string | null;
  }>({ key: "", items: null, note: "", err: null });
  // Opened from the files list (the panel is remounted per file): that file first.
  const [sel, setSel] = useState<Item | null>(
    start
      ? {
          src: "project",
          project,
          path: start.path,
          kind: start.kind,
          size: start.size,
          title: start.path,
        }
      : null,
  );
  const [q, setQ] = useState("");
  const listKey = `${src}|${project}`;
  const current = loaded.key === listKey ? loaded : null;
  const items = current?.items ?? null;
  const note = current?.note ?? "";
  const err = current?.err ?? null;

  useEffect(() => {
    if (!open) return;
    let live = true;
    const setItems = (list: Item[], text: string) =>
      setLoaded({ key: listKey, items: list, note: text, err: null });
    const load = async () => {
      try {
        if (src === "claude") {
          // Kept on your main Hearth, whichever PC this War Room is on.
          const idx = await ember<{ synced_at: string | null; artifacts: ClaudeArtifact[] }>(
            "claude-artifacts",
            { on: null },
          );
          if (!live) return;
          const text = idx.synced_at
            ? `Copies of your claude.ai artifacts, synced ${new Date(idx.synced_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. To refresh, ask Claude Code to "sync my Claude artifacts into Hearth".`
            : `Not synced yet. Ask Claude Code to "sync my Claude artifacts into Hearth".`;
          setItems(
            idx.artifacts.map((a) => ({
              src: "claude",
              title: a.title,
              url: a.url,
              path: a.entry ? `${a.id}/${a.entry}` : "",
              kind: a.entry ? kindOf(a.entry) : "type",
              size: a.size ?? 0,
            })),
            text,
          );
        } else {
          const files = await ember<ProjectFile[]>(`projects/${encodeURIComponent(project)}/files`);
          if (!live) return;
          setItems(
            files
              .filter((f) => !HIDE.test(f.path))
              .sort((a, b) => b.mtime - a.mtime)
              .map((f) => ({
                src: "project",
                project,
                path: f.path,
                kind: f.kind,
                size: f.size,
                title: f.path,
              })),
            `Files in ${projectName}.`,
          );
        }
      } catch (e) {
        if (live) setLoaded({ key: listKey, items: [], note: "", err: (e as Error).message });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [open, src, project, projectName, listKey]);

  const shown = (items ?? []).filter((i) => !q || i.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <aside
      className="gh-panel art-panel"
      aria-label="Artifacts"
      aria-hidden={!open}
      data-testid="ember-artifacts"
    >
      <div className="gh-chrome">
        <div className="viewseg" role="tablist" aria-label="Which artifacts">
          {(["project", "claude"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={src === s}
              onClick={() => {
                setSrc(s);
                setSel(null);
              }}
            >
              {s === "project" ? "This project" : "Claude artifacts"}
            </button>
          ))}
        </div>
        <div className="gh-addr">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find…"
            aria-label="Find an artifact"
            className="art-find"
          />
        </div>
        <button
          type="button"
          className="gh-nb"
          title="Close"
          aria-label="Close Artifacts"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {sel ? (
        <Viewer
          key={`${sel.src}:${sel.path}:${sel.title}`}
          item={sel}
          onBack={() => setSel(null)}
        />
      ) : (
        <div className="gh-page">
          <p className="gh-none">{note}</p>
          {err && (
            <div className="gh-empty">
              <b>Couldn&apos;t load artifacts</b>
              <span>{err}</span>
            </div>
          )}
          {!items && !err && <p className="gh-none">Loading…</p>}
          {items && !err && !shown.length && (
            <div className="gh-empty">
              <b>Nothing here yet</b>
              <span>
                {src === "claude"
                  ? 'Ask Claude Code to "sync my Claude artifacts into Hearth" and they appear here, on every PC and device.'
                  : "Ask EMBER to build something in this project, and what it makes shows up here."}
              </span>
            </div>
          )}
          {shown.map((i) => (
            <a
              key={i.src + i.path + i.title}
              className="gh-row"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (i.kind === "type" && i.src === "claude" && i.url)
                  window.open(i.url, "_blank", "noopener");
                else setSel(i);
              }}
            >
              <span className="gh-ico">{(KIND[i.kind] ?? "File").slice(0, 1)}</span>
              <span className="gh-row-main">
                <b>{i.src === "claude" ? i.title : i.path.split("/").pop()}</b>
                <small>
                  {KIND[i.kind] ?? i.kind}
                  {i.src === "project" ? ` · ${i.path}` : ""}
                </small>
              </span>
            </a>
          ))}
        </div>
      )}
    </aside>
  );
}

/** One file. Remounted per file (its key), so it starts empty each time. */
function Viewer({ item, onBack }: { item: Item; onBack: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const raw = (dl = false) =>
    (item.src === "claude"
      ? `claude-artifacts/file?path=${encodeURIComponent(item.path)}`
      : `projects/${encodeURIComponent(item.project)}/file?path=${encodeURIComponent(item.path)}`) +
    (dl ? "&download=1" : "");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        if (["html", "image", "audio", "video", "pdf"].includes(item.kind)) {
          const key = await ember<{ base: string }>(
            item.src === "claude"
              ? "claude-artifacts/preview"
              : `projects/${encodeURIComponent(item.project)}/preview`,
            { body: {}, ...(item.src === "claude" ? { on: null } : {}) },
          );
          if (live)
            setUrl(
              previewBase(key.base, item.src === "claude" ? null : undefined) + enc(item.path),
            );
        } else {
          const r = await emberFetch(raw(), item.src === "claude" ? { on: null } : {});
          if (!r.ok) throw new Error("couldn't read the file");
          const t = await r.text();
          if (live) setText(t);
        }
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };
    void load();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const name = item.src === "claude" ? item.title : (item.path.split("/").pop() ?? item.path);
  return (
    <div className="art-view">
      <div className="art-view-h">
        <button type="button" className="btn small" onClick={onBack}>
          ‹ All
        </button>
        <b title={item.path}>{name}</b>
        <a className="btn small" href={`/api/engine/${raw(true)}`}>
          Download
        </a>
        {url && (
          <a className="btn small" href={url} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>
        )}
      </div>
      <div className="art-view-b">
        {err && <p className="err">{err}</p>}
        {url && item.kind === "html" && (
          <iframe
            src={url}
            title={name}
            sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups"
          />
        )}
        {url && item.kind === "image" && <img src={url} alt={name} />}
        {url && item.kind === "audio" && <audio controls src={url} />}
        {url && item.kind === "video" && <video controls src={url} />}
        {url && item.kind === "pdf" && <iframe src={url} title={name} />}
        {text != null &&
          (item.kind === "markdown" ? (
            // md() escapes the text first; only its own few tags become HTML.
            <article className="md" dangerouslySetInnerHTML={{ __html: md(text) }} />
          ) : (
            <pre className="art-code">{text}</pre>
          ))}
      </div>
    </div>
  );
}
