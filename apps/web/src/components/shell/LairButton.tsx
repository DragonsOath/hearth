import { Castle } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useDeskGroups } from "../../data/deskGroups";
import { useRestoreGroup } from "../desk/groups";
import { panelsFrom } from "../desk/layout";
import { useDesk } from "../desk/links";
import { cx } from "../ui";

/**
 * The Lair from anywhere: Ember beside your systems' panels. It brings back the Lair you used
 * last, exactly as you left it; with none saved, it opens a fresh one where you pick what to
 * open. Desktop only, like the Lair itself.
 */
/**
 * A phone's Ask (11-18, the owner: the separate Ask page "is dumb ... the ask should just take you
 * to the ember ask page ... the lair essentially"): Ember's chat in the Lair. Already in the Lair,
 * it turns to Ember; otherwise it brings back the Lair used last (a fresh one when none is saved),
 * showing Ember.
 */
export function useOpenEmberChat() {
  const groups = useDeskGroups();
  const restore = useRestoreGroup();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return () => {
    const here = new URLSearchParams(search);
    if (pathname === "/" && (here.has("panels") || here.has("project") || here.has("service"))) {
      here.set("view", "chat");
      navigate(`/?${here.toString()}`, { replace: true });
      return;
    }
    const latest = [...(groups.data ?? [])]
      .filter((g) => panelsFrom(new URLSearchParams(g.search)).length > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) {
      const s = new URLSearchParams(latest.search);
      s.set("view", "chat");
      restore({ ...latest, search: `?${s.toString()}` });
    } else navigate("/?panels=&view=chat");
  };
}

/** Opens the Lair you used last, exactly as you left it (a fresh one when none is saved). */
export function useOpenLair() {
  const groups = useDeskGroups();
  const restore = useRestoreGroup();
  const navigate = useNavigate();
  return () => {
    const latest = [...(groups.data ?? [])]
      .filter((g) => panelsFrom(new URLSearchParams(g.search)).length > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) restore(latest);
    else navigate("/?panels=");
  };
}

export function LairButton() {
  const desk = useDesk();
  const openLair = useOpenLair();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  if (!desk) return null;
  const inLair =
    pathname === "/" && (params.has("panels") || params.has("project") || params.has("service"));
  const open = () => {
    if (!inLair) openLair();
  };
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open the Lair"
      aria-current={inLair ? "page" : undefined}
      title="The Lair: your AI beside your systems' panels"
      className={cx(
        "flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[0.84rem] transition-colors",
        inLair
          ? "border-gold bg-gold/15 text-gold"
          : "border-gold/40 text-gold hover:border-gold hover:bg-gold/10",
      )}
      data-testid="lair-button"
    >
      <Castle strokeWidth={1.6} className="h-[18px] w-[18px]" aria-hidden />
      <span>The Lair</span>
    </button>
  );
}

/**
 * The Lair on a phone (11-13, the owner: "keep the Lair, get rid of the War Room"): Ember and
 * your open panels as a ring you swipe round. The War Room is for a tablet or computer.
 */
export function PhoneLairButton() {
  const openLair = useOpenLair();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const inLair = pathname === "/" && params.has("panels");
  return (
    <button
      type="button"
      onClick={() => {
        if (!inLair) openLair();
      }}
      aria-label="Open the Lair"
      aria-current={inLair ? "page" : undefined}
      className={cx(
        "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[0.8rem] text-gold transition-colors",
        inLair ? "border-gold bg-gold/15" : "border-gold/40",
      )}
      data-testid="phone-lair-button"
    >
      <Castle strokeWidth={1.6} className="h-[18px] w-[18px]" aria-hidden />
      Lair
    </button>
  );
}
