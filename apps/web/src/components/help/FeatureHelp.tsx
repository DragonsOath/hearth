import { useState } from "react";
import { Link, useLocation } from "react-router";
import { featuresOnPage } from "@dragon-control/core";
import { HelpCircle, MessageCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, useAiName } from "../../data/api";
import { Sheet, cx } from "../ui";
import { md } from "../ember/engine";

/**
 * A page's or panel's "How this works" (checklist 42.2): for the features on it, what each is for,
 * whether it is set up on this installation, and the manual's own words, with a way to ask Ember.
 * The answers come from the same feature list and manual the AI's hearth_help tool uses; there
 * is no second copy. It only explains: nothing here opens, changes or runs anything.
 */

interface HelpEntry {
  feature: { id: string; name: string; summary: string };
  implemented: { status: "working" | "partial" | "preview" | "planned"; note?: string };
  thisInstallation: { state: string; say: string; missing?: string[] };
  where: { path: string };
  manual: string;
}

const STATUS: Record<HelpEntry["implemented"]["status"], string> = {
  working: "Ready to use",
  partial: "Partly built",
  preview: "Not open to owners yet",
  planned: "Not built yet",
};

export function FeatureHelp({ features, compact }: { features: string[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!features.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="How this works"
        title="How this works"
        data-testid="feature-help"
        className={cx(
          "flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-muted hover:text-gold",
          compact ? "h-10 w-10" : "min-h-10 px-2 text-[0.82rem]",
        )}
      >
        <HelpCircle strokeWidth={1.5} className="h-5 w-5" />
        {!compact && <span>How this works</span>}
      </button>
      {open && <HelpSheet ids={features} onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpSheet({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const ai = useAiName();
  const q = useQuery({
    queryKey: ["help", ids.join(",")],
    queryFn: () =>
      api<{ features: HelpEntry[] }>(
        "GET",
        `/api/help?features=${encodeURIComponent(ids.join(","))}`,
      ),
  });
  const list = q.data?.features ?? [];
  return (
    <Sheet
      label="How this works"
      eyebrow="How this works"
      title={list[0]?.feature.name ?? "Help"}
      onClose={onClose}
      wide
    >
      <div className="space-y-8" data-testid="feature-help-sheet">
        {q.isLoading && <p className="text-muted">Loading…</p>}
        {q.error && (
          <p className="text-muted">The help could not be loaded. Try again in a moment.</p>
        )}
        {list.map((h) => (
          <section key={h.feature.id} data-testid="feature-help-entry" data-feature={h.feature.id}>
            <h3 className="font-display text-[1.25rem] text-ink">{h.feature.name}</h3>
            <p className="mt-1 text-[0.9rem] text-muted">{h.feature.summary}</p>
            <p className="mt-3 text-[0.82rem] text-faint">
              <span className="text-ink">{STATUS[h.implemented.status]}</span>
              {h.implemented.note ? `. ${h.implemented.note}` : ""}
            </p>
            {h.thisInstallation.state === "needs-setup" && (
              <div
                className="mt-3 rounded-lg border border-amber/40 p-3 text-[0.85rem]"
                data-testid="feature-help-missing"
              >
                <p className="text-ink">Set up first on this installation:</p>
                <ul className="mt-1 list-disc pl-5 text-muted">
                  {(h.thisInstallation.missing ?? []).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-3 text-[0.82rem] text-faint">Where: {h.where.path}</p>
            {h.manual && !h.manual.startsWith("(") && (
              // md() escapes the text first; only its own few tags become HTML.
              <div
                className="md mt-3 text-[0.88rem] leading-relaxed text-muted"
                dangerouslySetInnerHTML={{ __html: md(h.manual) }}
              />
            )}
            <Link
              to={`/ask?q=${encodeURIComponent(`How do I use ${h.feature.name} in Hearth?`)}`}
              className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-3 text-[0.82rem] text-muted hover:border-gold/50 hover:text-gold"
            >
              <MessageCircle strokeWidth={1.5} className="h-4 w-4" />
              Ask {ai} about this
            </Link>
          </section>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * The top bar's "How this works": the features of the page you are on (its route, and the
 * Settings tab or section in the address). In the Lair each panel has its own instead.
 */
export function PageHelp({ compact }: { compact?: boolean }) {
  const { pathname, hash, search } = useLocation();
  const params = new URLSearchParams(search);
  const inLair =
    pathname === "/" && (params.has("panels") || params.has("project") || params.has("service"));
  const ids = inLair ? [] : featuresOnPage(pathname, hash).map((f) => f.id);
  return <FeatureHelp features={ids.slice(0, 8)} compact={compact} />;
}
