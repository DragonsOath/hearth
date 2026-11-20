import { execFileSync } from "node:child_process";
import { isProjectColor, type ProjectColor } from "@dragon-control/core";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HOMELAB_SLUG } from "./homelab";
import type { EngineStore } from "./store";

/** How Hearth's Homelab brief starts (earlier versions too), to tell it from the owner's own. */
const OUR_BRIEF = /^(This homelab|The owner's homelab)\b/;

/**
 * Projects (ported from EMBER): the folders the engine works in, each with its own git history
 * and its own ongoing conversation. Hearth keeps each project's memory current inside the folder,
 * so Claude Code (CLAUDE.md, with @imports) and Codex (AGENTS.md) start every session already
 * knowing the owner's documents, photos, and the conversation so far.
 */

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  "dist-cache",
]);
const TEXT_EXT = new Set(
  ".md .txt .py .js .ts .jsx .tsx .json .yaml .yml .toml .css .html .htm .sh .csv .xml .svg .ini .cfg .sql .rs .go .java .c .h .cpp .lua .gd .kt .swift .rb .php .log".split(
    " ",
  ),
);
const IMAGE_EXT = new Set(".png .jpg .jpeg .gif .webp .bmp .ico .svg".split(" "));
/** Long enough for the Homelab project's brief, with room for the owner's additions. */
export const DESCRIPTION_MAX = 8000;
const DOC_MAX = 150_000; // documents up to this size are loaded into Claude's context in full
const CTX_START =
  "<!-- HEARTH:context:start (kept up to date by Hearth; edits inside are replaced) -->";
const CTX_END = "<!-- HEARTH:context:end -->";

export class ProjectError extends Error {}

export interface Project {
  slug: string;
  name: string;
  description: string;
  path: string;
  engine: string;
  model: string | null;
  /** Created in Hearth (false for the built-in sandbox). */
  created: boolean;
  /** Its color on Home (PROJECT_COLORS); absent keeps the plain card. */
  color?: ProjectColor;
  /** Hearth's old Homelab project (made by earlier versions when it found homelab apps here). */
  homelab?: boolean;
  /**
   * Kept so its conversation can still be read, but no longer a tab or a Home card: the Lair is
   * the homelab zone now (10-30).
   */
  archived?: boolean;
}

export interface ProjectFile {
  path: string;
  size: number;
  mtime: number;
  kind: string;
}

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function kindOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  if (ext === ".html" || ext === ".htm") return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === ".md") return "markdown";
  if (
    TEXT_EXT.has(ext) ||
    ["Makefile", "Dockerfile", ".gitignore", "LICENSE", "README"].includes(base)
  )
    return "text";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  return "binary";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
};
export function contentType(file: string) {
  const ext = path.extname(file).toLowerCase();
  return (
    CONTENT_TYPES[ext] ??
    (["text", "markdown"].includes(kindOf(file))
      ? "text/plain; charset=utf-8"
      : "application/octet-stream")
  );
}

// The description itself lives in Hearth's section (below), so an edit reaches the agent.
const INSTRUCTIONS = (name: string) => `# ${name}

What this project is, in the owner's words, is in the Hearth section below.

## Working here
- This folder is the whole project: code, documents, photos, and the conversation Hearth keeps.
- The owner's documents and photos are listed in the Hearth section below. Read them before deciding how to build.
- Commit your changes when you finish a piece of work.
- Say in your reply which file to open to see the result.
`;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", windowsHide: true });
}

export class Projects {
  private readonly fixed: Record<string, Project>;

  constructor(
    private readonly store: EngineStore,
    readonly workspaces: string,
  ) {
    // The sandbox: a scratch project that always exists.
    const sandbox = path.join(workspaces, "sandbox");
    if (!existsSync(sandbox)) {
      mkdirSync(sandbox, { recursive: true });
      writeFileSync(path.join(sandbox, "CLAUDE.md"), INSTRUCTIONS("Sandbox"));
      try {
        git(sandbox, "init", "-q");
      } catch {
        /* git is optional for the sandbox */
      }
    }
    this.fixed = {
      sandbox: {
        slug: "sandbox",
        name: "Sandbox",
        description: "Hearth's scratch project for trying tasks.",
        path: sandbox,
        engine: "claude-code",
        model: null,
        created: false,
      },
    };
  }

  get(slug: string): Project {
    const fixed = this.fixed[slug];
    if (fixed) return fixed;
    const row = this.store.projectRow(slug);
    if (!row || row.archived) throw new ProjectError(`unknown project '${slug}'`);
    return {
      slug: row.slug,
      name: row.name,
      description: row.description ?? "",
      path: row.path,
      engine: "claude-code",
      model: null,
      created: true,
      ...(isProjectColor(row.color) ? { color: row.color } : {}),
      ...(row.slug === this.hearthsHomelab() ? { homelab: true, archived: true } : {}),
    };
  }

