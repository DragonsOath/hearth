import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  LAYOUT_PARTS,
  type LayoutCopyResult,
  type LayoutPart,
  type LayoutPreview,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { applyBrowserLayout } from "../../lib/layoutKeeper";
import { Button, Panel, Section, cx } from "../ui";

/**
 * Copy another Hearth's layout (11-08): on Desktop-PC's Hearth, copy the home server's, and the
 * other way round, so two separate Hearths look the same; or don't, and each keeps its own.
 * Reads the other Hearth with its Hearth API key (Secure Vault there), shows what would change,
 * copies, and Undo puts this Hearth's layout back.
 */

const PART_NAMES: Record<LayoutPart, { name: string; what: string }> = {
  lair: { name: "The Lair", what: "its saved layouts, the order of its app strip, its chat dock" },
  home: {
    name: "Home dashboard",
    what: "widgets, their order and sizes, Home Assistant devices, clock, start page",
  },
  look: { name: "Theme and look", what: "the theme and the AI's look style" },
  sidebar: { name: "Sidebar", what: "open or narrow" },
};

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

interface Found {
  url: string;
  name: string;
  via: "home" | "tailscale";
}

export function LayoutCopySection() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Layout"
      action={
        !open ? (
          <Button tone="outline" onClick={() => setOpen(true)} data-testid="layout-copy-start">
            Copy another Hearth&apos;s layout
          </Button>
        ) : undefined
      }
    >
      <p className="max-w-2xl text-[0.84rem] text-muted">
        Each Hearth keeps its own layout. To make this one look like another of your Hearths (the
        Lair, the home dashboard, the theme, the sidebar), copy it here; on the other one, copy this
        one the same way. Undo puts this Hearth&apos;s layout back.
      </p>
      {open && <CopyForm onClose={() => setOpen(false)} />}
    </Section>
  );
}

