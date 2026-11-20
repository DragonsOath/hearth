import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ArrowUpRight, PanelRightOpen } from "lucide-react";
import type { CaveMessage } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { deskSearch, keyOf, panelsFrom, withPanel, type Panel } from "./layout";
import { useDesk, usePanelHref } from "./links";
import { useFeatureLink } from "../help/featureLink";

/**
 * Under an answer on the desk: the systems it referred to (what it cited and
 * what it checked) that are not open yet, offered as panels, and the part of
 * Hearth it looked up ("Open Movie nights", checklist 42.2). An offer only:
 * nothing opens or moves unless you click.
 */
export function Suggestions({ answer, asked }: { answer: CaveMessage; asked?: CaveMessage }) {
  const desk = useDesk();
  const ws = useWorkspace().data;
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const href = usePanelHref();
  const featureLink = useFeatureLink();
  if (!ws) return null;
  const open = pathname === "/" ? panelsFrom(params) : [];
  const refs = [
    ...(answer.evidence ?? []).map((e) => e.ref),
    ...(asked?.activity ?? []).map((a) => a.ref),
  ];
  const all = [...ws.services, ...ws.inactiveServices];
  const seen = new Set<string>();
  const offers = refs
    .filter((r): r is string => Boolean(r?.startsWith("service:")))
    .map((r) => r.slice("service:".length))
    .filter((id) => {
      if (seen.has(id) || open.some((p) => p.kind === "service" && p.id === id)) return false;
      seen.add(id);
      return all.some((s) => s.id === id);
    })
    .slice(0, 5)
    .map((id) => all.find((s) => s.id === id)!);
  // Hearth's own pages it looked up: offered on every screen size, not only the desk.
  const pages = [...new Set(refs.filter((r): r is string => Boolean(r?.startsWith("feature:"))))]
    .map((r) => featureLink(r))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .filter((l, i, list) => list.findIndex((x) => x.href === l.href) === i)
    .slice(0, 3);
  const panels = desk ? offers : [];
  if (!panels.length && !pages.length) return null;
  const openAll = () => {
    let next: Panel[] = open;
    for (const s of offers) next = withPanel(next, { kind: "service", id: s.id });
    const last = offers.at(-1)!;
    navigate(
      `/${deskSearch(pathname === "/" ? params : new URLSearchParams(), next, keyOf({ kind: "service", id: last.id }))}`,
    );
  };
  return (
    <li
      className="flex max-w-[96%] flex-wrap items-center gap-1.5 pl-11"
      data-testid="cave-suggestions"
    >
      {pages.map((l) => (
        <Link
          key={l.href}
          to={l.href}
          data-testid="open-feature"
          className="flex min-h-8 items-center gap-1.5 rounded-full border border-gold/40 px-3 text-[0.76rem] text-gold hover:border-gold"
        >
          <ArrowUpRight strokeWidth={1.5} className="h-3.5 w-3.5" />
          {l.label}
        </Link>
      ))}
      {panels.length > 0 && <span className="text-[0.74rem] text-faint">Open beside this:</span>}
      {panels.map((s) => (
        <Link
          key={s.id}
          to={href(`service:${s.id}`)!}
          className="flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[0.76rem] text-muted hover:border-gold/50 hover:text-gold"
        >
          <PanelRightOpen strokeWidth={1.5} className="h-3.5 w-3.5" />
          {s.name}
        </Link>
      ))}
      {panels.length > 1 && (
        <button
          type="button"
          onClick={openAll}
          className="min-h-8 rounded-full px-2 text-[0.76rem] text-faint hover:text-gold"
        >
          Open all
        </button>
      )}
    </li>
  );
}
