import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { seasonPacksOf, type CrucibleSetup } from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { appKindOf } from "../command/Diagnostics";
import { usePanelHref } from "../desk/links";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";

/**
 * "Season packs first" wherever seasons are requested (the owner, 11-24): the Crucible's TV
 * Shows setting, shown and changed right there. One setting for every show, so Sonarr itself
 * takes a whole-season pack when one fits and episodes when none does, for every request, with
 * no second download. Changing it is the Crucible's own save, as a plan you approve.
 */
/** A season pack for this request only (when the setting isn't Preferred): the Sonarr to try. */
export interface PackOnce {
  sonarrId: string | undefined;
  set: (sonarrId: string | undefined) => void;
}

export function SeasonPacksSwitch({ once }: { once?: PackOnce }) {
  const href = usePanelHref()("tool:crucible") ?? "/";
  const ws = useWorkspace().data;
  const sonarr = (ws?.services ?? []).find((s) => appKindOf(s) === "sonarr");
  const q = useQuery({
    queryKey: ["crucible-setups"],
    queryFn: () => api<{ setups: Record<string, CrucibleSetup> }>("GET", "/api/crucible"),
    staleTime: 60_000,
  });
  if (!q.data) return null;
  // The Sonarr the Crucible has TV rows for (its saved setup).
  const entry = Object.entries(q.data.setups).find(([, s]) => s?.shows?.length);
  const oneTime = once && sonarr && <Once once={once} sonarrId={entry?.[0] ?? sonarr.id} />;
  if (!entry)
    return (
      <div className="space-y-1" data-testid="season-packs-switch">
        {oneTime}
        <p className="text-[0.74rem] text-faint">
          Season packs first for every show: set up TV shows in{" "}
          <a href={href} className="text-gold underline underline-offset-2">
            the Crucible
          </a>
          .
        </p>
      </div>
    );
  return (
    <Switch
      sonarrId={entry[0]}
      setup={entry[1]}
      href={href}
      once={seasonPacksOf(entry[1]).choice === "prefer" ? undefined : oneTime}
    />
  );
}

/** "Try a season pack for this request": a pack only for what's being requested now. */
function Once({ once, sonarrId }: { once: PackOnce; sonarrId: string }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.82rem] text-ink">
      <input
        type="checkbox"
        checked={Boolean(once.sonarrId)}
        onChange={(e) => once.set(e.target.checked ? sonarrId : undefined)}
        className="h-4 w-4 accent-[var(--color-gold)]"
        data-testid="season-pack-once"
      />
      Try a season pack for this request
      <span className="text-[0.74rem] text-muted">(episode by episode if there isn't one)</span>
    </label>
  );
}

function Switch({
  sonarrId,
  setup,
  href,
  once,
}: {
  sonarrId: string;
  setup: CrucibleSetup;
  href: string;
  once?: React.ReactNode;
}) {
  const act = useApproveHere(sonarrId, "Changed from a request: season packs.");
  const qc = useQueryClient();
  const packs = seasonPacksOf(setup);
  const on = packs.choice === "prefer";
  // Saved: the switch (here and everywhere else) shows the new setting.
  const done = act.job?.status === "succeeded";
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: ["crucible-setups"] });
  }, [done, qc]);
  const flip = () =>
    void act.propose(
      "app-crucible-apply",
      {
        setup: JSON.stringify({
          ...setup,
          seasonPacks: { ...packs, choice: on ? "neutral" : "prefer" },
        }),
        resort: false,
        hookBase: window.location.origin,
      },
      on ? "Season packs: no preference, for every show" : "Season packs first, for every show",
    );
  return (
    <div className="space-y-1" data-testid="season-packs-switch">
      <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.82rem] text-ink">
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          checked={on}
          disabled={act.busy}
          onChange={flip}
          className="h-4 w-4 accent-[var(--color-gold)]"
          data-testid="season-packs-toggle"
        />
        Season packs first
        {packs.maxGB ? <span className="text-muted">(up to {packs.maxGB} GB a season)</span> : null}
      </label>
      <p className="text-[0.74rem] text-faint">
        {on
          ? "A whole season in one download when one fits your rules; episode by episode when none does. "
          : packs.choice === "avoid"
            ? "Now: episode by episode, a pack only when nothing else fits. "
            : "Now: no preference between packs and single episodes. "}
        For every show.{" "}
        <a href={href} className="text-gold underline underline-offset-2">
          More in the Crucible
        </a>
      </p>
      {once}
      {act.error && <p className="text-[0.76rem] text-amber">{act.error}</p>}
      <ApproveDialog c={act} />
    </div>
  );
}
