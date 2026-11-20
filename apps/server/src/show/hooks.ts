import type {
  ShowAck,
  ShowHold,
  ShowMode,
  ShowPlace,
  ShowRequest,
  ShowSettings,
} from "@dragon-control/core";

/**
 * Show & Tell, as Ember's turn and her other tools see it (11-14, the Premium split). Show & Tell
 * itself (the go-between with the owner's screen, finding places, its routes, Ember's show and
 * tidy_screen tools, her instructions while it is on, and the screens) is in the Premium package,
 * which hands Hearth this. Without it there is none: every call site does nothing, and Ember
 * works exactly as with Show & Tell off.
 */
export interface ShowHooks {
  /** The owner's choice, read as off without the licence (locked says why). */
  settings(): Promise<ShowSettings & { locked?: boolean }>;
  /** An answer started, ended, or was stopped. */
  start(conversationId: string): void;
  end(conversationId: string): void;
  cancel(conversationId: string): void;
  /** One of Ember's steps, narrated on the screen while it runs. */
  step(conversationId: string, label: string, state: "running" | "done" | "failed"): void;
  /** What this answer last put on screen, confirmed. */
  lastShown(conversationId: string): { place: ShowPlace; target?: string } | undefined;
  /** Shows something and waits for the screen (never throws). */
  request(req: Omit<ShowRequest, "id" | "at">): Promise<ShowAck & { id: string }>;
  /** Keeps a plan's setting on screen beside its approval card. */
  hold(conversationId: string, hold: ShowHold): void;
  /** A place in Hearth by Ember's name for it (app:radarr, page:/systems...). */
  resolve(
    where: string,
    tab: string | undefined,
    services: { id: string; name: string; image: string | null }[],
  ): ShowPlace | { error: string };
  /** Ember's instructions for this answer while it is on. */
  hint(mode: Exclude<ShowMode, "off">): string;
}
