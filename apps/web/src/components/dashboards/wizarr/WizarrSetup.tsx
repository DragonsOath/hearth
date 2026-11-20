import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Eye,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  WIZARR_THEMES,
  isDesignStep,
  restyleStep,
  stepTheme,
  type WizarrAdminRead,
  type WizarrSettings,
  type WizarrStep,
  type WizarrStepCategory,
  type WizarrWizard,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../../data/api";
import { keyPageHref } from "../../../lib/keyPage";
import { Skeleton, cx } from "../../ui";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Check, Field, SubNav, btn, btnBad, btnGold, input } from "../radarr/common";
import { WizarrPage, useWizarr } from "./shared";
import { Preview, ThemePicker, WizarrDesigns, designSteps } from "./designs";

/**
 * Wizarr's own setup, in the panel's Settings tab, as Wizarr lays it out: General (its settings and
 * cleaning expired users) and Wizard (the guide people see before and after they accept an
 * invitation, one set per media server). Wizarr keeps these behind its admin sign-in, which its API
 * key cannot open, so the owner adds that sign-in once; Hearth uses it only at Wizarr's own address
 * and never shows it. Every change is a plan you confirm here, and Hearth reads Wizarr back
 * afterwards.
 */

const SERVER_NAME: Record<string, string> = {
  plex: "Plex",
  jellyfin: "Jellyfin",
  emby: "Emby",
  audiobookshelf: "Audiobookshelf",
  romm: "RomM",
  komga: "Komga",
  kavita: "Kavita",
};
const serverName = (s: string) => SERVER_NAME[s] ?? s;
const LISTS: { category: WizarrStepCategory; title: string; hint: string }[] = [
  {
    category: "pre_invite",
    title: "Before they accept",
    hint: "Shown before someone accepts the invitation.",
  },
  {
    category: "post_invite",
    title: "After they accept",
    hint: "Shown once they have an account: how to get the app, house rules.",
  },
];

function useWizarrAdmin<T>(serviceId: string, what: "wizard" | "settings") {
  // Under the panel's dashboard key, so a confirmed change refreshes it too.
  return useQuery({
    queryKey: ["dashboard", serviceId, "wizarr-admin", what],
    queryFn: () =>
      api<WizarrAdminRead<T>>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/wizarr/${what}`,
      ),
  });
}

const field = input;

/** Adds Wizarr's admin sign-in to the vault, for its setup pages. */
function AdminSignIn({
  serviceId,
  name,
  read,
}: {
  serviceId: string;
  name: string;
  read: Extract<WizarrAdminRead<unknown>, { ok: false }>;
}) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  if (read.needs === "other")
    return (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="wizarr-admin-error"
      >
        <p className="text-amber">{name}&apos;s setup could not be read right now.</p>
        <p className="mt-1 text-muted">{read.message}</p>
      </div>
    );
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-bg/50 p-4 text-[0.86rem]"
      aria-label={`${name} admin sign-in`}
      data-testid="wizarr-admin-signin"
      onSubmit={(e) => {
        e.preventDefault();
        if (!username.trim() || !password) return;
        setSaving(true);
        setError(undefined);
        api("POST", "/api/vault/secrets", {
          name: `${name} admin sign-in`,
          kind: "login",
          tier: "automation",
          serviceId,
          username: username.trim(),
          value: password,
          scope: "approved-changes",
        })
          .then(() => {
            setPassword("");
            return qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSaving(false));
      }}
    >
      <p className="flex items-center gap-2 text-ink">
        <KeyRound strokeWidth={1.5} className="h-4 w-4 text-gold" />
        {read.needs === "login"
          ? `Connect ${name}'s admin sign-in`
          : `${name} refused the admin sign-in`}
      </p>
      <p className="text-muted">
        {read.needs === "login"
          ? `${name} keeps its settings and invite steps behind its admin sign-in, which the API key cannot open. Add the username and password you use for ${name}'s admin page. It goes in Secure Vault, is only sent to ${name}, and is never shown again. Every change is still a plan you confirm.`
          : read.message}
      </p>
      {read.needs !== "passkey" && (
        <div className="flex flex-wrap gap-2">
          <input
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-label="Admin username"
            placeholder="Admin username"
            className={cx(field, "w-auto min-w-0 flex-1")}
            data-testid="wizarr-admin-username"
          />
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Admin password"
            placeholder="Admin password"
            className={cx(field, "w-auto min-w-0 flex-1")}
            data-testid="wizarr-admin-password"
          />
          <button
            type="submit"
            className={btnGold}
            disabled={saving || !username.trim() || !password}
            data-testid="wizarr-admin-save"
            data-hearth-target="admin:connect"
          >
            Connect
          </button>
        </div>
      )}
      {error && <p className="text-amber">{error}</p>}
      {read.needs !== "login" && (
        <p className="text-[0.8rem] text-faint">
          To use a different admin, replace {name}&apos;s admin sign-in in Secure Vault.
        </p>
      )}
    </form>
  );
}

