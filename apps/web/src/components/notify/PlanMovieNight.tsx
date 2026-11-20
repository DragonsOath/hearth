import { useNavigate } from "react-router";
import { Popcorn } from "lucide-react";
import { usePanelHref } from "../desk/links";

/**
 * "Plan a movie night" on a movie (11-12): opens the Movie nights panel with this movie already
 * chosen. The title is handed over in this browser's session, so it works whether the panel is
 * already open (an event) or opens fresh (read once when it starts).
 */
const KEY = "hearth.movieNight.plan";
export const PLAN_MOVIE_NIGHT_EVENT = "hearth:plan-movie-night";

export function PlanMovieNightButton({ title, className }: { title: string; className?: string }) {
  const href = usePanelHref()("tool:movie-nights");
  const navigate = useNavigate();
  if (!href) return null;
  return (
    <button
      type="button"
      className={className}
      data-testid="plan-movie-night"
      onClick={() => {
        try {
          sessionStorage.setItem(KEY, title);
        } catch {
          // Private window: the panel still opens, the movie is picked by hand.
        }
        window.dispatchEvent(new CustomEvent(PLAN_MOVIE_NIGHT_EVENT, { detail: title }));
        navigate(href);
      }}
    >
      <Popcorn strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden /> Plan a movie night
    </button>
  );
}

/** The movie handed over by Plan a movie night, without clearing it (safe to read twice). */
export function peekPlannedMovie(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The movie handed over by Plan a movie night, once (it is cleared as it is read). */
export function takePlannedMovie(): string | undefined {
  try {
    const title = sessionStorage.getItem(KEY) ?? undefined;
    sessionStorage.removeItem(KEY);
    return title;
  } catch {
    return undefined;
  }
}