  has(slug: string) {
    try {
      this.get(slug);
      return true;
    } catch {
      return false;
    }
  }

  list(): (Project & { messages: number; active: number; last: string | null })[] {
    const stats = this.store.projectStats();
    // The Sandbox, the owner's projects in the order they were made, the old Homelab last.
    const rows = this.store.projectRows();
    const old = this.hearthsHomelab();
    const all = [
      ...Object.values(this.fixed),
      ...rows.filter((r) => r.slug !== old).map((r) => this.get(r.slug)),
      ...rows.filter((r) => r.slug === old).map((r) => this.get(r.slug)),
    ];
    return all.map((p) => ({
      ...p,
      messages: stats[p.slug]?.messages ?? 0,
      active: stats[p.slug]?.active ?? 0,
      last: stats[p.slug]?.last ?? null,
    }));
  }

  create(name: string, description: string, folder?: string, color?: ProjectColor): Project {
    name = (name ?? "").trim();
    if (!name) throw new ProjectError("a project needs a name");
    const slug = folder ?? slugify(name);
    if (!slug) throw new ProjectError("use letters or numbers in the name");
    if (this.has(slug) || this.store.projectRow(slug))
      throw new ProjectError(`a project called '${slug}' already exists`);
    const dir = path.join(this.workspaces, slug);
    if (existsSync(dir)) throw new ProjectError(`folder ${dir} already exists`);
    const desc = (description ?? "").trim() || `${name}.`;
    mkdirSync(dir, { recursive: true });
    const text = INSTRUCTIONS(name);
    writeFileSync(path.join(dir, "CLAUDE.md"), text);
    writeFileSync(path.join(dir, "AGENTS.md"), text);
    writeFileSync(
      path.join(dir, "README.md"),
      `# ${name}\n\n${desc.split("\n")[0]}\n\nCreated with Hearth on ${new Date().toISOString().slice(0, 10)}.\n`,
    );
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "Hearth");
      git(dir, "config", "user.email", "hearth@localhost");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", `Start ${name}`);
    } catch {
      /* without git the project still works; Claude can set it up */
    }
    this.store.addProject({ slug, name, description: desc, path: dir });
    if (color) this.store.setColor(slug, color);
    return this.get(slug);
  }

  /**
   * A new name or description (right-click a tab). Its folder keeps its name, so nothing that
   * points at it breaks; the agent reads the new description from then on.
   */
  edit(
    slug: string,
    change: { name?: string; description?: string; color?: ProjectColor | null },
  ): Project {
    if (this.fixed[slug]) throw new ProjectError("the scratch project keeps its name");
    this.get(slug);
    if (change.name !== undefined) {
      const name = change.name.trim().slice(0, 80);
      if (!name) throw new ProjectError("a project needs a name");
      this.store.setName(slug, name);
    }
    if (change.description !== undefined)
      this.store.setDescription(slug, change.description.trim().slice(0, DESCRIPTION_MAX));
    if (change.color !== undefined) this.store.setColor(slug, change.color);
    return this.get(slug);
  }

  /**
   * Deletes a project for good: its folder and every file in it, and what Hearth keeps about it.
   * The Sandbox stays. Only folders Hearth made (inside its projects folder) are removed.
   */
  remove(slug: string) {
    if (this.fixed[slug]) throw new ProjectError("the Sandbox can't be deleted");
    const p = this.get(slug);
    const root = path.resolve(this.workspaces);
    const dir = path.resolve(p.path);
    const inside = path.relative(root, dir);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
      throw new ProjectError("that project's folder is outside Hearth's projects folder");
    // Deleting Hearth's own Homelab is the owner's decision: it is not made again after that.
    if (this.isHearthsHomelab(slug)) this.store.setSetting("homelab_project_removed", true);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    this.store.deleteProject(slug);
  }

  /** Whether this project is the Homelab Hearth made (not the owner's own "homelab" folder). */
  private isHearthsHomelab(slug: string) {
    return slug === this.hearthsHomelab();
  }

  /** The folder name of the Homelab project an earlier Hearth made here, if there is one. */
  hearthsHomelab(): string | undefined {
    const set = this.store.setting<string>("homelab_project_slug", "");
    if (set) return this.store.projectRow(set) ? set : undefined;
    const row = this.store.projectRow(HOMELAB_SLUG);
    return row && OUR_BRIEF.test(row.description ?? "") ? HOMELAB_SLUG : undefined;
  }

  /** Live notes on the homelab (Hearth's snapshot of the machines), set by Hearth. */
  homelabNotes = "";

  /**
   * The Lair's notebook folder, where its agent works with Full access on: the old Homelab
   * project's folder when there is one (its notes and config backups carry on), otherwise a
   * "lair" folder beside the projects.
   */
  lairFolder(): string {
    const old = this.hearthsHomelab();
    if (old) return this.get(old).path;
    const dir = path.join(this.workspaces, ".lair");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Writes the live snapshot into the Lair's folder, so a Full-access Lair can read it there. */
  writeLairSnapshot() {
    if (!this.homelabNotes) return;
    try {
      const hd = path.join(this.lairFolder(), ".hearth");
      mkdirSync(hd, { recursive: true });
      writeFileSync(path.join(hd, "homelab.md"), this.homelabNotes);
    } catch {
      /* the snapshot also goes with each Lair message; the file is a convenience */
    }
  }

  /* ---------- files ---------- */

  files(slug: string, limit = 3000): ProjectFile[] {
    const root = this.get(slug).path;
    const out: ProjectFile[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (SKIP_DIRS.has(e)) continue;
        const full = path.join(dir, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else if (st.isFile())
          out.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            size: st.size,
            mtime: st.mtimeMs / 1000,
            kind: kindOf(full),
          });
      }
    };
    walk(root);
    return out;
  }

  /** A file inside the project (never outside it, never in .git or similar). */
  resolve(slug: string, rel: string): string {
    const root = path.resolve(this.get(slug).path);
    const f = path.resolve(root, rel);
    const inside = path.relative(root, f);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
      throw new ProjectError("path outside the project");
    if (inside.split(path.sep).some((part) => SKIP_DIRS.has(part)))
      throw new ProjectError("hidden folder");
    if (!existsSync(f) || !statSync(f).isFile()) throw new ProjectError("no such file");
    return f;
  }

  /** A file added straight to the project (Project files panel), under attachments/<date>/. */
  saveUpload(slug: string, name: string, data: Buffer): string {
    const root = this.get(slug).path;
    const folder = path.join(root, "attachments", new Date().toISOString().slice(0, 10));
    mkdirSync(folder, { recursive: true });
    const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, "_") || "file";
    const dot = safe.lastIndexOf(".");
    let target = path.join(folder, safe);
    for (let n = 2; existsSync(target); n++)
      target = path.join(
        folder,
        dot > 0 ? `${safe.slice(0, dot)}-${n}${safe.slice(dot)}` : `${safe}-${n}`,
      );
    writeFileSync(target, data);
    return path.relative(root, target).split(path.sep).join("/");
  }

  /* ---------- the project's memory, rewritten before each run ---------- */

  syncContext(slug: string) {
    const p = this.get(slug);
    const root = p.path;
    if (!existsSync(root)) return;
    const hd = path.join(root, ".hearth");
    mkdirSync(hd, { recursive: true });
    const msgs = this.store.messages(slug, 1_000_000);
    const who: Record<string, string> = {
      you: "Owner",
      ember: "Agent",
      sys: "Hearth",
      ask: "Hearth (question)",
    };
    const render = (rows: typeof msgs) =>
      rows
        .map((m) => {
          let name = who[m.role] ?? m.role;
          const engine = m.meta?.split(" ·")[0];
          if (m.role === "ember" && (engine === "Claude Code" || engine === "Codex")) name = engine;
          return `### ${name} · ${m.at.slice(0, 16).replace("T", " ")}\n\n${m.text.trim()}\n`;
        })
        .join("\n") || "_No messages yet._\n";
    writeFileSync(
      path.join(hd, "chat.md"),
      `# Conversation: ${p.name}\n\nThe full chat between the owner and the agent, oldest first.\n\n` +
        render(msgs),
    );
    writeFileSync(
      path.join(hd, "recent-chat.md"),
      "# Recent conversation (latest 40 messages, oldest first)\n\n" + render(msgs.slice(-40)),
    );

    const files = this.files(slug).filter((f) => !f.path.startsWith(".hearth/"));
    const rules = new Set(["CLAUDE.md", "AGENTS.md"]);
    const docs = files.filter(
      (f) =>
        (f.kind === "markdown" || f.kind === "text") &&
        !rules.has(f.path) &&
        (f.path.startsWith("attachments/") ||
          f.path.startsWith("docs/") ||
          !f.path.includes("/")) &&
        [".md", ".txt"].includes(path.extname(f.path).toLowerCase()),
    );
    const images = files.filter((f) => f.kind === "image");
    const other = files.filter(
      (f) => !docs.includes(f) && !images.includes(f) && !rules.has(f.path),
    );
    const size = (n: number) =>
      n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    const title = (f: ProjectFile) => {
      try {
        const line = readFileSync(path.join(root, f.path), "utf8")
          .split("\n")
          .slice(0, 15)
          .find((l) => l.startsWith("#"));
        return line ? `: ${line.replace(/^#+\s*/, "").slice(0, 100)}` : "";
      } catch {
        return "";
      }
    };
    const folders: Record<string, number> = {};
    for (const f of other) {
      const top = f.path.includes("/") ? f.path.split("/")[0]! : "(top level)";
      folders[top] = (folders[top] ?? 0) + 1;
    }
    const idx = [
      `# Project files: ${p.name}`,
      "",
      "Everything in this project folder (paths are relative to it).",
      "",
      "## Documents",
      "",
      ...(docs.length
        ? docs.map((f) => `- \`${f.path}\` (${size(f.size)})${title(f)}`)
        : ["_none_"]),
      "",
      "## Photos and images (open them with the Read tool to see them)",
      "",
      ...(images.length ? images.map((f) => `- \`${f.path}\` (${size(f.size)})`) : ["_none_"]),
      "",
      "## Other files",
      "",
      ...(Object.keys(folders).length
        ? Object.entries(folders)
            .sort()
            .map(([k, v]) =>
              k === "(top level)" ? `- top level: ${v} file(s)` : `- \`${k}/\`: ${v} file(s)`,
            )
        : ["_none_"]),
    ];
    writeFileSync(path.join(hd, "files.md"), idx.join("\n") + "\n");

    const homelab = slug === this.hearthsHomelab() && Boolean(this.homelabNotes);
    if (homelab) writeFileSync(path.join(hd, "homelab.md"), this.homelabNotes);
    const about = [
      "### What this project is (the owner's description; where it differs from anything above, this wins)",
      "",
      p.description.trim() || "_No description yet._",
      "",
    ];

    const loaded = docs.filter((f) => f.size <= DOC_MAX);
    const big = docs.filter((f) => f.size > DOC_MAX);
    const block = [
      CTX_START,
      "## Everything Hearth knows about this project",
      "",
      `The owner works on **${p.name}** through Hearth's War Room. Their messages there are typed straight to ` +
        "you, as if in Claude Code in this folder. Treat this section as the project's memory: their documents, " +
        "their photos, and the conversation so far.",
      "",
      ...about,
      ...(homelab
        ? [
            "### Live snapshot of the homelab (refreshed by Hearth every few minutes)",
            "",
            "@.hearth/homelab.md",
            "",
          ]
        : []),
      "### The owner's documents (loaded in full)",
      "",
      ...(loaded.length ? loaded.map((f) => `@${f.path}`) : ["_none yet_"]),
      ...(big.length
        ? [
            "",
            "Too large to load automatically; read when needed: " +
              big.map((f) => `\`${f.path}\``).join(", "),
          ]
        : []),
      "",
      "### Files and photos in this project",
      "",
      "@.hearth/files.md",
      "",
      "### Conversation so far",
      "",
      "@.hearth/recent-chat.md",
      "",
      "The complete history is in `.hearth/chat.md`.",
      CTX_END,
    ].join("\n");
    this.putBlock(path.join(root, "CLAUDE.md"), block, p);
    const codex = [
      CTX_START,
      "## Everything Hearth knows about this project",
      "",
      "The owner talks to you through Hearth.",
      "",
      ...about,
      "Before working, read these files:",
      "",
      ...(homelab ? ["- `.hearth/homelab.md` (live snapshot of the homelab, from Hearth)"] : []),
      ...docs.map((f) => `- \`${f.path}\``),
      "- `.hearth/files.md` (all files and photos)",
      "- `.hearth/recent-chat.md` (the conversation so far; full log in `.hearth/chat.md`)",
      CTX_END,
    ].join("\n");
    this.putBlock(path.join(root, "AGENTS.md"), codex, p);
    const gi = path.join(root, ".gitignore");
    const lines = existsSync(gi) ? readFileSync(gi, "utf8").split("\n").filter(Boolean) : [];
    if (!lines.includes(".hearth/")) writeFileSync(gi, [...lines, ".hearth/"].join("\n") + "\n");
  }

  private putBlock(file: string, block: string, p: Project) {
    let text = existsSync(file) ? readFileSync(file, "utf8") : `# ${p.name}\n\n${p.description}\n`;
    const a = text.indexOf(CTX_START);
    const b = text.indexOf(CTX_END);
    if (a >= 0 && b > a) text = text.slice(0, a) + block + text.slice(b + CTX_END.length);
    else text = text.trimEnd() + "\n\n" + block + "\n";
    writeFileSync(file, text);
  }
}
