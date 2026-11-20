import { useMemo, useState } from "react";
import { Paintbrush, Sparkles } from "lucide-react";
import {
  WIZARR_DESIGNS,
  WIZARR_THEMES,
  WORDING_LABELS,
  isDesignStep,
  restyleStep,
  stepTheme,
  stepWording,
  type WizarrDesign,
  type WizarrStep,
  type WizarrStepCategory,
  type WizarrWordingField,
  type WizarrWizard,
} from "@dragon-control/core";
import type { useApproveHere } from "../../jobs/ApproveHere";
import { cx } from "../../ui";
import { Field, btn, btnGold, input } from "../radarr/common";
import { useWizarr } from "./shared";

/**
 * Ready-made designs for Wizarr's invite steps. Pick a design and a color theme, change its
 * wording, see it, then save it for one media server: one plan you approve. A server whose steps
 * already use a design starts from those steps, with their own words: saving then changes only the
 * colors and the words you changed. Otherwise the design's own steps are added (and, when asked,
 * that server's current ones deleted first). Wizarr fills in the server's name and address itself;
 * the preview shows them as Wizarr will.
 */

export const SERVER_NAME: Record<string, string> = {
  plex: "Plex",
  jellyfin: "Jellyfin",
  audiobookshelf: "Audiobookshelf",
};
const MAX_STEPS = 12;

type Words = Partial<Record<WizarrWordingField, string>>;

