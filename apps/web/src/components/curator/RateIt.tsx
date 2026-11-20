import { Star } from "lucide-react";
import {
  RECOMMEND_REACTION_NAMES,
  RECOMMEND_REACTIONS,
  type RecommendRating,
} from "@dragon-control/core";
import { cx } from "../ui";

const field =
  "min-h-11 rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
const chip =
  "min-h-9 rounded-full border px-3 text-[0.8rem] transition-colors hover:border-gold/60 hover:text-gold";

/** "How was it?": stars, a quick reaction, your own words. All optional; Skip keeps none. */
export function RateIt({
  word,
  value,
  onChange,
  onDone,
}: {
  word: string;
  value: RecommendRating;
  onChange: (r: RecommendRating) => void;
  onDone: (r?: RecommendRating) => void;
}) {
  const filled = Boolean(value.stars || value.reaction || value.note?.trim());
  return (
    <div className="space-y-2 rounded-lg border border-gold/30 p-2" data-testid="recommend-rate">
      <p className="text-[0.8rem] text-ink">How was it? (all optional)</p>
      <div role="group" aria-label="Stars" className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={value.stars === n}
            onClick={() => onChange({ ...value, stars: value.stars === n ? undefined : n })}
            className="flex min-h-9 min-w-9 items-center justify-center rounded-md hover:bg-gold/10"
            data-testid={`recommend-star-${n}`}
          >
            <Star
              strokeWidth={1.6}
              className={cx(
                "h-5 w-5",
                (value.stars ?? 0) >= n ? "fill-gold text-gold" : "text-faint",
              )}
              aria-hidden
            />
          </button>
        ))}
      </div>
      <div role="group" aria-label="How it felt" className="flex flex-wrap gap-1.5">
        {RECOMMEND_REACTIONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={value.reaction === r}
            onClick={() => onChange({ ...value, reaction: value.reaction === r ? undefined : r })}
            className={cx(
              chip,
              value.reaction === r
                ? "border-gold/70 bg-gold/10 text-gold"
                : "border-line text-muted",
            )}
            data-testid={`recommend-reaction-${r}`}
          >
            {RECOMMEND_REACTION_NAMES[r]}
          </button>
        ))}
      </div>
      <textarea
        className={cx(field, "w-full py-2 text-[0.84rem]")}
        rows={2}
        maxLength={2000}
        placeholder="Anything to remember about it? (optional)"
        value={value.note ?? ""}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
        data-testid="recommend-note-text"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!filled}
          onClick={() => onDone(value)}
          className="min-h-9 rounded-lg bg-gold px-3 text-[0.8rem] font-bold text-[#1a0d05] disabled:opacity-50"
          data-testid="recommend-rate-save"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => onDone()}
          className="min-h-9 rounded-lg border border-line-strong px-3 text-[0.8rem] text-muted hover:text-ink"
          data-testid="recommend-rate-skip"
        >
          Skip, just {word.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
