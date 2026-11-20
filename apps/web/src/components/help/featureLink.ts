import { useCallback } from "react";
import { appKindOf, featureById, featureOpen, type Feature } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { usePanelHref } from "../desk/links";

/**
 * "Open it for me" (checklist 42.2): where one of Hearth's features opens, from the feature list
 * in core. Only Hearth's own pages and panels can come out of this; an id the list does not have,
 * a feature that is not available, or an app this installation does not have gives nothing.
 */

export interface FeatureLink {
  href: string;
  label: string;
  feature: Feature;
}

type Svc = { id: string; name: string; image?: string | null };

/** The pure part, for tests: a feature id, this installation's services, and the panel link maker. */
export function featureLink(
  id: string,
  services: Svc[],
  panelHref: (ref?: string, tab?: string) => string | undefined,
): FeatureLink | undefined {
  const feature = featureById(id);
  const open = feature && featureOpen(feature);
  if (!feature || !open) return undefined;
  const label = `Open ${feature.name}`;
  if ("page" in open)
    return open.page.startsWith("/") ? { href: open.page, label, feature } : undefined;
  if ("panel" in open) {
    const href = panelHref(`tool:${open.panel}`, open.tab);
    return href ? { href, label, feature } : undefined;
  }
  // The first of its apps this installation has, in the feature's order.
  for (const app of open.app) {
    const svc = services.find((s) => appKindOf(s) === app);
    if (svc) {
      const href = panelHref(`service:${svc.id}`, open.tab);
      if (href) return { href, label: `Open ${svc.name}`, feature };
    }
  }
  return undefined;
}

/** Resolves "feature:raid" references (and bare ids) to a link, on this screen. */
export function useFeatureLink(): (refOrId?: string) => FeatureLink | undefined {
  const ws = useWorkspace().data;
  const panelHref = usePanelHref();
  return useCallback(
    (refOrId?: string) => {
      if (!refOrId) return undefined;
      const id = refOrId.startsWith("feature:") ? refOrId.slice("feature:".length) : refOrId;
      return featureLink(id, ws?.services ?? [], panelHref);
    },
    [ws, panelHref],
  );
}

/**
 * The links the AI writes in an answer: exactly [words](hearth:feature-id). Anything else in
 * brackets stays plain text.
 */
export const HEARTH_LINK = /\[([^\]\n]{1,80})\]\(hearth:([a-z0-9-]{1,60})\)/g;