/** A design step as it will look, with Wizarr's fill-ins shown and no script running. */
export function Preview({
  html,
  serverName,
  address,
  className,
}: {
  html: string;
  serverName: string;
  address: string;
  className?: string;
}) {
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:14px;background:#0b0a10">${html
        .replace(/\{\{\s*server_name\s*\}\}/g, serverName)
        .replace(/\{\{\s*external_url\s*\}\}/g, address)}</body></html>`,
    [html, serverName, address],
  );
  return (
    <iframe
      title="Design preview"
      srcDoc={doc}
      // No scripts, forms or navigation: only the look is shown.
      sandbox=""
      className={cx("h-[30rem] w-full rounded-lg border border-line bg-black", className)}
      data-testid="wizarr-design-preview"
    />
  );
}

/** The eight color themes, as round swatches with their names. */
export function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[0.8rem] text-muted">Colors</p>
      <div role="radiogroup" aria-label="Colors" className="flex flex-wrap gap-1.5">
        {WIZARR_THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            onClick={() => onChange(t.id)}
            className={cx(
              "flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 text-[0.78rem]",
              value === t.id ? "border-gold text-gold" : "border-line text-muted hover:text-ink",
            )}
            data-testid={`wizarr-theme-${t.id}`}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full"
              style={{ background: t.swatch }}
            />
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A server's steps made from a design, in the order its guide shows them. */
export const designSteps = (steps: WizarrStep[]) =>
  steps
    .filter((s) => isDesignStep(s.markdown))
    .sort(
      (a, b) =>
        Number(a.category !== "pre_invite") - Number(b.category !== "pre_invite") ||
        a.position - b.position,
    );

/** One step on the designer's tabs: a saved step of this server, or one of the design's own. */
interface Draft {
  key: string;
  category: WizarrStepCategory;
  title: string;
  html: string;
  requireInteraction: boolean;
  /** The saved step it is (absent for the design's own steps). */
  saved?: WizarrStep;
  /** The words it starts with: the saved words, or the design's standard ones. */
  start: Words;
}

type Mode = "update" | "replace" | "add";

function ServerDesigner({
  design,
  server,
  current,
  media,
  c,
  readOnly,
  onClose,
}: {
  design: WizarrDesign;
  server: string;
  current: WizarrStep[];
  media?: { name: string; externalUrl?: string };
  c: ReturnType<typeof useApproveHere>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const name = SERVER_NAME[server] ?? server;
  const saved = designSteps(current);
  const [mode, setMode] = useState<Mode>(saved.length ? "update" : "replace");
  const [theme, setTheme] = useState(saved[0] ? stepTheme(saved[0].markdown) : "original");
  const [wording, setWording] = useState<Record<string, Words>>({});
  const [shown, setShown] = useState(0);

  const drafts: Draft[] =
    mode === "update"
      ? saved.map((s) => ({
          key: `saved-${s.id}`,
          category: s.category,
          title: s.title,
          html: s.markdown,
          requireInteraction: s.requireInteraction,
          saved: s,
          start: stepWording(s.markdown),
        }))
      : (design.servers[server]?.steps ?? []).map((st) => {
          // The design's step starts with the words of the saved step in its place, if any.
          const same = design.servers[server]!.steps.filter((x) => x.category === st.category);
          const match = saved.filter((x) => x.category === st.category)[same.indexOf(st)];
          return {
            key: `design-${st.id}`,
            category: st.category,
            title: st.title,
            html: st.html,
            requireInteraction: st.requireInteraction,
            start: { ...stepWording(st.html), ...(match ? stepWording(match.markdown) : {}) },
          };
        });
  const built = drafts.map((d) => restyleStep(d.html, theme, { ...d.start, ...wording[d.key] }));
  const changed = drafts.filter((d, i) => !d.saved || built[i] !== d.saved.markdown);
  const planSize =
    mode === "update" ? changed.length : drafts.length + (mode === "replace" ? current.length : 0);
  const at = Math.min(shown, Math.max(0, drafts.length - 1));
  const draft = drafts[at];

  const apply = () => {
    if (mode === "update") {
      const steps = drafts.flatMap((d, i) =>
        d.saved && built[i] !== d.saved.markdown
          ? [
              {
                kind: "app-wizarr-setup" as const,
                params: {
                  op: "step-edit",
                  stepId: d.saved.id,
                  title: d.saved.title,
                  body: built[i]!,
                  requireInteraction: d.saved.requireInteraction,
                },
              },
            ]
          : [],
      );
      void c.proposeMany(steps, `Change the colors and wording of ${name}'s guide in Wizarr`);
      return;
    }
    const del =
      mode === "replace"
        ? current.map((s) => ({
            kind: "app-wizarr-setup" as const,
            params: { op: "step-delete", stepId: s.id },
          }))
        : [];
    const add = drafts.map((d, i) => ({
      kind: "app-wizarr-setup" as const,
      params: {
        op: "step-add",
        server,
        category: d.category,
        title: d.title,
        body: built[i]!,
        requireInteraction: d.requireInteraction,
      },
    }));
    void c.proposeMany([...del, ...add], `Use the ${design.name} design for ${name} in Wizarr`);
  };

  return (
    <>
      <ThemePicker value={theme} onChange={setTheme} />

      <div role="tablist" aria-label="Design steps" className="flex flex-wrap gap-1.5">
        {drafts.map((d, i) => (
          <button
            key={d.key}
            type="button"
            role="tab"
            aria-selected={at === i}
            onClick={() => setShown(i)}
            className={cx(
              "min-h-9 rounded-full border px-3 text-[0.78rem]",
              at === i
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-line text-muted hover:text-ink",
            )}
          >
            {d.category === "pre_invite" ? "Before" : "After"}: {d.title || "Untitled"}
          </button>
        ))}
      </div>

      {draft && (
        <div className="grid gap-3 @2xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            {(Object.keys(WORDING_LABELS) as WizarrWordingField[])
              .filter((k) => draft.start[k] !== undefined)
              .map((k) => (
                <Field key={k} label={WORDING_LABELS[k]} htmlFor={`wizarr-word-${k}`}>
                  <textarea
                    id={`wizarr-word-${k}`}
                    className={cx(input, "min-h-10 py-2")}
                    rows={k === "intro" ? 4 : 2}
                    maxLength={400}
                    value={wording[draft.key]?.[k] ?? draft.start[k] ?? ""}
                    onChange={(e) =>
                      setWording((w) => ({
                        ...w,
                        [draft.key]: { ...w[draft.key], [k]: e.target.value },
                      }))
                    }
                    data-testid={`wizarr-word-${k}`}
                  />
                </Field>
              ))}
            <p className="text-[0.74rem] text-faint">
              {"{{ server_name }}"} and {"{{ external_url }}"} are filled in by Wizarr with this
              server&apos;s name and address.
            </p>
          </div>
          <Preview
            html={built[at]!}
            serverName={media?.name ?? name}
            address={media?.externalUrl ?? "https://media.example.com"}
          />
        </div>
      )}

      <div className="space-y-1.5">
        {saved.length > 0 && (
          <label className="flex min-h-9 items-center gap-2 text-[0.84rem] text-ink">
            <input
              type="radio"
              name="wizarr-design-mode"
              checked={mode === "update"}
              onChange={() => {
                setMode("update");
                setShown(0);
              }}
              data-testid="wizarr-design-update"
            />
            Keep {name}&apos;s current steps: change only their colors and the words you change
          </label>
        )}
        <label className="flex min-h-9 items-center gap-2 text-[0.84rem] text-ink">
          <input
            type="radio"
            name="wizarr-design-mode"
            checked={mode === "replace"}
            onChange={() => {
              setMode("replace");
              setShown(0);
            }}
            data-testid="wizarr-design-replace"
          />
          Replace {name}&apos;s current steps ({current.length}) with the {design.name}{" "}
          design&apos;s
        </label>
        <label className="flex min-h-9 items-center gap-2 text-[0.84rem] text-ink">
          <input
            type="radio"
            name="wizarr-design-mode"
            checked={mode === "add"}
            onChange={() => {
              setMode("add");
              setShown(0);
            }}
            data-testid="wizarr-design-add"
          />
          Add the {design.name} design&apos;s steps after the current ones
        </label>
      </div>
      {planSize > MAX_STEPS && (
        <p className="text-[0.8rem] text-amber">
          That is {planSize} changes, more than one plan holds ({MAX_STEPS}). Delete a few steps
          first, or add after them.
        </p>
      )}
      {mode === "update" && planSize === 0 && (
        <p className="text-[0.8rem] text-faint" data-testid="wizarr-design-unchanged">
          Nothing changed yet: pick other colors or change the words.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={readOnly || c.busy || planSize > MAX_STEPS || planSize === 0}
          onClick={apply}
          data-testid="wizarr-design-apply"
          data-hearth-target="wizard:design:apply"
        >
          <Sparkles strokeWidth={1.5} className="h-4 w-4" />{" "}
          {mode === "update" ? "Save colors and wording" : "Use this design"}
        </button>
        <button type="button" className={btn} onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Designer({
  design,
  serviceId,
  wizard,
  c,
  readOnly,
  onClose,
}: {
  design: WizarrDesign;
  serviceId: string;
  wizard: WizarrWizard;
  c: ReturnType<typeof useApproveHere>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { d } = useWizarr(serviceId);
  const here = new Set(wizard.servers.map((s) => s.server));
  const servers = Object.keys(design.servers).filter((s) => here.has(s));
  const [server, setServer] = useState(servers[0] ?? "");
  const current = wizard.servers.find((s) => s.server === server)?.steps ?? [];
  const media = d?.servers.find((s) => s.type === server);

  if (!servers.length)
    return (
      <p className="text-[0.84rem] text-muted">
        This design has steps for{" "}
        {Object.keys(design.servers)
          .map((s) => SERVER_NAME[s] ?? s)
          .join(", ")}
        , and this Wizarr has none of them.
      </p>
    );

  return (
    <div
      className="space-y-3 rounded-xl border border-gold/40 bg-bg/60 p-3"
      data-testid="wizarr-designer"
    >
      <Field label="For" htmlFor="wizarr-design-server">
        <select
          id="wizarr-design-server"
          className={cx(input, "w-auto")}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          data-testid="wizarr-design-server"
        >
          {servers.map((s) => (
            <option key={s} value={s}>
              {SERVER_NAME[s] ?? s}
            </option>
          ))}
        </select>
      </Field>
      {/* Each server starts from its own saved colors and words, again once a change is saved. */}
      <ServerDesigner
        key={`${server}:${designSteps(current)
          .map((s) => `${s.id}.${s.markdown.length}.${stepTheme(s.markdown)}`)
          .join(",")}`}
        design={design}
        server={server}
        current={current}
        media={media ? { name: media.name, externalUrl: media.externalUrl } : undefined}
        c={c}
        readOnly={readOnly}
        onClose={onClose}
      />
    </div>
  );
}

/** The designs gallery, at the top of Settings, Wizard. */
export function WizarrDesigns({
  serviceId,
  wizard,
  c,
  readOnly,
}: {
  serviceId: string;
  wizard: WizarrWizard;
  c: ReturnType<typeof useApproveHere>;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState<string>();
  const design = WIZARR_DESIGNS.find((x) => x.id === open);
  return (
    <div className="space-y-2" data-testid="wizarr-designs">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="flex items-center gap-1.5 text-[0.92rem] text-ink">
          <Paintbrush strokeWidth={1.5} className="h-4 w-4 text-gold" /> Designs
        </h3>
        <p className="text-[0.78rem] text-faint">
          A ready-made look for the guide: pick colors, change the wording, and use it.
        </p>
      </div>
      {design ? (
        <Designer
          key={design.id}
          design={design}
          serviceId={serviceId}
          wizard={wizard}
          c={c}
          readOnly={readOnly}
          onClose={() => setOpen(undefined)}
        />
      ) : (
        <ul className="grid gap-2 @lg:grid-cols-2">
          {WIZARR_DESIGNS.map((x) => (
            <li
              key={x.id}
              className="rounded-xl border border-line bg-bg/40 p-3"
              data-testid={`wizarr-design-${x.id}`}
            >
              <p className="text-[0.88rem] text-ink">{x.name}</p>
              <p className="mt-0.5 text-[0.78rem] text-muted">{x.summary}</p>
              <p className="mt-1 text-[0.74rem] text-faint">
                For{" "}
                {Object.keys(x.servers)
                  .map((s) => SERVER_NAME[s] ?? s)
                  .join(", ")}
                {x.source && (
                  <>
                    {" · "}
                    <a
                      href={x.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gold hover:underline"
                    >
                      {x.source.label}
                    </a>
                  </>
                )}
              </p>
              <div className="mt-2 flex items-center gap-1" aria-hidden="true">
                {WIZARR_THEMES.map((t) => (
                  <span
                    key={t.id}
                    className="h-3.5 w-3.5 rounded-full"
                    style={{ background: t.swatch }}
                  />
                ))}
              </div>
              <button
                type="button"
                className={cx(btn, "mt-2")}
                onClick={() => setOpen(x.id)}
                data-testid={`wizarr-design-open-${x.id}`}
              >
                Choose colors and wording
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
