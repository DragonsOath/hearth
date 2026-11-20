import { Cpu } from "lucide-react";
import { Link } from "react-router";
import { useWorkspace } from "../../data/api";
import { useConnectAgent } from "../../data/agent";
import { cx } from "../ui";

/** The AIs the Lair can switch between, in this order. */
const CHOICES = ["claude-code", "codex", "ollama"] as const;

/**
 * Which AI the Lair is talking to, and a switch between Claude Code, Codex and Ollama right here
 * (11-07: "there's no way to switch without going into the War Room"). It sets the connected
 * AI agent, the same choice as the AI Agent page. The conversation carries over: Hearth keeps it
 * and gives it to whichever AI answers next.
 */
export function AttachedAi({ className }: { className?: string }) {
  const ws = useWorkspace().data;
  const connect = useConnectAgent();
  if (!ws) return null;
  const on = ws.agents.find((a) => a.status === "connected");
  const choices = CHOICES.map((id) => ws.agents.find((a) => a.id === id)).filter(
    (a): a is NonNullable<typeof a> => Boolean(a),
  );
  const asked = connect.isPending ? connect.variables : undefined;
  return (
    <div className={cx("space-y-1", className)} data-testid="lair-ai" data-agent={on?.id ?? "none"}>
      {!on && (
        <p className="flex items-center gap-1 text-[0.72rem] text-faint">
          <Cpu aria-hidden strokeWidth={1.6} className="h-3 w-3" /> No AI connected: pick one
        </p>
      )}
      <div
        role="group"
        aria-label="AI answering in the Lair"
        className="grid w-full grid-cols-3 gap-0.5 rounded-lg border border-line bg-panel/90 p-0.5"
      >
        {choices.map((a) => {
          const current = a.id === on?.id;
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={current}
              disabled={connect.isPending || current}
              onClick={() => connect.mutate(a.id)}
              title={current ? `${a.name} is answering` : `Switch the Lair to ${a.name}`}
              className={cx(
                "min-h-8 truncate rounded-md px-2 text-[0.76rem] transition-colors",
                current
                  ? "bg-gold/15 font-semibold text-gold-bright"
                  : "text-muted hover:bg-white/5 hover:text-ink disabled:opacity-60",
              )}
              data-testid={`lair-ai-${a.id}`}
            >
              {asked === a.id ? `${a.name}…` : a.name}
            </button>
          );
        })}
      </div>
      {connect.isError && (
        <p className="text-[0.74rem] text-amber" role="alert">
          {(connect.error as Error).message}{" "}
          <Link to="/agent" className="underline hover:text-gold">
            Set it up
          </Link>
        </p>
      )}
    </div>
  );
}
