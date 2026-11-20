import { ASK_LEVEL_TEXT, useAskLevel, useSetAskLevel, type AskLevel } from "../../data/fullAccess";
import { cx } from "../ui";

const LEVELS: AskLevel[] = ["strict", "moderate", "free"];

/**
 * Settings, Ember: what the AI asks before acting (also in the War Room). The agent is the full
 * Claude Code, Codex, or Ollama either way; this only chooses when it stops to ask you.
 */
export function FullAccessSetting() {
  const level = useAskLevel();
  const set = useSetAskLevel();
  if (level.isError)
    return (
      <p className="text-[0.88rem] text-faint">
        Available when the War Room is set up on this computer.
      </p>
    );
  const current = set.isPending ? set.variables : level.data;
  return (
    <div className="space-y-3" data-testid="full-access">
      <p className="text-[0.82rem] leading-relaxed text-muted">
        In the War Room and the Lair, Ember is the full Claude Code, Codex, or Ollama, with
        everything it can do. You only choose what it asks you before it acts. It asks in its reply
        and goes on after you say yes.
      </p>
      <div role="radiogroup" aria-label="What Ember asks before acting" className="grid gap-2">
        {LEVELS.map((l) => {
          const on = current === l;
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`ask-level-${l}`}
              disabled={set.isPending || level.isPending}
              onClick={() => set.mutate(l)}
              className={cx(
                "min-h-11 rounded-xl border px-4 py-3 text-left transition-colors duration-200",
                on
                  ? "border-gold/60 bg-gold/10"
                  : "border-line hover:border-line-strong hover:bg-raised",
              )}
            >
              <span className={cx("block text-[0.92rem]", on ? "text-gold" : "text-ink")}>
                {ASK_LEVEL_TEXT[l].label}
              </span>
              <span className="mt-0.5 block text-[0.8rem] leading-relaxed text-muted">
                {ASK_LEVEL_TEXT[l].hint}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[0.78rem] text-faint">
        With the first two, a War Room message with words like &ldquo;delete&rdquo; or
        &ldquo;sudo&rdquo; also waits for your approval before it starts.
      </p>
      {set.isError && (
        <p role="alert" className="text-[0.8rem] text-bad">
          Couldn&apos;t change it. Try again.
        </p>
      )}
    </div>
  );
}