function Loading<T>({
  q,
  serviceId,
  name,
  children,
}: {
  q: ReturnType<typeof useWizarrAdmin<T>>;
  serviceId: string;
  name: string;
  children: (data: T, sample: boolean) => React.ReactNode;
}) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  const r = q.data;
  if (!r) return null;
  if (!r.ok) return <AdminSignIn serviceId={serviceId} name={name} read={r} />;
  return <>{children(r.data, Boolean(r.sample))}</>;
}

/** A step's words without Markdown marks, skipping a heading that repeats its title. */
export function preview(s: Pick<WizarrStep, "title" | "markdown">): string {
  // A step may carry its own styling or HTML: only its words are shown here.
  const text = s.markdown
    .replace(/<(style|script)\b[\s\S]*?(<\/\1>|$)/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const plain = (l: string) =>
    l
      .replace(/^#+\s*/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>]/g, "")
      .trim();
  const words = lines
    .map(plain)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (words.length > 1 && words[0]!.toLowerCase() === s.title.trim().toLowerCase()) words.shift();
  return words.join(" ");
}

/** As on Radarr's panel: sample data reads, but changes need a real Wizarr. */
function SampleNote({ name }: { name: string }) {
  return (
    <p className="rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-[0.8rem] text-amber">
      Sample data: connect a real {name} to make changes.
    </p>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  testId,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** Writing or changing one step. */
function StepEditor({
  initial,
  onSave,
  onCancel,
  busy,
  fill,
}: {
  initial?: WizarrStep;
  onSave: (s: {
    title: string;
    markdown: string;
    requireInteraction: boolean;
    theme?: string;
  }) => void;
  onCancel: () => void;
  busy: boolean;
  /** This server's name and address, for the preview of a design step. */
  fill?: { serverName: string; address: string };
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [markdown, setMarkdown] = useState(initial?.markdown ?? "");
  const [require, setRequire] = useState(initial?.requireInteraction ?? false);
  // A step made from a design can change colors on its own, keeping every word (11-04).
  const design = initial ? isDesignStep(initial.markdown) : false;
  const [theme, setTheme] = useState(initial ? stepTheme(initial.markdown) : "original");
  const id = useId();
  return (
    <form
      className="space-y-2 rounded-lg border border-gold/40 bg-bg/60 p-3"
      aria-label={initial ? "Edit step" : "New step"}
      data-testid="wizarr-step-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!markdown.trim()) return;
        onSave({
          title: title.trim(),
          markdown,
          requireInteraction: require,
          ...(design ? { theme } : {}),
        });
      }}
    >
      <Field label="Title" htmlFor={`${id}-title`}>
        <input
          id={`${id}-title`}
          className={field}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="wizarr-step-title"
          data-hearth-target="step:title"
        />
      </Field>
      {design && (
        <div className="space-y-2" data-testid="wizarr-step-colors">
          <ThemePicker value={theme} onChange={setTheme} />
          <p className="text-[0.76rem] text-faint">
            New colors go on every step of this server&apos;s guide made from a design, so the guide
            stays one color. Words, titles and order stay as they are.
          </p>
          <Preview
            html={restyleStep(markdown, theme)}
            serverName={fill?.serverName ?? "Media"}
            address={fill?.address ?? "https://media.example.com"}
            className="h-[22rem]"
          />
        </div>
      )}
      <Field
        label="What it says"
        hint="Markdown: # for a heading, **bold**, [text](link) for a link."
        htmlFor={`${id}-text`}
      >
        <textarea
          id={`${id}-text`}
          className={cx(field, "min-h-40 py-2 font-mono text-[0.8rem]")}
          value={markdown}
          maxLength={50_000}
          onChange={(e) => setMarkdown(e.target.value)}
          data-testid="wizarr-step-text"
          data-hearth-target="step:text"
        />
      </Field>
      <Check
        checked={require}
        onChange={setRequire}
        label="They must click a button or link on it before Next works"
        target="step:require"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={btnGold}
          disabled={busy || !markdown.trim()}
          data-testid="wizarr-step-save"
          data-hearth-target="step:save"
        >
          {initial ? "Save step" : "Add step"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function StepList({
  server,
  steps,
  list,
  other,
  c,
  readOnly,
  previewAt,
  fill,
}: {
  server: string;
  steps: WizarrStep[];
  list: (typeof LISTS)[number];
  other: (typeof LISTS)[number];
  c: ReturnType<typeof useApproveHere>;
  /** Sample data: nothing can be changed. */
  readOnly: boolean;
  /** Wizarr's own page for a step of this server's guide, by its place in the whole guide. */
  previewAt?: (index: number) => string | undefined;
  /** This server's name and address, for previews. */
  fill?: { serverName: string; address: string };
}) {
  const [editing, setEditing] = useState<number | "new">();
  const mine = steps
    .filter((s) => s.category === list.category)
    .sort((a, b) => a.position - b.position);
  const otherCount = steps.filter((s) => s.category === other.category).length;
  // Wizarr's guide runs the "before" steps first, then the "after" ones.
  const before = steps.filter((s) => s.category === "pre_invite").length;
  const guideIndex = (i: number) => (list.category === "pre_invite" ? i : before + i);
  const propose = (params: Record<string, string | number | boolean>, title: string) => {
    setEditing(undefined);
    void c.propose("app-wizarr-setup", params, title);
  };
  return (
    <div
      className="space-y-2 rounded-xl border border-line bg-bg/40 p-3"
      data-testid={`wizarr-steps-${server}-${list.category}`}
    >
      <div>
        <h4 className="text-[0.86rem] text-ink">{list.title}</h4>
        <p className="text-[0.76rem] text-faint">{list.hint}</p>
      </div>
      {mine.length === 0 && editing !== "new" && (
        <p className="text-[0.82rem] text-muted">No steps here yet.</p>
      )}
      <ol className="space-y-2">
        {mine.map((s, i) =>
          editing === s.id ? (
            <li key={s.id}>
              <StepEditor
                initial={s}
                busy={c.busy}
                fill={fill}
                onCancel={() => setEditing(undefined)}
                onSave={(v) => {
                  const edit = {
                    op: "step-edit",
                    stepId: s.id,
                    title: v.title,
                    body: v.theme ? restyleStep(v.markdown, v.theme) : v.markdown,
                    requireInteraction: v.requireInteraction,
                  };
                  if (!v.theme || v.theme === stepTheme(s.markdown))
                    return propose(edit, `Edit a Wizarr step: ${v.title || "Untitled"}`);
                  // New colors: every design step of this server's guide, in one plan.
                  const others = designSteps(steps).filter(
                    (x) => x.id !== s.id && stepTheme(x.markdown) !== v.theme,
                  );
                  setEditing(undefined);
                  const colors = WIZARR_THEMES.find((t) => t.id === v.theme)?.name ?? v.theme;
                  void c.proposeMany(
                    [
                      edit,
                      ...others.map((x) => ({
                        op: "step-edit",
                        stepId: x.id,
                        title: x.title,
                        body: restyleStep(x.markdown, v.theme!),
                        requireInteraction: x.requireInteraction,
                      })),
                    ].map((params) => ({ kind: "app-wizarr-setup" as const, params })),
                    `Change ${serverName(server)}'s guide to ${colors} colors in Wizarr`,
                  );
                }}
              />
            </li>
          ) : (
            <li
              key={s.id}
              className="rounded-lg border border-line bg-raised/60 p-2.5"
              data-testid={`wizarr-step-${s.id}`}
              data-hearth-target={`step:${s.id}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="tabular text-[0.76rem] text-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 text-[0.88rem] break-words text-ink">
                  {s.title || "Untitled"}
                </span>
                {s.requireInteraction && (
                  <span className="shrink-0 rounded-full border border-line px-2 text-[0.7rem] text-muted">
                    Needs a click
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-[0.78rem] text-muted">{preview(s)}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <IconButton
                  label={`Move ${s.title || "step"} up`}
                  disabled={c.busy || readOnly || i === 0}
                  onClick={() =>
                    propose(
                      { op: "step-move", stepId: s.id, category: list.category, index: i - 1 },
                      `Move a Wizarr step up: ${s.title || "Untitled"}`,
                    )
                  }
                >
                  <ArrowUp strokeWidth={1.5} className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label={`Move ${s.title || "step"} down`}
                  disabled={c.busy || readOnly || i === mine.length - 1}
                  onClick={() =>
                    propose(
                      { op: "step-move", stepId: s.id, category: list.category, index: i + 1 },
                      `Move a Wizarr step down: ${s.title || "Untitled"}`,
                    )
                  }
                >
                  <ArrowDown strokeWidth={1.5} className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label={`Edit ${s.title || "step"}`}
                  disabled={c.busy || readOnly}
                  onClick={() => setEditing(s.id)}
                  testId={`wizarr-step-edit-${s.id}`}
                >
                  <Pencil strokeWidth={1.5} className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label={`Delete ${s.title || "step"}`}
                  disabled={c.busy || readOnly}
                  onClick={() =>
                    propose(
                      { op: "step-delete", stepId: s.id },
                      `Delete a Wizarr step: ${s.title || "Untitled"}`,
                    )
                  }
                  testId={`wizarr-step-delete-${s.id}`}
                >
                  <Trash2 strokeWidth={1.5} className="h-4 w-4" />
                </IconButton>
                {previewAt?.(guideIndex(i)) && (
                  <a
                    href={previewAt(guideIndex(i))}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Preview ${s.title || "step"} in Wizarr`}
                    title="Preview this step in Wizarr"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink"
                    data-testid={`wizarr-step-preview-${s.id}`}
                  >
                    <Eye strokeWidth={1.5} className="h-4 w-4" />
                  </a>
                )}
                <button
                  type="button"
                  className="ml-auto min-h-9 px-1 text-[0.76rem] text-gold underline-offset-2 hover:underline disabled:opacity-50"
                  disabled={c.busy}
                  onClick={() =>
                    propose(
                      {
                        op: "step-move",
                        stepId: s.id,
                        category: other.category,
                        index: otherCount,
                      },
                      `Move a Wizarr step to ${other.title.toLowerCase()}: ${s.title || "Untitled"}`,
                    )
                  }
                >
                  Move to {other.title.toLowerCase()}
                </button>
              </div>
            </li>
          ),
        )}
      </ol>
      {editing === "new" ? (
        <StepEditor
          busy={c.busy}
          onCancel={() => setEditing(undefined)}
          onSave={(v) =>
            propose(
              {
                op: "step-add",
                server,
                category: list.category,
                title: v.title,
                body: v.markdown,
                requireInteraction: v.requireInteraction,
              },
              `Add a Wizarr step: ${v.title || "Untitled"}`,
            )
          }
        />
      ) : (
        <button
          type="button"
          className={btn}
          disabled={c.busy || readOnly}
          onClick={() => setEditing("new")}
          data-testid={`wizarr-step-add-${server}-${list.category}`}
          data-hearth-target={`wizard:add:${server}:${list.category}`}
        >
          <Plus strokeWidth={1.5} className="h-4 w-4" /> Add a step
        </button>
      )}
    </div>
  );
}

/** Settings, Wizard: the steps people see, per media server, before and after they accept. */
function WizardSection({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useWizarrAdmin<WizarrWizard>(serviceId, "wizard");
  const c = useApproveHere(serviceId, "From Wizarr's panel in Hearth.");
  // Wizarr's own guide pages, as its Preview Wizard button opens them (in a new tab, where
  // Wizarr's admin sign-in in the browser lets them show even while the guide is protected).
  const service = useWorkspace().data?.services.find((x) => x.id === serviceId);
  const wizardHref = (server: string, index: number) =>
    keyPageHref(service, `/wizard/${encodeURIComponent(server)}/${index}`);
  const media = useWizarr(serviceId).d?.servers;
  const fill = (server: string) => {
    const m = media?.find((x) => x.type === server);
    return {
      serverName: m?.name ?? serverName(server),
      address: m?.externalUrl ?? "https://media.example.com",
    };
  };
  return (
    <section
      className="@container space-y-4"
      data-testid="wizarr-wizard"
      aria-label={`${name} invite steps`}
    >
      <Loading q={q} serviceId={serviceId} name={name}>
        {(w, sample) => (
          <>
            <p className="text-[0.84rem] text-muted">
              The guide someone sees when they open an invitation: steps before they accept, and
              steps after (how to get the app, house rules). Each media server has its own.
            </p>
            {sample && <SampleNote name={name} />}
            <ApproveDialog c={c} />
            <WizarrDesigns serviceId={serviceId} wizard={w} c={c} readOnly={sample} />
            {w.servers.length === 0 && (
              <p className="text-[0.86rem] text-muted">
                {name} has no invite steps yet. Steps appear here for each media server {name} is
                connected to.
              </p>
            )}
            {w.servers.map((s) => (
              <div key={s.server} className="space-y-2" data-testid={`wizarr-wizard-${s.server}`}>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h3 className="text-[0.92rem] text-ink">{serverName(s.server)}</h3>
                  {wizardHref(s.server, 0) && (
                    <a
                      href={wizardHref(s.server, 0)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-9 items-center gap-1.5 text-[0.8rem] text-gold underline-offset-2 hover:underline"
                      data-testid={`wizarr-preview-${s.server}`}
                      data-hearth-target={`wizard:preview:${s.server}`}
                    >
                      <Eye strokeWidth={1.5} className="h-4 w-4" /> Preview the guide
                      <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <div className="grid gap-3 @lg:grid-cols-2">
                  <StepList
                    server={s.server}
                    steps={s.steps}
                    list={LISTS[0]!}
                    other={LISTS[1]!}
                    c={c}
                    readOnly={sample}
                    previewAt={(i) => wizardHref(s.server, i)}
                    fill={fill(s.server)}
                  />
                  <StepList
                    server={s.server}
                    steps={s.steps}
                    list={LISTS[1]!}
                    other={LISTS[0]!}
                    c={c}
                    readOnly={sample}
                    previewAt={(i) => wizardHref(s.server, i)}
                    fill={fill(s.server)}
                  />
                </div>
              </div>
            ))}
            <p className="text-[0.8rem] text-faint">
              Step bundles, presets, import and export stay in {name} for now:{" "}
              <WizarrPage
                serviceId={serviceId}
                path="/settings/#wizard"
                testId="wizarr-open-wizard"
              >
                Open {name}&apos;s Wizard settings
              </WizarrPage>
            </p>
          </>
        )}
      </Loading>
    </section>
  );
}

/** Settings, General: Wizarr's General settings, and cleaning expired users. */
function GeneralSection({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useWizarrAdmin<WizarrSettings>(serviceId, "settings");
  const c = useApproveHere(serviceId, "From Wizarr's panel in Hearth.");
  return (
    <section
      className="@container space-y-4"
      data-testid="wizarr-settings"
      aria-label={`${name} settings`}
    >
      <Loading q={q} serviceId={serviceId} name={name}>
        {(s, sample) => (
          <SettingsForm
            key={JSON.stringify(s)}
            s={s}
            sample={sample}
            c={c}
            name={name}
            serviceId={serviceId}
          />
        )}
      </Loading>
    </section>
  );
}

function SettingsForm({
  s,
  sample,
  c,
  name,
  serviceId,
}: {
  s: WizarrSettings;
  sample: boolean;
  c: ReturnType<typeof useApproveHere>;
  name: string;
  serviceId: string;
}) {
  const [displayName, setDisplayName] = useState(s.displayName);
  const [protect, setProtect] = useState(s.protectWizard);
  const [expiry, setExpiry] = useState(s.expiryAction);
  const [posters, setPosters] = useState(s.posters?.value ?? "");
  const changed =
    displayName.trim() !== s.displayName ||
    protect !== s.protectWizard ||
    expiry !== s.expiryAction ||
    (s.posters !== undefined && posters !== s.posters.value);
  return (
    <>
      {sample && <SampleNote name={name} />}
      <form
        className="space-y-3 rounded-xl border border-line bg-bg/50 p-4"
        aria-label="General settings"
        onSubmit={(e) => {
          e.preventDefault();
          void c.propose(
            "app-wizarr-setup",
            {
              op: "settings",
              ...(displayName.trim() !== s.displayName ? { displayName: displayName.trim() } : {}),
              ...(protect !== s.protectWizard ? { protectWizard: protect } : {}),
              ...(expiry !== s.expiryAction ? { expiryAction: expiry } : {}),
              ...(s.posters && posters !== s.posters.value ? { posters } : {}),
            },
            `Change ${name}'s settings`,
          );
        }}
      >
        <Field
          label="Display name"
          hint="What people see on the invitation pages."
          htmlFor="wizarr-display-name"
        >
          <input
            id="wizarr-display-name"
            className={field}
            value={displayName}
            maxLength={100}
            onChange={(e) => setDisplayName(e.target.value)}
            data-testid="wizarr-display-name"
            data-hearth-target="setting:display-name"
          />
        </Field>
        <Check
          checked={protect}
          onChange={setProtect}
          label="Only people with an invitation can open the guide"
          target="setting:protect"
        />
        <Field label="When someone's access ends" htmlFor="wizarr-expiry-action">
          <select
            id="wizarr-expiry-action"
            className={field}
            data-hearth-target="setting:expiry"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as WizarrSettings["expiryAction"])}
            data-testid="wizarr-expiry-action"
          >
            <option value="delete">Delete them</option>
            <option value="disable">
              Disable them (deleted where the media server cannot disable)
            </option>
          </select>
        </Field>
        {s.posters && (
          <Field label="Join page posters" htmlFor="wizarr-posters">
            <select
              id="wizarr-posters"
              className={field}
              value={posters}
              onChange={(e) => setPosters(e.target.value)}
              data-testid="wizarr-posters"
            >
              {s.posters.choices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button
          type="submit"
          className={btnGold}
          disabled={c.busy || sample || !changed || !displayName.trim()}
          data-testid="wizarr-settings-save"
          data-hearth-target="settings:save"
        >
          Save settings
        </button>
      </form>
      <ApproveDialog c={c} />
      <div
        className="space-y-2 rounded-xl border border-line bg-bg/50 p-4"
        data-testid="wizarr-clean-expired"
      >
        <h3 className="text-[0.9rem] text-ink">Expired users</h3>
        <p className="text-[0.84rem] text-muted">
          {s.expiryAction === "disable"
            ? "Disable everyone whose access has ended now, instead of waiting for Wizarr's next check."
            : "Delete everyone whose access has ended now, from Wizarr and the media server, instead of waiting for Wizarr's next check."}
        </p>
        <button
          type="button"
          className={btnBad}
          disabled={c.busy || sample}
          data-hearth-target="settings:clean-expired"
          onClick={() =>
            void c.propose(
              "app-wizarr-setup",
              { op: "clean-expired" },
              `Clean expired users in ${name}`,
            )
          }
          data-testid="wizarr-clean-expired-start"
        >
          <Trash2 strokeWidth={1.5} className="h-4 w-4" /> Clean expired users
        </button>
      </div>
      <p className="text-[0.8rem] text-faint">
        Alerts, connections, admins and LDAP stay in {name} for now:{" "}
        <WizarrPage serviceId={serviceId} path="/settings/" testId="wizarr-open-all-settings">
          Open {name}&apos;s settings
        </WizarrPage>
      </p>
    </>
  );
}

type Part = "general" | "wizard";

/**
 * Wizarr's Settings tab, laid out as Wizarr's own: General, and Wizard (the invite steps). Address:
 * "config" for General, "config/wizard" for the steps. What Hearth does not cover yet is one link
 * away in Wizarr.
 */
export function WizarrSettings({ serviceId, name, sub, onSub }: AppViewProps) {
  const part: Part = (sub ?? "").split("/")[0] === "wizard" ? "wizard" : "general";
  return (
    <div className="space-y-3" data-testid="wizarr-config">
      <SubNav
        label="Settings"
        target="settings"
        value={part}
        onChange={(p) => onSub?.(p === "general" ? null : p)}
        options={[
          { value: "general", label: "General" },
          { value: "wizard", label: "Wizard" },
        ]}
      />
      {part === "general" ? (
        <GeneralSection serviceId={serviceId} name={name} />
      ) : (
        <WizardSection serviceId={serviceId} name={name} />
      )}
    </div>
  );
}
