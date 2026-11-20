import { Swords } from "lucide-react";
import { useNavigate } from "react-router";
import { useAiName } from "../../data/api";
import { useEmberLink } from "../../pages/WarRoom";
import { cx } from "../ui";

/** The War Room from anywhere: EMBER's control center, with voice chat and Hearth's panels. */
export function WarRoomButton({ compact = false }: { compact?: boolean }) {
  const aiName = useAiName();
  const navigate = useNavigate();
  const link = useEmberLink();
  // EMBER set up and answering; when it is down, Hearth's own War Room still opens.
  const engine = Boolean(link.data?.configured && link.data.reachable);
  return (
    <button
      type="button"
      onClick={() => navigate("/war-room")}
      aria-label="Open the War Room"
      title={
        engine
          ? "The War Room: Claude Code and Codex with your homelab"
          : `The War Room: talk with ${aiName}, full screen`
      }
      className={cx(
        "flex shrink-0 items-center gap-2 rounded-full border border-gold/40 text-gold transition-colors hover:border-gold hover:bg-gold/10",
        compact ? "h-10 w-10 justify-center" : "min-h-10 px-3.5 text-[0.84rem]",
      )}
      data-testid="war-room-button"
    >
      <Swords strokeWidth={1.6} className="h-[18px] w-[18px]" aria-hidden />
      {!compact && <span>War Room</span>}
    </button>
  );
}
