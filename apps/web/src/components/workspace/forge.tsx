import { useNavigate } from "react-router";
import type { WorkspaceSummary } from "@dragon-control/core";
import { useSavedWorkspaces, useTemporaryWorkspaces } from "../../data/workspaces";
import { cx } from "../ui";
import { useOpenWorkspace } from "./dock";

/**
 * The Forge (checklist 46.19): Hearth's workspace, where Ember lays out what it found and the
 * owner makes the calls. The engine is the existing workspaces (workspaces/service.ts); this is
 * its name, its home (/forge, the old Saved work) and the ways to find it.
 */

/**
 * Sheets still waiting for the owner: not sent yet, either open now or saved in the Library (a
 * saved one closed half-way is unfinished work). Ember's own picks count as chosen, so "not sent"
 * is the test, not "all decided": a sheet Ember pre-filled still needs the owner to look and send.
 */
export function useForgeWaiting(): WorkspaceSummary[] {
  const temp = useTemporaryWorkspaces(true);
  const saved = useSavedWorkspaces(true);
  const seen = new Set<string>();
  return (
    [...(temp.data ?? []), ...(saved.data ?? [])]
      .filter((w) => {
        if (seen.has(w.id)) return false;
        seen.add(w.id);
        const live = w.kind === "saved" || w.state !== "closed";
        return live && !w.submittedAt && w.items > 0;
      })
      // Oldest first, and fixed: opening one touches it, so an order by last change would put
      // whichever is open first ("Project 1 of 3" always) and the arrows would only flip two.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  );
}

/** What Ember can build in the Forge today, as things to ask for. */
export const FORGE_EXAMPLES = [
  "Find duplicate movies in Plex and lay them out in the Forge",
  "Go through my stalled downloads with me in the Forge",
  "Show me Plex items that aren't matched, in the Forge",
  "Put my open to-do items in the Forge so I can sort them",
];

/**
 * The Forge in the top bar (wide screens), always there with Ember at her anvil (the owner's
 * artwork, 11-10). It opens the Forge sheet you had last (open or minimized); with none (all
 * closed), the Forge page with your saved work. The number is sheets waiting for your choices.
 */
export function ForgeChip() {
  const waiting = useForgeWaiting();
  const temp = useTemporaryWorkspaces(true);
  const saved = useSavedWorkspaces(true);
  const open = useOpenWorkspace();
  const navigate = useNavigate();
  const last = [...(temp.data ?? []), ...(saved.data ?? [])]
    .filter((w) => w.state !== "closed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const n = waiting.length;
  return (
    <button
      type="button"
      onClick={() => (last ? open(last) : navigate("/forge"))}
      aria-label={
        n
          ? `The Forge: ${n} ${n === 1 ? "sheet is" : "sheets are"} waiting for your choices`
          : last
            ? `The Forge: open ${last.title}`
            : "The Forge"
      }
      title={last ? `The Forge: ${last.title}` : "The Forge: your saved work"}
      className={cx(
        // Wide screens only: on a phone the top bar has no room; the Forge is in the menu.
        "hidden min-h-10 shrink-0 items-center gap-1.5 rounded-full lg:flex border border-gold/40 pr-3 pl-1 text-[0.84rem] text-gold transition-colors hover:border-gold hover:bg-gold/10",
      )}
      data-testid="forge-chip"
    >
      <img src="/brand/ember-forge.webp" alt="" aria-hidden className="h-8 w-8 object-contain" />
      <span>Forge</span>
      {n > 0 && (
        <span className="rounded-full bg-gold px-1.5 text-[0.7rem] font-semibold text-bg tabular">
          {n}
        </span>
      )}
    </button>
  );
}
