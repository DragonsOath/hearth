import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { CaveMessage } from "@dragon-control/core";
import { deskSearch, keyOf, panelsFrom, withPanel, type Panel } from "./layout";

/** "open:service:<id>@<tab>", the step Ember's open_panel tool leaves in the conversation. */
export function openedPanel(ref: string | undefined): Panel | undefined {
  const m = /^open:service:([^@]+)(?:@(.+))?$/.exec(ref ?? "");
  if (!m) return undefined;
  return { kind: "service", id: m[1]!, ...(m[2] ? { tab: m[2] } : {}) };
}

/**
 * Opens the panels Ember asks for while you watch (11-15, the owner: "it should be able to open a
 * panel on request regardless of Show & Tell"). Only steps that appear after the chat is shown
 * count, so reopening an old conversation never rearranges the screen. On a phone the panel comes
 * to the front, as when you pick it from Panels.
 */
export function useOpenPanels(conversationId: string | undefined, messages?: CaveMessage[]) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  // Per conversation: what was already there when it was first shown here.
  const seen = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!conversationId || !messages) return;
    const steps = messages.flatMap((m, i) =>
      (m.activity ?? []).map((a) => ({ key: `${i}:${m.at}:${a.id}`, panel: openedPanel(a.ref) })),
    );
    const known = seen.current.get(conversationId);
    if (!known) {
      seen.current.set(conversationId, new Set(steps.map((s) => s.key)));
      return;
    }
    const fresh = steps.filter((s) => s.panel && !known.has(s.key));
    for (const s of steps) known.add(s.key);
    if (!fresh.length) return;
    const base = pathname === "/" ? new URLSearchParams(params) : new URLSearchParams();
    base.delete("view");
    let next = pathname === "/" ? panelsFrom(params) : [];
    for (const s of fresh) next = withPanel(next, s.panel!);
    navigate(`/${deskSearch(base, next, keyOf(fresh.at(-1)!.panel!))}`);
  }, [conversationId, messages, navigate, pathname, params]);
}