function CopyForm({ onClose }: { onClose: () => void }) {
  const find = useQuery({
    queryKey: ["layout-find"],
    queryFn: () => api<{ found: Found[] }>("POST", "/api/layout/find", {}),
    staleTime: 60_000,
  });
  const [hub, setHub] = useState("");
  const [key, setKey] = useState("");
  const [parts, setParts] = useState<LayoutPart[]>([...LAYOUT_PARTS]);
  const found = find.data?.found ?? [];
  const picked = hub || found[0]?.url || "";
  const body = { hubUrl: picked, key: key.trim(), parts };
  const preview = useMutation({
    mutationFn: () => api<LayoutPreview>("POST", "/api/layout/preview", body),
  });
  const copy = useMutation({
    mutationFn: () => api<LayoutCopyResult>("POST", "/api/layout/copy", body),
    onSuccess: (r) => {
      applyBrowserLayout(r.browser);
      setKey("");
    },
  });
  const undo = useMutation({
    mutationFn: () => api<LayoutCopyResult>("POST", "/api/layout/undo", {}),
    onSuccess: (r) => {
      applyBrowserLayout(r.browser);
      window.location.reload();
    },
  });

  if (copy.data)
    return (
      <Panel className="mt-4 max-w-2xl space-y-3 p-5">
        <div data-testid="layout-copied" className="space-y-3">
          <p className="text-[0.92rem] text-ink">
            Copied {copy.data.from}&apos;s layout:{" "}
            {copy.data.parts.map((p) => PART_NAMES[p].name).join(", ")}.
          </p>
          {copy.data.missing.length > 0 && (
            <p className="text-[0.82rem] text-warn">
              Left out, because this Hearth doesn&apos;t have them: {copy.data.missing.join(", ")}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              onClick={() => window.location.reload()}
              data-testid="layout-reload"
            >
              Show it now
            </Button>
            <Button tone="quiet" onClick={() => undo.mutate()} disabled={undo.isPending}>
              Undo
            </Button>
          </div>
        </div>
      </Panel>
    );

  return (
    <Panel className="mt-4 max-w-2xl space-y-4 p-5">
      <div data-testid="layout-copy" className="space-y-3">
        <div>
          <p className="mb-2 text-[0.86rem] text-ink">Copy from</p>
          {find.isLoading ? (
            <p className="text-[0.84rem] text-muted">Looking on your home network and Tailscale…</p>
          ) : (
            found.length > 0 && (
              <div role="radiogroup" aria-label="Your other Hearth" className="mb-2 space-y-2">
                {found.map((f) => (
                  <label
                    key={f.url}
                    className={cx(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3",
                      picked === f.url ? "border-gold/70 bg-gold/10" : "border-line",
                    )}
                  >
                    <input
                      type="radio"
                      name="layout-hub"
                      checked={picked === f.url}
                      onChange={() => setHub(f.url)}
                      className="accent-[var(--color-gold)]"
                    />
                    <span className="text-[0.92rem] text-ink">Hearth on {f.name}</span>
                    <span className="ml-auto text-[0.74rem] text-faint">
                      {f.via === "tailscale" ? "Tailscale" : "Home network"}
                    </span>
                  </label>
                ))}
              </div>
            )
          )}
          <label className="block text-[0.82rem] text-muted">
            {found.length ? "Or type its address" : "Its address"}
            <input
              className={cx(field, "mt-1")}
              placeholder="192.168.1.10:7600"
              spellCheck={false}
              value={hub}
              onChange={(e) => setHub(e.target.value)}
              data-testid="layout-hub"
            />
          </label>
        </div>
        <label className="block text-[0.86rem] text-ink">
          Its Hearth API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={cx(field, "mt-1 font-mono")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="layout-key"
          />
          <span className="mt-1 block text-[0.76rem] text-faint">
            On that Hearth: Secure Vault, Hearth API key, Copy. It only lets this Hearth read the
            layout.
          </span>
        </label>
        <fieldset>
          <legend className="mb-1 text-[0.86rem] text-ink">What to copy</legend>
          {LAYOUT_PARTS.map((p) => (
            <label key={p} className="flex min-h-10 items-start gap-2 text-[0.84rem]">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
                checked={parts.includes(p)}
                onChange={(e) =>
                  setParts(e.target.checked ? [...parts, p] : parts.filter((x) => x !== p))
                }
              />
              <span>
                <span className="text-ink">{PART_NAMES[p].name}</span>{" "}
                <span className="text-faint">({PART_NAMES[p].what})</span>
              </span>
            </label>
          ))}
        </fieldset>
        {preview.data && (
          <div className="space-y-1 text-[0.82rem]" data-testid="layout-preview">
            <p className="text-ink">
              From {preview.data.from}
              {preview.data.deskLayouts.length
                ? `: the Lair layouts ${preview.data.deskLayouts.join(", ")}`
                : ""}
              . This Hearth&apos;s own{" "}
              {preview.data.parts.map((p) => PART_NAMES[p].name).join(", ")} will be replaced (Undo
              puts them back).
            </p>
            {!preview.data.hasBrowser && (
              <p className="text-muted">
                It has no browser layout kept yet: open that Hearth in a browser once, then try
                again for its home dashboard, strip order and sidebar.
              </p>
            )}
            {preview.data.missing.length > 0 && (
              <p className="text-warn">
                Left out, because this Hearth doesn&apos;t have them:{" "}
                {preview.data.missing.join(", ")}.
              </p>
            )}
          </div>
        )}
        {(preview.error ?? copy.error ?? find.error) && (
          <p className="text-[0.82rem] text-warn" role="alert">
            {(preview.error ?? copy.error ?? find.error)!.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!preview.data ? (
            <Button
              tone="primary"
              disabled={!picked || !key.trim() || !parts.length || preview.isPending}
              onClick={() => preview.mutate()}
              data-testid="layout-preview-go"
            >
              {preview.isPending ? "Reading it…" : "See what changes"}
            </Button>
          ) : (
            <Button
              tone="primary"
              disabled={copy.isPending}
              onClick={() => copy.mutate()}
              data-testid="layout-copy-go"
            >
              {copy.isPending ? "Copying…" : "Copy it here"}
            </Button>
          )}
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}
