import type { ShowPlace } from "@dragon-control/core";

/** "Show again" from a step in the conversation, to the presenter (same window only). */
export interface ShowAgain {
  place: ShowPlace;
  target?: string;
  caption: string;
}

const listeners = new Set<(r: ShowAgain) => void>();

export function showAgain(r: ShowAgain) {
  for (const l of listeners) l(r);
}

export function onShowAgain(l: (r: ShowAgain) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
